import type { BoardRegister, GarmentRole } from '@garderobe/contracts';
import type { MandatoryContext } from './context.js';
import {
  COOL_FAMILIES,
  WARM_FAMILIES,
  isBlazer,
  isChino,
  isDenim,
  isFieldPiece,
  isJeans,
  isNewBalance,
  isOxfordButtonDown,
  isScarf,
  isStripe,
  isTextured,
  isTie,
  isWashed,
  jeansNameProblem,
  type WardrobeGarment,
} from './garments.js';
import { ruleRef } from './profile.js';

/**
 * Deterministic validation (spec section 7, step 3). Every candidate — from the composer, a model,
 * a reserve, a swap or a carried-over option — passes the same checks before it can be offered.
 * Hard violations reject; soft findings only shape ranking. Each check names its rule and passage.
 */

export interface CandidateSlot {
  garmentId: string;
  role: GarmentRole;
  alternativeGroup?: string | null;
}

export interface Candidate {
  slots: CandidateSlot[];
  source?: 'composer' | 'model' | 'reserve' | 'carried' | 'swap' | 'repair';
}

export interface Check {
  ruleKey: string;
  strength: 'hard' | 'soft';
  passed: boolean;
  detail: string;
  garmentIds?: string[];
  passage?: { section: string | null; quote: string | null };
}

export interface OutfitParts {
  top: WardrobeGarment | null;
  mid: WardrobeGarment | null;
  outer: WardrobeGarment | null;
  bottom: WardrobeGarment | null;
  socks: WardrobeGarment | null;
  footwear: WardrobeGarment[];
  belt: WardrobeGarment | null;
  flourish: WardrobeGarment | null;
}

export interface OutfitValidation {
  valid: boolean;
  checks: Check[];
  violations: Check[];
  warnings: Check[];
  parts: OutfitParts;
  registers: BoardRegister[];
  register: BoardRegister;
  safe: boolean;
  statementCount: number;
}

export interface ValidateOptions {
  /** The swap being validated: a replacement must not be a navy fallback unless explicitly requested. */
  swap?: { role: GarmentRole; replacedGarmentId: string; replacementGarmentId: string; explicit: boolean };
  /** Trip boards: an explicit packing request permits deliberate reuse. */
  allowRepeats?: boolean;
}

const REGISTER_ORDER: BoardRegister[] = ['academic_blazer', 'field_workwear', 'sprezzatura', 'rl_ivy', 'fun_lane', 'home_key', 'other'];
const LAUNDERED = ['per_wear', 'single_wear_day'];

export function partsOf(c: Candidate, ctx: MandatoryContext): OutfitParts {
  const get = (role: GarmentRole) => c.slots.filter((s) => s.role === role).map((s) => ctx.byId.get(s.garmentId)).filter((g): g is WardrobeGarment => Boolean(g));
  return {
    top: get('base_top')[0] ?? null,
    mid: get('mid_layer')[0] ?? null,
    outer: get('outer_layer')[0] ?? null,
    bottom: get('bottom')[0] ?? null,
    socks: get('socks')[0] ?? null,
    footwear: get('footwear'),
    belt: get('belt')[0] ?? null,
    flourish: get('accessory')[0] ?? null,
  };
}

export function upperFamilies(p: OutfitParts): string[] {
  return [...new Set([p.top, p.mid, p.outer, p.flourish].flatMap((g) => g?.families ?? []))];
}

export function registersOf(p: OutfitParts): BoardRegister[] {
  const r = new Set<BoardRegister>();
  const { top, outer, bottom, flourish } = p;
  if (outer && isBlazer(outer)) r.add('academic_blazer');
  if (outer && isFieldPiece(outer)) r.add('field_workwear');
  if (top && flourish && isTie(flourish) && (isWashed(top) || top.fabricClass === 'lightweight_oxford') && bottom && !/flannel/i.test(bottom.name)) r.add('sprezzatura');
  if (top && bottom && ((isStripe(top) && isOxfordButtonDown(top) && isJeans(bottom)) || (isDenim(top) && (isChino(bottom) || /fatigue/i.test(bottom.name) || isJeans(bottom))))) r.add('rl_ivy');
  if (top?.statement && bottom && !bottom.statement && p.socks && p.socks.families.some((f) => top.families.includes(f))) r.add('fun_lane');
  if (top && bottom && isOxfordButtonDown(top) && isChino(bottom) && p.footwear.some(isNewBalance) && !top.statement && !(flourish && isTie(flourish))) r.add('home_key');
  if (!r.size) r.add('other');
  return REGISTER_ORDER.filter((x) => r.has(x));
}

/** The drone (profile section 6): white shirt, blue chino, safe permutations; jeans and the wide stripe. */
export function isSafePermutation(p: OutfitParts): boolean {
  const { top, bottom } = p;
  if (!top || !bottom) return false;
  const plainPale = !top.pattern && top.families.length > 0 && top.families.every((f) => ['white', 'blue'].includes(f));
  if (plainPale && isChino(bottom) && bottom.families.some((f) => ['navy', 'blue', 'beige'].includes(f)) && !p.outer && !p.flourish) return true;
  if (/wide stripe/i.test(top.pattern ?? '') && isJeans(bottom)) return true;
  return false;
}

function check(ctx: MandatoryContext, ruleKey: string, passed: boolean, detail: string, garmentIds?: string[], strength?: 'hard' | 'soft'): Check {
  const ref = ruleRef(ctx.policy, ruleKey);
  return { ruleKey, strength: strength ?? ref.strength, passed, detail, ...(garmentIds?.length ? { garmentIds } : {}), passage: { section: ref.section, quote: ref.quote } };
}

export function validateOutfit(c: Candidate, ctx: MandatoryContext, opts: ValidateOptions = {}): OutfitValidation {
  const checks: Check[] = [];
  const add = (ch: Check) => checks.push(ch);
  const { policy } = ctx;
  const peak = ctx.thermal.peakTempC;
  const departure = ctx.thermal.departureTempC;

  // --- integrity: real owned garments in correct roles, one complete outfit
  const unknown = c.slots.filter((s) => !ctx.byId.has(s.garmentId));
  add(check(ctx, 'integrity.known_garment', unknown.length === 0, unknown.length ? `Not an owned garment of this wardrobe: ${unknown.map((s) => s.garmentId).join(', ')}` : 'Every garment ID is a real owned record', unknown.map((s) => s.garmentId), 'hard'));
  const wrongRole = c.slots.filter((s) => {
    const g = ctx.byId.get(s.garmentId);
    if (!g) return false;
    if (!g.roles.includes(s.role)) return true;
    return s.role === 'accessory' && !isTie(g) && !isScarf(g) && g.category !== 'accessory';
  });
  add(check(ctx, 'integrity.role', wrongRole.length === 0, wrongRole.length ? `Role not served by the garment: ${wrongRole.map((s) => `${ctx.byId.get(s.garmentId)!.name} as ${s.role}`).join('; ')}` : 'Each garment fills a role it can serve', wrongRole.map((s) => s.garmentId), 'hard'));
  const count = (role: GarmentRole) => c.slots.filter((s) => s.role === role).length;
  const dup = c.slots.length !== new Set(c.slots.map((s) => s.garmentId)).size;
  const footwearSlots = c.slots.filter((s) => s.role === 'footwear');
  const footwearGrouped = footwearSlots.length <= 1 || (footwearSlots.every((s) => s.alternativeGroup) && new Set(footwearSlots.map((s) => s.alternativeGroup)).size === 1);
  const structural: string[] = [];
  if (count('base_top') + count('one_piece') !== 1) structural.push('exactly one shirt or top');
  if (count('bottom') + count('one_piece') !== 1) structural.push('exactly one pair of trousers');
  if (footwearSlots.length < 1) structural.push('footwear');
  if (!footwearGrouped) structural.push('footwear alternatives in one alternative group');
  if (count('outer_layer') > 1 || count('mid_layer') > 1 || count('belt') > 1 || count('socks') > 1 || count('accessory') > 1) structural.push('at most one of each layer, belt, socks and flourish');
  if (c.slots.some((s) => ['underwear', 'indoor'].includes(s.role))) structural.push('no underwear or indoor slots on a board');
  if (dup) structural.push('no garment twice');
  add(check(ctx, 'integrity.complete', structural.length === 0, structural.length ? `Incomplete or malformed outfit: needs ${structural.join(', ')}` : 'Complete outfit', undefined, 'hard'));

  const p = partsOf(c, ctx);
  const known = c.slots.map((s) => ctx.byId.get(s.garmentId)).filter((g): g is WardrobeGarment => Boolean(g));

  // --- availability: owned, at home, not restricted, planned, clean (estimated), explicitly requested if occasional
  const unavailable: string[] = [];
  const unavailableIds: string[] = [];
  for (const g of known) {
    const why: string[] = [];
    if (!g.eligibility.available) why.push(g.eligibility.reasons.join('; ') || g.eligibility.label);
    if (g.planningPolicy === 'occasional' && !ctx.request.include.includes(g.garmentId)) why.push('occasional piece not requested');
    if (g.indoorOnly) why.push('indoor only');
    if (LAUNDERED.includes(g.laundryPolicy) && (!g.estimate || !g.estimate.eligible || g.estimate.estimatedCleanUnits <= 0)) why.push('no clean unit (dirty or away)');
    if (why.length) {
      unavailable.push(`${g.name}: ${why.join('; ')}`);
      unavailableIds.push(g.garmentId);
    }
  }
  add(check(ctx, 'availability.eligible', unavailable.length === 0, unavailable.length ? `Unavailable: ${unavailable.join(' | ')}` : 'Every piece is owned, at home, unrestricted and estimated clean', unavailableIds, 'hard'));

  // --- hard.socks_always
  if (policy.socks.required) {
    const s = p.socks;
    const merino = s?.fabricClass === policy.socks.defaultFabricClass;
    const ok = Boolean(s) && !s!.indoorOnly && (merino || (s!.thermal.minC <= peak && peak <= s!.thermal.maxC));
    add(check(ctx, 'hard.socks_always', ok, !s ? 'No socks: every outfit has socks, in any weather' : ok ? `Socks: ${s.name}${merino ? ' (merino default)' : ` (${s.thermal.basis})`}` : `${s.name} is not suitable socks for this outfit (${s.indoorOnly ? 'indoor only' : s.thermal.basis})`, s ? [s.garmentId] : [], 'hard'));
  }

  // --- footwear restriction and pairing
  if (policy.sneakersOnly.active) {
    const bad = p.footwear.filter((f) => f.category !== 'sneakers' || f.attributes.construction === 'welted' || f.attributes.model === '990v6');
    add(check(ctx, 'hard.sneakers_only_until_healed', bad.length === 0, bad.length ? `Sneakers only until the owner says his feet have healed: ${bad.map((b) => b.name).join(', ')} excluded` : 'Sneakers only (healing restriction active)', bad.map((b) => b.garmentId), 'hard'));
  }
  if (policy.sneakerAndWelted.active) {
    const wearableWelted = ctx.wardrobe.some((g) => g.footwearKind === 'welted' && g.eligibility.available);
    const wearableSneaker = ctx.wardrobe.some((g) => g.footwearKind === 'sneaker' && g.eligibility.available);
    const both = wearableWelted && wearableSneaker;
    const ok = !both || (p.footwear.some((f) => f.footwearKind === 'sneaker') && p.footwear.some((f) => f.footwearKind === 'welted') && footwearGrouped && p.footwear.length === 2);
    add(check(ctx, 'hard.sneaker_and_welted_alternative', ok, !both ? 'Pairing not applicable: a sneaker and a welted shoe are not both wearable' : ok ? 'Names a sneaker and a welted alternative' : 'Must name one sneaker and one welted alternative now the fleet has returned', p.footwear.map((f) => f.garmentId), 'hard'));
  }

  // --- thermal rules
  if (policy.thermal.peakForBase) {
    const base = [p.top, p.mid, p.bottom].filter((g): g is WardrobeGarment => Boolean(g));
    const bad = base.filter((g) => !(g.thermal.minC <= peak && peak <= g.thermal.maxC));
    add(check(ctx, 'hard.thermal_peak_for_base', bad.length === 0, bad.length ? `Not for a ${peak} °C peak: ${bad.map((g) => `${g.name} (${g.thermal.minC}–${g.thermal.maxC} °C, ${g.thermal.basis})`).join('; ')}` : `Shirt and trousers chosen for the ${peak} °C peak (${ctx.thermal.source})`, bad.map((g) => g.garmentId), 'hard'));
  }
  if (policy.thermal.morningForOuterwear) {
    const needOuter = Math.round(departure) < 14;
    const o = p.outer;
    const fits = !o || (o.thermal.minC <= departure && departure <= o.thermal.maxC);
    const ok = fits && (!needOuter || Boolean(o));
    add(
      check(
        ctx,
        'hard.thermal_morning_for_outerwear',
        ok,
        !fits ? `${o!.name} does not answer a ${departure} °C departure (${o!.thermal.minC}–${o!.thermal.maxC} °C)` : needOuter && !o ? `A ${departure} °C departure needs a jacket (implementation reading: a start below 14 °C is a cool start)` : o ? `${o.name} for the ${departure} °C departure` : `No jacket needed at a ${departure} °C departure`,
        o ? [o.garmentId] : [],
        'hard',
      ),
    );
    if (p.mid && p.outer && departure >= 12) add(check(ctx, 'comfort.layering', false, 'Knit and jacket together are too warm above a 12 °C departure', [p.mid.garmentId, p.outer.garmentId], 'hard'));
  }
  if (policy.jacketBand.active && p.outer) {
    const t = Math.round(departure);
    const inBand = t >= policy.jacketBand.minC && t <= policy.jacketBand.maxC;
    const ok = !inBand || (p.top?.fabricClass === policy.jacketBand.requiredBaseFabricClass && !p.mid);
    add(
      check(
        ctx,
        'hard.thermal_jacket_14_16_lightweight_oxford',
        ok,
        !inBand ? `Jacket worn at ${departure} °C, outside the ${policy.jacketBand.minC}–${policy.jacketBand.maxC} °C band` : ok ? `Jacket at ${departure} °C over a lightweight oxford` : `At ${departure} °C a jacket goes over a lightweight oxford only; ${p.top?.name ?? 'this top'} is too warm underneath`,
        [p.outer.garmentId, ...(p.top ? [p.top.garmentId] : [])],
        'hard',
      ),
    );
  }

  // --- hard.variety_seven_days
  if (policy.repeat.active && !opts.allowRepeats) {
    const from = addDaysLocal(ctx.day.date, -policy.repeat.horizonDays);
    const repeats = known.filter((g) => c.slots.some((s) => s.garmentId === g.garmentId && policy.repeat.roles.includes(s.role)) && g.wornDates.some((d) => d >= from && d < ctx.day.date));
    add(check(ctx, 'hard.variety_seven_days', repeats.length === 0, repeats.length ? `Worn in the last ${policy.repeat.horizonDays} days (a repeat): ${repeats.map((g) => `${g.name} on ${g.lastWornOn}`).join('; ')}` : `No shirt or trousers worn in the last ${policy.repeat.horizonDays} days`, repeats.map((g) => g.garmentId), 'hard'));
  }

  // --- hard.perceptible_names
  if (policy.names.active) {
    const problems = known.map((g) => jeansNameProblem(g, policy.names.jeansShades) ?? (/\bPCF\d+\b/.test(g.name) ? `${g.name} carries a maker code` : null)).filter((x): x is string => Boolean(x));
    add(check(ctx, 'hard.perceptible_names', problems.length === 0, problems.length ? problems.join('; ') : 'Names are what he sees at the wardrobe', undefined, 'hard'));
  }

  // --- colour.no_neutral_three_times (each footwear alternative checked as its own outfit)
  if (policy.neutrals.active) {
    const visibleBase = [p.outer, p.mid, p.top, p.bottom, p.socks, p.belt].filter((g): g is WardrobeGarment => Boolean(g));
    const alternatives = p.footwear.length ? p.footwear.map((f) => [...visibleBase, f]) : [visibleBase];
    let worst: { family: string; n: number } | null = null;
    for (const set of alternatives) {
      for (const fam of policy.neutrals.families) {
        const n = set.filter((g) => g.families.includes(fam)).length;
        if (n > policy.neutrals.max && (!worst || n > worst.n)) worst = { family: fam, n };
      }
    }
    add(check(ctx, 'colour.no_neutral_three_times', !worst, worst ? `${worst.family} appears ${worst.n} times in one outfit` : 'No single neutral three times'));
  }

  // --- accessories and filters
  const forbidden = known.filter((g) => /watch|\bring\b|bracelet|necklace|jewel|cufflink/i.test(g.name) || g.tags.some((t) => policy.forbiddenAccessoryTypes.includes(t)));
  add(check(ctx, 'accessories.no_watches_or_jewellery', forbidden.length === 0, forbidden.length ? `No watches or jewellery: ${forbidden.map((g) => g.name).join(', ')}` : 'No watch or jewellery suggested', forbidden.map((g) => g.garmentId), 'hard'));
  const filtered = known.filter((g) => g.tags.some((t) => policy.excludedTags.includes(t)));
  add(check(ctx, 'filter.categories_out', filtered.length === 0, filtered.length ? `Filtered out by the profile: ${filtered.map((g) => g.name).join(', ')}` : 'Nothing from the filtered-out categories', filtered.map((g) => g.garmentId), 'hard'));
  const excluded = known.filter((g) => ctx.request.exclude.includes(g.garmentId));
  if (ctx.request.exclude.length) add(check(ctx, 'request.exclusions', excluded.length === 0, excluded.length ? `Excluded by the owner today: ${excluded.map((g) => g.name).join(', ')}` : 'Respects the owner\'s exclusions', excluded.map((g) => g.garmentId), 'hard'));

  // --- owner comfort directions (scoped to garment and situation) and observations
  for (const d of ctx.comfort.directions.filter((x) => x.applies)) {
    const hit = known.filter((g) => d.garmentIds.includes(g.garmentId));
    const where = d.activity ?? d.setting;
    add({
      ruleKey: d.ruleKey,
      strength: 'hard',
      passed: hit.length === 0,
      detail: hit.length ? `The owner asked: “${d.statement}” — ${hit.map((g) => g.name).join(', ')}${where ? ` is not for ${where}, and today includes “${d.matchedOn}”` : ''}` : `Respects the owner's comfort direction “${d.statement}”`,
      ...(hit.length ? { garmentIds: hit.map((g) => g.garmentId) } : {}),
      passage: { section: null, quote: d.statement },
    });
  }
  const cautioned = known.filter((g) => ctx.comfort.cautioned.has(g.garmentId));
  if (cautioned.length) {
    const o = ctx.comfort.cautioned.get(cautioned[0]!.garmentId)!;
    add({ ruleKey: 'comfort.observation', strength: 'soft', passed: false, detail: `${cautioned[0]!.name}: the owner noted “${o.text}”, and today includes “${o.matchedOn}”`, garmentIds: cautioned.map((g) => g.garmentId), passage: { section: null, quote: o.text } });
  }

  // --- swaps never fall back to navy
  if (opts.swap && policy.navyFallback.active) {
    const r = ctx.byId.get(opts.swap.replacementGarmentId);
    const navy = Boolean(r && (r.families.includes(policy.navyFallback.colorFamily) || r.colorFamily === policy.navyFallback.colorFamily));
    const ok = !navy || opts.swap.explicit;
    add(check(ctx, 'hard.never_fall_back_to_navy', ok, !navy ? 'Replacement is not a navy fallback' : ok ? 'Navy replacement explicitly requested by the owner' : `${r!.name} would be a navy fallback`, r ? [r.garmentId] : [], 'hard'));
  }

  // --- soft signals
  const uppers = upperFamilies(p);
  const bottomFams = p.bottom?.families ?? [];
  if (policy.footEcho && p.socks) {
    const echo = p.socks.families.some((f) => uppers.includes(f) && !bottomFams.includes(f));
    const matchesTrouser = p.socks.families.some((f) => bottomFams.includes(f));
    add(check(ctx, 'colour.foot_echoes_higher_up', echo && !matchesTrouser, echo ? 'The socks echo a colour higher up' : matchesTrouser ? 'The socks repeat the trouser colour' : 'The socks do not echo the upper half', [p.socks.garmentId], 'soft'));
  }
  const statements = [p.outer, p.mid, p.top, p.bottom].filter((g) => g?.statement).length;
  add(check(ctx, 'register.avoid_clown', statements <= policy.maxStatementPieces, statements > policy.maxStatementPieces ? `${statements} statement pieces: colour on colour on colour` : 'At most one loud piece', undefined, 'soft'));
  const repels = known.filter((g) => ['moleskin', 'napped_surface', 'synthetic', 'sheen'].includes(g.fabricClass ?? '') || /moleskin/i.test(g.fabric ?? ''));
  if (repels.length) add(check(ctx, 'fabric.repels', false, `Owned but on the repel list: ${repels.map((g) => g.name).join(', ')}`, repels.map((g) => g.garmentId), 'soft'));
  if (policy.beltFlourish) add(check(ctx, 'accessories.belt_line_optional_flourish', Boolean(p.flourish), p.flourish ? `Optional flourish: ${p.flourish.name}` : 'No scarf or tie suggestion on the belt line', undefined, 'soft'));

  const violations = checks.filter((x) => x.strength === 'hard' && !x.passed);
  const warnings = checks.filter((x) => x.strength === 'soft' && !x.passed);
  const registers = registersOf(p);
  return { valid: violations.length === 0, checks, violations, warnings, parts: p, registers, register: registers[0]!, safe: isSafePermutation(p), statementCount: statements };
}

function addDaysLocal(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Board-level checks (spec section 7 step 4; profile sections 3 and 6). */
export function validateBoard(
  options: { validation: OutfitValidation; slots: CandidateSlot[] }[],
  ctx: MandatoryContext,
  poolAllowsOtherRegister: boolean,
  opts: { pinned?: Set<string>; allowRepeats?: boolean; registerNote?: string | null } = {},
): Check[] {
  const out: Check[] = [];
  const pinned = opts.pinned ?? new Set<string>();
  // A piece the owner explicitly asked for is in every option by design; it is exempt from distinctness.
  const tops = options.map((o) => o.validation.parts.top?.garmentId).filter((id): id is string => Boolean(id) && !pinned.has(id!));
  const bottoms = options.map((o) => o.validation.parts.bottom?.garmentId).filter((id): id is string => Boolean(id) && !pinned.has(id!));
  out.push({ ruleKey: 'board.distinct_shirts', strength: 'hard', passed: new Set(tops).size === tops.length, detail: new Set(tops).size === tops.length ? 'Every option has its own shirt' : 'A shirt repeats within the board' });
  const bottomsDistinct = new Set(bottoms).size === bottoms.length;
  out.push({
    ruleKey: 'board.distinct_trousers',
    strength: opts.allowRepeats ? 'soft' : 'hard',
    passed: bottomsDistinct,
    detail: bottomsDistinct ? 'Every option has its own trousers' : opts.allowRepeats ? 'Trousers repeat within the trip board (the suitcase is too small for all distinct)' : 'Trousers repeat within the board',
  });
  const allHome = options.length > 0 && options.every((o) => o.validation.register === 'home_key');
  const homeRef = ruleRef(ctx.policy, 'register.home_key_never_only');
  if (ctx.policy.homeKeyNeverOnly) {
    out.push({ ruleKey: 'register.home_key_never_only', strength: 'hard', passed: !allHome || !poolAllowsOtherRegister, detail: !allHome ? 'The home key is not the only register offered' : poolAllowsOtherRegister ? 'Only the home key is offered although other registers are possible' : 'Only home-key outfits are possible from the eligible pool', passage: { section: homeRef.section, quote: homeRef.quote } });
  }
  if (ctx.policy.safeNeverLeads && options.length > 1) {
    const lead = options[0]!.validation;
    out.push({ ruleKey: 'register.safe_never_leads', strength: 'soft', passed: !lead.safe && lead.register !== 'home_key', detail: lead.safe || lead.register === 'home_key' ? 'A safe option leads the board' : 'The lead option is not a safe permutation' });
  }
  const regs = new Set(options.map((o) => o.validation.register));
  const largest = Math.max(0, ...[...regs].map((r) => options.filter((o) => o.validation.register === r).length));
  const spread = options.length <= 1 || (regs.size >= 2 && largest <= Math.ceil(options.length / 2));
  out.push({ ruleKey: 'board.register_spread', strength: 'soft', passed: spread, detail: `Registers: ${[...regs].join(', ')}${spread ? '' : ` — ${opts.registerNote ?? `${largest} of ${options.length} options share one register`}`}` });
  return out;
}

export const WARM = WARM_FAMILIES;
export const COOL = COOL_FAMILIES;
export { isTextured };
