import { redactSecrets } from './redact.js';
import { wrapUntrusted, type UntrustedEnvelope } from './untrusted.js';

/**
 * Google Workspace adapters behind interfaces (spec section 10): Gmail read for receipt research and
 * Calendar read/write for the managed outfit event. Real adapters target the documented REST APIs
 * with a backend-held OAuth grant; tests and the simulation use the in-memory fakes. Email and event
 * text returned to the assistant is wrapped as untrusted data.
 */

export interface EmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  /** ISO instant the message was sent. */
  date: string;
  text: string;
  attachments?: { filename: string; mimeType: string; attachmentId: string }[];
}

export interface GmailAdapter {
  search(query: string, pageToken?: string): Promise<{ messages: { id: string; threadId: string }[]; nextPageToken?: string }>;
  get(id: string): Promise<EmailMessage>;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
  etag?: string;
  privateKey?: string;
}

export interface CalendarAdapter {
  listEvents(calendarId: string, fromIso: string, toIso: string): Promise<CalendarEvent[]>;
  /** Create or update the managed event identified by a private extended property; returns the read-back. */
  upsertManagedEvent(calendarId: string, key: string, event: Omit<CalendarEvent, 'id' | 'etag' | 'privateKey'>): Promise<CalendarEvent>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
}

/** Serializes OAuth refresh per grant; an authorization failure produces one reconnect state. */
export class OAuthTokenProvider {
  private inflight: Promise<string> | null = null;
  private cached: { token: string; expiresAt: number } | null = null;
  constructor(private readonly refresh: () => Promise<{ accessToken: string; expiresIn: number }>, private readonly onRevoked?: (reason: string) => Promise<void>) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) return this.cached.token;
    this.inflight ??= this.refresh()
      .then((r) => {
        this.cached = { token: r.accessToken, expiresAt: Date.now() + r.expiresIn * 1000 };
        return r.accessToken;
      })
      .catch(async (err) => {
        this.cached = null;
        if (/invalid_grant|revoked|unauthorized/i.test(String(err))) await this.onRevoked?.(redactSecrets(String(err)));
        throw err;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

function b64urlDecode(data: string): string {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

export class GmailApiAdapter implements GmailAdapter {
  constructor(private readonly tokens: OAuthTokenProvider, private readonly doFetch: typeof fetch = fetch) {}

  private async api<T>(path: string): Promise<T> {
    const res = await this.doFetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${await this.tokens.token()}` } });
    if (!res.ok) throw new Error(`Gmail ${res.status}`);
    return (await res.json()) as T;
  }

  async search(query: string, pageToken?: string) {
    const qs = new URLSearchParams({ q: query, maxResults: '50', ...(pageToken ? { pageToken } : {}) });
    const r = await this.api<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(`messages?${qs}`);
    return { messages: r.messages ?? [], nextPageToken: r.nextPageToken };
  }

  async get(id: string): Promise<EmailMessage> {
    const r = await this.api<{ id: string; threadId: string; internalDate: string; payload: GmailPart }>(`messages/${encodeURIComponent(id)}?format=full`);
    const header = (n: string) => r.payload.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? '';
    const texts: string[] = [];
    const attachments: EmailMessage['attachments'] = [];
    const walk = (p: GmailPart) => {
      if (p.filename && p.body?.attachmentId) attachments.push({ filename: p.filename, mimeType: p.mimeType ?? 'application/octet-stream', attachmentId: p.body.attachmentId });
      else if (p.mimeType === 'text/plain' && p.body?.data) texts.push(b64urlDecode(p.body.data));
      else if (p.mimeType === 'text/html' && p.body?.data && !texts.length) texts.push(b64urlDecode(p.body.data).replace(/<[^>]+>/g, ' '));
      p.parts?.forEach(walk);
    };
    walk(r.payload);
    return { id: r.id, threadId: r.threadId, from: header('from'), subject: header('subject'), date: new Date(Number(r.internalDate)).toISOString(), text: texts.join('\n'), attachments };
  }
}

export class FakeGmail implements GmailAdapter {
  readonly searches: { query: string; pageToken?: string }[] = [];
  constructor(public messages: EmailMessage[], private readonly pageSize = 2) {}
  async search(query: string, pageToken?: string) {
    this.searches.push({ query, pageToken });
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t && !t.includes(':'));
    const hits = this.messages.filter((m) => terms.every((t) => `${m.from} ${m.subject} ${m.text}`.toLowerCase().includes(t)));
    const start = pageToken ? Number(pageToken) : 0;
    const page = hits.slice(start, start + this.pageSize);
    return { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: start + this.pageSize < hits.length ? String(start + this.pageSize) : undefined };
  }
  async get(id: string) {
    const m = this.messages.find((x) => x.id === id);
    if (!m) throw new Error('not found');
    return m;
  }
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  constructor(private readonly tokens: OAuthTokenProvider, private readonly allowedWriteCalendars: readonly string[], private readonly doFetch: typeof fetch = fetch) {}

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.doFetch(`https://www.googleapis.com/calendar/v3/${path}`, { ...init, headers: { authorization: `Bearer ${await this.tokens.token()}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`Calendar ${res.status}`);
    return (await res.json()) as T;
  }

  async listEvents(calendarId: string, fromIso: string, toIso: string) {
    const qs = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: 'true', orderBy: 'startTime' });
    const r = await this.api<{ items?: GEvent[] }>(`calendars/${encodeURIComponent(calendarId)}/events?${qs}`);
    return (r.items ?? []).map(toEvent);
  }

  async upsertManagedEvent(calendarId: string, key: string, event: Omit<CalendarEvent, 'id' | 'etag' | 'privateKey'>) {
    if (!this.allowedWriteCalendars.includes(calendarId)) throw new Error('Calendar writes are limited to the dedicated outfit calendar');
    const qs = new URLSearchParams({ privateExtendedProperty: `garderobeKey=${key}` });
    const existing = await this.api<{ items?: GEvent[] }>(`calendars/${encodeURIComponent(calendarId)}/events?${qs}`);
    const body = JSON.stringify({ summary: event.summary, description: event.description, start: { dateTime: event.start }, end: { dateTime: event.end }, extendedProperties: { private: { garderobeKey: key } } });
    const saved = existing.items?.[0]
      ? await this.api<GEvent>(`calendars/${encodeURIComponent(calendarId)}/events/${existing.items[0].id}`, { method: 'PUT', body, headers: { 'if-match': existing.items[0].etag ?? '*' } })
      : await this.api<GEvent>(`calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body });
    const readBack = await this.getEvent(calendarId, saved.id);
    if (!readBack || readBack.description !== event.description) throw new Error('Calendar read-back did not match the managed content');
    return readBack;
  }

  async getEvent(calendarId: string, eventId: string) {
    try {
      return toEvent(await this.api<GEvent>(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`));
    } catch {
      return null;
    }
  }
}

interface GEvent {
  id: string;
  etag?: string;
  summary?: string;
  description?: string;
  status?: CalendarEvent['status'];
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: CalendarEvent['responseStatus'] }[];
  extendedProperties?: { private?: Record<string, string> };
}

function toEvent(e: GEvent): CalendarEvent {
  return {
    id: e.id,
    etag: e.etag,
    summary: e.summary ?? '',
    description: e.description,
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    status: e.status,
    responseStatus: e.attendees?.find((a) => a.self)?.responseStatus,
    privateKey: e.extendedProperties?.private?.garderobeKey,
  };
}

export class FakeCalendar implements CalendarAdapter {
  readonly events = new Map<string, CalendarEvent[]>();
  constructor(private readonly allowedWriteCalendars: readonly string[] = ['garderobe-outfits']) {}
  async listEvents(calendarId: string, fromIso: string, toIso: string) {
    return (this.events.get(calendarId) ?? []).filter((e) => e.start < toIso && e.end > fromIso);
  }
  async upsertManagedEvent(calendarId: string, key: string, event: Omit<CalendarEvent, 'id' | 'etag' | 'privateKey'>) {
    if (!this.allowedWriteCalendars.includes(calendarId)) throw new Error('Calendar writes are limited to the dedicated outfit calendar');
    const list = this.events.get(calendarId) ?? [];
    const prior = list.find((e) => e.privateKey === key);
    const saved: CalendarEvent = { ...event, id: prior?.id ?? `evt_${list.length + 1}`, privateKey: key, etag: String(Date.now()) };
    this.events.set(calendarId, [...list.filter((e) => e.privateKey !== key), saved]);
    return saved;
  }
  async getEvent(calendarId: string, eventId: string) {
    return (this.events.get(calendarId) ?? []).find((e) => e.id === eventId) ?? null;
  }
}

/** Calendar text shown to the assistant: descriptions are untrusted and cannot authorize anything. */
export function calendarForModel(events: CalendarEvent[]): UntrustedEnvelope {
  return wrapUntrusted(
    'Google Calendar',
    events.filter((e) => e.status !== 'cancelled').map((e) => ({ summary: e.summary, start: e.start, end: e.end, declined: e.responseStatus === 'declined', description: e.description?.slice(0, 500) })),
  );
}
