import { ownerPrincipal, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { resolveIdentity } from '../domain/identity.js';
import { isSessionValid } from '../lifecycle/recovery.js';
import type { Env } from '../env.js';
import { HttpError } from '../api/http.js';
import { AccessError, isProtectedHost, verifyAccess, type AccessIdentity } from './access.js';
import { resolveNativeAccessToken } from './native.js';

/**
 * Authentication for the native app and the private web board (spec section 15).
 *
 * Two accepted credentials, both on an Access-protected hostname only:
 * - `Authorization: Bearer <token>` from the native public-client flow (opaque, 15 minutes);
 * - a verified Cloudflare Access assertion (header or cookie) for the web board and the consent page.
 * The internal user id is mapped from the verified (issuer, subject); an unknown subject is refused,
 * and email is never used to find or link a user.
 */

export interface AppAuth {
  principal: Principal;
  via: 'access' | 'native_token';
  displayName: string;
  expiresAt: string | null;
  identity: AccessIdentity | null;
}

const ACCESS_STATUS: Record<AccessError['code'], number> = {
  access_required: 401,
  access_invalid: 401,
  host_not_protected: 403,
  access_not_configured: 503,
};

export function accessHttpError(err: AccessError): HttpError {
  return new HttpError(ACCESS_STATUS[err.code], err.code, err.message, err.reason ? { reason: err.reason } : undefined, err.code === 'access_required' || err.code === 'access_invalid' ? { 'www-authenticate': 'Bearer realm="garderobe"' } : undefined);
}

async function activeUser(env: Pick<Env, 'DB'>, userId: string): Promise<{ displayName: string }> {
  const u = await env.DB.prepare('SELECT display_name, status FROM users WHERE user_id = ?').bind(userId).first<{ display_name: string; status: string }>();
  if (!u) throw new HttpError(403, 'unknown_identity', 'This sign-in is not linked to a Garderobe owner');
  if (u.status !== 'active') throw new HttpError(403, 'user_disabled', 'This account is disabled');
  return { displayName: u.display_name };
}

/** Maps a verified Access identity to its internal user (unknown subjects are refused). */
export async function userForAccessIdentity(env: Pick<Env, 'DB'>, identity: AccessIdentity): Promise<{ userId: string; displayName: string }> {
  const userId = await resolveIdentity(env.DB, identity.issuer, identity.subject);
  if (!userId) throw new HttpError(403, 'unknown_identity', 'This sign-in is not linked to a Garderobe owner');
  const u = await activeUser(env, userId);
  return { userId, displayName: u.displayName };
}

/** Access-only authentication (web board, consent page, native authorize). */
export async function authenticateAccess(env: Env, request: Request, opts: { extraHosts?: string[] } = {}): Promise<AppAuth> {
  let identity: AccessIdentity;
  try {
    identity = await verifyAccess(env, request, undefined, opts.extraHosts);
  } catch (err) {
    if (err instanceof AccessError) throw accessHttpError(err);
    throw err;
  }
  const { userId, displayName } = await userForAccessIdentity(env, identity);
  return { principal: ownerPrincipal(userId, 'access', [SCOPE_READ, SCOPE_WRITE]), via: 'access', displayName, expiresAt: new Date(identity.expiresAt * 1000).toISOString(), identity };
}

/** API authentication: native bearer token or Access assertion, on a protected hostname. */
export async function authenticateApp(env: Env, request: Request): Promise<AppAuth> {
  if (!isProtectedHost(env, request)) throw new HttpError(403, 'host_not_protected', 'This hostname is not protected by Access; use the Garderobe app hostname');
  const authz = request.headers.get('authorization');
  if (authz) {
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,512})$/.exec(authz.trim());
    if (!m) throw new HttpError(401, 'invalid_token', 'Malformed Authorization header', undefined, { 'www-authenticate': 'Bearer realm="garderobe", error="invalid_token"' });
    const session = await resolveNativeAccessToken(env, m[1]!);
    if (!session) throw new HttpError(401, 'invalid_token', 'The access token is invalid, expired or revoked', undefined, { 'www-authenticate': 'Bearer realm="garderobe", error="invalid_token"' });
    if (!(await isSessionValid(env.DB, session.userId, session.createdAt))) throw new HttpError(401, 'invalid_token', 'This session was revoked', undefined, { 'www-authenticate': 'Bearer realm="garderobe", error="invalid_token"' });
    const u = await activeUser(env, session.userId);
    return { principal: ownerPrincipal(session.userId, 'native_token', session.scopes), via: 'native_token', displayName: u.displayName, expiresAt: session.expiresAt, identity: null };
  }
  return authenticateAccess(env, request);
}
