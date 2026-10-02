/**
 * The turn runtime: how a model's tool call becomes a recorded observation, a piece of bookkeeping or a
 * PROPOSAL for the owner. Conversation text is never authority for a sensitive change.
 *
 * A tool never writes to the database. A write tool hands a typed command to `commit()`, which
 *   1. classifies it in trusted code (policy/classes.ts);
 *   2. for a wear or wash report, checks that every garment was named by the owner in their own words
 *      or attached to the message (policy/naming.ts) and keeps that provenance with the turn;
 *   3. for everything else that changes the wardrobe, the profile, rules, purchases, returns, memory or
 *      the account - and for any report that failed step 2, and for every write on a read-only
 *      connection - records a PROPOSAL with a summary written by trusted code (policy/describe.ts) and
 *      executes nothing. The owner confirms or rejects that exact proposal in the app;
 *   4. for what may be recorded, registers a durable action intent under the parent turn BEFORE dispatch
 *      (a recovered turn or a resampled model resolves to the same action and the same command), then
 *      executes through the shared command service and returns the stored receipt.
 * What the model is told afterwards is the receipt's or the proposal's own summary.
 */
import type { CommandReceipt } from "@garderobe/contracts";
import { CommandError, all, isCommandError, registerActionIntent, type CommandService, type Db, type Principal } from "@garderobe/domain";
import { classifyChange } from "../policy/classes.ts";
import { describeChange, expectedVersionsFor } from "../policy/describe.ts";
import { garmentsOfCategories, resolveOwnerNaming, type OwnerNaming } from "../policy/naming.ts";
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
  /** Garments under an active restriction at the start of the turn (from the mandatory context). */
  restrictedGarmentIds?: string[];
  /** What was asked in this turn, in the asker's own words (the owner's own voice, or a research request's topic). Bounds what a web search may carry out. */
  requestText?: string;
  conversationId: string;
  unindexedSource?: () => Promise<CanonicalMessage[]>;
  ports: AssistantPorts;
  /** Schema-validated product facts from page text, through the model service under this turn's identity. */
  extractProduct?: (page: { url: string; content: string }) => Promise<Record<string, unknown>>;
  /**
   * Addresses that may be retrieved in this turn (normalized with urlKey): those the owner supplied and
   * those a search of this turn returned. A model cannot make the assistant fetch an address of its own
   * composition, which could carry private data out in the path or query.
   */
  allowedUrls?: Set<string>;
  /** True once the owner stopped this turn: nothing further is dispatched. */
  isCancelled?: () => Promise<boolean>;
  /** One original conversation message by ID (text and bounded tool payloads). */
  readOriginal?: (messageId: string) => Promise<Record<string, unknown> | null>;
  /** Full-text search over the Think Session. */
  sessionSearch?: (query: string, limit: number) => Promise<{ messageId: string }[]>;
  /** Record, with the turn, why an observation was accepted without a tap (trusted code only). */
  onGrant?(grant: Record<string, unknown>): Promise<void> | void;
  /** What the owner named in this turn's own words; resolved once per turn by commit(). */
  naming?: Promise<OwnerNaming>;
  /** Proposals recorded in this turn so far (bounded). */
  proposalCount?: number;
  onReceipt(receipt: CommandReceipt): Promise<void> | void;
  onRefusal(refusal: { tool: string; code: string; message: string }): Promise<void> | void;
  onProposal(proposal: { type: string; summary: string; payload: Record<string, unknown>; expectedVersions?: Record<string, number> }): Promise<void> | void;
  onClarification(c: { question: string; choices: { id: string; label: string }[]; actionId: string | null }): Promise<void> | void;
  onActivity(label: string, data?: Record<string, unknown>): Promise<void> | void;
}

export interface CommitRequest {
  tool: string;
  type: string;
  payload: Record<string, unknown>;
  targets: string[];
  /** Durable business key for effects that are identified by a source occurrence rather than by the turn. */
  businessKey?: string;
  occurredAt?: string;
}

export type CommitResult =
  | { status: "committed"; commandId: string; outcome: string; summary: string; result: Record<string, unknown>; undoAvailable: boolean; receipt: CommandReceipt }
  | { status: "proposed"; summary: string; note: string }
  | { status: "refused"; code: string; message: string };

/** No turn may leave more than this many requests for the owner to go through. */
export const MAX_PROPOSALS_PER_TURN = 8;
/** A wear report is taken without a tap for today and the last week; anything older waits for the owner. */
const WEAR_REPORT_DAYS = 7;

const PROPOSED_NOTE = "NOT DONE. This was recorded as a request for the owner to confirm in the Garderobe app (Settings, Requests to confirm). Nothing has changed. Tell the owner exactly that; never say it was done.";

function garmentsOf(type: string, payload: Record<string, any>): string[] {
  const itemIds = (): string[] => ((payload["items"] ?? []) as { garmentId: string }[]).map((i) => i.garmentId);
  switch (type) {
    case "wear.record":
      return [...(payload["garmentIds"] ?? [])];
    case "wear.amend":
      return [...(payload["remove"] ?? []), ...(payload["add"] ?? [])];
    case "care.mark_dirty":
    case "care.washed":
      return itemIds();
    case "feedback.record":
      return [...(payload["garmentIds"] ?? [])];
    default:
      return [];
  }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

interface ObservationGate {
  ok: boolean;
  /** The command as it may be recorded (a group report is narrowed to what the owner named). */
  payload: Record<string, unknown>;
  provenance: { garmentId: string; basis: "named_by_owner" | "attached_by_owner" | "category_named_by_owner"; matched: string[] }[];
}

/**
 * Whether a wear or wash report (or a comfort note) may be recorded without the owner's tap: every garment
 * in it must have been named by the owner in this turn's own words, in a sentence that reads as their own
 * report, or attached to the message by the owner. Text in attachments and relayed passages never names
 * anything. A report that does not pass is not refused: it becomes a proposal.
 */
async function observationGate(rt: TurnRuntime, type: string, payload: Record<string, any>): Promise<ObservationGate> {
  const no: ObservationGate = { ok: false, payload, provenance: [] };
  rt.naming ??= resolveOwnerNaming(rt.db, rt.principal.userId, rt.ownerTexts.join("\n\n"));
  const naming = await rt.naming;
  const date = (payload["wearingDate"] as string | null | undefined) ?? null;
  if ((type === "wear.record" || type === "wear.amend") && date) {
    const age = daysBetween(date, rt.localDate);
    if (age < 0 || age > WEAR_REPORT_DAYS) return no;
  }
  let effective: Record<string, unknown> = payload;
  let ids = garmentsOf(type, payload);
  const groupReport = type === "care.washed" || type === "care.mark_dirty";
  const inNamedCategory = new Set<string>();
  if (groupReport && naming.categories.size > 0) for (const g of await garmentsOfCategories(rt.db, rt.principal.userId, [...naming.categories])) inNamedCategory.add(g.garmentId);
  if (type === "care.washed" && payload["allOfChannel"]) {
    if (!naming.handwashGroup) {
      // "Washed all my socks": the report covers the hand-wash pieces of the categories the owner named.
      const group = (await garmentsOfCategories(rt.db, rt.principal.userId, [...naming.categories])).filter((g) => g.careChannel === payload["allOfChannel"]);
      if (group.length === 0) return no;
      ids = group.map((g) => g.garmentId);
      effective = { items: ids.map((garmentId) => ({ garmentId })) };
    } else return { ok: true, payload, provenance: [] };
  }
  if (ids.length === 0 && type !== "feedback.record") return no;
  const provenance: ObservationGate["provenance"] = [];
  for (const garmentId of [...new Set(ids)]) {
    const named = naming.named.get(garmentId);
    if (rt.attachedRefs.includes(garmentId)) provenance.push({ garmentId, basis: "attached_by_owner", matched: [] });
    else if (named?.direct) provenance.push({ garmentId, basis: "named_by_owner", matched: named.matched });
    else if (groupReport && inNamedCategory.has(garmentId)) provenance.push({ garmentId, basis: "category_named_by_owner", matched: [] });
    else return no;
  }
  // Words relayed by a connected assistant never record the wear of a piece under an active restriction.
  if (rt.principal.channel === "mcp" && type === "wear.record" && ids.some((id) => (rt.restrictedGarmentIds ?? []).includes(id))) return no;
  return { ok: true, payload: effective, provenance };
}

async function propose(rt: TurnRuntime, req: CommitRequest): Promise<CommitResult> {
  // What would be executed must be a well-formed command about records that exist: the owner is never
  // asked to confirm something that could not be carried out.
  if (rt.service.registry.has(req.type)) {
    const parsed = rt.service.registry.get(req.type).schema.safeParse(req.payload);
    if (!parsed.success) {
      const refusal = { tool: req.tool, code: "invalid_request", message: `that request is not complete or well formed: ${parsed.error.issues.slice(0, 3).map((issue: { path: PropertyKey[]; message: string }) => `${issue.path.join(".")} ${issue.message}`).join("; ")}` };
      await rt.onRefusal(refusal);
      return { status: "refused", code: refusal.code, message: `Nothing was changed. ${refusal.message}` };
    }
  }
  const referenced = [...new Set([...garmentsOf(req.type, req.payload), ...(typeof req.payload["garmentId"] === "string" ? [req.payload["garmentId"] as string] : [])])];
  if (referenced.length > 0) {
    const known = new Set((await all<{ garment_id: string }>(rt.db, `SELECT garment_id FROM garments WHERE user_id = ? AND garment_id IN (${referenced.map(() => "?").join(",")})`, rt.principal.userId, ...referenced)).map((r) => r.garment_id));
    const missing = referenced.filter((id) => !known.has(id));
    if (missing.length > 0) {
      const refusal = { tool: req.tool, code: "not_found", message: `no such piece in this wardrobe: ${missing.join(", ")}. Look the piece up first; nothing is created to make a reference resolve` };
      await rt.onRefusal(refusal);
      return { status: "refused", code: refusal.code, message: `Nothing was changed. ${refusal.message}` };
    }
  }
  rt.proposalCount = (rt.proposalCount ?? 0) + 1;
  if (rt.proposalCount > MAX_PROPOSALS_PER_TURN) {
    const refusal = { tool: req.tool, code: "too_many_requests", message: `this turn already left ${MAX_PROPOSALS_PER_TURN} requests for the owner to confirm; no more are added` };
    await rt.onRefusal(refusal);
    return { status: "refused", code: refusal.code, message: `Nothing was changed. ${refusal.message}` };
  }
  const summary = await describeChange(rt.db, rt.principal.userId, req.type, req.payload);
  const expectedVersions = await expectedVersionsFor(rt.db, rt.principal.userId, req.type, req.payload);
  await rt.onProposal({ type: req.type, summary, payload: req.payload, ...(Object.keys(expectedVersions).length > 0 ? { expectedVersions } : {}) });
  return { status: "proposed", summary, note: PROPOSED_NOTE };
}

export async function commit(rt: TurnRuntime, req: CommitRequest): Promise<CommitResult> {
  if (await rt.isCancelled?.()) {
    const refusal = { tool: req.tool, code: "cancelled", message: "the owner stopped this turn" };
    await rt.onRefusal(refusal);
    return { status: "refused", code: "cancelled", message: "Nothing was changed. The owner stopped this turn." };
  }
  // A read-only connection changes nothing at all.
  if (rt.readOnly) return propose(rt, req);
  const cls = classifyChange(req.type, req.payload, rt.principal.channel);
  if (cls === "confirm") return propose(rt, req);
  let payload = req.payload;
  if (cls === "observation") {
    const gate = await observationGate(rt, req.type, req.payload);
    if (!gate.ok) return propose(rt, req);
    payload = gate.payload;
    await rt.onGrant?.({ tool: req.tool, type: req.type, basis: "owner_report", messageId: rt.userMessageId, garments: gate.provenance });
  }
  try {
    let idempotencyKey: string;
    let actionId: string | undefined;
    if (req.businessKey) {
      idempotencyKey = req.businessKey;
    } else {
      const intent = await registerActionIntent(rt.db, rt.principal, { parentKind: "turn", parentId: rt.turnId, operation: req.type, targets: req.targets, effect: payload, nowMs: rt.now() });
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
      payload,
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

/** An address normalized for comparison: scheme, host, path and query; no fragment, no trailing slash. Null when it is not a valid https address. */
export function urlKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Why an address may not be retrieved in this turn, or null when it may. */
export function retrievalRefusal(rt: Pick<TurnRuntime, "allowedUrls">, url: string): string | null {
  const key = urlKey(url);
  if (!key) return "that is not a public https address";
  if (rt.allowedUrls && !rt.allowedUrls.has(key)) return "that address was not given by the owner and did not come from a search in this turn; only those are retrieved. Search first, or ask the owner for the link";
  return null;
}

/** Words about the owner's body and health: they leave in a search query only when the request itself used them. */
const PRIVATE_TERMS = /\b(nerve|neuropath\w*|injur\w*|surgery|operation|diagnos\w*|chemo\w*|cancer|diabet\w*|arthrit\w*|medical|medication|disab\w*|podiatr\w*|physio\w*|rash|eczema|psoriasis|swelling|swollen|pain|weight|kg|kilos?|stone|lbs?|pounds heavy|bmi|password|address|postcode|phone|salary|income)\b/gi;

/**
 * Why a web search query may not be sent, or null when it may. A query is model-written text that leaves
 * to a third party, so it must not be a vehicle for the owner's private facts: every number in it (a
 * measurement, a size, a date of birth) and every word about the owner's body or health must already be
 * in what was asked in this turn, or be part of a wardrobe or product record's own name (a model number).
 * This bounds what a search can carry; it does not make search results trustworthy.
 */
export async function searchQueryRefusal(rt: Pick<TurnRuntime, "db" | "principal" | "requestText">, query: string): Promise<string | null> {
  const asked = ` ${(rt.requestText ?? "").toLowerCase()} `;
  const q = query.toLowerCase();
  const numbers = q.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const unknown = numbers.filter((n) => !asked.includes(n) && !(n.length === 4 && Number(n) >= 1800 && Number(n) <= 2099));
  if (unknown.length > 0) {
    const names = (await all<{ name: string }>(rt.db, "SELECT name FROM garments WHERE user_id = ? UNION ALL SELECT name FROM products WHERE user_id = ?", rt.principal.userId, rt.principal.userId)).map((r) => r.name.toLowerCase()).join(" ");
    const leaking = unknown.filter((n) => !names.includes(n));
    if (leaking.length > 0) return `the query carries a number (${leaking.join(", ")}) that was not in what was asked and is not part of a product name; measurements, sizes and other private values are not sent to a search provider`;
  }
  const terms = [...new Set((q.match(PRIVATE_TERMS) ?? []).filter((t) => !asked.includes(t)))];
  if (terms.length > 0) return `the query mentions ${terms.join(", ")}, which was not in what was asked; the owner's health and personal details are not sent to a search provider`;
  return null;
}
