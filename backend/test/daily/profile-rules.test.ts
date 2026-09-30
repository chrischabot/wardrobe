import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { GarmentRole } from '@garderobe/contracts';
import { selectBoard, type ScoredOption } from '../../src/recommend/compose.js';
import type { MandatoryContext } from '../../src/recommend/context.js';
import { validateOutfit, type CandidateSlot } from '../../src/recommend/validate.js';
import type { WeatherScenario } from '../../src/weather/fake.js';
import { ownerScenario, type Scenario } from '../helpers/daily.js';
import { run } from '../helpers/fixtures.js';

const DATE = '2026-10-06';

function withSlot(slots: CandidateSlot[], role: GarmentRole, garmentId: string | null): CandidateSlot[] {
  const rest = slots.filter((s) => s.role !== role);
  return garmentId ? [...rest, { garmentId, role, alternativeGroup: null }] : rest;
}
const garmentsOf = (ctx: MandatoryContext, slots: CandidateSlot[], role: GarmentRole) => slots.filter((s) => s.role === role).map((s) => ctx.byId.get(s.garmentId)!);
const violations = (v: ReturnType<typeof validateOutfit>) => v.violations.map((x) => x.ruleKey);
async function sneakersRestrictionId(s: Scenario): Promise<string> {
  const r = await env.DB.prepare("SELECT restriction_id FROM restrictions WHERE user_id = ? AND rule_key = 'hard.sneakers_only_until_healed' AND lifted_at IS NULL").bind(s.userId).first<{ restriction_id: string }>();
  return r!.restriction_id;
}
/** Departure 12 °C at 08:00, 17 °C peak (spec section 7: does not trigger the 14–16 rule). */
const twelveToSeventeen: WeatherScenario = (_d, h) => ({ temperatureC: h <= 8 ? 12 : h >= 13 && h <= 16 ? 17 : 14 });

describe('hard.socks_always — socks always, wicking merino by default', () => {
  it('every option has socks, merino by default, in mild weather and in heat', async () => {
    for (const scenario of ['mild', 'heat', 'heavyRain'] as const) {
      const s = await ownerScenario({ weather: { scenario } });
      const { context, composed } = await s.rec.compose({ date: DATE });
      expect(composed.options.length).toBeGreaterThan(0);
      for (const o of composed.options) {
        const socks = garmentsOf(context, o.slots, 'socks');
        expect(socks).toHaveLength(1);
        if (scenario !== 'mild' || context.thermal.peakTempC > 12) expect(socks[0]!.fabricClass).toBe('merino');
        expect(o.validation.checks.find((c) => c.ruleKey === 'hard.socks_always')).toMatchObject({ passed: true, strength: 'hard' });
      }
    }
  });

  it('rejects a sockless outfit and indoor-only bed socks, and admits no temporary exception', async () => {
    const s = await ownerScenario();
    const { context, composed } = await s.rec.compose({ date: DATE });
    const base = composed.options[0]!.slots;
    const sockless = validateOutfit({ slots: withSlot(base, 'socks', null) }, context);
    expect(sockless.valid).toBe(false);
    expect(violations(sockless)).toContain('hard.socks_always');
    const bed = await s.byName('Alpaca bed sock — clotted cream');
    const bedSocks = validateOutfit({ slots: withSlot(base, 'socks', bed) }, context);
    expect(bedSocks.valid).toBe(false);
    expect(violations(bedSocks)).toEqual(expect.arrayContaining(['availability.eligible', 'hard.socks_always']));
    const brief = await run(s.principal, { type: 'set_temporary_brief', text: 'Loafers without socks today', validFrom: DATE, validTo: DATE, overridesRuleKey: 'hard.socks_always' });
    expect(brief.outcome).toBe('rejected');
    expect(brief.error?.code).toBe('rule_admits_no_exception');
  });

  it('merino stays wearable in a heatwave while alpaca socks appear only at 12 °C or colder', async () => {
    const cold = await ownerScenario({ weather: { scenario: 'coldSnap' } });
    const c = await cold.rec.compose({ date: DATE });
    const alpaca = c.context.wardrobe.find((g) => g.name === 'Alpaca — inky blue')!;
    expect(c.context.byId.get(alpaca.garmentId)!.thermal.maxC).toBe(12);
    const hot = await ownerScenario({ weather: { scenario: 'heat' } });
    const h = await hot.rec.compose({ date: DATE });
    for (const o of h.composed.options) expect(garmentsOf(h.context, o.slots, 'socks')[0]!.fabricClass).not.toBe('alpaca');
    const withAlpaca = validateOutfit({ slots: withSlot(h.composed.options[0]!.slots, 'socks', h.context.wardrobe.find((g) => g.name === 'Alpaca — inky blue')!.garmentId) }, h.context);
    expect(violations(withAlpaca)).toContain('hard.socks_always');
  });
});

describe('hard.sneakers_only_until_healed and hard.sneaker_and_welted_alternative', () => {
  it('offers only sneakers while the healing restriction stands; welted shoes and a 990v6 are rejected', async () => {
    const s = await ownerScenario();
    const v6 = (await s.cmd({ type: 'add_item', explicit: true, name: 'NB 990v6 — grey', category: 'sneakers', roles: ['footwear'], maker: 'New Balance', color: 'Grey', attributes: { model: '990v6' } })).facts.garmentId as string;
    for (const date of ['2026-10-06', '2026-10-07', '2026-10-08']) {
      const { context, composed } = await s.rec.compose({ date, seed: `seed-${date}` });
      expect(context.policy.sneakersOnly.active).toBe(true);
      expect(context.policy.sneakerAndWelted.active).toBe(false);
      for (const o of composed.options) {
        const shoes = garmentsOf(context, o.slots, 'footwear');
        expect(shoes).toHaveLength(1);
        expect(shoes[0]!.category).toBe('sneakers');
        expect(shoes[0]!.garmentId).not.toBe(v6);
      }
    }
    const { context, composed } = await s.rec.compose({ date: DATE });
    for (const name of ['Paraboot Reims — noir (black)', "Drake's Clifford boot", 'Paraboot Michael Cerf']) {
      const id = context.wardrobe.find((g) => g.name === name)?.garmentId ?? (await s.byName(name));
      const v = validateOutfit({ slots: withSlot(composed.options[0]!.slots, 'footwear', id) }, context);
      expect(violations(v)).toEqual(expect.arrayContaining(['hard.sneakers_only_until_healed', 'availability.eligible']));
    }
    const v = validateOutfit({ slots: withSlot(composed.options[0]!.slots, 'footwear', v6) }, context);
    expect(violations(v)).toContain('hard.sneakers_only_until_healed');
    const brief = await run(s.principal, { type: 'set_temporary_brief', text: 'Paraboots today', validFrom: DATE, validTo: DATE, overridesRuleKey: 'hard.sneakers_only_until_healed' });
    expect(brief.outcome).toBe('rejected');
  });

  it('once the owner says his feet have healed, every option names a sneaker and a welted alternative', async () => {
    const s = await ownerScenario();
    await s.cmd({ type: 'lift_restriction', restrictionId: await sneakersRestrictionId(s), evidence: 'My feet have healed.' });
    const { context, composed } = await s.rec.compose({ date: DATE });
    expect(context.policy.sneakersOnly.active).toBe(false);
    expect(context.policy.sneakerAndWelted.active).toBe(true);
    expect(composed.options).toHaveLength(5);
    for (const o of composed.options) {
      const shoes = o.slots.filter((x) => x.role === 'footwear');
      expect(shoes).toHaveLength(2);
      expect(new Set(shoes.map((x) => x.alternativeGroup))).toEqual(new Set(['footwear']));
      const kinds = shoes.map((x) => context.byId.get(x.garmentId)!.footwearKind).sort();
      expect(kinds).toEqual(['sneaker', 'welted']);
    }
    // A single-shoe outfit is now incomplete under the pairing rule.
    const single = validateOutfit({ slots: o0(composed.options[0]!.slots) }, context);
    expect(violations(single)).toContain('hard.sneaker_and_welted_alternative');
    // The published board keeps both; choosing one is required so a wear never logs both.
    const out = await s.rec.composeAndPublish({ date: DATE });
    const doc = out.board!.document!;
    expect(doc.options[0]!.lines.find((l) => l.kind === 'socks_and_shoes')!.text).toMatch(/, or /);
    const sel = await run(s.principal, { type: 'select_option', boardId: out.board!.boardId, optionId: out.board!.options[0]!.optionId });
    expect(sel.outcome).toBe('rejected');
  });
});

function o0(slots: CandidateSlot[]): CandidateSlot[] {
  const shoes = slots.filter((s) => s.role === 'footwear');
  return [...slots.filter((s) => s.role !== 'footwear'), { ...shoes[0]!, alternativeGroup: null }];
}

describe('hard.thermal_* — peak for shirts and trousers, the morning for outerwear, 14–16 °C over a lightweight oxford', () => {
  it('an 11→19 °C day is a 19 °C outfit with a jacket for the 11 °C start', async () => {
    const s = await ownerScenario({ weather: { scenario: 'elevenToNineteen' } });
    const { context, composed } = await s.rec.compose({ date: DATE });
    expect(context.thermal).toMatchObject({ peakTempC: 19, departureTempC: 11 });
    for (const o of composed.options) {
      const { top, bottom, outer } = o.validation.parts;
      for (const g of [top!, bottom!]) expect(g.thermal.minC <= 19 && 19 <= g.thermal.maxC).toBe(true);
      expect(outer).not.toBeNull();
      expect(outer!.thermal.minC <= 11 && 11 <= outer!.thermal.maxC).toBe(true);
    }
    // A cold-weather flannel answers the 11 °C morning, not the 19 °C day: rejected.
    const flannel = await s.byName('Flannel plaid — grey');
    const v = validateOutfit({ slots: withSlot(composed.options[0]!.slots, 'base_top', flannel) }, context);
    expect(violations(v)).toContain('hard.thermal_peak_for_base');
    // Without a jacket the 11 °C departure is unanswered.
    const bare = validateOutfit({ slots: withSlot(composed.options[0]!.slots, 'outer_layer', null) }, context);
    expect(violations(bare)).toContain('hard.thermal_morning_for_outerwear');
  });

  it('at a 14–16 °C departure a jacket goes over a lightweight oxford only; without a jacket a heavier shirt is fine', async () => {
    const s = await ownerScenario({ weather: { scenario: 'jacketBand' } });
    const { context, composed } = await s.rec.compose({ date: DATE });
    expect(context.thermal.departureTempC).toBe(15);
    expect(composed.options.length).toBe(5);
    for (const o of composed.options) {
      if (o.validation.parts.outer) expect(o.validation.parts.top!.fabricClass).toBe('lightweight_oxford');
      expect(o.validation.checks.find((c) => c.ruleKey === 'hard.thermal_jacket_14_16_lightweight_oxford')?.passed ?? true).toBe(true);
    }
    const pima = await s.byName('Pima oxford — white');
    const jacket = await s.byName("Drake's Olive Jungle Jacket");
    const base = composed.options[0]!.slots;
    const withJacket = validateOutfit({ slots: withSlot(withSlot(base, 'base_top', pima), 'outer_layer', jacket) }, context);
    expect(violations(withJacket)).toContain('hard.thermal_jacket_14_16_lightweight_oxford');
    const noJacket = validateOutfit({ slots: withSlot(withSlot(base, 'base_top', pima), 'outer_layer', null) }, context);
    expect(violations(noJacket)).not.toContain('hard.thermal_jacket_14_16_lightweight_oxford');
  });

  it('a 12 °C departure with a 17 °C peak does not trigger the 14–16 rule; a dated owner exception relaxes it only for that day', async () => {
    const s = await ownerScenario({ weather: { scenario: twelveToSeventeen } });
    const { context, composed } = await s.rec.compose({ date: DATE });
    expect(context.thermal).toMatchObject({ peakTempC: 17, departureTempC: 12 });
    const pima = await s.byName('Pima oxford — white');
    const jacket = await s.byName("Drake's Olive Jungle Jacket");
    const v = validateOutfit({ slots: withSlot(withSlot(composed.options[0]!.slots, 'base_top', pima), 'outer_layer', jacket) }, context);
    expect(violations(v)).not.toContain('hard.thermal_jacket_14_16_lightweight_oxford');

    const band = await ownerScenario({ weather: { scenario: 'jacketBand' } });
    await band.cmd({ type: 'set_temporary_brief', text: 'The Pima under a jacket is fine today', validFrom: DATE, validTo: DATE, overridesRuleKey: 'hard.thermal_jacket_14_16_lightweight_oxford' });
    const b = await band.rec.compose({ date: DATE });
    expect(b.context.policy.jacketBand.active).toBe(false);
    expect(b.context.policy.rules['hard.thermal_jacket_14_16_lightweight_oxford']!.relaxedBy).toMatch(/^brief\./);
    const next = await band.rec.compose({ date: '2026-10-07' });
    expect(next.context.policy.jacketBand.active).toBe(true);
  });

  it('heat: no jacket is proposed and every top and trouser is rated for the 31 °C peak', async () => {
    const s = await ownerScenario({ weather: { scenario: 'heat' } });
    const { composed } = await s.rec.compose({ date: DATE });
    expect(composed.options.length).toBeGreaterThanOrEqual(3);
    for (const o of composed.options) {
      expect(o.validation.parts.outer).toBeNull();
      expect(o.validation.parts.top!.thermal.maxC).toBeGreaterThanOrEqual(31);
      expect(o.validation.parts.bottom!.thermal.maxC).toBeGreaterThanOrEqual(31);
    }
  });
});

describe('hard.variety_seven_days — anything worn in the last seven days is a repeat', () => {
  it('excludes shirts and trousers worn in the previous seven days, not those worn eight days ago', async () => {
    const s = await ownerScenario();
    const recent = await s.byName('Lightweight oxford — gold');
    const trousers = await s.byName('Di Sondrio beige chino');
    const older = await s.byName('Lightweight oxford — pink');
    await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-01', occurredAt: '2026-10-01T08:00:00+01:00', items: [{ garmentId: recent, role: 'base_top' }, { garmentId: trousers, role: 'bottom' }] });
    await s.cmd({ type: 'mark_washed', garmentId: recent, occurredAt: '2026-10-02T08:00:00+01:00' });
    await s.cmd({ type: 'mark_washed', garmentId: trousers, occurredAt: '2026-10-02T08:00:00+01:00' });
    await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-09-28', occurredAt: '2026-09-28T08:00:00+01:00', items: [{ garmentId: older, role: 'base_top' }] });
    await s.cmd({ type: 'mark_washed', garmentId: older, occurredAt: '2026-09-29T08:00:00+01:00' });
    const { context, composed } = await s.rec.compose({ date: DATE });
    for (const o of composed.options) {
      expect(o.slots.map((x) => x.garmentId)).not.toContain(recent);
      expect(o.slots.map((x) => x.garmentId)).not.toContain(trousers);
    }
    const base = composed.options[0]!.slots;
    expect(violations(validateOutfit({ slots: withSlot(base, 'base_top', recent) }, context))).toContain('hard.variety_seven_days');
    expect(violations(validateOutfit({ slots: withSlot(base, 'base_top', older) }, context))).not.toContain('hard.variety_seven_days');
    // A dated owner exception relaxes the repeat rule for that day only; it never makes dirty stock clean.
    await s.cmd({ type: 'set_temporary_brief', text: 'Happy to repeat the gold oxford', validFrom: DATE, validTo: DATE, overridesRuleKey: 'hard.variety_seven_days' });
    const relaxed = await s.rec.compose({ date: DATE });
    expect(violations(validateOutfit({ slots: withSlot(base, 'base_top', recent) }, relaxed.context))).not.toContain('hard.variety_seven_days');
    await s.cmd({ type: 'mark_in_wash', garmentId: recent });
    const dirty = await s.rec.compose({ date: DATE });
    expect(violations(validateOutfit({ slots: withSlot(base, 'base_top', recent) }, dirty.context))).toContain('availability.eligible');
  });
});

describe('hard.never_fall_back_to_navy — a swap never defaults to navy', () => {
  it('an automatic replacement is never navy; an explicitly requested navy piece is allowed', async () => {
    const s = await ownerScenario();
    const { context } = await s.rec.compose({ date: DATE });
    const navyShirt = await s.byName('Pima oxford — navy');
    const board = (await s.rec.composeAndPublish({ date: DATE })).board!;
    // An option where the navy shirt is otherwise a valid fit (so only the navy rule can decide).
    const option = board.options.find((o) => o.status === 'offerable' && validateOutfit({ slots: withSlot(o.slots, 'base_top', navyShirt) }, context).valid)!;
    expect(option).toBeDefined();
    const current = option.slots.find((x) => x.role === 'base_top')!.garmentId;
    const v = validateOutfit({ slots: withSlot(option.slots, 'base_top', navyShirt) }, context, { swap: { role: 'base_top', replacedGarmentId: current, replacementGarmentId: navyShirt, explicit: false } });
    expect(violations(v)).toContain('hard.never_fall_back_to_navy');
    const explicit = validateOutfit({ slots: withSlot(option.slots, 'base_top', navyShirt) }, context, { swap: { role: 'base_top', replacedGarmentId: current, replacementGarmentId: navyShirt, explicit: true } });
    expect(violations(explicit)).not.toContain('hard.never_fall_back_to_navy');

    // Leave only navy shirts clean: the automatic swap declines rather than fall back to navy.
    const onBoard = new Set(board.options.filter((o) => o.status === 'offerable').flatMap((o) => o.slots.map((x) => x.garmentId)));
    for (const g of context.wardrobe.filter((g) => g.roles.includes('base_top') && !g.families.includes('navy') && !onBoard.has(g.garmentId) && g.eligibility.available)) {
      await s.cmd({ type: 'mark_in_wash', garmentId: g.garmentId });
    }
    const auto = await s.rec.swap({ boardDate: DATE, optionId: option.optionId, role: 'base_top' });
    expect(auto.status).toBe('no_valid_replacement');
    const asked = await s.rec.swap({ boardDate: DATE, optionId: option.optionId, role: 'base_top', replacementGarmentId: navyShirt });
    expect(asked.status).toBe('revised');
    expect(asked.changes.find((c) => c.kind === 'swapped')!.replaced).toEqual([{ role: 'base_top', from: context.byId.get(current)!.name, to: 'Pima oxford — navy' }]);
  });

  it('a swap changes only the named slot', async () => {
    const s = await ownerScenario();
    const board = (await s.rec.composeAndPublish({ date: DATE })).board!;
    const before = board.options[1]!;
    const res = await s.rec.swap({ boardDate: DATE, optionId: before.optionId, role: 'base_top' });
    expect(res.status).toBe('revised');
    const after = res.board!.options.find((o) => o.position === before.position)!;
    const keep = (o: typeof before) => o.slots.filter((x) => x.role !== 'base_top').map((x) => `${x.role}:${x.garmentId}`).sort();
    expect(keep(after)).toEqual(keep(before));
    expect(after.slots.find((x) => x.role === 'base_top')!.garmentId).not.toBe(before.slots.find((x) => x.role === 'base_top')!.garmentId);
    const top = res.board!.document!.options.find((o) => o.optionId === after.optionId)!;
    expect(top.lineage).toEqual({ previousOptionId: before.optionId, changedRoles: ['base_top'] });
    // Other options carried unchanged.
    for (const o of board.options.filter((x) => x.optionId !== before.optionId && x.status === 'offerable')) {
      const carried = res.board!.options.find((x) => x.position === o.position)!;
      expect(carried.slots.map((x) => x.garmentId).sort()).toEqual(o.slots.map((x) => x.garmentId).sort());
    }
  });
});

describe('hard.perceptible_names — names are what he sees at the wardrobe', () => {
  it('indigo jeans without a light, mid or dark name cannot be offered; with one they can', async () => {
    const s = await ownerScenario();
    const unnamed = (await s.cmd({ type: 'add_item', explicit: true, name: "Levi's 501 stonewash", category: 'jeans', roles: ['bottom'], color: 'Indigo', fabric: 'Denim', attributes: { fabricClass: 'denim' } })).facts.garmentId as string;
    const named = (await s.cmd({ type: 'add_item', explicit: true, name: 'Jeans — mid', category: 'jeans', roles: ['bottom'], color: 'Indigo', fabric: 'Denim', attributes: { fabricClass: 'denim' } })).facts.garmentId as string;
    const { context, composed } = await s.rec.compose({ date: DATE });
    expect(violations(validateOutfit({ slots: withSlot(composed.options[0]!.slots, 'bottom', unnamed) }, context))).toContain('hard.perceptible_names');
    expect(violations(validateOutfit({ slots: withSlot(composed.options[0]!.slots, 'bottom', named) }, context))).not.toContain('hard.perceptible_names');
    const out = await s.rec.composeAndPublish({ date: DATE });
    expect(out.board!.document!.text).not.toMatch(/PCF\d+/);
    expect(out.board!.document!.text).not.toContain("Levi's 501 stonewash");
    // Every garment line is the record's perceptible name.
    for (const o of out.board!.document!.options) for (const g of o.garments) expect(g.name).toBe(context.byId.get(g.garmentId)!.name);
  });
});

describe('colour, register and accessory rules', () => {
  it('never lets one neutral appear three times; never more than one loud piece; no watches or jewellery', async () => {
    const s = await ownerScenario();
    const watch = (await s.cmd({ type: 'add_item', explicit: true, name: 'Steel wristwatch', category: 'accessory', roles: ['accessory'] })).facts.garmentId as string;
    const { context, composed } = await s.rec.compose({ date: DATE });
    for (const o of composed.options) {
      expect(o.validation.checks.find((c) => c.ruleKey === 'colour.no_neutral_three_times')!.passed).toBe(true);
      expect(o.validation.statementCount).toBeLessThanOrEqual(1);
      expect(o.slots.map((x) => x.garmentId)).not.toContain(watch);
    }
    const navyAll = withSlot(withSlot(withSlot(composed.options[0]!.slots, 'outer_layer', await s.byName("Drake's Navy Cotton-Linen Games Mk.IV")), 'bottom', await s.byName('Single-pleated Di Sondrio navy')), 'footwear', await s.byName('NB 990v4 — navy'));
    expect(violations(validateOutfit({ slots: navyAll }, context))).toContain('colour.no_neutral_three_times');
    expect(violations(validateOutfit({ slots: withSlot(composed.options[0]!.slots, 'accessory', watch) }, context))).toContain('accessories.no_watches_or_jewellery');
  });

  it('spreads registers; the home key is never the only option and a safe option never leads', async () => {
    const s = await ownerScenario({ weather: { scenario: 'heat' } });
    for (const scenario of ['mild', 'heat', 'jacketBand'] as const) {
      s.weather.set({ scenario });
      const { composed } = await s.rec.compose({ date: DATE });
      const regs = composed.options.map((o) => o.validation.register);
      expect(new Set(regs).size).toBeGreaterThanOrEqual(2);
      expect(regs.every((r) => r === 'home_key')).toBe(false);
      expect(composed.options[0]!.validation.safe).toBe(false);
      expect(composed.options[0]!.validation.register).not.toBe('home_key');
      expect(composed.boardChecks.find((c) => c.ruleKey === 'register.home_key_never_only')!.passed).toBe(true);
    }
  });

  it('board selection replaces an all-home-key board and moves a safe lead back', () => {
    const mk = (id: string, register: string, safe: boolean, score: number): ScoredOption =>
      ({ slots: [], score, taste: score, joint: 1, jointDetail: null, devices: [], suitable: null, source: 'composer', validation: { register, registers: [register], safe, statementCount: 0, valid: true, checks: [], violations: [], warnings: [], parts: { top: { garmentId: `t${id}`, fabricClass: 'x' }, bottom: { garmentId: `b${id}` }, outer: null, mid: null, socks: null, footwear: [], belt: null, flourish: null } } }) as unknown as ScoredOption;
    const ranked = [mk('1', 'home_key', true, 10), mk('2', 'home_key', true, 9), mk('3', 'home_key', false, 8), mk('4', 'field_workwear', false, 1)];
    const chosen = selectBoard(ranked, 3, 0, false);
    expect(chosen.some((c) => c.validation.register !== 'home_key')).toBe(true);
    expect(chosen[0]!.validation.register).not.toBe('home_key');
  });

  it('the foot echoes a colour higher up, and each belt line carries an optional scarf or tie', async () => {
    const s = await ownerScenario();
    const out = await s.rec.composeAndPublish({ date: DATE });
    const { composed } = out;
    const echo = composed!.options.filter((o) => o.devices.includes('echo')).length;
    expect(echo).toBeGreaterThanOrEqual(3);
    for (const o of out.board!.document!.options.filter((x) => x.status === 'offerable')) {
      const belt = o.lines.find((l) => l.kind === 'belt')!;
      expect(belt.flourish).not.toBeNull();
      expect(['scarf', 'tie']).toContain(belt.flourish!.kind);
      expect(o.garments.find((g) => g.garmentId === belt.flourish!.garmentId)!.optional).toBe(true);
    }
  });
});

describe('board document follows profile section 11', () => {
  it('day line closing on the shape of the day, five outfits, each opening with a why, then jacket, shirt, trousers, belt with flourish, socks with shoes', async () => {
    const s = await ownerScenario({ weather: { scenario: 'rainAfterFour' } });
    const out = await s.rec.composeAndPublish({ date: DATE });
    const doc = out.board!.document!;
    expect(doc.documentVersion).toBe('board-document/1');
    expect(doc.dayLine).toBe('Tuesday: 13 °C leaving, 18 °C later; rain after 4. Nothing in the calendar: the day is yours.');
    expect(doc.dayLine.endsWith(doc.shapeOfDay)).toBe(true);
    expect(doc.options.filter((o) => o.status === 'offerable')).toHaveLength(5);
    expect(doc.prose).toBe('deterministic');
    for (const o of doc.options) {
      expect(o.lines.map((l) => l.kind)).toEqual(['jacket', 'shirt', 'trousers', 'belt', 'socks_and_shoes']);
      expect(o.why.length).toBeGreaterThan(30);
      expect(o.why).toMatch(/\.$/);
    }
    const blocks = doc.text.split('\n\n');
    expect(blocks[0]).toBe(doc.dayLine);
    expect(blocks[1]).toMatch(/^1\. /);
    const labels = blocks[2]!.split('\n').map((l) => l.trim().split(':')[0]!);
    expect(labels.filter((l) => !l.startsWith('optional'))).toEqual(['Jacket', 'Shirt', 'Trousers', 'Belt', 'Socks and shoes']);
    expect(labels[4]).toMatch(/^optional (scarf|tie)$/);
    expect(doc.text).not.toMatch(/\b(g|opt|brd)_[a-f0-9]{8}/);
    expect(doc.weather).toMatchObject({ peakTempC: 18, departureTempC: 13.2, rainStartsAt: '16:00', line: '13 °C leaving, 18 °C later; rain after 4' });
  });
});
