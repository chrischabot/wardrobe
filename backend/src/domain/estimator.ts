import {
  DEFAULT_ESTIMATOR_PARAMETERS,
  ESTIMATOR_VERSION,
  EstimatorParameters,
  type AvailabilityEstimate,
  type EstimateBasis,
  type LaundryPool,
  type LaundryReset,
  type StockBucket,
} from '@garderobe/contracts';
import { parseJson } from './db.js';
import { assertPrincipal, type Principal } from './principal.js';
import { loadAllLots, type GarmentRow, type LotRow } from './records.js';
import { evaluateEligibility } from './availability.js';
import { loadActiveRestrictions } from './restrictions.js';
import { listLaundryResets, loadSettings } from './laundry.js';
import { localDateOf } from './time.js';

/**
 * Availability estimator, version `availability-estimator/1` (spec section 5, "Probability without
 * status interrogation").
 *
 * Model (initial parameters are hypotheses, not calibrated accuracy):
 *  - Selection prior: on an unselected board with N offerable options each option has probability 1/N;
 *    footwear alternatives inside an option share that option's probability (1/k each).
 *  - Board use: multiply by P(use board) to leave room for an unreported other outfit or no wear.
 *  - A garment in several options of one board: sum the mutually exclusive option probabilities.
 *  - A selection raises the selected option to `selectedOptionProbability` and board use to
 *    `selectedBoardUseProbability`; a recorded wear on a date replaces that day's uncertainty.
 *  - Clean stock: physical clean units plus dirty units cleared by the latest applied weekly reset of
 *    the garment's laundry pool (service: dirtied before Friday's collection cutoff, or in a batch
 *    collected before Sunday's baseline; hand wash: dirtied before its baseline). Owner exceptions
 *    (still away, missed return, dirty, delay) after the cutoff override the reset.
 *  - Quantity-aware: the number of inferred wears is Poisson-binomial over the uncertain days; the
 *    probability of availability is P(inferred wears < estimated clean units).
 * Inferred wears never enter recorded wear counts and never move stock.
 */

export interface EstimatorBoardDay {
  boardDate: string;
  options: { optionId: string; slots: { garmentId: string; role: string; alternativeGroup: string | null }[] }[];
  selectedOptionId: string | null;
  selectedFootwearId: string | null;
  /** True when any wear is recorded for this date: the observation replaces the day's uncertainty. */
  dayHasRecordedWear: boolean;
}

export interface EstimatorGarmentInput {
  garmentId: string;
  laundryPolicy: string;
  careChannel: string;
  eligible: boolean;
  exclusionReasons: string[];
  units: Record<StockBucket, string[]>;
  /** Units in a laundry batch that the owner reported as still away (never reset). */
  exceptionUnits: number;
  exceptions: { kind: string; occurredAt: string; quantity: number }[];
  cleanBasis: 'observed' | 'import_baseline';
}

export interface EstimatorInput {
  garment: EstimatorGarmentInput;
  resets: Pick<LaundryReset, 'pool' | 'cycleKey' | 'cutoffAt' | 'effectiveAt'>[];
  boards: EstimatorBoardDay[];
  asOf: string;
  targetDate: string;
  params?: EstimatorParameters;
}

/** Probability that a garment is worn from one board day (mutually exclusive options summed). */
export function boardWearProbability(day: EstimatorBoardDay, garmentId: string, params: EstimatorParameters): number {
  const n = day.options.length;
  if (n === 0) return 0;
  const selected = day.selectedOptionId && day.options.some((o) => o.optionId === day.selectedOptionId) ? day.selectedOptionId : null;
  const pUse = selected ? params.selectedBoardUseProbability : params.boardUseProbability;
  let sum = 0;
  for (const o of day.options) {
    const pOption = selected ? (o.optionId === selected ? (n === 1 ? 1 : params.selectedOptionProbability) : (1 - params.selectedOptionProbability) / (n - 1)) : 1 / n;
    const slot = o.slots.find((s) => s.garmentId === garmentId);
    if (!slot) continue;
    let share = 1;
    if (slot.alternativeGroup) {
      const group = o.slots.filter((s) => s.alternativeGroup === slot.alternativeGroup);
      if (selected === o.optionId && day.selectedFootwearId && group.some((s) => s.garmentId === day.selectedFootwearId)) {
        share = day.selectedFootwearId === garmentId ? 1 : 0;
      } else {
        share = 1 / group.length;
      }
    }
    sum += pOption * share;
  }
  return Math.min(1, pUse * sum);
}

/** P(K < c) for K ~ Poisson-binomial(ps). */
export function probabilityFewerThan(ps: number[], c: number): number {
  if (c <= 0) return 0;
  let dist = [1];
  for (const p of ps) {
    const next = new Array<number>(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      next[k]! += dist[k]! * (1 - p);
      next[k + 1]! += dist[k]! * p;
    }
    dist = next;
  }
  let total = 0;
  for (let k = 0; k < Math.min(c, dist.length); k++) total += dist[k]!;
  return Math.max(0, Math.min(1, total));
}

export function poolOf(careChannel: string): LaundryPool {
  return careChannel === 'hand_wash' ? 'hand_wash' : 'service';
}

export function estimateGarment(input: EstimatorInput): AvailabilityEstimate {
  const params = EstimatorParameters.parse(input.params ?? DEFAULT_ESTIMATOR_PARAMETERS);
  const g = input.garment;
  const basis: EstimateBasis[] = [];
  const result = (estimatedCleanUnits: number, expected: number, p: number): AvailabilityEstimate => ({
    estimatorVersion: ESTIMATOR_VERSION,
    garmentId: g.garmentId,
    asOf: input.asOf,
    targetDate: input.targetDate,
    eligible: g.eligible,
    exclusionReasons: g.exclusionReasons,
    estimatedCleanUnits,
    expectedInferredWears: expected,
    probabilityAvailable: p,
    likelyAvailable: g.eligible && p >= params.likelyAvailableThreshold,
    basis,
  });

  if (!g.eligible) {
    basis.push({ kind: 'hard_exclusion', detail: g.exclusionReasons.join('; ') || 'Not eligible' });
    return result(0, 0, 0);
  }
  if (g.laundryPolicy === 'multi_wear' || g.laundryPolicy === 'never') {
    const owned = g.units.clean.length + g.units.worn.length + g.units.hamper.length;
    basis.push({ kind: 'not_laundered', detail: 'Wear does not consume clean stock for this garment' });
    return result(owned, 0, owned > 0 ? 1 : 0);
  }

  const clean = g.units.clean.length;
  basis.push({
    kind: 'physical_clean',
    detail: g.cleanBasis === 'import_baseline' ? 'Clean units from the import baseline (cleanliness estimated under the weekly reset, not observed)' : 'Clean units on record',
    quantity: clean,
  });

  const pool = poolOf(g.careChannel);
  const asOfMs = Date.parse(input.asOf);
  const reset = input.resets
    .filter((r) => r.pool === pool && Date.parse(r.effectiveAt) <= asOfMs)
    .sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];

  let resetCleared = 0;
  if (reset) {
    const cutoff = Date.parse(reset.cutoffAt);
    const effective = Date.parse(reset.effectiveAt);
    const dirty = [...g.units.worn, ...g.units.hamper].filter((t) => Date.parse(t) < cutoff).length;
    const inBatch = pool === 'service' ? Math.max(0, g.units.laundry.filter((t) => Date.parse(t) < effective).length - g.exceptionUnits) : 0;
    const overriding = g.exceptions.filter((e) => Date.parse(e.occurredAt) >= cutoff && e.kind !== 'still_away').reduce((n, e) => n + e.quantity, 0);
    resetCleared = Math.max(0, dirty + inBatch - overriding);
    if (resetCleared > 0) basis.push({ kind: 'weekly_reset', detail: `Weekly ${pool.replace('_', ' ')} reset of ${reset.cycleKey} clears routine use before its cutoff`, quantity: resetCleared, resetCycle: reset.cycleKey });
    if (overriding > 0 || g.exceptionUnits > 0) basis.push({ kind: 'owner_exception', detail: 'Owner-reported exception overrides the weekly reset', quantity: overriding + g.exceptionUnits });
  }
  const estimatedClean = clean + resetCleared;

  // Uncertain board days: after the reset cutoff, before the target date, with no recorded wear.
  const since = reset ? localDateOf(reset.cutoffAt, 'UTC') : '0000-01-01';
  const ps: number[] = [];
  for (const day of input.boards) {
    if (day.boardDate >= input.targetDate || day.boardDate < since) continue;
    if (day.dayHasRecordedWear) {
      basis.push({ kind: 'recorded_wear', detail: `Wear recorded on ${day.boardDate}; the observation replaces that day's estimate`, boardDate: day.boardDate });
      continue;
    }
    const p = boardWearProbability(day, g.garmentId, params);
    if (p > 0) {
      ps.push(p);
      basis.push({ kind: day.selectedOptionId ? 'selection' : 'board_probability', detail: `Possible unreported wear from the ${day.boardDate} board`, probability: p, boardDate: day.boardDate });
    }
  }
  const expected = ps.reduce((a, b) => a + b, 0);
  return result(estimatedClean, expected, probabilityFewerThan(ps, estimatedClean));
}

/** Independence approximation of an option's joint availability (daily-service may refine for shared garments). */
export function optionAvailability(garmentIds: string[], estimates: Map<string, AvailabilityEstimate>): number {
  return garmentIds.reduce((p, id) => p * (estimates.get(id)?.probabilityAvailable ?? 0), 1);
}

/** Loads the owner's state and estimates availability of garments for a target local date. */
export async function estimateAvailability(
  db: D1Database,
  principal: Principal,
  opts: { targetDate: string; asOf?: string; garmentIds?: string[]; includeOccasional?: boolean },
): Promise<AvailabilityEstimate[]> {
  assertPrincipal(principal);
  const userId = principal.userId;
  const asOf = opts.asOf ?? new Date().toISOString();
  const settings = await loadSettings(db, principal);
  const params = EstimatorParameters.parse(parseJson(settings?.estimator_params_json, DEFAULT_ESTIMATOR_PARAMETERS));
  const { results: garments } = await db.prepare('SELECT * FROM garments WHERE user_id = ?').bind(userId).all<GarmentRow>();
  const wanted = opts.garmentIds ? new Set(opts.garmentIds) : null;
  const lots = await loadAllLots(db, userId);
  const restrictions = await loadActiveRestrictions(db, userId);
  const resets = await listLaundryResets(db, principal);
  const { results: exceptions } = await db
    .prepare('SELECT garment_id, kind, occurred_at, quantity, batch_id FROM laundry_exceptions WHERE user_id = ? AND cleared_at IS NULL')
    .bind(userId)
    .all<{ garment_id: string; kind: string; occurred_at: string; quantity: number; batch_id: string | null }>();
  const { results: observedClean } = await db
    .prepare("SELECT garment_id, COUNT(*) AS n FROM stock_movements WHERE user_id = ? AND voided_at IS NULL AND kind <> 'receive' GROUP BY garment_id")
    .bind(userId)
    .all<{ garment_id: string; n: number }>();
  const observed = new Set(observedClean.map((o) => o.garment_id));
  const boards = await loadBoardDays(db, userId, asOf, opts.targetDate);

  const out: AvailabilityEstimate[] = [];
  for (const g of garments) {
    if (wanted && !wanted.has(g.garment_id)) continue;
    const gl = lots.filter((l) => l.garment_id === g.garment_id);
    const eligibility = evaluateEligibility(g, restrictions, { includeOccasional: opts.includeOccasional, lots: gl });
    const ex = exceptions.filter((e) => e.garment_id === g.garment_id);
    out.push(
      estimateGarment({
        garment: {
          garmentId: g.garment_id,
          laundryPolicy: g.laundry_policy,
          careChannel: g.care_channel,
          eligible: eligibility.available,
          exclusionReasons: eligibility.reasons,
          units: mergeUnits(gl),
          exceptionUnits: ex.filter((e) => e.kind === 'still_away' || e.kind === 'missed_return').reduce((n, e) => n + e.quantity, 0),
          exceptions: ex.map((e) => ({ kind: e.kind, occurredAt: e.occurred_at, quantity: e.quantity })),
          cleanBasis: observed.has(g.garment_id) ? 'observed' : 'import_baseline',
        },
        resets,
        boards,
        asOf,
        targetDate: opts.targetDate,
        params,
      }),
    );
  }
  return out;
}

function mergeUnits(lots: LotRow[]): Record<StockBucket, string[]> {
  const out: Record<StockBucket, string[]> = { clean: [], worn: [], hamper: [], laundry: [], storage: [], away: [], retired: [] };
  for (const l of lots) {
    const u = parseJson<Partial<Record<StockBucket, string[]>>>(l.units_json, {});
    for (const k of Object.keys(out) as StockBucket[]) out[k].push(...(u[k] ?? []));
  }
  return out;
}

async function loadBoardDays(db: D1Database, userId: string, asOf: string, targetDate: string): Promise<EstimatorBoardDay[]> {
  const from = new Date(Date.parse(asOf) - 14 * 86_400_000).toISOString().slice(0, 10);
  const { results: boards } = await db
    .prepare("SELECT board_id, board_date, current_revision FROM boards WHERE user_id = ? AND purpose = 'day' AND status = 'published' AND board_date >= ? AND board_date < ?")
    .bind(userId, from, targetDate)
    .all<{ board_id: string; board_date: string; current_revision: number }>();
  const days: EstimatorBoardDay[] = [];
  for (const b of boards) {
    const { results: slots } = await db
      .prepare(
        `SELECT o.option_id, og.garment_id, og.role, og.alternative_group FROM board_options o JOIN option_garments og ON og.user_id = o.user_id AND og.option_id = o.option_id
         WHERE o.user_id = ? AND o.board_id = ? AND o.revision = ? AND o.status = 'offerable'`,
      )
      .bind(userId, b.board_id, b.current_revision)
      .all<{ option_id: string; garment_id: string; role: string; alternative_group: string | null }>();
    const optionIds = [...new Set(slots.map((s) => s.option_id))];
    const sel = await db
      .prepare("SELECT option_id, footwear_garment_id FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'")
      .bind(userId, b.board_id)
      .first<{ option_id: string; footwear_garment_id: string | null }>();
    const worn = await db.prepare("SELECT 1 AS x FROM daily_wears WHERE user_id = ? AND wearing_date = ? AND status = 'active' LIMIT 1").bind(userId, b.board_date).first();
    days.push({
      boardDate: b.board_date,
      options: optionIds.map((id) => ({ optionId: id, slots: slots.filter((s) => s.option_id === id).map((s) => ({ garmentId: s.garment_id, role: s.role, alternativeGroup: s.alternative_group })) })),
      selectedOptionId: sel?.option_id ?? null,
      selectedFootwearId: sel?.footwear_garment_id ?? null,
      dayHasRecordedWear: Boolean(worn),
    });
  }
  return days;
}
