import { z } from "zod";
import { GarmentId, Instant, LocalDate } from "./primitives.ts";
import { Acquisition, Bucket, PlanningPolicy } from "./garment.ts";

/**
 * Why a garment is or is not offerable. Hard reasons exclude the garment until an owner
 * observation or an applicable authorized event changes the fact; uncertainty alone never does.
 */
export const AvailabilityReason = z.enum([
  "not_owned_yet", // incoming: ordered, arrival not established
  "disposed",
  "merged",
  "no_units_at_home", // nothing clean at home (all dirty / in service / away)
  "restricted", // active restriction (healing, tailor, storage, trip, for sale...)
  "in_storage",
  "at_tailor",
  "on_trip",
  "planning_excluded",
  "planning_occasional",
  "indoor_only",
  "observed_dirty",
  "in_service_batch",
  "laundry_exception",
  "estimated_possibly_worn", // soft: probabilistic, never a hard exclusion
  "import_cleanliness_unverified", // soft
]);
export type AvailabilityReason = z.infer<typeof AvailabilityReason>;

export const AvailabilityStatus = z.enum([
  "available", // at least one unit observed clean at home, no material uncertainty
  "estimated", // offerable, with probabilistic uncertainty recorded
  "conditional", // offerable only on explicit request (occasional, indoor-only)
  "unavailable", // hard exclusion
]);
export type AvailabilityStatus = z.infer<typeof AvailabilityStatus>;

export const GarmentAvailability = z.object({
  garmentId: GarmentId,
  status: AvailabilityStatus,
  hardExcluded: z.boolean(),
  /** Probability that at least one clean unit is at home for a fresh wear on `forDate`. */
  pAvailable: z.number().min(0).max(1),
  /** Probability the garment was worn without a report, per local date since the last baseline. */
  inferredWear: z.array(z.object({ localDate: LocalDate, probability: z.number().min(0).max(1) })),
  reasons: z.array(AvailabilityReason),
  restrictionIds: z.array(z.string()),
  acquisition: Acquisition,
  planningPolicy: PlanningPolicy,
  balances: z.array(z.object({ bucket: Bucket, ref: z.string(), quantity: z.number().int().nonnegative() })),
  cleanObserved: z.number().int().nonnegative(),
  basis: z.array(z.string()).describe("Concise, human-readable basis lines; shown in availability detail only."),
});
export type GarmentAvailability = z.infer<typeof GarmentAvailability>;

export const AvailabilitySnapshot = z.object({
  modelVersion: z.string(),
  forDate: LocalDate,
  computedAt: Instant,
  wardrobeRevision: z.number().int().nonnegative(),
  parameters: z.object({
    pUseBoard: z.number(),
    pFollowSelection: z.number(),
    parameterStatus: z.literal("hypothesis").describe("Initial parameters are hypotheses, not calibrated accuracy."),
  }),
  lastBaseline: z
    .object({ cycleKey: LocalDate, cutoffAt: Instant })
    .nullable()
    .describe("Most recent applied weekly service-laundry baseline."),
  garments: z.array(GarmentAvailability),
});
export type AvailabilitySnapshot = z.infer<typeof AvailabilitySnapshot>;

/** One published set of mutually exclusive outfit options whose wear is not yet observed. */
export const ExposureOption = z.object({
  optionId: z.string(),
  /** Garments certain to be worn if this option is worn. */
  garmentIds: z.array(GarmentId),
  /** Alternatives sharing the option's probability (e.g. two footwear choices). */
  alternativeGroups: z.array(z.array(GarmentId).min(2)).default([]),
});
export type ExposureOption = z.infer<typeof ExposureOption>;

export const JointAvailability = z.object({
  garmentIds: z.array(GarmentId),
  pAllAvailable: z.number().min(0).max(1),
  hardExcluded: z.array(GarmentId),
  modelVersion: z.string(),
});
export type JointAvailability = z.infer<typeof JointAvailability>;
