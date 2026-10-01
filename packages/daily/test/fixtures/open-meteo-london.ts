/**
 * RECORDED real responses from Open-Meteo (not synthetic). Captured with curl on 2026-09-30.
 *
 * Forecast URL (London, two days, so nothing was trimmed beyond the request itself):
 *   https://api.open-meteo.com/v1/forecast?latitude=51.5074&longitude=-0.1278&timezone=Europe%2FLondon&start_date=2026-09-30&end_date=2026-10-01&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,rain,showers,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m&wind_speed_unit=kmh&temperature_unit=celsius&precipitation_unit=mm
 *
 * Geocoding URL:
 *   https://geocoding-api.open-meteo.com/v1/search?name=London&count=1&language=en&format=json
 * No-match URL (same, name=Zzzxqqnowhere): the service answers 200 without a `results` key.
 *
 * The values are exactly as returned; only JSON whitespace differs.
 */
export const OPEN_METEO_LONDON_FORECAST = {
  latitude: 51.51147,
  longitude: -0.13078308,
  generationtime_ms: 0.4919767379760742,
  utc_offset_seconds: 3600,
  timezone: "Europe/London",
  timezone_abbreviation: "GMT+1",
  elevation: 16.0,
  hourly_units: {
    time: "iso8601",
    temperature_2m: "°C",
    apparent_temperature: "°C",
    precipitation_probability: "%",
    precipitation: "mm",
    rain: "mm",
    showers: "mm",
    snowfall: "cm",
    weather_code: "wmo code",
    wind_speed_10m: "km/h",
    wind_gusts_10m: "km/h",
    relative_humidity_2m: "%",
  },
  hourly: {
    time: ["2026-09-30T00:00", "2026-09-30T01:00", "2026-09-30T02:00", "2026-09-30T03:00", "2026-09-30T04:00", "2026-09-30T05:00", "2026-09-30T06:00", "2026-09-30T07:00", "2026-09-30T08:00", "2026-09-30T09:00", "2026-09-30T10:00", "2026-09-30T11:00", "2026-09-30T12:00", "2026-09-30T13:00", "2026-09-30T14:00", "2026-09-30T15:00", "2026-09-30T16:00", "2026-09-30T17:00", "2026-09-30T18:00", "2026-09-30T19:00", "2026-09-30T20:00", "2026-09-30T21:00", "2026-09-30T22:00", "2026-09-30T23:00", "2026-10-01T00:00", "2026-10-01T01:00", "2026-10-01T02:00", "2026-10-01T03:00", "2026-10-01T04:00", "2026-10-01T05:00", "2026-10-01T06:00", "2026-10-01T07:00", "2026-10-01T08:00", "2026-10-01T09:00", "2026-10-01T10:00", "2026-10-01T11:00", "2026-10-01T12:00", "2026-10-01T13:00", "2026-10-01T14:00", "2026-10-01T15:00", "2026-10-01T16:00", "2026-10-01T17:00", "2026-10-01T18:00", "2026-10-01T19:00", "2026-10-01T20:00", "2026-10-01T21:00", "2026-10-01T22:00", "2026-10-01T23:00"],
    temperature_2m: [22.0, 22.2, 22.4, 22.1, 21.9, 21.0, 20.8, 21.1, 21.5, 21.9, 21.2, 20.7, 21.4, 22.6, 23.3, 23.7, 23.7, 23.2, 22.1, 21.3, 20.4, 20.0, 19.6, 19.3, 18.0, 16.3, 16.6, 16.1, 15.6, 15.4, 15.2, 14.8, 15.0, 15.7, 16.7, 17.9, 19.0, 19.9, 20.4, 20.6, 20.5, 20.2, 19.7, 19.0, 18.4, 17.5, 16.4, 15.7],
    apparent_temperature: [23.0, 22.6, 22.5, 22.5, 21.7, 21.3, 21.5, 21.5, 21.9, 22.0, 21.6, 21.4, 21.5, 22.1, 22.3, 22.1, 21.6, 21.1, 20.2, 19.8, 17.6, 18.3, 18.7, 18.9, 16.2, 16.0, 16.5, 15.4, 14.8, 14.7, 14.3, 13.7, 13.8, 14.3, 15.7, 16.1, 16.2, 16.8, 17.3, 17.2, 17.2, 17.0, 16.6, 16.3, 16.0, 15.1, 14.5, 14.1],
    precipitation_probability: [20, 8, 9, 17, 25, 31, 37, 45, 59, 76, 84, 79, 66, 51, 33, 12, 0, 2, 13, 20, 19, 14, 12, 15, 21, 24, 23, 20, 16, 11, 6, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    precipitation: [0.0, 0.0, 0.0, 0.0, 0.1, 0.0, 0.1, 0.0, 0.0, 0.0, 0.2, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    rain: [0.0, 0.0, 0.0, 0.0, 0.1, 0.0, 0.1, 0.0, 0.0, 0.0, 0.2, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    showers: [0.0, 0.0, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.1, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.2, 0.2, 0.7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    snowfall: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    weather_code: [3, 3, 3, 1, 51, 3, 51, 3, 3, 3, 51, 51, 2, 1, 1, 3, 0, 0, 3, 0, 0, 2, 3, 2, 3, 51, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    wind_speed_10m: [10.4, 12.2, 13.0, 11.2, 14.0, 14.0, 11.5, 13.0, 14.0, 16.6, 16.2, 17.3, 13.0, 13.3, 12.6, 13.0, 13.7, 13.3, 13.7, 11.9, 14.8, 12.2, 6.8, 5.0, 16.2, 9.4, 8.3, 10.4, 9.7, 8.6, 10.1, 11.9, 12.2, 13.0, 10.1, 11.5, 14.0, 14.4, 13.7, 14.8, 14.0, 13.0, 12.6, 10.4, 9.7, 10.8, 9.7, 8.3],
    wind_gusts_10m: [22.7, 25.9, 27.7, 23.8, 29.9, 30.2, 24.8, 27.7, 30.2, 34.9, 34.9, 34.9, 28.4, 29.9, 28.4, 29.5, 30.6, 29.9, 30.6, 26.3, 31.7, 26.3, 14.8, 10.8, 35.3, 20.9, 17.6, 22.7, 20.9, 19.1, 21.6, 25.6, 25.9, 28.4, 21.2, 25.6, 32.0, 33.5, 32.0, 33.8, 32.0, 29.2, 28.1, 23.0, 21.2, 23.4, 21.2, 18.4],
    relative_humidity_2m: [73, 69, 67, 67, 67, 76, 77, 75, 75, 74, 80, 88, 71, 59, 51, 45, 41, 42, 46, 51, 43, 53, 55, 58, 66, 82, 81, 80, 79, 80, 81, 83, 81, 76, 70, 58, 46, 40, 37, 36, 36, 35, 37, 40, 44, 50, 58, 61],
  },
};

export const OPEN_METEO_LONDON_GEOCODING = {
  results: [
    {
      id: 2643743,
      name: "London",
      latitude: 51.50853,
      longitude: -0.12574,
      elevation: 25.0,
      feature_code: "PPLC",
      country_code: "GB",
      admin1_id: 6269131,
      admin2_id: 2648110,
      timezone: "Europe/London",
      population: 8961989,
      country_id: 2635167,
      country: "United Kingdom",
      admin1: "England",
      admin2: "Greater London",
    },
  ],
  generationtime_ms: 0.60880184,
};

/** Recorded answer for a name that matches nothing: HTTP 200, no `results` key. */
export const OPEN_METEO_NO_MATCH_GEOCODING = { generationtime_ms: 0.51796436 };

/** Recorded HTTP 400 body for an unknown hourly variable (`hourly=bogus_var`). */
export const OPEN_METEO_ERROR_BODY = {
  reason: "Invalid value: Cannot initialize SurfacePressureAndHeightVariable<VariableAndPreviousDay, VariableOrSpread<ForecastPressureVariable>, ForecastHeightVariable> from invalid String value bogus_var",
  error: true,
};
