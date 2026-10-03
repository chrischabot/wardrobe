/**
 * Node-side stand-ins for the EXTERNAL services the Worker under test calls. Everything inside the
 * Worker is real; only these network boundaries are replaced. Each is a LABELLED TEST DOUBLE and proves
 * nothing about the real service:
 *
 *  1. `api.open-meteo.com` / `geocoding-api.open-meteo.com`: a scripted forecast in Open-Meteo's wire
 *     shape (hourly arrays, units, `utc_offset_seconds`). A journey sets the forecast for one place and
 *     local date; a place and date with no script answers HTTP 503, i.e. a provider outage. The Worker's
 *     real Open-Meteo adapter parses the response.
 *  2. Google Calendar `events` endpoints under `google.fixture.test/calendar/v3/calendars/{id}/events`:
 *     an in-memory calendar in Google's documented wire shape (list, get, insert with caller-supplied
 *     ID and 409 on a duplicate, patch with `If-Match` and 412, delete leaving a cancelled event), with
 *     scriptable faults: an outage (503, nothing written), a lost response (written, then 503) and a
 *     permanent refusal (403). The
 *     Worker's real Google Calendar adapter and projector talk to it.
 *  3. Everything else is delegated to the Worker package's own labelled fixture (`fixtureOutbound`):
 *     Google OAuth token/revoke/calendar list, the remote MCP stand-in, the push stand-in; any other host
 *     answers 503.
 *
 * Journeys control and inspect the doubles through `https://journey.fixture.test/...` (see
 * `src/world.ts`). State is keyed by place and calendar ID so test files that run at the same time do
 * not see each other's scripts.
 */
import { fixtureOutbound, GOOGLE_FIXTURE_ORIGIN } from "@garderobe/worker/testing/vitest-config";

export const JOURNEY_FIXTURE_ORIGIN = "https://journey.fixture.test";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/* ------------------------------------------------------------------ */
/* Weather double (Open-Meteo wire shape)                               */
/* ------------------------------------------------------------------ */

export interface DayScript {
  /** Temperature from midnight until 10:00 local (covers an 08:00 departure). */
  morningC: number;
  /** Temperature 10:00-17:59 local (the daytime peak). */
  peakC: number;
  /** Temperature from 18:00 local. */
  eveningC: number;
  /** Local hour from which it rains (probability 90 %, `rainMmPerHour` each hour); omit for a dry day. */
  rainFromHour?: number;
  rainMmPerHour?: number;
  gustKmh?: number;
}

interface Place {
  label: string;
  latitude: number;
  longitude: number;
  timezone: string;
  days: Map<string, DayScript>;
  /** When true every forecast request for this place fails (provider outage). */
  down: boolean;
  requests: number;
}

const places = new Map<string, Place>();
let placeCounter = 0;

function offsetSeconds(timezone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - atMs) / 1000);
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function forecastResponse(url: URL): Response {
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  const place = [...places.values()].find((p) => Math.abs(p.latitude - latitude) < 0.01 && Math.abs(p.longitude - longitude) < 0.01);
  if (!place) return json({ error: true, reason: "TEST DOUBLE: no scripted forecast for this location (treated as an outage)" }, 503);
  place.requests++;
  if (place.down) return json({ error: true, reason: "TEST DOUBLE: scripted provider outage" }, 503);
  const start = url.searchParams.get("start_date")!;
  const end = url.searchParams.get("end_date")!;
  const timezone = url.searchParams.get("timezone") ?? place.timezone;
  // Like the live service, labels are UTC plus ONE fixed offset (the offset in force at the first label).
  const offset = offsetSeconds(timezone, Date.parse(`${start}T12:00:00Z`));
  const time: string[] = [];
  const series: Record<string, (number | null)[]> = { temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], rain: [], showers: [], snowfall: [], weather_code: [], wind_speed_10m: [], wind_gusts_10m: [], relative_humidity_2m: [] };
  let scripted = 0;
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const day = place.days.get(date);
    if (day) scripted++;
    for (let hour = 0; hour < 24; hour++) {
      time.push(`${date}T${String(hour).padStart(2, "0")}:00`);
      if (!day) {
        for (const key of Object.keys(series)) series[key]!.push(null);
        continue;
      }
      const temperature = hour < 10 ? day.morningC : hour < 18 ? day.peakC : day.eveningC;
      // Precipitation values describe the PRECEDING hour in this wire format.
      const wet = day.rainFromHour !== undefined && hour - 1 >= day.rainFromHour;
      const mm = wet ? (day.rainMmPerHour ?? 1.5) : 0;
      series.temperature_2m!.push(temperature);
      series.apparent_temperature!.push(temperature - 1);
      series.precipitation_probability!.push(wet ? 90 : 0);
      series.precipitation!.push(mm);
      series.rain!.push(mm);
      series.showers!.push(0);
      series.snowfall!.push(0);
      series.weather_code!.push(wet ? 63 : 1);
      series.wind_speed_10m!.push(10);
      series.wind_gusts_10m!.push(day.gustKmh ?? 18);
      series.relative_humidity_2m!.push(60);
    }
  }
  if (scripted === 0) return json({ error: true, reason: "TEST DOUBLE: no scripted forecast for these dates (treated as an outage)" }, 503);
  return json({
    latitude: place.latitude,
    longitude: place.longitude,
    generationtime_ms: 0.1,
    utc_offset_seconds: offset,
    timezone,
    timezone_abbreviation: "TEST",
    elevation: 10,
    hourly_units: { time: "iso8601", temperature_2m: "°C", apparent_temperature: "°C", precipitation_probability: "%", precipitation: "mm", rain: "mm", showers: "mm", snowfall: "cm", weather_code: "wmo code", wind_speed_10m: "km/h", wind_gusts_10m: "km/h", relative_humidity_2m: "%" },
    hourly: { time, ...series },
  });
}

function geocodeResponse(url: URL): Response {
  const name = (url.searchParams.get("name") ?? "").trim().toLowerCase();
  const place = [...places.values()].find((p) => p.label.toLowerCase() === name);
  if (!place) return json({ generationtime_ms: 0.1 }); // the live service answers 200 without `results`
  return json({ results: [{ id: 1, name: place.label, latitude: place.latitude, longitude: place.longitude, timezone: place.timezone, country: "Testland" }], generationtime_ms: 0.1 });
}

/* ------------------------------------------------------------------ */
/* Google Calendar events double                                        */
/* ------------------------------------------------------------------ */

interface StoredEvent {
  id: string;
  etag: string;
  status: string;
  writes: number;
  [field: string]: unknown;
}

interface CalendarState {
  events: Map<string, StoredEvent>;
  log: { seq: number; op: string; eventId: string | null; status: number; ifMatch: string | null; revision: string | null; hasAttendees: boolean; sendUpdates: string | null }[];
  /** Remaining number of write requests to fail with HTTP 503 (a scripted Google outage). */
  failWrites: number;
  /** Remaining number of write requests that ARE applied but answered 503: the response was lost. */
  loseResponses: number;
  /** Remaining number of write requests refused with HTTP 403 (a permanent refusal, not an outage). */
  forbidWrites: number;
}

const calendars = new Map<string, CalendarState>();
let etagCounter = 0;
let logSeq = 0;

const calendarOf = (id: string): CalendarState => {
  let state = calendars.get(id);
  if (!state) {
    state = { events: new Map(), log: [], failWrites: 0, loseResponses: 0, forbidWrites: 0 };
    calendars.set(id, state);
  }
  return state;
};

const startMs = (event: StoredEvent): number | null => {
  const start = event.start as { dateTime?: string; date?: string } | undefined;
  if (start?.dateTime) return Date.parse(start.dateTime);
  if (start?.date) return Date.parse(`${start.date}T00:00:00Z`);
  return null;
};

const endMs = (event: StoredEvent): number | null => {
  const end = event.end as { dateTime?: string; date?: string } | undefined;
  if (end?.dateTime) return Date.parse(end.dateTime);
  if (end?.date) return Date.parse(`${end.date}T00:00:00Z`);
  return null;
};

const revisionOf = (body: Record<string, any> | null): string | null => {
  const props = body?.extendedProperties?.private as Record<string, string> | undefined;
  if (!props) return null;
  const key = Object.keys(props).find((k) => /revision/i.test(k));
  return key ? String(props[key]) : null;
};

async function calendarEvents(request: Request, url: URL, calendarId: string, eventId: string | null): Promise<Response> {
  if (!(request.headers.get("Authorization") ?? "").startsWith("Bearer ")) return json({ error: { code: 401, message: "unauthenticated" } }, 401);
  const state = calendarOf(calendarId);
  const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
  const body = text ? (JSON.parse(text) as Record<string, any>) : null;
  const record = (op: string, status: number) => state.log.push({ seq: ++logSeq, op, eventId: eventId ?? (body?.id as string | undefined) ?? null, status, ifMatch: request.headers.get("If-Match"), revision: revisionOf(body), hasAttendees: Array.isArray(body?.attendees) && body!.attendees.length > 0, sendUpdates: url.searchParams.get("sendUpdates") });
  let done = (op: string, response: Response) => {
    record(op, response.status);
    return response;
  };
  const isWrite = request.method !== "GET";
  if (isWrite && state.failWrites > 0) {
    state.failWrites--;
    return done(`${request.method} (scripted outage)`, json({ error: { code: 503, message: "TEST DOUBLE: scripted calendar outage" } }, 503));
  }
  if (isWrite && state.forbidWrites > 0) {
    state.forbidWrites--;
    return done(`${request.method} (scripted refusal)`, json({ error: { code: 403, message: "TEST DOUBLE: scripted refusal", errors: [{ reason: "forbidden" }] } }, 403));
  }
  // A lost response: the write below is applied, but the caller is told 503 and cannot know it landed.
  const lost = isWrite && state.loseResponses > 0;
  if (lost) {
    state.loseResponses--;
    const applied = done;
    done = (op: string, response: Response) => {
      applied(`${op} (applied, response lost)`, response);
      return json({ error: { code: 503, message: "TEST DOUBLE: the write was applied but its response was lost" } }, 503);
    };
  }
  if (!eventId && request.method === "GET") {
    const min = url.searchParams.get("timeMin");
    const max = url.searchParams.get("timeMax");
    const showDeleted = url.searchParams.get("showDeleted") === "true";
    const items = [...state.events.values()].filter((event) => {
      if (event.status === "cancelled" && !showDeleted) return false;
      // Like the live service: events that end after timeMin and start before timeMax.
      const at = startMs(event);
      if (at === null) return true;
      const until = endMs(event) ?? at;
      if (min && until <= Date.parse(min)) return false;
      if (max && at >= Date.parse(max)) return false;
      return true;
    });
    return done("list", json({ items }));
  }
  if (!eventId && request.method === "POST") {
    const id = String(body?.id ?? `generated${++etagCounter}`);
    if (state.events.has(id)) return done("insert", json({ error: { code: 409, message: "The requested identifier already exists.", errors: [{ reason: "duplicate" }] } }, 409));
    const event: StoredEvent = { ...body, id, etag: `"etag-${++etagCounter}"`, status: String(body?.status ?? "confirmed"), writes: 1 };
    state.events.set(id, event);
    return done("insert", json(event, 200, { ETag: event.etag }));
  }
  const existing = eventId ? state.events.get(eventId) : undefined;
  if (request.method === "GET") return done("get", existing ? json(existing, 200, { ETag: existing.etag }) : json({ error: { code: 404, message: "Not Found" } }, 404));
  if (!existing) return done(request.method.toLowerCase(), json({ error: { code: 404, message: "Not Found" } }, 404));
  if (request.method === "PATCH") {
    const ifMatch = request.headers.get("If-Match");
    if (ifMatch && ifMatch !== existing.etag) return done("patch", json({ error: { code: 412, message: "Precondition Failed", errors: [{ reason: "conditionNotMet" }] } }, 412));
    const merged: StoredEvent = { ...existing, ...body, id: existing.id, etag: `"etag-${++etagCounter}"`, status: String(body?.status ?? existing.status), writes: existing.writes + 1 };
    if (body?.extendedProperties?.private) merged.extendedProperties = { ...(existing.extendedProperties as object), private: { ...((existing.extendedProperties as any)?.private ?? {}), ...body.extendedProperties.private } };
    state.events.set(existing.id, merged);
    return done("patch", json(merged, 200, { ETag: merged.etag }));
  }
  if (request.method === "DELETE") {
    state.events.set(existing.id, { ...existing, status: "cancelled", etag: `"etag-${++etagCounter}"`, writes: existing.writes + 1 });
    return done("delete", new Response(null, { status: 204 }));
  }
  return json({ error: { code: 405 } }, 405);
}

/* ------------------------------------------------------------------ */
/* Control channel for the journeys                                     */
/* ------------------------------------------------------------------ */

async function control(request: Request, url: URL): Promise<Response> {
  const body = request.method === "POST" ? ((await request.json()) as Record<string, any>) : {};
  switch (url.pathname) {
    case "/place": {
      // A new, clearly fictional place with coordinates no other test file uses.
      placeCounter++;
      const place: Place = { label: String(body.label ?? `Journey Place ${placeCounter}`), latitude: 30 + placeCounter, longitude: 5, timezone: String(body.timezone ?? "Europe/London"), days: new Map(), down: false, requests: 0 };
      places.set(place.label, place);
      return json({ label: place.label, latitude: place.latitude, longitude: place.longitude, timezone: place.timezone });
    }
    case "/weather": {
      const place = places.get(String(body.place));
      if (!place) return json({ error: "unknown place" }, 404);
      if (body.clear) place.days.clear();
      for (const [date, script] of Object.entries((body.days ?? {}) as Record<string, DayScript>)) place.days.set(date, script);
      if (typeof body.down === "boolean") place.down = body.down;
      return json({ ok: true, requests: place.requests });
    }
    case "/calendar/seed": {
      const state = calendarOf(String(body.calendarId));
      if (body.clear) state.events.clear();
      for (const event of (body.events ?? []) as Record<string, any>[]) state.events.set(String(event.id), { ...event, id: String(event.id), etag: `"etag-${++etagCounter}"`, status: String(event.status ?? "confirmed"), writes: 0 });
      if (typeof body.failWrites === "number") state.failWrites = body.failWrites;
      if (typeof body.loseResponses === "number") state.loseResponses = body.loseResponses;
      if (typeof body.forbidWrites === "number") state.forbidWrites = body.forbidWrites;
      return json({ ok: true });
    }
    case "/calendar/edit": {
      // An edit made in a calendar client (not through the Worker): changes fields and the etag.
      const state = calendarOf(String(body.calendarId));
      const event = state.events.get(String(body.eventId));
      if (!event) return json({ error: "unknown event" }, 404);
      state.events.set(event.id, { ...event, ...(body.fields as object), id: event.id, etag: `"etag-${++etagCounter}"`, writes: event.writes + 1 });
      return json({ ok: true });
    }
    case "/calendar/state": {
      const state = calendarOf(String(url.searchParams.get("calendarId")));
      return json({ events: [...state.events.values()], log: state.log });
    }
    default:
      return json({ error: "not part of the journey fixture" }, 404);
  }
}

export async function journeyOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === JOURNEY_FIXTURE_ORIGIN) return control(request, url);
  if (url.host === "api.open-meteo.com" && url.pathname === "/v1/forecast") return forecastResponse(url);
  if (url.host === "geocoding-api.open-meteo.com" && url.pathname === "/v1/search") return geocodeResponse(url);
  if (url.origin === GOOGLE_FIXTURE_ORIGIN) {
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (match) return calendarEvents(request, url, decodeURIComponent(match[1]!), match[2] ? decodeURIComponent(match[2]) : null);
  }
  return fixtureOutbound(request);
}
