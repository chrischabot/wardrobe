/**
 * Ports: the ONLY boundary between the daily service and external services. Real adapters live in
 * `weather/` and `calendar/`; tests substitute clearly labelled fakes here and nowhere else.
 */
import type { CalendarEventContext, OutfitCandidate, WeatherLocation, WeatherProviderName } from "@garderobe/contracts/ext/daily";

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

/* ------------------------------- weather ------------------------------- */

/** One normalized forecast hour. `null` = the provider did not supply the value (never zero). */
export interface ProviderHour {
  /** Local wall time in the forecast timezone, `YYYY-MM-DDTHH:00`. */
  localTime: string;
  /** UTC instant, ISO 8601 with Z. */
  at: string;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  precipitationProbabilityPct: number | null;
  precipitationMm: number | null;
  precipitationType: "none" | "rain" | "showers" | "snow" | "mixed" | "sleet" | "hail" | null;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  humidityPct: number | null;
}

export interface ProviderForecast {
  provider: WeatherProviderName;
  attribution: string;
  /** Timezone the local times are expressed in. */
  timezone: string;
  latitude: number;
  longitude: number;
  fetchedAt: string;
  /** Forecast issue/model time when supplied by the provider, else null. */
  issuedAt: string | null;
  hours: ProviderHour[];
  /** null = the provider has no alert feed; [] = none active. */
  alerts: { title: string; severity: string | null; startsAt: string | null; endsAt: string | null; source: string | null }[] | null;
  /** Fields the provider did not supply at all for this request (e.g. "issuedAt", "alerts"). */
  missingFields: string[];
}

export interface ForecastRequest {
  latitude: number;
  longitude: number;
  timezone: string;
  /** Inclusive local dates. */
  startDate: string;
  endDate: string;
}

/** Thrown by adapters for any provider failure; the service turns it into a stale/unavailable state. */
export class WeatherProviderError extends Error {
  readonly detail: { provider: WeatherProviderName; status?: number; retryable: boolean };
  constructor(message: string, detail: { provider: WeatherProviderName; status?: number; retryable: boolean }) {
    super(message);
    this.name = "WeatherProviderError";
    this.detail = detail;
  }
}

export interface WeatherProvider {
  readonly name: WeatherProviderName;
  forecast(request: ForecastRequest): Promise<ProviderForecast>;
}

export interface Geocoder {
  /** Resolve a city-level label. Returns null when nothing matches (never a guess). */
  geocode(label: string): Promise<WeatherLocation | null>;
}

/* ------------------------------- calendar ------------------------------ */

/** Thrown when the owner's Calendar grant is absent or revoked: distinct from an empty calendar. */
export class CalendarNotConnectedError extends Error {
  constructor(message = "Google Calendar is not connected") {
    super(message);
    this.name = "CalendarNotConnectedError";
  }
}

export class CalendarApiError extends Error {
  readonly detail: { status: number | null; retryable: boolean; reason?: string };
  constructor(message: string, detail: { status: number | null; retryable: boolean; reason?: string }) {
    super(message);
    this.name = "CalendarApiError";
    this.detail = detail;
  }
}

/** Raw event as read for day context, before influence weighting. */
export interface CalendarEventRaw {
  eventId: string;
  calendarId: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  attendance: CalendarEventContext["attendance"];
  cancelled: boolean;
}

export interface CalendarReader {
  /** Events overlapping [timeMin, timeMax) in the given calendars. Throws CalendarNotConnectedError / CalendarApiError. */
  listEvents(userId: string, request: { calendarIds: string[]; timeMin: string; timeMax: string; timezone: string }): Promise<CalendarEventRaw[]>;
}

/** The managed outfit event as the projector sees it. */
export interface ManagedEvent {
  eventId: string;
  etag: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  summary: string | null;
  description: string | null;
  /** extendedProperties.private */
  privateProperties: Record<string, string>;
  attendeeCount: number;
}

export interface ManagedEventWrite {
  summary: string;
  description: string;
  privateProperties: Record<string, string>;
  /** Timed presentation: start/end instants with the owner's timezone. All-day: a local date. */
  time: { kind: "timed"; startsAt: string; endsAt: string; timezone: string } | { kind: "all_day"; localDate: string };
  /** Calendar popup reminder minutes; null = no calendar reminder (app notifications are separate). */
  reminderMinutesBefore: number | null;
}

export interface CalendarWriter {
  /** null when the event does not exist (404). A deleted event is returned with status "cancelled" when the API reports it so. */
  getEvent(userId: string, calendarId: string, eventId: string): Promise<ManagedEvent | null>;
  /** Insert with a caller-supplied ID. Throws CalendarApiError with reason "duplicate" on 409. Never sends invitations. */
  insertEvent(userId: string, calendarId: string, eventId: string, write: ManagedEventWrite): Promise<ManagedEvent>;
  /** Conditional update (If-Match when etag given). Throws CalendarApiError with reason "precondition" on 412. Only managed fields are sent. */
  patchEvent(userId: string, calendarId: string, eventId: string, write: Partial<ManagedEventWrite> & { status?: "confirmed" }, etag: string | null): Promise<ManagedEvent>;
  /** Delete the managed event (pause / suppression). A missing event is not an error. */
  deleteEvent(userId: string, calendarId: string, eventId: string): Promise<void>;
}

/* ------------------------------ composition ---------------------------- */

/** Compact, complete context handed to a composition model (assembled by trusted code, never by the model). */
export interface CompositionRequest {
  localDate: string;
  count: number;
  /** The mandatory context rendered for a model (full profile text, rules, inventory, weather, calendar, history). */
  contextText: string;
  /** Structured form of the same context for adapters that prefer it. */
  contextData: Record<string, unknown>;
  /** Rejections from earlier attempts in this run, so the model can repair them. */
  rejections: { candidate: OutfitCandidate; violations: string[] }[];
  deadlineAtMs: number;
}

/**
 * The composition model behind the AI Gateway (implemented by the assistant workstream). It only ever
 * PROPOSES candidates by garment ID; everything it returns is validated in code before publication.
 */
export interface CompositionModel {
  readonly profile: string;
  propose(request: CompositionRequest): Promise<OutfitCandidate[]>;
}
