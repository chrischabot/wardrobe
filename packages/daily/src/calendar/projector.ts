/**
 * Calendar as a dependable presentation (specification section 9).
 *
 * One managed event per board day, addressed by a stable caller-supplied ID. The projector always
 * projects what D1 says NOW (the current revision, or the absence of a board when it is suppressed or
 * paused), so an older delayed effect can never restore older contents. New contents replace the
 * managed contents of the existing event: nothing is appended and no second event is created. A write
 * is reported `projected` only after a read-back verified that revision.
 */
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { claimDueEffects, first, latestDesiredRevision, prepare, settleEffect, stmt, toInstant, zonedToUtcMs, type Db, type EffectRecord } from "@garderobe/domain";
import { CALENDAR_EFFECT_KIND } from "../boards.ts";
import { dailySettings, loadOwner } from "../context.ts";
import type { DailyDeps } from "../deps.ts";
import { boardSummary, buildBoardDocument, loadBoard, pauseCovering, renderBoardCalendarText } from "../document.ts";
import { CalendarApiError, CalendarNotConnectedError, type CalendarWriter, type ManagedEvent, type ManagedEventWrite } from "../ports.ts";
import { managedEventId } from "./event-id.ts";

export const REVISION_PROPERTY = "garderobeRevision";
export const BOARD_PROPERTY = "garderobeBoard";
const MAX_ATTEMPTS = 8;

export type ProjectionOutcome = "projected" | "removed" | "superseded" | "not_connected" | "retry" | "failed" | "skipped_deleted_externally" | "suppressed_deleted_externally" | "busy";

interface ProjectionRow {
  target_key: string;
  board_id: string;
  calendar_id: string | null;
  event_id: string;
  state: string;
  suppression_reason: string | null;
  projected_revision: number | null;
  etag: string | null;
  managed_text: string | null;
}

async function setProjection(db: Db, userId: string, targetKey: string, nowMs: number, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  await prepare(db, stmt(`UPDATE calendar_projections SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE user_id = ? AND target_key = ?`, ...keys.map((k) => fields[k]), toInstant(nowMs), userId, targetKey)).run();
}

/** Replace the managed text inside whatever the description holds now, preserving unmanaged content around it. */
export function mergeDescription(remote: string | null, previousManaged: string | null, next: string): string {
  if (!remote || remote.trim() === "") return next;
  if (previousManaged && remote.includes(previousManaged)) return remote.replace(previousManaged, next);
  if (remote.includes(next)) return remote;
  // The managed outfit text itself was edited: the authoritative projection replaces it.
  return next;
}

function isNotConnected(e: unknown): boolean {
  return e instanceof CalendarNotConnectedError || (e as Error)?.name === "CalendarNotConnectedError";
}
function apiError(e: unknown): CalendarApiError | null {
  return e instanceof CalendarApiError || (e as Error)?.name === "CalendarApiError" ? (e as CalendarApiError) : null;
}

function eventWrite(doc: BoardDocument, text: string, morningLocalTime: string, presentation: "timed" | "all_day", reminderMinutesBefore: number | null): ManagedEventWrite {
  const startMs = zonedToUtcMs(doc.localDate, morningLocalTime, doc.timezone);
  return {
    summary: boardSummary(doc),
    description: text,
    privateProperties: { [BOARD_PROPERTY]: doc.boardId, [REVISION_PROPERTY]: String(doc.revision) },
    // An all-day board has no 7 AM start; the morning reminder is then the app's, kept separate.
    time: presentation === "all_day" ? { kind: "all_day", localDate: doc.localDate } : { kind: "timed", startsAt: toInstant(startMs), endsAt: toInstant(startMs + 15 * 60_000), timezone: doc.timezone },
    reminderMinutesBefore,
  };
}

async function projectOne(deps: DailyDeps, effect: EffectRecord, nowMs: number): Promise<ProjectionOutcome> {
  const db = deps.db;
  const { userId, targetKey } = effect;
  const payload = effect.payload as { boardId?: string | null; localDate: string; scope: string; restore?: boolean };
  const retryLater = async (error: string, outcome: ProjectionOutcome, delayMs: number): Promise<ProjectionOutcome> => {
    if (effect.attempts >= MAX_ATTEMPTS) {
      await settleEffect(db, effect, { state: "failed" }, nowMs);
      return outcome === "not_connected" ? "not_connected" : "failed";
    }
    await settleEffect(db, effect, { state: "retry", error, retryAtMs: nowMs + delayMs }, nowMs);
    return outcome;
  };

  // A newer desired revision exists for this event: this effect is superseded and never written.
  const latest = await latestDesiredRevision(db, userId, effect.kind, targetKey);
  if (latest !== null && latest > effect.desiredRevision) {
    await settleEffect(db, effect, { state: "superseded" }, nowMs);
    return "superseded";
  }

  const eventId = await managedEventId(userId, payload.scope, payload.localDate);
  await prepare(db, stmt("INSERT INTO calendar_projections (user_id, target_key, board_id, local_date, event_id, state, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (user_id, target_key) DO NOTHING", userId, targetKey, payload.boardId ?? "", payload.localDate, eventId, toInstant(nowMs))).run();

  const owner = await loadOwner(db, userId);
  const settings = dailySettings(owner.settings);
  const calendarId = settings.calendar.outfitCalendarId;
  const writer: CalendarWriter | null = deps.calendar.writer;
  if (!writer || !calendarId) {
    await setProjection(db, userId, targetKey, nowMs, { state: "not_connected", last_error: !writer ? "Google Calendar is not connected" : "no outfit calendar has been chosen" });
    return retryLater("calendar not connected", "not_connected", 30 * 60_000);
  }

  // Serialize projection per managed event.
  const lock = await prepare(db, stmt("UPDATE calendar_projections SET lock_until = ? WHERE user_id = ? AND target_key = ? AND (lock_until IS NULL OR lock_until < ?)", toInstant(nowMs + 60_000), userId, targetKey, toInstant(nowMs))).run();
  if ((lock.meta?.changes ?? 0) !== 1) {
    await settleEffect(db, effect, { state: "retry", error: "another projection of this event is in progress", retryAtMs: nowMs + 15_000 }, nowMs);
    return "busy";
  }

  try {
    const row = (await first<ProjectionRow>(db, "SELECT target_key, board_id, calendar_id, event_id, state, suppression_reason, projected_revision, etag, managed_text FROM calendar_projections WHERE user_id = ? AND target_key = ?", userId, targetKey))!;
    if (row.state === "suppressed" && row.suppression_reason === "deleted_externally" && !payload.restore) {
      // The owner deleted the event in Calendar: delivery for that day stays suppressed until an explicit restore.
      await settleEffect(db, effect, { state: "cancelled" }, nowMs);
      return "skipped_deleted_externally";
    }

    for (let round = 0; round < 4; round++) {
      // Recheck what D1 wants before every write.
      const board = await loadBoard(db, userId, { date: payload.localDate, scope: payload.scope });
      const suppression = await first<{ reason: string }>(db, "SELECT reason FROM board_suppressions WHERE user_id = ? AND scope = ? AND local_date = ? AND status = 'active'", userId, payload.scope, payload.localDate);
      const paused = await pauseCovering(db, userId, payload.localDate);
      const absent = !board || board.status === "suppressed" || !!suppression || !!paused;
      const remote = await writer.getEvent(userId, calendarId, eventId);

      if (absent) {
        if (remote && remote.status !== "cancelled") await writer.deleteEvent(userId, calendarId, eventId);
        const after = await writer.getEvent(userId, calendarId, eventId);
        if (after && after.status !== "cancelled") continue;
        await setProjection(db, userId, targetKey, nowMs, { state: "suppressed", suppression_reason: paused ? "pause" : "owner_request", calendar_id: calendarId, etag: null, last_error: null, last_verified_at: toInstant(nowMs) });
        await settleEffect(db, effect, { state: "projected" }, nowMs);
        return "removed";
      }

      const doc = await buildBoardDocument(db, userId, board);
      const url = settings.calendar.boardBaseUrl ? `${settings.calendar.boardBaseUrl.replace(/\/+$/, "")}/board/${doc.localDate}` : null;
      const text = renderBoardCalendarText(doc, { boardUrl: url });
      const write = eventWrite(doc, text, owner.settings.delivery.morningLocalTime, settings.calendar.presentation, settings.calendar.reminderMinutesBefore);

      const deletedByOwner = (remote === null && row.projected_revision !== null && row.state === "projected") || (remote?.status === "cancelled" && row.state !== "suppressed" && row.projected_revision !== null);
      if (deletedByOwner && !payload.restore) {
        await setProjection(db, userId, targetKey, nowMs, { state: "suppressed", suppression_reason: "deleted_externally", last_error: null });
        await settleEffect(db, effect, { state: "cancelled" }, nowMs);
        return "suppressed_deleted_externally";
      }

      let written: ManagedEvent | null = null;
      const alreadyCurrent = !!remote && remote.status !== "cancelled" && remote.privateProperties[REVISION_PROPERTY] === String(doc.revision) && (remote.description ?? "").includes(text);
      try {
        if (alreadyCurrent) {
          written = remote; // an identical projection already landed (a retried or duplicate effect): nothing to write
        } else if (remote === null) {
          written = await writer.insertEvent(userId, calendarId, eventId, write);
        } else {
          const description = mergeDescription(remote.status === "cancelled" ? null : remote.description, row.managed_text, text);
          written = await writer.patchEvent(userId, calendarId, eventId, { ...write, description, ...(remote.status === "cancelled" ? { status: "confirmed" as const } : {}) }, remote.etag);
        }
      } catch (e) {
        const api = apiError(e);
        if (!api) throw e;
        // Lost conditional update, an ID that already exists, or an uncertain outcome: retrieve the
        // event by its stable ID and decide from what is actually there. Never create another event.
        if (api.detail.reason !== "precondition" && api.detail.reason !== "duplicate" && !api.detail.retryable) throw e;
      }

      // Read-back: only a verified revision is reported as projected.
      const check = await writer.getEvent(userId, calendarId, eventId);
      const current = await loadBoard(db, userId, { date: payload.localDate, scope: payload.scope });
      const verified = !!check && check.status !== "cancelled" && check.privateProperties[REVISION_PROPERTY] === String(doc.revision) && (check.description ?? "").includes(text);
      if (verified && current && current.current_revision === doc.revision && current.status !== "suppressed") {
        await setProjection(db, userId, targetKey, nowMs, { state: "projected", suppression_reason: null, board_id: doc.boardId, calendar_id: calendarId, projected_revision: doc.revision, etag: check!.etag ?? written?.etag ?? null, managed_text: text, last_verified_at: toInstant(nowMs), last_error: null });
        await settleEffect(db, effect, { state: "projected" }, nowMs);
        return "projected";
      }
      // Not verified, or the board moved on while writing: go round again with the newest state.
    }
    await setProjection(db, userId, targetKey, nowMs, { last_error: "the event could not be verified after writing" });
    return retryLater("read-back did not verify the projected revision", "retry", 60_000);
  } catch (e) {
    if (isNotConnected(e)) {
      await setProjection(db, userId, targetKey, nowMs, { state: "not_connected", last_error: "Google Calendar is not connected" });
      return retryLater("calendar not connected", "not_connected", 30 * 60_000);
    }
    const api = apiError(e);
    const message = api ? `calendar error${api.detail.status ? ` ${api.detail.status}` : ""}${api.detail.reason ? ` (${api.detail.reason})` : ""}` : String((e as Error)?.message ?? e).slice(0, 200);
    if (api && !api.detail.retryable) {
      await setProjection(db, userId, targetKey, nowMs, { state: "failed", last_error: message });
      await settleEffect(db, effect, { state: "failed" }, nowMs);
      return "failed";
    }
    await setProjection(db, userId, targetKey, nowMs, { last_error: message, ...(effect.attempts >= MAX_ATTEMPTS ? { state: "failed" } : {}) });
    return retryLater(message, "retry", Math.min(15 * 60_000, 30_000 * 2 ** Math.min(effect.attempts, 5)));
  } finally {
    await prepare(db, stmt("UPDATE calendar_projections SET lock_until = NULL WHERE user_id = ? AND target_key = ?", userId, targetKey)).run();
  }
}

/** Claim and deliver due Calendar projection effects. Safe to call repeatedly and concurrently. */
export async function projectCalendarEffects(deps: DailyDeps, opts: { nowMs?: number; limit?: number } = {}): Promise<{ effectId: string; userId: string; targetKey: string; outcome: ProjectionOutcome }[]> {
  const nowMs = opts.nowMs ?? deps.clock?.() ?? Date.now();
  const effects = await claimDueEffects(deps.db, { nowMs, kinds: [CALENDAR_EFFECT_KIND], limit: opts.limit ?? 20 });
  const out: { effectId: string; userId: string; targetKey: string; outcome: ProjectionOutcome }[] = [];
  for (const effect of effects) {
    let outcome: ProjectionOutcome;
    try {
      outcome = await projectOne(deps, effect, nowMs);
    } catch (e) {
      await settleEffect(deps.db, effect, { state: "retry", error: String((e as Error)?.message ?? e).slice(0, 200), retryAtMs: nowMs + 60_000 }, nowMs);
      outcome = "retry";
    }
    out.push({ effectId: effect.effectId, userId: effect.userId, targetKey: effect.targetKey, outcome });
  }
  return out;
}
