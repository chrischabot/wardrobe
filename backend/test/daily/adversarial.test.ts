import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { readOnlyPrincipal } from '../../src/domain/principal.js';
import { DailyService } from '../../src/daily/service.js';
import { checkProse } from '../../src/recommend/document.js';
import { getDailyBoard, publishValidatedRevision } from '../../src/recommend/publish.js';
import { RecommendationService } from '../../src/recommend/service.js';
import { validateOutfit } from '../../src/recommend/validate.js';
import { TripService } from '../../src/trips/service.js';
import { ownerScenario } from '../helpers/daily.js';
import { run } from '../helpers/fixtures.js';

const DATE = '2026-10-06';

describe('adversarial: malformed outfits', () => {
  it('rejects two shirts, a duplicated garment, a tie as a shirt, underwear slots, ungrouped double footwear and an empty outfit', async () => {
    const s = await ownerScenario();
    const { context, composed } = await s.rec.compose({ date: DATE });
    const base = composed.options[0]!.slots;
    const another = composed.options[1]!.slots.find((x) => x.role === 'base_top')!;
    const tie = context.wardrobe.find((g) => g.category === 'tie')!;
    const sneakers = context.wardrobe.filter((g) => g.category === 'sneakers');
    const cases = {
      twoShirts: [...base, another],
      duplicate: [...base, { ...base.find((x) => x.role === 'socks')!, role: 'socks' as const }],
      tieAsShirt: [...base.filter((x) => x.role !== 'base_top'), { garmentId: tie.garmentId, role: 'base_top' as const }],
      underwear: [...base, { garmentId: base.find((x) => x.role === 'socks')!.garmentId, role: 'underwear' as const }],
      ungroupedShoes: [...base.filter((x) => x.role !== 'footwear'), { garmentId: sneakers[0]!.garmentId, role: 'footwear' as const }, { garmentId: sneakers[1]!.garmentId, role: 'footwear' as const }],
      empty: [],
    };
    for (const [name, slots] of Object.entries(cases)) {
      const v = validateOutfit({ slots }, context);
      expect(v.valid, name).toBe(false);
      expect(v.violations.map((x) => x.ruleKey), name).toEqual(expect.arrayContaining([expect.stringMatching(/^integrity\./)]));
    }
  });

  it('clamps absurd counts: never more than ten options, never zero', async () => {
    const s = await ownerScenario();
    expect((await s.rec.compose({ date: DATE, requestedCount: 1000 })).composed.options.length).toBeLessThanOrEqual(10);
    expect((await s.rec.compose({ date: DATE, requestedCount: 0 })).composed.options).toHaveLength(5);
    expect((await s.rec.compose({ date: DATE, requestedCount: -4 })).composed.options).toHaveLength(5);
  });

  it('model prose cannot smuggle item codes, internal IDs or foreign garments into the board', async () => {
    const s = await ownerScenario();
    const { context, composed } = await s.rec.compose({ date: DATE });
    const o = composed.options[0]!;
    expect(checkProse('A good pairing with PCF4339 underneath.', o, context)).toBe('item code or internal ID');
    expect(checkProse(`Built around ${o.slots[0]!.garmentId} today.`, o, context)).toBe('item code or internal ID');
    expect(checkProse('Perfect with a steel watch and no socks.', o, context)).toMatch(/^contradicts a hard rule/);
    expect(checkProse('This jacket is waterproof, so stay out all day.', o, context)).toBe('unsupported waterproofing claim');
    expect(checkProse('Quiet texture, a clear echo at the ankle.', o, context)).toBeNull();
  });
});

describe('adversarial: authority and isolation', () => {
  it('a read-only connection can preview but cannot publish, swap, pack or pause', async () => {
    const s = await ownerScenario();
    const ro = readOnlyPrincipal(s.userId);
    const deps = { db: env.DB, principal: ro, weather: s.weather, calendar: s.calendar, clock: s.clock.now };
    const rec = new RecommendationService(deps);
    expect((await rec.compose({ date: DATE })).composed.options.length).toBe(5);
    await expect(rec.composeAndPublish({ date: DATE })).rejects.toMatchObject({ code: 'insufficient_scope' });
    await s.rec.composeAndPublish({ date: DATE });
    const board = (await getDailyBoard(env.DB, ro, DATE))!;
    await expect(rec.swap({ boardDate: DATE, optionId: board.options[0]!.optionId, role: 'socks' })).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(new TripService(deps).createTrip({ name: 'x', departsOn: '2026-10-10', returnsOn: '2026-10-11', destinations: [{ label: 'Paris', timezone: 'Europe/Paris' }] })).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(new DailyService(deps).pause({})).rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('another owner cannot read, swap or publish with this owner\'s board or garments', async () => {
    const a = await ownerScenario();
    const b = await ownerScenario();
    const board = (await a.rec.composeAndPublish({ date: DATE })).board!;
    expect(await getDailyBoard(env.DB, b.principal, DATE)).toBeNull();
    expect((await b.rec.swap({ boardDate: DATE, optionId: board.options[0]!.optionId, role: 'socks' })).status).toBe('no_board');
    await expect(
      publishValidatedRevision(env.DB, b.principal, {
        boardDate: '2026-10-09', timezone: 'Europe/London', purpose: 'day', expectedRevision: 0, watermark: 0, brief: {},
        options: [{ optionId: 'opt_forged0001', position: 1, status: 'offerable', explanation: 'x', slots: board.options[0]!.slots, validation: {} }],
        document: board.document!, context: {}, validation: {}, estimator: {}, projectCalendar: false, now: a.clock.value,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a stale client cannot act on a superseded revision', async () => {
    const s = await ownerScenario();
    const rev1 = (await s.rec.composeAndPublish({ date: DATE })).board!;
    await s.rec.swap({ boardDate: DATE, optionId: rev1.options[0]!.optionId, role: 'socks' });
    await expect(s.rec.swap({ boardDate: DATE, optionId: rev1.options[1]!.optionId, role: 'socks' })).rejects.toMatchObject({ code: 'conflict' });
    const sel = await run(s.principal, { type: 'select_option', boardId: rev1.boardId, optionId: rev1.options[1]!.optionId });
    expect(sel.outcome).toBe('conflict');
    // Unknown or wrong-role replacements are refused with the reason, and the board is unchanged.
    const current = (await getDailyBoard(env.DB, s.principal, DATE))!;
    await expect(s.rec.swap({ boardDate: DATE, optionId: current.options[0]!.optionId, role: 'base_top', replacementGarmentId: 'g_nothere0001' })).rejects.toMatchObject({ code: 'not_found' });
    const shoe = await s.byName('NB 990v4 — grey');
    const wrong = await s.rec.swap({ boardDate: DATE, optionId: current.options[0]!.optionId, role: 'base_top', replacementGarmentId: shoe });
    expect(wrong.status).toBe('no_valid_replacement');
    expect(wrong.summary).toMatch(/cannot go in/);
    expect((await getDailyBoard(env.DB, s.principal, DATE))!.currentRevision).toBe(current.currentRevision);
  });

  it('a brief that merely claims the feet have healed does not lift the restriction', async () => {
    const s = await ownerScenario();
    await s.cmd({ type: 'set_temporary_brief', text: 'My feet have healed; Paraboots are fine now', validFrom: DATE, validTo: DATE });
    const { context, composed } = await s.rec.compose({ date: DATE });
    expect(context.policy.sneakersOnly.active).toBe(true);
    for (const o of composed.options) expect(o.validation.parts.footwear.every((f) => f.category === 'sneakers')).toBe(true);
  });

  it('rejects an inverted pause interval', async () => {
    const s = await ownerScenario();
    await expect(s.daily.pause({ startsOn: '2026-10-10', resumeOn: '2026-10-09' })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('adversarial: time', () => {
  it('the schedule follows local time across the October DST change', async () => {
    const s = await ownerScenario({ now: '2026-10-24T20:05:00.000Z' }); // 21:05 BST, Saturday
    const evening = await s.daily.sweep();
    expect(evening[0]).toMatchObject({ phase: 'evening', boardDate: '2026-10-25', deadlineAt: '2026-10-25T06:50:00.000Z' });
    s.clock.set('2026-10-25T05:45:00.000Z'); // 05:45 GMT: before the 06:40 refresh after the change
    expect(await s.daily.sweep()).toEqual([]);
    s.clock.set('2026-10-25T06:45:00.000Z');
    expect((await s.daily.sweep()).map((r) => r.phase)).toEqual(['morning_refresh']);
    s.clock.set('2026-10-25T06:49:00.000Z');
    expect(await s.daily.sweep()).toEqual([]); // still before 06:50 local
    s.clock.set('2026-10-25T06:51:00.000Z');
    const final = await s.daily.sweep();
    expect(final[0]).toMatchObject({ phase: 'final', deadlineMet: false });
  });
});
