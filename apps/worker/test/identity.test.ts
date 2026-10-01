import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createUser, first } from "@garderobe/domain";
import { createInvitation } from "../src/identity/service.ts";
import { APP_ORIGIN, ApiClient, MCP_ORIGIN, connectMcp, newIdentity, provisionOwner, testApp } from "../src/testing/index.ts";

const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string; details: Record<string, any> } }).error;

describe("claiming the invited account", () => {
  it("links the identity, issues the recovery kit once, and stores only a verifier", async () => {
    const owner = await provisionOwner();
    const kit = owner.recoveryKit;
    expect(kit.recoveryCode).toMatch(/^GRD1-RK[0-9A-Z]+-/);
    expect(kit.downloadText).toContain(kit.recoveryCode);
    expect(kit.storageInstruction.length).toBeGreaterThan(40);
    // The kit is not shown again.
    const me = await owner.api.json("GET", "/v1/me");
    expect(me.issuedRecoveryKit).toBeNull();
    expect(me.recoveryKit.present).toBe(true);
    // The database holds a salted verifier, never the code or any part of its secret.
    const app = await testApp();
    const row = await first<{ verifier: string; salt: string; algorithm: string }>(app.db, "SELECT verifier, salt, algorithm FROM recovery_credentials WHERE user_id = ? AND status = 'active'", owner.userId);
    const secret = kit.recoveryCode.split("-").slice(2).join("");
    expect(row!.algorithm).toBe("pbkdf2-sha256-100000");
    expect(row!.verifier).not.toContain(secret.slice(0, 12));
    const dump = JSON.stringify((await app.db.prepare("SELECT * FROM recovery_credentials WHERE user_id = ?").bind(owner.userId).all()).results);
    expect(dump).not.toContain(secret.slice(0, 16));
  });

  it("refuses a wrong, reused or expired invitation and an identity that already has an account", async () => {
    const app = await testApp();
    const { userId } = await createUser(app.db, { displayName: "Invited owner (test fixture)", isSynthetic: true });
    const invitation = await createInvitation(app.db, app.env, { userId });
    const visitor = new ApiClient(newIdentity("visitor"));
    const wrong = await visitor.post("/auth/claim", { invitationCode: "GRDI-this-is-not-the-invitation-code" });
    expect(wrong.status).toBe(403);
    expect((await visitor.post("/auth/claim", { invitationCode: invitation.invitationCode })).status).toBe(200);
    // One use only.
    const second = new ApiClient(newIdentity("second-claimer"));
    expect((await second.post("/auth/claim", { invitationCode: invitation.invitationCode })).status).toBe(403);
    expect((await second.get("/v1/me")).status).toBe(403);
    // Expired.
    const { userId: lateUser } = await createUser(app.db, { displayName: "Late owner (test fixture)", isSynthetic: true });
    const expired = await createInvitation(app.db, app.env, { userId: lateUser, nowMs: Date.now() - 30 * 86_400_000 });
    expect((await new ApiClient(newIdentity("late")).post("/auth/claim", { invitationCode: expired.invitationCode })).status).toBe(403);
    // An identity that already belongs to an account cannot claim another one.
    const fresh = await createInvitation(app.db, app.env, { userId: lateUser });
    const taken = await visitor.post("/auth/claim", { invitationCode: fresh.invitationCode });
    expect(taken.status).toBe(403);
    expect((await errorOf(taken)).details.reason).toBe("identity_in_use");
    expect((await visitor.json("GET", "/v1/me")).userId).toBe(userId);
  });

  it("limits guessing: repeated wrong codes from one sign-in are rate limited", async () => {
    const guesser = new ApiClient(newIdentity("guesser"));
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await guesser.post("/auth/claim", { invitationCode: `GRDI-guess-number-${i}-padding-padding` })).status);
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("linking and unlinking a second sign-in", () => {
  it("links only with a ticket the signed-in owner created, and unlinking keeps the wardrobe", async () => {
    const owner = await provisionOwner({ real: true });
    const before = (await owner.api.json("GET", "/v1/wardrobe")).total;
    const second = new ApiClient(newIdentity("second"));
    // Without a ticket: nothing. With someone else's guess: nothing.
    expect((await second.post("/auth/link/complete", { linkCode: "GRDL-not-a-real-link-code-000000" })).status).toBe(403);
    const ticket = await owner.api.json("POST", "/v1/identities/link", {});
    const linked = await second.json("POST", "/auth/link/complete", { linkCode: ticket.linkCode });
    expect(linked.userId).toBe(owner.userId);
    expect(linked.identities).toHaveLength(2);
    // The ticket works once.
    expect((await new ApiClient(newIdentity("third")).post("/auth/link/complete", { linkCode: ticket.linkCode })).status).toBe(403);
    // Both sign-ins reach the same wardrobe.
    expect((await second.json("GET", "/v1/wardrobe")).total).toBe(before);

    // Unlink the original identity from the second one: the wardrobe and its history stay.
    const me = await second.json("GET", "/v1/me");
    const original = me.identities.find((i: any) => !i.current);
    const after = await second.json("POST", "/v1/identities/unlink", { identityId: original.identityId });
    expect(after.identities).toHaveLength(1);
    expect((await owner.api.get("/v1/me")).status).toBe(403);
    expect((await second.json("GET", "/v1/wardrobe")).total).toBe(before);
  });

  it("will not unlink the only sign-in when no recovery kit exists", async () => {
    const owner = await provisionOwner();
    const app = await testApp();
    await app.db.prepare("UPDATE recovery_credentials SET status = 'replaced' WHERE user_id = ?").bind(owner.userId).run();
    const me = await owner.api.json("GET", "/v1/me");
    const response = await owner.api.post("/v1/identities/unlink", { identityId: me.identities[0].identityId });
    expect(response.status).toBe(409);
    expect((await owner.api.get("/v1/me")).status).toBe(200);
  });
});

describe("recovering after losing the sign-in", () => {
  it("restores the same wardrobe to a new identity, spends the credential, revokes sessions and assistants, and issues a new kit", async () => {
    const owner = await provisionOwner({ real: true });
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const assistant = await connectMcp(owner, { write: true, clientName: "Assistant before recovery" });
    const oldToken = assistant.oauth.snapshot().accessToken;
    // A third-party connection exists and must be left exactly as it is.
    const app = await testApp();
    await app.db.prepare("INSERT INTO connection_profiles (user_id, connection_id, kind, name, namespace, auth_type, state, capabilities_json, created_at, updated_at) VALUES (?, 'con_fixture', 'google_workspace', 'Google', 'google', 'oauth', 'needs_reconnect', '[]', ?, ?)").bind(owner.userId, new Date().toISOString(), new Date().toISOString()).run();

    // The owner can no longer use the old Google account. They sign in with a different one.
    const replacement = new ApiClient(newIdentity("replacement"));
    expect((await replacement.get("/v1/wardrobe")).status).toBe(403);
    const tx = await replacement.json("POST", "/auth/recovery/start", {});
    expect(tx.attemptsRemaining).toBe(5);

    // Knowing the wardrobe or the email proves nothing; a wrong code is refused and counted.
    const wrong = await replacement.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: "GRD1-RKAAAAAAAAAA-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000" });
    expect(wrong.status).toBe(403);
    expect((await errorOf(wrong)).details.attemptsRemaining).toBe(4);
    // Another identity cannot use this transaction even with the right code.
    const thief = new ApiClient(newIdentity("thief"));
    expect((await thief.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: owner.recoveryKit.recoveryCode })).status).toBe(404);

    const done = await replacement.json("POST", "/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: owner.recoveryKit.recoveryCode.toLowerCase(), unlinkPreviousIdentities: true });
    expect(done.userId).toBe(owner.userId);
    expect(done.identityLinked).toBe(true);
    expect(done.assistantGrantsRevoked).toBe(1);
    expect(done.previousIdentitiesUnlinked).toBe(1);
    expect(done.connectionsUnchanged).toBe(true);
    expect(done.replacementKit.recoveryCode).not.toBe(owner.recoveryKit.recoveryCode);
    expect(done.receiptId).toMatch(/^aud_/);

    // Same wardrobe, same IDs, nothing deleted.
    const recovered = await replacement.json("GET", "/v1/wardrobe");
    expect(recovered.total).toBe(wardrobe.total);
    expect(recovered.items.map((i: any) => i.garment.garmentId).sort()).toEqual(wardrobe.items.map((i: any) => i.garment.garmentId).sort());
    expect((await replacement.json("GET", "/v1/style")).document.contentSha256).toBe("e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198");

    // The old identity and its sessions no longer work; the assistant's token is refused.
    expect((await owner.api.get("/v1/me")).status).toBe(403);
    const mcp = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${oldToken}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(mcp.status).toBe(401);
    expect((await replacement.json("GET", "/v1/assistants")).grants.every((g: any) => g.status === "revoked")).toBe(true);

    // The used credential cannot be used again, by anyone, in a new transaction.
    const again = new ApiClient(newIdentity("again"));
    const tx2 = await again.json("POST", "/auth/recovery/start", {});
    const reuse = await again.post("/auth/recovery/complete", { transactionId: tx2.transactionId, recoveryCode: owner.recoveryKit.recoveryCode });
    expect(reuse.status).toBe(403);
    expect((await again.get("/v1/me")).status).toBe(403);
    // The finished transaction cannot be replayed either.
    expect((await replacement.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: done.replacementKit.recoveryCode })).status).toBe(410);

    // Recovery did not touch the third-party connection: a grant that needed reconnecting still does.
    const connections = await replacement.json("GET", "/v1/connections");
    expect(connections.connections).toHaveLength(1);
    expect(connections.connections[0].state).toBe("needs_reconnect");

    // There is an audit receipt for the recovery and for the refused attempts, without the code in it.
    const audit = await app.db.prepare("SELECT kind, outcome, detail_json FROM account_audit WHERE kind = 'recovery.complete' ORDER BY at").all<{ kind: string; outcome: string; detail_json: string }>();
    expect(audit.results.some((r) => r.outcome === "ok")).toBe(true);
    expect(audit.results.some((r) => r.outcome === "refused")).toBe(true);
    expect(JSON.stringify(audit.results)).not.toContain(owner.recoveryKit.recoveryCode.split("-").slice(2).join("").slice(0, 16));

    // The replacement kit works for a later loss.
    const later = new ApiClient(newIdentity("later"));
    const tx3 = await later.json("POST", "/auth/recovery/start", {});
    const second = await later.json("POST", "/auth/recovery/complete", { transactionId: tx3.transactionId, recoveryCode: done.replacementKit.recoveryCode });
    expect(second.userId).toBe(owner.userId);
    // Not asked to unlink: the earlier identity stays linked, but its older session was signed out.
    expect(second.previousIdentitiesUnlinked).toBe(0);
  });

  it("keeps a session that predates recovery signed out even when its identity stays linked", async () => {
    const owner = await provisionOwner();
    const stale = owner.api.with({ issuedAgoSeconds: 300 });
    expect((await stale.get("/v1/me")).status).toBe(200);
    const fresh = new ApiClient(newIdentity("fresh"));
    const tx = await fresh.json("POST", "/auth/recovery/start", {});
    await fresh.json("POST", "/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: owner.recoveryKit.recoveryCode });
    const response = await stale.get("/v1/me");
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("session_revoked");
  });

  it("expires a recovery transaction and exhausts its attempts without ever inventing an override", async () => {
    const owner = await provisionOwner();
    const app = await testApp();
    const visitor = new ApiClient(newIdentity("locked-out"));
    const tx = await visitor.json("POST", "/auth/recovery/start", {});
    let last: Response | null = null;
    for (let i = 0; i < 5; i++) last = await visitor.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: `GRD1-RKAAAAAAAAAA-${"0000-".repeat(12)}000${i}` });
    expect(last!.status).toBe(403);
    const error = await errorOf(last!);
    expect(error.code).toBe("unrecoverable");
    expect(error.message).toContain("cannot be recovered");
    // Even the right code is now refused in this transaction.
    expect((await visitor.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: owner.recoveryKit.recoveryCode })).status).toBe(410);
    // An expired transaction is refused.
    const other = new ApiClient(newIdentity("slow"));
    const tx2 = await other.json("POST", "/auth/recovery/start", {});
    await app.db.prepare("UPDATE recovery_transactions SET expires_at = ? WHERE transaction_id = ?").bind(new Date(Date.now() - 1000).toISOString(), tx2.transactionId).run();
    expect((await other.post("/auth/recovery/complete", { transactionId: tx2.transactionId, recoveryCode: owner.recoveryKit.recoveryCode })).status).toBe(410);
    // The account is untouched and the real kit still works for its owner.
    expect((await owner.api.get("/v1/me")).status).toBe(200);
    // No route offers a way around the credential.
    for (const path of ["/auth/recovery/override", "/auth/recovery/email", "/auth/recovery/support", "/v1/admin/recover"]) expect((await SELF.fetch(`${APP_ORIGIN}${path}`, { method: "POST", headers: await visitor.headers() })).status).toBe(404);
  });

  it("rotating the kit retires the previous code", async () => {
    const owner = await provisionOwner();
    const rotated = await owner.api.json("POST", "/v1/recovery-kit", {});
    expect(rotated.replacedKitId).toBe(owner.recoveryKit.kitId);
    const visitor = new ApiClient(newIdentity("old-kit"));
    const tx = await visitor.json("POST", "/auth/recovery/start", {});
    expect((await visitor.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: owner.recoveryKit.recoveryCode })).status).toBe(403);
    expect((await visitor.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: rotated.kit.recoveryCode })).status).toBe(200);
  });
});

describe("account deletion is its own confirmed operation", () => {
  it("needs the confirmation step, then disables the account and its assistants", async () => {
    const owner = await provisionOwner();
    const assistant = await connectMcp(owner, { write: false, clientName: "Assistant of a deleted account" });
    const token = assistant.oauth.snapshot().accessToken;
    const asked = await owner.api.json("POST", "/v1/account/delete", {});
    expect(asked.state).toBe("confirmation_required");
    expect(asked.consequence).toContain("not the same as unlinking");
    expect((await owner.api.get("/v1/me")).status).toBe(200);
    expect((await owner.api.post("/v1/account/delete", { confirmationToken: "GRDD-not-the-token" })).status).toBe(409);
    const confirmed = await owner.api.json("POST", "/v1/account/delete", { confirmationToken: asked.confirmationToken });
    expect(confirmed.state).toBe("disabled_pending_deletion");
    const after = await owner.api.get("/v1/me");
    expect(after.status).toBe(403);
    expect((await errorOf(after)).code).toBe("account_disabled");
    const mcp = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(mcp.status).toBe(401);
  });
});
