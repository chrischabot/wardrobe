/**
 * SIMULATION ONLY: LABELLED STAND-INS for the external services the Worker calls, held in the memory of
 * the simulation Worker and scripted by the simulator through the control door (worker/entry.ts).
 * Everything inside the Worker is the product; only these network boundaries are replaced, and nothing
 * here proves anything about the real services.
 *
 *  1. Open-Meteo forecast and geocoding (`api.open-meteo.com`, `geocoding-api.open-meteo.com`): a
 *     scripted forecast in Open-Meteo's wire shape per place and local date, parsed by the product's real
 *     adapter. A place or date with no script, or a place switched to "down", answers HTTP 503: an outage.
 *  2. Google OAuth token and revocation, calendar list and creation, and the Calendar events API, under
 *     `SIM_GOOGLE_ORIGIN`: an in-memory calendar in Google's documented wire shape (caller-supplied IDs
 *     and 409, `If-Match` and 412, cancelled-on-delete) with a scriptable write outage.
 *  3. Every other host answers 503: the simulation Worker never reaches the network.
 */
export const SIM_GOOGLE_ORIGIN = "https://google.simulation.invalid";
export const SIM_GOOGLE_CLIENT_SECRET = "simulation-google-client-secret";
const GOOGLE_ACCESS = "simulation-access-token";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/* ------------------------------ weather ------------------------------ */

export interface DayScript {
  /** Temperature from midnight until 10:00 local (covers an 08:00 departure). */
  morningC: number;
  /** Temperature 10:00-17:59 local (the daytime peak). */
  peakC: number;
  /** Temperature from 18:00 local. */
  eveningC: number;
  /** Local hour from which it rains; omit for a dry day. */
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
  down: boolean;
  requests: number;
}

const places = new Map<string, Place>();

function offsetSeconds(timezone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Math.round((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - atMs) / 1000);
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const SERIES = ["temperature_2m", "apparent_temperature", "precipitation_probability", "precipitation", "rain", "showers", "snowfall", "weather_code", "wind_speed_10m", "wind_gusts_10m", "relative_humidity_2m"] as const;

function forecast(url: URL): Response {
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  const place = [...places.values()].find((p) => Math.abs(p.latitude - latitude) < 0.01 && Math.abs(p.longitude - longitude) < 0.01);
  if (!place) return json({ error: true, reason: "SIMULATION STAND-IN: no scripted forecast for this location (an outage)" }, 503);
  place.requests++;
  if (place.down) return json({ error: true, reason: "SIMULATION STAND-IN: scripted provider outage" }, 503);
  const start = url.searchParams.get("start_date");
  const end = url.searchParams.get("end_date");
  if (!start || !end) return json({ error: true, reason: "SIMULATION STAND-IN: start_date and end_date are required" }, 400);
  const timezone = url.searchParams.get("timezone") ?? place.timezone;
  // Like the live service, labels are UTC plus one fixed offset (the offset in force at the first label).
  const offset = offsetSeconds(timezone, Date.parse(`${start}T12:00:00Z`));
  const time: string[] = [];
  const series = Object.fromEntries(SERIES.map((k) => [k, [] as (number | null)[]])) as Record<(typeof SERIES)[number], (number | null)[]>;
  let scripted = 0;
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const day = place.days.get(date);
    if (day) scripted++;
    for (let hour = 0; hour < 24; hour++) {
      time.push(`${date}T${String(hour).padStart(2, "0")}:00`);
      if (!day) {
        for (const key of SERIES) series[key].push(null);
        continue;
      }
      const temperature = hour < 10 ? day.morningC : hour < 18 ? day.peakC : day.eveningC;
      // Precipitation values describe the preceding hour in this wire format.
      const wet = day.rainFromHour !== undefined && hour - 1 >= day.rainFromHour;
      const mm = wet ? (day.rainMmPerHour ?? 1.5) : 0;
      series.temperature_2m.push(temperature);
      series.apparent_temperature.push(temperature - 1);
      series.precipitation_probability.push(wet ? 90 : 0);
      series.precipitation.push(mm);
      series.rain.push(mm);
      series.showers.push(0);
      series.snowfall.push(0);
      series.weather_code.push(wet ? 63 : 1);
      series.wind_speed_10m.push(10);
      series.wind_gusts_10m.push(day.gustKmh ?? 18);
      series.relative_humidity_2m.push(60);
    }
  }
  if (scripted === 0) return json({ error: true, reason: "SIMULATION STAND-IN: no scripted forecast for these dates (an outage)" }, 503);
  return json({
    latitude: place.latitude,
    longitude: place.longitude,
    generationtime_ms: 0.1,
    utc_offset_seconds: offset,
    timezone,
    timezone_abbreviation: "SIM",
    elevation: 10,
    hourly_units: { time: "iso8601", temperature_2m: "°C", apparent_temperature: "°C", precipitation_probability: "%", precipitation: "mm", rain: "mm", showers: "mm", snowfall: "cm", weather_code: "wmo code", wind_speed_10m: "km/h", wind_gusts_10m: "km/h", relative_humidity_2m: "%" },
    hourly: { time, ...series },
  });
}

function geocode(url: URL): Response {
  const name = (url.searchParams.get("name") ?? "").trim().toLowerCase();
  const place = [...places.values()].find((p) => p.label.toLowerCase() === name);
  if (!place) return json({ generationtime_ms: 0.1 }); // the live service answers 200 without `results`
  return json({ results: [{ id: 1, name: place.label, latitude: place.latitude, longitude: place.longitude, timezone: place.timezone, country: "Simulation" }], generationtime_ms: 0.1 });
}

export interface WeatherControl {
  places?: { label: string; latitude: number; longitude: number; timezone: string }[];
  /** label -> local date -> script; `null` removes the day (that day then has no forecast). */
  days?: Record<string, Record<string, DayScript | null>>;
  down?: Record<string, boolean>;
}

export function controlWeather(body: WeatherControl): Record<string, unknown> {
  for (const p of body.places ?? []) {
    const existing = places.get(p.label);
    places.set(p.label, { label: p.label, latitude: p.latitude, longitude: p.longitude, timezone: p.timezone, days: existing?.days ?? new Map(), down: existing?.down ?? false, requests: existing?.requests ?? 0 });
  }
  for (const [label, days] of Object.entries(body.days ?? {})) {
    const place = places.get(label);
    if (!place) throw new Error(`unknown place '${label}'`);
    for (const [date, script] of Object.entries(days)) {
      if (script === null) place.days.delete(date);
      else place.days.set(date, script);
    }
  }
  for (const [label, down] of Object.entries(body.down ?? {})) {
    const place = places.get(label);
    if (!place) throw new Error(`unknown place '${label}'`);
    place.down = down;
  }
  return { places: [...places.values()].map((p) => ({ label: p.label, scriptedDays: p.days.size, down: p.down, requests: p.requests })) };
}

/* ------------------------------ Google ------------------------------- */

interface StoredEvent {
  id: string;
  etag: string;
  status: string;
  writes: number;
  [field: string]: unknown;
}

interface CalendarState {
  events: Map<string, StoredEvent>;
  log: { seq: number; op: string; eventId: string | null; status: number; ifMatch: string | null; revision: string | null; at: string }[];
  /** Remaining number of write requests to answer 503 without writing (a scripted outage). */
  failWrites: number;
}

const calendars = new Map<string, CalendarState>();
let counter = 0;
let logSeq = 0;

function calendarOf(id: string): CalendarState {
  let state = calendars.get(id);
  if (!state) {
    state = { events: new Map(), log: [], failWrites: 0 };
    calendars.set(id, state);
  }
  return state;
}

const edge = (event: StoredEvent, which: "start" | "end"): number | null => {
  const value = event[which] as { dateTime?: string; date?: string } | undefined;
  if (value?.dateTime) return Date.parse(value.dateTime);
  if (value?.date) return Date.parse(`${value.date}T00:00:00Z`);
  return null;
};

const revisionOf = (body: Record<string, any> | null): string | null => {
  const props = body?.extendedProperties?.private as Record<string, string> | undefined;
  if (!props) return null;
  const key = Object.keys(props).find((k) => /revision/i.test(k));
  return key ? String(props[key]) : null;
};

async function calendarEvents(request: Request, url: URL, calendarId: string, eventId: string | null): Promise<Response> {
  const state = calendarOf(calendarId);
  const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
  const body = text ? (JSON.parse(text) as Record<string, any>) : null;
  const done = (op: string, response: Response) => {
    state.log.push({ seq: ++logSeq, op, eventId: eventId ?? (body?.id as string | undefined) ?? null, status: response.status, ifMatch: request.headers.get("If-Match"), revision: revisionOf(body), at: new Date().toISOString() });
    return response;
  };
  if (request.method !== "GET" && state.failWrites > 0) {
    state.failWrites--;
    return done(`${request.method} (scripted outage)`, json({ error: { code: 503, message: "SIMULATION STAND-IN: scripted calendar outage" } }, 503));
  }
  if (!eventId && request.method === "GET") {
    const min = url.searchParams.get("timeMin");
    const max = url.searchParams.get("timeMax");
    const showDeleted = url.searchParams.get("showDeleted") === "true";
    const items = [...state.events.values()].filter((event) => {
      if (event.status === "cancelled" && !showDeleted) return false;
      const at = edge(event, "start");
      if (at === null) return true;
      const until = edge(event, "end") ?? at;
      if (min && until <= Date.parse(min)) return false;
      if (max && at >= Date.parse(max)) return false;
      return true;
    });
    return done("list", json({ items }));
  }
  if (!eventId && request.method === "POST") {
    const id = String(body?.id ?? `generated${++counter}`);
    if (state.events.has(id)) return done("insert", json({ error: { code: 409, message: "The requested identifier already exists.", errors: [{ reason: "duplicate" }] } }, 409));
    const event: StoredEvent = { ...body, id, etag: `"etag-${++counter}"`, status: String(body?.status ?? "confirmed"), writes: 1 };
    state.events.set(id, event);
    return done("insert", json(event, 200, { ETag: event.etag }));
  }
  const existing = eventId ? state.events.get(eventId) : undefined;
  if (request.method === "GET") return done("get", existing ? json(existing, 200, { ETag: existing.etag }) : json({ error: { code: 404, message: "Not Found" } }, 404));
  if (!existing) return done(request.method.toLowerCase(), json({ error: { code: 404, message: "Not Found" } }, 404));
  if (request.method === "PATCH" || request.method === "PUT") {
    const ifMatch = request.headers.get("If-Match");
    if (ifMatch && ifMatch !== existing.etag) return done("patch", json({ error: { code: 412, message: "Precondition Failed", errors: [{ reason: "conditionNotMet" }] } }, 412));
    const merged: StoredEvent = { ...existing, ...body, id: existing.id, etag: `"etag-${++counter}"`, status: String(body?.status ?? existing.status), writes: existing.writes + 1 };
    if (body?.extendedProperties?.private) merged.extendedProperties = { ...(existing.extendedProperties as object), private: { ...((existing.extendedProperties as any)?.private ?? {}), ...body.extendedProperties.private } };
    state.events.set(existing.id, merged);
    return done("patch", json(merged, 200, { ETag: merged.etag }));
  }
  if (request.method === "DELETE") {
    state.events.set(existing.id, { ...existing, status: "cancelled", etag: `"etag-${++counter}"`, writes: existing.writes + 1 });
    return done("delete", new Response(null, { status: 204 }));
  }
  return json({ error: { code: 405 } }, 405);
}

async function google(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/token") {
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") === "refresh_token") return json({ access_token: GOOGLE_ACCESS, expires_in: 3600, token_type: "Bearer" });
    if (!form.get("code_verifier") || form.get("client_secret") !== SIM_GOOGLE_CLIENT_SECRET || form.get("code") !== "simulation-code") return json({ error: "invalid_grant" }, 400);
    const scope = "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.app.created";
    return json({ access_token: GOOGLE_ACCESS, refresh_token: "simulation-refresh-token", expires_in: 3600, scope, token_type: "Bearer" });
  }
  if (url.pathname === "/revoke") return json({});
  if (request.headers.get("Authorization") !== `Bearer ${GOOGLE_ACCESS}`) return json({ error: { code: 401, message: "unauthenticated" } }, 401);
  if (url.pathname === "/calendar/v3/users/me/calendarList") return json({ items: [{ id: "primary", summary: "Personal (simulated)", primary: true, accessRole: "owner" }] });
  if (url.pathname === "/calendar/v3/calendars" && request.method === "POST") {
    const summary = String(((await request.json()) as { summary?: string }).summary ?? "Outfits");
    const id = `outfits-${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@group.calendar.simulation.invalid`;
    calendarOf(id);
    return json({ id, summary });
  }
  const calendar = /^\/calendar\/v3\/calendars\/([^/]+)$/.exec(url.pathname);
  if (calendar && request.method === "GET") {
    const id = decodeURIComponent(calendar[1]!);
    return calendars.has(id) || id === "primary" ? json({ id, summary: id === "primary" ? "Personal (simulated)" : "Outfits" }) : json({ error: { code: 404 } }, 404);
  }
  const events = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
  if (events) return calendarEvents(request, url, decodeURIComponent(events[1]!), events[2] ? decodeURIComponent(events[2]) : null);
  return json({ error: { code: 404, message: "not part of the simulation stand-in" } }, 404);
}

export interface CalendarControl {
  calendarId: string;
  /** Events as a calendar client would have written them (not through the Worker). */
  upsert?: Record<string, unknown>[];
  /** Event IDs cancelled in a calendar client. */
  cancel?: string[];
  failWrites?: number;
}

export function controlCalendar(body: CalendarControl): Record<string, unknown> {
  const state = calendarOf(body.calendarId);
  for (const event of body.upsert ?? []) {
    const id = String(event.id);
    const existing = state.events.get(id);
    state.events.set(id, { ...(existing ?? {}), ...event, id, etag: `"etag-${++counter}"`, status: String(event.status ?? "confirmed"), writes: (existing?.writes ?? 0) + 1 });
  }
  for (const id of body.cancel ?? []) {
    const existing = state.events.get(id);
    if (existing) state.events.set(id, { ...existing, status: "cancelled", etag: `"etag-${++counter}"`, writes: existing.writes + 1 });
  }
  if (typeof body.failWrites === "number") state.failWrites = body.failWrites;
  return { calendarId: body.calendarId, events: state.events.size };
}

export function readCalendar(calendarId: string): Record<string, unknown> {
  const state = calendarOf(calendarId);
  return { calendarId, events: [...state.events.values()], log: state.log };
}

export const listCalendars = (): string[] => [...calendars.keys()];

/* ------------------------------ outbound ----------------------------- */

let outboundRefused = 0;
export const refusedOutbound = (): number => outboundRefused;

/** Every outbound request of the simulation Worker ends here; nothing reaches the network. */
export async function simulatedOutbound(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const url = new URL(request.url);
  if (url.host === "api.open-meteo.com" && url.pathname === "/v1/forecast") return forecast(url);
  if (url.host === "geocoding-api.open-meteo.com" && url.pathname === "/v1/search") return geocode(url);
  if (url.origin === SIM_GOOGLE_ORIGIN) return google(request, url);
  outboundRefused++;
  return json({ error: "outbound network is disabled in the simulation Worker", host: url.host }, 503);
}
