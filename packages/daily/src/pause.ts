/**
 * Pause and resume (specification section 9), and the morning presentation marker.
 *
 * Pausing stops composition, automatic publication and wardrobe reminders for the interval. It does
 * not touch conversation, observations or existing data, and it needs no reason. Managed outfit
 * events inside the interval are removed so their reminders stop. Resuming prepares the next useful
 * board: no missed notifications, no questions about missing wears, no backlog of old boards.
 */
import { DAILY_COMMANDS } from "@garderobe/contracts/ext/daily";
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { all, assertPrincipal, CommandError, define, first, localDateOf, requireScope, stmt, type CommandContext, type CommandPlan, type CommandRegistry, type PlannedEffect, type Principal } from "@garderobe/domain";
import { CALENDAR_EFFECT_KIND, projectionTarget } from "./boards.ts";
import { dailySettings, loadOwner } from "./context.ts";
import { nowOf, type DailyDeps } from "./deps.ts";
import { buildBoardDocument, loadBoard, pauseCovering, type BoardRow } from "./document.ts";
import { parseScope } from "./model.ts";
import { prepareBoard } from "./service.ts";

export const MORNING_REMINDER_EFFECT_KIND = "notification.morning_board";

async function calendarEffectsFor(ctx: CommandContext, from: string, until: string | null): Promise<PlannedEffect[]> {
  const boards = await all<BoardRow>(ctx.db, "SELECT * FROM boards WHERE user_id = ? AND status = 'active' AND local_date >= ? AND (? IS NULL OR local_date < ?) ORDER BY local_date", ctx.userId, from, until, until);
  return boards
    .filter((b) => !parseScope(b.scope).evening)
    .map((b) => {
      const targetKey = projectionTarget(b.scope, b.local_date);
      return { kind: CALENDAR_EFFECT_KIND, targetKey, operationKey: `${CALENDAR_EFFECT_KIND}:${targetKey}:${ctx.commandId}`, desiredRevision: ctx.nowMs, payload: { boardId: b.board_id, localDate: b.local_date, scope: b.scope } };
    });
}

export const servicePause = define({
  type: "service.pause",
  schema: DAILY_COMMANDS["service.pause"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const today = localDateOf(ctx.nowMs, ctx.settings.timezone);
    const from = p.from ?? today;
    if (from < today) throw new CommandError("invalid_command", "a pause cannot start in the past", { today });
    if (p.resumeOn !== null && p.resumeOn <= from) throw new CommandError("invalid_command", "the resume date must be after the first paused day");
    const active = await first<{ pause_id: string; starts_on: string; resume_on: string | null }>(ctx.db, "SELECT pause_id, starts_on, resume_on FROM service_pauses WHERE user_id = ? AND status = 'active'", ctx.userId);
    if (active && active.starts_on === from && active.resume_on === p.resumeOn) return { outcome: "noop", summary: "Recommendations are already paused for that interval", undo: { unavailableReason: "nothing changed" } };
    const pauseId = active?.pause_id ?? ctx.newId("pse");
    const statements = active
      ? [stmt("UPDATE service_pauses SET starts_on = ?, resume_on = ? WHERE user_id = ? AND pause_id = ? AND status = 'active'", from, p.resumeOn, ctx.userId, pauseId)]
      : [stmt("INSERT INTO service_pauses (user_id, pause_id, starts_on, resume_on, status, created_at, command_id) VALUES (?, ?, ?, ?, 'active', ?, ?)", ctx.userId, pauseId, from, p.resumeOn, ctx.now, ctx.commandId)];
    // Managed outfit events inside the interval are removed so their reminders do not continue; if the
    // interval moved, events of the days it no longer covers are projected again.
    const span = [from, ...(active ? [active.starts_on] : [])].sort()[0]!;
    return {
      summary: p.resumeOn ? `Recommendations paused from ${from} until ${p.resumeOn}. Conversation, observations and return deadlines are unaffected` : `Recommendations paused from ${from} until you resume. Conversation, observations and return deadlines are unaffected`,
      statements,
      preconditions: active ? [] : [{ label: "no other pause is active", sql: "NOT EXISTS (SELECT 1 FROM service_pauses WHERE user_id = ? AND status = 'active')", params: [ctx.userId], class: "internal" }],
      affected: [{ kind: "service_pause", id: pauseId, version: 1 }],
      effects: await calendarEffectsFor(ctx, span, null),
      result: { pauseId, from, resumeOn: p.resumeOn },
      undo: active ? { unavailableReason: "resume, or set the pause interval again" } : { data: { pauseId } },
    };
  },
  async planUndo(ctx, _o, data): Promise<CommandPlan> {
    const row = await first<{ starts_on: string }>(ctx.db, "SELECT starts_on FROM service_pauses WHERE user_id = ? AND pause_id = ? AND status = 'active'", ctx.userId, data.pauseId);
    if (!row) return { outcome: "noop", summary: "That pause has already ended", undo: { unavailableReason: "nothing changed" } };
    return {
      summary: "Pause removed",
      statements: [stmt("UPDATE service_pauses SET status = 'ended', ended_at = ?, ended_by_command_id = ? WHERE user_id = ? AND pause_id = ?", ctx.now, ctx.commandId, ctx.userId, data.pauseId)],
      effects: await calendarEffectsFor(ctx, row.starts_on, null),
      undo: { unavailableReason: "this is already an undo" },
    };
  },
});

export const serviceResume = define({
  type: "service.resume",
  schema: DAILY_COMMANDS["service.resume"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "system_schedule", "standing_policy"],
  async plan(ctx): Promise<CommandPlan> {
    const active = await first<{ pause_id: string; starts_on: string; resume_on: string | null }>(ctx.db, "SELECT pause_id, starts_on, resume_on FROM service_pauses WHERE user_id = ? AND status = 'active'", ctx.userId);
    if (!active) return { outcome: "noop", summary: "Recommendations are not paused", undo: { unavailableReason: "nothing changed" } };
    const today = localDateOf(ctx.nowMs, ctx.settings.timezone);
    // An automatic resume only happens on or after the date the owner set; an indefinite pause stays paused.
    if (ctx.principal.actor === "system" && (active.resume_on === null || active.resume_on > today)) {
      throw new CommandError("precondition_failed", "this pause has no resume date that has arrived; only the owner can resume it");
    }
    return {
      summary: "Recommendations resumed. The next board is being prepared; nothing from the pause is replayed",
      statements: [stmt("UPDATE service_pauses SET status = 'ended', ended_at = ?, ended_by_command_id = ? WHERE user_id = ? AND pause_id = ? AND status = 'active'", ctx.now, ctx.commandId, ctx.userId, active.pause_id)],
      affected: [{ kind: "service_pause", id: active.pause_id, version: 2 }],
      // Boards of past paused days are not projected: there is no backlog.
      effects: await calendarEffectsFor(ctx, today, null),
      result: { pauseId: active.pause_id, pausedFrom: active.starts_on },
      undo: { unavailableReason: "pause again instead" },
    };
  },
});

/**
 * The morning surface. Marks the already prepared board as presented and queues the configured
 * reminder exactly once per board day. It reads no model and composes nothing.
 */
export const boardPresent = define({
  type: "board.present",
  schema: DAILY_COMMANDS["board.present"],
  class: "system",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const board = await loadBoard(ctx.db, ctx.userId, { date: p.localDate, scope: p.scope });
    if (!board) throw new CommandError("not_found", `no board is prepared for ${p.localDate}`);
    if (await pauseCovering(ctx.db, ctx.userId, p.localDate)) throw new CommandError("precondition_failed", "recommendations are paused; no reminder is sent");
    if (board.status === "suppressed") throw new CommandError("precondition_failed", "this day's board was removed; no reminder is sent");
    const options = await first<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM board_options WHERE user_id = ? AND board_id = ? AND revision = ? AND state = 'offered'", ctx.userId, board.board_id, board.current_revision);
    return {
      summary: `The board for ${p.localDate} is ready (revision ${board.current_revision}, ${options?.n ?? 0} outfits)`,
      affected: [{ kind: "board", id: board.board_id, version: board.current_revision }],
      effects: board.status === "active" && (options?.n ?? 0) > 0 ? [{ kind: MORNING_REMINDER_EFFECT_KIND, targetKey: `morning:${p.scope}:${p.localDate}`, operationKey: `${MORNING_REMINDER_EFFECT_KIND}:${ctx.userId}:${p.scope}:${p.localDate}`, desiredRevision: board.current_revision, payload: { boardId: board.board_id, revision: board.current_revision, localDate: p.localDate, scope: p.scope } }] : [],
      outbox: [{ topic: "board.presented", entityKind: "board", entityId: board.board_id, revision: board.current_revision }],
      preconditions: [{ label: "recommendations are not paused for this day", sql: "NOT EXISTS (SELECT 1 FROM service_pauses WHERE user_id = ? AND status = 'active' AND starts_on <= ? AND (resume_on IS NULL OR resume_on > ?))", params: [ctx.userId, p.localDate, p.localDate], class: "state" }],
      result: { boardId: board.board_id, revision: board.current_revision },
      undo: { unavailableReason: "a presentation marker is not undone" },
    };
  },
});

export function registerPauseCommands(registry: CommandRegistry): void {
  registry.register(servicePause);
  registry.register(serviceResume);
  registry.register(boardPresent);
}

/**
 * Resume: end the pause, apply the elapsed weekly cleanliness resets (explicit exceptions are kept by
 * the ledger), fetch weather and calendar, and prepare the NEXT useful board - today's before midday,
 * otherwise tomorrow's. Nothing that was missed is replayed.
 */
export async function resumeService(deps: DailyDeps, principal: Principal, opts: { nowMs?: number; clientRequestId: string }): Promise<{ resumed: boolean; board: BoardDocument | null; localDate: string; note: string | null }> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const nowMs = nowOf(deps, opts.nowMs);
  const authorization = principal.actor === "system" ? "system_schedule" : principal.actor === "assistant" ? "owner_statement" : "owner_tap";
  const receipt = await deps.commands.execute(principal, { type: "service.resume", payload: {}, idempotencyKey: `resume:${opts.clientRequestId}`, expectedVersions: {}, authorization, source: { channel: principal.channel } });
  const owner = await loadOwner(deps.db, principal.userId);
  const tz = owner.settings.timezone;
  const today = localDateOf(nowMs, tz);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(nowMs)));
  const localDate = hour < 12 ? today : localDateOf(nowMs + 24 * 3600_000, tz);
  if (receipt.outcome === "noop") {
    const board = await loadBoard(deps.db, principal.userId, { date: localDate });
    return { resumed: false, board: board ? await buildBoardDocument(deps.db, principal.userId, board) : null, localDate, note: "Recommendations were not paused." };
  }
  // Weekly cleanliness baselines that elapsed during the pause, each applied once (standing owner policy).
  await deps.commands.execute(principal, { type: "laundry.apply_weekly_reset", payload: {}, idempotencyKey: `resume-weekly-reset:${opts.clientRequestId}`, expectedVersions: {}, authorization: "standing_policy", source: { channel: principal.channel } });
  void dailySettings;
  const existing = await loadBoard(deps.db, principal.userId, { date: localDate });
  if (existing?.status === "worn" || existing?.status === "suppressed") {
    return { resumed: true, board: await buildBoardDocument(deps.db, principal.userId, existing), localDate, note: null };
  }
  const result = await prepareBoard(deps, principal, { localDate, reason: existing ? "resume" : "compose", purpose: "resume", idempotencyKey: `resume-board:${opts.clientRequestId}`, nowMs });
  return { resumed: true, board: result.board, localDate, note: result.note };
}
