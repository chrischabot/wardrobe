/**
 * The turn runtime: how a model's tool call becomes a receipt or, in the few cases the owner's decision of
 * 2026-10-05 keeps for the signed-in owner, a REQUEST in the app.
 *
 * A tool never writes to the database. A write tool hands a typed command to `commit()`, which
 *   1. classifies it in trusted code (policy/classes.ts);
 *   2. keeps as a request, with a summary written by trusted code (policy/describe.ts), executing nothing:
 *      every write on a read-only connection; the section 3 changes (`confirm`); a direction from a turn
 *      in which the owner wrote no words of their own (a photograph, an attachment, a tapped choice); a
 *      wear or wash report that trusted code does not find in the owner's own words (policy/report.ts);
 *      a direction that the owner's own words do not ask for (policy/intent.ts: text in attachments,
 *      pasted or relayed passages and tool results never does);
 *      and a restriction lift that the owner's words do not state (policy/ended.ts);
 *   3. refuses outright a restriction lift asked for through a connected assistant;
 *   4. otherwise records WHY it may be applied with the turn (a grant: `owner_report` with its provenance
 *      for a report, `owner_direction` for a direction) - the ledger hook refuses a turn command without
 *      one - registers a durable action intent under the parent turn BEFORE dispatch (a recovered turn or a
 *      resampled model resolves to the same action and command), executes through the shared command
 *      service and returns the stored receipt, whose undo says whether it can be taken back.
 * What the model is told afterwards is the receipt's or the request's own summary.
 */
import type { CommandReceipt } from "@garderobe/contracts";
import { CommandError, all, first, isCommandError, registerActionIntent, type CommandService, type Db, type Principal } from "@garderobe/domain";
import { classifyChange, forbiddenForConnectedAssistant, indirectReach, targetIdsOf, MAX_APPLIED_CHANGES_PER_TURN } from "../policy/classes.ts";
import { describeChange, expectedVersionsFor } from "../policy/describe.ts";
import { endedCovers, statesConditionEnded } from "../policy/ended.ts";
import { ownerRequests, type RecordContext } from "../policy/intent.ts";
import { loadWardrobeWords, type GarmentWords } from "../policy/naming.ts";
import { ownerAuthoredText } from "../policy/voice.ts";
import { attachedGarmentIds, coverOf, resolveOwnerReports, type OwnerReport, type ReportKind } from "../policy/report.ts";
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
  /** The owner's IANA time zone (settings), for checking a reminder's local day and time. */
  timezone?: string;
  /**
   * The owner's words that can stand behind a change in this turn: this turn's own text and, ONLY when
   * this turn answers a question the assistant asked, the text of the message that question was about.
   * No other earlier message is ever in this list. Empty texts are left out.
   */
  ownerTexts: string[];
  /** The owner's own text of this turn's message alone ("" for a photograph, an attachment or a tapped choice). */
  currentOwnerText: string;
  /** When this turn answers the assistant's question: the ID of the owner's message that question was about. */
  askedMessageId?: string;
  attachedRefs: string[];
  /** True when the owner attached a photograph to this turn's message. */
  hasImages?: boolean;
  /** The piece the owner tapped as the answer to the assistant's question (the choice's ID), if any. */
  chosenGarmentIds?: string[];
  /** The owner's wardrobe as naming reads it, loaded once per turn by commit(). */
  wardrobe?: Promise<GarmentWords[]>;
  /** Garments under an active restriction at the start of the turn (from the mandatory context). Informational: a report of wearing one is still a fact. */
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
  /** Record, with the turn, why a change was applied (trusted code only): an owner's report or an owner's direction. */
  onGrant?(grant: Record<string, unknown>): Promise<void> | void;
  /** The owner's own wear and wash reports of this turn, read by trusted code; resolved once per turn by commit(). */
  reports?: Promise<OwnerReport[]>;
  /** Proposals recorded in this turn so far (bounded). */
  proposalCount?: number;
  /**
   * The per-turn cap (MAX_APPLIED_CHANGES_PER_TURN) counts distinct commands this turn committed, plus slots
   * held by calls still in flight. A replay of this turn's own command (recovery, a repeated tool call) is
   * the same command ID and counts once; it never takes a second slot.
   */
  appliedCommandIds?: Set<string>;
  /** Loads appliedCommandIds from the ledger once per runtime, so a recovered runtime keeps the turn's count. */
  appliedLoaded?: Promise<void>;
  reservedSlots?: number;
  /** In-flight commits by trusted command identity so concurrent identical calls share one slot and receipt. */
  inFlightCommits?: Map<string, Promise<CommitResult>>;
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
  /**
   * Identifiers TRUSTED CODE made up in this turn for the record this command creates (never a value the
   * model supplied). The summary says such a record is new instead of printing the identifier.
   */
  minted?: string[];
  /** Durable business key for effects that are identified by a source occurrence rather than by the turn. */
  businessKey?: string;
  occurredAt?: string;
}

export type CommitResult =
  | { status: "committed"; commandId: string; outcome: string; summary: string; result: Record<string, unknown>; undoAvailable: boolean; receipt: CommandReceipt }
  | { status: "proposed"; summary: string; note: string; reason: ProposalReason }
  | { status: "refused"; code: string; message: string };

/** Why a change was kept as a request for the owner instead of being applied. */
export type ProposalReason = "read_only_connection" | "owner_confirmation_required" | "no_owner_words" | "report_not_in_owner_words" | "not_requested_by_owner" | "lift_not_stated_by_owner" | "turn_change_limit";

/** No turn may leave more than this many requests for the owner to go through. */
export const MAX_PROPOSALS_PER_TURN = 8;

/**
 * No turn may apply more than MAX_APPLIED_CHANGES_PER_TURN changes (defined in policy/classes.ts, which also
 * holds back a single command of wider reach; re-exported here). Observations and directions count;
 * bookkeeping does not, and a repeated change that is the turn's own command counts once. Further changes
 * are kept as requests, counted against MAX_PROPOSALS_PER_TURN. A SAFETY ADDITION, not a specification
 * requirement: the coordinator's decision of 2026-10-12 under the owner's standing delegation, so that one
 * compromised step cannot apply hundreds of changes that would each need its own undo.
 */
export { MAX_APPLIED_CHANGES_PER_TURN };

/** Changes the ledger records only from the owner's own statement (packages/domain refuses a photograph or a model inference as their source). */
const NEEDS_OWNER_WORDS = new Set(["style.add_amendment", "style.add_direction", "measurement.record"]);

const PROPOSED_NOTE: Record<ProposalReason, string> = {
  read_only_connection: "NOT DONE. This connection may only read, so the change was recorded as a request for the owner to confirm in the Garderobe app (Settings, Requests to confirm). Nothing has changed. Tell the owner exactly that.",
  owner_confirmation_required: "NOT DONE. This kind of change (irreversible, an authorization towards someone else, what a model or connection may reach, or rewriting the profile document) waits for the owner to confirm it in the Garderobe app (Settings, Requests to confirm). Nothing has changed. Tell the owner exactly that.",
  no_owner_words: "NOT DONE. This message has no words of the owner's own (only a photograph, an attachment, pasted text or a tapped choice), so the change was recorded as a request for the owner to confirm in the Garderobe app. Nothing has changed. Tell the owner exactly that, or let them say it in their own words.",
  report_not_in_owner_words: "NOT DONE. The system did not find this report, with this day and these pieces, in the owner's own words, so it was recorded as a request for the owner to confirm in the Garderobe app. Nothing has changed. Tell the owner exactly that.",
  not_requested_by_owner: "NOT DONE. The owner's own words in this message do not ask for this change (text in attachments, pasted or quoted passages, pages and tool results never does), so it was recorded as a request for the owner to confirm in the Garderobe app. Nothing has changed. Tell the owner exactly that, or let them ask for it in their own words.",
  lift_not_stated_by_owner: "NOT DONE. The owner's words do not say that the restriction's condition has ended, so the restriction stays in force and a request to lift it was recorded for the owner to confirm in the Garderobe app. Tell the owner exactly that.",
  turn_change_limit: `NOT DONE. This turn has already applied ${MAX_APPLIED_CHANGES_PER_TURN} changes, the most one turn may apply, so this one was recorded as a request for the owner to confirm in the Garderobe app. Nothing more has changed. Tell the owner exactly that.`,
};

/**
 * Every piece a request refers to, wherever the command keeps it: the piece itself, a list of pieces, the
 * two sides of a merge, the pieces a restriction covers and the items of a project or a care report. A
 * request about a piece that does not exist is never put before the owner (adversarial finding I06-1).
 */
function garmentRefsIn(payload: Record<string, any>): string[] {
  const out: unknown[] = [payload["garmentId"], payload["sourceGarmentId"], payload["targetGarmentId"]];
  for (const list of [payload["garmentIds"], payload["scope"]?.["garmentIds"]]) if (Array.isArray(list)) out.push(...list);
  if (Array.isArray(payload["items"])) for (const item of payload["items"]) out.push(item?.["garmentId"]);
  return out.filter((id): id is string => typeof id === "string" && id.length > 0);
}

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

interface ObservationGate {
  ok: boolean;
  provenance: { garmentId: string; basis: "named_by_owner" | "attached_by_owner"; matched: string[]; clause: string }[];
}

const REPORT_KIND: Record<string, ReportKind> = { "wear.record": "wear", "care.mark_dirty": "dirty", "care.washed": "washed" };

/**
 * Whether a wear or wash report may be recorded at once: trusted code must find that very report in the
 * owner's own words of this turn (policy/report.ts) - a clause in the form of a first-person report of
 * this kind, for a wear report dated by that code to exactly the command's date, that names every garment
 * of the command or points at garments the owner attached. A group ("all my hand-wash things"), a
 * model-chosen date and text in attachments or relayed passages never pass. A report that does not pass
 * is not refused: it becomes a request. No refusal for a restricted piece: a report of what was worn is
 * a fact (owner decision of 2026-10-05).
 */
async function observationGate(rt: TurnRuntime, type: string, payload: Record<string, any>): Promise<ObservationGate> {
  const no: ObservationGate = { ok: false, provenance: [] };
  const kind = REPORT_KIND[type];
  if (!kind) return no;
  // A whole care channel is a group the owner did not enumerate: kept as a request.
  if (payload["allOfChannel"]) return no;
  const ids = garmentsOf(type, payload);
  if (ids.length === 0) return no;
  rt.reports ??= resolveOwnerReports(rt.db, rt.principal.userId, rt.ownerTexts, rt.localDate);
  const date = kind === "wear" ? ((payload["wearingDate"] as string | null | undefined) ?? null) : null;
  if (kind === "wear" && !date) return no;
  // What a connected assistant says the owner attached is that assistant's word, not the owner's act in
  // the app: on that channel a piece counts only when the owner's relayed words name it.
  const cover = coverOf(await rt.reports, kind, date, ids, attachedGarmentIds(rt.principal.channel === "mcp" ? [] : rt.attachedRefs));
  if (!cover) return no;
  return { ok: true, provenance: cover };
}

async function propose(rt: TurnRuntime, req: CommitRequest, reason: ProposalReason): Promise<CommitResult> {
  // An action intent or business-key command already committed in this turn resolves to its stored receipt
  // rather than being proposed or refused on a replay or resumed turn.
  rt.appliedLoaded ??= loadAppliedThisTurn(rt);
  await rt.appliedLoaded;
  const replay = await sameTurnReceipt(rt, req);
  if (replay) return replay;
  if (req.type === "reminder.set") {
    const dueMs = Date.parse(String(req.payload["dueAt"] ?? ""));
    if (Number.isNaN(dueMs) || dueMs <= rt.now()) {
      return refuseOutright(rt, req, "precondition_failed", "that time has already passed; nothing was set");
    }
  }
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
  // What the ledger accepts only on the owner's own statement is not offered from a message in which the
  // owner said nothing: the confirmation could never be carried out, and a photograph or an attachment is
  // not a statement.
  // Decided from the turn itself, not from a field a tool may or may not have put in the payload.
  const sourceKind = (req.payload["source"] as { kind?: unknown } | undefined)?.kind;
  if (NEEDS_OWNER_WORDS.has(req.type) && (!ownerSpoke(rt) || sourceKind === "photograph" || sourceKind === "model_inference")) {
    const refusal = { tool: req.tool, code: "no_owner_words", message: "the owner wrote nothing in their own words in this message; a rule, a profile amendment or a measurement is recorded only from what the owner says. Tell the owner what you found and let them say it" };
    await rt.onRefusal(refusal);
    return { status: "refused", code: refusal.code, message: `Nothing was changed. ${refusal.message}` };
  }
  const unknown = await refuseUnknownPieces(rt, req);
  if (unknown) return unknown;
  // The summary states the whole change in full. A change too long to show in full is not shortened and
  // not proposed: the owner never confirms text they were not shown (third review, finding B).
  let summary: string;
  try {
    summary = await describeChange(rt.db, rt.principal.userId, req.type, req.payload, { minted: req.minted ?? [] });
  } catch (e) {
    if (!isCommandError(e)) throw e;
    const refusal = { tool: req.tool, code: "too_long_to_confirm", message: (e as CommandError).message };
    await rt.onRefusal(refusal);
    return { status: "refused", code: refusal.code, message: `Nothing was changed. ${refusal.message}` };
  }
  rt.proposalCount = (rt.proposalCount ?? 0) + 1;
  if (rt.proposalCount > MAX_PROPOSALS_PER_TURN) {
    const refusal = { tool: req.tool, code: "too_many_requests", message: `this turn already left ${MAX_PROPOSALS_PER_TURN} requests for the owner to confirm; no more are added` };
    await rt.onRefusal(refusal);
    return { status: "refused", code: refusal.code, message: `Nothing was changed. ${refusal.message}` };
  }
  const expectedVersions = await expectedVersionsFor(rt.db, rt.principal.userId, req.type, req.payload);
  await rt.onProposal({ type: req.type, summary, payload: req.payload, ...(Object.keys(expectedVersions).length > 0 ? { expectedVersions } : {}) });
  return { status: "proposed", summary, note: PROPOSED_NOTE[reason], reason };
}

async function refuseOutright(rt: Pick<TurnRuntime, "onRefusal">, req: CommitRequest, code: string, message: string): Promise<CommitResult> {
  await rt.onRefusal({ tool: req.tool, code, message });
  return { status: "refused", code, message: `Nothing was changed. ${message}` };
}

/** A change about a piece that does not exist is neither applied nor put before the owner; nothing is created to make it resolve. */
export async function refuseUnknownPieces(rt: Pick<TurnRuntime, "db" | "principal" | "onRefusal">, req: CommitRequest): Promise<CommitResult | null> {
  const minted = new Set(req.minted ?? []);
  // An identifier trusted code made up in this turn for the record this command creates is not a reference to
  // an existing piece: the command is what creates it.
  const referenced = [...new Set([...garmentsOf(req.type, req.payload), ...garmentRefsIn(req.payload)])].filter((id) => !minted.has(id));
  if (referenced.length === 0) return null;
  const known = new Set((await all<{ garment_id: string }>(rt.db, `SELECT garment_id FROM garments WHERE user_id = ? AND garment_id IN (${referenced.map(() => "?").join(",")})`, rt.principal.userId, ...referenced)).map((r) => r.garment_id));
  const missing = referenced.filter((id) => !known.has(id));
  if (missing.length === 0) return null;
  return refuseOutright(rt, req, "not_found", `no such piece in this wardrobe: ${missing.join(", ")}. Look the piece up first; nothing is created to make a reference resolve`);
}

export async function commit(rt: TurnRuntime, req: CommitRequest): Promise<CommitResult> {
  if (await rt.isCancelled?.()) {
    const refusal = { tool: req.tool, code: "cancelled", message: "the owner stopped this turn" };
    await rt.onRefusal(refusal);
    return { status: "refused", code: "cancelled", message: "Nothing was changed. The owner stopped this turn." };
  }
  // A connected assistant never lifts a restriction, nor undoes the command that recorded one: a relayed
  // statement cannot be verified as the owner's. Refused, not kept (contract section 3).
  if (rt.principal.channel === "mcp") {
    const target = req.type === "command.undo" ? await first<{ type: string }>(rt.db, "SELECT type FROM commands WHERE user_id = ? AND command_id = ?", rt.principal.userId, String(req.payload["commandId"] ?? "")) : null;
    const forbidden = forbiddenForConnectedAssistant(req.type, req.payload, target);
    if (forbidden) return refuseOutright(rt, req, forbidden, "a restriction is lifted only by the owner in the Garderobe app, never through a connected assistant");
  }
  // A read-only connection changes nothing at all.
  if (rt.readOnly) return propose(rt, req, "read_only_connection");
  const cls = classifyChange(req.type, req.payload, rt.principal.channel, await indirectReach(rt.db, rt.principal.userId, req.type, req.payload));
  if (cls === "confirm") return propose(rt, req, "owner_confirmation_required");
  const payload = req.payload;
  let grant: Parameters<NonNullable<TurnRuntime["onGrant"]>>[0] | undefined;
  if (cls === "observation") {
    const gate = await observationGate(rt, req.type, req.payload);
    if (!gate.ok) return propose(rt, req, "report_not_in_owner_words");
    // The report is credited to the message whose owner words carry it: a tapped clarification answer has none,
    // and then the report is the message the question was about (ownerSource), never the wordless tap.
    grant = { tool: req.tool, type: req.type, basis: "owner_report", messageId: ownerSource(rt).ref.slice("message:".length), ...(req.type === "wear.record" ? { wearingDate: req.payload["wearingDate"] } : {}), garments: gate.provenance };
  } else if (cls === "direction") {
    // A direction is the owner's to give, in their own words of this turn.
    if (!ownerSpoke(rt)) return propose(rt, req, "no_owner_words");
    const unknown = await refuseUnknownPieces(rt, req);
    if (unknown) return unknown;
    let statement: string | undefined;
    let requestedBy: string | undefined;
    if (req.type === "assistant.lift_restriction") {
      // A hard constraint ends only when the owner SAYS its condition has ended (policy/ended.ts), and the
      // statement ends only the restriction whose condition it speaks to: "my feet have healed" never lifts
      // a restriction on storage, a sale or a trip.
      const ended = statesConditionEnded(rt.ownerTexts);
      if (!ended) return propose(rt, req, "lift_not_stated_by_owner");
      const restriction = await first<{ kind: string; reason: string }>(rt.db, "SELECT kind, reason FROM restrictions WHERE user_id = ? AND restriction_id = ?", rt.principal.userId, String(req.payload["restrictionId"] ?? ""));
      if (!restriction || !endedCovers(restriction, ended)) return propose(rt, req, "lift_not_stated_by_owner");
      statement = ended.sentence;
    } else {
      // The owner's own words must ask for THIS change (policy/intent.ts); writing something is not enough.
      rt.wardrobe ??= loadWardrobeWords(rt.db, rt.principal.userId);
      // What a connected assistant says the owner attached is its word, not the owner's act in the app.
      const pointedAt = [...(rt.chosenGarmentIds ?? []), ...attachedGarmentIds(rt.principal.channel === "mcp" ? [] : rt.attachedRefs)];
      const intent = ownerRequests(req.type, req.payload, { ownerTexts: rt.ownerTexts, wardrobe: await rt.wardrobe, pointedAt, localDate: rt.localDate, ...(rt.timezone ? { timezone: rt.timezone } : {}), record: await recordContextFor(rt, req.type, req.payload) });
      if (!intent.ok) return propose(rt, req, "not_requested_by_owner");
      requestedBy = intent.sentence;
    }
    grant = { tool: req.tool, type: req.type, basis: "owner_direction", messageId: ownerSource(rt).ref.slice("message:".length), targets: targetIdsOf(payload, req.type), ...(statement ? { statement } : {}), ...(requestedBy ? { requestedBy } : {}) };
  }
  // The per-turn cap on applied changes. Tool calls of one step run concurrently, so the in-flight entry and
  // the slot are taken in the same synchronous step as the check, and given back if nothing new was applied.
  // A recovered runtime starts from what the ledger says this turn already applied, never from zero.
  rt.appliedLoaded ??= loadAppliedThisTurn(rt);
  await rt.appliedLoaded;
  const inFlightMap = (rt.inFlightCommits ??= new Map<string, Promise<CommitResult>>());
  const inFlightKey = req.businessKey
    ? `bk:${req.businessKey}:${req.type}:${canonical(payload)}`
    : `intent:${req.type}:${canonical(req.targets)}:${canonical(payload)}`;
  const existingInFlight = inFlightMap.get(inFlightKey);
  if (existingInFlight) {
    const shared = await existingInFlight;
    if (shared.status === "committed") {
      const replayed = { ...shared.receipt, replayed: true };
      await rt.onReceipt(replayed);
      return { ...shared, receipt: replayed };
    }
    return shared;
  }
  let slot = false;
  const appliedIds = (rt.appliedCommandIds ??= new Set<string>());
  const releaseSlot = () => {
    if (slot) {
      rt.reservedSlots = Math.max(0, (rt.reservedSlots ?? 1) - 1);
      slot = false;
    }
  };
  const counts = (commandId: string) => {
    if (slot) {
      appliedIds.add(commandId);
      releaseSlot();
    }
  };
  if (cls !== "bookkeeping" && appliedIds.size + (rt.reservedSlots ?? 0) < MAX_APPLIED_CHANGES_PER_TURN) {
    rt.reservedSlots = (rt.reservedSlots ?? 0) + 1;
    slot = true;
  }
  const runCommit = (async (): Promise<CommitResult> => {
    try {
      if (cls !== "bookkeeping") {
        // A business-key command that already committed (in this turn or an earlier turn) applies no new change:
        // resolve its stored receipt and release any reserved slot.
        if (req.businessKey) {
          const replay = await sameTurnReceipt(rt, req);
          if (replay) return replay;
        }
        if (!slot) {
          // At the cap when this call started: a repeat of a change this turn already applied still returns its
          // stored receipt, and if a concurrent replay just released a slot we claim it now.
          const replay = await sameTurnReceipt(rt, req);
          if (replay) return replay;
          if (appliedIds.size + (rt.reservedSlots ?? 0) < MAX_APPLIED_CHANGES_PER_TURN) {
            rt.reservedSlots = (rt.reservedSlots ?? 0) + 1;
            slot = true;
          } else {
            return await propose(rt, req, "turn_change_limit");
          }
        }
      }
      if (grant) await rt.onGrant?.(grant);
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
            // This turn's own command: counted once by its ID, however often it is replayed.
            if (APPLIED_OUTCOMES.has(stored.outcome)) counts(stored.commandId);
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
      // Counted as soon as the ledger applied it, before any callback that could throw. A replay here is an
      // earlier turn's command under the same business key: nothing new was applied. A merge applies a change too.
      if (APPLIED_OUTCOMES.has(receipt.outcome) && !receipt.replayed) counts(receipt.commandId);
      // A new piece, a rename or an alias changes what the owner's words can name: later calls read it afresh.
      if (req.type.startsWith("garment.") || req.type === "purchase.import_order" || req.type === "assistant.report_arrival") rt.wardrobe = undefined;
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
    } finally {
      inFlightMap.delete(inFlightKey);
      // The in-flight reservation is released if it was not already transferred into appliedCommandIds.
      releaseSlot();
    }
  })();
  inFlightMap.set(inFlightKey, runCommit);
  return runCommit;
}

/** Receipt outcomes that changed the ledger and so take a slot of the per-turn cap. */
const APPLIED_OUTCOMES: ReadonlySet<string> = new Set(["committed", "merged"]);

/**
 * Seed the turn's applied-change set from every command this turn applied as the assistant (recovery, a fresh
 * runtime): those made through an action intent AND those made under a business key, which register none.
 */
async function loadAppliedThisTurn(rt: TurnRuntime): Promise<void> {
  const rows = await all<{ operation: string; effect_json: string; command_id: string }>(
    rt.db,
    "SELECT type AS operation, payload_json AS effect_json, command_id FROM commands WHERE user_id = ? AND actor = 'assistant' AND outcome IN ('committed', 'merged') AND json_extract(source_json, '$.parentKind') = 'turn' AND json_extract(source_json, '$.parentId') = ?",
    rt.principal.userId,
    rt.turnId,
  );
  const ids = (rt.appliedCommandIds ??= new Set<string>());
  for (const r of rows) {
    let effect: Record<string, unknown> = {};
    try {
      effect = JSON.parse(r.effect_json) as Record<string, unknown>;
    } catch {
      /* an unreadable effect still counts */
    }
    if (classifyChange(r.operation, effect, rt.principal.channel) !== "bookkeeping") ids.add(r.command_id);
  }
}

/** Canonical JSON (sorted keys) for comparing a request's effect with a stored action intent's. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The stored receipt of the very same change committed earlier in this turn (same operation, targets and
 * effect), read without registering anything; null when there is none. Used at the per-turn cap so a replay
 * is recognised before the cap would turn it into a request.
 */
async function sameTurnReceipt(rt: TurnRuntime, req: CommitRequest): Promise<CommitResult | null> {
  let commandId: string | null = null;
  let sameTurnBusinessKey = false;
  if (req.businessKey) {
    // A business-key command is found by its key and verified against both type and canonical payload; whether
    // it was committed in this turn or an earlier turn, replaying it applies no new change.
    const row = await first<{ command_id: string; parent_id: string | null; type: string; payload_json: string }>(
      rt.db,
      "SELECT command_id, json_extract(source_json, '$.parentId') AS parent_id, type, payload_json FROM commands WHERE user_id = ? AND idempotency_key = ?",
      rt.principal.userId,
      req.businessKey,
    );
    if (!row || row.type !== req.type) return null;
    try {
      if (canonical(JSON.parse(row.payload_json)) !== canonical(req.payload)) return null;
    } catch {
      return null;
    }
    sameTurnBusinessKey = row.parent_id === rt.turnId;
    commandId = row.command_id;
  } else {
    const wantedTargets = canonical(req.targets);
    const wantedEffect = canonical(req.payload);
    const rows = await all<{ command_id: string | null; targets_json: string; effect_json: string }>(
      rt.db,
      "SELECT command_id, targets_json, effect_json FROM action_intents WHERE user_id = ? AND parent_kind = 'turn' AND parent_id = ? AND operation = ? AND state = 'committed'",
      rt.principal.userId,
      rt.turnId,
      req.type,
    );
    const hit = rows.find((r) => {
      if (!r.command_id) return false;
      try {
        return canonical(JSON.parse(r.targets_json)) === wantedTargets && canonical(JSON.parse(r.effect_json)) === wantedEffect;
      } catch {
        return false;
      }
    });
    commandId = hit?.command_id ?? null;
  }
  if (!commandId) return null;
  const stored = await rt.service.getReceipt(rt.principal, commandId);
  if (!stored) return null;
  if (sameTurnBusinessKey && APPLIED_OUTCOMES.has(stored.outcome) && classifyChange(req.type, req.payload, rt.principal.channel) !== "bookkeeping") {
    (rt.appliedCommandIds ??= new Set<string>()).add(stored.commandId);
  }
  const replayed = { ...stored, replayed: true };
  await rt.onReceipt(replayed);
  return { status: "committed", commandId: stored.commandId, outcome: stored.outcome, summary: stored.summary, result: stored.result, undoAvailable: stored.undo.available, receipt: replayed };
}

/**
 * What trusted code reads about the existing record a change refers to, so the intent check can require the
 * owner's sentence to name it (policy/intent.ts): a return's piece and merchant, an order's merchant and
 * number, a reminder's title, a remembered fact's text, a project's title and an earlier change's receipt
 * (and whether it is the owner's most recent change). Null when the change refers to no such record.
 */
async function recordContextFor(rt: TurnRuntime, type: string, payload: Record<string, any>): Promise<RecordContext | null> {
  const u = rt.principal.userId;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (type) {
    case "return.update_case":
    case "return.link_exchange": {
      const r = await first<{ garment_id: string | null; name: string | null; merchant: string | null }>(rt.db, "SELECT c.garment_id, g.name, o.merchant FROM return_cases c LEFT JOIN garments g ON g.user_id = c.user_id AND g.garment_id = c.garment_id LEFT JOIN orders o ON o.user_id = c.user_id AND o.order_id = c.order_id WHERE c.user_id = ? AND c.case_id = ?", u, s(payload["caseId"]));
      return r ? { garmentId: r.garment_id, words: [r.name ?? "", r.merchant ?? ""] } : null;
    }
    case "return.open_case":
    case "purchase.record_event":
    case "purchase.mark_delivered": {
      const r = await first<{ merchant: string; order_number: string | null }>(rt.db, "SELECT merchant, order_number FROM orders WHERE user_id = ? AND order_id = ?", u, s(payload["orderId"]));
      const line = type === "purchase.mark_delivered" ? await first<{ garment_id: string | null }>(rt.db, "SELECT garment_id FROM order_lines WHERE user_id = ? AND order_id = ? AND line_id = ?", u, s(payload["orderId"]), s(payload["lineId"])) : null;
      return r ? { garmentId: line?.garment_id ?? null, words: [r.merchant, r.order_number ?? ""] } : null;
    }
    case "reminder.cancel": {
      const r = await first<{ title: string }>(rt.db, "SELECT title FROM reminders WHERE user_id = ? AND reminder_id = ?", u, s(payload["reminderId"]));
      return r ? { words: [r.title] } : null;
    }
    case "memory.set_status": {
      const r = await first<{ text: string }>(rt.db, "SELECT text FROM memory_conclusions WHERE user_id = ? AND conclusion_id = ? ORDER BY version DESC LIMIT 1", u, s(payload["conclusionId"]));
      return r ? { words: [r.text] } : null;
    }
    case "lifecycle.record_event": {
      const r = await first<{ title: string }>(rt.db, "SELECT title FROM lifecycle_projects WHERE user_id = ? AND project_id = ?", u, s(payload["projectId"]));
      if (!r) return null;
      const items = await all<{ garment_id: string }>(rt.db, "SELECT garment_id FROM lifecycle_project_items WHERE user_id = ? AND project_id = ?", u, s(payload["projectId"]));
      return { words: [r.title], garmentIds: items.map((i) => i.garment_id) };
    }
    case "command.undo": {
      const target = s(payload["commandId"]);
      const r = await first<{ receipt_json: string }>(rt.db, "SELECT receipt_json FROM commands WHERE user_id = ? AND command_id = ?", u, target);
      if (!r) return null;
      let latestCommandId: string | null = null;
      const pageSize = 100;
      for (let offset = 0; ; offset += pageSize) {
        const recent = await all<{ command_id: string; type: string; payload_json: string }>(
          rt.db,
          "SELECT command_id, type, payload_json FROM commands WHERE user_id = ? AND type <> 'command.undo' AND type NOT LIKE 'inference.%' AND authorization_basis IN ('owner_tap', 'owner_statement') AND outcome IN ('committed', 'merged') ORDER BY recorded_at DESC, rowid DESC LIMIT ? OFFSET ?",
          u,
          pageSize,
          offset,
        );
        const hit = recent.find((c) => {
          let p: Record<string, unknown> = {};
          try {
            p = JSON.parse(c.payload_json) as Record<string, unknown>;
          } catch {
            p = {};
          }
          return classifyChange(c.type, p, rt.principal.channel) !== "bookkeeping";
        });
        if (hit) {
          latestCommandId = hit.command_id;
          break;
        }
        if (recent.length < pageSize) break;
      }
      let summary = "";
      try {
        summary = String((JSON.parse(r.receipt_json) as { summary?: unknown }).summary ?? "");
      } catch {
        summary = "";
      }
      return { words: [summary], mostRecent: latestCommandId === target };
    }
    default:
      return null;
  }
}

/** What a tool returns to the model for a committed command: the system's summary, not room for embellishment. */
export function forModel(result: CommitResult): Record<string, unknown> {
  if (result.status === "committed") return { status: "committed", receipt: { commandId: result.commandId, outcome: result.outcome, summary: result.summary, undoAvailable: result.undoAvailable }, result: result.result };
  return result;
}

const hasWords = (text: string) => ownerAuthoredText(text).trim().length > 0;

/**
 * Whether words of the owner's own stand behind this turn: written in this turn's message or, when this
 * turn answers the assistant's question, in the message that question was about (attachments,
 * photographs, relayed passages and tapped choice labels are not their words). An earlier message is
 * never counted otherwise: `ownerTexts` holds nothing else.
 */
export function ownerSpoke(rt: Pick<TurnRuntime, "ownerTexts">): boolean {
  return rt.ownerTexts.some(hasWords);
}

/**
 * The source trusted code records for a change asked for in this turn. It says "owner statement" only
 * when the owner wrote words of their own; a message that was only a photograph or an attachment is
 * recorded as what it was, so the summary the owner confirms never credits them with a statement they
 * did not make.
 */
export function ownerSource(rt: TurnRuntime): { kind: "owner_statement" | "photograph" | "model_inference"; ref: string } {
  const ref = `message:${rt.userMessageId}`;
  if (hasWords(rt.currentOwnerText)) return { kind: "owner_statement", ref };
  // A tapped answer has no words of its own: the statement is the message the question was about, and
  // the reference names THAT message, never the wordless one.
  if (rt.askedMessageId && ownerSpoke(rt)) return { kind: "owner_statement", ref: `message:${rt.askedMessageId}` };
  return { kind: rt.hasImages ? "photograph" : "model_inference", ref };
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
  // No allow-list means nothing was given or found in this turn: nothing is retrieved (fail closed).
  if (!rt.allowedUrls || !rt.allowedUrls.has(key)) return "that address was not given by the owner and did not come from a search in this turn; only those are retrieved. Search first, or ask the owner for the link";
  return null;
}

/** Words about the owner's body and health: they leave in a search query only when the request itself used them. */
const PRIVATE_TERMS = /\b(nerve|neuropath\w*|injur\w*|damage\w*|heal\w*|recover\w*|feet|foot|toes?|ankles?|blister\w*|sprain\w*|fractur\w*|wound\w*|sore\w*|ache\w*|aching|limp\w*|orthotic\w*|insole\w*|plantar|fasciitis|tendon\w*|bunion\w*|gout|edema|oedema|ulcer\w*|infect\w*|numb\w*|tingl\w*|surgery|operation|diagnos\w*|chemo\w*|cancer|diabet\w*|arthrit\w*|medical|medication|disab\w*|podiatr\w*|physio\w*|doctor\w*|surgeon\w*|clinic\w*|hospital\w*|patient\w*|therap\w*|chronic|symptom\w*|allerg\w*|irritat\w*|itch\w*|chaf\w*|restriction\w*|rash|eczema|psoriasis|swelling|swollen|pain|weight|kg|kilos?|stone|lbs?|pounds heavy|bmi|password|address|postcode|phone|salary|income)\b/gi;

const REASON_STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "are", "was", "were", "his", "her", "their", "our", "out", "into", "not", "all", "any", "can", "may", "new", "some",
  "shirt", "shirts", "trouser", "trousers", "pant", "pants", "jean", "jeans", "chino", "chinos", "jacket", "jackets", "coat", "coats", "blazer", "blazers", "suit", "suits",
  "sweater", "sweaters", "jumper", "jumpers", "cardigan", "cardigans", "crewneck", "polo", "polos", "rugby", "rugbies", "overshirt", "overshirts", "chore", "mac", "parka", "overcoat",
  "shoe", "shoes", "boot", "boots", "sneaker", "sneakers", "loafer", "loafers", "derby", "derbies", "oxford", "oxfords", "sock", "socks", "belt", "belts", "scarf", "scarves", "tie", "ties",
  "wool", "cotton", "linen", "cashmere", "silk", "denim", "flannel", "corduroy", "tweed", "shetland", "lambswool", "merino", "alpaca", "suede", "leather", "canvas", "chambray", "poplin", "twill",
  "navy", "blue", "black", "grey", "gray", "brown", "tan", "olive", "green", "white", "cream", "ecru", "beige", "khaki", "burgundy", "charcoal", "indigo", "moss", "oatmeal",
]);

/**
 * Why a web search query may not be sent, or null when it may. A query is model-written text that leaves
 * to a third party, so it must not be a vehicle for the owner's private facts: every number in it (a
 * measurement, a size, a date of birth), every word about the owner's body or health, and any stored
 * restriction reason or comfort note must already be in what was asked in this turn, or be part of a
 * wardrobe or product record's own name (a model number).
 * This bounds what a search can carry; it does not make search results trustworthy.
 */
export async function searchQueryRefusal(rt: Pick<TurnRuntime, "db" | "principal" | "requestText">, query: string): Promise<string | null> {
  const asked = ` ${(rt.requestText ?? "").toLowerCase()} `;
  const q = query.toLowerCase();
  // Whole numbers only: "44" is not said by "144". A year is a number like any other (a birth year is private).
  const tokens = (text: string) => new Set(text.match(/\d+(?:[.,]\d+)?/g) ?? []);
  const askedNumbers = tokens(asked);
  const numbers = [...tokens(q)];
  const unknown = numbers.filter((n) => !askedNumbers.has(n));
  if (unknown.length > 0) {
    const names = tokens((await all<{ name: string }>(rt.db, "SELECT name FROM garments WHERE user_id = ? UNION ALL SELECT name FROM products WHERE user_id = ?", rt.principal.userId, rt.principal.userId)).map((r) => r.name.toLowerCase()).join(" "));
    const leaking = unknown.filter((n) => !names.has(n));
    if (leaking.length > 0) return `the query carries a number (${leaking.join(", ")}) that was not in what was asked and is not part of a product name; measurements, sizes and other private values are not sent to a search provider`;
  }
  // Whole terms only, by the same word-bounded pattern: "painting" does not say "pain", nor "lightweight" "weight".
  const askedTerms = new Set((asked.match(PRIVATE_TERMS) ?? []).map((t) => t.toLowerCase()));
  const terms = [...new Set((q.match(PRIVATE_TERMS) ?? []).map((t) => t.toLowerCase()).filter((t) => !askedTerms.has(t)))];
  if (terms.length > 0) return `the query mentions ${terms.join(", ")}, which was not in what was asked; the owner's health and personal details are not sent to a search provider`;
  // Stored restriction reasons and comfort notes may not be copied into an outbound query even when listed medical words are omitted.
  const wordsOf = (text: string | null | undefined) => ((text ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !REASON_STOP.has(w));
  const askedWords = new Set(wordsOf(asked));
  const queryWords = new Set(wordsOf(q));
  const notes = await all<{ reason: string | null }>(
    rt.db,
    "SELECT reason FROM restrictions WHERE user_id = ? AND reason IS NOT NULL UNION ALL SELECT text AS reason FROM comfort_feedback WHERE user_id = ? AND text IS NOT NULL",
    rt.principal.userId,
    rt.principal.userId,
  );
  for (const row of notes) {
    const leaked = [...new Set(wordsOf(row.reason))].filter((w) => queryWords.has(w) && !askedWords.has(w));
    if (leaked.length >= 2) {
      return `the query carries words from a stored restriction or comfort note (${leaked.slice(0, 4).join(", ")}) that were not in what was asked; restriction reasons and health details are not sent to a search provider`;
    }
  }
  return null;
}
