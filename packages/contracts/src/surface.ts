import { z } from 'zod';
import { GarmentRole, Instant, LocalDate, OpaqueId, TimeZone } from './enums.js';
import { CommandReceipt } from './receipt.js';
import { StudioSlot } from './visual.js';
import { CONTRACTS_VERSION } from './version.js';

/**
 * API surface shapes added under CONTRACTS_VERSION 2026-10-01 (additive):
 * - the four shapes the iOS app validated against provisional copies (swap candidates, the run input
 *   endpoint, the upload PUT response, the prepare-board response);
 * - trips and packing, service pause state, orders and return deadlines, comfort observations,
 *   lifecycle projects, saved Studio combinations, account recovery, email intake and portability.
 */

// ------------------------------------------------------------------ iOS provisional shapes

/** GET /v1/today/options/{optionId}/swaps?role=: validated alternatives for one piece (reads only). */
export const SwapCandidates = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  optionId: OpaqueId,
  role: GarmentRole,
  /** Validated as a swap (never a navy fallback), best first. Empty when nothing else works today. */
  candidates: z.array(z.object({ garmentId: OpaqueId, name: z.string(), reason: z.string() })),
  validatedAt: Instant,
});
export type SwapCandidates = z.infer<typeof SwapCandidates>;

/** POST /v1/runs/{id}/input: answer the question a run is waiting on (null, absent or "decline" declines). */
export const RunInputRequest = z.strictObject({
  choiceId: z.string().min(1).max(80).nullable().optional(),
});
export type RunInputRequest = z.infer<typeof RunInputRequest>;

/** Response of POST /v1/runs/{id}/input. `run` is a RunStatus (validated separately by clients). */
export const RunInputResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  status: z.enum(['executed', 'declined', 'expired']),
  /** The receipt of the confirmed command; replayed when the question was already answered. */
  receipt: CommandReceipt.nullable(),
  /** For a confirmed account operation (export, import, recovery kit): its result, with the owner's private link. */
  operation: z.object({ operation: z.string(), idempotencyKey: z.string().nullable(), replayed: z.boolean(), result: z.record(z.string(), z.unknown()) }).nullable().optional(),
  run: z.record(z.string(), z.unknown()),
});
export type RunInputResponse = z.infer<typeof RunInputResponse>;

/** Response of PUT <uploadUrl> (the bytes are stored; they become evidence only after /complete). */
export const UploadReceiveResponse = z.object({
  uploadId: OpaqueId,
  receivedBytes: z.number().int().nonnegative(),
});
export type UploadReceiveResponse = z.infer<typeof UploadReceiveResponse>;

/** POST /v1/today/prepare request. */
export const PrepareBoardRequest = z.strictObject({
  date: LocalDate.optional(),
  count: z.number().int().min(3).max(5).optional(),
});
export type PrepareBoardRequest = z.infer<typeof PrepareBoardRequest>;

/** POST /v1/today/prepare response: compose, validate and publish now. */
export const PrepareBoardResponse = z.object({
  published: z.boolean(),
  /** published, no_valid_outfit, unchanged, or a publication conflict code. */
  reason: z.string(),
  revision: z.number().int().positive().nullable(),
  shortfall: z.string().nullable(),
  /** 'day' or 'trip:<tripId>' (additive). */
  purpose: z.string().optional(),
  date: LocalDate.optional(),
});
export type PrepareBoardResponse = z.infer<typeof PrepareBoardResponse>;

// ------------------------------------------------------------------ trips and packing

export const TripDestinationSchema = z.strictObject({
  label: z.string().min(1).max(120),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  timezone: TimeZone,
  from: LocalDate.optional(),
  to: LocalDate.optional(),
});

/** POST /v1/trips */
export const CreateTripRequest = z
  .strictObject({
    name: z.string().min(1).max(120),
    departsOn: LocalDate,
    returnsOn: LocalDate,
    destinations: z.array(TripDestinationSchema).min(1).max(10),
    timezone: TimeZone.optional(),
    luggage: z.string().max(60).nullable().optional(),
    occasions: z.array(z.strictObject({ date: LocalDate, occasion: z.string().min(1).max(60), note: z.string().max(300).optional() })).max(30).optional(),
    laundryOpportunities: z.array(z.strictObject({ date: LocalDate, kind: z.string().max(60) })).max(30).optional(),
    allowRepeats: z.boolean().optional(),
  })
  .refine((t) => t.returnsOn >= t.departsOn, { message: 'returnsOn must not precede departsOn' });
export type CreateTripRequest = z.infer<typeof CreateTripRequest>;

export const Trip = z.object({
  tripId: OpaqueId,
  name: z.string(),
  departsOn: LocalDate,
  returnsOn: LocalDate,
  destinations: z.array(z.object({ label: z.string(), timezone: z.string() }).passthrough()),
  timezone: z.string(),
  luggage: z.string().nullable(),
  status: z.enum(['planned', 'packed', 'completed', 'cancelled']),
  allowRepeats: z.boolean(),
  occasions: z.array(z.object({ date: z.string(), occasion: z.string(), note: z.string().optional() })),
  packedAt: z.string().nullable(),
  unpackedAt: z.string().nullable(),
  version: z.number().int().positive(),
});
export type Trip = z.infer<typeof Trip>;

export const TripItem = z.object({
  garmentId: OpaqueId,
  name: z.string().optional(),
  proposedQty: z.number().int().nonnegative(),
  packedQty: z.number().int().nonnegative(),
  unpackedQty: z.number().int().nonnegative(),
  packedAt: z.string().nullable(),
  unpackedAt: z.string().nullable(),
});

/** GET /v1/trips/{tripId}, and the result of packing actions. */
export const TripDetail = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  trip: Trip,
  items: z.array(TripItem),
  /** Owner-language summary of the action that produced this response (packing, unpacking). */
  summary: z.string().nullable(),
  replayed: z.boolean().optional(),
});
export type TripDetail = z.infer<typeof TripDetail>;

export const TripsResponse = z.object({ schemaVersion: z.literal(CONTRACTS_VERSION), trips: z.array(Trip) });

/** POST /v1/trips/{tripId}/proposal: a proposal only; nothing is packed. */
export const PackingProposalResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  tripId: OpaqueId,
  days: z.array(z.object({ date: LocalDate, garments: z.array(z.object({ garmentId: OpaqueId, name: z.string(), role: z.string() })), why: z.string() })),
  items: z.array(z.object({ garmentId: OpaqueId, name: z.string(), quantity: z.number().int().positive() })),
  notes: z.array(z.string()),
});

/** POST /v1/trips/{tripId}/packed and /unpacked: the owner's statement. */
export const PackingRequest = z.strictObject({
  items: z.array(z.strictObject({ garmentId: OpaqueId, quantity: z.number().int().positive().max(50) })).max(200).optional(),
  occurredAt: Instant.optional(),
});
export type PackingRequest = z.infer<typeof PackingRequest>;

/** Trip summary on Today during a packed trip (TodayResponse.trip). */
export const TodayTrip = z.object({
  tripId: OpaqueId,
  name: z.string(),
  timezone: z.string(),
  departsOn: LocalDate,
  returnsOn: LocalDate,
  destinations: z.array(z.string()),
});
export type TodayTrip = z.infer<typeof TodayTrip>;

// ------------------------------------------------------------------ service pause

/** GET /v1/service/pause: pausing and resuming are the pause_service / resume_service commands. */
export const ServicePauseState = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  paused: z.boolean(),
  current: z.object({ pauseId: OpaqueId, startsOn: LocalDate, resumeOn: LocalDate.nullable(), createdAt: Instant, commandId: z.string().nullable() }).nullable(),
  /** Outfit-calendar days currently suppressed by a pause. */
  suppressedDates: z.array(LocalDate),
});
export type ServicePauseState = z.infer<typeof ServicePauseState>;

// ------------------------------------------------------------------ orders and return deadlines

export const ReturnDeadline = z.object({
  deadlineId: OpaqueId,
  lineId: OpaqueId,
  kind: z.enum(['request', 'post', 'retailer_receipt']),
  deadlineAt: Instant,
  timezone: z.string(),
  /** The purchase terms actually checked (never a generic policy). */
  termsSource: z.string(),
  checkedAt: Instant,
  status: z.string(),
});
export type ReturnDeadline = z.infer<typeof ReturnDeadline>;

export const OrderLine = z.object({
  lineId: OpaqueId,
  externalLineId: z.string(),
  garmentId: OpaqueId.nullable(),
  description: z.string(),
  spec: z.record(z.string(), z.unknown()),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
  currency: z.string(),
  /** A predicted date, not a receipt. */
  arrivalEstimate: LocalDate.nullable(),
  arrivedQty: z.number().int().nonnegative(),
  arrivedAt: z.string().nullable(),
  refundedMinor: z.number().int().nonnegative(),
  remakeOfLineId: z.string().nullable(),
  status: z.string(),
  version: z.number().int().positive(),
  returnDeadlines: z.array(ReturnDeadline),
});

export const Order = z.object({
  orderId: OpaqueId,
  merchant: z.string(),
  merchantOrderNumber: z.string(),
  orderedAt: Instant,
  currency: z.string(),
  sourceRef: z.string().nullable(),
  status: z.string(),
  lines: z.array(OrderLine),
});
export type Order = z.infer<typeof Order>;

/** GET /v1/orders */
export const OrdersResponse = z.object({ schemaVersion: z.literal(CONTRACTS_VERSION), orders: z.array(Order) });
/** GET /v1/returns: open (and, with ?status=all, closed) sourced deadlines, soonest first. */
export const ReturnDeadlinesResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  deadlines: z.array(ReturnDeadline.extend({ merchant: z.string(), merchantOrderNumber: z.string(), description: z.string(), garmentId: OpaqueId.nullable() })),
});

/** POST /v1/intake/email/sync: bounded, paginated Gmail receipt search. */
export const EmailSyncRequest = z.strictObject({ query: z.string().min(1).max(500).optional(), maxPages: z.number().int().min(1).max(20).optional() });
export const EmailSyncResponse = z.object({ schemaVersion: z.literal(CONTRACTS_VERSION), report: z.record(z.string(), z.unknown()) });

// ------------------------------------------------------------------ comfort, lifecycle, combinations

/** GET /v1/comfort?garmentId=: the owner's comfort reports, verbatim and scoped. */
export const ComfortFeedbackResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  feedback: z.array(
    z.object({
      feedbackId: OpaqueId,
      garmentId: OpaqueId.nullable(),
      combinationRef: z.string().nullable(),
      wearingDate: LocalDate.nullable(),
      activity: z.string().nullable(),
      layer: z.string().nullable(),
      conditions: z.record(z.string(), z.unknown()),
      text: z.string(),
      scope: z.string(),
      createdAt: Instant,
    }),
  ),
});

export const LifecycleProject = z.object({
  projectId: OpaqueId,
  kind: z.enum(['tailoring', 'return', 'storage', 'sale', 'consignment', 'repair']),
  status: z.string(),
  details: z.record(z.string(), z.unknown()),
  expectedReturn: LocalDate.nullable(),
  actualReturn: z.string().nullable(),
  items: z.array(z.object({ garmentId: OpaqueId, name: z.string(), quantity: z.number().int().positive() })),
  createdAt: Instant,
  updatedAt: Instant,
  version: z.number().int().positive(),
});
export type LifecycleProject = z.infer<typeof LifecycleProject>;
/** GET /v1/projects (and /v1/projects/{id} returns one LifecycleProject). */
export const LifecycleProjectsResponse = z.object({ schemaVersion: z.literal(CONTRACTS_VERSION), projects: z.array(LifecycleProject) });

/** GET /v1/studio/combinations?kind=&from=&to= */
export const SavedCombinationsResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  combinations: z.array(
    z.object({
      combinationId: OpaqueId,
      kind: z.enum(['saved', 'plan']),
      name: z.string().nullable(),
      slots: z.array(StudioSlot),
      mode: z.enum(['today', 'explore']),
      plannedForDate: LocalDate.nullable(),
      status: z.enum(['active', 'removed', 'superseded']),
      createdAt: Instant,
      version: z.number().int().positive(),
    }),
  ),
});

// ------------------------------------------------------------------ account recovery and portability

/** POST /v1/auth/recovery-kit: shown once; only a verifier is stored. Never available over MCP. */
export const RecoveryKitResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  credential: z.string(),
  credentialId: z.string(),
  instructions: z.string(),
  issuedAt: Instant,
});

/** POST /v1/auth/recover: a verified but unlinked Access identity presents the owner's recovery code. */
export const RecoverRequest = z.strictObject({ credential: z.string().min(10).max(200) });
export const RecoverResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  recovered: z.literal(true),
  displayName: z.string(),
  /** Every earlier session and assistant grant stopped working at this instant. */
  sessionsValidAfter: Instant,
  replacementKit: RecoveryKitResponse.omit({ schemaVersion: true }),
});

/** POST /v1/import response (the request body is a garderobe-export/1 package). */
export const ImportResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  imported: z.literal(true),
  tables: z.array(z.object({ name: z.string(), rows: z.number().int().nonnegative() })),
});

/** A receipt-carrying response of a service operation (trips, email sync) reached through the command policy. */
export const OperationReceipt = z.object({
  operation: z.string(),
  idempotencyKey: z.string().nullable(),
  replayed: z.boolean(),
  result: z.record(z.string(), z.unknown()),
});
export type OperationReceipt = z.infer<typeof OperationReceipt>;

// ------------------------------------------------------------------ export, import and recovery reached from an assistant

const TableCount = z.object({ name: z.string(), rows: z.number().int().nonnegative() });

/**
 * Result of the `export_data` operation (garderobe_command, after the owner confirms). The record is
 * never inline: it is stored privately and delivered by `downloadUrl`, a short-lived signed link that
 * also requires the owner's Garderobe sign-in (Access or the app's session) to open.
 */
export const ExportDownloadResult = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  exportId: OpaqueId,
  transferId: OpaqueId,
  exportedAt: Instant,
  expiresAt: Instant,
  delivery: z.literal('signed_link'),
  /** Present in the delivered result; opens only for the signed-in owner, until expiresAt. */
  downloadUrl: z.string().url().optional(),
  packageSha256: z.string(),
  complete: z.boolean(),
  incomplete: z.array(z.string()),
  tables: z.array(TableCount),
  summary: z.string(),
});
export type ExportDownloadResult = z.infer<typeof ExportDownloadResult>;

/** POST /v1/import/packages: a verified export staged privately for an import the owner confirms later. */
export const StagedImportPackage = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  packageId: OpaqueId,
  exportId: z.string(),
  exportedAt: z.string(),
  sourceDisplayName: z.string().nullable(),
  tables: z.array(TableCount),
  status: z.enum(['staged', 'imported', 'expired']),
  expiresAt: Instant,
});
export type StagedImportPackage = z.infer<typeof StagedImportPackage>;

/** Result of the `import_data` operation: the import service's result plus its effect on connections. */
export const McpImportResult = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  imported: z.literal(true),
  packageId: OpaqueId,
  exportId: z.string(),
  tables: z.array(TableCount),
  /** Connected assistants carried in the package: always restored revoked. */
  importedAssistantGrants: z.object({ count: z.number().int().nonnegative(), status: z.literal('revoked') }),
  /** Sign-in sessions are never part of an export and are never recreated. */
  sessionsRecreated: z.literal(0),
  /** The connection that asked for the import keeps working with the scopes the owner granted it. */
  callingGrant: z.object({ grantId: z.string().nullable(), status: z.literal('active'), note: z.string() }),
  summary: z.string(),
});
export type McpImportResult = z.infer<typeof McpImportResult>;

/**
 * Result of the `issue_recovery_kit` operation. The recovery code is not in this result: it is issued
 * only when the signed-in owner opens `collectUrl` in Garderobe (one time, until expiresAt).
 */
export const RecoveryKitLink = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  transferId: OpaqueId,
  expiresAt: Instant,
  delivery: z.literal('garderobe_link'),
  collectUrl: z.string().url().optional(),
  codeIncluded: z.literal(false),
  summary: z.string(),
});
export type RecoveryKitLink = z.infer<typeof RecoveryKitLink>;

/** GET /v1/auth/recovery-kit and garderobe_inventory view=recovery: metadata only, never the code. */
export const RecoveryStatus = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  hasActiveKit: z.boolean(),
  activeKitIssuedAt: Instant.nullable(),
  lastRecoveredAt: Instant.nullable(),
  failedAttemptsLast24h: z.number().int().nonnegative(),
  pendingCollection: z.object({ transferId: OpaqueId, expiresAt: Instant }).nullable(),
});
export type RecoveryStatus = z.infer<typeof RecoveryStatus>;

/** GET /v1/account/transfers and garderobe_inventory view=transfers: exports, staged imports, recovery links and their audit trail. */
export const AccountTransfers = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  transfers: z.array(
    z.object({
      transferId: OpaqueId,
      kind: z.enum(['export_download', 'import_package', 'recovery_kit_link']),
      status: z.string(),
      surface: z.string(),
      createdAt: Instant,
      expiresAt: Instant,
      completedAt: Instant.nullable(),
      summary: z.record(z.string(), z.unknown()),
    }),
  ),
  audit: z.array(
    z.object({
      auditId: OpaqueId,
      action: z.string(),
      surface: z.string(),
      grantRef: z.string().nullable(),
      idempotencyKey: z.string().nullable(),
      outcome: z.string(),
      detail: z.record(z.string(), z.unknown()),
      createdAt: Instant,
    }),
  ),
});
export type AccountTransfers = z.infer<typeof AccountTransfers>;
