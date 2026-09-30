/**
 * Worker bindings. Keep in sync with wrangler.jsonc. Later workstreams add bindings additively.
 */
export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  OAUTH_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  INDEX_QUEUE: Queue;
  MEDIA_QUEUE: Queue;
  DAILY_SERVICE_WORKFLOW: Workflow;
  ASSISTANT: DurableObjectNamespace;
  AI: Ai;
  ENVIRONMENT: string;
  AI_GATEWAY_ID: string;
  AI_GATEWAY_ACCOUNT_ID: string;
  DEFAULT_TIMEZONE: string;
  // ---- HTTP API, MCP server and authentication (API/MCP workstream). Optional so tests and other
  // packages typed against Env are unaffected; see backend/src/api/README.md.
  /** Cloudflare Access issuer, e.g. https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Comma-separated Access application AUD tags (app/API, web board). */
  ACCESS_AUD?: string;
  /** Optional static JWKS (local development and tests); otherwise fetched from the team domain. */
  ACCESS_JWKS_JSON?: string;
  /** Comma-separated hostnames protected by Access (the app/API hostname and the web board). */
  APP_HOSTNAMES?: string;
  /** Public origin of the app/API hostname, e.g. https://garderobe.example.com */
  APP_ORIGIN?: string;
  /** Public origin of the MCP hostname (resource and OAuth issuer), e.g. https://mcp.garderobe.example.com */
  MCP_ORIGIN?: string;
  /** Comma-separated redirect URIs registered for the native iOS public client. */
  NATIVE_REDIRECT_URIS?: string;
  /** Secret for integrity-protecting MCP input_required request state (Worker secret). */
  MCP_STATE_SECRET?: string;
  /** Weather provider: 'open-meteo' (default) or, when ENVIRONMENT=local only, 'fake:<scenario>'. */
  WEATHER_PROVIDER?: string;
  /** Secret for owner-scoped signed media URLs (visual wardrobe workstream). */
  MEDIA_URL_SIGNING_KEY?: string;
  /** AI Gateway run token for the Unified Billing compat route (Worker secret; deployments only). */
  AI_GATEWAY_TOKEN?: string;
  /** Recorded Gateway/Unified Billing probe outcomes by model profile (JSON; deployments only). */
  MODEL_PROBES?: string;
  /**
   * Deployment-wide model spend ceiling in US dollars over a 30-day sliding window, across every owner
   * and model (models/budget.ts SpendCap). Set on dev to the owner's $50 rule because the gateway's
   * rule does not count gpt-6.1-sol. Unset: no deployment cap.
   */
  MODEL_SPEND_CAP_USD?: string;
}
