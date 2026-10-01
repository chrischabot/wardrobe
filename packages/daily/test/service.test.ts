/**
 * The evening-to-morning service: local schedules evaluated from UTC, one run per owner, local day and
 * phase, truthful weather and calendar outages that recover on the next phase, and pause/resume.
 * Real command service and real local D1 with the real owner's data. Labelled fakes stand in only for
 * the weather HTTP service and the Google Calendar HTTP service; no model is configured at all, so
 * every board here is prepared with the phone offline and no assistant connected.
 */
import { describe, expect, it } from "vitest";
import { all, first, getAvailability } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { CalendarApiError, getBoard, getPauseState, getToday, phaseSchedule, recommend, resumeService, runDueJobs, runOwnerPhase } from "../src/index.ts";
import { createDailyHarness, garmentsByName, MILD_DAY, OUTFIT_CALENDAR, realOwner, SCHEDULED, WARM_DAY, type DailyHarness } from "./helpers.ts";

const DEFAULTS = { eveningComposeLocalTime: "21:00", morningRefreshLeadMinutes: 20, morningPublishLeadMinutes: 10 };

async function setup(startAt = "2026-09-15T19:00:00Z"): Promise<{ h: DailyHarness; owner: TestOwner }> {
  const h = await createDailyHarness({ startAt, isolate: true });
  const owner = await realOwner(h);
  for (let d = 14; d <= 30; d++) h.weather.setForecast(`2026-09-${d}`, MILD_DAY);
  return { h, owner };
}

const runsFor = (h: DailyHarness, owner: TestOwner, localDate?: string) =>
  all<{ local_date: string; phase: string; status: string; attempts: number; detail_json: string }>(h.db, `SELECT local_date, phase, status, attempts, detail_json FROM day_runs WHERE user_id = ? ${localDate ? "AND local_date = ?" : ""} ORDER BY due_at, phase`, ...(localDate ? [owner.userId, localDate] : [owner.userId]));
const publishCount = async (h: DailyHarness, owner: TestOwner) => (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'board.publish'", owner.userId))!.n;

describe("the scheduled sequence", () => {
  it("composes at 9 PM, refreshes at 6:40, publishes and verifies Calendar at 6:50, and presents at 7 with no inference and no duplicate runs", async () => {
    const { h, owner } = await setup();
    // 8:55 PM London: nothing is due yet.
    h.clock.set("2026-09-15T19:55:00Z");
    expect((await runDueJobs(h.deps)).runs.filter((r) => r.localDate === "2026-09-16")).toEqual([]);

    h.clock.set("2026-09-15T20:00:00Z"); // 9 PM
    const evening = await runDueJobs(h.deps);
    expect(evening.runs).toContainEqual(expect.objectContaining({ userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", status: "succeeded" }));
    const composed = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(composed.options).toHaveLength(5);
    expect(composed.reason).toBe("compose");
    // The projection was delivered by the same sweep, before sleep.
    expect(composed.calendarProjection).toMatchObject({ state: "projected", projectedRevision: 1 });

    // The sweep runs every five minutes; nothing is repeated.
    const publishes = await publishCount(h, owner);
    for (const t of ["2026-09-15T20:05:00Z", "2026-09-15T20:10:00Z", "2026-09-15T23:00:00Z"]) {
      h.clock.set(t);
      await runDueJobs(h.deps);
    }
    expect(await publishCount(h, owner)).toBe(publishes);

    h.clock.set("2026-09-16T05:40:00Z"); // 6:40 AM
    const refresh = await runDueJobs(h.deps);
    expect(refresh.runs).toContainEqual(expect.objectContaining({ phase: "morning_refresh", status: "succeeded", detail: expect.objectContaining({ weather: "fresh", calendar: "ok" }) }));
    h.clock.set("2026-09-16T05:50:00Z"); // 6:50 AM
    const publish = await runDueJobs(h.deps);
    expect(publish.runs).toContainEqual(expect.objectContaining({ phase: "morning_publish", status: "succeeded", detail: expect.objectContaining({ boardReady: true, calendar: "projected", calendarVerified: true }) }));
    h.clock.set("2026-09-16T06:00:00Z"); // 7 AM
    const present = await runDueJobs(h.deps);
    expect(present.runs).toContainEqual(expect.objectContaining({ phase: "morning_present", status: "succeeded", detail: expect.objectContaining({ presented: true, reminderQueued: true, inferenceCalls: 0 }) }));

    const today = await getToday(h.db, owner.principal(), { nowMs: h.clock.now() });
    expect(today.board!.options).toHaveLength(5);
    expect(today.board!.freshness.weather).toBe("fresh");
    expect(today.board!.calendarProjection.state).toBe("projected");
    expect(h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).filter((e) => e.description!.includes("Wednesday 16 September"))).toHaveLength(1);

    expect((await runsFor(h, owner, "2026-09-16")).map((r) => [r.phase, r.status, r.attempts])).toEqual([["evening_compose", "succeeded", 1], ["morning_refresh", "succeeded", 1], ["morning_publish", "succeeded", 1], ["morning_present", "succeeded", 1]]);
    // One reminder for the day, however often the sweep runs afterwards.
    h.clock.set("2026-09-16T06:05:00Z");
    await runDueJobs(h.deps);
    const reminders = await all(h.db, "SELECT effect_id FROM effects WHERE user_id = ? AND kind = 'notification.morning_board'", owner.userId);
    expect(reminders).toHaveLength(1);
  });

  it("missed phases are caught up after recovery, in order, and a board that was never composed is composed late rather than skipped", async () => {
    const { h, owner } = await setup();
    // The service was down from the evening until 6:55 AM.
    h.clock.set("2026-09-16T05:55:00Z");
    const sweep = await runDueJobs(h.deps);
    const mine = sweep.runs.filter((r) => r.userId === owner.userId && r.localDate === "2026-09-16");
    expect(mine.map((r) => [r.phase, r.status])).toEqual([["morning_refresh", "succeeded"], ["morning_publish", "succeeded"]]);
    expect(mine[0]!.detail).toMatchObject({ action: "composed_late", offered: 5 });
    expect((await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!.options).toHaveLength(5);
    // The evening phase is past its useful window and is not replayed.
    expect((await runsFor(h, owner, "2026-09-16")).map((r) => r.phase)).not.toContain("evening_compose");
  });

  it("a phase missed by more than the catch-up window is not replayed: no late board and no afternoon reminder", async () => {
    const { h, owner } = await setup();
    h.clock.set("2026-09-16T13:00:00Z"); // 2 PM: the morning of the 16th was missed entirely
    const sweep = await runDueJobs(h.deps);
    expect(sweep.runs.filter((r) => r.userId === owner.userId)).toEqual([]);
    expect(await getBoard(h.db, owner.principal(), { date: "2026-09-16" })).toBeNull();
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM effects WHERE user_id = ?", owner.userId))!.n).toBe(0);
  });

  it("two workers racing for the same phase produce one run and one board revision", async () => {
    const { h, owner } = await setup();
    h.clock.set("2026-09-15T20:00:00Z");
    const input = { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose" as const, nowMs: h.clock.now() };
    const [a, b] = await Promise.all([runOwnerPhase(h.deps, input), runOwnerPhase(h.deps, input)]);
    expect([a.status, b.status].sort()).toEqual(["in_progress", "succeeded"]);
    expect((await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!.revision).toBe(1);
    expect(await publishCount(h, owner)).toBe(1);
    expect((await runOwnerPhase(h.deps, input)).status).toBe("already_done");
  });

  it("a failed phase is retried by a later sweep", async () => {
    const { h, owner } = await setup();
    h.clock.set("2026-09-15T20:00:00Z");
    // The owner's account data is fine; the phase fails because the store is briefly broken for this run.
    const original = h.deps.commands;
    h.deps.commands = { execute: async () => { throw new Error("TEST: transient failure before anything was written"); } } as never;
    const failed = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", nowMs: h.clock.now() });
    expect(failed.status).toBe("failed");
    expect(await getBoard(h.db, owner.principal(), { date: "2026-09-16" })).toBeNull();
    h.deps.commands = original;
    h.clock.set("2026-09-15T20:05:00Z");
    await runDueJobs(h.deps);
    expect((await runsFor(h, owner, "2026-09-16")).map((r) => [r.phase, r.status, r.attempts])).toEqual([["evening_compose", "succeeded", 2]]);
    expect((await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!.options).toHaveLength(5);
  });

  it("local schedules follow the owner's timezone through daylight-saving changes", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    // The Saturday before the clocks go back, and the Sunday they do (Europe/London, 25 October 2026).
    expect(iso(phaseSchedule("2026-10-24", "Europe/London", "07:00", DEFAULTS).morning_present.dueAtMs)).toBe("2026-10-24T06:00:00.000Z");
    const sunday = phaseSchedule("2026-10-25", "Europe/London", "07:00", DEFAULTS);
    expect(iso(sunday.evening_compose.dueAtMs)).toBe("2026-10-24T20:00:00.000Z"); // 9 PM BST the evening before
    expect(iso(sunday.morning_refresh.dueAtMs)).toBe("2026-10-25T06:40:00.000Z"); // 6:40 GMT
    expect(iso(sunday.morning_present.dueAtMs)).toBe("2026-10-25T07:00:00.000Z");
    // Spring forward (28 March 2027): 7 AM is 06:00 UTC again.
    expect(iso(phaseSchedule("2027-03-28", "Europe/London", "07:00", DEFAULTS).morning_present.dueAtMs)).toBe("2027-03-28T06:00:00.000Z");
    expect(iso(phaseSchedule("2027-03-27", "Europe/London", "07:00", DEFAULTS).morning_present.dueAtMs)).toBe("2027-03-27T07:00:00.000Z");
    // An explicit travel override: the same local times in New York.
    expect(iso(phaseSchedule("2026-09-16", "America/New_York", "07:00", DEFAULTS).morning_present.dueAtMs)).toBe("2026-09-16T11:00:00.000Z");
  });

  it("sweeping across the autumn clock change runs each phase exactly once per local day", async () => {
    const { h, owner } = await setup("2026-10-24T17:00:00Z");
    for (const d of ["2026-10-24", "2026-10-25", "2026-10-26"]) h.weather.setForecast(d, { temperatureByHour: { 0: 8, 8: 9, 14: 13, 23: 8 } });
    for (let t = Date.parse("2026-10-24T17:00:00Z"); t <= Date.parse("2026-10-25T09:00:00Z"); t += 20 * 60_000) {
      h.clock.set(new Date(t).toISOString().replace(".000Z", "Z"));
      await runDueJobs(h.deps);
    }
    const runs = await runsFor(h, owner, "2026-10-25");
    expect(runs.map((r) => [r.phase, r.status, r.attempts])).toEqual([["evening_compose", "succeeded", 1], ["morning_refresh", "succeeded", 1], ["morning_publish", "succeeded", 1], ["morning_present", "succeeded", 1]]);
    const event = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).find((e) => e.description!.includes("Sunday 25 October"))!;
    expect(event.time).toMatchObject({ startsAt: "2026-10-25T07:00:00Z" }); // 7 AM GMT, not 6
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND kind = 'notification.morning_board'", owner.userId))!.n).toBe(1);
  });

  it("a disabled account runs nothing", async () => {
    const { h, owner } = await setup();
    await h.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(owner.userId).run();
    h.clock.set("2026-09-15T20:00:00Z");
    const sweep = await runDueJobs(h.deps);
    expect(sweep.runs.filter((r) => r.userId === owner.userId)).toEqual([]);
    await expect(runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "forbidden" });
    expect(await runsFor(h, owner)).toEqual([]);
  });
});

describe("source outages are surfaced truthfully and recover on the next phase", () => {
  it("with the weather provider down and nothing cached the board says the forecast is unavailable, assumes nothing, and the morning phase recovers", async () => {
    const { h, owner } = await setup();
    h.clock.set("2026-09-15T20:00:00Z");
    h.weather.failNext(5);
    const evening = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", nowMs: h.clock.now() });
    expect(evening).toMatchObject({ status: "succeeded", detail: { weather: "unavailable", offered: 5 } });
    const limited = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(limited.validity).toBe("limited");
    expect(limited.freshness.weather).toBe("unavailable");
    expect(limited.weatherLine).toBeNull();
    expect(limited.notice).toBe("The forecast is unavailable, so temperature rules could not be checked.");
    expect(`${limited.dayLine} ${limited.options.map((o) => o.reason).join(" ")}`).not.toMatch(/dry|warm day|mild|°C/i);
    // Unknown temperature: the 14-16 C rule cannot be ruled out, so a jacket only ever sits over a lightweight oxford.
    for (const o of limited.options) {
      if (o.garments.some((g) => g.role === "outer")) expect(o.garments.find((g) => g.role === "top")!.name).toMatch(/^Lightweight oxford/);
    }
    const snapshot = await first<{ freshness: string; snapshot_json: string }>(h.db, "SELECT freshness, snapshot_json FROM weather_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", owner.userId);
    expect(snapshot!.freshness).toBe("unavailable");
    expect(JSON.parse(snapshot!.snapshot_json).conditions).toMatchObject({ peakC: null, departureC: null, maxPrecipitationProbabilityPct: null, maxWindGustKmh: null });

    h.weather.failNext(0);
    h.clock.set("2026-09-16T05:40:00Z");
    const morning = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "morning_refresh", nowMs: h.clock.now() });
    expect(morning).toMatchObject({ status: "succeeded", detail: { weather: "fresh" } });
    const recovered = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(recovered.validity).toBe("current");
    expect(recovered.notice).toBeNull();
    expect(recovered.weatherLine).toBe("12 °C leaving, 19 °C later.");
    expect(recovered.revision).toBeGreaterThan(limited.revision);
  });

  it("a provider failure in the morning reuses the evening forecast with its age visible, then a fresh forecast replaces it", async () => {
    const { h, owner } = await setup();
    h.clock.set("2026-09-15T20:00:00Z");
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", nowMs: h.clock.now() });
    h.clock.set("2026-09-16T05:40:00Z");
    h.weather.failNext(1);
    const morning = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "morning_refresh", nowMs: h.clock.now() });
    expect(morning).toMatchObject({ status: "succeeded", detail: { weather: "stale" } });
    const stale = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(stale.freshness.weather).toBe("stale");
    expect(stale.validity).toBe("limited");
    expect(stale.notice).toMatch(/weather provider could not be reached; using the forecast fetched 9 h 40 min ago|using the forecast fetched/);
    expect(stale.weatherLine).toMatch(/12 °C leaving, 19 °C later.*old/);
    expect(stale.options).toHaveLength(5);

    // The next phase that reads weather gets a fresh forecast.
    h.clock.set("2026-09-16T20:00:00Z");
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-17", phase: "evening_compose", nowMs: h.clock.now() });
    const next = (await getBoard(h.db, owner.principal(), { date: "2026-09-17" }))!;
    expect(next.freshness.weather).toBe("fresh");
    expect(next.validity).toBe("current");
  });

  it("a calendar API error is never read as a free day, and the morning read recovers the day's events", async () => {
    const { h, owner } = await setup();
    h.calendar.seedReadEvents(owner.userId, "primary", [{ eventId: "evt-9", calendarId: "primary", title: "Board review", startsAt: "2026-09-16T13:00:00Z", endsAt: "2026-09-16T14:00:00Z", allDay: false, location: null, attendance: "accepted", cancelled: false }]);
    h.clock.set("2026-09-15T20:00:00Z");
    h.calendar.failNext("listEvents", 1, new CalendarApiError("TEST FAKE: backend error", { status: 500, retryable: true }));
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "evening_compose", nowMs: h.clock.now() });
    const blind = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(blind.freshness.calendar).toBe("error");
    expect(blind.notice).toBe("Calendar could not be read, so the day's events were not considered.");
    expect(blind.dayLine).not.toMatch(/Nothing fixed|commitment/);
    expect(blind.suitabilityLine).toBeNull();
    expect(blind.options).toHaveLength(5);

    h.clock.set("2026-09-16T05:40:00Z");
    await runOwnerPhase(h.deps, { userId: owner.userId, localDate: "2026-09-16", phase: "morning_refresh", nowMs: h.clock.now() });
    const seen = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    expect(seen.freshness.calendar).toBe("ok");
    expect(seen.notice).toBeNull();
    expect(seen.suitabilityLine).toBe("Three options work for “Board review”.");
    expect(seen.dayLine).toMatch(/One commitment, at 14:00\.$/);
  });
});

describe("pause and resume", () => {
  it("pausing stops composition, publication and reminders, removes managed future events, and leaves observations and conversation alone", async () => {
    const { h, owner } = await setup();
    h.clock.set("2026-09-15T20:00:00Z");
    await runDueJobs(h.deps); // board and Calendar event for the 16th exist
    expect(h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).filter((e) => e.status !== "cancelled")).toHaveLength(1);
    const before = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;

    h.clock.set("2026-09-15T21:00:00Z");
    const receipt = await owner.exec("service.pause", { from: "2026-09-16", resumeOn: "2026-09-21" });
    expect(receipt.summary).toMatch(/paused from 2026-09-16 until 2026-09-21/);
    expect(await getPauseState(h.db, owner.principal())).toMatchObject({ from: "2026-09-16", resumeOn: "2026-09-21", status: "active" });
    await runDueJobs(h.deps);
    expect(h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).filter((e) => e.status !== "cancelled")).toHaveLength(0);

    // Every phase inside the interval is skipped; nothing is composed, published or announced.
    const publishes = await publishCount(h, owner);
    for (const t of ["2026-09-16T05:40:00Z", "2026-09-16T05:50:00Z", "2026-09-16T06:00:00Z", "2026-09-16T20:00:00Z", "2026-09-17T06:00:00Z", "2026-09-18T06:00:00Z"]) {
      h.clock.set(t);
      await runDueJobs(h.deps);
    }
    expect(await publishCount(h, owner)).toBe(publishes);
    expect(await getBoard(h.db, owner.principal(), { date: "2026-09-17" })).toBeNull();
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND kind = 'notification.morning_board'", owner.userId))!.n).toBe(0);
    expect(new Set((await runsFor(h, owner)).filter((r) => r.local_date >= "2026-09-16" && r.phase !== "evening_compose").map((r) => r.status))).toEqual(new Set(["skipped_paused"]));
    // A job that was already queued when the pause began cannot publish either: the batch itself refuses.
    const o = before.options[0]!;
    await expect(owner.exec("board.publish", { localDate: "2026-09-17", options: [{ slots: o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })), reason: o.reason }], requestedCount: 1 }, SCHEDULED)).rejects.toMatchObject({ code: "precondition_failed" });
    const today = await getToday(h.db, owner.principal(), { date: "2026-09-17", nowMs: h.clock.now() });
    expect(today.paused).toMatchObject({ resumeOn: "2026-09-21" });
    expect(today.emptyReason).toBe("Recommendations are paused until 2026-09-21.");

    // Observations still commit, and an explicit question still gets an answer.
    const names = await garmentsByName(h, owner);
    const wear = await owner.exec("wear.record", { wearingDate: "2026-09-18", garmentIds: [names.get("Lightweight oxford — gold")!.garment_id] });
    expect(wear.outcome).toBe("committed");
    const asked = await recommend(h.deps, owner.principal(), { clientRequestId: "during-pause", date: "2026-09-19", count: 3, mode: "preview", nowMs: h.clock.now() });
    expect(asked.options).toHaveLength(3);
  });

  it("on the resume date the service resumes itself, applies the elapsed weekly laundry reset, prepares only the next useful board, and replays nothing", async () => {
    const { h, owner } = await setup();
    const names = await garmentsByName(h, owner);
    const shirt = names.get("Lightweight oxford — gold")!.garment_id;
    h.clock.set("2026-09-15T09:00:00Z");
    await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: [shirt] }); // worn before the break, never reported washed
    await owner.exec("service.pause", { from: "2026-09-15", resumeOn: "2026-09-22" });

    for (const t of ["2026-09-16T06:00:00Z", "2026-09-18T06:00:00Z", "2026-09-20T06:00:00Z", "2026-09-20T20:00:00Z"]) {
      h.clock.set(t);
      await runDueJobs(h.deps);
    }
    expect((await all(h.db, "SELECT board_id FROM boards WHERE user_id = ?", owner.userId))).toHaveLength(0);

    h.clock.set("2026-09-22T05:35:00Z"); // the resume date, before the morning
    const sweep = await runDueJobs(h.deps);
    expect(sweep.runs).toContainEqual(expect.objectContaining({ userId: owner.userId, phase: "resume", status: "succeeded", localDate: "2026-09-22" }));
    expect(await getPauseState(h.db, owner.principal())).toBeNull();
    const boards = await all<{ local_date: string }>(h.db, "SELECT local_date FROM boards WHERE user_id = ? ORDER BY local_date", owner.userId);
    expect(boards.map((b) => b.local_date)).toEqual(["2026-09-22"]); // no backlog of old boards
    expect((await getBoard(h.db, owner.principal(), { date: "2026-09-22" }))!.options).toHaveLength(5);

    // The Friday-Sunday cycle that elapsed during the pause was applied once; the shirt is no longer held as dirty.
    const cycles = await all<{ cycle_key: string }>(h.db, "SELECT cycle_key FROM laundry_cycles WHERE user_id = ? AND channel = 'service'", owner.userId);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    const availability = await getAvailability(h.db, owner.principal(), { forDate: "2026-09-23", nowMs: h.clock.now() });
    expect(availability.garments.find((g) => g.garmentId === shirt)!.hardExcluded).toBe(false);
    // The wear recorded before the pause is still in the record.
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", owner.userId, shirt))!.n).toBe(1);

    // The morning proceeds normally, with one reminder: none for the paused days.
    for (const t of ["2026-09-22T05:40:00Z", "2026-09-22T05:50:00Z", "2026-09-22T06:00:00Z"]) {
      h.clock.set(t);
      await runDueJobs(h.deps);
    }
    const reminders = await all<{ target_key: string }>(h.db, "SELECT target_key FROM effects WHERE user_id = ? AND kind = 'notification.morning_board'", owner.userId);
    expect(reminders.map((r) => r.target_key)).toEqual(["morning:home:2026-09-22"]);
    // No status questions were created for the missing week: the only commands are the service's own.
    const types = await all<{ type: string }>(h.db, "SELECT DISTINCT type FROM commands WHERE user_id = ? AND recorded_at >= '2026-09-22'", owner.userId);
    expect(types.map((t) => t.type).sort()).toEqual(["board.present", "board.publish", "calendar.record_snapshot", "laundry.apply_weekly_reset", "service.resume", "weather.record_snapshot"]);
  });

  it("an indefinite pause stays paused until the owner resumes; the service cannot resume it; resuming after midday prepares tomorrow", async () => {
    const { h, owner } = await setup();
    h.clock.set("2026-09-15T09:00:00Z");
    await owner.exec("service.pause", {});
    h.clock.set("2026-09-29T06:00:00Z");
    await runDueJobs(h.deps);
    expect(await getPauseState(h.db, owner.principal())).toMatchObject({ resumeOn: null, status: "active" });
    await expect(owner.exec("service.resume", {}, SCHEDULED)).rejects.toMatchObject({ code: "precondition_failed" });

    h.clock.set("2026-09-29T14:00:00Z"); // 3 PM London
    const resumed = await resumeService(h.deps, owner.principal(), { nowMs: h.clock.now(), clientRequestId: "tap-1" });
    expect(resumed).toMatchObject({ resumed: true, localDate: "2026-09-30" });
    expect(resumed.board!.options).toHaveLength(5);
    expect((await all<{ local_date: string }>(h.db, "SELECT local_date FROM boards WHERE user_id = ?", owner.userId)).map((b) => b.local_date)).toEqual(["2026-09-30"]);
    // Resuming twice is harmless.
    expect((await resumeService(h.deps, owner.principal(), { nowMs: h.clock.now(), clientRequestId: "tap-2" })).resumed).toBe(false);
  });

  it("rejects a pause that starts in the past or resumes before it starts, and undo removes a pause just created", async () => {
    const { h, owner } = await setup();
    h.clock.set("2026-09-15T09:00:00Z");
    await expect(owner.exec("service.pause", { from: "2026-09-10" })).rejects.toMatchObject({ code: "invalid_command" });
    await expect(owner.exec("service.pause", { from: "2026-09-20", resumeOn: "2026-09-20" })).rejects.toMatchObject({ code: "invalid_command" });
    const receipt = await owner.exec("service.pause", { from: "2026-09-20", resumeOn: "2026-09-25" });
    expect(receipt.undo.available).toBe(true);
    await owner.exec("command.undo", { commandId: receipt.commandId });
    expect(await getPauseState(h.db, owner.principal())).toBeNull();
  });
});

void WARM_DAY;
