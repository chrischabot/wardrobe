import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, registerClient, startAuthorization, validateAuthorizationResponseIssuer } from "@modelcontextprotocol/client";
import { GOOGLE_CAPABILITIES, type ApiConnection, type ConnectionCapability, type RegisterConnectionRequest } from "@garderobe/contracts/ext/api";
import { all, first, getSettings, json as parseJson, prepare, stmt, toInstant, type Db, type Principal, type Stmt } from "@garderobe/domain";
import type { z } from "zod";
import type { App } from "../app.ts";
import { auditStatement, type OwnerSession } from "../auth/session.ts";
import { codeHash, randomBytes, randomToken, seal, sha256Hex, toBase64Url, unseal } from "../crypto.ts";
import type { Env } from "../env.ts";
import { ApiException } from "../errors.ts";
import { assertRemoteUrl, guardedFetch, redactText, redactUrl } from "./endpoints.ts";

type Connection = z.infer<typeof ApiConnection>;
type Capability = z.infer<typeof ConnectionCapability>;
type RegisterInput = z.output<typeof RegisterConnectionRequest>;
type GoogleCapability = (typeof GOOGLE_CAPABILITIES)[number];

const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * Capability -> provider scopes (the narrowest that work). Reading uses the event and calendar-list
 * read scopes; writing uses `calendar.app.created`, which lets the backend create its own secondary
 * calendar and change events only on calendars it created: the dedicated outfit calendar, never the
 * owner's other calendars. (Scope list verified against Google's Calendar API scope documentation.)
 */
const GOOGLE: Record<GoogleCapability, { label: string; effect: "read" | "write"; scopes: string[]; service: "gmail" | "calendar" | "drive" | "sheets" }> = {
  "gmail.read_orders": { label: "Read order and delivery emails", effect: "read", scopes: ["https://www.googleapis.com/auth/gmail.readonly"], service: "gmail" },
  "calendar.read": { label: "Read your calendar for the day", effect: "read", scopes: ["https://www.googleapis.com/auth/calendar.events.readonly", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"], service: "calendar" },
  "calendar.write_outfit_calendar": { label: "Write the daily board to the outfit calendar", effect: "write", scopes: ["https://www.googleapis.com/auth/calendar.app.created"], service: "calendar" },
  "drive.read_selected": { label: "Read files you choose in Drive", effect: "read", scopes: ["https://www.googleapis.com/auth/drive.file"], service: "drive" },
  "sheets.read_selected": { label: "Read spreadsheets you choose", effect: "read", scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"], service: "sheets" },
};
const GOOGLE_SERVICE_ENDPOINT = { gmail: "https://gmail.googleapis.com/", calendar: "https://www.googleapis.com/calendar/v3/", drive: "https://www.googleapis.com/drive/v3/", sheets: "https://sheets.googleapis.com/" } as const;
const FIXED_ENDPOINTS: Record<string, string> = { exa: "https://mcp.exa.ai/mcp", tavily: "https://mcp.tavily.com/mcp" };

const googleAuthorizeUrl = (env: Env) => env.GOOGLE_OAUTH_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = (env: Env) => env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const googleRevokeUrl = (env: Env) => env.GOOGLE_OAUTH_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke";
const callbackUrl = (app: App) => `${app.config.appOrigin}/connections/callback`;

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

interface ProfileRow {
  connection_id: string;
  kind: Connection["kind"];
  name: string;
  endpoint: string | null;
  namespace: string;
  protocol: string | null;
  auth_type: Connection["authType"];
  state: Connection["state"];
  capabilities_json: string;
  expected_issuer: string | null;
  last_success_at: string | null;
  last_checked_at: string | null;
  issue_json: string | null;
  version: number;
  created_at: string;
}
const PROFILE_COLUMNS = "connection_id, kind, name, endpoint, namespace, protocol, auth_type, state, capabilities_json, expected_issuer, last_success_at, last_checked_at, issue_json, version, created_at";

function toConnection(row: ProfileRow): Connection {
  return {
    connectionId: row.connection_id,
    kind: row.kind,
    name: row.name,
    endpoint: row.endpoint,
    namespace: row.namespace,
    protocol: row.protocol,
    authType: row.auth_type,
    state: row.state,
    capabilities: parseJson<Capability[]>(row.capabilities_json, []),
    lastSuccessAt: row.last_success_at,
    lastCheckedAt: row.last_checked_at,
    issue: parseJson(row.issue_json, null),
    createdAt: row.created_at,
    version: row.version,
  };
}

async function loadProfile(db: Db, userId: string, connectionId: string): Promise<ProfileRow> {
  const row = await first<ProfileRow>(db, `SELECT ${PROFILE_COLUMNS} FROM connection_profiles WHERE user_id = ? AND connection_id = ?`, userId, connectionId);
  if (!row) throw new ApiException("not_found", "that connection was not found");
  return row;
}

export async function listConnections(db: Db, userId: string): Promise<Connection[]> {
  const rows = await all<ProfileRow>(db, `SELECT ${PROFILE_COLUMNS} FROM connection_profiles WHERE user_id = ? ORDER BY CASE kind WHEN 'google_workspace' THEN 0 ELSE 1 END, created_at`, userId);
  return rows.map(toConnection);
}

const secretRefOf = (connectionId: string) => `cred_${connectionId}`;
const aadOf = (userId: string, secretRef: string) => `connection-credential\u0000${userId}\u0000${secretRef}`;

interface GoogleCredential {
  type: "google";
  refreshToken: string;
  accessToken: string;
  accessExpiresAtMs: number;
  grantedScopes: string[];
}
interface SecretCredential {
  type: "secret";
  secret: string;
}
interface McpOAuthCredential {
  type: "mcp_oauth";
  authorizationServerUrl: string;
  clientInformation: Record<string, unknown>;
  resource: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  accessExpiresAtMs: number | null;
}
type Credential = GoogleCredential | SecretCredential | McpOAuthCredential;

async function credentialUpsert(env: Env, userId: string, connectionId: string, kind: string, authType: string, value: Credential | null, now: string): Promise<Stmt> {
  const secretRef = secretRefOf(connectionId);
  const sealed = value ? await seal(env.CREDENTIAL_KEY, value, aadOf(userId, secretRef)) : null;
  return stmt(
    `INSERT INTO connection_credentials (user_id, secret_ref, connection_id, kind, auth_type, ciphertext, iv, key_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, secret_ref) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, key_version = excluded.key_version, version = connection_credentials.version + 1, rotated_at = excluded.created_at, removed_at = NULL`,
    userId,
    secretRef,
    connectionId,
    kind,
    authType,
    sealed?.ciphertext ?? null,
    sealed?.iv ?? null,
    sealed?.keyVersion ?? null,
    now,
  );
}

async function readCredential(env: Env, db: Db, userId: string, connectionId: string): Promise<{ value: Credential; version: number } | null> {
  const secretRef = secretRefOf(connectionId);
  const row = await first<{ ciphertext: string | null; iv: string | null; version: number; removed_at: string | null }>(db, "SELECT ciphertext, iv, version, removed_at FROM connection_credentials WHERE user_id = ? AND secret_ref = ?", userId, secretRef);
  if (!row || !row.ciphertext || !row.iv || row.removed_at !== null) return null;
  return { value: await unseal<Credential>(env.CREDENTIAL_KEY, { ciphertext: row.ciphertext, iv: row.iv }, aadOf(userId, secretRef)), version: row.version };
}

function profileUpdate(userId: string, connectionId: string, patch: { state?: Connection["state"]; capabilities?: Capability[]; issue?: Connection["issue"]; lastSuccessAt?: string; protocol?: string | null; expectedIssuer?: string | null }, now: string): Stmt {
  const sets = ["version = version + 1", "updated_at = ?", "last_checked_at = ?"];
  const params: unknown[] = [now, now];
  if (patch.state !== undefined) (sets.push("state = ?"), params.push(patch.state));
  if (patch.capabilities !== undefined) (sets.push("capabilities_json = ?"), params.push(JSON.stringify(patch.capabilities)));
  if (patch.issue !== undefined) (sets.push("issue_json = ?"), params.push(patch.issue === null ? null : JSON.stringify(patch.issue)));
  if (patch.lastSuccessAt !== undefined) (sets.push("last_success_at = ?"), params.push(patch.lastSuccessAt));
  if (patch.protocol !== undefined) (sets.push("protocol = ?"), params.push(patch.protocol));
  if (patch.expectedIssuer !== undefined) (sets.push("expected_issuer = ?"), params.push(patch.expectedIssuer));
  return stmt(`UPDATE connection_profiles SET ${sets.join(", ")} WHERE user_id = ? AND connection_id = ?`, ...params, userId, connectionId);
}

async function uniqueNamespace(db: Db, userId: string, name: string, kind: string): Promise<string> {
  const base = (kind === "google_workspace" ? "google" : name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")).replace(/^[^a-z]+/, "").slice(0, 20) || "conn";
  const taken = new Set((await all<{ namespace: string }>(db, "SELECT namespace FROM connection_profiles WHERE user_id = ?", userId)).map((r) => r.namespace));
  if (!taken.has(base) && base.length >= 2) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${toBase64Url(randomBytes(4)).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/* ------------------------------------------------------------------ */
/* The assistant's connection registry (its executor reads this)        */
/* ------------------------------------------------------------------ */

async function assistantCommand(app: App, principal: Principal, type: string, payload: Record<string, unknown>, key: string): Promise<void> {
  if (!app.registry.has(type)) return;
  await app.service.execute(principal, { type, payload, idempotencyKey: key, expectedVersions: {}, authorization: "owner_tap", source: { channel: principal.channel } });
}

/** Mirror a connected profile into the assistant's registry: one entry per Google service, or the MCP endpoint itself. */
async function syncToAssistant(app: App, principal: Principal, profile: ProfileRow, status: "connected" | "needs_reauthorization" | "revoked", reason: string | null): Promise<void> {
  const capabilities = parseJson<Capability[]>(profile.capabilities_json, []);
  const entries: { connectionId: string; kind: string; label: string; endpoint: string; namespace: string; scopes: string[] }[] = [];
  if (profile.kind === "google_workspace") {
    for (const service of ["gmail", "calendar", "drive", "sheets"] as const) {
      const keys = capabilities.filter((c) => c.enabled && c.available && GOOGLE[c.key as GoogleCapability]?.service === service).map((c) => c.key);
      const everEnabled = capabilities.some((c) => GOOGLE[c.key as GoogleCapability]?.service === service && c.enabled);
      if (keys.length === 0 && !(status !== "connected" && everEnabled)) continue;
      entries.push({ connectionId: `${profile.connection_id}_${service}`, kind: service, label: `${profile.name} (${service})`, endpoint: GOOGLE_SERVICE_ENDPOINT[service], namespace: `${profile.namespace}_${service}`.slice(0, 31), scopes: keys });
    }
  } else if (profile.endpoint) {
    entries.push({ connectionId: profile.connection_id, kind: profile.kind, label: profile.name, endpoint: profile.endpoint, namespace: profile.namespace, scopes: capabilities.filter((c) => c.enabled).map((c) => c.key) });
  }
  const stamp = `${profile.version}`;
  for (const entry of entries) {
    if (status === "connected") {
      await assistantCommand(app, principal, "connection.register", { ...entry, secretRef: profile.auth_type === "none" ? null : secretRefOf(profile.connection_id) }, `connection:${entry.connectionId}:register:${await sha256Hex(JSON.stringify(entry))}`);
    }
    try {
      await assistantCommand(app, principal, "connection.set_status", { connectionId: entry.connectionId, status, reason }, `connection:${entry.connectionId}:status:${status}:${stamp}`);
    } catch (error) {
      // An entry that was never registered has nothing to update.
      if (status === "connected") throw error;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                         */
/* ------------------------------------------------------------------ */

function googleCapabilities(enabled: string[], grantedScopes: string[] | null): Capability[] {
  return GOOGLE_CAPABILITIES.map((key) => ({ key, label: GOOGLE[key].label, effect: GOOGLE[key].effect, enabled: enabled.includes(key), available: grantedScopes !== null && GOOGLE[key].scopes.every((s) => grantedScopes.includes(s)) }));
}

async function newOAuthState(app: App, userId: string, connectionId: string, verifier: string | null, returnTo: string, nowMs: number): Promise<{ state: string; statement: Stmt }> {
  const state = randomToken(32);
  const stateHash = await codeHash(app.env.STATE_SIGNING_KEY, "connection-oauth-state", state);
  const sealed = verifier ? await seal(app.env.CREDENTIAL_KEY, { verifier }, `oauth-state\u0000${stateHash}`) : null;
  return {
    state,
    statement: stmt(
      "INSERT INTO connection_oauth_states (state_hash, user_id, connection_id, verifier_cipher, verifier_iv, redirect_uri, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      stateHash,
      userId,
      connectionId,
      sealed?.ciphertext ?? null,
      sealed?.iv ?? null,
      callbackUrl(app),
      returnTo,
      toInstant(nowMs),
      toInstant(nowMs + OAUTH_STATE_TTL_MS),
    ),
  };
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(digest) };
}

async function googleAuthorization(app: App, userId: string, connectionId: string, enabled: string[], returnTo: string, nowMs: number): Promise<{ url: string; statement: Stmt }> {
  if (!app.env.GOOGLE_OAUTH_CLIENT_ID || !app.env.GOOGLE_OAUTH_CLIENT_SECRET) throw new ApiException("module_unavailable", "Google connections are not configured in this deployment", { module: "google_oauth" });
  const { verifier, challenge } = await pkce();
  const { state, statement } = await newOAuthState(app, userId, connectionId, verifier, returnTo, nowMs);
  const url = new URL(googleAuthorizeUrl(app.env));
  url.searchParams.set("client_id", app.env.GOOGLE_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(app));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...new Set(enabled.flatMap((k) => GOOGLE[k as GoogleCapability].scopes))].join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), statement };
}

/** Discover an MCP server's authorization server, register this backend as a client and build the authorization URL. */
async function mcpAuthorization(app: App, userId: string, connectionId: string, endpoint: string, returnTo: string, nowMs: number): Promise<{ url: string; statements: Stmt[]; issuer: string }> {
  const fetchFn = guardedFetch();
  const info = await discoverOAuthServerInfo(endpoint, { fetchFn });
  assertRemoteUrl(info.authorizationServerUrl, "authorization server");
  const metadata = info.authorizationServerMetadata;
  if (!metadata) throw new ApiException("precondition_failed", "that service does not publish OAuth authorization metadata", { reason: "no_authorization_metadata" });
  const clientInformation = await registerClient(info.authorizationServerUrl, {
    metadata,
    clientMetadata: { client_name: "Garderobe", redirect_uris: [callbackUrl(app)], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    fetchFn,
  });
  const stateToken = randomToken(32);
  const resource = info.resourceMetadata?.resource ? new URL(info.resourceMetadata.resource) : new URL(endpoint);
  const started = await startAuthorization(info.authorizationServerUrl, { metadata, clientInformation, redirectUrl: callbackUrl(app), state: stateToken, resource });
  assertRemoteUrl(new URL(started.authorizationUrl.toString().split("?")[0]!), "authorization endpoint");
  const stateHash = await codeHash(app.env.STATE_SIGNING_KEY, "connection-oauth-state", stateToken);
  const sealed = await seal(app.env.CREDENTIAL_KEY, { verifier: started.codeVerifier }, `oauth-state\u0000${stateHash}`);
  const now = toInstant(nowMs);
  const pending: McpOAuthCredential = { type: "mcp_oauth", authorizationServerUrl: info.authorizationServerUrl, clientInformation: clientInformation as unknown as Record<string, unknown>, resource: resource.toString(), accessToken: null, refreshToken: null, accessExpiresAtMs: null };
  return {
    url: started.authorizationUrl.toString(),
    issuer: String(metadata.issuer ?? info.authorizationServerUrl),
    statements: [
      stmt(
        "INSERT INTO connection_oauth_states (state_hash, user_id, connection_id, verifier_cipher, verifier_iv, redirect_uri, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        stateHash,
        userId,
        connectionId,
        sealed.ciphertext,
        sealed.iv,
        callbackUrl(app),
        returnTo,
        now,
        toInstant(nowMs + OAUTH_STATE_TTL_MS),
      ),
      await credentialUpsert(app.env, userId, connectionId, "mcp", "oauth", pending, now),
    ],
  };
}

export async function registerConnection(app: App, session: OwnerSession, input: RegisterInput): Promise<{ connection: Connection; authorizationUrl: string | null; replayed: boolean }> {
  const { db } = app;
  const userId = session.userId;
  const nowMs = app.now();
  const now = toInstant(nowMs);
  const existing = await first<ProfileRow>(db, `SELECT ${PROFILE_COLUMNS} FROM connection_profiles WHERE user_id = ? AND client_request_id = ?`, userId, input.clientRequestId);
  if (existing) return { connection: toConnection(existing), authorizationUrl: null, replayed: true };

  const connectionId = `con_${toBase64Url(randomBytes(9))}`;
  const namespace = await uniqueNamespace(db, userId, input.name, input.kind);
  const statements: Stmt[] = [];
  let authorizationUrl: string | null = null;
  let endpoint: string | null = null;
  let state: Connection["state"] = "connected";
  let capabilities: Capability[] = [];
  let protocol: string | null = null;
  let expectedIssuer: string | null = null;
  const credentialStatements: Stmt[] = [];

  if (input.kind === "google_workspace") {
    if (input.auth.type !== "oauth") throw new ApiException("invalid_command", "a Google connection is authorized in Google's own sign-in flow");
    const unknown = input.capabilities.filter((c) => !(GOOGLE_CAPABILITIES as readonly string[]).includes(c));
    if (unknown.length > 0) throw new ApiException("invalid_command", "unknown capability", { unknown, allowed: GOOGLE_CAPABILITIES });
    if (input.capabilities.length === 0) throw new ApiException("invalid_command", "choose at least one capability to connect");
    const other = await first(db, "SELECT connection_id FROM connection_profiles WHERE user_id = ? AND kind = 'google_workspace' AND state != 'disconnected'", userId);
    if (other) throw new ApiException("precondition_failed", "Google is already connected; change its capabilities or reconnect it instead", { reason: "already_connected" });
    capabilities = googleCapabilities(input.capabilities, null);
    state = "pending_authorization";
    protocol = "google-rest";
    expectedIssuer = "https://accounts.google.com";
    const auth = await googleAuthorization(app, userId, connectionId, input.capabilities, input.returnTo, nowMs);
    authorizationUrl = auth.url;
    credentialStatements.push(auth.statement);
  } else {
    const raw = input.kind === "mcp" ? input.endpoint : (FIXED_ENDPOINTS[input.kind] ?? input.endpoint);
    if (!raw) throw new ApiException("invalid_command", "an endpoint is required for this connection");
    endpoint = assertRemoteUrl(raw).toString();
    capabilities = [];
    if (input.auth.type === "secret") {
      credentialStatements.push(await credentialUpsert(app.env, userId, connectionId, input.kind, "secret", { type: "secret", secret: input.auth.secret }, now));
    } else if (input.auth.type === "oauth") {
      if (input.kind !== "mcp") throw new ApiException("invalid_command", "this connection uses a key, not a sign-in flow");
      state = "pending_authorization";
      const auth = await mcpAuthorization(app, userId, connectionId, endpoint, input.returnTo, nowMs);
      authorizationUrl = auth.url;
      expectedIssuer = auth.issuer;
      credentialStatements.push(...auth.statements);
    } else if (input.kind !== "mcp") {
      throw new ApiException("invalid_command", "this connection needs its key");
    }
  }

  const audit = await auditStatement({ userId, kind: "connection.register", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { connectionId, kind: input.kind, endpoint: endpoint ? redactUrl(endpoint) : null, authType: input.auth.type }, nowMs });
  statements.push(
    stmt(
      "INSERT INTO connection_profiles (user_id, connection_id, kind, name, endpoint, namespace, protocol, auth_type, state, capabilities_json, expected_issuer, client_request_id, last_checked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      userId,
      connectionId,
      input.kind,
      input.name,
      endpoint,
      namespace,
      protocol,
      input.auth.type,
      state,
      JSON.stringify(capabilities),
      expectedIssuer,
      input.clientRequestId,
      now,
      now,
      now,
    ),
    ...credentialStatements,
    audit.statement,
  );
  await db.batch(statements.map((s) => prepare(db, s)));
  const profile = await loadProfile(db, userId, connectionId);
  await reconcileRegistry(app, session.principal);
  return { connection: toConnection(profile), authorizationUrl, replayed: false };
}

/**
 * Bring the assistant's connection registry in line with the connection profiles (connected, needing
 * re-authorization, or revoked). Registering there is an owner action, so this runs inside an
 * authenticated owner request: right after a change the owner made, and on the next read after a
 * provider callback (which carries no owner session). Idempotent; a failure leaves the marker unset so
 * the next request tries again, and never blocks the owner's request.
 */
export async function reconcileRegistry(app: App, principal: Principal): Promise<void> {
  if (!app.assistant || principal.actor !== "owner") return;
  const rows = await all<ProfileRow>(app.db, `SELECT ${PROFILE_COLUMNS} FROM connection_profiles WHERE user_id = ? AND mirrored_version != version AND state != 'pending_authorization'`, principal.userId);
  for (const profile of rows) {
    try {
      if (profile.state === "connected") await syncToAssistant(app, principal, profile, "connected", null);
      else if (profile.state === "disconnected") await syncToAssistant(app, principal, profile, "revoked", "owner_disconnect");
      else await syncToAssistant(app, principal, profile, "needs_reauthorization", parseJson<{ message?: string } | null>(profile.issue_json, null)?.message ?? null);
      await prepare(app.db, stmt("UPDATE connection_profiles SET mirrored_version = ? WHERE user_id = ? AND connection_id = ? AND version = ?", profile.version, principal.userId, profile.connection_id, profile.version)).run();
    } catch (error) {
      console.warn("connection registry mirror failed", redactText(String((error as Error)?.message ?? error)));
    }
  }
}

export async function reconnectConnection(app: App, session: OwnerSession, connectionId: string, returnTo: string): Promise<{ connection: Connection; authorizationUrl: string | null; replayed: boolean }> {
  const profile = await loadProfile(app.db, session.userId, connectionId);
  if (profile.auth_type !== "oauth") throw new ApiException("precondition_failed", "this connection uses a key; remove it and add it again with the new key");
  const nowMs = app.now();
  const now = toInstant(nowMs);
  const capabilities = parseJson<Capability[]>(profile.capabilities_json, []);
  const statements: Stmt[] = [];
  let authorizationUrl: string;
  if (profile.kind === "google_workspace") {
    const enabled = capabilities.filter((c) => c.enabled).map((c) => c.key);
    const auth = await googleAuthorization(app, session.userId, connectionId, enabled.length > 0 ? enabled : ["calendar.read"], returnTo, nowMs);
    authorizationUrl = auth.url;
    statements.push(auth.statement);
  } else {
    const auth = await mcpAuthorization(app, session.userId, connectionId, profile.endpoint!, returnTo, nowMs);
    authorizationUrl = auth.url;
    statements.push(...auth.statements);
  }
  statements.push(profileUpdate(session.userId, connectionId, { state: "pending_authorization" }, now));
  await app.db.batch(statements.map((s) => prepare(app.db, s)));
  return { connection: toConnection(await loadProfile(app.db, session.userId, connectionId)), authorizationUrl, replayed: false };
}

/* ------------------------------------------------------------------ */
/* Provider callback                                                    */
/* ------------------------------------------------------------------ */

export interface CallbackOutcome {
  ok: boolean;
  title: string;
  message: string;
  returnTo: string;
}

/**
 * The provider's redirect back. Authentication is the stored one-time state alone: it names the owner
 * and the connection it was created for, expires after ten minutes and is spent before the code is
 * exchanged. No Access header, cookie or query field is trusted to say whose connection this is.
 */
export async function completeAuthorizationCallback(app: App, query: { state: string; code?: string; error?: string; iss?: string }): Promise<CallbackOutcome> {
  const { db, env } = app;
  const nowMs = app.now();
  const now = toInstant(nowMs);
  const stateHash = await codeHash(env.STATE_SIGNING_KEY, "connection-oauth-state", query.state);
  const row = await first<{ user_id: string; connection_id: string; verifier_cipher: string | null; verifier_iv: string | null; redirect_uri: string; return_to: string; expires_at: string; used_at: string | null }>(
    db,
    "SELECT user_id, connection_id, verifier_cipher, verifier_iv, redirect_uri, return_to, expires_at, used_at FROM connection_oauth_states WHERE state_hash = ?",
    stateHash,
  );
  const rejected = (message: string): CallbackOutcome => ({ ok: false, title: "This link cannot be used", message, returnTo: "app" });
  if (!row) return rejected("This connection link is not recognised. Start again from Settings.");
  if (row.used_at !== null) return rejected("This connection link was already used. Start again from Settings if the connection is not shown.");
  if (Date.parse(row.expires_at) <= nowMs) return rejected("This connection link has expired. Start again from Settings.");
  // Spend the state first; a concurrent second callback changes nothing.
  const spent = await prepare(db, stmt("UPDATE connection_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL", now, stateHash)).run();
  if ((spent.meta?.changes ?? 0) !== 1) return rejected("This connection link was already used. Start again from Settings if the connection is not shown.");

  const userId = row.user_id;
  const profile = await loadProfile(db, userId, row.connection_id);
  const user = await first<{ status: string }>(db, "SELECT status FROM users WHERE user_id = ?", userId);
  if (user?.status !== "active") return rejected("This account is not active.");
  const fail = async (message: string, reason: string): Promise<CallbackOutcome> => {
    const audit = await auditStatement({ userId, kind: "connection.authorize", outcome: "refused", channel: "web", detail: { connectionId: profile.connection_id, reason: redactText(reason).slice(0, 200) }, nowMs });
    await db.batch(
      [profileUpdate(userId, profile.connection_id, { state: "needs_reconnect", issue: { at: now, capability: null, message, action: "reconnect" } }, now), audit.statement].map((s) => prepare(db, s)),
    );
    return { ok: false, title: `${profile.name} was not connected`, message, returnTo: row.return_to };
  };
  if (query.error || !query.code) return fail(query.error === "access_denied" ? "You declined the request, so nothing was connected." : "The service did not complete the authorization.", query.error ?? "missing_code");
  const verifier = row.verifier_cipher && row.verifier_iv ? (await unseal<{ verifier: string }>(env.CREDENTIAL_KEY, { ciphertext: row.verifier_cipher, iv: row.verifier_iv }, `oauth-state\u0000${stateHash}`)).verifier : null;

  let credential: Credential;
  let capabilities = parseJson<Capability[]>(profile.capabilities_json, []);
  let issue: Connection["issue"] = null;
  try {
    if (profile.kind === "google_workspace") {
      const response = await fetch(googleTokenUrl(env), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "", client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "", redirect_uri: row.redirect_uri, code_verifier: verifier ?? "" }),
      });
      const body = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string };
      if (!response.ok || !body.access_token) return fail("Google did not accept the authorization. Try connecting again.", body.error ?? `http_${response.status}`);
      if (!body.refresh_token) return fail("Google did not grant offline access, so the connection could not be kept. Try connecting again.", "no_refresh_token");
      const granted = (body.scope ?? "").split(/\s+/).filter(Boolean);
      credential = { type: "google", refreshToken: body.refresh_token, accessToken: body.access_token, accessExpiresAtMs: nowMs + (body.expires_in ?? 3600) * 1000, grantedScopes: granted };
      capabilities = googleCapabilities(capabilities.filter((c) => c.enabled).map((c) => c.key), granted);
      const missing = capabilities.find((c) => c.enabled && !c.available);
      if (missing) issue = { at: now, capability: missing.key, message: `Google did not grant "${missing.label}"; that capability is unavailable until you reconnect and allow it.`, action: "reconnect" };
    } else {
      const stored = await readCredential(env, db, userId, profile.connection_id);
      if (!stored || stored.value.type !== "mcp_oauth" || !verifier) return fail("The authorization could not be matched to this connection. Try connecting again.", "missing_pending_credential");
      const fetchFn = guardedFetch();
      const info = await discoverOAuthServerInfo(profile.endpoint!, { fetchFn });
      if (info.authorizationServerUrl !== stored.value.authorizationServerUrl) return fail("The service's authorization server changed during sign-in. Try connecting again.", "issuer_changed");
      validateAuthorizationResponseIssuer({ iss: query.iss, expectedIssuer: profile.expected_issuer ?? undefined, issParameterSupported: Boolean(info.authorizationServerMetadata?.authorization_response_iss_parameter_supported) });
      const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
        ...(info.authorizationServerMetadata ? { metadata: info.authorizationServerMetadata } : {}),
        clientInformation: stored.value.clientInformation as never,
        authorizationCode: query.code,
        ...(query.iss ? { iss: query.iss } : {}),
        codeVerifier: verifier,
        redirectUri: row.redirect_uri,
        ...(stored.value.resource ? { resource: new URL(stored.value.resource) } : {}),
        fetchFn,
      });
      credential = { ...stored.value, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? null, accessExpiresAtMs: tokens.expires_in ? nowMs + tokens.expires_in * 1000 : null };
    }
  } catch (error) {
    return fail("The service did not complete the authorization. Try connecting again.", String((error as Error)?.message ?? error));
  }

  const audit = await auditStatement({ userId, kind: "connection.authorize", outcome: "ok", channel: "web", detail: { connectionId: profile.connection_id, kind: profile.kind }, nowMs });
  await db.batch(
    [
      await credentialUpsert(env, userId, profile.connection_id, profile.kind, "oauth", credential, now),
      profileUpdate(userId, profile.connection_id, { state: "connected", capabilities, issue, lastSuccessAt: now }, now),
      audit.statement,
    ].map((s) => prepare(db, s)),
  );
  // The assistant's registry is mirrored on the owner's next authenticated request (reconcileRegistry):
  // registering a connection there is an owner action, and this callback carries no owner session.
  return { ok: true, title: `${profile.name} is connected`, message: issue ? issue.message : "You can return to Garderobe.", returnTo: row.return_to };
}

/* ------------------------------------------------------------------ */
/* Capabilities, disconnect                                             */
/* ------------------------------------------------------------------ */

export async function setCapabilities(app: App, session: OwnerSession, connectionId: string, input: { enabled: string[]; expectedVersion?: number }): Promise<Connection> {
  const profile = await loadProfile(app.db, session.userId, connectionId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== profile.version) throw new ApiException("conflict", "this connection changed since it was read", { currentVersion: profile.version });
  if (profile.state === "disconnected") throw new ApiException("precondition_failed", "this connection is disconnected");
  const now = toInstant(app.now());
  const current = parseJson<Capability[]>(profile.capabilities_json, []);
  let capabilities: Capability[];
  let issue: Connection["issue"] = null;
  let state = profile.state;
  if (profile.kind === "google_workspace") {
    const unknown = input.enabled.filter((c) => !(GOOGLE_CAPABILITIES as readonly string[]).includes(c));
    if (unknown.length > 0) throw new ApiException("invalid_command", "unknown capability", { unknown, allowed: GOOGLE_CAPABILITIES });
    capabilities = current.map((c) => ({ ...c, enabled: input.enabled.includes(c.key) }));
    const missing = capabilities.find((c) => c.enabled && !c.available);
    if (missing && profile.state === "connected") {
      // Enabling something Google has not granted needs the owner back in Google's flow: one clear action.
      state = "needs_reconnect";
      issue = { at: now, capability: missing.key, message: `"${missing.label}" needs your permission in Google. Reconnect to allow it.`, action: "reconnect" };
    }
  } else {
    capabilities = input.enabled.map((key) => current.find((c) => c.key === key) ?? { key, label: key, effect: "read" as const, enabled: true, available: true }).map((c) => ({ ...c, enabled: true }));
    for (const c of current) if (!input.enabled.includes(c.key)) capabilities.push({ ...c, enabled: false });
  }
  const audit = await auditStatement({ userId: session.userId, kind: "connection.capabilities", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { connectionId, enabled: input.enabled }, nowMs: app.now() });
  await app.db.batch([profileUpdate(session.userId, connectionId, { capabilities, state, issue }, now), audit.statement].map((s) => prepare(app.db, s)));
  const updated = await loadProfile(app.db, session.userId, connectionId);
  if (updated.kind !== "google_workspace") {
    await assistantCommand(app, session.principal, "connection.set_tool_groups", { connectionId, enabledGroups: input.enabled.map((k) => k.replace(/^tools:/, "")) }, `connection:${connectionId}:groups:${updated.version}`).catch((error) => {
      console.warn("tool group mirror failed", redactText(String((error as Error)?.message ?? error)));
    });
  }
  await reconcileRegistry(app, session.principal);
  return toConnection(updated);
}

/**
 * Disconnect: stop future calls (profile and assistant registry are marked first), remove the stored
 * credential, then try to revoke at the provider and report honestly what happened there.
 */
export async function disconnectConnection(app: App, session: OwnerSession, connectionId: string) {
  const { db, env } = app;
  const userId = session.userId;
  const profile = await loadProfile(db, userId, connectionId);
  const nowMs = app.now();
  const now = toInstant(nowMs);
  const credential = await readCredential(env, db, userId, connectionId).catch(() => null);
  const audit = await auditStatement({ userId, kind: "connection.disconnect", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { connectionId, kind: profile.kind }, nowMs });
  await db.batch(
    [
      profileUpdate(userId, connectionId, { state: "disconnected", issue: null }, now),
      stmt("UPDATE connection_credentials SET ciphertext = NULL, iv = NULL, removed_at = ?, version = version + 1 WHERE user_id = ? AND connection_id = ?", now, userId, connectionId),
      stmt("UPDATE connection_oauth_states SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND connection_id = ?", now, userId, connectionId),
      audit.statement,
    ].map((s) => prepare(db, s)),
  );
  await reconcileRegistry(app, session.principal);

  let remoteRevocation: "revoked" | "unsupported" | "failed" | "not_applicable" = "not_applicable";
  if (credential?.value.type === "google") {
    try {
      const response = await fetch(googleRevokeUrl(env), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: credential.value.refreshToken }) });
      remoteRevocation = response.ok ? "revoked" : "failed";
    } catch {
      remoteRevocation = "failed";
    }
  } else if (credential?.value.type === "mcp_oauth") {
    remoteRevocation = await revokeMcpToken(profile.endpoint!, credential.value).catch(() => "failed" as const);
  }
  return { connection: toConnection(await loadProfile(db, userId, connectionId)), futureCallsStopped: true as const, credentialsRemoved: true, remoteRevocation, receiptId: audit.auditId };
}

async function revokeMcpToken(endpoint: string, credential: McpOAuthCredential): Promise<"revoked" | "unsupported" | "failed"> {
  const token = credential.refreshToken ?? credential.accessToken;
  if (!token) return "unsupported";
  const fetchFn = guardedFetch();
  const info = await discoverOAuthServerInfo(endpoint, { fetchFn });
  const revocation = (info.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint;
  if (!revocation) return "unsupported";
  const clientId = String((credential.clientInformation as { client_id?: string }).client_id ?? "");
  const response = await fetchFn(revocation, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token, client_id: clientId }) });
  return response.ok ? "revoked" : "failed";
}

/* ------------------------------------------------------------------ */
/* Calendars of the Google connection (first use: choose the outfit calendar) */
/* ------------------------------------------------------------------ */

const googleApiBase = (env: Env) => (env.GOOGLE_API_BASE_URL ?? "https://www.googleapis.com").replace(/\/+$/, "");

interface DailyCalendarSettings {
  outfitCalendarId: string | null;
  readCalendarIds: string[];
}

async function dailyCalendarSettings(db: Db, principal: Principal): Promise<DailyCalendarSettings> {
  const { settings } = await getSettings(db, principal);
  const calendar = ((settings.extensions.daily as { calendar?: Partial<DailyCalendarSettings> } | undefined)?.calendar ?? {}) as Partial<DailyCalendarSettings>;
  return { outfitCalendarId: calendar.outfitCalendarId ?? null, readCalendarIds: calendar.readCalendarIds ?? ["primary"] };
}

async function googleProfile(db: Db, userId: string, connectionId: string): Promise<ProfileRow> {
  const profile = await loadProfile(db, userId, connectionId);
  if (profile.kind !== "google_workspace") throw new ApiException("invalid_command", "calendars belong to the Google connection");
  if (profile.state !== "connected") throw new ApiException("precondition_failed", "Google needs to be connected again before its calendars can be read", { state: profile.state });
  return profile;
}

export async function listCalendars(app: App, session: OwnerSession, connectionId: string) {
  await googleProfile(app.db, session.userId, connectionId);
  const token = await googleAccessToken(app.env, app.db, session.userId, "calendar.read", app.now());
  if (!token) throw new ApiException("precondition_failed", "reading calendars is not enabled or not granted for the Google connection", { capability: "calendar.read" });
  const response = await fetch(`${googleApiBase(app.env)}/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=reader`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new ApiException("precondition_failed", "Google did not return the calendar list; try again or reconnect Google", { status: response.status });
  const body = (await response.json()) as { items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }[] };
  const chosen = await dailyCalendarSettings(app.db, session.principal);
  const calendars = (body.items ?? []).map((c) => ({
    calendarId: c.id,
    name: c.summaryOverride ?? c.summary ?? c.id,
    primary: c.primary === true,
    accessRole: c.accessRole ?? "reader",
    outfitCalendar: c.id === chosen.outfitCalendarId,
    readForContext: chosen.readCalendarIds.includes(c.id) || (c.primary === true && chosen.readCalendarIds.includes("primary")),
  }));
  return { calendars, outfitCalendarId: chosen.outfitCalendarId, readAt: toInstant(app.now()) };
}

/**
 * Create the dedicated outfit calendar once and record it in settings through the ordinary
 * `settings.update` command (same receipt as any other settings change). With the
 * `calendar.app.created` scope this calendar is the only one the backend is able to write.
 */
export async function ensureOutfitCalendar(app: App, session: OwnerSession, connectionId: string, input: { clientRequestId: string; name: string }) {
  await googleProfile(app.db, session.userId, connectionId);
  const chosen = await dailyCalendarSettings(app.db, session.principal);
  const token = await googleAccessToken(app.env, app.db, session.userId, "calendar.write_outfit_calendar", app.now());
  if (!token) throw new ApiException("precondition_failed", "writing the outfit calendar is not enabled or not granted for the Google connection", { capability: "calendar.write_outfit_calendar" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (chosen.outfitCalendarId) {
    const existing = await fetch(`${googleApiBase(app.env)}/calendar/v3/calendars/${encodeURIComponent(chosen.outfitCalendarId)}`, { headers });
    if (existing.ok) {
      const body = (await existing.json()) as { id: string; summary?: string };
      return { calendar: { calendarId: body.id, name: body.summary ?? input.name, primary: false, accessRole: "owner", outfitCalendar: true, readForContext: false }, created: false, receipt: null };
    }
    if (existing.status !== 404 && existing.status !== 410) throw new ApiException("precondition_failed", "Google did not confirm the outfit calendar; try again", { status: existing.status });
  }
  const { settings } = await getSettings(app.db, session.principal);
  const response = await fetch(`${googleApiBase(app.env)}/calendar/v3/calendars`, { method: "POST", headers, body: JSON.stringify({ summary: input.name, description: "Daily outfit board, managed by Garderobe.", timeZone: settings.timezone }) });
  if (!response.ok) throw new ApiException("precondition_failed", "Google did not create the outfit calendar; try again or reconnect Google", { status: response.status });
  const created = (await response.json()) as { id: string; summary?: string };
  const receipt = await app.service.execute(session.principal, {
    type: "settings.update",
    payload: { patch: { extensions: { daily: { calendar: { outfitCalendarId: created.id } } } } },
    idempotencyKey: `outfit-calendar:${input.clientRequestId}`,
    expectedVersions: {},
    authorization: "owner_tap",
    source: { channel: session.principal.channel, clientSubmissionId: input.clientRequestId },
  });
  return { calendar: { calendarId: created.id, name: created.summary ?? input.name, primary: false, accessRole: "owner", outfitCalendar: true, readForContext: false }, created: true, receipt };
}

/* ------------------------------------------------------------------ */
/* Credential use by the approved adapters                              */
/* ------------------------------------------------------------------ */

async function markNeedsReconnect(db: Db, userId: string, connectionId: string, capability: string | null, message: string, nowMs: number): Promise<void> {
  const now = toInstant(nowMs);
  // One reconnect state: repeated failures do not stack issues.
  await prepare(db, stmt("UPDATE connection_profiles SET state = 'needs_reconnect', issue_json = ?, last_checked_at = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND connection_id = ? AND state = 'connected'", JSON.stringify({ at: now, capability, message, action: "reconnect" }), now, now, userId, connectionId)).run();
}

/**
 * A Google access token for one capability of the owner's Workspace connection, for the approved
 * Google adapters only (calendar reader/writer, receipt reader). Returns null when the capability is
 * not enabled, not granted, or the connection needs the owner. Refresh is serialized per grant by a
 * version check: of two concurrent refreshes one stores its result and the other re-reads it.
 * The token is never returned to a client, a model, a log or another connection.
 */
export async function googleAccessToken(env: Env, db: Db, userId: string, capability: GoogleCapability, nowMs: number = Date.now()): Promise<string | null> {
  const profile = await first<ProfileRow>(db, `SELECT ${PROFILE_COLUMNS} FROM connection_profiles WHERE user_id = ? AND kind = 'google_workspace' AND state = 'connected'`, userId);
  if (!profile) return null;
  const cap = parseJson<Capability[]>(profile.capabilities_json, []).find((c) => c.key === capability);
  if (!cap || !cap.enabled || !cap.available) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await readCredential(env, db, userId, profile.connection_id);
    if (!stored || stored.value.type !== "google") return null;
    if (stored.value.accessExpiresAtMs - nowMs > 60_000) return stored.value.accessToken;
    const response = await fetch(googleTokenUrl(env), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.value.refreshToken, client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "", client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "" }),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
    if (!response.ok || !body.access_token) {
      if (body.error === "invalid_grant" || response.status === 400 || response.status === 401) {
        await markNeedsReconnect(db, userId, profile.connection_id, capability, "Google access was revoked or has expired. Reconnect Google to continue.", nowMs);
      }
      return null;
    }
    const next: GoogleCredential = { ...stored.value, accessToken: body.access_token, accessExpiresAtMs: nowMs + (body.expires_in ?? 3600) * 1000, refreshToken: body.refresh_token ?? stored.value.refreshToken };
    const secretRef = secretRefOf(profile.connection_id);
    const sealed = await seal(env.CREDENTIAL_KEY, next, aadOf(userId, secretRef));
    const now = toInstant(nowMs);
    const result = await prepare(
      db,
      stmt("UPDATE connection_credentials SET ciphertext = ?, iv = ?, key_version = ?, version = version + 1, rotated_at = ? WHERE user_id = ? AND secret_ref = ? AND version = ? AND removed_at IS NULL", sealed.ciphertext, sealed.iv, sealed.keyVersion, now, userId, secretRef, stored.version),
    ).run();
    if ((result.meta?.changes ?? 0) === 1) {
      await prepare(db, stmt("UPDATE connection_profiles SET last_success_at = ?, last_checked_at = ? WHERE user_id = ? AND connection_id = ?", now, now, userId, profile.connection_id)).run();
      return next.accessToken;
    }
    // Lost the race: another refresh stored a newer credential (or the connection was removed). Re-read.
  }
  return null;
}

/**
 * The authorization header value for an outbound call of one connection, resolved privately at
 * dispatch time (the stored endpoint stays credential-free). For the assistant's connection executor.
 * Returns null when the connection is not connected. Never forwards one connection's credential to another.
 */
export async function connectionAuthorization(env: Env, db: Db, userId: string, secretRef: string, nowMs: number = Date.now()): Promise<{ header: string; value: string } | null> {
  const row = await first<{ connection_id: string }>(db, "SELECT connection_id FROM connection_credentials WHERE user_id = ? AND secret_ref = ? AND removed_at IS NULL", userId, secretRef);
  if (!row) return null;
  const profile = await first<ProfileRow>(db, `SELECT ${PROFILE_COLUMNS} FROM connection_profiles WHERE user_id = ? AND connection_id = ? AND state = 'connected'`, userId, row.connection_id);
  if (!profile || profile.kind === "google_workspace") return null;
  const stored = await readCredential(env, db, userId, row.connection_id);
  if (!stored) return null;
  if (stored.value.type === "secret") return { header: "Authorization", value: `Bearer ${stored.value.secret}` };
  if (stored.value.type !== "mcp_oauth" || !stored.value.accessToken) return null;
  if (stored.value.accessExpiresAtMs === null || stored.value.accessExpiresAtMs - nowMs > 60_000) return { header: "Authorization", value: `Bearer ${stored.value.accessToken}` };
  if (!stored.value.refreshToken) {
    await markNeedsReconnect(db, userId, row.connection_id, null, `${profile.name} needs to be connected again.`, nowMs);
    return null;
  }
  try {
    const fetchFn = guardedFetch();
    const info = await discoverOAuthServerInfo(profile.endpoint!, { fetchFn });
    if (info.authorizationServerUrl !== stored.value.authorizationServerUrl) throw new Error("issuer_changed");
    const tokens = await refreshAuthorization(info.authorizationServerUrl, {
      ...(info.authorizationServerMetadata ? { metadata: info.authorizationServerMetadata } : {}),
      clientInformation: stored.value.clientInformation as never,
      refreshToken: stored.value.refreshToken,
      ...(stored.value.resource ? { resource: new URL(stored.value.resource) } : {}),
      fetchFn,
    });
    const next: McpOAuthCredential = { ...stored.value, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? stored.value.refreshToken, accessExpiresAtMs: tokens.expires_in ? nowMs + tokens.expires_in * 1000 : null };
    const sealed = await seal(env.CREDENTIAL_KEY, next, aadOf(userId, secretRef));
    const result = await prepare(
      db,
      stmt("UPDATE connection_credentials SET ciphertext = ?, iv = ?, key_version = ?, version = version + 1, rotated_at = ? WHERE user_id = ? AND secret_ref = ? AND version = ? AND removed_at IS NULL", sealed.ciphertext, sealed.iv, sealed.keyVersion, toInstant(nowMs), userId, secretRef, stored.version),
    ).run();
    if ((result.meta?.changes ?? 0) !== 1) return connectionAuthorization(env, db, userId, secretRef, nowMs + 1);
    return { header: "Authorization", value: `Bearer ${next.accessToken}` };
  } catch {
    await markNeedsReconnect(db, userId, row.connection_id, null, `${profile.name} needs to be connected again.`, nowMs);
    return null;
  }
}
