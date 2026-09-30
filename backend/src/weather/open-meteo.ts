import { zonedInstant } from '../domain/time.js';
import { WeatherProviderError, type ForecastRequest, type ForecastSnapshot, type HourlyPoint, type WeatherProvider } from './types.js';

/**
 * Open-Meteo forecast adapter (https://open-meteo.com/en/docs), the initial provider for this
 * personal, non-commercial deployment. Keyless; attribution retained (CC BY 4.0).
 *
 * Request: GET https://api.open-meteo.com/v1/forecast with `hourly=` variables, `timezone=<IANA>`,
 * `start_date`/`end_date` (local dates), `wind_speed_unit=kmh`. Response `hourly.time` values are local
 * wall-clock times in the requested timezone. Open-Meteo supplies no model issue time and no alerts;
 * both are recorded in `missingFields` rather than invented.
 */
export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_ATTRIBUTION = 'Weather data by Open-Meteo.com (CC BY 4.0)';

const HOURLY = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'wind_speed_10m',
  'wind_gusts_10m',
  'relative_humidity_2m',
] as const;

interface OpenMeteoResponse {
  timezone?: string;
  utc_offset_seconds?: number;
  hourly?: Partial<Record<(typeof HOURLY)[number] | 'time', (number | string | null)[]>>;
  error?: boolean;
  reason?: string;
}

export class OpenMeteoProvider implements WeatherProvider {
  readonly name = 'open-meteo';
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly endpoint = OPEN_METEO_ENDPOINT,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  buildUrl(req: ForecastRequest): string {
    const u = new URL(this.endpoint);
    u.searchParams.set('latitude', req.location.latitude.toFixed(4));
    u.searchParams.set('longitude', req.location.longitude.toFixed(4));
    u.searchParams.set('hourly', HOURLY.join(','));
    u.searchParams.set('timezone', req.timezone);
    u.searchParams.set('start_date', req.startDate);
    u.searchParams.set('end_date', req.endDate);
    u.searchParams.set('wind_speed_unit', 'kmh');
    u.searchParams.set('temperature_unit', 'celsius');
    u.searchParams.set('precipitation_unit', 'mm');
    return u.toString();
  }

  async forecast(req: ForecastRequest): Promise<ForecastSnapshot> {
    let res: Response;
    try {
      res = await this.fetcher(this.buildUrl(req), { headers: { accept: 'application/json' } });
    } catch (err) {
      throw new WeatherProviderError(`Open-Meteo unreachable: ${(err as Error).message}`, this.name);
    }
    if (!res.ok) throw new WeatherProviderError(`Open-Meteo returned HTTP ${res.status}`, this.name, res.status);
    const body = (await res.json()) as OpenMeteoResponse;
    if (body.error) throw new WeatherProviderError(`Open-Meteo error: ${body.reason ?? 'unknown'}`, this.name);
    return parseOpenMeteo(body, req, this.clock());
  }
}

export function parseOpenMeteo(body: OpenMeteoResponse, req: ForecastRequest, fetchedAt: string): ForecastSnapshot {
  const h = body.hourly;
  if (!h?.time?.length) throw new WeatherProviderError('Open-Meteo response has no hourly data', 'open-meteo');
  const missing = new Set<string>(['issuedAt', 'alerts']);
  const col = (k: (typeof HOURLY)[number]) => {
    const c = h[k];
    if (!c) missing.add(k);
    return c ?? [];
  };
  const t = col('temperature_2m');
  const a = col('apparent_temperature');
  const pp = col('precipitation_probability');
  const pr = col('precipitation');
  const rain = col('rain');
  const showers = col('showers');
  const snow = col('snowfall');
  const w = col('wind_speed_10m');
  const gu = col('wind_gusts_10m');
  const hu = col('relative_humidity_2m');
  const num = (v: number | string | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hourly: HourlyPoint[] = h.time.map((local, i) => {
    const [date, time] = String(local).split('T') as [string, string];
    const liquid = (num(rain[i]) ?? 0) + (num(showers[i]) ?? 0);
    const solid = num(snow[i]) ?? 0;
    const total = num(pr[i]);
    const type: HourlyPoint['precipitationType'] = total === null ? null : total <= 0 ? 'none' : liquid > 0 && solid > 0 ? 'mixed' : solid > 0 ? 'snow' : 'rain';
    return {
      time: zonedInstant(date, time.slice(0, 5), req.timezone),
      local: `${date}T${time.slice(0, 5)}`,
      temperatureC: num(t[i]),
      apparentC: num(a[i]),
      precipitationProbability: num(pp[i]),
      precipitationMm: total,
      precipitationType: type,
      windKmh: num(w[i]),
      gustKmh: num(gu[i]),
      humidity: num(hu[i]),
    };
  });
  return {
    snapshotVersion: 'forecast/1',
    provider: 'open-meteo',
    attribution: OPEN_METEO_ATTRIBUTION,
    location: req.location,
    timezone: req.timezone,
    fetchedAt,
    issuedAt: null,
    coveredFrom: hourly[0]!.time,
    coveredTo: new Date(Date.parse(hourly[hourly.length - 1]!.time) + 3_600_000).toISOString(),
    hourly,
    alerts: [],
    missingFields: [...missing],
  };
}
