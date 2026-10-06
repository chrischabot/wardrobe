/**
 * HTTP helpers shared by the deploy, verify and rehearsal commands (and importable by other test
 * threads that need to drive the development deployment):
 *
 *   import { targetFor, clientFor } from "<repo>/deploy/lib/http.mjs";
 *   const c = clientFor(targetFor("deployed"), readState());
 *   const me = await c.api("GET", "/v1/me", undefined, { as: "owner" });
 *   const mcp = await c.connectMcp({ write: true, as: "synthetic", clientName: "Journeys" });
 *
 * Sign-in here is the automation door's: an assertion signed with the key in the local deployment state
 * (see lib/state.mjs), for one of three labelled test identities. It is the application's ordinary
 * assertion check, with this tooling's issuer instead of the account's Access team. No Cloudflare
 * management credential is involved in any request made here.
 */
import { SignJWT, generateKeyPair, importJWK } from "jose";
import { HOSTS, NAMES } from "./config.mjs";

export function targetFor(kind) {
  if (kind === "rehearsal") {
    const port = process.env.GARDEROBE_REHEARSAL_PORT ?? "8791";
    // One local session: the operations Worker answers on the port and hands product routes to the product Worker.
    return { kind, appOrigin: `http://localhost:${port}`, mcpOrigin: `http://127.0.0.1:${port}`, opsOrigin: `http://localhost:${port}`, issuer: `http://localhost:${port}`, audience: NAMES.autoAudience, personOrigin: null };
  }
  if (kind !== "deployed") throw new Error(`unknown target '${kind}'`);
  return { kind, appOrigin: `https://${HOSTS.autoApp}`, mcpOrigin: `https://${HOSTS.autoMcp}`, opsOrigin: `https://${HOSTS.ops}`, issuer: `https://${HOSTS.ops}`, audience: NAMES.autoAudience, personOrigin: `https://${HOSTS.app}`, personMcpOrigin: `https://${HOSTS.mcp}` };
}

async function parse(response) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: response.status, ok: response.ok, json, text, headers: response.headers };
}

export function clientFor(target, state) {
  if (!state?.issuer?.privateJwk) throw new Error("no local deployment state; run the deploy (or rehearsal) command first");

  /** An assertion for a labelled identity. `tamper` produces the invalid variants the verification run needs. */
  async function assertion(who = "owner", tamper = null) {
    const identity = state.identities[who];
    if (!identity) throw new Error(`unknown identity '${who}'`);
    const now = Math.floor(Date.now() / 1000);
    let key = await importJWK(state.issuer.privateJwk, "RS256");
    if (tamper === "other_key") key = (await generateKeyPair("RS256")).privateKey;
    return new SignJWT({ email: identity.email, type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: state.issuer.privateJwk.kid })
      .setIssuer(tamper === "other_issuer" ? "https://other-team.cloudflareaccess.com" : target.issuer)
      .setAudience(tamper === "other_audience" ? "some-other-application" : target.audience)
      .setSubject(identity.subject)
      .setIssuedAt(tamper === "expired" ? now - 7200 : now)
      .setExpirationTime(tamper === "expired" ? now - 3600 : now + 3600)
      .sign(key);
  }

  async function api(method, route, body, { as = "owner", origin = target.appOrigin, headers = {}, tamper = null } = {}) {
    const h = { ...(as ? { "Cf-Access-Jwt-Assertion": await assertion(as, tamper) } : {}), ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    return parse(await fetch(`${origin}${route}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }));
  }

  async function ops(path, body = {}) {
    const started = Date.now();
    const r = await parse(await fetch(`${target.opsOrigin}${path}`, { method: "POST", headers: { Authorization: `Bearer ${state.opsToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    return { ...r, roundTripMs: Date.now() - started };
  }

  /** Claim the seeded account for a labelled identity when it is not linked yet. Returns how it ended. */
  async function ensureClaimed(who, invitationCode) {
    const me = await api("GET", "/v1/me", undefined, { as: who });
    if (me.ok) return { claimed: false, userId: me.json.userId ?? me.json.user?.userId ?? null };
    if (me.status !== 403 || me.json?.error?.code !== "identity_not_linked") throw new Error(`/v1/me answered ${me.status} ${me.text.slice(0, 200)}`);
    if (!invitationCode) throw new Error(`identity '${who}' is not linked and there is no invitation code in the local state`);
    const claim = await api("POST", "/auth/claim", { invitationCode }, { as: who });
    if (!claim.ok) throw new Error(`claim failed: ${claim.status} ${claim.text.slice(0, 200)}`);
    return { claimed: true, userId: claim.json.userId ?? null, recoveryKitIssued: Boolean(claim.json.issuedRecoveryKit) };
  }

  /**
   * A real MCP client through the whole consumer flow: 401, discovery, dynamic registration, authorization
   * code with PKCE, the signed-in owner's consent, token, tool calls. (Same steps as the Worker's own
   * scripts/lib/mcp-client.mjs, with the origins and the identity as parameters.)
   */
  async function connectMcp({ write = false, as = "owner", clientName = "Deployment verification", redirectUri = "https://mcp-client.garderobe-rebuild-dev.invalid/oauth/callback", onElicit = null } = {}) {
    const { Client, StreamableHTTPClientTransport, UnauthorizedError } = await import("@modelcontextprotocol/client");
    const { CfWorkerJsonSchemaValidator } = await import("@modelcontextprotocol/client/validators/cf-worker");
    const store = {};
    const oauth = {
      authorizationUrl: null,
      get redirectUrl() {
        return redirectUri;
      },
      get clientMetadata() {
        return { client_name: clientName, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: write ? "wardrobe.read wardrobe.write" : "wardrobe.read" };
      },
      clientInformation: () => store.client,
      saveClientInformation: (info) => void (store.client = info),
      tokens: () => store.tokens,
      saveTokens: (tokens) => void (store.tokens = tokens),
      redirectToAuthorization(url) {
        this.authorizationUrl = url;
      },
      saveCodeVerifier: (v) => void (store.verifier = v),
      codeVerifier: () => store.verifier,
      saveDiscoveryState: (s) => void (store.discovery = s),
      discoveryState: () => store.discovery,
      invalidateCredentials(scope) {
        if (scope === "all" || scope === "tokens") store.tokens = undefined;
        if (scope === "all" || scope === "client") store.client = undefined;
      },
    };
    const url = new URL(`${target.mcpOrigin}/mcp`);
    const newClient = () => {
      const client = new Client({ name: "garderobe-deploy-verify", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
      client.setRequestHandler("elicitation/create", async (request) => (onElicit ? onElicit(request.params ?? {}) : { action: "decline" }));
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
    // The owner's part: the consent page, signed in at the app hostname.
    const token = await assertion(as);
    const page = await fetch(String(oauth.authorizationUrl), { headers: { "Cf-Access-Jwt-Assertion": token }, redirect: "manual" });
    const html = await page.text();
    if (page.status !== 200) throw new Error(`consent page: ${page.status} ${html.slice(0, 200)}`);
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]?.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
    if (!handle) throw new Error("the consent page has no transaction handle");
    const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const form = new URLSearchParams({ handle, decision: "approve" });
    if (write) form.append("scope", "wardrobe.write");
    const decided = await fetch(`${target.appOrigin}/oauth/authorize`, { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies }, body: form.toString(), redirect: "manual" });
    const location = decided.headers.get("Location");
    if (decided.status !== 302 || !location) throw new Error(`consent decision: ${decided.status} ${(await decided.text()).slice(0, 200)}`);
    await first.finishAuth(new URL(location).searchParams);
    await probe.close().catch(() => undefined);
    const client = newClient();
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: oauth }));
    return { client, accessToken: () => store.tokens?.access_token, authorizationServer: new URL(String(oauth.authorizationUrl)).origin, close: () => client.close().catch(() => undefined) };
  }

  return { target, assertion, api, ops, ensureClaimed, connectMcp };
}

/** Call an MCP tool; returns `{ ok, data, error }` with the structured result or the typed error body. */
export async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).find((c) => c.type === "text")?.text ?? "";
  if (!result.isError) return { ok: true, data: result.structuredContent, error: null };
  try {
    return { ok: false, data: null, error: JSON.parse(text).error };
  } catch {
    return { ok: false, data: null, error: { code: "internal", message: text, details: {} } };
  }
}

/** Raw JSON-RPC call to an MCP endpoint with a bearer token (for refusal checks the SDK client would hide). */
export async function rawMcp(origin, token, method, params = {}) {
  const response = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: response.status, challenge: response.headers.get("WWW-Authenticate") ?? "", text: (await response.text()).slice(0, 500) };
}
