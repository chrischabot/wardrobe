/**
 * Regressions for the reviewed defects of the Calendar projector (findings 1 to 9).
 *
 * The projector, the command service and D1 (the real local D1 harness) are real. The stand-ins are:
 *   - `FakeGoogleCalendar`, the labelled TEST FAKE of the Google Calendar HTTP service behind the adapter
 *     port, in every projector test;
 *   - a scripted TEST FAKE `fetch` in place of Google's HTTP service for the adapter test (finding 8);
 *   - a TEST STAND-IN lease (a plain object in place of the D1 lease) in the unit test of `leasedWriter`.
 * Calendar IDs, descriptions, notes and times below are synthetic. Nothing here shows Google's behaviour.
 */
import { describe, expect, it, vi } from "vitest";
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { first } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { createGoogleCalendar } from "../src/calendar/google.ts";
import { carriesWrite, LeaseTooShortError, leasedWriter, managedBlock, mergeDescription, PROJECTION_LEASE_MS } from "../src/calendar/projector.ts";
import { CalendarApiError, getBoard, managedEventId, projectCalendarEffects, renderBoardCalendarText } from "../src/index.ts";
import type { FetchLike, ManagedEvent, ManagedEventWrite } from "../src/ports.ts";
import { FakeGoogleCalendar } from "../src/testing/fake-calendar.ts";
import { compose, createDailyHarness, MILD_DAY, OUTFIT_CALENDAR, realOwner, type DailyHarness } from "./helpers.ts";

const DAY = "2026-09-16";
/** Synthetic second outfit calendar. */
const NEW_CALENDAR = "outfits-moved@test.calendar";
/** 07:00-07:15 BST on DAY, as the projector writes it for the London test owner. */
const MORNING: ManagedEventWrite["time"] = { kind: "timed", startsAt: "2026-09-16T06:00:00Z", endsAt: "2026-09-16T06:15:00Z", timezone: "Europe/London" };
/** A synthetic time the owner moves the event to in Google. */
const MOVED: ManagedEventWrite["time"] = { kind: "timed", startsAt: "2026-09-16T08:00:00Z", endsAt: "2026-09-16T08:15:00Z", timezone: "Europe/London" };

interface ProjectionRow {
  state: string;
  suppression_reason: string | null;
  projected_revision: number | null;
  managed_text: string | null;
  etag: string | null;
  event_id: string;
  calendar_id: string | null;
  lock_until: string | null;
  lock_token: string | null;
  last_error: string | null;
}

async function setup(): Promise<{ h: DailyHarness; owner: TestOwner }> {
  const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
  const owner = await realOwner(h);
  h.weather.setForecast(DAY, MILD_DAY);
  return { h, owner };
}

const run = async (h: DailyHarness) => (await projectCalendarEffects(h.deps, { nowMs: h.clock.now() })).map((o) => o.outcome);
const live = (h: DailyHarness, owner: TestOwner, calendarId = OUTFIT_CALENDAR) => h.calendar.allEvents(owner.userId, calendarId).filter((e) => e.status !== "cancelled");
const writes = (h: DailyHarness) => h.calendar.log.filter((l) => l.op === "insertEvent" || l.op === "patchEvent" || l.op === "deleteEvent");
const swap = (owner: TestOwner, doc: BoardDocument, option: number) => owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[option]!.optionId, role: "top" });
const current = async (h: DailyHarness, owner: TestOwner) => (await getBoard(h.db, owner.principal(), { date: DAY }))!;
async function projection(h: DailyHarness, owner: TestOwner): Promise<ProjectionRow> {
  return (await first<ProjectionRow>(h.db, "SELECT state, suppression_reason, projected_revision, managed_text, etag, event_id, calendar_id, lock_until, lock_token, last_error FROM calendar_projections WHERE user_id = ?", owner.userId))!;
}
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("finding 1: the projection lease is owned by a token, renewed before every call, and released only by its owner", () => {
  it("a projector whose lease ran out during a call neither writes the row nor releases the lease another projector took", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    const insideB = gate();
    const releaseB = gate();
    let second: ReturnType<typeof run> | undefined;
    h.calendar.delayNext("insertEvent", async () => {
      // This insert outlives the lease it started under (61 s pass); meanwhile the board changes and a
      // second projector starts and is inside its own first Calendar call when the insert returns.
      h.clock.advance(61_000);
      await swap(owner, doc, 0);
      h.calendar.delayNext("getEvent", async () => {
        insideB.open();
        await releaseB.opened;
      });
      second = run(h);
      await insideB.opened;
    });

    expect(await run(h)).toEqual(["busy"]);
    const held = await projection(h, owner);
    // The second projector's lease is intact, and the first recorded nothing after losing its own.
    expect(held.lock_until).not.toBeNull();
    expect(held.lock_token).not.toBeNull();
    expect(held.projected_revision).toBeNull();

    releaseB.open();
    expect(await second!).toEqual(["projected"]);
    expect(live(h, owner)).toHaveLength(1);
    expect(live(h, owner)[0]!.privateProperties.garderobeRevision).toBe("2");
    expect(await projection(h, owner)).toMatchObject({ state: "projected", projected_revision: 2, lock_until: null, lock_token: null });
  });

  it("renews the lease before each call, so another projector cannot take it during a run of slow calls", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    const slow = () => h.clock.advance(30_000);
    let other: string[] | undefined;
    h.calendar.delayNext("getEvent", slow);
    h.calendar.delayNext("insertEvent", slow);
    h.calendar.delayNext("getEvent", async () => {
      // 90 s after the lease was first taken, during the read-back, a second projector tries.
      slow();
      await swap(owner, doc, 0);
      other = await run(h);
    });
    expect(await run(h)).toEqual(["projected"]);
    expect(other).toEqual(["busy"]);
    expect(writes(h).map((w) => w.op)).toEqual(["insertEvent", "patchEvent"]);
    expect(live(h, owner)[0]!.privateProperties.garderobeRevision).toBe("2");
  });

  it("does not start a call when the renewed lease would not outlast the call's deadline", async () => {
    const fake = new FakeGoogleCalendar();
    const at = 1_000_000;
    // TEST STAND-IN lease: renewals that only reach 20 s ahead, then a full lease.
    const short = leasedWriter(fake, { hold: async () => at + 20_000, keepUntilExpiry: () => undefined }, () => at);
    await expect(short.getEvent("u1", "cal", "gdbabcdef")).rejects.toBeInstanceOf(LeaseTooShortError);
    await expect(short.deleteEvent("u1", "cal", "gdbabcdef")).rejects.toBeInstanceOf(LeaseTooShortError);
    expect(fake.log).toHaveLength(0);
    const full = leasedWriter(fake, { hold: async () => at + PROJECTION_LEASE_MS, keepUntilExpiry: () => undefined }, () => at);
    expect(await full.getEvent("u1", "cal", "gdbabcdef")).toBeNull();
    expect(fake.log.map((l) => l.op)).toEqual(["getEvent"]);
  });

  it("refuses a writer whose calls have no bounded deadline, without calling it", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    h.calendar.callDeadlineMs = Number.POSITIVE_INFINITY;
    expect(await run(h)).toEqual(["failed"]);
    expect(h.calendar.log.filter((l) => l.op !== "listEvents")).toHaveLength(0);
    expect(await projection(h, owner)).toMatchObject({ state: "failed", lock_until: null, lock_token: null });
  });
});

describe("finding 2: a missing connection is recorded without losing the projection's durable state", () => {
  it("an owner's deletion survives a period without a Calendar connection: after reconnecting the event is not recreated", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const eventId = live(h, owner)[0]!.eventId;
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, eventId, { purge: true });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);

    h.deps.calendar = { reader: null, writer: null };
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 1);
    await run(h);
    expect(await projection(h, owner)).toMatchObject({ state: "suppressed", suppression_reason: "deleted_externally" });

    h.deps.calendar = { reader: h.calendar, writer: h.calendar };
    h.clock.advanceMinutes(31);
    await swap(owner, doc, 2);
    await run(h);
    expect(live(h, owner)).toHaveLength(0);
    expect(writes(h).map((w) => w.op)).toEqual(["insertEvent"]);
    expect((await current(h, owner)).calendarProjection.state).toBe("suppressed");
  });

  it("a lost connection keeps what was delivered, so a deletion made meanwhile is still recognised as the owner's", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const eventId = live(h, owner)[0]!.eventId;

    h.calendar.setConnected(owner.userId, false);
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["not_connected"]);
    expect(await projection(h, owner)).toMatchObject({ state: "not_connected", projected_revision: 1 });
    expect((await current(h, owner)).calendarProjection.state).toBe("not_connected");

    // While disconnected the owner deletes the event, and Google forgets it entirely.
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, eventId, { purge: true });
    h.calendar.setConnected(owner.userId, true);
    h.clock.advanceMinutes(31);
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);
    expect(live(h, owner)).toHaveLength(0);
    expect(writes(h).map((w) => w.op)).toEqual(["insertEvent"]);
  });
});

describe("finding 3: an event is current only when every managed field reads back as written", () => {
  it("a retried effect writes a new presentation and reminder although revision and text already match", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    // The insert lands, but its read-back fails: the effect is retried later.
    h.calendar.delayNext("insertEvent", () => h.calendar.failNext("getEvent", 1, new CalendarApiError("TEST FAKE: backend error", { status: 503, retryable: true })));
    expect(await run(h)).toEqual(["retry"]);
    expect(live(h, owner)[0]!.time).toEqual(MORNING);

    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { presentation: "all_day", reminderMinutesBefore: 10 } } } } });
    expect((await current(h, owner)).revision).toBe(1); // same revision, same text: only presentation changed
    h.clock.advanceMinutes(5);
    // The settings change queued its own projection: the first run writes the presentation, the second finds it current.
    expect(await run(h)).toEqual(["projected", "projected"]);
    expect(live(h, owner)[0]).toMatchObject({ time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: 10 });
    expect(writes(h).map((w) => w.op)).toEqual(["insertEvent", "patchEvent"]);
  });

  it("a read-back showing another start time than the one written does not verify, and the time is written again", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    h.calendar.delayNext("getEvent", () => undefined);
    h.calendar.delayNext("getEvent", () => {
      // The owner moves the event in Google just as the projector reads its write back.
      h.calendar.externalEdit(owner.userId, OUTFIT_CALENDAR, h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR)[0]!.eventId, (e) => {
        e.time = MOVED;
      });
    });
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner)[0]!.time).toEqual(MORNING);
    expect(writes(h).map((w) => w.op)).toEqual(["insertEvent", "patchEvent"]);
  });
});

describe("finding 4: after every remote operation the full desired state is read again", () => {
  it("a pause that lands while the event is being written is honoured in the same run: the event is removed, not reported projected", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    h.calendar.delayNext("insertEvent", async () => {
      await owner.exec("service.pause", { from: DAY, resumeOn: null });
    });
    expect(await run(h)).toEqual(["removed"]);
    expect(live(h, owner)).toHaveLength(0);
    expect(await projection(h, owner)).toMatchObject({ state: "suppressed", suppression_reason: "pause", projected_revision: null });
  });

  it("the end of a pause that lands while the event is being removed is honoured in the same run: the event is delivered again", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    await run(h);
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    h.calendar.delayNext("deleteEvent", async () => {
      await owner.exec("service.resume", {});
    });
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner)).toHaveLength(1);
    expect(await projection(h, owner)).toMatchObject({ state: "projected", projected_revision: 1, suppression_reason: null });
    // Our own delete is never mistaken for the owner's: the resume's own effect finds the event current.
    h.clock.advanceMinutes(1);
    expect(await run(h)).toEqual(["projected"]);
    // The delete is read back and the cancelled event gets a fresh fence value (a patch), then the restore.
    expect(writes(h).map((w) => w.op)).toEqual(["insertEvent", "deleteEvent", "patchEvent", "patchEvent"]);
  });
});

describe("finding 5: a change of outfit calendar moves the managed event", () => {
  it("SYNTHETIC: the texts of unverified writes survive a move whose previous-calendar cleanup could not finish, so their lines stay ours", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    // TEST-WRITTEN row state: an unverified write of ours carried this text.
    await h.db.prepare("UPDATE calendar_projections SET attempted_text = ? WHERE user_id = ?").bind(JSON.stringify(["UNVERIFIED LINE"]), owner.userId).run();
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // The previous calendar refuses the removal (a note); the insert into the new one gets no answer (TEST FAKE).
    h.calendar.failNext("deleteEvent", 1, new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" }));
    h.calendar.failNext("insertEvent", 4, new CalendarApiError("TEST FAKE: backend error", { status: 503, retryable: true }));
    expect(await run(h)).toEqual(["superseded", "retry"]);
    const row = await first<{ calendar_id: string; attempted_text: string | null }>(h.db, "SELECT calendar_id, attempted_text FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.calendar_id).toBe(NEW_CALENDAR);
    expect(JSON.parse(row!.attempted_text ?? "[]")).toContain("UNVERIFIED LINE");
  });

  it("once the markers are lost, a line known only from an unverified write of ours is kept: only the verified projection locates managed text", () => {
    const previous = "Day\nA\nB\nC";
    const attempted = "Day\nA\nX\nC";
    const next = managedBlock("Day\nA\nY\nC");
    // The unverified write stands whole: its lines that are not the verified projection's are kept, after the new text.
    expect(mergeDescription(`${attempted}\n\nMy note`, previous, next, [attempted])).toBe(`${next}\nX\n\nMy note`);
    // Mixed with the owner's line between surviving lines: both are kept, as the owner may have written either.
    expect(mergeDescription("Day\nA\nX\nOwner line\nC", previous, next, [attempted])).toBe(`${next}\nX\nOwner line`);
    expect(mergeDescription("Day\nA\nOwner line\nTail", "Day\nA\nB", next, ["Day\nA\nX\nTail"])).toBe(`${next}\nOwner line\nTail`);
    // No verified basis at all: nothing of the description is removed, the new text opens a fresh region.
    expect(mergeDescription("Unverified one\nOwner line", null, next, ["Unverified one\nUnverified two"])).toBe(`${next}\n\nUnverified one\nOwner line`);
    // The verified text stands whole and is replaced; a line only an unverified write added stays.
    expect(mergeDescription("Day\nA\nB\n\nMy note", "Day\nA", next, ["Day\nA\nB"])).toBe(`${next}\nB\n\nMy note`);
    // Inside our markers, a line of an unverified write is ours and is replaced.
    expect(mergeDescription(`Before\n${managedBlock(attempted)}`, previous, next, [attempted])).toBe(`Before\n${next}`);
  });

  it("SYNTHETIC: a write of ours that may still land on an event in the previous calendar that is not marked as ours is fenced on the move", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const old = live(h, owner, OUTFIT_CALENDAR)[0]!;
    // TEST FAKE state: the event no longer carries our board mark; TEST-WRITTEN row state: a write of ours to it may land.
    h.calendar.externalEdit(owner.userId, OUTFIT_CALENDAR, old.eventId, (e) => { delete e.privateProperties.garderobeBoard; });
    const stale = live(h, owner, OUTFIT_CALENDAR)[0]!.etag;
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, old.eventId]]), owner.userId).run();
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["superseded", "projected"]);
    const fenced = live(h, owner, OUTFIT_CALENDAR)[0]!;
    expect(fenced.etag).not.toBe(stale); // not removed (not ours), but its etag moved on
    await expect(h.calendar.patchEvent(owner.userId, OUTFIT_CALENDAR, old.eventId, { privateProperties: { garderobeBoard: doc.boardId } }, stale)).rejects.toMatchObject({ detail: { reason: "precondition" } });
    const row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
  });
  it("moving the outfit calendar alone moves the event, with no new board revision; settings that change nothing in the event queue nothing", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    expect((await current(h, owner)).revision).toBe(1);
    h.clock.advanceMinutes(2);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(0);
    expect(live(h, owner, NEW_CALENDAR)).toHaveLength(1);
    expect(await projection(h, owner)).toMatchObject({ state: "projected", calendar_id: NEW_CALENDAR, projected_revision: 1 });
    // A setting the event is not written from queues no projection.
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { readCalendarIds: ["primary", "work@test.calendar"] } } } } });
    h.clock.advanceMinutes(2);
    expect(await run(h)).toEqual([]);
  });

  it("undoing a move of the outfit calendar moves the event back", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const moved = await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    expect(await run(h)).toEqual(["projected"]);
    await owner.exec("command.undo", { commandId: moved.commandId });
    h.clock.advanceMinutes(2);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner, NEW_CALENDAR)).toHaveLength(0);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(1);
    expect(await projection(h, owner)).toMatchObject({ state: "projected", calendar_id: OUTFIT_CALENDAR });
  });

  it("a timezone change that makes today an earlier date re-projects that day's open board too", async () => {
    const { h, owner } = await setup();
    const EVE = "2026-09-15";
    h.weather.setForecast(EVE, MILD_DAY);
    await compose(h, owner, EVE); // composed at 21:00 BST on the 15th
    expect(await run(h)).toEqual(["projected"]);
    // 00:30 BST on the 16th in London is still 19:30 on the 15th in New York.
    h.clock.advanceMinutes(210);
    const before = h.calendar.log.length;
    await owner.exec("settings.update", { patch: { timezone: "America/New_York" } });
    const outcomes = await run(h);
    expect(outcomes.length).toBeGreaterThan(0);
    expect(h.calendar.log.slice(before).some((l) => l.op === "getEvent" || l.op === "patchEvent")).toBe(true);
  });

  it("removes the event from the previous calendar and delivers it to the new one, instead of reading it as deleted by the owner", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["superseded", "projected"]);
    expect(h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).map((e) => e.status)).toEqual(["cancelled"]);
    const moved = live(h, owner, NEW_CALENDAR);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.privateProperties.garderobeRevision).toBe("2");
    expect(await projection(h, owner)).toMatchObject({ state: "projected", calendar_id: NEW_CALENDAR, projected_revision: 2 });

    // Deletion detection starts afresh in the new calendar: a deletion there is the owner's again.
    h.calendar.externalDelete(owner.userId, NEW_CALENDAR, moved[0]!.eventId);
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 1);
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);
  });

  it("a removal from the previous calendar whose answer is lost is not read as the owner's deletion after switching back", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const oldEvent = live(h, owner, OUTFIT_CALENDAR)[0]!;
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // The delete in the previous calendar commits but its answer is a 503 (TEST FAKE).
    h.calendar.delayNext("deleteEvent", () => {
      h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, oldEvent.eventId, { purge: true });
    });
    h.calendar.failNext("deleteEvent", 1, new CalendarApiError("TEST FAKE: backend error after commit", { status: 503, retryable: true }));
    expect(await run(h)).toEqual(["superseded", "retry"]);

    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: OUTFIT_CALENDAR } } } } });
    h.clock.advanceMinutes(31);
    // The retried effect and the switch-back's own projection: the second finds the event current.
    expect(await run(h)).toEqual(["projected", "projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(1);
    expect(await projection(h, owner)).toMatchObject({ state: "projected", calendar_id: OUTFIT_CALENDAR });
    expect(await first<{ removing_event_id: string | null }>(h.db, "SELECT removing_event_id FROM calendar_projections WHERE user_id = ?", owner.userId)).toEqual({ removing_event_id: null });
  });

  it("a removal from the previous calendar that meets an edit made meanwhile (412) is retried, never left behind", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const oldEvent = live(h, owner, OUTFIT_CALENDAR)[0]!;
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // TEST FAKE: the owner edits the old event between our read and our delete.
    h.calendar.delayNext("deleteEvent", () => h.calendar.externalEdit(owner.userId, OUTFIT_CALENDAR, oldEvent.eventId, (e) => { e.summary = "edited meanwhile"; }));
    expect(await run(h)).toEqual(["superseded", "retry"]);
    expect(await projection(h, owner)).toMatchObject({ calendar_id: OUTFIT_CALENDAR });
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(1);
    h.clock.advanceMinutes(31);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(0);
    expect(live(h, owner, NEW_CALENDAR)).toHaveLength(1);
  });

  it("a refused removal from the previous calendar withdraws its intent: after switching back, the owner's own deletion is his", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const oldEvent = live(h, owner, OUTFIT_CALENDAR)[0]!;
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    h.calendar.failNext("deleteEvent", 1, new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: true }));
    expect(await run(h)).toEqual(["superseded", "retry"]);
    expect(await first<{ removing_event_id: string | null }>(h.db, "SELECT removing_event_id FROM calendar_projections WHERE user_id = ?", owner.userId)).toEqual({ removing_event_id: null });

    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: OUTFIT_CALENDAR } } } } });
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, oldEvent.eventId, { purge: true });
    h.clock.advanceMinutes(31);
    // The second effect (the switch-back's own projection) finds the day already suppressed.
    expect(await run(h)).toEqual(["suppressed_deleted_externally", "skipped_deleted_externally"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(0);
  });
});

describe("finding 6: the managed region has explicit bounds, and ambiguous owner text is never deleted", () => {
  // Synthetic managed text in the shape the projector renders.
  const previous = ["Tuesday: 12 °C at 08:00, 19 °C peak.", "", "1. Pink oxford with grey chino", "Warm against cool.", "Shirt: Pink oxford"].join("\n");
  const next = previous.replace("grey chino", "walnut chino");

  it("replaces the marked region with the new managed text, keeps the owner's line written inside it right after, and keeps everything outside it", () => {
    const remote = `Before\n${managedBlock(previous).replace("Warm against cool.", "MY OWN EDIT")}\n\nAfter`;
    // A line inside the markers that was not projected may be his note: it is kept, outside the new markers.
    expect(mergeDescription(remote, previous, managedBlock(next))).toBe(`Before\n${managedBlock(next)}\nMY OWN EDIT\n\nAfter`);
    // The description still opens with the day line, and the markers are invisible text only.
    expect(managedBlock(next).startsWith("Tuesday: 12 °C at 08:00, 19 °C peak.")).toBe(true);
    expect(managedBlock(next).replace(/[\u2060\u2063\u200b]/g, "")).toBe(`${next}\n`);
  });

  it("keeps the owner's text and opens a fresh marked region when nothing identifies the managed text", () => {
    expect(mergeDescription("Something else entirely", previous, managedBlock(next))).toBe(`${managedBlock(next)}\n\nSomething else entirely`);
    expect(mergeDescription("My own plans for the day", null, managedBlock(next))).toBe(`${managedBlock(next)}\n\nMy own plans for the day`);
  });

  it("does not stretch the managed span over an owner's line next to the surviving managed lines", () => {
    const remote = `Remember the umbrella\n${previous.replace("Tuesday: 12 °C at 08:00, 19 °C peak.\n", "")}`;
    expect(mergeDescription(remote, previous, next)).toBe(`Remember the umbrella\n\n${next}`);
  });

  it("keeps an owner's note written between two unchanged managed lines when the markers are gone", () => {
    const lines = previous.split("\n");
    const remote = [...lines.slice(0, 2), "Pick up the suit from the tailor", ...lines.slice(2)].join("\n");
    const merged = mergeDescription(remote, previous, next);
    expect(merged).toContain("Pick up the suit from the tailor");
    expect(merged.startsWith(next)).toBe(true);
  });

  it("a region whose end marker was lost falls back to the last projection's text and leaves no stray marker", () => {
    const broken = `${managedBlock(previous).split("\n").slice(0, -1).join("\n")}\n\nMy note`;
    expect(mergeDescription(broken, previous, managedBlock(next))).toBe(`${managedBlock(next)}\n\nMy note`);
  });

  it("an owner who replaced the whole description keeps his text; the outfits come first in a fresh region", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    h.calendar.externalEdit(owner.userId, OUTFIT_CALENDAR, live(h, owner)[0]!.eventId, (e) => {
      e.description = "Dentist at 9, take the umbrella";
    });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner)[0]!.description).toBe(`${managedBlock(renderBoardCalendarText(await current(h, owner)))}\n\nDentist at 9, take the umbrella`);
  });
});

describe("rule: text without the markers counts as ours only when a verified projection exists", () => {
  it("SYNTHETIC: with no verified projection, markerless text equal to the new outfit text is the owner's: it is kept whole and the outfits go first", () => {
    const next = "Wednesday 16 September\nNavy shirt, grey trousers";
    const remote = `${next}\nMy note`;
    expect(mergeDescription(remote, null, managedBlock(next))).toBe(`${managedBlock(next)}\n\n${next}\nMy note`);
    expect(mergeDescription(remote, "", managedBlock(next))).toBe(`${managedBlock(next)}\n\n${next}\nMy note`);
    // With a verified projection, the same text standing whole is the managed text and is replaced in place.
    expect(mergeDescription(remote, "Tuesday 15 September\nOlder outfit", managedBlock(next))).toBe(`${managedBlock(next)}\nMy note`);
  });

  it("SYNTHETIC: an event whose markerless description shows the outfit text verifies a write only when a verified projection exists", () => {
    const text = "Wednesday 16 September\nNavy shirt, grey trousers";
    const write: ManagedEventWrite = { summary: "Garderobe", description: managedBlock(text), privateProperties: { garderobeBoard: "b1", garderobeRevision: "2" }, time: MORNING, reminderMinutesBefore: 10 };
    const event: ManagedEvent = { eventId: "gdbabc", etag: "\"e1\"", status: "confirmed", summary: "Garderobe", description: text, privateProperties: { ...write.privateProperties }, attendeeCount: 0, time: MORNING, reminderMinutesBefore: 10 };
    expect(carriesWrite(event, write, text, false)).toBe(false);
    expect(carriesWrite(event, write, text, true)).toBe(true);
    // With the markers the managed region itself identifies the text, verified projection or not.
    expect(carriesWrite({ ...event, description: managedBlock(text) }, write, text, false)).toBe(true);
  });
});

describe("finding 7: a write that does not verify advances nothing of the recorded managed basis", () => {
  it("after rounds whose read-back never verifies, the row still holds the last verified revision, text and etag", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const before = await projection(h, owner);
    const eventId = live(h, owner)[0]!.eventId;
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    for (let round = 0; round < 4; round++) {
      h.calendar.delayNext("getEvent", () => undefined);
      // Synthetic interference: on every read-back the event has just been moved.
      h.calendar.delayNext("getEvent", () => h.calendar.externalEdit(owner.userId, OUTFIT_CALENDAR, eventId, (e) => (e.time = MOVED)));
    }
    expect(await run(h)).toEqual(["retry"]);
    const after = await projection(h, owner);
    expect(after).toMatchObject({ projected_revision: 1, managed_text: before.managed_text, etag: before.etag, state: "projected" });
    expect(after.last_error).toMatch(/could not be verified/);
    expect((await current(h, owner)).calendarProjection.state).not.toBe("projected");
  });
});

describe("finding 8: Google getEvent holds its whole read to one deadline by aborting", () => {
  const notFound = () => new Response(JSON.stringify({ error: { errors: [{ reason: "notFound" }], code: 404 } }), { status: 404 });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("aborts the calendar probe in flight when the read's deadline is up, before the probe's own request timeout", async () => {
    // Fake timers drive every deadline, request timeout and delay here, so the timings are exact rather than wall-clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let probeSignal: AbortSignal | undefined;
      let probeStartedAt = 0;
      let probeAbortedAt = 0;
      let tokens = 0;
      // TEST FAKE fetch: the event GET answers 404 after 150 ms; the probe never answers unless aborted.
      const fetch: FetchLike = async (input, init) => {
        if (new URL(input).pathname.endsWith("/events")) {
          probeStartedAt = Date.now();
          probeSignal = init?.signal;
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () => {
              probeAbortedAt = Date.now();
              reject(new Error("TEST FAKE: aborted"));
            });
          });
        }
        await sleep(150);
        return notFound();
      };
      const calendar = createGoogleCalendar({
        fetch,
        timeoutMs: 200,
        getAccessToken: async () => {
          tokens++;
          if (tokens === 2) await sleep(150); // a slow token refresh before the probe
          return "ya29.synthetic-test-token";
        },
      });
      const started = Date.now();
      const pending = calendar.getEvent("u1", "primary", "gdbabcdef").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await pending;
      expect(error).toBeInstanceOf(CalendarApiError);
      expect((error as CalendarApiError).detail).toEqual({ status: null, retryable: true, reason: "network" });
      expect(probeSignal?.aborted).toBe(true);
      // The probe started after the GET (150 ms) and the slow token lookup (150 ms), and was aborted by the read's
      // 400 ms deadline, 100 ms later: before its own 200 ms request timeout could fire.
      expect(probeStartedAt - started).toBe(300);
      expect(probeAbortedAt - started).toBe(400);
      expect(calendar.callDeadlineMs).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no further request once the read's deadline is up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const paths: string[] = [];
      const fetch: FetchLike = async (input) => {
        paths.push(new URL(input).pathname);
        await sleep(190);
        return notFound();
      };
      const calendar = createGoogleCalendar({ fetch, timeoutMs: 200, getAccessToken: async () => (await sleep(190), "ya29.synthetic-test-token") });
      const pending = calendar.getEvent("u1", "primary", "gdbabcdef").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(400);
      expect(((await pending) as CalendarApiError).detail).toEqual({ status: null, retryable: true, reason: "network" });
      // The second token lookup finishes after the deadline; the probe it would have led to never starts.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(paths).toEqual(["/calendar/v3/calendars/primary/events/gdbabcdef"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("finding 9: a deleted event whose ID stays reserved moves to a replacement ID", () => {
  it("after a restore the event is inserted under a deterministic replacement ID instead of failing as a duplicate every round", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const eventId = live(h, owner)[0]!.eventId;
    expect(eventId).toBe(await managedEventId(owner.userId, "home", DAY));
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, eventId, { reserveId: true });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);

    h.clock.advanceMinutes(2);
    await owner.exec("board.restore", { localDate: DAY });
    // The ID is taken with no event readable under it: read again on a later attempt before moving on.
    expect(await run(h)).toEqual(["retry"]);
    expect(live(h, owner)).toHaveLength(0);
    h.clock.advanceMinutes(6);
    expect(await run(h)).toEqual(["projected"]);
    const replacement = await managedEventId(owner.userId, `home|after-deletion|${eventId}`, DAY);
    expect(live(h, owner).map((e) => e.eventId)).toEqual([replacement]);
    expect(await projection(h, owner)).toMatchObject({ event_id: replacement, state: "projected", projected_revision: 2 });
    expect(h.calendar.log.filter((l) => l.op === "insertEvent").map((l) => [l.eventId, l.outcome, l.reason])).toEqual([
      [eventId, "ok", null],
      [eventId, "failed", "duplicate"],
      [eventId, "failed", "duplicate"],
      [replacement, "ok", null],
    ]);

    // Later revisions go to the replacement event.
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 1);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner).map((e) => [e.eventId, e.privateProperties.garderobeRevision])).toEqual([[replacement, "3"]]);
  });

  it("SYNTHETIC: a move to the replacement ID starts with no verified text there, keeping the old event's text among the unverified ones", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    await run(h);
    const eventId = live(h, owner)[0]!.eventId;
    const delivered = (await projection(h, owner)).managed_text;
    expect(delivered).not.toBeNull();
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, eventId, { reserveId: true });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);
    h.clock.advanceMinutes(2);
    await owner.exec("board.restore", { localDate: DAY });
    expect(await run(h)).toEqual(["retry"]);
    // TEST FAKE: the insert under the replacement ID is refused, so the run stops right after the move.
    const replacement = await managedEventId(owner.userId, `home|after-deletion|${eventId}`, DAY);
    const insertEvent = h.calendar.insertEvent.bind(h.calendar);
    h.calendar.insertEvent = async (userId, calendarId, id, write) => {
      if (id === replacement) throw new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" });
      return insertEvent(userId, calendarId, id, write);
    };
    h.clock.advanceMinutes(6);
    await run(h);
    const row = await first<{ event_id: string; managed_text: string | null; attempted_text: string | null }>(h.db, "SELECT event_id, managed_text, attempted_text FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.event_id).toBe(replacement);
    expect(row!.managed_text).toBeNull();
    expect(JSON.parse(row!.attempted_text ?? "[]")).toContain(delivered);
  });

  it("SYNTHETIC: a live event that a read misses for a moment while its ID answers 409 is reconciled under its own ID, never moved to a replacement", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const eventId = live(h, owner)[0]!.eventId;
    // TEST-WRITTEN row state: the day was never delivered, so a missing event is not the owner's deletion and an insert is tried.
    await h.db.prepare("UPDATE calendar_projections SET projected_revision = NULL, state = 'pending' WHERE user_id = ?").bind(owner.userId).run();
    // TEST FAKE: the next two reads of the event miss it (a passing miss), so an insert is tried and answers 409.
    const getEvent = h.calendar.getEvent.bind(h.calendar);
    let misses = 2;
    h.calendar.getEvent = async (userId, calendarId, id) => {
      if (id === eventId && misses > 0) { misses--; return null; }
      return getEvent(userId, calendarId, id);
    };
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["retry"]);
    h.clock.advanceMinutes(6);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner).map((e) => [e.eventId, e.privateProperties.garderobeRevision])).toEqual([[eventId, "2"]]);
    expect(await first<{ event_id: string; duplicate_missing: string | null }>(h.db, "SELECT event_id, duplicate_missing FROM calendar_projections WHERE user_id = ?", owner.userId)).toEqual({ event_id: eventId, duplicate_missing: null });
  });

  it("SYNTHETIC: a read that sees the event clears an earlier 'taken but missing' observation even when the write after it fails, so one later miss does not move the event", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const eventId = live(h, owner)[0]!.eventId;
    // TEST-WRITTEN row state: the day was never delivered, so a missing event is not the owner's deletion and an insert is tried.
    await h.db.prepare("UPDATE calendar_projections SET projected_revision = NULL, state = 'pending' WHERE user_id = ?").bind(owner.userId).run();
    // TEST FAKE: while `hide` is set, reads of the live event miss it, so an insert is tried and answers 409.
    const getEvent = h.calendar.getEvent.bind(h.calendar);
    let hide = true;
    h.calendar.getEvent = async (userId, calendarId, id) => (hide && id === eventId ? null : getEvent(userId, calendarId, id));
    const missingSince = async () => (await first<{ duplicate_missing: string | null }>(h.db, "SELECT duplicate_missing FROM calendar_projections WHERE user_id = ?", owner.userId))!.duplicate_missing;
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["retry"]);
    expect(await missingSince()).not.toBeNull();
    // The event is read again, then the write fails before any read-back (TEST FAKE: a dropped connection).
    hide = false;
    h.calendar.failNext("patchEvent", 1, new Error("TEST FAKE: connection reset"));
    h.clock.advanceMinutes(6);
    expect(await run(h)).toEqual(["retry"]);
    expect(await missingSince()).toBeNull();
    // One more passing miss: recorded anew, not taken as a confirmation of the first.
    hide = true;
    h.clock.advanceMinutes(6);
    expect(await run(h)).toEqual(["retry"]);
    expect(live(h, owner).map((e) => e.eventId)).toEqual([eventId]);
    expect((await projection(h, owner)).event_id).toBe(eventId);
  });

  const takenMissing = async (h: DailyHarness, owner: TestOwner) => JSON.parse((await first<{ duplicate_missing: string | null }>(h.db, "SELECT duplicate_missing FROM calendar_projections WHERE user_id = ?", owner.userId))!.duplicate_missing ?? "[]") as { calendarId: string; eventId: string; since: string }[];

  it("SYNTHETIC: an old observation of the same event ID in another calendar does not confirm a 409 here", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const eventId = live(h, owner)[0]!.eventId;
    // TEST-WRITTEN row state: the day was never delivered (so an insert is tried), and an observation ten minutes
    // old of the same event ID taken but unreadable, made in another calendar.
    const old = new Date(h.clock.now() - 10 * 60_000).toISOString();
    await h.db.prepare("UPDATE calendar_projections SET projected_revision = NULL, state = 'pending', duplicate_missing = ? WHERE user_id = ?").bind(JSON.stringify([{ calendarId: NEW_CALENDAR, eventId, since: old }]), owner.userId).run();
    // TEST FAKE: reads of the live event here miss it, so the insert answers 409 with nothing readable.
    const getEvent = h.calendar.getEvent.bind(h.calendar);
    h.calendar.getEvent = async (userId, calendarId, id) => (calendarId === OUTFIT_CALENDAR && id === eventId ? null : getEvent(userId, calendarId, id));
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["retry"]);
    expect((await projection(h, owner)).event_id).toBe(eventId);
    expect((await takenMissing(h, owner)).map((t) => [t.calendarId, t.eventId, t.since === old])).toEqual([[NEW_CALENDAR, eventId, true], [OUTFIT_CALENDAR, eventId, false]]);
  });

  it("SYNTHETIC: a change of outfit calendar clears every observation, so an old one for the new calendar does not move the event there at once", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const eventId = live(h, owner)[0]!.eventId;
    // TEST FAKE state: the new calendar already holds an event under the stable ID, and reads there miss it.
    await h.calendar.insertEvent(owner.userId, NEW_CALENDAR, eventId, { summary: "older", description: "", privateProperties: {}, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null });
    const getEvent = h.calendar.getEvent.bind(h.calendar);
    h.calendar.getEvent = async (userId, calendarId, id) => (calendarId === NEW_CALENDAR && id === eventId ? null : getEvent(userId, calendarId, id));
    // TEST-WRITTEN row state: an observation ten minutes old of exactly that event, made before the change.
    await h.db.prepare("UPDATE calendar_projections SET duplicate_missing = ? WHERE user_id = ?").bind(JSON.stringify([{ calendarId: NEW_CALENDAR, eventId, since: new Date(h.clock.now() - 10 * 60_000).toISOString() }]), owner.userId).run();
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // (The settings change queued its own effect, superseded by the swap's.)
    expect((await run(h)).filter((o) => o !== "superseded")).toEqual(["retry"]);
    const row = await projection(h, owner);
    expect([row.calendar_id, row.event_id]).toEqual([NEW_CALENDAR, eventId]);
    expect((await takenMissing(h, owner)).map((t) => [t.calendarId, t.eventId, Date.parse(t.since) === h.clock.now()])).toEqual([[NEW_CALENDAR, eventId, true]]);
  });

  it("SYNTHETIC: a cleanup read that sees an earlier event of ours clears its observation", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    // TEST FAKE state: an earlier event of ours under another ID; TEST-WRITTEN row state: a write of ours to it may
    // still land, and an old observation that its ID was taken with nothing readable.
    const strayId = "gdbabc0123stra9";
    await h.calendar.insertEvent(owner.userId, OUTFIT_CALENDAR, strayId, { summary: "older", description: "", privateProperties: { garderobeBoard: doc.boardId, garderobeRevision: "1" }, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null });
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ?, duplicate_missing = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, strayId]]), JSON.stringify([{ calendarId: OUTFIT_CALENDAR, eventId: strayId, since: new Date(h.clock.now() - 10 * 60_000).toISOString() }]), owner.userId).run();
    // The cleanup is refused after its read (TEST FAKE: forbidden), so only the read can clear the observation.
    h.calendar.failNext("deleteEvent", 3, new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" }));
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    await run(h);
    expect(h.calendar.log.some((l) => l.op === "getEvent" && l.eventId === strayId)).toBe(true);
    expect(await takenMissing(h, owner)).toEqual([]);
  });
});

describe("review: tombstones and earlier calendars", () => {
  it("SYNTHETIC: a cancelled fence of ours brought back as the board's event loses its tombstone mark, so the next run keeps it", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    // TEST FAKE state: the event at the stable ID is a cancelled fence of ours (a tombstone).
    h.calendar.externalEdit(owner.userId, OUTFIT_CALENDAR, event.eventId, (e) => { e.status = "cancelled"; e.privateProperties.garderobeTombstone = "1"; });
    // TEST-WRITTEN row state: the day was never delivered, so the cancelled event is not the owner's deletion.
    await h.db.prepare("UPDATE calendar_projections SET projected_revision = NULL, state = 'pending' WHERE user_id = ?").bind(owner.userId).run();
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["projected"]);
    const restored = live(h, owner);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.privateProperties.garderobeTombstone).not.toBe("1");
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 1);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner)).toHaveLength(1);
    expect((await projection(h, owner)).state).toBe("projected");
  });

  it("SYNTHETIC: an uncertain write left in an earlier calendar that could not be cleaned up is cleaned up by a later run once access returns", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const old = live(h, owner, OUTFIT_CALENDAR)[0]!;
    // TEST-WRITTEN row state: a write of ours to the old event may still land.
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, old.eventId]]), owner.userId).run();
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // The previous calendar refuses its reads for now (TEST FAKE: access lost).
    h.calendar.failNext("getEvent", 2, new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" }));
    expect(await run(h)).toEqual(["superseded", "projected"]);
    expect(live(h, owner, NEW_CALENDAR)).toHaveLength(1);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(1); // still there, not yet cleaned up
    let row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(JSON.parse(row!.uncertain_calendars ?? "[]")).toEqual([[OUTFIT_CALENDAR, old.eventId]]);
    // Access returns; the next projection of the day cleans up the earlier calendar.
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 1);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(0);
    row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
  });

  it("SYNTHETIC: texts of unverified writes stay recorded while a write of ours in an earlier calendar is still outstanding", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const old = live(h, owner, OUTFIT_CALENDAR)[0]!;
    // TEST-WRITTEN row state: an unverified write of ours to the old event carried this text and may still land.
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ?, attempted_text = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, old.eventId]]), JSON.stringify(["UNVERIFIED IN A"]), owner.userId).run();
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // The previous calendar refuses its reads (TEST FAKE: access lost), so its entry stays outstanding.
    h.calendar.failNext("getEvent", 2, new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" }));
    expect(await run(h)).toEqual(["superseded", "projected"]);
    let row = await first<{ uncertain_calendars: string | null; attempted_text: string | null }>(h.db, "SELECT uncertain_calendars, attempted_text FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(JSON.parse(row!.uncertain_calendars ?? "[]")).toEqual([[OUTFIT_CALENDAR, old.eventId]]);
    expect(JSON.parse(row!.attempted_text ?? "[]")).toContain("UNVERIFIED IN A");
    // Once the earlier calendar is cleaned up, a verified projection clears the history.
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 1);
    expect(await run(h)).toEqual(["projected"]);
    row = await first<{ uncertain_calendars: string | null; attempted_text: string | null }>(h.db, "SELECT uncertain_calendars, attempted_text FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row).toEqual({ uncertain_calendars: null, attempted_text: null });
  });

  it("SYNTHETIC: an event left in the previous calendar after a refused removal keeps its outfit lines recognised as ours when the owner switches back", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const old = live(h, owner, OUTFIT_CALENDAR)[0]!;
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // Every removal in the previous calendar is refused for now (TEST FAKE).
    h.calendar.failNext("deleteEvent", 2, new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" }));
    expect(await run(h)).toEqual(["superseded", "projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(1);
    let row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(JSON.parse(row!.uncertain_calendars ?? "[]")).toEqual([[OUTFIT_CALENDAR, old.eventId]]);
    // The owner switches back to the first calendar: the event standing there is the board's, not his note.
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: OUTFIT_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 1);
    expect(await run(h)).toEqual(["superseded", "projected"]);
    expect(live(h, owner, NEW_CALENDAR)).toHaveLength(0);
    const back = live(h, owner, OUTFIT_CALENDAR);
    expect(back).toHaveLength(1);
    const projected = await projection(h, owner);
    expect(back[0]!.description).toBe(managedBlock(projected.managed_text!));
    row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
  });

  it("SYNTHETIC: an event left in an earlier outfit calendar is cleaned up by a later attempt on its own, without any new board change", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // Every removal in the previous calendar is refused for now (TEST FAKE).
    h.calendar.failNext("deleteEvent", 2, new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" }));
    expect(await run(h)).toEqual(["superseded", "projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(1);
    // Delivered to the new calendar: the board's projection does not read as pending while the cleanup waits.
    expect((await current(h, owner)).calendarProjection.state).toBe("projected");
    // Access returns; no board change, setting or restore follows. The kept effect retries the cleanup itself.
    h.clock.advanceMinutes(31);
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(0);
    expect(live(h, owner, NEW_CALENDAR)).toHaveLength(1);
    const row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
    expect(await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND kind = 'calendar.project_board' AND state IN ('pending', 'in_progress')", owner.userId)).toEqual({ n: 0 });
  });

  it("SYNTHETIC: the cleanup of an event left in an earlier calendar keeps retrying with a capped backoff past the attempt limit, and stays recorded until it succeeds", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // TEST FAKE: removals in the previous calendar are refused until `locked` is cleared.
    const deleteEvent = h.calendar.deleteEvent.bind(h.calendar);
    let locked = true;
    h.calendar.deleteEvent = async (userId, calendarId, eventId, etag) => {
      if (locked && calendarId === OUTFIT_CALENDAR) throw new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" });
      return deleteEvent(userId, calendarId, eventId, etag);
    };
    expect(await run(h)).toEqual(["superseded", "projected"]);
    const pending = async () => first<{ effect_id: string; available_at: string; attempts: number }>(h.db, "SELECT effect_id, available_at, attempts FROM effects WHERE user_id = ? AND kind = 'calendar.project_board' AND state = 'pending'", owner.userId);
    let previousDelay = 0;
    // Twelve more attempts, past the projector's attempt limit of eight: each is scheduled again, never given up.
    for (let i = 0; i < 12; i++) {
      const effect = await pending();
      expect(effect, `attempt ${i}: the cleanup is still scheduled`).not.toBeNull();
      const delay = Date.parse(effect!.available_at) - h.clock.now();
      expect(delay).toBeGreaterThanOrEqual(previousDelay);
      expect(delay).toBeLessThanOrEqual(24 * 60 * 60_000);
      previousDelay = delay;
      // TEST-WRITTEN: the retry is made due now rather than waiting out the backoff (the day must not pass).
      await h.db.prepare("UPDATE effects SET available_at = ? WHERE user_id = ? AND effect_id = ?").bind(new Date(h.clock.now()).toISOString(), owner.userId, effect!.effect_id).run();
      expect(await run(h)).toEqual(["projected"]);
      expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(1);
      const row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
      expect(row!.uncertain_calendars).not.toBeNull();
    }
    expect(previousDelay).toBe(24 * 60 * 60_000);
    expect((await pending())!.attempts).toBeGreaterThan(8);
    // Access returns: the next attempt removes the event and the entry.
    locked = false;
    await h.db.prepare("UPDATE effects SET available_at = ? WHERE user_id = ? AND state = 'pending'").bind(new Date(h.clock.now()).toISOString(), owner.userId).run();
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(0);
    expect(await pending()).toBeNull();
  });

  it("SYNTHETIC: an ordinary writer error while cleaning up an earlier calendar does not stop delivery or the cleanup retries, past the attempt limit", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: NEW_CALENDAR } } } } });
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    // TEST FAKE: the move's removal is refused (so the entry is recorded), then every later removal there fails
    // with a plain connection error that is no CalendarApiError, until `broken` is cleared.
    const deleteEvent = h.calendar.deleteEvent.bind(h.calendar);
    let refusals = 1;
    let broken = true;
    h.calendar.deleteEvent = async (userId, calendarId, eventId, etag) => {
      if (calendarId === OUTFIT_CALENDAR && refusals > 0) { refusals--; throw new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" }); }
      if (calendarId === OUTFIT_CALENDAR && broken) throw new Error("TEST FAKE: connection reset");
      return deleteEvent(userId, calendarId, eventId, etag);
    };
    expect(await run(h)).toEqual(["superseded", "projected"]);
    const pending = async () => first<{ effect_id: string; attempts: number; last_error: string | null }>(h.db, "SELECT effect_id, attempts, last_error FROM effects WHERE user_id = ? AND kind = 'calendar.project_board' AND state = 'pending'", owner.userId);
    for (let i = 0; i < 10; i++) {
      const effect = await pending();
      expect(effect, `attempt ${i}: the cleanup is still scheduled`).not.toBeNull();
      // TEST-WRITTEN: the retry is made due now rather than waiting out the backoff.
      await h.db.prepare("UPDATE effects SET available_at = ? WHERE user_id = ? AND effect_id = ?").bind(new Date(h.clock.now()).toISOString(), owner.userId, effect!.effect_id).run();
      expect(await run(h)).toEqual(["projected"]);
      expect(live(h, owner, NEW_CALENDAR)).toHaveLength(1);
      expect((await projection(h, owner)).last_error).toContain("could not be cleaned up yet (error)");
    }
    expect((await pending())!.attempts).toBeGreaterThan(8);
    broken = false;
    await h.db.prepare("UPDATE effects SET available_at = ? WHERE user_id = ? AND state = 'pending'").bind(new Date(h.clock.now()).toISOString(), owner.userId).run();
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner, OUTFIT_CALENDAR)).toHaveLength(0);
    expect(await pending()).toBeNull();
  });

  it("SYNTHETIC: a fence on a cancelled event in an earlier calendar whose read-back fails is not taken as a fence: the entry stays until a later read-back verifies it", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    // TEST FAKE state: a cancelled event of ours in an earlier calendar; TEST-WRITTEN row state: a write of ours to
    // it may still land.
    const strayId = "gdbabc0123strb1";
    await h.calendar.insertEvent(owner.userId, NEW_CALENDAR, strayId, { summary: "older", description: "", privateProperties: { garderobeBoard: doc.boardId, garderobeRevision: "1" }, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null });
    h.calendar.externalDelete(owner.userId, NEW_CALENDAR, strayId);
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[NEW_CALENDAR, strayId]]), owner.userId).run();
    // TEST FAKE: the read-back after the fence patch (the second read of that event) fails.
    const getEvent = h.calendar.getEvent.bind(h.calendar);
    let reads = 0;
    let failReadBack = true;
    h.calendar.getEvent = async (userId, calendarId, id) => {
      if (calendarId === NEW_CALENDAR && id === strayId && failReadBack && ++reads === 2) throw new Error("TEST FAKE: connection reset");
      return getEvent(userId, calendarId, id);
    };
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["projected"]);
    expect(h.calendar.log.some((l) => l.op === "patchEvent" && l.eventId === strayId && l.outcome === "ok")).toBe(true);
    const uncertain = async () => (await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId))!.uncertain_calendars;
    expect(JSON.parse((await uncertain()) ?? "[]")).toEqual([[NEW_CALENDAR, strayId]]);
    // The next attempt reads the fence back and only then settles the entry.
    failReadBack = false;
    await h.db.prepare("UPDATE effects SET available_at = ? WHERE user_id = ? AND state = 'pending'").bind(new Date(h.clock.now()).toISOString(), owner.userId).run();
    expect(await run(h)).toEqual(["projected"]);
    expect(await uncertain()).toBeNull();
  });

  it("keeps an owner's note that reads like a line of an unverified write of ours when it stands above or below the outfits", () => {
    const previous = ["Tuesday: 12 °C at 08:00, 19 °C peak.", "", "1. Pink oxford with grey chino", "Warm against cool.", "Shirt: Pink oxford"].join("\n");
    const next = previous.replace("grey chino", "walnut chino");
    // An unverified write of ours carried, between its outfit lines, the same line the owner wrote above and below the outfits.
    const attempted = ["Tuesday: 12 °C at 08:00, 19 °C peak.", "", "1. Pink oxford with grey chino", "Bring the umbrella.", "Warm against cool.", "Shirt: Pink oxford"].join("\n");
    const remote = ["Bring the umbrella.", "Tuesday: 12 °C at 08:00, 19 °C peak.", "", "1. Pink oxford with grey chino", "MY OWN EDIT", "Warm against cool.", "Shirt: Pink oxford", "Bring the umbrella."].join("\n");
    expect(mergeDescription(remote, previous, managedBlock(next), [attempted])).toBe(["Bring the umbrella.", managedBlock(next), "MY OWN EDIT", "Bring the umbrella."].join("\n"));
    // Without markers, the same line among the outfits is not known to be ours (only an unverified write had it): it stays.
    const within = ["Tuesday: 12 °C at 08:00, 19 °C peak.", "", "1. Pink oxford with grey chino", "Bring the umbrella.", "MY OWN EDIT", "Warm against cool.", "Shirt: Pink oxford"].join("\n");
    expect(mergeDescription(within, previous, managedBlock(next), [attempted])).toBe([managedBlock(next), "Bring the umbrella.", "MY OWN EDIT"].join("\n"));
    // A description that now holds only the owner's note, which an unverified write of ours also carried: it survives.
    expect(mergeDescription("Bring the umbrella.", previous, managedBlock(next), [attempted])).toBe(`${managedBlock(next)}\n\nBring the umbrella.`);
  });

  it("SYNTHETIC: the history of unverified texts is not cut short while a write of ours is still outstanding", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    // TEST FAKE: a calendar that stays inaccessible; TEST-WRITTEN row state: a write of ours there is
    // outstanding, and eight unverified texts are already recorded.
    const LOCKED = "locked-outfits@test.calendar";
    const getEvent = h.calendar.getEvent.bind(h.calendar);
    h.calendar.getEvent = async (userId, calendarId, eventId) => {
      if (calendarId === LOCKED) throw new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: false, reason: "forbidden" });
      return getEvent(userId, calendarId, eventId);
    };
    const history = Array.from({ length: 8 }, (_, i) => `UNVERIFIED ${i}`);
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ?, attempted_text = ? WHERE user_id = ?").bind(JSON.stringify([[LOCKED, "lockedevent0001"]]), JSON.stringify(history), owner.userId).run();
    h.clock.advanceMinutes(2);
    await swap(owner, doc, 0);
    expect(await run(h)).toEqual(["projected"]);
    const row = await first<{ attempted_text: string | null }>(h.db, "SELECT attempted_text FROM calendar_projections WHERE user_id = ?", owner.userId);
    const kept: string[] = JSON.parse(row!.attempted_text ?? "[]");
    expect(kept).toHaveLength(9);
    expect(kept).toContain("UNVERIFIED 7");
  });
});
