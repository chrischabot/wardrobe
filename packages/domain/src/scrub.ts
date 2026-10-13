/**
 * Scrubbing the command ledger's own copies of a forgotten source.
 *
 * When the owner forgets a conversation message, the commands that message's turn issued keep their
 * identity (type, IDs, versions, outcome, times, what they affected) but must no longer hold the text.
 * The ledger keeps such text in several places: the request payload, the receipt's prose (summary,
 * repairs, result), the undo data, the command's source record, effect and outbox payloads, the action
 * intent that deduplicated the proposal, and incidental notes on rows the command wrote.
 *
 * `planLedgerScrub` returns the statements that remove all of that for a list of command IDs, to be
 * committed INSIDE the forgetting command's own batch, together with an exact account of what was
 * scrubbed, what could not be yet (queued work that still needs its payload to run) and which durable
 * owner records those commands wrote are kept because their text is the record itself (a profile
 * amendment, a standing direction, a restriction's reason). The caller's receipt reports exactly that:
 * the ledger is "erased" only when `pendingEffects` and `pendingOutbox` are empty, and what is in
 * `retained` is named, not silently kept.
 *
 * Nothing here deletes a row or changes a quantity, a wear, a restriction or any other fact: forgetting a
 * message never undoes what the owner did with it.
 */
import type { CommandReceipt } from "@garderobe/contracts";
import { allIn, json, stmt, type Db, type Stmt } from "./db.ts";

export const SCRUBBED_TEXT = "[forgotten at the owner's request]";
const SCRUBBED_JSON = JSON.stringify({ forgotten: true });
const UNDO_REASON = "the message that asked for this was forgotten; correct the record with a new action instead";

/** Source fields that identify where a command came from without carrying what was said. */
const SOURCE_KEEP = ["channel", "clientSubmissionId", "parentKind", "parentId", "actionId", "authRef"] as const;

/** Durable owner records whose text is the record itself: kept, and reported so the caller can say so. */
const RETAINED_TABLES: { kind: string; table: string; idColumn: string }[] = [
  { kind: "style_document", table: "style_documents", idColumn: "document_id" },
  { kind: "style_amendment", table: "style_amendments", idColumn: "amendment_id" },
  { kind: "style_rule", table: "style_rules", idColumn: "rule_id" },
  { kind: "standing_direction", table: "standing_directions", idColumn: "direction_id" },
  { kind: "temporary_brief", table: "temporary_briefs", idColumn: "brief_id" },
  { kind: "restriction", table: "restrictions", idColumn: "restriction_id" },
  { kind: "garment_fact", table: "garment_facts", idColumn: "fact_id" },
  { kind: "measurement", table: "measurements", idColumn: "measurement_id" },
  { kind: "size_experience", table: "size_experiences", idColumn: "size_experience_id" },
];

/** Tables whose rows carry a `source_json` with an optional free-text `note` written by the command. */
const SOURCE_NOTE_TABLES = ["garment_facts", "restrictions", "style_amendments", "standing_directions", "temporary_briefs", "measurements"];

export interface LedgerScrubPlan {
  /** Add these to the forgetting command's own statements: they commit or roll back with it. */
  statements: Stmt[];
  /** Commands whose ledger copies these statements scrub. */
  scrubbedCommandIds: string[];
  /** Commands that were scrubbed before (nothing more to do). */
  alreadyScrubbed: string[];
  /** IDs that are not commands of this owner; nothing is written for them. */
  unknownCommandIds: string[];
  counts: { commands: number; effects: number; outbox: number; actionIntents: number; notes: number };
  /** Queued external work of those commands that has not run yet and still holds its payload. */
  pendingEffects: { effectId: string; commandId: string; kind: string; state: string }[];
  /** Undelivered outbox entries of those commands that still hold their payload. */
  pendingOutbox: number;
  /** Durable owner records those commands wrote, kept because their text is the record itself. */
  retained: { kind: string; id: string; commandId: string }[];
  /** True when nothing of those commands' text is left in the command ledger's own copies. */
  ledgerCopiesErased: boolean;
}

/**
 * Plan the scrub of the ledger's copies for `commandIds` (the forgetting command itself is never scrubbed).
 * Owner-scoped: only this owner's commands are touched, whatever IDs are passed.
 */
export async function planLedgerScrub(ctx: { db: Db; userId: string; now: string; commandId: string }, commandIds: string[]): Promise<LedgerScrubPlan> {
  const { db, userId } = ctx;
  const wanted = [...new Set(commandIds)].filter((id) => id && id !== ctx.commandId);
  const rows = await allIn<{ command_id: string; receipt_json: string; source_json: string; scrubbed_at: string | null }>(
    db,
    "SELECT command_id, receipt_json, source_json, scrubbed_at FROM commands WHERE user_id = ? AND command_id IN (:ids)",
    [userId],
    wanted,
  );
  const known = new Map(rows.map((r) => [r.command_id, r]));
  const fresh = wanted.filter((id) => known.has(id) && known.get(id)!.scrubbed_at === null);
  const already = wanted.filter((id) => known.has(id) && known.get(id)!.scrubbed_at !== null);
  const plan: LedgerScrubPlan = {
    statements: [],
    scrubbedCommandIds: fresh,
    alreadyScrubbed: already,
    unknownCommandIds: wanted.filter((id) => !known.has(id)),
    counts: { commands: fresh.length, effects: 0, outbox: 0, actionIntents: 0, notes: 0 },
    pendingEffects: [],
    pendingOutbox: 0,
    retained: [],
    ledgerCopiesErased: true,
  };
  // Queued work is looked at for commands scrubbed earlier too: what was still pending then may have run
  // since, and a later call finishes the job.
  const targets = [...fresh, ...already];
  if (targets.length === 0) return plan;

  const effects = await allIn<{ effect_id: string; command_id: string; kind: string; state: string; payload_json: string }>(db, "SELECT effect_id, command_id, kind, state, payload_json FROM effects WHERE user_id = ? AND command_id IN (:ids)", [userId], targets);
  const outbox = await allIn<{ seq: number; state: string; payload_json: string }>(db, "SELECT seq, state, payload_json FROM outbox WHERE user_id = ? AND command_id IN (:ids)", [userId], targets);
  const intents = await allIn<{ action_id: string }>(db, "SELECT action_id FROM action_intents WHERE user_id = ? AND command_id IN (:ids)", [userId], fresh);
  const notes = await allIn<{ n: number }>(
    db,
    `SELECT (SELECT COUNT(*) FROM wear_observations w WHERE w.user_id = c.user_id AND w.command_id = c.command_id AND w.note IS NOT NULL)
          + (SELECT COUNT(*) FROM laundry_exceptions x WHERE x.user_id = c.user_id AND x.command_id = c.command_id AND x.note IS NOT NULL)
          + (SELECT COUNT(*) FROM stock_events e WHERE e.user_id = c.user_id AND e.command_id = c.command_id AND json_extract(e.payload_json, '$.note') IS NOT NULL) AS n
       FROM commands c WHERE c.user_id = ? AND c.command_id IN (:ids)`,
    [userId],
    fresh,
  );
  // Work that has not run yet needs its payload to run; it is reported, not broken.
  const running = new Set(["pending", "in_progress"]);
  plan.pendingEffects = effects.filter((e) => running.has(e.state)).map((e) => ({ effectId: e.effect_id, commandId: e.command_id, kind: e.kind, state: e.state }));
  plan.pendingOutbox = outbox.filter((o) => o.state === "pending" && o.payload_json !== "{}").length;
  plan.counts.effects = effects.filter((e) => !running.has(e.state) && e.payload_json !== SCRUBBED_JSON).length;
  plan.counts.outbox = outbox.filter((o) => o.state !== "pending" && o.payload_json !== "{}").length;
  plan.counts.actionIntents = intents.length;
  plan.counts.notes = notes.reduce((n, r) => n + Number(r.n ?? 0), 0);
  plan.ledgerCopiesErased = plan.pendingEffects.length === 0 && plan.pendingOutbox === 0;

  for (const t of RETAINED_TABLES) {
    const kept = await allIn<{ id: string; command_id: string }>(db, `SELECT DISTINCT ${t.idColumn} AS id, command_id FROM ${t.table} WHERE user_id = ? AND command_id IN (:ids)`, [userId], fresh);
    for (const k of kept) plan.retained.push({ kind: t.kind, id: k.id, commandId: k.command_id });
  }

  for (const id of already) {
    plan.statements.push(
      stmt("UPDATE effects SET payload_json = ?, last_error = NULL WHERE user_id = ? AND command_id = ? AND state NOT IN ('pending', 'in_progress')", SCRUBBED_JSON, userId, id),
      stmt("UPDATE outbox SET payload_json = '{}' WHERE user_id = ? AND command_id = ? AND state != 'pending'", userId, id),
    );
  }
  for (const id of fresh) {
    const row = known.get(id)!;
    const receipt = json<CommandReceipt>(row.receipt_json, {} as CommandReceipt);
    // The receipt keeps what happened as identifiers and versions; its prose and free-form result go.
    const skeleton: CommandReceipt = {
      ...receipt,
      summary: SCRUBBED_TEXT,
      repairs: [],
      result: { forgotten: true },
      undo: { available: false, reason: UNDO_REASON },
      replayed: false,
    };
    const source = json<Record<string, unknown>>(row.source_json, {});
    const keptSource: Record<string, unknown> = {};
    for (const key of SOURCE_KEEP) if (source[key] !== undefined) keptSource[key] = source[key];
    plan.statements.push(
      stmt(
        "UPDATE commands SET payload_json = ?, receipt_json = ?, undo_json = ?, source_json = ?, scrubbed_at = ?, scrubbed_by_command_id = ? WHERE user_id = ? AND command_id = ? AND scrubbed_at IS NULL",
        SCRUBBED_JSON, JSON.stringify(skeleton), JSON.stringify({ unavailableReason: UNDO_REASON }), JSON.stringify(keptSource), ctx.now, ctx.commandId, userId, id,
      ),
      stmt("UPDATE effects SET payload_json = ?, last_error = NULL WHERE user_id = ? AND command_id = ? AND state NOT IN ('pending', 'in_progress')", SCRUBBED_JSON, userId, id),
      stmt("UPDATE outbox SET payload_json = '{}' WHERE user_id = ? AND command_id = ? AND state != 'pending'", userId, id),
      stmt("UPDATE action_intents SET effect_json = ? WHERE user_id = ? AND command_id = ?", SCRUBBED_JSON, userId, id),
      stmt("UPDATE wear_observations SET note = NULL WHERE user_id = ? AND command_id = ? AND note IS NOT NULL", userId, id),
      stmt("UPDATE laundry_exceptions SET note = NULL WHERE user_id = ? AND command_id = ? AND note IS NOT NULL", userId, id),
      stmt("UPDATE stock_events SET payload_json = json_remove(payload_json, '$.note') WHERE user_id = ? AND command_id = ? AND json_extract(payload_json, '$.note') IS NOT NULL", userId, id),
    );
    for (const table of SOURCE_NOTE_TABLES) {
      plan.statements.push(stmt(`UPDATE ${table} SET source_json = json_remove(source_json, '$.note') WHERE user_id = ? AND command_id = ? AND json_extract(source_json, '$.note') IS NOT NULL`, userId, id));
    }
  }
  return plan;
}

/** Which of these commands have been scrubbed, and by which command (for receipts and export). */
export async function scrubbedCommands(db: Db, userId: string, commandIds: string[]): Promise<{ commandId: string; scrubbedAt: string; scrubbedByCommandId: string | null }[]> {
  const rows = await allIn<{ command_id: string; scrubbed_at: string; scrubbed_by_command_id: string | null }>(
    db,
    "SELECT command_id, scrubbed_at, scrubbed_by_command_id FROM commands WHERE user_id = ? AND scrubbed_at IS NOT NULL AND command_id IN (:ids)",
    [userId],
    [...new Set(commandIds)],
  );
  return rows.map((r) => ({ commandId: r.command_id, scrubbedAt: r.scrubbed_at, scrubbedByCommandId: r.scrubbed_by_command_id }));
}
