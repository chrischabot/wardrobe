import { describe, expect, it } from 'vitest';
import { validateOutfit } from '../../src/recommend/validate.js';
import { ownerScenario } from '../helpers/daily.js';

const DATE = '2026-10-06';

/** Every published option re-validates against the same context: zero tolerated hard violations. */
async function board(scenario: Parameters<typeof ownerScenario>[0], req: Record<string, unknown> = {}) {
  const s = await ownerScenario(scenario);
  const out = await s.rec.composeAndPublish({ date: DATE, ...req });
  const ctx = await s.rec.context({ date: DATE, ...req });
  expect(out.published).toBe(true);
  const options = out.board!.options.filter((o) => o.status === 'offerable');
  for (const o of options) {
    const v = validateOutfit({ slots: o.slots }, ctx);
    expect(v.violations, JSON.stringify(v.violations)).toEqual([]);
  }
  return { s, out, ctx, options, parts: options.map((o) => validateOutfit({ slots: o.slots }, ctx).parts) };
}

describe('simulated weather scenarios', () => {
  it('cold snap: a coat for a sub-zero departure, warm shirts and trousers for a 4 °C peak, scarves on the belt line', async () => {
    const { ctx, parts } = await board({ weather: { scenario: 'coldSnap' } });
    expect(ctx.thermal.peakTempC).toBe(4);
    for (const p of parts) {
      expect(p.outer).not.toBeNull();
      expect(p.outer!.thermal.minC).toBeLessThanOrEqual(ctx.thermal.departureTempC);
      expect(p.top!.fabricClass).not.toBe('lightweight_oxford');
      expect(p.top!.fabricClass).not.toMatch(/linen/);
    }
    expect(parts.filter((p) => p.flourish?.category === 'scarf').length).toBeGreaterThanOrEqual(3);
  });

  it('heavy rain: every option has a layer; the waxed cotton is used; light trousers are avoided', async () => {
    const { parts, out } = await board({ weather: { scenario: 'heavyRain' } });
    for (const p of parts) expect(p.outer).not.toBeNull();
    expect(parts.some((p) => p.outer!.fabricClass === 'waxed_cotton')).toBe(true);
    expect(parts.filter((p) => p.bottom!.families.some((f) => f === 'white' || f === 'cream')).length).toBeLessThanOrEqual(1);
    expect(out.board!.document!.weather.conditions).toEqual(expect.arrayContaining(['rain', 'heavy_rain']));
    expect(out.board!.document!.dayLine).toMatch(/heavy rain/);
  });

  it('strong wind: no linen jacket leads and scarves are favoured', async () => {
    const { parts, out } = await board({ weather: { scenario: 'strongWind' } });
    expect(out.board!.document!.weather.conditions).toContain('strong_wind');
    expect(/linen/i.test(parts[0]!.outer?.fabric ?? '')).toBe(false);
    expect(parts.filter((p) => p.flourish?.category === 'scarf').length).toBeGreaterThanOrEqual(3);
  });

  it('heat: no jackets, hot-weather cloth, merino socks still on', async () => {
    const { parts } = await board({ weather: { scenario: 'heat' } });
    for (const p of parts) {
      expect(p.outer).toBeNull();
      expect(p.socks!.fabricClass).toBe('merino');
      expect(p.bottom!.thermal.maxC).toBeGreaterThanOrEqual(31);
    }
  });

  it('evening-only: an explicitly evening outfit is dressed for the evening interval, not the afternoon', async () => {
    const { ctx, out, parts } = await board({ weather: { scenario: 'warmDayCoolEvening' } }, { window: { eveningOnly: true, start: '19:00', end: '23:00' } });
    expect(ctx.thermal).toMatchObject({ peakTempC: 16.5, departureTempC: 16.5 });
    expect(out.board!.brief.wearingInterval).toEqual({ start: '19:00', end: '23:00' });
    expect(out.board!.document!.weather.eveningOnly).toBe(true);
    // Warm-weather-only cloth (rated from 20 °C) is excluded although the afternoon reaches 24 °C.
    for (const p of parts) expect(p.top!.thermal.minC).toBeLessThanOrEqual(16.5);
  });

  it('an outage leaves a truthful board: seasonal basis, labelled, with a jacket (missing data never means warm)', async () => {
    const { out, parts } = await board({ weather: { scenario: 'mild', fail: true } });
    expect(out.board!.document!.weather.status).toBe('unavailable');
    expect(out.board!.document!.dayLine).toMatch(/No usable forecast; dressed for the season, not a forecast/);
    for (const p of parts) expect(p.outer).not.toBeNull();
  });
});
