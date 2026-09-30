import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { validateOutfit, type Candidate, type CandidateSlot } from '../../../../backend/src/recommend/validate.js';
import type { MandatoryContext } from '../../../../backend/src/recommend/context.js';
import { getDailyBoard } from '../../../../backend/src/recommend/publish.js';
import { ownerScenario, type Scenario } from '../../helpers/daily.js';
import { hardConstraintBreaks, isNavy } from '../../helpers/oracle.js';
import { newOwner } from '../../helpers/seed.js';

/**
 * Profile integrity at the validator: every section 8 hard constraint of the owner's real profile,
 * attacked with outfits built from his real wardrobe. Each attack starts from a valid composed option
 * and changes exactly the piece under attack, so the rejection is attributable to that rule.
 */

const DATE = '2026-10-06';
const ruleKeys = (slots: CandidateSlot[], ctx: MandatoryContext, opts = {}) => validateOutfit({ slots, source: 'model' }, ctx, opts).violations.map((v) => v.ruleKey);
const replace = (slots: CandidateSlot[], role: string, garmentId: string | null): CandidateSlot[] => {
  const rest = slots.filter((s) => s.role !== role);
  return garmentId ? [...rest, { garmentId, role: role as CandidateSlot['role'] }] : rest;
};

async function base(s: Scenario, date = DATE, pick: (slots: CandidateSlot[], ctx: MandatoryContext) => boolean = () => true) {
  const { context, composed } = await s.rec.compose({ date });
  const option = composed.options.find((o) => pick(o.slots, context)) ?? composed.options[0]!;
  expect(validateOutfit({ slots: option.slots }, context).valid).toBe(true);
  expect(hardConstraintBreaks(option.slots, context)).toEqual([]);
  return { ctx: context, slots: option.slots };
}

describe('socks always (hard.socks_always)', () => {
  it('rejects a sockless outfit, bed socks, and alpaca socks above 12 °C', async () => {
    const s = await ownerScenario();
    const { ctx, slots } = await base(s);
    expect(ruleKeys(replace(slots, 'socks', null), ctx)).toContain('hard.socks_always');
    expect(ruleKeys(replace(slots, 'socks', await s.byName('Alpaca bed sock — clotted cream')), ctx)).toEqual(expect.arrayContaining(['hard.socks_always']));
    expect(ctx.thermal.peakTempC).toBeGreaterThan(12);
    expect(ruleKeys(replace(slots, 'socks', await s.byName('Alpaca — inky blue')), ctx)).toContain('hard.socks_always');
  });

  it('the loafer-without-socks look is rejected twice over: no socks and a welted slip-on shoe while sneakers-only stands', async () => {
    const s = await ownerScenario();
    const { ctx, slots } = await base(s);
    const noSocksWelted = replace(replace(slots, 'socks', null), 'footwear', await s.byName('Paraboot Michael Cerf'));
    expect(ruleKeys(noSocksWelted, ctx)).toEqual(expect.arrayContaining(['hard.socks_always', 'hard.sneakers_only_until_healed']));
  });

  it('socks cannot be smuggled into another role to satisfy the count (merino socks as the accessory, no socks slot)', async () => {
    const s = await ownerScenario();
    const { ctx, slots } = await base(s);
    const sock = slots.find((x) => x.role === 'socks')!.garmentId;
    const smuggled = [...replace(replace(slots, 'socks', null), 'accessory', null), { garmentId: sock, role: 'accessory' as const }];
    expect(ruleKeys(smuggled, ctx)).toEqual(expect.arrayContaining(['hard.socks_always', 'integrity.role']));
  });
});

describe('sneakers only until healed (hard.sneakers_only_until_healed)', () => {
  it('rejects every welted shoe, the boot and the 990v6 from the real wardrobe, alone or as a footwear alternative', async () => {
    const s = await ownerScenario();
    const { ctx, slots } = await base(s);
    const forbidden = ['Paraboot Michael Cerf', 'Paraboot Reims — noir (black)', 'Paraboot Reims — café/marron', 'Paraboot Norwegian split-toe', "Drake's Clifford boot", 'NB 990v6'];
    const sneaker = slots.find((x) => x.role === 'footwear')!.garmentId;
    for (const name of forbidden) {
      const id = await s.byName(name);
      expect(ruleKeys(replace(slots, 'footwear', id), ctx), name).toContain('hard.sneakers_only_until_healed');
      const asAlternative = [...slots.filter((x) => x.role !== 'footwear'), { garmentId: sneaker, role: 'footwear' as const, alternativeGroup: 'f' }, { garmentId: id, role: 'footwear' as const, alternativeGroup: 'f' }];
      expect(ruleKeys(asAlternative, ctx), `${name} as alternative`).toContain('hard.sneakers_only_until_healed');
    }
  });

  it('the policy compiled for composition reports the restriction active for the owner', async () => {
    const s = await ownerScenario();
    const ctx = await s.rec.context({ date: DATE });
    expect(ctx.policy.sneakersOnly.active).toBe(true);
    expect(ctx.policy.sneakerAndWelted.active).toBe(false);
  });
});

describe('thermal rules', () => {
  it('a heavy shirt under a jacket at a 15 °C departure is rejected (lightweight oxford only in the 14–16 °C band)', async () => {
    const s = await ownerScenario({ weather: { scenario: 'jacketBand' } });
    const { ctx, slots } = await base(s, DATE, (sl) => sl.some((x) => x.role === 'outer_layer'));
    expect(Math.round(ctx.thermal.departureTempC)).toBeGreaterThanOrEqual(14);
    expect(Math.round(ctx.thermal.departureTempC)).toBeLessThanOrEqual(16);
    const outer = slots.find((x) => x.role === 'outer_layer')?.garmentId ?? (await s.byName("Drake's Navy Cotton-Linen Games Mk.IV"));
    const withJacket = replace(slots, 'outer_layer', outer);
    for (const heavy of ['Pima oxford — charcoal', 'Heavy rustic linen — sage', 'Clark oxford — beige']) {
      const attack = replace(withJacket, 'base_top', await s.byName(heavy));
      const keys = ruleKeys(attack, ctx);
      expect(keys, heavy).toContain('hard.thermal_jacket_14_16_lightweight_oxford');
      expect(hardConstraintBreaks(attack, ctx).join(' | '), heavy).toMatch(/needs a lightweight oxford|not for a/);
    }
  });

  it('morning-low dressing is rejected: a cold-morning flannel on an 11→19 °C day fails the peak rule', async () => {
    const s = await ownerScenario({ weather: { scenario: 'elevenToNineteen' } });
    const { ctx, slots } = await base(s);
    expect(ctx.thermal.peakTempC).toBeGreaterThanOrEqual(18);
    const flannel = await s.byName('Flannel plaid — grey');
    expect(ctx.byId.get(flannel)!.thermal.maxC).toBeLessThan(ctx.thermal.peakTempC);
    expect(ruleKeys(replace(slots, 'base_top', flannel), ctx)).toContain('hard.thermal_peak_for_base');
  });

  it('a 31 °C heat day rejects flannel and a heavy wool jacket; a cold snap rejects leaving without a jacket', async () => {
    const heat = await ownerScenario({ weather: { scenario: 'heat' } });
    const h = await base(heat);
    expect(ruleKeys(replace(h.slots, 'base_top', await heat.byName('Flannel plaid — rust+grey')), h.ctx)).toContain('hard.thermal_peak_for_base');
    expect(ruleKeys(replace(h.slots, 'outer_layer', await heat.byName('ISTO Heavy Wool Jacket')), h.ctx)).toContain('hard.thermal_morning_for_outerwear');
    const cold = await ownerScenario({ weather: { scenario: 'coldSnap' } });
    const c = await base(cold);
    expect(c.slots.some((x) => x.role === 'outer_layer')).toBe(true);
    expect(ruleKeys(replace(c.slots, 'outer_layer', null), c.ctx)).toContain('hard.thermal_morning_for_outerwear');
  });
});

describe('variety (hard.variety_seven_days)', () => {
  it('rejects a shirt or trousers worn within the last seven days, including exactly seven days ago; eight days ago is allowed', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:00:00.000Z' });
    const { slots } = await base(s);
    const shirt = slots.find((x) => x.role === 'base_top')!.garmentId;
    const trousers = slots.find((x) => x.role === 'bottom')!.garmentId;
    await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-09-29', items: [{ garmentId: shirt }] });
    await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-09-28', items: [{ garmentId: trousers }] });
    await s.cmd({ type: 'mark_washed', garmentId: shirt });
    await s.cmd({ type: 'mark_washed', garmentId: trousers });
    const ctx = await s.rec.context({ date: DATE });
    const keys = ruleKeys(slots, ctx);
    expect(keys).toContain('hard.variety_seven_days');
    const v = validateOutfit({ slots }, ctx).violations.find((x) => x.ruleKey === 'hard.variety_seven_days')!;
    expect(v.garmentIds).toContain(shirt); // 2026-09-29 is exactly seven days before 2026-10-06
    expect(v.garmentIds).not.toContain(trousers); // 2026-09-28 is eight days before
  });

  it('a composed or published board never contains a recent repeat', async () => {
    const s = await ownerScenario();
    const first = (await s.rec.composeAndPublish({ date: DATE })).board!;
    s.clock.set('2026-10-06T19:00:00.000Z');
    for (const o of first.options) {
      await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: DATE, items: o.slots.filter((x) => x.role === 'base_top' || x.role === 'bottom').map((x) => ({ garmentId: x.garmentId })) });
    }
    for (const o of first.options) for (const x of o.slots.filter((y) => y.role === 'base_top' || y.role === 'bottom')) await s.cmd({ type: 'mark_washed', garmentId: x.garmentId });
    s.clock.set('2026-10-06T20:00:00.000Z');
    const next = (await s.rec.composeAndPublish({ date: '2026-10-07' })).board!;
    const worn = new Set(first.options.flatMap((o) => o.slots.filter((x) => x.role === 'base_top' || x.role === 'bottom').map((x) => x.garmentId)));
    for (const o of next.options) for (const x of o.slots) if (x.role === 'base_top' || x.role === 'bottom') expect(worn.has(x.garmentId), x.garmentId).toBe(false);
  });
});

describe('never fall back to navy (hard.never_fall_back_to_navy)', () => {
  it('an implicit navy replacement in a swap is rejected; the owner\'s explicit navy choice is allowed', async () => {
    const s = await ownerScenario();
    const { ctx, slots } = await base(s);
    const top = slots.find((x) => x.role === 'base_top')!.garmentId;
    const navy = await s.byName('Pima oxford — navy');
    const attack = replace(slots, 'base_top', navy);
    expect(validateOutfit({ slots: attack }, ctx, { swap: { role: 'base_top', replacedGarmentId: top, replacementGarmentId: navy, explicit: false } }).violations.map((v) => v.ruleKey)).toContain('hard.never_fall_back_to_navy');
    expect(validateOutfit({ slots: attack }, ctx, { swap: { role: 'base_top', replacedGarmentId: top, replacementGarmentId: navy, explicit: true } }).violations.map((v) => v.ruleKey)).not.toContain('hard.never_fall_back_to_navy');
  });

  it('service-chosen swaps across every option and every swappable role never land on navy', async () => {
    const s = await ownerScenario();
    await s.rec.composeAndPublish({ date: DATE });
    const ctx = await s.rec.context({ date: DATE });
    let swaps = 0;
    for (const role of ['base_top', 'bottom', 'socks', 'outer_layer', 'footwear'] as const) {
      const board = (await getDailyBoard(env.DB, s.principal, DATE))!;
      for (const o of board.options.filter((x) => x.status === 'offerable')) {
        if (!o.slots.some((x) => x.role === role)) continue;
        const before = o.slots.find((x) => x.role === role)!.garmentId;
        const out = await s.rec.swap({ boardDate: DATE, optionId: (await getDailyBoard(env.DB, s.principal, DATE))!.options.find((x) => x.position === o.position)!.optionId, role }).catch((e: Error) => ({ status: `error:${e.message}`, board: null }));
        if (out.status !== 'revised' || !out.board) continue;
        const after = out.board.options.find((x) => x.position === o.position)!.slots.find((x) => x.role === role)!.garmentId;
        if (after !== before) {
          swaps++;
          expect(isNavy(ctx.byId.get(after)), `${role}: ${ctx.byId.get(before)?.name} -> ${ctx.byId.get(after)?.name}`).toBe(false);
        }
      }
    }
    expect(swaps).toBeGreaterThan(3);
  });
});

describe('benched, occasional and unavailable garments', () => {
  it('benched pieces fail availability even when the request explicitly includes them', async () => {
    const s = await ownerScenario();
    const benched = ["PWVC General's Overcoat", 'DBF Traveler — wool', 'PWVC Harris Tweed Marylebone', 'Wool-stripe knit tie — maroon'];
    const ids = await Promise.all(benched.map((n) => s.byName(n)));
    const ctx = await s.rec.context({ date: DATE, include: ids });
    const { slots } = await base(s);
    for (const [i, id] of ids.entries()) {
      const g = ctx.byId.get(id)!;
      const role = g.roles.includes('outer_layer') ? 'outer_layer' : 'accessory';
      expect(ruleKeys(replace(slots, role, id), ctx), benched[i]).toContain('availability.eligible');
    }
    const board = (await s.rec.composeAndPublish({ date: DATE, include: ids })).board!;
    for (const o of board.options) for (const x of o.slots) expect(ids).not.toContain(x.garmentId);
  });

  it('a garment at the tailor or in storage cannot be proposed', async () => {
    const s = await ownerScenario();
    const { ctx: _c, slots } = await base(s);
    const top = slots.find((x) => x.role === 'base_top')!.garmentId;
    await s.cmd({ type: 'send_to_tailor', garmentId: top, work: 'shorten sleeves' });
    const ctx = await s.rec.context({ date: DATE });
    expect(ruleKeys(slots, ctx)).toContain('availability.eligible');
    expect(hardConstraintBreaks(slots, ctx).join(' ')).toMatch(/unavailable/);
  });
});

describe('integrity of model-supplied slots', () => {
  it('hallucinated ids, SQL-shaped ids, another owner\'s garments and wrong roles are rejected', async () => {
    const s = await ownerScenario();
    const other = await newOwner();
    const { ctx, slots } = await base(s);
    const theirs = await other.byName('Lightweight oxford — gold');
    const cases: Record<string, CandidateSlot[]> = {
      hallucinated: replace(slots, 'base_top', 'g_0000000000000000000000000000dead'),
      sqlShaped: replace(slots, 'base_top', "g_x' OR '1'='1"),
      otherOwner: replace(slots, 'base_top', theirs),
      sneakerAsShirt: replace(slots, 'base_top', await s.byName('NB 990v4 — grey')),
      socksAsTrousers: replace(slots, 'bottom', slots.find((x) => x.role === 'socks')!.garmentId),
      blazerAsTrousers: replace(slots, 'bottom', await s.byName("Drake's Camel Field Games")),
    };
    for (const [name, attack] of Object.entries(cases)) {
      const keys = ruleKeys(attack, ctx);
      expect(keys.some((k) => k.startsWith('integrity.')), `${name}: ${keys}`).toBe(true);
    }
  });

  it('validates in constant shape for huge or empty candidates (no crash, always invalid)', async () => {
    const s = await ownerScenario();
    const { ctx, slots } = await base(s);
    const huge: Candidate = { slots: Array.from({ length: 5000 }, (_, i) => ({ garmentId: slots[i % slots.length]!.garmentId, role: slots[i % slots.length]!.role })) };
    expect(validateOutfit(huge, ctx).valid).toBe(false);
    expect(validateOutfit({ slots: [] }, ctx).valid).toBe(false);
  });
});
