/** Proves the semantics of the TEST FAKE calendar that other tests rely on. */
import { describe, expect, it } from "vitest";
import { CalendarApiError, CalendarNotConnectedError } from "../src/ports.ts";
import type { CalendarEventRaw, ManagedEventWrite } from "../src/ports.ts";
import { FakeGoogleCalendar } from "../src/testing/fake-calendar.ts";

const USER = "user-1";
const CAL = "outfits";
const ID = "gdb0123456789abcdef0123456789abcdef01234567";

function write(revision: string, overrides: Partial<ManagedEventWrite> = {}): ManagedEventWrite {
  return {
    summary: "Outfits for Thursday",
    description: `Board revision ${revision}`,
    privateProperties: { boardId: "b1", revision },
    time: { kind: "timed", startsAt: "2026-10-01T05:00:00Z", endsAt: "2026-10-01T05:15:00Z", timezone: "Europe/Zurich" },
    reminderMinutesBefore: null,
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function reasonOf(error: unknown): string | undefined {
  expect(error).toBeInstanceOf(CalendarApiError);
  return (error as CalendarApiError).detail.reason;
}

function stored(fake: FakeGoogleCalendar) {
  const events = fake.allEvents(USER, CAL);
  const first = events[0];
  if (!first || events.length !== 1) throw new Error(`expected exactly one stored event, found ${events.length}`);
  return first;
}

describe("FakeGoogleCalendar (TEST FAKE)", () => {
  it("changes the etag on every write and returns null for an unknown event", async () => {
    const fake = new FakeGoogleCalendar();
    expect(await fake.getEvent(USER, CAL, ID)).toBeNull();

    const inserted = await fake.insertEvent(USER, CAL, ID, write("1"));
    expect(inserted).toEqual({ eventId: ID, etag: inserted.etag, status: "confirmed", summary: "Outfits for Thursday", description: "Board revision 1", privateProperties: { boardId: "b1", revision: "1" }, attendeeCount: 0 });
    expect((await fake.getEvent(USER, CAL, ID))?.etag).toBe(inserted.etag);

    const patched = await fake.patchEvent(USER, CAL, ID, { description: "Board revision 2", privateProperties: { revision: "2" } }, inserted.etag);
    const again = await fake.patchEvent(USER, CAL, ID, { description: "Board revision 2" }, patched.etag);
    expect(new Set([inserted.etag, patched.etag, again.etag]).size).toBe(3);

    await fake.deleteEvent(USER, CAL, ID);
    expect((await fake.getEvent(USER, CAL, ID))?.etag).not.toBe(again.etag);
  });

  it("rejects an insert whose ID exists, also after deletion, and an ID outside Google's rules", async () => {
    const fake = new FakeGoogleCalendar();
    await fake.insertEvent(USER, CAL, ID, write("1"));
    expect(reasonOf(await caught(fake.insertEvent(USER, CAL, ID, write("2"))))).toBe("duplicate");
    await fake.deleteEvent(USER, CAL, ID);
    expect(reasonOf(await caught(fake.insertEvent(USER, CAL, ID, write("3"))))).toBe("duplicate");
    expect(stored(fake).privateProperties.revision).toBe("1");

    const invalid = await caught(fake.insertEvent(USER, CAL, "Not-Valid", write("1")));
    expect((invalid as CalendarApiError).detail).toEqual({ status: 400, retryable: false, reason: "invalid" });
    expect(fake.allEvents(USER, CAL)).toHaveLength(1);

    // The same ID in another calendar or for another user is a different event.
    await fake.insertEvent(USER, "other", ID, write("1"));
    await fake.insertEvent("user-2", CAL, ID, write("1"));
    expect(fake.allEvents("user-2", CAL)).toHaveLength(1);
  });

  it("rejects a patch with a stale etag and leaves the event unchanged", async () => {
    const fake = new FakeGoogleCalendar();
    const inserted = await fake.insertEvent(USER, CAL, ID, write("1"));
    const current = await fake.patchEvent(USER, CAL, ID, { description: "Board revision 2", privateProperties: { revision: "2" } }, inserted.etag);

    const error = await caught(fake.patchEvent(USER, CAL, ID, { description: "delayed older write", privateProperties: { revision: "1" } }, inserted.etag));
    expect((error as CalendarApiError).detail).toEqual({ status: 412, retryable: false, reason: "precondition" });
    expect(stored(fake)).toMatchObject({ description: "Board revision 2", etag: current.etag, privateProperties: { boardId: "b1", revision: "2" } });

    // No etag means an unconditional update.
    await fake.patchEvent(USER, CAL, ID, { summary: "Unconditional" }, null);
    expect(stored(fake).summary).toBe("Unconditional");

    expect(reasonOf(await caught(fake.patchEvent(USER, CAL, "gdbmissing", { summary: "x" }, null)))).toBe("not_found");
  });

  it("merges only the supplied fields on patch and preserves everything else", async () => {
    const fake = new FakeGoogleCalendar();
    await fake.insertEvent(USER, CAL, ID, write("1", { reminderMinutesBefore: 10 }));
    fake.externalEdit(USER, CAL, ID, (event) => {
      event.unmanaged.colorId = "7";
      event.unmanaged.location = "Home";
      event.privateProperties.ownerNote = "keep";
      event.description = `${event.description}\n\nOwner's own note`;
    });

    await fake.patchEvent(USER, CAL, ID, { summary: "New title", privateProperties: { revision: "2" } }, null);

    expect(stored(fake)).toMatchObject({
      summary: "New title",
      description: "Board revision 1\n\nOwner's own note",
      privateProperties: { boardId: "b1", revision: "2", ownerNote: "keep" },
      time: { kind: "timed", startsAt: "2026-10-01T05:00:00Z", endsAt: "2026-10-01T05:15:00Z", timezone: "Europe/Zurich" },
      reminderMinutesBefore: 10,
      transparency: "transparent",
      unmanaged: { colorId: "7", location: "Home" },
      attendees: [],
      status: "confirmed",
    });

    await fake.patchEvent(USER, CAL, ID, { reminderMinutesBefore: null, time: { kind: "all_day", localDate: "2026-10-01" } }, null);
    expect(stored(fake)).toMatchObject({ summary: "New title", reminderMinutesBefore: null, time: { kind: "all_day", localDate: "2026-10-01" }, unmanaged: { colorId: "7", location: "Home" } });
  });

  it("applies a write whose response is lost, so a retry by insert is a duplicate", async () => {
    const fake = new FakeGoogleCalendar();
    fake.loseResponseNext("insertEvent");
    const lost = await caught(fake.insertEvent(USER, CAL, ID, write("1")));
    expect((lost as CalendarApiError).detail).toEqual({ status: null, retryable: true, reason: "network" });

    const found = await fake.getEvent(USER, CAL, ID);
    expect(found?.privateProperties.revision).toBe("1");
    expect(reasonOf(await caught(fake.insertEvent(USER, CAL, ID, write("1"))))).toBe("duplicate");
    expect(fake.allEvents(USER, CAL)).toHaveLength(1);

    fake.loseResponseNext("patchEvent");
    await caught(fake.patchEvent(USER, CAL, ID, { description: "Board revision 2", privateProperties: { revision: "2" } }, found?.etag ?? null));
    expect(stored(fake).description).toBe("Board revision 2");
    // The etag moved on with the lost write: retrying with the old one fails the precondition.
    expect(reasonOf(await caught(fake.patchEvent(USER, CAL, ID, { description: "Board revision 2" }, found?.etag ?? null)))).toBe("precondition");

    expect(fake.log.map((entry) => [entry.op, entry.outcome, entry.revision])).toEqual([
      ["insertEvent", "lost_response", "1"],
      ["getEvent", "ok", null],
      ["insertEvent", "failed", "1"],
      ["patchEvent", "lost_response", "2"],
      ["patchEvent", "failed", null],
    ]);
  });

  it("fails the next n calls without applying them", async () => {
    const fake = new FakeGoogleCalendar();
    const outage = new CalendarApiError("TEST: backend error", { status: 503, retryable: true });
    fake.failNext("insertEvent", 2, outage);
    expect(await caught(fake.insertEvent(USER, CAL, ID, write("1")))).toBe(outage);
    expect(await caught(fake.insertEvent(USER, CAL, ID, write("1")))).toBe(outage);
    expect(fake.allEvents(USER, CAL)).toHaveLength(0);
    await fake.insertEvent(USER, CAL, ID, write("1"));
    expect(fake.allEvents(USER, CAL)).toHaveLength(1);
    // Other operations were never affected.
    fake.failNext("getEvent", 1, outage);
    await fake.deleteEvent(USER, CAL, ID);
    expect(await caught(fake.getEvent(USER, CAL, ID))).toBe(outage);
  });

  it("keeps a deleted event retrievable as cancelled; an external delete does the same or purges", async () => {
    const fake = new FakeGoogleCalendar();
    const inserted = await fake.insertEvent(USER, CAL, ID, write("1"));

    fake.externalDelete(USER, CAL, ID);
    const deleted = await fake.getEvent(USER, CAL, ID);
    expect(deleted?.status).toBe("cancelled");
    expect(deleted?.etag).not.toBe(inserted.etag);
    // A conditional update prepared before the deletion no longer matches.
    expect(reasonOf(await caught(fake.patchEvent(USER, CAL, ID, { description: "Board revision 2" }, inserted.etag)))).toBe("precondition");
    // An update does not revive it unless it says so.
    expect((await fake.patchEvent(USER, CAL, ID, { description: "Board revision 2" }, null)).status).toBe("cancelled");
    expect((await fake.patchEvent(USER, CAL, ID, { status: "confirmed" }, null)).status).toBe("confirmed");

    await fake.deleteEvent(USER, CAL, ID);
    expect((await fake.getEvent(USER, CAL, ID))?.status).toBe("cancelled");
    const writesBefore = stored(fake).writeCount;
    await fake.deleteEvent(USER, CAL, ID);
    await fake.deleteEvent(USER, CAL, "gdbmissing");
    expect(stored(fake).writeCount).toBe(writesBefore);

    fake.externalDelete(USER, CAL, ID, { purge: true });
    expect(await fake.getEvent(USER, CAL, ID)).toBeNull();
    expect(fake.allEvents(USER, CAL)).toHaveLength(0);
  });

  it("throws CalendarNotConnectedError on every call of a disconnected user only", async () => {
    const fake = new FakeGoogleCalendar();
    await fake.insertEvent(USER, CAL, ID, write("1"));
    fake.setConnected(USER, false);
    const calls = [
      () => fake.listEvents(USER, { calendarIds: [CAL], timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-10-02T00:00:00Z", timezone: "UTC" }),
      () => fake.getEvent(USER, CAL, ID),
      () => fake.insertEvent(USER, CAL, "gdbother", write("1")),
      () => fake.patchEvent(USER, CAL, ID, { summary: "x" }, null),
      () => fake.deleteEvent(USER, CAL, ID),
    ];
    for (const call of calls) expect(await caught(call())).toBeInstanceOf(CalendarNotConnectedError);
    expect(stored(fake)).toMatchObject({ summary: "Outfits for Thursday", status: "confirmed" });
    expect(fake.log.slice(1).map((entry) => entry.outcome)).toEqual(Array(5).fill("not_connected"));

    await fake.insertEvent("user-2", CAL, ID, write("1"));
    fake.setConnected(USER, true);
    expect((await fake.getEvent(USER, CAL, ID))?.status).toBe("confirmed");
  });

  it("runs the delay hook inside the call, before the write is applied", async () => {
    const fake = new FakeGoogleCalendar();
    const inserted = await fake.insertEvent(USER, CAL, ID, write("1"));

    // A newer write lands while an older conditional patch is in flight.
    fake.delayNext("patchEvent", async () => {
      await fake.patchEvent(USER, CAL, ID, { description: "Board revision 3", privateProperties: { revision: "3" } }, inserted.etag);
    });
    const older = await caught(fake.patchEvent(USER, CAL, ID, { description: "Board revision 2", privateProperties: { revision: "2" } }, inserted.etag));
    expect(reasonOf(older)).toBe("precondition");
    expect(stored(fake)).toMatchObject({ description: "Board revision 3", privateProperties: { revision: "3" } });

    expect(fake.log.map((entry) => [entry.seq, entry.op, entry.eventId, entry.revision, entry.ifMatch, entry.outcome, entry.attendeesSent])).toEqual([
      [1, "insertEvent", ID, "1", null, "ok", 0],
      [2, "patchEvent", ID, "2", inserted.etag, "failed", 0],
      [3, "patchEvent", ID, "3", inserted.etag, "ok", 0],
    ]);
  });

  it("reads the revision from a configurable private property", async () => {
    const fake = new FakeGoogleCalendar({ revisionProperty: "contentRevision" });
    await fake.insertEvent(USER, CAL, ID, write("1", { privateProperties: { contentRevision: "41" } }));
    expect(fake.log[0]).toMatchObject({ revision: "41", privateProperties: { contentRevision: "41" } });
  });

  it("lists seeded read events for the requested calendars and window", async () => {
    const fake = new FakeGoogleCalendar();
    const seed = (eventId: string, startsAt: string | null, endsAt: string | null): CalendarEventRaw => ({
      eventId,
      calendarId: "ignored",
      title: eventId,
      startsAt,
      endsAt,
      allDay: startsAt === null,
      location: null,
      attendance: "accepted",
      cancelled: false,
    });
    fake.seedReadEvents(USER, "primary", [
      seed("yesterday", "2026-09-30T09:00:00Z", "2026-09-30T10:00:00Z"),
      seed("overnight", "2026-09-30T23:00:00Z", "2026-10-01T01:00:00Z"),
      seed("meeting", "2026-10-01T09:00:00Z", "2026-10-01T10:00:00Z"),
      seed("ends-at-min", "2026-09-30T23:00:00Z", "2026-10-01T00:00:00Z"),
      seed("starts-at-max", "2026-10-02T00:00:00Z", "2026-10-02T01:00:00Z"),
      seed("allday", null, null),
    ]);
    fake.seedReadEvents(USER, "work", [seed("standup", "2026-10-01T08:00:00Z", "2026-10-01T08:15:00Z")]);
    fake.seedReadEvents("user-2", "primary", [seed("not-mine", "2026-10-01T08:00:00Z", "2026-10-01T08:15:00Z")]);
    await fake.insertEvent(USER, "primary", ID, write("1"));

    const window = { timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-10-02T00:00:00Z", timezone: "UTC" };
    const listed = await fake.listEvents(USER, { calendarIds: ["primary", "work"], ...window });
    expect(listed.map((event) => [event.calendarId, event.eventId])).toEqual([
      ["primary", "overnight"],
      ["primary", "meeting"],
      ["primary", "allday"],
      ["work", "standup"],
    ]);
    expect(await fake.listEvents(USER, { calendarIds: ["empty"], ...window })).toEqual([]);
  });
});
