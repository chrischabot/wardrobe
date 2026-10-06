/**
 * Weather assessment: turns a normalized provider forecast into the `WeatherSnapshot` the board,
 * the validator and the Calendar text share. Pure: no I/O, no clock (the caller passes `nowMs`).
 *
 * Rules implemented here (requirements/garderobe-replacement-design.md, "Weather skill and preloaded
 * forecast context", and the weather-for-outfits skill):
 *  - `peakC` is the maximum air temperature across the intended wearing interval: the daytime window for
 *    a day outfit, the evening window for an evening-only outfit (never a temperature from before it was
 *    put on).
 *  - `departureC` is the air temperature of the outdoor hour a jacket is worn: the hour containing the
 *    departure time, or the first hour of the evening window for an evening-only outfit.
 *  - Apparent temperature is recorded in the windows as context and is never used for either basis.
 *  - A `null` value means "not supplied". It is never read as zero, dry, warm or calm.
 *  - Rain probability and rain amount are separate fields and are never derived from each other.
 */
import type { DailySettings, DayConditions, WeatherHour, WeatherLocation, WeatherSnapshot, WeatherWindow } from "@garderobe/contracts/ext/daily";
import { parseInstant, toInstant } from "@garderobe/domain";
import type { ProviderForecast, ProviderHour } from "../ports.ts";

/* ------------------------------ civil time ----------------------------- */

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local wall time `YYYY-MM-DDTHH:mm` of an instant in an IANA timezone (daylight saving applied). */
export function localTimeOf(ms: number, timezone: string): string {
  let f = wallFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    wallFormatters.set(timezone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = part.value;
  return `${p.year!.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function minutesOf(localTime: string): number {
  const [h, m] = localTime.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function hourOf(hour: { localTime: string }): number {
  return Number(hour.localTime.slice(11, 13));
}

/* -------------------------------- numbers ------------------------------ */

function round1(value: number): number {
  return Math.round(value * 10) / 10 + 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function known(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

function maxOrNull(values: (number | null)[]): number | null {
  const k = known(values);
  return k.length === 0 ? null : round1(Math.max(...k));
}

function minOrNull(values: (number | null)[]): number | null {
  const k = known(values);
  return k.length === 0 ? null : round1(Math.min(...k));
}

/** Sum of the supplied values; null when every value is null (an unknown amount is not zero). */
function sumOrNull(values: (number | null)[]): number | null {
  const k = known(values);
  return k.length === 0 ? null : round2(k.reduce((a, b) => a + b, 0));
}

/* -------------------------------- windows ------------------------------ */

/** The fixed evening-return interval (local time). */
export const EVENING_RETURN_FROM = "17:00";
export const EVENING_RETURN_TO = "20:00";

const NUMERIC_FIELDS = ["temperatureC", "apparentTemperatureC", "precipitationProbabilityPct", "precipitationMm", "windSpeedKmh", "windGustKmh", "humidityPct"] as const;
const DATA_FIELDS = [...NUMERIC_FIELDS, "precipitationType"] as const satisfies readonly (keyof ProviderHour)[];

interface WindowSpec {
  name: WeatherWindow["name"];
  fromMin: number;
  toMin: number;
  /** True: the hour starting exactly at `toMin` belongs to the window ([from, to]). False: [from, to). */
  inclusiveEnd: boolean;
}

function hasData(hour: ProviderHour): boolean {
  return NUMERIC_FIELDS.some((f) => hour[f] !== null);
}

/** Hours whose one-hour slot overlaps the window. */
function hoursIn(spec: WindowSpec, hours: ProviderHour[]): ProviderHour[] {
  return hours.filter((hour) => {
    const start = hourOf(hour) * 60;
    return start + 60 > spec.fromMin && (spec.inclusiveEnd ? start <= spec.toMin : start < spec.toMin);
  });
}

function closedSpec(name: WeatherWindow["name"], from: string, to: string): WindowSpec {
  const fromMin = minutesOf(from);
  let toMin = minutesOf(to);
  // An interval that would run past midnight is clipped to the end of the local day.
  if (toMin < fromMin) toMin = 23 * 60 + 59;
  return { name, fromMin, toMin, inclusiveEnd: true };
}

function buildWindow(spec: WindowSpec, dayHours: ProviderHour[]): WeatherWindow {
  const hours = hoursIn(spec, dayHours);
  return {
    name: spec.name,
    fromLocalTime: formatMinutes(spec.fromMin),
    toLocalTime: formatMinutes(spec.toMin),
    coveredHours: hours.filter(hasData).length,
    minC: minOrNull(hours.map((h) => h.temperatureC)),
    maxC: maxOrNull(hours.map((h) => h.temperatureC)),
    apparentMinC: minOrNull(hours.map((h) => h.apparentTemperatureC)),
    apparentMaxC: maxOrNull(hours.map((h) => h.apparentTemperatureC)),
    maxPrecipitationProbabilityPct: maxOrNull(hours.map((h) => h.precipitationProbabilityPct)),
    precipitationMm: sumOrNull(hours.map((h) => h.precipitationMm)),
    maxWindGustKmh: maxOrNull(hours.map((h) => h.windGustKmh)),
  };
}

/* --------------------------------- line -------------------------------- */

function wholeDegrees(value: number): string {
  return `${Math.round(value) + 0} °C`;
}

/** "3 h", "45 min", "2 d": the forecast age as shown to the owner. */
export function formatAge(ageMinutes: number): string {
  if (ageMinutes < 60) return `${Math.max(0, Math.floor(ageMinutes))} min`;
  if (ageMinutes < 48 * 60) return `${Math.floor(ageMinutes / 60)} h`;
  return `${Math.floor(ageMinutes / (24 * 60))} d`;
}

function buildLine(conditions: DayConditions, firstWearingHour: number): string {
  const temperatures: string[] = [];
  if (conditions.departureC !== null) temperatures.push(`${wholeDegrees(conditions.departureC)} leaving`);
  if (conditions.peakC !== null) temperatures.push(`${wholeDegrees(conditions.peakC)} later`);
  const clauses: string[] = [];
  // The line is about temperature first; when neither basis was supplied, say so instead of staying silent.
  clauses.push(temperatures.length > 0 ? temperatures.join(", ") : "Temperature unknown");
  if (conditions.rainLikelyFromHour !== null) {
    const hour = conditions.rainLikelyFromHour;
    clauses.push(hour <= firstWearingHour ? "rain from the start" : `rain after ${hour % 12 === 0 ? 12 : hour % 12}`);
  }
  if (conditions.maxWindGustKmh !== null && conditions.maxWindGustKmh >= 50) clauses.push(`gusts to ${Math.round(conditions.maxWindGustKmh)} km/h`);
  return `${clauses.join("; ")}.`;
}

/* ------------------------------- snapshot ------------------------------ */

export interface BuildWeatherSnapshotInput {
  snapshotId: string;
  localDate: string;
  location: WeatherLocation;
  /** null = no forecast could be obtained. */
  forecast: ProviderForecast | null;
  settings: DailySettings;
  segment: "day" | "evening";
  nowMs: number;
  maxAgeMinutes: number;
  /** Caller-supplied reason (e.g. the provider error) shown instead of the generated one. */
  limitation?: string | null;
}

function unavailableConditions(snapshotId: string, segment: "day" | "evening"): DayConditions {
  return {
    freshness: "unavailable",
    snapshotId,
    peakC: null,
    peakInterval: null,
    departureC: null,
    departureInterval: null,
    eveningReturnC: null,
    maxPrecipitationProbabilityPct: null,
    precipitationMm: null,
    rainLikelyFromHour: null,
    maxWindGustKmh: null,
    segment,
  };
}

export function buildWeatherSnapshot(input: BuildWeatherSnapshotInput): WeatherSnapshot {
  const { snapshotId, localDate, location, forecast, settings, segment, nowMs } = input;
  const timezone = location.timezone;

  const dayHours = (forecast?.hours ?? []).filter((h) => h.localTime.slice(0, 10) === localDate);

  const departureMin = minutesOf(settings.departureLocalTime);
  const departureSpec: WindowSpec = { name: "departure", fromMin: departureMin, toMin: Math.min(departureMin + 60, 24 * 60), inclusiveEnd: false };
  const daytimeSpec = closedSpec("daytime", settings.daytimeFromLocalTime, settings.daytimeToLocalTime);
  const eveningReturnSpec = closedSpec("evening_return", EVENING_RETURN_FROM, EVENING_RETURN_TO);
  const eveningSpec = closedSpec("evening", settings.eveningFromLocalTime, settings.eveningToLocalTime);
  const specs = [departureSpec, daytimeSpec, eveningReturnSpec, eveningSpec];
  const windows = specs.map((spec) => buildWindow(spec, dayHours));
  const [, daytimeWindow, eveningReturnWindow, eveningWindow] = windows as [WeatherWindow, WeatherWindow, WeatherWindow, WeatherWindow];

  const wearingSpec = segment === "evening" ? eveningSpec : daytimeSpec;
  const wearingWindow = segment === "evening" ? eveningWindow : daytimeWindow;
  const wearingHours = hoursIn(wearingSpec, dayHours);
  const firstWearingHour = Math.floor(wearingSpec.fromMin / 60);

  /* freshness */
  let ageMinutes: number | null = null;
  let freshness: WeatherSnapshot["freshness"];
  let limitation: string | null = input.limitation ?? null;
  if (forecast === null) {
    freshness = "unavailable";
    limitation ??= "No forecast could be obtained from the weather provider; temperature, rain and wind are unknown.";
  } else {
    const ageMs = Math.max(0, nowMs - parseInstant(forecast.fetchedAt));
    ageMinutes = Math.floor(ageMs / 60_000);
    if (wearingWindow.coveredHours === 0) {
      freshness = "unavailable";
      limitation ??= `The forecast does not cover ${formatMinutes(wearingSpec.fromMin)}-${formatMinutes(wearingSpec.toMin)} on ${localDate} in ${timezone}; temperature, rain and wind are unknown.`;
    } else if (ageMs > input.maxAgeMinutes * 60_000) {
      freshness = "stale";
      limitation ??= `The forecast is ${formatAge(ageMinutes)} old (older than the ${input.maxAgeMinutes} min limit); a newer one could not be obtained.`;
    } else {
      freshness = "fresh";
    }
  }

  /* conditions */
  let conditions: DayConditions;
  if (freshness === "unavailable") {
    conditions = unavailableConditions(snapshotId, segment);
  } else {
    // Outdoor hour a jacket is worn: the departure hour, or the first hour of an evening-only outfit.
    const outdoorMin = segment === "evening" ? eveningSpec.fromMin : departureMin;
    const outdoorHour = dayHours.find((h) => hourOf(h) === Math.floor(outdoorMin / 60));
    const outdoorC = outdoorHour?.temperatureC ?? null;
    const rainHour = wearingHours.find((h) => h.precipitationProbabilityPct !== null && h.precipitationProbabilityPct >= 50);
    conditions = {
      freshness,
      snapshotId,
      peakC: wearingWindow.maxC,
      peakInterval: `${wearingWindow.fromLocalTime}-${wearingWindow.toLocalTime} ${timezone}`,
      departureC: outdoorC === null ? null : round1(outdoorC),
      departureInterval: `${formatMinutes(outdoorMin)}-${formatMinutes(Math.min(outdoorMin + 60, 24 * 60))} ${timezone}`,
      eveningReturnC: eveningReturnWindow.minC,
      maxPrecipitationProbabilityPct: wearingWindow.maxPrecipitationProbabilityPct,
      precipitationMm: wearingWindow.precipitationMm,
      rainLikelyFromHour: rainHour ? hourOf(rainHour) : null,
      maxWindGustKmh: wearingWindow.maxWindGustKmh,
      segment,
    };
  }

  /* line */
  let line: string;
  if (freshness === "unavailable") line = "Weather unavailable";
  else {
    line = buildLine(conditions, firstWearingHour);
    if (freshness === "stale" && ageMinutes !== null) line = `${line} (forecast ${formatAge(ageMinutes)} old)`;
  }

  /* missing fields */
  const missing = new Set<string>(forecast ? forecast.missingFields : ["forecast"]);
  if (forecast) for (const field of DATA_FIELDS) if (dayHours.every((h) => h[field] === null)) missing.add(field);

  const hours: WeatherHour[] = dayHours.map((h) => ({ ...h }));
  const first = dayHours[0];
  const last = dayHours[dayHours.length - 1];

  return {
    snapshotId,
    localDate,
    provider: forecast?.provider ?? settings.weatherProvider,
    attribution: forecast?.attribution ?? "",
    location,
    // Without a forecast there is no fetch time; the time of the failed attempt is recorded and ageMinutes stays null.
    fetchedAt: forecast?.fetchedAt ?? toInstant(nowMs),
    issuedAt: forecast?.issuedAt ?? null,
    coversFrom: first ? first.at : null,
    coversTo: last ? toInstant(parseInstant(last.at) + 3_600_000) : null,
    freshness,
    ageMinutes,
    missingFields: [...missing],
    hours,
    alerts: forecast?.alerts ?? null,
    windows,
    conditions,
    line,
    limitation,
  };
}

/* ---------------------------- plausibility ----------------------------- */

/**
 * Bounds outside which a value cannot be a real observation on Earth (the records are about -89 C and
 * +57 C, 408 km/h for a gust, 305 mm of rain in an hour). They are deliberately wide: their only purpose
 * is to refuse a forecast that is corrupt, in the wrong unit or forged, never to second-guess weather.
 */
export const PLAUSIBLE_RANGES: Record<(typeof NUMERIC_FIELDS)[number], { min: number; max: number; unit: string; label: string }> = {
  temperatureC: { min: -90, max: 60, unit: "°C", label: "a temperature" },
  apparentTemperatureC: { min: -120, max: 80, unit: "°C", label: "a felt temperature" },
  precipitationProbabilityPct: { min: 0, max: 100, unit: "%", label: "a chance of rain" },
  precipitationMm: { min: 0, max: 500, unit: "mm", label: "an hourly rain amount" },
  windSpeedKmh: { min: 0, max: 500, unit: "km/h", label: "a wind speed" },
  windGustKmh: { min: 0, max: 500, unit: "km/h", label: "a gust" },
  humidityPct: { min: 0, max: 100, unit: "%", label: "a humidity" },
};

/**
 * Why a forecast cannot be right, as a short phrase ("a temperature of 900 °C"), or null when every
 * supplied value is physically possible. A forecast with one impossible value is not used at all: the
 * same fault may have touched the values that look reasonable.
 */
export function implausibleForecast(forecast: ProviderForecast): string | null {
  for (const hour of forecast.hours) {
    for (const field of NUMERIC_FIELDS) {
      const value = hour[field];
      if (value === null) continue;
      const range = PLAUSIBLE_RANGES[field];
      if (!Number.isFinite(value) || value < range.min || value > range.max) return `${range.label} of ${Number.isFinite(value) ? round1(value) : "no finite value"} ${range.unit}`;
    }
  }
  return null;
}

/** Whether the forecast says anything at all about `localDate` (at least one supplied value in one of its hours). */
export function forecastCoversDate(forecast: ProviderForecast, localDate: string): boolean {
  return forecast.hours.some((h) => h.localTime.slice(0, 10) === localDate && hasData(h));
}

/* ---------------------------- material change -------------------------- */

/** Inclusive 14-16 C band of the owner's jacket rule. */
export const JACKET_BAND_MIN_C = 14;
export const JACKET_BAND_MAX_C = 16;
export const MATERIAL_TEMPERATURE_DELTA_C = 3;
export const RAIN_LIKELY_PCT = 50;
export const STRONG_GUST_KMH = 50;

function inJacketBand(value: number): boolean {
  return value >= JACKET_BAND_MIN_C && value <= JACKET_BAND_MAX_C;
}

/**
 * Whether two assessments of the same day differ enough to re-validate the board.
 * A value that was unknown on one side and known on the other counts as a change of that value.
 */
export function materialChange(before: DayConditions, after: DayConditions): { material: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const wasUnavailable = before.freshness === "unavailable";
  const isUnavailable = after.freshness === "unavailable";
  if (wasUnavailable !== isUnavailable) reasons.push(isUnavailable ? "weather became unavailable" : "weather became available");

  const temperature = (label: string, a: number | null, b: number | null) => {
    if (a === null && b === null) return;
    if (a === null || b === null) {
      // Already explained by the availability change above when that is the cause.
      if (wasUnavailable === isUnavailable) reasons.push(`${label} temperature ${b === null ? "is no longer known" : "became known"}`);
      return;
    }
    const delta = round1(b - a);
    if (Math.abs(delta) >= MATERIAL_TEMPERATURE_DELTA_C) reasons.push(`${label} temperature moved ${delta > 0 ? "+" : ""}${delta} C (${a} -> ${b})`);
    if (inJacketBand(a) !== inJacketBand(b)) reasons.push(`${label} temperature ${inJacketBand(b) ? "entered" : "left"} the ${JACKET_BAND_MIN_C}-${JACKET_BAND_MAX_C} C band (${a} -> ${b})`);
  };
  temperature("peak", before.peakC, after.peakC);
  temperature("departure", before.departureC, after.departureC);

  const threshold = (label: string, limit: number, unit: string, a: number | null, b: number | null) => {
    if (a === null || b === null) return;
    if (a >= limit !== b >= limit) reasons.push(`${label} ${b >= limit ? "rose to" : "fell below"} ${limit} ${unit} (${a} -> ${b})`);
  };
  threshold("rain probability", RAIN_LIKELY_PCT, "%", before.maxPrecipitationProbabilityPct, after.maxPrecipitationProbabilityPct);
  threshold("wind gusts", STRONG_GUST_KMH, "km/h", before.maxWindGustKmh, after.maxWindGustKmh);

  return { material: reasons.length > 0, reasons };
}
