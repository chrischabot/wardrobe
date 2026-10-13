// Fit arithmetic. Body circumference, garment circumference and flat half
// (pit-to-pit) measurements are distinct types; units are normalized before
// any ease is computed. A verdict is always returned with its numbers and its
// specific uncertainties, never as a bare size label.

export type LengthUnit = "in" | "cm";
export type MeasurementKind = "body_circumference" | "garment_circumference" | "flat_half" | "linear";

export interface Measurement<K extends MeasurementKind = MeasurementKind> {
  kind: K;
  value: number;
  unit: LengthUnit;
  /** ISO date (YYYY-MM-DD) the measurement was taken, when known. */
  measuredOn?: string;
}
export type BodyCircumference = Measurement<"body_circumference">;
export type GarmentCircumference = Measurement<"garment_circumference">;
export type FlatHalf = Measurement<"flat_half">;
/** Straight-line measurement (shoulder width, length, sleeve). */
export type Linear = Measurement<"linear">;

export const CM_PER_IN = 2.54;
export const toCm = (value: number, unit: LengthUnit): number => (unit === "cm" ? value : value * CM_PER_IN);
export const toIn = (value: number, unit: LengthUnit): number => (unit === "in" ? value : value / CM_PER_IN);
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface EaseComputation {
  bodyCm: number;
  bodyIn: number;
  garmentCircumferenceCm: number;
  garmentCircumferenceIn: number;
  easeCm: number;
  easeIn: number;
  /** True when the garment figure was a flat half measurement and was doubled. */
  doubledFlatHalf: boolean;
}

/** Garment circumference minus body circumference, in both units (rounded to 2 dp). */
export function computeEase(input: { body: BodyCircumference; garment: GarmentCircumference | FlatHalf }): EaseComputation {
  const doubledFlatHalf = input.garment.kind === "flat_half";
  const bodyCm = toCm(input.body.value, input.body.unit);
  const garmentCm = toCm(input.garment.value, input.garment.unit) * (doubledFlatHalf ? 2 : 1);
  const easeCm = garmentCm - bodyCm;
  return {
    bodyCm: round2(bodyCm),
    bodyIn: round2(bodyCm / CM_PER_IN),
    garmentCircumferenceCm: round2(garmentCm),
    garmentCircumferenceIn: round2(garmentCm / CM_PER_IN),
    easeCm: round2(easeCm),
    easeIn: round2(easeCm / CM_PER_IN),
    doubledFlatHalf,
  };
}

export type FitDimension = "chest" | "shoulder" | "waist" | "length" | "sleeve";
export const FIT_DIMENSIONS: readonly FitDimension[] = ["chest", "shoulder", "waist", "length", "sleeve"];
export interface EaseRange { minIn: number; maxIn: number }
export type EaseRanges = Record<FitDimension, EaseRange>;

/**
 * DEFAULT desired ranges (garment minus body/reference, in inches) for a
 * shirt-like garment. These are defaults only and are overridable per call
 * through `FitInput.easeRanges`; a jacket, knit or overcoat needs its own.
 */
export const DEFAULT_EASE_RANGES: EaseRanges = {
  chest: { minIn: 2, maxIn: 4 },
  waist: { minIn: 2, maxIn: 5 },
  shoulder: { minIn: 0, maxIn: 1 },
  length: { minIn: -1, maxIn: 1 },
  sleeve: { minIn: -0.5, maxIn: 0.5 },
};
/** DEFAULT reduction of the minimum circumference ease for stretch cloth (overridable via `stretchAllowanceIn`). */
export const DEFAULT_STRETCH_ALLOWANCE_IN = { none: 0, some: 0.5, high: 1 } as const;
export const DEFAULT_MAX_BODY_AGE_DAYS = 365;
/** DEFAULT band (inches) around a range bound inside which a changed body measurement would flip the verdict. */
export const DEFAULT_STALE_TOLERANCE_IN = 1;

export type Stretch = keyof typeof DEFAULT_STRETCH_ALLOWANCE_IN;

export interface FitInput {
  /** Maker's size label; never decisive on its own. */
  sizeLabel?: string;
  chest?: { body?: BodyCircumference; garment?: GarmentCircumference | FlatHalf };
  waist?: { body?: BodyCircumference; garment?: GarmentCircumference | FlatHalf };
  /** `body` is the wearer's own or preferred reference measurement. */
  shoulder?: { body?: Linear; garment?: Linear };
  length?: { body?: Linear; garment?: Linear };
  sleeve?: { body?: Linear; garment?: Linear };
  cut?: string;
  stretch?: Stretch;
  /** Extra room wanted over the default range for layers worn underneath. */
  layering?: { description: string; extraEaseIn: number };
  easeRanges?: Partial<EaseRanges>;
  stretchAllowanceIn?: number;
  /** Dimensions without which no verdict is given. Default: chest. */
  decisive?: FitDimension[];
  /** ISO date the assessment is made on; used only to age body measurements. */
  asOf: string;
  maxAgeDays?: number;
  staleToleranceIn?: number;
}

export interface DimensionAssessment {
  dimension: FitDimension;
  status: "computed" | "missing";
  missing: ("body" | "garment")[];
  bodyIn: number | null;
  garmentIn: number | null;
  differenceIn: number | null;
  differenceCm: number | null;
  desiredRangeIn: EaseRange;
  outcome: "within" | "tight" | "loose" | null;
  bodyMeasurementAgeDays: number | null;
  staleBodyMeasurement: boolean;
}

export type FitVerdict = "likely_fits" | "likely_tight" | "likely_loose" | "cannot_determine";
export interface FitAssessment {
  verdict: FitVerdict;
  /** Why the verdict is what it is, in one sentence. */
  reason: string;
  sizeLabel: string | null;
  computation: Record<FitDimension, DimensionAssessment>;
  staleBodyMeasurement: boolean;
  uncertainties: string[];
  notes: string[];
}

const DAY_MS = 86_400_000;
function ageDays(measuredOn: string | undefined, asOf: string): number | null {
  if (!measuredOn) return null;
  const from = Date.parse(measuredOn);
  const to = Date.parse(asOf);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / DAY_MS);
}

export function assessFit(input: FitInput): FitAssessment {
  const maxAge = input.maxAgeDays ?? DEFAULT_MAX_BODY_AGE_DAYS;
  const tolerance = input.staleToleranceIn ?? DEFAULT_STALE_TOLERANCE_IN;
  const stretch = input.stretch ?? "none";
  const stretchAllowance = input.stretchAllowanceIn ?? DEFAULT_STRETCH_ALLOWANCE_IN[stretch];
  const layerExtra = input.layering?.extraEaseIn ?? 0;
  const decisive = input.decisive ?? ["chest"];
  const uncertainties: string[] = [];
  const notes: string[] = [];
  const computation = {} as Record<FitDimension, DimensionAssessment>;

  for (const dimension of FIT_DIMENSIONS) {
    const pair = input[dimension];
    const base = input.easeRanges?.[dimension] ?? DEFAULT_EASE_RANGES[dimension];
    const circumference = dimension === "chest" || dimension === "waist";
    // Stretch and layering only change how much room is wanted around the body.
    const range: EaseRange = circumference
      ? { minIn: base.minIn - stretchAllowance + layerExtra, maxIn: base.maxIn + layerExtra }
      : { ...base };
    const missing: ("body" | "garment")[] = [];
    if (!pair?.body) missing.push("body");
    if (!pair?.garment) missing.push("garment");
    const result: DimensionAssessment = {
      dimension, status: "missing", missing, bodyIn: null, garmentIn: null, differenceIn: null,
      differenceCm: null, desiredRangeIn: range, outcome: null, bodyMeasurementAgeDays: null,
      staleBodyMeasurement: false,
    };
    computation[dimension] = result;
    if (pair?.body) result.bodyIn = round2(toIn(pair.body.value, pair.body.unit));
    if (pair?.garment) {
      const factor = pair.garment.kind === "flat_half" ? 2 : 1;
      result.garmentIn = round2(toIn(pair.garment.value, pair.garment.unit) * factor);
    }
    if (!pair?.body || !pair.garment) {
      const role = decisive.includes(dimension) ? "decisive " : "";
      uncertainties.push(`${dimension}: ${role}${missing.join(" and ")} measurement missing; not assessed.`);
      continue;
    }
    const factor = pair.garment.kind === "flat_half" ? 2 : 1;
    const diffCm = toCm(pair.garment.value, pair.garment.unit) * factor - toCm(pair.body.value, pair.body.unit);
    // Compare the same rounded figure that is reported, so the verdict always matches the numbers shown.
    const diffIn = round2(diffCm / CM_PER_IN);
    result.status = "computed";
    result.differenceCm = round2(diffCm);
    result.differenceIn = diffIn;
    result.outcome = diffIn < range.minIn ? "tight" : diffIn > range.maxIn ? "loose" : "within";
    const age = ageDays(pair.body.measuredOn, input.asOf);
    result.bodyMeasurementAgeDays = age;
    const nearBound = Math.abs(diffIn - range.minIn) <= tolerance || Math.abs(diffIn - range.maxIn) <= tolerance;
    if (age === null) {
      if (nearBound) uncertainties.push(`${dimension}: body measurement date unknown and the ease is within ${tolerance} in of a limit.`);
    } else if (age > maxAge && nearBound) {
      result.staleBodyMeasurement = true;
      uncertainties.push(`${dimension}: body measurement is ${age} days old and the ease (${result.differenceIn} in) is within ${tolerance} in of a limit; re-measuring could change the verdict.`);
    }
  }

  if (input.cut) notes.push(`Cut: ${input.cut}. Cut changes how the same ease wears and is not captured by the numbers.`);
  if (stretch !== "none") notes.push(`Stretch (${stretch}): minimum circumference ease lowered by ${stretchAllowance} in.`);
  if (input.layering) notes.push(`Layering (${input.layering.description}): circumference range raised by ${layerExtra} in.`);

  const all = FIT_DIMENSIONS.map((d) => computation[d]);
  const computed = all.filter((d) => d.status === "computed");
  const label = input.sizeLabel ?? null;
  const anyGarment = all.some((d) => d.garmentIn !== null);
  const missingDecisive = decisive.filter((d) => computation[d].status === "missing");
  let verdict: FitVerdict;
  let reason: string;
  if (!anyGarment) {
    verdict = "cannot_determine";
    reason = label
      ? `Size label "${label}" alone decides nothing: maker size labels are not interchangeable and no garment measurements are known.`
      : "No garment measurements are known.";
    if (label) uncertainties.push(reason);
  } else if (missingDecisive.length > 0) {
    verdict = "cannot_determine";
    reason = `Decisive measurement missing: ${missingDecisive.join(", ")}.`;
  } else {
    const tight = computed.filter((d) => d.outcome === "tight").map((d) => d.dimension);
    const loose = computed.filter((d) => d.outcome === "loose").map((d) => d.dimension);
    verdict = tight.length > 0 ? "likely_tight" : loose.length > 0 ? "likely_loose" : "likely_fits";
    reason = tight.length > 0 ? `Below the desired range in: ${tight.join(", ")}.`
      : loose.length > 0 ? `Above the desired range in: ${loose.join(", ")}.`
      : `Within the desired range in: ${computed.map((d) => d.dimension).join(", ")}.`;
    if (tight.length > 0 && loose.length > 0) uncertainties.push(`Mixed result: tight in ${tight.join(", ")} but loose in ${loose.join(", ")}.`);
  }
  return { verdict, reason, sizeLabel: label, computation, staleBodyMeasurement: all.some((d) => d.staleBodyMeasurement), uncertainties, notes };
}
