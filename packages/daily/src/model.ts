/**
 * In-memory model of one recommendation run. Everything here is assembled by trusted code from D1
 * (never by a model) and is the single input of validation, composition and repair.
 */
import type { Category, GarmentAttributes, GarmentAvailability, OwnerSettings, Role, StyleContext, ThermalBound } from "@garderobe/contracts";
import type { CalendarSnapshot, DailySettings, DayBrief, DayConditions, ValidationMode, WeatherSnapshot } from "@garderobe/contracts/ext/daily";
import type { EstimatorInput } from "@garderobe/domain";
import type { RuleSet } from "./rules.ts";

export type ColourFamily = "navy" | "blue" | "green" | "light_neutral" | "brown" | "grey" | "red" | "pink" | "yellow" | "black" | "unknown";

/** Families that count as neutrals for the profile's "never a single neutral three times" verdict. */
export const NEUTRAL_FAMILIES: ReadonlySet<ColourFamily> = new Set(["navy", "light_neutral", "brown", "grey", "black"]);
export const WARM_FAMILIES: ReadonlySet<ColourFamily> = new Set(["brown", "red", "pink", "yellow", "light_neutral"]);
export const COOL_FAMILIES: ReadonlySet<ColourFamily> = new Set(["navy", "blue", "green", "grey", "black"]);

const FAMILY_WORDS: [ColourFamily, RegExp][] = [
  // Order matters: the first family whose word appears wins ("slate blue" is blue, "dark navy" is navy).
  ["navy", /\b(navy|indigo|ink|inky)\b/],
  ["black", /\b(black|noir)\b/],
  ["pink", /\b(pink|rose)\b/],
  ["red", /\b(red|rust|burgundy|wine|maroon|brick|cherry)\b/],
  ["yellow", /\b(gold|golden|yellow|ochre)\b/],
  ["green", /\b(olive|sage|moss|laurel|evergreen|forest|pine|fatigue|emerald|green|khaki)\b/],
  ["brown", /\b(walnut|brown|tobacco|mocha|bark|café|cafe|marron|earth|clay|camel|chestnut)\b/],
  ["blue", /\b(blue|denim|airforce)\b/],
  ["grey", /\b(grey|gray|charcoal|slate|pepper|pow)\b/],
  ["light_neutral", /\b(beige|sand|stone|cream|bone|natural|biscuit|tea|off-white|white|almond|ecru)\b/],
];

/** Coarse colour family of a garment's recorded colour text. Unknown stays unknown. */
export function colourFamily(colour: string | null | undefined): ColourFamily {
  const text = (colour ?? "").toLowerCase();
  if (!text) return "unknown";
  for (const [family, pattern] of FAMILY_WORDS) if (pattern.test(text)) return family;
  return "unknown";
}

/**
 * Every neutral family a recorded colour names. A two-colour piece ("olive/cream") counts towards each
 * neutral it names, so the count behind the "never one neutral three times" verdict errs on the side
 * of variety. A colour whose only words are not neutrals yields none.
 */
export function neutralFamiliesOf(colour: string | null | undefined): ColourFamily[] {
  const text = (colour ?? "").toLowerCase();
  if (!text) return [];
  const out: ColourFamily[] = [];
  for (const [family, pattern] of FAMILY_WORDS) if (NEUTRAL_FAMILIES.has(family) && pattern.test(text)) out.push(family);
  return out;
}

export interface PoolGarment {
  garmentId: string;
  name: string;
  category: Category;
  roles: Role[];
  colour: string | null;
  fabric: string | null;
  maker: string | null;
  pattern: string | null;
  careChannel: "service" | "handwash" | "none";
  attributes: GarmentAttributes;
  thermal: ThermalBound | null;
  seasonNote: string | null;
  availability: GarmentAvailability;
  /** Recorded wearing dates within the pattern horizon before (and on) the board date, ascending. */
  wornDates: string[];
  colourFamily: ColourFamily;
  /** Trip scope only: clean units physically packed for the trip. */
  packedClean: number;
  /** Units in seasonal storage (used by Explore mode and the temperature preview). */
  inStorage: number;
}

/** A dated, scoped comfort observation from the owner (stored by the assistant workstream). */
export interface ComfortObservation {
  feedbackId: string;
  text: string;
  kind: string;
  /** Pain is never outweighed by a styling score. */
  pain: boolean;
  garmentIds: string[];
  wearingDate: string | null;
  /** Scope the owner stated; null = that occasion only. Never a universal ban. */
  scope: string | null;
  createdAt: string;
}

export interface ContextSource {
  name: string;
  /** Revision number or observation timestamp of the source. */
  revision: string;
  status: string;
}

export interface RecommendationContext {
  userId: string;
  localDate: string;
  today: string;
  timezone: string;
  nowMs: number;
  /** `home`, `home:evening`, `trip:<id>` or `trip:<id>:evening`. */
  scope: string;
  tripId: string | null;
  mode: ValidationMode;
  garments: Map<string, PoolGarment>;
  estimator: EstimatorInput;
  conditions: DayConditions;
  weather: WeatherSnapshot | null;
  calendar: CalendarSnapshot | null;
  /** The complete active style context (full profile text); null only when no profile was imported. */
  style: StyleContext | null;
  rules: RuleSet;
  settings: OwnerSettings;
  daily: DailySettings;
  brief: DayBrief;
  /** Counted wears in the pattern horizon. */
  wears: { garmentId: string; wearingDate: string }[];
  /** Selected options of other open boards in the coming week. */
  futureSelections: { localDate: string; boardId: string; garmentIds: string[] }[];
  /** Top/bottom pairs shown on boards in the last fortnight (novelty only; never a reservation). */
  recentlyShown: { localDate: string; topId: string | null; bottomId: string | null; footwearId: string | null }[];
  /** Dated comfort observations relevant to the pool (empty when none were supplied). */
  comfort: ComfortObservation[];
  revisions: { wardrobeRevision: number; styleRevision: number; settingsVersion: number };
  sources: ContextSource[];
}

export function parseScope(scope: string): { base: "home" | "trip"; tripId: string | null; evening: boolean } {
  const parts = scope.split(":");
  if (parts[0] === "home" && (parts.length === 1 || (parts.length === 2 && parts[1] === "evening"))) return { base: "home", tripId: null, evening: parts.length === 2 };
  if (parts[0] === "trip" && parts[1] && (parts.length === 2 || (parts.length === 3 && parts[2] === "evening"))) return { base: "trip", tripId: parts[1], evening: parts.length === 3 };
  throw new Error(`invalid board scope '${scope}'`);
}

export function unknownConditions(segment: "day" | "evening" = "day"): DayConditions {
  return {
    freshness: "unavailable",
    snapshotId: null,
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

/** Deterministic 32-bit hash for seeded, reproducible tie-breaking (never Math.random). */
export function seededUnit(...parts: string[]): number {
  let h = 2166136261;
  for (const ch of parts.join("\u001f")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}
