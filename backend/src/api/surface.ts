import {
  CONTRACTS_VERSION,
  CreateTripRequest,
  EmailSyncRequest,
  PackingRequest,
  RecoverRequest,
  type LifecycleProject,
  type OperationReceipt,
  type Order,
  type ReturnDeadline,
} from '@garderobe/contracts';
import type { Env } from '../env.js';
import { findForgedOwnerFields, requireScope, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { DomainError } from '../domain/errors.js';
import { canonicalJson, sha256Hex } from '../domain/hash.js';
import { parseJson } from '../domain/db.js';
import { TripService } from '../trips/service.js';
import { loadTrip, loadTripItems, type TripRecord, type TripItemRecord } from '../trips/store.js';
import { EmailIntakeService } from '../intake/email.js';
import type { GmailAdapter } from '../connectors/google.js';
import { exportOwnerData, importExport, type ExportPackage } from '../export/index.js';
import { issueRecoveryCredential, recoverWithCredential } from '../lifecycle/recovery.js';
import { assistantFor } from '../assistant/index.js';
import { AccessError, verifyAccess } from '../auth/access.js';
import { accessHttpError } from '../auth/app.js';
import { HttpError } from './http.js';
import { studioFor } from './visual.js';
import { afterCommit, now, weatherProvider, calendarSource } from './services.js';

/**
 * The API surface for features that are service operations rather than domain commands (spec
 * sections 5, 9, 10, 15, 16): trips and packing, email intake, account recovery, export and import,
 * and the read models for orders, return deadlines, comfort reports, lifecycle projects, saved
 * combinations and the pause. Every write goes through the command policy: the owner comes from the
 * principal, owner fields in a body are refused, `wardrobe:write` is required, and an
 * `Idempotency-Key` makes a repeated request return the stored result instead of repeating the effect.
 */

let testGmail: GmailAdapter | null = null;

/** Tests and the simulation install a Gmail stand-in (FakeGmail) here. Production needs a Gmail connection. */
export function installTestGmail(g: GmailAdapter | null): void {
  testGmail = g;
}

function noOwnerFields(body: unknown): void {
  const forged = findForgedOwnerFields(body);
  if (forged.length) throw new DomainError('forbidden_owner_field', 'Owner identity comes from the authenticated connection', { fields: forged });
}

/**
 * Runs a service operation once per idempotency key: the result is stored in `runs`
 * (`kind = 'operation'`); a repeat with the same body returns it (`replayed: true`), a different body
 * with the same key is refused, and a concurrent duplicate is told to retry.
 */
export async function idempotentOperation(env: Env, principal: Principal, key: string | null, operation: string, args: unknown, fn: () => Promise<Record<string, unknown>>): Promise<OperationReceipt> {
  if (!key) return { operation, idempotencyKey: null, replayed: false, result: await fn() };
  if (!/^[A-Za-z0-9:._\-]{8,200}$/.test(key)) throw new HttpError(422, 'validation_failed', 'Idempotency-Key must be 8–200 characters of letters, digits and : . _ -');
  const runId = `run_op${(await sha256Hex(`${principal.userId}:${key}`)).slice(0, 40)}`;
  const requestHash = await sha256Hex(canonicalJson({ operation, args }));
  const at = now();
  const ins = await env.DB.prepare("INSERT INTO runs (user_id, run_id, kind, status, parent_ref, input_json, created_at, updated_at, version) VALUES (?, ?, 'operation', 'running', ?, ?, ?, ?, 1) ON CONFLICT (user_id, run_id) DO NOTHING")
    .bind(principal.userId, runId, `op:${key}`, JSON.stringify({ operation, requestHash }), at, at)
    .run();
  if (!ins.meta.changes) {
    const prior = await env.DB.prepare('SELECT status, input_json, result_json FROM runs WHERE user_id = ? AND run_id = ?').bind(principal.userId, runId).first<{ status: string; input_json: string; result_json: string | null }>();
    const input = parseJson<{ operation?: string; requestHash?: string }>(prior?.input_json, {});
    if (input.operation !== operation || input.requestHash !== requestHash) throw new HttpError(409, 'idempotency_key_reused', 'This idempotency key was already used for a different request');
    if (prior?.status === 'finished') return { operation, idempotencyKey: key, replayed: true, result: parseJson(prior.result_json, {}) };
    if (prior?.status === 'running') throw new HttpError(409, 'in_progress', 'This request is still being processed; retry shortly');
    // A failed attempt may be retried with the same key.
    await env.DB.prepare("UPDATE runs SET status = 'running', updated_at = ?, version = version + 1 WHERE user_id = ? AND run_id = ?").bind(at, principal.userId, runId).run();
  }
  try {
    const result = await fn();
    await env.DB.prepare("UPDATE runs SET status = 'finished', result_json = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND run_id = ?").bind(JSON.stringify(result), now(), principal.userId, runId).run();
    return { operation, idempotencyKey: key, replayed: false, result };
  } catch (err) {
    await env.DB.prepare("UPDATE runs SET status = 'failed', result_json = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND run_id = ?").bind(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), now(), principal.userId, runId).run();
    throw err;
  }
}

// ------------------------------------------------------------------ trips and packing

function trips(env: Env, principal: Principal): TripService {
  return new TripService({ db: env.DB, principal, weather: weatherProvider(env), calendar: calendarSource(), clock: now });
}

async function withNames(env: Env, principal: Principal, items: TripItemRecord[]) {
  if (!items.length) return [];
  const ids = items.map((i) => i.garmentId);
  const { results } = await env.DB.prepare(`SELECT garment_id, name FROM garments WHERE user_id = ? AND garment_id IN (${ids.map(() => '?').join(', ')})`).bind(principal.userId, ...ids).all<{ garment_id: string; name: string }>();
  const names = new Map(results.map((r) => [r.garment_id, r.name]));
  return items.map((i) => ({ ...i, name: names.get(i.garmentId) ?? i.garmentId }));
}

function tripView(t: TripRecord) {
  return { tripId: t.tripId, name: t.name, departsOn: t.departsOn, returnsOn: t.returnsOn, destinations: t.destinations, timezone: t.timezone, luggage: t.luggage, status: t.status, allowRepeats: t.allowRepeats, occasions: t.occasions, packedAt: t.packedAt, unpackedAt: t.unpackedAt, version: t.version };
}

export async function tripDetail(env: Env, principal: Principal, tripId: string, summary: string | null = null) {
  requireScope(principal, SCOPE_READ);
  const trip = await loadTrip(env.DB, principal.userId, tripId);
  if (!trip) throw new HttpError(404, 'not_found', `No trip ${tripId}`);
  return { schemaVersion: CONTRACTS_VERSION, trip: tripView(trip), items: await withNames(env, principal, await loadTripItems(env.DB, principal.userId, tripId)), summary };
}

export async function listTrips(env: Env, principal: Principal) {
  requireScope(principal, SCOPE_READ);
  const { results } = await env.DB.prepare('SELECT trip_id FROM trips WHERE user_id = ? ORDER BY departs_on DESC').bind(principal.userId).all<{ trip_id: string }>();
  const out = [];
  for (const r of results) {
    const t = await loadTrip(env.DB, principal.userId, r.trip_id);
    if (t) out.push(tripView(t));
  }
  return { schemaVersion: CONTRACTS_VERSION, trips: out };
}

export type TripOperation =
  | ({ type: 'create_trip' } & CreateTripRequest)
  | { type: 'propose_packing'; tripId: string }
  | ({ type: 'mark_packed'; tripId: string } & PackingRequest)
  | ({ type: 'mark_unpacked'; tripId: string } & PackingRequest)
  | ({ type: 'sync_email' } & { query?: string; maxPages?: number });

/** One entry point for the write operations, shared by the HTTP routes and garderobe_command. */
export async function runOperation(env: Env, ctx: ExecutionContext | undefined, principal: Principal, op: TripOperation, key: string | null): Promise<OperationReceipt> {
  noOwnerFields(op);
  requireScope(principal, SCOPE_WRITE);
  const svc = trips(env, principal);
  return idempotentOperation(env, principal, key, op.type, op, async () => {
    switch (op.type) {
      case 'create_trip': {
        const { type: _t, ...rest } = op;
        void _t;
        const input = CreateTripRequest.parse(rest);
        const trip = await svc.createTrip(input);
        return await tripDetail(env, principal, trip.tripId, `Trip created: ${trip.name}, ${trip.departsOn} to ${trip.returnsOn}. Nothing is packed yet.`);
      }
      case 'propose_packing': {
        const p = await svc.proposePacking(op.tripId);
        return { schemaVersion: CONTRACTS_VERSION, ...p };
      }
      case 'mark_packed': {
        const req = PackingRequest.parse({ items: op.items, occurredAt: op.occurredAt });
        let items = req.items;
        if (!items?.length) {
          const current = await loadTripItems(env.DB, principal.userId, op.tripId);
          items = current.filter((i) => i.proposedQty > 0).map((i) => ({ garmentId: i.garmentId, quantity: i.proposedQty }));
          if (!items.length) throw new DomainError('validation_failed', 'Name the packed pieces, or ask for a packing proposal first');
        }
        const r = await svc.markPacked(op.tripId, items, req.occurredAt);
        await afterCommit(env, ctx, principal.userId);
        return await tripDetail(env, principal, op.tripId, r.summary);
      }
      case 'mark_unpacked': {
        const req = PackingRequest.parse({ items: op.items, occurredAt: op.occurredAt });
        const r = await svc.markUnpacked(op.tripId, req.occurredAt, req.items);
        await afterCommit(env, ctx, principal.userId);
        return await tripDetail(env, principal, op.tripId, r.summary);
      }
      case 'sync_email': {
        const req = EmailSyncRequest.parse({ query: op.query, maxPages: op.maxPages });
        const gmail = testGmail;
        if (!gmail) throw new HttpError(409, 'gmail_not_connected', 'Gmail is not connected; connect it in Settings > Connections to find purchases in email');
        const report = await new EmailIntakeService(env.DB, principal, { gmail, now }).sync(req.query ?? 'subject:(order OR receipt OR dispatched OR shipped OR refund)', { maxPages: req.maxPages });
        await afterCommit(env, ctx, principal.userId);
        return { schemaVersion: CONTRACTS_VERSION, report: report as unknown as Record<string, unknown> };
      }
    }
  });
}

// ------------------------------------------------------------------ pause state

export async function pauseState(env: Env, principal: Principal) {
  requireScope(principal, SCOPE_READ);
  const p = await env.DB.prepare('SELECT pause_id, starts_on, resume_on, created_at, command_id FROM service_pauses WHERE user_id = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .bind(principal.userId)
    .first<{ pause_id: string; starts_on: string; resume_on: string | null; created_at: string; command_id: string | null }>();
  const { results } = await env.DB.prepare("SELECT board_date FROM calendar_projections WHERE user_id = ? AND status = 'suppressed' AND suppressed_reason = 'paused' ORDER BY board_date").bind(principal.userId).all<{ board_date: string }>();
  return {
    schemaVersion: CONTRACTS_VERSION,
    paused: Boolean(p),
    current: p ? { pauseId: p.pause_id, startsOn: p.starts_on, resumeOn: p.resume_on, createdAt: p.created_at, commandId: p.command_id } : null,
    suppressedDates: results.map((r) => r.board_date),
  };
}

// ------------------------------------------------------------------ orders, return deadlines, comfort, projects

interface DeadlineRow {
  deadline_id: string;
  line_id: string;
  kind: ReturnDeadline['kind'];
  deadline_at: string;
  timezone: string;
  terms_source: string;
  checked_at: string;
  status: string;
}

const deadlineOf = (d: DeadlineRow): ReturnDeadline => ({ deadlineId: d.deadline_id, lineId: d.line_id, kind: d.kind, deadlineAt: d.deadline_at, timezone: d.timezone, termsSource: d.terms_source, checkedAt: d.checked_at, status: d.status });

export async function listOrders(env: Env, principal: Principal): Promise<{ schemaVersion: typeof CONTRACTS_VERSION; orders: Order[] }> {
  requireScope(principal, SCOPE_READ);
  const u = principal.userId;
  const { results: orders } = await env.DB.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY ordered_at DESC').bind(u).all<Record<string, unknown>>();
  const { results: lines } = await env.DB.prepare('SELECT * FROM order_lines WHERE user_id = ? ORDER BY external_line_id').bind(u).all<Record<string, unknown>>();
  const { results: deadlines } = await env.DB.prepare('SELECT * FROM return_deadlines WHERE user_id = ? ORDER BY deadline_at').bind(u).all<DeadlineRow>();
  return {
    schemaVersion: CONTRACTS_VERSION,
    orders: orders.map((o) => ({
      orderId: String(o.order_id),
      merchant: String(o.merchant),
      merchantOrderNumber: String(o.merchant_order_number),
      orderedAt: String(o.ordered_at),
      currency: String(o.currency),
      sourceRef: (o.source_ref as string | null) ?? null,
      status: String(o.status),
      lines: lines
        .filter((l) => l.order_id === o.order_id)
        .map((l) => ({
          lineId: String(l.line_id),
          externalLineId: String(l.external_line_id),
          garmentId: (l.garment_id as string | null) ?? null,
          description: String(l.description),
          spec: parseJson<Record<string, unknown>>(l.spec_json as string, {}),
          quantity: Number(l.quantity),
          unitPriceMinor: Number(l.unit_price_minor),
          currency: String(l.currency),
          arrivalEstimate: (l.arrival_estimate as string | null) ?? null,
          arrivedQty: Number(l.arrived_qty),
          arrivedAt: (l.arrived_at as string | null | undefined) ?? null,
          refundedMinor: Number(l.refunded_minor),
          remakeOfLineId: (l.remake_of_line_id as string | null) ?? null,
          status: String(l.status),
          version: Number(l.version),
          returnDeadlines: deadlines.filter((d) => d.line_id === l.line_id).map(deadlineOf),
        })),
    })),
  };
}

export async function listReturnDeadlines(env: Env, principal: Principal, params: URLSearchParams) {
  requireScope(principal, SCOPE_READ);
  const all = params.get('status') === 'all';
  const { results } = await env.DB.prepare(
    `SELECT d.*, o.merchant, o.merchant_order_number, l.description, l.garment_id FROM return_deadlines d
     JOIN order_lines l ON l.user_id = d.user_id AND l.line_id = d.line_id JOIN orders o ON o.user_id = l.user_id AND o.order_id = l.order_id
     WHERE d.user_id = ? ${all ? '' : "AND d.status = 'open'"} ORDER BY d.deadline_at`,
  )
    .bind(principal.userId)
    .all<DeadlineRow & { merchant: string; merchant_order_number: string; description: string; garment_id: string | null }>();
  return { schemaVersion: CONTRACTS_VERSION, deadlines: results.map((r) => ({ ...deadlineOf(r), merchant: r.merchant, merchantOrderNumber: r.merchant_order_number, description: r.description, garmentId: r.garment_id })) };
}

export async function listComfort(env: Env, principal: Principal, params: URLSearchParams) {
  requireScope(principal, SCOPE_READ);
  const garmentId = params.get('garmentId');
  const { results } = await env.DB.prepare(`SELECT * FROM comfort_feedback WHERE user_id = ? ${garmentId ? 'AND garment_id = ?' : ''} ORDER BY created_at DESC`)
    .bind(principal.userId, ...(garmentId ? [garmentId] : []))
    .all<Record<string, unknown>>();
  return {
    schemaVersion: CONTRACTS_VERSION,
    feedback: results.map((r) => ({
      feedbackId: String(r.feedback_id),
      garmentId: (r.garment_id as string | null) ?? null,
      combinationRef: (r.combination_ref as string | null) ?? null,
      wearingDate: (r.wearing_date as string | null) ?? null,
      activity: (r.activity as string | null) ?? null,
      layer: (r.layer as string | null) ?? null,
      conditions: parseJson<Record<string, unknown>>(r.conditions_json as string, {}),
      text: String(r.text),
      scope: String(r.scope),
      createdAt: String(r.created_at),
    })),
  };
}

export async function listProjects(env: Env, principal: Principal, projectId?: string): Promise<LifecycleProject[]> {
  requireScope(principal, SCOPE_READ);
  const u = principal.userId;
  const { results } = await env.DB.prepare(`SELECT * FROM lifecycle_projects WHERE user_id = ? ${projectId ? 'AND project_id = ?' : ''} ORDER BY updated_at DESC`)
    .bind(u, ...(projectId ? [projectId] : []))
    .all<Record<string, unknown>>();
  const { results: items } = await env.DB.prepare('SELECT i.project_id, i.garment_id, i.quantity, g.name FROM lifecycle_project_items i JOIN garments g ON g.user_id = i.user_id AND g.garment_id = i.garment_id WHERE i.user_id = ?')
    .bind(u)
    .all<{ project_id: string; garment_id: string; quantity: number; name: string }>();
  return results.map((p) => ({
    projectId: String(p.project_id),
    kind: p.kind as LifecycleProject['kind'],
    status: String(p.status),
    details: parseJson<Record<string, unknown>>(p.details_json as string, {}),
    expectedReturn: (p.expected_return as string | null) ?? null,
    actualReturn: (p.actual_return as string | null) ?? null,
    items: items.filter((i) => i.project_id === p.project_id).map((i) => ({ garmentId: i.garment_id, name: i.name, quantity: i.quantity })),
    createdAt: String(p.created_at),
    updatedAt: String(p.updated_at),
    version: Number(p.version),
  }));
}

export async function listCombinations(env: Env, principal: Principal, params: URLSearchParams) {
  const kind = params.get('kind');
  if (kind && kind !== 'saved' && kind !== 'plan') throw new HttpError(422, 'validation_failed', 'kind must be saved or plan');
  const from = params.get('from') ?? undefined;
  const to = params.get('to') ?? undefined;
  for (const d of [from, to]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new HttpError(422, 'validation_failed', 'from and to must be YYYY-MM-DD');
  const combinations = await studioFor(env, principal).listCombinations({ kind: (kind as 'saved' | 'plan' | null) ?? undefined, from, to, includeInactive: params.get('includeInactive') === '1' });
  return { schemaVersion: CONTRACTS_VERSION, combinations };
}

// ------------------------------------------------------------------ account recovery, export, import

/** POST /v1/auth/recovery-kit: a new one-time recovery code (replaces any earlier one). App only. */
export async function recoveryKit(env: Env, principal: Principal) {
  requireScope(principal, SCOPE_WRITE);
  const kit = await issueRecoveryCredential(env.DB, principal.userId, now());
  return { schemaVersion: CONTRACTS_VERSION, ...kit };
}

/**
 * POST /v1/auth/recover: the dedicated recovery route. The caller has a verified Access identity that
 * is not linked to any owner yet (a new Google or Apple sign-in); the recovery code binds it to the
 * owner and revokes every earlier session and assistant grant.
 */
export async function recover(env: Env, request: Request, raw: unknown) {
  let identity;
  try {
    identity = await verifyAccess(env, request);
  } catch (err) {
    if (err instanceof AccessError) throw accessHttpError(err);
    throw err;
  }
  noOwnerFields(raw);
  const { credential } = RecoverRequest.parse(raw);
  let outcome;
  try {
    outcome = await recoverWithCredential(env.DB, { credential, newIdentity: { issuer: identity.issuer, subject: identity.subject, ...(identity.email ? { email: identity.email } : {}) } }, now());
  } catch (err) {
    if (err instanceof DomainError && err.code === 'insufficient_scope') throw new HttpError(429, 'too_many_attempts', err.message);
    if (err instanceof DomainError && err.code === 'unauthenticated') throw new HttpError(401, 'recovery_failed', 'That recovery code is not valid');
    throw err;
  }
  const user = await env.DB.prepare('SELECT display_name FROM users WHERE user_id = ?').bind(outcome.userId).first<{ display_name: string }>();
  return { schemaVersion: CONTRACTS_VERSION, recovered: true as const, displayName: user?.display_name ?? '', sessionsValidAfter: outcome.sessionsValidAfter, replacementKit: outcome.replacementKit };
}

/** POST /v1/export: the portable owner export, including the conversation transcript from Think. */
export async function exportData(env: Env, principal: Principal): Promise<ExportPackage> {
  requireScope(principal, SCOPE_READ);
  let transcript: { id: string; role: string; text: string }[] | undefined;
  try {
    const raw = await (await assistantFor(env, principal)).rawTranscript(100_000);
    transcript = raw.map((m) => ({ id: m.id, role: m.role, text: m.text }));
  } catch (err) {
    // Without the transcript the export says it is incomplete rather than presenting itself as complete.
    console.warn('transcript unavailable for export', err instanceof Error ? err.message : String(err));
  }
  return exportOwnerData(env.DB, principal, { now: now(), transcript });
}

/** POST /v1/import and the MCP import_data operation: a verified export into this (empty) owner. */
export async function importData(env: Env, principal: Principal, raw: unknown) {
  requireScope(principal, SCOPE_WRITE);
  if (!raw || typeof raw !== 'object' || !('manifest' in raw) || !('files' in raw)) throw new HttpError(422, 'validation_failed', 'Send a garderobe-export/1 package ({ manifest, files })');
  const claimId = await claimEmptyOwner(env, principal);
  let result;
  try {
    // Every write batch of the import is fenced on this claim (see fencedImportDb).
    result = await importExport(fencedImportDb(env.DB, principal.userId, claimId), principal, raw as ExportPackage, { now: now() });
  } catch (err) {
    // A claim taken over while this import stalled: none of this import's batches committed.
    if (!(await holdsClaim(env, principal.userId, claimId))) {
      throw new HttpError(409, 'import_superseded', 'This import stalled and another import into this Garderobe took over; nothing from this package was imported');
    }
    // Nothing written (for example a package that fails verification): release the claim so a valid
    // package can still be imported. Once any batch has committed, the claim stays (failed), so no
    // other import is ever laid on top of partial rows.
    const released = await env.DB.prepare('DELETE FROM import_claims WHERE owner_user = ? AND claim_id = ? AND writes = 0').bind(principal.userId, claimId).run();
    if (!released.meta.changes) await env.DB.prepare("UPDATE import_claims SET status = 'failed', completed_at = ? WHERE owner_user = ? AND claim_id = ?").bind(now(), principal.userId, claimId).run();
    throw err;
  }
  await env.DB.prepare("UPDATE import_claims SET status = 'imported', completed_at = ? WHERE owner_user = ? AND claim_id = ?").bind(now(), principal.userId, claimId).run();
  return { schemaVersion: CONTRACTS_VERSION, imported: true as const, tables: result.tables };
}

/** The same records the import service counts to decide an owner is not empty. */
const EMPTY_OWNER = 'NOT EXISTS (SELECT 1 FROM garments WHERE user_id = ?1) AND NOT EXISTS (SELECT 1 FROM style_documents WHERE user_id = ?1) AND NOT EXISTS (SELECT 1 FROM command_receipts WHERE user_id = ?1)';

export const IMPORT_CLAIM_STALE_MS = 10 * 60_000;

async function holdsClaim(env: Env, userId: string, claimId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare('SELECT 1 AS ok FROM import_claims WHERE owner_user = ? AND claim_id = ?').bind(userId, claimId).first());
}

let importTestHook: ((claimId: string, batch: number) => Promise<void>) | null = null;

/** Tests only: runs before each fenced write batch (used to stall an importer deterministically). */
export function installImportTestHook(hook: ((claimId: string, batch: number) => Promise<void>) | null): void {
  importTestHook = hook;
}

/**
 * The database handle the import service writes through. Reads pass straight through; every batch
 * (the import service writes only in batches) is wrapped so that, in the same D1 transaction:
 *  1. a precondition row fails the whole batch (CHECK ok = 1) unless this claim is still held and
 *     still `importing`;
 *  2. the claim's heartbeat (`claimed_at`) and write count are updated;
 *  3. the precondition row is removed.
 * A superseded importer therefore writes nothing, whatever point it resumes from. The handle refuses
 * every other write path (`exec`, a prepared statement's `run`, sessions, dumps), so a future change to
 * the import service cannot write around the fence: statements it prepares may be read (`all`,
 * `first`, `raw`) or written only through `batch`.
 */
function fencedImportDb(db: D1Database, userId: string, claimId: string): D1Database {
  const refuse = (what: string) => () => {
    throw new Error(`Import writes must go through the claim-fenced batch; ${what} is not allowed on the import handle`);
  };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === 'run') return refuse('run()');
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  const unwrap = (s: D1PreparedStatement) => real.get(s) ?? s;
  let n = 0;
  const batch = async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const index = n++;
    if (importTestHook) await importTestHook(claimId, index);
    const checkId = `icl_fence_${crypto.randomUUID().replace(/-/g, '')}`;
    const results = await db.batch<T>([
      db
        .prepare("INSERT INTO command_preconditions (check_id, ok) SELECT ?1, CASE WHEN EXISTS (SELECT 1 FROM import_claims WHERE owner_user = ?2 AND claim_id = ?3 AND status = 'importing') THEN 1 ELSE 0 END")
        .bind(checkId, userId, claimId),
      db.prepare('UPDATE import_claims SET claimed_at = ?1, writes = writes + 1 WHERE owner_user = ?2 AND claim_id = ?3').bind(now(), userId, claimId),
      ...statements.map(unwrap),
      db.prepare('DELETE FROM command_preconditions WHERE check_id = ?').bind(checkId),
    ]);
    return results.slice(2, 2 + statements.length);
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') return batch;
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (prop === 'exec' || prop === 'withSession' || prop === 'dump') return refuse(`${String(prop)}()`);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Tests only: the fenced handle the import service is given, for checking its refused write paths. */
export const fencedImportDbForTest = fencedImportDb;

/**
 * Claims the owner for one import. The empty-owner check and the claim are one conditional INSERT, so
 * of two confirmations arriving together exactly one gets the claim; the other is refused before it
 * writes anything. A claim may be taken over only when its importer has written nothing (`writes = 0`)
 * and has been silent for ten minutes; the importer it was taken from is fenced out (fencedImportDb).
 */
async function claimEmptyOwner(env: Env, principal: Principal): Promise<string> {
  const userId = principal.userId;
  const at = now();
  const claimId = `icl_${crypto.randomUUID().replace(/-/g, '')}`;
  const stale = new Date(Date.parse(at) - IMPORT_CLAIM_STALE_MS).toISOString();
  await env.DB.prepare(`DELETE FROM import_claims WHERE owner_user = ?1 AND status IN ('importing', 'failed') AND writes = 0 AND claimed_at < ?2 AND ${EMPTY_OWNER}`).bind(userId, stale).run();
  const r = await env.DB.prepare(`INSERT OR IGNORE INTO import_claims (owner_user, claim_id, status, claimed_at) SELECT ?1, ?2, 'importing', ?3 WHERE ${EMPTY_OWNER}`).bind(userId, claimId, at).run();
  if (r.meta.changes) return claimId;
  const existing = await env.DB.prepare('SELECT status FROM import_claims WHERE owner_user = ?').bind(userId).first<{ status: string }>();
  if (existing?.status === 'importing') throw new HttpError(409, 'import_in_progress', 'Another import into this Garderobe is already running; nothing was imported');
  throw new DomainError('invalid_state', 'Imports go into an empty owner only; this owner already has records');
}
