import { CalendarApiError, type CalendarEvent, type CalendarSource, type ManagedEvent, type ManagedEventInput, type ManagedEventStore } from './types.js';

/**
 * Google Calendar API v3 adapter, written against the documented REST API
 * (https://developers.google.com/workspace/calendar/api/v3/reference). No credentials are bundled:
 * an access-token provider is injected by the connection layer. Exercised in tests through a fetch
 * double that follows the documented request/response shapes; it has not been run against Google.
 *
 *  - events.list  GET  /calendars/{calendarId}/events?timeMin&timeMax&singleEvents=true&orderBy=startTime
 *  - events.get   GET  /calendars/{calendarId}/events/{eventId}
 *  - events.insert POST /calendars/{calendarId}/events?sendUpdates=none  (caller-supplied `id`)
 *  - events.patch PATCH /calendars/{calendarId}/events/{eventId}?sendUpdates=none with If-Match: <etag>
 *  - events.delete DELETE /calendars/{calendarId}/events/{eventId}?sendUpdates=none
 *
 * Event IDs: characters of base32hex (a–v, 0–9), length 5–1024 (events.insert reference).
 */
export const GOOGLE_CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const MANAGED_MARKER = 'garderobeManaged';

interface GoogleEvent {
  id: string;
  etag: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  transparency?: 'transparent' | 'opaque';
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
  updated?: string;
}

export interface GoogleCalendarOptions {
  getAccessToken: () => Promise<string>;
  /** Calendars read for day context (default: primary). */
  contextCalendarIds?: string[];
  fetcher?: typeof fetch;
  baseUrl?: string;
}

export class GoogleCalendarAdapter implements CalendarSource, ManagedEventStore {
  readonly name = 'google-calendar';
  private readonly fetcher: typeof fetch;
  private readonly base: string;

  constructor(private readonly opts: GoogleCalendarOptions) {
    this.fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
    this.base = opts.baseUrl ?? GOOGLE_CALENDAR_BASE;
  }

  private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T | null> {
    const token = await this.opts.getAccessToken();
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CalendarApiError(`Google Calendar request failed: ${(err as Error).message}`, 0);
    }
    if (res.status === 204) return null;
    if (res.status === 404 || res.status === 410) {
      if (method === 'GET') return null;
      throw new CalendarApiError('Event not found', res.status);
    }
    if (!res.ok) throw new CalendarApiError(`Google Calendar HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  async listEvents(req: { timeMin: string; timeMax: string; timezone: string }): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    for (const calendarId of this.opts.contextCalendarIds ?? ['primary']) {
      let pageToken: string | undefined;
      do {
        const q = new URLSearchParams({ timeMin: req.timeMin, timeMax: req.timeMax, singleEvents: 'true', orderBy: 'startTime', timeZone: req.timezone, maxResults: '250' });
        if (pageToken) q.set('pageToken', pageToken);
        const page = await this.call<{ items?: GoogleEvent[]; nextPageToken?: string }>('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
        for (const e of page?.items ?? []) out.push(toCalendarEvent(e, calendarId));
        pageToken = page?.nextPageToken;
      } while (pageToken);
    }
    return out;
  }

  async getEvent(calendarId: string, eventId: string): Promise<ManagedEvent | null> {
    const e = await this.call<GoogleEvent>('GET', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    return e ? toManaged(e) : null;
  }

  async insertEvent(calendarId: string, event: ManagedEventInput): Promise<ManagedEvent> {
    assertEventId(event.id);
    const e = await this.call<GoogleEvent>('POST', `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, toGoogleBody(event));
    return toManaged(e!);
  }

  async patchEvent(calendarId: string, eventId: string, patch: Partial<Omit<ManagedEventInput, 'id'>> & { status?: ManagedEvent['status'] }, etag: string): Promise<ManagedEvent> {
    const e = await this.call<GoogleEvent>('PATCH', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, toGoogleBody(patch), { 'if-match': etag });
    return toManaged(e!);
  }

  async deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void> {
    await this.call('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, undefined, etag ? { 'if-match': etag } : {});
  }
}

export function assertEventId(id: string): void {
  if (!/^[a-v0-9]{5,1024}$/.test(id)) throw new CalendarApiError(`Invalid Google event id ${id}: base32hex characters, length 5–1024`, 400);
}

function toGoogleBody(e: Partial<ManagedEventInput> & { status?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (e.id) body.id = e.id;
  if (e.summary !== undefined) body.summary = e.summary;
  if (e.description !== undefined) body.description = e.description;
  if (e.start) body.start = e.start;
  if (e.end) body.end = e.end;
  if (e.transparency) body.transparency = e.transparency;
  if (e.status) body.status = e.status;
  if (e.privateProperties) body.extendedProperties = { private: { ...e.privateProperties, [MANAGED_MARKER]: 'true' } };
  if (e.id || e.summary !== undefined) {
    // Outfit delivery never invites anyone and configures its own reminders (spec section 9).
    body.attendees = [];
    body.reminders = { useDefault: false, overrides: [] };
    body.guestsCanInviteOthers = false;
  }
  return body;
}

function toManaged(e: GoogleEvent): ManagedEvent {
  const priv = { ...(e.extendedProperties?.private ?? {}) };
  delete priv[MANAGED_MARKER];
  return {
    id: e.id,
    etag: e.etag,
    status: e.status ?? 'confirmed',
    summary: e.summary ?? '',
    description: e.description ?? '',
    start: e.start ?? {},
    end: e.end ?? {},
    transparency: e.transparency ?? 'opaque',
    privateProperties: priv,
    updated: e.updated ?? new Date(0).toISOString(),
  };
}

export function toCalendarEvent(e: GoogleEvent, calendarId: string): CalendarEvent {
  const self = e.attendees?.find((a) => a.self);
  const response = self?.responseStatus;
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  return {
    eventId: e.id,
    calendarId,
    title: e.summary ?? '',
    description: e.description ?? null,
    location: e.location ?? null,
    start: e.start?.dateTime ? new Date(e.start.dateTime).toISOString() : null,
    end: e.end?.dateTime ? new Date(e.end.dateTime).toISOString() : null,
    startDate: allDay ? e.start!.date! : null,
    endDate: allDay ? (e.end?.date ?? null) : null,
    allDay,
    status: e.status ?? 'confirmed',
    selfResponse: response === 'accepted' || response === 'tentative' || response === 'declined' || response === 'needsAction' ? response : null,
    managedByGarderobe: e.extendedProperties?.private?.[MANAGED_MARKER] === 'true',
  };
}
