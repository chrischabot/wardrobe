import { addDays, zonedInstant } from '../domain/time.js';
import { WeatherProviderError, type ForecastRequest, type ForecastSnapshot, type HourlyPoint, type WeatherProvider } from './types.js';

/**
 * Deterministic weather fake for tests, demo and the end-to-end simulation. A scenario is a function
 * from local date and hour to conditions; built-in scenarios cover the acceptance cases of spec
 * section 7 (cold departure with a warm afternoon, heavy rain, strong wind, heat, the 14–16 °C
 * transition, evening-only wear) and a provider failure.
 */

export interface HourConditions {
  temperatureC: number;
  apparentC?: number;
  precipitationProbability?: number;
  precipitationMm?: number;
  precipitationType?: HourlyPoint['precipitationType'];
  windKmh?: number;
  gustKmh?: number;
  humidity?: number;
}

export type WeatherScenario = (localDate: string, hour: number) => HourConditions;

/** Smooth diurnal curve: `low` at 05:00, `high` at 15:00. */
export function diurnal(low: number, high: number, extra: Omit<HourConditions, 'temperatureC'> = {}): WeatherScenario {
  return (_date, hour) => {
    // Rises from `low` at 05:00 to `high` at 15:00, then falls back towards the next 05:00.
    const h = hour < 5 ? hour + 24 : hour;
    const shape = h <= 15 ? (1 - Math.cos((Math.PI * (h - 5)) / 10)) / 2 : (1 + Math.cos((Math.PI * (h - 15)) / 14)) / 2;
    const t = Math.round((low + (high - low) * shape) * 10) / 10;
    return { temperatureC: t, apparentC: t, precipitationProbability: 5, precipitationMm: 0, precipitationType: 'none', windKmh: 10, gustKmh: 18, humidity: 70, ...extra };
  };
}

/** Named scenarios used by tests and the simulation. */
export const WEATHER_SCENARIOS = {
  /** Mild, dry autumn day. */
  mild: diurnal(12, 18),
  /** Cold snap: freezing start, barely above 4 °C. */
  coldSnap: diurnal(-3, 4, { windKmh: 14, gustKmh: 25 }),
  /** The profile's own example: starts at 11 °C and reaches 19 °C. */
  elevenToNineteen: ((date, hour) => {
    const base = diurnal(9, 19)(date, hour);
    const t = hour <= 8 ? 11 : hour >= 14 && hour <= 16 ? 19 : base.temperatureC < 11 ? 11 : base.temperatureC;
    return { ...base, temperatureC: t, apparentC: t };
  }) as WeatherScenario,
  /** Departure inside the 14–16 °C jacket band, peak 21 °C. */
  jacketBand: ((date, hour) => {
    const base = diurnal(12, 21)(date, hour);
    const t = hour >= 7 && hour <= 9 ? 15 : base.temperatureC;
    return { ...base, temperatureC: t, apparentC: t };
  }) as WeatherScenario,
  /** Heavy rain through the commute and afternoon. */
  heavyRain: diurnal(10, 14, { precipitationProbability: 95, precipitationMm: 3.5, precipitationType: 'rain', windKmh: 20, gustKmh: 35, humidity: 95 }),
  /** Strong wind, dry. */
  strongWind: diurnal(9, 13, { windKmh: 45, gustKmh: 70 }),
  /** Heat: 31 °C peak. */
  heat: diurnal(21, 31, { humidity: 45 }),
  /** Cool evening after a warm day (for evening-only wear). */
  warmDayCoolEvening: ((date, hour) => {
    const base = diurnal(12, 24)(date, hour);
    const t = hour >= 19 ? Math.max(11, 24 - (hour - 16) * 2.5) : base.temperatureC;
    return { ...base, temperatureC: t, apparentC: t };
  }) as WeatherScenario,
  /** Rain arriving at 16:00 on a mild day. */
  rainAfterFour: ((date, hour) => {
    const base = diurnal(12, 18)(date, hour);
    return hour >= 16 ? { ...base, precipitationProbability: 80, precipitationMm: 1.2, precipitationType: 'rain' } : base;
  }) as WeatherScenario,
} satisfies Record<string, WeatherScenario>;

export type WeatherScenarioName = keyof typeof WEATHER_SCENARIOS;

export interface FakeWeatherOptions {
  /** Scenario for every date, or per local date. */
  scenario?: WeatherScenario | WeatherScenarioName;
  byDate?: Record<string, WeatherScenario | WeatherScenarioName>;
  /** Scenario per location label (e.g. a trip destination), checked before `scenario`. */
  byLocation?: Record<string, WeatherScenario | WeatherScenarioName>;
  /** When true every call throws (provider outage). */
  fail?: boolean;
  issuedAt?: string | null;
  alerts?: string[];
  clock?: () => string;
  /** Fields to report as missing (simulating a partial provider). */
  missingFields?: (keyof HourConditions)[];
}

let instances = 0;

export class FakeWeatherProvider implements WeatherProvider {
  calls = 0;
  private revision = 0;
  private readonly instance = ++instances;
  constructor(public options: FakeWeatherOptions = {}) {}

  /**
   * Each fake instance and scenario change has its own provider identity, so the shared forecast cache
   * (keyed by provider, coarse location and interval) never serves another simulation's conditions.
   */
  get name(): string {
    return `fake-weather-${this.instance}-r${this.revision}`;
  }

  set(options: Partial<FakeWeatherOptions>): void {
    this.options = { ...this.options, ...options };
    // An outage keeps the identity (so a prior snapshot can serve as the stale fallback); new conditions do not.
    if ('scenario' in options || 'byDate' in options || 'byLocation' in options || 'missingFields' in options) this.revision++;
  }

  private scenarioFor(date: string, location?: string): WeatherScenario {
    const s = this.options.byDate?.[date] ?? (location ? this.options.byLocation?.[location] : undefined) ?? this.options.scenario ?? 'mild';
    return typeof s === 'string' ? WEATHER_SCENARIOS[s] : s;
  }

  async forecast(req: ForecastRequest): Promise<ForecastSnapshot> {
    this.calls++;
    if (this.options.fail) throw new WeatherProviderError('Simulated provider outage', this.name, 503);
    const hourly: HourlyPoint[] = [];
    const missing = new Set(this.options.missingFields ?? []);
    for (let d = req.startDate; d <= req.endDate; d = addDays(d, 1)) {
      const scenario = this.scenarioFor(d, req.location.label);
      for (let hour = 0; hour < 24; hour++) {
        const c = scenario(d, hour);
        const hh = `${String(hour).padStart(2, '0')}:00`;
        const v = <K extends keyof HourConditions>(k: K, fallback: HourConditions[K] | null = null) => (missing.has(k) ? null : (c[k] ?? fallback));
        hourly.push({
          time: zonedInstant(d, hh, req.timezone),
          local: `${d}T${hh}`,
          temperatureC: v('temperatureC') as number | null,
          apparentC: v('apparentC', c.temperatureC) as number | null,
          precipitationProbability: v('precipitationProbability', 0) as number | null,
          precipitationMm: v('precipitationMm', 0) as number | null,
          precipitationType: v('precipitationType', 'none') as HourlyPoint['precipitationType'],
          windKmh: v('windKmh', 10) as number | null,
          gustKmh: v('gustKmh', 15) as number | null,
          humidity: v('humidity', 70) as number | null,
        });
      }
    }
    const fetchedAt = this.options.clock?.() ?? new Date().toISOString();
    return {
      snapshotVersion: 'forecast/1',
      provider: this.name,
      attribution: 'Simulated forecast (test fixture)',
      location: req.location,
      timezone: req.timezone,
      fetchedAt,
      issuedAt: this.options.issuedAt === undefined ? fetchedAt : this.options.issuedAt,
      coveredFrom: hourly[0]!.time,
      coveredTo: new Date(Date.parse(hourly[hourly.length - 1]!.time) + 3_600_000).toISOString(),
      hourly,
      alerts: this.options.alerts ?? [],
      missingFields: [...missing, ...(this.options.issuedAt === null ? ['issuedAt'] : [])],
    };
  }
}
