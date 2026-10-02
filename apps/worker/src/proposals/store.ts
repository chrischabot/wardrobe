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

/** How many requests one connection (or one relayed turn) may leave waiting for the owner within a day. */
export const SUBMITTED_PER_DAY = { typed_command: 40, relayed_turn: 12 } as const;

/**
 * Keep one request as a proposal. Repeating the same request (same origin, source and idempotency key)
 * returns the proposal already kept; the same key with a different request returns `conflict`, and
 * nothing is stored for it. A source that has already left its day's share of requests gets `limited`:
 * the owner's list is not something a connected assistant can fill up.
 */
export async function recordSubmittedProposal(db: Db, input: SubmittedProposalInput): Promise<{ row: SubmittedProposalRow; created: boolean } | { conflict: true } | { limited: true }> {
  const requestHash = await requestHashOf(input);
  const proposalId = `prp_${(await sha256Hex(`submitted\u0000${input.origin}\u0000${input.sourceRef}\u0000${input.idempotencyKey}\u0000${requestHash}`)).slice(0, 32)}`;
  const find = () => first<SubmittedProposalRow>(db, `SELECT ${COLUMNS} FROM submitted_proposals WHERE user_id = ? AND origin = ? AND source_ref = ? AND idempotency_key = ?`, input.userId, input.origin, input.sourceRef, input.idempotencyKey);
  const existing = await find();
  if (existing) return existing.request_hash === requestHash ? { row: existing, created: false } : { conflict: true };
  const recent = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM submitted_proposals WHERE user_id = ? AND origin = ? AND source_ref = ? AND created_at > ?", input.userId, input.origin, input.sourceRef, toInstant(input.nowMs - 86_400_000));
  if ((recent?.n ?? 0) >= SUBMITTED_PER_DAY[input.origin]) return { limited: true };
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

export const listSubmittedProposals = (db: Db, userId: string, limit: number): Promise<SubmittedProposalRow[]> =>
  all<SubmittedProposalRow>(db, `SELECT ${COLUMNS} FROM submitted_proposals WHERE user_id = ? ORDER BY created_at DESC, proposal_id LIMIT ?`, userId, limit);

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

const clip = (text: string): string => (text.length > 120 ? `${text.slice(0, 120)}…` : text);
const shown = (value: unknown): string => (typeof value === "string" ? JSON.stringify(clip(value.replace(/\s+/g, " ").trim())) : clip(JSON.stringify(value)));

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
 * marks so they read as content of the request, not as a statement by Garderobe. Identifiers are
 * followed by what the ledger holds under them, so the owner reads a name and not only an identifier;
 * an identifier that names nothing of the owner's is said to name nothing.
 */
export function describeProposedChange(type: string, payload: Record<string, unknown>, refs?: ProposalReferences): string {
  const fields = Object.entries(payload)
    .filter(([key, value]) => key !== "source" && value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))
    .slice(0, 8)
    .map(([key, value]) => `${key}: ${shown(value)}`);
  const more = Object.keys(payload).length > 9 ? "; further fields are in the full request" : "";
  const notes: string[] = [];
  if (refs) {
    const ids = [...garmentIdsIn(payload)];
    const named = ids.slice(0, 6).map((id) => (refs.garments.has(id) ? `${JSON.stringify(clip(refs.garments.get(id)!))} (${id})` : `${id} is not a garment in this wardrobe`));
    if (named.length) notes.push(`Garments: ${named.join(", ")}${ids.length > 6 ? ` and ${ids.length - 6} more` : ""}.`);
    if (type === "command.undo" && typeof payload.commandId === "string") {
      const target = refs.commands.get(payload.commandId);
      notes.push(target ? `The change to undo: ${target.type}, recorded ${target.recordedAt}.` : "The change to undo was not found.");
    }
  }
  return `${LABELS[type] ?? `Run the command ${type}`}${fields.length ? ` (${fields.join("; ")}${more})` : ""}${notes.length ? `. ${notes.join(" ")}` : ""}`;
}
