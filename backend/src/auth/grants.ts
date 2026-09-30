import type { AssistantGrant } from '@garderobe/contracts';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { SCOPE_WRITE } from '../domain/principal.js';
import { isGrantValid } from '../lifecycle/recovery.js';
import { parseJson } from '../domain/db.js';

/**
 * The application's authoritative record of consumer MCP grants (spec section 13, "Authorization for
 * Claude and ChatGPT"). The Workers OAuth provider stores tokens in OAUTH_KV; this D1 row is checked
 * on every protected MCP operation, so revocation here takes effect on the next call even if a KV
 * record lingers. Grants carry a version; token props name the version they were issued for.
 */

export interface GrantRow {
  user_id: string;
  grant_id: string;
  provider_grant_id: string | null;
  client_id: string;
  client_kind: 'claude' | 'chatgpt' | 'other';
  client_name: string;
  redirect_host: string;
  scopes_json: string;
  status: 'active' | 'revoked';
  version: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  last_operation: string | null;
}

/** Props sealed into every token issued for a grant (never model-visible). */
export interface GrantProps {
  userId: string;
  grantRef: string;
  grantVersion: number;
}

const CLAUDE_HOSTS = [/(^|\.)claude\.ai$/, /(^|\.)claude\.com$/, /(^|\.)anthropic\.com$/];
const CHATGPT_HOSTS = [/(^|\.)chatgpt\.com$/, /(^|\.)openai\.com$/];

/**
 * Which consumer assistant a grant belongs to, from where its tokens are delivered (the redirect
 * host) or a Client ID Metadata Document domain. A self-asserted client name alone never decides it.
 */
export function classifyClient(redirectUri: string, clientId: string): 'claude' | 'chatgpt' | 'other' {
  const hosts: string[] = [];
  for (const u of [redirectUri, clientId]) {
    try {
      const url = new URL(u);
      if (url.protocol === 'https:') hosts.push(url.hostname.toLowerCase());
    } catch {
      /* not a URL */
    }
  }
  if (hosts.some((h) => CLAUDE_HOSTS.some((re) => re.test(h)))) return 'claude';
  if (hosts.some((h) => CHATGPT_HOSTS.some((re) => re.test(h)))) return 'chatgpt';
  return 'other';
}

export function redirectHostOf(redirectUri: string): string {
  try {
    const u = new URL(redirectUri);
    return u.host || redirectUri;
  } catch {
    return redirectUri;
  }
}

export async function createGrantRecord(
  db: D1Database,
  input: { userId: string; clientId: string; clientName: string; redirectUri: string; scopes: string[]; now: string },
): Promise<GrantRow> {
  const grantId = `mgr_${crypto.randomUUID().replace(/-/g, '')}`;
  await db
    .prepare(
      `INSERT INTO mcp_grants (user_id, grant_id, client_id, client_kind, client_name, redirect_host, scopes_json, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
    )
    .bind(input.userId, grantId, input.clientId, classifyClient(input.redirectUri, input.clientId), input.clientName.slice(0, 120), redirectHostOf(input.redirectUri), JSON.stringify(input.scopes), input.now, input.now)
    .run();
  return (await getGrant(db, input.userId, grantId))!;
}

export function getGrant(db: D1Database, userId: string, grantId: string): Promise<GrantRow | null> {
  return db.prepare('SELECT * FROM mcp_grants WHERE user_id = ? AND grant_id = ?').bind(userId, grantId).first<GrantRow>();
}

export async function attachProviderGrant(db: D1Database, userId: string, grantId: string, providerGrantId: string): Promise<void> {
  await db.prepare('UPDATE mcp_grants SET provider_grant_id = ? WHERE user_id = ? AND grant_id = ? AND provider_grant_id IS NULL').bind(providerGrantId, userId, grantId).run();
}

/**
 * The per-call grant decision: the D1 grant must exist, be active, match the version sealed into the
 * token, and postdate any recovery that revoked all grants. Returns the grant's scopes.
 */
export async function checkGrant(db: D1Database, props: GrantProps | null | undefined): Promise<{ ok: true; grant: GrantRow; scopes: string[] } | { ok: false; reason: string }> {
  if (!props || typeof props.userId !== 'string' || typeof props.grantRef !== 'string') return { ok: false, reason: 'token carries no Garderobe grant' };
  const grant = await getGrant(db, props.userId, props.grantRef);
  if (!grant) return { ok: false, reason: 'grant not found' };
  if (grant.status !== 'active') return { ok: false, reason: 'grant revoked' };
  if (grant.version !== props.grantVersion) return { ok: false, reason: 'grant version changed' };
  if (!(await isGrantValid(db, grant.user_id, grant.created_at))) return { ok: false, reason: 'grants revoked by account recovery' };
  const user = await db.prepare('SELECT status FROM users WHERE user_id = ?').bind(grant.user_id).first<{ status: string }>();
  if (user?.status !== 'active') return { ok: false, reason: 'account disabled' };
  return { ok: true, grant, scopes: parseJson<string[]>(grant.scopes_json, []) };
}

export async function touchGrant(db: D1Database, userId: string, grantId: string, operation: string, now: string, protocol?: string): Promise<void> {
  await db
    .prepare('UPDATE mcp_grants SET last_used_at = ?, last_operation = ?, last_protocol = COALESCE(?, last_protocol) WHERE user_id = ? AND grant_id = ?')
    .bind(now, operation.slice(0, 80), protocol ?? null, userId, grantId)
    .run();
}

/** Immediate revocation: D1 first (authoritative), then the provider's KV grant and tokens. */
export async function revokeGrant(
  db: D1Database,
  helpers: OAuthHelpers | undefined,
  userId: string,
  grantId: string,
  reason: string,
  now: string,
): Promise<{ revoked: boolean; remoteRevocation: 'revoked' | 'failed' | 'not_applicable' }> {
  const grant = await getGrant(db, userId, grantId);
  if (!grant) return { revoked: false, remoteRevocation: 'not_applicable' };
  await db
    .prepare("UPDATE mcp_grants SET status = 'revoked', version = version + 1, revoked_at = COALESCE(revoked_at, ?), revoked_reason = COALESCE(revoked_reason, ?), updated_at = ? WHERE user_id = ? AND grant_id = ?")
    .bind(now, reason, now, userId, grantId)
    .run();
  if (!grant.provider_grant_id || !helpers) return { revoked: true, remoteRevocation: grant.provider_grant_id ? 'failed' : 'not_applicable' };
  try {
    await helpers.revokeGrant(grant.provider_grant_id, userId);
    return { revoked: true, remoteRevocation: 'revoked' };
  } catch (err) {
    console.warn('provider grant revocation failed; D1 revocation still blocks every call', err instanceof Error ? err.message : String(err));
    return { revoked: true, remoteRevocation: 'failed' };
  }
}

export async function listGrants(db: D1Database, userId: string): Promise<AssistantGrant[]> {
  const { results } = await db.prepare('SELECT * FROM mcp_grants WHERE user_id = ? ORDER BY client_kind, created_at DESC').bind(userId).all<GrantRow>();
  return results.map((g) => {
    const scopes = parseJson<string[]>(g.scopes_json, []);
    return {
      grantId: g.grant_id,
      client: g.client_kind,
      clientId: g.client_id,
      clientName: g.client_name,
      redirectHost: g.redirect_host,
      scopes,
      canWrite: scopes.includes(SCOPE_WRITE),
      status: g.status,
      createdAt: g.created_at,
      lastUsedAt: g.last_used_at,
      lastOperation: g.last_operation,
      revokedAt: g.revoked_at,
    };
  });
}
