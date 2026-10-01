/**
 * TEST FAKE: stands in for the Google Calendar HTTP service only.
 *
 * It implements the CalendarReader / CalendarWriter ports in memory so projector and board tests can run
 * without Google. It is not the real adapter (`src/calendar/google.ts`) and nothing proven against it is
 * proven against Google. Its semantics follow Google's documentation where that is explicit:
 *   - every write gives the event a new etag;
 *   - an insert whose ID already exists fails with reason "duplicate" (HTTP 409), also when the existing
 *     event is deleted, and an ID outside Google's rules is rejected (HTTP 400);
 *   - a patch carrying a stale etag fails with reason "precondition" (HTTP 412);
 *   - a patch changes only the supplied fields (private properties merge key by key) and keeps the rest;
 *   - a deleted event is kept with status "cancelled" and is still returned by getEvent.
 * ASSUMPTIONS where the documentation is silent and no real grant was available to check:
 *   - a patch of a cancelled event without `status: "confirmed"` is applied and leaves it cancelled;
 *   - a patch with `status: "confirmed"` restores a cancelled event.
 *
 * listEvents returns exactly what `seedReadEvents` stored for the requested calendars (timed events are
 * filtered to the requested window; all-day events carry no date in CalendarEventRaw and are always
 * returned). Seeded cancelled events are returned too, so callers can exercise their handling of them.
 * Managed events written through this fake are not mixed into listEvents.
 */
import { isValidGoogleEventId } from "../calendar/event-id.ts";
import { CalendarApiError, CalendarNotConnectedError } from "../ports.ts";
import type { CalendarEventRaw, CalendarReader, CalendarWriter, ManagedEvent, ManagedEventWrite } from "../ports.ts";

export type FakeCalendarOp = "listEvents" | "getEvent" | "insertEvent" | "patchEvent" | "deleteEvent";

/** One event as the fake stores it. `unmanaged` holds fields the projector does not manage (e.g. colorId). */
export interface FakeStoredEvent {
  eventId: string;
  calendarId: string;
  etag: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary: string | null;
  description: string | null;
  privateProperties: Record<string, string>;
  time: ManagedEventWrite["time"] | null;
  reminderMinutesBefore: number | null;
  transparency: "transparent" | "opaque";
  /** Always empty after writes through the port, which cannot express attendees; only `externalEdit` can add any. */
  attendees: { email: string }[];
  unmanaged: Record<string, unknown>;
  /** Number of writes applied to this event (insert, patch, delete, external edits). */
  writeCount: number;
}

export interface FakeCalendarLogEntry {
  /** Position in call order, starting at 1. */
  seq: number;
  op: FakeCalendarOp;
  userId: string;
  calendarId: string | null;
  eventId: string | null;
  /** Value of the revision private property in the write, when the call carried one. */
  revision: string | null;
  /** Private properties sent with the write, when it carried any. */
  privateProperties: Record<string, string> | null;
  /** etag sent as the update condition (patch only). */
  ifMatch: string | null;
  /** The port has no way to send attendees; recorded so tests can assert it stays zero. */
  attendeesSent: 0;
  outcome: "ok" | "failed" | "lost_response" | "not_connected";
  /** CalendarApiError reason when the call failed with one. */
  reason: string | null;
}

type WriteInfo = { privateProperties?: Record<string, string>; ifMatch?: string | null };

export class FakeGoogleCalendar implements CalendarReader, CalendarWriter {
  /** Every call in order, including failed ones. */
  readonly log: FakeCalendarLogEntry[] = [];

  private readonly revisionProperty: string;
  private readonly events = new Map<string, Map<string, FakeStoredEvent>>();
  private readonly readEvents = new Map<string, CalendarEventRaw[]>();
  private readonly disconnected = new Set<string>();
  private readonly failures = new Map<FakeCalendarOp, { remaining: number; error: Error }[]>();
  private readonly lostResponses = new Map<FakeCalendarOp, number>();
  private readonly delays = new Map<FakeCalendarOp, (() => void | Promise<void>)[]>();
  private etagCounter = 0;

  /** `revisionProperty` names the private property copied into `log[].revision` (default "revision"). */
  constructor(options: { revisionProperty?: string } = {}) {
    this.revisionProperty = options.revisionProperty ?? "revision";
  }

  /* ------------------------------ test controls ------------------------------ */

  /** Users are connected by default. false makes every call throw CalendarNotConnectedError. */
  setConnected(userId: string, connected: boolean): void {
    if (connected) this.disconnected.delete(userId);
    else this.disconnected.add(userId);
  }

  isConnected(userId: string): boolean {
    return !this.disconnected.has(userId);
  }

  /** The next `n` calls of `op` throw `error` and change nothing. */
  failNext(op: FakeCalendarOp, n: number, error: Error): void {
    if (n <= 0) return;
    const queue = this.failures.get(op) ?? [];
    queue.push({ remaining: n, error });
    this.failures.set(op, queue);
  }

  /** The next call of `op` IS applied, then throws a retryable CalendarApiError: a lost response. */
  loseResponseNext(op: FakeCalendarOp, n = 1): void {
    this.lostResponses.set(op, (this.lostResponses.get(op) ?? 0) + n);
  }

  /** `fn` runs (and is awaited) inside the next call of `op`, before it is applied: use it to interleave writes. */
  delayNext(op: FakeCalendarOp, fn: () => void | Promise<void>): void {
    const queue = this.delays.get(op) ?? [];
    queue.push(fn);
    this.delays.set(op, queue);
  }

  /** Replace the events listEvents returns for one calendar. */
  seedReadEvents(userId: string, calendarId: string, events: CalendarEventRaw[]): void {
    this.readEvents.set(this.key(userId, calendarId), events.map((event) => ({ ...event, calendarId })));
  }

  /** The owner edits the event in Google: `mutate` changes the stored event and the etag moves on. */
  externalEdit(userId: string, calendarId: string, eventId: string, mutate: (event: FakeStoredEvent) => void): void {
    const event = this.calendar(userId, calendarId).get(eventId);
    if (!event) throw new Error(`TEST FAKE: no event ${eventId} to edit`);
    mutate(event);
    this.touch(event);
  }

  /**
   * The owner deletes the event in Google. By default it stays retrievable as "cancelled" (what Google
   * does); `purge: true` removes it entirely, as Google eventually does, so getEvent returns null.
   */
  externalDelete(userId: string, calendarId: string, eventId: string, options: { purge?: boolean } = {}): void {
    const calendar = this.calendar(userId, calendarId);
    const event = calendar.get(eventId);
    if (!event) return;
    if (options.purge) {
      calendar.delete(eventId);
      return;
    }
    event.status = "cancelled";
    this.touch(event);
  }

  /** Copies of every stored event of one calendar, cancelled ones included, in insertion order. */
  allEvents(userId: string, calendarId: string): FakeStoredEvent[] {
    return [...this.calendar(userId, calendarId).values()].map((event) => structuredClone(event));
  }

  /* ------------------------------- CalendarReader ---------------------------- */

  async listEvents(userId: string, request: { calendarIds: string[]; timeMin: string; timeMax: string; timezone: string }): Promise<CalendarEventRaw[]> {
    return this.run("listEvents", userId, null, null, {}, () => {
      const min = Date.parse(request.timeMin);
      const max = Date.parse(request.timeMax);
      const result: CalendarEventRaw[] = [];
      for (const calendarId of request.calendarIds) {
        for (const event of this.readEvents.get(this.key(userId, calendarId)) ?? []) {
          if (event.startsAt !== null && event.endsAt !== null) {
            // Google: timeMin is an exclusive bound on the end, timeMax an exclusive bound on the start.
            if (!(Date.parse(event.endsAt) > min && Date.parse(event.startsAt) < max)) continue;
          }
          result.push({ ...event });
        }
      }
      return result;
    });
  }

  /* ------------------------------- CalendarWriter ---------------------------- */

  async getEvent(userId: string, calendarId: string, eventId: string): Promise<ManagedEvent | null> {
    return this.run("getEvent", userId, calendarId, eventId, {}, () => {
      const event = this.calendar(userId, calendarId).get(eventId);
      return event ? this.present(event) : null;
    });
  }

  async insertEvent(userId: string, calendarId: string, eventId: string, write: ManagedEventWrite): Promise<ManagedEvent> {
    return this.run("insertEvent", userId, calendarId, eventId, { privateProperties: write.privateProperties }, () => {
      if (!isValidGoogleEventId(eventId)) {
        throw new CalendarApiError("TEST FAKE: invalid event ID (HTTP 400)", { status: 400, retryable: false, reason: "invalid" });
      }
      const calendar = this.calendar(userId, calendarId);
      if (calendar.has(eventId)) {
        throw new CalendarApiError("TEST FAKE: the requested identifier already exists (HTTP 409)", { status: 409, retryable: false, reason: "duplicate" });
      }
      const event: FakeStoredEvent = {
        eventId,
        calendarId,
        etag: "",
        status: "confirmed",
        summary: write.summary,
        description: write.description,
        privateProperties: { ...write.privateProperties },
        time: { ...write.time },
        reminderMinutesBefore: write.reminderMinutesBefore,
        transparency: "transparent",
        attendees: [],
        unmanaged: {},
        writeCount: 0,
      };
      this.touch(event);
      calendar.set(eventId, event);
      return this.present(event);
    });
  }

  async patchEvent(
    userId: string,
    calendarId: string,
    eventId: string,
    write: Partial<ManagedEventWrite> & { status?: "confirmed" },
    etag: string | null,
  ): Promise<ManagedEvent> {
    const info: WriteInfo = { ifMatch: etag };
    if (write.privateProperties !== undefined) info.privateProperties = write.privateProperties;
    return this.run("patchEvent", userId, calendarId, eventId, info, () => {
      const event = this.calendar(userId, calendarId).get(eventId);
      if (!event) throw new CalendarApiError("TEST FAKE: event not found (HTTP 404)", { status: 404, retryable: false, reason: "not_found" });
      if (etag !== null && etag !== event.etag) {
        throw new CalendarApiError("TEST FAKE: precondition failed (HTTP 412)", { status: 412, retryable: false, reason: "precondition" });
      }
      if (write.summary !== undefined) event.summary = write.summary;
      if (write.description !== undefined) event.description = write.description;
      if (write.privateProperties !== undefined) event.privateProperties = { ...event.privateProperties, ...write.privateProperties };
      if (write.time !== undefined) event.time = { ...write.time };
      if (write.reminderMinutesBefore !== undefined) event.reminderMinutesBefore = write.reminderMinutesBefore;
      if (write.status !== undefined) event.status = write.status;
      this.touch(event);
      return this.present(event);
    });
  }

  async deleteEvent(userId: string, calendarId: string, eventId: string): Promise<void> {
    return this.run("deleteEvent", userId, calendarId, eventId, {}, () => {
      const event = this.calendar(userId, calendarId).get(eventId);
      // Missing (404) and already deleted (410) are both success for the port.
      if (!event || event.status === "cancelled") return;
      event.status = "cancelled";
      this.touch(event);
    });
  }

  /* ---------------------------------- internals ------------------------------ */

  private async run<T>(op: FakeCalendarOp, userId: string, calendarId: string | null, eventId: string | null, info: WriteInfo, apply: () => T): Promise<T> {
    const entry: FakeCalendarLogEntry = {
      seq: this.log.length + 1,
      op,
      userId,
      calendarId,
      eventId,
      revision: info.privateProperties?.[this.revisionProperty] ?? null,
      privateProperties: info.privateProperties ? { ...info.privateProperties } : null,
      ifMatch: info.ifMatch ?? null,
      attendeesSent: 0,
      outcome: "ok",
      reason: null,
    };
    this.log.push(entry);

    if (this.disconnected.has(userId)) {
      entry.outcome = "not_connected";
      throw new CalendarNotConnectedError();
    }

    const delay = this.delays.get(op)?.shift();
    if (delay) await delay();

    const failure = this.takeFailure(op);
    if (failure) {
      entry.outcome = "failed";
      entry.reason = failure instanceof CalendarApiError ? (failure.detail.reason ?? null) : null;
      throw failure;
    }

    let result: T;
    try {
      result = apply();
    } catch (error) {
      entry.outcome = "failed";
      entry.reason = error instanceof CalendarApiError ? (error.detail.reason ?? null) : null;
      throw error;
    }

    const lost = this.lostResponses.get(op) ?? 0;
    if (lost > 0) {
      this.lostResponses.set(op, lost - 1);
      entry.outcome = "lost_response";
      entry.reason = "network";
      throw new CalendarApiError("TEST FAKE: the call was applied but its response was lost", { status: null, retryable: true, reason: "network" });
    }
    return result;
  }

  private takeFailure(op: FakeCalendarOp): Error | null {
    const queue = this.failures.get(op);
    const head = queue?.[0];
    if (!queue || !head) return null;
    head.remaining -= 1;
    if (head.remaining <= 0) queue.shift();
    return head.error;
  }

  private key(userId: string, calendarId: string): string {
    return `${userId}\u0000${calendarId}`;
  }

  private calendar(userId: string, calendarId: string): Map<string, FakeStoredEvent> {
    const key = this.key(userId, calendarId);
    let calendar = this.events.get(key);
    if (!calendar) {
      calendar = new Map();
      this.events.set(key, calendar);
    }
    return calendar;
  }

  /** Give the event a new etag, in Google's quoted form. */
  private touch(event: FakeStoredEvent): void {
    this.etagCounter += 1;
    event.etag = `"fake-${this.etagCounter}"`;
    event.writeCount += 1;
  }

  private present(event: FakeStoredEvent): ManagedEvent {
    return {
      eventId: event.eventId,
      etag: event.etag,
      status: event.status,
      summary: event.summary,
      description: event.description,
      privateProperties: { ...event.privateProperties },
      attendeeCount: event.attendees.length,
    };
  }
}
