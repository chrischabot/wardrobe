import type { CommandOf } from '@garderobe/contracts';
import { rawPredicate } from './db.js';
import { DomainError } from './errors.js';
import { localDateOf } from './time.js';
import type { CommandPlan, HandlerContext, UndoPlan } from './commands/types.js';

/**
 * pause_service / resume_service (spec section 9 "Pause and resume") as typed commands with receipts
 * and compensating Undo. The D1 state (service_pauses) commits in the command batch. The Calendar
 * side (removing outfit events for paused days; preparing the next useful board on resume) is applied
 * by the API right after the commit through the daily service (`api/service-effects.ts`), and the
 * scheduled phases already skip paused days.
 */

const PAUSE_SCOPES = JSON.stringify(['recommendations', 'board_publication', 'wardrobe_reminders']);

async function ownerTimezone(db: D1Database, userId: string): Promise<string> {
  return (await db.prepare('SELECT timezone FROM owner_settings WHERE user_id = ?').bind(userId).first<{ timezone: string }>())?.timezone ?? 'Europe/London';
}

export async function pauseService(ctx: HandlerContext<CommandOf<'pause_service'>>): Promise<CommandPlan> {
  const userId = ctx.principal.userId;
  const c = ctx.command;
  const today = localDateOf(ctx.now, await ownerTimezone(ctx.db, userId));
  const startsOn = c.startsOn ?? today;
  if (startsOn < today) throw new DomainError('validation_failed', 'A pause cannot start in the past');
  if (c.resumeOn && c.resumeOn <= startsOn) throw new DomainError('validation_failed', 'The resume date must come after the start of the pause');
  const pauseId = `pau_${crypto.randomUUID().replace(/-/g, '')}`;
  const until = c.resumeOn ? `until ${c.resumeOn}` : 'until you resume';
  return {
    occurredAt: ctx.now,
    guards: [rawPredicate('SELECT COUNT(*) = 0 FROM service_pauses WHERE user_id = ? AND ended_at IS NULL', [userId], 'no open pause')],
    statements: [
      ctx.db
        .prepare('INSERT INTO service_pauses (user_id, pause_id, scopes_json, starts_on, resume_on, ended_at, command_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
        .bind(userId, pauseId, PAUSE_SCOPES, startsOn, c.resumeOn ?? null, ctx.commandId, ctx.now),
    ],
    affected: [{ entityType: 'service_pause', entityId: pauseId, version: 1, change: 'created' }],
    summary: `Garderobe is paused from ${startsOn} ${until}: no outfit boards or outfit events for those days. Wears and laundry still record as usual.`,
    facts: { pauseId, startsOn, resumeOn: c.resumeOn ?? null, reason: c.reason ?? null },
    undo: { kind: 'end_pause', pauseId } satisfies UndoPlan,
    effects: [],
  };
}

export async function resumeService(ctx: HandlerContext<CommandOf<'resume_service'>>): Promise<CommandPlan> {
  const userId = ctx.principal.userId;
  const { results } = await ctx.db.prepare('SELECT pause_id FROM service_pauses WHERE user_id = ? AND ended_at IS NULL').bind(userId).all<{ pause_id: string }>();
  if (!results.length) throw new DomainError('invalid_state', 'Garderobe is not paused');
  const pauseIds = results.map((r) => r.pause_id);
  return {
    occurredAt: ctx.now,
    guards: [rawPredicate('SELECT COUNT(*) > 0 FROM service_pauses WHERE user_id = ? AND ended_at IS NULL', [userId], 'an open pause')],
    statements: [ctx.db.prepare('UPDATE service_pauses SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL').bind(ctx.now, userId)],
    affected: pauseIds.map((id) => ({ entityType: 'service_pause' as const, entityId: id, version: 1, change: 'updated' as const })),
    summary: 'Garderobe is running again: the next board is prepared from today’s wardrobe and weather. Missed days are not caught up.',
    facts: { pauseIds },
    undo: { kind: 'reinstate_pauses', pauseIds } satisfies UndoPlan,
    effects: [],
  };
}

/** Compensation plans for the two commands (called from commands/undo.ts). */
export function compensatePause(ctx: HandlerContext, undo: Extract<UndoPlan, { kind: 'end_pause' | 'reinstate_pauses' }>): CommandPlan {
  const userId = ctx.principal.userId;
  const base: CommandPlan = { occurredAt: ctx.now, guards: [], statements: [], affected: [], summary: '', facts: {}, undo: null, effects: [] };
  if (undo.kind === 'end_pause') {
    base.guards.push(rawPredicate('SELECT ended_at IS NULL FROM service_pauses WHERE user_id = ? AND pause_id = ?', [userId, undo.pauseId], 'pause still open'));
    base.statements.push(ctx.db.prepare('UPDATE service_pauses SET ended_at = ? WHERE user_id = ? AND pause_id = ? AND ended_at IS NULL').bind(ctx.now, userId, undo.pauseId));
    base.affected.push({ entityType: 'service_pause', entityId: undo.pauseId, version: 1, change: 'updated' });
    base.summary = 'The pause is withdrawn; Garderobe is running again.';
    base.facts = { resumed: true, pauseIds: [undo.pauseId] };
    return base;
  }
  base.guards.push(rawPredicate('SELECT COUNT(*) = 0 FROM service_pauses WHERE user_id = ? AND ended_at IS NULL', [userId], 'no other open pause'));
  for (const id of undo.pauseIds) {
    base.statements.push(ctx.db.prepare('UPDATE service_pauses SET ended_at = NULL WHERE user_id = ? AND pause_id = ?').bind(userId, id));
    base.affected.push({ entityType: 'service_pause', entityId: id, version: 1, change: 'updated' });
  }
  base.summary = 'Paused again, as before.';
  base.facts = { paused: true, pauseIds: undo.pauseIds };
  return base;
}
