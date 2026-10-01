/**
 * How trusted Worker code reaches the conversation actor. The actor is addressed ONLY by the verified
 * principal's internal user ID; a client can never supply an owner or an actor name. Only grant metadata
 * (channel, scopes, an audit reference) crosses the boundary - a Principal object itself cannot be forged
 * or passed, and the actor re-derives its own.
 */
import { getAgentByName } from "agents";
import type { ClarificationAnswer, RecallResult, ResearchRequest, ResultDelivery, TranscriptPage, TurnEvent, TurnGrant, TurnInput, TurnRecord } from "@garderobe/contracts/ext/assistant";
import { assertPrincipal, requireScope, type Principal } from "@garderobe/domain";
import type { ConversationBackup, ConversationExport, GarderobeAssistantBase } from "./agent/assistant.ts";
import type { RecallInput } from "./recall/index.ts";

/** A request the conversation actor rejected (reused submission ID, invalid body, no pending question). Nothing was started. */
export class AssistantRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AssistantRequestError";
  }
}

export interface AssistantClient {
  submitTurn(input: TurnInput): Promise<TurnRecord>;
  runTurn(input: TurnInput): Promise<TurnRecord>;
  streamTurn(input: TurnInput, onEvent: (json: string) => void | Promise<void>): Promise<TurnRecord>;
  resumeTurn(turnId: string): Promise<TurnRecord | null>;
  getTurn(turnId: string): Promise<TurnRecord | null>;
  turnEvents(turnId: string, opts?: { afterSeq?: number }): Promise<{ events: TurnEvent[]; expired: boolean }>;
  cancelTurn(turnId: string): Promise<{ status: string; committedCommandIds: string[] } | null>;
  answerClarification(turnId: string, answer: ClarificationAnswer): Promise<TurnRecord>;
  startResearch(request: ResearchRequest): Promise<TurnRecord & { jobId: string | null }>;
  transcript(opts?: { before?: string; after?: string; around?: string; limit?: number }): Promise<TranscriptPage>;
  recallSearch(input: RecallInput): Promise<RecallResult>;
  deliverResult(delivery: ResultDelivery): Promise<{ delivered: boolean; messageId: string }>;
  reconcileErasures(): Promise<{ erased: string[] }>;
  /** Rebuild the session without compaction summaries that covered forgotten messages (only between turns). */
  rebuildSanitizedSession(): Promise<{ rebuilt: boolean; reason?: string }>;
  projectIndex(opts?: { fromStart?: boolean }): Promise<{ indexed: number; indexedPosition: number }>;
  exportConversation(): Promise<Awaited<ReturnType<GarderobeAssistantBase["exportConversation"]>>>;
  importConversation(data: Parameters<GarderobeAssistantBase["importConversation"]>[0]): Promise<{ imported: number }>;
  /** Store watermarks for export and restore manifests. */
  conversationWatermarks(): Promise<ConversationExport["watermarks"]>;
  /** Operational backup: messages, compaction overlays with summaries, unsettled turns, watermarks. */
  backupConversation(): Promise<ConversationBackup>;
  restoreConversation(backup: ConversationBackup): Promise<Awaited<ReturnType<GarderobeAssistantBase["restoreConversation"]>>>;
  /** Account deletion: wipe the actor's own storage and this owner's research task actors. Works for a disabled account. */
  eraseEverything(): Promise<{ messages: number; compactionOverlays: number; taskActors: number }>;
}

export function assistantClient(env: { ASSISTANT: DurableObjectNamespace<any> }, principal: Principal): AssistantClient {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const channel = principal.channel === "mcp" || principal.channel === "web" ? principal.channel : "ios";
  const grant: TurnGrant = { channel, scopes: [...principal.scopes], authRef: principal.authRef };
  /** Each call takes a fresh stub and releases it, so the actor can hibernate or be evicted between calls. */
  const call = async <T>(fn: (actor: any) => Promise<T>): Promise<T> => {
    const actor: any = await getAgentByName(env.ASSISTANT as never, principal.userId);
    try {
      return await fn(actor);
    } finally {
      actor[Symbol.dispose]?.();
    }
  };
  const unwrap = <T>(value: T): T => {
    const rejected = (value as { rejected?: { code: string; message: string } } | null)?.rejected;
    if (rejected) throw new AssistantRequestError(rejected.code, rejected.message);
    return value;
  };
  const stub = async (): Promise<any> => new Proxy({}, { get: (_t, method: string) => (method === "then" ? undefined : async (...args: unknown[]) => unwrap(await call((actor) => actor[method](...args)))) });
  const writer = () => requireScope(principal, "write");
  return {
    submitTurn: async (input) => (await stub()).submitTurn(grant, input),
    runTurn: async (input) => (await stub()).runOwnerTurn(grant, input),
    streamTurn: async (input, onEvent) => (await stub()).streamTurn(grant, input, onEvent),
    resumeTurn: async (turnId) => (await stub()).resumeTurn(turnId),
    getTurn: async (turnId) => (await stub()).getTurn(turnId),
    turnEvents: async (turnId, opts) => (await stub()).turnEvents(turnId, opts ?? {}),
    cancelTurn: async (turnId) => (await stub()).cancelTurn(turnId),
    answerClarification: async (turnId, answer) => (await stub()).answerClarification(grant, turnId, answer),
    startResearch: async (request) => (await stub()).startResearch(grant, request),
    transcript: async (opts) => (await stub()).transcript(opts ?? {}),
    recallSearch: async (input) => (await stub()).recallSearch(grant, input),
    deliverResult: async (delivery) => {
      writer();
      return (await stub()).deliverResult(delivery);
    },
    reconcileErasures: async () => {
      writer();
      return (await stub()).reconcileErasures();
    },
    rebuildSanitizedSession: async () => {
      writer();
      return (await stub()).rebuildSanitizedSession();
    },
    projectIndex: async (opts) => (await stub()).projectIndex(opts ?? {}),
    exportConversation: async () => (await stub()).exportConversation(),
    importConversation: async (data) => {
      writer();
      return (await stub()).importConversation(data);
    },
    conversationWatermarks: async () => (await stub()).conversationWatermarks(),
    backupConversation: async () => (await stub()).backupConversation(),
    restoreConversation: async (backup) => {
      writer();
      return (await stub()).restoreConversation(backup);
    },
    eraseEverything: async () => {
      writer();
      return (await stub()).eraseEverything();
    },
  };
}
