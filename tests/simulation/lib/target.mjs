/**
 * One simulation target: a Garderobe Worker reachable at an app origin and an MCP origin.
 *
 * The simulator touches the target in exactly three ways, and this module is all of them:
 *
 *  1. as a CONNECTED ASSISTANT, through a real MCP client (the TypeScript SDK over streamable HTTP):
 *     401, discovery, dynamic client registration, authorization code with PKCE, the owner's consent,
 *     token, refresh, then tool calls with the client's own Garderobe token. Every wardrobe action and
 *     every read the invariants use goes this way (`McpSession`).
 *  2. as the SIGNED-IN OWNER on the app hostname, for the things a connected assistant cannot do by
 *     design: claiming the account, approving the consent page, confirming or rejecting a request that
 *     waits for the owner, connecting a calendar, asking for a packing proposal, and lifting a
 *     restriction (`Target.api`).
 *  3. through the target's TEST DOORS when it has them (the local simulation Worker): the clock, the
 *     scripted weather and calendar stand-ins and the scheduled trigger (`Target.door`). A target
 *     without doors runs on the real clock with its real adapters.
 *
 * The same code runs against a local Worker and a deployment; only the target description differs.
 */
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { SignJWT, importJWK } from "jose";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MemoryOAuthClient {
  constructor(meta) {
    this.meta = meta;
    this.authorizationUrl = null;
    this.tokenSaves = 0;
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
    this.tokenSaves++;
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

/** A connected assistant: one OAuth grant of one owner, with every call counted. */
export class McpSession {
  constructor(target, ownerKey, options) {
    this.target = target;
    this.ownerKey = ownerKey;
    this.options = options;
    this.oauth = new MemoryOAuthClient({ clientName: options.clientName, redirectUri: options.redirectUri, scope: options.write ? "wardrobe.read wardrobe.write" : "wardrobe.read" });
    this.url = new URL(`${target.description.mcpOrigin}/mcp`);
    this.client = null;
    this.authorizations = 0;
  }

  newClient() {
    // The interpreting JSON Schema validator is chosen explicitly: the SDK's default (Ajv) ends the Node
    // process with a bus error in the project sandbox. Tool results are still validated against each
    // tool's published output schema.
    const client = new Client({ name: "garderobe-simulation-client", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } }, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    // A connected assistant cannot confirm its own request: any confirmation question is declined.
    client.setRequestHandler("elicitation/create", async () => ({ action: "decline" }));
    return client;
  }

  /** The whole authorization: unauthenticated probe, discovery, registration, PKCE, the owner's consent, token. */
  async authorize() {
    this.oauth.authorizationUrl = null;
    const first = new StreamableHTTPClientTransport(this.url, { authProvider: this.oauth });
    const probe = this.newClient();
    try {
      await probe.connect(first);
      await probe.listTools();
      if (!this.oauth.tokens()) throw new Error("the MCP endpoint answered without authorization");
    } catch (error) {
      if (!(error instanceof UnauthorizedError) && !this.oauth.authorizationUrl) throw error;
    }
    if (this.oauth.authorizationUrl) {
      const back = await this.target.approveConsent(this.ownerKey, this.oauth.authorizationUrl, { write: this.options.write });
      await first.finishAuth(back.searchParams);
      this.authorizations++;
    }
    await probe.close().catch(() => undefined);
    if (this.client) await this.client.close().catch(() => undefined);
    this.client = this.newClient();
    await this.client.connect(new StreamableHTTPClientTransport(this.url, { authProvider: this.oauth }));
    return this;
  }

  /** Run one request; when the grant's tokens are no longer accepted and cannot be refreshed, authorize again once. */
  async withAuthorization(run) {
    try {
      return await run(this.client);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      await this.authorize();
      return run(this.client);
    }
  }

  /** Call a tool; returns `{ ok, data, error, text, ms }` with the structured result or the typed error body. */
  async callTool(name, args = {}) {
    const started = Date.now();
    const result = await this.withAuthorization((client) => client.callTool({ name, arguments: args }));
    const ms = Date.now() - started;
    const text = (result.content ?? []).find((c) => c.type === "text")?.text ?? "";
    let outcome;
    if (result.isError) {
      let error;
      try {
        error = JSON.parse(text).error;
      } catch {
        error = { code: "unparsed_tool_error", message: text, details: {} };
      }
      outcome = { ok: false, data: null, error, text, ms };
    } else outcome = { ok: true, data: result.structuredContent, error: null, text, ms };
    this.target.recordCall({ session: this.options.clientName, owner: this.ownerKey, tool: name, args, ok: outcome.ok, code: outcome.error?.code ?? null, ms });
    return outcome;
  }

  async listTools() {
    return (await this.withAuthorization((client) => client.listTools())).tools;
  }

  async listResources() {
    return (await this.withAuthorization((client) => client.listResources())).resources;
  }

  async readResource(uri) {
    const result = await this.withAuthorization((client) => client.readResource({ uri }));
    this.target.recordResource(uri);
    return result.contents ?? [];
  }

  /** How often the access token was renewed with the refresh token (every save after the first of each authorization). */
  get tokenRefreshes() {
    return Math.max(0, this.oauth.tokenSaves - this.authorizations);
  }

  async close() {
    if (this.client) await this.client.close().catch(() => undefined);
  }
}

export class Target {
  constructor(description, { onCall } = {}) {
    this.description = description;
    this.doors = description.doors ?? { kind: "none" };
    this.calls = [];
    this.resourceReads = new Map();
    this.onCall = onCall ?? (() => undefined);
    this.clock = null; // { simMs, realMs } once the clock door was used
    this.bootId = null;
    this.ownerRequests = 0;
    this.doorRequests = 0;
  }

  get hasClock() {
    return this.doors.kind === "simulation-worker" && this.doors.clock === true;
  }

  /** The target's current time: the simulated clock when it has that door, otherwise the real clock. */
  now() {
    return this.clock ? this.clock.simMs + (Date.now() - this.clock.realMs) : Date.now();
  }

  recordCall(call) {
    this.calls.push(call);
    this.onCall(call);
  }

  recordResource(uri) {
    this.resourceReads.set(uri, (this.resourceReads.get(uri) ?? 0) + 1);
  }

  /* ------------------------------ test doors ------------------------------ */

  async door(method, path, body) {
    if (this.doors.kind !== "simulation-worker") throw new Error(`the target '${this.description.label}' has no test door (${path})`);
    this.doorRequests++;
    const response = await fetch(`${this.doors.controlOrigin}${path}`, { method, headers: { "x-sim-control": this.doors.controlToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`simulation door ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    if (data.bootId) {
      // The stand-ins and the clock live in the Worker's memory: a restarted Worker has lost them and the run is void.
      if (this.bootId && this.bootId !== data.bootId) throw new Error("the simulation Worker restarted during the run; its clock and scripted conditions are lost, so this run is void");
      this.bootId = data.bootId;
    }
    return data;
  }

  async setClock(simMs) {
    if (!this.hasClock) throw new Error("this target has no clock door");
    const before = Date.now();
    await this.door("POST", "/__sim/clock", { nowMs: simMs });
    this.clock = { simMs, realMs: before };
  }

  /** One run of the product's scheduled handler (the five-minute cron), waited to its end. */
  runScheduled() {
    return this.door("POST", "/__sim/scheduled", {});
  }

  scriptWeather(control) {
    return this.door("POST", "/__sim/weather", control);
  }

  scriptCalendar(control) {
    return this.door("POST", "/__sim/calendar", control);
  }

  readCalendar(calendarId) {
    return this.door("GET", `/__sim/calendar?calendarId=${encodeURIComponent(calendarId)}`);
  }

  /* ------------------------------ the signed-in owner ------------------------------ */

  /** The headers that sign the owner in on the app hostname. */
  async ownerHeaders(ownerKey) {
    const signIn = this.description.signIn;
    const owner = this.description.owners[ownerKey];
    if (!owner) throw new Error(`the target describes no owner '${ownerKey}'`);
    if (signIn.kind === "local-assertion") {
      // A stand-in for Cloudflare Access on a LOCAL target only: an assertion signed with the run's own key,
      // verified by the Worker's ordinary assertion check. It carries the target's time, simulated or real.
      const key = await importJWK(signIn.privateJwk, "RS256");
      const now = Math.floor(this.now() / 1000);
      const assertion = await new SignJWT({ email: owner.email, type: "app" }).setProtectedHeader({ alg: "RS256", kid: signIn.privateJwk.kid }).setIssuer(signIn.issuer).setAudience(signIn.audience).setSubject(owner.subject).setIssuedAt(now - 5).setExpirationTime(now + 900).sign(key);
      return { "Cf-Access-Jwt-Assertion": assertion };
    }
    if (signIn.kind === "headers-from-environment") {
      // A deployment behind Cloudflare Access: the owner's own Access credential for scripts, read from the
      // environment of this process (never from a file in the repository, never a management credential).
      const headers = {};
      for (const [header, variable] of Object.entries(owner.headersFromEnvironment ?? {})) {
        const value = process.env[variable];
        if (!value) throw new Error(`the environment variable ${variable} (sign-in of owner '${ownerKey}') is not set`);
        headers[header] = value;
      }
      return headers;
    }
    throw new Error(`unknown sign-in kind '${signIn.kind}'`);
  }

  async api(ownerKey, method, route, body) {
    this.ownerRequests++;
    const headers = await this.ownerHeaders(ownerKey);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${this.description.appOrigin}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: response.status, ok: response.ok, json, text, headers: response.headers };
  }

  /** `api`, for a request that must succeed. */
  async apiOk(ownerKey, method, route, body) {
    const response = await this.api(ownerKey, method, route, body);
    if (!response.ok) throw new Error(`${method} ${route} as owner '${ownerKey}' answered ${response.status}: ${response.text.slice(0, 400)}`);
    return response.json;
  }

  /** Sign in; claim the account with its invitation when this identity is not linked yet. */
  async claim(ownerKey) {
    const me = await this.api(ownerKey, "GET", "/v1/me");
    if (me.ok) return { claimed: false, userId: me.json.userId };
    if (me.status !== 403 || me.json?.error?.code !== "identity_not_linked") throw new Error(`GET /v1/me as owner '${ownerKey}' answered ${me.status}: ${me.text.slice(0, 300)}`);
    const code = this.description.owners[ownerKey].invitationCode;
    if (!code) throw new Error(`owner '${ownerKey}' is not linked and the target gives no invitation code`);
    const claim = await this.apiOk(ownerKey, "POST", "/auth/claim", { invitationCode: code });
    return { claimed: true, userId: claim.userId ?? claim.me?.userId ?? null };
  }

  /** The owner's part of an authorization: open the consent page signed in, then Allow (with or without the write permission). */
  async approveConsent(ownerKey, authorizationUrl, { write }) {
    const headers = await this.ownerHeaders(ownerKey);
    const page = await fetch(String(authorizationUrl), { headers, redirect: "manual" });
    const html = await page.text();
    if (page.status !== 200) throw new Error(`consent page answered ${page.status}: ${html.slice(0, 300)}`);
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]?.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
    if (!handle) throw new Error("the consent page has no transaction handle");
    const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const form = new URLSearchParams({ handle, decision: "approve" });
    if (write) form.append("scope", "wardrobe.write");
    const decided = await fetch(`${this.description.appOrigin}/oauth/authorize`, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", ...(cookies ? { Cookie: cookies } : {}) }, body: form.toString(), redirect: "manual" });
    const location = decided.headers.get("Location");
    if (decided.status !== 302 || !location) throw new Error(`consent decision answered ${decided.status}: ${(await decided.text()).slice(0, 300)}`);
    return new URL(location);
  }

  /** Connect an assistant for an owner through the whole OAuth flow. */
  async connect(ownerKey, { write, clientName, redirectUri }) {
    const session = new McpSession(this, ownerKey, { write, clientName, redirectUri });
    await session.authorize();
    return session;
  }

  /** Poll until `read()` returns something truthy; a deployment finishes background work after it answers. */
  async eventually(read, { attempts = this.hasClock ? 1 : 20, delayMs = 500 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
      last = await read();
      if (last) return last;
      if (i + 1 < attempts) await sleep(delayMs);
    }
    return last;
  }
}
