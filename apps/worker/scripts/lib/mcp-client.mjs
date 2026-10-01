/**
 * A real MCP client for a locally running Garderobe Worker, for the smoke script and for the simulation
 * and test threads to import:
 *
 *   import { connectLocalMcp, callTool } from "<repo>/apps/worker/scripts/lib/mcp-client.mjs";
 *   const mcp = await connectLocalMcp({ write: true, clientName: "Simulation" });
 *   const today = await callTool(mcp.client, "garderobe_today", {});
 *
 * It is the TypeScript SDK's `Client` over streamable HTTP, pinned to protocol 2026-07-28, and it goes
 * through the same steps a consumer assistant does: 401 -> protected-resource and authorization-server
 * discovery -> dynamic client registration -> authorization code with PKCE -> the owner's consent ->
 * token -> tool calls with its own Garderobe token. The only local stand-in is the owner's sign-in on
 * the consent page (a locally signed assertion instead of Cloudflare Access; see lib/local.mjs).
 */
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { LOCAL, localAssertion } from "./local.mjs";

class MemoryOAuthClient {
  constructor(meta) {
    this.meta = meta;
    this.authorizationUrl = null;
  }
  get redirectUrl() {
    return this.meta.redirectUri;
  }
  get clientMetadata() {
    return { client_name: this.meta.clientName, redirect_uris: [this.meta.redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: this.meta.scope };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info) {
    this.client = info;
  }
  tokens() {
    return this.stored;
  }
  saveTokens(tokens) {
    this.stored = tokens;
  }
  redirectToAuthorization(url) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
  invalidateCredentials(scope) {
    if (scope === "all" || scope === "tokens") this.stored = undefined;
    if (scope === "all" || scope === "client") this.client = undefined;
  }
}

/** The owner's part: open the consent page signed in, then Allow (optionally with the write permission) or Deny. */
export async function approveConsent(authorizationUrl, { allow = true, write = false, identity } = {}) {
  const assertion = await localAssertion(identity);
  const page = await fetch(String(authorizationUrl), { headers: { "Cf-Access-Jwt-Assertion": assertion }, redirect: "manual" });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`consent page: ${page.status} ${html.slice(0, 300)}`);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]?.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
  if (!handle) throw new Error("the consent page has no transaction handle");
  const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const form = new URLSearchParams({ handle, decision: allow ? "approve" : "deny" });
  if (allow && write) form.append("scope", "wardrobe.write");
  const decided = await fetch(`${LOCAL.appOrigin}/oauth/authorize`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies }, body: form.toString(), redirect: "manual" });
  const location = decided.headers.get("Location");
  if (decided.status !== 302 || !location) throw new Error(`consent decision: ${decided.status} ${(await decided.text()).slice(0, 300)}`);
  return new URL(location);
}

/**
 * Connect and authorize. Options: `write` (grant the write permission), `clientName`, `redirectUri`,
 * `onElicit(params)` to answer a confirmation request ({ action: "accept", content: { confirm: true } }).
 */
export async function connectLocalMcp(options = {}) {
  const oauth = new MemoryOAuthClient({
    clientName: options.clientName ?? "Garderobe local MCP client",
    redirectUri: options.redirectUri ?? "https://mcp-client.garderobe.local/oauth/callback",
    scope: options.write ? "wardrobe.read wardrobe.write" : "wardrobe.read",
  });
  const url = new URL(`${LOCAL.mcpOrigin}/mcp`);
  const newClient = () => {
    const client = new Client({ name: "garderobe-local-client", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
    client.setRequestHandler("elicitation/create", async (request) => (options.onElicit ? options.onElicit(request.params ?? {}) : { action: "decline" }));
    return client;
  };
  const first = new StreamableHTTPClientTransport(url, { authProvider: oauth });
  const probe = newClient();
  try {
    await probe.connect(first);
    await probe.listTools();
    throw new Error("the MCP endpoint answered without authorization");
  } catch (error) {
    if (!(error instanceof UnauthorizedError) && !oauth.authorizationUrl) throw error;
  }
  if (!oauth.authorizationUrl) throw new Error("the client was not sent to the authorization endpoint");
  const back = await approveConsent(oauth.authorizationUrl, { allow: true, write: options.write ?? false });
  await first.finishAuth(back.searchParams);
  await probe.close().catch(() => undefined);
  const client = newClient();
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: oauth }));
  return { client, oauth, close: () => client.close().catch(() => undefined) };
}

/** Call a tool; returns `{ ok, data, error, text }` with the structured result or the typed error body. */
export async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).find((c) => c.type === "text")?.text ?? "";
  if (result.isError) {
    let error;
    try {
      error = JSON.parse(text).error;
    } catch {
      error = { code: "internal", message: text, details: {} };
    }
    return { ok: false, data: null, error, text };
  }
  return { ok: true, data: result.structuredContent, error: null, text };
}
