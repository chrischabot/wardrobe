import type { AffectedEntity, CommandOf, WearItem } from '@garderobe/contracts';
import { versionIs, rawPredicate, type Predicate } from './db.js';
import { DomainError } from './errors.js';
import { dailyWearId, newId } from './ids.js';
import { requireGarments, type GarmentRow } from './records.js';
import { StockPlanner } from './stock/ledger.js';
import { addDays, isValidTimeZone, localDateOf, zonedInstant } from './time.js';
import { revalidationEffect, type CommandPlan, type HandlerContext } from './commands/types.js';

/**
 * Wear accounting (spec section 5, "One counted wear per garment and wearing date").
 *
 * - Observations are immutable records of what the owner reported; corrections supersede them.
 * - The counted wear is the row (user_id, garment_id, wearing_date) in daily_wears, derived from the
 *   active observations of that date. Duplicate reports from any client merge into it.
 * - Stock consumption follows the counted wear, not the report: one `wear` movement per garment and
 *   date (unique index), plus explicit fresh-unit movements for anonymous quantities.
 * - Trousers (single_wear_day) move to `worn`; per-wear garments to the hamper; multi-wear and
 *   never-laundered garments never move.
 */

interface ObsItem {
  garmentId: string;
  role: string | null;
  fresh: boolean;
}

export interface ObservationState {
  observationId: string;
  wearingDate: string;
  timezone: string;
  occurredAt: string;
  source: string;
  sourceRef: string | null;
  segment: string | null;
  optionId: string | null;
  status: 'active' | 'superseded' | 'retracted';
  revision: number;
  supersedesObservationId: string | null;
  version: number;
  items: ObsItem[];
}

export async function loadObservation(db: D1Database, userId: string, observationId: string): Promise<ObservationState | null> {
  const row = await db
    .prepare('SELECT * FROM wear_observations WHERE user_id = ? AND observation_id = ?')
    .bind(userId, observationId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const { results } = await db
    .prepare('SELECT garment_id, role, fresh_unit FROM observation_items WHERE user_id = ? AND observation_id = ?')
    .bind(userId, observationId)
    .all<{ garment_id: string; role: string | null; fresh_unit: number }>();
  return toState(row, results);
}

function toState(row: Record<string, unknown>, items: { garment_id: string; role: string | null; fresh_unit: number }[]): ObservationState {
  return {
    observationId: row.observation_id as string,
    wearingDate: row.wearing_date as string,
    timezone: row.timezone as string,
    occurredAt: row.occurred_at as string,
    source: row.source as string,
    sourceRef: (row.source_ref as string | null) ?? null,
    segment: (row.segment as string | null) ?? null,
    optionId: (row.option_id as string | null) ?? null,
    status: row.status as ObservationState['status'],
    revision: row.revision as number,
    supersedesObservationId: (row.supersedes_observation_id as string | null) ?? null,
    version: row.version as number,
    items: items.map((i) => ({ garmentId: i.garment_id, role: i.role, fresh: i.fresh_unit === 1 })),
  };
}

async function loadDayObservations(db: D1Database, userId: string, date: string): Promise<ObservationState[]> {
  const { results: rows } = await db
    .prepare('SELECT * FROM wear_observations WHERE user_id = ? AND wearing_date = ?')
    .bind(userId, date)
    .all<Record<string, unknown>>();
  if (!rows.length) return [];
  const { results: items } = await db
    .prepare(
      `SELECT i.observation_id, i.garment_id, i.role, i.fresh_unit FROM observation_items i
       JOIN wear_observations o ON o.user_id = i.user_id AND o.observation_id = i.observation_id
       WHERE i.user_id = ? AND o.wearing_date = ?`,
    )
    .bind(userId, date)
    .all<{ observation_id: string; garment_id: string; role: string | null; fresh_unit: number }>();
  return rows.map((r) => toState(r, items.filter((i) => i.observation_id === r.observation_id)));
}

export interface CountedGarment {
  garmentId: string;
  name: string;
  countedBefore: boolean;
  countedAfter: boolean;
  observationCount: number;
}

export interface WearChange {
  date: string;
  add?: ObservationState;
  deactivate?: { observation: ObservationState; status: 'superseded' | 'retracted' }[];
  reactivate?: ObservationState[];
}

export interface WearChangePlan {
  statements: D1PreparedStatement[];
  guards: Predicate[];
  affected: AffectedEntity[];
  counted: CountedGarment[];
  stockNotes: { garmentId: string; detail: string; kind: string }[];
  garments: Map<string, GarmentRow>;
}

const CONSUMING = new Set(['per_wear', 'single_wear_day']);

/** Plans the full consequence of adding, deactivating or reactivating observations of one date. */
export async function planWearChange(ctx: HandlerContext, change: WearChange): Promise<WearChangePlan> {
  const { db, principal, now, commandId } = ctx;
  const userId = principal.userId;
  const touchedObs = [...(change.add ? [change.add] : []), ...(change.deactivate ?? []).map((d) => d.observation), ...(change.reactivate ?? [])];
  const garmentIds = [...new Set(touchedObs.flatMap((o) => o.items.map((i) => i.garmentId)))];

  // Read order matters on deployed D1 (ADV-08 follow-up). Each query is a separate round trip with
  // no shared snapshot, so other commands can commit between reads. The counted-wear rows are read
  // FIRST: they are what the commit guard pins, and every later read (observations, stock) is then
  // at least as fresh. Whether a garment was already counted is taken only from this pinned row,
  // never from the observations read, so a receipt's committed/merged outcome always matches what
  // actually commits.
  const existing = new Map<string, { revision: number; status: string }>();
  if (garmentIds.length) {
    const { results } = await db
      .prepare(`SELECT garment_id, revision, status FROM daily_wears WHERE user_id = ? AND wearing_date = ? AND garment_id IN (${garmentIds.map(() => '?').join(',')})`)
      .bind(userId, change.date, ...garmentIds)
      .all<{ garment_id: string; revision: number; status: string }>();
    for (const r of results) existing.set(r.garment_id, { revision: r.revision, status: r.status });
  }

  const day = await loadDayObservations(db, userId, change.date);
  const deactivated = new Set((change.deactivate ?? []).map((d) => d.observation.observationId));
  const reactivated = new Set((change.reactivate ?? []).map((o) => o.observationId));
  const activeAfter = day.filter((o) => (o.status === 'active' && !deactivated.has(o.observationId)) || reactivated.has(o.observationId));
  if (change.add) activeAfter.push(change.add);

  const garments = await requireGarments(db, userId, garmentIds);

  const planner = new StockPlanner(db, userId, commandId, now);
  await planner.load(garmentIds);

  const statements: D1PreparedStatement[] = [];
  const guards: Predicate[] = [];
  const affected: AffectedEntity[] = [];

  // Observation rows first (the daily upserts below are derived from the new state).
  if (change.add) {
    const o = change.add;
    statements.push(
      db
        .prepare(
          `INSERT INTO wear_observations (user_id, observation_id, wearing_date, timezone, occurred_at, reported_at, source, source_ref, segment, option_id, status, revision, supersedes_observation_id, command_id, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1)`,
        )
        .bind(userId, o.observationId, o.wearingDate, o.timezone, o.occurredAt, now, o.source, o.sourceRef, o.segment, o.optionId, o.revision, o.supersedesObservationId, commandId),
    );
    for (const item of o.items) {
      statements.push(
        db
          .prepare('INSERT INTO observation_items (user_id, observation_id, garment_id, role, fresh_unit) VALUES (?, ?, ?, ?, ?)')
          .bind(userId, o.observationId, item.garmentId, item.role, item.fresh ? 1 : 0),
      );
    }
    affected.push({ entityType: 'wear_observation', entityId: o.observationId, version: 1, change: 'created' });
  }
  for (const d of change.deactivate ?? []) {
    guards.push(versionIs(userId, 'wear_observation', d.observation.observationId, d.observation.version));
    statements.push(
      db
        .prepare('UPDATE wear_observations SET status = ?, version = version + 1 WHERE user_id = ? AND observation_id = ?')
        .bind(d.status, userId, d.observation.observationId),
    );
    affected.push({ entityType: 'wear_observation', entityId: d.observation.observationId, version: d.observation.version + 1, change: d.status === 'retracted' ? 'retracted' : 'updated' });
  }
  for (const o of change.reactivate ?? []) {
    guards.push(versionIs(userId, 'wear_observation', o.observationId, o.version));
    statements.push(db.prepare("UPDATE wear_observations SET status = 'active', version = version + 1 WHERE user_id = ? AND observation_id = ?").bind(userId, o.observationId));
    affected.push({ entityType: 'wear_observation', entityId: o.observationId, version: o.version + 1, change: 'updated' });
  }

  const counted: CountedGarment[] = [];
  for (const gid of garmentIds) {
    const g = garments.get(gid)!;
    const covering = activeAfter.filter((o) => o.items.some((i) => i.garmentId === gid));
    const wearKey = dailyWearId(gid, change.date);

    if (CONSUMING.has(g.laundry_policy)) {
      const existingWear = planner.activeMovements((m) => m.wearKey === wearKey && m.params.kind === 'wear');
      if (covering.length && !existingWear.length) {
        const first = [...covering].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))[0]!;
        planner.add(gid, { kind: 'wear', to: g.laundry_policy === 'per_wear' ? 'hamper' : 'worn' }, first.occurredAt, { observationId: first.observationId, wearKey });
      } else if (!covering.length) {
        for (const m of existingWear) planner.void(m.movementId);
      }
      // Fresh-unit movements follow their observation.
      for (const d of change.deactivate ?? []) {
        for (const m of planner.activeMovements((x) => x.observationId === d.observation.observationId && x.garmentId === gid && x.params.kind === 'wear' && x.params.fresh === true)) {
          planner.void(m.movementId);
        }
      }
      for (const o of [...(change.add ? [change.add] : []), ...(change.reactivate ?? [])]) {
        const item = o.items.find((i) => i.garmentId === gid);
        if (item?.fresh) planner.add(gid, { kind: 'wear', to: 'hamper', fresh: true }, o.occurredAt, { observationId: o.observationId });
      }
    }

    const prior = existing.get(gid);
    // Concurrency (ADV-08): the counted-wear revision changes only when the counted status changes
    // (created, retracted, reinstated). Merging another report into an already counted wear keeps the
    // revision, so concurrent duplicate reports do not conflict with one another; any status
    // transition in between still fails this guard and the command rebases.
    guards.push(
      rawPredicate(
        'COALESCE((SELECT revision FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date = ?), 0) = ?',
        [userId, gid, change.date, prior?.revision ?? 0],
        `counted wear ${wearKey} at revision ${prior?.revision ?? 0}`,
      ),
    );
    if (!covering.length && prior?.status === 'active') {
      // Un-counting (retraction or amendment away from this garment): a report merged in concurrently
      // does not change the revision, so also require that no other active report still covers the
      // garment on that day. Otherwise the stock movement would be voided while the wear stays counted.
      const keep = [...deactivated];
      guards.push(
        rawPredicate(
          `SELECT COUNT(*) = 0 FROM wear_observations o JOIN observation_items i ON i.user_id = o.user_id AND i.observation_id = o.observation_id
           WHERE o.user_id = ? AND i.garment_id = ? AND o.wearing_date = ? AND o.status = 'active'${keep.length ? ` AND o.observation_id NOT IN (${keep.map(() => '?').join(',')})` : ''}`,
          [userId, gid, change.date, ...keep],
          `no other active report of ${wearKey}`,
        ),
      );
    }
    if (covering.length || prior) {
      const statusAfter = covering.length ? 'active' : 'retracted';
      const statusChanges = !prior || prior.status !== statusAfter;
      const first = [...covering].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))[0];
      // Aggregates are derived from the committed observation rows inside the batch, so reports
      // merged concurrently are all reflected whichever commits last.
      statements.push(
        db
          .prepare(
            `WITH a AS (
               SELECT o.occurred_at, o.timezone, o.source, o.segment FROM wear_observations o
               JOIN observation_items i ON i.user_id = o.user_id AND i.observation_id = o.observation_id
               WHERE o.user_id = ? AND i.garment_id = ? AND o.wearing_date = ? AND o.status = 'active'
             )
             INSERT INTO daily_wears (user_id, garment_id, wearing_date, timezone, first_occurred_at, observation_count, sources_json, segments_json, status, revision, updated_at)
             SELECT ?, ?, ?,
               COALESCE((SELECT timezone FROM a ORDER BY occurred_at LIMIT 1), ?),
               COALESCE((SELECT MIN(occurred_at) FROM a), ?),
               (SELECT COUNT(*) FROM a),
               COALESCE((SELECT json_group_array(source) FROM (SELECT DISTINCT source FROM a ORDER BY source)), '[]'),
               COALESCE((SELECT json_group_array(segment) FROM (SELECT segment FROM a WHERE segment IS NOT NULL GROUP BY segment ORDER BY MIN(occurred_at), segment)), '[]'),
               CASE WHEN EXISTS (SELECT 1 FROM a) THEN 'active' ELSE 'retracted' END,
               1, ?
             WHERE 1
             ON CONFLICT (user_id, garment_id, wearing_date) DO UPDATE SET
               timezone = excluded.timezone, first_occurred_at = excluded.first_occurred_at, observation_count = excluded.observation_count,
               sources_json = excluded.sources_json, segments_json = excluded.segments_json,
               revision = CASE WHEN daily_wears.status = excluded.status THEN daily_wears.revision ELSE daily_wears.revision + 1 END,
               status = excluded.status, updated_at = excluded.updated_at`,
          )
          .bind(userId, gid, change.date, userId, gid, change.date, first?.timezone ?? change.add?.timezone ?? 'UTC', first?.occurredAt ?? now, now),
      );
      affected.push({
        entityType: 'daily_wear',
        entityId: wearKey,
        version: prior ? (statusChanges ? prior.revision + 1 : prior.revision) : 1,
        change: !covering.length ? 'retracted' : prior ? 'updated' : 'created',
      });
    }
    counted.push({
      garmentId: gid,
      name: g.name,
      countedBefore: prior?.status === 'active',
      countedAfter: covering.length > 0,
      observationCount: covering.length,
    });
  }

  const stock = planner.finalize();
  return {
    statements: [...statements, ...stock.statements],
    guards: [...guards, ...stock.guards],
    affected: [...affected, ...stock.affected],
    counted,
    stockNotes: stock.notes,
    garments,
  };
}

function validateItems(items: readonly WearItem[], garments?: Map<string, GarmentRow>): void {
  const ids = items.map((i) => i.garmentId);
  if (new Set(ids).size !== ids.length) throw new DomainError('validation_failed', 'A garment appears twice in one observation', { garmentIds: ids });
  if (garments) {
    for (const i of items) {
      const g = garments.get(i.garmentId)!;
      if (i.freshUnit && g.tracking !== 'anonymous_quantity') {
        throw new DomainError('validation_failed', `${g.name} is a single garment; freshUnit applies only to interchangeable units such as socks`, { garmentId: i.garmentId });
      }
    }
  }
}

function ledgerWarnings(garments: Map<string, GarmentRow>): string[] {
  const out: string[] = [];
  for (const g of garments.values()) {
    if (g.acquisition !== 'owned') out.push(`${g.name}: the ledger had this as ${g.acquisition}; the wear is recorded as observed and the item's status is unchanged.`);
    else if (g.location !== 'home') out.push(`${g.name}: the ledger had this at ${g.location}; the wear is recorded as observed.`);
  }
  return out;
}

function summarize(date: string, counted: CountedGarment[]): string {
  const fresh = counted.filter((c) => c.countedAfter && !c.countedBefore).map((c) => c.name);
  const already = counted.filter((c) => c.countedAfter && c.countedBefore).map((c) => c.name);
  const parts = [`Recorded ${date}:`];
  parts.push(fresh.length ? `counted ${fresh.join(', ')}` : 'no new counted wear');
  if (already.length) parts.push(`(already counted that day: ${already.join(', ')})`);
  return parts.join(' ') + '.';
}

export async function recordWear(ctx: HandlerContext<CommandOf<'record_wear'>>): Promise<CommandPlan> {
  const c = ctx.command;
  if (!isValidTimeZone(c.timezone)) throw new DomainError('validation_failed', `Unknown timezone ${c.timezone}`);
  validateItems(c.items);
  // The wearing date is the owner's local calendar date (ADV-09): without an explicit wearingDate it
  // is derived in the owner's configured time zone, not the reporting device's, so one wear reported
  // by two devices that disagree on the zone lands on one day. The device zone is kept as the
  // observation's event timezone. An explicit wearingDate (e.g. on a trip) stays the key.
  const settings = await ctx.db.prepare('SELECT timezone FROM owner_settings WHERE user_id = ?').bind(ctx.principal.userId).first<{ timezone: string }>();
  const ownerTz = settings?.timezone && isValidTimeZone(settings.timezone) ? settings.timezone : c.timezone;
  const dateTz = c.wearingDate ? c.timezone : ownerTz;
  const today = localDateOf(ctx.now, dateTz);
  let occurredAt = c.occurredAt ? new Date(c.occurredAt).toISOString() : undefined;
  const wearingDate = c.wearingDate ?? localDateOf(occurredAt ?? ctx.now, ownerTz);
  if (!occurredAt) occurredAt = wearingDate === today ? ctx.now : zonedInstant(wearingDate, '12:00', dateTz);
  if (wearingDate > today) throw new DomainError('validation_failed', `A wear cannot be recorded for a future date (${wearingDate})`);
  if (Date.parse(occurredAt) > Date.parse(ctx.now) + 5 * 60_000) throw new DomainError('validation_failed', 'occurredAt is in the future');
  // An overnight outfit keeps its starting date: the wearing date may precede the occurrence date by one day, never follow it.
  const occurredLocal = localDateOf(occurredAt, dateTz);
  if (wearingDate > occurredLocal || wearingDate < addDays(occurredLocal, -1)) {
    if (c.occurredAt) throw new DomainError('validation_failed', `wearingDate ${wearingDate} is inconsistent with occurredAt (${occurredLocal} local)`);
  }

  const garments = await requireGarments(ctx.db, ctx.principal.userId, c.items.map((i) => i.garmentId));
  validateItems(c.items, garments);

  const observation: ObservationState = {
    observationId: newId('obs'),
    wearingDate,
    timezone: c.timezone,
    occurredAt,
    source: ctx.envelope.source,
    sourceRef: c.sourceRef ?? null,
    segment: c.segment ?? null,
    optionId: c.optionId ?? null,
    status: 'active',
    revision: 1,
    supersedesObservationId: null,
    version: 1,
    items: c.items.map((i) => ({ garmentId: i.garmentId, role: i.role ?? null, fresh: Boolean(i.freshUnit) })),
  };
  const plan = await planWearChange(ctx, { date: wearingDate, add: observation });
  const allMerged = plan.counted.every((x) => x.countedBefore);
  return {
    occurredAt,
    guards: plan.guards,
    statements: plan.statements,
    affected: plan.affected,
    outcome: allMerged ? 'merged' : 'committed',
    summary: summarize(wearingDate, plan.counted),
    facts: {
      observationId: observation.observationId,
      wearingDate,
      timezone: c.timezone,
      counted: plan.counted,
      stockNotes: plan.stockNotes,
      warnings: ledgerWarnings(garments),
    },
    undo: { kind: 'retract_observation', observationId: observation.observationId },
    effects: [revalidationEffect(ctx.commandId, [...garments.keys()], 'wear_recorded')],
  };
}

export async function amendWear(ctx: HandlerContext<CommandOf<'amend_wear'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const target = await loadObservation(ctx.db, ctx.principal.userId, c.observationId);
  if (!target) throw new DomainError('not_found', `No wear observation ${c.observationId}`, { entityType: 'wear_observation', entityId: c.observationId });
  if (target.status !== 'active') throw new DomainError('invalid_state', 'Only the active revision of an observation can be amended', { status: target.status });
  validateItems(c.items);
  if (c.items.length) {
    const garments = await requireGarments(ctx.db, ctx.principal.userId, c.items.map((i) => i.garmentId));
    validateItems(c.items, garments);
  }
  const replacement: ObservationState | undefined = c.items.length
    ? {
        ...target,
        observationId: newId('obs'),
        revision: target.revision + 1,
        supersedesObservationId: target.observationId,
        status: 'active',
        version: 1,
        sourceRef: c.reason ?? target.sourceRef,
        items: c.items.map((i) => ({ garmentId: i.garmentId, role: i.role ?? null, fresh: Boolean(i.freshUnit) })),
      }
    : undefined;
  const plan = await planWearChange(ctx, {
    date: target.wearingDate,
    add: replacement,
    deactivate: [{ observation: target, status: replacement ? 'superseded' : 'retracted' }],
  });
  const removed = plan.counted.filter((x) => x.countedBefore && !x.countedAfter).map((x) => x.name);
  const added = plan.counted.filter((x) => !x.countedBefore && x.countedAfter).map((x) => x.name);
  return {
    occurredAt: target.occurredAt,
    guards: plan.guards,
    statements: plan.statements,
    affected: plan.affected,
    summary: `Amended the ${target.wearingDate} record${added.length ? `; now counted: ${added.join(', ')}` : ''}${removed.length ? `; no longer counted: ${removed.join(', ')}` : ''}${!added.length && !removed.length ? '; counted wears unchanged' : ''}.`,
    facts: { previousObservationId: target.observationId, observationId: replacement?.observationId ?? null, wearingDate: target.wearingDate, counted: plan.counted, stockNotes: plan.stockNotes },
    undo: replacement
      ? { kind: 'revert_amendment', newObservationId: replacement.observationId, previousObservationId: target.observationId }
      : { kind: 'revert_amendment', newObservationId: '', previousObservationId: target.observationId },
    effects: [revalidationEffect(ctx.commandId, plan.counted.map((x) => x.garmentId), 'wear_amended')],
  };
}

/** Compensation for a mistaken recording: retracts the observation and recomputes the day. */
export async function planRetraction(ctx: HandlerContext, observationId: string): Promise<CommandPlan> {
  const obs = await loadObservation(ctx.db, ctx.principal.userId, observationId);
  if (!obs) throw new DomainError('not_found', `No wear observation ${observationId}`);
  if (obs.status !== 'active') throw new DomainError('invalid_state', 'That observation has already been superseded or retracted; undo the later change instead', { status: obs.status });
  const plan = await planWearChange(ctx, { date: obs.wearingDate, deactivate: [{ observation: obs, status: 'retracted' }] });
  const removed = plan.counted.filter((x) => x.countedBefore && !x.countedAfter).map((x) => x.name);
  return {
    occurredAt: obs.occurredAt,
    guards: plan.guards,
    statements: plan.statements,
    affected: plan.affected,
    summary: `Removed the ${obs.wearingDate} wear record${removed.length ? `; no longer counted: ${removed.join(', ')}` : ''}.`,
    facts: { retractedObservationId: observationId, counted: plan.counted, stockNotes: plan.stockNotes },
    undo: null,
    undoUnavailableReason: 'Undo of an undo is not supported; record the wear again instead.',
    effects: [revalidationEffect(ctx.commandId, plan.counted.map((x) => x.garmentId), 'wear_retracted')],
  };
}

export async function planRevertAmendment(ctx: HandlerContext, newObservationId: string, previousObservationId: string): Promise<CommandPlan> {
  const previous = await loadObservation(ctx.db, ctx.principal.userId, previousObservationId);
  if (!previous) throw new DomainError('not_found', `No wear observation ${previousObservationId}`);
  const current = newObservationId ? await loadObservation(ctx.db, ctx.principal.userId, newObservationId) : null;
  if (current && current.status !== 'active') throw new DomainError('invalid_state', 'The amended record has changed since; undo the later change first');
  if (previous.status === 'active') throw new DomainError('invalid_state', 'The original record is already active');
  const plan = await planWearChange(ctx, {
    date: previous.wearingDate,
    deactivate: current ? [{ observation: current, status: 'retracted' }] : [],
    reactivate: [previous],
  });
  return {
    occurredAt: previous.occurredAt,
    guards: plan.guards,
    statements: plan.statements,
    affected: plan.affected,
    summary: `Restored the original ${previous.wearingDate} wear record.`,
    facts: { restoredObservationId: previousObservationId, counted: plan.counted, stockNotes: plan.stockNotes },
    undo: null,
    undoUnavailableReason: 'Undo of an undo is not supported; amend the record instead.',
    effects: [revalidationEffect(ctx.commandId, plan.counted.map((x) => x.garmentId), 'wear_amendment_reverted')],
  };
}
