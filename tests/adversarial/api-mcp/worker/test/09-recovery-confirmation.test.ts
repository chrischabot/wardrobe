import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createUser } from "@garderobe/domain";
import { createInvitation } from "../../../../../apps/worker/src/identity/service.ts";
import {
  APP_ORIGIN,
  ApiClient,
  MCP_ORIGIN,
  connectMcp,
  createWorld,
  defect,
  errorOf,
  fingerprint,
  newIdentity,
  provisionOwner,
  rowCounts,
  sql,
  syntheticOwner,
  testApp,
  toolResult,
  type TestOwner,
  type World,
} from "../src/harness.ts";

/*
 * THREAT CLASS 9: account recovery and confirmation abuse.
 *
 * Recovery, linking, claiming, signing out everywhere and account deletion are the operations that move
 * an account between identities or end it. Each is attacked here as someone who holds part of what is
 * needed (a signed-in identity of their own, a transaction identifier, a spent or stolen code, a stale
 * confirmation) and as a careless client that sends the same request twice at once.
 *
 * Every owner in this file except `world.real` is a LABELLED SYNTHETIC test owner created for one test.
 * Recovery codes, link codes and confirmation tokens are never printed; assertions compare outcomes,
 * hashes and stored rows. (`createInvitation` is the product's own provisioning function: there is no
 * HTTP route that issues an invitation, which is itself asserted below.)
 */
let world: World;

const fresh = (label: string) => new ApiClient(newIdentity(label));

const linkedIdentities = async (userId: string) => (await sql<{ subject: string }>("SELECT subject FROM auth_identities WHERE user_id = ? AND unlinked_at IS NULL", userId)).map((r) => r.subject);
const activeKits = async (userId: string) => (await sql<{ kit_id: string }>("SELECT kit_id FROM recovery_credentials WHERE user_id = ? AND status = 'active'", userId)).map((r) => r.kit_id);

async function startRecovery(client: ApiClient): Promise<string> {
  return (await client.json("POST", "/auth/recovery/start", {})).transactionId as string;
}

/** A well-formed code that matches no kit. Each has its own kit identifier, so the per-kit rate limit of one test never meets another's. */
const WRONG_CODE = (n: number) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const kit = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % 32]).join("");
  return `GRD1-RK${kit}-${"0000-".repeat(12)}${String(n).padStart(4, "0")}`;
};

beforeAll(async () => {
  world = await createWorld();
});

/* ------------------------------------------------------------------ */

describe("recovery with a stolen, spent or guessed credential", () => {
  it("spends the code exactly once when two identities present it at the same moment", async () => {
    const owner = await syntheticOwner("Synthetic owner (parallel recovery fixture)");
    const before = await rowCounts(owner);
    const a = fresh("adv-recover-a");
    const b = fresh("adv-recover-b");
    const [txA, txB] = [await startRecovery(a), await startRecovery(b)];
    const [ra, rb] = await Promise.all([
      a.post("/auth/recovery/complete", { transactionId: txA, recoveryCode: owner.recoveryKit.recoveryCode, unlinkPreviousIdentities: true }),
      b.post("/auth/recovery/complete", { transactionId: txB, recoveryCode: owner.recoveryKit.recoveryCode, unlinkPreviousIdentities: true }),
    ]);
    const statuses = [ra.status, rb.status].sort();
    await ra.text();
    await rb.text();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect(statuses[1]).toBeLessThan(500);
    // Exactly one of the two identities owns the account now; exactly one replacement kit is active.
    const linked = await linkedIdentities(owner.userId);
    expect(linked).toHaveLength(1);
    expect([a.identity.subject, b.identity.subject]).toContain(linked[0]);
    expect(await activeKits(owner.userId)).toHaveLength(1);
    expect((await sql("SELECT 1 FROM recovery_credentials WHERE user_id = ? AND status = 'used'", owner.userId)).length).toBe(1);
    // The wardrobe is the same: no garment, stock or wear row was touched by either attempt.
    const after = await rowCounts(owner);
    for (const table of ["garments", "stock_balances", "stock_events", "daily_wears", "commands"]) expect(after[table], table).toBe(before[table]);
    const loser = linked[0] === a.identity.subject ? b : a;
    expect((await loser.get("/v1/me")).status).toBe(403);
  });

  it("[fixed R09-2] a recovery transaction compares at most its five allowed guesses even when they arrive at the same moment", async () => {
    const owner = await syntheticOwner("Synthetic owner (parallel guessing fixture)");
    const guesser = fresh("adv-burst-guesser");
    const tx = await startRecovery(guesser);
    // Ten wrong guesses at the same moment against one transaction.
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => guesser.post("/auth/recovery/complete", { transactionId: tx, recoveryCode: WRONG_CODE(i) })));
    const statuses: string[] = [];
    for (const r of burst) statuses.push(`${r.status}:${String(((await r.json().catch(() => ({}))) as any)?.error?.code ?? "")}`);
    // Every wrong guess is refused as a client error, never a server error and never accepted.
    for (const s of statuses) expect(Number(s.split(":")[0]), statuses.join(" ")).toBeGreaterThanOrEqual(400);
    for (const s of statuses) expect(Number(s.split(":")[0]), statuses.join(" ")).toBeLessThan(500);
    const row = (await sql<{ max_attempts: number }>("SELECT max_attempts FROM recovery_transactions WHERE transaction_id = ?", tx))[0]!;
    // Guesses that were actually compared with a credential, as the audit trail recorded them.
    const evaluated = await sql("SELECT 1 FROM account_audit WHERE kind = 'recovery.complete' AND outcome = 'refused' AND detail_json LIKE ?", `%${tx}%`);
    expect(await linkedIdentities(owner.userId)).toEqual([owner.identity.subject]);
    // At least one guess was really compared (the burst was not refused wholesale before any credential was read),
    // and no more than the transaction allows.
    expect(evaluated.length, statuses.join(" ")).toBeGreaterThanOrEqual(1);
    expect(evaluated.length).toBeLessThanOrEqual(row.max_attempts);
  });

  it("does not give a transaction more than its five attempts, and counts guesses per sign-in across transactions", async () => {
    const owner = await syntheticOwner("Synthetic owner (guessing fixture)");
    const guesser = fresh("adv-guesser");
    const tx = await startRecovery(guesser);
    for (let i = 0; i < 5; i++) {
      const r = await guesser.post("/auth/recovery/complete", { transactionId: tx, recoveryCode: WRONG_CODE(i) });
      expect(r.status).toBe(403);
      await r.text();
    }
    const row = (await sql<{ attempts: number; max_attempts: number; status: string }>("SELECT attempts, max_attempts, status FROM recovery_transactions WHERE transaction_id = ?", tx))[0]!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(row.max_attempts);
    // The right code is refused in the exhausted transaction, and the account is untouched.
    const late = await guesser.post("/auth/recovery/complete", { transactionId: tx, recoveryCode: owner.recoveryKit.recoveryCode });
    expect(late.status).toBeGreaterThanOrEqual(400);
    await late.text();
    expect(await linkedIdentities(owner.userId)).toEqual([owner.identity.subject]);
    expect((await owner.api.get("/v1/me")).status).toBe(200);
    // More transactions do not buy unlimited guesses: this sign-in is rate limited.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const started = await guesser.post("/auth/recovery/start", {});
      statuses.push(started.status);
      if (!started.ok) {
        await started.text();
        continue;
      }
      const { transactionId } = (await started.json()) as { transactionId: string };
      const r = await guesser.post("/auth/recovery/complete", { transactionId, recoveryCode: WRONG_CODE(100 + i) });
      statuses.push(r.status);
      await r.text();
    }
    expect(statuses).toContain(429);
    // The owner's own kit still works afterwards for someone else's fresh sign-in: guessing locked nobody out.
    const rightful = fresh("adv-rightful");
    const done = await rightful.post("/auth/recovery/complete", { transactionId: await startRecovery(rightful), recoveryCode: owner.recoveryKit.recoveryCode });
    expect(done.status).toBe(200);
    await done.text();
  });

  it("does not let another sign-in use, probe or burn someone else's recovery transaction", async () => {
    const owner = await syntheticOwner("Synthetic owner (transaction fixture)");
    const rightful = fresh("adv-tx-owner");
    const thief = fresh("adv-tx-thief");
    const tx = await startRecovery(rightful);
    for (let i = 0; i < 7; i++) {
      const r = await thief.post("/auth/recovery/complete", { transactionId: tx, recoveryCode: i === 6 ? owner.recoveryKit.recoveryCode : WRONG_CODE(i) });
      expect([404, 429]).toContain(r.status);
      await r.text();
    }
    const row = (await sql<{ attempts: number; status: string }>("SELECT attempts, status FROM recovery_transactions WHERE transaction_id = ?", tx))[0]!;
    expect(row).toEqual({ attempts: 0, status: "open" });
    expect(await linkedIdentities(owner.userId)).toEqual([owner.identity.subject]);
    // An unknown transaction and a known one of somebody else are indistinguishable.
    const unknown = await thief.post("/auth/recovery/complete", { transactionId: "rtx_does_not_exist_000000000000", recoveryCode: WRONG_CODE(1) });
    expect([404, 429]).toContain(unknown.status);
    await unknown.text();
    const done = await rightful.post("/auth/recovery/complete", { transactionId: tx, recoveryCode: owner.recoveryKit.recoveryCode });
    expect(done.status).toBe(200);
    await done.text();
  });

  it("does not move a signed-in owner into another account, and does not spend the victim's code on the attempt", async () => {
    const victim = await syntheticOwner("Synthetic owner (recovery victim fixture)");
    const attacker = world.synthetic; // already owns an account
    const before = { victim: await linkedIdentities(victim.userId), attacker: await linkedIdentities(attacker.userId) };
    const tx = await startRecovery(attacker.api);
    const attempt = await attacker.api.post("/auth/recovery/complete", { transactionId: tx, recoveryCode: victim.recoveryKit.recoveryCode, unlinkPreviousIdentities: true });
    expect(attempt.status).toBe(403);
    expect((await errorOf(attempt)).details.reason).toBe("identity_in_use");
    expect(await linkedIdentities(victim.userId)).toEqual(before.victim);
    expect(await linkedIdentities(attacker.userId)).toEqual(before.attacker);
    expect((await attacker.api.json("GET", "/v1/me")).userId).toBe(attacker.userId);
    expect((await victim.api.get("/v1/me")).status).toBe(200);
    expect(await activeKits(victim.userId)).toEqual([victim.recoveryKit.kitId]);
  });

  it("lets the owner take the account back after a thief used a stolen kit, and leaves the thief with nothing", async () => {
    const owner = await syntheticOwner("Synthetic owner (stolen kit fixture)");
    await connectMcp(owner, { write: true, clientName: "Owner's assistant before the theft (test)" });
    const wardrobe = await fingerprint(owner);
    // The owner linked a second sign-in in advance (the specification's "link a second identity in advance").
    const second = fresh("adv-owner-second");
    const ticket = await owner.api.json("POST", "/v1/identities/link", {});
    expect((await second.post("/auth/link/complete", { linkCode: ticket.linkCode })).status).toBe(200);

    // The thief has the kit and a sign-in of their own. They do not ask to unlink anything.
    const thief = fresh("adv-thief");
    const stolen = await thief.json("POST", "/auth/recovery/complete", { transactionId: await startRecovery(thief), recoveryCode: owner.recoveryKit.recoveryCode });
    expect(stolen.userId).toBe(owner.userId);
    // The theft is visible: an audit receipt exists and the owner's assistants were disconnected.
    expect((await sql("SELECT 1 FROM account_audit WHERE user_id = ? AND kind = 'recovery.complete' AND outcome = 'ok'", owner.userId)).length).toBe(1);
    expect((await sql("SELECT 1 FROM mcp_grants WHERE user_id = ? AND status = 'active'", owner.userId)).length).toBe(0);

    // The owner signs in again with a sign-in that is still linked, sees the stranger, removes it and signs everyone else out.
    const ownerAgain = new ApiClient(owner.identity);
    const me = await ownerAgain.json("GET", "/v1/me");
    expect(me.userId).toBe(owner.userId);
    expect(me.identities).toHaveLength(3);
    const strangers = me.identities.filter((i: any) => !i.current && i.displayEmail === thief.identity.email);
    expect(strangers).toHaveLength(1);
    expect((await ownerAgain.post("/v1/identities/unlink", { identityId: strangers[0].identityId })).status).toBe(200);
    const rotated = await ownerAgain.json("POST", "/v1/recovery-kit", {});
    expect((await ownerAgain.post("/v1/sessions/revoke", {})).status).toBe(200);

    // The thief: no session, and neither the original kit nor the kit the thief was issued works any more.
    expect((await thief.get("/v1/me")).status).toBe(403);
    for (const code of [owner.recoveryKit.recoveryCode, stolen.replacementKit.recoveryCode]) {
      const again = fresh("adv-thief-again");
      const r = await again.post("/auth/recovery/complete", { transactionId: await startRecovery(again), recoveryCode: code });
      expect(r.status).toBe(403);
      await r.text();
      expect((await again.get("/v1/me")).status).toBe(403);
    }
    expect(await activeKits(owner.userId)).toEqual([rotated.kit.kitId]);
    expect((await linkedIdentities(owner.userId)).sort()).toEqual([owner.identity.subject, second.identity.subject].sort());
    // Nothing in the wardrobe changed through any of this.
    const after = await fingerprint(owner);
    for (const key of ["garments", "stock_balances", "stock_events", "daily_wears", "restriction_rows", "style_document_rows"]) expect(after[key], key).toEqual(wardrobe[key]);
  });

  it("answers malformed recovery input with a refusal, never a server error, and never by another route", async () => {
    const owner = await syntheticOwner("Synthetic owner (malformed recovery fixture)");
    const code = owner.recoveryKit.recoveryCode;
    const secretPart = code.split("-").slice(2).join("").slice(0, 16);
    // Each case names the refusal it must get: a body the request schema refuses, a transaction that does not exist,
    // or a code that is not accepted (with attempts left, because every case has a transaction of its own).
    interface Refusal {
      status: number;
      code: string;
      reason?: string;
    }
    const SCHEMA: Refusal = { status: 400, code: "invalid_command" };
    const NO_TRANSACTION: Refusal = { status: 404, code: "not_found" };
    const NOT_ACCEPTED: Refusal = { status: 403, code: "forbidden", reason: "recovery_credential_not_accepted" };
    const cases: [string, (tx: string) => unknown, Refusal][] = [
      ["an empty body", () => ({}), SCHEMA],
      ["no recovery code", (tx) => ({ transactionId: tx }), SCHEMA],
      ["no transaction", () => ({ recoveryCode: code }), SCHEMA],
      ["an empty code", (tx) => ({ transactionId: tx, recoveryCode: "" }), SCHEMA],
      ["a null code", (tx) => ({ transactionId: tx, recoveryCode: null }), SCHEMA],
      ["the code inside an array", (tx) => ({ transactionId: tx, recoveryCode: [code] }), SCHEMA],
      ["an operator object as the code", (tx) => ({ transactionId: tx, recoveryCode: { $ne: "" } }), SCHEMA],
      ["an operator object as the transaction", () => ({ transactionId: { $gt: "" }, recoveryCode: code }), SCHEMA],
      ["a 200,000-character code", (tx) => ({ transactionId: tx, recoveryCode: "A".repeat(200_000) }), SCHEMA],
      ["SQL after the transaction", (tx) => ({ transactionId: `${tx}' OR '1'='1`, recoveryCode: code }), NO_TRANSACTION],
      ["SQL after the code", (tx) => ({ transactionId: tx, recoveryCode: `${code}' OR '1'='1` }), NOT_ACCEPTED],
      ["look-alike hyphens", (tx) => ({ transactionId: tx, recoveryCode: code.replace(/-/g, "\u2010") }), NOT_ACCEPTED],
      ["the code less its last character", (tx) => ({ transactionId: tx, recoveryCode: code.slice(0, -1) }), NOT_ACCEPTED],
      ["the code with a character added", (tx) => ({ transactionId: tx, recoveryCode: `${code}0` }), NOT_ACCEPTED],
    ];
    // (The right code with extra fields such as userId, force or override is not malformed: the extra fields are ignored and
    // the code is valid, so it would recover the account. It is not sent here.)
    for (const [index, [what, input, expected]] of cases.entries()) {
      // A fresh identity and transaction per case: no case spends another's attempts or meets another's rate limit.
      const visitor = fresh(`adv-malformed-${index}`);
      const tx = await startRecovery(visitor);
      const r = await visitor.post("/auth/recovery/complete", input(tx));
      const text = await r.text();
      expect(r.status, `${what}: ${text.slice(0, 160)}`).toBe(expected.status);
      const error = (JSON.parse(text) as { error?: { code?: string; details?: Record<string, unknown> } }).error;
      expect(error?.code, what).toBe(expected.code);
      if (expected.reason) expect(error?.details?.["reason"], what).toBe(expected.reason);
      expect(text, what).not.toContain(secretPart);
      expect((await visitor.get("/v1/me")).status, `${what}: the visitor is not signed in to any account`).toBe(403);
    }
    expect(await linkedIdentities(owner.userId)).toEqual([owner.identity.subject]);
    const visitor = fresh("adv-malformed-routes");
    for (const path of ["/auth/recovery/override", "/auth/recovery/email", "/auth/recovery/reset", "/auth/recovery/support", "/v1/admin/recover", "/v1/recovery/override", "/auth/invitations", "/v1/invitations", "/auth/claim/reissue"]) {
      const r = await SELF.fetch(`${APP_ORIGIN}${path}`, { method: "POST", headers: await visitor.headers({ "Content-Type": "application/json" }), body: JSON.stringify({ userId: owner.userId, email: owner.identity.email }) });
      expect(r.status, path).toBe(404);
      await r.text();
    }
    // The recovery routes are not served on the MCP hostname at all.
    const wrongHost = await visitor.with({ origin: MCP_ORIGIN }).post("/auth/recovery/start", {});
    expect(wrongHost.status).toBe(401);
    await wrongHost.text();
  });
});

describe("claiming and linking under abuse", () => {
  it("links exactly one identity when two claim the same invitation at the same moment", async () => {
    const app = await testApp();
    const { userId } = await createUser(app.db, { displayName: "Synthetic invited owner (parallel claim fixture)", isSynthetic: true });
    const invitation = await createInvitation(app.db, app.env, { userId });
    const a = fresh("adv-claim-a");
    const b = fresh("adv-claim-b");
    const results = await Promise.all([a, b, a, b].map((c) => c.post("/auth/claim", { invitationCode: invitation.invitationCode })));
    const statuses = results.map((r) => r.status);
    for (const r of results) await r.text();
    expect(statuses.every((s) => s < 500)).toBe(true);
    const linked = await linkedIdentities(userId);
    expect(linked).toHaveLength(1);
    expect(await activeKits(userId)).toHaveLength(1);
    // Whoever lost holds no account; the invitation cannot be used a third time.
    const loser = linked[0] === a.identity.subject ? b : a;
    expect((await loser.get("/v1/me")).status).toBe(403);
    const third = await fresh("adv-claim-c").post("/auth/claim", { invitationCode: invitation.invitationCode });
    expect(third.status).toBe(403);
    await third.text();
  });

  it("does not let an invitation, a link code or a recovery code be used as one of the others, or across accounts", async () => {
    const a = await syntheticOwner("Synthetic owner A (code confusion fixture)");
    const app = await testApp();
    const { userId: invitedUser } = await createUser(app.db, { displayName: "Synthetic invited owner (code confusion fixture)", isSynthetic: true });
    const invitation = await createInvitation(app.db, app.env, { userId: invitedUser });
    const ticket = await a.api.json("POST", "/v1/identities/link", {});
    const visitor = fresh("adv-confusion");
    const tx = await startRecovery(visitor);
    const attempts: [string, unknown][] = [
      ["/auth/claim", { invitationCode: ticket.linkCode }],
      ["/auth/claim", { invitationCode: a.recoveryKit.recoveryCode }],
      ["/auth/link/complete", { linkCode: invitation.invitationCode }],
      ["/auth/link/complete", { linkCode: a.recoveryKit.recoveryCode }],
      ["/auth/recovery/complete", { transactionId: tx, recoveryCode: invitation.invitationCode }],
      ["/auth/recovery/complete", { transactionId: tx, recoveryCode: ticket.linkCode }],
    ];
    for (const [path, body] of attempts) {
      const r = await visitor.post(path, body);
      expect(r.status, path).toBeGreaterThanOrEqual(400);
      expect(r.status, path).toBeLessThan(500);
      await r.text();
    }
    expect((await visitor.get("/v1/me")).status).toBe(403);
    expect(await linkedIdentities(a.userId)).toEqual([a.identity.subject]);
    expect(await linkedIdentities(invitedUser)).toEqual([]);
    // A sign-in that already owns an account cannot be pulled into another by a link code or an invitation.
    const b = world.synthetic;
    for (const [path, body] of [["/auth/link/complete", { linkCode: ticket.linkCode }], ["/auth/claim", { invitationCode: invitation.invitationCode }]] as [string, unknown][]) {
      const r = await b.api.post(path, body);
      expect(r.status, path).toBe(403);
      await r.text();
    }
    expect((await b.api.json("GET", "/v1/me")).userId).toBe(b.userId);
    expect(await linkedIdentities(a.userId)).toEqual([a.identity.subject]);
    // The link code was not spent by the refused attempts: the owner's intended second sign-in still links, once.
    const [first, second] = await Promise.all([fresh("adv-link-1"), fresh("adv-link-2")].map((c) => c.post("/auth/link/complete", { linkCode: ticket.linkCode })));
    expect([first!.status, second!.status].sort()).toEqual([200, 403]);
    await first!.text();
    await second!.text();
    expect(await linkedIdentities(a.userId)).toHaveLength(2);
  });

  it("refuses an expired link code and one created before the owner signed out everywhere is still only the owner's to give", async () => {
    const owner = await syntheticOwner("Synthetic owner (expired link fixture)");
    const ticket = await owner.api.json("POST", "/v1/identities/link", {});
    await sql("UPDATE identity_link_tickets SET expires_at = ? WHERE user_id = ? RETURNING ticket_id", new Date(Date.now() - 1000).toISOString(), owner.userId);
    const late = await fresh("adv-late-link").post("/auth/link/complete", { linkCode: ticket.linkCode });
    expect(late.status).toBe(403);
    await late.text();
    expect(await linkedIdentities(owner.userId)).toEqual([owner.identity.subject]);
    // Link codes are rate limited per owner: a compromised session cannot mint them without bound.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await owner.api.post("/v1/identities/link", {});
      statuses.push(r.status);
      await r.text();
    }
    expect(statuses).toContain(429);
  });

  it("[fixed R09-3] never leaves an account with no sign-in and no recovery kit, even when both sign-ins are unlinked at the same moment", async () => {
    const owner = await syntheticOwner("Synthetic owner (parallel unlink fixture)");
    const second = fresh("adv-unlink-second");
    const ticket = await owner.api.json("POST", "/v1/identities/link", {});
    expect((await second.post("/auth/link/complete", { linkCode: ticket.linkCode })).status).toBe(200);
    // No recovery kit is active (as after a kit was retired and before a new one was stored).
    await sql("UPDATE recovery_credentials SET status = 'replaced' WHERE user_id = ? RETURNING kit_id", owner.userId);
    const ids = (await owner.api.json("GET", "/v1/me")).identities as { identityId: string; current: boolean }[];
    const mine = ids.find((i) => i.current)!.identityId;
    const theirs = ids.find((i) => !i.current)!.identityId;
    // Each session unlinks the OTHER sign-in at the same moment.
    const [x, y] = await Promise.all([owner.api.post("/v1/identities/unlink", { identityId: theirs }), second.post("/v1/identities/unlink", { identityId: mine })]);
    await x.text();
    await y.text();
    expect(x.status).toBeLessThan(500);
    expect(y.status).toBeLessThan(500);
    const remaining = await linkedIdentities(owner.userId);
    expect(remaining.length, "an account with no linked sign-in and no recovery kit can never be reached again").toBeGreaterThanOrEqual(1);
  });
});

describe("signing out everywhere", () => {
  it("refuses every session that existed before, for every linked sign-in, on every surface", async () => {
    const owner = await syntheticOwner("Synthetic owner (sign-out fixture)");
    const older = owner.api.with({ issuedAgoSeconds: 900 });
    const current = owner.api.with({ issuedAgoSeconds: 5 });
    expect((await older.get("/v1/me")).status).toBe(200);
    expect((await current.post("/v1/sessions/revoke", {})).status).toBe(200);
    const before = await fingerprint(owner);
    for (const [method, path, body] of [
      ["GET", "/v1/me", undefined],
      ["GET", "/v1/wardrobe", undefined],
      ["POST", "/v1/commands", { type: "care.mark_dirty", payload: { items: [{ garmentId: "shirt-gold", quantity: 1 }] }, idempotencyKey: `adv-stale-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios" } }],
      ["POST", "/v1/recovery-kit", {}],
      ["POST", "/v1/identities/link", {}],
      ["POST", "/v1/account/delete", {}],
      ["POST", "/v1/sessions/revoke", {}],
    ] as [string, string, unknown][]) {
      const r = await older.request(method, path, body === undefined ? {} : { body });
      expect(r.status, path).toBe(401);
      expect((await errorOf(r)).code, path).toBe("session_revoked");
    }
    expect(await fingerprint(owner)).toEqual(before);
    expect((await current.get("/v1/me")).status).toBe(200);
    expect(await activeKits(owner.userId)).toEqual([owner.recoveryKit.kitId]);
  });

  it("[fixed R09-1] signing out everywhere also refuses another device's session of the same sign-in that began after the session that asked", async () => {
    // The phone's session is two hours old. A second session of the SAME sign-in began ten minutes ago on
    // another device (or was stolen from it). The owner presses "sign out everywhere" on the phone.
    const owner = await syntheticOwner("Synthetic owner (same sign-in sessions fixture)");
    const phone = owner.api.with({ issuedAgoSeconds: 7200, expiresInSeconds: 86_400 });
    const elsewhere = owner.api.with({ issuedAgoSeconds: 600 });
    expect((await elsewhere.get("/v1/me")).status).toBe(200);
    expect((await phone.post("/v1/sessions/revoke", {})).status).toBe(200);
    expect((await phone.get("/v1/me")).status).toBe(200); // the session that asked stays
    const response = await elsewhere.get("/v1/me");
    await response.text();
    expect(response.status).toBe(401);
  });
});

describe("account deletion needs its own, fresh, owner-bound confirmation", () => {
  it("refuses a confirmation from another owner, a superseded or expired one, and a guess; the account and its data stay", async () => {
    const owner = await syntheticOwner("Synthetic owner (deletion confirmation fixture)");
    const attacker = world.synthetic;
    const before = await fingerprint(owner);
    const attackerBefore = await fingerprint(attacker);
    const first = await owner.api.json("POST", "/v1/account/delete", {});
    expect(first.state).toBe("confirmation_required");
    // 1. The attacker presents the victim's confirmation on its own session: it is not the attacker's confirmation.
    const cross = await attacker.api.post("/v1/account/delete", { confirmationToken: first.confirmationToken });
    expect(cross.status).toBeGreaterThanOrEqual(400);
    await cross.text();
    expect((await attacker.api.get("/v1/me")).status).toBe(200);
    expect(await fingerprint(attacker)).toEqual(attackerBefore);
    // 2. And the attacker's own confirmation does not delete the victim.
    const attackerAsk = await attacker.api.json("POST", "/v1/account/delete", {});
    const swapped = await owner.api.post("/v1/account/delete", { confirmationToken: attackerAsk.confirmationToken });
    expect(swapped.status).toBeGreaterThanOrEqual(400);
    await swapped.text();
    // 3. Asking again supersedes the first confirmation.
    const second = await owner.api.json("POST", "/v1/account/delete", {});
    const superseded = await owner.api.post("/v1/account/delete", { confirmationToken: first.confirmationToken });
    expect(superseded.status).toBeGreaterThanOrEqual(400);
    await superseded.text();
    // 4. Guessed and altered tokens, while the owner's confirmation is live: each is refused as a wrong token
    // (`confirmation_required`, apps/worker/src/identity/service.ts), not as an expired one. The route allows ten
    // deletion requests an owner per hour (`auth_rate_limits`); its counter is cleared before each phase below so
    // that each refusal is the one the phase names, not the rate limit.
    const resetDeleteLimit = () => sql("DELETE FROM auth_rate_limits WHERE bucket = ? RETURNING bucket", `account-delete:${owner.userId}`);
    await resetDeleteLimit();
    const live = await sql<{ expires_at: string }>("SELECT expires_at FROM account_deletions WHERE user_id = ?", owner.userId);
    expect(live.length, "the owner's confirmation is stored").toBeGreaterThan(0);
    for (const row of live) expect(Date.parse(row.expires_at), "the owner's confirmation is still live").toBeGreaterThan(Date.now());
    for (const token of ["GRDD-guess", "true", "1", `${second.confirmationToken}x`, second.confirmationToken.slice(0, -1), second.confirmationToken.toLowerCase(), ` ${second.confirmationToken}`, "%", "' OR 1=1 --"]) {
      const r = await owner.api.post("/v1/account/delete", { confirmationToken: token });
      const body = (await r.json().catch(() => ({}))) as { error?: { code?: string } };
      expect(r.status, token.slice(0, 12)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      expect(body.error?.code, `${token.slice(0, 12)}: ${JSON.stringify(body.error)}`).toBe("confirmation_required");
    }
    expect((await sql<{ status: string }>("SELECT status FROM users WHERE user_id = ?", owner.userId))[0]!.status, "a guess deleted the account").toBe("active");
    // 5. The genuine, still-current confirmation, once expired: refused as expired.
    await resetDeleteLimit();
    await sql("UPDATE account_deletions SET expires_at = ? WHERE user_id = ? RETURNING user_id", new Date(Date.now() - 1000).toISOString(), owner.userId);
    const expired = await owner.api.post("/v1/account/delete", { confirmationToken: second.confirmationToken });
    const expiredBody = (await expired.json().catch(() => ({}))) as { error?: { code?: string } };
    expect(expired.status).toBeGreaterThanOrEqual(400);
    expect(expiredBody.error?.code, JSON.stringify(expiredBody.error)).toBe("expired");
    // 6. Malformed shapes (a body without a token asks for a new confirmation; none deletes anything).
    await resetDeleteLimit();
    for (const body of [{ confirmationToken: true }, { confirmationToken: [second.confirmationToken] }, { confirm: true }, { confirmed: "yes", force: true }]) {
      const r = await owner.api.post("/v1/account/delete", body);
      await r.text();
      expect(r.status).toBeLessThan(500);
    }
    expect((await owner.api.get("/v1/me")).status).toBe(200);
    expect((await sql<{ status: string }>("SELECT status FROM users WHERE user_id = ?", owner.userId))[0]!.status).toBe("active");
    expect(await fingerprint(owner)).toEqual(before);
    // The attacker's own pending request did not delete the attacker either.
    expect((await sql<{ status: string }>("SELECT status FROM users WHERE user_id = ?", attacker.userId))[0]!.status).toBe("active");
  });

  it("erases once when the confirmation is sent twice at the same moment, and nothing brings the account back", async () => {
    const owner = await syntheticOwner("Synthetic owner (deletion fixture)");
    const mcp = await connectMcp(owner, { write: true, clientName: "Assistant of an account about to be deleted (test)" });
    const token = mcp.oauth.snapshot().accessToken;
    const second = fresh("adv-deleted-second");
    const ticket = await owner.api.json("POST", "/v1/identities/link", {});
    expect((await second.post("/auth/link/complete", { linkCode: ticket.linkCode })).status).toBe(200);
    const spare = await owner.api.json("POST", "/v1/identities/link", {});
    const erasuresBefore = new Set((await sql<{ erasure_id: string }>("SELECT erasure_id FROM account_erasures")).map((r) => r.erasure_id));
    const asked = await owner.api.json("POST", "/v1/account/delete", {});
    const [a, b] = await Promise.all([owner.api.post("/v1/account/delete", { confirmationToken: asked.confirmationToken }), owner.api.post("/v1/account/delete", { confirmationToken: asked.confirmationToken })]);
    const statuses = [a.status, b.status].sort();
    await a.text();
    await b.text();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeLessThan(500);
    // Exactly one erasure record was added by the two confirmations, and it is this account's: either still
    // pending for this owner, or erased (when the pending owner is cleared).
    const added = (await sql<{ erasure_id: string; state: string; pending_owner_id: string | null }>("SELECT erasure_id, state, pending_owner_id FROM account_erasures")).filter((r) => !erasuresBefore.has(r.erasure_id));
    expect(added.length, "erasure records added by the two simultaneous confirmations").toBe(1);
    if (added[0]!.state === "pending") expect(added[0]!.pending_owner_id).toBe(owner.userId);
    else expect(added[0]).toMatchObject({ state: "erased", pending_owner_id: null });
    // Every owner table is empty for this account.
    const counts = await rowCounts(owner);
    const left = Object.entries(counts).filter(([, n]) => n > 0).map(([table]) => table);
    expect(left).toEqual([]);
    // No way back in: both sign-ins, the spare link code, the recovery kit, the assistant's token.
    expect((await owner.api.get("/v1/me")).status).toBe(403);
    expect((await second.get("/v1/me")).status).toBe(403);
    const relink = await fresh("adv-deleted-relink").post("/auth/link/complete", { linkCode: spare.linkCode });
    expect(relink.status).toBe(403);
    await relink.text();
    const visitor = fresh("adv-deleted-recover");
    const recovery = await visitor.post("/auth/recovery/complete", { transactionId: await startRecovery(visitor), recoveryCode: owner.recoveryKit.recoveryCode });
    expect(recovery.status).toBeGreaterThanOrEqual(400);
    await recovery.text();
    expect((await visitor.get("/v1/me")).status).toBe(403);
    const viaMcp = await SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(viaMcp.status).toBe(401);
    await viaMcp.text();
    // The other owners are untouched.
    expect((await world.real.api.get("/v1/me")).status).toBe(200);
    expect((await world.synthetic.api.get("/v1/me")).status).toBe(200);
  });

  it("cannot be started or confirmed by a connected assistant, a cross-site page or a signed-out session", async () => {
    const owner = await provisionOwner({ displayName: "Synthetic owner (deletion surfaces fixture)" });
    const mcp = await connectMcp(owner, { write: true, clientName: "Assistant asking for deletion (test)" });
    const asked = await owner.api.json("POST", "/v1/account/delete", {});
    // The assistant: no tool, no command type, no route.
    const tools = (await mcp.client.listTools()).tools.map((t) => t.name);
    expect(tools.some((t) => /delete|erase|account/i.test(t))).toBe(false);
    for (const type of ["account.delete", "account.erase", "user.delete", "identity.unlink", "sessions.revoke", "recovery_kit.issue"]) {
      // A structured refusal from the tool; a thrown protocol error is not an answer and fails the test.
      const result = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type, payload: { confirmationToken: asked.confirmationToken }, idempotencyKey: `adv-del-${crypto.randomUUID()}` } }));
      expect(result.ok, `${type}: ${JSON.stringify(result.data ?? null).slice(0, 200)}`).toBe(false);
      expect(["unknown_command", "forbidden", "confirmation_required"], `${type}: ${JSON.stringify(result.error)}`).toContain(result.error?.code);
    }
    const bearer = mcp.oauth.snapshot().accessToken;
    for (const origin of [APP_ORIGIN, MCP_ORIGIN]) {
      const r = await SELF.fetch(`${origin}/v1/account/delete`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirmationToken: asked.confirmationToken }) });
      expect(r.status, origin).toBeGreaterThanOrEqual(401);
      await r.text();
    }
    // A cross-site page with the owner's browser cookies.
    const web = owner.api.with({ client: "web" });
    const crossSite = await SELF.fetch(`${APP_ORIGIN}/v1/account/delete`, { method: "POST", headers: await web.headers({ "Content-Type": "application/json", Origin: "https://evil.example" }), body: JSON.stringify({ confirmationToken: asked.confirmationToken }) });
    expect(crossSite.status).toBe(403);
    await crossSite.text();
    // A session that was signed out.
    const stale = owner.api.with({ issuedAgoSeconds: 900 });
    expect((await owner.api.with({ issuedAgoSeconds: 5 }).post("/v1/sessions/revoke", {})).status).toBe(200);
    const signedOut = await stale.post("/v1/account/delete", { confirmationToken: asked.confirmationToken });
    expect(signedOut.status).toBe(401);
    await signedOut.text();
    expect((await sql<{ status: string }>("SELECT status FROM users WHERE user_id = ?", owner.userId))[0]!.status).toBe("active");
    expect((await sql<{ confirmed_at: string | null }>("SELECT confirmed_at FROM account_deletions WHERE user_id = ?", owner.userId))[0]!.confirmed_at).toBeNull();
    await mcp.close();
  });
});

describe("the recovery kit itself", () => {
  it("is shown once, stored only as a verifier, never returned again, and never written to an audit row or receipt", async () => {
    const owner = await syntheticOwner("Synthetic owner (kit storage fixture)");
    const secret = owner.recoveryKit.recoveryCode.split("-").slice(2).join("");
    const rotated = await owner.api.json("POST", "/v1/recovery-kit", {});
    const rotatedSecret = (rotated.kit.recoveryCode as string).split("-").slice(2).join("");
    // A failed and a successful use, so that audit rows exist.
    const visitor = fresh("adv-kit-audit");
    const tx = await startRecovery(visitor);
    // The replaced kit is refused as not accepted, with attempts left; the current kit recovers this account.
    const stale = await visitor.post("/auth/recovery/complete", { transactionId: tx, recoveryCode: owner.recoveryKit.recoveryCode });
    expect(stale.status, "the replaced kit").toBe(403);
    const staleError = await errorOf(stale);
    expect(staleError.code, "the replaced kit").toBe("forbidden");
    expect(staleError.details.reason, "the replaced kit").toBe("recovery_credential_not_accepted");
    const recovered = await visitor.post("/auth/recovery/complete", { transactionId: tx, recoveryCode: rotated.kit.recoveryCode });
    const recoveredText = await recovered.text();
    expect(recovered.status, "the current kit").toBe(200);
    const outcome = JSON.parse(recoveredText) as { userId: string; replacementKit: { recoveryCode: string } };
    expect(outcome.userId, "the account recovered").toBe(owner.userId);
    // The replacement kit is shown once, in this response, and nowhere afterwards either. Each code is searched for in
    // every form: the text is compared with hyphens, spaces and case removed, so the complete hyphenated code, the code
    // without hyphens and any 16-character run of its secret part are all found.
    const replacementSecret = outcome.replacementKit.recoveryCode.split("-").slice(2).join("");
    const squash = (text: string): string => text.replace(/[-\s\u2010-\u2015]/g, "").toUpperCase();
    const needles = [secret, rotatedSecret, replacementSecret].map((s) => squash(s).slice(0, 16));
    for (const path of ["/v1/me", "/v1/settings", "/v1/recovery", "/v1/meta", "/v1/commands"]) {
      const response = await visitor.get(path);
      const text = await response.text();
      expect(response.status, `${path}: ${text.slice(0, 160)}`).toBe(200);
      for (const needle of needles) expect(squash(text).includes(needle), path).toBe(false);
    }
    // Every text column of every table: none of the three codes, in whole or in part.
    const tables = await sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'");
    const hits: string[] = [];
    // The column values are read as text and compared in JavaScript under the same squash() as the responses above,
    // so both scans look for exactly the same thing (no long nested SQL expression).
    for (const { name } of tables) {
      const columns = await sql<{ name: string; type: string }>(`SELECT name, type FROM pragma_table_info('${name}')`);
      for (const column of columns.filter((c) => /TEXT|CHAR|CLOB|^$/i.test(c.type))) {
        const values = await sql<{ v: string | null }>(`SELECT CAST("${column.name}" AS TEXT) AS v FROM "${name}" WHERE "${column.name}" IS NOT NULL`);
        const squashed = values.map((r) => squash(String(r.v ?? "")));
        for (const needle of needles) if (squashed.some((v) => v.includes(needle))) hits.push(`${name}.${column.name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
