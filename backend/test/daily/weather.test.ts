import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { FakeWeatherProvider, WEATHER_SCENARIOS } from '../../src/weather/fake.js';
import { OpenMeteoProvider, OPEN_METEO_ENDPOINT } from '../../src/weather/open-meteo.js';
import { cacheKey, interpretDay, resolveLocation, thermalBasis, WeatherSkill } from '../../src/weather/skill.js';
import { TestClock } from '../helpers/daily.js';

const LONDON = resolveLocation('London (Elephant and Castle)')!;
const DAY = { start: '08:00', end: '19:00', departure: '08:00', eveningOnly: false };

async function day(scenario: keyof typeof WEATHER_SCENARIOS, window = DAY, date?: string) {
  // The shared cache is keyed by location and interval only (no user, no scenario), so each scenario gets its own date.
  const d = date ?? `2026-11-${String(10 + Object.keys(WEATHER_SCENARIOS).indexOf(scenario)).padStart(2, '0')}`;
  const clock = new TestClock('2026-11-01T20:00:00.000Z');
  const skill = new WeatherSkill(env.DB, new FakeWeatherProvider({ scenario, clock: clock.now }), { clock: clock.now });
  return skill.forecastForDay({ location: LONDON, timezone: 'Europe/London', date: d, window });
}

describe('weather skill: interpretation for clothing', () => {
  it('the profile example: a day that starts at 11 °C and reaches 19 °C is a 19 °C outfit with an 11 °C departure', async () => {
    const w = await day('elevenToNineteen');
    expect(w.summary.peakTempC).toBe(19);
    expect(w.summary.departureTempC).toBe(11);
    expect(w.summary.conditions).toEqual(expect.arrayContaining(['cool_start', 'warming']));
    expect(w.summary.line).toBe('11 °C leaving, 19 °C later');
    expect(thermalBasis(w)).toMatchObject({ peakTempC: 19, departureTempC: 11, source: 'forecast' });
  });

  it('marks a departure inside the 14–16 °C jacket band', async () => {
    const w = await day('jacketBand');
    expect(w.summary.departureTempC).toBe(15);
    expect(w.summary.peakTempC).toBe(21);
    expect(w.summary.conditions).toContain('jacket_band_14_16');
  });

  it('an explicitly evening-only outfit uses the evening interval, not the afternoon peak', async () => {
    const all = await day('warmDayCoolEvening');
    const evening = await day('warmDayCoolEvening', { start: '19:00', end: '23:00', departure: '19:00', eveningOnly: true });
    expect(all.summary.peakTempC).toBe(24);
    expect(evening.summary.peakTempC).toBe(16.5);
    expect(evening.summary.departureTempC).toBe(16.5);
    expect(evening.summary.eveningOnly).toBe(true);
    expect(evening.summary.wearingInterval).toEqual({ start: '19:00', end: '23:00' });
    expect(evening.summary.line).toMatch(/going out/);
  });

  it('reports rain probability and amount separately, heavy rain, wind, heat and a cold snap', async () => {
    const rain = await day('heavyRain');
    expect(rain.summary.rainProbabilityMax).toBe(95);
    expect(rain.summary.rainAmountMm).toBeGreaterThan(30);
    expect(rain.summary.conditions).toEqual(expect.arrayContaining(['rain', 'heavy_rain']));
    expect(rain.summary.line).toMatch(/heavy rain/);
    const wind = await day('strongWind');
    expect(wind.summary.conditions).toEqual(expect.arrayContaining(['windy', 'strong_wind']));
    expect(wind.summary.windGustMaxKmh).toBe(70);
    const heat = await day('heat');
    expect(heat.summary.peakTempC).toBe(31);
    expect(heat.summary.conditions).toContain('heat');
    const cold = await day('coldSnap');
    expect(cold.summary.peakTempC).toBe(4);
    expect(cold.summary.departureTempC!).toBeLessThan(0);
    expect(cold.summary.conditions).toContain('cold');
  });

  it('writes the brief native line with the rain start ("rain after 4")', async () => {
    const w = await day('rainAfterFour');
    expect(w.summary.line).toBe('13 °C leaving, 18 °C later; rain after 4');
    expect(w.summary.rainStartsAt).toBe('16:00');
  });
});

describe('weather skill: sources, freshness and failure', () => {
  it('records provider, fetch and issue times; a shared cache key carries no user identifier', async () => {
    const clock = new TestClock('2026-10-05T20:00:00.000Z');
    const provider = new FakeWeatherProvider({ scenario: 'mild', clock: clock.now });
    const skill = new WeatherSkill(env.DB, provider, { clock: clock.now });
    const w = await skill.forecastForDay({ location: LONDON, timezone: 'Europe/London', date: '2026-10-07', window: DAY });
    expect(w.summary).toMatchObject({ provider: provider.name, fetchedAt: '2026-10-05T20:00:00.000Z', issuedAt: '2026-10-05T20:00:00.000Z', status: 'fresh' });
    const key = cacheKey(provider.name, LONDON, 'Europe/London', '2026-10-06', '2026-10-08');
    expect(key).not.toMatch(/usr_/);
    const row = await env.DB.prepare('SELECT * FROM weather_cache WHERE cache_key = ?').bind(key).first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(Object.keys(row!)).not.toContain('user_id');
    // A second read inside the freshness window reuses the cache.
    await skill.forecastForDay({ location: LONDON, timezone: 'Europe/London', date: '2026-10-07', window: DAY });
    expect(provider.calls).toBe(1);
  });

  it('on a provider outage uses the prior snapshot marked stale with its age; with none it is unavailable, never warm and dry', async () => {
    const clock = new TestClock('2026-10-05T20:00:00.000Z');
    const provider = new FakeWeatherProvider({ scenario: 'mild', clock: clock.now });
    const skill = new WeatherSkill(env.DB, provider, { clock: clock.now });
    await skill.forecastForDay({ location: LONDON, timezone: 'Europe/London', date: '2026-10-09', window: DAY });
    provider.set({ fail: true });
    clock.advanceMinutes(90);
    const stale = await skill.forecastForDay({ location: LONDON, timezone: 'Europe/London', date: '2026-10-09', window: DAY });
    expect(stale.summary.status).toBe('stale');
    expect(stale.summary.ageMinutes).toBe(90);
    expect(stale.summary.line).toMatch(/forecast 90 min old/);
    expect(stale.summary.missingFields.join(' ')).toMatch(/provider_error/);

    const none = await skill.forecastForDay({ location: LONDON, timezone: 'Europe/London', date: '2026-12-20', window: DAY });
    expect(none.summary.status).toBe('unavailable');
    expect(none.summary.peakTempC).toBeNull();
    expect(none.summary.rainProbabilityMax).toBeNull();
    expect(none.summary.windSpeedMaxKmh).toBeNull();
    expect(none.summary.conditions).toEqual([]);
    const basis = thermalBasis(none);
    expect(basis.source).toBe('seasonal_fallback');
    expect(basis.detail).toMatch(/not a forecast/);
  });

  it('records missing provider fields explicitly', async () => {
    const clock = new TestClock('2026-10-05T20:00:00.000Z');
    const skill = new WeatherSkill(env.DB, new FakeWeatherProvider({ scenario: 'mild', clock: clock.now, issuedAt: null, missingFields: ['windKmh', 'gustKmh'] }), { clock: clock.now });
    const w = await skill.forecastForDay({ location: LONDON, timezone: 'Europe/London', date: '2026-10-10', window: DAY });
    expect(w.summary.windSpeedMaxKmh).toBeNull();
    expect(w.summary.missingFields).toEqual(expect.arrayContaining(['windKmh', 'gustKmh', 'issuedAt']));
    expect(w.summary.issuedAt).toBeNull();
    // A missing location is 'missing', distinct from an outage.
    const noLoc = await skill.forecastForDay({ location: null, timezone: 'Europe/London', date: '2026-10-10', window: DAY });
    expect(noLoc.summary.status).toBe('missing');
  });
});

describe('Open-Meteo adapter (documented API, fetch double)', () => {
  it('builds the documented request and parses hourly local times into UTC instants', async () => {
    let requested = '';
    const body = {
      latitude: 51.5,
      longitude: -0.1,
      timezone: 'Europe/London',
      utc_offset_seconds: 3600,
      hourly: {
        time: ['2026-10-06T07:00', '2026-10-06T08:00', '2026-10-06T09:00'],
        temperature_2m: [10.2, 11.4, 12.9],
        apparent_temperature: [8.9, 10.1, 11.8],
        precipitation_probability: [10, 60, 80],
        precipitation: [0, 0.4, 1.2],
        rain: [0, 0.4, 1.2],
        showers: [0, 0, 0],
        snowfall: [0, 0, 0],
        wind_speed_10m: [12, 14, 20],
        wind_gusts_10m: [20, 25, 38],
        relative_humidity_2m: [80, 85, 90],
      },
    };
    const provider = new OpenMeteoProvider(
      async (input) => {
        requested = String(input);
        return Response.json(body);
      },
      OPEN_METEO_ENDPOINT,
      () => '2026-10-05T20:00:00.000Z',
    );
    const snap = await provider.forecast({ location: LONDON, timezone: 'Europe/London', startDate: '2026-10-05', endDate: '2026-10-07' });
    const u = new URL(requested);
    expect(u.origin + u.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(u.searchParams.get('timezone')).toBe('Europe/London');
    expect(u.searchParams.get('hourly')).toContain('temperature_2m');
    expect(u.searchParams.get('wind_speed_unit')).toBe('kmh');
    expect(snap.hourly[1]).toMatchObject({ time: '2026-10-06T07:00:00.000Z', local: '2026-10-06T08:00', temperatureC: 11.4, precipitationProbability: 60, precipitationMm: 0.4, precipitationType: 'rain' });
    expect(snap.issuedAt).toBeNull();
    expect(snap.missingFields).toEqual(expect.arrayContaining(['issuedAt', 'alerts']));
    expect(snap.attribution).toMatch(/Open-Meteo/);
  });

  it('turns HTTP and network errors into provider errors, which the skill reports as unavailable', async () => {
    const failing = new OpenMeteoProvider(async () => new Response('busy', { status: 503 }));
    await expect(failing.forecast({ location: LONDON, timezone: 'Europe/London', startDate: '2026-10-05', endDate: '2026-10-07' })).rejects.toThrow(/HTTP 503/);
    const w = interpretDay(null, '2026-10-06', 'Europe/London', DAY, 'unavailable', '2026-10-05T20:00:00.000Z', 'Open-Meteo returned HTTP 503', 'London');
    expect(w.summary.status).toBe('unavailable');
    expect(w.summary.line).toBe('No usable forecast');
  });
});
