/**
 * Weather assessment acceptance scenarios (requirements/garderobe-replacement-design.md, "Weather skill
 * and preloaded forecast context"). `buildWeatherSnapshot` and `materialChange` are pure; the forecasts
 * fed to them are SYNTHETIC, built by the test fake in src/testing/fake-weather.ts (no provider is called).
 */
import { describe, expect, it } from "vitest";
import { DailySettings, WeatherSnapshot } from "@garderobe/contracts/ext/daily";
import type { DayConditions, WeatherLocation } from "@garderobe/contracts/ext/daily";
import { buildWeatherSnapshot, localTimeOf, materialChange } from "../src/weather/assess.ts";
import { FakeGeocoder, FakeWeatherProvider, syntheticForecast } from "../src/testing/fake-weather.ts";
import type { SyntheticHoursSpec } from "../src/testing/fake-weather.ts";
import type { ProviderForecast } from "../src/ports.ts";

const settings = DailySettings.parse({});
const LONDON: WeatherLocation = { label: "London, United Kingdom", latitude: 51.50853, longitude: -0.12574, timezone: "Europe/London" };
const DATE = "2026-10-01";
/** 07:40 local (06:40 UTC): the morning refresh. */
const NOW = Date.UTC(2026, 9, 1, 6, 40, 0);

/** Cold start, warm afternoon: 11.6 C at 08:00 rising to 19 C at 15:00. */
const COLD_START_WARM_AFTERNOON = { 0: 9, 6: 10.5, 8: 11.6, 15: 19, 19: 16, 23: 12 };

function londonForecast(spec: SyntheticHoursSpec, fetchedAtMs = NOW - 10 * 60_000): ProviderForecast {
  return syntheticForecast({ localDate: DATE, timezone: LONDON.timezone, fetchedAtMs, ...spec });
}

function snapshot(forecast: ProviderForecast | null, overrides: Partial<Parameters<typeof buildWeatherSnapshot>[0]> = {}): WeatherSnapshot {
  const built = buildWeatherSnapshot({ snapshotId: "wx_test", localDate: DATE, location: LONDON, forecast, settings, segment: "day", nowMs: NOW, maxAgeMinutes: 60, ...overrides });
  // Every snapshot must satisfy the published contract.
  expect(WeatherSnapshot.parse(built)).toEqual(built);
  return built;
}

function windowOf(s: WeatherSnapshot, name: WeatherSnapshot["windows"][number]["name"]) {
  return s.windows.find((w) => w.name === name)!;
}

describe("cold departure with a warm afternoon", () => {
  it("takes the peak from the daytime interval and the departure basis from the departure hour", () => {
    const s = snapshot(londonForecast({ temperatureByHour: COLD_START_WARM_AFTERNOON }));
    expect(s.freshness).toBe("fresh");
    expect(s.ageMinutes).toBe(10);
    expect(s.limitation).toBeNull();
    expect(s.conditions.peakC).toBe(19);
    expect(s.conditions.peakInterval).toBe("08:00-19:00 Europe/London");
    expect(s.conditions.departureC).toBe(11.6);
    expect(s.conditions.departureInterval).toBe("08:00-09:00 Europe/London");
    expect(s.conditions.eveningReturnC).toBe(15); // 17:00-20:00: 17.5, 16.8 (18:00), 16, 15
    expect(s.conditions.segment).toBe("day");
    expect(s.conditions.snapshotId).toBe("wx_test");
    expect(s.conditions.rainLikelyFromHour).toBeNull();
    expect(s.line).toBe("12 °C leaving, 19 °C later.");
    expect(s.hours).toHaveLength(24);
    expect(s.coversFrom).toBe("2026-09-30T23:00:00Z");
    expect(s.coversTo).toBe("2026-10-01T23:00:00Z");
  });

  it("adds the rain clause in the brief's form when rain becomes likely at 16:00", () => {
    const s = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 12, 15: 18, 23: 12 }, rainProbabilityByHour: (h) => (h >= 16 ? 70 : 10) }));
    expect(s.conditions.rainLikelyFromHour).toBe(16);
    expect(s.line).toBe("12 °C leaving, 18 °C later; rain after 4.");
  });

  it("records apparent temperature in the windows but never uses it as a basis", () => {
    const forecast = londonForecast({ temperatureByHour: COLD_START_WARM_AFTERNOON });
    for (const hour of forecast.hours) hour.apparentTemperatureC = hour.temperatureC! - 6;
    const s = snapshot(forecast);
    expect(windowOf(s, "daytime").apparentMaxC).toBe(13);
    expect(windowOf(s, "departure").apparentMinC).toBe(5.6);
    expect(s.conditions.peakC).toBe(19);
    expect(s.conditions.departureC).toBe(11.6);
    expect(s.line).toBe("12 °C leaving, 19 °C later.");
  });

  it("builds the four named windows from the settings", () => {
    const s = snapshot(londonForecast({ temperatureByHour: COLD_START_WARM_AFTERNOON }));
    expect(s.windows.map((w) => [w.name, w.fromLocalTime, w.toLocalTime, w.coveredHours])).toEqual([
      ["departure", "08:00", "09:00", 1],
      ["daytime", "08:00", "19:00", 12],
      ["evening_return", "17:00", "20:00", 4],
      ["evening", "18:00", "23:00", 6],
    ]);
    expect(windowOf(s, "daytime")).toMatchObject({ minC: 11.6, maxC: 19 });
    expect(windowOf(s, "departure")).toMatchObject({ minC: 11.6, maxC: 11.6 });
  });
});

describe("rain: probability and amount are kept distinct", () => {
  it("heavy rain during a short commute shows as a large amount in the departure window", () => {
    const s = snapshot(londonForecast({ temperatureByHour: () => 13, rainProbabilityByHour: (h) => (h === 8 ? 90 : 5), rainMmByHour: (h) => (h === 8 ? 6 : 0) }));
    expect(windowOf(s, "departure")).toMatchObject({ maxPrecipitationProbabilityPct: 90, precipitationMm: 6 });
    expect(s.conditions.maxPrecipitationProbabilityPct).toBe(90);
    expect(s.conditions.precipitationMm).toBe(6);
    expect(s.conditions.rainLikelyFromHour).toBe(8);
    expect(s.line).toBe("13 °C leaving, 13 °C later; rain from the start.");
  });

  it("a high probability of very little rain keeps its small amount", () => {
    const s = snapshot(londonForecast({ temperatureByHour: () => 13, rainProbabilityByHour: () => 90, rainMmByHour: (h) => (h === 10 || h === 14 ? 0.1 : 0) }));
    expect(s.conditions.maxPrecipitationProbabilityPct).toBe(90);
    expect(s.conditions.precipitationMm).toBe(0.2);
    expect(windowOf(s, "departure")).toMatchObject({ maxPrecipitationProbabilityPct: 90, precipitationMm: 0 });
  });

  it("a likely-dry day with a wet evening does not put rain into the daytime basis", () => {
    const s = snapshot(londonForecast({ temperatureByHour: () => 13, rainProbabilityByHour: (h) => (h >= 21 ? 80 : 20), rainMmByHour: (h) => (h >= 21 ? 3 : 0) }));
    expect(s.conditions.rainLikelyFromHour).toBeNull();
    expect(s.conditions.precipitationMm).toBe(0);
    expect(windowOf(s, "evening")).toMatchObject({ maxPrecipitationProbabilityPct: 80, precipitationMm: 9 });
    expect(s.line).toBe("13 °C leaving, 13 °C later.");
  });

  it("sums only the supplied amounts and never counts a null hour as zero", () => {
    const forecast = londonForecast({ temperatureByHour: () => 13, rainMmByHour: (h) => (h === 9 ? 1.5 : 0) });
    for (const hour of forecast.hours) if (hour.localTime.endsWith("T09:00") === false) hour.precipitationMm = null;
    expect(snapshot(forecast).conditions.precipitationMm).toBe(1.5);
  });
});

describe("strong wind", () => {
  it("adds a gust clause at 50 km/h and above", () => {
    const s = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 12, 15: 18, 23: 12 }, gustByHour: (h) => (h === 13 ? 62 : 20) }));
    expect(s.conditions.maxWindGustKmh).toBe(62);
    expect(s.line).toBe("12 °C leaving, 18 °C later; gusts to 62 km/h.");
  });

  it("combines rain and gust clauses, and stays silent below 50 km/h", () => {
    const windyWet = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 12, 15: 18, 23: 12 }, rainProbabilityByHour: (h) => (h >= 16 ? 70 : 10), gustByHour: () => 50 }));
    expect(windyWet.line).toBe("12 °C leaving, 18 °C later; rain after 4; gusts to 50 km/h.");
    const breezy = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 12, 15: 18, 23: 12 }, gustByHour: () => 49 }));
    expect(breezy.line).toBe("12 °C leaving, 18 °C later.");
  });
});

describe("evening-only outfit", () => {
  it("uses the maximum of the evening interval, not the afternoon peak", () => {
    const forecast = londonForecast({ temperatureByHour: { 0: 10, 8: 13, 14: 24, 18: 17, 23: 12 } });
    const evening = snapshot(forecast, { segment: "evening" });
    expect(evening.conditions.segment).toBe("evening");
    expect(evening.conditions.peakC).toBe(17);
    expect(evening.conditions.peakInterval).toBe("18:00-23:00 Europe/London");
    expect(evening.conditions.departureC).toBe(17);
    expect(evening.conditions.departureInterval).toBe("18:00-19:00 Europe/London");
    expect(evening.line).toBe("17 °C leaving, 17 °C later.");
    // The same forecast for a day outfit keeps the afternoon peak.
    expect(snapshot(forecast).conditions.peakC).toBe(24);
  });
});

describe("travel across timezones", () => {
  it("assigns a Tokyo forecast's hours to the right local date", async () => {
    const tokyo = (await new FakeGeocoder().geocode("Tokyo"))!;
    expect(tokyo.timezone).toBe("Asia/Tokyo");
    const provider = new FakeWeatherProvider({ now: () => NOW });
    provider.setForecast("2026-09-30", { temperatureByHour: () => 30 });
    provider.setForecast(DATE, { temperatureByHour: { 0: 17, 8: 19, 14: 23, 23: 18 } });
    provider.setForecast("2026-10-02", { temperatureByHour: () => 5 });
    const forecast = await provider.forecast({ latitude: tokyo.latitude, longitude: tokyo.longitude, timezone: tokyo.timezone, startDate: "2026-09-30", endDate: "2026-10-02" });
    expect(forecast.hours).toHaveLength(72);

    const s = snapshot(forecast, { location: tokyo });
    expect(s.hours).toHaveLength(24);
    expect(s.hours[0]).toMatchObject({ localTime: "2026-10-01T00:00", at: "2026-09-30T15:00:00Z" }); // UTC+9
    expect(s.hours[23]).toMatchObject({ localTime: "2026-10-01T23:00", at: "2026-10-01T14:00:00Z" });
    expect(s.coversFrom).toBe("2026-09-30T15:00:00Z");
    expect(s.coversTo).toBe("2026-10-01T15:00:00Z");
    // Neither the 30 C of the previous local day nor the 5 C of the next one leaks in.
    expect(s.conditions.peakC).toBe(23);
    expect(s.conditions.departureC).toBe(19);
    expect(s.conditions.peakInterval).toBe("08:00-19:00 Asia/Tokyo");
    expect(windowOf(s, "daytime").minC).toBe(19);

    // The instant that is 08:00 in Tokyo is still the previous evening in London.
    const eightInTokyo = Date.parse(s.hours[8]!.at);
    expect(localTimeOf(eightInTokyo, "Asia/Tokyo")).toBe("2026-10-01T08:00");
    expect(localTimeOf(eightInTokyo, "Europe/London")).toBe("2026-10-01T00:00");
  });
});

describe("stale forecast", () => {
  it("is marked stale with its age in the line, keeping its values", () => {
    const s = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 12, 15: 18, 23: 12 }, rainProbabilityByHour: (h) => (h >= 16 ? 70 : 10) }, NOW - 190 * 60_000));
    expect(s.freshness).toBe("stale");
    expect(s.conditions.freshness).toBe("stale");
    expect(s.ageMinutes).toBe(190);
    expect(s.line).toBe("12 °C leaving, 18 °C later; rain after 4. (forecast 3 h old)");
    expect(s.limitation).toContain("3 h old");
    expect(s.conditions.peakC).toBe(18);
  });

  it("is fresh at exactly the limit and stale just beyond it; a caller's limitation is kept", () => {
    const spec = { temperatureByHour: () => 12 };
    expect(snapshot(londonForecast(spec, NOW - 60 * 60_000)).freshness).toBe("fresh");
    const stale = snapshot(londonForecast(spec, NOW - 61 * 60_000), { limitation: "Provider returned HTTP 503; reusing the 06:39 forecast." });
    expect(stale.freshness).toBe("stale");
    expect(stale.line).toBe("12 °C leaving, 12 °C later. (forecast 1 h old)");
    expect(stale.limitation).toBe("Provider returned HTTP 503; reusing the 06:39 forecast.");
    expect(snapshot(londonForecast(spec, NOW - 45 * 60_000), { maxAgeMinutes: 30 }).line).toBe("12 °C leaving, 12 °C later. (forecast 45 min old)");
  });
});

describe("no usable forecast", () => {
  const NUMERIC_CONDITIONS = ["peakC", "departureC", "eveningReturnC", "maxPrecipitationProbabilityPct", "precipitationMm", "rainLikelyFromHour", "maxWindGustKmh"] as const;

  it("a null forecast is unavailable with every numeric condition null and no dry, warm or calm wording", () => {
    const s = snapshot(null);
    expect(s.freshness).toBe("unavailable");
    expect(s.conditions.freshness).toBe("unavailable");
    for (const field of NUMERIC_CONDITIONS) expect(s.conditions[field]).toBeNull();
    expect(s.line).toBe("Weather unavailable");
    expect(s.limitation).toBeTruthy();
    expect(`${s.line} ${s.limitation}`).not.toMatch(/\b(dry|warm|calm|mild|clear|sunny|fine|\d+ ?°C)\b/i);
    expect(s.ageMinutes).toBeNull();
    expect(s.hours).toEqual([]);
    expect(s.alerts).toBeNull();
    expect(s.coversFrom).toBeNull();
    expect(s.missingFields).toEqual(["forecast"]);
    expect(s.provider).toBe("open-meteo");
    for (const w of s.windows) expect(w).toMatchObject({ coveredHours: 0, minC: null, maxC: null, maxPrecipitationProbabilityPct: null, precipitationMm: null, maxWindGustKmh: null });
  });

  it("keeps the caller's explanation of the outage", () => {
    const s = snapshot(null, { limitation: "Open-Meteo forecast: HTTP 503 and no earlier forecast covers today." });
    expect(s.limitation).toBe("Open-Meteo forecast: HTTP 503 and no earlier forecast covers today.");
    expect(s.line).toBe("Weather unavailable");
  });

  it("a forecast that does not cover the wearing interval is unavailable, with its age still reported", () => {
    const otherDay = syntheticForecast({ localDate: "2026-09-29", timezone: LONDON.timezone, fetchedAtMs: NOW - 5 * 60_000, temperatureByHour: () => 25 });
    const s = snapshot(otherDay);
    expect(s.freshness).toBe("unavailable");
    expect(s.ageMinutes).toBe(5);
    expect(s.hours).toEqual([]);
    for (const field of NUMERIC_CONDITIONS) expect(s.conditions[field]).toBeNull();
    expect(s.line).toBe("Weather unavailable");
    expect(s.limitation).toContain("does not cover");

    // Only the small hours are covered: the daytime interval is not.
    const nightOnly = londonForecast({ temperatureByHour: () => 8 });
    nightOnly.hours = nightOnly.hours.slice(0, 6);
    expect(snapshot(nightOnly).freshness).toBe("unavailable");
  });
});

describe("missing provider fields", () => {
  it("reports a field that is null for every hour and yields null, not zero", () => {
    const s = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 12, 15: 18, 23: 12 }, rainProbabilityByHour: (h) => (h >= 16 ? 70 : 10), gustByHour: () => 80, nullFields: ["precipitationMm", "windGustKmh"] }));
    expect(s.freshness).toBe("fresh");
    expect(s.missingFields).toEqual(["issuedAt", "alerts", "precipitationMm", "windGustKmh"]);
    expect(s.conditions.precipitationMm).toBeNull();
    expect(s.conditions.maxWindGustKmh).toBeNull();
    expect(windowOf(s, "daytime")).toMatchObject({ precipitationMm: null, maxWindGustKmh: null, maxPrecipitationProbabilityPct: 70 });
    // The probability is still known; nothing is said about gusts.
    expect(s.line).toBe("12 °C leaving, 18 °C later; rain after 4.");
  });

  it("omits clauses whose data is missing instead of implying no rain", () => {
    const s = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 12, 15: 18, 23: 12 }, nullFields: ["precipitationProbabilityPct", "temperatureC"] }));
    expect(s.missingFields).toContain("temperatureC");
    expect(s.missingFields).toContain("precipitationProbabilityPct");
    expect(s.conditions.peakC).toBeNull();
    expect(s.conditions.departureC).toBeNull();
    expect(s.conditions.rainLikelyFromHour).toBeNull();
    expect(s.conditions.maxPrecipitationProbabilityPct).toBeNull();
    expect(s.line).toBe("Temperature unknown.");
    // Wind was supplied and is below the threshold, so it is simply not mentioned.
    expect(s.conditions.maxWindGustKmh).toBe(10);
  });
});

describe("materialChange", () => {
  const base: DayConditions = {
    freshness: "fresh",
    snapshotId: "wx_a",
    peakC: 20,
    peakInterval: "08:00-19:00 Europe/London",
    departureC: 10,
    departureInterval: "08:00-09:00 Europe/London",
    eveningReturnC: 15,
    maxPrecipitationProbabilityPct: 20,
    precipitationMm: 0,
    rainLikelyFromHour: null,
    maxWindGustKmh: 20,
    segment: "day",
  };
  const change = (before: Partial<DayConditions>, after: Partial<DayConditions>) => materialChange({ ...base, ...before }, { ...base, ...after });

  it("is not material when nothing relevant moved", () => {
    expect(materialChange(base, { ...base, snapshotId: "wx_b", eveningReturnC: 9, precipitationMm: 4 })).toEqual({ material: false, reasons: [] });
  });

  it("flags a peak or departure move of 3 C or more, in either direction", () => {
    expect(change({ peakC: 20 }, { peakC: 22.9 }).material).toBe(false);
    expect(change({ peakC: 20 }, { peakC: 23 }).material).toBe(true);
    expect(change({ peakC: 23 }, { peakC: 20 }).material).toBe(true);
    expect(change({ departureC: 10 }, { departureC: 12.9 }).material).toBe(false);
    expect(change({ departureC: 10 }, { departureC: 13 })).toEqual({ material: true, reasons: [expect.stringContaining("departure temperature moved +3 C")] });
    expect(change({ departureC: 10 }, { departureC: 7 }).material).toBe(true);
  });

  it("flags crossing the inclusive 14-16 C band, with 14.0 and 16.0 inside it", () => {
    expect(change({ departureC: 13.9 }, { departureC: 14.0 })).toEqual({ material: true, reasons: [expect.stringContaining("departure temperature entered the 14-16 C band")] });
    expect(change({ departureC: 14.0 }, { departureC: 13.9 })).toEqual({ material: true, reasons: [expect.stringContaining("departure temperature left the 14-16 C band")] });
    expect(change({ departureC: 14.0 }, { departureC: 16.0 }).material).toBe(false);
    expect(change({ departureC: 16.0 }, { departureC: 14.0 }).material).toBe(false);
    expect(change({ departureC: 16.0 }, { departureC: 16.1 }).material).toBe(true);
    expect(change({ departureC: 16.1 }, { departureC: 16.0 }).material).toBe(true);
    expect(change({ departureC: 16.1 }, { departureC: 17.9 }).material).toBe(false);
    expect(change({ departureC: 12 }, { departureC: 13.9 }).material).toBe(false);
    // The peak is checked against the same band.
    expect(change({ peakC: 17 }, { peakC: 16.0 })).toEqual({ material: true, reasons: [expect.stringContaining("peak temperature entered the 14-16 C band")] });
    expect(change({ peakC: 17 }, { peakC: 16.1 }).material).toBe(false);
  });

  it("flags rain probability crossing 50 % and gusts crossing 50 km/h", () => {
    expect(change({ maxPrecipitationProbabilityPct: 49 }, { maxPrecipitationProbabilityPct: 50 }).material).toBe(true);
    expect(change({ maxPrecipitationProbabilityPct: 50 }, { maxPrecipitationProbabilityPct: 49 }).material).toBe(true);
    expect(change({ maxPrecipitationProbabilityPct: 50 }, { maxPrecipitationProbabilityPct: 95 }).material).toBe(false);
    expect(change({ maxPrecipitationProbabilityPct: 5 }, { maxPrecipitationProbabilityPct: 49 }).material).toBe(false);
    expect(change({ maxWindGustKmh: 49 }, { maxWindGustKmh: 50 }).material).toBe(true);
    expect(change({ maxWindGustKmh: 50 }, { maxWindGustKmh: 49.9 }).material).toBe(true);
    expect(change({ maxWindGustKmh: 50 }, { maxWindGustKmh: 70 }).material).toBe(false);
  });

  it("flags a change to or from unavailable, but not fresh to stale", () => {
    const unavailable: DayConditions = { ...base, freshness: "unavailable", peakC: null, departureC: null, eveningReturnC: null, maxPrecipitationProbabilityPct: null, precipitationMm: null, maxWindGustKmh: null, peakInterval: null, departureInterval: null };
    expect(materialChange(base, unavailable)).toEqual({ material: true, reasons: ["weather became unavailable"] });
    expect(materialChange(unavailable, base)).toEqual({ material: true, reasons: ["weather became available"] });
    expect(materialChange(unavailable, unavailable).material).toBe(false);
    expect(change({}, { freshness: "stale" }).material).toBe(false);
  });

  it("treats a temperature basis that becomes unknown as a change", () => {
    expect(change({ departureC: 10 }, { departureC: null })).toEqual({ material: true, reasons: ["departure temperature is no longer known"] });
  });

  it("agrees with two snapshots built from real assessments", () => {
    const morning = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 12, 15: 17, 23: 12 } }));
    const revised = snapshot(londonForecast({ temperatureByHour: { 0: 9, 8: 14.5, 15: 17.5, 23: 12 } }));
    const result = materialChange(morning.conditions, revised.conditions);
    expect(result.material).toBe(true);
    expect(result.reasons).toEqual([expect.stringContaining("departure temperature entered the 14-16 C band")]);
    expect(materialChange(morning.conditions, snapshot(null).conditions).reasons).toEqual(["weather became unavailable"]);
  });
});
