import type { BoardWeather } from '@garderobe/contracts';
import { addDays } from '../domain/time.js';
import type { ForecastSnapshot, HourlyPoint, WeatherLocation, WeatherProvider } from './types.js';

/**
 * The `weather-for-outfits` backend skill (spec section 7). Trusted code calls it automatically before
 * evening planning, morning validation, weather-affected swaps, packing and ad hoc advice; a model
 * never has to remember to. Tools:
 *  - `forecastForDay` (weather.forecast): snapshot + clothing interpretation for one wearing interval;
 *  - `compareLocations` (weather.compare_locations): the same interpretation for several places.
 *
 * Interpretation rules:
 *  - peak = maximum temperature across the intended wearing interval (shirts, trousers, socks);
 *  - departure = temperature at the departure time (outerwear); an evening-only outfit departs at its
 *    interval start and peaks within that interval only;
 *  - rain probability and rain amount are reported separately; apparent temperature is reported but
 *    never replaces the profile's temperature basis;
 *  - a missing value stays null and is listed; missing data never means dry, warm or calm.
 */

export const WEATHER_SKILL_VERSION = 'weather-for-outfits/1';

export interface WearingWindow {
  /** Local HH:MM. */
  start: string;
  end: string;
  departure: string;
  eveningOnly: boolean;
}

export const DEFAULT_DAY_WINDOW: WearingWindow = { start: '08:00', end: '19:00', departure: '08:00', eveningOnly: false };

export interface DayWeather {
  summary: BoardWeather;
  /** The snapshot used (copied into the private board context), or null when none was usable. */
  snapshot: ForecastSnapshot | null;
  /** Hours inside the wearing interval, for the hourly basis view. */
  hours: HourlyPoint[];
  /** Seasonal fallback used for thermal checks when no forecast is usable (never presented as a forecast). */
  fallback: { peakTempC: number; departureTempC: number; basis: string } | null;
}

export interface WeatherSkillOptions {
  /** Forecast older than this (minutes) is 'stale'. Initial target: a fetch within an hour. */
  freshMinutes?: number;
  /** A prior snapshot older than this is not used at all on outage. */
  maxFallbackAgeMinutes?: number;
  clock?: () => string;
}

const KNOWN_CITIES: Record<string, { latitude: number; longitude: number }> = {
  london: { latitude: 51.4946, longitude: -0.1003 }, // Elephant and Castle (profile section 1)
  paris: { latitude: 48.8566, longitude: 2.3522 },
  rotterdam: { latitude: 51.9244, longitude: 4.4777 },
  amsterdam: { latitude: 52.3676, longitude: 4.9041 },
  'new york': { latitude: 40.7128, longitude: -74.006 },
  edinburgh: { latitude: 55.9533, longitude: -3.1883 },
};

/** Resolves a city-level location. Coordinates from settings win; a known city label is the fallback. */
export function resolveLocation(label: string, latitude?: number | null, longitude?: number | null, basis = 'owner_settings'): WeatherLocation | null {
  if (typeof latitude === 'number' && typeof longitude === 'number') return { label, latitude, longitude, basis };
  // City-level label, e.g. "London (Elephant and Castle)": the city before any parenthesis or comma.
  const city = label.toLowerCase().replace(/\(.*?\)/g, '').split(',')[0]!.trim();
  const c = KNOWN_CITIES[city];
  return c ? { label, ...c, basis: 'home_city_label' } : null;
}

/** Approximate London monthly means (max, min) used only when no forecast is usable. */
const SEASONAL: [number, number][] = [
  [8, 3], [9, 3], [12, 4], [15, 6], [18, 9], [21, 12], [24, 14], [23, 14], [20, 12], [16, 9], [11, 6], [9, 4],
];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function cacheKey(provider: string, loc: WeatherLocation, timezone: string, startDate: string, endDate: string): string {
  // Coarse location (0.1°) and interval only: no user identifier ever enters a shared cache key.
  return `${provider}|${loc.latitude.toFixed(1)}|${loc.longitude.toFixed(1)}|${timezone}|${startDate}|${endDate}`;
}

export class WeatherSkill {
  private readonly freshMinutes: number;
  private readonly maxFallbackAgeMinutes: number;
  private readonly clock: () => string;

  constructor(
    private readonly db: D1Database,
    private readonly provider: WeatherProvider,
    opts: WeatherSkillOptions = {},
  ) {
    this.freshMinutes = opts.freshMinutes ?? 60;
    this.maxFallbackAgeMinutes = opts.maxFallbackAgeMinutes ?? 36 * 60;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  /** Fetches (or reuses a fresh cached) snapshot covering the date; on outage falls back to a relevant prior snapshot. */
  async snapshotFor(location: WeatherLocation, timezone: string, date: string, opts: { forceRefresh?: boolean } = {}): Promise<{ snapshot: ForecastSnapshot | null; status: BoardWeather['status']; error: string | null }> {
    const startDate = addDays(date, -1);
    const endDate = addDays(date, 1);
    const key = cacheKey(this.provider.name, location, timezone, startDate, endDate);
    const now = this.clock();
    const cached = await this.db.prepare('SELECT snapshot_json, fetched_at FROM weather_cache WHERE cache_key = ?').bind(key).first<{ snapshot_json: string; fetched_at: string }>();
    const age = (s: { fetched_at: string }) => (Date.parse(now) - Date.parse(s.fetched_at)) / 60_000;
    if (cached && !opts.forceRefresh && age(cached) <= this.freshMinutes) {
      return { snapshot: JSON.parse(cached.snapshot_json) as ForecastSnapshot, status: 'fresh', error: null };
    }
    try {
      const snap = await this.provider.forecast({ location, timezone, startDate, endDate });
      await this.db
        .prepare(
          `INSERT INTO weather_cache (cache_key, provider, lat_key, lon_key, timezone, start_date, end_date, fetched_at, issued_at, snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (cache_key) DO UPDATE SET fetched_at = excluded.fetched_at, issued_at = excluded.issued_at, snapshot_json = excluded.snapshot_json`,
        )
        .bind(key, this.provider.name, location.latitude.toFixed(1), location.longitude.toFixed(1), timezone, startDate, endDate, snap.fetchedAt, snap.issuedAt, JSON.stringify(snap))
        .run();
      return { snapshot: snap, status: 'fresh', error: null };
    } catch (err) {
      const message = (err as Error).message;
      if (cached && age(cached) <= this.maxFallbackAgeMinutes) {
        return { snapshot: JSON.parse(cached.snapshot_json) as ForecastSnapshot, status: 'stale', error: message };
      }
      return { snapshot: null, status: 'unavailable', error: message };
    }
  }

  /** weather.forecast: interpretation of one wearing interval on one local date. */
  async forecastForDay(input: { location: WeatherLocation | null; timezone: string; date: string; window?: WearingWindow; forceRefresh?: boolean }): Promise<DayWeather> {
    const window = input.window ?? DEFAULT_DAY_WINDOW;
    if (!input.location) return interpretDay(null, input.date, input.timezone, window, 'missing', this.clock(), 'No home location with coordinates is set', 'Location not set');
    const { snapshot, status, error } = await this.snapshotFor(input.location, input.timezone, input.date, { forceRefresh: input.forceRefresh });
    return interpretDay(snapshot, input.date, input.timezone, window, status, this.clock(), error, input.location.label, this.freshMinutes);
  }

  /** weather.compare_locations: the same interval interpreted for several places (travel, packing). */
  async compareLocations(input: { locations: { location: WeatherLocation; timezone: string }[]; date: string; window?: WearingWindow }): Promise<DayWeather[]> {
    const out: DayWeather[] = [];
    for (const l of input.locations) out.push(await this.forecastForDay({ location: l.location, timezone: l.timezone, date: input.date, window: input.window }));
    return out;
  }
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + (m || 0);
}

function localMinutes(p: HourlyPoint): number {
  return minutesOf(p.local.slice(11, 16));
}

function hourLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}` : `${h12}`;
}

const fmt = (n: number) => `${Math.round(n)} °C`;

/** Pure interpretation of a snapshot for one wearing window. Exported for tests and the simulation. */
export function interpretDay(
  snapshot: ForecastSnapshot | null,
  date: string,
  timezone: string,
  window: WearingWindow,
  status: BoardWeather['status'],
  now: string,
  error: string | null = null,
  locationLabel = snapshot?.location.label ?? 'Unknown',
  freshMinutes = 60,
): DayWeather {
  const startM = minutesOf(window.start);
  const endM = minutesOf(window.end);
  const depM = minutesOf(window.departure);
  const hours = (snapshot?.hourly ?? []).filter((p) => p.local.slice(0, 10) === date && localMinutes(p) >= Math.floor(startM / 60) * 60 && localMinutes(p) <= endM);
  const missingFields = new Set(snapshot?.missingFields ?? []);
  const vals = (k: keyof HourlyPoint) => hours.map((h) => h[k]).filter((v): v is number => typeof v === 'number');
  const temps = vals('temperatureC');
  const usable = snapshot !== null && temps.length > 0;
  if (snapshot && !temps.length) missingFields.add('coverage');
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
  const dep = hours.find((h) => localMinutes(h) === Math.floor(depM / 60) * 60 && h.temperatureC !== null) ?? hours.find((h) => h.temperatureC !== null);
  const evening = (snapshot?.hourly ?? []).filter((p) => p.local.slice(0, 10) === date && localMinutes(p) >= 18 * 60 && localMinutes(p) <= 22 * 60);
  const rainyHour = hours.find((h) => (h.precipitationProbability ?? 0) >= 50 || (h.precipitationMm ?? 0) >= 0.3);
  const precipTypes = new Set(hours.map((h) => h.precipitationType).filter((t) => t && t !== 'none'));
  const peakTempC = usable ? round1(max(temps)!) : null;
  const departureTempC = usable && dep?.temperatureC != null ? round1(dep.temperatureC) : null;
  const rainProb = max(vals('precipitationProbability'));
  const rainMm = vals('precipitationMm').length ? round1(vals('precipitationMm').reduce((a, b) => a + b, 0)) : null;
  const wind = max(vals('windKmh'));
  const gust = max(vals('gustKmh'));
  const ageMinutes = snapshot ? Math.max(0, Math.round((Date.parse(now) - Date.parse(snapshot.fetchedAt)) / 60_000)) : null;
  const effectiveStatus: BoardWeather['status'] = !snapshot ? status : !usable ? 'missing' : status === 'fresh' && ageMinutes !== null && ageMinutes > freshMinutes ? 'stale' : status;

  const conditions: BoardWeather['conditions'] = [];
  if (peakTempC !== null && peakTempC <= 8) conditions.push('cold');
  if (departureTempC !== null && departureTempC < 14) conditions.push('cool_start');
  if (peakTempC !== null && departureTempC !== null && peakTempC - departureTempC >= 5) conditions.push('warming');
  if (departureTempC !== null && Math.round(departureTempC) >= 14 && Math.round(departureTempC) <= 16) conditions.push('jacket_band_14_16');
  if (peakTempC !== null && peakTempC >= 27) conditions.push('heat');
  if ((rainProb ?? 0) >= 50 || (rainMm ?? 0) >= 1) conditions.push('rain');
  if ((rainMm ?? 0) >= 5 || hours.some((h) => (h.precipitationMm ?? 0) >= 2)) conditions.push('heavy_rain');
  if ((wind ?? 0) >= 30 || (gust ?? 0) >= 45) conditions.push('windy');
  if ((wind ?? 0) >= 40 || (gust ?? 0) >= 60) conditions.push('strong_wind');
  if (precipTypes.has('snow') || precipTypes.has('mixed')) conditions.push('snow');

  let line: string;
  if (!usable) {
    line = snapshot ? 'The forecast does not cover this day' : 'No usable forecast';
  } else if (window.eveningOnly) {
    line = `${fmt(departureTempC ?? peakTempC!)} going out, ${fmt(min(temps)!)} late`;
  } else {
    line = departureTempC !== null && peakTempC !== null && peakTempC - departureTempC >= 2 ? `${fmt(departureTempC)} leaving, ${fmt(peakTempC)} later` : `${fmt(peakTempC!)} all day`;
  }
  if (usable && rainyHour) {
    const hhmm = rainyHour.local.slice(11, 16);
    line += minutesOf(hhmm) <= startM + 60 ? (conditions.includes('heavy_rain') ? '; heavy rain' : '; rain') : `; rain after ${hourLabel(hhmm)}`;
  } else if (usable && conditions.includes('strong_wind')) line += '; strong wind';
  else if (usable && conditions.includes('windy')) line += '; windy';
  if (effectiveStatus === 'stale' && ageMinutes !== null) line += ` (forecast ${ageMinutes >= 120 ? `${Math.round(ageMinutes / 60)} h` : `${ageMinutes} min`} old)`;

  const month = Number(date.slice(5, 7));
  const [smax, smin] = SEASONAL[month - 1]!;
  const fallback = usable ? null : { peakTempC: smax, departureTempC: smin + 2, basis: `Seasonal London average for month ${month}; not a forecast` };

  const summary: BoardWeather = {
    provider: snapshot?.provider ?? null,
    attribution: snapshot?.attribution ?? null,
    locationLabel,
    timezone,
    status: effectiveStatus,
    fetchedAt: snapshot?.fetchedAt ?? null,
    issuedAt: snapshot?.issuedAt ?? null,
    ageMinutes,
    wearingInterval: { start: window.start, end: window.end },
    eveningOnly: window.eveningOnly,
    departureTime: window.departure,
    departureTempC,
    peakTempC,
    lowTempC: usable ? round1(min(temps)!) : null,
    eveningTempC: evening.length && evening.some((e) => e.temperatureC !== null) ? round1(Math.min(...evening.map((e) => e.temperatureC).filter((v): v is number => v !== null))) : null,
    apparentPeakC: vals('apparentC').length ? round1(max(vals('apparentC'))!) : null,
    rainProbabilityMax: rainProb,
    rainAmountMm: rainMm,
    rainStartsAt: rainyHour ? rainyHour.local.slice(11, 16) : null,
    precipitationType: !hours.length ? null : precipTypes.has('mixed') || (precipTypes.has('rain') && precipTypes.has('snow')) ? 'mixed' : precipTypes.has('snow') ? 'snow' : precipTypes.has('rain') ? 'rain' : 'none',
    windSpeedMaxKmh: wind,
    windGustMaxKmh: gust,
    humidityMax: max(vals('humidity')),
    conditions,
    alerts: snapshot?.alerts ?? [],
    missingFields: [...missingFields, ...(error ? [`provider_error: ${error}`] : [])],
    line,
  };
  return { summary, snapshot, hours, fallback };
}

/** Temperatures the thermal rules use: the forecast when usable, else the labelled seasonal fallback. */
export function thermalBasis(w: DayWeather): { peakTempC: number; departureTempC: number; source: 'forecast' | 'seasonal_fallback'; detail: string } {
  if (w.summary.peakTempC !== null && w.summary.departureTempC !== null) {
    return { peakTempC: w.summary.peakTempC, departureTempC: w.summary.departureTempC, source: 'forecast', detail: `${w.summary.provider} fetched ${w.summary.fetchedAt}` };
  }
  const f = w.fallback ?? { peakTempC: 15, departureTempC: 10, basis: 'Generic fallback' };
  return { peakTempC: f.peakTempC, departureTempC: f.departureTempC, source: 'seasonal_fallback', detail: f.basis };
}
