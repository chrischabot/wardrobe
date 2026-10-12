/**
 * Google Calendar API v3 adapter (CalendarReader + CalendarWriter).
 *
 * VERIFIED against the official discovery document
 * https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest, revision "20260925", read on 2026-09-30
 * (re-check any time with `node --experimental-strip-types scripts/verify-google-calendar.ts`):
 *   - baseUrl https://www.googleapis.com/calendar/v3/
 *   - events.list    GET    calendars/{calendarId}/events
 *       query: singleEvents, orderBy (enum includes "startTime"), timeMin, timeMax, timeZone, showDeleted,
 *       maxResults (default 250), pageToken; response schema Events has items and nextPageToken
 *   - events.get     GET    calendars/{calendarId}/events/{eventId}
 *   - events.insert  POST   calendars/{calendarId}/events            query: sendUpdates (enum includes "none")
 *   - events.patch   PATCH  calendars/{calendarId}/events/{eventId}  query: sendUpdates
 *   - events.delete  DELETE calendars/{calendarId}/events/{eventId}  query: sendUpdates
 *   - the global `fields` query parameter (partial response)
 *   - Event fields: id, etag, status, summary, description, location, start, end (EventDateTime: date,
 *     dateTime, timeZone), transparency, extendedProperties.private, reminders.useDefault,
 *     reminders.overrides (EventReminder: method, minutes), attendees[].self, attendees[].responseStatus,
 *     organizer.self
 * READ in Google's published documentation on 2026-09-30 (documentation, not an executed request):
 *   - caller-supplied event IDs: base32hex characters a-v and 0-9, length 5 to 1024, unique per calendar
 *     (events.insert reference; the same text is in the discovery document's Event.id description)
 *   - conditional modification: an `If-Match` header carrying the etag; HTTP 412 when the event changed;
 *     no conditional insert, but an insert with a supplied ID only succeeds when that ID does not exist
 *     (guide "Get specific versions of resources")
 *   - error reasons: 401 authError, 403 rateLimitExceeded / userRateLimitExceeded / quotaExceeded,
 *     404 notFound, 409 duplicate, 410 deleted, 412 conditionNotMet, 429 rateLimitExceeded, 500 backendError
 *     (guide "Handle API errors")
 *
 * NOT VERIFIED: we have no Google OAuth grant, so no request in this file has ever been sent to the real
 * service. In particular these behaviours rest on documentation or general Google API convention only:
 *   - that events.patch honours `If-Match` and answers 412 exactly as the guide describes, and that
 *     events.delete does the same (the projector sends it on every delete so a late delete cannot remove a
 *     newer write);
 *   - that PATCH merges `extendedProperties.private` key by key and leaves unsent fields untouched;
 *   - that a PATCH changing a timed event to all-day (or back) needs the other form nulled explicitly,
 *     which is why start/end are sent with `date: null` or `dateTime: null, timeZone: null`;
 *   - that a PATCH with `status: "confirmed"` restores an event deleted earlier;
 *   - that an insert reusing the ID of a deleted event answers 409;
 *   - that a deleted event's ID can also answer 404 (not 410) on events.get while an insert with it still
 *     answers 409; the projector then moves the event to a replacement ID derived from the old one;
 *   - that events.list on a calendar this grant cannot see (deleted, unshared, wrong ID) answers 404, which
 *     is how getEvent tells "this event does not exist" from "the whole calendar is not accessible";
 *   - that events.get returns start/end with the `timeZone` that was written and `reminders` as written
 *     (`useDefault: false` with the overrides), which the projector compares to verify a write;
 *   - that the invisible marker characters around the managed text (U+2060, U+2063, U+200B) are kept
 *     in a description as written, also after the owner edits the event in Google's own editors;
 *   - the exact `reason` strings of a 403 for a revoked or under-scoped grant (`insufficientPermissions`
 *     and the newer `ACCESS_TOKEN_SCOPE_INSUFFICIENT` are handled; neither appears in the errors guide);
 *   - the shape of attendee entries under the `fields` selector used by listEvents.
 *
 * Runs in the Cloudflare Workers runtime: only the injected `fetch`; no Node APIs.
 */
import { CalendarApiError, CalendarNotConnectedError, DEFAULT_REQUEST_TIMEOUT_MS, DeadlineError, withDeadline, withRequestTimeout } from "../ports.ts";
import type { CalendarEventRaw, CalendarReader, CalendarWriter, FetchLike, ManagedEvent, ManagedEventWrite } from "../ports.ts";

const DEFAULT_BASE_URL = "https://www.googleapis.com/calendar/v3";

/** Only what day context needs. Event descriptions are deliberately not requested. */
const LIST_FIELDS = "nextPageToken,items(id,status,summary,location,start,end,organizer/self,attendees(self,responseStatus))";

/** Stops a misbehaving `nextPageToken` chain (40 pages of 250 is 10,000 events for one day window). */
const MAX_PAGES = 40;

/** 403 reasons that mean the owner's grant is revoked or lacks the Calendar scope. */
const AUTH_REASONS: ReadonlySet<string> = new Set(["insufficientPermissions", "authError", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "UNAUTHENTICATED"]);

/** 403 reasons that are usage limits: worth retrying later. */
const RATE_REASONS: ReadonlySet<string> = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED"]);

/** Reasons this adapter reports for statuses the projector must tell apart. */
const STATUS_REASONS: Readonly<Record<number, string>> = { 404: "not_found", 409: "duplicate", 410: "not_found", 412: "precondition" };

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Machine reasons Google put in an error body (`error.errors[].reason`, `error.status`, `error.details[].reason`). */
function errorReasons(body: unknown): string[] {
  const error = asObject(asObject(body)?.error);
  if (!error) return [];
  const reasons: string[] = [];
  const push = (value: unknown): void => {
    // Short identifier-like strings only, so nothing else from a response can reach an error message.
    if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) reasons.push(value);
  };
  for (const key of ["errors", "details"]) {
    const list = error[key];
    if (Array.isArray(list)) for (const entry of list) push(asObject(entry)?.reason);
  }
  push(error.status);
  return reasons;
}

/** RFC 3339 date-time (any offset) to a UTC instant with `Z`; null when absent or unparsable. */
function toInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

function nextLocalDate(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new CalendarApiError("Google Calendar write refused: an all-day event needs a YYYY-MM-DD date", { status: null, retryable: false, reason: "invalid_request" });
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return next.toISOString().slice(0, 10);
}

function attendanceOf(item: JsonObject): CalendarEventRaw["attendance"] {
  const attendees = Array.isArray(item.attendees) ? item.attendees : [];
  for (const entry of attendees) {
    const attendee = asObject(entry);
    if (attendee?.self !== true) continue;
    switch (attendee.responseStatus) {
      case "accepted":
        return "accepted";
      case "tentative":
        return "tentative";
      case "declined":
        return "declined";
      case "needsAction":
        return "needs_action";
      default:
        return "unknown";
    }
  }
  return asObject(item.organizer)?.self === true ? "organizer" : "unknown";
}

function toRawEvent(calendarId: string, item: JsonObject): CalendarEventRaw | null {
  const eventId = asString(item.id);
  if (eventId === null) return null;
  const start = asObject(item.start);
  const end = asObject(item.end);
  const allDay = typeof start?.date === "string";
  return {
    eventId,
    calendarId,
    title: asString(item.summary) ?? "",
    startsAt: allDay ? null : toInstant(start?.dateTime),
    endsAt: allDay ? null : toInstant(end?.dateTime),
    allDay,
    location: asString(item.location),
    attendance: attendanceOf(item),
    cancelled: item.status === "cancelled",
  };
}

function toManagedEvent(eventId: string, body: JsonObject, headerEtag: string | null): ManagedEvent {
  const privateProperties: Record<string, string> = {};
  const source = asObject(asObject(body.extendedProperties)?.private);
  if (source) for (const [key, value] of Object.entries(source)) if (typeof value === "string") privateProperties[key] = value;
  const status = body.status === "cancelled" || body.status === "tentative" ? body.status : "confirmed";
  const event: ManagedEvent = {
    eventId: asString(body.id) ?? eventId,
    etag: asString(body.etag) ?? headerEtag,
    status,
    summary: asString(body.summary),
    description: asString(body.description),
    privateProperties,
    attendeeCount: Array.isArray(body.attendees) ? body.attendees.length : 0,
  };
  const time = managedTimeOf(body);
  if (time !== undefined) event.time = time;
  const reminder = reminderOf(body);
  if (reminder !== undefined) event.reminderMinutesBefore = reminder;
  return event;
}

/**
 * start/end in the form the projector writes: all-day when start and end are dates one day apart; timed
 * when both carry a date-time and the start a time zone (the end's, when present, the same). Any other
 * form is null (not one the projector wrote); no start or end at all is undefined (not read).
 */
function managedTimeOf(body: JsonObject): ManagedEventWrite["time"] | null | undefined {
  const start = asObject(body.start);
  const end = asObject(body.end);
  if (!start || !end) return undefined;
  const startDate = asString(start.date);
  const endDate = asString(end.date);
  if (startDate !== null || endDate !== null) {
    if (startDate === null || endDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
    return endDate === nextLocalDate(startDate) ? { kind: "all_day", localDate: startDate } : null;
  }
  const startsAt = toInstant(start.dateTime);
  const endsAt = toInstant(end.dateTime);
  const timezone = asString(start.timeZone);
  const endZone = asString(end.timeZone);
  if (startsAt === null || endsAt === null || timezone === null || (endZone !== null && endZone !== timezone)) return null;
  return { kind: "timed", startsAt, endsAt, timezone };
}

/** The reminder configuration as the projector writes it (see ManagedEvent.reminderMinutesBefore). */
function reminderOf(body: JsonObject): number | null | "other" | undefined {
  const reminders = asObject(body.reminders);
  if (!reminders) return undefined;
  if (reminders.useDefault === true) return "other";
  const overrides = Array.isArray(reminders.overrides) ? reminders.overrides : [];
  if (overrides.length === 0) return null;
  const only = overrides.length === 1 ? asObject(overrides[0]) : null;
  return only?.method === "popup" && typeof only.minutes === "number" ? only.minutes : "other";
}

function remindersBody(reminderMinutesBefore: number | null): JsonObject {
  return { useDefault: false, overrides: reminderMinutesBefore === null ? [] : [{ method: "popup", minutes: reminderMinutesBefore }] };
}

/**
 * start/end for a write. `forPatch` nulls the fields of the other presentation, because PATCH merges
 * nested objects and a leftover `dateTime` next to a new `date` is rejected.
 */
function timeBody(time: ManagedEventWrite["time"], forPatch: boolean): { start: JsonObject; end: JsonObject } {
  if (time.kind === "timed") {
    const clear = forPatch ? { date: null } : {};
    return {
      start: { dateTime: time.startsAt, timeZone: time.timezone, ...clear },
      end: { dateTime: time.endsAt, timeZone: time.timezone, ...clear },
    };
  }
  const clear = forPatch ? { dateTime: null, timeZone: null } : {};
  return { start: { date: time.localDate, ...clear }, end: { date: nextLocalDate(time.localDate), ...clear } };
}

interface CallSpec {
  op: "events.list" | "events.get" | "events.insert" | "events.patch" | "events.delete";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: JsonObject;
  headers?: Record<string, string>;
  /** Statuses returned to the caller instead of being thrown. */
  allow?: number[];
  /** False when a successful response carries no body worth reading (delete). */
  expectJson?: boolean;
}

interface CallResult {
  status: number;
  ok: boolean;
  body: JsonObject;
  etag: string | null;
}

export function createGoogleCalendar(opts: {
  fetch: FetchLike;
  getAccessToken: (userId: string) => Promise<string | null>;
  baseUrl?: string;
  /** Deadline for one request, body included (default 15 s; 0 disables). A timeout is a retryable network failure. */
  timeoutMs?: number;
}): CalendarReader & CalendarWriter {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchFn = withRequestTimeout(opts.fetch, opts.timeoutMs);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // One call is at most an access-token lookup and a request, each with its own deadline (insert, patch,
  // delete); getEvent, which can make two of each, is held to the same total and aborted when it is up.
  // Without a per-request deadline there is no bound, and the outfit-calendar projector refuses the writer.
  const callDeadlineMs = timeoutMs > 0 && Number.isFinite(timeoutMs) ? 2 * timeoutMs : Number.POSITIVE_INFINITY;
  const networkError = (op: CallSpec["op"]): CalendarApiError => new CalendarApiError(`Google Calendar ${op} failed: network error`, { status: null, retryable: true, reason: "network" });

  const eventsPath = (calendarId: string): string => `/calendars/${encodeURIComponent(calendarId)}/events`;
  const eventPath = (calendarId: string, eventId: string): string => `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`;

  /**
   * One authorised request. Error messages are built only from the operation name, the HTTP status and a
   * short machine reason: never from the token, the URL, a response message or event text. `signal`
   * aborts the request in flight, and once it has fired no further request is started.
   */
  async function call(userId: string, spec: CallSpec, signal?: AbortSignal): Promise<CallResult> {
    if (signal?.aborted) throw networkError(spec.op);
    // The access-token lookup (a refresh against Google's token endpoint) has a deadline of the same
    // length as the request that follows it: a silent token service must not hold a phase either. A
    // lookup that fails for any other reason keeps its own error.
    let token: string | null;
    try {
      token = await withDeadline(opts.getAccessToken(userId), opts.timeoutMs);
    } catch (e) {
      if (e instanceof DeadlineError) throw networkError(spec.op);
      throw e;
    }
    if (token === null || token === "") throw new CalendarNotConnectedError();
    if (signal?.aborted) throw networkError(spec.op);

    const query = new URLSearchParams(spec.query ?? {}).toString();
    const url = `${baseUrl}${spec.path}${query ? `?${query}` : ""}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", ...spec.headers };
    const init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal } = { method: spec.method, headers };
    if (spec.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(spec.body);
    }
    if (signal) init.signal = signal;

    let response: Response;
    let text: string;
    try {
      response = await fetchFn(url, init);
      text = await response.text();
    } catch {
      // The outcome of a write is unknown here: the projector reads the event back before retrying.
      throw networkError(spec.op);
    }

    const status = response.status;
    const etag = response.headers.get("etag");
    if (status >= 200 && status < 300) {
      if (spec.expectJson === false) return { status, ok: true, body: {}, etag };
      const body = asObject(parseJson(text));
      if (!body) throw new CalendarApiError(`Google Calendar ${spec.op} failed: HTTP ${status} without a JSON object`, { status, retryable: true, reason: "invalid_response" });
      return { status, ok: true, body, etag };
    }
    if (spec.allow?.includes(status)) return { status, ok: false, body: {}, etag: null };

    const reasons = errorReasons(parseJson(text)).filter((reason) => !reason.includes(token));
    if (status === 401) throw new CalendarNotConnectedError("Google Calendar access was refused (HTTP 401): the grant is absent, expired or revoked");
    if (status === 403) {
      if (reasons.some((reason) => AUTH_REASONS.has(reason))) {
        throw new CalendarNotConnectedError("Google Calendar access was refused (HTTP 403): the grant is revoked or lacks the Calendar permission");
      }
      const rate = reasons.find((reason) => RATE_REASONS.has(reason));
      if (rate !== undefined) throw new CalendarApiError(`Google Calendar ${spec.op} failed: HTTP 403 (${rate})`, { status, retryable: true, reason: rate });
    }
    const reason = STATUS_REASONS[status] ?? reasons[0];
    const retryable = status === 429 || status >= 500;
    const detail: { status: number; retryable: boolean; reason?: string } = { status, retryable };
    if (reason !== undefined) detail.reason = reason;
    throw new CalendarApiError(`Google Calendar ${spec.op} failed: HTTP ${status}${reason !== undefined ? ` (${reason})` : ""}`, detail);
  }

  /**
   * events.get, and on a 404 a one-item events.list of the same calendar: Google answers 404 for every
   * event of a calendar that was deleted or that this grant can no longer see, and such a calendar must
   * never read as "the owner deleted the event". 410 is a deleted event and needs no probe.
   */
  async function readEvent(userId: string, calendarId: string, eventId: string, signal: AbortSignal): Promise<ManagedEvent | null> {
    const result = await call(userId, { op: "events.get", method: "GET", path: eventPath(calendarId, eventId), allow: [404, 410] }, signal);
    if (result.ok) return toManagedEvent(eventId, result.body, result.etag);
    if (result.status === 410) return null;
    const probe = await call(userId, { op: "events.list", method: "GET", path: eventsPath(calendarId), query: { maxResults: "1", fields: "kind" }, allow: [404] }, signal);
    if (!probe.ok) throw new CalendarApiError("Google Calendar events.get failed: the calendar is not accessible", { status: 404, retryable: false, reason: "calendar_inaccessible" });
    return null;
  }

  return {
    callDeadlineMs,

    async listEvents(userId, request) {
      const events: CalendarEventRaw[] = [];
      for (const calendarId of request.calendarIds) {
        let pageToken: string | null = null;
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES) {
            throw new CalendarApiError(`Google Calendar events.list failed: more than ${MAX_PAGES} pages for one window`, { status: null, retryable: false, reason: "too_many_pages" });
          }
          const query: Record<string, string> = {
            singleEvents: "true",
            orderBy: "startTime",
            timeMin: request.timeMin,
            timeMax: request.timeMax,
            timeZone: request.timezone,
            showDeleted: "false",
            maxResults: "250",
            fields: LIST_FIELDS,
          };
          if (pageToken !== null) query.pageToken = pageToken;
          const result = await call(userId, { op: "events.list", method: "GET", path: eventsPath(calendarId), query });
          const items = Array.isArray(result.body.items) ? result.body.items : [];
          for (const entry of items) {
            const item = asObject(entry);
            const event = item ? toRawEvent(calendarId, item) : null;
            if (event) events.push(event);
          }
          const next = asString(result.body.nextPageToken);
          if (next === null || next === "") break;
          pageToken = next;
        }
      }
      return events;
    },

    async getEvent(userId, calendarId, eventId) {
      // The whole read (up to two token lookups and two requests) is held to one deadline. When it is up
      // the request in flight is aborted, not merely abandoned, and no further request starts.
      const controller = new AbortController();
      try {
        return await withDeadline(readEvent(userId, calendarId, eventId, controller.signal), callDeadlineMs, () => controller.abort());
      } catch (e) {
        if (e instanceof DeadlineError) throw networkError("events.get");
        throw e;
      }
    },

    async insertEvent(userId, calendarId, eventId, write) {
      // No `attendees` key: outfit delivery never invites anyone. sendUpdates=none as a second guard.
      const body: JsonObject = {
        id: eventId,
        summary: write.summary,
        description: write.description,
        ...timeBody(write.time, false),
        transparency: "transparent",
        extendedProperties: { private: write.privateProperties },
        reminders: remindersBody(write.reminderMinutesBefore),
      };
      const result = await call(userId, { op: "events.insert", method: "POST", path: eventsPath(calendarId), query: { sendUpdates: "none" }, body });
      return toManagedEvent(eventId, result.body, result.etag);
    },

    async patchEvent(userId, calendarId, eventId, write, etag) {
      // Only managed fields present in `write` are sent; PATCH leaves everything else as it is.
      const body: JsonObject = {};
      if (write.summary !== undefined) body.summary = write.summary;
      if (write.description !== undefined) body.description = write.description;
      if (write.privateProperties !== undefined) body.extendedProperties = { private: write.privateProperties };
      if (write.time !== undefined) Object.assign(body, timeBody(write.time, true));
      if (write.reminderMinutesBefore !== undefined) body.reminders = remindersBody(write.reminderMinutesBefore);
      if (write.status !== undefined) body.status = write.status;
      const spec: CallSpec = { op: "events.patch", method: "PATCH", path: eventPath(calendarId, eventId), query: { sendUpdates: "none" }, body };
      if (etag !== null) spec.headers = { "If-Match": etag };
      const result = await call(userId, spec);
      return toManagedEvent(eventId, result.body, result.etag);
    },

    async deleteEvent(userId, calendarId, eventId, etag = null) {
      const spec: CallSpec = { op: "events.delete", method: "DELETE", path: eventPath(calendarId, eventId), query: { sendUpdates: "none" }, allow: [404, 410], expectJson: false };
      if (etag !== null) spec.headers = { "If-Match": etag };
      await call(userId, spec);
    },
  };
}
