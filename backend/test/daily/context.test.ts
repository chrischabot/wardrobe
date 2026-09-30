import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { getRevisionRecord } from '../../src/recommend/publish.js';
import { ownerScenario } from '../helpers/daily.js';
import { OWNER_SOURCES } from '../helpers/fixtures.js';

const DATE = '2026-10-06';

describe('mandatory context is assembled by trusted code before any model is involved', () => {
  it('contains the full owner profile, all derived rules, restrictions and precedence', async () => {
    const s = await ownerScenario();
    const ctx = await s.rec.context({ date: DATE });
    expect(ctx.style.documents).toHaveLength(1);
    expect(ctx.style.documents[0]!.body).toBe(OWNER_SOURCES.profileText);
    expect(ctx.style.documents[0]!.contentSha256).toBe('e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198');
    expect(ctx.style.rules).toHaveLength(41);
    expect(Object.keys(ctx.policy.rules)).toHaveLength(41);
    expect(ctx.policy.sneakersOnly.active).toBe(true);
    expect(ctx.policy.jacketBand).toMatchObject({ active: true, minC: 14, maxC: 16, requiredBaseFabricClass: 'lightweight_oxford' });
    expect(ctx.policy.repeat).toMatchObject({ active: true, horizonDays: 7, roles: ['base_top', 'bottom'] });
    expect(ctx.policy.precedence).toMatch(/Precedence/);
    expect(ctx.style.dormantRuleKeys).toContain('hard.sneaker_and_welted_alternative');
  });

  it('preloads the forecast with fetch and issue times and stamps every source', async () => {
    const s = await ownerScenario();
    const ctx = await s.rec.context({ date: DATE });
    expect(s.weather.calls).toBe(1);
    expect(ctx.weather.summary.fetchedAt).toBe('2026-10-05T20:00:00.000Z');
    expect(ctx.weather.summary.issuedAt).toBe('2026-10-05T20:00:00.000Z');
    expect(ctx.weather.hours.length).toBe(12);
    const sources = Object.fromEntries(ctx.sources.map((x) => [x.source, x]));
    expect(Object.keys(sources).sort()).toEqual(['calendar', 'laundry', 'style', 'wardrobe', 'wears', 'weather']);
    expect(sources.weather!.status).toBe('fresh');
    expect(sources.style!.revision).toMatch(/^v1:e15639d891f9/);
  });

  it('distinguishes an empty calendar, a missing connection and a failed read', async () => {
    const connected = await ownerScenario();
    expect((await connected.rec.context({ date: DATE })).calendar.snapshot.status).toBe('empty');
    const none = await ownerScenario({ calendarConnected: false });
    const n = await none.rec.context({ date: DATE });
    expect(n.calendar.snapshot.status).toBe('not_connected');
    expect(n.calendar.brief.shapeOfDay).toMatch(/not connected/);
    const failing = await ownerScenario();
    failing.calendar.failListing = true;
    const f = await failing.rec.context({ date: DATE });
    expect(f.calendar.snapshot.status).toBe('unavailable');
    expect(f.calendar.brief.shapeOfDay).toMatch(/could not be read/);
    expect(f.sources.find((x) => x.source === 'calendar')!.status).toBe('unavailable');
  });

  it('carries the complete wardrobe with eligibility, recent wears, coming selections and recently shown boards', async () => {
    const s = await ownerScenario();
    const shirt = await s.byName('Selvedge twill — olive');
    await s.cmd({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-04', occurredAt: '2026-10-04T08:00:00+01:00', items: [{ garmentId: shirt, role: 'base_top' }] });
    const future = await s.rec.composeAndPublish({ date: '2026-10-08' });
    await s.cmd({ type: 'select_option', boardId: future.board!.boardId, optionId: future.board!.options[0]!.optionId });
    const ctx = await s.rec.context({ date: DATE });
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(s.userId).first<{ n: number }>();
    expect(ctx.wardrobe.length).toBe(count!.n);
    expect(ctx.wardrobe.some((g) => g.planningPolicy === 'excluded' && !g.eligibility.available)).toBe(true);
    expect(ctx.recentWears.map((w) => w.garmentId)).toContain(shirt);
    expect(ctx.byId.get(shirt)!.lastWornOn).toBe('2026-10-04');
    expect(ctx.comingSelections).toHaveLength(1);
    expect(ctx.comingSelections[0]!.date).toBe('2026-10-08');
    const later = await s.rec.context({ date: '2026-10-09' });
    expect(later.recentlyShown.map((d) => d.date)).toContain('2026-10-08');
  });

  it('stores the context evidence with each published revision', async () => {
    const s = await ownerScenario();
    const out = await s.rec.composeAndPublish({ date: DATE });
    const rec = await getRevisionRecord(env.DB, s.principal, out.board!.boardId, 1);
    const c = rec!.context as Record<string, any>;
    expect(c.contextVersion).toBe('mandatory-context/1');
    expect(c.style.documents[0].sha256).toBe('e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198');
    expect(c.style.ruleKeys).toHaveLength(41);
    expect(c.weather.provider).toBe(s.weather.name);
    expect(c.calendar.status).toBe('empty');
    expect(c.request).toEqual({ date: DATE });
    expect(c.thermal).toMatchObject({ source: 'forecast' });
  });
});
