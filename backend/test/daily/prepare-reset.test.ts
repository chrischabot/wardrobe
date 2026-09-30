import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getDailyBoard } from '../../src/recommend/publish.js';
import { RecommendationService } from '../../src/recommend/service.js';
import { validateOutfit } from '../../src/recommend/validate.js';
import { apiOwner, installApiScenario, prepareToday } from '../helpers/api.js';
import { ok } from '../helpers/fixtures.js';

/**
 * "Prepare now" (POST /v1/today/prepare, through the Worker's own fetch handler) applies any weekly
 * laundry reset that is due before composing, exactly like the scheduled evening phase. No scheduled
 * phase runs anywhere in this file: the Sunday sweep is missed on purpose.
 */

const cycles = async (userId: string) =>
  (await env.DB.prepare('SELECT pool, cycle_key FROM laundry_resets WHERE user_id = ? ORDER BY pool, cycle_key').bind(userId).all<{ pool: string; cycle_key: string }>()).results.map((r) => `${r.pool}:${r.cycle_key}`);

describe('Prepare now applies a due weekly laundry reset', () => {
  it('a shirt chosen on Monday is likely available again after a missed Sunday sweep', async () => {
    const { clock, weather } = installApiScenario({ now: '2026-09-28T05:30:00.000Z' }); // Monday 06:30 in London
    const owner = await apiOwner();
    const rec = new RecommendationService({ db: env.DB, principal: owner.principal, weather, calendar: null, clock: clock.now });

    await prepareToday(owner.assertion);
    expect(await cycles(owner.userId)).toContain('service:2026-09-27');
    const monday = (await getDailyBoard(env.DB, owner.principal, '2026-09-28'))!;
    const chosen = monday.options.find((o) => o.status === 'offerable')!;
    const shirt = chosen.slots.find((s) => s.role === 'base_top')!.garmentId;
    await ok(owner.principal, { type: 'select_option', boardId: monday.boardId, optionId: chosen.optionId }, {}, { now: clock.now });

    // The following Tuesday; the Friday collection and the Sunday 4 October baseline have passed,
    // but no scheduled phase ran. The chosen, unreported shirt is still presumed worn.
    clock.set('2026-10-06T05:30:00.000Z');
    expect(await cycles(owner.userId)).not.toContain('service:2026-10-04');
    const stale = (await rec.context({ date: '2026-10-06' })).byId.get(shirt)!;
    expect(stale.estimate!.probabilityAvailable).toBeLessThan(0.5);

    const prepared = await prepareToday(owner.assertion);
    expect(prepared).toMatchObject({ published: true, date: '2026-10-06' });
    expect(await cycles(owner.userId)).toEqual(expect.arrayContaining(['service:2026-10-04', 'hand_wash:2026-10-04']));

    const ctx = await rec.context({ date: '2026-10-06' });
    const fresh = ctx.byId.get(shirt)!;
    expect(fresh.estimate!.probabilityAvailable).toBeGreaterThanOrEqual(0.5);
    expect(stale.estimate!.basis.some((b) => b.kind === 'selection' && b.boardDate === '2026-09-28')).toBe(true);
    expect(fresh.estimate!.basis.some((b) => b.kind === 'selection' || b.kind === 'board_probability')).toBe(false);
    expect(fresh.eligibility.available).toBe(true);
    // It completes a valid outfit on the day (hard rules and availability both pass).
    const tuesday = (await getDailyBoard(env.DB, owner.principal, '2026-10-06'))!;
    const base = tuesday.options.find((o) => o.status === 'offerable')!.slots;
    const withShirt = [...base.filter((s) => s.role !== 'base_top'), { garmentId: shirt, role: 'base_top' as const }];
    const v = validateOutfit({ slots: withShirt }, ctx);
    expect(v.violations.filter((x) => x.ruleKey === 'availability.eligible')).toEqual([]);

    // Idempotent: preparing again applies nothing new.
    const before = await cycles(owner.userId);
    await prepareToday(owner.assertion);
    expect(await cycles(owner.userId)).toEqual(before);
  });
});
