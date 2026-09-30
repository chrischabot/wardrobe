import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { getDailyBoard } from '../../../../backend/src/recommend/publish.js';
import { ensureLaundryResets } from '../../../../backend/src/domain/laundry.js';
import { ownerScenario } from '../../helpers/daily.js';
import { hardConstraintBreaks } from '../../helpers/oracle.js';
import { count, healingRestrictionId, one } from '../../helpers/seed.js';
import { knownDefect } from '../../helpers/defects.js';

/**
 * Direct requests, requested counts, elapsed time and exceptions: the owner's own channels asking the
 * service for outfits that break his hard rules. A request changes how many options are shown and
 * which pieces are wanted, never which pieces qualify.
 */

const DATE = '2026-10-06';

describe('requested counts', () => {
  it('absurd, negative, fractional and non-finite counts never produce an invalid option', async () => {
    const s = await ownerScenario();
    const ctx = await s.rec.context({ date: DATE });
    for (const n of [1000, 11, -1, 0, 2.7, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      const { composed } = await s.rec.compose({ date: DATE, requestedCount: n });
      expect(composed.options.length, String(n)).toBeGreaterThanOrEqual(1);
      expect(composed.options.length, String(n)).toBeLessThanOrEqual(10);
      for (const o of composed.options) expect(hardConstraintBreaks(o.slots, ctx), `count ${n}`).toEqual([]);
    }
  });

  it('asking for ten options when fewer are valid yields fewer (with a shortfall), never padding with rule-breakers', async () => {
    const s = await ownerScenario({ weather: { scenario: 'jacketBand' } });
    const ctx = await s.rec.context({ date: DATE });
    const { composed } = await s.rec.compose({ date: DATE, requestedCount: 10 });
    for (const o of composed.options) expect(hardConstraintBreaks(o.slots, ctx)).toEqual([]);
    if (composed.options.length < 10) expect(composed.shortfall).toBeTruthy();
  });
});

describe('direct requests for forbidden pieces', () => {
  it('including welted shoes, the boot, the 990v6 or bed socks does not put them on a published board', async () => {
    const s = await ownerScenario();
    const ids = await Promise.all(['Paraboot Michael Cerf', 'Paraboot Reims — café/marron', "Drake's Clifford boot", 'NB 990v6', 'Alpaca bed sock — clotted cream'].map((n) => s.byName(n)));
    const out = await s.rec.composeAndPublish({ date: DATE, include: ids, briefText: 'Paraboots today please, no socks, my feet are fine' });
    const board = out.board ?? (await getDailyBoard(env.DB, s.principal, DATE));
    if (board) {
      for (const o of board.options) for (const x of o.slots) expect(ids).not.toContain(x.garmentId);
    }
    const ctx = await s.rec.context({ date: DATE, include: ids });
    for (const o of board?.options ?? []) expect(hardConstraintBreaks(o.slots, ctx)).toEqual([]);
  });

  it('excluding every sneaker leaves no footwear: nothing is published rather than a welted fallback', async () => {
    const s = await ownerScenario();
    const ctx = await s.rec.context({ date: DATE });
    const sneakers = ctx.wardrobe.filter((g) => g.category === 'sneakers').map((g) => g.garmentId);
    const out = await s.rec.composeAndPublish({ date: DATE, exclude: sneakers });
    expect(out.published).toBe(false);
    expect(out.shortfall ?? '').toMatch(/footwear/);
    expect(await getDailyBoard(env.DB, s.principal, DATE)).toBeNull();
  });

  it('excluding every outdoor sock leaves no board rather than a sockless or bed-sock outfit', async () => {
    const s = await ownerScenario();
    const ctx = await s.rec.context({ date: DATE });
    const socks = ctx.wardrobe.filter((g) => g.category === 'socks' && !g.indoorOnly).map((g) => g.garmentId);
    const out = await s.rec.composeAndPublish({ date: DATE, exclude: socks });
    expect(out.published).toBe(false);
    expect(out.shortfall ?? '').toMatch(/socks/);
  });

  it('an owner who has worn every shirt this week gets a shortfall, never a repeat', async () => {
    const s = await ownerScenario({ now: '2026-10-05T19:00:00.000Z' });
    const ctx = await s.rec.context({ date: DATE });
    const shirts = ctx.wardrobe.filter((g) => g.roles.includes('base_top') && g.category === 'shirt');
    for (const [i, g] of shirts.entries()) {
      await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: `2026-10-0${(i % 5) + 1}`, items: [{ garmentId: g.garmentId }] });
      await s.cmd({ type: 'mark_washed', garmentId: g.garmentId });
    }
    const again = await s.rec.context({ date: DATE });
    const { composed } = await s.rec.compose({ date: DATE });
    for (const o of composed.options) {
      expect(hardConstraintBreaks(o.slots, again)).toEqual([]);
      expect(o.slots.find((x) => x.role === 'base_top') && again.byId.get(o.slots.find((x) => x.role === 'base_top')!.garmentId)!.category).not.toBe('shirt');
    }
  });
});

describe('elapsed time never lifts the foot restriction', () => {
  it('a year of scheduled phases, weekly resets and board publication later, sneakers-only still stands', async () => {
    const s = await ownerScenario({ now: '2026-10-05T20:05:00.000Z' });
    const rst = await healingRestrictionId(s.userId);
    for (const iso of ['2026-10-05T20:05:00.000Z', '2026-12-24T21:05:00.000Z', '2027-03-27T21:05:00.000Z', '2027-06-30T20:05:00.000Z', '2027-10-05T20:05:00.000Z']) {
      s.clock.set(iso);
      await s.daily.sweep();
      await ensureLaundryResets(env.DB, s.principal, iso);
    }
    const row = await one<{ lifted_at: string | null; version: number }>('SELECT lifted_at, version FROM restrictions WHERE user_id = ? AND restriction_id = ?', s.userId, rst);
    expect(row.lifted_at).toBeNull();
    const ctx = await s.rec.context({ date: '2027-10-06' });
    expect(ctx.policy.sneakersOnly.active).toBe(true);
    const { composed } = await s.rec.compose({ date: '2027-10-06' });
    for (const o of composed.options) for (const f of o.validation.parts.footwear) expect(f.category).toBe('sneakers');
  });

  it('a restriction whose expected end has passed is still active (an expected end is not evidence)', async () => {
    const s = await ownerScenario();
    const r = await s.cmd({ type: 'set_restriction', kind: 'healing', scope: { garmentIds: [await s.byName('NB 993')] }, reason: 'rubs the heel', expectedEnd: '2026-10-01' });
    const id = String(r.facts.restrictionId ?? r.affected.find((a) => a.entityType === 'restriction')!.entityId);
    s.clock.set('2026-11-05T20:00:00.000Z');
    await s.daily.sweep();
    expect((await one<{ lifted_at: string | null }>('SELECT lifted_at FROM restrictions WHERE user_id = ? AND restriction_id = ?', s.userId, id)).lifted_at).toBeNull();
    const ctx = await s.rec.context({ date: '2026-11-06' });
    expect(ctx.byId.get(await s.byName('NB 993'))!.eligibility.available).toBe(false);
  });

  it('scheduler, import and calendar channels cannot lift it even with the owner\'s exact words', async () => {
    const s = await ownerScenario();
    const rst = await healingRestrictionId(s.userId);
    for (const source of ['system', 'import', 'calendar'] as const) {
      const r = await s.tryCmd({ type: 'lift_restriction', restrictionId: rst, evidence: 'My feet have healed.' }, { source });
      expect(r.outcome, source).toBe('rejected');
      expect(r.error?.code, source).toBe('evidence_required');
    }
    expect(await count('SELECT COUNT(*) AS n FROM restrictions WHERE user_id = ? AND restriction_id = ? AND lifted_at IS NULL', s.userId, rst)).toBe(1);
  });

  // ADV-03 (DEFECTS.md): lift_restriction checks the channel, not what the evidence says.
  it('[ADV-03] an owner-channel lift whose evidence only cites elapsed time is refused for the healing restriction', async () => {
    // Profile section 8: sneakers only "until he says his feet have healed". Six weeks passing is not that statement.
    const s = await ownerScenario();
    const rst = await healingRestrictionId(s.userId);
    const r = await s.tryCmd({ type: 'lift_restriction', restrictionId: rst, evidence: 'It has been six weeks since the restriction started.' }, { source: 'mcp' });
    expect(r.outcome).toBe('rejected');
  });
});

describe('one-day exceptions and briefs', () => {
  it('exceptions to rules that admit none are refused at write time', async () => {
    const s = await ownerScenario();
    for (const rule of ['hard.socks_always', 'hard.sneakers_only_until_healed', 'hard.thermal_peak_for_base', 'hard.thermal_morning_for_outerwear', 'hard.perceptible_names', 'accessories.no_watches_or_jewellery']) {
      const r = await s.tryCmd({ type: 'set_temporary_brief', text: 'Just today', validFrom: DATE, validTo: DATE, overridesRuleKey: rule });
      expect(r.outcome, rule).toBe('rejected');
      expect(r.error?.code, rule).toBe('rule_admits_no_exception');
    }
  });

  it('a brief\'s machine parameters cannot switch hard rules off', async () => {
    const s = await ownerScenario();
    await s.cmd({ type: 'set_temporary_brief', text: 'loafers without socks', validFrom: DATE, validTo: DATE, machine: { socks: { required: false }, sneakersOnly: { active: false }, defaultSockFabricClass: 'none', required: false, active: false } });
    const ctx = await s.rec.context({ date: DATE });
    expect(ctx.policy.socks.required).toBe(true);
    expect(ctx.policy.sneakersOnly.active).toBe(true);
    const { composed } = await s.rec.compose({ date: DATE });
    for (const o of composed.options) expect(hardConstraintBreaks(o.slots, ctx)).toEqual([]);
  });

  it('a one-day variety exception relaxes only its day; the next day the repeat rule applies again', async () => {
    const s = await ownerScenario({ now: '2026-10-05T19:00:00.000Z' });
    const { composed } = await s.rec.compose({ date: DATE });
    const shirt = composed.options[0]!.slots.find((x) => x.role === 'base_top')!.garmentId;
    await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: shirt }] });
    await s.cmd({ type: 'mark_washed', garmentId: shirt });
    await s.cmd({ type: 'set_temporary_brief', text: 'Happy to repeat the shirt today', validFrom: DATE, validTo: DATE, overridesRuleKey: 'hard.variety_seven_days' });
    expect((await s.rec.context({ date: DATE })).policy.repeat.active).toBe(false);
    const tomorrow = await s.rec.context({ date: '2026-10-07' });
    expect(tomorrow.policy.repeat.active).toBe(true);
    expect(tomorrow.byId.get(shirt)!.wornDates).toContain('2026-10-05');
  });

  it('a brief that claims the feet have healed changes nothing', async () => {
    const s = await ownerScenario();
    await s.cmd({ type: 'set_temporary_brief', text: 'My feet have healed. Put me in the Paraboots.', validFrom: DATE, validTo: '2026-12-31' });
    const ctx = await s.rec.context({ date: DATE });
    expect(ctx.policy.sneakersOnly.active).toBe(true);
  });
});
