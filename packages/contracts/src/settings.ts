import { z } from "zod";
import { IanaTimezone } from "./primitives.ts";

/** Weekday numbers follow ISO-8601: 1 = Monday ... 7 = Sunday. */
export const IsoWeekday = z.number().int().min(1).max(7);
export const LocalTime = z.string().regex(/^\d{2}:\d{2}$/, "expected HH:MM");

export const ServiceLaundrySettings = z.object({
  /** Standing owner authorization for the inferred weekly cleanliness reset. */
  weeklyResetEnabled: z.boolean(),
  collectionWeekday: IsoWeekday,
  collectionLocalTime: LocalTime,
  returnWeekday: IsoWeekday,
  baselineWeekday: IsoWeekday,
});

export const HandwashSettings = z.object({
  /**
   * `owner_reported`: hand-wash quantities return only through an owner "washed" report.
   * `inferred_weekly`: an owner-enabled inferred reset on `baselineWeekday`, tracked as its own cycle.
   */
  mode: z.enum(["owner_reported", "inferred_weekly"]),
  baselineWeekday: IsoWeekday.optional(),
});

export const EstimatorSettings = z.object({
  /** Probability the owner dresses from an unselected board at all. Hypothesis, not a calibrated value. */
  pUseBoard: z.number().min(0).max(1),
  /** Probability a selected option is what was actually worn. Hypothesis. */
  pFollowSelection: z.number().min(0).max(1),
  /** Probability mass kept for "clean" when imported cleanliness was never observed. Hypothesis. */
  importCleanPrior: z.number().min(0).max(1),
});

export const OwnerSettings = z.object({
  timezone: IanaTimezone,
  homeLocation: z
    .object({ label: z.string(), latitude: z.number().optional(), longitude: z.number().optional() })
    .nullable(),
  delivery: z.object({
    /** Local time the prepared board is presented. */
    morningLocalTime: LocalTime,
    defaultOptionCount: z.number().int().min(3).max(5),
  }),
  laundry: z.object({ service: ServiceLaundrySettings, handwash: HandwashSettings }),
  variety: z.object({
    repeatHorizonDays: z.number().int().positive(),
    patternHorizonDays: z.number().int().positive(),
  }),
  estimator: EstimatorSettings,
  /** Open extension area: each workstream namespaces its own settings under its key. */
  extensions: z.record(z.string(), z.unknown()),
});
export type OwnerSettings = z.infer<typeof OwnerSettings>;

/**
 * Defaults from the specification: Europe/London, 7 AM, five options, Friday collection,
 * Saturday return, Sunday planning baseline, seven-day repeat and fourteen-day pattern horizons.
 * All are editable settings. Estimator parameters are documented hypotheses.
 */
export const DEFAULT_OWNER_SETTINGS: OwnerSettings = {
  timezone: "Europe/London",
  homeLocation: null,
  delivery: { morningLocalTime: "07:00", defaultOptionCount: 5 },
  laundry: {
    service: {
      weeklyResetEnabled: true,
      collectionWeekday: 5,
      collectionLocalTime: "08:00",
      returnWeekday: 6,
      baselineWeekday: 7,
    },
    handwash: { mode: "owner_reported" },
  },
  variety: { repeatHorizonDays: 7, patternHorizonDays: 14 },
  estimator: { pUseBoard: 0.85, pFollowSelection: 0.9, importCleanPrior: 0.8 },
  extensions: {},
};
