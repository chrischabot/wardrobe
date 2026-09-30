import { z } from 'zod';
import { Instant, LocalDate, OpaqueId } from './enums.js';
import { ESTIMATOR_VERSION } from './version.js';

/**
 * Availability estimator contract (spec section 5, "Probability without status interrogation").
 * Parameters are initial hypotheses, not calibrated accuracy; the selection prior may only be
 * learned from observed choices.
 */
export const EstimatorParameters = z.strictObject({
  version: z.literal(ESTIMATOR_VERSION),
  /** Probability that the owner uses an unselected board at all (vs. an unreported other outfit or no wear). */
  boardUseProbability: z.number().min(0).max(1),
  /** Probability of using a board once an option has been selected. */
  selectedBoardUseProbability: z.number().min(0).max(1),
  /** Share of the selection probability given to the selected option; the rest spreads over the others. */
  selectedOptionProbability: z.number().min(0).max(1),
  /** Minimum estimated probability of clean stock for a garment to be considered likely available. */
  likelyAvailableThreshold: z.number().min(0).max(1),
});
export type EstimatorParameters = z.infer<typeof EstimatorParameters>;

export const DEFAULT_ESTIMATOR_PARAMETERS: EstimatorParameters = {
  version: ESTIMATOR_VERSION,
  boardUseProbability: 0.7,
  selectedBoardUseProbability: 0.9,
  selectedOptionProbability: 0.85,
  likelyAvailableThreshold: 0.5,
};

export const EstimateBasis = z.object({
  kind: z.enum([
    'physical_clean',
    'weekly_reset',
    'owner_exception',
    'board_probability',
    'selection',
    'recorded_wear',
    'hard_exclusion',
    'not_laundered',
  ]),
  detail: z.string(),
  quantity: z.number().optional(),
  probability: z.number().optional(),
  boardDate: LocalDate.optional(),
  resetCycle: LocalDate.optional(),
});
export type EstimateBasis = z.infer<typeof EstimateBasis>;

export const AvailabilityEstimate = z.object({
  estimatorVersion: z.literal(ESTIMATOR_VERSION),
  garmentId: OpaqueId,
  asOf: Instant,
  targetDate: LocalDate,
  /** Hard eligibility (ownership, location, restrictions, planning policy). */
  eligible: z.boolean(),
  exclusionReasons: z.array(z.string()),
  /** Units believed clean at the start of the estimate (physical clean + reset-cleared). */
  estimatedCleanUnits: z.number().nonnegative(),
  /** Expected units consumed by probable but unrecorded wears before the target date. */
  expectedInferredWears: z.number().nonnegative(),
  /** Probability that at least one clean unit remains on the target date. */
  probabilityAvailable: z.number().min(0).max(1),
  likelyAvailable: z.boolean(),
  basis: z.array(EstimateBasis),
});
export type AvailabilityEstimate = z.infer<typeof AvailabilityEstimate>;
