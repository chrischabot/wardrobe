import { z } from 'zod';
import {
  AliasResolution,
  BoardDocument,
  CommandReceipt,
  CONTRACTS_VERSION,
  CreateTripRequest,
  DailyWear,
  DomainCommand,
  EmailSyncRequest,
  ExpectedVersion,
  GarmentRole,
  ItemDetail,
  OperationReceipt,
  PackingRequest,
  RunStatus,
  TodayResponse,
  TurnResponse,
  WardrobeItem,
} from '@garderobe/contracts';

/** Input and output schemas of the seven Garderobe MCP tools (zod; the SDK publishes them as JSON Schema). */

export const TodayInput = z.strictObject({
  date: z.iso.date().optional().describe('Local date (YYYY-MM-DD); defaults to today in the owner’s timezone'),
});
export const TodayOutput = TodayResponse;

const INVENTORY_VIEWS = ['items', 'item', 'history', 'snapshot', 'resolve', 'trips', 'trip', 'orders', 'returns', 'projects', 'combinations', 'comfort', 'pause', 'recovery', 'transfers'] as const;

export const InventoryInput = z.strictObject({
  view: z
    .enum(INVENTORY_VIEWS)
    .describe(
      'items: search/filter; item: one garment with facts, restrictions, wears and receipts; history: recorded wears; snapshot: the complete inventory; resolve: map an owner phrase to a garment; trips / trip (tripId): trips and what is packed; orders: orders with lines and sourced return deadlines; returns: open return deadlines; projects: tailoring, sale, consignment and other lifecycle projects; combinations: saved Studio combinations and plans; comfort: comfort reports (garmentId optional); pause: whether Garderobe is paused; recovery: whether a recovery code exists and when it was issued (never the code); transfers: exports, import packages the owner staged in Garderobe (their packageId) and recovery links, with the audit trail',
    ),
  tripId: z.string().min(3).max(80).optional(),
  q: z.string().max(200).optional().describe('Names, owner aliases, maker names or codes'),
  category: z.string().max(40).optional(),
  availability: z.enum(['available', 'unavailable', 'incoming', 'retired', 'any']).optional(),
  garmentId: z.string().min(3).max(80).optional(),
  phrase: z.string().min(1).max(200).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export const InventoryOutput = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  view: z.enum(INVENTORY_VIEWS),
  asOf: z.string(),
  /** True only when every matching record is included (no further page). */
  complete: z.boolean(),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  counts: z.object({ owned: z.number(), available: z.number(), incoming: z.number(), retired: z.number() }).nullable(),
  items: z.array(WardrobeItem),
  item: ItemDetail.nullable(),
  wears: z.array(DailyWear),
  resolution: AliasResolution.nullable(),
  /** Records of the trips, trip, orders, returns, projects, combinations, comfort, pause, recovery and transfers views. */
  records: z.array(z.record(z.string(), z.unknown())).optional(),
  sources: z.array(z.object({ source: z.string(), observedAt: z.string() })),
});

export const RecommendToolInput = z.strictObject({
  date: z.iso.date().optional(),
  count: z.number().int().min(1).max(10).optional().describe('How many outfits (it changes how many are shown, never which garments qualify)'),
  brief: z.string().max(2000).optional().describe('The day in the owner’s words'),
  occasion: z.enum(['formal', 'travel', 'dinner', 'outdoor']).optional(),
  include: z.array(z.string().min(3).max(80)).max(10).optional().describe('Garment ids every option must contain'),
  exclude: z.array(z.string().min(3).max(80)).max(30).optional(),
});
export const RecommendOutput = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  date: z.string(),
  document: BoardDocument,
  options: z.array(
    z.object({
      optionId: z.string(),
      position: z.number().int(),
      slots: z.array(z.object({ garmentId: z.string(), name: z.string(), role: GarmentRole, alternativeGroup: z.string().nullable() })),
      why: z.string(),
      valid: z.literal(true),
      jointAvailability: z.number(),
    }),
  ),
  shortfall: z.string().nullable(),
  preparedBoard: z.object({ boardId: z.string(), revision: z.number().int() }).nullable(),
});

/** Service operations reachable through garderobe_command (same policy: owner from the grant, write scope, idempotency key). */
export const OperationInput = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('create_trip'), ...CreateTripRequest.shape }),
  z.strictObject({ type: z.literal('propose_packing'), tripId: z.string().min(3).max(80) }),
  z.strictObject({ type: z.literal('mark_packed'), tripId: z.string().min(3).max(80), ...PackingRequest.shape }),
  z.strictObject({ type: z.literal('mark_unpacked'), tripId: z.string().min(3).max(80), ...PackingRequest.shape }),
  z.strictObject({ type: z.literal('sync_email'), ...EmailSyncRequest.shape }),
  z.strictObject({ type: z.literal('export_data') }).describe('Export the owner’s complete record after the owner confirms; returns a short-lived private download link (never the record itself)'),
  z
    .strictObject({ type: z.literal('import_data'), packageId: z.string().min(3).max(80).regex(/^pkg_[A-Za-z0-9]+$/).describe('A package the owner staged in Garderobe (garderobe_inventory view=transfers)') })
    .describe('Import a staged export into an empty Garderobe after the owner confirms'),
  z.strictObject({ type: z.literal('issue_recovery_kit') }).describe('After the owner confirms, prepare a new recovery code that the owner collects in Garderobe through a one-time link; the code never appears here'),
]);

export const CommandToolInput = z.strictObject({
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .regex(/^[A-Za-z0-9:._\-]+$/)
    .describe('Stable per intended change: resending the same key and command returns the original receipt instead of repeating the change'),
  command: DomainCommand.optional().describe('A typed domain command (record_wear, mark_in_wash, pause_service, …). Give exactly one of command or operation'),
  operation: OperationInput.optional().describe('A service operation: create_trip, propose_packing, mark_packed, mark_unpacked, sync_email, export_data, import_data, issue_recovery_kit'),
  expectedVersions: z.array(ExpectedVersion).max(100).optional().describe('Versions the change was planned against; a stale edit returns a conflict'),
});
export const CommandToolOutput = z.object({
  status: z.enum(['executed', 'proposal', 'declined', 'expired', 'awaiting_owner']),
  /** The verified receipt (committed, merged, rejected or conflict). Null for a proposal or declined request. */
  receipt: CommandReceipt.nullable(),
  /** For a read-only connection: the validated command the owner can confirm in Garderobe. Nothing changed. */
  proposal: z.object({ command: z.record(z.string(), z.unknown()), reason: z.string() }).nullable(),
  runId: z.string().nullable(),
  /** The result of a service operation (trips, email sync, export link, import, recovery link), with its idempotency record. */
  operation: OperationReceipt.nullable().optional(),
  /**
   * status=awaiting_owner: nothing has run yet. The owner confirms in Garderobe (confirmUrl, signed-in
   * only, or the app); then the same call with the same idempotencyKey returns the result.
   */
  confirmation: z.object({ prompt: z.string(), confirmUrl: z.string(), expiresAt: z.string() }).optional(),
});

export const AskInput = z.strictObject({
  text: z.string().min(1).max(20_000).describe('The owner’s request, in their words'),
  clientTurnId: z.string().min(8).max(80).regex(/^[A-Za-z0-9:._\-]+$/).optional().describe('Stable id for this message; resending it returns the existing turn'),
  conversation: z.string().max(120).optional().describe('Conversation handle returned by an earlier garderobe_ask'),
  waitSeconds: z.number().int().min(0).max(50).optional().describe('How long to wait for the answer before returning a run id (default 25)'),
});
export const AskOutput = z.object({
  status: z.enum(['answered', 'running', 'failed', 'cancelled']),
  runId: z.string(),
  clientTurnId: z.string(),
  conversation: z.string(),
  answer: z.string().nullable(),
  receipts: z.array(CommandReceipt),
  blocked: z.array(z.object({ family: z.string(), reason: z.string() })),
  /** Garderobe removed a pasted secret (a recovery code, a token) from this message before storing or sending it. */
  notice: TurnResponse.shape.notice,
});

export const ResearchInput = z.strictObject({
  kind: z.enum(['product', 'size', 'verdict', 'topic']),
  url: z.string().url().max(2000).optional(),
  size: z.string().max(40).optional(),
  colour: z.string().max(60).optional(),
  maker: z.string().max(120).optional(),
  category: z.enum(['jacket', 'coat', 'shirt', 'trousers', 'jeans', 'footwear', 'rugby', 'knitwear']).optional(),
  description: z.string().max(2000).optional(),
  question: z.string().max(4000).optional().describe('For kind=topic: a history, provenance or fit question answered by the assistant'),
  waitSeconds: z.number().int().min(0).max(50).optional().describe('For kind=topic: how long to wait for the answer before returning a run id to follow with garderobe_run (default 25)'),
});
export const ResearchOutput = z.object({
  kind: z.enum(['product', 'size', 'verdict', 'topic']),
  /** For kind=topic: answered (result.answer holds it), running (follow `next`), failed or cancelled. */
  status: z.string(),
  result: z.record(z.string(), z.unknown()),
  runId: z.string().nullable(),
  /** When status is running: the exact call that fetches the answer once it is ready. */
  next: z
    .object({
      tool: z.literal('garderobe_run'),
      arguments: z.object({ runId: z.string(), action: z.literal('status') }),
      instruction: z.string(),
    })
    .optional(),
});

export const RunInput = z.strictObject({
  runId: z.string().min(5).max(90),
  action: z.enum(['status', 'respond', 'cancel']).default('status'),
  choice: z.string().max(80).optional().describe('For action=respond: the id of the chosen answer'),
});
export const RunOutput = RunStatus;
