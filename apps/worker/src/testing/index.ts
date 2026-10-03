/**
 * Helpers for suites that drive the whole Worker inside workerd (`@garderobe/worker/testing`).
 * Use with `garderobeWorkerTestPlugin()` from `@garderobe/worker/testing/vitest-config`.
 *
 * Requests go through `SELF.fetch`, i.e. the Worker's real `fetch` handler: OAuth provider, router,
 * authentication, command service, D1, KV, R2 and the conversation actor. The stand-ins are listed in
 * the config helper (test-signed Access assertions, the labelled fake model, mocked Google endpoints).
 */
import "./clock.ts"; // first: installs the shifted clock when a whole-suite run asks for one
import { SELF, env as testEnvBindings } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/client";
import type { MeResponse, RecoveryKit } from "@garderobe/contracts/ext/api";
import { addDays, createPrincipal, createUser, getOwnerState, localDateOf, type Principal } from "@garderobe/domain";
import { importOwnerData, type OwnerImportResult } from "@garderobe/domain/import";
import { ownerDocuments, testDatabase } from "@garderobe/domain/testing";
import { SignJWT, importJWK } from "jose";
import type { z } from "zod";
import { appFor, type App } from "../app.ts";
import type { Env } from "../env.ts";
import { createInvitation } from "../identity/service.ts";

export const APP_ORIGIN = "http://localhost:8787";
export const MCP_ORIGIN = "http://127.0.0.1:8787";
export const MCP_URL = `${MCP_ORIGIN}/mcp`;

interface TestBindings extends Env {
  TEST_ACCESS_PRIVATE_JWK: string;
  TEST_UNTRUSTED_PRIVATE_JWK: string;
}

export const bindings = (): TestBindings => testEnvBindings as unknown as TestBindings;

/** The composed application of the Worker under test (same registry and command service the routes use). */
export async function testApp(): Promise<App> {
  await testDatabase();
  return appFor(bindings());
}

/* ------------------------------------------------------------------ */
/* Sign-in                                                              */
/* ------------------------------------------------------------------ */

export interface TestIdentity {
  subject: string;
  email: string | null;
}

let identityCounter = 0;
export function newIdentity(label = "owner"): TestIdentity {
  identityCounter++;
  const id = `${label}-${Date.now().toString(36)}-${identityCounter}-${Math.random().toString(36).slice(2, 8)}`;
  return { subject: `access-sub-${id}`, email: `${id}@example.test` };
}

export interface AssertionOptions {
  /** Seconds in the past the session was authenticated (default 0). */
  issuedAgoSeconds?: number;
  expiresInSeconds?: number;
  audience?: string;
  issuer?: string;
  /** Sign with a key the Worker does not trust (a forged assertion). */
  untrusted?: boolean;
  omitSubject?: boolean;
}

/**
 * A Cloudflare Access style assertion for a test identity, signed with the test run's key. The Worker
 * verifies it with its ordinary code path (signature, issuer, audience, expiry) against that key.
 */
export async function accessAssertion(identity: TestIdentity, options: AssertionOptions = {}): Promise<string> {
  const b = bindings();
  const jwk = JSON.parse(options.untrusted ? b.TEST_UNTRUSTED_PRIVATE_JWK : b.TEST_ACCESS_PRIVATE_JWK);
  const key = await importJWK(jwk, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const iat = now - (options.issuedAgoSeconds ?? 0);
  const jwt = new SignJWT({ ...(identity.email ? { email: identity.email } : {}), type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(options.issuer ?? b.ACCESS_TEAM_DOMAIN)
    .setAudience(options.audience ?? b.ACCESS_AUD)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (options.expiresInSeconds ?? 3600));
  if (!options.omitSubject) jwt.setSubject(identity.subject);
  return jwt.sign(key);
}

export interface ApiOptions extends AssertionOptions {
  /** `web`: a browser session (cookie + Origin). Default: the native app (assertion header only). */
  client?: "ios" | "web";
  origin?: string;
}

/** A signed-in client of the HTTP API for one identity. */
export class ApiClient {
  constructor(
    readonly identity: TestIdentity,
    readonly options: ApiOptions = {},
  ) {}

  with(options: ApiOptions): ApiClient {
    return new ApiClient(this.identity, { ...this.options, ...options });
  }

  async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await accessAssertion(this.identity, this.options);
    const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": token, ...extra };
    if (this.options.client === "web") {
      headers.Cookie = [`CF_Authorization=${token}`, extra.Cookie].filter(Boolean).join("; ");
      headers.Origin = extra.Origin ?? APP_ORIGIN;
    }
    return headers;
  }

  async request(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}): Promise<Response> {
    const headers = await this.headers(init.headers ?? {});
    let body: BodyInit | undefined = init.raw;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["Content-Type"] ??= "application/json";
    }
    return SELF.fetch(`${this.options.origin ?? APP_ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual" });
  }

  get(path: string, headers?: Record<string, string>): Promise<Response> {
    return this.request("GET", path, headers ? { headers } : {});
  }
  post(path: string, body: unknown = {}, headers?: Record<string, string>): Promise<Response> {
    return this.request("POST", path, { body, ...(headers ? { headers } : {}) });
  }

  /** Parse a 2xx JSON response or throw with the status and error body (keeps test failures readable). */
  async json<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body === undefined ? {} : { body });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 600)}`);
    return JSON.parse(text) as T;
  }

  /** Submit one command as this client (channel and authorization follow the client kind). */
  async command(type: string, payload: Record<string, unknown>, opts: { idempotencyKey?: string; expectedVersions?: Record<string, number>; occurredAt?: string } = {}): Promise<Response> {
    return this.post("/v1/commands", {
      type,
      payload,
      idempotencyKey: opts.idempotencyKey ?? `test-${crypto.randomUUID()}`,
      expectedVersions: opts.expectedVersions ?? {},
      ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}),
      authorization: "owner_tap",
      source: { channel: this.options.client === "web" ? "web" : "ios" },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Owners                                                               */
/* ------------------------------------------------------------------ */

export interface TestOwner {
  userId: string;
  identity: TestIdentity;
  api: ApiClient;
  /** The recovery kit issued when the account was claimed (shown to the owner once). */
  recoveryKit: z.infer<typeof RecoveryKit>;
  /** A principal for seeding through the command service directly (system authority for this owner). */
  systemPrincipal: Principal;
  /** Present for the real-owner fixture: the import result (every source row accounted for). */
  importResult: OwnerImportResult | null;
}

/**
 * Create an owner the way a deployment does: an internal user is provisioned, an invitation is issued,
 * and the identity claims it through the real `/auth/claim` route.
 *  - `real: true` imports the supplied profile and the real inventory CSV through the command service
 *    (the owner's actual data; use it for personalization checks).
 *  - otherwise the account is empty and marked synthetic; seed boundary cases yourself and label them.
 */
export async function provisionOwner(options: { displayName?: string; real?: boolean; identity?: TestIdentity } = {}): Promise<TestOwner> {
  const app = await testApp();
  const identity = options.identity ?? newIdentity(options.real ? "real-owner" : "synthetic-owner");
  const { userId } = await createUser(app.db, { displayName: options.displayName ?? (options.real ? "Chris (owner data fixture)" : "Synthetic owner (test fixture)"), isSynthetic: !options.real });
  let importResult: OwnerImportResult | null = null;
  if (options.real) {
    const docs = ownerDocuments();
    importResult = await importOwnerData(app.service, createPrincipal({ userId, actor: "system", channel: "import", scopes: ["read", "write", "admin"], authRef: "test:owner-import" }), docs);
  }
  const invitation = await createInvitation(app.db, app.env, { userId });
  const api = new ApiClient(identity);
  const response = await SELF.fetch(`${APP_ORIGIN}/auth/claim`, { method: "POST", headers: await api.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ invitationCode: invitation.invitationCode }) });
  if (!response.ok) throw new Error(`claim failed: ${response.status} ${await response.text()}`);
  const me = (await response.json()) as z.infer<typeof MeResponse>;
  return {
    userId,
    identity,
    api,
    recoveryKit: me.issuedRecoveryKit!,
    systemPrincipal: createPrincipal({ userId, actor: "system", channel: "system", scopes: ["read", "write"], authRef: "test:seed" }),
    importResult,
  };
}

/* ------------------------------------------------------------------ */
/* MCP client over HTTP with OAuth                                      */
/* ------------------------------------------------------------------ */

/** In-memory OAuth client state for the SDK's own authorization flow (discovery, registration, PKCE, token, refresh). */
export class TestOAuthClient implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private client: any;
  private stored: any;
  private verifier = "";
  private issuer: string | undefined;
  private discovery: unknown;

  saveDiscoveryState(state: unknown) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery as never;
  }

  constructor(
    private readonly meta: { clientName: string; redirectUri: string; scope: string },
  ) {}

  get redirectUrl(): string {
    return this.meta.redirectUri;
  }
  get clientMetadata() {
    return { client_name: this.meta.clientName, redirect_uris: [this.meta.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: this.meta.scope };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: any) {
    this.client = info;
  }
  tokens() {
    return this.stored;
  }
  saveTokens(tokens: any) {
    this.stored = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveAuthorizationServerUrl(url: string) {
    this.issuer = url;
  }
  authorizationServerUrl() {
    return this.issuer;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.stored = undefined;
    if (scope === "all" || scope === "client") this.client = undefined;
  }
  /** Current tokens and client registration, for tests that talk to the token endpoint directly. */
  snapshot(): { accessToken: string; refreshToken: string | null; clientId: string } {
    return { accessToken: this.stored?.access_token, refreshToken: this.stored?.refresh_token ?? null, clientId: this.client?.client_id };
  }
}

const selfFetch = ((input: RequestInfo | URL, init?: RequestInit) => SELF.fetch(input as never, init as never)) as typeof fetch;

/**
 * The owner's part of the authorization flow in a browser: open the consent page (signed in through
 * Access), then press Allow or Deny. Returns the redirect back to the client.
 */
export async function decideConsent(owner: { api: ApiClient }, authorizationUrl: URL | string, decision: { allow: boolean; write?: boolean }): Promise<{ status: number; location: string | null; page: string; pageStatus: number }> {
  const web = owner.api.with({ client: "web" });
  const url = new URL(String(authorizationUrl));
  const pageResponse = await SELF.fetch(url.toString(), { headers: await web.headers(), redirect: "manual" });
  const page = await pageResponse.text();
  if (pageResponse.status !== 200) return { status: pageResponse.status, location: pageResponse.headers.get("Location"), page, pageStatus: pageResponse.status };
  const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1];
  if (!handle) throw new Error(`consent page has no transaction handle: ${page.slice(0, 300)}`);
  const cookies = pageResponse.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
  const form = new URLSearchParams({ handle: handle.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code))), decision: decision.allow ? "approve" : "deny" });
  if (decision.allow && decision.write) form.append("scope", "wardrobe.write");
  const response = await SELF.fetch(`${APP_ORIGIN}/oauth/authorize`, {
    method: "POST",
    headers: await web.headers({ "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies }),
    body: form.toString(),
    redirect: "manual",
  });
  return { status: response.status, location: response.headers.get("Location"), page, pageStatus: 200 };
}

export interface McpConnection {
  client: Client;
  oauth: TestOAuthClient;
  /** Open a fresh transport with the stored credentials (the server keeps no session). */
  reconnect(): Promise<Client>;
  close(): Promise<void>;
}

/**
 * Connect a real MCP client (the TypeScript SDK's `Client` over streamable HTTP) the way a consumer
 * assistant does: the SDK discovers the authorization server from the 401, registers itself, starts
 * the authorization-code flow with PKCE; the owner approves on the consent page; the SDK exchanges
 * the code and calls the server with its own token.
 */
export async function connectMcp(
  owner: { api: ApiClient },
  options: {
    write?: boolean;
    requestWrite?: boolean;
    clientName?: string;
    redirectUri?: string;
    /** `modern`: pinned to 2026-07-28 (default). `legacy`: the 2025 handshake (the compatibility path). */
    era?: "modern" | "legacy";
    /** Answers `elicitation/create` requests (the owner's reply to a confirmation). Default: decline. */
    onElicit?: (params: { message?: string }) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
    /** Wraps the HTTP fetch of this client (to observe or tamper with the wire in tests). */
    wrapFetch?: (inner: typeof fetch) => typeof fetch;
  } = {},
): Promise<McpConnection> {
  const requestWrite = options.requestWrite ?? options.write ?? false;
  const oauth = new TestOAuthClient({
    clientName: options.clientName ?? "Test assistant",
    redirectUri: options.redirectUri ?? "https://assistant.client.test/oauth/callback",
    scope: requestWrite ? "wardrobe.read wardrobe.write" : "wardrobe.read",
  });
  const transportOptions = { authProvider: oauth, fetch: options.wrapFetch ? options.wrapFetch(selfFetch) : selfFetch };
  const newClient = (): Client => {
    const client = new Client(
      { name: "garderobe-test-client", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } }, ...(options.era === "legacy" ? {} : { versionNegotiation: { mode: { pin: "2026-07-28" } } }) } as never,
    );
    client.setRequestHandler("elicitation/create", async (request: any) => (options.onElicit ? options.onElicit(request.params ?? {}) : { action: "decline" }) as never);
    return client;
  };
  const open = async (): Promise<Client> => {
    const client = newClient();
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), transportOptions));
    return client;
  };
  const first = new StreamableHTTPClientTransport(new URL(MCP_URL), transportOptions);
  const probe = newClient();
  try {
    await probe.connect(first);
    await probe.listTools();
    throw new Error("the MCP endpoint answered without authorization");
  } catch (error) {
    if (!(error instanceof UnauthorizedError) && !oauth.authorizationUrl) throw error;
  }
  if (!oauth.authorizationUrl) throw new Error("the client was not sent to the authorization endpoint");
  const consent = await decideConsent(owner, oauth.authorizationUrl, { allow: true, write: options.write ?? false });
  if (consent.status !== 302 || !consent.location) throw new Error(`consent did not redirect: ${consent.status} ${consent.page.slice(0, 300)}`);
  await first.finishAuth(new URL(consent.location).searchParams);
  await probe.close().catch(() => undefined);
  let client = await open();
  return {
    get client() {
      return client;
    },
    oauth,
    reconnect: async () => {
      await client.close().catch(() => undefined);
      client = await open();
      return client;
    },
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

/** The structured result of a tool call, or the error body when the tool refused. */
export function toolResult<T = any>(result: { isError?: boolean; structuredContent?: unknown; content?: unknown }): { ok: boolean; data: T; error: { code: string; message: string; details: Record<string, unknown> } | null } {
  if (result.isError) {
    const text = (result.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text ?? "{}";
    let error: any;
    try {
      error = JSON.parse(text).error;
    } catch {
      error = { code: "internal", message: text, details: {} };
    }
    return { ok: false, data: undefined as T, error };
  }
  return { ok: true, data: result.structuredContent as T, error: null };
}

/* ------------------------------------------------------------------ */
/* Module fixtures                                                      */
/* ------------------------------------------------------------------ */

export { fakeModelFor, resetFakeModels, type FakeModel } from "@garderobe/assistant/testing";

/** The conversation profile the FAKE MODEL stands in for. */
export const FAKE_MODEL_PROFILE = "deepseek-v41-flash";

/**
 * Make the conversation route selectable for an owner in a test: records the capability probes the
 * model service requires, labelled as a fixture. No Gateway is contacted; the route is served by the
 * assistant workstream's FAKE MODEL. Returns that fake so the test can script its replies.
 */
export async function enableFakeModel(owner: TestOwner, profileId: string = FAKE_MODEL_PROFILE) {
  const { fakeModelFor } = await import("@garderobe/assistant/testing");
  const app = await testApp();
  const system = createPrincipal({ userId: owner.userId, actor: "system", channel: "system", scopes: ["read", "write", "admin"], authRef: "test:model-probe-fixture" });
  for (const operation of ["text", "tools", "structured_output", "vision"]) {
    await app.service.execute(system, {
      type: "inference.record_probe",
      payload: { profileId, operation, result: "passed", billing: "unified_billing", reason: "TEST FIXTURE: the route is served by the FAKE MODEL; no Gateway was probed", gatewayId: "garderobe-test-fake" },
      idempotencyKey: `probe-fixture:${owner.userId}:${profileId}:${operation}`,
      expectedVersions: {},
      authorization: "system_schedule",
      source: { channel: "system" },
    });
  }
  return fakeModelFor(profileId);
}

/**
 * A calendar day as the owner counts it: today in the owner's own timezone, plus `offset` days. Use this
 * wherever a test names "today", "tomorrow" or "yesterday" to the Worker. The UTC date is a different
 * day for part of every day for an owner who is not on UTC, and the Worker rightly refuses, for example,
 * to publish a board for a day that is already over for the owner.
 */
/** The calendar day at `nowMs` in `timezone`, plus `offset` days. */
export const localDay = (timezone: string, nowMs: number, offset = 0): string => addDays(localDateOf(nowMs, timezone), offset);

export async function ownerDay(owner: Pick<TestOwner, "systemPrincipal">, offset = 0): Promise<string> {
  const app = await testApp();
  const { settings } = await getOwnerState(app.db, owner.systemPrincipal);
  return localDay(settings.timezone, Date.now(), offset);
}

/**
 * Publish a board for a date through the real route (`POST /v1/recommendations`, mode `board`). The
 * daily service's deterministic composer builds it from the owner's wardrobe; in a test run the weather
 * request fails (no network) and no calendar is connected, so the board states those limitations.
 */
export async function publishBoard(owner: TestOwner, options: { date?: string; brief?: string; count?: number } = {}): Promise<any> {
  return owner.api.json("POST", "/v1/recommendations", { clientRequestId: `board-${crypto.randomUUID()}`, mode: "board", ...options });
}

/** A minimal valid PNG (a labelled test image, not a garment photograph). */
export function testPng(width = 96, height = 96): Uint8Array {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  // Uncompressed (stored) deflate blocks of the raw scanlines.
  const row = 1 + width * 3;
  const raw = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([40 + ((x * 3) % 180), 60 + ((y * 2) % 150), 120], y * row + 1 + x * 3);
  const blocks: number[] = [0x78, 0x01];
  for (let offset = 0; offset < raw.length; offset += 65535) {
    const part = raw.subarray(offset, Math.min(offset + 65535, raw.length));
    const final = offset + 65535 >= raw.length ? 1 : 0;
    blocks.push(final, part.length & 0xff, part.length >>> 8, ~part.length & 0xff, (~part.length >>> 8) & 0xff, ...part);
  }
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  blocks.push(b >>> 8, b & 0xff, a >>> 8, a & 0xff);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", new Uint8Array(blocks)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Upload a test image through the real routes: authorize, PUT the bytes, complete. */
export async function uploadImage(owner: TestOwner, input: { garmentId?: string; intent?: "garment_photo" | "selfie" | "attachment"; bytes?: Uint8Array; contentType?: string }): Promise<{ uploadId: string; complete: any }> {
  const bytes = input.bytes ?? testPng();
  const contentType = input.contentType ?? "image/png";
  const authorization = await owner.api.json("POST", "/v1/uploads", { clientUploadId: `upload-${crypto.randomUUID()}`, intent: input.intent ?? "garment_photo", contentType, byteLength: bytes.length, ...(input.garmentId ? { garmentId: input.garmentId } : {}) });
  const put = await SELF.fetch(`${APP_ORIGIN}${authorization.url}`, { method: "PUT", headers: { ...authorization.requiredHeaders, "Content-Length": String(bytes.length) }, body: bytes });
  if (!put.ok) throw new Error(`upload PUT failed: ${put.status} ${await put.text()}`);
  const complete = await owner.api.json("POST", `/v1/uploads/${authorization.uploadId}/complete`, {});
  return { uploadId: authorization.uploadId, complete };
}

/** Read a server-sent event stream to its end. */
export async function readSse(response: Response): Promise<{ id: string | null; event: string; data: any }[]> {
  const text = await response.text();
  const events: { id: string | null; event: string; data: any }[] = [];
  for (const block of text.split("\n\n")) {
    let id: string | null = null;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (data) events.push({ id, event, data: JSON.parse(data) });
  }
  return events;
}

export { selfFetch };
