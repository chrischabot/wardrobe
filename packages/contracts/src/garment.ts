import { z } from "zod";
import { Basis, GarmentId, Instant, LocalDate, SourceRef, UserId } from "./primitives.ts";

export const Category = z.enum([
  "shirt",
  "knitwear",
  "tee",
  "trousers",
  "outerwear",
  "footwear",
  "socks",
  "belt",
  "tie",
  "scarf",
  "pocket_square",
  "accessory",
  "one_piece",
  "other",
]);
export type Category = z.infer<typeof Category>;

/** Slot a garment can fill in an outfit. */
export const Role = z.enum(["top", "mid_layer", "bottom", "outer", "footwear", "socks", "belt", "neckwear", "accessory", "one_piece"]);
export type Role = z.infer<typeof Role>;

/** Acquisition state. An order is not an arrival: `incoming` stock is never wearable. */
export const Acquisition = z.enum(["incoming", "owned", "disposed"]);
export type Acquisition = z.infer<typeof Acquisition>;

/** Planning policy, independent of condition, location and restrictions. */
export const PlanningPolicy = z.enum(["normal", "occasional", "excluded"]);
export type PlanningPolicy = z.infer<typeof PlanningPolicy>;

/** Care channel. `none` garments (footwear, belts...) can never acquire a laundry state. */
export const CareChannel = z.enum(["service", "handwash", "none"]);
export type CareChannel = z.infer<typeof CareChannel>;

/**
 * Quantity buckets. A garment's owned units are split across these; quantities never go negative.
 * `dirty` means "worn or marked dirty, awaiting care" - it does not claim the unit physically
 * entered a hamper. `service` units are away in a laundry batch (ref = batch id).
 */
export const Bucket = z.enum(["incoming", "clean", "dirty", "service", "storage", "tailor", "trip", "gone"]);
export type Bucket = z.infer<typeof Bucket>;

export const StockBalance = z.object({
  bucket: Bucket,
  ref: z.string().describe("Batch ID for `service`, trip ID for `trip`, otherwise empty."),
  quantity: z.number().int().nonnegative(),
});
export type StockBalance = z.infer<typeof StockBalance>;

export const FootwearKind = z.enum(["sneaker", "welted", "boot", "other"]);

/** Temperature bound with its explicit basis; an unsettled basis stays `unsettled`. */
export const ThermalBound = z.object({
  minC: z.number().optional(),
  maxC: z.number().optional(),
  basis: z.enum(["daytime_peak", "outdoor_interval", "unsettled"]),
  source: z.string().describe("Where the bound came from (import row text, profile passage, owner statement)."),
});
export type ThermalBound = z.infer<typeof ThermalBound>;

export const GarmentAttributes = z
  .object({
    footwearKind: FootwearKind.optional(),
    model: z.string().optional().describe("Product model used by selectors, e.g. '990v4'."),
    fabricClass: z
      .enum(["lightweight_oxford", "heavy_oxford", "cotton_linen", "pure_linen", "flannel", "wool", "denim", "corduroy", "alpaca", "merino", "twill", "other"])
      .optional(),
    indoorOnly: z.boolean().optional(),
    layeringOnly: z.boolean().optional(),
    jacketLike: z.boolean().optional().describe("Counts as a jacket for the 14-16 C layering rule."),
    breakingIn: z.boolean().optional(),
    fitNote: z.string().optional(),
  })
  .catchall(z.unknown());
export type GarmentAttributes = z.infer<typeof GarmentAttributes>;

export const Garment = z.object({
  userId: UserId,
  garmentId: GarmentId,
  version: z.number().int().positive(),
  name: z.string().min(1).describe("Perceptible name the owner recognises at the wardrobe."),
  category: Category,
  roles: z.array(Role).min(1),
  maker: z.string().nullable(),
  product: z.string().nullable().describe("Manufacturer terminology; shown on the item page, not in outfit copy."),
  fabric: z.string().nullable(),
  colour: z.string().nullable(),
  pattern: z.string().nullable(),
  size: z.string().nullable(),
  careChannel: CareChannel,
  acquisition: Acquisition,
  planningPolicy: PlanningPolicy,
  planningReason: z.string().nullable(),
  condition: z.string().nullable(),
  seasonNote: z.string().nullable().describe("Imported season text, preserved verbatim."),
  thermal: ThermalBound.nullable(),
  attributes: GarmentAttributes,
  isSynthetic: z.boolean().describe("True only for labelled synthetic test fixtures."),
  mergedInto: GarmentId.nullable(),
  wearLoggingSince: LocalDate.nullable().describe("Start of reliable wear logging; zero recorded wears means unlogged, never unworn."),
  createdAt: Instant,
  updatedAt: Instant,
});
export type Garment = z.infer<typeof Garment>;

export const GarmentAlias = z.object({
  aliasId: z.string(),
  garmentId: GarmentId,
  phrase: z.string().min(1),
  kind: z.enum(["owner_name", "maker_name", "code", "import", "merged"]),
});
export type GarmentAlias = z.infer<typeof GarmentAlias>;

export const GarmentFact = z.object({
  factId: z.string(),
  garmentId: GarmentId,
  attribute: z.string(),
  value: z.unknown(),
  source: SourceRef,
  scope: z.string().nullable(),
  supersededBy: z.string().nullable(),
  recordedAt: Instant,
});
export type GarmentFact = z.infer<typeof GarmentFact>;

export const RestrictionKind = z.enum(["healing", "tailor", "storage", "trip", "for_sale", "return_pending", "occasional_use", "other"]);
export type RestrictionKind = z.infer<typeof RestrictionKind>;

/** Which garments a restriction covers: named garments and/or a selector evaluated against current records. */
export const RestrictionScope = z.object({
  garmentIds: z.array(GarmentId).optional(),
  /** A garment is covered when it is named in garmentIds or matches ANY clause (all set fields of a clause must match). */
  anyOf: z
    .array(
      z.object({
        category: Category.optional(),
        footwearKinds: z.array(FootwearKind).optional(),
        models: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type RestrictionScope = z.infer<typeof RestrictionScope>;

export const Restriction = z.object({
  restrictionId: z.string(),
  kind: RestrictionKind,
  scope: RestrictionScope,
  reason: z.string(),
  startsAt: Instant,
  expectedEnd: Instant.nullable().describe("A prediction only: an expected end never lifts the restriction."),
  requiredEvidence: z.enum(["owner_statement", "owner_observation", "receipt"]),
  status: z.enum(["active", "resolved"]),
  resolvedAt: Instant.nullable(),
  source: SourceRef,
});
export type Restriction = z.infer<typeof Restriction>;

export const WearObservation = z.object({
  observationId: z.string(),
  garmentId: GarmentId,
  wearingDate: LocalDate,
  occurredAt: Instant,
  reportedAt: Instant,
  timezone: z.string(),
  channel: z.string(),
  segment: z.string().nullable(),
  status: z.enum(["active", "retracted"]),
  commandId: z.string(),
});
export type WearObservation = z.infer<typeof WearObservation>;

/** The counted wear: at most one per (user, garment, wearing date). */
export const DailyWear = z.object({
  garmentId: GarmentId,
  wearingDate: LocalDate,
  observationCount: z.number().int().positive(),
  status: z.enum(["active", "retracted"]),
});
export type DailyWear = z.infer<typeof DailyWear>;

export const StockMovement = z.object({
  eventId: z.string(),
  kind: z.string(),
  from: Bucket.nullable(),
  to: Bucket.nullable(),
  quantity: z.number().int().nonnegative(),
  basis: Basis,
  occurredAt: Instant,
  note: z.string().nullable(),
});
export type StockMovement = z.infer<typeof StockMovement>;
