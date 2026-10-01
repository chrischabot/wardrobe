/** The D1 turn ledger: stable turn identity bound to the owner and the canonical request body, with replayable events. */
import type { TurnEvent, TurnRecord, TurnStatus } from "@garderobe/contracts/ext/assistant";
import type { CommandReceipt } from "@garderobe/contracts";
import { all, first, json, prepare, stmt, toInstant, type Db } from "@garderobe/domain";

export interface TurnRow {
  user_id: string;
  turn_id: string;
  submission_id: string;
  request_hash: string;
  kind: string;
  channel: string;
  scopes_json: string;
  auth_ref: string;
  status: TurnStatus;
  user_message_id: string;
  reply_message_id: string | null;
  reply_text: string | null;
  receipts_json: string;
  refusals_json: string;
  proposals_json: string;
  clarification_json: string | null;
  result_json: string | null;
  failure_json: string | null;
  model_profile: string | null;
  next_event_seq: number;
  created_at: string;
  completed_at: string | null;
}

export class SubmissionReuseError extends Error {
  readonly code = "submission_reuse";
  constructor() {
    super("this submission ID was already used for a different message");
  }
}

export function toTurnRecord(row: TurnRow, accepted: boolean): TurnRecord {
  return {
    turnId: row.turn_id,
    submissionId: row.submission_id,
    channel: row.channel,
    status: row.status,
    accepted,
    reply: row.reply_message_id ? { messageId: row.reply_message_id, text: row.reply_text ?? "" } : null,
    receipts: json(row.receipts_json, []),
    refusals: json(row.refusals_json, []),
    proposals: json<{ type: string; summary: string; payload: Record<string, unknown> }[]>(row.proposals_json, []).map((p) => ({ type: p.type, summary: p.summary, payload: p.payload })),
    clarification: json(row.clarification_json, null),
    result: json(row.result_json, null),
    failure: json(row.failure_json, null),
    modelProfile: row.model_profile,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function findTurn(db: Db, userId: string, turnId: string): Promise<TurnRow | null> {
  return first<TurnRow>(db, "SELECT * FROM assistant_turns WHERE user_id = ? AND turn_id = ?", userId, turnId);
}

export async function findTurnBySubmission(db: Db, userId: string, submissionId: string): Promise<TurnRow | null> {
  return first<TurnRow>(db, "SELECT * FROM assistant_turns WHERE user_id = ? AND submission_id = ?", userId, submissionId);
}

/**
 * Bind a client submission ID to the owner and the canonical request body. A retransmission of the same
 * body returns the same turn; the same ID with a different body is an error.
 */
export async function acceptTurnRow(
  db: Db,
  input: { userId: string; turnId: string; submissionId: string; requestHash: string; kind: string; channel: string; scopes: string[]; authRef: string; userMessageId: string; nowMs: number },
): Promise<{ row: TurnRow; accepted: boolean }> {
  const now = toInstant(input.nowMs);
  await prepare(
    db,
    stmt(
      `INSERT INTO assistant_turns (user_id, turn_id, submission_id, request_hash, kind, channel, scopes_json, auth_ref, status, user_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?) ON CONFLICT (user_id, submission_id) DO NOTHING`,
      input.userId, input.turnId, input.submissionId, input.requestHash, input.kind, input.channel, JSON.stringify(input.scopes), input.authRef, input.userMessageId, now, now,
    ),
  ).run();
  const row = (await findTurnBySubmission(db, input.userId, input.submissionId))!;
  if (row.request_hash !== input.requestHash) throw new SubmissionReuseError();
  return { row, accepted: row.turn_id === input.turnId };
}

export async function updateTurn(db: Db, userId: string, turnId: string, patch: Partial<Record<"status" | "reply_message_id" | "reply_text" | "clarification_json" | "result_json" | "failure_json" | "model_profile" | "completed_at", string | null>>, nowMs: number): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  await prepare(db, stmt(`UPDATE assistant_turns SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE user_id = ? AND turn_id = ?`, ...keys.map((k) => (patch as Record<string, string | null>)[k]), toInstant(nowMs), userId, turnId)).run();
}

/**
 * Append to a JSON list column in ONE statement. Tools of a turn can run concurrently, so a read-modify-write
 * here would lose receipts; `json_insert` on the stored value is atomic. Returns false when `dedupe` matched.
 */
async function appendJson(db: Db, userId: string, turnId: string, column: "receipts_json" | "refusals_json" | "proposals_json", item: unknown, dedupe?: { path: string; value: string }): Promise<boolean> {
  const text = JSON.stringify(item);
  const res = dedupe
    ? await prepare(db, stmt(`UPDATE assistant_turns SET ${column} = json_insert(${column}, '$[#]', json(?)) WHERE user_id = ? AND turn_id = ? AND NOT EXISTS (SELECT 1 FROM json_each(assistant_turns.${column}) WHERE json_extract(value, ?) = ?)`, text, userId, turnId, dedupe.path, dedupe.value)).run()
    : await prepare(db, stmt(`UPDATE assistant_turns SET ${column} = json_insert(${column}, '$[#]', json(?)) WHERE user_id = ? AND turn_id = ?`, text, userId, turnId)).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function emitTurnEvent(db: Db, userId: string, turnId: string, type: TurnEvent["type"], data: Record<string, unknown>, nowMs: number): Promise<void> {
  // One atomic batch: the sequence number is taken and advanced together, so concurrent emitters never collide.
  await db.batch([
    prepare(db, stmt("INSERT INTO assistant_turn_events (user_id, turn_id, seq, type, at, data_json) SELECT user_id, turn_id, next_event_seq, ?, ?, ? FROM assistant_turns WHERE user_id = ? AND turn_id = ?", type, toInstant(nowMs), JSON.stringify(data), userId, turnId)),
    prepare(db, stmt("UPDATE assistant_turns SET next_event_seq = next_event_seq + 1 WHERE user_id = ? AND turn_id = ?", userId, turnId)),
  ]);
}

/** The receipt reference shown with a turn is built from the stored receipt, never from model prose. */
export async function recordReceipt(db: Db, userId: string, turnId: string, receipt: CommandReceipt, nowMs: number): Promise<void> {
  const ref = { commandId: receipt.commandId, type: receipt.type, outcome: receipt.outcome, summary: receipt.summary, undoAvailable: receipt.undo.available };
  const added = await appendJson(db, userId, turnId, "receipts_json", ref, { path: "$.commandId", value: receipt.commandId });
  if (added) await emitTurnEvent(db, userId, turnId, "command_receipt", ref, nowMs);
}

export async function recordRefusal(db: Db, userId: string, turnId: string, refusal: { tool: string; code: string; message: string }): Promise<void> {
  await appendJson(db, userId, turnId, "refusals_json", refusal);
}

export async function recordProposal(db: Db, userId: string, turnId: string, proposal: { type: string; summary: string; payload: Record<string, unknown> }): Promise<void> {
  const key = JSON.stringify([proposal.type, proposal.payload]);
  await appendJson(db, userId, turnId, "proposals_json", { ...proposal, key }, { path: "$.key", value: key });
}

export const TURN_EVENT_RETENTION = 500;

export async function readTurnEvents(db: Db, userId: string, turnId: string, afterSeq = 0): Promise<{ events: TurnEvent[]; expired: boolean }> {
  const rows = await all<{ seq: number; type: TurnEvent["type"]; at: string; data_json: string }>(db, "SELECT seq, type, at, data_json FROM assistant_turn_events WHERE user_id = ? AND turn_id = ? AND seq > ? ORDER BY seq LIMIT ?", userId, turnId, afterSeq, TURN_EVENT_RETENTION);
  const oldest = await first<{ seq: number | null }>(db, "SELECT MIN(seq) AS seq FROM assistant_turn_events WHERE user_id = ? AND turn_id = ?", userId, turnId);
  return { events: rows.map((r) => ({ seq: r.seq, type: r.type, at: r.at, data: json(r.data_json, {}) })), expired: oldest?.seq !== null && oldest?.seq !== undefined && afterSeq > 0 && afterSeq + 1 < oldest.seq };
}
