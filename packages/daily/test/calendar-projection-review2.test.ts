/**
 * Regressions for the second change review of the Calendar projector: settlement fenced by the lease
 * token, and a delete that fails keeping what was delivered.
 *
 * The projector, the command service and D1 (the real local D1 harness) are real. The stand-in is
 * `FakeGoogleCalendar`, the labelled TEST FAKE of the Google Calendar HTTP service behind the adapter
 * port. One test writes the lease token directly (TEST-WRITTEN) to stand for another projector taking the
 * lease. Nothing here shows Google's behaviour.
 */
import { describe, expect, it } from "vitest";
import { all, claimDueEffects, first } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { CalendarApiError, projectCalendarEffects } from "../src/index.ts";
import { CallAbandonedError, definitelyNotDeleted, LeaseLostError, LeaseTooShortError, leasedWriter, PROJECTION_LEASE_MS, ProjectionLease, settleClaimed } from "../src/calendar/projector.ts";
import { CalendarNotConnectedError } from "../src/ports.ts";
import { FakeGoogleCalendar } from "../src/testing/fake-calendar.ts";
import { compose, createDailyHarness, MILD_DAY, OUTFIT_CALENDAR, realOwner, type DailyHarness } from "./helpers.ts";

const DAY = "2026-09-16";

async function setup(): Promise<{ h: DailyHarness; owner: TestOwner }> {
  const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
  const owner = await realOwner(h);
  h.weather.setForecast(DAY, MILD_DAY);
  return { h, owner };
}
const run = async (h: DailyHarness) => (await projectCalendarEffects(h.deps, { nowMs: h.clock.now() })).map((o) => o.outcome);
const live = (h: DailyHarness, owner: TestOwner) => h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).filter((e) => e.status !== "cancelled");
const writes = (h: DailyHarness) => h.calendar.log.filter((l) => l.op === "insertEvent" || l.op === "patchEvent" || l.op === "deleteEvent");

describe("settlement is fenced by the projection lease", () => {
  it("a projector that lost its lease after its last call neither settles the effect nor records the projection", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    // During the read-back after the insert, another projector (TEST-WRITTEN token) takes the lease.
    h.calendar.delayNext("insertEvent", () =>
      h.calendar.delayNext("getEvent", async () => {
        await h.db.prepare("UPDATE calendar_projections SET lock_token = 'TEST-OTHER-PROJECTOR', lock_until = ? WHERE user_id = ?").bind("2099-01-01T00:00:00Z", owner.userId).run();
      }),
    );
    expect(await run(h)).toEqual(["busy"]);
    const effects = await all<{ state: string }>(h.db, "SELECT state FROM effects WHERE user_id = ? AND kind = 'calendar.project_board'", owner.userId);
    expect(effects.map((e) => e.state)).not.toContain("projected");
    const row = await first<{ projected_revision: number | null; lock_token: string }>(h.db, "SELECT projected_revision, lock_token FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row).toMatchObject({ projected_revision: null, lock_token: "TEST-OTHER-PROJECTOR" });
  });
});

describe("a missing event is fenced before anything is concluded from its absence", () => {
  it("SYNTHETIC: a fence of ours whose removal failed is removed by the next run, and the owner's deletion is still recognised", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    // TEST FAKE state: the owner deleted the event and Google no longer returns it; TEST-WRITTEN row state:
    // a write of ours to it may still land.
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId, { purge: true });
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, event.eventId]]), owner.userId).run();
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    // The claim lands; the removal of the fence gets no answer it can trust (TEST FAKE).
    h.calendar.failNext("deleteEvent", 1, new CalendarApiError("TEST FAKE: backend error", { status: 503, retryable: true }));
    expect(await run(h)).toEqual(["retry"]);
    expect(live(h, owner)).toHaveLength(1); // the fence stands for now
    h.clock.advanceMinutes(31);
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);
    expect(live(h, owner)).toHaveLength(0);
    const row = await first<{ state: string; suppression_reason: string }>(h.db, "SELECT state, suppression_reason FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row).toEqual({ state: "suppressed", suppression_reason: "deleted_externally" });
  });

  it("SYNTHETIC: a day the owner deleted is skipped only once writes of ours in other calendars are fenced too", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId);
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);
    // TEST FAKE state: an event of ours in another calendar; TEST-WRITTEN row state: a write of ours to it may land.
    const other = "older-outfits@test.calendar";
    await h.calendar.insertEvent(owner.userId, other, event.eventId, { summary: "older", description: "", privateProperties: { garderobeBoard: doc.boardId, garderobeRevision: "1" }, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null });
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[other, event.eventId]]), owner.userId).run();
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[1]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["skipped_deleted_externally"]);
    expect(h.calendar.allEvents(owner.userId, other).map((e) => e.status)).toEqual(["cancelled"]);
    const row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
  });
  it("SYNTHETIC: a day the owner deleted is not skipped while a restore of ours may still land: the restored event is removed first", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId);
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);
    // TEST-WRITTEN row state: a restore of ours may still land; TEST FAKE state: it has landed.
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, event.eventId]]), owner.userId).run();
    h.calendar.externalEdit(owner.userId, OUTFIT_CALENDAR, event.eventId, (e) => { e.status = "confirmed"; });
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[1]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["skipped_deleted_externally"]);
    expect(live(h, owner)).toHaveLength(0);
    const row = await first<{ state: string; suppression_reason: string; uncertain_calendars: string | null }>(h.db, "SELECT state, suppression_reason, uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row).toEqual({ state: "suppressed", suppression_reason: "deleted_externally", uncertain_calendars: null });
  });
  // TEST-WRITTEN row state: a write of ours to the event may still land.
  const markUncertain = (h: DailyHarness, owner: TestOwner, eventId: string) => h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, eventId]]), owner.userId).run();

  it("SYNTHETIC: an event that looks deleted by the owner is fenced first, so a late insert of ours cannot recreate it", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    await markUncertain(h, owner, event.eventId);
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId, { purge: true });
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    const before = h.calendar.log.length;
    expect(await run(h)).toEqual(["suppressed_deleted_externally"]);
    // The ID was claimed and removed before the owner's deletion was recorded.
    expect(h.calendar.log.slice(before).filter((l) => l.outcome === "ok" && l.op !== "getEvent").map((l) => l.op)).toEqual(["insertEvent", "deleteEvent"]);
    expect(live(h, owner)).toHaveLength(0);
    // A late insert of ours finds the ID taken.
    await expect(h.calendar.insertEvent(owner.userId, OUTFIT_CALENDAR, event.eventId, { summary: "late", description: "", privateProperties: {}, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null })).rejects.toMatchObject({ detail: { reason: "duplicate" } });
    const row = await first<{ state: string; suppression_reason: string; uncertain_calendars: string | null }>(h.db, "SELECT state, suppression_reason, uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row).toMatchObject({ state: "suppressed", suppression_reason: "deleted_externally" });
  });

  it("SYNTHETIC: a pause over an event missing while a write of ours may still land fences it and records the pause, not an owner deletion", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    await markUncertain(h, owner, event.eventId);
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId, { purge: true });
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    expect(await run(h)).toEqual(["removed"]);
    expect(live(h, owner)).toHaveLength(0);
    const row = await first<{ suppression_reason: string; uncertain_calendars: string | null }>(h.db, "SELECT suppression_reason, uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row).toEqual({ suppression_reason: "pause", uncertain_calendars: null });
  });

  it("SYNTHETIC: an ID taken although no event can be read under it counts as fenced, so the removal completes instead of retrying forever", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    await markUncertain(h, owner, event.eventId);
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId, { reserveId: true });
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    expect(await run(h)).toEqual(["removed"]);
    const inserts = h.calendar.log.filter((l) => l.op === "insertEvent");
    expect(inserts.map((l) => l.reason)).toEqual([null, "duplicate"]); // the first delivery, then one claim attempt
    const row = await first<{ state: string; uncertain_calendars: string | null }>(h.db, "SELECT state, uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row).toEqual({ state: "suppressed", uncertain_calendars: null });
  });

  it("SYNTHETIC: a write of ours that may still land under an earlier event ID in this calendar is fenced, and an event of ours standing there is removed, before the day is projected", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    // TEST FAKE state: an earlier event of ours under another ID (a replacement ID left behind), and
    // TEST-WRITTEN row state saying a write of ours to it may still land.
    const strayId = "gdbabc0123stra1";
    await h.calendar.insertEvent(owner.userId, OUTFIT_CALENDAR, strayId, { summary: "older", description: "", privateProperties: { garderobeBoard: doc.boardId, garderobeRevision: "1" }, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null });
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, strayId]]), owner.userId).run();
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner).map((e) => e.eventId)).toEqual([event.eventId]);
    const stray = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).find((e) => e.eventId === strayId)!;
    expect(stray.status).toBe("cancelled");
    // A late insert under the earlier ID finds it taken.
    await expect(h.calendar.insertEvent(owner.userId, OUTFIT_CALENDAR, strayId, { summary: "late", description: "", privateProperties: {}, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null })).rejects.toMatchObject({ detail: { reason: "duplicate" } });
    const row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
  });

  it("SYNTHETIC: an earlier event of ours that another client removes just before our delete is fenced, not taken as gone", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    // TEST FAKE state: an earlier event of ours under another ID; TEST-WRITTEN row state: a write of ours to it may land.
    const strayId = "gdbabc0123stra2";
    await h.calendar.insertEvent(owner.userId, OUTFIT_CALENDAR, strayId, { summary: "older", description: "", privateProperties: { garderobeBoard: doc.boardId, garderobeRevision: "1" }, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null });
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, strayId]]), owner.userId).run();
    // Another client removes it (TEST FAKE: purged) between our read and our delete; the delete still answers
    // success, as the port treats 404/410 on delete.
    h.calendar.delayNext("deleteEvent", () => h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, strayId, { purge: true }));
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["projected"]);
    expect(live(h, owner).map((e) => e.eventId)).toEqual([event.eventId]);
    // The vanished ID was claimed and removed again, so a late insert of ours under it finds it taken.
    await expect(h.calendar.insertEvent(owner.userId, OUTFIT_CALENDAR, strayId, { summary: "late", description: "", privateProperties: {}, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null })).rejects.toMatchObject({ detail: { reason: "duplicate" } });
    const row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
  });

  it("SYNTHETIC: a not-found answer while an earlier event is being fenced is read again, not taken as a failed delivery", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    // TEST FAKE state: an event under an earlier ID that no longer carries our mark; TEST-WRITTEN row state: a write may land.
    const strayId = "gdbabc0123stra3";
    await h.calendar.insertEvent(owner.userId, OUTFIT_CALENDAR, strayId, { summary: "older", description: "", privateProperties: {}, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null });
    await h.db.prepare("UPDATE calendar_projections SET uncertain_calendars = ? WHERE user_id = ?").bind(JSON.stringify([[OUTFIT_CALENDAR, strayId]]), owner.userId).run();
    h.calendar.failNext("patchEvent", 1, new CalendarApiError("TEST FAKE: not found (HTTP 404)", { status: 404, retryable: false, reason: "not_found" }));
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["projected"]);
    const row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
  });

  it("SYNTHETIC: an event that vanishes just before our removal is claimed and removed again, so a late insert of ours cannot recreate it", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    // Another client purges the event between our read and our delete (TEST FAKE); the delete answers success.
    h.calendar.delayNext("deleteEvent", () => h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId, { purge: true }));
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    expect(await run(h)).toEqual(["removed"]);
    expect(live(h, owner)).toHaveLength(0);
    await expect(h.calendar.insertEvent(owner.userId, OUTFIT_CALENDAR, event.eventId, { summary: "late", description: "", privateProperties: {}, time: { kind: "all_day", localDate: DAY }, reminderMinutesBefore: null })).rejects.toMatchObject({ detail: { reason: "duplicate" } });
  });

  it("SYNTHETIC: an event another client deletes just before our removal gets a fresh fence value, so a late restore of ours against its etag fails", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    // Another client deletes the event between our read and our delete (TEST FAKE); our delete then answers
    // success without changing anything, and the cancelled event keeps the etag it got from that deletion.
    let cancelledEtag = "";
    h.calendar.delayNext("deleteEvent", () => {
      h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId);
      cancelledEtag = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).find((e) => e.eventId === event.eventId)!.etag;
    });
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    expect(await run(h)).toEqual(["removed"]);
    expect(live(h, owner)).toHaveLength(0);
    // A restore patch of ours made against the cancelled event's etag cannot land any more.
    await expect(h.calendar.patchEvent(owner.userId, OUTFIT_CALENDAR, event.eventId, { status: "confirmed" }, cancelledEtag)).rejects.toMatchObject({ detail: { reason: "precondition" } });
  });

  it("SYNTHETIC: a tombstone whose delete answered success but still stands is not taken as fenced: it is removed before the day settles", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    await markUncertain(h, owner, event.eventId);
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId, { purge: true });
    // TEST FAKE: the first delete answers success without removing anything (the tombstone stays live).
    const deleteEvent = h.calendar.deleteEvent.bind(h.calendar);
    let swallowed = false;
    h.calendar.deleteEvent = async (userId, calendarId, eventId, etag) => {
      if (!swallowed) { swallowed = true; return; }
      return deleteEvent(userId, calendarId, eventId, etag);
    };
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    expect(await run(h)).toEqual(["removed"]);
    expect(swallowed).toBe(true);
    expect(live(h, owner)).toHaveLength(0);
  });

  it("SYNTHETIC: on a move, an event in the previous calendar that another client deleted just before our delete gets a fresh fence value", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    let cancelledEtag = "";
    h.calendar.delayNext("deleteEvent", () => {
      h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId);
      cancelledEtag = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).find((e) => e.eventId === event.eventId)!.etag;
    });
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { outfitCalendarId: "outfits-moved@test.calendar" } } } } });
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["projected"]);
    await expect(h.calendar.patchEvent(owner.userId, OUTFIT_CALENDAR, event.eventId, { status: "confirmed" }, cancelledEtag)).rejects.toMatchObject({ detail: { reason: "precondition" } });
  });

  it("SYNTHETIC: an ID found taken by a cancelled event is fenced by moving that event's etag on, not taken as fenced as it stands", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    await markUncertain(h, owner, event.eventId);
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, event.eventId);
    const cancelledEtag = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).find((e) => e.eventId === event.eventId)!.etag;
    // TEST FAKE: the first read answers "no event" (as Google does for a deleted event), so the projector
    // tries to claim the ID and finds it taken by the cancelled event.
    const getEvent = h.calendar.getEvent.bind(h.calendar);
    let hidden = false;
    h.calendar.getEvent = async (userId, calendarId, eventId) => {
      if (!hidden && eventId === event.eventId) { hidden = true; return null; }
      return getEvent(userId, calendarId, eventId);
    };
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    expect(await run(h)).toEqual(["removed"]);
    expect(hidden).toBe(true);
    // A restore patch of ours conditioned on the cancelled event's etag cannot land any more.
    await expect(h.calendar.patchEvent(owner.userId, OUTFIT_CALENDAR, event.eventId, { status: "confirmed" }, cancelledEtag)).rejects.toMatchObject({ detail: { reason: "precondition" } });
  });
});

describe("a call given up on ends the run", () => {
  it("SYNTHETIC: an abandoned insert that lands after the board was paused and its removal settled is refused, so no event is left behind", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    h.calendar.callDeadlineMs = 50; // TEST FAKE: a short promised deadline so the give-up happens quickly
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.calendar.delayNext("insertEvent", () => held); // the insert stays in flight until the test releases it
    expect(await run(h)).toEqual(["retry"]);
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    h.clock.advanceMinutes(2);
    // No event can be read, yet the insert may still land: the ID is claimed and removed before settling.
    expect(await run(h)).toContain("removed");
    expect(live(h, owner)).toHaveLength(0);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live(h, owner)).toHaveLength(0);
    const inserts = h.calendar.log.filter((l) => l.op === "insertEvent");
    expect(inserts.map((l) => l.reason)).toContain("duplicate");
    const row = await first<{ uncertain_calendars: string | null; state: string }>(h.db, "SELECT uncertain_calendars, state FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row).toMatchObject({ uncertain_calendars: null, state: "suppressed" });
  });

  it("SYNTHETIC: a late insert of ours that lands just before the claim is read again and removed, not taken for a reserved ID", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    h.calendar.callDeadlineMs = 50; // TEST FAKE: a short promised deadline so the give-up happens quickly
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.calendar.delayNext("insertEvent", () => held); // the first insert stays in flight
    expect(await run(h)).toEqual(["retry"]);
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    h.clock.advanceMinutes(2);
    // The late insert lands between the read that saw no event and the claim, so the claim is a duplicate.
    h.calendar.delayNext("insertEvent", async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(await run(h)).toContain("removed");
    expect(live(h, owner)).toHaveLength(0);
    expect(h.calendar.log.filter((l) => l.op === "insertEvent").map((l) => l.reason)).toContain("duplicate");
  });

  it("SYNTHETIC: an abandoned presentation patch cannot land after settings reverted, because the next run writes a fence instead of taking the event as current", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const delivered = live(h, owner)[0]!;
    expect(delivered.time).toMatchObject({ kind: "timed" });
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { presentation: "all_day" } } } } });
    // TEST-WRITTEN effect state: the delivered effect is offered again, as a redelivery would.
    await h.db.prepare("UPDATE effects SET state = 'pending', available_at = ? WHERE user_id = ? AND kind = 'calendar.project_board'").bind(new Date(h.clock.now()).toISOString(), owner.userId).run();
    h.calendar.callDeadlineMs = 50; // TEST FAKE: a short promised deadline so the give-up happens quickly
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.calendar.delayNext("patchEvent", () => held); // the all-day patch stays in flight
    expect(await run(h)).toEqual(["retry"]);
    await owner.exec("settings.update", { patch: { extensions: { daily: { calendar: { presentation: "timed" } } } } });
    h.clock.advanceMinutes(2);
    expect(await run(h)).toEqual(["projected"]);
    const fencedEvent = live(h, owner)[0]!;
    // The event already showed the wanted write, yet it was written again: its etag moved on.
    expect(fencedEvent.etag).not.toBe(delivered.etag);
    expect(fencedEvent.time).toMatchObject({ kind: "timed" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = live(h, owner)[0]!;
    expect(after.time).toMatchObject({ kind: "timed" });
    expect(after.etag).toBe(fencedEvent.etag);
    expect(h.calendar.log.filter((l) => l.op === "patchEvent").map((l) => l.reason)).toContain("precondition");
    const row = await first<{ uncertain_calendars: string | null }>(h.db, "SELECT uncertain_calendars FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.uncertain_calendars).toBeNull();
  });
  it("SYNTHETIC: an abandoned patch that lands after the next projector delivered a newer revision fails its precondition and changes nothing", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, DAY)).board!;
    expect(await run(h)).toEqual(["projected"]);
    h.calendar.callDeadlineMs = 50; // TEST FAKE: a short promised deadline so the give-up happens quickly
    // The next patch is held in flight (never answered in time) until the test releases it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.calendar.delayNext("patchEvent", () => held);
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    expect(await run(h)).toEqual(["retry"]);
    // The lease runs out; the next projector delivers a newer revision.
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[1]!.optionId, role: "top" });
    h.clock.advanceMinutes(2);
    expect(await run(h)).toContain("projected");
    const delivered = live(h, owner)[0]!;
    expect(delivered.privateProperties.garderobeRevision).toBe("3");
    // Now the abandoned write lands: its If-Match names the etag it read, which is no longer current.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = live(h, owner)[0]!;
    expect(after.privateProperties.garderobeRevision).toBe("3");
    expect(after.etag).toBe(delivered.etag);
    const patches = h.calendar.log.filter((l) => l.op === "patchEvent");
    expect(patches.every((p) => p.ifMatch !== null)).toBe(true);
    expect(patches.find((p) => p.revision === "2")?.reason).toBe("precondition");
  });

  it("SYNTHETIC: every delete is conditional, so a late delete cannot remove an event written after it was read", async () => {
    const fake = new FakeGoogleCalendar();
    const write = { summary: "s", description: "d", privateProperties: { garderobeRevision: "1" }, time: { kind: "all_day" as const, localDate: "2026-09-16" }, reminderMinutesBefore: null };
    const first = await fake.insertEvent("u1", "cal", "gdbabcdef", write);
    await fake.patchEvent("u1", "cal", "gdbabcdef", { description: "newer" }, first.etag);
    await expect(fake.deleteEvent("u1", "cal", "gdbabcdef", first.etag)).rejects.toMatchObject({ detail: { reason: "precondition" } });
    expect((await fake.getEvent("u1", "cal", "gdbabcdef"))!.status).toBe("confirmed");
    // The leased writer passes the etag through.
    const at = 1_000_000;
    const w = leasedWriter(fake, { hold: async () => at + PROJECTION_LEASE_MS, keepUntilExpiry: () => undefined }, () => at);
    await expect(w.deleteEvent("u1", "cal", "gdbabcdef", first.etag)).rejects.toMatchObject({ detail: { reason: "precondition" } });
    expect(fake.log.filter((l) => l.op === "deleteEvent").map((l) => l.ifMatch)).toEqual([first.etag, first.etag]);
  });

  it("every delete the projector sends carries the etag it read", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    expect(await run(h)).toEqual(["removed"]);
    const deletes = h.calendar.log.filter((l) => l.op === "deleteEvent");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.ifMatch).not.toBeNull();
  });

  it("SYNTHETIC: while a removal of ours may still land, an event that already shows the wanted write is written again, so the late delete's etag is stale", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const event = live(h, owner)[0]!;
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    // The delete gets no answer it can trust (503) and has not landed yet: the intent stays.
    h.calendar.failNext("deleteEvent", 1, new CalendarApiError("TEST FAKE: backend error", { status: 503, retryable: true }));
    expect(await run(h)).toEqual(["retry"]);
    await owner.exec("service.resume", {});
    h.clock.advanceMinutes(31);
    expect(await run(h)).toContain("projected");
    const now = live(h, owner)[0]!;
    // The event already carried the wanted write, yet it was written again: its etag moved on.
    expect(now.etag).not.toBe(event.etag);
    // The late delete (conditional on the etag it read) now fails and removes nothing.
    await expect(h.calendar.deleteEvent(owner.userId, OUTFIT_CALENDAR, event.eventId, event.etag)).rejects.toMatchObject({ detail: { reason: "precondition" } });
    expect(live(h, owner)).toHaveLength(1);
    const row = await first<{ removing_event_id: string | null }>(h.db, "SELECT removing_event_id FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(row!.removing_event_id).toBeNull();
  });

  it("after a write is given up no further call starts, so the abandoned write cannot overtake a later one", async () => {
    const fake = new FakeGoogleCalendar();
    fake.callDeadlineMs = 50; // TEST FAKE: a short promised deadline so the give-up happens quickly
    let kept = false;
    const at = 1_000_000;
    // TEST STAND-IN lease: always renewable.
    const w = leasedWriter(fake, { hold: async () => at + PROJECTION_LEASE_MS, keepUntilExpiry: () => { kept = true; } }, () => at);
    fake.delayNext("patchEvent", () => new Promise<void>(() => undefined)); // never answers
    await expect(w.patchEvent("u1", "cal", "gdbabcdef", {} as never, null)).rejects.toMatchObject({ detail: { reason: "network" } });
    expect(kept).toBe(true);
    await expect(w.getEvent("u1", "cal", "gdbabcdef")).rejects.toBeInstanceOf(CallAbandonedError);
    await expect(w.deleteEvent("u1", "cal", "gdbabcdef")).rejects.toBeInstanceOf(CallAbandonedError);
    expect(fake.log.map((l) => l.op)).toEqual(["patchEvent"]);
    expect(definitelyNotDeleted(new CallAbandonedError())).toBe(true);
  });

  it("after a given-up write the effect is not offered again until the retained lease has run out", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    h.calendar.callDeadlineMs = 50; // TEST FAKE: a short promised deadline so the give-up happens quickly
    h.calendar.delayNext("insertEvent", () => new Promise<void>(() => undefined)); // never answers
    expect(await run(h)).toEqual(["retry"]);
    const effect = await first<{ available_at: string }>(h.db, "SELECT available_at FROM effects WHERE user_id = ? AND kind = 'calendar.project_board' AND state = 'pending'", owner.userId);
    const lease = await first<{ lock_until: string | null; lock_token: string | null }>(h.db, "SELECT lock_until, lock_token FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(lease!.lock_token).not.toBeNull(); // kept, not released
    expect(Date.parse(effect!.available_at)).toBeGreaterThan(Date.parse(lease!.lock_until!));
    // Nothing is claimed while the lease stands, so no attempt is spent on a projection that would be busy.
    h.clock.advanceMinutes(0.5);
    expect(await run(h)).toEqual([]);
    h.clock.advanceMinutes(2);
    expect(await run(h)).toEqual(["projected"]);
  });
});

describe("settling without the lease is fenced by the effect's claim", () => {
  it("a run that could not take the lease never resets an effect that was settled or reclaimed meanwhile", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    const [claimed] = await claimDueEffects(h.db, { nowMs: h.clock.now(), kinds: ["calendar.project_board"] });
    expect(claimed).toBeDefined();
    const state = async () => (await first<{ state: string; attempts: number }>(h.db, "SELECT state, attempts FROM effects WHERE user_id = ? AND effect_id = ?", owner.userId, claimed!.effectId))!;
    const retry = { state: "retry" as const, error: "another projection of this event is in progress", retryAtMs: h.clock.now() + 15_000 };
    // TEST-WRITTEN: the lease holder settled it as projected meanwhile.
    await h.db.prepare("UPDATE effects SET state = 'projected', claimed_until = NULL WHERE effect_id = ?").bind(claimed!.effectId).run();
    await settleClaimed(h.db, claimed!, retry, h.clock.now());
    expect((await state()).state).toBe("projected");
    // TEST-WRITTEN: reclaimed by another run (one more attempt).
    await h.db.prepare("UPDATE effects SET state = 'in_progress', attempts = attempts + 1 WHERE effect_id = ?").bind(claimed!.effectId).run();
    await settleClaimed(h.db, claimed!, retry, h.clock.now());
    expect((await state()).state).toBe("in_progress");
    // Its own standing claim is settled.
    await settleClaimed(h.db, { ...claimed!, attempts: claimed!.attempts + 1 }, retry, h.clock.now());
    expect((await state()).state).toBe("pending");
  });
});

describe("a delete that never started withdraws its removal intent", () => {
  it("counts a refusal by the lease guard, no connection and a client error as not deleted; a server error, a timeout or no answer as uncertain", () => {
    expect(definitelyNotDeleted(new LeaseTooShortError(1_000, 30_000))).toBe(true);
    expect(definitelyNotDeleted(new LeaseLostError())).toBe(true);
    expect(definitelyNotDeleted(new CalendarNotConnectedError())).toBe(true);
    expect(definitelyNotDeleted(new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: true }))).toBe(true);
    expect(definitelyNotDeleted(new CalendarApiError("TEST FAKE: backend error", { status: 503, retryable: true }))).toBe(false);
    expect(definitelyNotDeleted(new CalendarApiError("TEST FAKE: request timeout", { status: 408, retryable: true }))).toBe(false);
    expect(definitelyNotDeleted(new CalendarApiError("TEST FAKE: no answer", { status: null, retryable: true, reason: "network" }))).toBe(false);
  });

  it("withdraws the intent after its own lease was lost, but never while another projector holds a live lease", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const row = await first<{ target_key: string }>(h.db, "SELECT target_key FROM calendar_projections WHERE user_id = ?", owner.userId);
    const lease = (await ProjectionLease.acquire(h.db, owner.userId, row!.target_key, () => h.clock.now()))!;
    const intent = async () => (await first<{ removing_event_id: string | null }>(h.db, "SELECT removing_event_id FROM calendar_projections WHERE user_id = ?", owner.userId))!.removing_event_id;
    // The intent recorded by this projector; then (TEST-WRITTEN) another projector took the lease and its lease ran out.
    const token = (await first<{ lock_token: string }>(h.db, "SELECT lock_token FROM calendar_projections WHERE user_id = ?", owner.userId))!.lock_token;
    await lease.markIntent("TEST-EVENT");
    await h.db.prepare("UPDATE calendar_projections SET lock_token = 'TEST-OTHER', lock_until = '2000-01-01T00:00:00Z' WHERE user_id = ?").bind(owner.userId).run();
    await lease.withdrawIntent("TEST-EVENT");
    expect(await intent()).toBeNull();
    // Our own intent while another projector holds a live lease (TEST-WRITTEN): left alone.
    await h.db.prepare("UPDATE calendar_projections SET removing_event_id = 'TEST-EVENT', removing_token = ?, lock_token = 'TEST-OTHER', lock_until = '2099-01-01T00:00:00Z' WHERE user_id = ?").bind(token, owner.userId).run();
    await lease.withdrawIntent("TEST-EVENT");
    expect(await intent()).toBe("TEST-EVENT");
    // An intent another projector recorded for the same event after our lease ran out (TEST-WRITTEN): never
    // withdrawn by our delayed handler, even once that projector's lease ran out or was released too.
    await h.db.prepare("UPDATE calendar_projections SET removing_event_id = 'TEST-EVENT', removing_token = 'TEST-OTHER', lock_token = NULL, lock_until = NULL WHERE user_id = ?").bind(owner.userId).run();
    await lease.withdrawIntent("TEST-EVENT");
    expect(await intent()).toBe("TEST-EVENT");
    // Another event's intent is never touched.
    await lease.withdrawIntent("TEST-OTHER-EVENT");
    expect(await intent()).toBe("TEST-EVENT");
  });
});

describe("a delete that fails keeps what was delivered", () => {
  it("after a refused removal and a resume, the owner's own deletion is recognised and the event is not recreated", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const eventId = live(h, owner)[0]!.eventId;
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    h.calendar.failNext("deleteEvent", 1, new CalendarApiError("TEST FAKE: forbidden", { status: 403, retryable: true }));
    expect(await run(h)).toEqual(["retry"]);
    expect(live(h, owner)).toHaveLength(1);
    const kept = await first<{ projected_revision: number | null; removing_event_id: string | null }>(h.db, "SELECT projected_revision, removing_event_id FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(kept).toEqual({ projected_revision: 1, removing_event_id: null });

    await owner.exec("service.resume", {});
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, eventId, { purge: true });
    h.clock.advanceMinutes(31);
    const outcomes = await run(h);
    expect(outcomes).toContain("suppressed_deleted_externally");
    expect(outcomes).not.toContain("projected");
    expect(live(h, owner)).toHaveLength(0);
    expect(writes(h).filter((w) => w.op === "insertEvent")).toHaveLength(1);
  });

  it("a server error after which the event is gone is not taken for the owner's deletion: after a resume the event is delivered again", async () => {
    const { h, owner } = await setup();
    await compose(h, owner, DAY);
    expect(await run(h)).toEqual(["projected"]);
    const eventId = live(h, owner)[0]!.eventId;
    h.clock.advanceMinutes(2);
    await owner.exec("service.pause", { from: DAY, resumeOn: null });
    // The delete commits but the answer is a 503: stood for by removing the event and failing the call.
    h.calendar.failNext("deleteEvent", 1, new CalendarApiError("TEST FAKE: backend error after commit", { status: 503, retryable: true }));
    h.calendar.delayNext("deleteEvent", () => {
      h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, eventId, { purge: true });
    });
    expect(await run(h)).toEqual(["retry"]);
    const kept = await first<{ removing_event_id: string | null }>(h.db, "SELECT removing_event_id FROM calendar_projections WHERE user_id = ?", owner.userId);
    expect(kept?.removing_event_id).toBe(eventId);

    await owner.exec("service.resume", {});
    h.clock.advanceMinutes(31);
    const outcomes = await run(h);
    expect(outcomes).not.toContain("suppressed_deleted_externally");
    expect(outcomes).toContain("projected");
    expect(live(h, owner)).toHaveLength(1);
  });
});
