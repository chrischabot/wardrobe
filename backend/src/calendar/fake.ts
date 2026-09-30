import { CalendarApiError, type CalendarEvent, type CalendarSource, type ManagedEvent, type ManagedEventInput, type ManagedEventStore } from './types.js';

/**
 * Deterministic in-memory calendar for tests, demo and the simulation. It serves day-context events
 * and behaves like Google Calendar for the managed event: caller-supplied IDs (409 on duplicates),
 * etags (412 on a stale If-Match), deleted events read back as `cancelled`, and injectable failures:
 *  - `failNext(n, status)`: the next n writes fail before applying;
 *  - `loseNextResponse()`: the next write applies but its response is lost (status 0, unknown outcome);
 *  - `holdNextWrite()`: returns a release function; the next write waits (for out-of-order tests).
 */
export class FakeCalendar implements CalendarSource, ManagedEventStore {
  readonly name = 'fake-calendar';
  events: CalendarEvent[] = [];
  readonly managed = new Map<string, ManagedEvent>();
  writes = 0;
  inserts = 0;
  failListing = false;
  private failures: number[] = [];
  private loseResponses = 0;
  private held: Promise<void> | null = null;
  private reachedHold: (() => void) | null = null;
  private etagCounter = 0;

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  addEvent(e: Partial<CalendarEvent> & Pick<CalendarEvent, 'title'>): CalendarEvent {
    const ev: CalendarEvent = {
      eventId: e.eventId ?? `evt${this.events.length + 1}`,
      calendarId: e.calendarId ?? 'primary',
      description: null,
      location: null,
      start: null,
      end: null,
      startDate: null,
      endDate: null,
      allDay: false,
      status: 'confirmed',
      selfResponse: 'accepted',
      managedByGarderobe: false,
      ...e,
    };
    this.events.push(ev);
    return ev;
  }

  async listEvents(req: { timeMin: string; timeMax: string; timezone: string }): Promise<CalendarEvent[]> {
    if (this.failListing) throw new CalendarApiError('Simulated calendar outage', 503);
    const lo = Date.parse(req.timeMin);
    const hi = Date.parse(req.timeMax);
    const own = [...this.managed.values()]
      .filter((m) => m.status !== 'cancelled')
      .map(
        (m): CalendarEvent => ({
          eventId: m.id,
          calendarId: 'garderobe',
          title: m.summary,
          description: m.description,
          location: null,
          start: m.start.dateTime ?? null,
          end: m.end.dateTime ?? null,
          startDate: m.start.date ?? null,
          endDate: m.end.date ?? null,
          allDay: Boolean(m.start.date),
          status: m.status,
          selfResponse: null,
          managedByGarderobe: true,
        }),
      );
    return [...this.events, ...own].filter((e) => {
      if (e.allDay && e.startDate) {
        const s = Date.parse(`${e.startDate}T00:00:00Z`);
        const en = Date.parse(`${e.endDate ?? e.startDate}T00:00:00Z`);
        return s < hi && en >= lo - 86_400_000;
      }
      return e.start !== null && Date.parse(e.start) < hi && Date.parse(e.end ?? e.start) > lo;
    });
  }

  failNext(n = 1, status = 503): void {
    for (let i = 0; i < n; i++) this.failures.push(status);
  }
  loseNextResponse(): void {
    this.loseResponses++;
  }
  /** Holds the next write until released; `reached` resolves once a write is waiting on the hold. */
  holdNextWrite(): { release: () => void; reached: Promise<void> } {
    let release!: () => void;
    this.held = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (this.reachedHold = r));
    return { release, reached };
  }

  private async beforeWrite(): Promise<void> {
    const held = this.held;
    if (held) {
      this.held = null;
      this.reachedHold?.();
      this.reachedHold = null;
      await held;
    }
    const f = this.failures.shift();
    if (f !== undefined) throw new CalendarApiError(`Simulated HTTP ${f}`, f);
  }
  private afterWrite<T>(v: T): T {
    this.writes++;
    if (this.loseResponses > 0) {
      this.loseResponses--;
      throw new CalendarApiError('Simulated lost response (write applied)', 0);
    }
    return v;
  }
  private nextEtag(): string {
    return `"${++this.etagCounter}"`;
  }

  async getEvent(_calendarId: string, eventId: string): Promise<ManagedEvent | null> {
    const e = this.managed.get(eventId);
    return e ? structuredClone(e) : null;
  }

  async insertEvent(_calendarId: string, input: ManagedEventInput): Promise<ManagedEvent> {
    await this.beforeWrite();
    if (this.managed.has(input.id)) throw new CalendarApiError('Duplicate event id', 409);
    const ev: ManagedEvent = { ...structuredClone(input), etag: this.nextEtag(), status: 'confirmed', updated: this.clock() };
    this.managed.set(input.id, ev);
    this.inserts++;
    return this.afterWrite(structuredClone(ev));
  }

  async patchEvent(_calendarId: string, eventId: string, patch: Partial<Omit<ManagedEventInput, 'id'>> & { status?: ManagedEvent['status'] }, etag: string): Promise<ManagedEvent> {
    await this.beforeWrite();
    const cur = this.managed.get(eventId);
    if (!cur) throw new CalendarApiError('Event not found', 404);
    if (cur.etag !== etag) throw new CalendarApiError('Precondition failed (etag changed)', 412);
    const next: ManagedEvent = {
      ...cur,
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.start ? { start: patch.start } : {}),
      ...(patch.end ? { end: patch.end } : {}),
      ...(patch.transparency ? { transparency: patch.transparency } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      privateProperties: patch.privateProperties ? { ...cur.privateProperties, ...patch.privateProperties } : cur.privateProperties,
      etag: this.nextEtag(),
      updated: this.clock(),
    };
    this.managed.set(eventId, next);
    return this.afterWrite(structuredClone(next));
  }

  async deleteEvent(_calendarId: string, eventId: string): Promise<void> {
    await this.beforeWrite();
    const cur = this.managed.get(eventId);
    if (!cur) throw new CalendarApiError('Event not found', 404);
    this.managed.set(eventId, { ...cur, status: 'cancelled', etag: this.nextEtag(), updated: this.clock() });
    this.afterWrite(undefined);
  }

  /** Simulates the owner editing the managed event text in their calendar client. */
  ownerEdit(eventId: string, description: string): void {
    const cur = this.managed.get(eventId);
    if (cur) this.managed.set(eventId, { ...cur, description, etag: this.nextEtag(), updated: this.clock() });
  }
  /** Simulates the owner deleting the managed event in their calendar client. */
  ownerDelete(eventId: string): void {
    const cur = this.managed.get(eventId);
    if (cur) this.managed.set(eventId, { ...cur, status: 'cancelled', etag: this.nextEtag(), updated: this.clock() });
  }
}
