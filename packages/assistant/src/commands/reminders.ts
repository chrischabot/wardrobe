import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, define, first, stmt, toInstant, type PlannedEffect } from "@garderobe/domain";
import { NO_UNDO, newEffects, named } from "./common.ts";

/**
 * A reminder for a drop or a window, set from the conversation. It is its own managed event type: the
 * notification and the calendar projection are separate effects from the daily outfit board's.
 */
export const reminderSet = define({
  type: "reminder.set",
  schema: C["reminder.set"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const dueMs = Date.parse(p.dueAt);
    if (dueMs <= ctx.nowMs) throw new CommandError("precondition_failed", "that time has already passed; nothing was set");
    const reminderId = p.reminderId ?? ctx.newId("rem");
    const existing = await first<{ version: number }>(ctx.db, "SELECT version FROM reminders WHERE user_id = ? AND reminder_id = ?", ctx.userId, reminderId);
    const version = (existing?.version ?? 0) + 1;
    const planned: PlannedEffect[] = [...new Set(p.leadMinutes)]
      .map((lead) => ({ lead, at: dueMs - lead * 60_000 }))
      .filter((x) => x.at > ctx.nowMs)
      .map((x) => ({ kind: "notification.reminder", targetKey: `reminder:${reminderId}`, operationKey: `reminder:${reminderId}:${p.dueAt}:${x.lead}`, payload: { reminderId, kind: p.kind, title: p.title, dueAt: p.dueAt, leadMinutes: x.lead }, availableAt: toInstant(x.at) }));
    planned.push({ kind: "calendar.project_reminder", targetKey: `reminder:${reminderId}`, operationKey: `reminder-calendar:${reminderId}:${version}`, desiredRevision: version, payload: { reminderId, kind: p.kind, title: p.title, dueAt: p.dueAt, note: p.note, url: p.url } });
    const effects = await newEffects(ctx, planned);
    return {
      outcome: existing ? "merged" : "committed",
      summary: `Reminder set: ${named(p.title)} at ${p.dueAt}`,
      statements: [
        existing
          ? stmt("UPDATE reminders SET version = version + 1, kind = ?, title = ?, note = ?, url = ?, due_at = ?, status = 'active', command_id = ?, updated_at = ? WHERE user_id = ? AND reminder_id = ?", p.kind, p.title, p.note, p.url, p.dueAt, ctx.commandId, ctx.now, ctx.userId, reminderId)
          : stmt("INSERT INTO reminders (user_id, reminder_id, version, kind, title, note, due_at, url, status, source_ref, command_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)", ctx.userId, reminderId, p.kind, p.title, p.note, p.dueAt, p.url, ctx.envelope.source.parentId ?? null, ctx.commandId, ctx.now, ctx.now),
        // A changed time supersedes notifications queued for the old one. (A prefix comparison, not LIKE: D1 limits a LIKE pattern to 50 bytes.)
        ...(existing ? [stmt("UPDATE effects SET state = 'cancelled', updated_at = ? WHERE user_id = ? AND kind = 'notification.reminder' AND target_key = ? AND state = 'pending' AND substr(operation_key, 1, length(?)) != ?", ctx.now, ctx.userId, `reminder:${reminderId}`, `reminder:${reminderId}:${p.dueAt}:`, `reminder:${reminderId}:${p.dueAt}:`)] : []),
      ],
      affected: [{ kind: "reminder", id: reminderId, version }],
      effects,
      result: { reminderId, dueAt: p.dueAt },
      undo: { data: { reminderId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return cancelPlan(ctx.now, ctx.userId, data.reminderId, "Reminder removed");
  },
});

function cancelPlan(now: string, userId: string, reminderId: string, summary: string) {
  return {
    summary,
    statements: [
      stmt("UPDATE reminders SET status = 'cancelled', version = version + 1, updated_at = ? WHERE user_id = ? AND reminder_id = ?", now, userId, reminderId),
      stmt("UPDATE effects SET state = 'cancelled', updated_at = ? WHERE user_id = ? AND target_key = ? AND kind IN ('notification.reminder', 'calendar.project_reminder') AND state = 'pending'", now, userId, `reminder:${reminderId}`),
    ],
    undo: NO_UNDO("set the reminder again to restore it"),
  };
}

export const reminderCancel = define({
  type: "reminder.cancel",
  schema: C["reminder.cancel"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const row = await first<{ status: string; title: string }>(ctx.db, "SELECT status, title FROM reminders WHERE user_id = ? AND reminder_id = ?", ctx.userId, p.reminderId);
    if (!row) throw new CommandError("not_found", `no reminder '${p.reminderId}'; nothing was written`);
    if (row.status === "cancelled") return { outcome: "noop" as const, summary: "That reminder was already removed", undo: NO_UNDO("nothing changed") };
    return { ...cancelPlan(ctx.now, ctx.userId, p.reminderId, `Reminder removed: ${row.title}`), affected: [{ kind: "reminder", id: p.reminderId, version: 2 }], result: { reminderId: p.reminderId } };
  },
});

/** Administrative record of an owner's AI Search instance. The provisioning itself is done by trusted code with the namespace binding. */
export const searchRecordInstance = define({
  type: "search.record_instance",
  schema: C["search.record_instance"],
  class: "system",
  requiredScope: "admin",
  async plan(ctx, p) {
    return {
      summary: `AI Search instance ${p.instance} ${p.created ? "created" : "confirmed"} for ${p.environment} on gateway ${p.gatewayId}`,
      statements: [
        stmt(
          "INSERT INTO search_instances (user_id, environment, instance, gateway_id, created, provisioned_at, command_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, environment) DO UPDATE SET instance = excluded.instance, gateway_id = excluded.gateway_id, provisioned_at = excluded.provisioned_at, command_id = excluded.command_id",
          ctx.userId, p.environment, p.instance, p.gatewayId, p.created, ctx.now, ctx.commandId,
        ),
      ],
      result: { instance: p.instance },
      undo: NO_UNDO("an administrative record"),
    };
  },
});

/** Mailbox synchronization progress, written by the purchase investigation job. Identifiers only; no message content. */
export const mailRecordSync = define({
  type: "mail.record_sync",
  schema: C["mail.record_sync"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule"],
  async plan(ctx, p) {
    if (!(await first(ctx.db, "SELECT 1 AS x FROM connections WHERE user_id = ? AND connection_id = ?", ctx.userId, p.connectionId))) throw new CommandError("not_found", `no connection '${p.connectionId}'`);
    return {
      summary: `Mailbox read: ${p.seen.length} message(s) recorded as read (${p.completion})`,
      statements: [
        ...p.seen.map((m) => stmt("INSERT OR IGNORE INTO mail_seen (user_id, connection_id, message_id, classified, sent_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)", ctx.userId, p.connectionId, m.messageId, m.classified, m.sentAt, ctx.now)),
        stmt(
          "INSERT INTO mail_sync_state (user_id, connection_id, history_id, backfill_from, backfill_to, completion, resume_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, connection_id) DO UPDATE SET history_id = COALESCE(excluded.history_id, history_id), backfill_from = COALESCE(excluded.backfill_from, backfill_from), backfill_to = COALESCE(excluded.backfill_to, backfill_to), completion = excluded.completion, resume_json = excluded.resume_json, updated_at = excluded.updated_at",
          ctx.userId, p.connectionId, p.historyId, p.backfillFrom, p.backfillTo, p.completion, p.resume ? JSON.stringify(p.resume) : null, ctx.now,
        ),
      ],
      result: { connectionId: p.connectionId, recorded: p.seen.length },
      undo: NO_UNDO("a synchronization watermark is superseded by the next run"),
    };
  },
});

export const reminderHandlers = [reminderSet, reminderCancel, searchRecordInstance, mailRecordSync];
