/**
 * The weather service around the adapter: the shared cache without user identifiers, per-owner
 * snapshots, city-level location, and the typed skill tools. Real D1; the provider and geocoder are
 * the labelled fakes behind the weather port (the real Open-Meteo adapter is exercised against a
 * recorded live response in weather-open-meteo.test.ts and by scripts/verify-open-meteo.ts).
 */
import { describe, expect, it } from "vitest";
import { all } from "@garderobe/domain";
import { fetchWeatherSnapshot, WEATHER_SKILL, WEATHER_TOOLS, weatherForecast } from "../src/index.ts";
import { createDailyHarness, MILD_DAY, system, TEST_DAILY_SETTINGS } from "./helpers.ts";

describe("weather service", () => {
  it("two owners in the same city share one cached provider call; the cache holds no user identifier and each owner keeps a private snapshot", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const a = await h.createSyntheticOwner({ settings: TEST_DAILY_SETTINGS as never });
    const b = await h.createSyntheticOwner({ settings: TEST_DAILY_SETTINGS as never });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const first = await fetchWeatherSnapshot(h.deps, await system(h, a), { localDate: "2026-09-16", purpose: "evening_compose" });
    h.clock.advanceMinutes(20);
    const second = await fetchWeatherSnapshot(h.deps, await system(h, b), { localDate: "2026-09-16", purpose: "evening_compose" });
    expect(h.weather.calls).toHaveLength(1);
    // The provider saw a city-level location, not a precise one.
    expect(h.weather.calls[0]).toMatchObject({ latitude: 51.5, longitude: -0.1 });
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.ageMinutes).toBe(20);
    expect(second.freshness).toBe("fresh");

    const cache = await all<Record<string, unknown>>(h.db, "SELECT * FROM weather_cache");
    expect(cache).toHaveLength(1);
    expect(cache[0]!.cache_key).toBe("open-meteo|51.5|-0.1|2026-09-16");
    expect(JSON.stringify(cache[0])).not.toContain(a.userId);
    expect(JSON.stringify(cache[0])).not.toContain(b.userId);
    expect(Object.keys(cache[0]!)).not.toContain("user_id");
    const snapshots = await all<{ user_id: string; snapshot_id: string }>(h.db, "SELECT user_id, snapshot_id FROM weather_snapshots WHERE user_id IN (?, ?)", a.userId, b.userId);
    expect(snapshots.map((s) => s.user_id).sort()).toEqual([a.userId, b.userId].sort());
    expect(new Set(snapshots.map((s) => s.snapshot_id)).size).toBe(2);

    // Past the one-hour freshness target the provider is asked again.
    h.clock.advanceMinutes(45);
    await fetchWeatherSnapshot(h.deps, await system(h, a), { localDate: "2026-09-16", purpose: "morning_refresh" });
    expect(h.weather.calls).toHaveLength(2);
  });

  it("a city name alone is enough; an unresolvable place or a missing home city yields an unavailable snapshot with the reason, never a guess", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const cityOnly = await h.createSyntheticOwner({ settings: { homeLocation: { label: "London" } } as never });
    const ok = await weatherForecast(h.deps, cityOnly.principal(), { localDate: "2026-09-16" }, { nowMs: h.clock.now() });
    expect(ok.freshness).toBe("fresh");
    expect(ok.location).toMatchObject({ label: "London", timezone: "Europe/London" });
    expect(h.geocoder.calls).toEqual(["London"]);
    expect(ok.line).toBe("12 °C leaving, 19 °C later.");
    expect(ok.missingFields).toEqual(expect.arrayContaining(["issuedAt", "alerts"]));
    expect(ok.issuedAt).toBeNull();
    expect(ok.attribution).toBeTruthy();

    const unknown = await weatherForecast(h.deps, cityOnly.principal(), { localDate: "2026-09-16", location: { label: "Atlantis" } }, { nowMs: h.clock.now() });
    expect(unknown.freshness).toBe("unavailable");
    expect(unknown.limitation).toMatch(/Atlantis.*could not be resolved/);
    expect(unknown.conditions).toMatchObject({ peakC: null, departureC: null });

    const homeless = await h.createSyntheticOwner();
    const none = await weatherForecast(h.deps, homeless.principal(), { localDate: "2026-09-16" }, { nowMs: h.clock.now() });
    expect(none.freshness).toBe("unavailable");
    expect(none.limitation).toBe("No home city is set, so no forecast was requested.");
  });

  it("an evening-only request uses the evening maximum, not the afternoon peak, and records the interval", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await h.createSyntheticOwner({ settings: TEST_DAILY_SETTINGS as never });
    h.weather.setForecast("2026-09-16", { temperatureByHour: { 0: 10, 8: 12, 14: 24, 18: 17, 21: 13, 23: 11 } });
    const day = await weatherForecast(h.deps, owner.principal(), { localDate: "2026-09-16" }, { nowMs: h.clock.now() });
    const evening = await weatherForecast(h.deps, owner.principal(), { localDate: "2026-09-16", segment: "evening" }, { nowMs: h.clock.now() });
    expect(day.conditions.peakC).toBe(24);
    expect(evening.conditions.peakC).toBe(17);
    expect(evening.conditions.peakInterval).toBe("18:00-23:00 Europe/London");
    expect(evening.conditions.segment).toBe("evening");
  });

  it("publishes the versioned skill with its two typed tools", () => {
    expect(WEATHER_SKILL.name).toBe("weather-for-outfits");
    expect(WEATHER_SKILL.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(WEATHER_TOOLS)).toEqual(["weather.forecast", "weather.compare_locations"]);
    expect(WEATHER_TOOLS["weather.forecast"].input.safeParse({ localDate: "16 Sept" }).success).toBe(false);
    expect(WEATHER_TOOLS["weather.compare_locations"].input.safeParse({ localDate: "2026-09-16", locations: [{ label: "London" }] }).success).toBe(false);
  });
});
