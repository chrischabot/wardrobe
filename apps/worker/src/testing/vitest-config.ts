/**
 * Node-side Vitest configuration for suites that drive the WHOLE Garderobe Worker (this package's
 * tests, and the journey, adversarial and simulation suites).
 *
 *   import { defineConfig } from "vitest/config";
 *   import { garderobeWorkerTestPlugin } from "@garderobe/worker/testing/vitest-config";
 *   export default defineConfig(async () => ({ plugins: [await garderobeWorkerTestPlugin()], test: { include: ["test/**\/*.test.ts"] } }));
 *
 * What is real: the Worker entry and router, workerd, local D1 with every migration, local KV (the
 * OAuth provider's store), local R2 (media and export buckets), a local queue, the conversation
 * Durable Object, the command service and every module.
 * What stands in for an external party (each labelled where it is used):
 *   - Cloudflare Access: assertions are signed with a key pair generated for the test run and verified
 *     by the Worker's ordinary verification code against that key (there is no Access edge locally);
 *   - the language model: the assistant workstream's labelled FAKE MODEL (`TestAssistant`);
 *   - Google's OAuth and Calendar endpoints: the labelled fixture `fixtureOutbound` below;
 *   - every other outbound request (weather, remote MCP servers): answered 503, i.e. an outage.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { garderobeWorkersPlugin } from "@garderobe/domain/testing/vitest-config";
import { exportJWK } from "jose";

const here = path.dirname(fileURLToPath(import.meta.url));

export const TEST_APP_ORIGIN = "http://localhost:8787";
/** A second loopback origin, so hostname separation between the app and MCP is exercised for real. */
export const TEST_MCP_ORIGIN = "http://127.0.0.1:8787";
export const TEST_ACCESS_ISSUER = "https://garderobe-test.cloudflareaccess.com";
export const TEST_ACCESS_AUD = "garderobe-test-audience";
export const TEST_QUEUE = "garderobe-media-test";

export interface WorkerTestPluginOptions {
  /** Worker entry; defaults to this package's test entry (the real Worker with the fake-model actor). */
  main?: string;
  bindings?: Record<string, unknown>;
  miniflare?: Record<string, unknown>;
}

const secret = (bytes: number): string => btoa(String.fromCharCode(...randomBytes(bytes)));

/** Host of the labelled stand-in for Google's OAuth and Calendar endpoints (see `fixtureOutbound`). */
export const GOOGLE_FIXTURE_ORIGIN = "https://google.fixture.test";

const calls: { method: string; url: string; body: string }[] = [];
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Every outbound request of the Worker under test ends here: tests never reach the network.
 *
 * `google.fixture.test` is a LABELLED STAND-IN for Google's token, revocation and Calendar endpoints,
 * with fixed, documented behaviour chosen by the request (it is not Google and proves nothing about
 * Google's real responses):
 *   - token, authorization_code: code `fixture-code` grants every requested capability; a code
 *     `scopes:<space separated scope URLs>` grants exactly those; code `no-refresh` omits the refresh
 *     token; anything else is `invalid_grant`.
 *   - token, refresh_token: `fixture-refresh-revoked` is `invalid_grant`; otherwise a new access token.
 *   - revoke: 200.
 *   - calendar list: a primary calendar and a second one; create: id `outfits-<name>`; get: 200 for an
 *     id starting with `outfits-`, else 404.
 *   - `GET /__calls` returns (and clears) the log of requests received, so a test can assert what was sent.
 *
 * `https://mcp.tavily.com/mcp` is a LABELLED STAND-IN for a remote MCP tool service (it is not Tavily and
 * proves nothing about Tavily's real tools or responses): it speaks JSON-RPC, requires a bearer key that
 * starts with `tvly-`, lists a search tool, an extract tool and a provider-side research agent, answers
 * `fixture_search` with one result whose URL carries a key (to prove redaction), and logs every request
 * (method, tool, arguments, protocol header, whether the key was present) to the same `/__calls` log.
 * Every other host answers 503 `outbound network is disabled in tests`: weather and other remote MCP
 * servers are therefore reported by the application as unavailable, which is the real behaviour for an outage.
 */
export const MCP_FIXTURE_URL = "https://mcp.tavily.com/mcp";
const MCP_FIXTURE_TOOLS = [
  { name: "fixture_search", description: "Search the web for pages.", inputSchema: { type: "object", properties: { query: { type: "string" }, include_answer: { type: "boolean" } }, required: ["query"] } },
  { name: "fixture_extract", description: "Extract the content of pages.", inputSchema: { type: "object", properties: { urls: { type: "array", items: { type: "string" } }, extract_depth: { type: "string" } }, required: ["urls"] } },
  { name: "fixture_research", description: "A deep research agent that writes a report.", inputSchema: { type: "object", properties: { input: { type: "string" } } } },
];

async function mcpFixture(request: Request): Promise<Response> {
  const text = await request.text();
  const body = JSON.parse(text) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const authorized = (request.headers.get("Authorization") ?? "").startsWith("Bearer tvly-");
  calls.push({ method: "MCP", url: request.url, body: JSON.stringify({ method: body.method, tool: body.params?.name ?? null, arguments: body.params?.arguments ?? null, protocol: request.headers.get("Mcp-Protocol-Version"), authorized }) });
  if (!authorized) return jsonResponse({ error: "unauthorized" }, 401);
  const reply = (result: unknown) => jsonResponse({ jsonrpc: "2.0", id: body.id, result });
  if (body.method === "tools/list") return reply({ tools: MCP_FIXTURE_TOOLS });
  if (body.method === "tools/call" && body.params?.name === "fixture_search") {
    return reply({ content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://shop.example.com/crewneck?api_key=LEAKEDKEY123456", title: "Shetland crewneck", content: `Fixture result for ${String(body.params.arguments?.query)}` }] }) }] });
  }
  return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not part of the fixture" } });
}

export async function fixtureOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin + url.pathname === MCP_FIXTURE_URL && request.method === "POST") return mcpFixture(request);
  if (url.origin !== GOOGLE_FIXTURE_ORIGIN) return jsonResponse({ error: "outbound network is disabled in tests", host: url.host }, 503);
  if (url.pathname === "/__calls") return jsonResponse(calls.splice(0, calls.length));
  const body = request.method === "GET" ? "" : await request.text();
  calls.push({ method: request.method, url: url.toString(), body });
  const form = new URLSearchParams(body);
  if (url.pathname === "/token") {
    if (form.get("grant_type") === "refresh_token") {
      if (form.get("refresh_token") === "fixture-refresh-revoked") return jsonResponse({ error: "invalid_grant" }, 400);
      return jsonResponse({ access_token: `fixture-access-${calls.length}`, expires_in: 3600, token_type: "Bearer" });
    }
    const code = form.get("code") ?? "";
    if (!form.get("code_verifier") || form.get("client_secret") !== "test-google-client-secret") return jsonResponse({ error: "invalid_request" }, 400);
    const all = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets.readonly";
    if (code === "fixture-code") return jsonResponse({ access_token: "fixture-access-initial", refresh_token: "fixture-refresh-1", expires_in: 3600, scope: all, token_type: "Bearer" });
    if (code === "expiring") return jsonResponse({ access_token: "fixture-access-short", refresh_token: "fixture-refresh-1", expires_in: 1, scope: all, token_type: "Bearer" });
    if (code === "expiring-revoked") return jsonResponse({ access_token: "fixture-access-short", refresh_token: "fixture-refresh-revoked", expires_in: 1, scope: all, token_type: "Bearer" });
    if (code.startsWith("scopes:")) return jsonResponse({ access_token: "fixture-access-partial", refresh_token: "fixture-refresh-2", expires_in: 3600, scope: code.slice(7), token_type: "Bearer" });
    if (code === "no-refresh") return jsonResponse({ access_token: "fixture-access-norefresh", expires_in: 3600, scope: all, token_type: "Bearer" });
    return jsonResponse({ error: "invalid_grant" }, 400);
  }
  if (url.pathname === "/revoke") return jsonResponse({});
  if (!(request.headers.get("Authorization") ?? "").startsWith("Bearer fixture-access")) return jsonResponse({ error: { code: 401, message: "unauthenticated" } }, 401);
  if (url.pathname === "/calendar/v3/users/me/calendarList") {
    return jsonResponse({ items: [{ id: "primary-calendar@example.test", summary: "Personal", primary: true, accessRole: "owner" }, { id: "team@example.test", summary: "Team", accessRole: "reader" }] });
  }
  if (url.pathname === "/calendar/v3/calendars" && request.method === "POST") {
    const summary = String((JSON.parse(body) as { summary?: string }).summary ?? "Outfits");
    return jsonResponse({ id: `outfits-${summary.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@group.calendar.example.test`, summary });
  }
  const calendar = /^\/calendar\/v3\/calendars\/([^/]+)$/.exec(url.pathname);
  if (calendar && request.method === "GET") {
    const id = decodeURIComponent(calendar[1]!);
    return id.startsWith("outfits-") ? jsonResponse({ id, summary: "Outfits" }) : jsonResponse({ error: { code: 404 } }, 404);
  }
  if (/^\/calendar\/v3\/calendars\/[^/]+\/events/.test(url.pathname)) return jsonResponse({ items: [] });
  return jsonResponse({ error: { code: 404, message: "not part of the fixture" } }, 404);
}

export async function garderobeWorkerTestPlugin(options: WorkerTestPluginOptions = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-access-key";
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: "RS256" };
  // A second key pair that the Worker does NOT trust, for forged-assertion tests.
  const untrusted = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const untrustedJwk = { ...(await exportJWK(untrusted.privateKey)), kid, alg: "RS256" };
  return garderobeWorkersPlugin({
    main: options.main ?? path.join(here, "worker-entry.ts"),
    miniflare: {
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      kvNamespaces: ["OAUTH_KV"],
      r2Buckets: ["MEDIA_BUCKET", "EXPORT_BUCKET"],
      queueProducers: { MEDIA_QUEUE: { queueName: TEST_QUEUE } },
      queueConsumers: { [TEST_QUEUE]: { maxBatchSize: 5, maxBatchTimeout: 0.05, maxRetries: 3, retryDelay: 0 } },
      durableObjects: { ASSISTANT: { className: "GarderobeAssistant", useSQLite: true } },
      outboundService: fixtureOutbound,
      ...(options.miniflare ?? {}),
    },
    bindings: {
      ENVIRONMENT: "test",
      APP_ORIGIN: TEST_APP_ORIGIN,
      MCP_ORIGIN: TEST_MCP_ORIGIN,
      ACCESS_TEAM_DOMAIN: TEST_ACCESS_ISSUER,
      ACCESS_AUD: TEST_ACCESS_AUD,
      ACCESS_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
      TEST_ACCESS_PRIVATE_JWK: JSON.stringify(privateJwk),
      TEST_UNTRUSTED_PRIVATE_JWK: JSON.stringify(untrustedJwk),
      // Random per run; test-only values, never deployment secrets.
      CREDENTIAL_KEY: secret(32),
      STATE_SIGNING_KEY: secret(48),
      MEDIA_SIGNING_KEY: secret(48),
      AI_GATEWAY_ID: "garderobe-test-fake",
      GOOGLE_OAUTH_CLIENT_ID: "test-google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-google-client-secret",
      GOOGLE_OAUTH_AUTHORIZE_URL: `${GOOGLE_FIXTURE_ORIGIN}/authorize`,
      GOOGLE_OAUTH_TOKEN_URL: `${GOOGLE_FIXTURE_ORIGIN}/token`,
      GOOGLE_OAUTH_REVOKE_URL: `${GOOGLE_FIXTURE_ORIGIN}/revoke`,
      GOOGLE_API_BASE_URL: GOOGLE_FIXTURE_ORIGIN,
      APP_RETURN_URL: "https://app.garderobe.test/connections",
      ...(options.bindings ?? {}),
    },
  });
}
