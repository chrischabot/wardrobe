import type { CommandReceipt } from '@garderobe/contracts';
import type { Env } from '../env.js';
import type { Principal } from '../domain/principal.js';
import { localDateOf } from '../domain/time.js';
import { dailyService, now, ownerTimezone } from './services.js';

/**
 * External effects of the service-pause commands, applied right after their commit through the daily
 * service (the same operations DailyService.pause / resume perform):
 * - pause_service, and Undo of resume_service: remove (suppress) the outfit events of the paused days;
 * - resume_service, and Undo of pause_service: end the pause and prepare only the next useful board.
 * Scheduled phases skip paused days on their own, so a failure here leaves at most a stale event
 * that the next resume or sweep corrects.
 */
export async function applyServiceEffects(env: Env, principal: Principal, receipt: CommandReceipt): Promise<Record<string, unknown> | null> {
  if ((receipt.outcome !== 'committed' && receipt.outcome !== 'merged') || receipt.replayed) return null;
  const compensated = receipt.facts.compensatedType as string | undefined;
  const pauses = receipt.commandType === 'pause_service' || (receipt.commandType === 'undo' && compensated === 'resume_service');
  const resumes = receipt.commandType === 'resume_service' || (receipt.commandType === 'undo' && compensated === 'pause_service');
  if (!pauses && !resumes) return null;
  const daily = await dailyService(env, principal.userId);
  if (resumes) {
    const r = await daily.resume();
    return { resumed: true, boardDate: r.boardDate, published: r.outcome.published };
  }
  const today = localDateOf(now(), await ownerTimezone(env, principal));
  const { results: open } = await env.DB.prepare('SELECT starts_on, resume_on FROM service_pauses WHERE user_id = ? AND ended_at IS NULL').bind(principal.userId).all<{ starts_on: string; resume_on: string | null }>();
  const suppressed: string[] = [];
  for (const p of open) {
    const { results } = await env.DB.prepare(`SELECT board_date FROM calendar_projections WHERE user_id = ? AND board_date >= ? AND board_date >= ? ${p.resume_on ? 'AND board_date < ?' : ''}`)
      .bind(principal.userId, p.starts_on, today, ...(p.resume_on ? [p.resume_on] : []))
      .all<{ board_date: string }>();
    for (const r of results) {
      await daily.projector.suppress(r.board_date, 'paused');
      suppressed.push(r.board_date);
    }
  }
  return { paused: true, suppressedDates: suppressed };
}
