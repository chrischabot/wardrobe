import { z } from 'zod';
import { GarmentRole, Instant, LocalDate, OpaqueId, TimeZone } from './enums.js';

/**
 * The shared semantic outfit document of one board revision (spec sections 7 and 9; owner profile
 * section 11). The app, the private web board and the Calendar description render this one document
 * without extra lookups. Added additively under CONTRACTS_VERSION 2026-10-01; its own shape is
 * versioned by `documentVersion`.
 */
export const BOARD_DOCUMENT_VERSION = 'board-document/1' as const;

export const WeatherSourceStatus = z.enum(['fresh', 'stale', 'missing', 'unavailable']);
export type WeatherSourceStatus = z.infer<typeof WeatherSourceStatus>;

/** Clothing-relevant weather for the board's wearing interval. Missing values stay null, never guessed. */
export const BoardWeather = z.object({
  provider: z.string().nullable(),
  attribution: z.string().nullable(),
  locationLabel: z.string(),
  timezone: TimeZone,
  status: WeatherSourceStatus,
  fetchedAt: Instant.nullable(),
  /** Forecast issue time when the provider supplies one (Open-Meteo does not). */
  issuedAt: Instant.nullable(),
  ageMinutes: z.number().int().nonnegative().nullable(),
  /** Local wall-clock interval the outfit is worn in, e.g. 08:00–19:00, or an evening-only interval. */
  wearingInterval: z.object({ start: z.string(), end: z.string() }),
  eveningOnly: z.boolean(),
  departureTime: z.string(),
  /** Temperature at departure: the basis for outerwear (profile section 8, rule 4). */
  departureTempC: z.number().nullable(),
  /** Maximum across the wearing interval: the basis for shirts, trousers and socks. */
  peakTempC: z.number().nullable(),
  lowTempC: z.number().nullable(),
  eveningTempC: z.number().nullable(),
  apparentPeakC: z.number().nullable(),
  /** Highest hourly precipitation probability in the interval, 0–100. A probability is not an amount. */
  rainProbabilityMax: z.number().nullable(),
  rainAmountMm: z.number().nullable(),
  /** Local HH:MM of the first hour when rain becomes likely, if any. */
  rainStartsAt: z.string().nullable(),
  precipitationType: z.enum(['none', 'rain', 'snow', 'mixed']).nullable(),
  windSpeedMaxKmh: z.number().nullable(),
  windGustMaxKmh: z.number().nullable(),
  humidityMax: z.number().nullable(),
  conditions: z.array(z.enum(['cold', 'cool_start', 'warming', 'jacket_band_14_16', 'heat', 'rain', 'heavy_rain', 'windy', 'strong_wind', 'snow'])),
  alerts: z.array(z.string()),
  missingFields: z.array(z.string()),
  /** Brief native line, e.g. "12 °C leaving, 18 °C later; rain after 4". */
  line: z.string(),
});
export type BoardWeather = z.infer<typeof BoardWeather>;

/** Display data for one garment, so the board renders without extra lookups. */
export const BoardGarmentDisplay = z.object({
  garmentId: OpaqueId,
  /** Perceptible name (profile section 8, rule 7): what the owner sees at the wardrobe. */
  name: z.string(),
  role: GarmentRole,
  category: z.string(),
  colour: z.string().nullable(),
  colorFamily: z.string().nullable(),
  aliases: z.array(z.string()),
  images: z.array(z.object({ assetId: OpaqueId, kind: z.string(), role: z.enum(['catalogue', 'supporting']), verified: z.boolean() })),
  optional: z.boolean(),
  alternativeGroup: z.string().nullable(),
});
export type BoardGarmentDisplay = z.infer<typeof BoardGarmentDisplay>;

export const BoardLineKind = z.enum(['jacket', 'jumper', 'shirt', 'trousers', 'belt', 'socks_and_shoes']);
export const BoardLine = z.object({
  kind: BoardLineKind,
  label: z.string(),
  text: z.string(),
  garmentIds: z.array(OpaqueId),
  /** The belt line's optional scarf or tie (profile section 9): often ignored, always welcome. */
  flourish: z.object({ garmentId: OpaqueId, kind: z.enum(['scarf', 'tie']), text: z.string() }).nullable(),
});
export type BoardLine = z.infer<typeof BoardLine>;

export const BoardRegister = z.enum(['home_key', 'sprezzatura', 'rl_ivy', 'field_workwear', 'academic_blazer', 'fun_lane', 'other']);
export type BoardRegister = z.infer<typeof BoardRegister>;

export const BoardOptionDocument = z.object({
  optionId: OpaqueId,
  position: z.number().int().positive(),
  status: z.enum(['offerable', 'reserve']),
  register: BoardRegister,
  registers: z.array(BoardRegister),
  /** Opening sentence: why it works and what makes it interesting. */
  why: z.string(),
  lines: z.array(BoardLine),
  garments: z.array(BoardGarmentDisplay),
  footwear: z.array(z.object({ garmentId: OpaqueId, kind: z.enum(['sneaker', 'welted', 'other']) })),
  suitability: z.object({ occasion: z.string(), suitable: z.boolean() }).nullable(),
  /** Estimated joint availability of the whole outfit (estimator-based; not a calibrated accuracy). */
  jointAvailability: z.number().min(0).max(1),
  /** Present only when uncertainty materially affects the choice. */
  qualification: z.string().nullable(),
  lineage: z.object({ previousOptionId: OpaqueId.nullable(), changedRoles: z.array(GarmentRole) }),
});
export type BoardOptionDocument = z.infer<typeof BoardOptionDocument>;

export const BoardDocument = z.object({
  documentVersion: z.literal(BOARD_DOCUMENT_VERSION),
  boardDate: LocalDate,
  timezone: TimeZone,
  purpose: z.string(),
  /** Profile section 11: a day line closing on the shape of the day. */
  dayLine: z.string(),
  shapeOfDay: z.string(),
  /** e.g. "Three options work for your client meeting." Null when no event is relevant. */
  suitabilityNote: z.string().nullable(),
  weather: BoardWeather,
  calendar: z.object({
    status: z.enum(['read', 'empty', 'unavailable', 'not_connected']),
    fetchedAt: Instant.nullable(),
    occasion: z.string().nullable(),
    relevantEventTitle: z.string().nullable(),
    suitableCount: z.number().int().nonnegative(),
  }),
  requestedCount: z.number().int().positive(),
  options: z.array(BoardOptionDocument),
  reserves: z.number().int().nonnegative(),
  /** One brief explanation outside the outfit copy when fewer valid options exist than requested. */
  shortfall: z.string().nullable(),
  prose: z.enum(['deterministic', 'model']),
  /** Plain-text rendering (Calendar description body) in the profile's section 11 order. */
  text: z.string(),
});
export type BoardDocument = z.infer<typeof BoardDocument>;
