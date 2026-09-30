import { z } from 'zod';
import {
  Instant,
  LaundryExceptionKind,
  LaundryPool,
  LocalDate,
  OpaqueId,
  RequiredEvidence,
  RestrictionKind,
  SourceChannel,
  StockBucket,
  TimeZone,
  GarmentRole,
  Category,
} from './enums.js';

/** Materialized stock balance of one garment (sum over its lots). */
export const StockBalance = z.object({
  garmentId: OpaqueId,
  buckets: z.record(StockBucket, z.number().int().nonnegative()),
  /** Units physically owned (every bucket except retired). */
  totalOwned: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});
export type StockBalance = z.infer<typeof StockBalance>;

export const RestrictionScope = z
  .strictObject({
    garmentIds: z.array(OpaqueId).max(200).optional(),
    categories: z.array(Category).max(30).optional(),
    roles: z.array(GarmentRole).max(20).optional(),
    /**
     * Attribute selector, e.g. { construction: 'welted', model: '990v6' }. A garment matches when ANY
     * listed attribute equals its value. The whole scope is also a union: a garment is restricted when
     * it matches any of garmentIds, categories, roles or attributes.
     */
    attributes: z.record(z.string().max(40), z.string().max(80)).optional(),
  })
  .refine(
    (s) => Boolean(s.garmentIds?.length || s.categories?.length || s.roles?.length || (s.attributes && Object.keys(s.attributes).length)),
    { message: 'A restriction scope must name garments, categories, roles or attributes' },
  );
export type RestrictionScope = z.infer<typeof RestrictionScope>;

export const Restriction = z.object({
  restrictionId: OpaqueId,
  kind: RestrictionKind,
  scope: RestrictionScope,
  reason: z.string().max(1000),
  startsAt: Instant,
  /** Expected end is informational; it never lifts the restriction by itself. */
  expectedEnd: LocalDate.nullable(),
  requiredEvidence: RequiredEvidence,
  liftedAt: Instant.nullable(),
  liftEvidence: z.string().max(1000).nullable(),
  version: z.number().int().positive(),
});
export type Restriction = z.infer<typeof Restriction>;

export const WearItem = z.strictObject({
  garmentId: OpaqueId,
  role: GarmentRole.optional(),
  /**
   * Explicit report of changing into another clean unit of an anonymous-quantity garment
   * (e.g. a fresh pair of the same socks). Moves one more unit without another counted wear.
   */
  freshUnit: z.boolean().optional(),
});
export type WearItem = z.infer<typeof WearItem>;

export const WearObservation = z.object({
  observationId: OpaqueId,
  wearingDate: LocalDate,
  timezone: TimeZone,
  occurredAt: Instant,
  reportedAt: Instant,
  source: SourceChannel,
  sourceRef: z.string().max(500).nullable(),
  segment: z.string().max(40).nullable(),
  items: z.array(WearItem),
  status: z.enum(['active', 'superseded', 'retracted']),
  revision: z.number().int().positive(),
  supersedesObservationId: OpaqueId.nullable(),
  version: z.number().int().positive(),
});
export type WearObservation = z.infer<typeof WearObservation>;

/** The counted wear: one per (user, garment, wearing date). */
export const DailyWear = z.object({
  garmentId: OpaqueId,
  wearingDate: LocalDate,
  timezone: TimeZone,
  firstOccurredAt: Instant,
  observationCount: z.number().int().nonnegative(),
  sources: z.array(SourceChannel),
  segments: z.array(z.string()),
  status: z.enum(['active', 'retracted']),
  revision: z.number().int().positive(),
});
export type DailyWear = z.infer<typeof DailyWear>;

export const LaundryBatchItem = z.object({
  garmentId: OpaqueId,
  lotId: OpaqueId,
  quantity: z.number().int().positive(),
  returnedQuantity: z.number().int().nonnegative(),
  status: z.enum(['away', 'returned', 'missing']),
});
export type LaundryBatchItem = z.infer<typeof LaundryBatchItem>;

export const LaundryBatch = z.object({
  batchId: OpaqueId,
  channel: z.literal('service'),
  status: z.enum(['collected', 'partially_returned', 'returned', 'voided']),
  collectedAt: Instant,
  returnedAt: Instant.nullable(),
  items: z.array(LaundryBatchItem),
  version: z.number().int().positive(),
});
export type LaundryBatch = z.infer<typeof LaundryBatch>;

export const LaundryException = z.object({
  exceptionId: OpaqueId,
  garmentId: OpaqueId,
  kind: LaundryExceptionKind,
  quantity: z.number().int().positive(),
  batchId: OpaqueId.nullable(),
  occurredAt: Instant,
  clearedAt: Instant.nullable(),
});
export type LaundryException = z.infer<typeof LaundryException>;

/**
 * Weekly laundry routine in local time. Initial routine (section 5): service collection on
 * Friday, return on Saturday, clean planning baseline on Sunday. Editable settings.
 * Days use 0 = Sunday ... 6 = Saturday.
 */
export const LaundryRoutine = z.strictObject({
  service: z.strictObject({
    collectDow: z.number().int().min(0).max(6),
    collectTime: z.string().regex(/^\d{2}:\d{2}$/),
    returnDow: z.number().int().min(0).max(6),
    baselineDow: z.number().int().min(0).max(6),
    baselineTime: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  handWash: z.strictObject({
    /** Hand-wash socks have their own cycle; null disables the routine reset for that pool. */
    baselineDow: z.number().int().min(0).max(6).nullable(),
    baselineTime: z.string().regex(/^\d{2}:\d{2}$/),
  }),
});
export type LaundryRoutine = z.infer<typeof LaundryRoutine>;

export const DEFAULT_LAUNDRY_ROUTINE: LaundryRoutine = {
  service: { collectDow: 5, collectTime: '09:00', returnDow: 6, baselineDow: 0, baselineTime: '00:00' },
  handWash: { baselineDow: 0, baselineTime: '00:00' },
};

export const LaundryReset = z.object({
  pool: LaundryPool,
  cycleKey: LocalDate,
  /** Dirty states that occurred before this instant participate in the reset. */
  cutoffAt: Instant,
  /** The reset's clean baseline applies from this instant. */
  effectiveAt: Instant,
  appliedAt: Instant,
});
export type LaundryReset = z.infer<typeof LaundryReset>;
