import { DEFAULT_ESTIMATOR_PARAMETERS, EstimatorParameters, type LaundryReset } from '@garderobe/contracts';
import { parseJson } from '../domain/db.js';
import { poolOf, type EstimatorBoardDay } from '../domain/estimator.js';
import { localDateOf } from '../domain/time.js';
import type { WardrobeGarment } from './garments.js';

/**
 * Joint availability of a whole outfit (spec section 5, "Probability without status interrogation":
 * rank using estimated joint availability, not independent per-item thresholds).
 *
 * The foundation estimator supplies each garment's estimated clean units (physical plus the weekly
 * reset) and the board-day selection model. Earlier board days are independent; within a day the
 * owner wears at most one option, so garments shared by an earlier option are correlated. Exact
 * dynamic programming over days tracks the joint count of inferred wears of the outfit's garments and
 * returns P(every garment keeps at least one estimated clean unit). With one garment it equals the
 * estimator's own probabilityAvailable.
 */

export interface JointInput {
  garments: WardrobeGarment[];
  boardDays: EstimatorBoardDay[];
  resets: Pick<LaundryReset, 'pool' | 'cutoffAt' | 'effectiveAt'>[];
  asOf: string;
  targetDate: string;
  params?: EstimatorParameters;
}

interface Outcome {
  p: number;
  garments: Set<string>;
}

function dayOutcomes(day: EstimatorBoardDay, relevant: Set<string>, params: EstimatorParameters): Outcome[] {
  const n = day.options.length;
  if (!n) return [];
  const selected = day.selectedOptionId && day.options.some((o) => o.optionId === day.selectedOptionId) ? day.selectedOptionId : null;
  const pUse = selected ? params.selectedBoardUseProbability : params.boardUseProbability;
  const out: Outcome[] = [];
  for (const o of day.options) {
    const pOpt = selected ? (o.optionId === selected ? (n === 1 ? 1 : params.selectedOptionProbability) : (1 - params.selectedOptionProbability) / (n - 1)) : 1 / n;
    const fixed = new Set<string>();
    const groups = new Map<string, string[]>();
    for (const s of o.slots) {
      if (s.alternativeGroup) groups.set(s.alternativeGroup, [...(groups.get(s.alternativeGroup) ?? []), s.garmentId]);
      else if (relevant.has(s.garmentId)) fixed.add(s.garmentId);
    }
    // Enumerate alternative choices only for groups that touch the outfit's garments.
    let branches: { p: number; garments: Set<string> }[] = [{ p: 1, garments: fixed }];
    for (const members of groups.values()) {
      if (!members.some((m) => relevant.has(m))) continue;
      const chosen = selected === o.optionId && day.selectedFootwearId && members.includes(day.selectedFootwearId) ? [day.selectedFootwearId] : members;
      const next: typeof branches = [];
      for (const b of branches) {
        for (const m of chosen) {
          const g = new Set(b.garments);
          if (relevant.has(m)) g.add(m);
          next.push({ p: b.p / chosen.length, garments: g });
        }
      }
      branches = next;
    }
    for (const b of branches) if (b.garments.size) out.push({ p: pUse * pOpt * b.p, garments: b.garments });
  }
  return out;
}

export function jointAvailability(input: JointInput): { probability: number; perGarment: Record<string, number>; constrained: string[] } {
  const params = EstimatorParameters.parse(input.params ?? DEFAULT_ESTIMATOR_PARAMETERS);
  const asOfMs = Date.parse(input.asOf);
  const perGarment: Record<string, number> = {};
  const constrained: { id: string; clean: number; since: string }[] = [];
  for (const g of input.garments) {
    const e = g.estimate;
    perGarment[g.garmentId] = e?.probabilityAvailable ?? 0;
    if (!e || !e.eligible) return { probability: 0, perGarment, constrained: [g.garmentId] };
    if (g.laundryPolicy === 'multi_wear' || g.laundryPolicy === 'never') continue;
    if (e.estimatedCleanUnits <= 0) return { probability: 0, perGarment, constrained: [g.garmentId] };
    const pool = poolOf(g.careChannel);
    const reset = input.resets.filter((r) => r.pool === pool && Date.parse(r.effectiveAt) <= asOfMs).sort((a, b) => Date.parse(b.effectiveAt) - Date.parse(a.effectiveAt))[0];
    constrained.push({ id: g.garmentId, clean: e.estimatedCleanUnits, since: reset ? localDateOf(reset.cutoffAt, 'UTC') : '0000-01-01' });
  }
  if (!constrained.length) return { probability: 1, perGarment, constrained: [] };
  const index = new Map(constrained.map((c, i) => [c.id, i]));
  // state: uses per constrained garment (each < its clean units); absorbing failure is dropped.
  let states = new Map<string, number>([[constrained.map(() => 0).join(','), 1]]);
  const days = [...input.boardDays].filter((d) => d.boardDate < input.targetDate && !d.dayHasRecordedWear).sort((a, b) => a.boardDate.localeCompare(b.boardDate));
  for (const day of days) {
    const relevant = new Set(constrained.filter((c) => day.boardDate >= c.since).map((c) => c.id));
    if (!relevant.size) continue;
    const outcomes = dayOutcomes(day, relevant, params);
    const pNone = Math.max(0, 1 - outcomes.reduce((a, o) => a + o.p, 0));
    const next = new Map<string, number>();
    for (const [key, p] of states) {
      next.set(key, (next.get(key) ?? 0) + p * pNone);
      const uses = key.split(',').map(Number);
      for (const o of outcomes) {
        const u = [...uses];
        let failed = false;
        for (const id of o.garments) {
          const i = index.get(id)!;
          u[i]! += 1;
          if (u[i]! >= constrained[i]!.clean) failed = true;
        }
        if (failed) continue;
        const k = u.join(',');
        next.set(k, (next.get(k) ?? 0) + p * o.p);
      }
    }
    states = next;
  }
  let total = 0;
  for (const p of states.values()) total += p;
  return { probability: Math.max(0, Math.min(1, total)), perGarment, constrained: constrained.map((c) => c.id) };
}

/** Earlier published home boards (same window as the foundation estimator). */
export async function loadEstimatorBoardDays(db: D1Database, userId: string, asOf: string, targetDate: string): Promise<EstimatorBoardDay[]> {
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
    const sel = await db
      .prepare("SELECT option_id, footwear_garment_id FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'")
      .bind(userId, b.board_id)
      .first<{ option_id: string; footwear_garment_id: string | null }>();
    const worn = await db.prepare("SELECT 1 AS x FROM daily_wears WHERE user_id = ? AND wearing_date = ? AND status = 'active' LIMIT 1").bind(userId, b.board_date).first();
    const ids = [...new Set(slots.map((s) => s.option_id))];
    days.push({
      boardDate: b.board_date,
      options: ids.map((id) => ({ optionId: id, slots: slots.filter((s) => s.option_id === id).map((s) => ({ garmentId: s.garment_id, role: s.role, alternativeGroup: s.alternative_group })) })),
      selectedOptionId: sel?.option_id ?? null,
      selectedFootwearId: sel?.footwear_garment_id ?? null,
      dayHasRecordedWear: Boolean(worn),
    });
  }
  return days;
}

export function estimatorParamsOf(settingsJson: string | null | undefined): EstimatorParameters {
  return EstimatorParameters.parse(parseJson(settingsJson, DEFAULT_ESTIMATOR_PARAMETERS));
}
