import { OAuthError, OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from '../env.js';
import { SCOPE_READ, SCOPE_WRITE } from '../domain/principal.js';
import { HttpError, html, readForm } from '../api/http.js';
import { consentPage, messagePage } from '../web/consent.js';
import { authenticateAccess } from './app.js';
import { attachProviderGrant, checkGrant, createGrantRecord, type GrantProps } from './grants.js';
import { signState, verifyState } from './jose.js';

/**
 * Inbound OAuth for Claude and ChatGPT on @cloudflare/workers-oauth-provider (spec section 13).
 *
 * - The provider serves RFC 8414 / RFC 9728 discovery, the token endpoint (code exchange, rotating
 *   refresh, revocation) and dynamic registration (kept for consumer compatibility), and validates
 *   bearer tokens for the MCP resource `${MCP_ORIGIN}/mcp`. CIMD client ids are enabled.
 * - `/authorize` is Garderobe's Access-protected consent page: it shows the client, where tokens go
 *   and the read/write capabilities, then records an explicit grant in D1 before completing.
 * - Access tokens live 15 minutes; refresh tokens rotate and expire after 90 days without use.
 * - Every protected call re-checks the D1 grant (status + version), so revocation is immediate.
 */

export const MCP_SCOPES = [SCOPE_READ, SCOPE_WRITE];
export const OAUTH_ACCESS_TOKEN_TTL_S = 15 * 60;
export const OAUTH_REFRESH_IDLE_TTL_S = 90 * 86_400;

export type EnvWithOAuth = Env & { OAUTH_PROVIDER?: OAuthHelpers };

export function mcpOrigin(env: Env, request?: Request): string {
  return (env.MCP_ORIGIN ?? env.APP_ORIGIN ?? (request ? new URL(request.url).origin : 'http://localhost:8787')).replace(/\/+$/, '');
}

const DEV_STATE_SECRET = 'garderobe-local-development-state-secret-not-for-deployment';

/** Secret for signed state; a fixed development value is used only when ENVIRONMENT=local. */
export function stateSecret(env: Env): string {
  if (env.MCP_STATE_SECRET && env.MCP_STATE_SECRET.length >= 32) return env.MCP_STATE_SECRET;
  if (env.ENVIRONMENT === 'local') return DEV_STATE_SECRET;
  throw new HttpError(503, 'not_configured', 'MCP_STATE_SECRET is not configured');
}

const providers = new Map<string, OAuthProvider>();

/** One provider per MCP origin (constructed lazily because the origin comes from the environment). */
export function oauthProvider(env: Env, handlers: { mcp: ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>['fetch']> }; app: ExportedHandler<Env> }): OAuthProvider {
  const origin = mcpOrigin(env);
  let p = providers.get(origin);
  if (p) return p;
  p = new OAuthProvider({
    apiHandlers: { [`${origin}/mcp`]: handlers.mcp as never },
    defaultHandler: handlers.app as never,
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    clientRegistrationEndpoint: `${origin}/oauth/register`,
    accessTokenTTL: OAUTH_ACCESS_TOKEN_TTL_S,
    refreshTokenTTL: OAUTH_REFRESH_IDLE_TTL_S,
    refreshTokenIdleTTL: OAUTH_REFRESH_IDLE_TTL_S,
    scopesSupported: MCP_SCOPES,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Garderobe' },
    requiredScopes: [SCOPE_READ],
    tokenExchangeCallback: async (options) => {
      const e = options.env as Env;
      const props = options.props as GrantProps;
      if (options.grantType === 'authorization_code') {
        await attachProviderGrant(e.DB, options.userId, props.grantRef, options.grantId);
        return;
      }
      if (options.grantType === 'refresh_token') {
        const check = await checkGrant(e.DB, props);
        if (!check.ok) throw new OAuthError('invalid_grant', { description: `This connection was disconnected (${check.reason}); reconnect from Garderobe.` });
        // Never widen: the token carries at most what the owner granted in D1.
        return { accessTokenScope: options.requestedScope.filter((s) => check.scopes.includes(s)) };
      }
      return;
    },
  });
  providers.set(origin, p);
  return p;
}

function consentHosts(env: Env, request: Request): string[] {
  return [new URL(mcpOrigin(env, request)).hostname];
}

/** GET/POST /authorize on the MCP hostname (an Access path rule protects it). */
export async function handleAuthorize(env: EnvWithOAuth, request: Request): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;
  if (!helpers) throw new HttpError(500, 'not_configured', 'OAuth provider helpers are unavailable');
  const auth = await authenticateAccess(env, request, { extraHosts: consentHosts(env, request) });
  const secret = stateSecret(env);
  if (request.method === 'GET') {
    let authRequest;
    try {
      authRequest = await helpers.parseAuthRequest(request);
    } catch (err) {
      return html(messagePage('This connection request is not valid', err instanceof Error ? err.message : 'Invalid authorization request'), 400);
    }
    const unknown = authRequest.scope.filter((s) => !MCP_SCOPES.includes(s));
    if (unknown.length) return html(messagePage('Unsupported permissions requested', `Garderobe does not offer: ${unknown.join(', ')}`), 400);
    const details = await helpers.describeConsent(authRequest);
    const consent = await helpers.beginConsent(authRequest);
    const binding = await signState(secret, { u: auth.principal.userId, h: consent.handle, exp: Date.now() + 10 * 60_000 });
    return html(consentPage(details, consent.handle, binding, auth.displayName), 200, consent.headers);
  }
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use GET or POST');
  const form = await readForm(request.clone());
  const handle = form.get('handle') ?? '';
  const binding = await verifyState<{ u: string; h: string; exp: number }>(secret, form.get('owner') ?? '');
  if (!binding || binding.u !== auth.principal.userId || binding.h !== handle || binding.exp < Date.now()) {
    return html(messagePage('Please start again', 'This approval page belongs to a different sign-in or has expired.'), 403);
  }
  if (form.get('decision') !== 'approve') {
    const denied = await helpers.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const chosen = [...new Set(form.getAll('scope').map(String))];
  if (!chosen.includes(SCOPE_READ) || chosen.some((s) => !MCP_SCOPES.includes(s))) return html(messagePage('Invalid permissions', 'Read access is required and only Garderobe permissions can be granted.'), 400);
  let approved;
  try {
    approved = await helpers.approveConsent(request, handle);
  } catch (err) {
    return html(messagePage('Please start again', err instanceof Error ? err.message : 'This approval was already used or has expired.'), 400);
  }
  // The owner may approve fewer capabilities than the client requested, never more (read is always granted).
  const requested = new Set([SCOPE_READ, ...approved.request.scope]);
  const scopes = chosen.filter((s) => requested.has(s));
  const client = await helpers.lookupClient(approved.request.clientId);
  const now = new Date().toISOString();
  // A reconnect replaces the earlier grant of the same client and redirect.
  const grant = await createGrantRecord(env.DB, {
    userId: auth.principal.userId,
    clientId: approved.request.clientId,
    clientName: client?.clientName ?? approved.request.clientId,
    redirectUri: approved.request.redirectUri,
    scopes,
    now,
  });
  await env.DB.prepare(
    "UPDATE mcp_grants SET status = 'revoked', version = version + 1, revoked_at = ?, revoked_reason = 'replaced by reconnect', updated_at = ? WHERE user_id = ? AND client_id = ? AND redirect_host = ? AND grant_id <> ? AND status = 'active'",
  )
    .bind(now, now, auth.principal.userId, grant.client_id, grant.redirect_host, grant.grant_id)
    .run();
  const props: GrantProps = { userId: auth.principal.userId, grantRef: grant.grant_id, grantVersion: grant.version };
  const { redirectTo } = await helpers.completeAuthorization({
    request: { ...approved.request, scope: scopes },
    userId: auth.principal.userId,
    metadata: { grantRef: grant.grant_id, clientKind: grant.client_kind },
    scope: scopes,
    props,
  });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}
