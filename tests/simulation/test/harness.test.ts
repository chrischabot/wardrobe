import { describe, expect, it } from 'vitest';
import { buildScenario } from '../src/scenario.js';
import { signSimState, verifySimState, type SimState } from '../src/sim-state.js';

const SECRET = 'x'.repeat(40);
const state: SimState = { v: 1, userId: 'usr_simulation01', clock: '2026-10-05T06:00:00.000Z', weather: { home: {} }, calendar: null, revision: 'r1' };

describe('simulation header (the only gate of the Worker hook)', () => {
  it('accepts its own signature and refuses a tampered body, another secret or a short secret', async () => {
    const header = await signSimState(state, SECRET);
    expect(await verifySimState(header, SECRET)).toEqual(state);
    const [body, mac] = header.split('.');
    const forged = Buffer.from(JSON.stringify({ ...state, userId: 'usr_someoneelse1' })).toString('base64url');
    expect(await verifySimState(`${forged}.${mac}`, SECRET)).toBeNull();
    expect(await verifySimState(`${body}.${mac!.slice(0, -2)}AA`, SECRET)).toBeNull();
    expect(await verifySimState(header, 'y'.repeat(40))).toBeNull();
    expect(await verifySimState(header, 'short')).toBeNull();
    expect(await verifySimState(header, undefined)).toBeNull();
  });
});

describe('seeded scenario', () => {
  it('is reproducible from its seed and differs between seeds', () => {
    expect(JSON.stringify(buildScenario(7))).toBe(JSON.stringify(buildScenario(7)));
    expect(JSON.stringify(buildScenario(7).days.map((d) => d.weather))).not.toBe(JSON.stringify(buildScenario(8).days.map((d) => d.weather)));
  });

  it('covers at least 28 days and every weather kind and circumstance for any seed', () => {
    const required = ['weather_outage', 'calendar_outage', 'forecast_revised_overnight', 'spill_mark_in_wash', 'laundry_collected', 'laundry_returned', 'laundry_partial_return', 'repair_restriction_set', 'repair_restriction_lifted', 'sent_to_tailor', 'back_from_tailor', 'seasonal_storage', 'trip_created', 'trip_packed', 'trip_day', 'trip_unpacked', 'feet_healed', 'pause_from_tomorrow', 'paused', 'resume', 'temporary_brief', 'occasion_preview'];
    for (const seed of [1, 42, 20261005, 99991]) {
      const s = buildScenario(seed);
      expect(s.days.length).toBeGreaterThanOrEqual(28);
      const kinds = new Set(s.days.map((d) => d.weatherKind));
      for (const k of ['heavy_rain', 'rain_after_four', 'strong_wind', 'jacket_band', 'cold_start_warm_afternoon', 'cold_snap', 'unseasonal_warm']) expect(kinds, `seed ${seed} weather ${k}`).toContain(k);
      const circ = new Set(s.days.flatMap((d) => d.circumstances));
      for (const c of required) expect(circ, `seed ${seed} circumstance ${c}`).toContain(c);
      expect(s.days.some((d) => d.calendarLabels.includes('adversarial event title'))).toBe(true);
      expect(s.days.flatMap((d) => d.asks).some((a) => a.expectedDepth === 'deep')).toBe(true);
    }
  });
});
