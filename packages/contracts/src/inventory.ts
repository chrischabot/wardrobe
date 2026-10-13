import { z } from "zod";
import { Instant, LocalDate } from "./primitives.ts";
import { DailyWear, Garment, GarmentAlias, GarmentFact, Restriction, StockBalance, StockMovement, WearObservation } from "./garment.ts";
import { GarmentAvailability } from "./availability.ts";
import { Measurement } from "./style.ts";

/** A garment with everything the item page needs from the ledger. */
export const GarmentDetail = z.object({
  garment: Garment,
  aliases: z.array(GarmentAlias),
  facts: z.array(GarmentFact),
  balances: z.array(StockBalance),
  totalOwnedUnits: z.number().int().nonnegative(),
  restrictions: z.array(Restriction),
  recordedWearCount: z.number().int().nonnegative(),
  lastRecordedWear: LocalDate.nullable(),
  /** Wear counts start at the beginning of reliable logging: zero means unlogged, never unworn. */
  wearCountCaveat: z.string(),
  recentWears: z.array(DailyWear),
  movements: z.array(StockMovement),
  /** Current measurements stored for this garment. An empty list means none are recorded, which stays visible. */
  measurements: z.array(Measurement).optional(),
});
export type GarmentDetail = z.infer<typeof GarmentDetail>;

export const InventoryItem = z.object({
  garment: Garment,
  aliases: z.array(z.string()),
  balances: z.array(StockBalance),
  totalOwnedUnits: z.number().int().nonnegative(),
  availability: GarmentAvailability.nullable(),
  recordedWearCount: z.number().int().nonnegative(),
  lastRecordedWear: LocalDate.nullable(),
});
export type InventoryItem = z.infer<typeof InventoryItem>;

/**
 * Inventory page or complete snapshot. `complete` and `total` are always explicit so a
 * consumer can never mistake one page for the whole wardrobe.
 */
export const InventoryPage = z.object({
  items: z.array(InventoryItem),
  total: z.number().int().nonnegative(),
  complete: z.boolean(),
  nextCursor: z.string().nullable(),
  counts: z.object({
    owned: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    incoming: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative(),
  }),
  wardrobeRevision: z.number().int().nonnegative(),
  readAt: Instant,
});
export type InventoryPage = z.infer<typeof InventoryPage>;

export const InventoryQuery = z.object({
  search: z.string().optional().describe("Matches names, aliases, maker names and codes."),
  category: z.string().optional(),
  acquisition: z.enum(["incoming", "owned", "disposed"]).optional(),
  availability: z.enum(["available", "estimated", "conditional", "unavailable"]).optional(),
  colour: z.string().optional(),
  location: z.enum(["home", "storage", "tailor", "trip", "service"]).optional(),
  includeDisposed: z.boolean().default(false),
  limit: z.number().int().positive().max(500).optional().describe("Omit for a complete snapshot."),
  cursor: z.string().optional(),
  forDate: LocalDate.optional(),
});
export type InventoryQuery = z.input<typeof InventoryQuery>;

/** The garments a selector currently matches: what a bulk edit would touch, read before it is confirmed. */
export const GarmentSelection = z.object({
  garments: z.array(z.object({ garmentId: z.string(), version: z.number().int().positive(), name: z.string(), category: z.string() })),
  count: z.number().int().nonnegative(),
  wardrobeRevision: z.number().int().nonnegative(),
});
export type GarmentSelection = z.infer<typeof GarmentSelection>;

/** A day's record: what was actually worn, grouped from observations. */
export const DailyRecord = z.object({
  wearingDate: LocalDate,
  garments: z.array(z.object({ garmentId: z.string(), name: z.string(), segments: z.array(z.string()), observationCount: z.number().int() })),
  observations: z.array(WearObservation),
});
export type DailyRecord = z.infer<typeof DailyRecord>;

/** Result of resolving a phrase to garments. More than one match must be disambiguated, never guessed. */
export const AliasResolution = z.object({
  phrase: z.string(),
  matches: z.array(z.object({ garmentId: z.string(), name: z.string(), matchedOn: z.string(), distinguishing: z.string() })),
  ambiguous: z.boolean(),
});
export type AliasResolution = z.infer<typeof AliasResolution>;
