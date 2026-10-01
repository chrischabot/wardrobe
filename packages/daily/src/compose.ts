/**
 * Board composition (specification section 7, steps 1-6).
 *
 * Candidates come from three sources, all validated by the same code before they can be offered:
 *   - a composition model (optional, behind the `CompositionModel` port), asked for more candidates
 *     than are displayed, by exact garment ID;
 *   - previously approved combinations (options the owner chose before), revalidated for the day;
 *   - the deterministic composer below, which is also the tested fallback when inference is
 *     unavailable or keeps failing validation.
 *
 * The deterministic composer's preferences (season words, colour relations, when a jacket is worth
 * carrying) are SOFT ranking heuristics grounded in the profile's vocabulary. They never override a
 * hard rule and they are not a claim about taste: taste is judged by people and the evaluation suite.
 */
import type { Role } from "@garderobe/contracts";
import { OutfitCandidate } from "@garderobe/contracts/ext/daily";
import type { CalendarEventContext, OutfitSlot, OutfitValidation } from "@garderobe/contracts/ext/daily";
import { jointAvailability } from "@garderobe/domain";
import { COOL_FAMILIES, NEUTRAL_FAMILIES, WARM_FAMILIES, seededUnit, type PoolGarment, type RecommendationContext } from "./model.ts";
import type { CompositionModel } from "./ports.ts";
import { EXPLORE_ADVISORY, garmentViolations, roleAccepts, validateCandidate, type ValidateOptions } from "./validate.ts";
import { renderContextData, renderContextText } from "./context-text.ts";

export interface ComposedOption {
  optionId?: string;
  slots: OutfitSlot[];
  footwearAlternatives: string[];
  reason: string;
  explanationSource: "model_verified" | "factual";
  removedClaims: string[];
  source: "model" | "deterministic" | "reserve" | "approved_combination" | "owner_swap" | "repair";
  /** Pieces the owner chose for this option himself. */
  explicitGarmentIds?: string[];
  suitsEventIds: string[];
  validation: OutfitValidation;
  jointAvailability: number;
  score: number;
}

export interface ComposeDiagnostics {
  modelProfile: string | null;
  modelAttempts: number;
  modelAccepted: number;
  modelRejected: { violations: string[] }[];
  modelError: string | null;
  approvedUsed: number;
  pairsConsidered: number;
  eligible: Record<string, number>;
}

export interface ComposeResult {
  options: ComposedOption[];
  reserves: ComposedOption[];
  requestedCount: number;
  /** One brief explanation outside the outfit copy when fewer valid outfits exist than requested. */
  notice: string | null;
  suitabilityLine: string | null;
  diagnostics: ComposeDiagnostics;
}

export interface ComposeOptions {
  count?: number;
  reserveCount?: number;
  model?: CompositionModel | null;
  maxModelAttempts?: number;
  /** Wall-clock budget (ms) for the model part of this composition; it bounds every attempt together. */
  modelBudgetMs?: number;
  deadlineAtMs?: number;
  /** Existing options kept exactly as they are (replenishment keeps valid options usable). */
  keep?: ComposedOption[];
  /** Slots fixed by the owner (Studio locks, "find something that works with this"). */
  locked?: OutfitSlot[];
  /** Previously chosen combinations to revalidate for the day. */
  approved?: { slots: OutfitSlot[]; footwearAlternatives: string[]; reason: string }[];
  validate?: ValidateOptions;
  /** Shirts a rebuilt option must not come back with. */
  avoidTops?: string[];
}

const SATURATED = new Set(["red", "pink", "yellow", "green"]);

/* ------------------------------------------------------------------ */
/* Soft preferences                                                     */
/* ------------------------------------------------------------------ */

/** Soft comfort band read from the sheet's season words. Numbers here rank; they never reject. */
function seasonBand(note: string | null): { lo: number | null; hi: number | null } {
  const s = (note ?? "").toLowerCase();
  if (!s) return { lo: null, hi: null };
  if (s.includes("winter")) return { lo: null, hi: 10 };
  if (s.includes("cool/cold")) return { lo: null, hi: 14 };
  if (s === "cold") return { lo: null, hi: 12 };
  if (s === "cool") return { lo: null, hi: 17 };
  if (s.includes("transitional")) return { lo: 12, hi: 22 };
  if (s.includes("warm-leaning")) return { lo: 16, hi: null };
  if (s.includes("warm")) return { lo: 20, hi: null };
  if (s.startsWith("hot")) return { lo: 25, hi: null };
  if (s.includes("all-but-coldest")) return { lo: 8, hi: null };
  return { lo: null, hi: null };
}

function seasonFit(g: PoolGarment, temperature: number | null): number {
  const band = seasonBand(g.seasonNote);
  if (temperature === null) return band.lo === null && band.hi === null ? 0.5 : 0; // unknown weather: prefer all-season pieces
  let penalty = 0;
  if (band.lo !== null && temperature < band.lo) penalty = band.lo - temperature;
  if (band.hi !== null && temperature > band.hi) penalty = temperature - band.hi;
  return penalty === 0 ? 0.5 : -Math.min(8, penalty * 0.9);
}

function rotation(ctx: RecommendationContext, g: PoolGarment): number {
  let score = g.availability.pAvailable * 2;
  if (g.wornDates.length > 0) score -= 1; // worn inside the fortnight (the hard 7-day check is the validator's)
  if (ctx.futureSelections.some((s) => s.garmentIds.includes(g.garmentId))) score -= 2; // already planned this week
  for (const c of ctx.comfort) {
    if (!c.garmentIds.includes(g.garmentId) || c.kind === "positive") continue;
    // Pain outranks every styling score: the piece is reached for only when nothing else is eligible.
    // Other discomfort is scoped to its occasion and only nudges the ranking; it is never a ban.
    score -= c.pain ? 1000 : 1.5;
  }
  const shown = ctx.recentlyShown.filter((s) => s.topId === g.garmentId || s.bottomId === g.garmentId || s.footwearId === g.garmentId).length;
  return score - Math.min(3, shown * 1.5);
}

function pairScore(ctx: RecommendationContext, top: PoolGarment, bottom: PoolGarment): number {
  let score = 0;
  const a = top.colourFamily;
  const b = bottom.colourFamily;
  if (a === b && NEUTRAL_FAMILIES.has(a)) score -= 1.2; // the drone
  else if (a === b) score += 0.4; // one colour at two depths
  if ((WARM_FAMILIES.has(a) && COOL_FAMILIES.has(b)) || (COOL_FAMILIES.has(a) && WARM_FAMILIES.has(b))) score += 1.4; // warm against cool
  if (SATURATED.has(a) && NEUTRAL_FAMILIES.has(b)) score += 1.1; // one saturated voice in a calm frame
  if (SATURATED.has(a) && SATURATED.has(b) && a !== b) score -= 1.6; // the clown
  if (ctx.recentlyShown.some((s) => s.topId === top.garmentId && s.bottomId === bottom.garmentId)) score -= 1.5;
  return score;
}

/** Garments of a role that pass every single-garment check for the day (or are wearable-in-principle in Explore). */
export function eligibleFor(ctx: RecommendationContext, role: Role, opts: ValidateOptions = {}): PoolGarment[] {
  const out: PoolGarment[] = [];
  for (const g of ctx.garments.values()) {
    if (!roleAccepts(g, role)) continue;
    const own = garmentViolations(ctx, g.garmentId, role, opts).filter((x) => x.severity === "blocking" && !(ctx.mode === "explore" && EXPLORE_ADVISORY.has(x.code)));
    if (own.length === 0) out.push(g);
  }
  return out.sort((x, y) => x.garmentId.localeCompare(y.garmentId));
}

/* ------------------------------------------------------------------ */
/* Occasions                                                            */
/* ------------------------------------------------------------------ */

function suits(occasion: "smart" | "practical" | "none", top: PoolGarment | undefined, bottom: PoolGarment | undefined): boolean {
  if (!top || !bottom) return false;
  const bottomText = `${bottom.name} ${bottom.fabric ?? ""}`.toLowerCase();
  const casualBottom = /denim|fatigue|drawstring|5-pocket/.test(bottomText);
  if (occasion === "smart") return top.category === "shirt" && !/plaid|flannel|denim/.test(`${top.name} ${top.fabric ?? ""}`.toLowerCase()) && !casualBottom;
  if (occasion === "practical") return casualBottom || /cord|twill|chino/.test(bottomText);
  return false;
}

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

function cleanTitle(title: string): string {
  const t = title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

/* ------------------------------------------------------------------ */
/* Building one outfit around a top and a bottom                        */
/* ------------------------------------------------------------------ */

interface BoardUsage {
  footwear: Map<string, number>;
  outers: Map<string, number>;
  socks: Map<string, number>;
  index: number;
}

interface Pools {
  tops: PoolGarment[];
  bottoms: PoolGarment[];
  outers: PoolGarment[];
  footwear: PoolGarment[];
  socks: PoolGarment[];
  belts: PoolGarment[];
  neckwear: PoolGarment[];
}

function pick<T extends PoolGarment>(list: T[], score: (g: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const g of list) {
    const s = score(g);
    if (s > bestScore) {
      best = g;
      bestScore = s;
    }
  }
  return best;
}

function jacketWanted(ctx: RecommendationContext, index: number, smart: boolean): boolean {
  const c = ctx.conditions;
  const wet = (c.maxPrecipitationProbabilityPct !== null && c.maxPrecipitationProbabilityPct >= 50) || (c.maxWindGustKmh !== null && c.maxWindGustKmh >= 50);
  if (c.departureC === null) return index % 2 === 0; // unknown: some options carry a layer that can come off
  if (c.departureC < 17) return true;
  if (c.departureC <= 21) return wet || smart || index % 2 === 0;
  return false;
}

function chooseOuter(ctx: RecommendationContext, pools: Pools, top: PoolGarment, bottom: PoolGarment, usage: BoardUsage, seed: string): PoolGarment | undefined {
  const band = ctx.rules.jacketBand;
  const t = ctx.conditions.departureC;
  // Inside the 14-16 C band - or when the outdoor temperature is unknown and the band cannot be ruled
  // out - a jacket only goes over the required shirt; any other shirt simply goes without a jacket.
  if (band && top.attributes.fabricClass !== band.requiredShirtFabricClass && (t === null || (t >= band.minC && t <= band.maxC))) return undefined;
  return pick(pools.outers, (g) => {
    let s = seasonFit(g, t) * 1.5 + rotation(ctx, g) - (usage.outers.get(g.garmentId) ?? 0) * 2.5 + seededUnit(seed, g.garmentId) * 0.6;
    if (NEUTRAL_FAMILIES.has(g.colourFamily) && g.colourFamily === top.colourFamily && g.colourFamily === bottom.colourFamily) s -= 3; // same neutral three times
    if (g.colourFamily === bottom.colourFamily) s -= 0.6;
    if (g.attributes.fitNote) s -= 0.5;
    return s;
  });
}

function buildOutfit(ctx: RecommendationContext, pools: Pools, top: PoolGarment, bottom: PoolGarment, usage: BoardUsage, smart: boolean, locked: Map<Role, PoolGarment>): { slots: OutfitSlot[]; footwearAlternatives: string[] } | null {
  const seed = `${ctx.userId}|${ctx.localDate}|${top.garmentId}|${bottom.garmentId}`;
  const slots: OutfitSlot[] = [];
  const outer = locked.get("outer") ?? (jacketWanted(ctx, usage.index, smart) ? chooseOuter(ctx, pools, top, bottom, usage, seed) : undefined);
  if (outer) slots.push({ role: "outer", garmentId: outer.garmentId });
  slots.push({ role: "top", garmentId: top.garmentId }, { role: "bottom", garmentId: bottom.garmentId });

  const upper = new Set([top.colourFamily, outer?.colourFamily].filter(Boolean));
  const belt = locked.get("belt") ?? pick(pools.belts, (g) => (g.colourFamily === "brown" ? 0.5 : 0) + (upper.has(g.colourFamily) ? 0.8 : 0) + (g.colourFamily === "black" && (bottom.colourFamily === "grey" || bottom.colourFamily === "black") ? 1.2 : 0) + seededUnit(seed, g.garmentId) * 0.2);
  if (belt) slots.push({ role: "belt", garmentId: belt.garmentId });

  // The belt line's optional flourish, appropriate to the day: a scarf for a cold start, a knit tie for a smart occasion.
  const flourish = locked.get("neckwear") ?? pick(
    pools.neckwear.filter((g) => (g.category === "scarf" ? ctx.conditions.departureC !== null && ctx.conditions.departureC <= 10 : smart && top.category === "shirt")),
    (g) => seasonFit(g, ctx.conditions.departureC) + (g.colourFamily !== top.colourFamily ? 0.5 : 0) + seededUnit(seed, g.garmentId) * 0.5,
  );
  if (flourish) slots.push({ role: "neckwear", garmentId: flourish.garmentId });

  const footwearScore = (g: PoolGarment) =>
    rotation(ctx, g) - (usage.footwear.get(g.garmentId) ?? 0) * 1.5 + (upper.has(g.colourFamily) ? 0.8 : 0) - (g.colourFamily === bottom.colourFamily ? 0.3 : 0) + (g.attributes.breakingIn ? -0.5 : 0) + seededUnit(seed, g.garmentId) * 0.6;
  const paired = ctx.rules.pairedFootwear?.inForce === true;
  const sneakers = pools.footwear.filter((g) => g.attributes.footwearKind === "sneaker");
  const footwear = locked.get("footwear") ?? pick(paired && sneakers.length > 0 ? sneakers : pools.footwear, footwearScore);
  if (!footwear) return null;
  const footwearAlternatives: string[] = [];
  if (paired) {
    const otherKind = footwear.attributes.footwearKind === "welted" ? "sneaker" : "welted";
    const other = pick(pools.footwear.filter((g) => g.attributes.footwearKind === otherKind && g.garmentId !== footwear.garmentId), footwearScore);
    if (other) footwearAlternatives.push(other.garmentId);
  }

  // The sock as the quiet rhyme or the single flash: echo a colour from higher up, not the trouser.
  const calm = !SATURATED.has(top.colourFamily) && !(outer && SATURATED.has(outer.colourFamily));
  const peak = ctx.conditions.peakC;
  const socks = locked.get("socks") ?? pick(pools.socks, (g) => {
    let s = g.availability.pAvailable * 2 + seasonFit(g, peak) - (usage.socks.get(g.garmentId) ?? 0) * (g.availability.cleanObserved > 1 ? 0.4 : 1.5) + seededUnit(seed, g.garmentId) * 0.5;
    if (ctx.rules.defaultSockFabricClass && g.attributes.fabricClass === ctx.rules.defaultSockFabricClass) s += 2;
    if (upper.has(g.colourFamily) && g.colourFamily !== bottom.colourFamily) s += 2;
    if (g.colourFamily === bottom.colourFamily) s -= 1;
    if (calm && SATURATED.has(g.colourFamily)) s += 0.9;
    return s;
  });
  if (!socks) return null;
  slots.push({ role: "socks", garmentId: socks.garmentId }, { role: "footwear", garmentId: footwear.garmentId });
  for (const [role, g] of locked) if (!slots.some((s) => s.role === role)) slots.push({ role, garmentId: g.garmentId });
  return { slots, footwearAlternatives };
}

/* ------------------------------------------------------------------ */
/* Explanations from records                                            */
/* ------------------------------------------------------------------ */

const lower = (name: string): string => name;

/**
 * A factual explanation assembled from ledger names and relations the code computed. It invents no
 * styling rationale: every clause states something checkable about the recorded pieces or the forecast.
 */
export function factualReason(ctx: RecommendationContext, slots: OutfitSlot[]): string {
  const g = (role: Role) => {
    const id = slots.find((s) => s.role === role)?.garmentId;
    return id ? ctx.garments.get(id) : undefined;
  };
  const top = g("top");
  const bottom = g("bottom");
  const outer = g("outer");
  const socks = g("socks");
  const parts: string[] = [];
  if (top && bottom) {
    const a = top.colourFamily;
    const b = bottom.colourFamily;
    if (a !== "unknown" && b !== "unknown") {
      if ((WARM_FAMILIES.has(a) && COOL_FAMILIES.has(b)) || (COOL_FAMILIES.has(a) && WARM_FAMILIES.has(b))) parts.push(`Warm against cool: ${lower(top.name)} over ${lower(bottom.name)}`);
      else if (SATURATED.has(a) && NEUTRAL_FAMILIES.has(b)) parts.push(`One saturated voice in a calm frame: ${lower(top.name)} over ${lower(bottom.name)}`);
      else if (a === b) parts.push(`One colour at two depths: ${lower(top.name)} over ${lower(bottom.name)}`);
      else parts.push(`${top.name} over ${bottom.name}`);
    } else parts.push(`${top.name} over ${bottom.name}`);

  }
  if (socks && top) {
    if (socks.colourFamily !== "unknown" && (socks.colourFamily === top.colourFamily || socks.colourFamily === outer?.colourFamily)) parts.push("the sock echoes a colour from higher up");
    else if (SATURATED.has(socks.colourFamily)) parts.push("the sock is the single flash");
  }
  const c = ctx.conditions;
  if (c.peakC !== null) {
    if (outer && c.departureC !== null) parts.push(`dressed for the ${Math.round(c.peakC)} °C peak, with ${outer.name} for the ${Math.round(c.departureC)} °C start`);
    else parts.push(`dressed for the ${Math.round(c.peakC)} °C peak`);
  }
  const text = parts.join("; ");
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : "A complete outfit from available pieces.";
}

/** Check a model's explanation against the records it cites; unsupported claims are removed and the prose replaced. */
export function verifyExplanation(ctx: RecommendationContext, candidate: OutfitCandidate): { reason: string; explanationSource: "model_verified" | "factual"; removedClaims: string[] } {
  const removed: string[] = [];
  const ids = new Set(candidate.slots.map((s) => s.garmentId));
  for (const claim of candidate.claims) {
    const g = ids.has(claim.garmentId) ? ctx.garments.get(claim.garmentId) : undefined;
    const record = g ? { name: g.name, colour: g.colour, fabric: g.fabric, maker: g.maker, category: g.category, pattern: g.pattern }[claim.attribute] : null;
    const supported = !!record && record.toLowerCase().includes(claim.value.toLowerCase());
    if (!supported) removed.push(`${claim.attribute}: ${claim.value}`);
  }
  const prose = (candidate.principle ?? "").replace(/\s+/g, " ").trim();
  // Prose carrying item codes, percentages, links or diagnostics is never published.
  const unsafe = prose.length === 0 || prose.length > 320 || /(gmt_[0-9a-f]{6,}|\d\s?%|https?:|[<>{}])/i.test(prose);
  if (removed.length > 0 || unsafe) return { reason: factualReason(ctx, candidate.slots), explanationSource: "factual", removedClaims: removed };
  return { reason: prose, explanationSource: "model_verified", removedClaims: [] };
}

/* ------------------------------------------------------------------ */
/* Composition                                                          */
/* ------------------------------------------------------------------ */

function slotOf(option: { slots: OutfitSlot[] }, role: Role): string | null {
  return option.slots.find((s) => s.role === role)?.garmentId ?? null;
}

function toComposed(ctx: RecommendationContext, c: { slots: OutfitSlot[]; footwearAlternatives: string[] }, validation: OutfitValidation, extra: Pick<ComposedOption, "reason" | "explanationSource" | "removedClaims" | "source" | "score"> & { optionId?: string; suitsEventIds?: string[] }): ComposedOption {
  return {
    ...(extra.optionId ? { optionId: extra.optionId } : {}),
    slots: c.slots,
    footwearAlternatives: c.footwearAlternatives,
    reason: extra.reason,
    explanationSource: extra.explanationSource,
    removedClaims: extra.removedClaims,
    source: extra.source,
    suitsEventIds: extra.suitsEventIds ?? [],
    validation,
    jointAvailability: jointAvailability(ctx.estimator, c.slots.map((s) => s.garmentId)).pAllAvailable,
    score: extra.score,
  };
}

export function relevantCalendarEvents(ctx: RecommendationContext): CalendarEventContext[] {
  if (!ctx.calendar || (ctx.calendar.status !== "ok" && ctx.calendar.status !== "stale")) return [];
  return ctx.calendar.events.filter((e) => e.weight !== "none" && e.inferredOccasion !== "none" && !e.cancelled);
}

export async function composeBoard(ctx: RecommendationContext, opts: ComposeOptions = {}): Promise<ComposeResult> {
  const validateOpts: ValidateOptions = { requirePairedFootwear: true, ...(opts.validate ?? {}) };
  const requestedCount = ctx.brief.requestedCount ?? opts.count ?? ctx.settings.delivery.defaultOptionCount;
  const reserveCount = opts.reserveCount ?? ctx.daily.reserveCount;
  const locked = new Map<Role, PoolGarment>();
  for (const s of opts.locked ?? []) {
    const g = ctx.garments.get(s.garmentId);
    if (g) locked.set(s.role, g);
  }

  const pools: Pools = {
    tops: eligibleFor(ctx, "top", validateOpts),
    bottoms: eligibleFor(ctx, "bottom", validateOpts),
    outers: eligibleFor(ctx, "outer", validateOpts),
    footwear: eligibleFor(ctx, "footwear", validateOpts),
    socks: eligibleFor(ctx, "socks", validateOpts),
    belts: eligibleFor(ctx, "belt", validateOpts),
    neckwear: eligibleFor(ctx, "neckwear", validateOpts),
  };
  const diagnostics: ComposeDiagnostics = {
    modelProfile: opts.model?.profile ?? null,
    modelAttempts: 0,
    modelAccepted: 0,
    modelRejected: [],
    modelError: null,
    approvedUsed: 0,
    pairsConsidered: 0,
    eligible: { top: pools.tops.length, bottom: pools.bottoms.length, outer: pools.outers.length, footwear: pools.footwear.length, socks: pools.socks.length, belt: pools.belts.length },
  };

  const pools_ = pools;
  const events = relevantCalendarEvents(ctx);
  const primaryEvent = events.find((e) => e.weight === "full") ?? events[0];
  const occasion = primaryEvent?.inferredOccasion ?? "none";
  const suitsEvent = (o: { slots: OutfitSlot[] }) => (primaryEvent ? suits(occasion, ctx.garments.get(slotOf(o, "top") ?? ""), ctx.garments.get(slotOf(o, "bottom") ?? "")) : false);

  // --- Candidate pool, best first ------------------------------------------------------------
  const candidates: ComposedOption[] = [];
  const keyOf = (o: { slots: OutfitSlot[] }) => o.slots.map((s) => `${s.role}:${s.garmentId}`).sort().join("|");
  const seenKeys = new Set<string>((opts.keep ?? []).map(keyOf));
  const add = (c: ComposedOption) => {
    const key = keyOf(c);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    candidates.push(c);
  };

  // 1. The composition model, asked for more than will be shown; rejected candidates go back for repair
  //    within a bounded budget, then the fallback below takes over.
  if (opts.model) {
    const want = requestedCount + reserveCount + 2;
    const maxAttempts = opts.maxModelAttempts ?? 2;
    const rejections: { candidate: OutfitCandidate; violations: string[] }[] = [];
    const contextText = renderContextText(ctx);
    const contextData = renderContextData(ctx);
    let accepted = 0;
    // The inference budget is wall-clock: a slow or hung model cannot hold the morning board. When it
    // runs out the attempt is abandoned and the deterministic composer fills the board.
    const budgetMs = Math.max(0, opts.modelBudgetMs ?? 120_000);
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= maxAttempts && accepted < want; attempt++) {
      const remaining = budgetMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        diagnostics.modelError = diagnostics.modelError ?? "the inference budget for this board was used up";
        break;
      }
      diagnostics.modelAttempts = attempt;
      let proposals: unknown[];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const call = opts.model.propose({ localDate: ctx.localDate, count: want, contextText, contextData, rejections: [...rejections], deadlineAtMs: (opts.deadlineAtMs ?? ctx.nowMs + budgetMs) });
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("the model did not answer within the inference budget for this board")), remaining);
        });
        proposals = await Promise.race([call, timeout]);
      } catch (e) {
        diagnostics.modelError = String((e as Error)?.message ?? e).slice(0, 200);
        break;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!Array.isArray(proposals)) {
        diagnostics.modelError = "the model did not return a list of candidates";
        break;
      }
      for (const raw of proposals.slice(0, 24)) {
        const parsed = OutfitCandidate.safeParse(raw);
        if (!parsed.success) {
          diagnostics.modelRejected.push({ violations: ["malformed candidate (garment IDs and structured roles are required)"] });
          continue;
        }
        const candidate = parsed.data;
        const validation = validateCandidate(ctx, candidate, validateOpts);
        if (!validation.valid) {
          const violations = validation.violations.filter((x) => x.severity === "blocking").map((x) => `${x.code}: ${x.message}`);
          diagnostics.modelRejected.push({ violations });
          rejections.push({ candidate, violations });
          continue;
        }
        const explained = verifyExplanation(ctx, candidate);
        accepted++;
        add(toComposed(ctx, candidate, validation, { ...explained, source: "model", score: 100 - accepted }));
      }
    }
    diagnostics.modelAccepted = accepted;
  }

  // 2. Previously approved combinations, revalidated for this day, with their stored explanation.
  for (const a of opts.approved ?? []) {
    const validation = validateCandidate(ctx, a, validateOpts);
    if (!validation.valid) continue;
    diagnostics.approvedUsed++;
    add(toComposed(ctx, a, validation, { reason: a.reason, explanationSource: "factual", removedClaims: [], source: "approved_combination", score: 50 - diagnostics.approvedUsed }));
  }

  // 3. The deterministic composer.
  const tops = locked.has("top") ? [locked.get("top")!] : pools.tops;
  const bottoms = locked.has("bottom") ? [locked.get("bottom")!] : pools.bottoms;
  const peak = ctx.conditions.peakC;
  const pairs: { top: PoolGarment; bottom: PoolGarment; score: number }[] = [];
  for (const top of tops) {
    const topScore = rotation(ctx, top) + seasonFit(top, peak) * 1.5;
    for (const bottom of bottoms) {
      const score = topScore + rotation(ctx, bottom) + seasonFit(bottom, peak) * 1.5 + pairScore(ctx, top, bottom) + seededUnit(ctx.userId, ctx.localDate, top.garmentId, bottom.garmentId) * 1.2;
      pairs.push({ top, bottom, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.top.garmentId.localeCompare(b.top.garmentId) || a.bottom.garmentId.localeCompare(b.bottom.garmentId));
  diagnostics.pairsConsidered = pairs.length;

  // --- Selection ------------------------------------------------------------------------------
  const chosen: ComposedOption[] = [...(opts.keep ?? [])];
  const usage: BoardUsage = { footwear: new Map(), outers: new Map(), socks: new Map(), index: 0 };
  const usedTops = new Set<string>();
  const usedBottoms = new Set<string>();
  const note = (o: ComposedOption) => {
    const bump = (m: Map<string, number>, id: string | null) => id && m.set(id, (m.get(id) ?? 0) + 1);
    bump(usage.footwear, slotOf(o, "footwear"));
    bump(usage.outers, slotOf(o, "outer"));
    bump(usage.socks, slotOf(o, "socks"));
    const t = slotOf(o, "top");
    const b = slotOf(o, "bottom");
    if (t) usedTops.add(t);
    if (b) usedBottoms.add(b);
    usage.index++;
  };
  for (const o of chosen) note(o);
  for (const id of opts.avoidTops ?? []) usedTops.add(id);

  const topLocked = locked.has("top");
  const bottomLocked = locked.has("bottom");
  const accept = (o: { slots: OutfitSlot[] }, distinctBottoms: boolean): boolean => {
    const t = slotOf(o, "top");
    const b = slotOf(o, "bottom");
    if (!topLocked && t && usedTops.has(t)) return false; // never the same shirt twice on a board
    if (!bottomLocked && distinctBottoms && b && usedBottoms.has(b)) return false;
    return true;
  };

  const total = requestedCount + reserveCount;
  const majority = primaryEvent ? (ctx.brief.occasionOnly ? requestedCount : Math.min(requestedCount, Math.floor(requestedCount / 2) + 1)) : 0;
  const suitableCount = () => chosen.slice(0, requestedCount).filter(suitsEvent).length;

  // Walk ready candidates (model, approved) and lazily built deterministic outfits in score order.
  const fill = (target: number, distinctBottoms: boolean, requireSuitable: boolean, excludeSuitable = false) => {
    for (const c of candidates) {
      if (chosen.length >= target) return;
      if (chosen.includes(c) || !accept(c, distinctBottoms)) continue;
      if (requireSuitable && !suitsEvent(c)) continue;
      chosen.push(c);
      note(c);
    }
    for (const p of pairs) {
      if (chosen.length >= target) return;
      const probe = { slots: [{ role: "top" as const, garmentId: p.top.garmentId }, { role: "bottom" as const, garmentId: p.bottom.garmentId }] };
      if (!accept(probe, distinctBottoms)) continue;
      const suitable = primaryEvent ? suits(occasion, p.top, p.bottom) : false;
      if (requireSuitable && !suitable) continue;
      if (excludeSuitable && suitable) continue;
      const built = buildOutfit(ctx, pools, p.top, p.bottom, usage, suitable && occasion === "smart", locked);
      if (!built) continue;
      const key = keyOf(built);
      if (seenKeys.has(key)) continue;
      let validation = validateCandidate(ctx, built, validateOpts);
      if (!validation.valid && built.slots.some((s) => s.role === "outer") && !locked.has("outer")) {
        // A layer that does not survive the combination check is dropped rather than the outfit.
        built.slots = built.slots.filter((s) => s.role !== "outer");
        validation = validateCandidate(ctx, built, validateOpts);
      }
      if (!validation.valid) continue;
      seenKeys.add(key);
      const option = toComposed(ctx, built, validation, { reason: factualReason(ctx, built.slots), explanationSource: "factual", removedClaims: [], source: "deterministic", score: p.score });
      chosen.push(option);
      note(option);
    }
  };

  if (majority > 0) {
    // A relevant event shapes a proportionate majority of the board, not all of it.
    for (const distinct of [true, false]) {
      const before = chosen.length;
      const target = Math.min(requestedCount, chosen.length + Math.max(0, majority - suitableCount()));
      if (target > before) fill(target, distinct, true);
    }
  }
  // Whole-board constraint only on an explicit request; otherwise the remaining options stay open.
  const restRequireSuitable = !!primaryEvent && ctx.brief.occasionOnly;
  for (const distinct of [true, false]) {
    // Remaining places prefer useful alternatives for the rest of the day when an event took its share.
    if (primaryEvent && !restRequireSuitable) fill(requestedCount, distinct, false, true);
    fill(requestedCount, distinct, restRequireSuitable);
  }
  for (const distinct of [true, false]) fill(total, distinct, false);

  const options = chosen.slice(0, requestedCount);
  const reserves = chosen.slice(requestedCount, total).map((o) => ({ ...o, source: o.source === "deterministic" ? ("reserve" as const) : o.source }));
  for (const o of options) if (primaryEvent && suitsEvent(o) && o.suitsEventIds.length === 0) o.suitsEventIds = [primaryEvent.eventId];

  let notice: string | null = null;
  if (options.length < requestedCount) {
    // A board never shows the same shirt twice, so shirts bound the count; an empty pool of anything
    // required bounds it at zero.
    const pools = [["shirts", tops.length], ["trousers", bottoms.length], ["pairs of shoes", pools_.footwear.length], ["pairs of socks", pools_.socks.length]] as const;
    const empty = pools.find((p) => p[1] === 0);
    const word = options.length === 1 ? "outfit" : "outfits";
    const count = NUMBER_WORDS[options.length] ?? String(options.length);
    if (options.length === 0) notice = empty ? `No complete outfit is available for this day: ${empty[1]} eligible ${empty[0]}.` : "No complete outfit is available for this day: no eligible combination passes every rule.";
    else if (tops.length <= options.length) notice = `${count} valid ${word} today instead of ${requestedCount}: only ${tops.length} eligible shirts.`;
    else notice = `${count} valid ${word} today instead of ${requestedCount}: no further combination of eligible pieces passes every rule.`;
  }
  let suitabilityLine: string | null = null;
  if (primaryEvent) {
    const n = options.filter((o) => o.suitsEventIds.length > 0).length;
    if (n > 0) suitabilityLine = `${n === options.length && n > 1 ? "All" : (NUMBER_WORDS[n] ?? n)} ${n === 1 ? "option works" : "options work"} for “${cleanTitle(primaryEvent.title)}”.`;
  }
  return { options, reserves, requestedCount, notice, suitabilityLine, diagnostics };
}

/**
 * The sneaker + welted format (profile section 8.4): when it is in force and an outfit names only one
 * kind, add an eligible shoe of the other kind as a footwear alternative. Every piece of the outfit
 * stays as it is, so an option the owner has already seen - or chosen - keeps its identity when the
 * format comes into force (the moment he reports his feet have healed). Returns the candidate unchanged
 * when the format is not in force, the pair is already named, or nothing of the missing kind is eligible.
 */
export function withPairedFootwear(
  ctx: RecommendationContext,
  candidate: { slots: OutfitSlot[]; footwearAlternatives: string[] },
  opts: { validate?: ValidateOptions; usage?: Map<string, number> } = {},
): { slots: OutfitSlot[]; footwearAlternatives: string[]; added: string[] } {
  const unchanged = { slots: candidate.slots, footwearAlternatives: candidate.footwearAlternatives, added: [] as string[] };
  if (ctx.rules.pairedFootwear?.inForce !== true) return unchanged;
  const main = ctx.garments.get(candidate.slots.find((s) => s.role === "footwear")?.garmentId ?? "");
  if (!main) return unchanged;
  const named = [main, ...candidate.footwearAlternatives.map((id) => ctx.garments.get(id)).filter((g): g is PoolGarment => !!g)];
  const kinds = new Set(named.map((g) => String(g.attributes.footwearKind ?? "")));
  const missing = ["sneaker", "welted"].filter((k) => !kinds.has(k));
  if (missing.length === 0) return unchanged;
  const inOutfit = new Set([...candidate.slots.map((s) => s.garmentId), ...candidate.footwearAlternatives]);
  const eligible = eligibleFor(ctx, "footwear", opts.validate ?? {}).filter((g) => !inOutfit.has(g.garmentId));
  const added: string[] = [];
  for (const kind of missing) {
    const best = eligible
      .filter((g) => g.attributes.footwearKind === kind)
      .map((g) => ({ g, score: rotation(ctx, g) - (opts.usage?.get(g.garmentId) ?? 0) * 1.5 + (g.attributes.breakingIn ? -0.5 : 0) + seededUnit(ctx.userId, ctx.localDate, "pair", g.garmentId) * 0.6 }))
      .sort((a, b) => b.score - a.score || a.g.garmentId.localeCompare(b.g.garmentId))[0];
    if (!best) continue;
    added.push(best.g.garmentId);
    opts.usage?.set(best.g.garmentId, (opts.usage.get(best.g.garmentId) ?? 0) + 1);
  }
  return added.length > 0 ? { slots: candidate.slots, footwearAlternatives: [...candidate.footwearAlternatives, ...added], added } : unchanged;
}

/**
 * Replace one slot of an outfit, keeping every other piece. Honours "never fall back to navy": a navy
 * replacement for a non-navy piece is taken only when nothing else validates.
 */
export function findReplacement(
  ctx: RecommendationContext,
  option: { slots: OutfitSlot[]; footwearAlternatives: string[] },
  role: Role,
  opts: { avoidGarmentIds?: Set<string>; validate?: ValidateOptions } = {},
): { slots: OutfitSlot[]; footwearAlternatives: string[]; validation: OutfitValidation; replacement: PoolGarment } | null {
  const validateOpts: ValidateOptions = { requirePairedFootwear: true, ...(opts.validate ?? {}) };
  const original = ctx.garments.get(slotOf(option, role) ?? "");
  const avoid = opts.avoidGarmentIds ?? new Set<string>();
  const current = new Set(option.slots.map((s) => s.garmentId));
  const others = (r: Role) => ctx.garments.get(slotOf(option, r) ?? "");
  const top = role === "top" ? undefined : others("top");
  const bottom = role === "bottom" ? undefined : others("bottom");
  const temperature = role === "outer" ? ctx.conditions.departureC : ctx.conditions.peakC;
  const ranked = eligibleFor(ctx, role, validateOpts)
    .filter((g) => !current.has(g.garmentId) && !avoid.has(g.garmentId) && !option.footwearAlternatives.includes(g.garmentId))
    .map((g) => {
      let score = rotation(ctx, g) + seasonFit(g, temperature) * 1.5 + seededUnit(ctx.userId, ctx.localDate, "swap", g.garmentId) * 0.8;
      if (role === "top" && bottom) score += pairScore(ctx, g, bottom);
      if (role === "bottom" && top) score += pairScore(ctx, top, g);
      if (original && g.attributes.fabricClass && g.attributes.fabricClass === original.attributes.fabricClass) score += 0.6; // keep the register of the piece it replaces
      if (ctx.rules.navySwap && g.colourFamily === ctx.rules.navySwap.family && original?.colourFamily !== ctx.rules.navySwap.family) score -= 50;
      return { g, score };
    })
    .sort((a, b) => b.score - a.score || a.g.garmentId.localeCompare(b.g.garmentId));
  for (const { g } of ranked) {
    const swapped = option.slots.some((s) => s.role === role) ? option.slots.map((s) => (s.role === role ? { role, garmentId: g.garmentId } : s)) : [...option.slots, { role, garmentId: g.garmentId }];
    // An option published before the paired-shoe format came into force gains its alternative here.
    const { slots, footwearAlternatives } = withPairedFootwear(ctx, { slots: swapped, footwearAlternatives: option.footwearAlternatives }, { validate: validateOpts });
    const validation = validateCandidate(ctx, { slots, footwearAlternatives }, validateOpts);
    if (validation.valid) return { slots, footwearAlternatives, validation, replacement: g };
  }
  return null;
}
