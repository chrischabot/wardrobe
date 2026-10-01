import { OAuthProvider, insufficientScope, type OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import type { Scope } from "@garderobe/contracts";
import { MCP_SCOPES } from "@garderobe/contracts/ext/api";
import { createPrincipal, prepare, stmt } from "@garderobe/domain";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { appFor, type App } from "../app.ts";
import { configOf, type Env } from "../env.ts";
import { ApiException, normalizeError } from "../errors.ts";
import type { McpProps } from "./consent.ts";
import { requireActiveGrant } from "./grants.ts";
import { buildMcpServer, type McpCaller } from "./server.ts";

/** Access tokens live 15 minutes; refresh credentials rotate and a grant ends after 90 idle days. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_IDLE_TTL_SECONDS = 90 * 86_400;

const handlers = new WeakMap<App, McpHttpHandler>();

function mcpHandler(app: App): McpHttpHandler {
  let handler = handlers.get(app);
  if (!handler) {
    handler = createMcpHandler(
      (ctx) => {
        const caller = ctx.authInfo?.extra?.caller as McpCaller | undefined;
        // The factory is only ever reached through protectedMcpFetch, which always supplies a caller.
        if (!caller) throw new Error("mcp request without an authenticated caller");
        (ctx.authInfo!.extra as Record<string, unknown>).era = ctx.era;
        return buildMcpServer(app, caller);
      },
      {
        // 2026-07-28 is the native contract; 2025-11-25 peers are served by the SDK's stateless fallback
        // from the same factory (the compatibility path), recorded per connection below.
        legacy: "stateless",
        responseMode: "auto",
        onerror: (error) => console.warn("mcp transport", String(error?.message ?? error)),
      },
    );
    handlers.set(app, handler);
  }
  return handler;
}

function bearerError(app: App, status: number, error: string, description: string): Response {
  const metadata = `${app.config.mcpOrigin}/.well-known/oauth-protected-resource/mcp`;
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "WWW-Authenticate": `Bearer error="${error}", error_description="${description}", resource_metadata="${metadata}"` },
  });
}

/** Which tool a JSON-RPC body calls, read from a clone so the request stays readable. */
async function calledTool(request: Request): Promise<string | null> {
  if (request.method !== "POST") return null;
  try {
    const body = (await request.clone().json()) as { method?: string; params?: { name?: string } } | unknown[];
    if (Array.isArray(body)) return null;
    return body.method === "tools/call" && typeof body.params?.name === "string" ? body.params.name : null;
  } catch {
    return null;
  }
}

/**
 * The protected MCP endpoint. The Workers OAuth provider has already validated the bearer token for
 * this resource; here the application decides:
 *  1. the request arrived on the MCP hostname;
 *  2. the grant is still active in D1 (immediate revocation, independent of the provider's KV state)
 *     and the account is active;
 *  3. the effective permissions are the intersection of the token's scopes and the recorded grant;
 *  4. the owner is the grant's internal user. Nothing in the request body can name another owner.
 */
export async function protectedMcpFetch(request: Request, env: Env, ctx: ExecutionContext & { props?: unknown; auth?: OAuthResourceAuth }): Promise<Response> {
  const app = appFor(env);
  const url = new URL(request.url);
  if (url.origin !== app.config.mcpOrigin) return bearerError(app, 401, "invalid_token", "this endpoint is only served on the MCP hostname");
  const props = ctx.props as McpProps | undefined;
  const auth = ctx.auth;
  if (!props?.userId || !props.grantId || !auth) return bearerError(app, 401, "invalid_token", "the access token is not a Garderobe grant");
  let grant;
  try {
    grant = await requireActiveGrant(app.db, props.userId, props.grantId, app.now());
  } catch (error) {
    if (error instanceof ApiException) return bearerError(app, 401, "invalid_token", error.message);
    const n = normalizeError(error);
    return new Response(JSON.stringify({ error: n.code }), { status: n.status, headers: { "Content-Type": "application/json" } });
  }
  const tokenScopes = new Set(auth.scope);
  const granted = grant.scopes.filter((s) => (MCP_SCOPES as readonly string[]).includes(s) && tokenScopes.has(s));
  if (!granted.includes("wardrobe.read")) return insufficientScope(auth, ["wardrobe.read"], "this connection may not read the wardrobe");
  const canWrite = granted.includes("wardrobe.write");

  // Scope denial as an OAuth step-up: a read-only connection calling the write tool is told which scopes it needs.
  if (!canWrite && (await calledTool(request)) === "garderobe_command") {
    return insufficientScope(auth, ["wardrobe.read", "wardrobe.write"], "this connection is read-only; changing the wardrobe needs the write permission");
  }

  const scopes: Scope[] = canWrite ? ["read", "write"] : ["read"];
  // An external assistant relays the owner's statements: it acts as `assistant` on channel `mcp`, never as `owner`.
  const principal = createPrincipal({ userId: props.userId, actor: "assistant", channel: "mcp", scopes, authRef: `mcp:${grant.grantId}` });
  const caller: McpCaller = { principal, grantId: grant.grantId, clientId: grant.clientId, canWrite, exec: ctx };
  const extra: Record<string, unknown> = { caller, grantId: grant.grantId };
  const response = await mcpHandler(app).fetch(request, {
    // The token itself is deliberately not handed to tool code.
    authInfo: { token: "", clientId: grant.clientId, scopes: granted, ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}), resource: new URL(app.config.mcpResource), extra },
  });
  // Record which protocol era this connection actually used (compatibility is recorded, never assumed).
  const era = extra.era === "legacy" ? "2025-11-25 (compatibility)" : extra.era === "modern" ? "2026-07-28" : null;
  if (era) ctx.waitUntil(prepare(app.db, stmt("UPDATE mcp_grants SET protocol = ? WHERE user_id = ? AND grant_id = ? AND (protocol IS NULL OR protocol != ?)", era, props.userId, grant.grantId, era)).run());
  return response;
}

const providers = new WeakMap<object, OAuthProvider<Env>>();

/**
 * The MCP authorization server and protected resource (the maintained Workers OAuth provider; no
 * bespoke token server). It issues Garderobe credentials only: the owner's Google token is never
 * passed to a consumer assistant. Discovery, token, registration and revocation are served by the
 * library on the MCP hostname; the consent page is application code on the Access-protected app
 * hostname. Client ID Metadata Documents are supported; dynamic registration is kept for consumer
 * compatibility.
 */
export function oauthProviderFor(env: Env, defaultFetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>): OAuthProvider<Env> {
  const cached = providers.get(env);
  if (cached) return cached;
  const config = configOf(env);
  const provider = new OAuthProvider<Env>({
    apiRoute: config.mcpResource,
    apiHandler: { fetch: protectedMcpFetch as never },
    defaultHandler: { fetch: defaultFetch as never },
    authorizeEndpoint: `${config.appOrigin}/oauth/authorize`,
    tokenEndpoint: `${config.mcpOrigin}/oauth/token`,
    clientRegistrationEndpoint: `${config.mcpOrigin}/oauth/register`,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_IDLE_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_IDLE_TTL_SECONDS,
    scopesSupported: [...MCP_SCOPES],
    requiredScopes: ["wardrobe.read"],
    resourceMetadata: { resource: config.mcpResource, authorization_servers: [config.mcpOrigin], resource_name: "Garderobe" },
    clientIdMetadataDocumentEnabled: true,
  });
  providers.set(env, provider);
  return provider;
}
