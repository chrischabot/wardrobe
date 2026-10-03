/**
 * Proposals that do not come from an assistant turn's own record: a sensitive typed command sent by a
 * connected assistant, and a command Garderobe's assistant tried on relayed text that is not allowed
 * there. This module only stores and reads them (table `submitted_proposals`); deciding them is in
 * `service.ts`. It has no dependency on the composed application, so the command registry guards can
 * use it.
 */
import { all, canonicalJson, first, json as parseJson, prepare, stmt, toInstant, type Db } from "@garderobe/domain";
import { sha256Hex } from "../crypto.ts";

export type SubmittedOrigin = "typed_command" | "relayed_turn";

export interface SubmittedProposalInput {
  userId: string;
  origin: SubmittedOrigin;
  /** The grant (typed_command) or the turn (relayed_turn). */
  sourceRef: string;
  grantId: string | null;
  turnId: string | null;
  idempotencyKey: string;
  type: string;
  payload: Record<string, unknown>;
  expectedVersions: Record<string, number>;
  occurredAt: string | null;
  nowMs: number;
}

export interface SubmittedProposalRow {
  proposal_id: string;
  origin: SubmittedOrigin;
  source_ref: string;
  grant_id: string | null;
  turn_id: string | null;
  idempotency_key: string;
  request_hash: string;
  command_type: string;
  payload_json: string;
  expected_versions_json: string;
  occurred_at: string | null;
  created_at: string;
}

const COLUMNS = "proposal_id, origin, source_ref, grant_id, turn_id, idempotency_key, request_hash, command_type, payload_json, expected_versions_json, occurred_at, created_at";

/** Everything that defines the change. A request that differs in any of it is a different proposal. */
export const requestHashOf = (input: Pick<SubmittedProposalInput, "type" | "payload" | "expectedVersions" | "occurredAt">): Promise<string> =>
  sha256Hex(canonicalJson({ type: input.type, payload: input.payload, expectedVersions: input.expectedVersions, occurredAt: input.occurredAt }));

/** A proposal nobody decided is offered for this long; after that it can no longer be confirmed and no longer counts as waiting. */
export const PROPOSAL_LIFETIME_MS = 14 * 86_400_000;

/**
 * How many requests connected assistants may have waiting for the owner at once. A request counts from
 * the moment it is kept until the owner decides it or it expires, wherever it is kept: a typed command, a
 * command refused on a relayed turn (both in `submitted_proposals`), and what the assistant recorded on a
 * turn a connection started (`assistant_turns.proposals_json`). The limits protect the owner's list, and
 * only the owner can take something off it, so opening a second connection or asking through
 * `garderobe_ask` instead of a typed command gives no further room.
 */
export const WAITING_LIMITS = { perConnection: 40, perOwner: 80, perRelayedTurn: 12 } as const;

export interface WaitingRequests {
  /** Everything connected assistants have waiting for this owner. */
  total: number;
  byGrant: Map<string, number>;
  byTurn: Map<string, number>;
}

/** What connected assistants have waiting for the owner's decision right now, per connection (grant) and in all. */
export async function waitingRequests(db: Db, userId: string, nowMs: number): Promise<WaitingRequests> {
  const sinceSeconds = Math.floor((nowMs - PROPOSAL_LIFETIME_MS) / 1000);
  const out: WaitingRequests = { total: 0, byGrant: new Map(), byTurn: new Map() };
  const add = (grant: string | null, n: number) => {
    if (n <= 0) return;
    out.total += n;
    if (grant) out.byGrant.set(grant, (out.byGrant.get(grant) ?? 0) + n);
  };
  const submitted = await all<{ grant: string | null; turn_id: string | null; n: number }>(
    db,
    `SELECT COALESCE(p.grant_id, CASE WHEN t.auth_ref LIKE 'mcp:%' THEN substr(t.auth_ref, 5) END) AS grant, p.turn_id AS turn_id, COUNT(*) AS n
       FROM submitted_proposals p LEFT JOIN assistant_turns t ON t.user_id = p.user_id AND t.turn_id = p.turn_id
      WHERE p.user_id = ? AND unixepoch(p.created_at) > ?
        AND NOT EXISTS (SELECT 1 FROM proposal_decisions d WHERE d.user_id = p.user_id AND d.proposal_id = p.proposal_id)
      GROUP BY 1, 2`,
    userId, sinceSeconds,
  );
  for (const row of submitted) {
    add(row.grant, row.n);
    if (row.turn_id) out.byTurn.set(row.turn_id, (out.byTurn.get(row.turn_id) ?? 0) + row.n);
  }
  // What the assistant itself recorded on turns a connection started. A decision on one of them is stored
  // under the turn; decisions on that turn's `submitted_proposals` rows were counted above and are left out.
  const turns = await all<{ grant: string; proposed: number; decided: number }>(
    db,
    `SELECT substr(t.auth_ref, 5) AS grant, json_array_length(t.proposals_json) AS proposed,
            (SELECT COUNT(*) FROM proposal_decisions d WHERE d.user_id = t.user_id AND d.turn_id = t.turn_id
                AND NOT EXISTS (SELECT 1 FROM submitted_proposals s WHERE s.user_id = d.user_id AND s.proposal_id = d.proposal_id)) AS decided
       FROM assistant_turns t
      WHERE t.user_id = ? AND t.auth_ref LIKE 'mcp:%' AND t.proposals_json != '[]' AND unixepoch(t.created_at) > ?`,
    userId, sinceSeconds,
  );
  for (const row of turns) add(row.grant, row.proposed - row.decided);
  return out;
}

/** Whether a connection may leave one more request for the owner: neither it nor all connections together are at their limit. */
export function hasRoomToWait(waiting: WaitingRequests, grantId: string | null): boolean {
  if (waiting.total >= WAITING_LIMITS.perOwner) return false;
  return !grantId || (waiting.byGrant.get(grantId) ?? 0) < WAITING_LIMITS.perConnection;
}

/**
 * Keep one request as a proposal. Repeating the same request (same origin, source and idempotency key)
 * returns the proposal already kept; the same key with a different request returns `conflict`, and
 * nothing is stored for it. When the connection, all connections together or the relayed turn already
 * have their share of requests waiting, the answer is `limited`: the owner's list is not something a
 * connected assistant can fill up. A request whose summary could not be shown to the owner in full is
 * `unshowable` and is not kept: the owner never confirms text they were not shown.
 */
export async function recordSubmittedProposal(db: Db, input: SubmittedProposalInput): Promise<{ row: SubmittedProposalRow; created: boolean } | { conflict: true } | { limited: true } | { unshowable: true }> {
  const requestHash = await requestHashOf(input);
  const proposalId = `prp_${(await sha256Hex(`submitted\u0000${input.origin}\u0000${input.sourceRef}\u0000${input.idempotencyKey}\u0000${requestHash}`)).slice(0, 32)}`;
  const find = () => first<SubmittedProposalRow>(db, `SELECT ${COLUMNS} FROM submitted_proposals WHERE user_id = ? AND origin = ? AND source_ref = ? AND idempotency_key = ?`, input.userId, input.origin, input.sourceRef, input.idempotencyKey);
  const existing = await find();
  if (existing) return existing.request_hash === requestHash ? { row: existing, created: false } : { conflict: true };
  if (!summaryFitsInFull(input.type, input.payload)) return { unshowable: true };
  // The connection a relayed turn belongs to is read from the turn; a typed command names its grant.
  const grantId = input.grantId ?? (input.turnId ? grantOfAuthRef((await first<{ auth_ref: string }>(db, "SELECT auth_ref FROM assistant_turns WHERE user_id = ? AND turn_id = ?", input.userId, input.turnId))?.auth_ref) : null);
  const waiting = await waitingRequests(db, input.userId, input.nowMs);
  if (!hasRoomToWait(waiting, grantId)) return { limited: true };
  if (input.origin === "relayed_turn" && (waiting.byTurn.get(input.sourceRef) ?? 0) >= WAITING_LIMITS.perRelayedTurn) return { limited: true };
  await prepare(
    db,
    stmt(
      "INSERT INTO submitted_proposals (user_id, proposal_id, origin, source_ref, grant_id, turn_id, idempotency_key, request_hash, command_type, payload_json, expected_versions_json, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      input.userId, proposalId, input.origin, input.sourceRef, input.grantId, input.turnId, input.idempotencyKey, requestHash, input.type, JSON.stringify(input.payload), JSON.stringify(input.expectedVersions), input.occurredAt, toInstant(input.nowMs),
    ),
  ).run();
  const row = await find();
  if (!row) throw new Error("the proposal could not be stored");
  return row.request_hash === requestHash ? { row, created: true } : { conflict: true };
}

/** The grant a turn was started under, when a connected assistant started it. */
export const grantOfAuthRef = (authRef: string | null | undefined): string | null => (authRef?.startsWith("mcp:") ? authRef.slice(4) : null);

/** The newest kept requests, decided or not: the history part of the owner's list. */
export const listSubmittedProposals = (db: Db, userId: string, limit: number): Promise<SubmittedProposalRow[]> =>
  all<SubmittedProposalRow>(db, `SELECT ${COLUMNS} FROM submitted_proposals WHERE user_id = ? ORDER BY unixepoch(created_at) DESC, proposal_id LIMIT ?`, userId, limit);

/** Every kept request the owner has not decided and that has not expired. Not truncated: nothing waiting is left off the owner's list. */
export const listWaitingSubmittedProposals = (db: Db, userId: string, nowMs: number): Promise<SubmittedProposalRow[]> =>
  all<SubmittedProposalRow>(
    db,
    `SELECT ${COLUMNS} FROM submitted_proposals p WHERE p.user_id = ? AND unixepoch(p.created_at) > ?
        AND NOT EXISTS (SELECT 1 FROM proposal_decisions d WHERE d.user_id = p.user_id AND d.proposal_id = p.proposal_id)`,
    userId, Math.floor((nowMs - PROPOSAL_LIFETIME_MS) / 1000),
  );

export const findSubmittedProposal = (db: Db, userId: string, proposalId: string): Promise<SubmittedProposalRow | null> =>
  first<SubmittedProposalRow>(db, `SELECT ${COLUMNS} FROM submitted_proposals WHERE user_id = ? AND proposal_id = ?`, userId, proposalId);

export const submittedPayload = (row: SubmittedProposalRow): Record<string, unknown> => parseJson<Record<string, unknown>>(row.payload_json, {});
export const submittedExpectedVersions = (row: SubmittedProposalRow): Record<string, number> => parseJson<Record<string, number>>(row.expected_versions_json, {});

const LABELS: Record<string, string> = {
  "garment.create": "Add a garment to the wardrobe",
  "garment.receive": "Mark an incoming garment as arrived and owned",
  "garment.retire": "Retire a garment from the wardrobe",
  "garment.merge": "Merge two garment records into one",
  "garment.remove_fabricated": "Remove a garment record as a mistake",
  "garment.bulk_correct": "Correct several garments at once",
  "garment.correct": "Correct a garment's details",
  "garment.add_alias": "Add another name for a garment",
  "garment.move": "Record where a garment is",
  "stock.reconcile": "Set the counted quantities of a garment",
  "style.add_amendment": "Add an amendment to My style",
  "style.set_amendment_status": "Change the status of an amendment to My style",
  "style.save_document": "Save a new version of My style",
  "style.import_document": "Replace My style with an imported document",
  "style.upsert_rule": "Add or change a style rule",
  "style.add_direction": "Add a standing direction",
  "style.retire_direction": "Retire a standing direction",
  "style.resolve_fact_conflict": "Decide a conflict between My style and a stored fact",
  "style.set_brief": "Set the brief for a day",
  "style.retire_brief": "Withdraw the brief for a day",
  "garment.remove_alias": "Remove a name for a garment",
  "garment.set_planning_policy": "Change whether a garment is offered in outfits",
  "stock.pack": "Record garments as packed for a trip",
  "stock.unpack": "Record garments as unpacked after a trip",
  "size_experience.record": "Record how a size fits",
  "laundry.collect": "Record a laundry pickup",
  "laundry.return": "Record that laundry came back",
  "laundry.report_exception": "Record that laundry did not come back as expected",
  "board.select": "Choose an outfit on a day's board",
  "board.swap_slot": "Swap one piece of an outfit on a day's board",
  "board.suppress": "Stop showing a day's board",
  "board.restore": "Bring back a day's board",
  "exposure.select": "Record which offered option was chosen",
  "feedback.record": "Record feedback on an outfit or a garment",
  "feedback.retract": "Withdraw recorded feedback",
  "service.pause": "Pause the daily service",
  "service.resume": "Resume the daily service",
  "settings.update": "Change settings",
  "trip.create": "Add a trip",
  "trip.update": "Change a trip",
  "trip.cancel": "Cancel a trip",
  "studio.save_combination": "Save a combination in Studio",
  "studio.remove_combination": "Remove a saved combination",
  "studio.plan_for_day": "Plan a combination for a day",
  "studio.remove_day_plan": "Remove a day's plan",
  "reminder.set": "Set a reminder",
  "reminder.cancel": "Cancel a reminder",
  "memory.record_conclusion": "Remember something about you",
  "memory.set_status": "Change what is remembered about you",
  "purchase.import_order": "Record an order",
  "purchase.link_line": "Link an order line to a garment",
  "purchase.record_event": "Record an event on an order",
  "purchase.mark_delivered": "Mark an order as delivered",
  "return.open_case": "Open a return or exchange",
  "return.update_case": "Change a return or exchange",
  "return.link_exchange": "Link an exchange to its replacement",
  "lifecycle.open_project": "Open a repair or alteration project",
  "lifecycle.update_project": "Change a repair or alteration project",
  "lifecycle.record_event": "Record an event on a repair or alteration project",
  "connection.register": "Add a connection to another service",
  "connection.set_status": "Enable or disable a connection to another service",
  "connection.set_tool_groups": "Change what a connected service may be used for",
  "inference.set_routing": "Change which model answers",
  "media.authorize_upload": "Prepare an image upload",
  "media.finalize_upload": "Finish an image upload",
  "media.decide_review": "Decide an image waiting for review",
  "media.set_primary_asset": "Choose a garment's main image",
  "media.request_discovery": "Search for product images",
  "media.request_composite_preview": "Render an outfit preview",
  "job.create": "Start a background job",
  "measurement.record": "Record a measurement",
  "restriction.add": "Record a restriction",
  "restriction.resolve": "Lift a restriction",
  "conversation.forget_source": "Forget something you said or sent",
  "media.delete_asset": "Delete an image",
  "lifecycle.authorize_action": "Authorize an action with another party",
  "command.undo": "Undo an earlier change",
  "wear.record": "Record a wear",
  "wear.amend": "Change a recorded wear",
};

/**
 * A value exactly as it would be stored, written as JSON: text in straight quotation marks with line
 * breaks and control characters as escapes, numbers, lists and nested records in full. Nothing is cut,
 * collapsed or trimmed. Characters that could make the line read differently from what is stored are
 * written as visible escapes too: invisible and direction-changing characters, and characters that look
 * like the closing quotation mark.
 */
const MISLEADING = /[\u007f-\u009f\u02ba\u02dd\u02ee\u201c-\u201f\u2028\u2029\u2033\u2036\u3003\u301d-\u301f\uff02]|\p{Cf}/gu;
const shown = (value: unknown): string => JSON.stringify(value).replace(MISLEADING, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

/** The longest summary the owner is asked to read. A request that needs more is refused, never shortened. */
export const MAX_SUMMARY_CHARS = 6000;

/** Whether the whole request can be put before the owner: every field, every value in full, within the bound. */
export const summaryFitsInFull = (type: string, payload: Record<string, unknown>): boolean => describeProposedChange(type, payload).length <= MAX_SUMMARY_CHARS;

/** Every garment identifier that appears anywhere in a payload. */
export function garmentIdsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    if (/^gmt_[A-Za-z0-9_-]+$/.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) garmentIdsIn(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) garmentIdsIn(v, into);
  }
  return into;
}

/** What the ledger says about the things a payload refers to by identifier, for the owner's summary. */
export interface ProposalReferences {
  /** Name by garment identifier, for the owner's own garments. */
  garments: Map<string, string>;
  /** Type and date of the command a `command.undo` would undo. */
  commands: Map<string, { type: string; recordedAt: string }>;
}

/**
 * The summary the owner is shown: written here from the command type and the exact payload that would
 * run, never taken from a model or from the requesting assistant. Text values are shown in quotation
 * marks so they read as content of the request, not as a statement by Garderobe. Every field of the
 * request is listed and every value is shown in full (see `shown`): the owner confirms exactly this
 * payload, so nothing of it may be left out or shortened. A request too long to show this way is not kept
 * at all (`summaryFitsInFull`). Because the summary is derived from the stored payload each time it is
 * read, it cannot differ from what would run. Identifiers are followed by what the ledger holds under
 * them, so the owner reads a name and not only an identifier; an identifier that names nothing of the
 * owner's is said to name nothing.
 */
export function describeProposedChange(type: string, payload: Record<string, unknown>, refs?: ProposalReferences): string {
  const fields = Object.entries(payload)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${shown(key).slice(1, -1)}: ${shown(value)}`);
  const notes: string[] = [];
  if (refs) {
    const ids = [...garmentIdsIn(payload)];
    const named = ids.map((id) => (refs.garments.has(id) ? `${shown(refs.garments.get(id)!)} (${id})` : `${id} is not a garment in this wardrobe`));
    if (named.length) notes.push(`Garments: ${named.join(", ")}.`);
    if (type === "command.undo" && typeof payload.commandId === "string") {
      const target = refs.commands.get(payload.commandId);
      notes.push(target ? `The change to undo: ${target.type}, recorded ${target.recordedAt}.` : "The change to undo was not found.");
    }
  }
  return `${LABELS[type] ?? `Run the command ${type}`}${fields.length ? ` (${fields.join("; ")})` : ""}${notes.length ? `. ${notes.join(" ")}` : ""}`;
}
