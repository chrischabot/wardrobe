/**
 * TEST FAKE: stands in for the weather provider HTTP service only.
 *
 * `FakeWeatherProvider` replaces a real `WeatherProvider` adapter (Open-Meteo / WeatherKit) and
 * `FakeGeocoder` replaces the real geocoding service. Every number they return is synthetic and chosen by
 * the test; nothing here is a forecast. Everything downstream of the port (assessment, caching, boards)
 * runs for real. Do not import this from production code.
 *
 * This module does not depend on `cloudflare:test`, so other packages' tests can use it too.
 */
import type { WeatherLocation, WeatherProviderName } from "@garderobe/contracts/ext/daily";
import { addDays, toInstant, zonedToUtcMs } from "@garderobe/domain";
import { WeatherProviderError } from "../ports.ts";
import type { ForecastRequest, Geocoder, ProviderForecast, ProviderHour, WeatherProvider } from "../ports.ts";

/** A value per local hour (0-23): a function, or a sparse record that is linearly interpolated between its hours. */
export type ByHour = Record<number, number> | ((hour: number) => number);

export interface SyntheticHoursSpec {
  temperatureByHour: ByHour;
  /** Percent. Default: 0 for every hour (a synthetic dry day chosen by the test, not an inference). */
  rainProbabilityByHour?: ByHour;
  /** Millimetres per hour. Default 0. */
  rainMmByHour?: ByHour;
  /** km/h. Default 10. */
  gustByHour?: ByHour;
  /** Fields reported as null for every hour, as a provider that does not supply them would. */
  nullFields?: (keyof ProviderHour)[];
}

export interface SyntheticForecastOptions extends SyntheticHoursSpec {
  localDate: string;
  timezone: string;
  latitude?: number;
  longitude?: number;
  fetchedAtMs: number;
}

export const FAKE_WEATHER_ATTRIBUTION = "TEST FAKE weather (synthetic data)";

function valueAt(spec: ByHour | undefined, hour: number, fallback: number): number {
  if (spec === undefined) return fallback;
  if (typeof spec === "function") return spec(hour);
  const points = Object.keys(spec)
    .map(Number)
    .sort((a, b) => a - b);
  if (points.length === 0) return fallback;
  const exact = spec[hour];
  if (exact !== undefined) return exact;
  const before = points.filter((p) => p < hour).pop();
  const after = points.find((p) => p > hour);
  if (before === undefined) return spec[after!]!;
  if (after === undefined) return spec[before]!;
  const t = (hour - before) / (after - before);
  return Math.round((spec[before]! + (spec[after]! - spec[before]!) * t) * 10) / 10;
}

/** The 24 synthetic hours of one local date. */
export function syntheticHours(localDate: string, timezone: string, spec: SyntheticHoursSpec): ProviderHour[] {
  const nulls = new Set<keyof ProviderHour>(spec.nullFields ?? []);
  const hours: ProviderHour[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const hh = hour.toString().padStart(2, "0");
    const temperature = valueAt(spec.temperatureByHour, hour, 0);
    const rainMm = valueAt(spec.rainMmByHour, hour, 0);
    const gust = valueAt(spec.gustByHour, hour, 10);
    const full: ProviderHour = {
      localTime: `${localDate}T${hh}:00`,
      at: toInstant(zonedToUtcMs(localDate, `${hh}:00`, timezone)),
      temperatureC: temperature,
      apparentTemperatureC: temperature,
      precipitationProbabilityPct: valueAt(spec.rainProbabilityByHour, hour, 0),
      precipitationMm: rainMm,
      precipitationType: rainMm > 0 ? "rain" : "none",
      windSpeedKmh: Math.round(gust * 6) / 10,
      windGustKmh: gust,
      humidityPct: 60,
    };
    hours.push({
      localTime: full.localTime,
      at: full.at,
      temperatureC: nulls.has("temperatureC") ? null : full.temperatureC,
      apparentTemperatureC: nulls.has("apparentTemperatureC") ? null : full.apparentTemperatureC,
      precipitationProbabilityPct: nulls.has("precipitationProbabilityPct") ? null : full.precipitationProbabilityPct,
      precipitationMm: nulls.has("precipitationMm") ? null : full.precipitationMm,
      precipitationType: nulls.has("precipitationType") ? null : full.precipitationType,
      windSpeedKmh: nulls.has("windSpeedKmh") ? null : full.windSpeedKmh,
      windGustKmh: nulls.has("windGustKmh") ? null : full.windGustKmh,
      humidityPct: nulls.has("humidityPct") ? null : full.humidityPct,
    });
  }
  return hours;
}

/** A synthetic 24-hour forecast for one local date. Like Open-Meteo, it supplies no issue time and no alerts. */
export function syntheticForecast(opts: SyntheticForecastOptions): ProviderForecast {
  return {
    provider: "open-meteo",
    attribution: FAKE_WEATHER_ATTRIBUTION,
    timezone: opts.timezone,
    latitude: opts.latitude ?? 51.5085,
    longitude: opts.longitude ?? -0.1257,
    fetchedAt: toInstant(opts.fetchedAtMs),
    issuedAt: null,
    hours: syntheticHours(opts.localDate, opts.timezone, opts),
    alerts: null,
    missingFields: ["issuedAt", "alerts"],
  };
}

/** TEST FAKE weather provider: returns the synthetic hours a test configured, or fails on demand. */
export class FakeWeatherProvider implements WeatherProvider {
  readonly name: WeatherProviderName;
  /** Every request received, including the ones that were made to fail. */
  readonly calls: ForecastRequest[] = [];
  private readonly now: () => number;
  private readonly byDate = new Map<string, SyntheticHoursSpec | ProviderHour[]>();
  private failures: { remaining: number; error: Error | null } = { remaining: 0, error: null };

  constructor(opts: { now?: () => number; name?: WeatherProviderName } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.name = opts.name ?? "open-meteo";
  }

  /** Configure the hours of one local date: a synthetic spec, or explicit hours. Dates never configured yield no hours. */
  setForecast(localDate: string, hoursSpec: SyntheticHoursSpec | ProviderHour[]): this {
    this.byDate.set(localDate, hoursSpec);
    return this;
  }

  clearForecasts(): this {
    this.byDate.clear();
    return this;
  }

  /** Make the next `n` calls throw (default: a retryable HTTP 503 WeatherProviderError). */
  failNext(n: number, error?: Error): this {
    this.failures = { remaining: n, error: error ?? null };
    return this;
  }

  async forecast(request: ForecastRequest): Promise<ProviderForecast> {
    this.calls.push({ ...request });
    if (this.failures.remaining > 0) {
      this.failures.remaining -= 1;
      throw this.failures.error ?? new WeatherProviderError("TEST FAKE: simulated provider outage (HTTP 503)", { provider: this.name, status: 503, retryable: true });
    }
    const hours: ProviderHour[] = [];
    for (let date = request.startDate; date <= request.endDate; date = addDays(date, 1)) {
      const spec = this.byDate.get(date);
      if (spec === undefined) continue;
      hours.push(...(Array.isArray(spec) ? spec.map((h) => ({ ...h })) : syntheticHours(date, request.timezone, spec)));
    }
    return {
      provider: this.name,
      attribution: FAKE_WEATHER_ATTRIBUTION,
      timezone: request.timezone,
      latitude: request.latitude,
      longitude: request.longitude,
      fetchedAt: toInstant(this.now()),
      issuedAt: null,
      hours,
      alerts: null,
      missingFields: ["issuedAt", "alerts"],
    };
  }
}

/** Real coordinates and timezones of the four cities the fake knows (GeoNames values, as Open-Meteo geocoding returns them). */
export const FAKE_GEOCODER_PLACES: Record<string, WeatherLocation> = {
  london: { label: "London, United Kingdom", latitude: 51.50853, longitude: -0.12574, timezone: "Europe/London" },
  paris: { label: "Paris, France", latitude: 48.85341, longitude: 2.3488, timezone: "Europe/Paris" },
  "new york": { label: "New York, United States", latitude: 40.71427, longitude: -74.00597, timezone: "America/New_York" },
  tokyo: { label: "Tokyo, Japan", latitude: 35.6895, longitude: 139.69171, timezone: "Asia/Tokyo" },
};

/** TEST FAKE geocoder: a four-city table. Unknown labels return null, as the real geocoder does. */
export class FakeGeocoder implements Geocoder {
  readonly calls: string[] = [];
  private readonly places: Record<string, WeatherLocation>;

  constructor(extraPlaces: Record<string, WeatherLocation> = {}) {
    this.places = { ...FAKE_GEOCODER_PLACES };
    for (const [key, place] of Object.entries(extraPlaces)) this.places[key.trim().toLowerCase()] = place;
  }

  async geocode(label: string): Promise<WeatherLocation | null> {
    this.calls.push(label);
    const normalized = label.trim().toLowerCase();
    // "London" and the fake's own full label "London, United Kingdom" both resolve; nothing else is guessed.
    const place = this.places[normalized] ?? Object.values(this.places).find((p) => p.label.toLowerCase() === normalized);
    return place ? { ...place } : null;
  }
}
