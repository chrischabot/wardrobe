import { json, parseJson } from '../domain/db.js';
import { DomainError } from '../domain/errors.js';
import { ensureLaundryResets, loadSettings } from '../domain/laundry.js';
import { assertPrincipal, requireScope, SCOPE_WRITE } from '../domain/principal.js';
import { addDays, localDateOf, localParts, zonedInstant } from '../domain/time.js';
import { CalendarProjector, type CalendarPresentation, type ProjectionResult } from '../calendar/projection.js';
import type { ManagedEventStore } from '../calendar/types.js';
import type { ComposeRequest } from '../recommend/context.js';
import { getDailyBoard } from '../recommend/publish.js';
import { RecommendationService, type PublishOutcome, type RecommendationDeps, type RevisionOutcome } from '../recommend/service.js';
import { loadTripCovering } from '../trips/store.js';

/**
 * The evening-to-morning service (spec section 9). Default local schedule (Europe/London unless the
 * owner or a trip says otherwise), evaluated from UTC by `sweep` so DST needs no special case:
 *
 * | Local time      | Phase            | Result                                                         |
 * | 21:00 day before| `evening`        | weekly laundry resets; compose, validate, publish tomorrow      |
 * | 06:40           | `morning_refresh`| refresh forecast (and calendar); repair affected options        |
 * | 06:50 (deadline)| `final`          | process pending changes, publish final revision, verify Calendar|
 * | 07:00           | delivery         | the prepared board is read; no inference is needed              |
 *
 * Each (owner, local date, phase) runs once: a `runs` row keyed by date and phase deduplicates
 * repeated triggers and Workflow step retries; a failed or stale run can be taken over. Missed
 * phases are caught up only while still useful; past days are never composed (no backlog). Pause is
 * checked before every publication, inside the publication batch itself.
 */

export type DailyPhase = 'evening' | 'morning_refresh' | 'final';

export interface DailySchedule {
  evening: string;
  morningRefresh: string;
  final: string;
  /** Missed morning phases are caught up only until this local time (a board for a day nearly over is no use). */
  catchUpUntil: string;
}

export const DEFAULT_SCHEDULE: DailySchedule = { evening: '21:00', morningRefresh: '06:40', final: '06:50', catchUpUntil: '12:00' };

export interface DailyServiceDeps extends RecommendationDeps {
  calendarStore?: ManagedEventStore | null;
  calendarId?: string;
  presentation?: CalendarPresentation;
  boardBaseUrl?: string;
  schedule?: Partial<DailySchedule>;
}

export interface PhaseResult {
  phase: DailyPhase;
  boardDate: string;
  status: 'complete' | 'duplicate' | 'in_progress' | 'paused' | 'failed' | 'too_late';
  runId: string;
  purpose: string | null;
  publish: Pick<PublishOutcome, 'published' | 'reason' | 'attempts' | 'shortfall'> | null;
  repair: Pick<RevisionOutcome, 'status' | 'summary' | 'changed'> | null;
  resetsApplied: { pool: string; cycleKey: string }[];
  projection: ProjectionResult | null;
  deadlineAt: string | null;
  deadlineMet: boolean | null;
  error: string | null;
}

export interface EffectProcessingResult {
  processed: number;
  repaired: RevisionOutcome[];
  projections: ProjectionResult[];
}

export class DailyService {
  readonly recommendations: RecommendationService;
  readonly projector: CalendarProjector;
  private readonly schedule: DailySchedule;
  private readonly clock: () => string;

  constructor(private readonly deps: DailyServiceDeps) {
    assertPrincipal(deps.principal);
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.recommendations = new RecommendationService(deps);
    this.projector = new CalendarProjector({ db: deps.db, principal: deps.principal, store: deps.calendarStore ?? null, calendarId: deps.calendarId ?? 'garderobe-outfits', clock: this.clock, presentation: deps.presentation, boardBaseUrl: deps.boardBaseUrl });
    this.schedule = { ...DEFAULT_SCHEDULE, ...deps.schedule };
  }

  private get db(): D1Database {
    return this.deps.db;
  }
  private get userId(): string {
    return this.deps.principal.userId;
  }

  async timezone(): Promise<string> {
    return (await loadSettings(this.db, this.deps.principal))?.timezone ?? 'Europe/London';
  }

  /** Purpose of the day's board: a packed trip covering the date replaces the home board. */
  async purposeFor(boardDate: string): Promise<string> {
    const trip = await loadTripCovering(this.db, this.userId, boardDate);
    return trip ? `trip:${trip.tripId}` : 'day';
  }

  // ---------------------------------------------------------------- pause and resume

  async activePause(date: string): Promise<{ pauseId: string; startsOn: string; resumeOn: string | null } | null> {
    const r = await this.db
      .prepare('SELECT pause_id, starts_on, resume_on FROM service_pauses WHERE user_id = ? AND ended_at IS NULL AND starts_on <= ? AND (resume_on IS NULL OR resume_on > ?) ORDER BY created_at DESC LIMIT 1')
      .bind(this.userId, date, date)
      .first<{ pause_id: string; starts_on: string; resume_on: string | null }>();
    return r ? { pauseId: r.pause_id, startsOn: r.starts_on, resumeOn: r.resume_on } : null;
  }

  /**
   * Pause recommendations: stops composition, publication and reminders for the interval (resumeOn is
   * the first day back; null = until resumed). Observations, conversation and existing data are
   * untouched. Managed events inside the interval are suppressed so their reminders stop.
   */
  async pause(input: { startsOn?: string; resumeOn?: string | null } = {}): Promise<{ pauseId: string; startsOn: string; resumeOn: string | null; suppressedDates: string[] }> {
    requireScope(this.deps.principal, SCOPE_WRITE);
    if (input.resumeOn && input.startsOn && input.resumeOn <= input.startsOn) throw new DomainError('validation_failed', 'The resume date must come after the start of the pause');
    const tz = await this.timezone();
    const today = localDateOf(this.clock(), tz);
    const startsOn = input.startsOn ?? today;
    const pauseId = `pau_${crypto.randomUUID().replace(/-/g, '')}`;
    await this.db
      .prepare('INSERT INTO service_pauses (user_id, pause_id, scopes_json, starts_on, resume_on, ended_at, command_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)')
      .bind(this.userId, pauseId, json(['recommendations', 'board_publication', 'wardrobe_reminders']), startsOn, input.resumeOn ?? null, this.clock())
      .run();
    const { results } = await this.db
      .prepare(`SELECT board_date FROM calendar_projections WHERE user_id = ? AND board_date >= ? AND board_date >= ? ${input.resumeOn ? 'AND board_date < ?' : ''}`)
      .bind(this.userId, startsOn, today, ...(input.resumeOn ? [input.resumeOn] : []))
      .all<{ board_date: string }>();
    for (const r of results) await this.projector.suppress(r.board_date, 'paused');
    return { pauseId, startsOn, resumeOn: input.resumeOn ?? null, suppressedDates: results.map((r) => r.board_date) };
  }

  /**
   * Resume: end the pause, apply elapsed weekly resets, fetch weather and calendar and prepare only the
   * next useful board. Missed notifications are not replayed, missing wears are not requested and no
   * backlog of old boards is published.
   */
  async resume(): Promise<{ ended: number; boardDate: string; outcome: PublishOutcome; projection: ProjectionResult | null; resetsApplied: number }> {
    requireScope(this.deps.principal, SCOPE_WRITE);
    const now = this.clock();
    const tz = await this.timezone();
    const ended = await this.db.prepare('UPDATE service_pauses SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL').bind(now, this.userId).run();
    const resets = await ensureLaundryResets(this.db, this.deps.principal, now);
    const today = localDateOf(now, tz);
    const beforeFinal = Date.parse(now) < Date.parse(zonedInstant(today, this.schedule.final, tz));
    const boardDate = beforeFinal ? today : addDays(today, 1);
    // Days suppressed by the pause stay suppressed; only the next useful day is restored and prepared.
    await this.projector.restore(boardDate);
    const purpose = await this.purposeFor(boardDate);
    const outcome = await this.recommendations.composeAndPublish({ date: boardDate, purpose, forceWeatherRefresh: true });
    const projection = outcome.published ? await this.projector.projectDay(boardDate) : null;
    return { ended: ended.meta.changes ?? 0, boardDate, outcome, projection, resetsApplied: resets.length };
  }

  // ---------------------------------------------------------------- phases

  private runKey(boardDate: string, phase: DailyPhase): string {
    return `daily:${boardDate}:${phase}`;
  }

  /** Claims the (date, phase) run; returns null when it already completed or is running elsewhere. */
  private async claim(boardDate: string, phase: DailyPhase, deadlineAt: string | null): Promise<{ runId: string; claimed: boolean; existing: string | null }> {
    const runId = this.runKey(boardDate, phase);
    const now = this.clock();
    const ins = await this.db
      .prepare("INSERT OR IGNORE INTO runs (user_id, run_id, kind, status, parent_ref, input_json, deadline_at, created_at, updated_at, version) VALUES (?, ?, 'daily_phase', 'running', ?, ?, ?, ?, ?, 1)")
      .bind(this.userId, runId, `board_date:${boardDate}`, json({ phase, boardDate }), deadlineAt, now, now)
      .run();
    if (ins.meta.changes) return { runId, claimed: true, existing: null };
    const r = await this.db.prepare('SELECT status, updated_at, version FROM runs WHERE user_id = ? AND run_id = ?').bind(this.userId, runId).first<{ status: string; updated_at: string; version: number }>();
    if (!r) return { runId, claimed: false, existing: 'missing' };
    if (r.status === 'complete' || r.status === 'paused') return { runId, claimed: false, existing: 'complete' };
    const stale = Date.parse(now) - Date.parse(r.updated_at) > 10 * 60_000;
    if (r.status === 'running' && !stale) return { runId, claimed: false, existing: 'running' };
    const take = await this.db
      .prepare("UPDATE runs SET status = 'running', updated_at = ?, version = version + 1 WHERE user_id = ? AND run_id = ? AND version = ?")
      .bind(now, this.userId, runId, r.version)
      .run();
    return { runId, claimed: Boolean(take.meta.changes), existing: take.meta.changes ? null : 'running' };
  }

  private async finish(runId: string, status: 'complete' | 'failed' | 'paused', result: Record<string, unknown>): Promise<void> {
    await this.db.prepare('UPDATE runs SET status = ?, result_json = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND run_id = ?').bind(status, json(result), this.clock(), this.userId, runId).run();
  }

  async runPhase(phase: DailyPhase, boardDate: string, request: Partial<ComposeRequest> = {}): Promise<PhaseResult> {
    const tz = await this.timezone();
    const now = this.clock();
    const today = localDateOf(now, tz);
    const deadlineAt = zonedInstant(boardDate, this.schedule.final, tz);
    const base: PhaseResult = { phase, boardDate, status: 'complete', runId: this.runKey(boardDate, phase), purpose: null, publish: null, repair: null, resetsApplied: [], projection: null, deadlineAt, deadlineMet: null, error: null };
    if (boardDate < today) return { ...base, status: 'too_late', error: 'Past days are never composed (no backlog)' };
    const claim = await this.claim(boardDate, phase, deadlineAt);
    if (!claim.claimed) return { ...base, status: claim.existing === 'complete' ? 'duplicate' : 'in_progress' };
    try {
      const pause = await this.activePause(boardDate);
      if (pause) {
        await this.projector.suppress(boardDate, 'paused');
        await this.finish(claim.runId, 'paused', { pauseId: pause.pauseId });
        return { ...base, status: 'paused' };
      }
      const resets = await ensureLaundryResets(this.db, this.deps.principal, now);
      const purpose = request.purpose ?? (await this.purposeFor(boardDate));
      const existing = await getDailyBoard(this.db, this.deps.principal, boardDate, purpose);
      let publish: PhaseResult['publish'] = null;
      let repair: PhaseResult['repair'] = null;
      if (phase === 'evening' || !existing || existing.status !== 'published') {
        const outcome = await this.recommendations.composeAndPublish({ ...request, date: boardDate, purpose, forceWeatherRefresh: phase !== 'evening' });
        publish = { published: outcome.published, reason: outcome.reason, attempts: outcome.attempts, shortfall: outcome.shortfall };
      } else {
        await this.processEffects();
        const reason = phase === 'morning_refresh' ? 'morning_refresh' : 'final_validation';
        // A board composed without a forecast (provider outage in the evening) is brought onto the real
        // forecast once the provider answers: recomposed if nothing is chosen or worn yet, otherwise
        // republished around the selection, with every option revalidated against the forecast.
        const recovery = await this.recommendations.weatherRecovery(boardDate, purpose);
        if (recovery.recovered && !recovery.selected && !recovery.worn) {
          // weatherRecovery has just fetched the forecast; composition reuses that cached snapshot.
          const outcome = await this.recommendations.composeAndPublish({ ...(recovery.request ?? {}), ...request, date: boardDate, purpose, forceWeatherRefresh: false });
          publish = { published: outcome.published, reason: outcome.reason, attempts: outcome.attempts, shortfall: outcome.shortfall };
        } else {
          const r = await this.recommendations.repairBoard(boardDate, purpose, reason, {
            // After a recovery the snapshot weatherRecovery fetched is reused, so the revision matches that decision.
            forceWeatherRefresh: !recovery.recovered,
            ...(recovery.recovered ? { republishReason: 'The forecast is back: every option was checked against it.', weatherOnlyWhenWorn: recovery.worn } : {}),
          });
          repair = { status: r.status, summary: r.summary, changed: r.changed };
        }
      }
      const projection = (await this.projector.row(boardDate)) ? await this.projector.projectDay(boardDate) : null;
      const deadlineMet = phase === 'final' ? Date.parse(this.clock()) <= Date.parse(deadlineAt) : null;
      const result: PhaseResult = { ...base, purpose, publish, repair, resetsApplied: resets.map((r) => ({ pool: r.pool, cycleKey: r.cycleKey })), projection, deadlineMet };
      await this.finish(claim.runId, 'complete', { purpose, publish, repair, resets: result.resetsApplied, projection, deadlineMet });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finish(claim.runId, 'failed', { error: message });
      return { ...base, status: 'failed', error: message };
    }
  }

  /**
   * Scheduled sweep: evaluates the owner's local schedule from UTC and runs every due phase once.
   * A missed evening is caught up by the morning phases; days already past are skipped.
   */
  async sweep(): Promise<PhaseResult[]> {
    const tz = await this.timezone();
    const now = this.clock();
    const local = localParts(now, tz);
    const hhmm = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
    const today = local.date;
    const out: PhaseResult[] = [];
    await this.processEffects();
    if (hhmm >= this.schedule.catchUpUntil) {
      // Too late for today's morning phases; nothing to catch up.
    } else if (hhmm >= this.schedule.final) out.push(await this.runPhase('final', today));
    else if (hhmm >= this.schedule.morningRefresh) out.push(await this.runPhase('morning_refresh', today));
    if (hhmm >= this.schedule.evening) out.push(await this.runPhase('evening', addDays(today, 1)));
    await this.projector.projectPending(today);
    return out.filter((r) => r.status !== 'duplicate');
  }

  /**
   * Applies the outbox: availability-changing commands revalidate every open board (today not yet
   * worn, and future days), selections re-project the managed event. Idempotent: effects are marked
   * applied, and repair of an already valid board is a no-op.
   */
  async processEffects(): Promise<EffectProcessingResult> {
    const tz = await this.timezone();
    const today = localDateOf(this.clock(), tz);
    const { results } = await this.db
      .prepare("SELECT effect_id, kind, payload_json FROM command_effects WHERE user_id = ? AND status = 'pending' AND kind IN ('board_revalidation', 'calendar_projection') ORDER BY created_at")
      .bind(this.userId)
      .all<{ effect_id: string; kind: string; payload_json: string }>();
    const repaired: RevisionOutcome[] = [];
    const projections: ProjectionResult[] = [];
    const revalidations = results.filter((r) => r.kind === 'board_revalidation');
    if (revalidations.length) {
      const { results: boards } = await this.db
        .prepare("SELECT board_date, purpose FROM boards WHERE user_id = ? AND board_date >= ? AND status = 'published' ORDER BY board_date")
        .bind(this.userId, today)
        .all<{ board_date: string; purpose: string }>();
      for (const b of boards) {
        const r = await this.recommendations.repairBoard(b.board_date, b.purpose, 'reality_changed');
        repaired.push(r);
        if (r.changed && (await this.projector.row(b.board_date))) projections.push(await this.projector.projectDay(b.board_date));
      }
      for (const e of revalidations) await this.markEffect(e.effect_id, 'projected', null);
    }
    for (const e of results.filter((r) => r.kind === 'calendar_projection')) {
      const payload = parseJson<{ boardDate?: string }>(e.payload_json, {});
      if (!payload.boardDate) {
        await this.markEffect(e.effect_id, 'failed', 'No board date in payload');
        continue;
      }
      await this.projector.requestReprojection(payload.boardDate);
      const p = await this.projector.projectDay(payload.boardDate);
      projections.push(p);
      await this.markEffect(e.effect_id, p.status === 'projected' || p.status === 'up_to_date' ? 'projected' : p.status === 'suppressed' ? 'superseded' : 'failed', p.error);
    }
    return { processed: results.length, repaired, projections };
  }

  private async markEffect(effectId: string, status: 'projected' | 'failed' | 'superseded', error: string | null): Promise<void> {
    await this.db
      .prepare('UPDATE command_effects SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE user_id = ? AND effect_id = ?')
      .bind(status, error, this.clock(), this.userId, effectId)
      .run();
  }
}
