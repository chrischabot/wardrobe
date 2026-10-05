/**
 * Regression tests for defects the adversarial suite exposed in the daily service
 * (tests/adversarial/daily-media/daily; identifiers as in its COVERAGE.md).
 *
 * Real D1 and the real weather service; the provider is the labelled FakeWeatherProvider behind the
 * weather port.
 */
import { describe, expect, it } from "vitest";
import { all } from "@garderobe/domain";
import { fetchWeatherSnapshot } from "../src/index.ts";
import { forecastCoversDate, implausibleForecast } from "../src/weather/assess.ts";
import { createDailyHarness, MILD_DAY, system, TEST_DAILY_SETTINGS } from "./helpers.ts";

describe("ADV-W1: a physically impossible forecast is refused whole", () => {
  it.each([
    // The reason names the first impossible value met, hour by hour: midnight's 400 degrees here.
    ["900 degrees", { temperatureByHour: { 0: 400, 12: 900, 23: 400 } }, /temperature of 400/],
    ["below absolute zero", { temperatureByHour: { 0: -300, 23: -300 } }, /temperature of -300/],
    ["a 5000 % chance of rain", { ...MILD_DAY, rainProbabilityByHour: () => 5000 }, /chance of rain of 5000/],
  ] as const)("%s: the snapshot is unavailable with a plain reason, and nothing is cached", async (_label, spec, reason) => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: TEST_DAILY_SETTINGS as never });
    h.weather.setForecast("2026-09-16", spec as never);
    const snapshot = await fetchWeatherSnapshot(h.deps, await system(h, owner), { localDate: "2026-09-16", purpose: "evening_compose" });
    expect(snapshot.freshness).toBe("unavailable");
    expect(snapshot.conditions).toMatchObject({ peakC: null, departureC: null, maxPrecipitationProbabilityPct: null });
    expect(snapshot.limitation).toMatch(/implausible forecast/);
    expect(snapshot.limitation).toMatch(reason);
    expect(snapshot.line).toBe("Weather unavailable");
    expect(await all(h.db, "SELECT cache_key FROM weather_cache")).toEqual([]);
  });

  it("an impossible answer after a good one falls back to the good one as stale, and says why", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: TEST_DAILY_SETTINGS as never });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const good = await fetchWeatherSnapshot(h.deps, await system(h, owner), { localDate: "2026-09-16", purpose: "evening_compose" });
    expect(good.freshness).toBe("fresh");
    h.clock.advanceMinutes(90);
    h.weather.setForecast("2026-09-16", { temperatureByHour: { 0: 900, 23: 900 } });
    const later = await fetchWeatherSnapshot(h.deps, await system(h, owner), { localDate: "2026-09-16", purpose: "morning_refresh" });
    expect(later.freshness).toBe("stale");
    expect(later.conditions.peakC).toBe(good.conditions.peakC);
    expect(later.limitation).toMatch(/implausible forecast.*using the forecast fetched 1 h ago/);
  });

  it("real extremes are weather: 46 degrees and minus 40 are accepted", () => {
    const hour = (temperatureC: number) => ({ localTime: "2026-07-01T14:00", at: "2026-07-01T13:00:00Z", temperatureC, apparentTemperatureC: temperatureC + 4, precipitationProbabilityPct: 100, precipitationMm: 80, precipitationType: "rain" as const, windSpeedKmh: 120, windGustKmh: 190, humidityPct: 100 });
    const forecast = (temperatureC: number) => ({ provider: "open-meteo" as const, attribution: "", timezone: "Europe/London", latitude: 0, longitude: 0, fetchedAt: "2026-07-01T00:00:00Z", issuedAt: null, hours: [hour(temperatureC)], alerts: null, missingFields: [] });
    expect(implausibleForecast(forecast(46) as never)).toBeNull();
    expect(implausibleForecast(forecast(-40) as never)).toBeNull();
    expect(implausibleForecast(forecast(61) as never)).toMatch(/temperature of 61/);
    expect(forecastCoversDate(forecast(20) as never, "2026-07-01")).toBe(true);
    expect(forecastCoversDate(forecast(20) as never, "2026-07-02")).toBe(false);
  });
});

describe("ADV-W2: an answer that says nothing about the day is not held in the shared cache", () => {
  it("the next request asks the provider again and uses a good answer at once", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: TEST_DAILY_SETTINGS as never });
    // Nothing configured for the date: the fake answers with no hours for it.
    const empty = await fetchWeatherSnapshot(h.deps, await system(h, owner), { localDate: "2026-09-16", purpose: "evening_compose" });
    expect(empty.freshness).toBe("unavailable");
    expect(await all(h.db, "SELECT cache_key FROM weather_cache")).toEqual([]);
    h.clock.advanceMinutes(1);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const next = await fetchWeatherSnapshot(h.deps, await system(h, owner), { localDate: "2026-09-16", purpose: "evening_compose" });
    expect(next.freshness).toBe("fresh");
    expect(next.conditions.peakC).toBe(19);
    expect(h.weather.calls).toHaveLength(2);
  });
});
