import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Bindings and configuration of the Garderobe Worker.
 *
 * None of these is a Cloudflare management credential: the Worker never holds an account API token.
 * Application login is a Cloudflare Access assertion verified against the team's public keys; MCP
 * access is a grant issued by this Worker's own OAuth authorization server.
 */
export interface Env {
  /** D1: the domain ledger and every workstream's tables. */
  DB: D1Database;
  /** KV namespace required by @cloudflare/workers-oauth-provider (clients, grants, token hashes). */
  OAUTH_KV: KVNamespace;
  /** Private R2 bucket for export packages (short-lived, owner-prefixed keys). */
  EXPORT_BUCKET: R2Bucket;
  /** Private R2 bucket of the visual wardrobe (no public domain). */
  MEDIA_BUCKET?: R2Bucket;
  MEDIA_QUEUE?: Queue;
  IMAGES?: unknown;
  /** Think conversation authority (Durable Object namespace of GarderobeAssistant). */
  ASSISTANT?: DurableObjectNamespace;
  AI?: unknown;
  AI_SEARCH?: unknown;
  AI_GATEWAY_ID?: string;
  /** Injected by the OAuth provider for the default handler. */
  OAUTH_PROVIDER?: OAuthHelpers;

  /** Deployment environment name: `local`, `test`, `dev`, ... */
  ENVIRONMENT: string;
  /** Origin of the app/API hostname (behind Cloudflare Access), e.g. https://garderobe-dev.example.com */
  APP_ORIGIN: string;
  /** Origin of the MCP hostname (Workers OAuth provider). May equal APP_ORIGIN in local development. */
  MCP_ORIGIN: string;
  /** Cloudflare Access team domain (the assertion issuer), e.g. https://team.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application audience tag(s), comma separated. */
  ACCESS_AUD: string;
  /**
   * Public JWKS used instead of fetching the team's certificate endpoint. Accepted only when
   * ENVIRONMENT is `local` or `test` (local run mode and tests sign assertions with a generated key).
   */
  ACCESS_JWKS_JSON?: string;

  /** Secret: base64 of 32 random bytes; AES-256-GCM key for third-party credentials at rest. */
  CREDENTIAL_KEY: string;
  /** Secret (>= 32 chars): HMAC key for one-time code hashes and MCP multi-round-trip request state. */
  STATE_SIGNING_KEY: string;
  /** Secret (>= 32 chars) of the media workstream's upload/read tokens. */
  MEDIA_SIGNING_KEY?: string;
  /** Google OAuth client of the dedicated Google Cloud project (Workspace connection; not app login). */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  /** Overrides for the Google endpoints (local run mode and tests point these at a local fixture server). */
  GOOGLE_OAUTH_AUTHORIZE_URL?: string;
  GOOGLE_OAUTH_TOKEN_URL?: string;
  GOOGLE_OAUTH_REVOKE_URL?: string;
  GOOGLE_API_BASE_URL?: string;
  /** Universal-link prefix the system browser returns to after a connection flow. */
  APP_RETURN_URL?: string;
}

export const LOCAL_ENVIRONMENTS = new Set(["local", "test"]);

export interface Config {
  environment: string;
  isLocal: boolean;
  appOrigin: string;
  mcpOrigin: string;
  mcpResource: string;
  accessIssuer: string;
  accessAudiences: string[];
}

function origin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`configuration error: ${name} is not a URL`);
  }
  return url.origin;
}

const configs = new WeakMap<object, Config>();

export function configOf(env: Env): Config {
  const cached = configs.get(env);
  if (cached) return cached;
  for (const key of ["ENVIRONMENT", "APP_ORIGIN", "MCP_ORIGIN", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "CREDENTIAL_KEY", "STATE_SIGNING_KEY"] as const) {
    if (!env[key]) throw new Error(`configuration error: ${key} is not set`);
  }
  if (env.STATE_SIGNING_KEY.length < 32) throw new Error("configuration error: STATE_SIGNING_KEY must be at least 32 characters");
  const isLocal = LOCAL_ENVIRONMENTS.has(env.ENVIRONMENT);
  if (env.ACCESS_JWKS_JSON && !isLocal) throw new Error("configuration error: ACCESS_JWKS_JSON is only accepted in local and test environments");
  const mcpOrigin = origin(env.MCP_ORIGIN, "MCP_ORIGIN");
  const config: Config = {
    environment: env.ENVIRONMENT,
    isLocal,
    appOrigin: origin(env.APP_ORIGIN, "APP_ORIGIN"),
    mcpOrigin,
    mcpResource: `${mcpOrigin}/mcp`,
    accessIssuer: env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, ""),
    accessAudiences: env.ACCESS_AUD.split(",").map((s) => s.trim()).filter(Boolean),
  };
  configs.set(env, config);
  return config;
}
