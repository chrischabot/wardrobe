/**
 * Open-Meteo adapter against RECORDED real responses (test/fixtures/open-meteo-london.ts).
 * The only stand-in is the HTTP transport: `fetch` is replaced by a function returning the recorded
 * body. The live service itself is exercised by scripts/verify-open-meteo.ts, not here.
 */
import { describe, expect, it } from "vitest";
import { WeatherProviderError } from "../src/ports.ts";
import type { FetchLike, ForecastRequest } from "../src/ports.ts";
import { OPEN_METEO_ATTRIBUTION, createOpenMeteoGeocoder, createOpenMeteoProvider, precipitationTypeOf } from "../src/weather/open-meteo.ts";
import { OPEN_METEO_ERROR_BODY, OPEN_METEO_LONDON_FORECAST, OPEN_METEO_LONDON_GEOCODING, OPEN_METEO_NO_MATCH_GEOCODING } from "./fixtures/open-meteo-london.ts";

const LONDON: ForecastRequest = { latitude: 51.5074, longitude: -0.1278, timezone: "Europe/London", startDate: "2026-09-30", endDate: "2026-09-30" };
const NOW = Date.UTC(2026, 8, 30, 6, 0, 0);

/** Transport stand-in: answers every request with one canned body and records the URLs asked for. */
function cannedFetch(body: unknown, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(input);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
  };
}

function recorded(): typeof OPEN_METEO_LONDON_FORECAST {
  return structuredClone(OPEN_METEO_LONDON_FORECAST);
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

describe("Open-Meteo forecast adapter", () => {
  it("requests the documented parameters, one extra day each side", async () => {
    const transport = cannedFetch(recorded());
    await createOpenMeteoProvider({ fetch: transport.fetch, now: () => NOW }).forecast(LONDON);
    const url = new URL(transport.urls[0]!);
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "51.5074",
      longitude: "-0.1278",
      timezone: "Europe/London",
      start_date: "2026-09-29",
      end_date: "2026-10-01",
      hourly: "temperature_2m,apparent_temperature,precipitation_probability,precipitation,rain,showers,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m",
      temperature_unit: "celsius",
      wind_speed_unit: "kmh",
      precipitation_unit: "mm",
    });
  });

  it("normalizes the recorded London response for the requested local date", async () => {
    const transport = cannedFetch(recorded());
    const forecast = await createOpenMeteoProvider({ fetch: transport.fetch, now: () => NOW }).forecast(LONDON);

    expect(forecast.provider).toBe("open-meteo");
    expect(forecast.attribution).toBe(OPEN_METEO_ATTRIBUTION);
    expect(forecast.attribution).toBe("Weather data by Open-Meteo.com");
    expect(forecast.timezone).toBe("Europe/London");
    expect(forecast.latitude).toBe(51.51147);
    expect(forecast.longitude).toBe(-0.13078308);
    expect(forecast.fetchedAt).toBe("2026-09-30T06:00:00Z");
    expect(forecast.issuedAt).toBeNull();
    expect(forecast.alerts).toBeNull();
    expect(forecast.missingFields).toEqual(["issuedAt", "alerts"]);

    expect(forecast.hours).toHaveLength(24);
    expect(forecast.hours.map((h) => h.localTime.slice(0, 10))).toEqual(Array(24).fill("2026-09-30"));
    // British Summer Time: local midnight is 23:00 UTC the day before.
    expect(forecast.hours[0]).toEqual({
      localTime: "2026-09-30T00:00",
      at: "2026-09-29T23:00:00Z",
      temperatureC: 22.0,
      apparentTemperatureC: 23.0,
      precipitationProbabilityPct: 8, // the value labelled 01:00 describes 00:00-01:00
      precipitationMm: 0,
      precipitationType: "none",
      windSpeedKmh: 10.4,
      windGustKmh: 25.9,
      humidityPct: 73,
    });
    // 08:00: instantaneous values from the 08:00 label, interval values from the 09:00 label.
    expect(forecast.hours[8]).toEqual({
      localTime: "2026-09-30T08:00",
      at: "2026-09-30T07:00:00Z",
      temperatureC: 21.5,
      apparentTemperatureC: 21.9,
      precipitationProbabilityPct: 76,
      precipitationMm: 0,
      precipitationType: "none",
      windSpeedKmh: 14.0,
      windGustKmh: 34.9,
      humidityPct: 75,
    });
    // 09:00-10:00: 0.2 mm of rain, no showers.
    expect(forecast.hours[9]).toMatchObject({ precipitationMm: 0.2, precipitationType: "rain", precipitationProbabilityPct: 84 });
    // 04:00-05:00: showers only.
    expect(forecast.hours[4]).toMatchObject({ precipitationType: "showers" });
    // 23:00-24:00 takes its interval values from the next day's 00:00 label.
    expect(forecast.hours[23]).toMatchObject({ localTime: "2026-09-30T23:00", temperatureC: 19.3, precipitationProbabilityPct: 21, precipitationType: "showers", windGustKmh: 35.3 });
  });

  it("leaves interval values null, not zero, when the following label is absent", async () => {
    const transport = cannedFetch(recorded());
    const forecast = await createOpenMeteoProvider({ fetch: transport.fetch, now: () => NOW }).forecast({ ...LONDON, endDate: "2026-10-01" });
    expect(forecast.hours).toHaveLength(48);
    const last = forecast.hours[47]!;
    expect(last.localTime).toBe("2026-10-01T23:00");
    expect(last.temperatureC).toBe(15.7);
    expect(last.humidityPct).toBe(61);
    expect(last.precipitationProbabilityPct).toBeNull();
    expect(last.precipitationMm).toBeNull();
    expect(last.windGustKmh).toBeNull();
    // The amounts for 23:00-24:00 are unknown, so the type falls back to the weather code at 23:00 (0 = clear).
    expect(last.precipitationType).toBe("none");
  });

  it("preserves null elements as null", async () => {
    const body = recorded() as unknown as { hourly: Record<string, (number | null)[]> };
    body.hourly.temperature_2m![8] = null;
    body.hourly.precipitation![9] = null;
    body.hourly.precipitation_probability![9] = null;
    body.hourly.wind_gusts_10m![9] = null;
    body.hourly.relative_humidity_2m![8] = null;
    for (const variable of ["rain", "showers", "snowfall"]) body.hourly[variable]![13] = null;
    body.hourly.weather_code![12] = null;
    body.hourly.weather_code![13] = null;
    const forecast = await createOpenMeteoProvider({ fetch: cannedFetch(body).fetch, now: () => NOW }).forecast(LONDON);
    expect(forecast.hours[8]).toMatchObject({ temperatureC: null, precipitationMm: null, precipitationProbabilityPct: null, windGustKmh: null, humidityPct: null, apparentTemperatureC: 21.9 });
    expect(forecast.hours[12]!.precipitationType).toBeNull();
    expect(forecast.hours[7]!.temperatureC).toBe(21.1);
  });

  it("reports a requested variable that the response omits", async () => {
    const body = recorded() as unknown as { hourly: Record<string, unknown>; hourly_units: Record<string, unknown> };
    delete body.hourly.wind_gusts_10m;
    delete body.hourly_units.wind_gusts_10m;
    const forecast = await createOpenMeteoProvider({ fetch: cannedFetch(body).fetch, now: () => NOW }).forecast(LONDON);
    expect(forecast.missingFields).toEqual(["issuedAt", "alerts", "hourly.wind_gusts_10m"]);
    expect(forecast.hours.every((h) => h.windGustKmh === null)).toBe(true);
    expect(forecast.hours[8]!.windSpeedKmh).toBe(14.0);
  });

  it.each([
    ["temperature_2m", "°F"],
    ["wind_gusts_10m", "mp/h"],
    ["precipitation", "inch"],
    ["relative_humidity_2m", "fraction"],
  ])("rejects %s reported in %s instead of converting", async (variable, unit) => {
    const body = recorded() as unknown as { hourly_units: Record<string, string> };
    body.hourly_units[variable] = unit;
    const error = await failure(createOpenMeteoProvider({ fetch: cannedFetch(body).fetch }).forecast(LONDON));
    expect(error.message).toContain(variable);
    expect(error.message).toContain("refusing to convert");
    expect(error.detail).toMatchObject({ provider: "open-meteo", retryable: false });
  });

  it("derives true local time from the instant when the service labels across a daylight-saving change with one fixed offset", async () => {
    // Shape observed live for Australia/Sydney over the 2026-10-04 change: every label at +10:00.
    // (Constructed body with temperature = label index; not a recorded response.)
    const time: string[] = [];
    for (const day of ["2026-10-04", "2026-10-05", "2026-10-06"]) for (let h = 0; h < 24; h++) time.push(`${day}T${h.toString().padStart(2, "0")}:00`);
    const body = { latitude: -33.87, longitude: 151.21, utc_offset_seconds: 36000, timezone: "Australia/Sydney", hourly_units: { temperature_2m: "°C" }, hourly: { time, temperature_2m: time.map((_, i) => i) } };
    const forecast = await createOpenMeteoProvider({ fetch: cannedFetch(body).fetch, now: () => NOW }).forecast({ latitude: -33.87, longitude: 151.21, timezone: "Australia/Sydney", startDate: "2026-10-05", endDate: "2026-10-05" });
    expect(forecast.hours).toHaveLength(24);
    // Local midnight on 5 October is 13:00 UTC on the 4th (UTC+11), which the service labelled "2026-10-04T23:00".
    expect(forecast.hours[0]).toMatchObject({ localTime: "2026-10-05T00:00", at: "2026-10-04T13:00:00Z", temperatureC: 23 });
    expect(forecast.hours[23]).toMatchObject({ localTime: "2026-10-05T23:00", at: "2026-10-05T12:00:00Z", temperatureC: 46 });
  });

  it("maps HTTP 500 to a retryable error", async () => {
    const error = await failure(createOpenMeteoProvider({ fetch: cannedFetch("upstream unavailable", 500).fetch }).forecast(LONDON));
    expect(error.detail).toEqual({ provider: "open-meteo", status: 500, retryable: true });
  });

  it("maps HTTP 429 to a retryable error", async () => {
    const error = await failure(createOpenMeteoProvider({ fetch: cannedFetch({ error: true, reason: "Too many requests" }, 429).fetch }).forecast(LONDON));
    expect(error.detail).toEqual({ provider: "open-meteo", status: 429, retryable: true });
  });

  it("maps the recorded HTTP 400 error body to a non-retryable error carrying the reason", async () => {
    const error = await failure(createOpenMeteoProvider({ fetch: cannedFetch(OPEN_METEO_ERROR_BODY, 400).fetch }).forecast(LONDON));
    expect(error.detail).toEqual({ provider: "open-meteo", status: 400, retryable: false });
    expect(error.message).toContain("bogus_var");
  });

  it('treats an {"error": true} body as a failure even with HTTP 200', async () => {
    const error = await failure(createOpenMeteoProvider({ fetch: cannedFetch({ error: true, reason: "nope" }, 200).fetch }).forecast(LONDON));
    expect(error.detail.retryable).toBe(false);
    expect(error.message).toContain("nope");
  });

  it("maps a network exception to a retryable error", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("connection reset");
    };
    const error = await failure(createOpenMeteoProvider({ fetch }).forecast(LONDON));
    expect(error.detail).toEqual({ provider: "open-meteo", retryable: true });
    expect(error.message).toContain("connection reset");
  });

  it.each([
    ["a non-JSON body", "<html>gateway</html>"],
    ["a body without hourly data", { latitude: 1, longitude: 2, utc_offset_seconds: 0 }],
    ["a series of the wrong length", { utc_offset_seconds: 0, hourly_units: { temperature_2m: "°C" }, hourly: { time: ["2026-09-30T00:00", "2026-09-30T01:00"], temperature_2m: [1] } }],
    ["a non-numeric value", { utc_offset_seconds: 0, hourly_units: { temperature_2m: "°C" }, hourly: { time: ["2026-09-30T00:00"], temperature_2m: ["12"] } }],
    ["an unexpected time format", { utc_offset_seconds: 0, hourly_units: {}, hourly: { time: [1790949600] } }],
  ])("rejects %s as malformed", async (_name, body) => {
    const error = await failure(createOpenMeteoProvider({ fetch: cannedFetch(body).fetch }).forecast(LONDON));
    expect(error.detail.provider).toBe("open-meteo");
  });
});

describe("precipitationTypeOf", () => {
  it("is none when the amounts are present and zero, whatever the code says", () => {
    expect(precipitationTypeOf({ rainMm: 0, showersMm: 0, snowfallCm: 0, codes: [61, 63] })).toBe("none");
  });
  it("is null when every input is null", () => {
    expect(precipitationTypeOf({ rainMm: null, showersMm: null, snowfallCm: null, codes: [null, null] })).toBeNull();
  });
  it("separates rain, showers, snow and mixed by amount", () => {
    expect(precipitationTypeOf({ rainMm: 1.2, showersMm: 0, snowfallCm: 0, codes: [61] })).toBe("rain");
    expect(precipitationTypeOf({ rainMm: 0, showersMm: 0.4, snowfallCm: 0, codes: [80] })).toBe("showers");
    expect(precipitationTypeOf({ rainMm: 0, showersMm: 0, snowfallCm: 0.7, codes: [71] })).toBe("snow");
    expect(precipitationTypeOf({ rainMm: 0.3, showersMm: 0, snowfallCm: 0.7, codes: [71] })).toBe("mixed");
  });
  it("uses the WMO code to refine wet hours and to stand in for missing amounts", () => {
    expect(precipitationTypeOf({ rainMm: 0.5, showersMm: 0, snowfallCm: 0, codes: [66] })).toBe("sleet");
    expect(precipitationTypeOf({ rainMm: 0, showersMm: 2, snowfallCm: 0, codes: [96] })).toBe("hail");
    expect(precipitationTypeOf({ rainMm: null, showersMm: null, snowfallCm: null, codes: [73] })).toBe("snow");
    expect(precipitationTypeOf({ rainMm: null, showersMm: null, snowfallCm: null, codes: [2] })).toBe("none");
  });
});

describe("Open-Meteo geocoder", () => {
  it("resolves the recorded London response", async () => {
    const transport = cannedFetch(OPEN_METEO_LONDON_GEOCODING);
    const place = await createOpenMeteoGeocoder({ fetch: transport.fetch }).geocode(" London ");
    expect(place).toEqual({ label: "London, United Kingdom", latitude: 51.50853, longitude: -0.12574, timezone: "Europe/London" });
    const url = new URL(transport.urls[0]!);
    expect(url.origin + url.pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: "London", count: "1", language: "en", format: "json" });
  });

  it("returns null for the recorded no-match response and for an empty results list", async () => {
    expect(await createOpenMeteoGeocoder({ fetch: cannedFetch(OPEN_METEO_NO_MATCH_GEOCODING).fetch }).geocode("Zzzxqqnowhere")).toBeNull();
    expect(await createOpenMeteoGeocoder({ fetch: cannedFetch({ results: [] }).fetch }).geocode("Nowhere")).toBeNull();
  });

  it("does not call the service for a blank label, and never guesses a timezone", async () => {
    const transport = cannedFetch(OPEN_METEO_LONDON_GEOCODING);
    expect(await createOpenMeteoGeocoder({ fetch: transport.fetch }).geocode("   ")).toBeNull();
    expect(transport.urls).toHaveLength(0);
    const noTimezone = { results: [{ name: "Somewhere", latitude: 1, longitude: 2, country: "Nowhere" }] };
    expect(await createOpenMeteoGeocoder({ fetch: cannedFetch(noTimezone).fetch }).geocode("Somewhere")).toBeNull();
  });

  it("maps a server failure to a retryable error", async () => {
    const error = await failure(createOpenMeteoGeocoder({ fetch: cannedFetch("oops", 503).fetch }).geocode("London"));
    expect(error.detail).toEqual({ provider: "open-meteo", status: 503, retryable: true });
  });
});
