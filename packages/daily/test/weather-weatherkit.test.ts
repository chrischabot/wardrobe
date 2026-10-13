/**
 * WeatherKit adapter tests.
 *
 * NOT a test against Apple: the project has no Apple credentials. Stand-ins used here:
 *  - a P-256 key generated in the test replaces the real WeatherKit .p8 key;
 *  - `fetch` is replaced by a function returning a hand-written fixture that follows the shapes in Apple's
 *    documentation (Weather, HourlyForecast, HourWeatherConditions, Metadata, WeatherAlertSummary). The
 *    fixture is NOT a recorded WeatherKit response.
 * What this proves: the token has the documented header and claims and its ES256 signature verifies with
 * the matching public key; a documentation-shaped body normalizes to the port's units; errors map.
 */
import { describe, expect, it } from "vitest";
import { WeatherProviderError } from "../src/ports.ts";
import type { FetchLike, ForecastRequest } from "../src/ports.ts";
import { WEATHERKIT_ATTRIBUTION, WEATHERKIT_LEGAL_ATTRIBUTION_URL, createWeatherKitProvider, createWeatherKitToken } from "../src/weather/weatherkit.ts";
import type { WeatherKitCredentials } from "../src/weather/weatherkit.ts";

const LONDON: ForecastRequest = { latitude: 51.5074, longitude: -0.1278, timezone: "Europe/London", startDate: "2026-09-30", endDate: "2026-09-30" };
const NOW = Date.UTC(2026, 8, 30, 6, 0, 0);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Locally generated stand-in for the WeatherKit key, in the same PKCS#8 PEM form as Apple's .p8 file. */
async function generateCredentials(): Promise<{ credentials: WeatherKitCredentials; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const lines = toBase64(pkcs8).match(/.{1,64}/g)!.join("\n");
  return {
    publicKey: pair.publicKey,
    credentials: { teamId: "DEF123GHIJ", serviceId: "com.example.weatherkit-client", keyId: "ABC123DEFG", privateKeyPkcs8Pem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n` },
  };
}

async function verifyToken(token: string, publicKey: CryptoKey): Promise<{ header: unknown; claims: unknown; valid: boolean; signatureBytes: number }> {
  const [header, claims, signature] = token.split(".") as [string, string, string];
  const signatureBytes = fromBase64Url(signature);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signatureBytes as unknown as ArrayBuffer, new TextEncoder().encode(`${header}.${claims}`));
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as unknown;
  return { header: decode(header), claims: decode(claims), valid, signatureBytes: signatureBytes.length };
}

/** Hand-written from Apple's documented shapes; values are invented. London on 2026-09-30 is UTC+1. */
function documentationShapedBody(): Record<string, unknown> {
  const metadata = {
    attributionURL: "https://developer.apple.com/weatherkit/data-source-attribution/",
    expireTime: "2026-09-30T07:00:00Z",
    latitude: 51.507,
    longitude: -0.128,
    readTime: "2026-09-30T06:00:00Z",
    reportedTime: "2026-09-30T05:00:00Z",
    units: "m",
    version: 1,
  };
  const hour = (forecastStart: string, extra: Record<string, unknown>) => ({
    forecastStart,
    cloudCover: 0.5,
    conditionCode: "PartlyCloudy",
    daylight: true,
    humidity: 0.82,
    precipitationAmount: 0,
    precipitationChance: 0,
    precipitationType: "clear",
    pressure: 1014.2,
    pressureTrend: "steady",
    temperature: 12.4,
    temperatureApparent: 11.1,
    temperatureDewPoint: 9.4,
    uvIndex: 1,
    visibility: 24000,
    windDirection: 230,
    windGust: 31.5,
    windSpeed: 14.2,
    ...extra,
  });
  return {
    forecastHourly: {
      name: "HourlyForecast",
      metadata,
      hours: [
        hour("2026-09-29T22:00:00Z", { temperature: 99 }), // 23:00 local the day before: outside the request
        hour("2026-09-29T23:00:00Z", {}),
        hour("2026-09-30T07:00:00Z", { temperature: 13.9, temperatureApparent: 12.5, precipitationChance: 0.35, precipitationAmount: 1.8, precipitationType: "rain", humidity: 0.905 }),
        hour("2026-09-30T08:00:00Z", { precipitationChance: 0.6, precipitationType: "precipitation", precipitationAmount: undefined, windGust: undefined }),
        hour("2026-09-30T22:00:00Z", { precipitationChance: 1, precipitationType: "snow", precipitationAmount: 0.4 }),
        hour("2026-09-30T23:00:00Z", { temperature: 98 }), // 00:00 local the next day: outside the request
      ],
    },
    weatherAlerts: {
      name: "WeatherAlertCollection",
      metadata,
      detailsUrl: "https://weatherkit.apple.com/alertDetails/index.html",
      alerts: [
        {
          id: "6d2f1c0e-0b0a-4d5c-9a57-000000000001",
          areaName: "London & South East England",
          certainty: "likely",
          countryCode: "GB",
          description: "Yellow Wind Warning",
          effectiveTime: "2026-09-30T04:00:00Z",
          eventOnsetTime: "2026-09-30T09:00:00Z",
          eventEndTime: "2026-09-30T18:00:00Z",
          expireTime: "2026-09-30T19:00:00Z",
          issuedTime: "2026-09-30T03:30:00Z",
          responses: [],
          severity: "moderate",
          source: "Met Office",
          urgency: "expected",
        },
        { id: "6d2f1c0e-0b0a-4d5c-9a57-000000000002", certainty: "possible", countryCode: "GB", description: "Yellow Rain Warning", effectiveTime: "2026-09-30T10:00:00Z", expireTime: "2026-09-30T20:00:00Z", issuedTime: "2026-09-30T03:30:00Z", responses: [], severity: "minor", source: "Met Office" },
      ],
    },
  };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function cannedFetch(body: unknown, status = 200): { fetch: FetchLike; requests: Captured[] } {
  const requests: Captured[] = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({ url: input, headers: init?.headers ?? {} });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<WeatherProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WeatherProviderError);
    return error as WeatherProviderError;
  }
  throw new Error("expected the adapter to throw");
}

describe("WeatherKit developer token", () => {
  it("has exactly the documented header and claims, and its ES256 signature verifies with the public key", async () => {
    const { credentials, publicKey } = await generateCredentials();
    const token = await createWeatherKitToken(credentials, NOW, 1800);
    expect(token.split(".")).toHaveLength(3);
    expect(token).not.toMatch(/[+/=]/); // base64url, unpadded
    const verified = await verifyToken(token, publicKey);
    expect(verified.header).toEqual({ alg: "ES256", kid: "ABC123DEFG", id: "DEF123GHIJ.com.example.weatherkit-client" });
    expect(verified.claims).toEqual({ iss: "DEF123GHIJ", iat: NOW / 1000, exp: NOW / 1000 + 1800, sub: "com.example.weatherkit-client" });
    expect(verified.signatureBytes).toBe(64); // raw r||s as JWS requires, not DER
    expect(verified.valid).toBe(true);
  });

  it("does not verify with a different key or after tampering", async () => {
    const { credentials, publicKey } = await generateCredentials();
    const other = await generateCredentials();
    const token = await createWeatherKitToken(credentials, NOW);
    expect((await verifyToken(token, other.publicKey)).valid).toBe(false);
    const [header, , signature] = token.split(".") as [string, string, string];
    const forgedClaims = btoa(JSON.stringify({ iss: "ATTACKER00", iat: 1, exp: 9999999999, sub: "x" })).replace(/=+$/, "");
    expect((await verifyToken(`${header}.${forgedClaims}.${signature}`, publicKey)).valid).toBe(false);
  });

  it("rejects a key that is not PKCS#8 P-256", async () => {
    const bad: WeatherKitCredentials = { teamId: "T", serviceId: "s", keyId: "k", privateKeyPkcs8Pem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" };
    const error = await failure(createWeatherKitToken(bad, NOW));
    expect(error.detail).toEqual({ provider: "weatherkit", retryable: false });
  });
});

describe("WeatherKit forecast adapter (documentation-shaped fixture)", () => {
  it("calls the documented endpoint with a bearer token that verifies", async () => {
    const { credentials, publicKey } = await generateCredentials();
    const transport = cannedFetch(documentationShapedBody());
    await createWeatherKitProvider({ fetch: transport.fetch, credentials, now: () => NOW }).forecast(LONDON);
    const request = transport.requests[0]!;
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe("https://weatherkit.apple.com/api/v1/weather/en/51.5074/-0.1278");
    // Local midnight to local midnight, as UTC instants (London is UTC+1 on this date).
    expect(Object.fromEntries(url.searchParams)).toEqual({ dataSets: "forecastHourly", hourlyStart: "2026-09-29T23:00:00Z", hourlyEnd: "2026-09-30T23:00:00Z", timezone: "Europe/London" });
    expect(request.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const verified = await verifyToken(request.headers.authorization!.slice("Bearer ".length), publicKey);
    expect(verified.valid).toBe(true);
    expect(verified.claims).toMatchObject({ iss: "DEF123GHIJ", sub: "com.example.weatherkit-client", iat: NOW / 1000 });
  });

  it("normalizes fractions to percent and keeps Celsius, km/h and mm", async () => {
    const { credentials } = await generateCredentials();
    const forecast = await createWeatherKitProvider({ fetch: cannedFetch(documentationShapedBody()).fetch, credentials, now: () => NOW }).forecast(LONDON);
    expect(forecast.provider).toBe("weatherkit");
    expect(forecast.attribution).toBe(WEATHERKIT_ATTRIBUTION);
    expect(WEATHERKIT_ATTRIBUTION).toContain("Weather");
    expect(WEATHERKIT_ATTRIBUTION).toContain(WEATHERKIT_LEGAL_ATTRIBUTION_URL);
    expect(WEATHERKIT_LEGAL_ATTRIBUTION_URL).toBe("https://weatherkit.apple.com/legal-attribution.html");
    expect(forecast.fetchedAt).toBe("2026-09-30T06:00:00Z");
    expect(forecast.issuedAt).toBe("2026-09-30T05:00:00Z"); // metadata.reportedTime, not readTime
    expect(forecast.latitude).toBe(51.507);
    expect(forecast.longitude).toBe(-0.128);

    // Only the four hours whose local date is 2026-09-30.
    expect(forecast.hours.map((h) => h.localTime)).toEqual(["2026-09-30T00:00", "2026-09-30T08:00", "2026-09-30T09:00", "2026-09-30T23:00"]);
    expect(forecast.hours[0]).toEqual({
      localTime: "2026-09-30T00:00",
      at: "2026-09-29T23:00:00Z",
      temperatureC: 12.4,
      apparentTemperatureC: 11.1,
      precipitationProbabilityPct: 0,
      precipitationMm: 0,
      precipitationType: "none",
      windSpeedKmh: 14.2,
      windGustKmh: 31.5,
      humidityPct: 82,
    });
    expect(forecast.hours[1]).toMatchObject({ temperatureC: 13.9, apparentTemperatureC: 12.5, precipitationProbabilityPct: 35, precipitationMm: 1.8, precipitationType: "rain", humidityPct: 90.5 });
    // Optional fields absent from the response stay null; an unspecified precipitation type is unknown, not "none".
    expect(forecast.hours[2]).toMatchObject({ precipitationProbabilityPct: 60, precipitationMm: null, precipitationType: null, windGustKmh: null, windSpeedKmh: 14.2 });
    expect(forecast.hours[3]).toMatchObject({ precipitationProbabilityPct: 100, precipitationType: "snow", precipitationMm: 0.4 });
  });

  it("reports alerts as missing when no country code is configured", async () => {
    const { credentials } = await generateCredentials();
    const forecast = await createWeatherKitProvider({ fetch: cannedFetch(documentationShapedBody()).fetch, credentials, now: () => NOW }).forecast(LONDON);
    expect(forecast.alerts).toBeNull();
    expect(forecast.missingFields).toEqual(["alerts"]);
  });

  it("requests and maps weather alerts when a country code is configured", async () => {
    const { credentials } = await generateCredentials();
    const transport = cannedFetch(documentationShapedBody());
    const forecast = await createWeatherKitProvider({ fetch: transport.fetch, credentials, now: () => NOW, countryCode: "GB", language: "en-GB" }).forecast(LONDON);
    const url = new URL(transport.requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/weather/en-GB/51.5074/-0.1278");
    expect(url.searchParams.get("dataSets")).toBe("forecastHourly,weatherAlerts");
    expect(url.searchParams.get("countryCode")).toBe("GB");
    expect(forecast.missingFields).toEqual([]);
    expect(forecast.alerts).toEqual([
      { title: "Yellow Wind Warning", severity: "moderate", startsAt: "2026-09-30T09:00:00Z", endsAt: "2026-09-30T18:00:00Z", source: "Met Office" },
      { title: "Yellow Rain Warning", severity: "minor", startsAt: "2026-09-30T10:00:00Z", endsAt: "2026-09-30T20:00:00Z", source: "Met Office" },
    ]);
  });

  it("lists issuedAt and alerts as missing when the response carries neither", async () => {
    const { credentials } = await generateCredentials();
    const body = documentationShapedBody() as { forecastHourly: { metadata: Record<string, unknown> }; weatherAlerts?: unknown };
    body.forecastHourly.metadata = { ...body.forecastHourly.metadata, reportedTime: undefined };
    delete body.weatherAlerts;
    const forecast = await createWeatherKitProvider({ fetch: cannedFetch(body).fetch, credentials, now: () => NOW, countryCode: "GB" }).forecast(LONDON);
    expect(forecast.issuedAt).toBeNull();
    expect(forecast.alerts).toBeNull();
    expect(forecast.missingFields).toEqual(["issuedAt", "alerts"]);
  });

  it("reuses a token until shortly before it expires", async () => {
    const { credentials } = await generateCredentials();
    const transport = cannedFetch(documentationShapedBody());
    let now = NOW;
    const provider = createWeatherKitProvider({ fetch: transport.fetch, credentials, now: () => now });
    await provider.forecast(LONDON);
    now += 10 * 60_000;
    await provider.forecast(LONDON);
    now += 25 * 60_000;
    await provider.forecast(LONDON);
    const tokens = transport.requests.map((r) => r.headers.authorization);
    expect(tokens[1]).toBe(tokens[0]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it.each([
    [401, { reason: "NOT_ENABLED" }, false],
    [400, { reason: "INVALID_PARAMETER" }, false],
    [429, "rate limited", true],
    [500, "server error", true],
    [503, "unavailable", true],
  ])("maps HTTP %i to WeatherProviderError", async (status, body, retryable) => {
    const { credentials } = await generateCredentials();
    const error = await failure(createWeatherKitProvider({ fetch: cannedFetch(body, status).fetch, credentials, now: () => NOW }).forecast(LONDON));
    expect(error.detail).toEqual({ provider: "weatherkit", status, retryable });
    if (typeof body === "object") expect(error.message).toContain(body.reason);
  });

  it("maps a network exception, a malformed body, non-metric units and temporary unavailability", async () => {
    const { credentials } = await generateCredentials();
    const throwing: FetchLike = async () => {
      throw new TypeError("socket hang up");
    };
    expect((await failure(createWeatherKitProvider({ fetch: throwing, credentials }).forecast(LONDON))).detail).toEqual({ provider: "weatherkit", retryable: true });
    expect((await failure(createWeatherKitProvider({ fetch: cannedFetch("not json").fetch, credentials }).forecast(LONDON))).detail.retryable).toBe(false);
    expect((await failure(createWeatherKitProvider({ fetch: cannedFetch({ currentWeather: {} }).fetch, credentials }).forecast(LONDON))).detail.retryable).toBe(false);

    const imperial = documentationShapedBody() as { forecastHourly: { metadata: Record<string, unknown> } };
    imperial.forecastHourly.metadata.units = "e";
    const unitsError = await failure(createWeatherKitProvider({ fetch: cannedFetch(imperial).fetch, credentials }).forecast(LONDON));
    expect(unitsError.message).toContain("units");
    expect(unitsError.detail.retryable).toBe(false);

    const unavailable = documentationShapedBody() as { forecastHourly: { metadata: Record<string, unknown> } };
    unavailable.forecastHourly.metadata.temporarilyUnavailable = true;
    expect((await failure(createWeatherKitProvider({ fetch: cannedFetch(unavailable).fetch, credentials }).forecast(LONDON))).detail.retryable).toBe(true);
  });
});
