import {
  CONTRACTS_VERSION,
  type AccountTransfers,
  type ExportDownloadResult,
  type McpImportResult,
  type OperationReceipt,
  type RecoveryKitLink,
  type RecoveryStatus,
  type StagedImportPackage,
} from '@garderobe/contracts';
import type { Env } from '../env.js';
import { findForgedOwnerFields, requireScope, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { DomainError } from '../domain/errors.js';
import { parseJson } from '../domain/db.js';
import { verifyExport, type ExportPackage } from '../export/index.js';
import { issueRecoveryCredential } from '../lifecycle/recovery.js';
import { signState, verifyState } from '../auth/jose.js';
import { stateSecret } from '../auth/oauth.js';
import { HttpError } from './http.js';
import { now } from './services.js';
import { exportData, idempotentOperation, importData } from './surface.js';

/**
 * Export, import and recovery reached from a connected assistant (the owner's request of 2026-09-29,
 * a deliberate departure from spec sections 15/16, which kept them app-only). The safeguards:
 *
 * - Each action is a `garderobe_command` operation: write scope, an idempotency key, and the owner's
 *   confirmation through the pending-action flow before anything runs. Read-only grants get a proposal.
 * - Nothing private goes into the assistant's transcript. An export is stored privately (R2) and
 *   delivered by a short-lived signed link that also needs the owner's Garderobe sign-in; an import
 *   reads a package the owner staged in Garderobe (never a package pasted into a chat); a recovery
 *   code is issued only when the signed-in owner opens a one-time collection link in Garderobe.
 * - Links are stateless HMAC tokens bound to the owner, the transfer and an expiry; no link or code
 *   is stored. The export/import service is used unchanged (verifyExport, empty-owner import, revoked
 *   grants, no sessions).
 * - Every step is audited in `account_audit` with the surface and the connection that asked.
 */

export const EXPORT_LINK_TTL_MS = 15 * 60_000;
export const RECOVERY_LINK_TTL_MS = 15 * 60_000;
export const STAGED_IMPORT_TTL_MS = 24 * 3600_000;
export const MAX_IMPORT_PACKAGE_BYTES = 50_000_000;

export type AccountOperation = { type: 'export_data' } | { type: 'import_data'; packageId: string } | { type: 'issue_recovery_kit' };
export const ACCOUNT_OPERATIONS: ReadonlySet<string> = new Set(['export_data', 'import_data', 'issue_recovery_kit']);
export function isAccountOperation(op: { type: string }): op is AccountOperation {
  return ACCOUNT_OPERATIONS.has(op.type);
}

export interface AccountMeta {
  surface: 'mcp' | 'app' | 'web';
  grantRef: string | null;
}

type LinkKind = 'export' | 'recovery';
interface LinkClaims {
  k: LinkKind;
  u: string;
  x: string;
  exp: number;
}

const exportObjectKey = (userId: string, transferId: string) => `private/exports/${userId}/${transferId}.json`;
const stagedObjectKey = (userId: string, packageId: string) => `private/import-packages/${userId}/${packageId}.json`;
const newRef = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

/** An export id as Garderobe issues it (`exp_` + 32 hex); anything else from a file is not shown. */
export function safeExportId(value: unknown): string | null {
  return typeof value === 'string' && /^exp_[a-f0-9]{32}$/.test(value) ? value : null;
}

/** The calendar date of a file's exportedAt, only when it is a real ISO instant. */
export function safeExportDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) return null;
  return value.slice(0, 10);
}

/**
 * A display name from a file, shown only when it is a short, single-line, plain name (letters, spaces,
 * hyphens, apostrophes, full stops; at most 40 characters and 5 words). Otherwise it is left out.
 */
export function safeFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > 40 || name.split(/\s+/).length > 5) return null;
  return /^[\p{L}][\p{L}\p{M} .'’-]*$/u.test(name) && !/\s{2,}/.test(name) ? name : null;
}

function noOwnerFields(body: unknown): void {
  const forged = findForgedOwnerFields(body);
  if (forged.length) throw new DomainError('forbidden_owner_field', 'Owner identity comes from the authenticated connection', { fields: forged });
}

export async function audit(env: Env, principal: Principal, entry: { action: string; surface: string; grantRef?: string | null; idempotencyKey?: string | null; outcome: string; detail?: Record<string, unknown> }): Promise<void> {
  await env.DB.prepare('INSERT INTO account_audit (user_id, audit_id, action, surface, grant_ref, idempotency_key, outcome, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(principal.userId, newRef('aud'), entry.action, entry.surface, entry.grantRef ?? null, entry.idempotencyKey ?? null, entry.outcome, JSON.stringify(entry.detail ?? {}), now())
    .run();
}

/** Signed, owner-bound link token. Deterministic, so a replayed operation returns the same link. */
function linkToken(env: Env, claims: LinkClaims): Promise<string> {
  return signState(stateSecret(env), { k: claims.k, u: claims.u, x: claims.x, exp: claims.exp });
}

async function verifyLink(env: Env, principal: Principal, kind: LinkKind, transferId: string, token: string | null): Promise<void> {
  const claims = token ? await verifyState<LinkClaims>(stateSecret(env), token) : null;
  if (!claims || claims.k !== kind || claims.x !== transferId || claims.u !== principal.userId) throw new HttpError(403, 'invalid_link', 'This link is not valid for the signed-in owner');
  if (typeof claims.exp !== 'number' || claims.exp <= Date.parse(now())) throw new HttpError(410, 'link_expired', 'This link has expired; ask again from Garderobe or your assistant');
}

/** Deletes this owner's expired private packages and marks them expired. */
async function sweepExpired(env: Env, userId: string): Promise<void> {
  const { results } = await env.DB.prepare("SELECT transfer_id, kind FROM account_transfers WHERE user_id = ? AND status IN ('ready', 'staged', 'pending') AND expires_at <= ?").bind(userId, now()).all<{ transfer_id: string; kind: string }>();
  for (const r of results) {
    if (r.kind === 'export_download') await env.MEDIA.delete(exportObjectKey(userId, r.transfer_id));
    if (r.kind === 'import_package') await env.MEDIA.delete(stagedObjectKey(userId, r.transfer_id));
    await env.DB.prepare("UPDATE account_transfers SET status = 'expired' WHERE user_id = ? AND transfer_id = ? AND status IN ('ready', 'staged', 'pending')").bind(userId, r.transfer_id).run();
  }
}

async function insertTransfer(env: Env, principal: Principal, row: { transferId: string; kind: string; status: string; ref: string | null; summary: Record<string, unknown>; meta: AccountMeta; idempotencyKey: string | null; expiresAt: string }): Promise<void> {
  await env.DB.prepare('INSERT INTO account_transfers (user_id, transfer_id, kind, status, ref, summary_json, surface, grant_ref, idempotency_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(principal.userId, row.transferId, row.kind, row.status, row.ref, JSON.stringify(row.summary), row.meta.surface, row.meta.grantRef, row.idempotencyKey, row.expiresAt, now())
    .run();
}

// ------------------------------------------------------------------ export

async function createExportDownload(env: Env, principal: Principal, meta: AccountMeta, key: string | null): Promise<ExportDownloadResult> {
  requireScope(principal, SCOPE_READ);
  await sweepExpired(env, principal.userId);
  const pkg = await exportData(env, principal);
  const transferId = newRef('xfr');
  const expiresAt = new Date(Date.parse(now()) + EXPORT_LINK_TTL_MS).toISOString();
  await env.MEDIA.put(exportObjectKey(principal.userId, transferId), JSON.stringify(pkg), { httpMetadata: { contentType: 'application/json' }, customMetadata: { exportId: pkg.manifest.exportId } });
  const tables = pkg.manifest.tables.map((t) => ({ name: t.name, rows: t.rows }));
  const garments = tables.find((t) => t.name === 'garments')?.rows ?? 0;
  const incomplete = pkg.manifest.incomplete.map((i) => i.component);
  const summary = `Export ${pkg.manifest.exportId} is ready: ${garments} garments across ${tables.length} tables${incomplete.length ? ` (not included: ${incomplete.join(', ')})` : ''}. Download it from the private link, signed in to Garderobe, before ${expiresAt}. The record itself was not sent to the assistant.`;
  await insertTransfer(env, principal, { transferId, kind: 'export_download', status: 'ready', ref: pkg.manifest.exportId, summary: { exportId: pkg.manifest.exportId, packageSha256: pkg.manifest.packageSha256, tables: tables.length, garments, complete: pkg.manifest.complete }, meta, idempotencyKey: key, expiresAt });
  await audit(env, principal, { action: 'export', surface: meta.surface, grantRef: meta.grantRef, idempotencyKey: key, outcome: 'link_issued', detail: { exportId: pkg.manifest.exportId, transferId, expiresAt } });
  return {
    schemaVersion: CONTRACTS_VERSION,
    exportId: pkg.manifest.exportId,
    transferId,
    exportedAt: pkg.manifest.exportedAt,
    expiresAt,
    delivery: 'signed_link',
    packageSha256: pkg.manifest.packageSha256,
    complete: pkg.manifest.complete,
    incomplete,
    tables,
    summary,
  };
}

/** GET /v1/export/downloads/{transferId}?t=: the signed link, opened by the signed-in owner. */
export async function serveExportDownload(env: Env, principal: Principal, via: string, transferId: string, token: string | null): Promise<Response> {
  requireScope(principal, SCOPE_READ);
  await verifyLink(env, principal, 'export', transferId, token);
  const row = await env.DB.prepare("SELECT status, ref, expires_at FROM account_transfers WHERE user_id = ? AND transfer_id = ? AND kind = 'export_download'").bind(principal.userId, transferId).first<{ status: string; ref: string; expires_at: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'No such export');
  if (row.status !== 'ready' || row.expires_at <= now()) throw new HttpError(410, 'link_expired', 'This export link has expired; request a new export');
  const object = await env.MEDIA.get(exportObjectKey(principal.userId, transferId));
  if (!object) throw new HttpError(410, 'link_expired', 'This export is no longer stored; request a new export');
  await audit(env, principal, { action: 'export', surface: via, outcome: 'downloaded', detail: { exportId: row.ref, transferId } });
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="garderobe-export-${row.ref}.json"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

// ------------------------------------------------------------------ import

function isPackage(raw: unknown): raw is ExportPackage {
  return !!raw && typeof raw === 'object' && 'manifest' in raw && 'files' in raw && typeof (raw as ExportPackage).manifest === 'object' && typeof (raw as ExportPackage).files === 'object';
}

function stagedView(row: { transfer_id: string; status: string; expires_at: string; summary_json: string }): StagedImportPackage {
  const s = parseJson<{ exportId?: string; exportedAt?: string; sourceDisplayName?: string | null; tables?: { name: string; rows: number }[] }>(row.summary_json, {});
  return {
    schemaVersion: CONTRACTS_VERSION,
    packageId: row.transfer_id,
    exportId: s.exportId ?? '',
    exportedAt: s.exportedAt ?? '',
    sourceDisplayName: s.sourceDisplayName ?? null,
    tables: s.tables ?? [],
    status: (row.status === 'staged' && row.expires_at <= now() ? 'expired' : row.status) as StagedImportPackage['status'],
    expiresAt: row.expires_at,
  };
}

/**
 * POST /v1/import/packages (app/web only): stage a package for an import the owner confirms later
 * (from the app or an assistant). It is verified now with the unchanged verifyExport, so a tampered or
 * credential-bearing package is refused before it is stored.
 */
export async function stageImportPackage(env: Env, principal: Principal, raw: unknown, via: string): Promise<StagedImportPackage> {
  requireScope(principal, SCOPE_WRITE);
  if (!isPackage(raw)) throw new HttpError(422, 'validation_failed', 'Send a garderobe-export/1 package ({ manifest, files })');
  const v = await verifyExport(raw);
  if (!v.ok) {
    await audit(env, principal, { action: 'import', surface: via, outcome: 'refused_at_staging', detail: { problems: v.problems.slice(0, 20) } });
    throw new HttpError(422, 'validation_failed', `Export failed verification: ${v.problems.join('; ')}`, { problems: v.problems });
  }
  await sweepExpired(env, principal.userId);
  const packageId = newRef('pkg');
  const expiresAt = new Date(Date.parse(now()) + STAGED_IMPORT_TTL_MS).toISOString();
  await env.MEDIA.put(stagedObjectKey(principal.userId, packageId), JSON.stringify(raw), { httpMetadata: { contentType: 'application/json' } });
  const summary = { exportId: raw.manifest.exportId, exportedAt: raw.manifest.exportedAt, sourceDisplayName: raw.manifest.owner?.displayName ?? null, tables: raw.manifest.tables.map((t) => ({ name: t.name, rows: t.rows })) };
  await insertTransfer(env, principal, { transferId: packageId, kind: 'import_package', status: 'staged', ref: raw.manifest.exportId, summary, meta: { surface: via === 'native_token' ? 'app' : 'web', grantRef: null }, idempotencyKey: null, expiresAt });
  await audit(env, principal, { action: 'import', surface: via, outcome: 'staged', detail: { packageId, exportId: raw.manifest.exportId } });
  const row = await env.DB.prepare('SELECT transfer_id, status, expires_at, summary_json FROM account_transfers WHERE user_id = ? AND transfer_id = ?').bind(principal.userId, packageId).first<{ transfer_id: string; status: string; expires_at: string; summary_json: string }>();
  return stagedView(row!);
}

export async function stagedPackage(env: Env, principal: Principal, packageId: string): Promise<StagedImportPackage | null> {
  const row = await env.DB.prepare("SELECT transfer_id, status, expires_at, summary_json FROM account_transfers WHERE user_id = ? AND transfer_id = ? AND kind = 'import_package'").bind(principal.userId, packageId).first<{ transfer_id: string; status: string; expires_at: string; summary_json: string }>();
  return row ? stagedView(row) : null;
}

async function importStaged(env: Env, principal: Principal, packageId: string, meta: AccountMeta, key: string | null): Promise<McpImportResult> {
  requireScope(principal, SCOPE_WRITE);
  const staged = await stagedPackage(env, principal, packageId);
  if (!staged) throw new HttpError(404, 'not_found', `No staged import package ${packageId}; the owner stages one in Garderobe first`);
  if (staged.status !== 'staged') throw new HttpError(409, 'invalid_state', `Package ${packageId} is ${staged.status}`);
  const object = await env.MEDIA.get(stagedObjectKey(principal.userId, packageId));
  if (!object) throw new HttpError(410, 'link_expired', 'The staged package is no longer stored; stage it again');
  const pkg = JSON.parse(await object.text()) as ExportPackage;
  let result;
  try {
    // The unchanged import service: verifyExport, empty owner only, grants revoked, no sessions.
    result = await importData(env, principal, pkg);
  } catch (err) {
    await audit(env, principal, { action: 'import', surface: meta.surface, grantRef: meta.grantRef, idempotencyKey: key, outcome: 'refused', detail: { packageId, reason: err instanceof Error ? err.message.slice(0, 300) : String(err) } });
    throw err;
  }
  await env.DB.prepare("UPDATE account_transfers SET status = 'imported', completed_at = ? WHERE user_id = ? AND transfer_id = ?").bind(now(), principal.userId, packageId).run();
  await env.MEDIA.delete(stagedObjectKey(principal.userId, packageId));
  const grants = pkg.manifest.tables.find((t) => t.name === 'mcp_grants')?.rows ?? 0;
  const garments = result.tables.find((t) => t.name === 'garments')?.rows ?? 0;
  await audit(env, principal, { action: 'import', surface: meta.surface, grantRef: meta.grantRef, idempotencyKey: key, outcome: 'imported', detail: { packageId, exportId: pkg.manifest.exportId, garments, importedAssistantGrants: grants } });
  return {
    schemaVersion: CONTRACTS_VERSION,
    imported: true,
    packageId,
    exportId: pkg.manifest.exportId,
    tables: result.tables,
    importedAssistantGrants: { count: grants, status: 'revoked' },
    sessionsRecreated: 0,
    callingGrant: { grantId: meta.grantRef, status: 'active', note: 'This connection keeps working with the scopes the owner granted it; connections carried in the package arrive revoked and must be reconnected.' },
    summary: `Imported export ${safeExportId(pkg.manifest.exportId) ?? '(unrecognised id)'}: ${garments} garments. Connected assistants from the package arrive disconnected (${grants}); no sign-in sessions were restored.`,
  };
}

// ------------------------------------------------------------------ recovery

async function requestRecoveryLink(env: Env, principal: Principal, meta: AccountMeta, key: string | null): Promise<RecoveryKitLink> {
  requireScope(principal, SCOPE_WRITE);
  // A newer request supersedes an uncollected earlier link.
  await env.DB.prepare("UPDATE account_transfers SET status = 'expired' WHERE user_id = ? AND kind = 'recovery_kit_link' AND status = 'pending'").bind(principal.userId).run();
  const transferId = newRef('rkl');
  const expiresAt = new Date(Date.parse(now()) + RECOVERY_LINK_TTL_MS).toISOString();
  await insertTransfer(env, principal, { transferId, kind: 'recovery_kit_link', status: 'pending', ref: null, summary: {}, meta, idempotencyKey: key, expiresAt });
  await audit(env, principal, { action: 'recovery_kit', surface: meta.surface, grantRef: meta.grantRef, idempotencyKey: key, outcome: 'link_issued', detail: { transferId, expiresAt } });
  return {
    schemaVersion: CONTRACTS_VERSION,
    transferId,
    expiresAt,
    delivery: 'garderobe_link',
    codeIncluded: false,
    summary: `A new recovery code is waiting in Garderobe. Open the one-time link signed in to Garderobe before ${expiresAt}; the code is shown there only, never in this conversation. Collecting it replaces the current code.`,
  };
}

export function sameOrigin(env: Env, request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const expected = (env.APP_ORIGIN ?? new URL(request.url).origin).replace(/\/+$/, '');
  return origin.replace(/\/+$/, '') === expected;
}

export async function recoveryLinkState(env: Env, principal: Principal, transferId: string, token: string | null): Promise<{ expiresAt: string }> {
  await verifyLink(env, principal, 'recovery', transferId, token);
  const row = await env.DB.prepare("SELECT status, expires_at FROM account_transfers WHERE user_id = ? AND transfer_id = ? AND kind = 'recovery_kit_link'").bind(principal.userId, transferId).first<{ status: string; expires_at: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'No such recovery link');
  if (row.status === 'collected') throw new HttpError(410, 'already_collected', 'This recovery code was already collected; the link works once');
  if (row.status !== 'pending' || row.expires_at <= now()) throw new HttpError(410, 'link_expired', 'This recovery link has expired or was replaced by a newer one');
  return { expiresAt: row.expires_at };
}

/**
 * POST /v1/auth/recovery-kit/collect/{transferId}?t=: the signed-in owner collects the code in
 * Garderobe. The link works once; the code is issued (replacing the previous one) at this moment and
 * appears only in this response.
 */
export async function collectRecoveryKit(env: Env, principal: Principal, via: string, transferId: string, token: string | null, request: Request) {
  requireScope(principal, SCOPE_WRITE);
  if (!sameOrigin(env, request)) throw new HttpError(403, 'forbidden_origin', 'Collect the recovery code from Garderobe itself');
  await recoveryLinkState(env, principal, transferId, token);
  const at = now();
  const claim = await env.DB.prepare("UPDATE account_transfers SET status = 'collected', completed_at = ? WHERE user_id = ? AND transfer_id = ? AND kind = 'recovery_kit_link' AND status = 'pending' AND expires_at > ?").bind(at, principal.userId, transferId, at).run();
  if (!claim.meta.changes) throw new HttpError(410, 'already_collected', 'This recovery code was already collected; the link works once');
  const kit = await issueRecoveryCredential(env.DB, principal.userId, at);
  await audit(env, principal, { action: 'recovery_kit', surface: via, outcome: 'collected', detail: { transferId, issuedAt: kit.issuedAt } });
  return { schemaVersion: CONTRACTS_VERSION, ...kit };
}

export async function recoveryStatus(env: Env, principal: Principal): Promise<RecoveryStatus> {
  requireScope(principal, SCOPE_READ);
  const at = now();
  const active = await env.DB.prepare('SELECT MAX(created_at) AS t FROM recovery_credentials WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').bind(principal.userId).first<{ t: string | null }>();
  const recovered = await env.DB.prepare("SELECT MAX(created_at) AS t FROM recovery_attempts WHERE user_id = ? AND outcome = 'recovered'").bind(principal.userId).first<{ t: string | null }>();
  const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_attempts WHERE user_id = ? AND outcome <> 'recovered' AND created_at >= ?").bind(principal.userId, new Date(Date.parse(at) - 24 * 3600_000).toISOString()).first<{ n: number }>();
  const pending = await env.DB.prepare("SELECT transfer_id, expires_at FROM account_transfers WHERE user_id = ? AND kind = 'recovery_kit_link' AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(principal.userId, at).first<{ transfer_id: string; expires_at: string }>();
  return {
    schemaVersion: CONTRACTS_VERSION,
    hasActiveKit: Boolean(active?.t),
    activeKitIssuedAt: active?.t ?? null,
    lastRecoveredAt: recovered?.t ?? null,
    failedAttemptsLast24h: failed?.n ?? 0,
    pendingCollection: pending ? { transferId: pending.transfer_id, expiresAt: pending.expires_at } : null,
  };
}

export async function accountTransfers(env: Env, principal: Principal): Promise<AccountTransfers> {
  requireScope(principal, SCOPE_READ);
  const at = now();
  const t = await env.DB.prepare('SELECT * FROM account_transfers WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(principal.userId).all<Record<string, string | null>>();
  const a = await env.DB.prepare('SELECT * FROM account_audit WHERE user_id = ? ORDER BY created_at DESC, audit_id LIMIT 200').bind(principal.userId).all<Record<string, string | null>>();
  return {
    schemaVersion: CONTRACTS_VERSION,
    transfers: t.results.map((r) => ({
      transferId: r.transfer_id!,
      kind: r.kind as AccountTransfers['transfers'][number]['kind'],
      status: (r.status === 'ready' || r.status === 'staged' || r.status === 'pending') && r.expires_at! <= at ? 'expired' : r.status!,
      surface: r.surface!,
      createdAt: r.created_at!,
      expiresAt: r.expires_at!,
      completedAt: r.completed_at ?? null,
      summary: parseJson(r.summary_json, {}),
    })),
    audit: a.results.map((r) => ({ auditId: r.audit_id!, action: r.action!, surface: r.surface!, grantRef: r.grant_ref ?? null, idempotencyKey: r.idempotency_key ?? null, outcome: r.outcome!, detail: parseJson(r.detail_json, {}), createdAt: r.created_at! })),
  };
}

// ------------------------------------------------------------------ the operation entry point

/**
 * Runs an account operation once per idempotency key (the operation record in `runs`). Callers have
 * already obtained the owner's confirmation. The stored result never carries a link token; use
 * `withDeliveryLinks` to attach the owner-bound links when returning it.
 */
export async function runAccountOperation(env: Env, principal: Principal, op: AccountOperation, key: string, meta: AccountMeta): Promise<OperationReceipt> {
  noOwnerFields(op);
  requireScope(principal, SCOPE_WRITE);
  return idempotentOperation(env, principal, key, op.type, op, async () => {
    switch (op.type) {
      case 'export_data':
        return (await createExportDownload(env, principal, meta, key)) as never;
      case 'import_data':
        return (await importStaged(env, principal, op.packageId, meta, key)) as never;
      case 'issue_recovery_kit':
        return (await requestRecoveryLink(env, principal, meta, key)) as never;
    }
  });
}

/** Adds the owner-bound signed link to a stored export or recovery result (the same link on replay). */
export async function withDeliveryLinks(env: Env, principal: Principal, receipt: OperationReceipt, origin: string): Promise<OperationReceipt> {
  const r = receipt.result as Record<string, unknown>;
  const base = origin.replace(/\/+$/, '');
  if (receipt.operation === 'export_data' && typeof r.transferId === 'string' && typeof r.expiresAt === 'string') {
    const t = await linkToken(env, { k: 'export', u: principal.userId, x: r.transferId, exp: Date.parse(r.expiresAt) });
    return { ...receipt, result: { ...r, downloadUrl: `${base}/v1/export/downloads/${r.transferId}?t=${encodeURIComponent(t)}` } };
  }
  if (receipt.operation === 'issue_recovery_kit' && typeof r.transferId === 'string' && typeof r.expiresAt === 'string') {
    const t = await linkToken(env, { k: 'recovery', u: principal.userId, x: r.transferId, exp: Date.parse(r.expiresAt) });
    return { ...receipt, result: { ...r, collectUrl: `${base}/v1/auth/recovery-kit/collect/${r.transferId}?t=${encodeURIComponent(t)}` } };
  }
  return receipt;
}

/** The confirmation question for each account operation (asked through the pending-action flow). */
export async function accountQuestion(env: Env, principal: Principal, op: AccountOperation): Promise<{ kind: 'confirm'; prompt: string; choices: { id: string; label: string }[] }> {
  const choices = [
    { id: 'confirm', label: 'Yes, do it' },
    { id: 'decline', label: 'No' },
  ];
  if (op.type === 'export_data') {
    return { kind: 'confirm', prompt: 'Export your complete Garderobe record? It is stored privately and you get a download link that works for 15 minutes, only while signed in to Garderobe. The record itself is not sent to this assistant.', choices };
  }
  if (op.type === 'import_data') {
    const staged = await stagedPackage(env, principal, op.packageId);
    // ADV-18: everything below came from the file. Only a validated export id, a validated date and a
    // short, plain, clearly attributed name reach the question the owner answers; anything else is dropped.
    const exportId = staged ? safeExportId(staged.exportId) : null;
    const date = staged ? safeExportDate(staged.exportedAt) : null;
    const name = staged ? safeFileName(staged.sourceDisplayName) : null;
    const what = staged
      ? `the staged export${exportId ? ` ${exportId}` : ''}${date ? ` from ${date}` : ''}${name ? ` (the file names its owner “${name}”)` : ''}`
      : `package ${op.packageId}`;
    return { kind: 'confirm', prompt: `Import ${what} into this Garderobe? Imports go only into an empty Garderobe. Assistants in the package arrive disconnected and no sign-in sessions are restored; this connection keeps working.`, choices };
  }
  return { kind: 'confirm', prompt: 'Create a new recovery code? It is shown only in Garderobe, through a one-time link that needs your Garderobe sign-in, never in this conversation. Collecting it replaces your current code.', choices };
}
