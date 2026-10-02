/**
 * Apple WeatherKit REST adapter (alternate provider).
 *
 * NOT EXERCISED AGAINST THE REAL SERVICE. This project holds no Apple Developer credentials (Team ID,
 * Service ID, WeatherKit key), so no authenticated WeatherKit call has ever been made by this code. It is
 * written from Apple's published documentation and tested with a locally generated P-256 key and a
 * documentation-shaped fixture. Treat it as unproven until `forecast()` has succeeded once with real
 * credentials.
 *
 * Verified against documentation (JSON form fetched 2026-09-30 from
 * https://developer.apple.com/tutorials/data/documentation/weatherkitrestapi/<page>.json):
 *  - get-api-v1-weather-_language_-_latitude_-_longitude_: endpoint
 *    GET https://weatherkit.apple.com/api/v1/weather/{language}/{latitude}/{longitude}; query parameters
 *    dataSets (comma-delimited), hourlyStart, hourlyEnd (date-time), timezone (required), countryCode
 *    ("necessary for weather alerts"); responses 200 Weather, 400 invalid parameter, 401 unauthorized.
 *  - dataset: values forecastHourly and weatherAlerts.
 *  - weather: response members forecastHourly (HourlyForecast) and weatherAlerts (WeatherAlertCollection).
 *  - hourlyforecast, hourlyforecast/hourlyforecastdata, productdata: HourlyForecast = { metadata, hours[] }.
 *  - hourweatherconditions: forecastStart (date-time), temperature and temperatureApparent (degrees
 *    Celsius, at the start of the hour), humidity (0 to 1), precipitationChance (0 to 1, during the hour),
 *    precipitationAmount (millimeters, optional), precipitationType, windSpeed (kilometers per hour),
 *    windGust (kilometers per hour, maximum during the hour, optional).
 *  - precipitationtype: clear, precipitation, rain, snow, sleet, hail, mixed.
 *  - metadata: reportedTime ("the time the provider reported the weather data", optional) is used as
 *    issuedAt; readTime is when Apple procured the data and is not an issue time; units ("set to metric");
 *    temporarilyUnavailable. unitssystem: the only value is "m".
 *  - weatheralertcollection, weatheralertcollection/weatheralertcollectiondata, weatheralertsummary,
 *    severity: alerts[] with description, severity, source, effectiveTime, expireTime, eventOnsetTime,
 *    eventEndTime.
 *  - request-authentication-for-weatherkit-rest-api: `Authorization: Bearer <token>`; ES256 JWT with header
 *    { alg: "ES256", kid: <key id>, id: "<team id>.<service id>" } and claims { iss: <team id>, iat, exp,
 *    sub: <service id> }, "only the claims listed".
 *  - https://developer.apple.com/weatherkit/ ("Apple Weather and third-party attribution"): display the
 *    Apple Weather trademark and the legal link to other data sources.
 * Verified live without credentials: the endpoint exists and answers HTTP 401 with {"reason": "..."} to a
 * missing or malformed token. `scripts/verify-unauthenticated.ts` repeats that through this adapter with
 * a token signed by a throwaway key, which is the only live exchange this file has ever had.
 *
 * NOT verifiable without credentials (assumptions, each handled defensively):
 *  - that Apple accepts the token this code signs (the tests only prove it verifies with the public key);
 *  - the JSON actually returned (field presence, number formats, the form of date-time strings);
 *  - whether hourlyEnd is inclusive (hours are filtered by local date afterwards, so either works);
 *  - whether a `precipitationAmount` is always present (absent becomes null, never zero);
 *  - the body and status of rate-limit and server errors (429 and 5xx are treated as retryable);
 *  - the shape of weatherAlerts for a country without alert coverage (absent becomes alerts: null).
 */
import { addDays, toInstant, zonedToUtcMs } from "@garderobe/domain";
import { WeatherProviderError, withRequestTimeout } from "../ports.ts";
import type { FetchLike, ForecastRequest, ProviderForecast, ProviderHour, WeatherProvider } from "../ports.ts";
import { localTimeOf } from "./assess.ts";

export const WEATHERKIT_BASE_URL = "https://weatherkit.apple.com";
export const WEATHERKIT_LEGAL_ATTRIBUTION_URL = "https://weatherkit.apple.com/legal-attribution.html";
/**
 * Apple requires the Apple Weather trademark (the Apple logo followed by "Weather") and the legal link to
 * other data sources wherever its weather data is shown. U+F8FF is the Apple logo glyph; it only renders
 * in Apple's fonts, so a surface that cannot draw it must show the logo image from Apple's
 * GET /attribution/{language} endpoint instead.
 */
export const WEATHERKIT_ATTRIBUTION = `\uF8FF Weather. Other data sources: ${WEATHERKIT_LEGAL_ATTRIBUTION_URL}`;

export interface WeatherKitCredentials {
  /** 10-character Apple Developer Team ID. */
  teamId: string;
  /** Registered Service ID, e.g. com.example.weatherkit-client. */
  serviceId: string;
  /** 10-character identifier of the WeatherKit key. */
  keyId: string;
  /** The downloaded .p8 key: PKCS#8 PEM of a P-256 private key. */
  privateKeyPkcs8Pem: string;
}

const PROVIDER = "weatherkit" as const;
/** Developer-token lifetime. Short, per Apple's guidance; a token is reused until a minute before expiry. */
export const WEATHERKIT_TOKEN_TTL_SECONDS = 30 * 60;

function fail(message: string, retryable: boolean, status?: number): never {
  throw new WeatherProviderError(message, status === undefined ? { provider: PROVIDER, retryable } : { provider: PROVIDER, status, retryable });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ---------------------------------- token ------------------------------ */

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const base64 = pem.replace(/-----BEGIN [A-Z ]+-----/g, "").replace(/-----END [A-Z ]+-----/g, "").replace(/\s+/g, "");
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return fail("WeatherKit: the private key is not valid PEM", false);
  }
  try {
    return await crypto.subtle.importKey("pkcs8", der as unknown as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch (cause) {
    return fail(`WeatherKit: the private key is not a PKCS#8 P-256 key (${cause instanceof Error ? cause.message : String(cause)})`, false);
  }
}

/**
 * Sign a WeatherKit developer token (compact ES256 JWT). WebCrypto ECDSA returns the raw r||s signature
 * that JWS requires, so no DER conversion is involved.
 */
export async function createWeatherKitToken(credentials: WeatherKitCredentials, nowMs: number, ttlSeconds: number = WEATHERKIT_TOKEN_TTL_SECONDS): Promise<string> {
  const key = await importPrivateKey(credentials.privateKeyPkcs8Pem);
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "ES256", kid: credentials.keyId, id: `${credentials.teamId}.${credentials.serviceId}` };
  const claims = { iss: credentials.teamId, iat, exp: iat + ttlSeconds, sub: credentials.serviceId };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/* ------------------------------ normalization -------------------------- */

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A 0..1 fraction as a percentage, without binary-fraction noise (0.35 -> 35, not 35.00000000000001). */
function fractionToPct(value: unknown): number | null {
  const n = numberOrNull(value);
  return n === null ? null : Math.round(n * 1000) / 10;
}

function instantOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : toInstant(ms);
}

function precipitationType(value: unknown): ProviderHour["precipitationType"] {
  switch (value) {
    case "clear":
      return "none";
    case "rain":
    case "snow":
    case "sleet":
    case "hail":
    case "mixed":
      return value;
    default:
      // "precipitation" (type unspecified) and any undocumented value: the type is unknown, not "none".
      return null;
  }
}

/** Normalize a documented-shape `Weather` response. `alertsRequested` = the weatherAlerts data set was asked for. */
export function normalizeWeatherKitForecast(body: Record<string, unknown>, request: ForecastRequest, fetchedAtMs: number, alertsRequested: boolean): ProviderForecast {
  const forecastHourly = body.forecastHourly;
  if (!isRecord(forecastHourly) || !Array.isArray(forecastHourly.hours)) return fail("WeatherKit: response has no forecastHourly.hours array", false);
  const metadata = isRecord(forecastHourly.metadata) ? forecastHourly.metadata : {};
  if (metadata.temporarilyUnavailable === true) return fail("WeatherKit: hourly forecast is temporarily unavailable", true);
  // Documented as always metric ("m"). Anything else is refused rather than converted on a guess.
  if (metadata.units !== undefined && metadata.units !== "m") return fail(`WeatherKit: unexpected units system ${JSON.stringify(metadata.units)} (expected "m")`, false);

  const hours: ProviderHour[] = [];
  for (const raw of forecastHourly.hours as unknown[]) {
    if (!isRecord(raw)) return fail("WeatherKit: an hourly entry is not an object", false);
    const at = instantOrNull(raw.forecastStart);
    if (at === null) return fail("WeatherKit: an hourly entry has no valid forecastStart", false);
    const localTime = localTimeOf(Date.parse(at), request.timezone);
    const localDate = localTime.slice(0, 10);
    if (localDate < request.startDate || localDate > request.endDate) continue;
    hours.push({
      localTime,
      at,
      temperatureC: numberOrNull(raw.temperature),
      apparentTemperatureC: numberOrNull(raw.temperatureApparent),
      precipitationProbabilityPct: fractionToPct(raw.precipitationChance),
      precipitationMm: numberOrNull(raw.precipitationAmount),
      precipitationType: precipitationType(raw.precipitationType),
      windSpeedKmh: numberOrNull(raw.windSpeed),
      windGustKmh: numberOrNull(raw.windGust),
      humidityPct: fractionToPct(raw.humidity),
    });
  }
  hours.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const missingFields: string[] = [];
  const issuedAt = instantOrNull(metadata.reportedTime);
  if (issuedAt === null) missingFields.push("issuedAt");

  let alerts: ProviderForecast["alerts"] = null;
  const collection = body.weatherAlerts;
  if (alertsRequested && isRecord(collection) && Array.isArray(collection.alerts)) {
    alerts = (collection.alerts as unknown[]).filter(isRecord).map((alert) => ({
      title: typeof alert.description === "string" && alert.description !== "" ? alert.description : "Weather alert",
      severity: typeof alert.severity === "string" ? alert.severity : null,
      startsAt: instantOrNull(alert.eventOnsetTime) ?? instantOrNull(alert.effectiveTime),
      endsAt: instantOrNull(alert.eventEndTime) ?? instantOrNull(alert.expireTime),
      source: typeof alert.source === "string" ? alert.source : null,
    }));
  } else {
    missingFields.push("alerts");
  }

  return {
    provider: PROVIDER,
    attribution: WEATHERKIT_ATTRIBUTION,
    timezone: request.timezone,
    latitude: numberOrNull(metadata.latitude) ?? request.latitude,
    longitude: numberOrNull(metadata.longitude) ?? request.longitude,
    fetchedAt: toInstant(fetchedAtMs),
    issuedAt,
    hours,
    alerts,
    missingFields,
  };
}

/* --------------------------------- provider ---------------------------- */

export interface WeatherKitProviderOptions {
  fetch: FetchLike;
  credentials: WeatherKitCredentials;
  now?: () => number;
  /** Language tag for localized fields (alert text). Default "en". */
  language?: string;
  /**
   * ISO alpha-2 country code of the requested location. Apple documents it as necessary for weather
   * alerts, and a forecast request does not carry one, so alerts are only requested when this is given;
   * otherwise `alerts` is null and listed as missing.
   */
  countryCode?: string | ((request: ForecastRequest) => string | null);
  baseUrl?: string;
  /** Deadline for one request, body included (default 15 s; 0 disables). A timeout is a retryable network failure. */
  timeoutMs?: number;
}

export function createWeatherKitProvider(opts: WeatherKitProviderOptions): WeatherProvider {
  const now = opts.now ?? (() => Date.now());
  const fetchFn = withRequestTimeout(opts.fetch, opts.timeoutMs);
  const baseUrl = (opts.baseUrl ?? WEATHERKIT_BASE_URL).replace(/\/+$/, "");
  const language = opts.language ?? "en";
  let cached: { token: string; expiresAtMs: number } | null = null;

  async function token(): Promise<string> {
    const nowMs = now();
    if (cached && cached.expiresAtMs - 60_000 > nowMs) return cached.token;
    const signed = await createWeatherKitToken(opts.credentials, nowMs);
    cached = { token: signed, expiresAtMs: (Math.floor(nowMs / 1000) + WEATHERKIT_TOKEN_TTL_SECONDS) * 1000 };
    return signed;
  }

  return {
    name: PROVIDER,
    async forecast(request: ForecastRequest): Promise<ProviderForecast> {
      const countryCode = typeof opts.countryCode === "function" ? opts.countryCode(request) : (opts.countryCode ?? null);
      const alertsRequested = typeof countryCode === "string" && countryCode !== "";
      const params = new URLSearchParams({
        dataSets: alertsRequested ? "forecastHourly,weatherAlerts" : "forecastHourly",
        hourlyStart: toInstant(zonedToUtcMs(request.startDate, "00:00", request.timezone)),
        hourlyEnd: toInstant(zonedToUtcMs(addDays(request.endDate, 1), "00:00", request.timezone)),
        timezone: request.timezone,
      });
      if (alertsRequested) params.set("countryCode", countryCode);
      const url = `${baseUrl}/api/v1/weather/${encodeURIComponent(language)}/${request.latitude}/${request.longitude}?${params.toString()}`;

      const bearer = await token();
      let response: Response;
      try {
        response = await fetchFn(url, { method: "GET", headers: { authorization: `Bearer ${bearer}`, accept: "application/json" } });
      } catch (cause) {
        return fail(`WeatherKit: network failure (${cause instanceof Error ? cause.message : String(cause)})`, true);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (cause) {
        return fail(`WeatherKit: response body could not be read (${cause instanceof Error ? cause.message : String(cause)})`, true, response.status);
      }
      let body: unknown = undefined;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (response.status < 200 || response.status > 299) {
        const reason = isRecord(body) && typeof body.reason === "string" ? ` (${body.reason})` : "";
        // A rejected token must not be reused.
        if (response.status === 401) cached = null;
        return fail(`WeatherKit: HTTP ${response.status}${reason}`, response.status >= 500 || response.status === 429, response.status);
      }
      if (!isRecord(body)) return fail("WeatherKit: response is not a JSON object", false, response.status);
      return normalizeWeatherKitForecast(body, request, now(), alertsRequested);
    },
  };
}
