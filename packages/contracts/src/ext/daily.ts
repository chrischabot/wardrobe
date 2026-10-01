/**
 * Daily-service contracts (owned by the daily-service workstream).
 *
 * One semantic board document serves the native app, the private web board and the Calendar text.
 * Every exported schema here is picked up by the contract generator (JSON Schema + Swift).
 * Import as `@garderobe/contracts/ext/daily`.
 */
import { z } from "zod";
import { GarmentId, IanaTimezone, Instant, LocalDate, SourceRef } from "../primitives.ts";
import { Role } from "../garment.ts";

export const DAILY_CONTRACT_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* Outfits and validation                                               */
/* ------------------------------------------------------------------ */

/** One garment in one role. Options reference real garment IDs; names always come from records. */
export const OutfitSlot = z.object({ role: Role, garmentId: GarmentId });
export type OutfitSlot = z.infer<typeof OutfitSlot>;

/** A factual claim an explanation relies on; verified against the garment record before publication. */
export const OutfitClaim = z.object({
  garmentId: GarmentId,
  attribute: z.enum(["name", "colour", "fabric", "maker", "category", "pattern"]),
  value: z.string().min(1),
});
export type OutfitClaim = z.infer<typeof OutfitClaim>;

/** What a composer (model or deterministic) proposes. IDs only; display names are never accepted. */
export const OutfitCandidate = z.object({
  slots: z.array(OutfitSlot).min(1),
  /** Additional footwear the owner can pick at the door (sneaker + welted once the fleet returns). */
  footwearAlternatives: z.array(GarmentId).default([]),
  /** Intended visual principle, one or two sentences. */
  principle: z.string().max(600).nullable().default(null),
  claims: z.array(OutfitClaim).default([]),
  /** Calendar event IDs this candidate is meant to suit. */
  suitsEventIds: z.array(z.string()).default([]),
});
export type OutfitCandidate = z.infer<typeof OutfitCandidate>;

export const ValidationMode = z.enum([
  "for_today", // only eligible owned stock; every hard rule
  "explore", // Studio exploration: seasonal/stored pieces allowed, result is labelled not-wearable-today
]);
export type ValidationMode = z.infer<typeof ValidationMode>;

export const OutfitViolation = z.object({
  /** Stable machine code, e.g. `socks_required`, `unavailable`, `repeat_within_horizon`. */
  code: z.string(),
  message: z.string(),
  garmentIds: z.array(GarmentId),
  severity: z.enum(["blocking", "advisory"]),
  /** Style rule key (and version) that produced the violation, where one did. */
  ruleKey: z.string().nullable().default(null),
});
export type OutfitViolation = z.infer<typeof OutfitViolation>;

export const OutfitValidation = z.object({
  valid: z.boolean(),
  violations: z.array(OutfitViolation),
  /** Facts and rules the verdict rests on (weather basis, rule versions, availability model, revisions). */
  evidence: z.record(z.string(), z.unknown()),
});
export type OutfitValidation = z.infer<typeof OutfitValidation>;

export const ValidateOutfitInput = z.object({
  slots: z.array(OutfitSlot).min(1),
  footwearAlternatives: z.array(GarmentId).default([]),
  forDate: LocalDate,
  mode: ValidationMode.default("for_today"),
  /** Validate against the packed subset of this trip instead of home stock. */
  tripId: z.string().nullable().default(null),
  /** Explicit scoped exception to the repeat rule (owner override / packing request). */
  allowRepeat: z.boolean().default(false),
  /** Garments the owner explicitly asked for: lets occasional / indoor-only pieces through. Never makes absent stock present. */
  explicitGarmentIds: z.array(GarmentId).default([]),
});
export type ValidateOutfitInput = z.input<typeof ValidateOutfitInput>;

export const SuggestOutfitsInput = z.object({
  locked: z.array(OutfitSlot).default([]),
  openRoles: z.array(Role).default([]),
  forDate: LocalDate,
  mode: ValidationMode.default("for_today"),
  tripId: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(12).default(5),
});
export type SuggestOutfitsInput = z.input<typeof SuggestOutfitsInput>;

export const SuggestedOutfit = z.object({ slots: z.array(OutfitSlot), reason: z.string(), validation: OutfitValidation });
export type SuggestedOutfit = z.infer<typeof SuggestedOutfit>;

/* ------------------------------------------------------------------ */
/* Weather                                                              */
/* ------------------------------------------------------------------ */

export const WeatherProviderName = z.enum(["open-meteo", "weatherkit"]);
export type WeatherProviderName = z.infer<typeof WeatherProviderName>;

export const PrecipitationType = z.enum(["none", "rain", "showers", "snow", "mixed", "sleet", "hail"]);

/** One forecast hour. `null` means the provider did not supply the field: never read it as zero. */
export const WeatherHour = z.object({
  /** Local wall time in the snapshot timezone, `YYYY-MM-DDTHH:00`. */
  localTime: z.string(),
  at: Instant,
  temperatureC: z.number().nullable(),
  apparentTemperatureC: z.number().nullable(),
  precipitationProbabilityPct: z.number().nullable(),
  precipitationMm: z.number().nullable(),
  precipitationType: PrecipitationType.nullable(),
  windSpeedKmh: z.number().nullable(),
  windGustKmh: z.number().nullable(),
  humidityPct: z.number().nullable(),
});
export type WeatherHour = z.infer<typeof WeatherHour>;

export const WeatherAlert = z.object({ title: z.string(), severity: z.string().nullable(), startsAt: Instant.nullable(), endsAt: Instant.nullable(), source: z.string().nullable() });

export const WeatherLocation = z.object({
  label: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: IanaTimezone,
});
export type WeatherLocation = z.infer<typeof WeatherLocation>;

/** Temperatures and conditions of one named interval of the day. */
export const WeatherWindow = z.object({
  name: z.enum(["departure", "daytime", "evening_return", "evening"]),
  fromLocalTime: z.string(),
  toLocalTime: z.string(),
  /** Hours of the interval the forecast actually covered. */
  coveredHours: z.number().int().nonnegative(),
  minC: z.number().nullable(),
  maxC: z.number().nullable(),
  apparentMinC: z.number().nullable(),
  apparentMaxC: z.number().nullable(),
  maxPrecipitationProbabilityPct: z.number().nullable(),
  precipitationMm: z.number().nullable(),
  maxWindGustKmh: z.number().nullable(),
});
export type WeatherWindow = z.infer<typeof WeatherWindow>;

export const WeatherFreshness = z.enum([
  "fresh", // fetched within the freshness threshold and covering the day
  "stale", // an older snapshot reused after a failed or skipped fetch; its age is shown
  "unavailable", // no usable forecast: nothing is assumed about temperature, rain or wind
]);
export type WeatherFreshness = z.infer<typeof WeatherFreshness>;

/** The temperature bases composition and validation use, with the interval each came from. */
export const DayConditions = z.object({
  freshness: WeatherFreshness,
  snapshotId: z.string().nullable(),
  /** Maximum across the intended wearing interval (daytime, or the evening interval for an evening-only outfit). Base layers, trousers and socks. */
  peakC: z.number().nullable(),
  peakInterval: z.string().nullable(),
  /** Outdoor temperature when a jacket is worn, normally departure. Outerwear and the 14-16 C rule. */
  departureC: z.number().nullable(),
  departureInterval: z.string().nullable(),
  eveningReturnC: z.number().nullable(),
  maxPrecipitationProbabilityPct: z.number().nullable(),
  precipitationMm: z.number().nullable(),
  /** Local hour (0-23) from which rain is likely, when it is. */
  rainLikelyFromHour: z.number().int().nullable(),
  maxWindGustKmh: z.number().nullable(),
  segment: z.enum(["day", "evening"]).default("day"),
});
export type DayConditions = z.infer<typeof DayConditions>;

export const WeatherSnapshot = z.object({
  snapshotId: z.string(),
  localDate: LocalDate,
  provider: WeatherProviderName,
  attribution: z.string(),
  location: WeatherLocation,
  fetchedAt: Instant,
  /** Forecast issue/model time when the provider supplies one; null otherwise. */
  issuedAt: Instant.nullable(),
  coversFrom: Instant.nullable(),
  coversTo: Instant.nullable(),
  freshness: WeatherFreshness,
  ageMinutes: z.number().nullable(),
  /** Provider fields that were absent for this forecast (e.g. `alerts`, `issuedAt`). */
  missingFields: z.array(z.string()),
  hours: z.array(WeatherHour),
  alerts: z.array(WeatherAlert).nullable().describe("null = the provider offers no alert data; [] = none active."),
  windows: z.array(WeatherWindow),
  conditions: DayConditions,
  /** Brief native line, e.g. "12 °C leaving, 18 °C later; rain after 4." */
  line: z.string(),
  /** Why the snapshot is stale or unavailable, when it is. */
  limitation: z.string().nullable(),
});
export type WeatherSnapshot = z.infer<typeof WeatherSnapshot>;

/** Typed tools of the `weather-for-outfits` backend skill. */
export const WeatherForecastInput = z.object({
  localDate: LocalDate,
  /** Defaults to the owner's saved home city. A city label alone is enough (it is geocoded). */
  location: z.object({ label: z.string().min(1), latitude: z.number().optional(), longitude: z.number().optional(), timezone: IanaTimezone.optional() }).optional(),
  segment: z.enum(["day", "evening"]).default("day"),
});
export type WeatherForecastInput = z.input<typeof WeatherForecastInput>;

export const WeatherCompareLocationsInput = z.object({
  localDate: LocalDate,
  locations: z.array(z.object({ label: z.string().min(1), latitude: z.number().optional(), longitude: z.number().optional(), timezone: IanaTimezone.optional() })).min(2).max(4),
});
export type WeatherCompareLocationsInput = z.input<typeof WeatherCompareLocationsInput>;

export const WeatherComparison = z.object({
  localDate: LocalDate,
  snapshots: z.array(WeatherSnapshot),
  /** Factual differences between the first location and each other one (null where either side is unknown). */
  differences: z.array(z.object({ label: z.string(), peakDeltaC: z.number().nullable(), departureDeltaC: z.number().nullable(), utcOffsetDeltaMinutes: z.number().nullable(), note: z.string() })),
});
export type WeatherComparison = z.infer<typeof WeatherComparison>;

/* ------------------------------------------------------------------ */
/* Calendar context                                                     */
/* ------------------------------------------------------------------ */

export const CalendarEventContext = z.object({
  eventId: z.string(),
  calendarId: z.string(),
  title: z.string(),
  startsAt: Instant.nullable(),
  endsAt: Instant.nullable(),
  allDay: z.boolean(),
  location: z.string().nullable(),
  /** The owner's own response. Declined and cancelled events never constrain the board. */
  attendance: z.enum(["accepted", "tentative", "declined", "needs_action", "organizer", "unknown"]),
  cancelled: z.boolean(),
  /** How much the event shapes the board: none (declined, cancelled, all-day reminder), reduced (tentative), full. */
  weight: z.enum(["none", "reduced", "full"]),
  /** Occasion inferred from the event text: evidence to interpret, never authority. */
  inferredOccasion: z.enum(["smart", "practical", "none"]),
});
export type CalendarEventContext = z.infer<typeof CalendarEventContext>;

export const CalendarSnapshot = z.object({
  snapshotId: z.string(),
  localDate: LocalDate,
  /** `ok` with zero events is an EMPTY calendar; `not_connected` / `error` are MISSING access. They are never conflated. */
  status: z.enum(["ok", "not_connected", "error", "stale"]),
  readAt: Instant.nullable(),
  ageMinutes: z.number().nullable(),
  events: z.array(CalendarEventContext),
  limitation: z.string().nullable(),
});
export type CalendarSnapshot = z.infer<typeof CalendarSnapshot>;

/* ------------------------------------------------------------------ */
/* Boards                                                               */
/* ------------------------------------------------------------------ */

/** The owner's editable day brief. It outranks any occasion inferred from the calendar. */
export const DayBrief = z.object({
  text: z.string().nullable().default(null),
  requestedCount: z.number().int().min(1).max(8).nullable().default(null),
  include: z.array(GarmentId).default([]),
  exclude: z.array(GarmentId).default([]),
  /** Only an explicit request makes an occasion a whole-board constraint. */
  occasionOnly: z.boolean().default(false),
  /** Explicit scoped exception to the seven-day repeat rule for this board only. */
  allowRepeat: z.boolean().default(false),
  segment: z.enum(["day", "evening"]).default("day"),
});
export type DayBrief = z.infer<typeof DayBrief>;

export const BoardGarmentLine = z.object({
  garmentId: GarmentId,
  role: Role,
  /** Perceptible name from the garment record. */
  name: z.string(),
  colour: z.string().nullable(),
});
export type BoardGarmentLine = z.infer<typeof BoardGarmentLine>;

export const BoardOption = z.object({
  /** Durable identity of the option. The number is only a convenience within one revision. */
  optionId: z.string(),
  number: z.number().int().positive(),
  /** Short recognisable title built from record names. */
  name: z.string(),
  /** One or two sentences on why it works; factual claims verified against records. */
  reason: z.string(),
  garments: z.array(BoardGarmentLine),
  footwearAlternatives: z.array(BoardGarmentLine),
  /** Optional scarf/tie flourish carried on the belt line. */
  flourish: BoardGarmentLine.nullable(),
  /** Calendar events this option suits. */
  suitsEventIds: z.array(z.string()),
  /** Concise qualification shown only when uncertainty materially affects the choice. */
  qualification: z.string().nullable(),
  /** True when this option changed in the current revision (changed-item receipt). */
  changedInRevision: z.boolean(),
});
export type BoardOption = z.infer<typeof BoardOption>;

export const BoardValidity = z.enum([
  "current", // validated against current state and fresh sources
  "limited", // published with a stated limitation (stale/unavailable weather or calendar)
  "degraded", // fewer valid options than requested; the notice says why
  "worn", // the day's outfit is recorded; the board is history
  "suppressed", // removed or paused for that day
]);
export type BoardValidity = z.infer<typeof BoardValidity>;

/** The one semantic board document behind the app, the private web board and the Calendar text. */
export const BoardDocument = z.object({
  boardId: z.string(),
  /** `home`, or `trip:<tripId>` for a trip-day board. */
  scope: z.string(),
  localDate: LocalDate,
  timezone: IanaTimezone,
  revision: z.number().int().positive(),
  publishedAt: Instant,
  reason: z.enum(["compose", "refresh", "repair", "replenish", "swap", "rebuild", "resume"]),
  validity: BoardValidity,
  /** Day line closing on the shape of the day. */
  dayLine: z.string(),
  weatherLine: z.string().nullable(),
  /** e.g. "Three options work for your meeting today." */
  suitabilityLine: z.string().nullable(),
  /** One brief explanation outside the outfit copy (shortage, stale source). Never inside an option. */
  notice: z.string().nullable(),
  requestedCount: z.number().int().positive(),
  options: z.array(BoardOption),
  selection: z.object({ optionId: z.string(), footwearGarmentId: GarmentId.nullable(), selectedAt: Instant }).nullable(),
  /** What changed from the previous revision, in ledger names. */
  changes: z.array(z.string()),
  brief: DayBrief,
  freshness: z.object({
    weather: WeatherFreshness,
    weatherSnapshotId: z.string().nullable(),
    weatherFetchedAt: Instant.nullable(),
    calendar: z.enum(["ok", "not_connected", "error", "stale", "not_read"]),
    calendarSnapshotId: z.string().nullable(),
    calendarReadAt: Instant.nullable(),
    wardrobeRevision: z.number().int().nonnegative(),
    styleRevision: z.number().int().nonnegative(),
  }),
  calendarProjection: z.object({
    state: z.enum(["not_requested", "pending", "projected", "failed", "not_connected", "suppressed"]),
    projectedRevision: z.number().int().nullable(),
    /** Concise connection action when Calendar needs the owner. */
    action: z.string().nullable(),
  }),
});
export type BoardDocument = z.infer<typeof BoardDocument>;

/** `GET /v1/today`: the current board, the day's record and the service state. Reading it needs no inference. */
export const TodayView = z.object({
  localDate: LocalDate,
  timezone: IanaTimezone,
  board: BoardDocument.nullable(),
  /** Garments recorded as worn today (the day's record once a wear exists). */
  dayRecord: z.array(BoardGarmentLine),
  paused: z.object({ pauseId: z.string(), from: LocalDate, resumeOn: LocalDate.nullable() }).nullable(),
  /** Why there is no board, when there is none (paused, not yet prepared, nothing eligible). */
  emptyReason: z.string().nullable(),
  readAt: Instant,
});
export type TodayView = z.infer<typeof TodayView>;

/** Stored per option: what the validator checked and the probability basis. */
export const OptionEvidence = z.object({
  validation: OutfitValidation,
  jointAvailability: z.number().min(0).max(1),
  availabilityModelVersion: z.string(),
  source: z.enum(["model", "deterministic", "reserve", "approved_combination", "owner_swap", "repair"]),
  explanationSource: z.enum(["model_verified", "factual"]),
  removedClaims: z.array(z.string()),
  /** Pieces the owner put into this option himself; they stay admitted (e.g. an occasional piece) when the option is revalidated. */
  explicitGarmentIds: z.array(GarmentId).default([]),
});
export type OptionEvidence = z.infer<typeof OptionEvidence>;

/* ------------------------------------------------------------------ */
/* Command payloads (registered by registerDaily)                       */
/* ------------------------------------------------------------------ */

export const PublishedOptionInput = z.object({
  /** Keep an existing option's identity across revisions; omitted for a new option. */
  optionId: z.string().optional(),
  slots: z.array(OutfitSlot).min(1),
  footwearAlternatives: z.array(GarmentId).default([]),
  reason: z.string().max(600),
  explanationSource: z.enum(["model_verified", "factual"]).default("factual"),
  removedClaims: z.array(z.string()).default([]),
  explicitGarmentIds: z.array(GarmentId).default([]),
  source: z.enum(["model", "deterministic", "reserve", "approved_combination", "owner_swap", "repair"]).default("deterministic"),
  suitsEventIds: z.array(z.string()).default([]),
});
export type PublishedOptionInput = z.infer<typeof PublishedOptionInput>;

/**
 * Publish a board revision. The handler revalidates every option against CURRENT state inside the
 * command: a candidate that went stale during composition cannot commit; it is replaced from the
 * reserves or dropped, never padded.
 */
export const BoardPublish = z.object({
  localDate: LocalDate,
  scope: z.string().default("home"),
  reason: z.enum(["compose", "refresh", "repair", "replenish", "swap", "rebuild", "resume"]).default("compose"),
  options: z.array(PublishedOptionInput),
  reserves: z.array(PublishedOptionInput).default([]),
  brief: DayBrief.default(DayBrief.parse({})),
  requestedCount: z.number().int().min(1).max(8),
  weatherSnapshotId: z.string().nullable().default(null),
  calendarSnapshotId: z.string().nullable().default(null),
  notice: z.string().nullable().default(null),
  /** Revisions the composition read; recorded as evidence. */
  composedAgainst: z.object({ wardrobeRevision: z.number().int(), styleRevision: z.number().int() }).optional(),
});

/** Choose records an intention, never a wear. `optionId: null` clears the selection. */
export const BoardSelect = z.object({ boardId: z.string(), optionId: z.string().nullable(), footwearGarmentId: GarmentId.nullable().default(null) });

/** Swap one slot. With `garmentId` the owner's pick is validated; without it a replacement is chosen (never navy by default). */
export const BoardSwapSlot = z.object({
  boardId: z.string(),
  optionId: z.string(),
  role: Role,
  garmentId: GarmentId.optional(),
  /**
   * A weather snapshot read for this swap (the service's `swapSlot` supplies it when the board's stored
   * forecast is past its freshness threshold). Without it the newest recorded snapshot for the day is used.
   */
  weatherSnapshotId: z.string().optional(),
});

/** Remove / pause a single day's board; records a suppression so retries cannot recreate the event. */
export const BoardSuppress = z.object({ localDate: LocalDate, scope: z.string().default("home"), reason: z.string().nullable().default(null) });
export const BoardRestore = z.object({ localDate: LocalDate, scope: z.string().default("home") });
/** The morning surface: marks the prepared board as presented and queues the configured reminder. No inference. */
export const BoardPresent = z.object({ localDate: LocalDate, scope: z.string().default("home") });

export const ServicePause = z.object({
  /** First paused local date; defaults to today. */
  from: LocalDate.optional(),
  /** Optional resume date (first active day). Omit for an indefinite pause. */
  resumeOn: LocalDate.nullable().default(null),
});
export const ServiceResume = z.object({});

export const PauseState = z.object({ pauseId: z.string(), from: LocalDate, resumeOn: LocalDate.nullable(), status: z.enum(["active", "ended"]), createdAt: Instant, endedAt: Instant.nullable() });
export type PauseState = z.infer<typeof PauseState>;

export const TripDestination = z.object({
  label: z.string().min(1),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  timezone: IanaTimezone,
  from: LocalDate,
  to: LocalDate,
});
export type TripDestination = z.infer<typeof TripDestination>;

export const TripOccasion = z.object({ localDate: LocalDate, label: z.string().min(1), register: z.enum(["smart", "practical", "none"]).default("none"), segment: z.enum(["day", "evening"]).default("day") });

export const TripCreate = z.object({
  tripId: z.string().optional(),
  name: z.string().min(1),
  departsOn: LocalDate,
  returnsOn: LocalDate,
  destinations: z.array(TripDestination).min(1),
  occasions: z.array(TripOccasion).default([]),
  luggage: z.object({ label: z.string(), maxPieces: z.number().int().positive().nullable().default(null) }).nullable().default(null),
  /** Washing opportunities are estimates until an observation applies. */
  laundry: z.array(z.object({ localDate: LocalDate, note: z.string().nullable().default(null) })).default([]),
  source: SourceRef,
});
export const TripUpdate = z.object({
  tripId: z.string(),
  changes: z
    .object({
      name: z.string().min(1),
      departsOn: LocalDate,
      returnsOn: LocalDate,
      destinations: z.array(TripDestination).min(1),
      occasions: z.array(TripOccasion),
      luggage: z.object({ label: z.string(), maxPieces: z.number().int().positive().nullable().default(null) }).nullable(),
      laundry: z.array(z.object({ localDate: LocalDate, note: z.string().nullable().default(null) })),
    })
    .partial()
    .refine((c) => Object.keys(c).length > 0, "at least one change is required"),
});
export const TripCancel = z.object({ tripId: z.string() });

export const PackingItem = z.object({ garmentId: GarmentId, name: z.string(), role: Role, quantity: z.number().int().positive() });
export const PackingDayPlan = z.object({ localDate: LocalDate, segment: z.enum(["day", "evening"]), occasion: z.string().nullable(), slots: z.array(OutfitSlot), reason: z.string() });

/** A PROPOSED packing list: distinct from physically packed quantities (`stock.pack`). */
export const PackingProposal = z.object({
  tripId: z.string(),
  revision: z.number().int().positive(),
  createdAt: Instant,
  items: z.array(PackingItem),
  days: z.array(PackingDayPlan),
  /** The repeat-policy exception applies to this trip only. */
  repeatExceptionForTrip: z.literal(true),
  weather: z.array(z.object({ localDate: LocalDate, label: z.string(), freshness: WeatherFreshness, line: z.string() })),
  notes: z.array(z.string()),
});
export type PackingProposal = z.infer<typeof PackingProposal>;

export const TripRecordPackingProposal = z.object({ tripId: z.string(), items: z.array(PackingItem), days: z.array(PackingDayPlan), weather: PackingProposal.shape.weather, notes: z.array(z.string()).default([]) });

export const Trip = z.object({
  tripId: z.string(),
  version: z.number().int().positive(),
  name: z.string(),
  departsOn: LocalDate,
  returnsOn: LocalDate,
  destinations: z.array(TripDestination),
  occasions: z.array(TripOccasion),
  luggage: z.object({ label: z.string(), maxPieces: z.number().int().positive().nullable() }).nullable(),
  laundry: z.array(z.object({ localDate: LocalDate, note: z.string().nullable() })),
  status: z.enum(["planned", "cancelled"]),
  /** Physically packed quantities, read from the stock ledger (never from the proposal). */
  packed: z.array(z.object({ garmentId: GarmentId, name: z.string(), clean: z.number().int().nonnegative(), worn: z.number().int().nonnegative() })),
  proposal: PackingProposal.nullable(),
});
export type Trip = z.infer<typeof Trip>;

/** System records of what external sources said (stored per owner; the shared weather cache holds no user IDs). */
export const WeatherRecordSnapshot = z.object({ snapshot: WeatherSnapshot, purpose: z.enum(["evening_compose", "morning_refresh", "adhoc", "trip", "resume"]) });
export const CalendarRecordSnapshot = z.object({ snapshot: CalendarSnapshot });

export const DAILY_COMMANDS = {
  "board.publish": BoardPublish,
  "board.select": BoardSelect,
  "board.swap_slot": BoardSwapSlot,
  "board.suppress": BoardSuppress,
  "board.restore": BoardRestore,
  "board.present": BoardPresent,
  "service.pause": ServicePause,
  "service.resume": ServiceResume,
  "trip.create": TripCreate,
  "trip.update": TripUpdate,
  "trip.cancel": TripCancel,
  "trip.record_packing_proposal": TripRecordPackingProposal,
  "weather.record_snapshot": WeatherRecordSnapshot,
  "calendar.record_snapshot": CalendarRecordSnapshot,
} as const;
export type DailyCommandType = keyof typeof DAILY_COMMANDS;

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

/** Simulation only: what becomes wearable at a chosen temperature. Never changes actual availability. */
export const TemperaturePreview = z.object({
  simulation: z.literal(true),
  label: z.string(),
  temperatureC: z.number(),
  wearable: z.array(z.object({ garmentId: GarmentId, name: z.string(), role: Role, inStorage: z.boolean(), basis: z.string() })),
  notWearable: z.array(z.object({ garmentId: GarmentId, name: z.string(), role: Role, why: z.string() })),
});
export type TemperaturePreview = z.infer<typeof TemperaturePreview>;

/** Settings the daily service reads from `OwnerSettings.extensions.daily` (all optional, with defaults). */
export const DailySettings = z.object({
  eveningComposeLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("21:00"),
  /** Minutes before the morning time for the refresh and the final publication. */
  morningRefreshLeadMinutes: z.number().int().positive().default(20),
  morningPublishLeadMinutes: z.number().int().positive().default(10),
  departureLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
  daytimeFromLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
  daytimeToLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("19:00"),
  eveningFromLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
  eveningToLocalTime: z.string().regex(/^\d{2}:\d{2}$/).default("23:00"),
  weatherMaxAgeMinutes: z.number().int().positive().default(60),
  calendarMaxAgeMinutes: z.number().int().positive().default(30),
  weatherProvider: WeatherProviderName.default("open-meteo"),
  reserveCount: z.number().int().min(0).max(5).default(3),
  calendar: z
    .object({
      /** Dedicated outfit calendar the managed event is written to; null until chosen in setup. */
      outfitCalendarId: z.string().nullable().default(null),
      /** Calendars read for day context. */
      readCalendarIds: z.array(z.string()).default(["primary"]),
      /** `timed`: transparent 15-minute event at the morning time. `all_day`: all-day board with a separate app reminder. */
      presentation: z.enum(["timed", "all_day"]).default("timed"),
      /** Calendar's own popup reminder, separate from app notifications; null = none. */
      reminderMinutesBefore: z.number().int().min(0).nullable().default(null),
      boardBaseUrl: z.string().nullable().default(null),
    })
    .default({ outfitCalendarId: null, readCalendarIds: ["primary"], presentation: "timed", reminderMinutesBefore: null, boardBaseUrl: null }),
});
export type DailySettings = z.infer<typeof DailySettings>;
