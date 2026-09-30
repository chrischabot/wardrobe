import { GarmentRole as GarmentRoleSchema, type BoardRegister, type GarmentRole } from '@garderobe/contracts';
import { z } from 'zod';
import { OCCASION_LABEL, type Occasion } from '../calendar/brief.js';
import type { MandatoryContext } from './context.js';
import {
  COOL_FAMILIES,
  WARM_FAMILIES,
  isBlazer,
  isChino,
  isDrawstring,
  isFieldPiece,
  isJeans,
  isLightTrouser,
  isScarf,
  isTextured,
  isTie,
  type WardrobeGarment,
} from './garments.js';
import { jointAvailability, type JointInput } from './joint.js';
import { upperFamilies, validateBoard, validateOutfit, type Candidate, type CandidateSlot, type Check, type OutfitParts, type OutfitValidation } from './validate.js';

/**
 * Deterministic composition (spec section 7, "Composition and validation"). No model is needed: the
 * composer derives eligible pools per role, generates complete candidates, validates every one in
 * code, scores taste and joint availability, and selects a varied board with reserves. An optional
 * `CandidateProposer` (a model) may add candidates; they pass the same validator and never bypass it.
 */

export interface CandidateProposer {
  readonly name: string;
  propose(ctx: MandatoryContext, count: number): Promise<Candidate[]>;
}

/** Shape a proposed candidate must have before the validator even looks at it. */
const ProposedCandidate = z.object({
  slots: z
    .array(z.object({ garmentId: z.string().min(1).max(100), role: GarmentRoleSchema, alternativeGroup: z.string().max(40).nullable().optional() }))
    .min(1)
    .max(12),
});

export interface ScoredOption {
  slots: CandidateSlot[];
  validation: OutfitValidation;
  taste: number;
  joint: number;
  jointDetail: ReturnType<typeof jointAvailability> | null;
  score: number;
  devices: string[];
  suitable: boolean | null;
  source: NonNullable<Candidate['source']>;
}

export interface ComposedBoard {
  options: ScoredOption[];
  reserves: ScoredOption[];
  requestedCount: number;
  shortfall: string | null;
  boardChecks: Check[];
  occasion: Occasion | null;
  suitableCount: number;
  pools: Record<string, number>;
  rejected: { source: string; violations: Check[] }[];
  candidatesConsidered: number;
  /** Explicitly requested pieces: whether each is in every option, or why it cannot be. */
  pins: (PinStatus & { enforced: boolean })[];
  /** Why the board's registers are less spread than the profile asks, when they are. */
  registerNote: string | null;
}

export interface ComposeOptions {
  proposer?: CandidateProposer | null;
  /** Garments pinned by the owner ("with the gold oxford"); every option must contain them. */
  pinned?: string[];
  jointInput?: Omit<JointInput, 'garments' | 'targetDate'>;
  reserveCount?: number;
  /** Trip boards permit deliberate reuse. */
  allowRepeats?: boolean;
}

// ------------------------------------------------------------------ pools

function clean(g: WardrobeGarment): boolean {
  if (!g.eligibility.available || g.indoorOnly) return false;
  if (!g.estimate || !g.estimate.eligible) return false;
  if ((g.laundryPolicy === 'per_wear' || g.laundryPolicy === 'single_wear_day') && g.estimate.estimatedCleanUnits <= 0) return false;
  return true;
}

export function eligiblePools(ctx: MandatoryContext, allowRepeats = false): Record<'tops' | 'mids' | 'outers' | 'bottoms' | 'socks' | 'footwear' | 'belts' | 'flourishes', WardrobeGarment[]> {
  const { policy } = ctx;
  const peak = ctx.thermal.peakTempC;
  const dep = ctx.thermal.departureTempC;
  const from = addDays(ctx.day.date, -policy.repeat.horizonDays);
  const requested = (g: WardrobeGarment) => g.planningPolicy !== 'occasional' || ctx.request.include.includes(g.garmentId);
  const ok = (g: WardrobeGarment) =>
    clean(g) &&
    requested(g) &&
    !ctx.request.exclude.includes(g.garmentId) &&
    !ctx.comfort.excluded.has(g.garmentId) &&
    !g.tags.some((t) => policy.excludedTags.includes(t)) &&
    !/watch|\bring\b|bracelet|necklace|jewel|cufflink/i.test(g.name);
  const notRepeat = (g: WardrobeGarment) => allowRepeats || !policy.repeat.active || !g.wornDates.some((d) => d >= from && d < ctx.day.date);
  const forPeak = (g: WardrobeGarment) => g.thermal.minC <= peak && peak <= g.thermal.maxC;
  const has = (g: WardrobeGarment, r: GarmentRole) => g.roles.includes(r);
  const w = ctx.wardrobe.filter(ok);
  return {
    tops: w.filter((g) => has(g, 'base_top') && forPeak(g) && notRepeat(g)),
    mids: w.filter((g) => has(g, 'mid_layer') && forPeak(g) && peak <= 14),
    outers: w.filter((g) => has(g, 'outer_layer') && !has(g, 'base_top') && g.thermal.minC <= dep && dep <= g.thermal.maxC),
    bottoms: w.filter((g) => has(g, 'bottom') && forPeak(g) && notRepeat(g)),
    socks: w.filter((g) => has(g, 'socks') && (g.fabricClass === policy.socks.defaultFabricClass || (g.thermal.minC <= peak && peak <= g.thermal.maxC))),
    footwear: w.filter((g) => has(g, 'footwear') && (!policy.sneakersOnly.active || (g.category === 'sneakers' && g.attributes.construction !== 'welted' && g.attributes.model !== '990v6'))),
    belts: w.filter((g) => has(g, 'belt')),
    flourishes: w.filter((g) => has(g, 'accessory') && (isTie(g) || (isScarf(g) && g.thermal.minC <= dep && dep <= g.thermal.maxC + 2))),
  };
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ explicit requests (include)

type PoolKey = keyof ReturnType<typeof eligiblePools>;
const ROLE_POOLS: [GarmentRole, PoolKey][] = [
  ['base_top', 'tops'],
  ['bottom', 'bottoms'],
  ['outer_layer', 'outers'],
  ['mid_layer', 'mids'],
  ['footwear', 'footwear'],
  ['socks', 'socks'],
  ['belt', 'belts'],
  ['accessory', 'flourishes'],
];

export interface PinStatus {
  garmentId: string;
  name: string | null;
  pool: PoolKey | null;
  /** Why the piece cannot be in today's outfits (null when it can). */
  problem: string | null;
}

/**
 * Whether an explicitly requested piece can be worn today, and if not, the plain reason: unavailable,
 * restricted, not clean, wrong for the weather, a seven-day repeat, excluded, or an owner comfort
 * direction. A request never makes an ineligible piece eligible.
 */
export function pinStatus(ctx: MandatoryContext, pools: ReturnType<typeof eligiblePools>, garmentId: string, allowRepeats = false): PinStatus {
  const g = ctx.byId.get(garmentId);
  if (!g) return { garmentId, name: null, pool: null, problem: 'is not a garment in this wardrobe' };
  for (const [role, key] of ROLE_POOLS) if (g.roles.includes(role) && pools[key].some((x) => x.garmentId === g.garmentId)) return { garmentId, name: g.name, pool: key, problem: null };
  const { policy } = ctx;
  const peak = ctx.thermal.peakTempC;
  const dep = ctx.thermal.departureTempC;
  const why: string[] = [];
  if (!g.roles.some((r) => ROLE_POOLS.some(([role]) => role === r))) why.push('is not worn as part of a day outfit');
  if (!g.eligibility.available) why.push(g.eligibility.reasons.join('; ') || g.eligibility.label);
  if (g.indoorOnly) why.push('is indoor only');
  if (g.eligibility.available && (!g.estimate || !g.estimate.eligible)) why.push(g.estimate?.exclusionReasons.join('; ') || 'is not available');
  else if (g.eligibility.available && (g.laundryPolicy === 'per_wear' || g.laundryPolicy === 'single_wear_day') && (g.estimate?.estimatedCleanUnits ?? 0) <= 0) why.push('has no clean unit (worn or in the wash)');
  if (ctx.request.exclude.includes(g.garmentId)) why.push('was also excluded in this request');
  const direction = ctx.comfort.excluded.get(g.garmentId);
  if (direction) why.push(`you asked “${direction.statement}”, and today includes “${direction.matchedOn}”`);
  if (g.tags.some((t) => policy.excludedTags.includes(t))) why.push('is filtered out by your profile');
  if (g.roles.includes('footwear') && policy.sneakersOnly.active && !(g.category === 'sneakers' && g.attributes.construction !== 'welted' && g.attributes.model !== '990v6')) why.push('sneakers only until you say your feet have healed');
  if (g.roles.includes('base_top') || g.roles.includes('bottom') || g.roles.includes('mid_layer')) {
    if (!(g.thermal.minC <= peak && peak <= g.thermal.maxC)) why.push(`is for ${g.thermal.minC}–${g.thermal.maxC} °C and today peaks at ${peak} °C`);
    else if (g.roles.includes('mid_layer') && !g.roles.includes('base_top') && peak > 14) why.push(`a knit is too warm for a ${peak} °C peak`);
  } else if (g.roles.includes('outer_layer') && !(g.thermal.minC <= dep && dep <= g.thermal.maxC)) why.push(`is for ${g.thermal.minC}–${g.thermal.maxC} °C and the morning starts at ${dep} °C`);
  if (!allowRepeats && policy.repeat.active && (g.roles.includes('base_top') || g.roles.includes('bottom'))) {
    const from = addDays(ctx.day.date, -policy.repeat.horizonDays);
    if (g.wornDates.some((d) => d >= from && d < ctx.day.date)) why.push(`was worn on ${g.lastWornOn}, within the last ${policy.repeat.horizonDays} days`);
  }
  return { garmentId, name: g.name, pool: null, problem: why.length ? why.join('; ') : 'does not fit today’s rules' };
}

function pinNote(unusable: PinStatus[], uncombinable: PinStatus[]): string | null {
  const parts: string[] = [];
  for (const p of unusable) parts.push(`${p.name ?? 'One requested piece'} can’t be included: it ${p.problem}.`);
  if (uncombinable.length) parts.push(`${uncombinable.map((p) => p.name).join(' and ')} ${uncombinable.length === 1 ? 'is' : 'are'} wearable, but no complete outfit with ${uncombinable.length === 1 ? 'it' : 'them'} passes today’s rules.`);
  if (!parts.length) return null;
  return `${parts.join(' ')} These options are without ${unusable.length + uncombinable.length === 1 ? 'it' : 'them'}.`;
}

// ------------------------------------------------------------------ deterministic variety

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

// ------------------------------------------------------------------ scoring

const warm = (fs: string[]) => fs.some((f) => WARM_FAMILIES.includes(f));
const cool = (fs: string[]) => fs.some((f) => COOL_FAMILIES.includes(f));

export function tasteScore(p: OutfitParts, v: OutfitValidation, ctx: MandatoryContext): { score: number; devices: string[] } {
  const { policy } = ctx;
  const devices: string[] = [];
  let s = 0;
  const major = [p.top, p.mid, p.outer, p.bottom].filter((g): g is WardrobeGarment => Boolean(g));
  for (const g of major) {
    if (g.fabricClass && policy.fabricSings.includes(g.fabricClass)) s += 0.5;
    if (g.fabricClass === 'lightweight_oxford') s += 0.4;
    if (g.fabricClass === 'moleskin' || /moleskin/i.test(g.fabric ?? '')) s -= 1.5;
  }
  const upper = upperFamilies(p);
  const bottom = p.bottom?.families ?? [];
  const upperMajor = [...new Set([p.top, p.mid, p.outer].flatMap((g) => g?.families ?? []))];
  if ((warm(upperMajor) && cool(bottom)) || (cool(upperMajor) && warm(bottom))) {
    s += 1;
    devices.push('warm_cool');
  }
  if (p.socks) {
    if (p.socks.families.some((f) => upper.includes(f) && !bottom.includes(f))) {
      s += 1.5;
      devices.push('echo');
    } else if (p.socks.families.some((f) => bottom.includes(f))) s -= 1.2;
  }
  const shoe = p.footwear[0];
  if (shoe) {
    if (shoe.families.some((f) => upper.includes(f) && !bottom.includes(f))) {
      s += 0.6;
      devices.push('shoe_echo');
    } else if (shoe.families.length && shoe.families.every((f) => bottom.includes(f))) s -= 0.6;
  }
  const textured = major.filter(isTextured);
  if (textured.length >= 1 && new Set(major.map((g) => g.fabricClass)).size >= 2 && (textured.length >= 2 || major.some((g) => g.fabricClass === 'lightweight_oxford'))) {
    s += 0.8;
    devices.push('texture');
  }
  if (v.statementCount === 1) {
    s += 0.6;
    devices.push('one_voice');
  } else if (v.statementCount > policy.maxStatementPieces) s -= 4;
  if (v.safe) s -= 1.2;
  if (v.register === 'home_key') s -= 0.3;
  if (v.register !== 'other') s += 0.5;
  for (const f of new Set(major.flatMap((g) => g.families))) if (policy.palette.core.includes(f) || policy.palette.accents.includes(f)) s += 0.1;
  if (p.top && (p.top.attributes.tier === 'layering' || p.top.attributes.tier === 'secondary_layering')) s -= 0.8;
  for (const g of major) if (g.attributes.fitNote) s -= 0.2;
  // Weather: rain and wind justify protective choices; they never override hard rules.
  const cond = ctx.weather.summary.conditions;
  if (cond.includes('rain')) {
    if (p.outer?.fabricClass === 'waxed_cotton') {
      s += 1.2;
      devices.push('rain_layer');
    }
    if (p.bottom && isLightTrouser(p.bottom)) s -= 1;
    if (p.outer && /linen/i.test(p.outer.fabric ?? '')) s -= 0.5;
    if (!p.outer) s -= 0.8;
  }
  if (cond.includes('windy')) {
    if (p.flourish && isScarf(p.flourish)) s += 0.4;
    if (p.outer && /linen/i.test(p.outer.fabric ?? '')) s -= 0.4;
  }
  if (cond.includes('heat') && !p.outer) s += 0.5;
  // Novelty against recently shown boards; respect the coming week's selections.
  const shown = new Set(ctx.recentlyShown.filter((d) => d.date >= addDays(ctx.day.date, -3)).flatMap((d) => d.garmentIds.flat()));
  const selected = new Set(ctx.comingSelections.flatMap((c) => c.garmentIds));
  for (const g of [...major, p.socks, ...p.footwear].filter((x): x is WardrobeGarment => Boolean(x))) {
    if (shown.has(g.garmentId)) s -= 0.25;
    if (selected.has(g.garmentId) && (g.laundryPolicy === 'per_wear' || g.laundryPolicy === 'single_wear_day') && (g.estimate?.estimatedCleanUnits ?? 0) <= 1) s -= 1;
  }
  for (const g of [p.outer, ...p.footwear]) if (g && g.wornDates.length) s -= 0.1 * Math.min(3, g.wornDates.length);
  // Comfort: an owner observation that matches today's situation ranks the garment lower (never a ban).
  for (const g of [...major, p.socks, ...p.footwear, p.belt].filter((x): x is WardrobeGarment => Boolean(x))) if (ctx.comfort.cautioned.has(g.garmentId)) s -= 1.5;
  s += (hash(`${ctx.seed}|${p.top?.garmentId}|${p.bottom?.garmentId}|${p.outer?.garmentId ?? ''}`) - 0.5) * 0.6;
  return { score: s, devices };
}

/** Whether an option works for the day's relevant occasion. */
export function suitsOccasion(p: OutfitParts, occasion: Occasion | null, statementCount: number): boolean | null {
  if (!occasion) return null;
  const { outer, bottom, flourish, top } = p;
  switch (occasion) {
    case 'formal':
      return Boolean((outer && isBlazer(outer)) || (flourish && isTie(flourish))) && statementCount === 0 && Boolean(bottom) && !isJeans(bottom!) && !isDrawstring(bottom!) && !(bottom && isLightTrouser(bottom) && isJeans(bottom));
    case 'travel':
      return Boolean(bottom) && !isLightTrouser(bottom!) && !isDrawstring(bottom!) && (!outer || isFieldPiece(outer) || outer.category === 'coat') && !(top && /linen/i.test(top.fabric ?? '') && !/cotton/i.test(top.fabric ?? ''));
    case 'dinner':
      return Boolean((outer && (isBlazer(outer) || outer.category === 'coat')) || flourish) && Boolean(bottom) && !isDrawstring(bottom!);
    case 'outdoor':
      return Boolean(bottom) && !isLightTrouser(bottom!) && (!outer || !isBlazer(outer));
  }
}

// ------------------------------------------------------------------ completion of a (top, bottom, outer) triple

function familyScore(g: WardrobeGarment, upper: string[], bottom: string[]): number {
  let s = 0;
  if (g.families.some((f) => upper.includes(f) && !bottom.includes(f))) s += 1;
  if (g.families.some((f) => bottom.includes(f))) s -= 0.8;
  return s;
}

function complete(
  ctx: MandatoryContext,
  pools: ReturnType<typeof eligiblePools>,
  top: WardrobeGarment,
  bottom: WardrobeGarment,
  outer: WardrobeGarment | null,
  mid: WardrobeGarment | null,
  flourishKind: 'tie' | 'scarf' | 'any',
  allowRepeats: boolean,
): Candidate | null {
  const base: CandidateSlot[] = [
    ...(outer ? [{ garmentId: outer.garmentId, role: 'outer_layer' as const }] : []),
    ...(mid ? [{ garmentId: mid.garmentId, role: 'mid_layer' as const }] : []),
    { garmentId: top.garmentId, role: 'base_top' },
    { garmentId: bottom.garmentId, role: 'bottom' },
  ];
  const upper = [...new Set([top, mid, outer].flatMap((g) => g?.families ?? []))];
  const bf = bottom.families;
  const novelty = (g: WardrobeGarment) => -0.15 * g.wornDates.length + (hash(`${ctx.seed}|${top.garmentId}|${g.garmentId}`) - 0.5) * 0.4;
  const socks = [...pools.socks]
    .map((g) => ({ g, s: familyScore(g, upper, bf) + novelty(g) + (g.fabricClass === ctx.policy.socks.defaultFabricClass ? 0.3 : 0) + (ctx.thermal.peakTempC <= 8 && g.fabricClass === 'alpaca' ? 0.6 : 0) + Math.min(2, g.estimate?.estimatedCleanUnits ?? 0) * 0.1 }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6);
  const sneakers = pools.footwear.filter((g) => g.footwearKind === 'sneaker');
  const welted = pools.footwear.filter((g) => g.footwearKind === 'welted');
  const pairing = ctx.policy.sneakerAndWelted.active && sneakers.length > 0 && welted.length > 0;
  const shoeScore = (g: WardrobeGarment) => familyScore(g, upper, bf) * 0.8 + novelty(g);
  const shoeSets: WardrobeGarment[][] = pairing
    ? sneakers
        .flatMap((s) => welted.map((w) => [s, w]))
        .sort((a, b) => shoeScore(b[0]!) + shoeScore(b[1]!) - shoeScore(a[0]!) - shoeScore(a[1]!))
        .slice(0, 4)
    : [...(ctx.policy.sneakersOnly.active ? sneakers : pools.footwear)].sort((a, b) => shoeScore(b) - shoeScore(a)).slice(0, 3).map((g) => [g]);
  const shoeFamilies = (shoeSets[0] ?? []).flatMap((s) => s.families);
  const beltScore = (b: WardrobeGarment) =>
    (b.families.some((f) => upper.includes(f) || shoeFamilies.includes(f)) ? 0.5 : 0) -
    (b.families.some((f) => bf.includes(f)) ? 0.8 : 0) -
    (b.families.includes('black') && ![...upper, ...bf].some((f) => ['black', 'grey', 'slate'].includes(f)) ? 0.6 : 0) +
    (hash(`${ctx.seed}|b|${top.garmentId}|${b.garmentId}`) - 0.5) * 0.5;
  const belts: (WardrobeGarment | null)[] = isDrawstring(bottom) ? [null] : [...pools.belts].sort((a, b) => beltScore(b) - beltScore(a));
  if (!belts.length) belts.push(null);
  const statementAlready = [top, mid, outer, bottom].some((g) => g?.statement);
  const flourishes = [...pools.flourishes]
    .filter((g) => flourishKind === 'any' || (flourishKind === 'tie' ? isTie(g) : isScarf(g)))
    .map((g) => ({ g, s: familyScore(g, [...upper, ...bf], []) * 0.3 + (statementAlready && g.statement ? -1 : 0) + (hash(`${ctx.seed}|f|${top.garmentId}|${g.garmentId}`) - 0.5) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.g);
  const flourish = flourishes[0] ?? (flourishKind !== 'any' ? pools.flourishes[0] : undefined) ?? null;
  if (!socks.length || !shoeSets.length) return null;
  for (const shoes of shoeSets) {
    for (const sock of socks) {
      for (const belt of belts) {
        const slots: CandidateSlot[] = [
          ...base,
          ...(belt ? [{ garmentId: belt.garmentId, role: 'belt' as const }] : []),
          ...(flourish ? [{ garmentId: flourish.garmentId, role: 'accessory' as const, alternativeGroup: 'flourish' }] : []),
          { garmentId: sock.g.garmentId, role: 'socks' },
          ...shoes.map((s) => ({ garmentId: s.garmentId, role: 'footwear' as const, alternativeGroup: shoes.length > 1 ? 'footwear' : null })),
        ];
        const v = validateOutfit({ slots, source: 'composer' }, ctx, { allowRepeats });
        if (v.valid) return { slots, source: 'composer' };
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ composition

export async function composeBoard(ctx: MandatoryContext, opts: ComposeOptions = {}): Promise<ComposedBoard> {
  const allowRepeats = Boolean(opts.allowRepeats);
  const requested = [...new Set([...(opts.pinned ?? []), ...ctx.request.include])];
  if (!requested.length) return composeWith(ctx, opts, []);
  // Every option contains each requested piece that can be worn today; a piece that cannot is named
  // with the reason instead of being dropped silently.
  const statuses = requested.map((id) => pinStatus(ctx, eligiblePools(ctx, allowRepeats), id, allowRepeats));
  const usable = statuses.filter((s) => !s.problem);
  const unusable = statuses.filter((s) => s.problem);
  let board = usable.length ? await composeWith(ctx, opts, usable) : null;
  let uncombinable: PinStatus[] = [];
  if (!board || !board.options.length) {
    uncombinable = usable;
    board = await composeWith(ctx, opts, []);
  }
  const note = pinNote(unusable, uncombinable);
  const shortfall = [board.shortfall, note].filter(Boolean).join(' ') || null;
  return { ...board, shortfall, pins: statuses.map((s) => ({ ...s, enforced: !s.problem && !uncombinable.includes(s) })) };
}

async function composeWith(ctx: MandatoryContext, opts: ComposeOptions, pins: PinStatus[]): Promise<ComposedBoard> {
  const allowRepeats = Boolean(opts.allowRepeats);
  const pools = eligiblePools(ctx, allowRepeats);
  for (const pin of pins) {
    const g = ctx.byId.get(pin.garmentId)!;
    const key = pin.pool!;
    // Footwear alternatives: keep the other kind so a sneaker/welted pair can still be named.
    if (key === 'footwear' && ctx.policy.sneakerAndWelted.active) pools.footwear = pools.footwear.filter((f) => f.garmentId === g.garmentId || f.footwearKind !== g.footwearKind);
    else pools[key] = pools[key].filter((x) => x.garmentId === g.garmentId);
  }
  const pinnedOuter = pins.some((p) => p.pool === 'outers');
  const pinnedMid = pins.find((p) => p.pool === 'mids') ? pools.mids[0]! : null;
  const n = ctx.day.requestedCount;
  const dep = ctx.thermal.departureTempC;
  const cond = ctx.weather.summary.conditions;
  const outerRequired = Math.round(dep) < 14;
  const outerOptional = !outerRequired && (dep <= 19 || cond.includes('rain') || cond.includes('windy'));
  const band = ctx.policy.jacketBand;
  const inJacketBand = band.active && Math.round(dep) >= band.minC && Math.round(dep) <= band.maxC;
  const pinned = new Set(pins.map((p) => p.garmentId));
  const rejected: ComposedBoard['rejected'] = [];

  // Pre-score (top, bottom) pairs; keep the most promising for full completion.
  const pairs: { top: WardrobeGarment; bottom: WardrobeGarment; pre: number }[] = [];
  for (const top of pools.tops) {
    for (const bottom of pools.bottoms) {
      if (isJeans(bottom) && top.fabricClass === 'denim' && !/denim/i.test(bottom.name)) continue;
      let pre = 0;
      if ((warm(top.families) && cool(bottom.families)) || (cool(top.families) && warm(bottom.families))) pre += 1;
      if (top.statement && bottom.statement) pre -= 4;
      if (top.fabricClass && ctx.policy.fabricSings.includes(top.fabricClass)) pre += 0.4;
      if (isTextured(bottom) || isTextured(top)) pre += 0.4;
      if (top.families.some((f) => bottom.families.includes(f) && ctx.policy.neutrals.families.includes(f))) pre -= 0.3;
      if (isChino(bottom) && !top.pattern && top.families.every((f) => ['white', 'blue'].includes(f))) pre -= 0.8;
      pre += (hash(`${ctx.seed}|${top.garmentId}|${bottom.garmentId}`) - 0.5) * 1.2;
      pairs.push({ top, bottom, pre });
    }
  }
  pairs.sort((a, b) => b.pre - a.pre);
  const shortlist = pairs.slice(0, 160);

  const candidates: Candidate[] = [];
  const outerScore = (o: WardrobeGarment, top: WardrobeGarment) =>
    (warm(o.families) !== warm(top.families) ? 0.5 : 0) + (isTextured(o) ? 0.4 : 0) + (cond.includes('rain') && o.fabricClass === 'waxed_cotton' ? 1.5 : 0) + (hash(`${ctx.seed}|o|${top.garmentId}|${o.garmentId}`) - 0.5) - (o.statement && top.statement ? 3 : 0);
  for (const { top, bottom } of shortlist) {
    const outerChoices: (WardrobeGarment | null)[] = [];
    const outersForTop = pools.outers.filter((o) => !inJacketBand || top.fabricClass === band.requiredBaseFabricClass);
    const ranked = [...outersForTop].sort((a, b) => outerScore(b, top) - outerScore(a, top)).slice(0, 3);
    if (pinnedOuter) outerChoices.push(...ranked);
    else if (pinnedMid && !outerRequired) outerChoices.push(null, ...(dep < 12 ? ranked : []));
    else if (outerRequired) outerChoices.push(...ranked);
    else if (outerOptional) outerChoices.push(null, ...ranked);
    else outerChoices.push(null);
    const mid = pinnedMid ?? (ctx.thermal.peakTempC <= 8 ? (pools.mids.find((m) => !m.statement) ?? null) : null);
    for (const outer of outerChoices.slice(0, 3)) {
      for (const kind of ['any', 'tie'] as const) {
        const c = complete(ctx, pools, top, bottom, outer, outer && mid && dep >= 12 ? null : mid, kind === 'any' && (dep <= 12 || cond.includes('windy')) ? 'scarf' : kind, allowRepeats);
        if (c) candidates.push(c);
      }
    }
  }
  // Model-proposed candidates (optional) pass the very same validator. Malformed output (not an
  // array, null entries, missing or mistyped slots) is discarded as rejected input, never dereferenced.
  if (opts.proposer) {
    try {
      const raw: unknown = await opts.proposer.propose(ctx, n * 3);
      for (const item of Array.isArray(raw) ? raw.slice(0, 500) : []) {
        const parsed = ProposedCandidate.safeParse(item);
        if (parsed.success) candidates.push({ slots: parsed.data.slots, source: 'model' });
        else rejected.push({ source: 'model', violations: [{ ruleKey: 'integrity.malformed_candidate', strength: 'hard', passed: false, detail: 'Malformed candidate from the model was discarded' }] });
      }
    } catch {
      // A proposer outage leaves the deterministic board intact.
    }
  }

  const seen = new Set<string>();
  const scored: ScoredOption[] = [];
  const board = ctx.calendar.brief;
  for (const c of candidates) {
    const key = c.slots.map((s) => `${s.role}:${s.garmentId}`).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const v = validateOutfit(c, ctx, { allowRepeats });
    if (!v.valid) {
      rejected.push({ source: c.source ?? 'composer', violations: v.violations });
      continue;
    }
    if (pinned.size && ![...pinned].every((id) => c.slots.some((s) => s.garmentId === id))) continue;
    if (v.statementCount > ctx.policy.maxStatementPieces) continue; // never compose the clown
    const t = tasteScore(v.parts, v, ctx);
    scored.push({ slots: c.slots, validation: v, taste: t.score, joint: 1, jointDetail: null, score: t.score, devices: t.devices, suitable: suitsOccasion(v.parts, board.occasion, v.statementCount), source: c.source ?? 'composer' });
  }
  scored.sort((a, b) => b.taste - a.taste);
  // Shortlist by taste, always keeping the best occasion-suitable candidates so the subset can be filled.
  const shortlist2 = [...new Set([...scored.slice(0, 120), ...scored.filter((o) => o.suitable).slice(0, 60)])];
  // Joint availability for the shortlist (exact DP over earlier board days).
  const scoreJoint = (o: ScoredOption) => {
    if (opts.jointInput) {
      const garments = [...new Set(o.slots.map((s) => s.garmentId))].map((id) => ctx.byId.get(id)!).filter((g) => !(o.slots.find((s) => s.garmentId === g.garmentId)?.alternativeGroup));
      const detail = jointAvailability({ ...opts.jointInput, garments, targetDate: ctx.day.date });
      o.joint = detail.probability;
      o.jointDetail = detail;
    }
    o.score = o.taste + 2.5 * o.joint;
  };
  for (const o of shortlist2) scoreJoint(o);
  const ranked = shortlist2.sort((a, b) => b.score - a.score);

  const occasion = board.occasion;
  const suitableTarget = occasion ? (ctx.calendar.wholeBoardOccasion ? n : Math.floor(n / 2) + 1) : 0;
  const selection = selectBoardDetailed(ranked, n, suitableTarget, ctx.calendar.wholeBoardOccasion, { pinned, allowRepeatBottoms: allowRepeats });
  const chosen = selection.chosen;
  const reserveCount = opts.reserveCount ?? 2;
  const usedTops = new Set(chosen.map((c) => c.validation.parts.top?.garmentId).filter((id): id is string => Boolean(id) && !pinned.has(id!)));
  const usedBottoms = new Set(chosen.map((c) => c.validation.parts.bottom?.garmentId).filter((id): id is string => Boolean(id) && !pinned.has(id!)));
  const reserveOk = (o: ScoredOption) => !chosen.includes(o) && !usedTops.has(o.validation.parts.top?.garmentId ?? '') && (allowRepeats || !usedBottoms.has(o.validation.parts.bottom?.garmentId ?? ''));
  let reserves = ranked.filter(reserveOk).slice(0, reserveCount);
  if (reserves.length < reserveCount) {
    // The taste shortlist can be exhausted by the chosen board's shirts and trousers while the full
    // valid set still holds outfits that repeat nothing; reserves (used by repair) come from there.
    const inShortlist = new Set(shortlist2);
    const extra = scored.filter((o) => !inShortlist.has(o) && reserveOk(o)).slice(0, 60);
    for (const o of extra) scoreJoint(o);
    extra.sort((a, b) => b.score - a.score);
    reserves = [...reserves, ...extra].slice(0, reserveCount);
  }

  const poolAllowsOther = ranked.some((o) => o.validation.register !== 'home_key');
  const boardChecks = validateBoard(chosen.map((o) => ({ validation: o.validation, slots: o.slots })), ctx, poolAllowsOther, { pinned, allowRepeats, registerNote: selection.registerNote });
  const suitableCount = chosen.filter((o) => o.suitable).length;
  let shortfall: string | null = null;
  if (chosen.length < n) {
    const limits: string[] = [];
    if (pools.tops.length < n) limits.push(`${pools.tops.length === 0 ? 'no' : `only ${pools.tops.length}`} clean shirt${pools.tops.length === 1 ? '' : 's'} suit${pools.tops.length === 1 ? 's' : ''} the day`);
    if (pools.bottoms.length < n) limits.push(`${pools.bottoms.length === 0 ? 'no' : `only ${pools.bottoms.length}`} pair${pools.bottoms.length === 1 ? '' : 's'} of trousers qualif${pools.bottoms.length === 1 ? 'ies' : 'y'}`);
    if (!pools.socks.length) limits.push('no clean socks are left');
    if (!pools.footwear.length) limits.push('no footwear is wearable');
    if (outerRequired && !pools.outers.length) limits.push('no available jacket answers the morning');
    if (!limits.length && chosen.length > 0 && selection.distinctLimit < n) limits.push('the shirts and trousers that suit the day make only this many outfits without repeating a piece');
    shortfall =
      chosen.length === 0
        ? `No complete outfit is possible today: ${limits.join('; ') || 'the eligible pieces do not combine within the rules'}.`
        : `${chosen.length} complete outfit${chosen.length === 1 ? '' : 's'} instead of ${n}: ${limits.join('; ') || 'the remaining combinations break a rule'}.`;
  }
  return {
    options: chosen,
    reserves,
    requestedCount: n,
    shortfall,
    boardChecks,
    occasion,
    suitableCount,
    pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])),
    rejected: rejected.slice(0, 50),
    candidatesConsidered: candidates.length,
    pins: [],
    registerNote: selection.registerNote,
  };
}

export interface SelectOptions {
  /** Explicitly requested pieces: they are in every option, so they are exempt from distinctness. */
  pinned?: Set<string>;
  /** Trip boards (small suitcase) may show the same trousers in two options when stock is short. */
  allowRepeatBottoms?: boolean;
}

export interface BoardSelection {
  chosen: ScoredOption[];
  /** Most options possible with every shirt and trousers distinct (bipartite matching over candidates). */
  distinctLimit: number;
  /** Why registers are less spread than the profile asks, when they are; null otherwise. */
  registerNote: string | null;
}

/** Greedy varied selection; see selectBoardDetailed. */
export function selectBoard(ranked: ScoredOption[], n: number, suitableTarget: number, wholeBoard: boolean, opts: SelectOptions = {}): ScoredOption[] {
  return selectBoardDetailed(ranked, n, suitableTarget, wholeBoard, opts).chosen;
}

/**
 * Maximum number of options with pairwise-distinct shirts and (when strict) trousers: a maximum
 * bipartite matching between shirts and trousers over the candidate pairs. Pinned pieces are exempt.
 */
function maxDistinct(cands: ScoredOption[], usedTops: Set<string>, usedBottoms: Set<string>, pinned: Set<string>, strictBottoms: boolean, cap: number): number {
  const adj = new Map<string, Set<string>>();
  cands.forEach((o, i) => {
    const t = o.validation.parts.top?.garmentId ?? `none:${i}`;
    const b = o.validation.parts.bottom?.garmentId ?? `none:${i}`;
    if (usedTops.has(t) || usedBottoms.has(b)) return;
    const tk = pinned.has(t) ? `pin:${i}` : t;
    const bk = pinned.has(b) || !strictBottoms ? `pin:${i}` : b;
    if (!adj.has(tk)) adj.set(tk, new Set());
    adj.get(tk)!.add(bk);
  });
  const matchOf = new Map<string, string>();
  const tryAugment = (t: string, seen: Set<string>): boolean => {
    for (const b of adj.get(t)!) {
      if (seen.has(b)) continue;
      seen.add(b);
      const owner = matchOf.get(b);
      if (owner === undefined || tryAugment(owner, seen)) {
        matchOf.set(b, t);
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (const t of adj.keys()) {
    if (size >= cap) break;
    if (tryAugment(t, new Set())) size++;
  }
  return size;
}

/**
 * Board selection (spec section 7 step 4; profile sections 3 and 6). Shirts and trousers are distinct
 * across the board: when the pool cannot fill the count that way, fewer options are chosen rather
 * than repeating a piece (trip boards excepted). A feasibility check keeps the greedy choice from
 * blocking a full board that a different choice would allow. Registers are spread: at most half the
 * board (rounded up) shares one register, relaxed only when no full distinct board exists otherwise,
 * and then at least two registers whenever the pool has them; the relaxation is recorded.
 */
export function selectBoardDetailed(ranked: ScoredOption[], n: number, suitableTarget: number, wholeBoard: boolean, opts: SelectOptions = {}): BoardSelection {
  const pinned = opts.pinned ?? new Set<string>();
  const topOf = (o: ScoredOption) => o.validation.parts.top?.garmentId ?? null;
  const bottomOf = (o: ScoredOption) => o.validation.parts.bottom?.garmentId ?? null;
  const distinctKey = (id: string | null) => (id && !pinned.has(id) ? id : null);

  const pick = (strictBottoms: boolean, regCap: number): ScoredOption[] => {
    const target = Math.min(n, maxDistinct(ranked, new Set(), new Set(), pinned, strictBottoms, n));
    const chosen: ScoredOption[] = [];
    let need = suitableTarget;
    // An occasion shapes a subset of the board: unless the owner asked for it on every option, one
    // option stays for the rest of the day (relaxed only when no other candidate exists).
    let keepAlternative = suitableTarget > 0 && !wholeBoard && target > 1;
    const usedTops = new Set<string>();
    const usedBottoms = new Set<string>();
    while (chosen.length < target) {
      const needSuitable = chosen.filter((c) => c.suitable).length < need;
      const options: { o: ScoredOption; adj: number }[] = [];
      for (const o of ranked) {
        if (chosen.includes(o)) continue;
        const p = o.validation.parts;
        const t = distinctKey(topOf(o));
        const b = distinctKey(bottomOf(o));
        if (t && usedTops.has(t)) continue;
        if (strictBottoms && b && usedBottoms.has(b)) continue;
        if ((needSuitable || wholeBoard) && need > 0 && !o.suitable) continue;
        if (keepAlternative && o.suitable && chosen.filter((c) => c.suitable).length >= Math.max(need, target - 1)) continue;
        const reg = o.validation.register;
        if (chosen.filter((c) => c.validation.register === reg).length >= regCap) continue;
        let adj = o.score;
        adj -= 1.5 * chosen.filter((c) => c.validation.register === reg).length;
        if (reg === 'home_key' && chosen.some((c) => c.validation.register === 'home_key')) adj -= 2;
        adj -= 0.6 * chosen.filter((c) => c.validation.parts.footwear[0]?.garmentId === p.footwear[0]?.garmentId).length;
        adj -= 1.6 * chosen.filter((c) => p.outer && c.validation.parts.outer?.garmentId === p.outer.garmentId).length;
        adj -= 0.5 * chosen.filter((c) => c.validation.parts.top?.fabricClass && c.validation.parts.top.fabricClass === p.top?.fabricClass).length;
        adj -= 0.3 * chosen.filter((c) => c.validation.parts.socks?.garmentId === p.socks?.garmentId).length;
        adj -= 0.4 * chosen.filter((c) => (c.validation.parts.outer === null) === (p.outer === null)).length * 0.5;
        if (!strictBottoms) adj -= 1.5 * chosen.filter((c) => bottomOf(c) === bottomOf(o)).length;
        options.push({ o, adj });
      }
      options.sort((a, b) => b.adj - a.adj);
      let best: ScoredOption | null = null;
      const remainingAfter = target - chosen.length - 1;
      for (const { o } of options) {
        if (remainingAfter <= 0) {
          best = o;
          break;
        }
        const t2 = new Set(usedTops);
        const b2 = new Set(usedBottoms);
        const t = distinctKey(topOf(o));
        const b = distinctKey(bottomOf(o));
        if (t) t2.add(t);
        if (b && strictBottoms) b2.add(b);
        const rest = ranked.filter((x) => x !== o && !chosen.includes(x));
        if (maxDistinct(rest, t2, b2, pinned, strictBottoms, remainingAfter) >= remainingAfter) {
          best = o;
          break;
        }
      }
      if (!best) {
        if (needSuitable && need > 0 && !wholeBoard) {
          // Not enough suitable options: stop requiring suitability rather than stop the board.
          need = chosen.filter((c) => c.suitable).length;
          continue;
        }
        if (keepAlternative) {
          keepAlternative = false;
          continue;
        }
        break;
      }
      chosen.push(best);
      const t = distinctKey(topOf(best));
      const b = distinctKey(bottomOf(best));
      if (t) usedTops.add(t);
      if (b) usedBottoms.add(b);
    }
    return chosen;
  };

  const distinctLimit = Math.min(n, maxDistinct(ranked, new Set(), new Set(), pinned, true, n));
  const caps = [...new Set([Math.max(1, Math.ceil(n / 2)), Math.max(1, n - 1), n])];
  let chosen: ScoredOption[] = [];
  let capUsed = caps[0]!;
  for (const cap of caps) {
    const c = pick(true, cap);
    if (c.length > chosen.length) {
      chosen = c;
      capUsed = cap;
    }
    if (c.length >= distinctLimit) break;
  }
  if (opts.allowRepeatBottoms && chosen.length < n) {
    for (const cap of caps) {
      const c = pick(false, cap);
      if (c.length > chosen.length) {
        chosen = c;
        capUsed = cap;
      }
      if (c.length >= n) break;
    }
  }

  // One register only (the home key or any other) while the pool offers another: replace the weakest
  // option whose removal keeps the occasion subset intact with the best candidate of another register
  // that repeats no shirt or trousers. The home key is the floor, never the only thing offered.
  if (chosen.length > 1 && new Set(chosen.map((c) => c.validation.register)).size === 1) {
    const reg = chosen[0]!.validation.register;
    const need = Math.min(suitableTarget, chosen.filter((c) => c.suitable).length);
    const keepAlt = suitableTarget > 0 && !wholeBoard && chosen.some((c) => !c.suitable);
    for (let i = chosen.length - 1; i >= 0; i--) {
      const others = chosen.filter((_, j) => j !== i);
      const alt = ranked.find(
        (o) =>
          o.validation.register !== reg &&
          !chosen.includes(o) &&
          !others.some((c) => distinctKey(topOf(o)) && topOf(c) === topOf(o)) &&
          (opts.allowRepeatBottoms || !others.some((c) => distinctKey(bottomOf(o)) && bottomOf(c) === bottomOf(o))) &&
          (!wholeBoard || suitableTarget === 0 || o.suitable) &&
          others.filter((c) => c.suitable).length + (o.suitable ? 1 : 0) >= need &&
          (!keepAlt || others.some((c) => !c.suitable) || !o.suitable),
      );
      if (alt) {
        chosen[i] = alt;
        break;
      }
    }
  }

  const regs = new Set(chosen.map((c) => c.validation.register));
  const largest = Math.max(0, ...[...regs].map((r) => chosen.filter((c) => c.validation.register === r).length));
  let registerNote: string | null = null;
  if (chosen.length > 1 && regs.size < 2) {
    registerNote = `Every option is in the ${[...regs][0]!.replace(/_/g, ' ')} register: the pieces available today do not combine into ${chosen.length} distinct outfits in any other register.`;
  } else if (chosen.length > 1 && largest > Math.ceil(chosen.length / 2) && capUsed > Math.ceil(n / 2)) {
    registerNote = `Registers are less spread than usual (${largest} of ${chosen.length} options share one): the pieces available today make no more varied board without repeating a shirt or trousers.`;
  }

  // Order: suitable options first when an occasion applies; a safe option never leads.
  chosen.sort((a, b) => Number(b.suitable ?? 0) - Number(a.suitable ?? 0) || b.score - a.score);
  const leadIsSafe = (o: ScoredOption) => o.validation.safe || o.validation.register === 'home_key';
  if (chosen.length > 1 && leadIsSafe(chosen[0]!)) {
    const i = chosen.findIndex((o) => !leadIsSafe(o) && (o.suitable ?? true) === (chosen[0]!.suitable ?? true));
    if (i > 0) [chosen[0], chosen[i]] = [chosen[i]!, chosen[0]!];
  }
  return { chosen, distinctLimit, registerNote };
}

export function occasionPhrase(occasion: Occasion | null, title: string | null): string | null {
  if (!occasion) return null;
  const label = OCCASION_LABEL[occasion];
  if (occasion === 'formal' && title && /client/i.test(title)) return 'client meeting';
  return label;
}

export type { BoardRegister };
