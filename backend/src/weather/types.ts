/**
 * Weather provider interface (spec section 7, "Weather skill and preloaded forecast context").
 * Providers return raw hourly data in Celsius and km/h. Missing fields are recorded explicitly; a
 * rain probability is never converted into an amount.
 */

export interface WeatherLocation {
  label: string;
  latitude: number;
  longitude: number;
  /** How the coordinates were obtained, e.g. 'owner_settings', 'home_city_label', 'trip_destination'. */
  basis: string;
}

export interface HourlyPoint {
  /** UTC instant of the start of the hour. */
  time: string;
  /** Local wall-clock 'YYYY-MM-DDTHH:MM' in the forecast timezone. */
  local: string;
  temperatureC: number | null;
  apparentC: number | null;
  /** 0–100. */
  precipitationProbability: number | null;
  precipitationMm: number | null;
  precipitationType: 'none' | 'rain' | 'snow' | 'mixed' | null;
  windKmh: number | null;
  gustKmh: number | null;
  humidity: number | null;
}

export interface ForecastSnapshot {
  snapshotVersion: 'forecast/1';
  provider: string;
  attribution: string;
  location: WeatherLocation;
  timezone: string;
  fetchedAt: string;
  /** Issue time of the model run when the provider supplies one; null otherwise (recorded as missing). */
  issuedAt: string | null;
  coveredFrom: string;
  coveredTo: string;
  hourly: HourlyPoint[];
  alerts: string[];
  /** Provider fields that were not supplied (e.g. 'issuedAt', 'alerts'). */
  missingFields: string[];
}

export interface ForecastRequest {
  location: WeatherLocation;
  timezone: string;
  /** Inclusive local dates. */
  startDate: string;
  endDate: string;
}

export interface WeatherProvider {
  readonly name: string;
  forecast(req: ForecastRequest): Promise<ForecastSnapshot>;
}

export class WeatherProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WeatherProviderError';
  }
}
