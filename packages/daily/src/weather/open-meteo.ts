/**
 * Open-Meteo adapter: hourly forecast and city geocoding over plain HTTP GET (no key, no account).
 *
 * Contract checked on 2026-09-30 against the live API (curl from the build sandbox) and
 * https://open-meteo.com/en/docs. `scripts/verify-open-meteo.ts` re-checks it on demand.
 *
 *  - GET https://api.open-meteo.com/v1/forecast with latitude, longitude, timezone, start_date, end_date,
 *    hourly=<comma list>, temperature_unit=celsius, wind_speed_unit=kmh, precipitation_unit=mm.
 *  - Response: latitude, longitude (the grid cell actually used), utc_offset_seconds, timezone,
 *    hourly_units{<variable>: unit}, hourly{time[], <variable>[]}. Units observed and asserted here:
 *    temperature_2m / apparent_temperature "°C"; precipitation / rain / showers "mm"; snowfall "cm" (always
 *    centimetres in metric mode; it is only used as a presence test, never added to a millimetre amount);
 *    wind_speed_10m / wind_gusts_10m "km/h"; precipitation_probability / relative_humidity_2m "%".
 *  - Errors: HTTP 400 with {"error": true, "reason": "..."}.
 *  - The forecast endpoint returns no forecast issue/model-run time and no weather alerts, so `issuedAt`
 *    and `alerts` are null and both are listed in `missingFields`.
 *
 * Two properties of the live contract shape the normalization below:
 *
 *  1. `hourly.time` is UTC plus ONE fixed offset (`utc_offset_seconds`, the offset in force when the call
 *     is made), not true wall time across a daylight-saving change. Observed: a Sydney request spanning
 *     the 2026-10-04 change returned 72 labels at +10:00 throughout. The adapter therefore takes the
 *     instant as label minus `utc_offset_seconds` and derives the real local wall time from that instant,
 *     and it requests one extra day on each side so the requested local dates are fully covered.
 *  2. Per the documentation table, temperature, apparent temperature, humidity, wind speed and weather
 *     code are instantaneous values at the labelled hour, while precipitation, rain, showers, snowfall,
 *     precipitation probability and wind gusts describe the PRECEDING hour. A `ProviderHour` describes the
 *     hour that starts at `localTime`, so those interval values are read from the next label (the value
 *     labelled 09:00 belongs to the 08:00-09:00 hour). When the next label is absent they are null.
 */
import type { WeatherLocation } from "@garderobe/contracts/ext/daily";
import { addDays, toInstant } from "@garderobe/domain";
import { WeatherProviderError, withRequestTimeout } from "../ports.ts";
import type { FetchLike, ForecastRequest, Geocoder, ProviderForecast, ProviderHour, WeatherProvider } from "../ports.ts";
import { localTimeOf } from "./assess.ts";

/** Attribution required by Open-Meteo's CC BY 4.0 data licence. */
export const OPEN_METEO_ATTRIBUTION = "Weather data by Open-Meteo.com";
export const OPEN_METEO_FORECAST_BASE_URL = "https://api.open-meteo.com";
export const OPEN_METEO_GEOCODING_BASE_URL = "https://geocoding-api.open-meteo.com";

/** Hourly variables requested, with the unit the response must declare for each. */
export const OPEN_METEO_HOURLY_UNITS = {
  temperature_2m: "°C",
  apparent_temperature: "°C",
  precipitation_probability: "%",
  precipitation: "mm",
  rain: "mm",
  showers: "mm",
  snowfall: "cm",
  weather_code: null, // dimensionless WMO code; its unit label is not asserted
  wind_speed_10m: "km/h",
  wind_gusts_10m: "km/h",
  relative_humidity_2m: "%",
} as const satisfies Record<string, string | null>;

type HourlyVariable = keyof typeof OPEN_METEO_HOURLY_UNITS;
export const OPEN_METEO_HOURLY_VARIABLES = Object.keys(OPEN_METEO_HOURLY_UNITS) as HourlyVariable[];

const PROVIDER = "open-meteo" as const;
const LABEL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function fail(message: string, retryable: boolean, status?: number): never {
  throw new WeatherProviderError(message, status === undefined ? { provider: PROVIDER, retryable } : { provider: PROVIDER, status, retryable });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GET a JSON object, mapping every failure mode to WeatherProviderError. */
async function getJson(fetchFn: FetchLike, url: string, what: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchFn(url, { method: "GET", headers: { accept: "application/json" } });
  } catch (cause) {
    return fail(`${what}: network failure (${cause instanceof Error ? cause.message : String(cause)})`, true);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    return fail(`${what}: response body could not be read (${cause instanceof Error ? cause.message : String(cause)})`, true, response.status);
  }
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : null;
  if (response.status < 200 || response.status > 299) {
    const retryable = response.status >= 500 || response.status === 429;
    return fail(`${what}: HTTP ${response.status}${reason ? ` (${reason})` : ""}`, retryable, response.status);
  }
  if (!isRecord(body)) return fail(`${what}: response is not a JSON object`, false, response.status);
  if (body.error === true) return fail(`${what}: provider error${reason ? ` (${reason})` : ""}`, false, response.status);
  return body;
}

/* ------------------------------ precipitation -------------------------- */

/** WMO weather interpretation codes as listed in the Open-Meteo documentation. */
function typeFromCode(code: number): ProviderHour["precipitationType"] {
  if ([51, 53, 55, 61, 63, 65].includes(code)) return "rain";
  if ([56, 57, 66, 67].includes(code)) return "sleet"; // freezing drizzle / freezing rain
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([80, 81, 82, 95, 97].includes(code)) return "showers";
  if ([96, 99].includes(code)) return "hail";
  return "none";
}

/**
 * Precipitation type of one hour from the rain, showers and snowfall amounts of that hour and the WMO
 * codes at its two ends. Amounts decide whenever all three are supplied (all zero = "none"); the code
 * only refines wet hours (freezing, hail) or stands in when an amount is missing. All inputs null = null.
 */
export function precipitationTypeOf(input: { rainMm: number | null; showersMm: number | null; snowfallCm: number | null; codes: (number | null)[] }): ProviderHour["precipitationType"] {
  const codes = input.codes.filter((c): c is number => c !== null);
  const { rainMm, showersMm, snowfallCm } = input;
  if (rainMm === null || showersMm === null || snowfallCm === null) {
    if (codes.length === 0) return null;
    const types = codes.map(typeFromCode).filter((t) => t !== "none");
    return types[types.length - 1] ?? "none";
  }
  const liquid = rainMm > 0 || showersMm > 0;
  const snow = snowfallCm > 0;
  if (!liquid && !snow) return "none";
  if (liquid && snow) return "mixed";
  if (snow) return "snow";
  if (codes.some((c) => c === 96 || c === 99)) return "hail";
  if (codes.some((c) => [56, 57, 66, 67].includes(c))) return "sleet";
  return rainMm >= showersMm ? "rain" : "showers";
}

/* --------------------------------- forecast ---------------------------- */

function readSeries(hourly: Record<string, unknown>, variable: HourlyVariable, length: number): (number | null)[] | null {
  const raw = hourly[variable];
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length !== length) return fail(`Open-Meteo forecast: hourly.${variable} is not an array of ${length} values`, false);
  return raw.map((value) => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) return fail(`Open-Meteo forecast: hourly.${variable} contains a non-numeric value`, false);
    return value;
  });
}

/** Normalize a forecast response body. Exported so the live verification script can inspect the same path. */
export function normalizeOpenMeteoForecast(body: Record<string, unknown>, request: ForecastRequest, fetchedAtMs: number): ProviderForecast {
  const hourly = body.hourly;
  const units = body.hourly_units;
  const offsetSeconds = body.utc_offset_seconds;
  if (!isRecord(hourly) || !Array.isArray(hourly.time)) return fail("Open-Meteo forecast: response has no hourly.time array", false);
  if (!isRecord(units)) return fail("Open-Meteo forecast: response has no hourly_units object", false);
  if (typeof offsetSeconds !== "number" || !Number.isFinite(offsetSeconds)) return fail("Open-Meteo forecast: response has no utc_offset_seconds", false);

  // Label -> UTC instant. Labels are UTC + utc_offset_seconds (see the header comment).
  const instants = (hourly.time as unknown[]).map((label) => {
    const m = typeof label === "string" ? LABEL.exec(label) : null;
    if (!m) return fail(`Open-Meteo forecast: unexpected time label ${JSON.stringify(label)} (expected YYYY-MM-DDTHH:mm)`, false);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) - offsetSeconds * 1000;
  });

  const missingFields = ["issuedAt", "alerts"];
  const series = {} as Record<HourlyVariable, (number | null)[] | null>;
  for (const variable of OPEN_METEO_HOURLY_VARIABLES) {
    const values = readSeries(hourly, variable, instants.length);
    series[variable] = values;
    if (values === null) {
      missingFields.push(`hourly.${variable}`);
      continue;
    }
    const expected = OPEN_METEO_HOURLY_UNITS[variable];
    if (expected !== null && units[variable] !== expected) {
      return fail(`Open-Meteo forecast: ${variable} is reported in ${JSON.stringify(units[variable])}, expected ${JSON.stringify(expected)}; refusing to convert`, false);
    }
  }

  const instant = (variable: HourlyVariable, i: number): number | null => series[variable]?.[i] ?? null;
  /** Value for the hour STARTING at label i of a variable reported for the preceding hour. */
  const interval = (variable: HourlyVariable, i: number): number | null => {
    const next = instants[i + 1];
    if (next === undefined || next - instants[i]! !== 3_600_000) return null;
    return series[variable]?.[i + 1] ?? null;
  };

  const hours: ProviderHour[] = [];
  for (let i = 0; i < instants.length; i++) {
    const atMs = instants[i]!;
    const localTime = localTimeOf(atMs, request.timezone);
    const localDate = localTime.slice(0, 10);
    if (localDate < request.startDate || localDate > request.endDate) continue;
    hours.push({
      localTime,
      at: toInstant(atMs),
      temperatureC: instant("temperature_2m", i),
      apparentTemperatureC: instant("apparent_temperature", i),
      precipitationProbabilityPct: interval("precipitation_probability", i),
      precipitationMm: interval("precipitation", i),
      precipitationType: precipitationTypeOf({
        rainMm: interval("rain", i),
        showersMm: interval("showers", i),
        snowfallCm: interval("snowfall", i),
        codes: [instant("weather_code", i), instants[i + 1] === undefined ? null : instant("weather_code", i + 1)],
      }),
      windSpeedKmh: instant("wind_speed_10m", i),
      windGustKmh: interval("wind_gusts_10m", i),
      humidityPct: instant("relative_humidity_2m", i),
    });
  }

  return {
    provider: PROVIDER,
    attribution: OPEN_METEO_ATTRIBUTION,
    timezone: request.timezone,
    latitude: typeof body.latitude === "number" ? body.latitude : request.latitude,
    longitude: typeof body.longitude === "number" ? body.longitude : request.longitude,
    fetchedAt: toInstant(fetchedAtMs),
    issuedAt: null,
    hours,
    alerts: null,
    missingFields,
  };
}

/** The exact forecast URL the adapter calls for a request (one extra day each side; see the header comment). */
export function openMeteoForecastUrl(request: ForecastRequest, baseUrl: string = OPEN_METEO_FORECAST_BASE_URL): string {
  const params = new URLSearchParams({
    latitude: String(request.latitude),
    longitude: String(request.longitude),
    timezone: request.timezone,
    start_date: addDays(request.startDate, -1),
    end_date: addDays(request.endDate, 1),
    hourly: OPEN_METEO_HOURLY_VARIABLES.join(","),
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
  });
  return `${baseUrl.replace(/\/+$/, "")}/v1/forecast?${params.toString()}`;
}

export function createOpenMeteoProvider(opts: { fetch: FetchLike; baseUrl?: string; now?: () => number; timeoutMs?: number }): WeatherProvider {
  const now = opts.now ?? (() => Date.now());
  const fetchFn = withRequestTimeout(opts.fetch, opts.timeoutMs);
  return {
    name: PROVIDER,
    async forecast(request: ForecastRequest): Promise<ProviderForecast> {
      const body = await getJson(fetchFn, openMeteoForecastUrl(request, opts.baseUrl), "Open-Meteo forecast");
      return normalizeOpenMeteoForecast(body, request, now());
    },
  };
}

/* -------------------------------- geocoding ---------------------------- */

export function createOpenMeteoGeocoder(opts: { fetch: FetchLike; baseUrl?: string; timeoutMs?: number }): Geocoder {
  const baseUrl = (opts.baseUrl ?? OPEN_METEO_GEOCODING_BASE_URL).replace(/\/+$/, "");
  const fetchFn = withRequestTimeout(opts.fetch, opts.timeoutMs);
  return {
    async geocode(label: string): Promise<WeatherLocation | null> {
      const name = label.trim();
      if (name === "") return null;
      const params = new URLSearchParams({ name, count: "1", language: "en", format: "json" });
      const body = await getJson(fetchFn, `${baseUrl}/v1/search?${params.toString()}`, "Open-Meteo geocoding");
      // No match: the live API answers 200 with no `results` key at all.
      if (body.results === undefined) return null;
      if (!Array.isArray(body.results)) return fail("Open-Meteo geocoding: results is not an array", false);
      const first: unknown = body.results[0];
      if (first === undefined) return null;
      if (!isRecord(first) || typeof first.name !== "string" || typeof first.latitude !== "number" || typeof first.longitude !== "number") {
        return fail("Open-Meteo geocoding: result lacks name, latitude or longitude", false);
      }
      // A place without a timezone cannot be used for a local-day forecast; it is not guessed.
      if (typeof first.timezone !== "string" || first.timezone === "") return null;
      const country = typeof first.country === "string" && first.country !== "" ? first.country : null;
      return { label: country ? `${first.name}, ${country}` : first.name, latitude: first.latitude, longitude: first.longitude, timezone: first.timezone };
    },
  };
}
