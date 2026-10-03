import { API_VERSION, CONTRACT_VERSION, CommandEnvelope, GarmentSelector, InventoryQuery, LocalDate, type CommandReceipt } from "@garderobe/contracts";
import {
  AvailabilityQuery,
  MCP_COMPAT_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  ReceiptListQuery,
  ResolveQuery,
  StyleConflictsQuery,
  StylePreviewSaveRequest,
  type ApiError,
} from "@garderobe/contracts/ext/api";
import {
  first,
  getAvailability,
  getDailyRecord,
  getGarmentDetail,
  getLaundryState,
  getOwnerState,
  getSettings,
  getStyleContext,
  isCommandError,
  listInventory,
  listStyleFactConflicts,
  localDateOf,
  previewGarmentSelection,
  previewStyleSave,
  resolveAlias,
  toInstant,
  type CommandRegistry,
  type Principal,
} from "@garderobe/domain";
import { z } from "zod";
import { afterCommit, type App } from "../app.ts";
import { ApiException, isRetryable, normalizeError } from "../errors.ts";
import { json, readJson, readQuery } from "../http.ts";
import { describeMe } from "../identity/service.ts";
import { owner, type RouteDef } from "../router.ts";
import { connectedDispositionOfType } from "../mcp/policy.ts";

const now = (app: App) => toInstant(app.now());

/** Matches `CommandBatchRequest` in the contract. */
const MAX_BATCH_COMMANDS = 50;

/* ------------------------------------------------------------------ */
/* Shared read helpers (also used by the MCP tools)                     */
/* ------------------------------------------------------------------ */

export function parseInventoryQuery(url: URL): z.input<typeof InventoryQuery> {
  const raw: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams) raw[k] = v;
  if (typeof raw.limit === "string") raw.limit = Number(raw.limit);
  if (typeof raw.includeDisposed === "string") raw.includeDisposed = raw.includeDisposed === "true";
  const parsed = InventoryQuery.safeParse(raw);
  if (!parsed.success) throw new ApiException("invalid_command", "the inventory query is invalid", { issues: parsed.error.issues });
  return parsed.data;
}

export async function readService(app: App, principal: Principal) {
  const pause = app.daily ? await app.daily.pause(principal) : null;
  return { paused: pause !== null && pause.status === "active", pause: pause && pause.status === "active" ? pause : null, returnDeadlinesActive: true };
}

export async function readItem(app: App, principal: Principal, garmentId: string) {
  const detail = await getGarmentDetail(app.db, principal, garmentId);
  const availability = (await getAvailability(app.db, principal, { nowMs: app.now() })).garments.find((g) => g.garmentId === garmentId) ?? null;
  let media = null;
  let knownCombinations: unknown[] = [];
  let mediaAvailable = false;
  if (app.media) {
    try {
      [media, knownCombinations] = await Promise.all([app.media.garmentMedia(principal, garmentId), app.media.combinationsForGarment(principal, garmentId)]);
      mediaAvailable = true;
    } catch (error) {
      // A media read failure never hides the ledger facts; the response says media was not read.
      if (!isCommandError(error)) console.warn("media read failed", String((error as Error)?.message ?? error));
    }
  }
  return { detail, availability, media, mediaAvailable, knownCombinations, readAt: now(app) };
}

export async function readSettings(app: App, principal: Principal) {
  const { settings, version } = await getSettings(app.db, principal);
  let profile = null;
  try {
    const style = await getStyleContext(app.db, principal);
    profile = { documentId: style.document.documentId, title: style.document.title, version: style.document.version, contentSha256: style.document.contentSha256, byteLength: style.document.byteLength };
  } catch (error) {
    if (!isCommandError(error) || error.code !== "not_found") throw error;
  }
  let inference = null;
  if (app.assistant) {
    try {
      inference = await app.assistant.inference(principal);
    } catch (error) {
      console.warn("inference overview unavailable", String((error as Error)?.message ?? error));
    }
  }
  return { settings, version, profile, inference, service: await readService(app, principal), apiVersion: API_VERSION, contractVersion: CONTRACT_VERSION, readAt: now(app) };
}

/**
 * Whether a connected assistant's typed command of this type waits for the owner's confirmation (or is
 * not available to it at all) instead of running. Derived from the one policy in mcp/policy.ts, so the
 * published list cannot differ from what the MCP tool does. `job.create` and `command.undo` are marked
 * although a research job and the undo of a wear or wash report run directly: that depends on the request.
 */
export const isConsequential = (registry: CommandRegistry, type: string): boolean => connectedDispositionOfType(registry, type, {}) !== "direct";

const schemaCache = new WeakMap<CommandRegistry, unknown[]>();

/** Every registered command type with its payload JSON Schema: the constrained write surface, discoverable. */
export function describeCommandTypes(registry: CommandRegistry) {
  let types = schemaCache.get(registry);
  if (!types) {
    types = registry.types().map((type) => {
      const def = registry.get(type);
      let payloadSchema: Record<string, unknown>;
      try {
        payloadSchema = z.toJSONSchema(def.schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
      } catch {
        payloadSchema = { type: "object" };
      }
      return { type, class: def.class, requiredScope: def.requiredScope, authorizations: registry.allowedAuthorizations(def), consequential: isConsequential(registry, type), payloadSchema };
    });
    schemaCache.set(registry, types);
  }
  return { types, contractVersion: CONTRACT_VERSION };
}

export async function receiptByIdempotencyKey(app: App, principal: Principal, key: string): Promise<CommandReceipt | null> {
  const row = await first<{ receipt_json: string }>(app.db, "SELECT receipt_json FROM commands WHERE user_id = ? AND idempotency_key = ?", principal.userId, key);
  return row ? (JSON.parse(row.receipt_json) as CommandReceipt) : null;
}

export async function listReceipts(app: App, principal: Principal, query: { entity?: string; idempotencyKey?: string; limit: number }): Promise<{ receipts: CommandReceipt[] }> {
  if (query.idempotencyKey) {
    const receipt = await receiptByIdempotencyKey(app, principal, query.idempotencyKey);
    return { receipts: receipt ? [receipt] : [] };
  }
  if (query.entity) {
    const index = query.entity.indexOf(":");
    if (index <= 0) throw new ApiException("invalid_command", "entity must be written kind:id, for example garment:gmt_x");
    return { receipts: await app.service.listReceipts(principal, { kind: query.entity.slice(0, index), entityId: query.entity.slice(index + 1), limit: query.limit }) };
  }
  return { receipts: await app.service.listReceipts(principal, { limit: query.limit }) };
}

/** Execute one command for an authenticated principal and schedule its follow-up work. */
export async function executeCommand(app: App, principal: Principal, envelope: unknown, exec: ExecutionContext): Promise<CommandReceipt> {
  const receipt = await app.service.execute(principal, envelope as Record<string, unknown>);
  if (!receipt.replayed) exec.waitUntil(afterCommit(app, principal));
  return receipt;
}

/* ------------------------------------------------------------------ */
/* Routes                                                               */
/* ------------------------------------------------------------------ */

export function coreRoutes(): RouteDef[] {
  return [
    owner("GET", "/v1/meta", "read", async ({ app }) =>
      json({
        apiVersion: API_VERSION,
        contractVersion: CONTRACT_VERSION,
        serverTime: now(app),
        environment: app.config.environment,
        modules: [
          { name: "foundation", mounted: true },
          { name: "daily", mounted: app.daily !== null },
          { name: "assistant", mounted: app.assistant !== null },
          { name: "media", mounted: app.media !== null },
        ],
        mcp: { endpoint: app.config.mcpResource, protocolVersions: [MCP_PROTOCOL_VERSION, MCP_COMPAT_PROTOCOL_VERSION], authorizationServer: app.config.mcpOrigin },
      }),
    ),

    owner("GET", "/v1/me", "read", async ({ app, session }) => json(await describeMe(app.db, session))),

    owner("GET", "/v1/wardrobe", "read", async ({ app, session, url }) => json(await listInventory(app.db, session.principal, parseInventoryQuery(url), { nowMs: app.now() }))),

    owner("GET", "/v1/wardrobe/resolve", "read", async ({ app, session, url }) => json(await resolveAlias(app.db, session.principal, readQuery(url, ResolveQuery).phrase))),

    // A read that takes a body: the selector can name many garments. Nothing is changed.
    owner("POST", "/v1/wardrobe/selection", "read", async ({ app, session, request }) => json(await previewGarmentSelection(app.db, session.principal, await readJson(request, GarmentSelector)))),

    owner("GET", "/v1/availability", "read", async ({ app, session, url }) => {
      const { date } = readQuery(url, AvailabilityQuery);
      return json(await getAvailability(app.db, session.principal, { ...(date ? { forDate: date } : {}), nowMs: app.now() }));
    }),

    owner("GET", "/v1/items/{id}", "read", async ({ app, session, params }) => json(await readItem(app, session.principal, params.id!))),

    owner("GET", "/v1/laundry", "read", async ({ app, session }) => json({ ...(await getLaundryState(app.db, session.principal)), readAt: now(app) })),

    // Temporary briefs are dated, so the profile is read for a day: the one asked for, or the owner's local today.
    owner("GET", "/v1/style", "read", async ({ app, session, url }) => {
      const { date } = readQuery(url, AvailabilityQuery);
      const forDate = date ?? localDateOf(app.now(), (await getSettings(app.db, session.principal)).settings.timezone);
      return json(await getStyleContext(app.db, session.principal, { forDate }));
    }),

    owner("POST", "/v1/style/preview-save", "read", async ({ app, session, request }) => {
      const body = await readJson(request, StylePreviewSaveRequest);
      return json(await previewStyleSave(app.db, session.principal, { content: body.content, ...(body.documentId ? { documentId: body.documentId } : {}) }));
    }),

    owner("GET", "/v1/style/conflicts", "read", async ({ app, session, url }) => {
      const q = readQuery(url, StyleConflictsQuery);
      return json({ conflicts: await listStyleFactConflicts(app.db, session.principal, { status: q.status, ...(q.documentId ? { documentId: q.documentId } : {}) }) });
    }),

    owner("GET", "/v1/days/{date}", "read", async ({ app, session, params }) => {
      const date = LocalDate.safeParse(params.date);
      if (!date.success) throw new ApiException("invalid_command", "the date must be written YYYY-MM-DD");
      return json(await getDailyRecord(app.db, session.principal, date.data));
    }),

    owner("GET", "/v1/settings", "read", async ({ app, session }) => json(await readSettings(app, session.principal))),

    owner("POST", "/v1/commands", "write", async ({ app, session, request, exec }) => {
      const envelope = await readJson(request, z.record(z.string(), z.unknown()));
      return json(await executeCommand(app, session.principal, envelope, exec));
    }),

    /*
     * Offline replay. The phone submits its queued commands in the order they were made, each with the
     * idempotency key it created at the time. Every command is independent: one refusal never blocks or
     * rolls back the others, and the response says per command whether it is final or worth retrying.
     */
    owner("POST", "/v1/commands/batch", "write", async ({ app, session, request, exec }) => {
      const body = await readJson(request, z.object({ commands: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_BATCH_COMMANDS) }), 4_000_000);
      const results: ({ status: "receipt"; idempotencyKey: string; receipt: CommandReceipt } | { status: "error"; idempotencyKey: string; error: ApiError; retryable: boolean })[] = [];
      let committed = false;
      for (const command of body.commands) {
        const idempotencyKey = typeof command.idempotencyKey === "string" ? command.idempotencyKey : "";
        try {
          const parsed = CommandEnvelope.safeParse(command);
          if (!parsed.success) throw new ApiException("invalid_command", "the command envelope is invalid", { issues: parsed.error.issues });
          const receipt = await app.service.execute(session.principal, command);
          committed ||= !receipt.replayed;
          results.push({ status: "receipt", idempotencyKey, receipt });
        } catch (error) {
          const n = normalizeError(error);
          if (n.code === "internal") console.error("batch command failed", String((error as Error)?.stack ?? error));
          results.push({ status: "error", idempotencyKey, error: { code: n.code, message: n.message, details: n.details }, retryable: isRetryable(n.code) });
        }
      }
      if (committed) exec.waitUntil(afterCommit(app, session.principal));
      const state = await getOwnerState(app.db, session.principal);
      return json({ results, wardrobeRevision: state.wardrobeRevision });
    }),

    owner("GET", "/v1/commands", "read", async ({ app, session, url }) => json(await listReceipts(app, session.principal, readQuery(url, ReceiptListQuery)))),

    owner("GET", "/v1/commands/{id}", "read", async ({ app, session, params }) => {
      const receipt = await app.service.getReceipt(session.principal, params.id!);
      if (!receipt) throw new ApiException("not_found", "that receipt was not found");
      return json(receipt);
    }),

    owner("GET", "/v1/command-types", "read", async ({ app }) => json(describeCommandTypes(app.registry))),
  ];
}
