import { describe, expect, it } from 'vitest';
import { selectBoardDetailed, type ScoredOption } from '../../src/recommend/compose.js';
import { validateOutfit } from '../../src/recommend/validate.js';
import type { WeatherScenarioName } from '../../src/weather/fake.js';
import { ownerScenario } from '../helpers/daily.js';

/**
 * Regressions for the defects the journey suite found against the owner's real profile and wardrobe
 * (tests/journeys README, D5, D9, D13, D14, D15): trousers repeated within a board, boards collapsing
 * into one register, navy and board-repeat pieces in the Swap list, stored comfort feedback ignored,
 * and `include` dropped silently.
 */

const DATE = '2026-10-06';

const mk = (id: string, top: string, bottom: string, register: string, score: number): ScoredOption =>
  ({
    slots: [],
    score,
    taste: score,
    joint: 1,
    jointDetail: null,
    devices: [],
    suitable: null,
    source: 'composer',
    validation: { register, registers: [register], safe: false, statementCount: 0, valid: true, checks: [], violations: [], warnings: [], parts: { top: { garmentId: top, fabricClass: `f${id}` }, bottom: { garmentId: bottom }, outer: null, mid: null, socks: null, footwear: [], belt: null, flourish: null } },
  }) as unknown as ScoredOption;

describe('board selection: distinct trousers and spread registers', () => {
  it('finds the full distinct board a greedy choice would block, instead of repeating trousers', () => {
    // Greedy takes t1/b1 first; then t1/b2 repeats the shirt and t2/b1 the trousers. The distinct board is t1/b2 + t2/b1.
    const ranked = [mk('1', 't1', 'b1', 'rl_ivy', 10), mk('2', 't1', 'b2', 'field_workwear', 9), mk('3', 't2', 'b1', 'sprezzatura', 8)];
    const sel = selectBoardDetailed(ranked, 2, 0, false);
    expect(sel.chosen).toHaveLength(2);
    expect(new Set(sel.chosen.map((o) => o.validation.parts.bottom!.garmentId)).size).toBe(2);
    expect(new Set(sel.chosen.map((o) => o.validation.parts.top!.garmentId)).size).toBe(2);
  });

  it('publishes fewer options rather than a repeat when the trousers run out', () => {
    const ranked = [mk('1', 't1', 'b1', 'rl_ivy', 10), mk('2', 't2', 'b1', 'field_workwear', 9), mk('3', 't3', 'b1', 'sprezzatura', 8), mk('4', 't4', 'b2', 'academic_blazer', 1)];
    const sel = selectBoardDetailed(ranked, 3, 0, false);
    expect(sel.chosen.map((o) => o.validation.parts.bottom!.garmentId).sort()).toEqual(['b1', 'b2']);
    expect(sel.distinctLimit).toBe(2);
  });

  it('never lets one register take more than half the board when others exist, and records why when only one exists', () => {
    const field = [1, 2, 3, 4, 5].map((i) => mk(`f${i}`, `tf${i}`, `bf${i}`, 'field_workwear', 20 - i));
    const others = [mk('o1', 'to1', 'bo1', 'rl_ivy', 1), mk('o2', 'to2', 'bo2', 'sprezzatura', 0)];
    const spread = selectBoardDetailed([...field, ...others], 5, 0, false);
    expect(spread.chosen).toHaveLength(5);
    expect(spread.chosen.filter((o) => o.validation.register === 'field_workwear').length).toBeLessThanOrEqual(3);
    expect(spread.registerNote).toBeNull();
    const only = selectBoardDetailed(field, 5, 0, false);
    expect(only.chosen).toHaveLength(5);
    expect(only.registerNote).toMatch(/field workwear register/);
  });

  it('on real boards across seeds, weather and calendar days: shirts and trousers distinct, at least two registers, none over half unless recorded', async () => {
    const days: { scenario: WeatherScenarioName; meeting?: boolean }[] = [{ scenario: 'coldSnap' }, { scenario: 'heavyRain', meeting: true }, { scenario: 'mild' }, { scenario: 'jacketBand' }];
    for (const day of days) {
      const s = await ownerScenario({ weather: { scenario: day.scenario } });
      if (day.meeting) s.calendar.addEvent({ title: 'Client meeting with the Rotterdam team', start: `${DATE}T09:00:00.000Z`, end: `${DATE}T10:30:00.000Z` });
      for (let i = 0; i < 16; i++) {
        const { composed, context } = await s.rec.compose({ date: DATE, seed: `seed-${day.scenario}-${i}` });
        const label = `${day.scenario} seed ${i}`;
        const opts = composed.options;
        expect(opts.length, label).toBeGreaterThanOrEqual(3);
        const tops = opts.map((o) => o.validation.parts.top!.garmentId);
        const bottoms = opts.map((o) => o.validation.parts.bottom!.garmentId);
        expect(new Set(tops).size, `${label}: shirts`).toBe(tops.length);
        expect(new Set(bottoms).size, `${label}: trousers ${bottoms.map((b) => context.byId.get(b)!.name).join(' | ')}`).toBe(bottoms.length);
        const regs = opts.map((o) => o.validation.register);
        expect(new Set(regs).size, `${label}: ${regs.join(',')}`).toBeGreaterThanOrEqual(2);
        const largest = Math.max(...regs.map((r) => regs.filter((x) => x === r).length));
        if (largest > Math.ceil(opts.length / 2)) expect(composed.registerNote, `${label}: ${regs.join(',')}`).toBeTruthy();
        expect(composed.boardChecks.find((c) => c.ruleKey === 'board.distinct_trousers')!.passed, label).toBe(true);
        if (day.meeting) {
          // The meeting shapes a subset: at least one suitable option, and at least one for the rest of the day.
          const suitable = opts.filter((o) => o.suitable).length;
          expect(suitable, label).toBeGreaterThanOrEqual(1);
          expect(suitable, `${label}: an alternative remains for the rest of the day`).toBeLessThan(opts.length);
        }
      }
    }
  });
});

describe('the Swap list', () => {
  it('offers no navy piece and nothing another option of the board already wears; every candidate validates as a swap', async () => {
    const s = await ownerScenario({ weather: { scenario: 'rainAfterFour' } });
    const out = await s.rec.composeAndPublish({ date: DATE });
    const ctx = await s.rec.context({ date: DATE });
    const offerable = out.board!.options.filter((o) => o.status === 'offerable');
    let offered = 0;
    for (const o of offerable) {
      const others = new Set(offerable.filter((x) => x !== o).flatMap((x) => x.slots.filter((sl) => sl.role === 'base_top' || sl.role === 'bottom').map((sl) => sl.garmentId)));
      for (const role of ['base_top', 'bottom', 'socks'] as const) {
        const { candidates } = await s.rec.swapCandidates({ boardDate: DATE, optionId: o.optionId, role, limit: 50 });
        offered += candidates.length;
        for (const c of candidates) {
          const g = ctx.byId.get(c.garmentId)!;
          expect(g.families.includes('navy') || g.colorFamily === 'navy', `${role}: ${g.name}`).toBe(false);
          if (role !== 'socks') expect(others.has(c.garmentId), `${role}: ${g.name} is on another option`).toBe(false);
          const target = o.slots.find((sl) => sl.role === role)!;
          const slots = o.slots.map((sl) => (sl === target ? { ...sl, garmentId: c.garmentId } : sl));
          expect(validateOutfit({ slots }, ctx).valid, g.name).toBe(true);
        }
      }
    }
    expect(offered).toBeGreaterThan(0);
  });
});

describe('comfort feedback in composition', () => {
  it('a standing direction applies on a day whose calendar implies the situation, not on a declined event or an ordinary day; an observation only ranks lower', async () => {
    const s = await ownerScenario();
    const plain = await s.rec.compose({ date: DATE });
    const shoes = plain.composed.options[0]!.slots.find((sl) => sl.role === 'footwear')!.garmentId;
    const outfit = plain.composed.options[0]!.slots;
    await s.cmd({ type: 'record_comfort_feedback', text: 'Do not suggest these for long walks', garmentId: shoes, activity: 'long walks', standingInstruction: { ownerQuote: 'Do not suggest these for long walks', appliesTo: { activity: 'long walks' } } });
    // Ordinary day: still wearable.
    expect((await s.rec.validateProposal({ date: DATE }, { slots: outfit })).valid).toBe(true);
    // A declined walk imposes nothing.
    s.calendar.addEvent({ title: 'Walk on Hampstead Heath with Sam', start: `${DATE}T10:00:00.000Z`, end: `${DATE}T13:00:00.000Z`, selfResponse: 'declined' });
    expect((await s.rec.validateProposal({ date: DATE }, { slots: outfit })).valid).toBe(true);
    // An accepted walk does.
    const WALK_DAY = '2026-10-07';
    s.calendar.addEvent({ title: 'Long walk along the Thames Path', start: `${WALK_DAY}T09:00:00.000Z`, end: `${WALK_DAY}T15:00:00.000Z` });
    const v = await s.rec.validateProposal({ date: WALK_DAY }, { slots: outfit });
    expect(v.violations.map((x) => x.ruleKey).some((k) => k.startsWith('comfort.')), JSON.stringify(v.violations.map((x) => x.detail))).toBe(true);
    const walk = await s.rec.compose({ date: WALK_DAY });
    expect(walk.composed.options.length).toBeGreaterThan(0);
    for (const o of walk.composed.options) expect(o.slots.map((sl) => sl.garmentId)).not.toContain(shoes);
    // An observation matching the day's situation is a note, never a ban.
    const TRAIN_DAY = '2026-10-08';
    const other = plain.composed.options.flatMap((o) => o.slots).find((sl) => sl.role === 'footwear' && sl.garmentId !== shoes)?.garmentId ?? shoes;
    await s.cmd({ type: 'record_comfort_feedback', text: 'These hurt after an hour on the train', garmentId: other, wearingDate: DATE, activity: 'commute', conditions: { setting: 'train' } });
    s.calendar.addEvent({ title: 'Train to Bristol for the commute', start: `${TRAIN_DAY}T08:00:00.000Z`, end: `${TRAIN_DAY}T10:00:00.000Z` });
    const withOther = outfit.map((sl) => (sl.role === 'footwear' ? { ...sl, garmentId: other } : sl));
    const noted = await s.rec.validateProposal({ date: TRAIN_DAY }, { slots: withOther });
    expect(noted.valid).toBe(true);
    expect(noted.warnings.map((w) => w.ruleKey)).toContain('comfort.observation');
  });
});

describe('include (explicit requests)', () => {
  it('builds every option around a wearable piece; names each unwearable one with its reason instead of dropping it', async () => {
    const s = await ownerScenario({ weather: { scenario: 'coldSnap' } });
    const ctx = await s.rec.context({ date: DATE });
    const chino = ctx.wardrobe.find((g) => g.roles.includes('bottom') && g.thermal.minC <= ctx.thermal.peakTempC && ctx.thermal.peakTempC <= g.thermal.maxC && g.eligibility.available && (g.estimate?.estimatedCleanUnits ?? 0) > 0)!;
    const withChino = await s.rec.compose({ date: DATE, include: [chino.garmentId] });
    expect(withChino.composed.options.length).toBeGreaterThan(0);
    for (const o of withChino.composed.options) expect(o.slots.map((sl) => sl.garmentId)).toContain(chino.garmentId);
    expect(withChino.composed.pins).toMatchObject([{ garmentId: chino.garmentId, enforced: true, problem: null }]);

    const paraboot = await s.byName('Paraboot Reims — café/marron');
    const summerShirt = ctx.wardrobe.find((g) => g.roles.includes('base_top') && g.eligibility.available && g.thermal.minC > ctx.thermal.peakTempC)!;
    const dirty = await s.byName('Lightweight oxford — gold');
    await s.cmd({ type: 'mark_in_wash', garmentId: dirty });
    for (const [id, reason] of [
      [paraboot, /sneakers only/i],
      [summerShirt.garmentId, /°C/],
      [dirty, /./],
    ] as const) {
      const r = await s.rec.compose({ date: DATE, include: [id] });
      const name = (await s.rec.context({ date: DATE })).byId.get(id)!.name;
      for (const o of r.composed.options) expect(o.slots.map((sl) => sl.garmentId)).not.toContain(id);
      expect(r.composed.shortfall, name).toContain(`${name} can’t be included`);
      expect(r.composed.pins[0]!.problem, name).toMatch(reason);
      expect(r.composed.options.length, 'the rest of the board still comes').toBeGreaterThan(0);
    }
  });
});
