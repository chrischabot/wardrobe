/**
 * The evening-to-morning service (specification section 9).
 *
 * A due-job sweep evaluates every owner's LOCAL schedule from UTC, so daylight-saving changes are
 * handled by the civil-time conversion, and claims each (owner, local day, phase) exactly once in D1.
 * Missed phases are retried after recovery while they are still useful. No phone, timer or consumer
 * assistant takes part: the board is composed the evening before, refreshed and published before the
 * morning, and presenting it needs no inference.
 */
import { addDays, all, first, isCommandError, localDateOf, prepare, stmt, systemPrincipalFor, toInstant, zonedToUtcMs, type Principal } from "@garderobe/domain";
import { dailySettings, loadOwner } from "./context.ts";
import { projectCalendarEffects } from "./calendar/projector.ts";
import { nowOf, type DailyDeps } from "./deps.ts";
import { loadBoard, loadRevision, pauseCovering } from "./document.ts";
import { relevantEvents } from "./calendar/influence.ts";
import { resumeService } from "./pause.ts";
import { prepareBoard, replenishBoards, reviseBoard } from "./service.ts";
import { fetchWeatherSnapshot, readCalendarSnapshot } from "./snapshots.ts";
import { materialChange } from "./weather/assess.ts";

export type Phase = "evening_compose" | "morning_refresh" | "morning_publish" | "morning_present";
export const PHASES: Phase[] = ["evening_compose", "morning_refresh", "morning_publish", "morning_present"];
const MAX_PHASE_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;
/** A missed morning phase is still worth running for this long after the morning time; later it would only be noise. */
export const MORNING_CATCH_UP_MS = 3 * 3600_000;

export interface PhaseRun {
  userId: string;
  localDate: string;
  phase: Phase | "resume";
  status: "succeeded" | "failed" | "skipped_paused" | "already_done" | "in_progress" | "not_due";
  detail: Record<string, unknown>;
}

function minusMinutes(localTime: string, minutes: number): string {
  const [h, m] = localTime.split(":").map(Number) as [number, number];
  const total = Math.max(0, h * 60 + m - minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** UTC instants of one board day's phases in the owner's timezone, and until when each is still worth running. */
export function phaseSchedule(localDate: string, timezone: string, morningLocalTime: string, daily: { eveningComposeLocalTime: string; morningRefreshLeadMinutes: number; morningPublishLeadMinutes: number }): Record<Phase, { dueAtMs: number; expiresAtMs: number }> {
  const morning = zonedToUtcMs(localDate, morningLocalTime, timezone);
  const endOfDay = Math.min(zonedToUtcMs(addDays(localDate, 1), "00:00", timezone), morning + MORNING_CATCH_UP_MS);
  return {
    // Composed the evening before; if that run was missed it is still worth doing until the morning refresh takes over.
    evening_compose: { dueAtMs: zonedToUtcMs(addDays(localDate, -1), daily.eveningComposeLocalTime, timezone), expiresAtMs: zonedToUtcMs(localDate, minusMinutes(morningLocalTime, daily.morningRefreshLeadMinutes), timezone) },
    morning_refresh: { dueAtMs: zonedToUtcMs(localDate, minusMinutes(morningLocalTime, daily.morningRefreshLeadMinutes), timezone), expiresAtMs: endOfDay },
    morning_publish: { dueAtMs: zonedToUtcMs(localDate, minusMinutes(morningLocalTime, daily.morningPublishLeadMinutes), timezone), expiresAtMs: endOfDay },
    morning_present: { dueAtMs: morning, expiresAtMs: endOfDay },
  };
}

/** Claim one (owner, local day, phase). Returns false when it is done, in progress, or out of attempts. */
async function claim(deps: DailyDeps, userId: string, localDate: string, phase: string, dueAtMs: number, timezone: string, nowMs: number): Promise<"claimed" | "already_done" | "in_progress"> {
  const now = toInstant(nowMs);
  const lease = toInstant(nowMs + LEASE_MS);
  const inserted = await prepare(
    deps.db,
    stmt("INSERT INTO day_runs (user_id, local_date, phase, status, due_at, timezone, attempts, lease_until, started_at) VALUES (?, ?, ?, 'running', ?, ?, 1, ?, ?) ON CONFLICT (user_id, local_date, phase) DO NOTHING", userId, localDate, phase, toInstant(dueAtMs), timezone, lease, now),
  ).run();
  if ((inserted.meta?.changes ?? 0) === 1) return "claimed";
  const retry = await prepare(
    deps.db,
    stmt(
      "UPDATE day_runs SET status = 'running', attempts = attempts + 1, lease_until = ?, started_at = ? WHERE user_id = ? AND local_date = ? AND phase = ? AND attempts < ? AND (status = 'failed' OR (status = 'running' AND lease_until < ?))",
      lease, now, userId, localDate, phase, MAX_PHASE_ATTEMPTS, now,
    ),
  ).run();
  if ((retry.meta?.changes ?? 0) === 1) return "claimed";
  const row = await first<{ status: string }>(deps.db, "SELECT status FROM day_runs WHERE user_id = ? AND local_date = ? AND phase = ?", userId, localDate, phase);
  return row?.status === "running" ? "in_progress" : "already_done";
}

async function finish(deps: DailyDeps, userId: string, localDate: string, phase: string, status: "succeeded" | "failed" | "skipped_paused", detail: Record<string, unknown>, nowMs: number): Promise<void> {
  await prepare(deps.db, stmt("UPDATE day_runs SET status = ?, finished_at = ?, lease_until = NULL, detail_json = ? WHERE user_id = ? AND local_date = ? AND phase = ?", status, toInstant(nowMs), JSON.stringify(detail), userId, localDate, phase)).run();
}

async function applyWeeklyReset(deps: DailyDeps, principal: Principal, key: string): Promise<void> {
  // The inferred weekly cleanliness baseline, under the owner's standing authorization; applied once per cycle by the ledger.
  await deps.commands.execute(principal, { type: "laundry.apply_weekly_reset", payload: {}, idempotencyKey: key, expectedVersions: {}, authorization: "standing_policy", source: { channel: principal.channel } });
}

async function runPhase(deps: DailyDeps, principal: Principal, localDate: string, phase: Phase, nowMs: number): Promise<Record<string, unknown>> {
  const userId = principal.userId;
  const key = `phase:${phase}:${userId}:${localDate}`;
  if (phase === "evening_compose") {
    await applyWeeklyReset(deps, principal, `${key}:weekly-reset`);
    const existing = await loadBoard(deps.db, userId, { date: localDate });
    if (existing) {
      // The owner already planned this day: it is revalidated and refreshed, never recomposed over.
      if (existing.status !== "active") return { board: existing.board_id, action: "left_alone", status: existing.status };
      const weather = await fetchWeatherSnapshot(deps, principal, { localDate, purpose: "evening_compose", nowMs });
      const calendar = await readCalendarSnapshot(deps, principal, { localDate, nowMs });
      const r = await reviseBoard(deps, principal, existing, { nowMs, reason: "refresh", weather, calendar, force: true, idempotencyKey: `${key}:refresh` });
      return { board: r.boardId, action: r.action, revision: r.revision, offered: r.offered, weather: weather.freshness, calendar: calendar.status };
    }
    const result = await prepareBoard(deps, principal, { localDate, purpose: "evening_compose", idempotencyKey: key, nowMs });
    return { board: result.board?.boardId ?? null, revision: result.board?.revision ?? null, offered: result.board?.options.length ?? 0, requested: result.requestedCount, note: result.note, weather: result.board?.freshness.weather ?? null, calendar: result.board?.freshness.calendar ?? null, model: result.diagnostics?.modelProfile ?? null, modelError: result.diagnostics?.modelError ?? null };
  }

  if (phase === "morning_refresh") {
    await applyWeeklyReset(deps, principal, `${key}:weekly-reset`);
    const weather = await fetchWeatherSnapshot(deps, principal, { localDate, purpose: "morning_refresh", nowMs });
    const calendar = await readCalendarSnapshot(deps, principal, { localDate, nowMs });
    const board = await loadBoard(deps.db, userId, { date: localDate });
    if (!board) {
      const result = await prepareBoard(deps, principal, { localDate, purpose: "morning_refresh", weather, calendar, idempotencyKey: key, nowMs });
      return { board: result.board?.boardId ?? null, action: "composed_late", offered: result.board?.options.length ?? 0, note: result.note, weather: weather.freshness, calendar: calendar.status };
    }
    if (board.status !== "active") return { board: board.board_id, action: "left_alone", status: board.status };
    const revision = (await loadRevision(deps.db, userId, board.board_id, board.current_revision))!;
    const change = materialChange(revision.conditions, weather.conditions);
    const previousCalendar = revision.calendar_snapshot_id ? await first<{ snapshot_json: string }>(deps.db, "SELECT snapshot_json FROM calendar_snapshots WHERE user_id = ? AND snapshot_id = ?", userId, revision.calendar_snapshot_id) : null;
    const before = previousCalendar ? relevantEvents(JSON.parse(previousCalendar.snapshot_json).events ?? []).map((e) => e.eventId).sort().join(",") : "";
    const after = calendar.status === "ok" ? relevantEvents(calendar.events).map((e) => e.eventId).sort().join(",") : before;
    // After a selection the day is not rebuilt for an ordinary change: the chosen outfit keeps its
    // pieces and at most a layer is adjusted. Without a selection, a material change recomposes.
    if (!board.selected_option_id && ((change.material && weather.freshness !== "unavailable") || before !== after)) {
      const result = await prepareBoard(deps, principal, { localDate, reason: "refresh", brief: revision.brief, purpose: "morning_refresh", weather, calendar, idempotencyKey: key, nowMs });
      return { board: board.board_id, action: "recomposed", reasons: [...change.reasons, ...(before !== after ? ["calendar changed"] : [])], revision: result.board?.revision ?? null, offered: result.board?.options.length ?? 0, weather: weather.freshness, calendar: calendar.status };
    }
    // A failed source never downgrades a board that was validated against a real forecast: the
    // limitation is recorded on the run and the earlier basis stays in force.
    if (weather.freshness === "unavailable" && revision.conditions.freshness !== "unavailable") {
      const r = await reviseBoard(deps, principal, board, { nowMs, reason: "refresh", idempotencyKey: `${key}:revalidate` });
      return { board: board.board_id, action: r.action, revision: r.revision, offered: r.offered, weather: "unavailable", weatherLimitation: weather.limitation, keptBasis: revision.weather_snapshot_id, calendar: calendar.status };
    }
    const r = await reviseBoard(deps, principal, board, { nowMs, reason: "refresh", weather, calendar: calendar.status === "error" || calendar.status === "not_connected" ? undefined : calendar, force: true, idempotencyKey: `${key}:refresh` });
    return { board: board.board_id, action: r.action, revision: r.revision, offered: r.offered, materialWeatherChange: change.material, reasons: change.reasons, weather: weather.freshness, calendar: calendar.status };
  }

  if (phase === "morning_publish") {
    let board = await loadBoard(deps.db, userId, { date: localDate });
    if (!board) {
      const result = await prepareBoard(deps, principal, { localDate, purpose: "morning_refresh", idempotencyKey: key, nowMs });
      board = result.board ? await loadBoard(deps.db, userId, { date: localDate }) : null;
    }
    await replenishBoards(deps, principal, { nowMs });
    await projectCalendarEffects(deps, { nowMs });
    board = await loadBoard(deps.db, userId, { date: localDate });
    const projection = await first<{ state: string; projected_revision: number | null; last_error: string | null }>(deps.db, "SELECT state, projected_revision, last_error FROM calendar_projections WHERE user_id = ? AND target_key = ?", userId, `outfit-event:home:${localDate}`);
    const verified = !!board && projection?.state === "projected" && projection.projected_revision === board.current_revision;
    return { board: board?.board_id ?? null, revision: board?.current_revision ?? null, boardReady: !!board, calendar: projection?.state ?? "not_requested", calendarVerified: verified, calendarError: projection?.last_error ?? null };
  }

  // morning_present: the board is already prepared; this only marks it and queues the reminder.
  const board = await loadBoard(deps.db, userId, { date: localDate });
  if (!board) return { presented: false, why: "no board was prepared for this day" };
  try {
    const receipt = await deps.commands.execute(principal, { type: "board.present", payload: { localDate, scope: "home" }, idempotencyKey: key, expectedVersions: {}, authorization: "system_schedule", source: { channel: principal.channel } });
    return { presented: true, board: board.board_id, revision: board.current_revision, reminderQueued: receipt.effects.length > 0, inferenceCalls: 0 };
  } catch (e) {
    if (isCommandError(e) && e.code === "precondition_failed") return { presented: false, why: e.message };
    throw e;
  }
}

/** Run one phase for one owner and day, idempotently. Suitable as a Workflow step. */
export async function runOwnerPhase(deps: DailyDeps, input: { userId: string; localDate: string; phase: Phase; nowMs?: number; force?: boolean }): Promise<PhaseRun> {
  const nowMs = nowOf(deps, input.nowMs);
  const { userId, localDate, phase } = input;
  // The durable job's owner is rechecked before any effect: a disabled account runs nothing.
  const principal = await systemPrincipalFor(deps.db, userId, `daily:${phase}:${localDate}`);
  const owner = await loadOwner(deps.db, userId);
  const tz = owner.settings.timezone;
  const schedule = phaseSchedule(localDate, tz, owner.settings.delivery.morningLocalTime, dailySettings(owner.settings))[phase];
  if (!input.force && (nowMs < schedule.dueAtMs || nowMs >= schedule.expiresAtMs)) return { userId, localDate, phase, status: "not_due", detail: {} };
  const claimed = await claim(deps, userId, localDate, phase, schedule.dueAtMs, tz, nowMs);
  if (claimed !== "claimed") return { userId, localDate, phase, status: claimed, detail: {} };
  // Pause state is checked before any queued job composes or publishes.
  const paused = await pauseCovering(deps.db, userId, localDate);
  if (paused) {
    const detail = { pauseId: paused.pauseId };
    await finish(deps, userId, localDate, phase, "skipped_paused", detail, nowMs);
    return { userId, localDate, phase, status: "skipped_paused", detail };
  }
  try {
    const detail = await runPhase(deps, principal, localDate, phase, nowMs);
    await finish(deps, userId, localDate, phase, "succeeded", detail, nowMs);
    return { userId, localDate, phase, status: "succeeded", detail };
  } catch (e) {
    const detail = { error: isCommandError(e) ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e).slice(0, 300) };
    await finish(deps, userId, localDate, phase, "failed", detail, nowMs);
    return { userId, localDate, phase, status: "failed", detail };
  }
}

/**
 * The due-job sweep (run from the five-minute cron). For every active owner: automatic resume when a
 * pause's resume date has arrived, every due phase for today's and tomorrow's boards, the background
 * replenishment of shrunken boards, then delivery of pending Calendar projections.
 */
export async function runDueJobs(deps: DailyDeps, opts: { nowMs?: number } = {}): Promise<{ runs: PhaseRun[]; projections: Awaited<ReturnType<typeof projectCalendarEffects>> }> {
  const nowMs = nowOf(deps, opts.nowMs);
  const users = await all<{ user_id: string }>(deps.db, "SELECT user_id FROM users WHERE status = 'active' ORDER BY user_id");
  const runs: PhaseRun[] = [];
  for (const { user_id: userId } of users) {
    let owner;
    try {
      owner = await loadOwner(deps.db, userId);
    } catch {
      continue;
    }
    const tz = owner.settings.timezone;
    const daily = dailySettings(owner.settings);
    const today = localDateOf(nowMs, tz);

    const pause = await first<{ pause_id: string; resume_on: string | null }>(deps.db, "SELECT pause_id, resume_on FROM service_pauses WHERE user_id = ? AND status = 'active'", userId);
    if (pause && pause.resume_on !== null && pause.resume_on <= today) {
      const principal = await systemPrincipalFor(deps.db, userId, `daily:resume:${pause.pause_id}`);
      try {
        const r = await resumeService(deps, principal, { nowMs, clientRequestId: `auto:${pause.pause_id}` });
        runs.push({ userId, localDate: r.localDate, phase: "resume", status: "succeeded", detail: { pauseId: pause.pause_id, board: r.board?.boardId ?? null } });
      } catch (e) {
        runs.push({ userId, localDate: today, phase: "resume", status: "failed", detail: { error: String((e as Error)?.message ?? e).slice(0, 300) } });
      }
    }

    for (const localDate of [today, addDays(today, 1)]) {
      const schedule = phaseSchedule(localDate, tz, owner.settings.delivery.morningLocalTime, daily);
      for (const phase of PHASES) {
        const s = schedule[phase];
        if (nowMs < s.dueAtMs || nowMs >= s.expiresAtMs) continue;
        const run = await runOwnerPhase(deps, { userId, localDate, phase, nowMs });
        if (run.status !== "already_done" && run.status !== "not_due") runs.push(run);
      }
    }

    // Boards the in-commit repair had to shrink, or that an unevaluated change flagged.
    const flagged = await first<{ n: number }>(deps.db, "SELECT COUNT(*) AS n FROM boards WHERE user_id = ? AND status = 'active' AND needs_replenishment = 1 AND local_date >= ?", userId, today);
    if ((flagged?.n ?? 0) > 0) {
      try {
        await replenishBoards(deps, await systemPrincipalFor(deps.db, userId, "daily:replenish"), { nowMs });
      } catch {
        // Left flagged; the next sweep tries again. Existing valid options stay usable meanwhile.
      }
    }
  }
  const projections = await projectCalendarEffects(deps, { nowMs, limit: 50 });
  return { runs, projections };
}
