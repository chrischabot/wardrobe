/**
 * The turn runtime: how a model's tool call becomes (or does not become) a verified domain command.
 *
 * A tool never writes to the database. A write tool hands a typed command to `commit()`, which
 *   1. returns a proposal instead of acting when the connection is read-only;
 *   2. verifies the owner's authority for it in trusted code (see policy/authority.ts);
 *   3. registers a durable action intent under the parent turn BEFORE dispatch - a recovered turn, or a
 *      resampled model proposing the same effect under a new tool-call ID, resolves to the same action and
 *      therefore the same command (the idempotency key derives from the action ID, never from the
 *      provider's tool-call ID);
 *   4. executes through the shared command service and returns the stored receipt.
 * What the model is told afterwards is the receipt's own summary.
 */
import type { CommandReceipt } from "@garderobe/contracts";
import { CommandError, isCommandError, registerActionIntent, type CommandService, type Db, type Principal } from "@garderobe/domain";
import { verifyOwnerStatement, verifyRestrictionLift, type AuthorityCheck } from "../policy/authority.ts";
import type { CanonicalMessage } from "../recall/index.ts";
import type { SearchIndexPort } from "../recall/ai-search.ts";
import type { ExtractionRouter, SearchProvider } from "../research/index.ts";

/** Optional capabilities wired by the composition root (worker) or by tests. Absent = reported unavailable. */
export interface AssistantPorts {
  /** Daily service outfit validation (`validateOutfit` from @garderobe/daily). */
  validateOutfit?: (db: Db, principal: Principal, input: { slots: { role: string; garmentId: string }[]; forDate: string; mode: "for_today" | "explore"; nowMs?: number }) => Promise<{ valid: boolean; violations: { code: string; message: string; garmentIds: string[]; severity: string }[] }>;
  searchProviders?: SearchProvider[];
  extraction?: ExtractionRouter;
  searchIndex?: SearchIndexPort | null;
  /**
   * Read one of THIS owner's private images (media `openAssetImage`). Must throw when the asset does not
   * exist for the principal's owner. Photo intake is refused when this port is absent.
   */
  openImage?: (principal: Principal, assetId: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  /**
   * Daily service decision context (`decisionContext` from @garderobe/daily): for a question about one slot of
   * an actual outfit ("what socks with this?") it returns the outfit's facts, today's eligible pieces for
   * that slot, the forecast and the hard rules, as a ready text block.
   */
  decisionContext?: (principal: Principal, input: { localDate?: string; outfit: { role: string; garmentId: string }[]; role: string; tripId?: string }) => Promise<{ text: string } & Record<string, unknown>>;
  /** Tools of the owner's connected MCP connections, for on-demand description (never executed from here). */
  describeConnectionTools?: (principal: Principal, connectionId: string) => Promise<{ name: string; description: string; inputSchema: unknown }[]>;
}

export interface TurnRuntime {
  db: Db;
  service: CommandService;
  principal: Principal;
  turnId: string;
  /** ID of the owner's message that started the turn; recorded as the evidence reference of owner statements. */
  userMessageId: string;
  channel: string;
  /** True when the connection has no write scope: writes are described, not executed. */
  readOnly: boolean;
  now(): number;
  localDate: string;
  /** Owner text of this turn first, then the most recent earlier owner messages. */
  ownerTexts: string[];
  attachedRefs: string[];
  conversationId: string;
  unindexedSource?: () => Promise<CanonicalMessage[]>;
  ports: AssistantPorts;
  /** Schema-validated product facts from page text, through the model service under this turn's identity. */
  extractProduct?: (page: { url: string; content: string }) => Promise<Record<string, unknown>>;
  /** True once the owner stopped this turn: nothing further is dispatched. */
  isCancelled?: () => Promise<boolean>;
  /** One original conversation message by ID (text and bounded tool payloads). */
  readOriginal?: (messageId: string) => Promise<Record<string, unknown> | null>;
  /** Full-text search over the Think Session. */
  sessionSearch?: (query: string, limit: number) => Promise<{ messageId: string }[]>;
  onReceipt(receipt: CommandReceipt): Promise<void> | void;
  onRefusal(refusal: { tool: string; code: string; message: string }): Promise<void> | void;
  onProposal(proposal: { type: string; summary: string; payload: Record<string, unknown> }): Promise<void> | void;
  onClarification(c: { question: string; choices: { id: string; label: string }[]; actionId: string | null }): Promise<void> | void;
  onActivity(label: string, data?: Record<string, unknown>): Promise<void> | void;
}

export type AuthorityRequirement =
  /** Bookkeeping the owner's question implies (saving research, a shopping candidate): no quote needed. */
  | { level: "record" }
  /** An ordinary reversible request: the owner's words asking for it. */
  | { level: "routine"; ownerQuote: string | undefined }
  /** Creating garments, amending the profile or rules, external authorizations, forgetting. */
  | { level: "sensitive"; ownerQuote: string | undefined }
  /** Lifting a restriction: the owner must have said its condition ended. */
  | { level: "lift_restriction"; ownerQuote: string | undefined; restrictionKind: string };

export interface CommitRequest {
  tool: string;
  type: string;
  payload: Record<string, unknown>;
  targets: string[];
  authority: AuthorityRequirement;
  /** What a read-only connection is shown instead of an execution. */
  proposalSummary: string;
  /** Durable business key for effects that are identified by a source occurrence rather than by the turn. */
  businessKey?: string;
  occurredAt?: string;
}

export type CommitResult =
  | { status: "committed"; commandId: string; outcome: string; summary: string; result: Record<string, unknown>; undoAvailable: boolean; receipt: CommandReceipt }
  | { status: "proposed"; summary: string }
  | { status: "refused"; code: string; message: string };

export function checkAuthority(rt: Pick<TurnRuntime, "ownerTexts">, authority: AuthorityRequirement): AuthorityCheck {
  if (authority.level === "record") return { ok: true };
  if (authority.level === "lift_restriction") return verifyRestrictionLift({ quote: authority.ownerQuote, ownerTexts: rt.ownerTexts, restrictionKind: authority.restrictionKind });
  return verifyOwnerStatement({ quote: authority.ownerQuote, ownerTexts: rt.ownerTexts, level: authority.level });
}

export async function commit(rt: TurnRuntime, req: CommitRequest): Promise<CommitResult> {
  if (rt.readOnly) {
    await rt.onProposal({ type: req.type, summary: req.proposalSummary, payload: req.payload });
    return { status: "proposed", summary: `Not done: this connection can only read. Proposed for the owner to confirm: ${req.proposalSummary}` };
  }
  if (await rt.isCancelled?.()) {
    const refusal = { tool: req.tool, code: "cancelled", message: "the owner stopped this turn" };
    await rt.onRefusal(refusal);
    return { status: "refused", code: "cancelled", message: "Nothing was changed. The owner stopped this turn." };
  }
  const check = checkAuthority(rt, req.authority);
  if (!check.ok) {
    const refusal = { tool: req.tool, code: check.code ?? "not_authorized", message: check.message ?? "not authorized" };
    await rt.onRefusal(refusal);
    return { status: "refused", code: refusal.code, message: `Nothing was changed. ${refusal.message}` };
  }
  try {
    let idempotencyKey: string;
    let actionId: string | undefined;
    if (req.businessKey) {
      idempotencyKey = req.businessKey;
    } else {
      const intent = await registerActionIntent(rt.db, rt.principal, { parentKind: "turn", parentId: rt.turnId, operation: req.type, targets: req.targets, effect: req.payload, nowMs: rt.now() });
      idempotencyKey = intent.idempotencyKey;
      actionId = intent.actionId;
      if (intent.state === "committed" && intent.commandId) {
        // Already done in this turn (recovery or a resampled model): read the receipt, never run it again.
        const stored = await rt.service.getReceipt(rt.principal, intent.commandId);
        if (stored) {
          const replayed = { ...stored, replayed: true };
          await rt.onReceipt(replayed);
          return { status: "committed", commandId: stored.commandId, outcome: stored.outcome, summary: stored.summary, result: stored.result, undoAvailable: stored.undo.available, receipt: replayed };
        }
      }
    }
    const receipt = await rt.service.execute(rt.principal, {
      type: req.type,
      payload: req.payload,
      idempotencyKey,
      authorization: "owner_statement",
      ...(req.occurredAt ? { occurredAt: req.occurredAt } : {}),
      source: { channel: rt.principal.channel, parentKind: "turn", parentId: rt.turnId, ...(actionId ? { actionId } : {}), attachedRefs: rt.attachedRefs },
    });
    await rt.onReceipt(receipt);
    return { status: "committed", commandId: receipt.commandId, outcome: receipt.outcome, summary: receipt.summary, result: receipt.result, undoAvailable: receipt.undo.available, receipt };
  } catch (e) {
    if (isCommandError(e)) {
      const err = e as CommandError;
      const refusal = { tool: req.tool, code: err.code, message: err.message };
      await rt.onRefusal(refusal);
      return { status: "refused", code: err.code, message: `Nothing was changed. ${err.message}` };
    }
    throw e;
  }
}

/** What a tool returns to the model for a committed command: the system's summary, not room for embellishment. */
export function forModel(result: CommitResult): Record<string, unknown> {
  if (result.status === "committed") return { status: "committed", receipt: { commandId: result.commandId, outcome: result.outcome, summary: result.summary, undoAvailable: result.undoAvailable }, result: result.result };
  return result;
}

export function ownerSource(rt: TurnRuntime): { kind: "owner_statement"; ref: string } {
  return { kind: "owner_statement", ref: `message:${rt.userMessageId}` };
}
