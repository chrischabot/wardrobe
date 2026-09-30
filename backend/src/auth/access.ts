import type { Env } from '../env.js';
import { JwtError, verifyRs256Jwt, type Jwk, type JwtClaims } from './jose.js';

/**
 * Cloudflare Access assertion verification (spec section 15).
 *
 * Access puts a signed JWT in `Cf-Access-Jwt-Assertion` (and the `CF_Authorization` cookie) on every
 * request it lets through. The Worker verifies it itself: RS256 signature against the team's JWKS,
 * issuer (the team domain), audience (the Access application AUD tag), expiry. An unsigned, forged or
 * stale header is rejected, never trusted because it is present. Requests on a hostname that is not
 * an Access-protected application hostname are refused (a `workers.dev` or other alternate route
 * cannot bypass Access by sending its own header).
 *
 * Configuration (wrangler vars / secrets):
 * - ACCESS_TEAM_DOMAIN: `https://<team>.cloudflareaccess.com` (the issuer)
 * - ACCESS_AUD: comma-separated AUD tags of the app/API and web board applications
 * - APP_HOSTNAMES: comma-separated hostnames the Access applications protect
 * - ACCESS_JWKS_JSON (optional): a static JWKS instead of fetching `<team>/cdn-cgi/access/certs`. Used
 *   by local development and tests with a locally generated key; the verification path is identical.
 */

export interface AccessIdentity {
  issuer: string;
  /**
   * The Access user id (`sub`), or `service-token:<Client ID>` for a service-token assertion (which has
   * an empty `sub`). Either must be explicitly linked in auth_identities before it maps to an owner.
   */
  subject: string;
  email: string | null;
  expiresAt: number;
}

/** Prefix of the subject derived for Cloudflare Access service tokens; never produced by a user sign-in. */
export const SERVICE_TOKEN_SUBJECT_PREFIX = 'service-token:';

export class AccessError extends Error {
  constructor(
    readonly code: 'access_required' | 'access_invalid' | 'host_not_protected' | 'access_not_configured',
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

type AccessEnv = Pick<Env, 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD' | 'ACCESS_JWKS_JSON' | 'APP_HOSTNAMES'>;

const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 10 * 60_000;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function accessConfigured(env: AccessEnv): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && list(env.ACCESS_AUD).length);
}

/** True when the request arrived on a hostname an Access application protects. */
export function isProtectedHost(env: AccessEnv, request: Request, extraHosts: string[] = []): boolean {
  const host = new URL(request.url).hostname.toLowerCase();
  return [...list(env.APP_HOSTNAMES), ...extraHosts].map((h) => h.toLowerCase()).includes(host);
}

async function signingKeys(env: AccessEnv, forceRefresh = false): Promise<Jwk[]> {
  if (env.ACCESS_JWKS_JSON) {
    const parsed = JSON.parse(env.ACCESS_JWKS_JSON) as { keys?: Jwk[] };
    return parsed.keys ?? [];
  }
  const issuer = env.ACCESS_TEAM_DOMAIN!.replace(/\/+$/, '');
  const cached = jwksCache.get(issuer);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const res = await fetch(`${issuer}/cdn-cgi/access/certs`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new AccessError('access_invalid', 'Access signing keys are unavailable', 'jwks_fetch_failed');
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(issuer, { keys, fetchedAt: Date.now() });
  return keys;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** The raw assertion from the Access header or cookie (not yet verified). */
export function accessAssertion(request: Request): string | null {
  return request.headers.get('cf-access-jwt-assertion') ?? cookieValue(request, 'CF_Authorization');
}

/**
 * Verifies the Access assertion of a request on a protected hostname. Throws AccessError when the
 * hostname is not protected, the assertion is missing, or any check fails.
 */
export async function verifyAccess(env: AccessEnv, request: Request, nowSeconds?: number, extraHosts: string[] = []): Promise<AccessIdentity> {
  if (!accessConfigured(env)) throw new AccessError('access_not_configured', 'Cloudflare Access is not configured for this deployment');
  if (!isProtectedHost(env, request, extraHosts)) throw new AccessError('host_not_protected', 'This hostname is not protected by Access; use the Garderobe app hostname');
  const token = accessAssertion(request);
  if (!token) throw new AccessError('access_required', 'Sign in through Cloudflare Access');
  const issuer = env.ACCESS_TEAM_DOMAIN!.replace(/\/+$/, '');
  const audiences = list(env.ACCESS_AUD);
  const verifyOpts = { issuer, audiences, nowSeconds, maxLifetimeSeconds: 31 * 86_400, allowServiceToken: true };
  let claims: JwtClaims;
  try {
    claims = await verifyRs256Jwt(token, { keys: await signingKeys(env), ...verifyOpts });
  } catch (err) {
    if (err instanceof JwtError && err.reason === 'no_matching_key' && !env.ACCESS_JWKS_JSON) {
      // Access rotates keys: refresh once.
      try {
        claims = await verifyRs256Jwt(token, { keys: await signingKeys(env, true), ...verifyOpts });
      } catch (err2) {
        throw new AccessError('access_invalid', 'The Access assertion could not be verified', err2 instanceof JwtError ? err2.reason : 'error');
      }
    } else if (err instanceof AccessError) {
      throw err;
    } else {
      throw new AccessError('access_invalid', 'The Access assertion could not be verified', err instanceof JwtError ? err.reason : 'error');
    }
  }
  if (!claims.sub) return { issuer, subject: `${SERVICE_TOKEN_SUBJECT_PREFIX}${String(claims.common_name)}`, email: null, expiresAt: claims.exp };
  return { issuer, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : null, expiresAt: claims.exp };
}
