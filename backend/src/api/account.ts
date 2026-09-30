import {
  CONTRACTS_VERSION,
  RegisterConnectionRequest,
  type Connection,
  type ConnectionsResponse,
  type DisconnectResponse,
  type LaundryState,
  type ReceiptsPage,
  type SettingsResponse,
  type StyleCurrentResponse,
} from '@garderobe/contracts';
import type { Env } from '../env.js';
import type { Principal } from '../domain/principal.js';
import { requireScope, SCOPE_WRITE } from '../domain/principal.js';
import { getLaundryState, loadSettings, routineOf } from '../domain/laundry.js';
import { listStyleDocuments, listStyleRules } from '../domain/style.js';
import { hydrateReceipt } from '../domain/commands/service.js';
import { addDays, dayOfWeek, localDateOf, zonedInstant } from '../domain/time.js';
import { connectionRegistry } from '../connectors/index.js';
import { usesSimulatedModel } from '../assistant/runtime.js';
import { listGrants, revokeGrant } from '../auth/grants.js';
import type { EnvWithOAuth } from '../auth/oauth.js';
import { HttpError } from './http.js';
import { now } from './services.js';

/** Settings, My style, connections, connected assistants, laundry and receipts read models. */

export async function styleCurrent(env: Env, principal: Principal): Promise<StyleCurrentResponse> {
  const documents = await listStyleDocuments(env.DB, principal);
  if (!documents.length) throw new HttpError(404, 'not_found', 'No style document has been imported yet');
  const rules = await listStyleRules(env.DB, principal);
  const active = rules.filter((r) => r.status === 'active');
  return {
    schemaVersion: CONTRACTS_VERSION,
    document: documents[0]!,
    documents,
    rules: { active: active.length, hard: active.filter((r) => r.strength === 'hard').length, missingPassages: active.filter((r) => r.passageStatus === 'missing').length },
  };
}

const CONNECTION_CAPS: Record<string, string[]> = {
  gmail: ['Find purchases in email'],
  calendar: ['Read the day', 'Outfit calendar'],
  drive: ['Export files'],
  sheets: ['Read spreadsheets'],
  exa: ['Web search'],
  tavily: ['Web search and extraction'],
  mcp: ['Tools'],
};

export async function listConnections(env: Env, principal: Principal): Promise<Connection[]> {
  const out: Connection[] = [];
  const records = await connectionRegistry(env as never, principal).list();
  const present = new Set(records.map((r) => r.kind));
  for (const kind of ['gmail', 'calendar'] as const) {
    if (!present.has(kind)) {
      out.push({
        connectionId: `con_${kind}_not_connected`,
        kind,
        displayName: kind === 'gmail' ? 'Gmail' : 'Google Calendar',
        status: 'disconnected',
        capabilities: (CONNECTION_CAPS[kind] ?? []).map((name) => ({ name, available: false, missingPermission: kind === 'gmail' ? 'gmail.readonly' : 'calendar' })),
        lastSuccessAt: null,
        lastSuccessOperation: null,
        lastError: null,
        reconnectUrl: `/v1/connections/${kind}/connect`,
        client: null,
        scopes: [],
        endpoint: null,
        protocolVersion: null,
      });
    }
  }
  for (const r of records) {
    const health = r.health as { ok?: boolean; at?: string; operation?: string; reason?: string };
    const status: Connection['status'] = r.status === 'active' ? (health.ok === false ? 'error' : 'connected') : r.status === 'reconnect_required' ? 'needs_reauth' : 'disconnected';
    const kind = (['gmail', 'calendar', 'drive', 'sheets'] as const).includes(r.kind as never) ? (r.kind as Connection['kind']) : r.kind === 'exa' || r.kind === 'tavily' ? 'search' : 'mcp';
    out.push({
      connectionId: r.connectionId,
      kind,
      displayName: r.name,
      status,
      capabilities: r.kind === 'mcp' ? r.tools.map((t) => ({ name: t.name, available: t.approved && r.allowedEffects.includes(t.effect), missingPermission: r.allowedEffects.includes(t.effect) ? (t.approved ? null : 'schema approval') : `${t.effect} effect` })) : (CONNECTION_CAPS[r.kind] ?? []).map((name) => ({ name, available: status === 'connected', missingPermission: status === 'connected' ? null : 'reconnect' })),
      lastSuccessAt: health.ok ? (health.at ?? null) : null,
      lastSuccessOperation: health.ok ? (health.operation ?? null) : null,
      lastError: health.ok === false ? (health.reason ?? 'error') : null,
      reconnectUrl: status === 'connected' ? null : `/v1/connections/${r.connectionId}/connect`,
      client: null,
      scopes: r.allowedEffects,
      endpoint: r.endpoint,
      protocolVersion: r.protocolVersion,
    });
  }
  for (const g of await listGrants(env.DB, principal.userId)) {
    if (g.status !== 'active') continue;
    out.push({
      connectionId: g.grantId,
      kind: 'assistant_grant',
      displayName: g.client === 'claude' ? 'Claude' : g.client === 'chatgpt' ? 'ChatGPT' : g.clientName,
      status: 'connected',
      capabilities: [
        { name: 'Read your wardrobe', available: true, missingPermission: null },
        { name: 'Make changes', available: g.canWrite, missingPermission: g.canWrite ? null : 'wardrobe:write' },
      ],
      lastSuccessAt: g.lastUsedAt,
      lastSuccessOperation: g.lastOperation,
      lastError: null,
      reconnectUrl: null,
      client: g.client,
      scopes: g.scopes,
      endpoint: null,
      protocolVersion: null,
    });
  }
  return out;
}

export async function connectionsResponse(env: Env, principal: Principal): Promise<ConnectionsResponse> {
  return { schemaVersion: CONTRACTS_VERSION, connections: await listConnections(env, principal) };
}

/** POST /v1/connections: an owner-chosen remote MCP server. Endpoint validation happens in the registry. */
export async function registerConnection(env: Env, principal: Principal, raw: unknown): Promise<Connection> {
  requireScope(principal, SCOPE_WRITE);
  const req = RegisterConnectionRequest.parse(raw);
  const credentialRef = req.credentialSecretName ? `env:${req.credentialSecretName}` : undefined;
  const record = await connectionRegistry(env as never, principal).add({ name: req.name, endpoint: req.endpoint, allowedEffects: req.allowedEffects, credentialRef, expectedIssuer: req.expectedIssuer, dataClasses: req.dataClasses });
  const all = await listConnections(env, principal);
  return all.find((c) => c.connectionId === record.connectionId)!;
}

/** POST /v1/connections/{id}/disconnect: consumer MCP grants and outbound connections alike. */
export async function disconnect(env: EnvWithOAuth, principal: Principal, id: string): Promise<DisconnectResponse> {
  requireScope(principal, SCOPE_WRITE);
  if (id.startsWith('mgr_')) {
    const r = await revokeGrant(env.DB, env.OAUTH_PROVIDER, principal.userId, id, 'owner disconnected', now());
    if (!r.revoked) throw new HttpError(404, 'not_found', `No connection ${id}`);
    return { schemaVersion: CONTRACTS_VERSION, connectionId: id, status: 'disconnected', cancelledCalls: 0, remoteRevocation: r.remoteRevocation };
  }
  const r = await connectionRegistry(env as never, principal).disconnect(id);
  return { schemaVersion: CONTRACTS_VERSION, connectionId: id, status: 'disconnected', cancelledCalls: r.cancelledCalls, remoteRevocation: r.revoked ? 'revoked' : 'not_supported' };
}

export async function settingsResponse(env: Env, principal: Principal): Promise<SettingsResponse> {
  const s = await loadSettings(env.DB, principal);
  if (!s) throw new HttpError(404, 'not_found', 'Settings have not been created yet');
  const calendar = await env.DB.prepare('SELECT calendar_id, model_profiles_json, budget_json FROM owner_settings WHERE user_id = ?')
    .bind(principal.userId)
    .first<{ calendar_id: string | null; model_profiles_json: string; budget_json: string }>();
  const docs = await listStyleDocuments(env.DB, principal);
  const connections = await listConnections(env, principal);
  return {
    schemaVersion: CONTRACTS_VERSION,
    homeLocationLabel: s.home_location_label,
    timezone: s.timezone,
    deliveryTime: s.delivery_time,
    dailyOptionCount: s.daily_option_count,
    laundryRoutine: routineOf(s),
    version: s.version,
    calendarId: calendar?.calendar_id ?? null,
    styleDocuments: docs.map((d) => ({ documentId: d.documentId, title: d.title, version: d.version, contentSha256: d.contentSha256, byteLength: d.byteLength, authoredOn: d.authoredOn })),
    connectedAssistants: await listGrants(env.DB, principal.userId),
    connections: connections.filter((c) => c.kind !== 'assistant_grant'),
    models: { simulated: usesSimulatedModel(env), profiles: JSON.parse(calendar?.model_profiles_json ?? '{}') as Record<string, unknown> },
    budget: JSON.parse(calendar?.budget_json ?? '{}') as Record<string, unknown>,
  };
}

export async function laundryState(env: Env, principal: Principal): Promise<LaundryState> {
  const state = await getLaundryState(env.DB, principal);
  const s = await loadSettings(env.DB, principal);
  const tz = s?.timezone ?? env.DEFAULT_TIMEZONE ?? 'Europe/London';
  const routine = routineOf(s);
  const at = now();
  const today = localDateOf(at, tz);
  let nextCollectionAt: string | null = null;
  for (let i = 0; i < 8 && !nextCollectionAt; i++) {
    const d = addDays(today, i);
    if (dayOfWeek(d) !== routine.service.collectDow) continue;
    const inst = zonedInstant(d, routine.service.collectTime, tz);
    if (inst > at) nextCollectionAt = inst;
  }
  const ids = [...new Set([...state.hamper.service, ...state.hamper.handWash].map((h) => h.garmentId))];
  const tracking = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const { results } = await env.DB.prepare(`SELECT garment_id, tracking FROM garments WHERE user_id = ? AND garment_id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(principal.userId, ...chunk)
      .all<{ garment_id: string; tracking: string }>();
    for (const r of results) tracking.set(r.garment_id, r.tracking);
  }
  const line = (h: { garmentId: string; name: string; quantity: number }) => ({ ...h, tracking: (tracking.get(h.garmentId) ?? 'unit') as 'unit' | 'anonymous_quantity' });
  const batchRows = state.batches.length
    ? (
        await env.DB.prepare(`SELECT batch_id, lot_id, garment_id FROM laundry_batch_items WHERE user_id = ? AND batch_id IN (${state.batches.map(() => '?').join(', ')})`)
          .bind(principal.userId, ...state.batches.map((b) => b.batchId))
          .all<{ batch_id: string; lot_id: string; garment_id: string }>()
      ).results
    : [];
  const names = new Map<string, string>();
  for (const h of [...state.hamper.service, ...state.hamper.handWash]) names.set(h.garmentId, h.name);
  for (const b of state.batches) for (const i of b.items) names.set(i.garmentId, i.name);
  return {
    schemaVersion: CONTRACTS_VERSION,
    asOf: at,
    service: {
      hamper: state.hamper.service.map(line),
      batches: state.batches.map((b) => ({
        batchId: b.batchId,
        channel: 'service' as const,
        status: b.status as 'collected' | 'partially_returned',
        collectedAt: b.collectedAt,
        returnedAt: b.returnedAt,
        version: b.version,
        items: b.items.map((i) => ({
          garmentId: i.garmentId,
          lotId: batchRows.find((r) => r.batch_id === b.batchId && r.garment_id === i.garmentId)?.lot_id ?? 'lot_unknown',
          quantity: i.quantity,
          returnedQuantity: i.returnedQuantity,
          status: i.status as 'away' | 'returned' | 'missing',
        })),
        names: Object.fromEntries(b.items.map((i) => [i.garmentId, i.name])),
      })),
      nextCollectionAt,
    },
    handWash: { hamper: state.hamper.handWash.map(line) },
    openExceptions: state.openExceptions.map((e) => ({ ...e, name: names.get(e.garmentId) ?? e.garmentId })),
  };
}

/** GET /v1/receipts?cursor=&limit=: every stored receipt, newest first. */
export async function receiptsPage(env: Env, principal: Principal, params: URLSearchParams): Promise<ReceiptsPage> {
  const limit = Math.min(Math.max(Number.parseInt(params.get('limit') ?? '50', 10) || 50, 1), 200);
  const cursor = params.get('cursor');
  let where = 'user_id = ?';
  const binds: unknown[] = [principal.userId];
  if (cursor) {
    const [at, id] = cursor.split('|');
    if (!at || !id) throw new HttpError(422, 'validation_failed', 'Invalid cursor');
    where += ' AND (recorded_at < ? OR (recorded_at = ? AND command_id < ?))';
    binds.push(at, at, id);
  }
  const { results } = await env.DB.prepare(`SELECT command_id, request_hash, receipt_json, undo_json, undone_by_command_id, recorded_at FROM command_receipts WHERE ${where} ORDER BY recorded_at DESC, command_id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<{ command_id: string; request_hash: string; receipt_json: string; undo_json: string | null; undone_by_command_id: string | null; recorded_at: string }>();
  const page = results.slice(0, limit);
  const receipts = await Promise.all(page.map((r) => hydrateReceipt(env.DB, principal.userId, r as never)));
  const last = page[page.length - 1];
  return { schemaVersion: CONTRACTS_VERSION, receipts, nextCursor: results.length > limit && last ? `${last.recorded_at}|${last.command_id}` : null };
}
