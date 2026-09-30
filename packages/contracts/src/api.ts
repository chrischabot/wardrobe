import { z } from 'zod';
import { Category, GarmentRole, Instant, LocalDate, OpaqueId, StockBucket, TimeZone } from './enums.js';
import { Garment, GarmentAlias } from './garment.js';
import { Board, Selection } from './board.js';
import { WeatherSourceStatus } from './board-document.js';
import { DailyWear, LaundryBatch, LaundryRoutine, Restriction, StockBalance } from './stock.js';
import { AvailabilityEstimate } from './estimator.js';
import { CommandReceipt } from './receipt.js';
import { StyleDocument } from './style.js';
import { GarmentMedia } from './visual.js';
import { API_VERSION, CONTRACTS_VERSION } from './version.js';
import { TodayTrip } from './surface.js';

/**
 * HTTP API response shapes (spec section 13). The API/MCP workstream implements the routes;
 * these contracts are shared with the iOS app through the emitted JSON Schema.
 */

export const ApiError = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Human summaries such as "At the tailor" derived from the underlying facts. */
export const AvailabilitySummary = z.object({
  label: z.string(),
  available: z.boolean(),
  reasons: z.array(z.string()),
});
export type AvailabilitySummary = z.infer<typeof AvailabilitySummary>;

export const WardrobeItem = z.object({
  garment: Garment,
  aliases: z.array(GarmentAlias),
  stock: StockBalance,
  availability: AvailabilitySummary,
  lastRecordedWear: LocalDate.nullable(),
  recordedWearCount: z.number().int().nonnegative(),
  /** Catalogue image, supporting photos and thumbnail (additive; written by the HTTP API). Null when the garment has no image yet. */
  media: GarmentMedia.nullable().optional(),
});
export type WardrobeItem = z.infer<typeof WardrobeItem>;

export const WardrobeCounts = z.object({
  owned: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  incoming: z.number().int().nonnegative(),
  retired: z.number().int().nonnegative(),
});

export const WardrobePage = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  apiVersion: z.literal(API_VERSION),
  items: z.array(WardrobeItem),
  total: z.number().int().nonnegative(),
  /** True when items contains every matching record (no further page). */
  complete: z.boolean(),
  nextCursor: z.string().nullable(),
  counts: WardrobeCounts,
  asOf: Instant,
});
export type WardrobePage = z.infer<typeof WardrobePage>;

/** A board option the item appears in (item page "known combinations"). */
export const ItemCombination = z.object({
  boardId: OpaqueId,
  boardDate: LocalDate,
  boardRevision: z.number().int().positive(),
  optionId: OpaqueId,
  position: z.number().int().positive(),
  why: z.string().nullable(),
  garmentIds: z.array(OpaqueId),
});
export type ItemCombination = z.infer<typeof ItemCombination>;

export const ItemDetail = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  item: WardrobeItem,
  restrictions: z.array(Restriction),
  wearHistory: z.array(DailyWear),
  estimate: AvailabilityEstimate.nullable(),
  receipts: z.array(CommandReceipt),
  /** Options on today's (and later) published boards that include this item (additive). */
  combinations: z.array(ItemCombination).optional(),
});
export type ItemDetail = z.infer<typeof ItemDetail>;

export const SourceFreshness = z.object({
  source: z.enum(['wardrobe', 'weather', 'calendar', 'board']),
  status: z.enum(['fresh', 'stale', 'missing', 'unavailable']),
  observedAt: Instant.nullable(),
  revision: z.string().nullable(),
});

/**
 * Clothing weather for the day, flattened from the board document for simple clients. Values the
 * provider did not supply stay null (never guessed); `status` says whether the forecast is fresh.
 */
export const TodayWeather = z.object({
  locationLabel: z.string(),
  status: WeatherSourceStatus,
  observedAt: Instant.nullable(),
  /** Temperature at departure (answers the outerwear). */
  morningTempC: z.number().nullable(),
  /** Peak of the wearing interval (answers shirts, trousers, socks). */
  peakTempC: z.number().nullable(),
  /** Local HH:MM of the first likely rain, when any. */
  rainStartsAt: z.string().nullable(),
  /** Highest hourly precipitation probability, 0–1. */
  precipitationProbability: z.number().min(0).max(1).nullable(),
  rainAmountMm: z.number().nullable(),
  windKph: z.number().nonnegative().nullable(),
  gustKph: z.number().nonnegative().nullable(),
  /** Brief native line, e.g. "12 °C leaving, 18 °C later; rain after 4". */
  summary: z.string(),
  source: z.string(),
});
export type TodayWeather = z.infer<typeof TodayWeather>;

/**
 * A board garment with its display data, so the board renders without a wardrobe fetch. The HTTP API
 * always writes `aliases` and `media`; both are optional in the schema so clients built against the
 * iOS provisional shape (Garment + optional media) stay valid.
 */
export const BoardGarment = Garment.extend({
  /** Owner aliases and maker names (for search and "Ask about this"); the perceptible name is `name`. */
  aliases: z.array(z.string()).optional(),
  media: GarmentMedia.nullable().optional(),
});
export type BoardGarment = z.infer<typeof BoardGarment>;

export const TodayResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  date: LocalDate,
  timezone: TimeZone,
  board: Board.nullable(),
  selection: Selection.nullable(),
  recordedWears: z.array(DailyWear),
  sources: z.array(SourceFreshness),
  /** Present when fewer valid options exist than requested; one brief explanation. */
  shortfall: z.string().nullable(),
  /** Profile section 11 day line of the current revision (additive; written by the HTTP API). */
  dayLine: z.string().nullable().optional(),
  /** Weather of the board's wearing interval (additive). */
  weather: TodayWeather.nullable().optional(),
  /** Display data for every garment referenced by any option of the current revision (additive). */
  garments: z.array(BoardGarment).optional(),
  /** 'day' (home) or 'trip:<tripId>' during a packed trip, when the board is the trip-day board (additive). */
  purpose: z.string().optional(),
  /** The packed trip covering this date, when there is one (additive). */
  trip: TodayTrip.nullable().optional(),
});
export type TodayResponse = z.infer<typeof TodayResponse>;

// ------------------------------------------------------------------ settings, style, connected assistants

/** A consumer assistant's MCP grant (Claude, ChatGPT, ...). Listed per client; revocation is immediate. */
export const AssistantGrant = z.object({
  grantId: OpaqueId,
  client: z.enum(['claude', 'chatgpt', 'other']),
  clientId: z.string(),
  clientName: z.string(),
  /** Hostname the grant's tokens are delivered to. */
  redirectHost: z.string(),
  scopes: z.array(z.string()),
  canWrite: z.boolean(),
  status: z.enum(['active', 'revoked']),
  createdAt: Instant,
  lastUsedAt: Instant.nullable(),
  lastOperation: z.string().nullable(),
  revokedAt: Instant.nullable(),
});
export type AssistantGrant = z.infer<typeof AssistantGrant>;

export const ConnectionCapability = z.object({ name: z.string(), available: z.boolean(), missingPermission: z.string().nullable() });

export const ConnectionKindName = z.enum(['gmail', 'calendar', 'drive', 'sheets', 'search', 'browser', 'mcp', 'assistant_grant']);

/** Connection health without secrets (Settings > Connections and Connected assistants). */
export const Connection = z.object({
  connectionId: OpaqueId,
  kind: ConnectionKindName,
  displayName: z.string(),
  status: z.enum(['connected', 'needs_reauth', 'missing_permission', 'disconnected', 'error']),
  capabilities: z.array(ConnectionCapability),
  lastSuccessAt: Instant.nullable(),
  lastSuccessOperation: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Where to reconnect from a phone browser; never contains a credential. */
  reconnectUrl: z.string().nullable(),
  /** For assistant_grant: which consumer assistant holds the grant. */
  client: z.string().nullable(),
  scopes: z.array(z.string()),
  /** Credential-free endpoint for owner-added MCP connections. */
  endpoint: z.string().nullable().optional(),
  protocolVersion: z.string().nullable().optional(),
});
export type Connection = z.infer<typeof Connection>;

/** GET /v1/connections */
export const ConnectionsResponse = z.object({ schemaVersion: z.literal(CONTRACTS_VERSION), connections: z.array(Connection) });
export type ConnectionsResponse = z.infer<typeof ConnectionsResponse>;

/** POST /v1/connections: register an owner-chosen remote MCP server. Secrets are never echoed back. */
export const RegisterConnectionRequest = z.strictObject({
  name: z.string().min(1).max(80),
  endpoint: z.string().url().max(2000),
  allowedEffects: z.array(z.enum(['read', 'write'])).min(1).max(2).default(['read']),
  /**
   * Name of a Worker secret holding the remote server's bearer credential (e.g. EXA_API_KEY). The
   * value is resolved only at dispatch time and never returned. Phone-only OAuth for outbound
   * connections is not implemented yet.
   */
  credentialSecretName: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/).optional(),
  expectedIssuer: z.string().url().max(2000).optional(),
  dataClasses: z.array(z.string().max(40)).max(10).optional(),
});
export type RegisterConnectionRequest = z.infer<typeof RegisterConnectionRequest>;

/** POST /v1/connections/{id}/disconnect */
export const DisconnectResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  connectionId: z.string(),
  status: z.literal('disconnected'),
  cancelledCalls: z.number().int().nonnegative(),
  /** Outcome of revoking the credential at its issuer. */
  remoteRevocation: z.enum(['revoked', 'failed', 'not_supported', 'not_applicable']),
});
export type DisconnectResponse = z.infer<typeof DisconnectResponse>;

/** Summary of the owner's current style document (the full text is at GET /v1/style/current). */
export const StyleDocumentSummary = z.object({
  documentId: OpaqueId,
  title: z.string(),
  version: z.number().int().positive(),
  contentSha256: z.string(),
  byteLength: z.number().int().nonnegative(),
  authoredOn: LocalDate.nullable(),
});

export const SettingsResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  homeLocationLabel: z.string(),
  timezone: TimeZone,
  deliveryTime: z.string(),
  dailyOptionCount: z.number().int().min(3).max(5),
  laundryRoutine: LaundryRoutine,
  version: z.number().int().positive(),
  /** Outfit calendar used for the morning projection (additive). */
  calendarId: z.string().nullable().optional(),
  /** The owner's current style documents (additive). */
  styleDocuments: z.array(StyleDocumentSummary).optional(),
  /** Claude, ChatGPT and other consumer MCP grants, listed separately (additive). */
  connectedAssistants: z.array(AssistantGrant).optional(),
  /** Health of Gmail, Calendar and owner-added connections (additive). */
  connections: z.array(Connection).optional(),
  /** Effective model profile per task and whether it is simulated locally (additive). */
  models: z.object({ simulated: z.boolean(), profiles: z.record(z.string(), z.unknown()) }).optional(),
  budget: z.record(z.string(), z.unknown()).optional(),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

/** GET /v1/style/current: the full verbatim profile with its hash, for Settings > My style. */
export const StyleCurrentResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  document: StyleDocument,
  /** Every current document when the owner has more than one (the first is `document`). */
  documents: z.array(StyleDocument),
  rules: z.object({ active: z.number().int().nonnegative(), hard: z.number().int().nonnegative(), missingPassages: z.number().int().nonnegative() }),
});
export type StyleCurrentResponse = z.infer<typeof StyleCurrentResponse>;

export const CommandResponse = CommandReceipt;

/** GET /v1/receipts?cursor=&limit=: persistent receipt access, newest first. */
export const ReceiptsPage = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  receipts: z.array(CommandReceipt),
  nextCursor: z.string().nullable(),
});
export type ReceiptsPage = z.infer<typeof ReceiptsPage>;

// ------------------------------------------------------------------ wardrobe queries, laundry, temperature preview

/** Query parameters of GET /v1/wardrobe (all optional). */
export const WardrobeQueryParams = z.strictObject({
  /** Perceptible names, owner aliases, maker names and codes (e.g. PCF4340). */
  q: z.string().max(200).optional(),
  category: Category.optional(),
  availability: z.enum(['available', 'unavailable', 'incoming', 'retired', 'any']).optional(),
  colorFamily: z.string().max(40).optional(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).optional(),
  location: z.enum(['home', 'storage', 'tailor', 'repair', 'trip', 'consignment', 'in_transit', 'unknown']).optional(),
  /** Items whose last recorded wear is before this date, or that have no recorded wear. */
  lastWornBefore: LocalDate.optional(),
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type WardrobeQueryParams = z.infer<typeof WardrobeQueryParams>;

export const LaundryLine = z.object({
  garmentId: OpaqueId,
  name: z.string(),
  quantity: z.number().int().positive(),
  tracking: z.enum(['unit', 'anonymous_quantity']),
});
export type LaundryLine = z.infer<typeof LaundryLine>;

/** GET /v1/laundry: service laundry and hand wash kept separate; batches from actual membership. */
export const LaundryState = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  asOf: Instant,
  service: z.object({
    hamper: z.array(LaundryLine),
    batches: z.array(LaundryBatch.extend({ names: z.record(z.string(), z.string()) })),
    /** Next routine collection (local routine converted to an instant). */
    nextCollectionAt: Instant.nullable(),
  }),
  handWash: z.object({ hamper: z.array(LaundryLine) }),
  openExceptions: z
    .array(z.object({ exceptionId: OpaqueId, garmentId: OpaqueId, name: z.string(), kind: z.string(), quantity: z.number().int().positive(), batchId: OpaqueId.nullable(), occurredAt: Instant }))
    .optional(),
});
export type LaundryState = z.infer<typeof LaundryState>;

/** GET /v1/wardrobe/temperature-preview?temperatureC=: explicitly a simulation; it changes nothing. */
export const TemperaturePreview = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  simulation: z.literal(true),
  temperatureC: z.number(),
  basis: z.enum(['peak', 'departure']).optional(),
  items: z.array(
    z.object({
      garmentId: OpaqueId,
      name: z.string(),
      role: GarmentRole,
      wearable: z.boolean(),
      inStorage: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
  note: z.string(),
});
export type TemperaturePreview = z.infer<typeof TemperaturePreview>;

// ------------------------------------------------------------------ conversation

export const ConversationReference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('garment'), garmentId: OpaqueId }),
  z.object({ kind: z.literal('option'), boardId: OpaqueId, optionId: OpaqueId, boardRevision: z.number().int().positive() }),
]);
export type ConversationReference = z.infer<typeof ConversationReference>;

export const TurnIntent = z.enum(['chat', 'add_item', 'identify', 'what_i_wore']);

/** POST /v1/conversation/turns. A repeated clientTurnId returns the existing turn. */
export const TurnRequest = z
  .strictObject({
    clientTurnId: z.string().min(8).max(80).regex(/^[A-Za-z0-9:._\-]+$/),
    text: z.string().max(20000),
    attachmentIds: z.array(OpaqueId).max(10).default([]),
    references: z.array(ConversationReference).max(20).default([]),
    intent: TurnIntent.default('chat'),
    /** Only for intent what_i_wore: the owner explicitly asked to log it. A photo alone never authorizes a mutation. */
    explicitLog: z.boolean().default(false),
    sourceChannel: z.literal('app').default('app'),
    /** Stop the reply in progress and send this turn ("Stop and send"). */
    stopCurrent: z.boolean().optional(),
  })
  .refine((t) => t.text.trim().length > 0 || t.attachmentIds.length > 0, { message: 'A turn needs text or an attachment' });
export type TurnRequest = z.infer<typeof TurnRequest>;

export const TurnResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  clientTurnId: z.string(),
  /** The owner message id in the canonical transcript. */
  messageId: z.string(),
  runId: OpaqueId,
  /** existing: the backend already had this clientTurnId and returned the original turn. */
  status: z.enum(['accepted', 'existing', 'queued']),
  /**
   * Present when Garderobe removed a pasted secret (a recovery code, a token) from the message before
   * storing it (ADV-17): the same note the app shows as "Recovery code removed from your message".
   */
  notice: z
    .object({
      kind: z.literal('secret_removed'),
      title: z.string(),
      summary: z.string(),
      redacted: z.array(z.object({ kind: z.string(), count: z.number().int().positive() })),
    })
    .optional(),
});
export type TurnResponse = z.infer<typeof TurnResponse>;

export const SourceLink = z.object({ title: z.string(), url: z.string(), checkedAt: Instant.nullable() });

export const MessagePart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('outfit_card'),
    boardId: OpaqueId.nullable(),
    optionId: OpaqueId.nullable(),
    boardRevision: z.number().int().positive().nullable(),
    garmentIds: z.array(OpaqueId),
    explanation: z.string(),
    /** Actionable only when validated and tied to a board option. */
    validated: z.boolean(),
  }),
  z.object({ type: z.literal('sources'), sources: z.array(SourceLink) }),
  z.object({ type: z.literal('receipt'), commandId: OpaqueId, summary: z.string() }),
  z.object({ type: z.literal('reference'), reference: ConversationReference }),
  z.object({ type: z.literal('attachment'), uploadId: OpaqueId, contentType: z.string(), thumbnailUrl: z.string().nullable() }),
  z.object({ type: z.literal('result_card'), kind: z.string(), title: z.string(), summary: z.string(), jobRef: z.string() }),
]);
export type MessagePart = z.infer<typeof MessagePart>;

export const ConversationMessage = z.object({
  messageId: z.string(),
  clientTurnId: z.string().nullable(),
  role: z.enum(['user', 'assistant', 'system']),
  createdAt: Instant,
  /** app, web, conversation, mcp, system ... (metadata only). */
  sourceChannel: z.string(),
  status: z.enum(['complete', 'streaming', 'stopped', 'failed']),
  parts: z.array(MessagePart),
  runId: OpaqueId.nullable().optional(),
});
export type ConversationMessage = z.infer<typeof ConversationMessage>;

/** GET /v1/conversation/messages?before=<cursor>&limit=<n> (newest page when before is absent) or ?around=<messageId>. */
export const ConversationPage = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  messages: z.array(ConversationMessage),
  /** Cursor for the next older page. */
  before: z.string().nullable(),
  hasMore: z.boolean(),
  /** Cursor for newer messages when the page was requested with `around`. */
  after: z.string().nullable().optional(),
  activeRunId: OpaqueId.nullable(),
});
export type ConversationPage = z.infer<typeof ConversationPage>;

/** POST /v1/recall/search */
export const RecallSearchRequest = z.strictObject({
  query: z.string().min(1).max(500),
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  category: z.string().max(60).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type RecallSearchRequest = z.infer<typeof RecallSearchRequest>;

export const RecallSearchResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  query: z.string(),
  range: z.object({ from: z.string(), to: z.string() }).passthrough().nullable(),
  hits: z.array(
    z.object({
      messageId: z.string(),
      authoredAt: Instant,
      localDate: LocalDate,
      speaker: z.string(),
      quote: z.string(),
      judgments: z.array(z.object({ kind: z.string(), speaker: z.string(), subject: z.string(), quote: z.string() })),
      context: z.object({ before: z.string().nullable(), after: z.string().nullable() }),
      link: z.string(),
      score: z.number(),
    }),
  ),
  laterReversals: z.array(z.object({ kind: z.string(), subject: z.string(), quote: z.string(), authoredAt: z.string(), messageId: z.string() })),
  /** Index watermark: how much of the canonical transcript the search index has covered. */
  coverage: z.object({ sourceSeq: z.number(), indexedSeq: z.number(), exhaustive: z.boolean(), supplementedFromSource: z.number(), index: z.string() }),
  notes: z.array(z.string()),
});
export type RecallSearchResponse = z.infer<typeof RecallSearchResponse>;

// ------------------------------------------------------------------ runs and the SSE projection

export const RunState = z.enum(['queued', 'running', 'input_required', 'finished', 'cancelled', 'failed']);
export type RunState = z.infer<typeof RunState>;

/** A durable request for owner input (native question or MCP input_required); one record, both surfaces. */
export const PendingAction = z.object({
  pendingActionId: OpaqueId,
  prompt: z.string(),
  choices: z.array(z.object({ id: z.string(), label: z.string() })),
  status: z.enum(['pending', 'resolved', 'expired', 'cancelled']),
  expiresAt: Instant,
  /** The command the answer will execute, with its original idempotency key. */
  commandType: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
});
export type PendingAction = z.infer<typeof PendingAction>;

/** GET /v1/runs/{id}: durable progress or result; works after app closure or a lost stream. */
export const RunStatus = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  runId: OpaqueId,
  kind: z.string().optional(),
  status: RunState,
  lastEventId: z.string().nullable(),
  messageId: z.string().nullable(),
  message: ConversationMessage.nullable(),
  /** Receipts of commands this run committed (streamed prose never announces an uncommitted change). */
  receipts: z.array(CommandReceipt).optional(),
  pendingAction: PendingAction.nullable().optional(),
  createdAt: Instant.optional(),
  updatedAt: Instant.optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type RunStatus = z.infer<typeof RunStatus>;

/** POST /v1/runs/{id}/cancel: committed effects stay committed (undo is separate). */
export const CancelRunResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  runId: OpaqueId,
  status: RunState,
  committedEffects: z.array(z.object({ operation: z.string(), commandId: OpaqueId.nullable() })),
  stopped: z.array(z.string()),
});
export type CancelRunResponse = z.infer<typeof CancelRunResponse>;

/** Semantic run events for the SSE stream (section 13). Clients ignore unknown types. */
export const RunEventType = z.enum([
  'run_started',
  'activity',
  'text_delta',
  'outfit_board',
  'product_comparison',
  'sources',
  'command_receipt',
  'needs_input',
  'run_finished',
  /** Sent instead of replay when the Last-Event-ID has expired: the client replaces the message. */
  'snapshot',
]);
export const RunEvent = z.object({
  eventId: z.string(),
  runId: OpaqueId,
  type: z.union([RunEventType, z.string()]),
  at: Instant,
  data: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEvent>;

/** `RunEvent.data` payload per event type (the SSE `data:` line is a whole RunEvent). */
export const RunEventPayloads = {
  run_started: z.object({ messageId: z.string(), clientTurnId: z.string().nullable() }),
  activity: z.object({ text: z.string() }),
  text_delta: z.object({ messageId: z.string(), delta: z.string() }),
  outfit_board: z.object({ messageId: z.string(), card: MessagePart }),
  product_comparison: z.object({ messageId: z.string(), comparison: z.record(z.string(), z.unknown()) }),
  sources: z.object({ messageId: z.string(), sources: z.array(SourceLink) }),
  command_receipt: z.object({ receipt: CommandReceipt }),
  needs_input: z.object({ prompt: z.string(), choices: z.array(z.object({ id: z.string(), label: z.string() })), pendingActionId: OpaqueId.optional() }),
  run_finished: z.object({ messageId: z.string().nullable(), status: z.enum(['finished', 'cancelled', 'failed']), message: ConversationMessage.nullable() }),
  snapshot: z.object({ message: ConversationMessage.nullable(), status: RunState }),
} as const;

// ------------------------------------------------------------------ native app authentication (public PKCE client)

/** POST /v1/auth/native/token response (RFC 6749 shape). No client secret is ever involved. */
export const NativeTokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string(),
  scope: z.string(),
});
export type NativeTokenResponse = z.infer<typeof NativeTokenResponse>;

/** GET /v1/auth/session: who the app is signed in as (no internal identifiers beyond display data). */
export const SessionResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  displayName: z.string(),
  authenticatedBy: z.enum(['access', 'native_token']),
  scopes: z.array(z.string()),
  expiresAt: Instant.nullable(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export { StockBucket };
