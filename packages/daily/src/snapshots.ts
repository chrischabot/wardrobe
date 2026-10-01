/**
 * What the outside world said, recorded per owner: weather snapshots and calendar snapshots.
 *
 * Weather: the provider adapter is called through a shared cache keyed by provider, coarse location
 * and local date - no user identifier is ever part of a cache key. Each owner's private snapshot row
 * references what was used. A failed fetch falls back to a still-relevant earlier forecast with its
 * age visible; otherwise the snapshot is `unavailable` and nothing is assumed.
 *
 * Calendar: `ok` with no events is an empty calendar; `not_connected` and `error` are missing access.
 */
import { DAILY_COMMANDS } from "@garderobe/contracts/ext/daily";
import type { CalendarSnapshot, WeatherComparison, WeatherForecastInput, WeatherCompareLocationsInput, WeatherLocation, WeatherSnapshot } from "@garderobe/contracts/ext/daily";
import { WeatherCompareLocationsInput as CompareSchema, WeatherForecastInput as ForecastSchema } from "@garderobe/contracts/ext/daily";
import { addDays, assertPrincipal, define, first, newId, prepare, requireScope, stmt, toInstant, zonedToUtcMs, type CommandPlan, type CommandRegistry, type Db, type Principal } from "@garderobe/domain";
import { managedEventId } from "./calendar/event-id.ts";
import { weighEvents } from "./calendar/influence.ts";
import { dailySettings, latestCalendarSnapshot, loadOwner } from "./context.ts";
import { execAs, nowOf, type DailyDeps } from "./deps.ts";
import { CalendarNotConnectedError, type ProviderForecast } from "./ports.ts";
import { buildWeatherSnapshot, formatAge } from "./weather/assess.ts";

/** A forecast older than this is no longer relevant enough to stand in after a failed fetch. */
export const MAX_STALE_FORECAST_MINUTES = 12 * 60;

export const weatherRecordSnapshot = define({
  type: "weather.record_snapshot",
  schema: DAILY_COMMANDS["weather.record_snapshot"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap", "owner_statement"],
  async plan(ctx, p): Promise<CommandPlan> {
    const s = p.snapshot;
    return {
      summary: s.freshness === "unavailable" ? `Weather for ${s.localDate} is unavailable (${s.limitation ?? "no forecast"})` : `Weather for ${s.localDate} recorded: ${s.line} (${s.provider}, ${s.freshness})`,
      statements: [
        stmt(
          "INSERT INTO weather_snapshots (user_id, snapshot_id, local_date, purpose, provider, freshness, location_label, fetched_at, snapshot_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, s.snapshotId, s.localDate, p.purpose, s.provider, s.freshness, s.location.label, s.fetchedAt, JSON.stringify(s), ctx.commandId, ctx.now,
        ),
      ],
      affected: [{ kind: "weather_snapshot", id: s.snapshotId, version: 1 }],
      result: { snapshotId: s.snapshotId, freshness: s.freshness },
      undo: { unavailableReason: "a recorded source snapshot is evidence and is not undone" },
    };
  },
});

export const calendarRecordSnapshot = define({
  type: "calendar.record_snapshot",
  schema: DAILY_COMMANDS["calendar.record_snapshot"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap", "owner_statement"],
  async plan(ctx, p): Promise<CommandPlan> {
    const s = p.snapshot;
    return {
      summary: s.status === "ok" ? `Calendar for ${s.localDate} read: ${s.events.length} event${s.events.length === 1 ? "" : "s"}` : `Calendar for ${s.localDate}: ${s.status} (${s.limitation ?? "no detail"})`,
      statements: [stmt("INSERT INTO calendar_snapshots (user_id, snapshot_id, local_date, status, read_at, snapshot_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ctx.userId, s.snapshotId, s.localDate, s.status, s.readAt, JSON.stringify(s), ctx.commandId, ctx.now)],
      affected: [{ kind: "calendar_snapshot", id: s.snapshotId, version: 1 }],
      result: { snapshotId: s.snapshotId, status: s.status },
      undo: { unavailableReason: "a recorded source snapshot is evidence and is not undone" },
    };
  },
});

export function registerSnapshotCommands(registry: CommandRegistry): void {
  registry.register(weatherRecordSnapshot);
  registry.register(calendarRecordSnapshot);
}

/* ------------------------------------------------------------------ */
/* Weather                                                              */
/* ------------------------------------------------------------------ */

type LocationInput = { label: string; latitude?: number; longitude?: number; timezone?: string };

/** The owner's selected home city, or an explicit destination. A city label alone is geocoded; nothing is guessed. */
export async function resolveLocation(deps: DailyDeps, userId: string, location?: LocationInput): Promise<{ location: WeatherLocation | null; why: string | null }> {
  const owner = await loadOwner(deps.db, userId);
  const input: LocationInput | null = location ?? (owner.settings.homeLocation ? { ...owner.settings.homeLocation, timezone: owner.settings.timezone } : null);
  if (!input) return { location: null, why: "No home city is set, so no forecast was requested." };
  if (input.latitude !== undefined && input.longitude !== undefined) {
    return { location: { label: input.label, latitude: input.latitude, longitude: input.longitude, timezone: input.timezone ?? owner.settings.timezone }, why: null };
  }
  if (!deps.weather) return { location: null, why: "No weather provider is configured." };
  try {
    const found = await deps.weather.geocoder.geocode(input.label);
    if (!found) return { location: null, why: `The place “${input.label}” could not be resolved to a location.` };
    return { location: { ...found, label: input.label, timezone: input.timezone ?? found.timezone }, why: null };
  } catch {
    return { location: null, why: `The place “${input.label}” could not be looked up (the geocoding service failed).` };
  }
}

const coarse = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

/** Cache key: provider, coarse location and local date only. It never contains a user identifier. */
export function weatherCacheKey(provider: string, location: { latitude: number; longitude: number }, localDate: string): string {
  return `${provider}|${coarse(location.latitude)}|${coarse(location.longitude)}|${localDate}`;
}

async function readCache(db: Db, key: string): Promise<ProviderForecast | null> {
  const row = await first<{ payload_json: string }>(db, "SELECT payload_json FROM weather_cache WHERE cache_key = ?", key);
  return row ? (JSON.parse(row.payload_json) as ProviderForecast) : null;
}

async function writeCache(db: Db, key: string, localDate: string, f: ProviderForecast): Promise<void> {
  await prepare(
    db,
    stmt(
      `INSERT INTO weather_cache (cache_key, provider, latitude, longitude, timezone, local_date, fetched_at, issued_at, covers_from, covers_to, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (cache_key) DO UPDATE SET fetched_at = excluded.fetched_at, issued_at = excluded.issued_at, covers_from = excluded.covers_from, covers_to = excluded.covers_to, payload_json = excluded.payload_json`,
      key, f.provider, f.latitude, f.longitude, f.timezone, localDate, f.fetchedAt, f.issuedAt, f.hours[0]?.at ?? null, f.hours[f.hours.length - 1]?.at ?? null, JSON.stringify(f),
    ),
  ).run();
}

export interface FetchWeatherOptions {
  localDate: string;
  location?: LocationInput;
  segment?: "day" | "evening";
  purpose: "evening_compose" | "morning_refresh" | "adhoc" | "trip" | "resume";
  /** Freshness threshold; defaults to the owner's setting (one hour). */
  maxAgeMinutes?: number;
  nowMs?: number;
  /** Persist the snapshot for this owner (default true). */
  record?: boolean;
}

/**
 * The weather skill's fetch: invoked by the context assembler before evening planning, morning
 * validation, swaps, packing and ad hoc advice, so the model never has to remember to call it.
 */
export async function fetchWeatherSnapshot(deps: DailyDeps, principal: Principal, opts: FetchWeatherOptions): Promise<WeatherSnapshot> {
  assertPrincipal(principal);
  const nowMs = nowOf(deps, opts.nowMs);
  const owner = await loadOwner(deps.db, principal.userId);
  const settings = dailySettings(owner.settings);
  const maxAgeMinutes = opts.maxAgeMinutes ?? settings.weatherMaxAgeMinutes;
  const segment = opts.segment ?? "day";
  const snapshotId = newId("wxs");
  const resolved = await resolveLocation(deps, principal.userId, opts.location);
  let snapshot: WeatherSnapshot;
  if (!resolved.location || !deps.weather) {
    const location = resolved.location ?? { label: opts.location?.label ?? owner.settings.homeLocation?.label ?? "unknown location", latitude: 0, longitude: 0, timezone: opts.location?.timezone ?? owner.settings.timezone };
    snapshot = buildWeatherSnapshot({ snapshotId, localDate: opts.localDate, location, forecast: null, settings, segment, nowMs, maxAgeMinutes, limitation: resolved.why ?? "No weather provider is configured." });
  } else {
    const location = resolved.location;
    const provider = deps.weather.provider;
    const key = weatherCacheKey(provider.name, location, opts.localDate);
    const cached = await readCache(deps.db, key);
    const ageOf = (f: ProviderForecast) => (nowMs - Date.parse(f.fetchedAt)) / 60_000;
    let forecast: ProviderForecast | null = null;
    let limitation: string | null = null;
    if (cached && ageOf(cached) <= maxAgeMinutes && ageOf(cached) >= 0) {
      forecast = cached;
    } else {
      try {
        // The request itself is made at coarse precision: the provider sees a city-level location.
        forecast = await provider.forecast({ latitude: Number(coarse(location.latitude)), longitude: Number(coarse(location.longitude)), timezone: location.timezone, startDate: opts.localDate, endDate: opts.localDate });
        await writeCache(deps.db, key, opts.localDate, forecast);
      } catch (e) {
        const reason = String((e as Error)?.message ?? e).slice(0, 160);
        if (cached && ageOf(cached) <= MAX_STALE_FORECAST_MINUTES) {
          forecast = cached;
          limitation = `The weather provider could not be reached; using the forecast fetched ${formatAge(Math.round(ageOf(cached)))} ago.`;
        } else {
          limitation = `The weather provider could not be reached and no recent forecast is held (${reason}).`;
        }
      }
    }
    snapshot = buildWeatherSnapshot({ snapshotId, localDate: opts.localDate, location, forecast, settings, segment, nowMs, maxAgeMinutes, limitation });
  }
  if (opts.record !== false) await execAs(deps, principal, "weather.record_snapshot", { snapshot, purpose: opts.purpose }, `weather-snapshot:${snapshotId}`);
  return snapshot;
}

/** Typed tool `weather.forecast` of the weather-for-outfits skill. */
export async function weatherForecast(deps: DailyDeps, principal: Principal, input: WeatherForecastInput, opts: { nowMs?: number } = {}): Promise<WeatherSnapshot> {
  requireScope(principal, "read");
  const p = ForecastSchema.parse(input);
  return fetchWeatherSnapshot(deps, principal, { localDate: p.localDate, location: p.location, segment: p.segment, purpose: p.location ? "trip" : "adhoc", nowMs: opts.nowMs, record: principal.scopes.includes("write") || principal.scopes.includes("admin") });
}

function offsetMinutes(timezone: string, localDate: string): number {
  return Math.round((Date.UTC(Number(localDate.slice(0, 4)), Number(localDate.slice(5, 7)) - 1, Number(localDate.slice(8, 10)), 12) - zonedToUtcMs(localDate, "12:00", timezone)) / 60_000);
}

/** Typed tool `weather.compare_locations`: explicit travel between places, with factual differences only. */
export async function weatherCompareLocations(deps: DailyDeps, principal: Principal, input: WeatherCompareLocationsInput, opts: { nowMs?: number } = {}): Promise<WeatherComparison> {
  requireScope(principal, "read");
  const p = CompareSchema.parse(input);
  const snapshots: WeatherSnapshot[] = [];
  for (const location of p.locations) snapshots.push(await fetchWeatherSnapshot(deps, principal, { localDate: p.localDate, location, purpose: "trip", nowMs: opts.nowMs, record: false }));
  const base = snapshots[0]!;
  const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((b - a) * 10) / 10);
  return {
    localDate: p.localDate,
    snapshots,
    differences: snapshots.slice(1).map((s) => {
      const peak = delta(base.conditions.peakC, s.conditions.peakC);
      const departure = delta(base.conditions.departureC, s.conditions.departureC);
      const known = base.freshness !== "unavailable" && s.freshness !== "unavailable";
      const offset = known ? offsetMinutes(s.location.timezone, p.localDate) - offsetMinutes(base.location.timezone, p.localDate) : null;
      const note = !known
        ? `No comparison: the forecast for ${base.freshness === "unavailable" ? base.location.label : s.location.label} is unavailable.`
        : `${s.location.label} peaks ${peak === null ? "at an unknown temperature" : peak === 0 ? "at the same temperature" : `${Math.abs(peak)} °C ${peak > 0 ? "warmer" : "cooler"}`} than ${base.location.label}${offset ? `; its clock is ${Math.abs(offset) / 60} h ${offset > 0 ? "ahead" : "behind"}` : ""}.`;
      return { label: s.location.label, peakDeltaC: peak, departureDeltaC: departure, utcOffsetDeltaMinutes: offset, note };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Calendar                                                             */
/* ------------------------------------------------------------------ */

export async function readCalendarSnapshot(deps: DailyDeps, principal: Principal, opts: { localDate: string; scope?: string; nowMs?: number; record?: boolean; maxAgeMinutes?: number }): Promise<CalendarSnapshot> {
  assertPrincipal(principal);
  const nowMs = nowOf(deps, opts.nowMs);
  // Within the freshness threshold a successful read is still the read: it is reused, with its real age.
  if (opts.maxAgeMinutes !== undefined) {
    const held = await latestCalendarSnapshot(deps.db, principal.userId, opts.localDate);
    const age = held?.status === "ok" && held.readAt ? (nowMs - Date.parse(held.readAt)) / 60_000 : null;
    if (held && age !== null && age >= 0 && age <= opts.maxAgeMinutes) return { ...held, ageMinutes: Math.round(age) };
  }
  const owner = await loadOwner(deps.db, principal.userId);
  const settings = dailySettings(owner.settings);
  const timezone = owner.settings.timezone;
  const snapshotId = newId("cal");
  let snapshot: CalendarSnapshot;
  const missing = (status: "not_connected" | "error", limitation: string): CalendarSnapshot => ({ snapshotId, localDate: opts.localDate, status, readAt: null, ageMinutes: null, events: [], limitation });
  if (!deps.calendar.reader) {
    snapshot = missing("not_connected", "Google Calendar is not connected.");
  } else {
    try {
      const timeMin = toInstant(zonedToUtcMs(opts.localDate, "00:00", timezone));
      const timeMax = toInstant(zonedToUtcMs(addDays(opts.localDate, 1), "00:00", timezone));
      const raw = await deps.calendar.reader.listEvents(principal.userId, { calendarIds: settings.calendar.readCalendarIds, timeMin, timeMax, timezone });
      // The managed outfit event is the board itself, never context for the board.
      const own = await managedEventId(principal.userId, opts.scope ?? "home", opts.localDate);
      const events = weighEvents(raw.filter((e) => e.eventId !== own), { localDate: opts.localDate, timezone });
      snapshot = { snapshotId, localDate: opts.localDate, status: "ok", readAt: toInstant(nowMs), ageMinutes: 0, events, limitation: null };
    } catch (e) {
      if (e instanceof CalendarNotConnectedError || (e as Error)?.name === "CalendarNotConnectedError") {
        snapshot = missing("not_connected", "Google Calendar is not connected (the grant is missing or was revoked).");
      } else {
        // An API error is never read as a free day. A recent successful read may stand in, with its age.
        const previous = await latestCalendarSnapshot(deps.db, principal.userId, opts.localDate);
        const usable = previous && (previous.status === "ok" || previous.status === "stale") && previous.readAt ? previous : null;
        const age = usable ? Math.round((nowMs - Date.parse(usable.readAt!)) / 60_000) : null;
        snapshot = usable && age !== null && age <= 24 * 60
          ? { snapshotId, localDate: opts.localDate, status: "stale", readAt: usable.readAt, ageMinutes: age, events: usable.events, limitation: `Calendar could not be read; using the read from ${formatAge(age)} ago.` }
          : missing("error", "Calendar could not be read (the service returned an error).");
      }
    }
  }
  if (opts.record !== false) await execAs(deps, principal, "calendar.record_snapshot", { snapshot }, `calendar-snapshot:${snapshotId}`);
  return snapshot;
}
