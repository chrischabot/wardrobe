import type { TurnEvent, TurnRecord } from "@garderobe/contracts/ext/assistant";
import {
  assistantClient,
  exportAssistantData,
  eraseSearchInstance,
  getInferenceOverview,
  importAssistantData,
  listComfortFeedback,
  listConnections,
  listLifecycleProjects,
  listOrders,
  listReturnCases,
  registerAssistant,
  runAssistantMaintenance,
  AiSearchIndex,
  SubmissionReuseError,
} from "@garderobe/assistant";
import type { Principal } from "@garderobe/domain";
import { API_ERROR_STATUS, type ApiErrorCode } from "@garderobe/contracts/ext/api";
import { ApiException } from "../errors.ts";
import type { ApiRun, ApiRunEvent, ApiRunState, AssistantPort, TurnSubmission } from "../ports.ts";
import type { LaneContext } from "./index.ts";

const STATE: Record<TurnRecord["status"], ApiRunState> = { accepted: "queued", running: "running", needs_input: "needs_input", completed: "completed", failed: "failed", cancelled: "cancelled", resumable: "failed" };

function research(result: Record<string, unknown> | null): NonNullable<ApiRun["result"]>["research"] {
  if (!result || typeof result.summary !== "string") return null;
  const sources = Array.isArray(result.sources) ? (result.sources as Record<string, unknown>[]) : [];
  return {
    verdict: typeof result.verdict === "string" ? result.verdict : null,
    summary: result.summary,
    comparison: Array.isArray(result.comparison) ? (result.comparison as Record<string, unknown>[]) : [],
    sources: sources.map((s) => ({
      title: String(s.title ?? s.url ?? "Source"),
      url: typeof s.url === "string" ? s.url : null,
      checkedAt: typeof s.checkedAt === "string" ? s.checkedAt : null,
      kind: String(s.kind ?? "web"),
      excerpt: typeof s.excerpt === "string" ? s.excerpt : typeof s.quote === "string" ? s.quote : null,
    })),
  };
}

/** Project the assistant's durable turn record as a run. The turn stays the only record; nothing is copied. */
function toRun(record: TurnRecord, events: TurnEvent[]): ApiRun {
  const state = STATE[record.status];
  const lastActivity = [...events].reverse().find((e) => e.type === "activity");
  const terminal = state === "completed" || state === "failed" || state === "cancelled";
  return {
    runId: record.turnId,
    kind: "conversation_turn",
    state,
    createdAt: record.createdAt,
    updatedAt: record.completedAt ?? events.at(-1)?.at ?? record.createdAt,
    activity: terminal ? null : typeof lastActivity?.data.text === "string" ? lastActivity.data.text : typeof lastActivity?.data.label === "string" ? lastActivity.data.label : null,
    lastEventId: events.at(-1)?.seq ?? 0,
    pendingInput: record.clarification ? { inputId: record.clarification.inputId, question: record.clarification.question, choices: record.clarification.choices, actionId: record.clarification.actionId } : null,
    receipts: record.receipts,
    proposals: record.proposals,
    result: terminal || record.reply ? { reply: record.reply, options: [], board: null, research: research(record.result), exportId: null, importId: null } : null,
    error: record.failure ? { code: record.failure.code, message: record.failure.message, resumable: record.failure.resumable } : null,
  };
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Adapt one of the assistant's durable turn events to the API's `RunEventData` shapes, so every run
 * (conversation, research, export, import) speaks one event vocabulary on the wire.
 */
function toEvent(runId: string, e: TurnEvent): ApiRunEvent {
  const d = e.data as Record<string, unknown>;
  let data: Record<string, unknown>;
  switch (e.type) {
    case "run_started":
      data = { kind: "conversation_turn" };
      break;
    case "activity":
      data = { text: str(d.text) ?? str(d.label) ?? "Working" };
      break;
    case "text_delta":
      // The assistant coalesces streamed text: `replace` means this is the complete text so far.
      data = { messageId: str(d.messageId), delta: str(d.delta) ?? str(d.text) ?? "", replace: d.final === true || d.replace === true };
      break;
    case "sources":
      data = { sources: (Array.isArray(d.sources) ? (d.sources as Record<string, unknown>[]) : []).map((s) => ({ title: String(s.title ?? s.url ?? "Source"), url: str(s.url), checkedAt: str(s.checkedAt), kind: String(s.kind ?? "web"), excerpt: str(s.excerpt) ?? str(s.quote) })) };
      break;
    case "command_receipt":
      data = { receipt: "receipt" in d ? d.receipt : d };
      break;
    case "needs_input":
      data = { input: { inputId: String(d.inputId ?? ""), question: String(d.question ?? ""), choices: Array.isArray(d.choices) ? d.choices : [], actionId: str(d.actionId) } };
      break;
    case "run_finished":
      data = { state: STATE[String(d.status ?? d.state) as TurnRecord["status"]] ?? "completed" };
      break;
    default:
      data = d;
  }
  return { eventId: e.seq, runId, type: e.type, at: e.at, data };
}

/**
 * The assistant, mounted. The conversation actor is reached only through `assistantClient`, which
 * addresses it by the verified principal's internal user ID and passes the grant's channel and scopes:
 * a read-only connection gets proposals, never executed writes.
 */
export function createAssistantPort(ctx: LaneContext): AssistantPort {
  const { env, db } = ctx;
  const client = (principal: Principal) => assistantClient({ ASSISTANT: env.ASSISTANT as never }, principal);
  const input = (s: TurnSubmission) => ({ submissionId: s.submissionId, text: s.text, attachments: s.attachments, attachedRefs: s.attachedRefs });
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      // The actor reports refusals with a code; they become the API's typed errors.
      const code = (error as { name?: string; code?: string })?.name === "AssistantRequestError" ? String((error as { code?: string }).code) : error instanceof SubmissionReuseError ? "submission_reuse" : null;
      const message = String((error as Error)?.message ?? "");
      // The same client turn ID with a different body is refused, exactly like a reused idempotency key.
      if (code === "submission_reuse") throw new ApiException("idempotency_key_reuse", "that turn ID was already used for a different message");
      if (code === "invalid_request") throw new ApiException("invalid_command", message);
      if (code && code in API_ERROR_STATUS) throw new ApiException(code as ApiErrorCode, message);
      if (code) throw new ApiException("precondition_failed", message, { reason: code });
      throw error;
    }
  };
  const runOf = async (principal: Principal, record: TurnRecord): Promise<ApiRun> => {
    const { events } = await client(principal).turnEvents(record.turnId, { afterSeq: 0 });
    return toRun(record, events);
  };
  return {
    register: registerAssistant,
    submitTurn: async (principal, submission) => {
      const record = await guard(() => client(principal).submitTurn(input(submission)));
      return { runId: record.turnId, state: STATE[record.status], replayed: !record.accepted };
    },
    runTurn: async (principal, submission) => runOf(principal, await guard(() => client(principal).runTurn(input(submission)))),
    getRun: async (principal, runId) => {
      const record = await guard(() => client(principal).getTurn(runId));
      return record ? runOf(principal, record) : null;
    },
    runEvents: async (principal, runId, afterEventId) => {
      const result = await client(principal).turnEvents(runId, { afterSeq: afterEventId });
      return { events: result.events.map((e) => toEvent(runId, e)), expired: result.expired };
    },
    cancelRun: async (principal, runId) => {
      const c = client(principal);
      const cancelled = await c.cancelTurn(runId);
      const record = await c.getTurn(runId);
      if (!cancelled || !record) throw new ApiException("not_found", "that run was not found");
      const run = await runOf(principal, record);
      const stopped = cancelled.status === "cancelled" ? ["The assistant stopped working on this request."] : [];
      if (cancelled.committedCommandIds.length > 0) stopped.push(`${cancelled.committedCommandIds.length} change(s) had already been recorded and remain recorded; undo them separately if needed.`);
      return { run, stopped };
    },
    answerInput: async (principal, runId, answer) => runOf(principal, await guard(() => client(principal).answerClarification(runId, answer))),
    resumeRun: async (principal, runId) => {
      const record = await guard(() => client(principal).resumeTurn(runId));
      if (!record) throw new ApiException("not_found", "that run was not found");
      return runOf(principal, record);
    },
    maintenance: (nowMs) =>
      runAssistantMaintenance({
        db,
        service: ctx.service,
        env: { ASSISTANT: env.ASSISTANT as never },
        gatewayId: env.AI_GATEWAY_ID ?? "unconfigured",
        nowMs,
        searchIndexFor: (userId) => (env.AI_SEARCH ? new AiSearchIndex(env.AI_SEARCH as never, env.ENVIRONMENT ?? "dev", userId) : null),
      }),
    transcript: (principal, query) => guard(() => client(principal).transcript(query)),
    recall: (principal, query) => guard(() => client(principal).recallSearch(query as never)),
    startResearch: async (principal, request) => {
      const record = await guard(() => client(principal).startResearch(request));
      return { runId: record.turnId, state: STATE[record.status], replayed: !record.accepted };
    },
    orders: (principal) => listOrders(db, principal),
    returns: (principal) => listReturnCases(db, principal),
    projects: (principal) => listLifecycleProjects(db, principal),
    feedback: (principal, garmentId) => listComfortFeedback(db, principal, garmentId ? { garmentIds: [garmentId] } : {}),
    inference: (principal) => getInferenceOverview(db, principal, { gatewayId: env.AI_GATEWAY_ID ?? null, nowMs: ctx.now() }),
    connections: (principal) => listConnections(db, principal),
    exportData: async (principal, opts) => ({ records: await exportAssistantData(db, principal), conversation: opts?.operational ? await client(principal).backupConversation() : await client(principal).exportConversation() }),
    conversationWatermarks: async (principal) => (await client(principal).conversationWatermarks()) as unknown as Record<string, unknown>,
    eraseOwner: async (principal) => {
      const actor = await client(principal).eraseEverything();
      const search = env.AI_SEARCH ? await eraseSearchInstance(env.AI_SEARCH as never, env.ENVIRONMENT ?? "dev", principal.userId) : { instance: null, deleted: false };
      return { ...actor, searchInstanceDeleted: search.deleted };
    },
    importData: async (principal, data) => {
      const records = await importAssistantData(db, principal, data.records as never);
      // The records (tombstones, turns) are in place first: the backup form restores overlays and pending
      // turns against them and rebuilds the recall index; neither form runs inference or an external effect.
      const operational = (data.conversation as { kind?: string } | null)?.kind === "garderobe-conversation-backup";
      const conversation = !data.conversation ? null : operational ? await client(principal).restoreConversation(data.conversation as never) : await client(principal).importConversation(data.conversation as never);
      return { records, conversation };
    },
  };
}
