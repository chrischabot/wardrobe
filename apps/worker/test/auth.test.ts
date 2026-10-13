import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, ApiClient, MCP_ORIGIN, accessAssertion, newIdentity, provisionOwner, type TestOwner } from "../src/testing/index.ts";

/*
 * Cloudflare Access is represented by assertions signed with this test run's key; the Worker verifies
 * them with its ordinary verification code. Everything behind that (identity mapping, sessions,
 * routes, D1) is the real Worker.
 */
let owner: TestOwner;
let other: TestOwner;

beforeAll(async () => {
  owner = await provisionOwner();
  other = await provisionOwner();
});

const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; details: Record<string, unknown> } }).error;

describe("signing in", () => {
  it("refuses a request with no assertion", async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}/v1/me`);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("unauthenticated");
  });

  it("refuses an assertion signed by a key that is not the Access team's", async () => {
    const response = await new ApiClient(owner.identity, { untrusted: true }).get("/v1/me");
    expect(response.status).toBe(401);
  });

  it("refuses an assertion for another audience, from another issuer, or expired", async () => {
    expect((await new ApiClient(owner.identity, { audience: "some-other-application" }).get("/v1/me")).status).toBe(401);
    expect((await new ApiClient(owner.identity, { issuer: "https://attacker.cloudflareaccess.com" }).get("/v1/me")).status).toBe(401);
    const expired = await new ApiClient(owner.identity, { issuedAgoSeconds: 7200, expiresInSeconds: 3600 }).get("/v1/me");
    expect(expired.status).toBe(401);
    expect((await errorOf(expired)).details.reason).toBe("expired");
  });

  it("refuses an unsigned header value and a plain email header", async () => {
    const unsigned = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub: owner.identity.subject, iss: "https://garderobe-test.cloudflareaccess.com", aud: "garderobe-test-audience" }))}.`;
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/me`, { headers: { "Cf-Access-Jwt-Assertion": unsigned } })).status).toBe(401);
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/me`, { headers: { "Cf-Access-Authenticated-User-Email": owner.identity.email! } })).status).toBe(401);
  });

  it("refuses an assertion without a subject (a service token is not a person)", async () => {
    expect((await new ApiClient(owner.identity, { omitSubject: true }).get("/v1/me")).status).toBe(401);
  });

  it("does not treat a verified identity as an account: an unlinked sign-in is told to claim, link or recover", async () => {
    const stranger = new ApiClient(newIdentity("stranger"));
    const response = await stranger.get("/v1/wardrobe");
    expect(response.status).toBe(403);
    const error = await errorOf(response);
    expect(error.code).toBe("identity_not_linked");
    expect(error.details.next).toEqual(["claim", "link", "recovery"]);
  });

  it("never links by email: a new identity that reuses the owner's email address gets nothing", async () => {
    const sameEmail = new ApiClient({ subject: newIdentity().subject, email: owner.identity.email });
    const response = await sameEmail.get("/v1/me");
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("identity_not_linked");
  });
});

describe("hostname separation", () => {
  it("refuses app routes on the MCP hostname even with a valid assertion", async () => {
    const response = await owner.api.with({ origin: MCP_ORIGIN }).get("/v1/me");
    expect(response.status).toBe(401);
    expect((await errorOf(response)).details.reason).toBe("wrong_host");
  });

  it("refuses the MCP endpoint on the app hostname, and without a token on its own hostname", async () => {
    const onApp = await SELF.fetch(`${APP_ORIGIN}/mcp`, { method: "POST", headers: await owner.api.headers({ "Content-Type": "application/json" }), body: "{}" });
    expect([401, 404]).toContain(onApp.status);
    const noToken = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("does not accept an Access assertion as an MCP credential", async () => {
    const token = await accessAssertion(owner.identity);
    const response = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Cf-Access-Jwt-Assertion": token }, body: "{}" });
    expect(response.status).toBe(401);
  });
});

describe("browser sessions", () => {
  it("accepts the Access cookie and marks the session as the web channel", async () => {
    const me = await owner.api.with({ client: "web" }).json("GET", "/v1/me");
    expect(me.channel).toBe("web");
    expect((await owner.api.json("GET", "/v1/me")).channel).toBe("ios");
  });

  it("refuses a state-changing request sent from another site", async () => {
    const web = owner.api.with({ client: "web" });
    const response = await SELF.fetch(`${APP_ORIGIN}/v1/recovery-kit`, { method: "POST", headers: await web.headers({ "Content-Type": "application/json", Origin: "https://evil.example" }), body: "{}" });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).details.reason).toBe("cross_origin");
    // and the kit was not rotated
    expect((await owner.api.json("GET", "/v1/me")).recoveryKit.issuedAt).toBe(owner.recoveryKit.issuedAt);
  });
});

describe("two owners", () => {
  it("each sees only their own account", async () => {
    const a = await owner.api.json("GET", "/v1/me");
    const b = await other.api.json("GET", "/v1/me");
    expect(a.userId).toBe(owner.userId);
    expect(b.userId).toBe(other.userId);
    expect(a.userId).not.toBe(b.userId);
  });

  it("signing out everywhere refuses older sessions of that owner only, and keeps the session that asked", async () => {
    const older = owner.api.with({ issuedAgoSeconds: 600 });
    expect((await older.get("/v1/me")).status).toBe(200);
    const current = owner.api.with({ issuedAgoSeconds: 5 });
    const revoked = await current.json("POST", "/v1/sessions/revoke", {});
    expect(revoked.receiptId).toMatch(/^aud_/);
    // The session that asked keeps working.
    expect((await current.get("/v1/me")).status).toBe(200);
    // A session of another linked identity that predates the revocation is refused.
    const ticket = await current.json("POST", "/v1/identities/link", {});
    const second = new ApiClient(newIdentity("second-device"), { issuedAgoSeconds: 900 });
    // (linked now, but its session began before the revocation)
    await new ApiClient(second.identity).json("POST", "/auth/link/complete", { linkCode: ticket.linkCode });
    const stale = await second.get("/v1/me");
    expect(stale.status).toBe(401);
    expect((await errorOf(stale)).code).toBe("session_revoked");
    expect((await new ApiClient(second.identity).get("/v1/me")).status).toBe(200);
    // The other owner is unaffected.
    expect((await other.api.with({ issuedAgoSeconds: 600 }).get("/v1/me")).status).toBe(200);
  });

  it("exempts only the session that signed out: another session of the same sign-in that began after it is refused", async () => {
    const fresh = await provisionOwner();
    const phone = fresh.api.with({ issuedAgoSeconds: 7200, expiresInSeconds: 86_400 });
    const elsewhere = fresh.api.with({ issuedAgoSeconds: 600 });
    expect((await elsewhere.get("/v1/me")).status).toBe(200);
    expect((await phone.post("/v1/sessions/revoke", {})).status).toBe(200);
    // The session that asked keeps working, on later requests too.
    expect((await phone.get("/v1/me")).status).toBe(200);
    const refused = await elsewhere.get("/v1/me");
    expect(refused.status).toBe(401);
    expect((await errorOf(refused)).code).toBe("session_revoked");
    // A sign-in after the sign-out works.
    expect((await fresh.api.get("/v1/me")).status).toBe(200);

    // When the issuer supplies a session identifier (jti), another session of the same sign-in issued in the
    // exact same second is also refused.
    const secondOwner = await provisionOwner();
    const sameSecond = Math.floor(Date.now() / 1000) - 300;
    const revokingSession = secondOwner.api.with({ issuedAtSeconds: sameSecond, sessionId: "ses_revoking", expiresInSeconds: 86_400 });
    const siblingSameSecond = secondOwner.api.with({ issuedAtSeconds: sameSecond, sessionId: "ses_sibling", expiresInSeconds: 86_400 });
    expect((await siblingSameSecond.get("/v1/me")).status).toBe(200);
    expect((await revokingSession.post("/v1/sessions/revoke", {})).status).toBe(200);
    expect((await revokingSession.get("/v1/me")).status).toBe(200);
    const siblingRefused = await siblingSameSecond.get("/v1/me");
    expect(siblingRefused.status).toBe(401);
    expect((await errorOf(siblingRefused)).code).toBe("session_revoked");
  });
});
