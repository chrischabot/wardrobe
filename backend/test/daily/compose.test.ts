import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { CandidateProposer } from '../../src/recommend/compose.js';
import { jointAvailability } from '../../src/recommend/joint.js';
import type { ProseWriter, ProseWriterInput } from '../../src/recommend/document.js';
import { getDailyBoard, getRevisionRecord } from '../../src/recommend/publish.js';
import { validateOutfit } from '../../src/recommend/validate.js';
import { ownerScenario } from '../helpers/daily.js';
import { basicWardrobe, newUser, OWNER_SOURCES } from '../helpers/fixtures.js';

const DATE = '2026-10-06';
const HARD_KEYS = [
  'hard.socks_always',
  'hard.sneakers_only_until_healed',
  'hard.thermal_peak_for_base',
  'hard.thermal_morning_for_outerwear',
  'hard.variety_seven_days',
  'hard.perceptible_names',
  'colour.no_neutral_three_times',
  'accessories.no_watches_or_jewellery',
  'filter.categories_out',
  'integrity.known_garment',
  'integrity.role',
  'integrity.complete',
  'availability.eligible',
];

describe('option counts', () => {
  it('defaults to five, honours 3 and 4, the owner setting, and a direct request beyond it', async () => {
    const s = await ownerScenario();
    expect((await s.rec.compose({ date: DATE })).composed.options).toHaveLength(5);
    expect((await s.rec.compose({ date: DATE, requestedCount: 3 })).composed.options).toHaveLength(3);
    expect((await s.rec.compose({ date: DATE, requestedCount: 4 })).composed.options).toHaveLength(4);
    const seven = (await s.rec.compose({ date: DATE, requestedCount: 7 })).composed;
    expect(seven.options).toHaveLength(7);
    expect(new Set(seven.options.map((o) => o.validation.parts.top!.garmentId)).size).toBe(7);
    await env.DB.prepare('UPDATE owner_settings SET daily_option_count = 3 WHERE user_id = ?').bind(s.userId).run();
    expect((await s.rec.compose({ date: DATE })).composed.options).toHaveLength(3);
  });
});

describe('hallucinated items and wrong roles cannot become recommendations', () => {
  it('rejects invented IDs, another owner\'s garment and wrong roles', async () => {
    const s = await ownerScenario();
    const other = await newUser('Owner B');
    const theirs = await basicWardrobe(other);
    const { context, composed } = await s.rec.compose({ date: DATE });
    const base = composed.options[0]!.slots;
    const invented = validateOutfit({ slots: [...base.filter((x) => x.role !== 'base_top'), { garmentId: 'g_invented0001', role: 'base_top' }] }, context);
    expect(invented.violations.map((v) => v.ruleKey)).toContain('integrity.known_garment');
    const foreign = validateOutfit({ slots: [...base.filter((x) => x.role !== 'base_top'), { garmentId: theirs.shirtA, role: 'base_top' }] }, context);
    expect(foreign.violations.map((v) => v.ruleKey)).toContain('integrity.known_garment');
    const top = base.find((x) => x.role === 'base_top')!;
    const wrongRole = validateOutfit({ slots: [...base.filter((x) => x.role !== 'footwear'), { garmentId: top.garmentId, role: 'footwear' }] }, context);
    expect(wrongRole.violations.map((v) => v.ruleKey)).toEqual(expect.arrayContaining(['integrity.role']));
  });

  it('a model proposer\'s invalid candidates never reach the board; its valid ones pass the same validator', async () => {
    const s = await ownerScenario();
    const { context, composed } = await s.rec.compose({ date: DATE });
    const good = composed.reserves[0]!.slots;
    const proposer: CandidateProposer = {
      name: 'test-model',
      propose: async () => [
        { slots: [{ garmentId: 'g_madeup0001', role: 'base_top' }, ...good.filter((x) => x.role !== 'base_top')] },
        { slots: good.filter((x) => x.role !== 'socks') },
        { slots: good.map((x) => (x.role === 'footwear' ? { ...x, garmentId: context.wardrobe.find((g) => g.name === 'Paraboot Reims — noir (black)')!.garmentId } : x)) },
      ],
    };
    const deps = { ...s, proposer };
    const { RecommendationService } = await import('../../src/recommend/service.js');
    const rec = new RecommendationService({ db: env.DB, principal: s.principal, weather: s.weather, calendar: s.calendar, proposer, clock: s.clock.now });
    void deps;
    const out = await rec.compose({ date: DATE });
    const rejectedModel = out.composed.rejected.filter((r) => r.source === 'model');
    expect(rejectedModel.length).toBe(3);
    expect(rejectedModel.flatMap((r) => r.violations.map((v) => v.ruleKey))).toEqual(expect.arrayContaining(['integrity.known_garment', 'hard.socks_always', 'hard.sneakers_only_until_healed']));
    for (const o of out.composed.options) expect(o.slots.map((x) => x.garmentId)).not.toContain('g_madeup0001');
  });
});

describe('availability: dirty, incoming, restricted, retired, away, benched, indoor-only and occasional', () => {
  it('excludes each unavailable state and explains why', async () => {
    const s = await ownerScenario();
    const dirty = await s.byName('Lightweight oxford — gold');
    const restricted = await s.byName('Lightweight oxford — pink');
    const retired = await s.byName('Lightweight oxford — moss');
    const tailor = await s.byName("Drake's Olive Jungle Jacket");
    const stored = await s.byName('PWVC Cashmere Cord Bark');
    await s.cmd({ type: 'mark_in_wash', garmentId: dirty });
    await s.cmd({ type: 'set_restriction', kind: 'repair', scope: { garmentIds: [restricted] }, reason: 'Loose button' });
    await s.cmd({ type: 'dispose_item', garmentId: retired, reason: 'donated' });
    await s.cmd({ type: 'send_to_tailor', garmentId: tailor, work: 'Shorten sleeves' });
    await s.cmd({ type: 'put_into_storage', garmentId: stored });
    const incoming = (await s.cmd({ type: 'add_item', explicit: true, name: 'Lightweight oxford — ochre', category: 'shirt', roles: ['base_top'], color: 'Ochre', acquisition: 'incoming', attributes: { fabricClass: 'lightweight_oxford' } })).facts.garmentId as string;
    const unavailable = [dirty, restricted, retired, tailor, stored, incoming];
    for (const date of ['2026-10-06', '2026-10-07']) {
      const { context, composed } = await s.rec.compose({ date, seed: date });
      const used = new Set(composed.options.concat(composed.reserves).flatMap((o) => o.slots.map((x) => x.garmentId)));
      for (const id of unavailable) expect(used.has(id)).toBe(false);
      for (const id of used) {
        const g = context.byId.get(id)!;
        expect(g.planningPolicy).toBe('normal');
        expect(g.acquisition).toBe('owned');
        expect(g.indoorOnly).toBe(false);
      }
      const base = composed.options[0]!.slots;
      for (const id of [dirty, restricted, retired, incoming]) {
        const v = validateOutfit({ slots: [...base.filter((x) => x.role !== 'base_top'), { garmentId: id, role: 'base_top' }] }, context);
        expect(v.violations.find((x) => x.ruleKey === 'availability.eligible')?.detail).toMatch(/Unavailable/);
      }
    }
    const { context } = await s.rec.compose({ date: DATE });
    expect(context.byId.get(tailor)!.eligibility.label).toBe('At the tailor');
    expect(context.byId.get(incoming)!.eligibility.label).toBe('Incoming');
    expect(context.byId.get(retired)!.eligibility.label).toMatch(/Retired/);
  });

  it('an occasional piece is offered only on explicit request', async () => {
    const s = await ownerScenario();
    const square = await s.byName('Anglo-Italian pocket square');
    const plain = await s.rec.compose({ date: DATE });
    const slots = [...plain.composed.options[0]!.slots.filter((x) => x.role !== 'accessory'), { garmentId: square, role: 'accessory' as const, alternativeGroup: 'flourish' }];
    expect(validateOutfit({ slots }, plain.context).violations.find((v) => v.ruleKey === 'availability.eligible')?.detail).toMatch(/occasional piece not requested/);
    const asked = await s.rec.compose({ date: DATE, include: [square] });
    expect(validateOutfit({ slots }, asked.context).valid).toBe(true);
  });

  it('depleted laundry yields fewer valid options with one explanation, never placeholders; none yields no board', async () => {
    const s = await ownerScenario();
    const { context } = await s.rec.compose({ date: DATE });
    const tops = context.wardrobe.filter((g) => g.roles.includes('base_top') && g.eligibility.available && g.thermal.minC <= context.thermal.peakTempC && context.thermal.peakTempC <= g.thermal.maxC);
    for (const g of tops.slice(2)) await s.cmd({ type: 'mark_in_wash', garmentId: g.garmentId });
    const two = await s.rec.composeAndPublish({ date: DATE });
    expect(two.published).toBe(true);
    const offerable = two.board!.options.filter((o) => o.status === 'offerable');
    expect(offerable.length).toBe(2);
    expect(offerable.map((o) => o.position)).toEqual([1, 2]);
    expect(two.board!.document!.shortfall).toMatch(/^2 complete outfits instead of 5: only 2 clean shirts suit the day/);
    for (const o of two.composed!.options) expect(o.validation.valid).toBe(true);
    // Wash every remaining shirt: nothing is published for the next day, and the reason is stated.
    for (const g of tops.slice(0, 2)) await s.cmd({ type: 'mark_in_wash', garmentId: g.garmentId });
    const none = await s.rec.composeAndPublish({ date: '2026-10-07' });
    expect(none.published).toBe(false);
    expect(none.reason).toBe('no_valid_outfit');
    expect(none.shortfall).toMatch(/^No complete outfit is possible today: no clean shirts suit the day/);
    expect(await getDailyBoard(env.DB, s.principal, '2026-10-07')).toBeNull();
  });

  it('with every pair of socks in the wash there is no outfit at all: socks are never skipped', async () => {
    const s = await ownerScenario();
    const { context } = await s.rec.compose({ date: DATE });
    for (const g of context.wardrobe.filter((x) => x.roles.includes('socks'))) {
      const qty = g.estimate?.estimatedCleanUnits ?? 0;
      if (qty > 0) await s.cmd({ type: 'mark_in_wash', garmentId: g.garmentId, quantity: qty });
    }
    const out = await s.rec.composeAndPublish({ date: DATE });
    expect(out.published).toBe(false);
    expect(out.shortfall).toMatch(/no clean socks are left/);
  });
});

describe('joint availability ranking uses the foundation estimator', () => {
  it('equals the estimator for one garment and treats garments of the same earlier option as correlated', async () => {
    const s = await ownerScenario({ now: '2026-10-04T20:00:00.000Z' });
    const first = await s.rec.composeAndPublish({ date: '2026-10-05' });
    expect(first.published).toBe(true);
    s.clock.set('2026-10-05T20:00:00.000Z');
    const { context } = await s.rec.compose({ date: DATE });
    const option = first.board!.options[0]!;
    const offerable = first.board!.options.filter((o) => o.status === 'offerable');
    const optionsWith = (id: string) => offerable.filter((o) => o.slots.some((x) => x.garmentId === id)).length;
    // The shirt is unique on a board (distinct shirts), so it sits in exactly one earlier option.
    const g = context.byId.get(option.slots.find((x) => x.role === 'base_top')!.garmentId)!;
    expect(g.laundryPolicy).toBe('per_wear');
    expect(g.estimate!.estimatedCleanUnits).toBe(1);
    expect(optionsWith(g.garmentId)).toBe(1);
    expect(g.estimate!.probabilityAvailable).toBeCloseTo(1 - 0.7 / 5, 6);
    const input = await s.rec.jointInput(context);
    const single = jointAvailability({ ...input, garments: [g], targetDate: DATE });
    expect(single.probability).toBeCloseTo(g.estimate!.probabilityAvailable, 9);
    // Shirt and trousers from the same earlier option are correlated: joint > independent product.
    const top = g;
    const bottom = context.byId.get(option.slots.find((x) => x.role === 'bottom')!.garmentId)!;
    const pair = jointAvailability({ ...input, garments: [top, bottom], targetDate: DATE });
    const independent = top.estimate!.probabilityAvailable * bottom.estimate!.probabilityAvailable;
    expect(pair.probability).toBeLessThanOrEqual(Math.min(top.estimate!.probabilityAvailable, bottom.estimate!.probabilityAvailable) + 1e-9);
    if (bottom.estimate!.estimatedCleanUnits === 1 && bottom.laundryPolicy !== 'multi_wear') {
      expect(pair.probability).toBeGreaterThan(independent);
      // Exactly: P(no option containing either garment was worn) = 1 - 0.7 * |options with either| / 5.
      const either = offerable.filter((o) => o.slots.some((x) => x.garmentId === top.garmentId || x.garmentId === bottom.garmentId)).length;
      expect(pair.probability).toBeCloseTo(1 - (0.7 * either) / 5, 6);
    } else {
      // Trousers with two units survive one day's wear: the shirt alone constrains the pair.
      expect(pair.probability).toBeCloseTo(top.estimate!.probabilityAvailable, 9);
    }
    // Stored with the published revision's evidence.
    const out = await s.rec.composeAndPublish({ date: DATE });
    const rec = await getRevisionRecord(env.DB, s.principal, out.board!.boardId, out.board!.currentRevision);
    expect(rec!.estimator.estimatorVersion).toBe('availability-estimator/1');
    const ev = out.board!.options[0]!.validation as { jointAvailability: { probability: number; model: string } };
    expect(ev.jointAvailability.model).toMatch(/exact DP/);
  });
});

describe('revisions, identity, evidence and determinism', () => {
  it('keeps reserves whenever stock allows, across seeds (the taste shortlist alone can be used up by the board)', async () => {
    const s = await ownerScenario();
    for (let i = 0; i < 60; i++) {
      const { composed } = await s.rec.compose({ date: DATE, seed: `reserve-${i}` });
      expect(composed.options, `seed reserve-${i}`).toHaveLength(5);
      expect(composed.reserves.length, `seed reserve-${i}`).toBe(2);
      const tops = new Set(composed.options.map((o) => o.validation.parts.top!.garmentId));
      const bottoms = new Set(composed.options.map((o) => o.validation.parts.bottom!.garmentId));
      for (const r of composed.reserves) {
        expect(r.validation.valid).toBe(true);
        expect(tops.has(r.validation.parts.top!.garmentId)).toBe(false);
        expect(bottoms.has(r.validation.parts.bottom!.garmentId)).toBe(false);
      }
    }
  }, 120_000);

  it('keeps option IDs stable inside immutable revisions and stores the rules checked', async () => {
    const s = await ownerScenario();
    const out = await s.rec.composeAndPublish({ date: DATE });
    const rev1 = out.board!;
    const swapped = await s.rec.swap({ boardDate: DATE, optionId: rev1.options[2]!.optionId, role: 'socks' });
    expect(swapped.status).toBe('revised');
    const again = await getDailyBoard(env.DB, s.principal, DATE, 'day', 1);
    expect(again!.options.map((o) => o.optionId)).toEqual(rev1.options.map((o) => o.optionId));
    expect(again!.options.map((o) => o.slots)).toEqual(rev1.options.map((o) => o.slots));
    expect(again!.document!.options.map((o) => o.optionId)).toEqual(rev1.document!.options.map((o) => o.optionId));
    const rev2 = await getDailyBoard(env.DB, s.principal, DATE);
    expect(rev2!.currentRevision).toBe(2);
    expect(rev2!.options.some((o) => rev1.options.some((p) => p.optionId === o.optionId))).toBe(false);
    for (const o of rev1.options) {
      const checked = (o.validation.rulesChecked as { ruleKey: string; passed: boolean; strength: string; section: string | null }[]).filter((c) => c.strength === 'hard');
      for (const key of HARD_KEYS) expect(checked.find((c) => c.ruleKey === key), key).toMatchObject({ passed: true });
      expect(checked.find((c) => c.ruleKey === 'hard.socks_always')!.section).toBe('8. Hard constraints');
    }
    const record = await getRevisionRecord(env.DB, s.principal, rev1.boardId, 1);
    const applied = (record!.validation.rulesApplied as { ruleKey: string }[]).map((r) => r.ruleKey);
    expect(applied.length).toBe(41);
    expect(record!.validation.sneakersOnlyActive).toBe(true);
  });

  it('is deterministic for a day without any model', async () => {
    const s = await ownerScenario();
    const a = await s.rec.compose({ date: DATE });
    const b = await s.rec.compose({ date: DATE });
    const sig = (x: typeof a) => x.composed.options.map((o) => o.slots.map((sl) => sl.garmentId).sort().join(','));
    expect(sig(a)).toEqual(sig(b));
    const out = await s.rec.composeAndPublish({ date: DATE });
    expect(out.board!.document!.prose).toBe('deterministic');
  });

  it('a laundry command racing composition invalidates the stale publication; the board is recomposed from the new state', async () => {
    const s = await ownerScenario();
    let washed: string | null = null;
    const out = await s.rec.composeAndPublish({ date: DATE }, {
      beforePublish: async (attempt) => {
        if (attempt !== 1) return;
        const { composed, context } = await s.rec.compose({ date: DATE });
        washed = composed.options[0]!.validation.parts.top!.garmentId;
        void context;
        await s.cmd({ type: 'mark_in_wash', garmentId: washed });
      },
    });
    expect(out.published).toBe(true);
    expect(out.attempts).toBe(2);
    expect(out.board!.currentRevision).toBe(1);
    expect(out.board!.options.flatMap((o) => o.slots.map((x) => x.garmentId))).not.toContain(washed);
  });
});

describe('model prose is optional and checked', () => {
  it('uses checked model prose, rejects invented facts, and falls back when the model fails; the writer receives the full profile', async () => {
    const received: ProseWriterInput[] = [];
    const make = (fn: (i: ProseWriterInput) => Record<string, string>): ProseWriter => ({
      name: 'test',
      write: async (input) => {
        received.push(input);
        return { why: fn(input) };
      },
    });
    const good = make((i) => Object.fromEntries(i.options.map((o) => [o.optionId, 'Texture does the talking here, and the socks answer the shirt.'])));
    const s = await ownerScenario({ deps: { prose: good } });
    const out = await s.rec.composeAndPublish({ date: DATE });
    expect(out.board!.document!.prose).toBe('model');
    expect(out.board!.document!.options[0]!.why).toBe('Texture does the talking here, and the socks answer the shirt.');
    expect(received[0]!.profile).toBe(OWNER_SOURCES.profileText);

    const liar = make((i) => Object.fromEntries(i.options.map((o, n) => [o.optionId, n % 2 ? 'A 90% chance this is the best look of the week.' : 'Wear it with the PWVC Belted Safari for extra safety.'])));
    const t = await ownerScenario({ deps: { prose: liar } });
    const lied = await t.rec.composeAndPublish({ date: DATE });
    expect(lied.board!.document!.prose).toBe('deterministic');
    for (const o of lied.board!.document!.options) expect(o.why).not.toMatch(/90%|Belted Safari/);

    const broken: ProseWriter = { name: 'down', write: async () => { throw new Error('provider outage'); } };
    const u = await ownerScenario({ deps: { prose: broken } });
    const fallback = await u.rec.composeAndPublish({ date: DATE });
    expect(fallback.published).toBe(true);
    expect(fallback.board!.document!.prose).toBe('deterministic');
  });
});
