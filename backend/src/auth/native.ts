import type { Env } from '../env.js';
import { SCOPE_READ, SCOPE_WRITE } from '../domain/principal.js';
import { HttpError, json, readForm } from '../api/http.js';
import { randomToken, sha256B64url, timingSafeEqual } from './jose.js';
import { isSessionValid } from '../lifecycle/recovery.js';
import type { AppAuth } from './app.js';

/**
 * Native app sign-in: a secretless public OAuth client with PKCE S256 and a resource indicator
 * (spec section 15). In production Cloudflare Access Managed OAuth plays this role in front of the
 * Worker; this module is the Worker-side implementation used locally and in tests, with the same
 * contract the iOS app follows through ASWebAuthenticationSession:
 *
 *   GET  /v1/auth/native/authorize  (Access-protected: the owner signs in with Google through Access)
 *        ?response_type=code&client_id=garderobe-ios&redirect_uri=...&code_challenge=...
 *        &code_challenge_method=S256&state=...&resource=<APP_ORIGIN>/v1
 *        -> 302 redirect_uri?code=...&state=...&iss=<APP_ORIGIN>
 *   POST /v1/auth/native/token      grant_type=authorization_code | refresh_token (no client secret)
 *   POST /v1/auth/native/revoke     token=<access or refresh token>
 *
 * Codes live 60 seconds and work once. Access tokens are opaque and live 15 minutes; refresh tokens
 * rotate on every use, and presenting an already-rotated refresh token revokes the session.
 */

export const NATIVE_CLIENT_ID = 'garderobe-ios';
export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 86_400;
const CODE_TTL_S = 60;
const NATIVE_SCOPES = [SCOPE_READ, SCOPE_WRITE];

function appOrigin(env: Env, request: Request): string {
  return (env.APP_ORIGIN ?? new URL(request.url).origin).replace(/\/+$/, '');
}

export function nativeResource(env: Env, request: Request): string {
  return `${appOrigin(env, request)}/v1`;
}

function redirectUris(env: Env): string[] {
  return (env.NATIVE_REDIRECT_URIS ?? 'garderobe://auth/callback')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function oauthError(status: number, error: string, description: string): Response {
  return json({ error, error_description: description }, status);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** GET /v1/auth/native/authorize: the owner is already verified by Access (auth). */
export async function nativeAuthorize(env: Env, request: Request, auth: AppAuth): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const clientId = p.get('client_id');
  const redirectUri = p.get('redirect_uri');
  // Never redirect to an unregistered URI: errors about the client or redirect are shown, not redirected.
  if (clientId !== NATIVE_CLIENT_ID) throw new HttpError(400, 'invalid_client', 'Unknown native client');
  if (!redirectUri || !redirectUris(env).includes(redirectUri)) throw new HttpError(400, 'invalid_redirect_uri', 'The redirect URI is not registered for this client');
  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('iss', appOrigin(env, request));
    return new Response(null, { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } });
  };
  const state = p.get('state') ?? '';
  if (p.get('response_type') !== 'code') return back({ error: 'unsupported_response_type', state });
  if (p.get('code_challenge_method') !== 'S256') return back({ error: 'invalid_request', error_description: 'PKCE S256 is required', state });
  const challenge = p.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back({ error: 'invalid_request', error_description: 'Invalid code_challenge', state });
  if (p.get('resource') !== nativeResource(env, request)) return back({ error: 'invalid_target', error_description: 'resource must name the Garderobe API', state });
  const requested = (p.get('scope') ?? NATIVE_SCOPES.join(' ')).split(/\s+/).filter(Boolean);
  if (requested.some((s) => !NATIVE_SCOPES.includes(s))) return back({ error: 'invalid_scope', state });
  const code = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO native_auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, resource, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(await sha256B64url(code), auth.principal.userId, clientId, redirectUri, challenge, nativeResource(env, request), requested.join(' '), iso(now + CODE_TTL_S * 1000), iso(now))
    .run();
  return back({ code, state });
}

async function issueSession(env: Env, userId: string, clientId: string, scope: string, sessionId?: string): Promise<{ access: string; refresh: string; sessionId: string }> {
  const access = randomToken();
  const refresh = randomToken();
  const now = Date.now();
  const id = sessionId ?? `ses_${crypto.randomUUID().replace(/-/g, '')}`;
  await env.DB.prepare(
    `INSERT INTO app_sessions (user_id, session_id, client_id, scope, access_hash, access_expires_at, refresh_hash, refresh_expires_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(userId, id, clientId, scope, await sha256B64url(access), iso(now + ACCESS_TOKEN_TTL_S * 1000), await sha256B64url(refresh), iso(now + REFRESH_TOKEN_TTL_S * 1000), iso(now), iso(now))
    .run();
  return { access, refresh, sessionId: id };
}

function tokenResponse(access: string, refresh: string, scope: string): Response {
  return json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope }, 200, { pragma: 'no-cache' });
}

/** POST /v1/auth/native/token */
export async function nativeToken(env: Env, request: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = await readForm(request);
  } catch {
    return oauthError(400, 'invalid_request', 'Send application/x-www-form-urlencoded');
  }
  if (form.has('client_secret') || request.headers.get('authorization')) return oauthError(401, 'invalid_client', 'This is a public client: no client secret is accepted');
  if (form.get('client_id') !== NATIVE_CLIENT_ID) return oauthError(401, 'invalid_client', 'Unknown client');
  const grant = form.get('grant_type');
  const nowIso = iso(Date.now());
  if (grant === 'authorization_code') {
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError(400, 'invalid_grant', 'Invalid code_verifier');
    const hash = await sha256B64url(code);
    // Consume the code atomically: only the first exchange succeeds.
    const used = await env.DB.prepare('UPDATE native_auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').bind(nowIso, hash, nowIso).run();
    const row = await env.DB.prepare('SELECT * FROM native_auth_codes WHERE code_hash = ?').bind(hash).first<{ user_id: string; client_id: string; redirect_uri: string; code_challenge: string; resource: string; scope: string }>();
    if (!used.meta.changes || !row) return oauthError(400, 'invalid_grant', 'The authorization code is invalid, expired or already used');
    if (row.client_id !== NATIVE_CLIENT_ID || row.redirect_uri !== form.get('redirect_uri')) return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    if (form.has('resource') && form.get('resource') !== row.resource) return oauthError(400, 'invalid_target', 'resource does not match the authorization request');
    if (!timingSafeEqual(await sha256B64url(verifier), row.code_challenge)) return oauthError(400, 'invalid_grant', 'PKCE verification failed');
    const s = await issueSession(env, row.user_id, row.client_id, row.scope);
    return tokenResponse(s.access, s.refresh, row.scope);
  }
  if (grant === 'refresh_token') {
    const refresh = form.get('refresh_token') ?? '';
    const hash = await sha256B64url(refresh);
    const reused = await env.DB.prepare("SELECT user_id, session_id FROM app_sessions WHERE previous_refresh_hash = ? AND status = 'active'").bind(hash).first<{ user_id: string; session_id: string }>();
    if (reused) {
      // A rotated refresh token came back: treat the session as compromised.
      await env.DB.prepare("UPDATE app_sessions SET status = 'revoked', revoked_reason = 'refresh_token_reuse', updated_at = ? WHERE user_id = ? AND session_id = ?").bind(nowIso, reused.user_id, reused.session_id).run();
      return oauthError(400, 'invalid_grant', 'Refresh token was already used; the session has been revoked');
    }
    const row = await env.DB.prepare("SELECT * FROM app_sessions WHERE refresh_hash = ? AND status = 'active' AND refresh_expires_at > ?").bind(hash, nowIso).first<{ user_id: string; session_id: string; client_id: string; scope: string; created_at: string }>();
    if (!row) return oauthError(400, 'invalid_grant', 'The refresh token is invalid, expired or revoked');
    // Account recovery (sessions_valid_after) and a disabled account end the session at refresh, not only on use.
    const user = await env.DB.prepare('SELECT status FROM users WHERE user_id = ?').bind(row.user_id).first<{ status: string }>();
    if (user?.status !== 'active' || !(await isSessionValid(env.DB, row.user_id, row.created_at))) {
      await env.DB.prepare("UPDATE app_sessions SET status = 'revoked', revoked_reason = 'sessions_revoked', updated_at = ? WHERE user_id = ? AND session_id = ?").bind(nowIso, row.user_id, row.session_id).run();
      return oauthError(400, 'invalid_grant', 'This session was revoked; sign in again');
    }
    const access = randomToken();
    const next = randomToken();
    const now = Date.now();
    const res = await env.DB.prepare(
      `UPDATE app_sessions SET access_hash = ?, access_expires_at = ?, previous_refresh_hash = refresh_hash, refresh_hash = ?, refresh_expires_at = ?, updated_at = ?
       WHERE user_id = ? AND session_id = ? AND refresh_hash = ? AND status = 'active'`,
    )
      .bind(await sha256B64url(access), iso(now + ACCESS_TOKEN_TTL_S * 1000), await sha256B64url(next), iso(now + REFRESH_TOKEN_TTL_S * 1000), nowIso, row.user_id, row.session_id, hash)
      .run();
    if (!res.meta.changes) return oauthError(400, 'invalid_grant', 'The refresh token was used concurrently');
    return tokenResponse(access, next, row.scope);
  }
  return oauthError(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
}

/** POST /v1/auth/native/revoke (RFC 7009: always 200). */
export async function nativeRevoke(env: Env, request: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = await readForm(request);
  } catch {
    return oauthError(400, 'invalid_request', 'Send application/x-www-form-urlencoded');
  }
  const token = form.get('token') ?? '';
  if (token) {
    const hash = await sha256B64url(token);
    await env.DB.prepare("UPDATE app_sessions SET status = 'revoked', revoked_reason = 'owner_sign_out', updated_at = ? WHERE (access_hash = ? OR refresh_hash = ?) AND status = 'active'")
      .bind(iso(Date.now()), hash, hash)
      .run();
  }
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}

export interface NativeSession {
  userId: string;
  sessionId: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
}

/** Resolves an opaque native access token to its active session (null when invalid or expired). */
export async function resolveNativeAccessToken(env: Pick<Env, 'DB'>, token: string): Promise<NativeSession | null> {
  const nowIso = iso(Date.now());
  const row = await env.DB.prepare("SELECT user_id, session_id, scope, access_expires_at, created_at FROM app_sessions WHERE access_hash = ? AND status = 'active' AND access_expires_at > ?")
    .bind(await sha256B64url(token), nowIso)
    .first<{ user_id: string; session_id: string; scope: string; access_expires_at: string; created_at: string }>();
  if (!row) return null;
  await env.DB.prepare('UPDATE app_sessions SET last_used_at = ? WHERE user_id = ? AND session_id = ?').bind(nowIso, row.user_id, row.session_id).run();
  return { userId: row.user_id, sessionId: row.session_id, scopes: row.scope.split(' ').filter(Boolean), expiresAt: row.access_expires_at, createdAt: row.created_at };
}
