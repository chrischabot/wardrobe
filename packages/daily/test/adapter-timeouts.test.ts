/**
 * A silent provider must not hold a scheduled phase: every external adapter abandons one exchange after
 * its deadline and reports it the way it reports any network failure (retryable; the service then shows
 * a stale or unavailable source truthfully).
 *
 * TEST FAKES: `silentFetch` (never answers) and `stalledBodyFetch` (sends headers, then never finishes
 * the body) stand in for an unresponsive HTTP service. The deadline is shortened to 40 ms for the test.
 */
import { describe, expect, it } from "vitest";
import { createGoogleCalendar } from "../src/calendar/google.ts";
import { CalendarApiError, DEFAULT_REQUEST_TIMEOUT_MS, WeatherProviderError, withRequestTimeout } from "../src/ports.ts";
import type { FetchLike } from "../src/ports.ts";
import { createOpenMeteoGeocoder, createOpenMeteoProvider } from "../src/weather/open-meteo.ts";
import { createWeatherKitProvider } from "../src/weather/weatherkit.ts";

const LONDON = { latitude: 51.5, longitude: -0.1, timezone: "Europe/London", startDate: "2026-09-16", endDate: "2026-09-16" };

/** TEST FAKE: a service that accepts the connection and never answers. Records whether the request was aborted. */
function silentFetch(): { fetch: FetchLike; aborted: () => boolean; calls: () => number } {
  let aborted = false;
  let calls = 0;
  const fetch: FetchLike = (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("TEST-FAKE: aborted"));
      });
    });
  };
  return { fetch, aborted: () => aborted, calls: () => calls };
}

/** TEST FAKE: a service that sends status and headers and then stalls in the body. */
const stalledBodyFetch: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { "content-type": "application/json" } });

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

async function throwawayKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let binary = "";
  for (const b of der) binary += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----\n`;
}

describe("request deadline at the adapter boundary", () => {
  it("the default deadline is fifteen seconds and zero disables it", () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(15_000);
    const fetch: FetchLike = async () => new Response("{}");
    expect(withRequestTimeout(fetch, 0)).toBe(fetch);
  });

  it("passes a normal exchange through unchanged: status, headers, body and an empty 204", async () => {
    const wrapped = withRequestTimeout(async () => new Response('{"ok":true}', { status: 201, headers: { etag: '"e1"' } }), 40);
    const response = await wrapped("https://example.test/");
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"e1"');
    expect(await response.text()).toBe('{"ok":true}');
    const empty = await withRequestTimeout(async () => new Response(null, { status: 204 }), 40)("https://example.test/");
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });

  it("Google Calendar: a read or a write that gets no answer is aborted and reported as a retryable network failure", async () => {
    const silent = silentFetch();
    const calendar = createGoogleCalendar({ fetch: silent.fetch, getAccessToken: async () => "ya29.test-token", timeoutMs: 40 });
    const read = await failure(calendar.listEvents("u1", { calendarIds: ["primary"], timeMin: "2026-09-16T00:00:00Z", timeMax: "2026-09-17T00:00:00Z", timezone: "Europe/London" }));
    expect(read).toBeInstanceOf(CalendarApiError);
    expect((read as CalendarApiError).detail).toEqual({ status: null, retryable: true, reason: "network" });
    expect(silent.aborted()).toBe(true);
    const write = await failure(calendar.deleteEvent("u1", "primary", "abcde"));
    expect((write as CalendarApiError).detail).toEqual({ status: null, retryable: true, reason: "network" });
    expect((write as Error).message).not.toContain("ya29");
    expect(silent.calls()).toBe(2);
  });

  it("Google Calendar: headers followed by a stalled body are abandoned too", async () => {
    const calendar = createGoogleCalendar({ fetch: stalledBodyFetch, getAccessToken: async () => "ya29.test-token", timeoutMs: 40 });
    const error = await failure(calendar.getEvent("u1", "primary", "abcde"));
    expect((error as CalendarApiError).detail).toEqual({ status: null, retryable: true, reason: "network" });
  });

  it("Open-Meteo forecast and geocoding: no answer becomes a retryable provider error", async () => {
    const silent = silentFetch();
    const forecast = await failure(createOpenMeteoProvider({ fetch: silent.fetch, timeoutMs: 40 }).forecast(LONDON));
    expect(forecast).toBeInstanceOf(WeatherProviderError);
    expect((forecast as WeatherProviderError).detail).toEqual({ provider: "open-meteo", retryable: true });
    expect((forecast as Error).message).toMatch(/no complete response within 40 ms/);
    expect(silent.aborted()).toBe(true);
    const geocode = await failure(createOpenMeteoGeocoder({ fetch: stalledBodyFetch, timeoutMs: 40 }).geocode("London"));
    expect((geocode as WeatherProviderError).detail).toEqual({ provider: "open-meteo", retryable: true });
  });

  it("WeatherKit: no answer becomes a retryable provider error", async () => {
    const silent = silentFetch();
    const provider = createWeatherKitProvider({ fetch: silent.fetch, timeoutMs: 40, credentials: { teamId: "TESTTEAM00", serviceId: "test.service", keyId: "TESTKEY000", privateKeyPkcs8Pem: await throwawayKeyPem() } });
    const error = await failure(provider.forecast(LONDON));
    expect(error).toBeInstanceOf(WeatherProviderError);
    expect((error as WeatherProviderError).detail).toEqual({ provider: "weatherkit", retryable: true });
    expect(silent.aborted()).toBe(true);
  });
});
