/**
 * Versioned availability estimator (specification section 5, "Probability without status interrogation").
 *
 * Pure application code: no database, no model. It combines
 *   - observed physical facts (materialized stock balances, restrictions, acquisition, planning policy) and
 *   - a separately computed estimate of unreported routine wear since the last laundry baseline,
 * and never turns uncertainty into a hard exclusion, never creates units and never touches recorded wear.
 *
 * Probability model (initial parameters are documented HYPOTHESES, not calibrated accuracy):
 *   - an unselected set of N offered options: each option has prior pUse / N, where pUse is the
 *     probability the owner dresses from the board at all (the remainder is an unreported different
 *     outfit or no wear);
 *   - alternatives inside an option (two footwear choices) share that option's probability equally;
 *   - options of one set are mutually exclusive, so a garment appearing in several options gets the SUM
 *     of their probabilities - it is not charged one wear per option;
 *   - a selection moves the mass to the selected option (pFollowSelection);
 *   - a garment counts at most one wear per local date; dates are treated as independent;
 *   - P(a clean unit remains) uses the observed clean quantity: it is P(unreported wears < clean units);
 *   - joint availability of an outfit is computed exactly over the shared option outcomes, so garments
 *     that are offered together are correlated rather than multiplied as if independent.
 */
import { AVAILABILITY_MODEL_VERSION } from "@garderobe/contracts";
import type { AvailabilityReason, CareChannel, GarmentAvailability, PlanningPolicy, Acquisition, RestrictionScope } from "@garderobe/contracts";
import type { BalanceRow } from "../stock/replay.ts";

export interface EstimatorParams {
  pUseBoard: number;
  pFollowSelection: number;
  importCleanPrior: number;
}

export interface EstimatorGarment {
  garmentId: string;
  category: string;
  careChannel: CareChannel;
  acquisition: Acquisition;
  planningPolicy: PlanningPolicy;
  merged: boolean;
  attributes: Record<string, unknown>;
  balances: BalanceRow[];
  /** Imported stock whose cleanliness has not been established by an observation or a laundry baseline. */
  importCleanlinessUnverified: boolean;
  /**
   * How many of the clean units are clean only by the weekly laundry inference (no wash, return or count
   * was observed for them). Materialized by the stock planner from the replay; absent means none.
   */
  cleanInferred?: number;
  /** Imported stock for which no wash, return or count has been observed since (whatever a baseline has assumed). */
  importNeverObserved?: boolean;
}

export interface EstimatorRestriction {
  restrictionId: string;
  kind: string;
  scope: RestrictionScope;
}

export interface EstimatorExposureSet {
  exposureId: string;
  localDate: string;
  /** Overrides params.pUseBoard when set. */
  pUse: number | null;
  selectedOptionId: string | null;
  chosenAlternatives: string[];
  options: { optionId: string; garmentIds: string[]; alternativeGroups: string[][] }[];
}

export interface EstimatorInput {
  forDate: string;
  params: EstimatorParams;
  garments: EstimatorGarment[];
  restrictions: EstimatorRestriction[];
  /** Unresolved exposure sets before forDate. */
  exposures: EstimatorExposureSet[];
  /**
   * Per care channel, the first local date whose unreported wear still matters: the collection date of the
   * last applied laundry baseline (earlier routine uncertainty was cleared by that reset).
   */
  cutoffDateByChannel?: Partial<Record<CareChannel, string>>;
}

export function restrictionCovers(scope: RestrictionScope, g: { garmentId: string; category: string; attributes: Record<string, unknown> }): boolean {
  if (scope.garmentIds?.includes(g.garmentId)) return true;
  for (const clause of scope.anyOf ?? []) {
    const checks: boolean[] = [];
    if (clause.category !== undefined) checks.push(clause.category === g.category);
    if (clause.footwearKinds !== undefined) checks.push(clause.footwearKinds.includes(g.attributes.footwearKind as never));
    if (clause.models !== undefined) {
      const model = String(g.attributes.model ?? "").toLowerCase();
      checks.push(model !== "" && clause.models.some((m) => m.toLowerCase() === model));
    }
    if (checks.length > 0 && checks.every(Boolean)) return true;
  }
  return false;
}

/** Outcomes of one exposure set: mutually exclusive worn-garment sets with probabilities (sum <= 1). */
export function exposureOutcomes(set: EstimatorExposureSet, params: EstimatorParams): { probability: number; garmentIds: string[] }[] {
  const outcomes: { probability: number; garmentIds: string[] }[] = [];
  const expand = (option: EstimatorExposureSet["options"][number], probability: number, chosen: string[]) => {
    let combos: { p: number; ids: string[] }[] = [{ p: probability, ids: [...option.garmentIds] }];
    for (const group of option.alternativeGroups) {
      const picked = group.filter((id) => chosen.includes(id));
      const choices = picked.length > 0 ? picked : group;
      combos = combos.flatMap((c) => choices.map((id) => ({ p: c.p / choices.length, ids: [...c.ids, id] })));
    }
    for (const c of combos) outcomes.push({ probability: c.p, garmentIds: c.ids });
  };
  const selected = set.selectedOptionId ? set.options.find((o) => o.optionId === set.selectedOptionId) : undefined;
  if (selected) {
    expand(selected, params.pFollowSelection, set.chosenAlternatives);
  } else {
    const pUse = set.pUse ?? params.pUseBoard;
    for (const option of set.options) expand(option, pUse / set.options.length, []);
  }
  return outcomes;
}

/** Probability that a garment is worn (unreported) under one exposure set. Options are summed, never double-charged. */
export function selectionProbability(set: EstimatorExposureSet, garmentId: string, params: EstimatorParams): number {
  let p = 0;
  for (const o of exposureOutcomes(set, params)) if (o.garmentIds.includes(garmentId)) p += o.probability;
  return Math.min(1, p);
}

/** Per local date, the probability the garment was worn without a report (at most one wear per date). */
export function inferredWearByDate(garmentId: string, exposures: EstimatorExposureSet[], params: EstimatorParams, cutoffDate?: string): { localDate: string; probability: number }[] {
  const byDate = new Map<string, number>();
  for (const set of exposures) {
    if (cutoffDate && set.localDate < cutoffDate) continue;
    const p = selectionProbability(set, garmentId, params);
    if (p <= 0) continue;
    byDate.set(set.localDate, 1 - (1 - (byDate.get(set.localDate) ?? 0)) * (1 - p));
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([localDate, probability]) => ({ localDate, probability }));
}

function cleanAtHome(g: EstimatorGarment): number {
  return g.balances.filter((b) => b.bucket === "clean").reduce((n, b) => n + b.quantity, 0);
}

function hardReasons(g: EstimatorGarment, restrictions: EstimatorRestriction[]): { reasons: AvailabilityReason[]; restrictionIds: string[] } {
  const reasons: AvailabilityReason[] = [];
  const restrictionIds: string[] = [];
  if (g.merged) reasons.push("merged");
  if (g.acquisition === "incoming") reasons.push("not_owned_yet");
  if (g.acquisition === "disposed") reasons.push("disposed");
  for (const r of restrictions) {
    if (restrictionCovers(r.scope, g)) restrictionIds.push(r.restrictionId);
  }
  if (restrictionIds.length > 0) reasons.push("restricted");
  if (g.planningPolicy === "excluded") reasons.push("planning_excluded");
  if (g.acquisition === "owned" && !g.merged && cleanAtHome(g) === 0) {
    reasons.push("no_units_at_home");
    const has = (bucket: string) => g.balances.some((b) => b.bucket === bucket && b.quantity > 0);
    if (has("dirty")) reasons.push("observed_dirty");
    if (has("service")) reasons.push(g.balances.some((b) => b.bucket === "service" && b.held) ? "laundry_exception" : "in_service_batch");
    if (has("storage")) reasons.push("in_storage");
    if (has("tailor")) reasons.push("at_tailor");
    if (has("trip")) reasons.push("on_trip");
  }
  return { reasons, restrictionIds };
}

/**
 * Exact joint probability that every listed garment still has a clean unit at home for a fresh wear on
 * forDate, given the unresolved exposures. Hard-excluded garments make the result 0 and are listed.
 */
export function jointAvailability(input: EstimatorInput, garmentIds: string[]): { pAllAvailable: number; hardExcluded: string[] } {
  const byId = new Map(input.garments.map((g) => [g.garmentId, g]));
  const unique = [...new Set(garmentIds)];
  const hardExcluded: string[] = [];
  const tracked: { id: string; clean: number; cutoff: string | undefined }[] = [];
  let prior = 1;
  for (const id of unique) {
    const g = byId.get(id);
    if (!g || hardReasons(g, input.restrictions).reasons.length > 0) {
      hardExcluded.push(id);
      continue;
    }
    if (g.careChannel === "none") continue; // never laundered: present means wearable
    if (g.importCleanlinessUnverified) prior *= input.params.importCleanPrior;
    tracked.push({ id, clean: cleanAtHome(g), cutoff: input.cutoffDateByChannel?.[g.careChannel] });
  }
  if (hardExcluded.length > 0) return { pAllAvailable: 0, hardExcluded };
  if (tracked.length === 0) return { pAllAvailable: prior, hardExcluded };

  const index = new Map(tracked.map((t, i) => [t.id, i]));
  const dates = [...new Set(input.exposures.map((e) => e.localDate))].sort();
  // State: unreported-wear count per tracked garment, capped at its clean quantity (cap = unavailable).
  let states = new Map<string, { counts: number[]; p: number }>();
  states.set(tracked.map(() => 0).join(","), { counts: tracked.map(() => 0), p: 1 });

  for (const date of dates) {
    // Distribution over which tracked garments were worn that date (bitmask), combining independent sets.
    let masks = new Map<number, number>([[0, 1]]);
    for (const set of input.exposures.filter((e) => e.localDate === date)) {
      const setMasks = new Map<number, number>();
      let used = 0;
      for (const o of exposureOutcomes(set, input.params)) {
        let mask = 0;
        for (const id of o.garmentIds) {
          const i = index.get(id);
          if (i !== undefined && !(tracked[i]!.cutoff && date < tracked[i]!.cutoff!)) mask |= 1 << i;
        }
        setMasks.set(mask, (setMasks.get(mask) ?? 0) + o.probability);
        used += o.probability;
      }
      setMasks.set(0, (setMasks.get(0) ?? 0) + Math.max(0, 1 - used));
      const next = new Map<number, number>();
      for (const [m1, p1] of masks) for (const [m2, p2] of setMasks) next.set(m1 | m2, (next.get(m1 | m2) ?? 0) + p1 * p2);
      masks = next;
    }
    const nextStates = new Map<string, { counts: number[]; p: number }>();
    for (const st of states.values()) {
      for (const [mask, pm] of masks) {
        if (pm === 0) continue;
        const counts = st.counts.map((c, i) => Math.min(tracked[i]!.clean, c + ((mask >> i) & 1)));
        const key = counts.join(",");
        const existing = nextStates.get(key);
        if (existing) existing.p += st.p * pm;
        else nextStates.set(key, { counts, p: st.p * pm });
      }
    }
    states = nextStates;
  }
  let ok = 0;
  for (const st of states.values()) if (st.counts.every((c, i) => c < tracked[i]!.clean)) ok += st.p;
  return { pAllAvailable: Math.max(0, Math.min(1, ok * prior)), hardExcluded };
}

/**
 * How the clean units at home are known. An inferred state is never called an observation (specification
 * section 5: "Do not falsely record an observed pickup or return"): units the weekly baseline counted
 * clean are named as that estimate, imported stock as the ledger's balance (its own caveat follows), and
 * only what a wash, return, count or arrival established is called observed.
 */
function cleanBasis(g: EstimatorGarment, clean: number): string {
  const units = `${clean} clean unit${clean === 1 ? "" : "s"} at home`;
  const inferred = g.careChannel === "none" ? 0 : Math.min(clean, Math.max(0, g.cleanInferred ?? 0));
  if (inferred > 0) {
    const which = inferred === clean ? "" : `${inferred} of them `;
    return `${units}; ${which}counted clean by the weekly laundry baseline, an estimate: no wash or return was reported`;
  }
  if (g.careChannel !== "none" && (g.importCleanlinessUnverified || g.importNeverObserved)) return `${units} (ledger balance as imported; no wash or return has been reported for it)`;
  return `${units} (observed ledger balance)`;
}

export function estimateGarment(input: EstimatorInput, g: EstimatorGarment): GarmentAvailability {
  const { reasons, restrictionIds } = hardReasons(g, input.restrictions);
  const hardExcluded = reasons.length > 0;
  const clean = cleanAtHome(g);
  const inferredWear = g.careChannel === "none" ? [] : inferredWearByDate(g.garmentId, input.exposures, input.params, input.cutoffDateByChannel?.[g.careChannel]);
  const basis: string[] = [];
  let pAvailable = 0;
  let status: GarmentAvailability["status"] = "unavailable";
  if (!hardExcluded) {
    pAvailable = jointAvailability(input, [g.garmentId]).pAllAvailable;
    basis.push(cleanBasis(g, clean));
    if (g.careChannel !== "none" && g.importCleanlinessUnverified) {
      reasons.push("import_cleanliness_unverified");
      basis.push("cleanliness imported without an observation; treated as an estimate until a laundry baseline or owner report");
    }
    if (inferredWear.length > 0) {
      reasons.push("estimated_possibly_worn");
      basis.push(`offered on ${inferredWear.length} unreported day${inferredWear.length === 1 ? "" : "s"} since the last laundry baseline`);
    }
    const conditional = g.planningPolicy === "occasional" || g.attributes.indoorOnly === true;
    if (g.planningPolicy === "occasional") reasons.push("planning_occasional");
    if (g.attributes.indoorOnly === true) reasons.push("indoor_only");
    status = conditional ? "conditional" : pAvailable < 1 ? "estimated" : "available";
  } else {
    basis.push(`excluded: ${reasons.join(", ")}`);
  }
  return {
    garmentId: g.garmentId,
    status,
    hardExcluded,
    pAvailable,
    inferredWear,
    reasons,
    restrictionIds,
    acquisition: g.acquisition,
    planningPolicy: g.planningPolicy,
    balances: g.balances.map((b) => ({ bucket: b.bucket, ref: b.ref, quantity: b.quantity })),
    cleanObserved: clean,
    basis,
  };
}

export function estimateAll(input: EstimatorInput): GarmentAvailability[] {
  return input.garments.map((g) => estimateGarment(input, g));
}

/**
 * Selection prior learned ONLY from observed choices: posterior mean of a Beta prior centred on the
 * hypothesis. With no observations it returns the hypothesis unchanged.
 */
export function learnedBoardUsePrior(hypothesis: number, observed: { boardsOffered: number; boardsChosenFrom: number }, priorStrength = 10): number {
  const alpha = hypothesis * priorStrength + observed.boardsChosenFrom;
  const beta = (1 - hypothesis) * priorStrength + Math.max(0, observed.boardsOffered - observed.boardsChosenFrom);
  return alpha / (alpha + beta);
}

export const ESTIMATOR_MODEL_VERSION = AVAILABILITY_MODEL_VERSION;
