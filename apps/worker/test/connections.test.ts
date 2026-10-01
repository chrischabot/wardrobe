import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, ApiClient, newIdentity, provisionOwner, testApp, type TestOwner } from "../src/testing/index.ts";
import { checkRemoteUrl, redactText, redactUrl } from "../src/connections/endpoints.ts";
import { connectionAuthorization, googleAccessToken } from "../src/connections/service.ts";
import { assistantPortsFor } from "../src/lanes/index.ts";

/*
 * Third-party connections through the real Worker. Google's OAuth and Calendar endpoints are the
 * LABELLED FIXTURE described in src/testing/vitest-config.ts (`google.fixture.test`): these tests prove
 * the Worker's side of the flow (state, PKCE, storage, scoping, revocation handling), not Google's.
 */
let owner: TestOwner;
let other: TestOwner;
/** What the fixture "grants" when only the calendar capabilities were requested. */
const CALENDAR_SCOPES = "https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.app.created";

const fixtureCalls = async (): Promise<{ method: string; url: string; body: string }[]> => (await fetch("https://google.fixture.test/__calls")).json();
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string; details: Record<string, any> } }).error;
const register = (api: ApiClient, body: Record<string, unknown>) => api.post("/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, ...body });

async function connectGoogle(target: TestOwner, capabilities: string[], code = "fixture-code") {
  const started = await (await register(target.api, { kind: "google_workspace", name: "Google", auth: { type: "oauth" }, capabilities })).json() as any;
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  // The provider redirects the browser back: no Access header, no cookie, only the one-time state.
  const callback = await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`, { redirect: "manual" });
  return { started, state, callback };
}

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  other = await provisionOwner();
});

describe("endpoint validation", () => {
  it("refuses loopback, private, link-local, metadata and credential-bearing endpoints", async () => {
    const refused = [
      "http://mcp.example-service.com/mcp",
      "https://localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://2130706433/mcp",
      "https://10.0.0.5/mcp",
      "https://192.168.1.10/mcp",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/mcp",
      "https://metadata.google.internal/computeMetadata/v1",
      "https://printer.local/mcp",
      "https://intranet/mcp",
      "https://user:password@mcp.service-example.com/mcp",
      "https://mcp.service-example.com:22/mcp",
      "https://mcp.service-example.com/mcp?api_key=abc123",
      "https://mcp.tavily.com/mcp?tavilyApiKey=tvly-abcdefgh12345678",
      "https://8.8.8.8/mcp",
    ];
    for (const endpoint of refused) {
      expect(checkRemoteUrl(endpoint).ok, endpoint).toBe(false);
      const response = await register(owner.api, { kind: "mcp", name: "Bad endpoint", endpoint, auth: { type: "none" } });
      expect(response.status, endpoint).toBe(400);
    }
    expect(checkRemoteUrl("https://mcp.service-example.com/mcp").ok).toBe(true);
    expect((await owner.api.json("GET", "/v1/connections")).connections).toEqual([]);
  });

  it("redacts secrets from URLs and text before they can be stored, shown or logged", () => {
    expect(redactUrl("https://user:pw@mcp.tavily.com/mcp?tavilyApiKey=tvly-abcdefgh12345678&x=1")).toBe("https://mcp.tavily.com/mcp?tavilyApiKey=REDACTED&x=1");
    const text = redactText("failed GET https://api.example.com/v1?access_token=ya29.secretsecretsecret with Bearer abcdefghijklmnop123");
    expect(text).not.toContain("secretsecret");
    expect(text).not.toContain("abcdefghijklmnop123");
  });
});

describe("a connection with a key", () => {
  it("stores the key encrypted, never returns it, keeps the endpoint credential-free, and resolves it only at dispatch", async () => {
    const secret = "tvly-TESTSECRET-0123456789abcdef";
    const response = await register(owner.api, { kind: "tavily", name: "Tavily search", auth: { type: "secret", secret } });
    const body = (await response.json()) as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.connection.state).toBe("connected");
    expect(body.connection.endpoint).toBe("https://mcp.tavily.com/mcp");
    expect(body.authorizationUrl).toBeNull();
    expect(JSON.stringify(body)).not.toContain(secret);
    const listed = await owner.api.json("GET", "/v1/connections");
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed.connections[0].authType).toBe("secret");

    // At rest: ciphertext only, in this database and in the audit trail and command log.
    const app = await testApp();
    for (const table of ["connection_credentials", "connection_profiles", "account_audit", "commands"]) {
      const dump = JSON.stringify((await app.db.prepare(`SELECT * FROM ${table}`).all()).results);
      expect(dump, table).not.toContain(secret);
      expect(dump, table).not.toContain("TESTSECRET");
    }
    // The assistant's registry knows the connection by a reference name, not the key.
    const registry = await app.assistant!.connections(owner.systemPrincipal);
    const entry = registry.find((c) => c.connectionId === body.connection.connectionId)!;
    expect(entry.status).toBe("connected");
    expect(entry.secretRef).toBe(`cred_${body.connection.connectionId}`);
    expect(JSON.stringify(registry)).not.toContain(secret);
    // Resolved privately for a dispatch of THIS connection of THIS owner only.
    expect(await connectionAuthorization(app.env, app.db, owner.userId, entry.secretRef!)).toEqual({ header: "Authorization", value: `Bearer ${secret}` });
    expect(await connectionAuthorization(app.env, app.db, other.userId, entry.secretRef!)).toBeNull();

    // Same request ID: the same connection, not a second one.
    const again = await owner.api.post("/v1/connections", { clientRequestId: "fixed-request-id-1", kind: "exa", name: "Exa", auth: { type: "secret", secret: "exa-key-1" } });
    const replay = await owner.api.post("/v1/connections", { clientRequestId: "fixed-request-id-1", kind: "exa", name: "Exa", auth: { type: "secret", secret: "exa-key-1" } });
    expect(((await again.json()) as any).connection.connectionId).toBe(((await replay.json()) as any).connection.connectionId);

    // Another owner cannot see or disconnect it.
    expect((await other.api.json("GET", "/v1/connections")).connections).toEqual([]);
    expect((await other.api.post(`/v1/connections/${body.connection.connectionId}/disconnect`, {})).status).toBe(404);

    // Disconnect: future calls stop, the credential is removed, the registry entry is revoked.
    const disconnected = await owner.api.json("POST", `/v1/connections/${body.connection.connectionId}/disconnect`, {});
    expect(disconnected.connection.state).toBe("disconnected");
    expect(disconnected.credentialsRemoved).toBe(true);
    expect(disconnected.remoteRevocation).toBe("not_applicable");
    expect(await connectionAuthorization(app.env, app.db, owner.userId, entry.secretRef!)).toBeNull();
    const row = await app.db.prepare("SELECT ciphertext FROM connection_credentials WHERE user_id = ? AND connection_id = ?").bind(owner.userId, body.connection.connectionId).first<{ ciphertext: string | null }>();
    expect(row!.ciphertext).toBeNull();
    expect((await app.assistant!.connections(owner.systemPrincipal)).find((c) => c.connectionId === body.connection.connectionId)!.status).toBe("revoked");
  });
});

describe("a tool service's capabilities (remote MCP service: LABELLED FIXTURE, not Tavily)", () => {
  it("records what the service really offers, uses only groups the owner enabled, sends the key only as a header, and stops at disconnect", async () => {
    const secret = "tvly-FIXTUREKEY-0123456789abcdef";
    await fixtureCalls();
    const registered = (await (await register(owner.api, { kind: "tavily", name: "Page search", auth: { type: "secret", secret } })).json()) as any;
    const id = registered.connection.connectionId as string;

    // Discovery ran against the service: the offered groups are listed, nothing is enabled by default,
    // and the provider-side research agent is not offered as a capability at all.
    const capability = Object.fromEntries(registered.connection.capabilities.map((c: any) => [c.key, c]));
    expect(Object.keys(capability).sort()).toEqual(["tools:extract", "tools:search"]);
    expect(capability["tools:search"]).toMatchObject({ enabled: false, available: true, effect: "read" });
    expect(capability["tools:search"].label).toContain("fixture_search");
    expect(registered.connection.protocol).toBe("2026-07-28");
    expect(registered.connection.issue).toBeNull();
    const app = await testApp();
    const entry = (await app.assistant!.connections(owner.systemPrincipal)).find((c) => c.connectionId === id)!;
    expect(entry.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.tools.find((t) => t.name === "fixture_research")).toMatchObject({ enabled: false });
    const discovery = (await fixtureCalls()).filter((c) => c.method === "MCP").map((c) => JSON.parse(c.body));
    expect(discovery.every((c) => c.method === "tools/list" && c.authorized === true)).toBe(true);

    // The assistant's search port: nothing is sent while the owner has not enabled the group.
    const search = assistantPortsFor(app.env, owner.userId).searchProviders![0]!;
    await expect(search.search("shetland crewneck")).rejects.toMatchObject({ code: "not_executable" });
    expect((await fixtureCalls()).map((c) => JSON.parse(c.body)).filter((c) => c.method === "tools/call")).toEqual([]);

    // A capability the service does not offer cannot be switched on.
    const refused = await owner.api.post(`/v1/connections/${id}/capabilities`, { enabled: ["tools:admin"] });
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).details.allowed.sort()).toEqual(["tools:extract", "tools:search"]);

    const enabled = await owner.api.json("POST", `/v1/connections/${id}/capabilities`, { enabled: ["tools:search"] });
    expect(Object.fromEntries(enabled.capabilities.map((c: any) => [c.key, c.enabled]))).toEqual({ "tools:search": true, "tools:extract": false });
    await fixtureCalls();
    const found = await search.search("shetland crewneck");
    expect(found.results).toHaveLength(1);
    expect(found.results[0]!.title).toBe("Shetland crewneck");
    expect(found.results[0]!.url).not.toContain("LEAKEDKEY123456"); // a key-bearing result URL is redacted
    const sent = (await fixtureCalls()).map((c) => JSON.parse(c.body)).filter((c) => c.method === "tools/call");
    expect(sent).toEqual([{ method: "tools/call", tool: "fixture_search", arguments: { query: "shetland crewneck" }, protocol: "2026-07-28", authorized: true }]);
    expect(JSON.stringify(sent)).not.toContain("tvly-");

    // Another owner's assistant has no such connection: nothing is called and no key is borrowed.
    await expect(assistantPortsFor(app.env, other.userId).searchProviders![0]!.search("shetland crewneck")).rejects.toMatchObject({ code: "not_executable" });
    expect(await fixtureCalls()).toEqual([]);

    // Disconnect: the very next search is refused and nothing reaches the service.
    await owner.api.json("POST", `/v1/connections/${id}/disconnect`, {});
    await expect(search.search("again")).rejects.toMatchObject({ code: "not_executable" });
    expect((await fixtureCalls()).filter((c) => c.method === "MCP")).toEqual([]);
  });

  it("reports a service that cannot be reached as one retry state, enables nothing, and leaves sign-in and the wardrobe working", async () => {
    const registered = (await (await register(owner.api, { kind: "exa", name: "Unreachable search", auth: { type: "secret", secret: "exa-key-unreachable-1" } })).json()) as any;
    expect(registered.connection.capabilities).toEqual([]);
    expect(registered.connection.issue).toMatchObject({ action: "retry" });
    expect((await owner.api.get("/v1/wardrobe?limit=1")).status).toBe(200);
    await owner.api.json("POST", `/v1/connections/${registered.connection.connectionId}/disconnect`, {});
  });
});

describe("Google Workspace as a backend connection", () => {
  let connectionId: string;

  it("starts authorization bound to the owner: state, PKCE, offline access and only the requested scopes", async () => {
    await fixtureCalls();
    const { started, state, callback } = await connectGoogle(owner, ["calendar.read", "calendar.write_outfit_calendar"], `scopes:${CALENDAR_SCOPES}`);
    connectionId = started.connection.connectionId;
    expect(started.connection.state).toBe("pending_authorization");
    const url = new URL(started.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://google.fixture.test/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(`${APP_ORIGIN}/connections/callback`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")!.length).toBeGreaterThan(40);
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes.sort()).toEqual(["https://www.googleapis.com/auth/calendar.app.created", "https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.readonly"]);
    expect(scopes.join(" ")).not.toContain("gmail");

    // The callback succeeded on its state alone, and exchanged the code with the PKCE verifier on the backend.
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Google is connected");
    const exchange = (await fixtureCalls()).find((c) => c.url.endsWith("/token"))!;
    const form = new URLSearchParams(exchange.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")!.length).toBeGreaterThan(40);
    expect(form.get("redirect_uri")).toBe(`${APP_ORIGIN}/connections/callback`);

    const connection = (await owner.api.json("GET", "/v1/connections")).connections.find((c: any) => c.connectionId === connectionId);
    expect(connection.state).toBe("connected");
    expect(connection.lastSuccessAt).toBeTruthy();
    const capability = Object.fromEntries(connection.capabilities.map((c: any) => [c.key, c]));
    expect(capability["calendar.read"]).toMatchObject({ enabled: true, available: true });
    expect(capability["gmail.read_orders"]).toMatchObject({ enabled: false });
    // The assistant's registry learns of the Google calendar on the owner's next request, by reference only.
    const registry = await (await testApp()).assistant!.connections(owner.systemPrincipal);
    const calendarEntry = registry.find((c) => c.connectionId === `${connectionId}_calendar`)!;
    expect(calendarEntry.status).toBe("connected");
    expect(calendarEntry.kind).toBe("calendar");
    expect(registry.some((c) => c.connectionId === `${connectionId}_gmail`)).toBe(false);
    // The state is single-use.
    const replay = await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=${encodeURIComponent(state)}&code=fixture-code`);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("already used");
    // The tokens are not readable anywhere.
    const app = await testApp();
    const dump = JSON.stringify((await app.db.prepare("SELECT * FROM connection_credentials WHERE user_id = ?").bind(owner.userId).all()).results) + JSON.stringify(await owner.api.json("GET", "/v1/connections"));
    expect(dump).not.toContain("fixture-refresh-2");
    expect(dump).not.toContain("fixture-access");
  });

  it("refuses a callback with an unknown, expired or foreign state, whatever headers accompany it", async () => {
    const unknown = await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=not-a-real-state&code=fixture-code`, { headers: await owner.api.headers() });
    expect(unknown.status).toBe(400);
    // A second owner starts a flow; the first owner's valid Access session cannot complete it for themselves.
    const started = (await (await register(other.api, { kind: "google_workspace", name: "Google", auth: { type: "oauth" }, capabilities: ["calendar.read"] })).json()) as any;
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const app = await testApp();
    await app.db.prepare("UPDATE connection_oauth_states SET expires_at = ? WHERE connection_id = ?").bind(new Date(Date.now() - 1000).toISOString(), started.connection.connectionId).run();
    const expired = await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=${encodeURIComponent(state)}&code=fixture-code`, { headers: await owner.api.headers() });
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain("expired");
    expect((await other.api.json("GET", "/v1/connections")).connections[0].state).toBe("pending_authorization");
    expect((await owner.api.json("GET", "/v1/connections")).connections.filter((c: any) => c.kind === "google_workspace")).toHaveLength(1);
  });

  it("lists calendars and creates the dedicated outfit calendar once, recorded through settings.update", async () => {
    const calendars = await owner.api.json("GET", `/v1/connections/${connectionId}/calendars`);
    expect(calendars.calendars.map((c: any) => c.name)).toEqual(["Personal", "Team"]);
    expect(calendars.calendars[0]).toMatchObject({ primary: true, readForContext: true, outfitCalendar: false });
    expect(calendars.outfitCalendarId).toBeNull();

    const created = await owner.api.json("POST", `/v1/connections/${connectionId}/outfit-calendar`, { clientRequestId: `cal-${crypto.randomUUID()}` });
    expect(created.created).toBe(true);
    expect(created.receipt.type).toBe("settings.update");
    const settings = await owner.api.json("GET", "/v1/settings");
    expect(settings.settings.extensions.daily.calendar.outfitCalendarId).toBe(created.calendar.calendarId);
    const again = await owner.api.json("POST", `/v1/connections/${connectionId}/outfit-calendar`, { clientRequestId: `cal-${crypto.randomUUID()}` });
    expect(again.created).toBe(false);
    expect(again.calendar.calendarId).toBe(created.calendar.calendarId);
    expect((await other.api.get(`/v1/connections/${connectionId}/calendars`)).status).toBe(404);
  });

  it("gives an adapter a token only for an enabled, granted capability of that owner", async () => {
    const app = await testApp();
    expect(await googleAccessToken(app.env, app.db, owner.userId, "calendar.read")).toMatch(/^fixture-access/);
    expect(await googleAccessToken(app.env, app.db, owner.userId, "gmail.read_orders")).toBeNull();
    expect(await googleAccessToken(app.env, app.db, other.userId, "calendar.read")).toBeNull();
    // Enabling something Google has not granted produces one clear reconnect action naming the capability.
    const updated = await owner.api.json("POST", `/v1/connections/${connectionId}/capabilities`, { enabled: ["calendar.read", "calendar.write_outfit_calendar", "gmail.read_orders"] });
    expect(updated.state).toBe("needs_reconnect");
    expect(updated.issue).toMatchObject({ capability: "gmail.read_orders", action: "reconnect" });
    const recovery = await owner.api.json("GET", "/v1/recovery");
    expect(recovery.connectionIssues.map((i: any) => i.capability)).toContain("gmail.read_orders");
    expect(recovery.actions).toContain("reconnect");
    // A connection problem never blocks the wardrobe or logging a wear.
    expect((await owner.api.get("/v1/wardrobe")).status).toBe(200);
    // Reconnecting asks Google again and restores the connection.
    const reconnect = await owner.api.json("POST", `/v1/connections/${connectionId}/reconnect`, {});
    expect(new URL(reconnect.authorizationUrl).searchParams.get("scope")).toContain("gmail.readonly");
    const state = new URL(reconnect.authorizationUrl).searchParams.get("state")!;
    expect((await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=${encodeURIComponent(state)}&code=fixture-code`)).status).toBe(200);
    const connection = (await owner.api.json("GET", "/v1/connections")).connections.find((c: any) => c.connectionId === connectionId);
    expect(connection.state).toBe("connected");
    expect(connection.issue).toBeNull();
    expect(await googleAccessToken(app.env, app.db, owner.userId, "gmail.read_orders")).toMatch(/^fixture-access/);
  });

  it("disconnects: credential removed, provider revocation attempted and reported, sign-in unaffected", async () => {
    await fixtureCalls();
    const result = await owner.api.json("POST", `/v1/connections/${connectionId}/disconnect`, {});
    expect(result.connection.state).toBe("disconnected");
    expect(result.futureCallsStopped).toBe(true);
    expect(result.remoteRevocation).toBe("revoked");
    expect(result.receiptId).toMatch(/^aud_/);
    const revoke = (await fixtureCalls()).find((c) => c.url.endsWith("/revoke"))!;
    expect(new URLSearchParams(revoke.body).get("token")).toBe("fixture-refresh-1");
    const app = await testApp();
    expect(await googleAccessToken(app.env, app.db, owner.userId, "calendar.read")).toBeNull();
    expect((await owner.api.get(`/v1/connections/${connectionId}/calendars`)).status).toBe(409);
    // Disconnecting Google does not affect app sign-in, the wardrobe, or today's board reads.
    expect((await owner.api.get("/v1/me")).status).toBe(200);
    expect((await owner.api.get("/v1/wardrobe")).status).toBe(200);
    const registryAfter = await app.assistant!.connections(owner.systemPrincipal);
    expect(registryAfter.find((c) => c.connectionId === `${connectionId}_calendar`)!.status).toBe("revoked");
  });

  it("refreshes an expiring token once, and a revoked grant becomes one reconnect state without breaking anything else", async () => {
    const fresh = await provisionOwner();
    const { callback } = await connectGoogle(fresh, ["calendar.read"], "expiring");
    expect(callback.status).toBe(200);
    const app = await testApp();
    await fixtureCalls();
    const token = await googleAccessToken(app.env, app.db, fresh.userId, "calendar.read");
    expect(token).toMatch(/^fixture-access-\d+$/);
    expect(await googleAccessToken(app.env, app.db, fresh.userId, "calendar.read")).toBe(token);
    expect((await fixtureCalls()).filter((c) => new URLSearchParams(c.body).get("grant_type") === "refresh_token")).toHaveLength(1);

    const revoked = await provisionOwner();
    await connectGoogle(revoked, ["calendar.read"], "expiring-revoked");
    expect(await googleAccessToken(app.env, app.db, revoked.userId, "calendar.read")).toBeNull();
    expect(await googleAccessToken(app.env, app.db, revoked.userId, "calendar.read")).toBeNull();
    const connection = (await revoked.api.json("GET", "/v1/connections")).connections[0];
    expect(connection.state).toBe("needs_reconnect");
    expect(connection.issue.action).toBe("reconnect");
    expect((await revoked.api.get("/v1/me")).status).toBe(200);
    expect((await revoked.api.get("/v1/wardrobe")).status).toBe(200);
  });

  it("reports a capability Google declined, and a declined consent connects nothing", async () => {
    const partial = await provisionOwner();
    const { callback } = await connectGoogle(partial, ["calendar.read", "gmail.read_orders"], "scopes:https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly");
    expect(callback.status).toBe(200);
    const connection = (await partial.api.json("GET", "/v1/connections")).connections[0];
    const capability = Object.fromEntries(connection.capabilities.map((c: any) => [c.key, c]));
    expect(capability["calendar.read"].available).toBe(true);
    expect(capability["gmail.read_orders"]).toMatchObject({ enabled: true, available: false });
    expect(connection.issue.capability).toBe("gmail.read_orders");

    const declined = await provisionOwner();
    const started = (await (await register(declined.api, { kind: "google_workspace", name: "Google", auth: { type: "oauth" }, capabilities: ["calendar.read"] })).json()) as any;
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const response = await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=${encodeURIComponent(state)}&error=access_denied`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("declined");
    expect((await declined.api.json("GET", "/v1/connections")).connections[0].state).toBe("needs_reconnect");
    const app = await testApp();
    expect(await googleAccessToken(app.env, app.db, declined.userId, "calendar.read")).toBeNull();
  });

  it("needs an owner session to register or change a connection", async () => {
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/connections`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await new ApiClient(newIdentity("nobody")).get("/v1/connections")).status).toBe(403);
  });
});
