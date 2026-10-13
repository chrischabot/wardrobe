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
import { CommandError, jointAvailability } from "@garderobe/domain";
import { COOL_FAMILIES, NEUTRAL_FAMILIES, WARM_FAMILIES, neutralFamiliesOf, seededUnit, type PoolGarment, type RecommendationContext } from "./model.ts";
import { SYSTEM_BUDGET_CLOCK, type BudgetClock, type CompositionModel } from "./ports.ts";
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
  /** The clock and timer the budget is measured with (default: the real wall clock). */
  budgetClock?: BudgetClock;
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
  /**
   * Carry the optional everyday tie suggestion on the belt line (default true). A packing proposal sets
   * it false: a suggestion that is "often ignored" does not earn a place in a carry-on, so only a scarf
   * for a cold start or a tie for a smart occasion is proposed for packing.
   */
  everydayFlourish?: boolean;
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

const neutralsOf = (g: PoolGarment) => neutralFamiliesOf(g.colour || g.name);

/**
 * The owner's limit on one neutral in an outfit (profile section 5) counts every piece worn in it:
 * jacket, shirt, trousers, belt, socks and shoes. True when adding `g` to the pieces already settled
 * would take one of its neutrals over that limit.
 */
export function exceedsNeutralLimit(ctx: RecommendationContext, g: PoolGarment, settled: (PoolGarment | undefined)[]): boolean {
  const limit = ctx.rules.neutralMax;
  if (!limit) return false;
  const seen = new Set<string>([g.garmentId]);
  const others: ReturnType<typeof neutralsOf>[] = [];
  // A piece is counted once however many times a caller lists it (a locked shoe is both fixed and chosen).
  for (const s of settled) {
    if (!s || seen.has(s.garmentId)) continue;
    seen.add(s.garmentId);
    others.push(neutralsOf(s));
  }
  return neutralsOf(g).some((family) => others.filter((o) => o.includes(family)).length + 1 > limit.max);
}

/**
 * The pieces of a pool that keep the outfit within the neutral limit. The limit is a soft verdict, so
 * when every piece would break it the whole pool stands and the validator reports the advisory.
 */
function withinNeutralLimit(ctx: RecommendationContext, pool: PoolGarment[], settled: (PoolGarment | undefined)[]): PoolGarment[] {
  const kept = pool.filter((g) => !exceedsNeutralLimit(ctx, g, settled));
  return kept.length > 0 ? kept : pool;
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

function chooseOuter(ctx: RecommendationContext, pools: Pools, top: PoolGarment, bottom: PoolGarment, usage: BoardUsage, seed: string, lockedOthers: (PoolGarment | undefined)[], shoes: PoolGarment[], socks: PoolGarment[]): PoolGarment | undefined {
  const band = ctx.rules.jacketBand;
  const t = ctx.conditions.departureC;
  // Inside the 14-16 C band - or when the outdoor temperature is unknown and the band cannot be ruled
  // out - a jacket only goes over the required shirt; any other shirt simply goes without a jacket.
  if (band && top.attributes.fabricClass !== band.requiredShirtFabricClass && (t === null || (t >= band.minC && t <= band.maxC))) return undefined;
  // A jacket that would be the third piece in one neutral is passed over while another jacket is eligible.
  const within = withinNeutralLimit(ctx, pools.outers, [top, bottom, ...lockedOthers]);
  // The shoe is chosen after the jacket, so a jacket is also passed over when every shoe still to choose
  // from would then be the third piece in one neutral (a navy jacket over navy trousers with only navy
  // shoes eligible), while another jacket leaves a shoe within the limit.
  const leavesShoe = shoes.length === 0 ? within : within.filter((g) => shoes.some((f) => !exceedsNeutralLimit(ctx, f, [g, top, bottom, ...lockedOthers])));
  // Socks are chosen last and the limit counts them too (profile rule 1: socks always), so a jacket is
  // preferred that leaves a shoe AND a pair of socks within the limit: over a navy shirt with only navy
  // socks, a navy jacket would leave the sock as the third navy piece.
  const leavesShoeAndSock = socks.length === 0 ? leavesShoe : leavesShoe.filter((g) => {
    const base = [g, top, bottom, ...lockedOthers];
    const shoeChoices: (PoolGarment | undefined)[] = shoes.length === 0 ? [undefined] : shoes.filter((f) => !exceedsNeutralLimit(ctx, f, base));
    return shoeChoices.some((f) => socks.some((s) => !exceedsNeutralLimit(ctx, s, [...base, f])));
  });
  return pick(leavesShoeAndSock.length > 0 ? leavesShoeAndSock : leavesShoe.length > 0 ? leavesShoe : within, (g) => {
    let s = seasonFit(g, t) * 1.5 + rotation(ctx, g) - (usage.outers.get(g.garmentId) ?? 0) * 2.5 + seededUnit(seed, g.garmentId) * 0.6;
    if (g.colourFamily === bottom.colourFamily) s -= 0.6;
    if (g.attributes.fitNote) s -= 0.5;
    return s;
  });
}

function buildOutfit(ctx: RecommendationContext, pools: Pools, top: PoolGarment, bottom: PoolGarment, usage: BoardUsage, smart: boolean, locked: Map<Role, PoolGarment>, everydayFlourish: boolean): { slots: OutfitSlot[]; footwearAlternatives: string[] } | null {
  const seed = `${ctx.userId}|${ctx.localDate}|${top.garmentId}|${bottom.garmentId}`;
  const slots: OutfitSlot[] = [];
  // Pieces the owner fixed count towards the neutral limit before anything is chosen around them.
  const fixed = [locked.get("footwear"), locked.get("belt"), locked.get("socks"), locked.get("mid_layer")];
  const paired = ctx.rules.pairedFootwear?.inForce === true;
  const sneakers = pools.footwear.filter((g) => g.attributes.footwearKind === "sneaker");
  const shoePool = paired && sneakers.length > 0 ? sneakers : pools.footwear;
  const outer = locked.get("outer") ?? (jacketWanted(ctx, usage.index, smart) ? chooseOuter(ctx, pools, top, bottom, usage, seed, fixed, locked.has("footwear") ? [] : shoePool, locked.has("socks") ? [] : pools.socks) : undefined);
  if (outer) slots.push({ role: "outer", garmentId: outer.garmentId });
  slots.push({ role: "top", garmentId: top.garmentId }, { role: "bottom", garmentId: bottom.garmentId });

  const upper = new Set([top.colourFamily, outer?.colourFamily].filter(Boolean));

  // The belt line's optional flourish, appropriate to the day (profile section 9): a scarf for a cold
  // start; otherwise, whenever the top is a shirt, a TIE whose season words in the sheet fit the day's
  // peak (the everyday suggestion is never a bandana or other neckwear; a smart occasion keeps any
  // neckwear that is not a scarf). It is a suggestion carried on every plan,
  // never a required piece. (No collar attribute is recorded on garments; the shirt category stands for it.)
  const departure = ctx.conditions.departureC;
  const scarfDay = departure !== null && departure <= 10;
  const flourish = locked.get("neckwear") ?? pick(
    pools.neckwear.filter((g) => (g.category === "scarf" ? scarfDay : top.category === "shirt" && (smart || (g.category === "tie" && everydayFlourish && seasonFit(g, ctx.conditions.peakC) >= 0)))),
    (g) => (g.category === "scarf" ? 2 + seasonFit(g, departure) : seasonFit(g, ctx.conditions.peakC)) + (g.colourFamily !== top.colourFamily ? 0.5 : 0) + (outer && g.colourFamily === outer.colourFamily ? -0.3 : 0) + seededUnit(seed, g.garmentId) * 0.5,
  );

  // The colour echo from higher up belongs to the sock first (profile section 4). A shoe in a neutral
  // already worn higher up would be that neutral's second piece and leave no room for the sock to echo
  // it, so such a shoe is ranked down rather than up; a shoe may still echo a colour that is not a neutral.
  const takesSockEcho = (g: PoolGarment) => NEUTRAL_FAMILIES.has(g.colourFamily) && upper.has(g.colourFamily);
  const footwearScore = (g: PoolGarment) =>
    rotation(ctx, g) - (usage.footwear.get(g.garmentId) ?? 0) * 1.5 + (takesSockEcho(g) ? -0.6 : upper.has(g.colourFamily) ? 0.8 : 0) - (g.colourFamily === bottom.colourFamily ? 0.3 : 0) + (g.attributes.breakingIn ? -0.5 : 0) + seededUnit(seed, g.garmentId) * 0.6;
  // The shoe echoes a colour from higher up, but never as the third piece in one neutral while another
  // eligible shoe exists (a navy jacket over a navy shirt does not take the navy sneaker as well).
  const worn = [outer, top, bottom, ...fixed];
  // The sock carries the echo of a colour from higher up (below), and the neutral limit counts shoe and
  // sock alike. A shoe that would take the last place that limit leaves in the only colour the sock can
  // echo is therefore passed over while another shoe leaves the sock its echo: under a navy jacket over a
  // rose shirt the sock is the navy one, so the shoe is not navy as well.
  const sockClass = ctx.rules.defaultSockFabricClass;
  const leavesSockEcho = (shoe: PoolGarment) =>
    pools.socks.some((s) => (!sockClass || s.attributes.fabricClass === sockClass) && s.colourFamily !== "unknown" && upper.has(s.colourFamily) && s.colourFamily !== bottom.colourFamily && !exceedsNeutralLimit(ctx, s, [...worn, shoe]));
  const keepingSockEcho = (shoes: PoolGarment[]): PoolGarment[] => {
    if (locked.has("socks")) return shoes;
    // First, a shoe that leaves some pair of socks within the neutral limit at all (socks are always worn):
    // under beige chinos with only beige socks, a beige shoe would make the sock the third beige piece.
    const leavingSock = shoes.filter((shoe) => pools.socks.some((s) => !exceedsNeutralLimit(ctx, s, [...worn, shoe])));
    const base = leavingSock.length > 0 ? leavingSock : shoes;
    const kept = base.filter(leavesSockEcho);
    return kept.length > 0 ? kept : base;
  };
  const footwear = locked.get("footwear") ?? pick(keepingSockEcho(withinNeutralLimit(ctx, shoePool, worn)), footwearScore);
  if (!footwear) return null;
  const footwearAlternatives: string[] = [];
  if (paired) {
    const otherKind = footwear.attributes.footwearKind === "welted" ? "sneaker" : "welted";
    const other = pick(withinNeutralLimit(ctx, pools.footwear.filter((g) => g.attributes.footwearKind === otherKind && g.garmentId !== footwear.garmentId), worn), footwearScore);
    if (other) footwearAlternatives.push(other.garmentId);
  }

  // The sock as the quiet rhyme or the single flash: echo a colour from higher up, not the trouser.
  const calm = !SATURATED.has(top.colourFamily) && !(outer && SATURATED.has(outer.colourFamily));
  const peak = ctx.conditions.peakC;
  const socks = locked.get("socks") ?? pick(withinNeutralLimit(ctx, pools.socks, [...worn, footwear]), (g) => {
    let s = g.availability.pAvailable * 2 + seasonFit(g, peak) - (usage.socks.get(g.garmentId) ?? 0) * (g.availability.cleanObserved > 1 ? 0.4 : 1.5) + seededUnit(seed, g.garmentId) * 0.5;
    if (ctx.rules.defaultSockFabricClass && g.attributes.fabricClass === ctx.rules.defaultSockFabricClass) s += 2;
    if (upper.has(g.colourFamily) && g.colourFamily !== bottom.colourFamily) s += 2;
    if (g.colourFamily === bottom.colourFamily) s -= 1;
    if (calm && SATURATED.has(g.colourFamily)) s += 0.9;
    return s;
  });
  if (!socks) return null;
  // The belt is settled last: the shoe and the sock carry the outfit's colour echo, and the belt is
  // then never the third piece in one neutral while another belt is eligible.
  const belt = locked.get("belt") ?? pick(withinNeutralLimit(ctx, pools.belts, [...worn, footwear, socks]), (g) => (g.colourFamily === "brown" ? 0.5 : 0) + (upper.has(g.colourFamily) ? 0.8 : 0) + (g.colourFamily === "black" && (bottom.colourFamily === "grey" || bottom.colourFamily === "black") ? 1.2 : 0) + seededUnit(seed, g.garmentId) * 0.2);
  if (belt) slots.push({ role: "belt", garmentId: belt.garmentId });
  if (flourish) slots.push({ role: "neckwear", garmentId: flourish.garmentId });
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

/**
 * The day's events an outfit suits in this context, by the composer's own rule: the primary relevant
 * event, when the outfit's top and bottom suit its inferred occasion. Used to judge stored outfits again
 * (an undo restoring earlier outfits) rather than carrying their historical claims.
 */
export function suitsEventIdsFor(ctx: RecommendationContext, o: { slots: OutfitSlot[] }): string[] {
  const events = relevantCalendarEvents(ctx);
  const primaryEvent = events.find((e) => e.weight === "full") ?? events[0];
  if (!primaryEvent) return [];
  return suits(primaryEvent.inferredOccasion, ctx.garments.get(slotOf(o, "top") ?? ""), ctx.garments.get(slotOf(o, "bottom") ?? "")) ? [primaryEvent.eventId] : [];
}

export async function composeBoard(ctx: RecommendationContext, opts: ComposeOptions = {}): Promise<ComposeResult> {
  const validateOpts: ValidateOptions = { requirePairedFootwear: true, ...(opts.validate ?? {}) };
  const requestedCount = ctx.brief.requestedCount ?? opts.count ?? ctx.settings.delivery.defaultOptionCount;
  const reserveCount = opts.reserveCount ?? ctx.daily.reserveCount;
  const locked = new Map<Role, PoolGarment>();
  for (const s of opts.locked ?? []) {
    const g = ctx.garments.get(s.garmentId);
    // A locked piece the ledger does not know is refused, never silently dropped from the request.
    if (!g) throw new CommandError("invalid_command", `the locked piece '${s.garmentId}' is not in the wardrobe`, { garmentId: s.garmentId, role: s.role });
    locked.set(s.role, g);
  }
  // Pieces the request names as ones that must stay are part of every outfit the composer builds: each
  // takes the first of its roles that is still free. They are still validated like any other piece
  // (naming a piece never makes absent stock present), and a board may then repeat a named shirt.
  for (const id of ctx.brief.include) {
    const g = ctx.garments.get(id);
    if (!g || [...locked.values()].some((l) => l.garmentId === id)) continue;
    const role = g.roles.find((r) => !locked.has(r));
    if (role) locked.set(role, g);
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
    const budgetClock = opts.budgetClock ?? SYSTEM_BUDGET_CLOCK;
    const startedAt = budgetClock.now();
    for (let attempt = 1; attempt <= maxAttempts && accepted < want; attempt++) {
      const remaining = budgetMs - (budgetClock.now() - startedAt);
      if (remaining <= 0) {
        diagnostics.modelError = diagnostics.modelError ?? "the inference budget for this board was used up";
        break;
      }
      diagnostics.modelAttempts = attempt;
      let proposals: unknown[];
      let cancelTimer: (() => void) | undefined;
      try {
        const call = opts.model.propose({ localDate: ctx.localDate, count: want, contextText, contextData, rejections: [...rejections], deadlineAtMs: (opts.deadlineAtMs ?? ctx.nowMs + budgetMs) });
        const timeout = new Promise<never>((_, reject) => {
          cancelTimer = budgetClock.after(remaining, () => reject(new Error("the model did not answer within the inference budget for this board")));
        });
        proposals = await Promise.race([call, timeout]);
      } catch (e) {
        diagnostics.modelError = String((e as Error)?.message ?? e).slice(0, 200);
        break;
      } finally {
        cancelTimer?.();
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
      const built = buildOutfit(ctx, pools, p.top, p.bottom, usage, suitable && occasion === "smart", locked, opts.everydayFlourish !== false);
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

  // An explicit occasion-only request keeps unsuitable outfits off the board: they may only be reserves.
  const options = restRequireSuitable ? chosen.filter(suitsEvent).slice(0, requestedCount) : chosen.slice(0, requestedCount);
  const rest = restRequireSuitable ? chosen.filter((o) => !options.includes(o)) : chosen.slice(requestedCount);
  const reserves = rest.slice(0, total - options.length).map((o) => ({ ...o, source: o.source === "deterministic" ? ("reserve" as const) : o.source }));
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
    // A piece that was asked for by name and cannot be worn that day is the reason, and is said so.
    if (options.length === 0) {
      for (const [role, g] of locked) {
        const blocker = garmentViolations(ctx, g.garmentId, role, validateOpts).find((x) => x.severity === "blocking" && !(ctx.mode === "explore" && EXPLORE_ADVISORY.has(x.code)));
        if (!blocker) continue;
        notice = `No outfit can be built around what was asked for: ${blocker.message}.`;
        break;
      }
    }
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
  opts: { validate?: ValidateOptions; usage?: Map<string, number>; avoidGarmentIds?: Set<string> } = {},
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
  const eligible = eligibleFor(ctx, "footwear", opts.validate ?? {}).filter((g) => !inOutfit.has(g.garmentId) && !opts.avoidGarmentIds?.has(g.garmentId));
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
 * Replace one slot of an outfit, keeping every other piece. Honours "never fall back to navy"
 * (profile section 8 rule 6): a navy replacement is taken only when nothing else validates, whatever
 * the colour of the piece being swapped out. A replacement that would be the third piece in one
 * neutral is likewise passed over while another validates.
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
  const kept = option.slots.filter((s) => s.role !== role && s.role !== "neckwear" && s.role !== "accessory").map((s) => ctx.garments.get(s.garmentId));
  const ranked = eligibleFor(ctx, role, validateOpts)
    .filter((g) => !current.has(g.garmentId) && !avoid.has(g.garmentId) && !option.footwearAlternatives.includes(g.garmentId))
    .map((g) => {
      let score = rotation(ctx, g) + seasonFit(g, temperature) * 1.5 + seededUnit(ctx.userId, ctx.localDate, "swap", g.garmentId) * 0.8;
      if (role === "top" && bottom) score += pairScore(ctx, g, bottom);
      if (role === "bottom" && top) score += pairScore(ctx, top, g);
      if (original && g.attributes.fabricClass && g.attributes.fabricClass === original.attributes.fabricClass) score += 0.6; // keep the register of the piece it replaces
      // Strict tiers, not score penalties: every non-navy piece is tried before any navy one, and within
      // each colour tier a piece that keeps the neutral limit before one that breaks it.
      const navy = !!ctx.rules.navySwap && g.colourFamily === ctx.rules.navySwap.family;
      const overNeutral = exceedsNeutralLimit(ctx, g, kept) && role !== "neckwear" && role !== "accessory";
      return { g, score, tier: (navy ? 2 : 0) + (overNeutral ? 1 : 0) };
    })
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.g.garmentId.localeCompare(b.g.garmentId));
  for (const { g } of ranked) {
    const swapped = option.slots.some((s) => s.role === role) ? option.slots.map((s) => (s.role === role ? { role, garmentId: g.garmentId } : s)) : [...option.slots, { role, garmentId: g.garmentId }];
    // An option published before the paired-shoe format came into force gains its alternative here: a
    // pair other than the avoided ones when one is eligible, otherwise whatever completes the format.
    const base = { slots: swapped, footwearAlternatives: option.footwearAlternatives };
    const avoiding = avoid.size > 0 ? withPairedFootwear(ctx, base, { validate: validateOpts, avoidGarmentIds: avoid }) : null;
    const { slots, footwearAlternatives } = avoiding && avoiding.added.length > 0 ? avoiding : withPairedFootwear(ctx, base, { validate: validateOpts });
    const validation = validateCandidate(ctx, { slots, footwearAlternatives }, validateOpts);
    if (validation.valid) return { slots, footwearAlternatives, validation, replacement: g };
  }
  return null;
}
