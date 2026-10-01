/**
 * Assistant contracts (owned by the assistant workstream).
 *
 * Command payloads and read models for the conversational assistant: turns, purchases, product
 * investigations, research notes, returns and exchanges, lifecycle projects, comfort feedback,
 * remembered conclusions, forgetting, inference accounting, outbound connections and background jobs.
 * Every exported schema is picked up by the contract generator. Import as `@garderobe/contracts/ext/assistant`.
 */
import { z } from "zod";
import { GarmentId, IanaTimezone, Instant, LocalDate, Scope } from "../primitives.ts";

export const ASSISTANT_CONTRACT_VERSION = "1.0.0";

const Id = z.string().min(1).max(128);
const MinorAmount = z.number().int().describe("Amount in the currency's minor unit (pence, cents).");
const Currency = z.string().length(3).describe("ISO 4217 currency code.");
const Quantity = z.number().int().positive();

/* ------------------------------------------------------------------ */
/* Conversation turns                                                   */
/* ------------------------------------------------------------------ */

/**
 * Material that is NOT the owner's own words: pasted text, a forwarded email, a web page, a document,
 * a calendar event, an image description. It is data for the assistant to read; it never authorizes a
 * change, lifts a restriction, amends the profile or creates a garment.
 */
export const TurnAttachment = z.object({
  kind: z.enum(["pasted_text", "email", "web_page", "document", "calendar_event", "image_description", "spreadsheet", "other"]),
  source: z.string().max(500).nullable().default(null).describe("Where it came from (URL, sender, file name), for display only."),
  text: z.string().max(200_000),
});
export type TurnAttachment = z.infer<typeof TurnAttachment>;

export const TurnChannel = z.enum(["ios", "web", "mcp"]);
export type TurnChannel = z.infer<typeof TurnChannel>;

/** A finalized upload from the visual wardrobe's upload path, given to the assistant as real image input. */
export const TurnImage = z.object({
  assetId: z.string().min(1).max(128),
  role: z.enum(["selfie", "shop_photo", "item_photo", "receipt", "other"]).default("other"),
});
export type TurnImage = z.infer<typeof TurnImage>;

/** What a client submits to start a conversational turn. The owner comes from the authenticated connection. */
export const TurnInput = z.object({
  /** Stable client submission ID created before sending; retransmission returns the same turn. */
  submissionId: z.string().min(8).max(128),
  /** Only what the owner typed or said. May be empty when a photograph is sent on its own; then nothing can be changed. */
  text: z.string().max(20_000).default(""),
  /** Photographs already uploaded and finalized. A photograph is evidence to look at, never an instruction or an authorization. */
  images: z.array(TurnImage).max(4).default([]),
  attachments: z.array(TurnAttachment).max(20).default([]),
  /** Attached item/outfit identity ("Ask about this"); resolved by trusted code, never guessed by a model. */
  attachedRefs: z.array(z.string().max(160)).max(20).default([]),
});
export type TurnInput = z.input<typeof TurnInput>;

export const TurnStatus = z.enum(["accepted", "running", "needs_input", "completed", "failed", "cancelled", "resumable"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const TurnReceiptRef = z.object({
  commandId: z.string(),
  type: z.string(),
  outcome: z.string(),
  /** Built by trusted code from ledger records; never model prose. */
  summary: z.string(),
  undoAvailable: z.boolean(),
});
export type TurnReceiptRef = z.infer<typeof TurnReceiptRef>;

export const TurnRecord = z.object({
  turnId: z.string(),
  submissionId: z.string(),
  channel: z.string(),
  status: TurnStatus,
  /** True on first acceptance; false when an identical retransmission resolved to the existing turn. */
  accepted: z.boolean(),
  reply: z.object({ messageId: z.string(), text: z.string() }).nullable(),
  receipts: z.array(TurnReceiptRef),
  /** Refusals by trusted policy during the turn (nothing was written for these). */
  refusals: z.array(z.object({ tool: z.string(), code: z.string(), message: z.string() })),
  /** Writes a read-only connection asked for: described, not executed. */
  proposals: z.array(z.object({ type: z.string(), summary: z.string(), payload: z.record(z.string(), z.unknown()) })),
  /** One pending question with the distinguishing facts; answering resumes the same pending action. */
  clarification: z
    .object({ inputId: z.string(), question: z.string(), choices: z.array(z.object({ id: z.string(), label: z.string() })), actionId: z.string().nullable() })
    .nullable(),
  /** Structured result of a research turn. */
  result: z.record(z.string(), z.unknown()).nullable(),
  failure: z.object({ code: z.string(), message: z.string(), resumable: z.boolean() }).nullable(),
  modelProfile: z.string().nullable(),
  createdAt: Instant,
  completedAt: Instant.nullable(),
});
export type TurnRecord = z.infer<typeof TurnRecord>;

/** An original transcript message (never a compaction overlay). */
export const TranscriptMessage = z.object({
  messageId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  authoredAt: Instant.nullable(),
  channel: z.string().nullable(),
  turnId: z.string().nullable(),
  text: z.string(),
  /** Parts as stored (text, tool calls with results, result cards). Reasoning is never included. */
  parts: z.array(z.record(z.string(), z.unknown())),
  /** True when the owner asked to forget this message: content is suppressed everywhere. */
  forgotten: z.boolean(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

export const TranscriptPage = z.object({
  messages: z.array(TranscriptMessage),
  /** Pass as `before` to load older messages; null at the beginning of the conversation. */
  nextBefore: z.string().nullable(),
  /** Pass as `after` to load newer messages; null at the end. */
  nextAfter: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
export type TranscriptPage = z.infer<typeof TranscriptPage>;

export const TurnEvent = z.object({
  seq: z.number().int().positive(),
  type: z.enum(["run_started", "activity", "text_delta", "sources", "command_receipt", "needs_input", "run_finished"]),
  at: Instant,
  data: z.record(z.string(), z.unknown()),
});
export type TurnEvent = z.infer<typeof TurnEvent>;

export const ClarificationAnswer = z.object({ inputId: z.string().min(1), choiceId: z.string().optional(), text: z.string().max(4000).optional() });
export type ClarificationAnswer = z.infer<typeof ClarificationAnswer>;

export const ResearchRequest = z.object({
  submissionId: z.string().min(8).max(128),
  topic: z.string().min(1).max(2000),
  kind: z.enum(["product", "history", "purchases", "general"]),
  url: z.string().url().optional(),
});
export type ResearchRequest = z.infer<typeof ResearchRequest>;

/** A settled background result appended at a message boundary without starting an inference turn. */
export const ResultDelivery = z.object({
  /** Stable delivery ID; a repeated delivery is accepted once. */
  deliveryId: z.string().min(8).max(160),
  title: z.string().min(1).max(200),
  body: z.string().max(8000),
  refs: z.array(z.object({ kind: z.string(), id: z.string() })).default([]),
});
export type ResultDelivery = z.input<typeof ResultDelivery>;

/* ------------------------------------------------------------------ */
/* Recall                                                               */
/* ------------------------------------------------------------------ */

export const JudgementKind = z.enum(["liked", "rejected", "ordered", "returned", "worn", "discomfort", "considering"]);
export type JudgementKind = z.infer<typeof JudgementKind>;

export const RecallQuery = z.object({
  text: z.string().max(1000).default(""),
  entityIds: z.array(z.string()).default([]),
  /** Resolved against the owner's timezone and the conversation date when omitted. */
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  judgement: JudgementKind.optional(),
  speaker: z.enum(["owner", "assistant"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});
export type RecallQuery = z.input<typeof RecallQuery>;

export const RecallHit = z.object({
  messageId: z.string(),
  authoredAt: Instant,
  channel: z.string().nullable(),
  speaker: z.enum(["owner", "assistant"]),
  /** Exact excerpt of the original message. */
  quote: z.string(),
  judgements: z.array(z.object({ kind: JudgementKind, subject: z.string(), speaker: z.enum(["owner", "assistant"]) })),
  entityIds: z.array(z.string()),
  /** Later facts that qualify this one (a return, a fit reversal, a correction), reported separately. */
  laterDevelopments: z.array(z.object({ kind: z.string(), messageId: z.string().nullable(), authoredAt: Instant.nullable(), quote: z.string() })),
  /** The original messages immediately before and after, for context. */
  surrounding: z.array(z.object({ messageId: z.string(), speaker: z.string(), authoredAt: Instant, quote: z.string() })),
  /** Shopping candidates (product investigations) this message names. */
  linkedInvestigations: z.array(z.object({ productId: z.string(), name: z.string() })),
  /** Opens this point in the continuous stream. */
  link: z.string(),
  origin: z.enum(["source_history", "ai_search", "both"]),
});
export type RecallHit = z.infer<typeof RecallHit>;

export const RecallResult = z.object({
  hits: z.array(RecallHit),
  resolvedRange: z.object({ from: LocalDate, to: LocalDate, basis: z.string() }).nullable(),
  /** Set when the requested period could mean more than one range; the assistant surfaces it rather than guessing. */
  ambiguity: z.string().nullable(),
  /** Disclosed when the derived index has not caught up; source history was searched directly for the gap. */
  indexGap: z.object({ unindexedMessages: z.number().int().nonnegative(), searchedSourceDirectly: z.boolean() }).nullable(),
  watermark: z.object({ indexedThrough: Instant.nullable(), unindexedMessages: z.number().int().nonnegative() }),
  exhaustive: z.boolean(),
  /** Historical liking never implies ownership or current stock. */
  caveat: z.string(),
});
export type RecallResult = z.infer<typeof RecallResult>;

/* ------------------------------------------------------------------ */
/* Purchases                                                            */
/* ------------------------------------------------------------------ */

export const OrderLineState = z.enum(["ordered", "dispatched", "delivered", "cancelled", "refunded", "returned", "exchanged"]);
export type OrderLineState = z.infer<typeof OrderLineState>;

export const OrderLineInput = z.object({
  /** Stable line identity within the order (product/fabric code + size + options); a product name alone is not an identity. */
  lineKey: z.string().min(1).max(200),
  productName: z.string().min(1),
  productCode: z.string().nullable().default(null),
  fabricCode: z.string().nullable().default(null),
  size: z.string().nullable().default(null),
  colour: z.string().nullable().default(null),
  fitOptions: z.record(z.string(), z.string()).default({}),
  priceMinor: MinorAmount.nullable().default(null),
  currency: Currency.nullable().default(null),
  quantity: Quantity.default(1),
  arrivalEstimate: z.string().nullable().default(null),
  /** Line of the replaced order this line remakes or replaces. */
  replacesLineKey: z.string().nullable().default(null),
});
export type OrderLineInput = z.input<typeof OrderLineInput>;

export const OrderEventKind = z.enum(["confirmation", "dispatch", "delivery", "refund", "cancellation", "remake", "return"]);
export type OrderEventKind = z.infer<typeof OrderEventKind>;

export const OrderEventInput = z.object({
  kind: OrderEventKind,
  /** Stable business key; a repeated event is recorded once. */
  dedupeKey: z.string().min(1).max(200),
  occurredAt: Instant,
  sourceRef: z.string().min(1).max(500).describe("Email message ID, receipt photo ID or owner statement reference."),
  lineKeys: z.array(z.string()).default([]),
  amountMinor: MinorAmount.nullable().default(null),
});
export type OrderEventInput = z.input<typeof OrderEventInput>;

/**
 * "Log the order": record an order and its lines. Deduplicated by merchant + order number + line key.
 * Creating an order NEVER activates stock: arrival is a separate owner observation (`garment.receive`).
 */
export const PurchaseImportOrder = z.object({
  merchant: z.string().min(1),
  merchantKey: z.string().min(1).max(120).describe("Normalized merchant identity, e.g. 'drakes'."),
  orderNumber: z.string().min(1).max(120),
  orderedOn: LocalDate.nullable().default(null),
  currency: Currency.nullable().default(null),
  totalMinor: MinorAmount.nullable().default(null),
  channel: z.enum(["email", "in_store", "owner_statement", "photo"]).default("email"),
  lines: z.array(OrderLineInput).min(1),
  events: z.array(OrderEventInput).default([]),
  /** The order this one replaces or remakes; linked, never double-counted. */
  replaces: z.object({ merchantKey: z.string(), orderNumber: z.string() }).nullable().default(null),
  sourceRefs: z.array(z.string().max(500)).default([]),
});

/** A dispatch, refund, cancellation, return or carrier delivery notice enriching an existing order. */
export const PurchaseRecordEvent = z.object({
  orderId: Id,
  event: OrderEventInput,
});

/** Link an order line to the garment record that represents it (created separately as incoming stock). */
export const PurchaseLinkLine = z.object({ orderId: Id, lineId: Id, garmentId: GarmentId });

/** The owner's arrival observation was recorded for this line (the stock fact itself is `garment.receive`). */
export const PurchaseMarkDelivered = z.object({ orderId: Id, lineId: Id, deliveredOn: LocalDate });

export const OrderLine = z.object({
  lineId: z.string(),
  lineKey: z.string(),
  productName: z.string(),
  productCode: z.string().nullable(),
  fabricCode: z.string().nullable(),
  size: z.string().nullable(),
  colour: z.string().nullable(),
  fitOptions: z.record(z.string(), z.string()),
  priceMinor: z.number().int().nullable(),
  currency: z.string().nullable(),
  quantity: z.number().int().positive(),
  arrivalEstimate: z.string().nullable(),
  state: OrderLineState,
  garmentId: z.string().nullable(),
  deliveredOn: LocalDate.nullable(),
  refundedMinor: z.number().int().nonnegative(),
  replaces: z.object({ orderId: z.string(), lineId: z.string() }).nullable(),
});
export type OrderLine = z.infer<typeof OrderLine>;

export const Order = z.object({
  orderId: z.string(),
  version: z.number().int().positive(),
  merchant: z.string(),
  merchantKey: z.string(),
  orderNumber: z.string(),
  orderedOn: LocalDate.nullable(),
  currency: z.string().nullable(),
  totalMinor: z.number().int().nullable(),
  channel: z.string(),
  replacesOrderId: z.string().nullable(),
  lines: z.array(OrderLine),
  events: z.array(z.object({ eventId: z.string(), kind: OrderEventKind, occurredAt: Instant, sourceRef: z.string(), lineIds: z.array(z.string()), amountMinor: z.number().int().nullable() })),
  sourceRefs: z.array(z.string()),
  createdAt: Instant,
  updatedAt: Instant,
});
export type Order = z.infer<typeof Order>;

/* ------------------------------------------------------------------ */
/* Product investigations and research                                  */
/* ------------------------------------------------------------------ */

/** A product record OUTSIDE the wardrobe (a shopping candidate). It is never owned stock. */
export const ProductRecord = z.object({
  productId: Id.optional(),
  url: z.string().url().nullable().default(null),
  maker: z.string().nullable().default(null),
  name: z.string().min(1),
  productCode: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
  sourceRef: z.string().max(500).nullable().default(null),
});

export const ProductAvailabilityState = z.enum(["available", "unavailable", "unknown"]);

/** One dated observation of the exact variant on the page actually checked. */
export const ProductRecordObservation = z.object({
  productId: Id,
  observedAt: Instant,
  checkedUrl: z.string().url(),
  availability: ProductAvailabilityState,
  size: z.string().nullable().default(null),
  colour: z.string().nullable().default(null),
  priceMinor: MinorAmount.nullable().default(null),
  currency: Currency.nullable().default(null),
  country: z.string().max(8).nullable().default(null),
  method: z.string().max(60),
  completeness: z.enum(["complete", "partial", "failed"]),
  /** Facts read from the evidence (fabric, construction, measurements...), each with its source anchor. */
  facts: z.array(z.object({ attribute: z.string(), value: z.string(), anchor: z.string().nullable().default(null) })).default([]),
  missingFields: z.array(z.string()).default([]),
  returnTerms: z.string().nullable().default(null),
});

/** A fit verdict with its arithmetic and its specific uncertainty, tied to dated measurements. */
export const ProductRecordFitAssessment = z.object({
  productId: Id,
  sizeLabel: z.string().nullable().default(null),
  verdict: z.enum(["likely_fits", "likely_tight", "likely_loose", "cannot_determine"]),
  computation: z.record(z.string(), z.unknown()).describe("Normalized inputs and computed ease per dimension."),
  uncertainties: z.array(z.string()).default([]),
  measurementRefs: z.array(z.string()).default([]),
});

export const ResearchClaim = z.object({
  text: z.string().min(1),
  status: z.enum(["supported", "maker_claim_only", "unsupported", "contested"]),
  support: z.array(z.object({ url: z.string().url(), passage: z.string().min(1), date: z.string().nullable().default(null), sourceClass: z.string() })).default([]),
  uncertainty: z.string().nullable().default(null),
});

/** Saved research: claims keep their citations and their uncertainty. */
export const ResearchSaveNote = z.object({
  noteId: Id.optional(),
  topic: z.string().min(1).max(300),
  body: z.string().min(1).max(60_000),
  claims: z.array(ResearchClaim).default([]),
  garmentIds: z.array(GarmentId).default([]),
  productIds: z.array(Id).default([]),
});

/* ------------------------------------------------------------------ */
/* Returns and exchanges                                                */
/* ------------------------------------------------------------------ */

export const ReturnTerms = z.object({
  windowDays: z.number().int().positive(),
  concerns: z.enum(["request", "post", "retailer_receipt"]),
  triggerEvent: z.enum(["delivery", "purchase", "dispatch"]),
  /** Where the terms were read (URL, email, receipt) and when they were checked. */
  sourceRef: z.string().min(1).max(500),
  checkedOn: LocalDate,
  text: z.string().nullable().default(null),
});
export type ReturnTerms = z.infer<typeof ReturnTerms>;

export const ReturnCaseState = z.enum(["considering", "requested", "label_ready", "posted", "retailer_received", "refunded", "exchanged", "closed", "cancelled"]);
export type ReturnCaseState = z.infer<typeof ReturnCaseState>;

/**
 * Open a return or exchange project for an order line or garment. A deadline is established only from
 * sourced terms and the real trigger date; otherwise it is unresolved research, never a guessed countdown.
 * Opening, drafting or requesting a return does NOT remove stock; physical departure does (`garment.retire`).
 */
export const ReturnOpenCase = z.object({
  caseId: Id.optional(),
  kind: z.enum(["return", "exchange"]),
  orderId: Id.nullable().default(null),
  lineId: Id.nullable().default(null),
  garmentId: GarmentId.nullable().default(null),
  quantity: Quantity.default(1),
  terms: ReturnTerms.nullable().default(null),
  /** The real trigger date (e.g. actual delivery date), when known. */
  triggerDate: LocalDate.nullable().default(null),
  timezone: IanaTimezone.optional(),
  nextAction: z.string().nullable().default(null),
  collectionPreference: z.string().nullable().default(null),
  refundExpectedMinor: MinorAmount.nullable().default(null),
  currency: Currency.nullable().default(null),
  reason: z.string().nullable().default(null),
});

export const ReturnUpdateCase = z.object({
  caseId: Id,
  state: ReturnCaseState.optional(),
  terms: ReturnTerms.optional(),
  triggerDate: LocalDate.optional(),
  nextAction: z.string().nullable().optional(),
  labelRef: z.string().nullable().optional(),
  collectionPreference: z.string().nullable().optional(),
  shipmentRef: z.string().nullable().optional(),
  retailerReceivedOn: LocalDate.optional(),
  refundExpectedMinor: MinorAmount.optional(),
  /** Adds to the refund received so far (partial refunds accumulate). */
  refundReceivedMinor: MinorAmount.optional(),
  refundSourceRef: z.string().max(500).optional(),
  currency: Currency.optional(),
  note: z.string().nullable().optional(),
});

/** Link the incoming variant of an exchange to its case; ownership is not duplicated. */
export const ReturnLinkExchange = z.object({ caseId: Id, incomingOrderId: Id, incomingLineId: Id });

export const ReturnCase = z.object({
  caseId: z.string(),
  version: z.number().int().positive(),
  kind: z.enum(["return", "exchange"]),
  state: ReturnCaseState,
  orderId: z.string().nullable(),
  lineId: z.string().nullable(),
  garmentId: z.string().nullable(),
  quantity: z.number().int().positive(),
  terms: ReturnTerms.nullable(),
  triggerDate: LocalDate.nullable(),
  deadline: z.object({
    status: z.enum(["established", "unresolved"]),
    at: Instant.nullable(),
    localDate: LocalDate.nullable(),
    timezone: z.string().nullable(),
    concerns: z.enum(["request", "post", "retailer_receipt"]).nullable(),
    /** Why the deadline is unresolved, when it is. */
    reason: z.string().nullable(),
  }),
  nextAction: z.string().nullable(),
  labelRef: z.string().nullable(),
  collectionPreference: z.string().nullable(),
  shipmentRef: z.string().nullable(),
  retailerReceivedOn: LocalDate.nullable(),
  refund: z.object({ expectedMinor: z.number().int().nullable(), receivedMinor: z.number().int().nonnegative(), state: z.enum(["none", "partial", "full", "over"]), currency: z.string().nullable() }),
  exchangeIncoming: z.object({ orderId: z.string(), lineId: z.string() }).nullable(),
  /** True only after physical departure was recorded on the ledger. */
  stockDeparted: z.boolean(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type ReturnCase = z.infer<typeof ReturnCase>;

/* ------------------------------------------------------------------ */
/* Lifecycle projects                                                   */
/* ------------------------------------------------------------------ */

export const LifecycleKind = z.enum(["consignment", "sale", "donation", "disposal", "tailoring", "seasonal_storage", "repair", "other"]);
export type LifecycleKind = z.infer<typeof LifecycleKind>;
export const LifecycleState = z.enum(["open", "in_progress", "awaiting_owner", "awaiting_external", "completed", "cancelled"]);

/** A durable project. Drafting a listing or planning a disposal never means the item has left the building. */
export const LifecycleOpenProject = z.object({
  projectId: Id.optional(),
  kind: LifecycleKind,
  title: z.string().min(1).max(200),
  items: z.array(z.object({ garmentId: GarmentId, quantity: Quantity.default(1) })).min(1),
  destination: z.string().nullable().default(null),
  nextAction: z.string().nullable().default(null),
  /** Tailoring: requested work and expected return. Sale: known prices, listing copy, photo references. */
  details: z.record(z.string(), z.unknown()).default({}),
});

export const LifecycleEventKind = z.enum([
  "photos_matched",
  "copy_drafted",
  "form_prepared",
  "submission_attempted",
  "submission_confirmed",
  "submission_uncertain",
  "pickup_scheduled",
  "pickup_completed",
  "proceeds_recorded",
  "sent_to_tailor",
  "returned_from_tailor",
  "stored",
  "retrieved",
  "discarded",
  "handoff_prepared",
  "note",
]);

/** Progress on a project. Physical transitions are recorded on the stock ledger by their own commands. */
export const LifecycleRecordEvent = z.object({
  projectId: Id,
  kind: LifecycleEventKind,
  detail: z.record(z.string(), z.unknown()).default({}),
  garmentIds: z.array(GarmentId).default([]),
  proceedsMinor: MinorAmount.optional(),
  currency: Currency.optional(),
  /** Stable key of an external operation (a form submission); used to reconcile before another attempt. */
  externalOperationKey: z.string().max(200).optional(),
  nextAction: z.string().nullable().optional(),
  state: LifecycleState.optional(),
});

export const LifecycleUpdateProject = z.object({
  projectId: Id,
  title: z.string().min(1).max(200).optional(),
  destination: z.string().nullable().optional(),
  nextAction: z.string().nullable().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  state: LifecycleState.optional(),
});

export const ExternalActionKind = z.enum(["send_message", "submit_listing", "purchase", "commit_service", "paid_booking"]);

/** The owner's retained authorization for one concrete kind of external action within a project. */
export const LifecycleAuthorizeAction = z.object({
  projectId: Id,
  action: ExternalActionKind,
  scope: z.string().min(1).max(500).describe("What exactly is authorized (destination, item set, price limit)."),
  ownerQuote: z.string().min(1).max(2000),
});

export const LifecycleProject = z.object({
  projectId: z.string(),
  version: z.number().int().positive(),
  kind: LifecycleKind,
  state: LifecycleState,
  title: z.string(),
  destination: z.string().nullable(),
  nextAction: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  items: z.array(z.object({ garmentId: z.string(), quantity: z.number().int().positive(), state: z.string(), proceedsMinor: z.number().int().nullable(), currency: z.string().nullable() })),
  authorizations: z.array(z.object({ action: ExternalActionKind, scope: z.string(), grantedAt: Instant })),
  events: z.array(z.object({ eventId: z.string(), kind: z.string(), detail: z.record(z.string(), z.unknown()), occurredAt: Instant })),
  createdAt: Instant,
  updatedAt: Instant,
});
export type LifecycleProject = z.infer<typeof LifecycleProject>;

/* ------------------------------------------------------------------ */
/* Optional comfort feedback                                            */
/* ------------------------------------------------------------------ */

export const ComfortKind = z.enum(["too_warm", "too_cold", "scratchy", "pain", "tight", "loose", "restrictive", "other_discomfort", "positive"]);
export type ComfortKind = z.infer<typeof ComfortKind>;

/**
 * One unsolicited observation ("too warm on the train"). Linked only to what is actually known;
 * missing context stays null rather than being asked for. Scope is kept narrow and visible.
 */
export const FeedbackRecord = z.object({
  feedbackId: Id.optional(),
  text: z.string().min(1).max(2000).describe("The owner's words, verbatim."),
  kind: ComfortKind,
  garmentIds: z.array(GarmentId).default([]),
  wearingDate: LocalDate.nullable().default(null),
  activity: z.string().max(200).nullable().default(null),
  layer: z.string().max(100).nullable().default(null),
  conditions: z.record(z.string(), z.unknown()).default({}),
  /** The context the observation applies to (e.g. 'commute by train'); null = only the reported occasion. */
  scope: z.string().max(300).nullable().default(null),
  sourceRef: z.string().max(500).nullable().default(null),
});

export const FeedbackRetract = z.object({ feedbackId: Id, reason: z.string().nullable().default(null) });

export const ComfortFeedback = z.object({
  feedbackId: z.string(),
  text: z.string(),
  kind: ComfortKind,
  pain: z.boolean(),
  garmentIds: z.array(z.string()),
  wearingDate: LocalDate.nullable(),
  activity: z.string().nullable(),
  layer: z.string().nullable(),
  conditions: z.record(z.string(), z.unknown()),
  scope: z.string().nullable(),
  status: z.enum(["active", "retracted"]),
  createdAt: Instant,
});
export type ComfortFeedback = z.infer<typeof ComfortFeedback>;

/* ------------------------------------------------------------------ */
/* Remembered conclusions and forgetting                                */
/* ------------------------------------------------------------------ */

export const MemoryKind = z.enum(["fit_judgement", "purchase_judgement", "preference", "unfinished_investigation", "fact", "other"]);

/**
 * A source-linked conclusion, never a second inventory. A model extraction is a `candidate` until the
 * owner confirms it; only owner-stated conclusions are recorded as `active` directly.
 */
export const MemoryRecordConclusion = z.object({
  conclusionId: Id.optional(),
  kind: MemoryKind,
  text: z.string().min(1).max(2000),
  speaker: z.enum(["owner", "assistant"]),
  sourceMessageIds: z.array(z.string()).min(1),
  /** Premises the conclusion depends on (a measurement, a size, a product version); rechecked before reuse. */
  premises: z.array(z.object({ kind: z.string(), ref: z.string(), value: z.string().nullable().default(null) })).default([]),
  entityIds: z.array(z.string()).default([]),
  status: z.enum(["candidate", "active"]).default("candidate"),
});

export const MemorySetStatus = z.object({
  conclusionId: Id,
  status: z.enum(["active", "retired"]),
  /** For a correction: the replacing text (creates a new version; the old one is kept as superseded). */
  correctedText: z.string().min(1).max(2000).optional(),
});

export const MemoryConclusion = z.object({
  conclusionId: z.string(),
  version: z.number().int().positive(),
  kind: MemoryKind,
  text: z.string(),
  speaker: z.enum(["owner", "assistant"]),
  status: z.enum(["candidate", "active", "superseded", "retired", "forgotten"]),
  sourceMessageIds: z.array(z.string()),
  premises: z.array(z.object({ kind: z.string(), ref: z.string(), value: z.string().nullable() })),
  entityIds: z.array(z.string()),
  createdAt: Instant,
});
export type MemoryConclusion = z.infer<typeof MemoryConclusion>;

/**
 * Forget conversation sources. Creates an immediate read-time tombstone across transcript, model
 * context and retrieval, and schedules physical removal and regeneration of summaries that contained
 * them. Suppression alone is never reported as completed erasure.
 */
export const ConversationForgetSource = z.object({
  sourceKind: z.enum(["message", "memory_conclusion", "research_note", "comfort_feedback"]),
  sourceIds: z.array(z.string().min(1)).min(1).max(200),
  reason: z.string().nullable().default(null),
});

/** Physical removal finished for tombstoned sources (reported by the store that erased them). */
export const ConversationConfirmErasure = z.object({
  sourceKind: z.enum(["message", "memory_conclusion", "research_note", "comfort_feedback"]),
  sourceIds: z.array(z.string().min(1)).min(1).max(200),
  store: z.enum(["transcript", "retrieval_index", "summaries", "ai_search", "ledger"]),
  /** Set when a provider retains metadata that cannot be removed immediately. */
  outstandingRetention: z.string().nullable().default(null),
});

export const ForgetState = z.object({
  sourceKind: z.string(),
  sourceId: z.string(),
  state: z.enum(["suppressed", "erased"]),
  requestedAt: Instant,
  erasedStores: z.array(z.string()),
  pendingStores: z.array(z.string()),
  outstandingRetention: z.string().nullable(),
});
export type ForgetState = z.infer<typeof ForgetState>;

/* ------------------------------------------------------------------ */
/* Inference: task profiles, budgets, usage                             */
/* ------------------------------------------------------------------ */

export const InferenceTask = z.enum([
  "conversation",
  "outfit_composition",
  "extraction",
  "photo_matching",
  "historical_research",
  "catalogue_editing",
  "compaction",
  "recall_enrichment",
  "semantic_indexing",
]);
export type InferenceTask = z.infer<typeof InferenceTask>;

export const BudgetClass = z.enum(["daily_board", "interactive", "research", "image_backfill", "maintenance", "search"]);
export type BudgetClass = z.infer<typeof BudgetClass>;

export const ModelOperation = z.enum(["text", "tools", "structured_output", "vision", "image_edit", "embedding"]);
export type ModelOperation = z.infer<typeof ModelOperation>;

/** Result of an authenticated capability + Unified Billing probe for one operation of one profile. */
export const ModelProbe = z.object({
  operation: ModelOperation,
  result: z.enum(["passed", "failed", "not_probed"]),
  billing: z.enum(["unified_billing", "ineligible", "not_probed"]),
  reason: z.string().nullable(),
  probedAt: Instant.nullable(),
  resolvedModel: z.string().nullable().describe("Model the provider reported answering (aliases can redirect)."),
});
export type ModelProbe = z.infer<typeof ModelProbe>;

export const ModelProfile = z.object({
  profileId: z.string(),
  label: z.string(),
  provider: z.string(),
  /** Exact API model ID, or null while the exact ID is still unverified (the profile is then unavailable). */
  apiModelId: z.string().nullable(),
  /** Route through AI Gateway, e.g. `deepseek/deepseek-flash`. */
  gatewayRoute: z.string().nullable(),
  supportedOperations: z.array(ModelOperation),
  inputTypes: z.array(z.enum(["text", "image"])),
  /** Provider-specific request parameters exactly as sent (no universal effort scale). */
  effort: z.record(z.string(), z.unknown()),
  contextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  /** Price hypothesis used for reservations, in micro-USD per million tokens, with its observation date. */
  price: z.object({ inputMicroUsdPerMTok: z.number().nonnegative(), outputMicroUsdPerMTok: z.number().nonnegative(), observedOn: LocalDate.nullable() }),
  /** Provider rate limits as observed by a probe; null until one records them. */
  rateLimit: z.object({ requestsPerMinute: z.number().nullable(), tokensPerMinute: z.number().nullable(), observedOn: LocalDate.nullable() }),
  dataPermissions: z.string(),
  fallbacks: z.array(z.string()),
  probes: z.array(ModelProbe),
  /** Selectable only after its required probes passed with Unified Billing. */
  selectable: z.boolean(),
  unavailableReason: z.string().nullable(),
});
export type ModelProfile = z.infer<typeof ModelProfile>;

export const InferenceOverview = z.object({
  gatewayId: z.string().nullable(),
  profiles: z.array(ModelProfile),
  routing: z.array(z.object({ task: InferenceTask, profileId: z.string().nullable(), fallbacks: z.array(z.string()), budgetClass: BudgetClass })),
  budgets: z.array(z.object({ budgetClass: BudgetClass, dailyLimitMicroUsd: z.number().int().nonnegative(), reservedMicroUsd: z.number().int().nonnegative(), settledMicroUsd: z.number().int().nonnegative(), uncertainMicroUsd: z.number().int().nonnegative(), budgetDay: LocalDate })),
  breakers: z.array(z.object({ profileId: z.string(), state: z.enum(["closed", "open", "half_open"]), failures: z.number().int().nonnegative(), openedAt: Instant.nullable() })),
});
export type InferenceOverview = z.infer<typeof InferenceOverview>;

/** Reserve spend before a model call is dispatched. Rejected when the task's budget would be exceeded. */
export const InferenceReserve = z.object({
  reservationId: Id,
  runId: Id,
  task: InferenceTask,
  budgetClass: BudgetClass,
  profileId: z.string(),
  attempt: z.number().int().positive().default(1),
  reservedMicroUsd: z.number().int().nonnegative(),
  budgetDay: LocalDate,
  dailyLimitMicroUsd: z.number().int().nonnegative(),
  parent: z.object({ kind: z.enum(["turn", "job", "workflow", "compaction"]), id: z.string() }),
  promptVersion: z.string().nullable().default(null),
  gatewayId: z.string(),
  /** Run evidence: schema version of any structured output, the exact effort parameters sent, and the input versions (profile hash, wardrobe and style revisions). */
  schemaVersion: z.string().nullable().default(null),
  effort: z.record(z.string(), z.unknown()).default({}),
  evidence: z.record(z.string(), z.unknown()).default({}),
  /** At most this many calls may be in flight for the owner; 0 = no cap. */
  maxOpenReservations: z.number().int().nonnegative().default(0),
  /** Discretionary work (research, image backfill) is refused once the day's spend across all classes reaches this; 0 = no ceiling. */
  discretionaryCeilingMicroUsd: z.number().int().nonnegative().default(0),
});

/** Settle a reservation against reported usage, release it, or keep it as uncertain until reconciliation. */
export const InferenceSettle = z.object({
  reservationId: Id,
  outcome: z.enum(["settled", "released", "uncertain"]),
  actualMicroUsd: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
  resolvedModel: z.string().nullable().default(null),
  errorClass: z.string().nullable().default(null),
});

/** Record a capability and billing probe result (deployment probes; never inferred from documentation). */
export const InferenceRecordProbe = z.object({
  profileId: z.string(),
  operation: ModelOperation,
  result: z.enum(["passed", "failed"]),
  billing: z.enum(["unified_billing", "ineligible"]),
  reason: z.string().nullable().default(null),
  resolvedModel: z.string().nullable().default(null),
  gatewayId: z.string(),
});

/** Owner's task routing choice. A profile must be selectable; promotion to the morning profile needs its evaluation gate. */
export const InferenceSetRouting = z.object({
  task: InferenceTask,
  profileId: z.string(),
  fallbacks: z.array(z.string()).default([]),
  /** Required for `outfit_composition`: reference to the passed evaluation run. */
  evaluationRef: z.string().nullable().default(null),
  /** The environment's Gateway whose probes decide whether the profile is selectable. */
  gatewayId: z.string().min(1),
});

/* ------------------------------------------------------------------ */
/* Outbound connections                                                 */
/* ------------------------------------------------------------------ */

export const ConnectionKind = z.enum(["gmail", "calendar", "drive", "sheets", "exa", "tavily", "mcp"]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export const ConnectionRegister = z.object({
  connectionId: Id.optional(),
  kind: ConnectionKind,
  label: z.string().min(1).max(120),
  endpoint: z.string().url(),
  /** Tool namespace, unique per owner; tools are exposed as `<namespace>__<tool>`. */
  namespace: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  /** NAME of the secret binding holding the credential. Never the credential itself. */
  secretRef: z.string().max(120).nullable().default(null),
  scopes: z.array(z.string()).default([]),
  /** Authorization issuer the connection's credential must come from (for example https://accounts.google.com). */
  expectedIssuer: z.string().url().nullable().default(null),
});

/** Result of a health check run before the evening preparation and the morning delivery. */
export const ConnectionRecordHealth = z.object({
  connectionId: Id,
  ok: z.boolean(),
  /** True when the service rejected the credential: the connection then needs the owner to sign in again. */
  authFailure: z.boolean().default(false),
  detail: z.string().max(300).nullable().default(null),
  phase: z.enum(["evening", "morning", "manual"]).default("manual"),
});

/* ------------------------------------------------------------------ */
/* Reminders set from conversation                                      */
/* ------------------------------------------------------------------ */

/** A reminder for a drop, a sale or another window: a managed event type distinct from outfit delivery. */
export const ReminderSet = z.object({
  reminderId: Id.optional(),
  kind: z.enum(["drop", "sale_window", "restock", "other"]),
  title: z.string().min(1).max(200),
  dueAt: Instant,
  note: z.string().max(1000).nullable().default(null),
  url: z.string().url().nullable().default(null),
  /** Also remind this many minutes before the time (0 = at the time). */
  leadMinutes: z.array(z.number().int().nonnegative()).max(4).default([0]),
});
export const ReminderCancel = z.object({ reminderId: Id });

export const Reminder = z.object({
  reminderId: z.string(),
  version: z.number().int().positive(),
  kind: z.string(),
  title: z.string(),
  note: z.string().nullable(),
  url: z.string().nullable(),
  dueAt: Instant,
  status: z.enum(["active", "cancelled"]),
});
export type Reminder = z.infer<typeof Reminder>;

/** Progress of a mailbox synchronization: which messages were read (identifiers only) and where the next run starts. */
export const MailRecordSync = z.object({
  connectionId: Id,
  seen: z.array(z.object({ messageId: z.string().min(1).max(200), classified: z.enum(["order", "not_order", "unreadable"]), sentAt: Instant.nullable().default(null) })).max(500),
  historyId: z.string().max(100).nullable().default(null),
  backfillFrom: LocalDate.nullable().default(null),
  backfillTo: LocalDate.nullable().default(null),
  completion: z.enum(["complete", "partial"]),
  resume: z.object({ queryIndex: z.number().int().nonnegative(), pageToken: z.string().optional() }).nullable().default(null),
});

/** Administrative record that an owner's private AI Search instance exists in an environment. */
export const SearchRecordInstance = z.object({
  environment: z.string().regex(/^[a-z]+$/),
  instance: z.string().min(1).max(100),
  gatewayId: z.string().min(1),
  created: z.boolean(),
});

export const ConnectionRecordDiscovery = z.object({
  connectionId: Id,
  protocolVersion: z.string().nullable().default(null),
  schemaDigest: z.string().length(64),
  tools: z.array(z.object({ name: z.string(), description: z.string().nullable().default(null), enabled: z.boolean(), disabledReason: z.string().nullable().default(null), group: z.string().nullable().default(null) })),
});

export const ConnectionSetToolGroups = z.object({ connectionId: Id, enabledGroups: z.array(z.string()) });
export const ConnectionSetStatus = z.object({ connectionId: Id, status: z.enum(["connected", "needs_reauthorization", "revoked"]), reason: z.string().nullable().default(null) });

export const Connection = z.object({
  connectionId: z.string(),
  version: z.number().int().positive(),
  kind: ConnectionKind,
  label: z.string(),
  endpoint: z.string(),
  namespace: z.string(),
  secretRef: z.string().nullable(),
  scopes: z.array(z.string()),
  status: z.enum(["registered", "connected", "needs_reauthorization", "revoked"]),
  protocolVersion: z.string().nullable(),
  schemaDigest: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string().nullable(), enabled: z.boolean(), disabledReason: z.string().nullable(), group: z.string().nullable() })),
  enabledGroups: z.array(z.string()),
  lastDiscoveryAt: Instant.nullable(),
  expectedIssuer: z.string().nullable(),
  health: z.object({ ok: z.boolean(), checkedAt: Instant, detail: z.string().nullable(), phase: z.string() }).nullable(),
});
export type Connection = z.infer<typeof Connection>;

/* ------------------------------------------------------------------ */
/* Background jobs                                                      */
/* ------------------------------------------------------------------ */

export const JobKind = z.enum(["email_investigation", "product_investigation", "historical_research", "image_backfill", "sheet_import", "index_rebuild", "summary_regeneration", "other"]);
export const JobState = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

export const JobCreate = z.object({
  jobId: Id.optional(),
  kind: JobKind,
  title: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(0).max(9).default(5),
});

export const JobUpdate = z.object({
  jobId: Id,
  state: JobState.optional(),
  progress: z.record(z.string(), z.unknown()).optional(),
  /** What was searched and whether it is complete; a first page is never presented as the whole result. */
  coverage: z.object({ from: z.string().nullable(), to: z.string().nullable(), completion: z.enum(["complete", "partial"]), resumeToken: z.string().nullable().default(null) }).optional(),
  resultRef: z.string().nullable().optional(),
  unresolvedReason: z.string().nullable().optional(),
  /** Effects already committed by the job (command IDs), reported when it is stopped. */
  committedCommandIds: z.array(z.string()).optional(),
});

export const Job = z.object({
  jobId: z.string(),
  version: z.number().int().positive(),
  kind: JobKind,
  state: JobState,
  title: z.string(),
  params: z.record(z.string(), z.unknown()),
  priority: z.number().int(),
  progress: z.record(z.string(), z.unknown()),
  coverage: z.object({ from: z.string().nullable(), to: z.string().nullable(), completion: z.enum(["complete", "partial"]), resumeToken: z.string().nullable() }).nullable(),
  resultRef: z.string().nullable(),
  unresolvedReason: z.string().nullable(),
  committedCommandIds: z.array(z.string()),
  /** Stable delivery ID of the result card; delivered to the conversation at most once. */
  deliveryId: z.string(),
  deliveredAt: Instant.nullable(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type Job = z.infer<typeof Job>;

/** The grant metadata trusted Worker code passes to the conversation actor (never a client-supplied owner). */
export const TurnGrant = z.object({ channel: TurnChannel, scopes: z.array(Scope), authRef: z.string().min(1).max(200) });
export type TurnGrant = z.infer<typeof TurnGrant>;

/** Assistant-lane command types and their payload schemas. */
export const ASSISTANT_COMMANDS = {
  "purchase.import_order": PurchaseImportOrder,
  "purchase.record_event": PurchaseRecordEvent,
  "purchase.link_line": PurchaseLinkLine,
  "purchase.mark_delivered": PurchaseMarkDelivered,
  "product.record": ProductRecord,
  "product.record_observation": ProductRecordObservation,
  "product.record_fit_assessment": ProductRecordFitAssessment,
  "research.save_note": ResearchSaveNote,
  "return.open_case": ReturnOpenCase,
  "return.update_case": ReturnUpdateCase,
  "return.link_exchange": ReturnLinkExchange,
  "lifecycle.open_project": LifecycleOpenProject,
  "lifecycle.record_event": LifecycleRecordEvent,
  "lifecycle.update_project": LifecycleUpdateProject,
  "lifecycle.authorize_action": LifecycleAuthorizeAction,
  "feedback.record": FeedbackRecord,
  "feedback.retract": FeedbackRetract,
  "memory.record_conclusion": MemoryRecordConclusion,
  "memory.set_status": MemorySetStatus,
  "conversation.forget_source": ConversationForgetSource,
  "conversation.confirm_erasure": ConversationConfirmErasure,
  "inference.reserve": InferenceReserve,
  "inference.settle": InferenceSettle,
  "inference.record_probe": InferenceRecordProbe,
  "inference.set_routing": InferenceSetRouting,
  "connection.register": ConnectionRegister,
  "connection.record_discovery": ConnectionRecordDiscovery,
  "connection.set_tool_groups": ConnectionSetToolGroups,
  "connection.set_status": ConnectionSetStatus,
  "connection.record_health": ConnectionRecordHealth,
  "reminder.set": ReminderSet,
  "reminder.cancel": ReminderCancel,
  "search.record_instance": SearchRecordInstance,
  "mail.record_sync": MailRecordSync,
  "job.create": JobCreate,
  "job.update": JobUpdate,
} as const;
export type AssistantCommandType = keyof typeof ASSISTANT_COMMANDS;
export const ASSISTANT_COMMAND_TYPES = Object.keys(ASSISTANT_COMMANDS) as AssistantCommandType[];
