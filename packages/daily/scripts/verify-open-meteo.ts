/**
 * Live contract check for the Open-Meteo adapters. Calls the REAL forecast and geocoding endpoints through
 * the real adapter code with Node's global fetch (nothing is faked) and exits non-zero when the live
 * contract no longer matches what the adapter expects.
 *
 *   cd wardrobe/packages/daily
 *   node --experimental-transform-types scripts/verify-open-meteo.ts
 *
 * (`--experimental-strip-types` alone cannot load `src/ports.ts`, whose error classes use constructor
 * parameter properties; `--experimental-transform-types` handles them.)
 */
import { addDays, localDateOf, toInstant, zonedToUtcMs } from "@garderobe/domain";
import { WeatherProviderError } from "../src/ports.ts";
import type { FetchLike, ProviderHour } from "../src/ports.ts";
import { OPEN_METEO_ATTRIBUTION, OPEN_METEO_HOURLY_VARIABLES, createOpenMeteoGeocoder, createOpenMeteoProvider } from "../src/weather/open-meteo.ts";

const problems: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) problems.push(message);
};

/** Real fetch, recording each exchange so the report can show what the service actually sent. */
const exchanges: { url: string; status: number; body: unknown }[] = [];
const recordingFetch: FetchLike = async (input, init) => {
  const response = await fetch(input, init);
  let body: unknown = null;
  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }
  exchanges.push({ url: input, status: response.status, body });
  return response;
};

const timezone = "Europe/London";
const london = { latitude: 51.5074, longitude: -0.1278 };
const today = localDateOf(Date.now(), timezone);
const tomorrow = addDays(today, 1);

console.log(`Open-Meteo live verification, run at ${toInstant(Date.now())}`);

/* ------------------------------- forecast ------------------------------ */
console.log(`\nForecast: London ${today} to ${tomorrow} (${timezone})`);
try {
  const provider = createOpenMeteoProvider({ fetch: recordingFetch });
  const forecast = await provider.forecast({ ...london, timezone, startDate: today, endDate: tomorrow });
  const exchange = exchanges[exchanges.length - 1]!;
  const raw = exchange.body as Record<string, unknown>;
  console.log(`  GET ${exchange.url}`);
  check(exchange.status === 200, `HTTP ${exchange.status}`);
  console.log(`  top-level keys: ${Object.keys(raw).join(", ")}`);
  console.log(`  hourly_units: ${JSON.stringify(raw.hourly_units)}`);
  console.log(`  utc_offset_seconds: ${String(raw.utc_offset_seconds)}, timezone: ${String(raw.timezone)}, grid cell: ${forecast.latitude}, ${forecast.longitude}`);
  const hourlyKeys = Object.keys((raw.hourly ?? {}) as Record<string, unknown>);
  const absent = OPEN_METEO_HOURLY_VARIABLES.filter((v) => !hourlyKeys.includes(v));
  check(absent.length === 0, `all ${OPEN_METEO_HOURLY_VARIABLES.length} requested hourly variables present${absent.length ? ` (absent: ${absent.join(", ")})` : ""}`);
  check(raw.timezone === timezone, `response timezone echoes the request (${String(raw.timezone)})`);
  const issueKeys = Object.keys(raw).filter((k) => /issue|model_run|init|alert|warning/i.test(k));
  check(issueKeys.length === 0, `no forecast issue time and no alerts in the response (adapter reports issuedAt=null, alerts=null)${issueKeys.length ? `; found: ${issueKeys.join(", ")}` : ""}`);
  check(forecast.issuedAt === null && forecast.alerts === null, "adapter: issuedAt null, alerts null");
  check(JSON.stringify(forecast.missingFields) === JSON.stringify(["issuedAt", "alerts"]), `adapter missingFields = ${JSON.stringify(forecast.missingFields)}`);
  check(forecast.attribution === OPEN_METEO_ATTRIBUTION, `attribution: ${forecast.attribution}`);
  check(forecast.hours.length >= 46 && forecast.hours.length <= 50, `${forecast.hours.length} normalized hours for two local days`);
  const first = forecast.hours[0];
  check(first?.localTime === `${today}T00:00`, `first hour local time ${first?.localTime}`);
  check(first?.at === toInstant(zonedToUtcMs(today, "00:00", timezone)), `first hour instant ${first?.at} is local midnight in ${timezone}`);
  const last = forecast.hours[forecast.hours.length - 1];
  check(last?.localTime === `${tomorrow}T23:00`, `last hour local time ${last?.localTime}`);
  const fields: (keyof ProviderHour)[] = ["temperatureC", "apparentTemperatureC", "precipitationProbabilityPct", "precipitationMm", "precipitationType", "windSpeedKmh", "windGustKmh", "humidityPct"];
  for (const field of fields) {
    const nulls = forecast.hours.filter((h) => h[field] === null).length;
    check(nulls < forecast.hours.length, `${field}: ${forecast.hours.length - nulls} of ${forecast.hours.length} hours supplied`);
  }
  const temperatures = forecast.hours.map((h) => h.temperatureC).filter((t): t is number => t !== null);
  check(temperatures.every((t) => t > -40 && t < 50), `temperatures plausible for Celsius (${Math.min(...temperatures)} to ${Math.max(...temperatures)})`);
  const sample = forecast.hours.find((h) => h.localTime === `${tomorrow}T08:00`);
  console.log(`  sample hour: ${JSON.stringify(sample)}`);
} catch (error) {
  check(false, `forecast call failed: ${error instanceof Error ? error.message : String(error)}`);
}

/* ----------------------------- error contract -------------------------- */
console.log("\nError contract: latitude 999");
try {
  await createOpenMeteoProvider({ fetch: recordingFetch }).forecast({ latitude: 999, longitude: 0, timezone, startDate: today, endDate: today });
  check(false, "an invalid latitude was accepted");
} catch (error) {
  const exchange = exchanges[exchanges.length - 1]!;
  console.log(`  raw: HTTP ${exchange.status} ${JSON.stringify(exchange.body)}`);
  check(error instanceof WeatherProviderError && error.detail.status === 400 && error.detail.retryable === false, `adapter threw: ${error instanceof Error ? error.message : String(error)}`);
  check((exchange.body as Record<string, unknown> | null)?.error === true, 'body carries "error": true');
}

/* ------------------------------- geocoding ----------------------------- */
console.log("\nGeocoding");
try {
  const geocoder = createOpenMeteoGeocoder({ fetch: recordingFetch });
  const place = await geocoder.geocode("London");
  const exchange = exchanges[exchanges.length - 1]!;
  console.log(`  GET ${exchange.url}`);
  check(exchange.status === 200, `HTTP ${exchange.status}`);
  console.log(`  "London" -> ${JSON.stringify(place)}`);
  check(place !== null && place.label === "London, United Kingdom" && place.timezone === "Europe/London", "label and timezone as expected");
  check(place !== null && Math.abs(place.latitude - 51.51) < 0.1 && Math.abs(place.longitude + 0.13) < 0.1, "coordinates are central London");
  const nowhere = await geocoder.geocode("Zzzxqqnowhere");
  console.log(`  "Zzzxqqnowhere" -> ${JSON.stringify(nowhere)} (raw: ${JSON.stringify(exchanges[exchanges.length - 1]!.body)})`);
  check(nowhere === null, "an unknown place returns null");
} catch (error) {
  check(false, `geocoding call failed: ${error instanceof Error ? error.message : String(error)}`);
}

/* --------------------------- daylight-saving change --------------------- */
// The adapter's central claim about this API: hourly labels carry ONE fixed offset across a clock change,
// so real local hours must be derived from the instant. Checked on the next change inside the forecast range.
console.log("\nDaylight-saving change inside the forecast range");
try {
  const zones = [
    { timezone: "Australia/Sydney", latitude: -33.87, longitude: 151.21 },
    { timezone: "Europe/London", latitude: 51.51, longitude: -0.13 },
    { timezone: "America/New_York", latitude: 40.71, longitude: -74.01 },
    { timezone: "America/Santiago", latitude: -33.45, longitude: -70.67 },
    { timezone: "Pacific/Auckland", latitude: -36.85, longitude: 174.76 },
  ];
  const dayHours = (date: string, tz: string) => Math.round((zonedToUtcMs(addDays(date, 1), "00:00", tz) - zonedToUtcMs(date, "00:00", tz)) / 3_600_000);
  let found: { zone: (typeof zones)[number]; date: string; hours: number } | null = null;
  for (const zone of zones) {
    const start = localDateOf(Date.now(), zone.timezone);
    for (let i = 1; i <= 12 && !found; i++) {
      const date = addDays(start, i);
      const hours = dayHours(date, zone.timezone);
      if (hours !== 24) found = { zone, date, hours };
    }
  }
  if (!found) {
    console.log("  skipped: no clock change in the next 12 days in any of the probed timezones (not a failure, and not a pass)");
  } else {
    const { zone, date, hours } = found;
    const forecast = await createOpenMeteoProvider({ fetch: recordingFetch }).forecast({ latitude: zone.latitude, longitude: zone.longitude, timezone: zone.timezone, startDate: addDays(date, -1), endDate: addDays(date, 1) });
    const raw = exchanges[exchanges.length - 1]!.body as { utc_offset_seconds?: number; hourly?: { time?: string[] } };
    const labels = raw.hourly?.time ?? [];
    const steps = new Set(labels.slice(1).map((label, i) => Date.parse(`${label}:00Z`) - Date.parse(`${labels[i]}:00Z`)));
    console.log(`  ${zone.timezone}, clock change on ${date} (a ${hours}-hour local day); ${labels.length} raw labels, utc_offset_seconds ${String(raw.utc_offset_seconds)}`);
    check(steps.size === 1 && steps.has(3_600_000), "raw labels advance by exactly one hour with no gap or repeat: one fixed offset across the change, as the adapter assumes");
    const onDay = forecast.hours.filter((h) => h.localTime.startsWith(date));
    check(onDay.length === hours, `the adapter yields ${onDay.length} local hours on ${date} (expected ${hours})`);
    check(forecast.hours.length === 48 + hours, `${forecast.hours.length} hours for the three local days (expected ${48 + hours})`);
    const instants = forecast.hours.map((h) => Date.parse(h.at));
    check(instants.every((ms, i) => i === 0 || ms - instants[i - 1]! === 3_600_000), "normalized instants are consecutive hours");
    check(forecast.hours[0]?.at === toInstant(zonedToUtcMs(addDays(date, -1), "00:00", zone.timezone)), `first instant ${forecast.hours[0]?.at} is local midnight of the first day`);
    check(new Set(forecast.hours.map((h) => h.localTime)).size === (hours === 25 ? forecast.hours.length - 1 : forecast.hours.length), "local wall times follow the real clock (a 23-hour day skips an hour; a 25-hour day repeats one)");
  }
} catch (error) {
  check(false, `daylight-saving check failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (problems.length > 0) {
  console.log(`\nRESULT: FAILED, ${problems.length} problem(s): the live contract does not match the adapter.`);
  process.exit(1);
}
console.log("\nRESULT: OK, the live Open-Meteo contract matches the adapter.");
