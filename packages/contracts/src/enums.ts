import { z } from 'zod';

/**
 * Shared vocabulary. Each fact the spec keeps separate (section 5, "Garment identity and
 * lifecycle") has its own enum instead of one overloaded status value.
 */

export const Category = z.enum([
  'shirt',
  'tshirt',
  'polo',
  'knitwear',
  'sweatshirt',
  'trousers',
  'jeans',
  'shorts',
  'blazer',
  'jacket',
  'coat',
  'overshirt',
  'shoes',
  'sneakers',
  'boots',
  'socks',
  'underwear',
  'belt',
  'scarf',
  'hat',
  'gloves',
  'bag',
  'tie',
  'accessory',
  'indoor',
]);
export type Category = z.infer<typeof Category>;

/** Outfit slot roles. A garment can serve several (an overshirt can be a top or an outer layer). */
export const GarmentRole = z.enum([
  'base_top',
  'mid_layer',
  'outer_layer',
  'bottom',
  'one_piece',
  'footwear',
  'socks',
  'belt',
  'accessory',
  'underwear',
  'indoor',
]);
export type GarmentRole = z.infer<typeof GarmentRole>;

/** Acquisition state: an order is not an arrival; disposal is final for planning. */
export const AcquisitionState = z.enum(['incoming', 'owned', 'disposed']);
export type AcquisitionState = z.infer<typeof AcquisitionState>;

/** Planning policy: occasional pieces appear only on explicit request; excluded never. */
export const PlanningPolicy = z.enum(['normal', 'occasional', 'excluded']);
export type PlanningPolicy = z.infer<typeof PlanningPolicy>;

export const GarmentCondition = z.enum(['good', 'worn', 'needs_repair', 'damaged', 'unknown']);
export type GarmentCondition = z.infer<typeof GarmentCondition>;

/** Where the garment (as a whole) is. Per-unit placement lives in stock buckets. */
export const LocationKind = z.enum(['home', 'storage', 'tailor', 'repair', 'trip', 'consignment', 'in_transit', 'unknown']);
export type LocationKind = z.infer<typeof LocationKind>;

/** Care channel that governs which laundry flow a dirty unit follows. */
export const CareChannel = z.enum(['service', 'hand_wash', 'dry_clean', 'none']);
export type CareChannel = z.infer<typeof CareChannel>;

/**
 * What one counted wear does to stock.
 * - per_wear: one wear dirties one unit (shirts, tees, socks)
 * - single_wear_day: one wearing day puts the unit into current use; not available to a later fresh outfit (trousers)
 * - multi_wear: wear does not consume clean stock (knitwear, blazers, coats)
 * - never: never acquires a laundry state (footwear, belts, most accessories)
 */
export const LaundryPolicy = z.enum(['per_wear', 'single_wear_day', 'multi_wear', 'never']);
export type LaundryPolicy = z.infer<typeof LaundryPolicy>;

export const StockTracking = z.enum(['unit', 'anonymous_quantity']);
export type StockTracking = z.infer<typeof StockTracking>;

/**
 * Physical stock buckets. Quantities are journaled and never negative.
 * - clean: ready to wear
 * - worn: in current use after a single-wear-day wear (not claimed to be in a hamper)
 * - hamper: dirty, waiting for its care channel
 * - laundry: inside a collected service batch
 * - storage: seasonal storage
 * - away: at the tailor, repair, on a trip or otherwise out of the house
 * - retired: lost, discarded or reconciled away
 */
export const StockBucket = z.enum(['clean', 'worn', 'hamper', 'laundry', 'storage', 'away', 'retired']);
export type StockBucket = z.infer<typeof StockBucket>;

export const DisposalReason = z.enum(['sold', 'donated', 'discarded', 'returned', 'lost', 'fabricated_entry']);
export type DisposalReason = z.infer<typeof DisposalReason>;

export const RestrictionKind = z.enum(['healing', 'occasional_use', 'repair', 'return_pending', 'for_sale', 'care', 'custom']);
export type RestrictionKind = z.infer<typeof RestrictionKind>;

/** Evidence required before a restriction may be lifted. Elapsed time is never evidence. */
export const RequiredEvidence = z.enum(['owner_statement', 'receipt', 'tailor_return', 'any_owner_command']);
export type RequiredEvidence = z.infer<typeof RequiredEvidence>;

/** Channel through which a command or observation arrived. Metadata only, never identity. */
export const SourceChannel = z.enum(['app', 'web', 'conversation', 'mcp', 'import', 'offline_replay', 'calendar', 'system']);
export type SourceChannel = z.infer<typeof SourceChannel>;

/** Source kind of a dated assertion (section 5, "Evidence and corrections"). */
export const FactSourceKind = z.enum([
  'owner_statement',
  'receipt',
  'maker_spec',
  'photograph',
  'measurement',
  'research',
  'import',
  'model_inference',
]);
export type FactSourceKind = z.infer<typeof FactSourceKind>;

export const AliasKind = z.enum(['owner_phrase', 'maker_name', 'maker_code', 'sku', 'import_ref']);
export type AliasKind = z.infer<typeof AliasKind>;

export const EntityType = z.enum([
  'user',
  'owner_settings',
  'garment',
  'stock_lot',
  'restriction',
  'wear_observation',
  'daily_wear',
  'laundry_batch',
  'laundry_reset',
  'board',
  'selection',
  'lifecycle_project',
  'order_line',
  'style_document',
  'saved_combination',
  'media_asset',
  'service_pause',
]);
export type EntityType = z.infer<typeof EntityType>;

/** Laundry pool for weekly resets: service laundry and hand wash have separate cycles. */
export const LaundryPool = z.enum(['service', 'hand_wash']);
export type LaundryPool = z.infer<typeof LaundryPool>;

export const LaundryExceptionKind = z.enum(['still_away', 'missed_return', 'dirty', 'delay']);
export type LaundryExceptionKind = z.infer<typeof LaundryExceptionKind>;

/** Local calendar date YYYY-MM-DD (a wearing date, board date or cycle date). */
export const LocalDate = z.iso.date();
/** Instant with an explicit offset, stored as UTC ISO-8601. */
export const Instant = z.iso.datetime({ offset: true });
/** IANA timezone name, e.g. Europe/London. Validated structurally; the backend checks Intl support. */
export const TimeZone = z.string().min(1).max(64).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$|^UTC$/);

/** Opaque identifiers are strings with a type prefix, e.g. g_..., cmd_... */
export const OpaqueId = z.string().min(3).max(80).regex(/^[a-z]{1,6}_[A-Za-z0-9_-]+$/);
