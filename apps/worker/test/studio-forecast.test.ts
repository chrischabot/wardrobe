import { beforeAll, describe, expect, it } from "vitest";
import { weatherCacheKey } from "@garderobe/daily";
import { createPrincipal, getOwnerState, toInstant, zonedToUtcMs } from "@garderobe/domain";
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
 * exercised by the journey suite. Some cases wrap the daily service's forecast read in a labelled TEST
 * DOUBLE, to count the reads, to make one fail or answer "unavailable", or to move the clock.
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
/** Jacket over a lightweight oxford: valid whatever the temperature, so it can be planned. */
let slots: { role: string; garmentId: string }[];
/** Jacket over a shirt that is not a lightweight oxford: the verdict depends on the temperature when leaving. */
let jacketOverClark: { role: string; garmentId: string }[];

/**
 * What looking at an outfit must leave unchanged: the weather snapshots recorded for the days looked at,
 * and the owner's commands. Board, weather and calendar commands are left out of the command count: an
 * earlier command's background follow-up (topping up boards) may still be recording those for other days.
 */
async function counts(days: string[]): Promise<{ commands: number; snapshots: number }> {
  const app = await testApp();
  const commands = await app.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type NOT LIKE 'board.%' AND type NOT LIKE 'weather.%' AND type NOT LIKE 'calendar.%'").bind(owner.userId).first<{ n: number }>();
  const snapshots = await app.db.prepare("SELECT COUNT(*) AS n FROM weather_snapshots WHERE user_id = ? AND local_date IN (SELECT value FROM json_each(?))").bind(owner.userId, JSON.stringify(days)).first<{ n: number }>();
  return { commands: commands!.n, snapshots: snapshots!.n };
}

/** TEST DATA: a day's forecast (temperature when leaving and in the evening, and the daytime peak) as the Open-Meteo adapter would have cached it just now. */
async function seedForecast(localDate: string, leavingC: number, peakC: number): Promise<void> {
  const app = await testApp();
  const { timezone } = (await getOwnerState(app.db, owner.systemPrincipal)).settings;
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

/** Submit a command as the owner and return its receipt; the test fails with the response when it is refused. */
async function commit(type: string, payload: Record<string, unknown>): Promise<any> {
  const response = await owner.api.command(type, payload);
  const text = await response.text();
  expect(response.status, `${type}: ${text}`).toBe(200);
  const body = JSON.parse(text);
  return body.receipt ?? body;
}

/** Submit a command the service must refuse and return the refusal's text. */
async function refused(type: string, payload: Record<string, unknown>): Promise<string> {
  const response = await owner.api.command(type, payload);
  const text = await response.text();
  expect(response.status, `${type}: ${text}`).toBeGreaterThanOrEqual(400);
  return text;
}

const setHome = async (homeLocation: typeof PLACE | null) => {
  const moved = await owner.api.command("settings.update", { patch: { homeLocation } });
  expect(moved.status, await moved.clone().text()).toBe(200);
};

const reader = (scopes: ("read" | "write")[] = ["read"]) => createPrincipal({ userId: owner.userId, actor: owner.systemPrincipal.actor, channel: owner.systemPrincipal.channel, scopes, authRef: "test:studio-forecast" });
const direct = (forDate: string) => ({ slots: jacketOverClark as never, forDate, mode: "explore" as const });

/*
 * Every test uses days of its own (the forecast cache and the owner's records are keyed by day), seeds
 * what it needs itself and removes what it saved, so the tests can be run alone or in any order.
 */
beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  await setHome(PLACE);
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
});

describe("Studio and the day's forecast", () => {
  it("judges the same outfit by each day's own temperatures when the day has no board, and records nothing for looking", async () => {
    const [bandDay, coolDay] = [await ownerDay(owner, 5), await ownerDay(owner, 6)];
    await seedForecast(bandDay, 15, 20);
    await seedForecast(coolDay, 11, 19);
    const before = await counts([bandDay, coolDay]);

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

    // Reads: no command and no weather snapshot was recorded for the owner.
    expect(await counts([bandDay, coolDay])).toEqual(before);
  });

  it("says the temperature rule is unchecked when no forecast can be had (provider outage, a date the provider does not cover), instead of assuming one", async () => {
    const days = [await ownerDay(owner, 7), await ownerDay(owner, 400)];
    const before = await counts(days);
    for (const day of days) {
      const verdict = await validate(day, jacketOverClark);
      expect(verdict.validator).toBe("daily-service");
      expect(codes(verdict)).toContain(UNVERIFIED);
      expect(codes(verdict)).not.toContain(BAND);
      expect(unchecked(verdict).length).toBeGreaterThan(0);
    }
    expect(await counts(days)).toEqual(before);
  });

  it("plans an outfit for a day through the command service, checked against that day's forecast, and GET /v1/studio checks a plan again against the forecast", async () => {
    const [bandDay, coolDay] = [await ownerDay(owner, 8), await ownerDay(owner, 9)];
    await seedForecast(bandDay, 15, 20);
    await seedForecast(coolDay, 11, 19);
    const snapshotsBefore = (await counts([bandDay, coolDay])).snapshots;
    const planOf = async () => ((await owner.api.json("GET", `/v1/studio?mode=for_today&date=${coolDay}`)).dayPlans as any[]).find((p) => p.localDate === coolDay && p.status === "planned");

    // In the 14-16 C band the jacket over the Clark oxford is refused as a plan; on the cool day the same outfit is accepted.
    expect(await refused("studio.plan_for_day", { localDate: bandDay, slots: jacketOverClark })).toContain("15 °C");
    const planned = await commit("studio.plan_for_day", { localDate: coolDay, slots: jacketOverClark });
    const planId = planned.result.planId as string;
    try {
      const plan = await planOf();
      expect(plan, "the plan is listed").toBeTruthy();
      expect(plan.validation.validator).toBe("daily-service");
      expect(plan.validation.valid).toBe(true);
      expect(unchecked(plan.validation)).toEqual([]);

      // A plan restored by undo is checked again when Studio is read. TEST DATA: by then the day's forecast has moved into the band.
      const removed = await commit("studio.remove_day_plan", { planId });
      await commit("command.undo", { commandId: removed.commandId });
      await seedForecast(coolDay, 15, 20);
      const rechecked = await planOf();
      expect(rechecked, "the restored plan is listed").toBeTruthy();
      expect(rechecked.needsRevalidation).toBe(true);
      // GET /v1/studio itself judged the plan by the forecast it read: 15 C, not "unavailable".
      expect(codes(rechecked.validation)).toContain(BAND);
      expect(codes(rechecked.validation)).not.toContain(UNVERIFIED);
      expect(rechecked.validation.violations.find((v: any) => v.code === BAND).message).toContain("15 °C");
      expect(rechecked.validation.valid).toBe(false);
      // Checking the plan recorded no weather snapshot of its own.
      expect((await counts([bandDay, coolDay])).snapshots).toBe(snapshotsBefore);
    } finally {
      await owner.api.command("studio.remove_day_plan", { planId });
    }
  });

  it("saves a combination to wear on a day only when that day's forecast allows it", async () => {
    const [bandDay, coolDay, outageDay] = [await ownerDay(owner, 10), await ownerDay(owner, 11), await ownerDay(owner, 12)];
    await seedForecast(bandDay, 15, 20);
    await seedForecast(coolDay, 11, 19);
    const snapshotsBefore = (await counts([bandDay, coolDay, outageDay])).snapshots;
    const save = (forDate: string) => ({ name: "TEST: jacket over the Clark oxford", slots: jacketOverClark, mode: "for_today", forDate });

    expect(await refused("studio.save_combination", save(bandDay))).toContain("15 °C");
    // With no forecast to be had the rule cannot be checked, and the refusal says so.
    expect(await refused("studio.save_combination", save(outageDay))).toContain("forecast is unavailable");
    const saved = await commit("studio.save_combination", save(coolDay));
    const combinationId = saved.result.combinationId as string;
    try {
      expect(saved.result.validation.validator).toBe("daily-service");
      expect(saved.result.validation.valid).toBe(true);
      expect(codes(saved.result.validation)).not.toContain(UNVERIFIED);
      expect(unchecked(saved.result.validation)).toEqual([]);
      const listed = ((await owner.api.json("GET", `/v1/studio?mode=for_today&date=${coolDay}`)).combinations as any[]).find((c) => c.combinationId === combinationId);
      expect(listed, "the combination is listed").toBeTruthy();
      expect(unchecked(listed.validation)).toEqual([]);
      expect((await counts([bandDay, coolDay, outageDay])).snapshots).toBe(snapshotsBefore);
    } finally {
      await owner.api.command("studio.remove_combination", { combinationId });
    }
  });

  it("keeps to the forecast recorded for a day that has a board while that record is fresh, and reads nothing", async () => {
    const app = await testApp();
    const boardDay = await ownerDay(owner, 3);
    await seedForecast(boardDay, 15, 20);
    await publishBoard(owner, { date: boardDay });
    const recorded = await app.db.prepare("SELECT freshness FROM weather_snapshots WHERE user_id = ? AND local_date = ? ORDER BY created_at DESC, snapshot_id DESC LIMIT 1").bind(owner.userId, boardDay).first<{ freshness: string }>();
    expect(recorded, "the board recorded its forecast").not.toBeNull();
    expect(recorded!.freshness).not.toBe("unavailable");

    // TEST DATA: the forecast held for that day changes just after the board was prepared.
    await seedForecast(boardDay, 11, 19);
    const before = await counts([boardDay]);
    const verdict = await validate(boardDay, jacketOverClark);
    // Studio judges by the 15 C the board was prepared on, not by the 11 C a fresh read would give.
    expect(codes(verdict)).toContain(BAND);
    expect(verdict.violations.find((v: any) => v.code === BAND).message).toContain("15 °C");
    expect(await counts([boardDay])).toEqual(before);

    // TEST DOUBLE counting the forecast reads around the daily service's real read: a fresh record needs none.
    let reads = 0;
    const counting = createStudioValidator(async () => ({ weather: (p, d) => (reads++, app.daily!.weather(p, d)), now: app.now }));
    await counting.validate(app.db, reader(), direct(boardDay));
    expect(reads).toBe(0);
  });

  it("reads a newer forecast once the day's recorded one is past the owner's freshness setting, and keeps the record when nothing newer can be had", async () => {
    const app = await testApp();
    const boardDay = await ownerDay(owner, 4);
    await seedForecast(boardDay, 15, 20);
    await publishBoard(owner, { date: boardDay });
    // TEST DATA: a newer forecast for the day. TEST CLOCK: Studio is asked two hours later (the freshness setting is one hour).
    await seedForecast(boardDay, 11, 19);
    const before = await counts([boardDay]);
    const twoHoursOn = () => app.now() + 2 * 3_600_000;

    const later = createStudioValidator(async () => ({ weather: app.daily!.weather, now: twoHoursOn }));
    const verdict = await later.validate(app.db, reader(), direct(boardDay));
    expect(verdict.violations.map((v) => v.code)).not.toContain(BAND);
    expect(verdict.violations.map((v) => v.code)).not.toContain(UNVERIFIED);

    // TEST DOUBLE of the forecast read answering "unavailable" (an outage): the board's 15 C record stands.
    const outage = createStudioValidator(async () => ({ weather: async (p, d) => ({ ...(await app.daily!.weather(p, d)), freshness: "unavailable" as const }), now: twoHoursOn }));
    const kept = await outage.validate(app.db, reader(), direct(boardDay));
    expect(kept.violations.find((v) => v.code === BAND)?.message).toContain("15 °C");
    expect(await counts([boardDay])).toEqual(before);
  });

  it("reads a forecast afresh when the recorded one's time cannot be read", async () => {
    const app = await testApp();
    const boardDay = await ownerDay(owner, 17);
    await seedForecast(boardDay, 15, 20);
    await publishBoard(owner, { date: boardDay });
    // TEST DATA: the record's time is damaged, and the forecast held for the day has changed.
    await app.db.prepare("UPDATE weather_snapshots SET fetched_at = 'TEST: not a time' WHERE user_id = ? AND local_date = ?").bind(owner.userId, boardDay).run();
    await seedForecast(boardDay, 11, 19);
    const validator = createStudioValidator(async () => ({ weather: (p, d) => app.daily!.weather(p, d), now: () => app.now() }));
    const verdict = await validator.validate(app.db, reader(), direct(boardDay));
    expect(verdict.violations.map((v) => v.code)).not.toContain(BAND);
    expect(verdict.violations.map((v) => v.code)).not.toContain(UNVERIFIED);
  });

  it("decides once per caller and day, decides again after the reuse time, and reads nothing for a caller who may not read", async () => {
    const app = await testApp();
    const [dayA, dayB] = [await ownerDay(owner, 13), await ownerDay(owner, 14)];
    // TEST DOUBLE of the daily service's forecast read: it counts the reads and answers "unavailable".
    let reads = 0;
    const source = async () => ({ weather: async (p: any, d?: string) => (reads++, { ...(await app.daily!.weather(p, d)), freshness: "unavailable" as const }), now: app.now });
    const validator = createStudioValidator(source);

    const caller = reader();
    const verdict = await validator.validate(app.db, caller, direct(dayA));
    expect(verdict.violations.map((v) => v.code)).toContain(UNVERIFIED);
    expect(reads).toBe(1);
    await validator.validate(app.db, caller, direct(dayA));
    await validator.suggest!(app.db, caller, { locked: [{ role: "top", garmentId: slots[1]!.garmentId }] as never, openRoles: [], forDate: dayA, mode: "explore", limit: 1 });
    expect(reads).toBe(1);
    await validator.validate(app.db, caller, direct(dayB));
    expect(reads).toBe(2);
    // Another caller object (a new request) decides for itself.
    await validator.validate(app.db, reader(), direct(dayA));
    expect(reads).toBe(3);

    // With no reuse time, the same long-lived caller decides again on every check.
    const unkept = createStudioValidator(source, { reuseMs: 0 });
    await unkept.validate(app.db, caller, direct(dayA));
    await unkept.validate(app.db, caller, direct(dayA));
    expect(reads).toBe(5);

    await expect(validator.validate(app.db, reader(["write"]), direct(dayA))).rejects.toMatchObject({ code: "forbidden" });
    expect(reads).toBe(5);
  });

  it("lets a failing forecast read surface as an error rather than as an unchecked rule, and does not keep the failure", async () => {
    const app = await testApp();
    const day = await ownerDay(owner, 15);
    // TEST DOUBLE of the daily service's forecast read: the first read fails as a broken database would.
    let reads = 0;
    const validator = createStudioValidator(async () => ({
      weather: async (p, d) => {
        reads += 1;
        if (reads === 1) throw new Error("TEST: the forecast read failed");
        return app.daily!.weather(p, d);
      },
      now: app.now,
    }));
    const caller = reader();
    await expect(validator.validate(app.db, caller, direct(day))).rejects.toThrow("TEST: the forecast read failed");
    // The same caller asks again and is answered (no forecast is held for that day, so the rule is unchecked).
    const verdict = await validator.validate(app.db, caller, direct(day));
    expect(reads).toBe(2);
    expect(verdict.violations.map((v) => v.code)).toContain(UNVERIFIED);
  });

  it("says the temperature rule is unchecked for an owner with no home location", async () => {
    const day = await ownerDay(owner, 16);
    await seedForecast(day, 15, 20);
    await setHome(null);
    try {
      const before = await counts([day]);
      const verdict = await validate(day, jacketOverClark);
      expect(verdict.validator).toBe("daily-service");
      expect(codes(verdict)).toContain(UNVERIFIED);
      expect(codes(verdict)).not.toContain(BAND);
      expect(await counts([day])).toEqual(before);
    } finally {
      await setHome(PLACE);
    }
  });
});
