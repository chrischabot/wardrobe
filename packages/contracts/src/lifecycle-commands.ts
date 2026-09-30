import { z } from 'zod';
import { Instant, LocalDate, OpaqueId, TimeZone } from './enums.js';

/**
 * Intake and lifecycle commands (spec sections 5, 8 and 10), added by the assistant/integrations
 * workstream. They run through the same CommandService as every other mutation: owner from the
 * principal, idempotency key, one D1 batch, a stored receipt.
 *
 * Boundaries encoded here:
 * - An order is not an arrival. import_order and record_order_event never create garments or stock;
 *   arrival stays the separate mark_arrived observation.
 * - Stable external identities (merchant + order number + external line id) deduplicate repeated
 *   emails; a remake links to its original line instead of doubling ownership.
 * - A return or exchange deadline needs its source terms (URL or message reference plus the quoted
 *   passage) and a real trigger date. No deadline is derived from a generic shop policy.
 * - Comfort feedback is scoped to what is known; only an explicit owner instruction (quoted) becomes a
 *   standing direction, and it is scoped to the garment and activity it names.
 * - For sale, sold and gone are distinct lifecycle states. Only physical departure retires stock.
 */

const Merchant = z.string().min(1).max(120);
const OrderNumber = z.string().min(1).max(120);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const MinorAmount = z.number().int().nonnegative().max(100_000_000);

export const OrderLineInput = z.strictObject({
  /** Merchant's own line identity (SKU + size + position, or the line number in the email). */
  externalLineId: z.string().min(1).max(160),
  description: z.string().min(1).max(300),
  /** Normalized specification: productCode, fabricCode, size, fit, colour, ... */
  spec: z.record(z.string().max(40), z.string().max(200)).optional(),
  quantity: z.number().int().positive().max(50),
  unitPriceMinor: MinorAmount,
  /** A predicted date is not a receipt. */
  arrivalEstimate: LocalDate.optional(),
  /** Link to an existing (usually incoming) garment. Never creates one. */
  garmentId: OpaqueId.optional(),
  /** A remake or replacement links to its original line of the same order. */
  remakeOfExternalLineId: z.string().min(1).max(160).optional(),
});
export type OrderLineInput = z.infer<typeof OrderLineInput>;

export const ImportOrderCommand = z.strictObject({
  type: z.literal('import_order'),
  merchant: Merchant,
  merchantOrderNumber: OrderNumber,
  orderedAt: Instant,
  currency: Currency,
  /** Source reference, e.g. gmail:<messageId>. Required: an order without evidence is not imported. */
  sourceRef: z.string().min(3).max(500),
  lines: z.array(OrderLineInput).min(1).max(50),
});

export const OrderEventKind = z.enum(['dispatched', 'cancelled', 'refunded', 'return_requested', 'return_posted', 'return_received', 'exchange_requested']);
export type OrderEventKind = z.infer<typeof OrderEventKind>;

export const RecordOrderEventCommand = z.strictObject({
  type: z.literal('record_order_event'),
  merchant: Merchant,
  merchantOrderNumber: OrderNumber,
  event: OrderEventKind,
  /** Lines the event concerns; default is every line of the order. */
  externalLineIds: z.array(z.string().min(1).max(160)).max(50).optional(),
  arrivalEstimate: LocalDate.optional(),
  refundMinor: MinorAmount.optional(),
  occurredAt: Instant.optional(),
  sourceRef: z.string().min(3).max(500),
});

export const ReturnDeadlineKind = z.enum(['request', 'post', 'retailer_receipt']);

export const RecordReturnTermsCommand = z.strictObject({
  type: z.literal('record_return_terms'),
  lineId: OpaqueId,
  kind: ReturnDeadlineKind,
  /** The purchase terms actually checked. The quote must contain the window it states. */
  terms: z.strictObject({
    sourceRef: z.string().min(3).max(500),
    quote: z.string().min(12).max(2000),
    checkedAt: Instant,
    windowDays: z.number().int().positive().max(365),
  }),
  /** The triggering event and its real date (delivery, order or dispatch), with its evidence. */
  trigger: z.strictObject({
    event: z.enum(['delivery', 'order', 'dispatch']),
    date: LocalDate,
    evidence: z.string().min(3).max(500),
  }),
  timezone: TimeZone,
});

export const RecordComfortFeedbackCommand = z
  .strictObject({
    type: z.literal('record_comfort_feedback'),
    /** The owner's words, verbatim. */
    text: z.string().min(1).max(1000),
    garmentId: OpaqueId.optional(),
    combinationRef: z.string().max(200).optional(),
    wearingDate: LocalDate.optional(),
    activity: z.string().max(120).optional(),
    layer: z.string().max(60).optional(),
    /** Only conditions actually known (e.g. { temperatureC: '19', setting: 'train' }). */
    conditions: z.record(z.string().max(40), z.string().max(120)).optional(),
    /** An explicit owner instruction ("do not suggest these for long walks") becomes a scoped standing direction. */
    standingInstruction: z
      .strictObject({
        ownerQuote: z.string().min(3).max(500),
        appliesTo: z.strictObject({ activity: z.string().max(120).optional(), setting: z.string().max(120).optional() }).optional(),
      })
      .optional(),
  })
  .refine((c) => c.garmentId !== undefined || c.combinationRef !== undefined, { message: 'Link feedback to a garment or a combination' })
  .refine((c) => !c.standingInstruction || c.garmentId !== undefined, { message: 'A standing instruction must name the garment it applies to' });

export const LifecycleProjectKind = z.enum(['tailoring', 'return', 'storage', 'sale', 'consignment', 'repair']);
export type LifecycleProjectKind = z.infer<typeof LifecycleProjectKind>;

/**
 * Statuses per kind. Sale/consignment: preparing -> listed (for sale) -> sold (buyer committed, still
 * owned) -> collected (gone: stock retired). Return: preparing -> requested -> posted (gone) -> refunded.
 * Any open project can be withdrawn, which lifts its for-sale/return restriction.
 */
export const LIFECYCLE_STATUSES: Record<LifecycleProjectKind, readonly string[]> = {
  sale: ['preparing', 'listed', 'sold', 'collected', 'withdrawn'],
  consignment: ['preparing', 'listed', 'sold', 'collected', 'withdrawn'],
  return: ['preparing', 'requested', 'posted', 'refunded', 'withdrawn'],
  tailoring: ['preparing', 'at_tailor', 'returned', 'withdrawn'],
  repair: ['preparing', 'at_repair', 'returned', 'withdrawn'],
  storage: ['preparing', 'stored', 'retrieved', 'withdrawn'],
};

/** The status at which items physically leave the owner's possession for good. */
export const LIFECYCLE_DEPARTURE_STATUS: Partial<Record<LifecycleProjectKind, { status: string; reason: 'sold' | 'returned' }>> = {
  sale: { status: 'collected', reason: 'sold' },
  consignment: { status: 'collected', reason: 'sold' },
  return: { status: 'posted', reason: 'returned' },
};

export const LifecycleDetails = z.strictObject({
  destination: z.string().max(200).optional(),
  collectionPreference: z.enum(['collection', 'drop_off', 'post']).optional(),
  listingCopy: z.string().max(4000).optional(),
  askingPriceMinor: MinorAmount.optional(),
  currency: Currency.optional(),
  work: z.string().max(1000).optional(),
  /** For a consignment: why the items go (e.g. 'size_correction'). Never a category verdict. */
  reason: z.string().max(200).optional(),
  orderLineId: OpaqueId.optional(),
  nextAction: z.string().max(300).optional(),
});

export const OpenLifecycleProjectCommand = z.strictObject({
  type: z.literal('open_lifecycle_project'),
  kind: LifecycleProjectKind,
  garmentIds: z.array(OpaqueId).min(1).max(50),
  details: LifecycleDetails.default({}),
  expectedReturn: LocalDate.optional(),
});

export const AdvanceLifecycleProjectCommand = z.strictObject({
  type: z.literal('advance_lifecycle_project'),
  projectId: OpaqueId,
  status: z.string().min(3).max(40),
  note: z.string().max(1000).optional(),
  proceedsMinor: MinorAmount.optional(),
  refundMinor: MinorAmount.optional(),
  currency: Currency.optional(),
  details: LifecycleDetails.optional(),
  occurredAt: Instant.optional(),
});
