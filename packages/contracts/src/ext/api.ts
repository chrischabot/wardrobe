/**
 * @garderobe/contracts/ext/api - the versioned HTTP API (`/v1`) and MCP tool contract.
 *
 * Owned by the api-mcp-identity workstream. This file is the single place where the wire shapes the
 * iOS client, the private web board, MCP consumers and the test/simulation threads use are agreed.
 * Specification sections 13 and 15.
 *
 * It reuses the other workstreams' contracts and never redefines them: boards, today, trips, pause,
 * weather (`ext/daily`); transcript, recall, orders, returns, lifecycle, feedback, inference overview
 * (`ext/assistant`); garment media, uploads, Studio (`ext/media`). Only route envelopes and the objects
 * this workstream owns (errors, identity, recovery, runs, connections as the phone sees them, connected
 * assistants, export/import, MCP tool inputs and outputs) are defined here.
 *
 * Conventions (all routes):
 *  - JSON bodies; every response carries `X-Garderobe-Api: v1` and `X-Garderobe-Contract: <CONTRACT_VERSION>`.
 *  - The owner is ALWAYS derived from the authenticated connection (Access assertion or MCP grant). No
 *    request field names an owner.
 *  - Errors: non-2xx with body `ApiErrorResponse` = `{ "error": { code, message, details } }`.
 *  - Clients must tolerate unknown fields and unknown event types.
 *  - Instants are UTC ISO 8601 (`Instant`), civil dates are `LocalDate` in the owner's timezone.
 */
import { z } from "zod";
import { GarmentAvailability } from "../availability.ts";
import { CommandEnvelope, CommandErrorCode, CommandReceipt, GarmentSelector } from "../commands.ts";
import { GarmentDetail } from "../inventory.ts";
import { Role } from "../garment.ts";
import { Channel, Instant, LocalDate, Scope } from "../primitives.ts";
import { OwnerSettings } from "../settings.ts";
import { StyleFactConflict } from "../style.ts";
import { ComfortFeedback, InferenceOverview, LifecycleProject, Order, ReturnCase, TranscriptPage } from "./assistant.ts";
import { BoardDocument, BoardOption, PauseState, TodayView, Trip } from "./daily.ts";
import { GarmentMedia, MediaAsset, PhotosNeededItem, StudioCombination, StudioDayPlan, StudioMode, StudioSelectors, StudioSlot, StudioSuggestion, UploadAuthorization, UploadContentType, UploadIntent } from "./media.ts";

/* ================================================================== */
/* Route manifest                                                       */
/* ================================================================== */

/**
 * Trust boundary of a route (specification section 15, "route manifest").
 *  - `access`: requires a verified Cloudflare Access assertion mapped to an active internal user.
 *  - `access_identity`: requires a verified Access assertion, but the identity need not be linked yet
 *    (owner claim, recovery, link completion). Never grants data access by itself.
 *  - `mcp_oauth`: under the Workers OAuth provider on the MCP hostname/path; requires its grant.
 *  - `oauth_public`: OAuth/MCP discovery, token (and RFC 7009 revocation) and registration endpoints.
 *  - `one_time_state`: authenticated only by stored, expiring, single-use state (provider OAuth callback).
 *  - `ticket`: a short-lived single-use ticket issued to an authenticated owner (download, upload bytes).
 */
export const RouteTrust = z.enum(["access", "access_identity", "mcp_oauth", "oauth_public", "one_time_state", "ticket"]);
export type RouteTrust = z.infer<typeof RouteTrust>;

export interface RouteSpec {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly trust: RouteTrust;
  /** Scope required of the principal (`null` for identity-only and protocol routes). */
  readonly scope: Scope | null;
  /** Names of the exported schemas (this file, the core contracts or a lane's ext file) for request and response. */
  readonly request: string | null;
  readonly response: string;
  readonly purpose: string;
}

const r = (method: RouteSpec["method"], path: string, trust: RouteTrust, scope: Scope | null, request: string | null, response: string, purpose: string): RouteSpec => ({ method, path, trust, scope, request, response, purpose });

/** Every route the Worker serves. The Worker's router is tested against this manifest: no route exists outside it. */
export const API_ROUTES: readonly RouteSpec[] = [
  // Session and identity
  r("GET", "/v1/meta", "access", "read", null, "MetaResponse", "API/contract versions, mounted modules, server time"),
  r("GET", "/v1/me", "access", "read", null, "MeResponse", "The signed-in owner, linked identities and recovery-kit presence"),
  // Daily surfaces
  r("GET", "/v1/today", "access", "read", "TodayQuery", "TodayResponse", "Current board and selected outfit with source freshness, revision and eligible options"),
  r("POST", "/v1/recommendations", "access", "write", "RecommendRequest", "RecommendResponse", "Request outfits with a brief, date and count: validated options (or a durable run)"),
  r("POST", "/v1/boards/{id}/swap", "access", "write", "SwapSlotRequest", "SwapSlotResponse", "Swap one slot of a board option; a forecast past its freshness threshold is refreshed first"),
  r("GET", "/v1/days/{date}", "access", "read", null, "DailyRecord", "What was actually worn on a wearing date"),
  r("GET", "/v1/weather", "access", "read", "WeatherQuery", "WeatherSnapshot", "Weather detail behind the board's weather line"),
  r("GET", "/v1/service", "access", "read", null, "ServiceState", "Pause/resume state of the daily service"),
  r("GET", "/v1/trips", "access", "read", null, "TripList", "Trips with proposed and packed quantities"),
  r("GET", "/v1/trips/{id}", "access", "read", null, "Trip", "One trip with its packing proposal and packed quantities"),
  r("POST", "/v1/trips/{id}/packing-proposal", "access", "write", "ClientRequest", "PackingProposal", "Propose a compact packing list (distinct from packed quantities)"),
  // Wardrobe
  r("GET", "/v1/wardrobe", "access", "read", "InventoryQuery", "InventoryPage", "Search or retrieve the complete inventory; explicit total, pagination, completeness"),
  r("GET", "/v1/wardrobe/resolve", "access", "read", "ResolveQuery", "AliasResolution", "Resolve an owner phrase to garments without guessing"),
  r("POST", "/v1/wardrobe/selection", "access", "read", "GarmentSelector", "GarmentSelection", "The garments a bulk edit with this selector would touch (no mutation); send its count as expectedCount of garment.bulk_correct"),
  r("GET", "/v1/wardrobe/temperature-preview", "access", "read", "TemperaturePreviewQuery", "TemperaturePreview", "Simulation: what becomes wearable at a temperature (never changes availability)"),
  r("GET", "/v1/availability", "access", "read", "AvailabilityQuery", "AvailabilitySnapshot", "Probabilistic availability for a date"),
  r("GET", "/v1/items/{id}", "access", "read", null, "ItemResponse", "An item with its facts, availability, media and known combinations"),
  r("GET", "/v1/items/{id}/image", "access", "read", "ImageQuery", "binary", "The garment's preferred display image; 404 when no real image exists"),
  r("GET", "/v1/laundry", "access", "read", null, "LaundryStateResponse", "Service laundry and hand-wash state with batch membership"),
  r("GET", "/v1/style", "access", "read", "AvailabilityQuery", "StyleContext", "Profile, amendments, rules, directions, open fact conflicts, and the briefs for a date (default: the owner's local today)"),
  r("POST", "/v1/style/preview-save", "access", "read", "StylePreviewSaveRequest", "StyleFactDiff", "What saving this profile text would do to the structured facts (no mutation); shown before Save in My style"),
  r("GET", "/v1/style/conflicts", "access", "read", "StyleConflictsQuery", "StyleConflictList", "Conflicts between the saved profile text and structured facts; open by default"),
  // Studio
  r("GET", "/v1/studio", "access", "read", "StudioQuery", "StudioResponse", "Studio selectors, opening outfit, saved combinations and day plans"),
  r("POST", "/v1/studio/validate", "access", "read", "StudioOutfitRequest", "StudioValidation", "Authoritative validation of a composed combination (no mutation)"),
  r("POST", "/v1/studio/suggest", "access", "read", "StudioOutfitRequest", "StudioSuggestResponse", "Find something that works with the locked pieces (no mutation)"),
  r("POST", "/v1/studio/compose", "access", "read", "StudioComposeRequest", "Composition", "Composition manifest for an outfit from the actual garment assets"),
  r("POST", "/v1/studio/previews", "access", "write", "StudioPreviewRequest", "StudioPreviewResponse", "Ask for a rendered preview of a composition (queued job); returns the manifest hash"),
  r("GET", "/v1/studio/compositions/{id}", "access", "read", null, "Composition", "A composition by manifest hash, with the state of its preview"),
  r("GET", "/v1/studio/compositions/{id}/preview", "access", "read", null, "binary", "The rendered preview (PNG); 404 until it is rendered"),
  // Commands
  r("POST", "/v1/commands", "access", "write", "CommandEnvelope", "CommandReceipt", "Execute a typed domain change with idempotency key and expected versions"),
  r("POST", "/v1/commands/batch", "access", "write", "CommandBatchRequest", "CommandBatchResponse", "Offline replay: ordered, independent submissions, one result each"),
  r("GET", "/v1/commands", "access", "read", "ReceiptListQuery", "ReceiptList", "Receipts for an entity, by idempotency key, or the most recent"),
  r("GET", "/v1/commands/{id}", "access", "read", null, "CommandReceipt", "A stored receipt by command ID"),
  r("GET", "/v1/command-types", "access", "read", null, "CommandTypeList", "Registered command types with payload JSON Schema, class and scope"),
  // Conversation, recall, research, projects
  r("POST", "/v1/conversation/turns", "access", "write", "TurnRequest", "TurnResponse", "Append to the owner's continuous conversation (stable client turn ID)"),
  r("GET", "/v1/conversation/messages", "access", "read", "MessagesQuery", "TranscriptPage", "Page the canonical transcript"),
  r("POST", "/v1/recall/search", "access", "read", "RecallQuery", "RecallResult", "Search dated conversations and personal judgments"),
  r("POST", "/v1/research", "access", "write", "StartResearchRequest", "StartResearchResponse", "Start a product, fit or history investigation (durable run)"),
  r("GET", "/v1/orders", "access", "read", null, "OrderList", "Orders and order lines (purchase sources)"),
  r("GET", "/v1/returns", "access", "read", null, "ReturnList", "Return and exchange cases with sourced deadlines"),
  r("GET", "/v1/projects", "access", "read", null, "ProjectList", "Lifecycle projects (tailoring, consignment, disposal...)"),
  r("GET", "/v1/feedback", "access", "read", "FeedbackQuery", "FeedbackList", "Optional comfort feedback already recorded"),
  // Runs
  r("GET", "/v1/runs/{id}", "access", "read", null, "Run", "Durable progress or result"),
  r("GET", "/v1/runs/{id}/events", "access", "read", "RunEventsQuery", "RunEvent (text/event-stream)", "Server-sent events with ordered event IDs"),
  r("POST", "/v1/runs/{id}/cancel", "access", "write", null, "RunCancelResponse", "Cancel remaining work; returns committed effects and what was stopped"),
  r("POST", "/v1/runs/{id}/resume", "access", "write", null, "Run", "Run again a run that failed with error.resumable = true (budget, no usable model, provider outage); committed changes are not repeated"),
  r("POST", "/v1/runs/{id}/input", "access", "write", "RunInputRequest", "Run", "Answer a needs_input request (same pending-action record as MCP input_required)"),
  // Media
  r("POST", "/v1/uploads", "access", "write", "UploadRequest", "UploadAuthorizationResponse", "Authorize a bounded media upload"),
  r("GET", "/v1/uploads/{id}", "access", "read", null, "UploadStatus", "State of an upload"),
  r("PUT", "/v1/uploads/{id}/content", "ticket", null, "binary", "UploadContentResponse", "Upload target named by the authorization (token bound to owner, upload, type and size)"),
  r("POST", "/v1/uploads/{id}/complete", "access", "write", null, "UploadCompleteResponse", "Validate and finalize an upload"),
  r("GET", "/v1/media/renditions/{id}", "access", "read", "ImageQuery", "binary", "Owner-scoped private rendition bytes"),
  r("GET", "/v1/media/assets/{id}", "access", "read", "AssetImageQuery", "binary", "Owner-scoped private asset image (variant selectable)"),
  r("GET", "/v1/media/photos-needed", "access", "read", null, "PhotosNeededList", "Items research could not resolve an image for"),
  r("GET", "/v1/media/review", "access", "read", null, "MediaReview", "Image candidates awaiting the owner's decision"),
  // Connections (third-party accounts and outbound MCP)
  r("GET", "/v1/connections", "access", "read", null, "ApiConnectionList", "Connection health and capabilities, never secrets"),
  r("POST", "/v1/connections", "access", "admin", "RegisterConnectionRequest", "RegisterConnectionResponse", "Register a connection: endpoint validation, auth flow, capability policy"),
  r("POST", "/v1/connections/{id}/reconnect", "access", "admin", "ReconnectRequest", "RegisterConnectionResponse", "Begin re-authorization of an existing connection"),
  r("POST", "/v1/connections/{id}/capabilities", "access", "admin", "ConnectionCapabilitiesRequest", "ApiConnection", "Change the capabilities the assistant may use"),
  r("POST", "/v1/connections/{id}/disconnect", "access", "admin", null, "DisconnectResponse", "Revoke local access, stop future calls, report remote revocation outcome"),
  r("GET", "/v1/connections/{id}/calendars", "access", "read", null, "ConnectionCalendarList", "The owner's calendars (first use: choose which are read for the day; shows the outfit calendar)"),
  r("POST", "/v1/connections/{id}/outfit-calendar", "access", "admin", "OutfitCalendarRequest", "OutfitCalendarResponse", "Create (once) the dedicated outfit calendar and record it in settings"),
  r("GET", "/connections/callback", "one_time_state", null, "ConnectionCallbackQuery", "text/html", "Provider OAuth callback; authenticated by stored expiring state only"),
  // Settings, connected assistants, recovery screen
  r("GET", "/v1/settings", "access", "read", null, "SettingsResponse", "Profile and delivery configuration, effective model profile, budget, version"),
  r("GET", "/v1/assistants", "access", "read", null, "AssistantGrantList", "Connected assistants (MCP grants) with permissions and last use"),
  r("POST", "/v1/assistants/{id}/disconnect", "access", "admin", null, "AssistantGrant", "Revoke an MCP grant immediately"),
  r("GET", "/v1/devices", "access", "read", null, "DeviceList", "Devices registered for notifications, and whether delivery is configured"),
  r("POST", "/v1/devices", "access", "write", "DeviceRegistration", "Device", "Register or refresh this device's notification token (never returned)"),
  r("POST", "/v1/devices/{id}/remove", "access", "write", null, "DeviceRemoved", "Stop notifications to a device"),
  r("GET", "/v1/recovery", "access", "read", null, "RecoveryStatus", "Recovery screen: last board, last confirmed Calendar projection, pending work, connection issues"),
  // Identity, recovery kit, account
  r("POST", "/v1/identities/link", "access", "admin", null, "IdentityLinkTicket", "Authenticated owner starts linking a second identity"),
  r("POST", "/v1/identities/unlink", "access", "admin", "IdentityUnlinkRequest", "MeResponse", "Unlink an identity (never deletes the wardrobe)"),
  r("POST", "/v1/recovery-kit", "access", "admin", null, "RecoveryKitIssued", "Issue (or rotate) the one-time recovery credential; shown once"),
  r("POST", "/v1/sessions/revoke", "access", "admin", null, "SessionsRevoked", "Sign out everywhere: refuse sessions authenticated before now"),
  r("POST", "/v1/account/delete", "access", "admin", "AccountDeleteRequest", "AccountDeleteResponse", "Account deletion: separate, confirmed, two-step operation"),
  // Dedicated authentication routes (verified Access identity that is not yet linked)
  r("POST", "/auth/claim", "access_identity", null, "ClaimRequest", "MeResponse", "Claim the invited owner account with a one-time invitation code"),
  r("POST", "/auth/link/complete", "access_identity", null, "IdentityLinkCompleteRequest", "MeResponse", "Bind the presenting identity using a link ticket issued to the owner"),
  r("POST", "/auth/recovery/start", "access_identity", null, null, "RecoveryTransaction", "Open an expiring recovery transaction bound to the presenting identity"),
  r("POST", "/auth/recovery/complete", "access_identity", null, "RecoveryCompleteRequest", "RecoveryCompleteResponse", "Prove possession of the recovery credential and bind the identity"),
  // Portable export and import
  r("POST", "/v1/exports", "access", "admin", "ExportRequest", "ExportJob", "Start (or resume) a portable export job"),
  r("GET", "/v1/exports", "access", "admin", null, "ExportList", "Export jobs of this owner"),
  r("GET", "/v1/exports/{id}", "access", "admin", null, "ExportJob", "Export job state, components and manifest summary"),
  r("POST", "/v1/exports/{id}/ticket", "access", "admin", null, "DownloadTicket", "Issue a short-lived single-use download ticket"),
  r("GET", "/v1/exports/{id}/download", "ticket", null, "DownloadQuery", "binary", "Download the package with a ticket"),
  r("POST", "/v1/imports", "access", "admin", "binary", "ImportJob", "Import a portable package into this (empty) owner"),
  r("GET", "/v1/imports/{id}", "access", "admin", null, "ImportJob", "Import job state and per-component outcome"),
  // Backups and restore
  r("GET", "/v1/backups", "access", "admin", null, "BackupList", "Backups of this owner with their restore manifests"),
  r("POST", "/v1/backups", "access", "admin", "ClientRequest", "Backup", "Take a backup now (one is taken daily by the scheduled sweep)"),
  r("POST", "/v1/backups/{id}/ticket", "access", "admin", null, "DownloadTicket", "Short-lived single-use download ticket for a backup package (downloaded through /v1/exports/{id}/download)"),
  r("GET", "/v1/backups/tombstones", "access", "admin", null, "TombstoneJournal", "Current deletion tombstones, replayed when an older backup is restored"),
  r("POST", "/v1/restore/verify", "access", "admin", "RestoreVerifyRequest", "RestoreReport", "After importing a backup: replay tombstones, rebuild indexes and compare the owner with the restore manifest"),
  // Private web board (cookie session through Access)
  r("GET", "/board", "access", "read", null, "text/html", "Private web board for today"),
  r("GET", "/board/{date}", "access", "read", null, "text/html", "Private web board for a date; option anchors use stable option IDs"),
  // MCP authorization (consent UI under Access; protocol endpoints under the Workers OAuth provider)
  r("GET", "/oauth/authorize", "access", "admin", "OAuth authorization request", "text/html", "Consent page: shows the requesting client and requested read/write capabilities"),
  r("POST", "/oauth/authorize", "access", "admin", "consent form", "302", "Record an explicit grant or denial for the one-time consent transaction"),
  r("POST", "/oauth/token", "oauth_public", null, "OAuth token or RFC 7009 revocation request", "OAuth response", "Token endpoint (authorization code with PKCE, refresh rotation) and revocation"),
  r("POST", "/oauth/register", "oauth_public", null, "RFC 7591", "RFC 7591", "Dynamic client registration (consumer compatibility only)"),
  r("GET", "/.well-known/oauth-authorization-server", "oauth_public", null, null, "RFC 8414", "Authorization server metadata"),
  r("GET", "/.well-known/oauth-protected-resource", "oauth_public", null, null, "RFC 9728", "Protected resource metadata for the MCP endpoint"),
  r("POST", "/mcp", "mcp_oauth", "read", "MCP JSON-RPC", "MCP JSON-RPC", "MCP server (2026-07-28, stateless; 2025-11-25 compatibility fallback)"),
] as const;

/* ================================================================== */
/* Errors                                                               */
/* ================================================================== */

export const ApiErrorCode = z.enum([
  ...CommandErrorCode.options,
  "unauthenticated", // 401: no valid assertion/grant
  "identity_not_linked", // 403: verified identity that maps to no user (use /auth/claim, /auth/link/complete or recovery)
  "account_disabled", // 403
  "session_revoked", // 401: the session predates a recovery/revocation; sign in again
  "grant_revoked", // 401: the MCP grant was disconnected
  "rate_limited", // 429
  "expired", // 410: transaction, ticket or cursor expired
  "payload_too_large", // 413
  "unsupported_media_type", // 415
  "module_unavailable", // 501: a backend module is not mounted in this build
  "confirmation_required", // 409: a consequential account operation needs its confirmation step
  "unrecoverable", // 403: neither a linked identity nor a valid recovery credential; no override exists
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  code: ApiErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ApiError = z.infer<typeof ApiError>;

export const ApiErrorResponse = z.object({ error: ApiError });
export type ApiErrorResponse = z.infer<typeof ApiErrorResponse>;

/** HTTP status for each error code. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid_command: 400,
  unknown_command: 400,
  forbidden: 403,
  not_found: 404,
  ambiguous_target: 409,
  conflict: 409,
  idempotency_key_reuse: 409,
  precondition_failed: 409,
  not_undoable: 409,
  internal: 500,
  unauthenticated: 401,
  identity_not_linked: 403,
  account_disabled: 403,
  session_revoked: 401,
  grant_revoked: 401,
  rate_limited: 429,
  expired: 410,
  payload_too_large: 413,
  unsupported_media_type: 415,
  module_unavailable: 501,
  confirmation_required: 409,
  unrecoverable: 403,
};

/** A body that only carries a stable client request ID (a retransmission returns the same result). */
export const ClientRequest = z.object({ clientRequestId: z.string().min(8).max(128) });

/* ================================================================== */
/* Session and identity                                                 */
/* ================================================================== */

export const ModuleName = z.enum(["foundation", "daily", "assistant", "media"]);
export type ModuleName = z.infer<typeof ModuleName>;

export const MetaResponse = z.object({
  apiVersion: z.literal("v1"),
  contractVersion: z.string(),
  serverTime: Instant,
  environment: z.string().describe("Deployment environment name, e.g. local, dev."),
  modules: z.array(z.object({ name: ModuleName, mounted: z.boolean() })),
  mcp: z.object({ endpoint: z.string(), protocolVersions: z.array(z.string()), authorizationServer: z.string() }),
});
export type MetaResponse = z.infer<typeof MetaResponse>;

export const LinkedIdentity = z.object({
  identityId: z.string().describe("Opaque handle for unlinking; derived, never the raw subject."),
  provider: z.string().describe("Display label of the issuer, e.g. 'Cloudflare Access'."),
  displayEmail: z.string().nullable().describe("Display/contact attribute only; never an identity key."),
  linkedAt: Instant,
  current: z.boolean().describe("True for the identity this request signed in with."),
});
export type LinkedIdentity = z.infer<typeof LinkedIdentity>;

/** The recovery kit is returned exactly once; only a verifier is stored. */
export const RecoveryKit = z.object({
  kitId: z.string(),
  recoveryCode: z.string().describe("High-entropy one-time credential. Shown once; store it offline."),
  issuedAt: Instant,
  storageInstruction: z.string(),
  /** A plain-text document suitable for saving or printing. */
  downloadFileName: z.string(),
  downloadText: z.string(),
});
export type RecoveryKit = z.infer<typeof RecoveryKit>;

export const MeResponse = z.object({
  userId: z.string(),
  displayName: z.string(),
  scopes: z.array(Scope),
  channel: Channel,
  identities: z.array(LinkedIdentity),
  recoveryKit: z.object({ present: z.boolean(), issuedAt: Instant.nullable() }),
  /** Set only in the response that created the account's first recovery kit (owner claim). Shown once. */
  issuedRecoveryKit: RecoveryKit.nullable().default(null),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ClaimRequest = z.object({ invitationCode: z.string().min(16).max(200) });
export const IdentityLinkTicket = z.object({ linkCode: z.string(), expiresAt: Instant });
export const IdentityLinkCompleteRequest = z.object({ linkCode: z.string().min(16).max(200) });
export const IdentityUnlinkRequest = z.object({ identityId: z.string() });

export const RecoveryKitIssued = z.object({ kit: RecoveryKit, replacedKitId: z.string().nullable(), receiptId: z.string() });
export const SessionsRevoked = z.object({ sessionsRevokedBefore: Instant, receiptId: z.string() });

export const RecoveryTransaction = z.object({ transactionId: z.string(), expiresAt: Instant, attemptsRemaining: z.number().int().nonnegative() });
export const RecoveryCompleteRequest = z.object({
  transactionId: z.string(),
  recoveryCode: z.string().min(16).max(200),
  /** Also unlink the identities that were linked before (for a compromised or permanently lost login). */
  unlinkPreviousIdentities: z.boolean().default(false),
});
export const RecoveryCompleteResponse = z.object({
  userId: z.string(),
  identityLinked: z.boolean(),
  /** Sessions authenticated before this instant are refused for this account. */
  sessionsRevokedBefore: Instant,
  assistantGrantsRevoked: z.number().int().nonnegative(),
  previousIdentitiesUnlinked: z.number().int().nonnegative(),
  replacementKit: RecoveryKit,
  receiptId: z.string(),
  /** Third-party data connections are separate grants: recovery never restores a revoked one. */
  connectionsUnchanged: z.literal(true),
});
export type RecoveryCompleteResponse = z.infer<typeof RecoveryCompleteResponse>;

export const AccountDeleteRequest = z.object({
  /** Omit to open the confirmation step; repeat with the returned token to confirm. */
  confirmationToken: z.string().optional(),
});
export const AccountDeleteResponse = z.object({
  /** `erased`: every stored record is gone. `disabled_pending_deletion`: the account is disabled and erasure is being finished in the background. */
  state: z.enum(["confirmation_required", "disabled_pending_deletion", "erased"]),
  confirmationToken: z.string().nullable(),
  expiresAt: Instant.nullable(),
  consequence: z.string(),
});

/* ================================================================== */
/* Notification devices                                                */
/* ================================================================== */

/** `POST /v1/devices`: the APNs device token as hexadecimal, and which APNs environment issued it. */
export const DeviceRegistration = z.object({
  deviceId: z.string().min(8).max(128).describe("Stable per-installation identifier chosen by the app (not the token)."),
  token: z.string().regex(/^[0-9a-fA-F]{32,200}$/),
  environment: z.enum(["development", "production"]),
});
export const Device = z.object({ deviceId: z.string(), environment: z.string(), status: z.enum(["active", "disabled"]), disabledReason: z.string().nullable().optional(), updatedAt: Instant, lastDeliveryAt: Instant.nullable().optional() });
export const DeviceList = z.object({ deliveryConfigured: z.boolean(), devices: z.array(Device) });
export const DeviceRemoved = z.object({ removed: z.boolean() });

/* ================================================================== */
/* Backups and restore                                                 */
/* ================================================================== */

/** What a restore must reproduce and where each store stood (snapshot times and projection watermarks). */
export const RestoreManifest = z.record(z.string(), z.unknown()).describe("format garderobe-restore-manifest/1: backupId, ownerRef, snapshot { takenAt, coherent, stores }, components, state, afterRestore");
export const Backup = z.object({
  backupId: z.string(),
  runId: z.string(),
  state: z.enum(["queued", "running", "completed", "completed_incomplete", "failed", "expired"]),
  complete: z.boolean(),
  takenAt: Instant.nullable(),
  requestedAt: Instant,
  finishedAt: Instant.nullable(),
  expiresAt: Instant.nullable(),
  byteLength: z.number().int().nullable(),
  sha256: z.string().nullable(),
  components: z.array(z.object({ name: z.string(), state: z.string(), records: z.number(), note: z.string().nullable() })),
  restoreManifest: RestoreManifest.nullable(),
});
export const BackupList = z.object({ backups: z.array(Backup), retentionDays: z.number().int(), intervalHours: z.number() });
export const TombstoneJournal = z.object({
  format: z.literal("garderobe-tombstones/1"),
  ownerRef: z.string(),
  writtenAt: Instant,
  tombstones: z.array(z.object({ sourceKind: z.string(), sourceId: z.string(), requestedAt: z.string() })),
});
export const RestoreVerifyRequest = z.object({ restoreManifest: RestoreManifest, tombstones: TombstoneJournal.optional() });
export const RestoreReport = z.object({
  /** True only when every check holds. */
  complete: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), expected: z.unknown(), actual: z.unknown(), note: z.string().optional() })),
  tombstonesReplayed: z.number().int().nonnegative(),
  verifiedAt: Instant,
});

/* ================================================================== */
/* Today, recommendations, service, trips                              */
/* ================================================================== */

export const SourceFreshness = z.object({
  source: z.enum(["wardrobe", "style", "weather", "calendar", "board", "media"]),
  state: z.enum(["fresh", "stale", "unavailable", "not_connected"]),
  checkedAt: Instant.nullable(),
  revision: z.number().int().nonnegative().nullable(),
  detail: z.string().nullable().describe("Owner-readable note, e.g. 'Calendar is disconnected'."),
});
export type SourceFreshness = z.infer<typeof SourceFreshness>;

export const ServiceState = z.object({
  paused: z.boolean(),
  /** The active pause; `resumeOn: null` means paused until the owner resumes. */
  pause: PauseState.nullable(),
  /** Return deadlines stay active during a pause by default; their controls are separate. */
  returnDeadlinesActive: z.boolean(),
});
export type ServiceState = z.infer<typeof ServiceState>;

export const TodayQuery = z.object({ date: LocalDate.optional(), scope: z.string().optional().describe("`home` (default) or `trip:<tripId>`.") });

/** `GET /v1/today`: the daily service's `TodayView` plus API-level status, freshness list and revision. */
export const TodayResponse = TodayView.extend({
  /** `ready`: a board exists. `paused`: the service is paused. `none`: no board (see `emptyReason`). */
  status: z.enum(["ready", "preparing", "paused", "none"]),
  freshness: z.array(SourceFreshness),
  runId: z.string().nullable(),
  wardrobeRevision: z.number().int().nonnegative(),
});
export type TodayResponse = z.infer<typeof TodayResponse>;

export const RecommendRequest = z.object({
  clientRequestId: z.string().min(8).max(128).describe("Stable ID: a retransmission returns the same result."),
  date: LocalDate.optional(),
  brief: z.string().max(2000).optional(),
  count: z.number().int().min(1).max(8).optional(),
  /** Garments that must stay. */
  lockedGarmentIds: z.array(z.string()).default([]),
  occasionOnly: z.boolean().default(false),
  /** `preview`: return options without publishing a board. `board`: publish a new board revision. */
  mode: z.enum(["preview", "board"]).default("preview"),
});
export const RecommendResponse = z.object({
  /** `completed`: validated options are in `options`. `running`: follow `runId`. Accepted work is never 'done'. */
  state: z.enum(["completed", "running"]),
  runId: z.string().nullable(),
  localDate: LocalDate,
  options: z.array(BoardOption),
  board: BoardDocument.nullable(),
  insufficient: z.boolean(),
  note: z.string().nullable(),
  wardrobeRevision: z.number().int().nonnegative(),
  readAt: Instant,
});
export type RecommendResponse = z.infer<typeof RecommendResponse>;

/** `POST /v1/boards/{id}/swap`. Without `garmentId` the daily service picks the replacement. */
export const SwapSlotRequest = z.object({
  clientRequestId: z.string().min(8).max(128).describe("Stable ID: a retransmission returns the same receipt."),
  optionId: z.string().min(1),
  role: Role,
  garmentId: z.string().optional(),
  /** The board revision the owner was looking at; a newer revision is a clean conflict. */
  expectedRevision: z.number().int().positive().optional(),
});
export const SwapSlotResponse = z.object({ board: BoardDocument, receipt: CommandReceipt });

export const WeatherQuery = z.object({ date: LocalDate.optional() });
export const TripList = z.object({ trips: z.array(Trip) });
export type TripList = z.infer<typeof TripList>;

/* ================================================================== */
/* Wardrobe, item, laundry, studio                                     */
/* ================================================================== */

/*
 * `GET /v1/wardrobe` takes the core `InventoryQuery` as a query string (booleans `true`/`false`,
 * numbers in decimal) and returns the core `InventoryPage`. Omitting `limit` returns the complete
 * snapshot with `complete: true`; a page always says `complete: false` and carries `nextCursor`.
 */
export const ResolveQuery = z.object({ phrase: z.string().min(1).max(200) });
/** `POST /v1/style/preview-save`: the edited profile text, exactly as it would be saved. Returns the core `StyleFactDiff`. */
export const StylePreviewSaveRequest = z.object({ content: z.string().min(1), documentId: z.string().optional() });
export const StyleConflictsQuery = z.object({ status: z.enum(["open", "resolved", "withdrawn", "all"]).default("open"), documentId: z.string().optional() });
export const StyleConflictList = z.object({ conflicts: z.array(StyleFactConflict) });
export const AvailabilityQuery = z.object({ date: LocalDate.optional() });
export const TemperaturePreviewQuery = z.object({ temperatureC: z.coerce.number().min(-40).max(50) });
export const ImageQuery = z.object({ width: z.coerce.number().int().optional().describe("One of 160, 320, 640, 1280.") });
export const AssetImageQuery = z.object({ variant: z.enum(["display", "original", "cutout", "catalogue"]).optional(), width: z.coerce.number().int().optional() });

export const ItemResponse = z.object({
  detail: GarmentDetail,
  availability: GarmentAvailability.nullable(),
  /** Null with `mediaAvailable: false` when the media module could not be read; the ledger part stays authoritative. */
  media: GarmentMedia.nullable(),
  mediaAvailable: z.boolean(),
  knownCombinations: z.array(StudioCombination),
  readAt: Instant,
});
export type ItemResponse = z.infer<typeof ItemResponse>;

const LaundryLine = z.object({ garmentId: z.string(), name: z.string(), quantity: z.number().int().nonnegative() });
export const LaundryStateResponse = z.object({
  awaitingService: z.array(LaundryLine),
  awaitingHandwash: z.array(LaundryLine),
  batches: z.array(
    z.object({
      batchId: z.string(),
      status: z.string(),
      pickedUpAt: Instant,
      returnedAt: Instant.nullable(),
      returnBasis: z.string().nullable(),
      items: z.array(LaundryLine.extend({ returnedQuantity: z.number().int().nonnegative(), stillAway: z.number().int().nonnegative() })),
    }),
  ),
  exceptions: z.array(z.object({ exceptionId: z.string(), kind: z.string(), garmentId: z.string().nullable(), cycleKey: z.string().nullable(), quantity: z.number().int(), occurredAt: Instant })),
  cycles: z.array(z.object({ channel: z.string(), cycleKey: z.string(), cutoffAt: Instant, baselineAt: Instant })),
  readAt: Instant,
});
export type LaundryStateResponse = z.infer<typeof LaundryStateResponse>;

export const StudioQuery = z.object({ mode: StudioMode.default("for_today"), date: LocalDate.optional() });
/** Media's `StudioSelectors` plus the saved combinations and day plans. Reading it changes nothing. */
export const StudioResponse = StudioSelectors.extend({
  combinations: z.array(StudioCombination),
  dayPlans: z.array(StudioDayPlan),
});
export type StudioResponse = z.infer<typeof StudioResponse>;
export const StudioOutfitRequest = z.object({
  mode: StudioMode.default("for_today"),
  date: LocalDate.optional(),
  /** Locked slots are returned unchanged by `suggest`. */
  slots: z.array(StudioSlot).min(1),
  limit: z.number().int().positive().max(10).optional(),
});
export const StudioSuggestResponse = z.object({ suggestions: z.array(StudioSuggestion) });
export const StudioComposeRequest = z.object({ slots: z.array(StudioSlot).min(1) });
export const StudioPreviewRequest = z.object({ clientRequestId: z.string().min(8).max(128), slots: z.array(StudioSlot).min(1) });
export const StudioPreviewResponse = z.object({ receipt: CommandReceipt, manifestHash: z.string().length(64) });

/* ================================================================== */
/* Commands                                                             */
/* ================================================================== */

/*
 * `POST /v1/commands`: body is the core `CommandEnvelope`; 200 with the core `CommandReceipt`.
 * `source.channel` must equal the connection's channel (`ios` or `web`; `mcp` on the MCP tool).
 * The same idempotency key and body returns the stored receipt with `replayed: true` (also 200).
 */
export const CommandBatchRequest = z.object({
  /** Executed strictly in order; each command is independent (its own receipt or error). Max 50. */
  commands: z.array(CommandEnvelope).min(1).max(50),
});
export const CommandBatchItem = z.discriminatedUnion("status", [
  z.object({ status: z.literal("receipt"), idempotencyKey: z.string(), receipt: CommandReceipt }),
  z.object({
    status: z.literal("error"),
    idempotencyKey: z.string(),
    error: ApiError,
    /** True when resubmitting the identical command later can succeed (transport/internal), false for a final refusal. */
    retryable: z.boolean(),
  }),
]);
export const CommandBatchResponse = z.object({ results: z.array(CommandBatchItem), wardrobeRevision: z.number().int().nonnegative() });
export type CommandBatchResponse = z.infer<typeof CommandBatchResponse>;

export const ReceiptListQuery = z.object({
  /** `kind:id`, e.g. `garment:gmt_x` (item history). */
  entity: z.string().optional(),
  /** Look up by the client's idempotency key (reconcile a command whose response was lost). */
  idempotencyKey: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
/** Newest first. */
export const ReceiptList = z.object({ receipts: z.array(CommandReceipt) });
export type ReceiptList = z.infer<typeof ReceiptList>;

export const CommandTypeInfo = z.object({
  type: z.string(),
  class: z.enum(["observation", "edit", "system"]),
  requiredScope: Scope,
  /** Authorization bases this command accepts. */
  authorizations: z.array(z.string()),
  /** True for operations that need an explicit confirmation step over MCP. */
  consequential: z.boolean(),
  payloadSchema: z.record(z.string(), z.unknown()).describe("JSON Schema (draft 2020-12) of the payload."),
});
export const CommandTypeList = z.object({ types: z.array(CommandTypeInfo), contractVersion: z.string() });
export type CommandTypeList = z.infer<typeof CommandTypeList>;

/* ================================================================== */
/* Conversation, research, projects                                    */
/* ================================================================== */

export const AttachedRef = z.object({
  kind: z.enum(["garment", "board_option", "board", "combination", "trip", "return", "order", "research", "message"]),
  id: z.string(),
  /** For `board_option`: the board and revision the card was shown in. */
  boardId: z.string().optional(),
  revision: z.number().int().positive().optional(),
});
export type AttachedRef = z.infer<typeof AttachedRef>;

export const TurnIntent = z.enum(["chat", "add_item", "identify", "what_i_wore", "product_investigation"]);

export const TurnRequest = z.object({
  clientTurnId: z.string().min(8).max(128).describe("Stable ID created before sending; a retransmission returns the same turn."),
  /** Only what the owner typed or said. May be empty when a photograph is sent on its own; then nothing can be changed. */
  text: z.string().max(20000).default(""),
  attachmentIds: z.array(z.string()).max(4).default([]).describe("Finalized upload asset IDs only: photographs the assistant should look at."),
  /** What each attached photograph is, when the capture sheet knows (same order is not required; matched by asset ID). */
  imageRoles: z.record(z.string(), z.enum(["selfie", "shop_photo", "item_photo", "receipt", "other"])).default({}),
  attachedRefs: z.array(AttachedRef).max(12).default([]),
  /** Capture-sheet intent. Encoded in request policy: a photo or a question never authorizes a mutation by itself. */
  intent: TurnIntent.default("chat"),
  /** A shared product link (Safari share extension): treated as data to investigate, never as an instruction. */
  sharedUrl: z.string().url().optional(),
  /** Pasted or forwarded third-party text: data for the assistant to read; it can never authorize a change. */
  pastedText: z.string().max(200000).optional(),
}).refine((t) => t.text.trim().length > 0 || t.attachmentIds.length > 0, "a turn needs text or a photograph");
export type TurnRequest = z.input<typeof TurnRequest>;
export const TurnResponse = z.object({
  turnId: z.string(),
  /** The run to follow (`GET /v1/runs/{id}` and its event stream). */
  runId: z.string(),
  /** `accepted` is never 'done': follow the run. */
  state: z.enum(["queued", "running", "needs_input", "completed", "failed", "cancelled"]),
  replayed: z.boolean(),
});
export type TurnResponse = z.infer<typeof TurnResponse>;

/** `GET /v1/conversation/messages` returns the assistant's `TranscriptPage` (original messages, stable IDs). */
export const MessagesQuery = z.object({
  before: z.string().optional().describe("`nextBefore` cursor: older messages."),
  after: z.string().optional().describe("`nextAfter` cursor: newer messages."),
  around: z.string().optional().describe("Message ID: return it with surrounding messages."),
  limit: z.coerce.number().int().positive().max(100).default(40),
});
export const MessagesPage = TranscriptPage;

export const SourceCitation = z.object({ title: z.string(), url: z.string().nullable(), checkedAt: Instant.nullable(), kind: z.string(), excerpt: z.string().nullable() });

export const StartResearchRequest = z.object({
  clientRequestId: z.string().min(8).max(128),
  topic: z.string().min(1).max(2000),
  kind: z.enum(["product", "history", "purchases", "general"]).default("product"),
  url: z.string().url().optional(),
});
export const ResearchResult = z.object({
  verdict: z.string().nullable(),
  summary: z.string(),
  comparison: z.array(z.record(z.string(), z.unknown())),
  sources: z.array(SourceCitation),
});
export type ResearchResult = z.infer<typeof ResearchResult>;
export const StartResearchResponse = z.object({ runId: z.string(), state: z.enum(["queued", "running", "needs_input", "completed", "failed", "cancelled"]), result: ResearchResult.nullable(), replayed: z.boolean() });
export type StartResearchResponse = z.infer<typeof StartResearchResponse>;

export const OrderList = z.object({ orders: z.array(Order) });
export const ReturnList = z.object({ returns: z.array(ReturnCase) });
export const ProjectList = z.object({ projects: z.array(LifecycleProject) });
export const FeedbackQuery = z.object({ garmentId: z.string().optional() });
export const FeedbackList = z.object({ feedback: z.array(ComfortFeedback) });

/* ================================================================== */
/* Runs and the event stream                                           */
/* ================================================================== */

export const RunKind = z.enum(["conversation_turn", "recommendation", "research", "export", "import", "media"]);
export type RunKind = z.infer<typeof RunKind>;
export const RunState = z.enum(["queued", "running", "needs_input", "completed", "failed", "cancelled"]);
export type RunState = z.infer<typeof RunState>;

/** A request for owner input. Native `needs_input` and MCP `input_required` are the same durable record. */
export const PendingInput = z.object({
  inputId: z.string(),
  question: z.string(),
  /** Compact choices containing only the unresolved pieces; free text when empty. */
  choices: z.array(z.object({ id: z.string(), label: z.string() })),
  /** The backend-issued action this answer completes; its command identity never changes across retries. */
  actionId: z.string().nullable(),
});
export type PendingInput = z.infer<typeof PendingInput>;

/** Short reference to a command a run committed; fetch the full receipt at `GET /v1/commands/{commandId}`. */
export const RunReceiptRef = z.object({ commandId: z.string(), type: z.string(), outcome: z.string(), summary: z.string(), undoAvailable: z.boolean() });
export type RunReceiptRef = z.infer<typeof RunReceiptRef>;

export const Run = z.object({
  runId: z.string(),
  kind: RunKind,
  state: RunState,
  createdAt: Instant,
  updatedAt: Instant,
  /** Visible work, e.g. "Checking the maker's size chart". Never raw reasoning. */
  activity: z.string().nullable(),
  lastEventId: z.number().int().nonnegative(),
  pendingInput: PendingInput.nullable(),
  /** Every command this run committed (also after cancel). */
  receipts: z.array(RunReceiptRef),
  /** Writes a read-only connection asked for: described, never executed. */
  proposals: z.array(z.object({ type: z.string(), summary: z.string(), payload: z.record(z.string(), z.unknown()) })),
  /** Durable final result, present once `state` is terminal. Which fields are set depends on `kind`. */
  result: z
    .object({
      reply: z.object({ messageId: z.string(), text: z.string() }).nullable().default(null),
      options: z.array(BoardOption).default([]),
      board: BoardDocument.nullable().default(null),
      research: ResearchResult.nullable().default(null),
      exportId: z.string().nullable().default(null),
      importId: z.string().nullable().default(null),
    })
    .nullable(),
  error: z.object({ code: z.string(), message: z.string(), resumable: z.boolean() }).nullable(),
});
export type Run = z.infer<typeof Run>;

export const RunEventType = z.enum(["run_started", "activity", "text_delta", "outfit_board", "product_comparison", "sources", "command_receipt", "needs_input", "run_finished", "snapshot"]);

/**
 * One server-sent event. Wire form: `id: <eventId>`, `event: <type>`, `data: <this object as JSON>`.
 * Reconnect with `Last-Event-ID` (or `?after=`). When the cursor is older than the retained window the
 * first event is `snapshot` carrying the current `Run`, then later events follow: never a silent gap.
 * `type` is an open string: unknown types must be ignored by clients.
 */
export const RunEvent = z.object({
  eventId: z.number().int().nonnegative(),
  runId: z.string(),
  type: z.string(),
  at: Instant,
  data: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEvent>;

/** `data` of each known event type. */
export const RunEventData = {
  run_started: z.object({ kind: RunKind }),
  activity: z.object({ text: z.string() }),
  /** `replace: true` means `delta` is the complete text so far (replace what was shown, do not append). */
  text_delta: z.object({ messageId: z.string().nullable(), delta: z.string(), replace: z.boolean().default(false) }),
  /** Validated options only; speculative text never becomes an actionable card. */
  outfit_board: z.object({ boardId: z.string().nullable(), revision: z.number().int().positive().nullable(), options: z.array(BoardOption) }),
  product_comparison: z.object({ title: z.string(), verdict: z.string().nullable(), rows: z.array(z.record(z.string(), z.unknown())) }),
  sources: z.object({ sources: z.array(SourceCitation) }),
  command_receipt: z.object({ receipt: RunReceiptRef }),
  needs_input: z.object({ input: PendingInput }),
  run_finished: z.object({ state: RunState }),
  snapshot: z.object({ run: Run, reason: z.enum(["cursor_expired", "initial"]) }),
} as const;

export const RunEventsQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  /** `false` returns the retained events and closes instead of waiting for more. */
  follow: z.enum(["true", "false"]).optional(),
});
export const RunCancelResponse = z.object({
  run: Run,
  /** Effects that had already committed and stay committed (undo is a separate command). */
  committed: z.array(RunReceiptRef),
  stopped: z.array(z.string()).describe("What was stopped, in owner-readable terms."),
});
export type RunCancelResponse = z.infer<typeof RunCancelResponse>;
export const RunInputRequest = z.object({
  inputId: z.string(),
  choiceId: z.string().optional(),
  text: z.string().max(4000).optional(),
});

/* ================================================================== */
/* Uploads                                                              */
/* ================================================================== */

export const UploadRequest = z.object({
  clientUploadId: z.string().min(8).max(128).describe("Stable ID: retrying returns the same upload."),
  intent: UploadIntent,
  contentType: UploadContentType,
  byteLength: z.number().int().positive(),
  garmentId: z.string().optional(),
  wearingDate: LocalDate.optional(),
});
/** Media's `UploadAuthorization` (PUT `url` with `requiredHeaders` before `expiresAt`) plus the replay flag. */
export const UploadAuthorizationResponse = UploadAuthorization.extend({ replayed: z.boolean() });
export type UploadAuthorizationResponse = z.infer<typeof UploadAuthorizationResponse>;
export const UploadContentResponse = z.object({ uploadId: z.string(), receivedBytes: z.number().int().nonnegative(), sha256: z.string() });
export const UploadCompleteResponse = z.object({
  uploadId: z.string(),
  /** A rejection (wrong type, too large, not an image) is a committed outcome with its reason, not a transport error. */
  state: z.enum(["finalized", "rejected"]),
  asset: MediaAsset.nullable(),
  rejectionReason: z.string().nullable(),
  /** Background normalization job started by finalization, when any. */
  jobId: z.string().nullable(),
  receipt: CommandReceipt,
});
export type UploadCompleteResponse = z.infer<typeof UploadCompleteResponse>;

/* ================================================================== */
/* Connections (as the phone sees them)                                */
/* ================================================================== */

export const ApiConnectionKind = z.enum(["google_workspace", "mcp", "exa", "tavily"]);
export type ApiConnectionKind = z.infer<typeof ApiConnectionKind>;
export const ApiConnectionState = z.enum(["pending_authorization", "connected", "needs_reconnect", "error", "disconnected"]);
export type ApiConnectionState = z.infer<typeof ApiConnectionState>;

/** Capability keys of a Google Workspace connection. Each maps to fixed provider scopes and an operation allowlist. */
export const GOOGLE_CAPABILITIES = ["gmail.read_orders", "calendar.read", "calendar.write_outfit_calendar", "drive.read_selected", "sheets.read_selected"] as const;

export const ConnectionCapability = z.object({
  key: z.string().describe("A GOOGLE_CAPABILITIES key, or `tools:<group>` for an MCP connection."),
  label: z.string(),
  effect: z.enum(["read", "write"]),
  /** Owner-selected policy: the assistant may use it. */
  enabled: z.boolean(),
  /** Granted/discovered at the provider. `enabled && !available` names the missing permission. */
  available: z.boolean(),
});
export type ConnectionCapability = z.infer<typeof ConnectionCapability>;

/** Never contains a credential, a refresh token or a key-bearing URL. */
export const ApiConnection = z.object({
  connectionId: z.string(),
  kind: ApiConnectionKind,
  name: z.string(),
  /** Credential-free operational endpoint (secret query parameters removed). */
  endpoint: z.string().nullable(),
  namespace: z.string().describe("Stable tool namespace for this connection."),
  protocol: z.string().nullable().describe("e.g. mcp/2026-07-28, mcp/2025-11-25 (compatibility), google-rest"),
  authType: z.enum(["oauth", "secret", "none"]),
  state: ApiConnectionState,
  capabilities: z.array(ConnectionCapability),
  lastSuccessAt: Instant.nullable(),
  lastCheckedAt: Instant.nullable(),
  issue: z.object({ at: Instant, capability: z.string().nullable(), message: z.string(), action: z.enum(["reconnect", "retry", "none"]) }).nullable(),
  createdAt: Instant,
  version: z.number().int().positive(),
});
export type ApiConnection = z.infer<typeof ApiConnection>;
export const ApiConnectionList = z.object({ connections: z.array(ApiConnection), readAt: Instant });
export type ApiConnectionList = z.infer<typeof ApiConnectionList>;

export const RegisterConnectionRequest = z.object({
  clientRequestId: z.string().min(8).max(128),
  kind: ApiConnectionKind,
  name: z.string().min(1).max(80),
  /** Required for `mcp`: remote HTTPS endpoint. Validated against loopback, private and metadata destinations. */
  endpoint: z.string().url().optional(),
  auth: z.discriminatedUnion("type", [
    z.object({ type: z.literal("oauth") }),
    /** The secret is stored encrypted and never returned; it may not be embedded in `endpoint`. */
    z.object({ type: z.literal("secret"), secret: z.string().min(1).max(4096) }),
    z.object({ type: z.literal("none") }),
  ]),
  /** Capability keys to enable. */
  capabilities: z.array(z.string()).default([]),
  /** Where the system browser returns after the provider's flow. */
  returnTo: z.enum(["app", "web"]).default("app"),
});
export type RegisterConnectionRequest = z.input<typeof RegisterConnectionRequest>;
export const ReconnectRequest = z.object({ returnTo: z.enum(["app", "web"]).default("app") });
export const RegisterConnectionResponse = z.object({
  connection: ApiConnection,
  /** Open in the system browser when present; the authorization-code flow completes on the backend. */
  authorizationUrl: z.string().nullable(),
  replayed: z.boolean(),
});
export type RegisterConnectionResponse = z.infer<typeof RegisterConnectionResponse>;
export const ConnectionCapabilitiesRequest = z.object({ enabled: z.array(z.string()), expectedVersion: z.number().int().positive().optional() });
export const ConnectionCallbackQuery = z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional() });
export const DisconnectResponse = z.object({
  connection: ApiConnection,
  /** Queued calls are refused from now on: the executor re-reads the connection status before every call. */
  futureCallsStopped: z.literal(true),
  credentialsRemoved: z.boolean(),
  remoteRevocation: z.enum(["revoked", "unsupported", "failed", "not_applicable"]),
  receiptId: z.string(),
});
export type DisconnectResponse = z.infer<typeof DisconnectResponse>;

export const ConnectionCalendar = z.object({
  calendarId: z.string(),
  name: z.string(),
  primary: z.boolean(),
  accessRole: z.string(),
  /** The dedicated calendar the daily board is written to (created by Garderobe; the only one it can write). */
  outfitCalendar: z.boolean(),
  /** Read for day context (settings `extensions.daily.calendar.readCalendarIds`). */
  readForContext: z.boolean(),
});
export const ConnectionCalendarList = z.object({ calendars: z.array(ConnectionCalendar), outfitCalendarId: z.string().nullable(), readAt: Instant });
export const OutfitCalendarRequest = z.object({ clientRequestId: z.string().min(8).max(128), name: z.string().min(1).max(80).default("Outfits") });
export const OutfitCalendarResponse = z.object({
  calendar: ConnectionCalendar,
  /** False when the outfit calendar already existed and was kept. */
  created: z.boolean(),
  /** Receipt of the `settings.update` that recorded the choice (null when nothing changed). */
  receipt: CommandReceipt.nullable(),
});

export const PhotosNeededList = z.object({ items: z.array(PhotosNeededItem) });

/* ================================================================== */
/* Settings, connected assistants, recovery screen                     */
/* ================================================================== */

export const SettingsResponse = z.object({
  settings: OwnerSettings,
  version: z.number().int().positive(),
  profile: z.object({ documentId: z.string(), title: z.string(), version: z.number().int().positive(), contentSha256: z.string(), byteLength: z.number().int().nonnegative() }).nullable(),
  /** Effective model profiles, budgets and usage (assistant `InferenceOverview`); null while that module is unavailable. */
  inference: InferenceOverview.nullable(),
  service: ServiceState,
  apiVersion: z.literal("v1"),
  contractVersion: z.string(),
  readAt: Instant,
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

/** OAuth scopes of the MCP authorization server. `wardrobe.write` implies read. */
export const McpScope = z.enum(["wardrobe.read", "wardrobe.write"]);
export type McpScope = z.infer<typeof McpScope>;
export const MCP_SCOPES = McpScope.options;

export const AssistantGrant = z.object({
  grantId: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  clientUri: z.string().nullable(),
  /** Verified domain of a Client ID Metadata Document client; null for a self-registered client. */
  clientDomain: z.string().nullable(),
  scopes: z.array(McpScope),
  access: z.enum(["read_only", "read_write"]),
  status: z.enum(["active", "revoked"]),
  grantedAt: Instant,
  lastUsedAt: Instant.nullable(),
  revokedAt: Instant.nullable(),
  version: z.number().int().positive(),
});
export type AssistantGrant = z.infer<typeof AssistantGrant>;
export const AssistantGrantList = z.object({ grants: z.array(AssistantGrant) });

export const RecoveryStatus = z.object({
  lastBoard: z.object({ boardId: z.string(), localDate: LocalDate, revision: z.number().int().positive(), publishedAt: Instant }).nullable(),
  lastCalendarProjection: z.object({ state: z.string(), projectedRevision: z.number().int().nullable(), action: z.string().nullable() }).nullable(),
  /** Effects committed but not yet projected, and runs waiting for input. */
  pending: z.object({ effects: z.number().int().nonnegative(), runsNeedingInput: z.number().int().nonnegative() }),
  connectionIssues: z.array(z.object({ connectionId: z.string(), name: z.string(), capability: z.string().nullable(), message: z.string(), action: z.enum(["reconnect", "retry", "none"]) })),
  actions: z.array(z.enum(["reconnect", "retry", "open_today"])),
  /** Behind a separate disclosure in the app. Never contains secrets. */
  diagnostics: z.record(z.string(), z.unknown()),
  readAt: Instant,
});
export type RecoveryStatus = z.infer<typeof RecoveryStatus>;

/* ================================================================== */
/* Portable export and import                                          */
/* ================================================================== */

export const EXPORT_FORMAT_VERSION = "garderobe-export/1" as const;

export const ExportRequest = z.object({
  clientRequestId: z.string().min(8).max(128),
  /** Optional passphrase encryption (AES-256-GCM, PBKDF2-SHA-256 key). The passphrase is never stored. */
  passphrase: z.string().min(12).max(1024).optional(),
});
export const ExportComponent = z.object({
  name: z.string(),
  state: z.enum(["pending", "complete", "incomplete", "unavailable"]),
  records: z.number().int().nonnegative(),
  note: z.string().nullable(),
});
export type ExportComponent = z.infer<typeof ExportComponent>;
export const ExportJob = z.object({
  exportId: z.string(),
  runId: z.string(),
  state: z.enum(["queued", "running", "completed", "completed_incomplete", "failed", "expired"]),
  /** True only when every component is complete. A partial package is never reported as complete. */
  complete: z.boolean(),
  encrypted: z.boolean(),
  formatVersion: z.string(),
  requestedAt: Instant,
  finishedAt: Instant.nullable(),
  expiresAt: Instant.nullable(),
  snapshot: z.object({ takenAt: Instant, wardrobeRevision: z.number().int().nonnegative(), styleRevision: z.number().int().nonnegative(), lastCommandRecordedAt: Instant.nullable() }).nullable(),
  components: z.array(ExportComponent),
  byteLength: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
});
export type ExportJob = z.infer<typeof ExportJob>;
export const ExportList = z.object({ exports: z.array(ExportJob) });
export const DownloadTicket = z.object({ url: z.string(), expiresAt: Instant, fileName: z.string() });
export const DownloadQuery = z.object({ ticket: z.string() });

/** `POST /v1/imports`: body is the package bytes; an encrypted package needs header `X-Garderobe-Passphrase`. */
export const ImportJob = z.object({
  importId: z.string(),
  runId: z.string(),
  state: z.enum(["running", "completed", "failed", "rejected"]),
  formatVersion: z.string().nullable(),
  checksumsVerified: z.boolean(),
  components: z.array(z.object({ name: z.string(), imported: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), note: z.string().nullable() })),
  /** Always 0: an import never replays external effects. */
  externalEffectsReplayed: z.literal(0),
  idsPreserved: z.boolean(),
  error: z.string().nullable(),
  finishedAt: Instant.nullable(),
});
export type ImportJob = z.infer<typeof ImportJob>;

/* ================================================================== */
/* MCP tools                                                            */
/* ================================================================== */

/** Protocol revisions: the server's native contract and the separately tested compatibility fallback. */
export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const MCP_COMPAT_PROTOCOL_VERSION = "2025-11-25" as const;
export const MCP_TOOL_NAMES = ["garderobe_ask", "garderobe_today", "garderobe_recommend", "garderobe_inventory", "garderobe_command", "garderobe_research", "garderobe_run"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/*
 * No MCP tool input carries an owner: the owner and scopes come from the OAuth grant of the
 * connection. Inputs are strict objects; an unknown property (such as `userId`) is rejected.
 * Every tool returns `structuredContent` matching its output schema plus a short text rendering.
 */

export const McpAskInput = z.strictObject({
  message: z.string().min(1).max(20000),
  /** Stable ID from the client; a retry returns the same turn. */
  clientTurnId: z.string().min(8).max(128),
  attachedRefs: z.array(AttachedRef).max(12).default([]),
  /** Third-party text for the assistant to read; never an instruction. */
  pastedText: z.string().max(200000).optional(),
  /** `wait`: return the answer when it is ready within the request; `start`: return the run handle at once. */
  mode: z.enum(["wait", "start"]).default("wait"),
});
export const McpAskOutput = z.object({
  runId: z.string(),
  state: RunState,
  answer: z.string().nullable(),
  /** Receipts of commands the assistant executed under this connection's write capability. */
  receipts: z.array(RunReceiptRef),
  /** For a read-only connection: what the assistant would do, never executed. */
  proposals: z.array(z.object({ type: z.string(), summary: z.string(), payload: z.record(z.string(), z.unknown()) })),
  pendingInput: PendingInput.nullable(),
});

export const McpTodayInput = z.strictObject({ date: LocalDate.optional() });
export const McpTodayOutput = TodayResponse;

export const McpRecommendInput = z.strictObject({
  brief: z.string().max(2000).optional(),
  date: LocalDate.optional(),
  count: z.number().int().min(1).max(8).optional(),
  clientRequestId: z.string().min(8).max(128),
});
export const McpRecommendOutput = RecommendResponse;

export const McpInventoryView = z.enum(["items", "snapshot", "item", "availability", "history", "laundry", "style", "resolve", "selection", "receipts", "command_types", "trips", "returns", "orders"]);
export const McpInventoryInput = z.strictObject({
  view: McpInventoryView.default("items"),
  selector: GarmentSelector.optional().describe("`selection`: which garments a bulk edit would cover. Read the result, then send its count as `expectedCount` of garment.bulk_correct."),
  /** `item`: the garment. `history`, `receipts`: optional garment filter. */
  garmentId: z.string().optional(),
  phrase: z.string().optional().describe("`resolve`: an owner phrase to resolve to garments."),
  search: z.string().optional(),
  category: z.string().optional(),
  colour: z.string().optional(),
  availability: z.enum(["available", "estimated", "conditional", "unavailable"]).optional(),
  location: z.enum(["home", "storage", "tailor", "trip", "service"]).optional(),
  date: LocalDate.optional(),
  from: LocalDate.optional(),
  to: LocalDate.optional(),
  limit: z.number().int().positive().max(500).optional().describe("`items` page size. Use view `snapshot` for the complete inventory."),
  cursor: z.string().optional(),
});
export const McpInventoryOutput = z.object({
  view: z.string(),
  /** True when `data` is the entire result set for the request; false when more pages exist. */
  complete: z.boolean(),
  total: z.number().int().nonnegative().nullable(),
  nextCursor: z.string().nullable(),
  wardrobeRevision: z.number().int().nonnegative(),
  /** When the ledger was read (source timestamp). */
  readAt: Instant,
  /** The same object the HTTP API returns for the view (InventoryPage, GarmentDetail, AvailabilitySnapshot, ...). */
  data: z.record(z.string(), z.unknown()),
});

export const McpCommandInput = z.strictObject({
  type: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8).max(200),
  expectedVersions: z.record(z.string(), z.number().int().nonnegative()).default({}),
  occurredAt: Instant.optional(),
});
export const McpCommandOutput = z.object({ receipt: CommandReceipt });

export const McpResearchInput = z.strictObject({
  topic: z.string().min(1).max(2000),
  kind: z.enum(["product", "history", "purchases", "general"]).default("product"),
  url: z.string().url().optional(),
  clientRequestId: z.string().min(8).max(128),
});
export const McpResearchOutput = z.object({ runId: z.string(), state: RunState, result: ResearchResult.nullable() });

export const McpRunInput = z.strictObject({
  runId: z.string(),
  action: z.enum(["status", "respond", "cancel", "resume"]).default("status"),
  inputId: z.string().optional(),
  choiceId: z.string().optional(),
  text: z.string().max(4000).optional(),
});
export const McpRunOutput = z.object({ run: Run, stopped: z.array(z.string()) });

/**
 * Tool contracts. `scope` is the OAuth scope needed to call the tool at all; `garderobe_ask` and
 * `garderobe_run` additionally execute writes only when the grant carries `wardrobe.write`.
 * The flags are the MCP tool annotations the server publishes.
 */
export const MCP_TOOL_CONTRACTS = {
  garderobe_ask: { input: McpAskInput, output: McpAskOutput, scope: "wardrobe.read", readOnly: false, destructive: false, idempotent: true, openWorld: true },
  garderobe_today: { input: McpTodayInput, output: McpTodayOutput, scope: "wardrobe.read", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  garderobe_recommend: { input: McpRecommendInput, output: McpRecommendOutput, scope: "wardrobe.read", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  garderobe_inventory: { input: McpInventoryInput, output: McpInventoryOutput, scope: "wardrobe.read", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  garderobe_command: { input: McpCommandInput, output: McpCommandOutput, scope: "wardrobe.write", readOnly: false, destructive: true, idempotent: true, openWorld: false },
  garderobe_research: { input: McpResearchInput, output: McpResearchOutput, scope: "wardrobe.read", readOnly: false, destructive: false, idempotent: true, openWorld: true },
  garderobe_run: { input: McpRunInput, output: McpRunOutput, scope: "wardrobe.read", readOnly: false, destructive: false, idempotent: true, openWorld: false },
} as const;

/** MCP resources (documents; correctness never depends on reading them first). */
export const MCP_RESOURCES = [
  { uri: "garderobe://guide", name: "Using the Garderobe tools", mimeType: "text/markdown" },
  { uri: "garderobe://style/profile", name: "Owner style profile (current version)", mimeType: "text/markdown" },
  { uri: "garderobe://commands", name: "Command types and payload schemas", mimeType: "application/json" },
] as const;

/**
 * Command types that are consequential (irreversible or identity-changing): over MCP they are executed
 * only after an explicit confirmation round (`input_required`), bound to the exact request.
 */
export const CONSEQUENTIAL_COMMAND_TYPES = ["garment.remove_fabricated", "garment.merge", "garment.retire", "style.save_document", "conversation.forget_source", "media.delete_asset"] as const;
