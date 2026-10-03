import { beforeAll, describe, expect, it } from "vitest";
import { weatherCacheKey } from "@garderobe/daily";
import { createPrincipal, toInstant, zonedToUtcMs } from "@garderobe/domain";
import { createStudioValidator } from "../src/lanes/studio-validator.ts";
import { ownerDay, provisionOwner, publishBoard, testApp, type TestOwner } from "../src/testing/index.ts";

/*
 * Studio checks an outfit against the day's forecast (journey defect D12-1): for a day nobody has asked
 * a board for, no forecast is recorded, so the Worker reads one for the check and records nothing; a day
 * with a recorded forecast is checked against that record, as the owner's board is.
 *
 * REAL owner fixture (supplied profile and the real inventory). Stand-ins: test-signed Access
 * assertions, and the weather. Outbound network is disabled in this suite (the Open-Meteo request is
 * answered 503), so forecasts are SEEDED into the daily service's shared forecast cache in the provider
 * adapter's shape, under the daily package's own cache key, for a fictional test place; the daily
 * service's real cache read, assessment and validation run on them. The provider request itself is
 * exercised by the journey suite. One case uses a labelled TEST DOUBLE of the daily service's forecast
 * read, to make that read fail and to count it.
 *
 * The verdict that depends on temperature is the owner's 14-16 C rule: a jacket goes over a lightweight
 * oxford only. Drake's jacket over the Clark oxford (not a lightweight oxford) breaks it at 15 C when
 * leaving, is fine at 11 C, and cannot be judged without a forecast.
 */
const PLACE = { label: "Studio forecast (fictional test place)", latitude: 61.3, longitude: 7.1 };
const BAND = "jacket_band_requires_lightweight_oxford";
const UNVERIFIED = "jacket_band_unverified";
const codes = (validation: any): string[] => (validation.violations as any[]).map((v) => v.code as string);
const unchecked = (validation: any): string[] => (validation.violations as any[]).map((v) => v.message as string).filter((m) => /forecast is unavailable/.test(m));

let owner: TestOwner;
let timezone: string;
/** Jacket over a lightweight oxford: valid whatever the temperature, so it can be planned. */
let slots: { role: string; garmentId: string }[];
/** Jacket over a shirt that is not a lightweight oxford: the verdict depends on the temperature when leaving. */
let jacketOverClark: { role: string; garmentId: string }[];
let bandDay: string;
let coolDay: string;
let outageDay: string;
let boardDay: string;

async function counts(): Promise<{ commands: number; snapshots: number }> {
  const app = await testApp();
  const count = async (table: string) => (await app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(owner.userId).first<{ n: number }>())!.n;
  return { commands: await count("commands"), snapshots: await count("weather_snapshots") };
}

/** TEST DATA: a day's forecast (temperature when leaving and in the evening, and the daytime peak) as the Open-Meteo adapter would have cached it just now. */
async function seedForecast(localDate: string, leavingC: number, peakC: number): Promise<void> {
  const app = await testApp();
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const clock = `${String(hour).padStart(2, "0")}:00`;
    const temperatureC = hour >= 10 && hour < 18 ? peakC : leavingC;
    return { localTime: `${localDate}T${clock}`, at: toInstant(zonedToUtcMs(localDate, clock, timezone)), temperatureC, apparentTemperatureC: temperatureC - 1, precipitationProbabilityPct: 0, precipitationMm: 0, precipitationType: "none", windSpeedKmh: 10, windGustKmh: 18, humidityPct: 60 };
  });
  const fetchedAt = toInstant(app.now());
  const forecast = { provider: "open-meteo", attribution: "TEST DATA (seeded forecast, not from Open-Meteo)", timezone, latitude: PLACE.latitude, longitude: PLACE.longitude, fetchedAt, issuedAt: null, hours, alerts: null, missingFields: ["issuedAt", "alerts"] };
  await app.db
    .prepare("INSERT OR REPLACE INTO weather_cache (cache_key, provider, latitude, longitude, timezone, local_date, fetched_at, issued_at, covers_from, covers_to, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(weatherCacheKey("open-meteo", PLACE, localDate), "open-meteo", PLACE.latitude, PLACE.longitude, timezone, localDate, fetchedAt, null, hours[0]!.at, hours[23]!.at, JSON.stringify(forecast))
    .run();
}

const validate = (date: string, outfit: { role: string; garmentId: string }[]) => owner.api.json("POST", "/v1/studio/validate", { mode: "explore", date, slots: outfit });

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  const moved = await owner.api.command("settings.update", { patch: { homeLocation: PLACE } });
  expect(moved.status, await moved.clone().text()).toBe(200);
  const wardrobe = (await owner.api.json("GET", "/v1/wardrobe?limit=200")).items as { garment: { garmentId: string; name: string } }[];
  const idByName = (name: string) => {
    const found = wardrobe.find((w) => w.garment.name === name);
    if (!found) throw new Error(`the real inventory has no garment named ${name}`);
    return found.garment.garmentId;
  };
  const rest = [
    { role: "bottom", garmentId: idByName("Stratton stretch corduroy") },
    { role: "socks", garmentId: idByName("Merino — deep earth brown") },
    { role: "footwear", garmentId: idByName("NB 990v4 — olive/cream") },
  ];
  const jacket = { role: "outer", garmentId: idByName("Drake's Olive Jungle Jacket") };
  slots = [jacket, { role: "top", garmentId: idByName("Pima oxford — navy") }, ...rest];
  jacketOverClark = [jacket, { role: "top", garmentId: idByName("Clark oxford — beige") }, ...rest];
  boardDay = await ownerDay(owner, 3);
  bandDay = await ownerDay(owner, 5);
  coolDay = await ownerDay(owner, 6);
  outageDay = await ownerDay(owner, 7);
  const app = await testApp();
  timezone = JSON.parse((await app.db.prepare("SELECT settings_json FROM owner_settings WHERE user_id = ?").bind(owner.userId).first<{ settings_json: string }>())!.settings_json).timezone as string;
  await seedForecast(bandDay, 15, 20);
  await seedForecast(coolDay, 11, 19);
});

describe("Studio and the day's forecast", () => {
  it("judges the same outfit by each day's own temperatures when the day has no board, and records nothing for looking", async () => {
    const before = await counts();
    expect(before.snapshots).toBe(0);

    const inBand = await validate(bandDay, jacketOverClark);
    expect(inBand.validator).toBe("daily-service");
    expect(codes(inBand)).toContain(BAND);
    expect(codes(inBand)).not.toContain(UNVERIFIED);
    expect(inBand.violations.find((v: any) => v.code === BAND).message).toContain("15 °C");

    const cool = await validate(coolDay, jacketOverClark);
    expect(codes(cool)).not.toContain(BAND);
    expect(codes(cool)).not.toContain(UNVERIFIED);
    expect(unchecked(cool)).toEqual([]);

    const suggestions = (await owner.api.json("POST", "/v1/studio/suggest", { mode: "explore", date: coolDay, slots: [{ ...slots[1], locked: true }] })).suggestions as any[];
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) expect(unchecked(suggestion.validation)).toEqual([]);

    const studio = await owner.api.json("GET", `/v1/studio?mode=for_today&date=${coolDay}`);
    expect(studio.selectors.length).toBeGreaterThan(0);
    expect(studio.opening.length).toBeGreaterThan(0);

    // Reads: no command and no weather snapshot was recorded for the owner.
    expect(await counts()).toEqual(before);
  });

  it("says the temperature rule is unchecked when no forecast can be had (provider outage, a date the provider does not cover), instead of assuming one", async () => {
    const before = await counts();
    for (const day of [outageDay, await ownerDay(owner, 400)]) {
      const verdict = await validate(day, jacketOverClark);
      expect(verdict.validator).toBe("daily-service");
      expect(codes(verdict)).toContain(UNVERIFIED);
      expect(codes(verdict)).not.toContain(BAND);
      expect(unchecked(verdict).length).toBeGreaterThan(0);
    }
    expect(await counts()).toEqual(before);
  });

  it("plans an outfit for a day through the command service, checked against that day's forecast, and Studio shows the plan's verdict", async () => {
    const snapshotsBefore = (await counts()).snapshots;
    // In the 14-16 C band the jacket over the Clark oxford is refused as a plan; on the cool day the same outfit is accepted.
    const refused = await owner.api.command("studio.plan_for_day", { localDate: bandDay, slots: jacketOverClark });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await refused.text()).toContain("15 °C");
    const planned = await owner.api.command("studio.plan_for_day", { localDate: coolDay, slots: jacketOverClark });
    expect(planned.status, await planned.clone().text()).toBe(200);

    const studio = await owner.api.json("GET", `/v1/studio?mode=for_today&date=${coolDay}`);
    const plan = (studio.dayPlans as any[]).find((p) => p.localDate === coolDay);
    expect(plan, "the plan is listed").toBeTruthy();
    expect(plan.validation.validator).toBe("daily-service");
    expect(plan.validation.valid).toBe(true);
    expect(unchecked(plan.validation)).toEqual([]);
    // Checking the plan recorded no weather snapshot of its own.
    expect((await counts()).snapshots).toBe(snapshotsBefore);
  });

  it("keeps to the forecast recorded for a day that has a board, even when a newer forecast could be read", async () => {
    const app = await testApp();
    await seedForecast(boardDay, 15, 20);
    await publishBoard(owner, { date: boardDay });
    const recorded = await app.db.prepare("SELECT freshness FROM weather_snapshots WHERE user_id = ? AND local_date = ? ORDER BY created_at DESC, snapshot_id DESC LIMIT 1").bind(owner.userId, boardDay).first<{ freshness: string }>();
    expect(recorded, "the board recorded its forecast").not.toBeNull();
    expect(recorded!.freshness).not.toBe("unavailable");

    // TEST DATA: the forecast held for that day changes after the board was prepared.
    await seedForecast(boardDay, 11, 19);
    const before = await counts();
    const verdict = await validate(boardDay, jacketOverClark);
    // Studio judges by the 15 C the board was prepared on, not by the 11 C a fresh read would give.
    expect(codes(verdict)).toContain(BAND);
    expect(verdict.violations.find((v: any) => v.code === BAND).message).toContain("15 °C");
    expect(await counts()).toEqual(before);
  });

  it("still answers when the forecast read fails, reads once per caller and day, and reads nothing for a caller who may not read", async () => {
    const app = await testApp();
    const principal = (scopes: ("read" | "write")[]) => createPrincipal({ userId: owner.userId, actor: owner.systemPrincipal.actor, channel: owner.systemPrincipal.channel, scopes, authRef: "test:studio-forecast" });
    // TEST DOUBLE of the daily service's forecast read: it counts the reads and always fails.
    let reads = 0;
    const validator = createStudioValidator(async () => ({
      weather: async () => {
        reads += 1;
        throw new Error("TEST: the forecast read failed");
      },
    }));
    const input = (forDate: string) => ({ slots: jacketOverClark as never, forDate, mode: "explore" as const });

    const reader = principal(["read"]);
    const verdict = await validator.validate(app.db, reader, input(outageDay));
    expect(verdict.violations.map((v) => v.code)).toContain(UNVERIFIED);
    expect(reads).toBe(1);
    await validator.validate(app.db, reader, input(outageDay));
    await validator.suggest!(app.db, reader, { locked: [{ role: "top", garmentId: slots[1]!.garmentId }] as never, openRoles: [], forDate: outageDay, mode: "explore", limit: 1 });
    expect(reads).toBe(1);
    await validator.validate(app.db, reader, input(await ownerDay(owner, 8)));
    expect(reads).toBe(2);
    // A day with a recorded forecast is not read again at all.
    await validator.validate(app.db, reader, input(boardDay));
    expect(reads).toBe(2);

    await expect(validator.validate(app.db, principal(["write"]), input(outageDay))).rejects.toMatchObject({ code: "forbidden" });
    expect(reads).toBe(2);
  });

  it("says the temperature rule is unchecked for an owner with no home location", async () => {
    const cleared = await owner.api.command("settings.update", { patch: { homeLocation: null } });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const before = await counts();
    const verdict = await validate(bandDay, jacketOverClark);
    expect(verdict.validator).toBe("daily-service");
    expect(codes(verdict)).toContain(UNVERIFIED);
    expect(codes(verdict)).not.toContain(BAND);
    expect(await counts()).toEqual(before);
  });
});
