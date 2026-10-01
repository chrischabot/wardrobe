import type { MeResponse, RecoveryKit } from "@garderobe/contracts/ext/api";
import { all, first, prepare, stmt, toInstant, type Db, type Stmt } from "@garderobe/domain";
import type { z } from "zod";
import type { VerifiedIdentity } from "../auth/access.ts";
import { auditStatement, findIdentity, identityHash, rateLimit, type OwnerSession } from "../auth/session.ts";
import { RECOVERY_KDF, codeHash, randomBytes, randomToken, recoveryVerifier, timingSafeEqual, toBase32, toBase64Url } from "../crypto.ts";
import type { Env } from "../env.ts";
import type { App } from "../app.ts";
import { eraseAccount, erasureRecordStatement } from "./erasure.ts";
import { ApiException } from "../errors.ts";
import { revokeAllGrantStatements, revokeProviderGrants } from "../mcp/grants.ts";

type Me = z.infer<typeof MeResponse>;
type Kit = z.infer<typeof RecoveryKit>;

const INVITATION_TTL_MS = 14 * 86_400_000;
const LINK_TICKET_TTL_MS = 15 * 60_000;
const RECOVERY_TTL_MS = 15 * 60_000;
const RECOVERY_MAX_ATTEMPTS = 5;
const DELETION_CONFIRM_TTL_MS = 10 * 60_000;

/* ------------------------------------------------------------------ */
/* Guarded batches                                                      */
/* ------------------------------------------------------------------ */

/**
 * A CHECK-constrained guard as the first statement of a batch (the mechanism of specification
 * section 8): when the predicate is false SQLite raises a constraint error and D1 rolls the whole
 * batch back, so a concurrent second use of a one-time credential writes nothing.
 */
function guard(id: string, label: string, predicateSql: string, params: unknown[]): Stmt {
  return stmt(`INSERT INTO command_preconditions (command_id, label, ok) SELECT ?, ?, CASE WHEN ${predicateSql} THEN 1 ELSE 0 END`, id, label, ...params);
}
const guardCleanup = (id: string): Stmt => stmt("DELETE FROM command_preconditions WHERE command_id = ?", id);

async function runGuarded(db: Db, statements: Stmt[], onGuardFailure: () => ApiException): Promise<void> {
  try {
    await db.batch(statements.map((s) => prepare(db, s)));
  } catch (error) {
    if (String((error as Error)?.message ?? error).includes("garderobe_precondition_failed")) throw onGuardFailure();
    throw error;
  }
}

const guardId = () => `acct_${toBase64Url(randomBytes(9))}`;

/** Insert or re-activate an identity link for a user. The (issuer, subject) key maps to exactly one user. */
function linkStatement(userId: string, identity: VerifiedIdentity, now: string): Stmt {
  return stmt(
    `INSERT INTO auth_identities (user_id, issuer, subject, display_email, linked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (issuer, subject) DO UPDATE SET unlinked_at = NULL, linked_at = excluded.linked_at, display_email = excluded.display_email
     WHERE auth_identities.user_id = excluded.user_id`,
    userId,
    identity.issuer,
    identity.subject,
    identity.email,
    now,
  );
}

/** The presenting identity must not already belong to a different account. Email is never consulted. */
async function assertIdentityFree(db: Db, identity: VerifiedIdentity, forUserId: string | null): Promise<void> {
  const existing = await findIdentity(db, identity.issuer, identity.subject);
  if (!existing) return;
  if (forUserId !== null && existing.user_id === forUserId) return;
  if (existing.unlinked_at === null || existing.user_id !== forUserId) {
    throw new ApiException("forbidden", "this sign-in already belongs to a Garderobe account", { reason: "identity_in_use" });
  }
}

/* ------------------------------------------------------------------ */
/* Recovery kit                                                         */
/* ------------------------------------------------------------------ */

const STORAGE_INSTRUCTION =
  "Keep this recovery code somewhere you can reach without your Google account and without this phone: printed, or in a password manager that does not depend on that login. It works once. Anyone who has it and can sign in through the app's login page can take over this wardrobe, so do not store it in email or a shared document.";

function groupCode(secret: string): string {
  return secret.match(/.{1,4}/g)!.join("-");
}

function parseRecoveryCode(input: string): { kitId: string; normalized: string } | null {
  const compact = input.toUpperCase().replace(/\s+/g, "");
  const parts = compact.split("-");
  if (parts.length < 3 || parts[0] !== "GRD1") return null;
  const kitId = parts[1]!;
  const secret = parts.slice(2).join("");
  if (!/^RK[0-9A-Z]{8,16}$/.test(kitId) || !/^[0-9A-Z]{40,64}$/.test(secret)) return null;
  return { kitId, normalized: `${kitId}:${secret}` };
}

interface NewKit {
  kit: Kit;
  statements: Stmt[];
}

/** Build a new recovery credential: the kit for the owner (returned once) and the statements storing its verifier. */
async function newRecoveryKit(userId: string, displayName: string, nowMs: number): Promise<NewKit> {
  const now = toInstant(nowMs);
  const kitId = `RK${toBase32(randomBytes(6)).slice(0, 10)}`;
  const secret = toBase32(randomBytes(32));
  const salt = toBase64Url(randomBytes(16));
  const verifier = await recoveryVerifier(`${kitId}:${secret}`, salt);
  const recoveryCode = `GRD1-${kitId}-${groupCode(secret)}`;
  const downloadText = [
    "GARDEROBE RECOVERY KIT",
    "",
    `Account: ${displayName}`,
    `Issued: ${now}`,
    `Kit: ${kitId}`,
    "",
    "Recovery code (works once):",
    recoveryCode,
    "",
    "How to use it",
    "1. Open Garderobe and sign in with a Google account you can still use.",
    "2. Choose 'Recover my wardrobe' and enter the code above.",
    "3. Your wardrobe is attached to that sign-in. Earlier sessions and connected assistants are signed out,",
    "   and you receive a new kit; this one stops working.",
    "",
    "What it does not do",
    "It does not reconnect Gmail, Calendar or other services; reconnect those from Settings.",
    "If you lose both your sign-in and this code, the account cannot be recovered. Nobody can override that.",
    "",
    STORAGE_INSTRUCTION,
    "",
  ].join("\n");
  return {
    kit: { kitId, recoveryCode, issuedAt: now, storageInstruction: STORAGE_INSTRUCTION, downloadFileName: `garderobe-recovery-kit-${kitId}.txt`, downloadText },
    statements: [
      stmt("UPDATE recovery_credentials SET status = 'replaced', retired_at = ? WHERE user_id = ? AND status = 'active'", now, userId),
      stmt("INSERT INTO recovery_credentials (user_id, kit_id, verifier, salt, algorithm, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)", userId, kitId, verifier, salt, RECOVERY_KDF, now),
    ],
  };
}

export async function issueRecoveryKit(db: Db, session: OwnerSession, nowMs: number): Promise<{ kit: Kit; replacedKitId: string | null; receiptId: string }> {
  const previous = await first<{ kit_id: string }>(db, "SELECT kit_id FROM recovery_credentials WHERE user_id = ? AND status = 'active'", session.userId);
  const created = await newRecoveryKit(session.userId, session.displayName, nowMs);
  const audit = await auditStatement({ userId: session.userId, kind: "recovery_kit.issued", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { kitId: created.kit.kitId, replaced: previous?.kit_id ?? null }, nowMs });
  await db.batch([...created.statements, audit.statement].map((s) => prepare(db, s)));
  return { kit: created.kit, replacedKitId: previous?.kit_id ?? null, receiptId: audit.auditId };
}

/* ------------------------------------------------------------------ */
/* Me                                                                   */
/* ------------------------------------------------------------------ */

export async function describeMe(db: Db, session: OwnerSession, issuedKit: Kit | null = null): Promise<Me> {
  const identities = await all<{ issuer: string; subject: string; display_email: string | null; linked_at: string }>(
    db,
    "SELECT issuer, subject, display_email, linked_at FROM auth_identities WHERE user_id = ? AND unlinked_at IS NULL ORDER BY linked_at",
    session.userId,
  );
  const kit = await first<{ created_at: string }>(db, "SELECT created_at FROM recovery_credentials WHERE user_id = ? AND status = 'active'", session.userId);
  const user = await first<{ display_name: string }>(db, "SELECT display_name FROM users WHERE user_id = ?", session.userId);
  return {
    userId: session.userId,
    displayName: user?.display_name ?? session.displayName,
    scopes: [...session.principal.scopes],
    channel: session.principal.channel,
    identities: await Promise.all(
      identities.map(async (i) => ({
        identityId: `idn_${await identityHash(i.issuer, i.subject)}`,
        provider: providerLabel(i.issuer),
        displayEmail: i.display_email,
        linkedAt: i.linked_at,
        current: i.issuer === session.identity.issuer && i.subject === session.identity.subject,
      })),
    ),
    recoveryKit: { present: kit !== null, issuedAt: kit?.created_at ?? null },
    issuedRecoveryKit: issuedKit,
  };
}

function providerLabel(issuer: string): string {
  try {
    const host = new URL(issuer).hostname;
    return host.endsWith(".cloudflareaccess.com") ? "Google via Cloudflare Access" : `Sign-in via ${host}`;
  } catch {
    return "Sign-in";
  }
}

/* ------------------------------------------------------------------ */
/* Invitation and claim                                                 */
/* ------------------------------------------------------------------ */

/**
 * Provisioning operation (deployment script, local seed, tests): create the one-time invitation for an
 * existing internal user. The code is returned once; only its keyed hash is stored. Not reachable
 * from any HTTP route.
 */
export async function createInvitation(db: Db, env: Env, input: { userId: string; nowMs?: number; ttlMs?: number }): Promise<{ invitationId: string; invitationCode: string; expiresAt: string }> {
  const nowMs = input.nowMs ?? Date.now();
  const invitationId = `inv_${toBase64Url(randomBytes(9))}`;
  const invitationCode = `GRDI-${randomToken(32)}`;
  const expiresAt = toInstant(nowMs + (input.ttlMs ?? INVITATION_TTL_MS));
  await prepare(
    db,
    stmt("INSERT INTO owner_invitations (invitation_id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", invitationId, input.userId, await codeHash(env.STATE_SIGNING_KEY, "invitation", invitationCode), toInstant(nowMs), expiresAt),
  ).run();
  return { invitationId, invitationCode, expiresAt };
}

/** Claim the invited owner account: links the presenting identity and issues the first recovery kit. */
export async function claimAccount(db: Db, env: Env, identity: VerifiedIdentity, invitationCode: string, nowMs: number): Promise<{ userId: string; displayName: string; kit: Kit }> {
  const subjectKey = await identityHash(identity.issuer, identity.subject);
  await rateLimit(db, `claim:${subjectKey}`, 5, 900, nowMs);
  await rateLimit(db, "claim:all", 60, 900, nowMs);
  const now = toInstant(nowMs);
  const hash = await codeHash(env.STATE_SIGNING_KEY, "invitation", invitationCode);
  const invitation = await first<{ invitation_id: string; user_id: string; expires_at: string; claimed_at: string | null; display_name: string; status: string }>(
    db,
    "SELECT i.invitation_id, i.user_id, i.expires_at, i.claimed_at, u.display_name, u.status FROM owner_invitations i JOIN users u ON u.user_id = i.user_id WHERE i.code_hash = ?",
    hash,
  );
  const refuse = async (reason: string): Promise<never> => {
    const audit = await auditStatement({ userId: null, kind: "account.claim", outcome: "refused", identity, channel: "web", detail: { reason }, nowMs });
    await prepare(db, audit.statement).run();
    throw new ApiException("forbidden", "that invitation code was not accepted", { reason: "invitation_not_accepted" });
  };
  if (!invitation || invitation.claimed_at !== null || invitation.status !== "active") return refuse("unknown_or_used");
  if (Date.parse(invitation.expires_at) <= nowMs) return refuse("expired");
  await assertIdentityFree(db, identity, invitation.user_id);

  const id = guardId();
  const kit = await newRecoveryKit(invitation.user_id, invitation.display_name, nowMs);
  const audit = await auditStatement({ userId: invitation.user_id, kind: "account.claim", outcome: "ok", identity, channel: "web", detail: { invitationId: invitation.invitation_id, kitId: kit.kit.kitId }, nowMs });
  await runGuarded(
    db,
    [
      guard(id, "invitation unclaimed", "(SELECT claimed_at IS NULL AND expires_at > ? FROM owner_invitations WHERE invitation_id = ?) = 1", [now, invitation.invitation_id]),
      stmt("UPDATE owner_invitations SET claimed_at = ?, claimed_issuer = ?, claimed_subject = ? WHERE invitation_id = ?", now, identity.issuer, subjectKey, invitation.invitation_id),
      linkStatement(invitation.user_id, identity, now),
      ...kit.statements,
      audit.statement,
      guardCleanup(id),
    ],
    () => new ApiException("forbidden", "that invitation code was not accepted", { reason: "invitation_not_accepted" }),
  );
  return { userId: invitation.user_id, displayName: invitation.display_name, kit: kit.kit };
}

/* ------------------------------------------------------------------ */
/* Linking and unlinking identities                                     */
/* ------------------------------------------------------------------ */

export async function createLinkTicket(db: Db, env: Env, session: OwnerSession, nowMs: number): Promise<{ linkCode: string; expiresAt: string }> {
  await rateLimit(db, `link-ticket:${session.userId}`, 10, 3600, nowMs);
  const linkCode = `GRDL-${randomToken(32)}`;
  const expiresAt = toInstant(nowMs + LINK_TICKET_TTL_MS);
  const audit = await auditStatement({ userId: session.userId, kind: "identity.link_ticket", outcome: "ok", identity: session.identity, channel: session.principal.channel, nowMs });
  await db.batch(
    [
      stmt("INSERT INTO identity_link_tickets (ticket_id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", `lnk_${toBase64Url(randomBytes(9))}`, session.userId, await codeHash(env.STATE_SIGNING_KEY, "link", linkCode), toInstant(nowMs), expiresAt),
      audit.statement,
    ].map((s) => prepare(db, s)),
  );
  return { linkCode, expiresAt };
}

/** The new identity presents a ticket the signed-in owner created. Matching email proves nothing and is not checked. */
export async function completeLink(db: Db, env: Env, identity: VerifiedIdentity, linkCode: string, nowMs: number): Promise<{ userId: string; displayName: string }> {
  const subjectKey = await identityHash(identity.issuer, identity.subject);
  await rateLimit(db, `link:${subjectKey}`, 5, 900, nowMs);
  const now = toInstant(nowMs);
  const ticket = await first<{ ticket_id: string; user_id: string; expires_at: string; used_at: string | null; display_name: string; status: string }>(
    db,
    "SELECT t.ticket_id, t.user_id, t.expires_at, t.used_at, u.display_name, u.status FROM identity_link_tickets t JOIN users u ON u.user_id = t.user_id WHERE t.code_hash = ?",
    await codeHash(env.STATE_SIGNING_KEY, "link", linkCode),
  );
  if (!ticket || ticket.used_at !== null || ticket.status !== "active" || Date.parse(ticket.expires_at) <= nowMs) {
    const audit = await auditStatement({ userId: null, kind: "identity.link", outcome: "refused", identity, channel: "web", detail: { reason: "ticket_not_accepted" }, nowMs });
    await prepare(db, audit.statement).run();
    throw new ApiException("forbidden", "that link code was not accepted", { reason: "link_code_not_accepted" });
  }
  await assertIdentityFree(db, identity, ticket.user_id);
  const id = guardId();
  const audit = await auditStatement({ userId: ticket.user_id, kind: "identity.link", outcome: "ok", identity, channel: "web", detail: { identity: `idn_${subjectKey}` }, nowMs });
  await runGuarded(
    db,
    [
      guard(id, "link ticket unused", "(SELECT used_at IS NULL AND expires_at > ? FROM identity_link_tickets WHERE ticket_id = ?) = 1", [now, ticket.ticket_id]),
      stmt("UPDATE identity_link_tickets SET used_at = ? WHERE ticket_id = ?", now, ticket.ticket_id),
      linkStatement(ticket.user_id, identity, now),
      audit.statement,
      guardCleanup(id),
    ],
    () => new ApiException("forbidden", "that link code was not accepted", { reason: "link_code_not_accepted" }),
  );
  return { userId: ticket.user_id, displayName: ticket.display_name };
}

/**
 * Unlink an identity. The wardrobe, its history and its provider connections are untouched. The last
 * identity can only be unlinked while a recovery kit exists, otherwise the account would be lost.
 */
export async function unlinkIdentityById(db: Db, session: OwnerSession, identityId: string, nowMs: number): Promise<void> {
  const identities = await all<{ issuer: string; subject: string }>(db, "SELECT issuer, subject FROM auth_identities WHERE user_id = ? AND unlinked_at IS NULL", session.userId);
  let target: { issuer: string; subject: string } | null = null;
  for (const i of identities) if (`idn_${await identityHash(i.issuer, i.subject)}` === identityId) target = i;
  if (!target) throw new ApiException("not_found", "that sign-in is not linked to this account");
  if (identities.length === 1) {
    const kit = await first(db, "SELECT kit_id FROM recovery_credentials WHERE user_id = ? AND status = 'active'", session.userId);
    if (!kit) throw new ApiException("precondition_failed", "this is the only sign-in and there is no recovery kit; unlinking it would lose the account", { reason: "last_identity_without_recovery" });
  }
  const audit = await auditStatement({ userId: session.userId, kind: "identity.unlink", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { identity: identityId }, nowMs });
  await db.batch(
    [stmt("UPDATE auth_identities SET unlinked_at = ? WHERE user_id = ? AND issuer = ? AND subject = ?", toInstant(nowMs), session.userId, target.issuer, target.subject), audit.statement].map((s) => prepare(db, s)),
  );
}

/* ------------------------------------------------------------------ */
/* Sessions                                                             */
/* ------------------------------------------------------------------ */

function floorStatement(userId: string, notBeforeMs: number, reason: string, exempt: { hash: string; notBeforeMs: number } | null, nowMs: number): Stmt {
  return stmt(
    `INSERT INTO auth_session_floors (user_id, not_before, reason, exempt_identity_hash, exempt_not_before, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET not_before = excluded.not_before, reason = excluded.reason, exempt_identity_hash = excluded.exempt_identity_hash, exempt_not_before = excluded.exempt_not_before, updated_at = excluded.updated_at`,
    userId,
    toInstant(notBeforeMs),
    reason,
    exempt?.hash ?? null,
    exempt ? toInstant(exempt.notBeforeMs) : null,
    toInstant(nowMs),
  );
}

/** Sign out everywhere: every session authenticated before now is refused, except the one doing this. */
export async function revokeSessions(db: Db, session: OwnerSession, nowMs: number): Promise<{ sessionsRevokedBefore: string; receiptId: string }> {
  const hash = await identityHash(session.identity.issuer, session.identity.subject);
  const audit = await auditStatement({ userId: session.userId, kind: "sessions.revoke", outcome: "ok", identity: session.identity, channel: session.principal.channel, nowMs });
  await db.batch([floorStatement(session.userId, nowMs, "owner_sign_out_everywhere", { hash, notBeforeMs: session.identity.issuedAtMs }, nowMs), audit.statement].map((s) => prepare(db, s)));
  return { sessionsRevokedBefore: toInstant(nowMs), receiptId: audit.auditId };
}

/* ------------------------------------------------------------------ */
/* Recovery after losing the login identity                             */
/* ------------------------------------------------------------------ */

export async function startRecovery(db: Db, identity: VerifiedIdentity, nowMs: number): Promise<{ transactionId: string; expiresAt: string; attemptsRemaining: number }> {
  const subjectKey = await identityHash(identity.issuer, identity.subject);
  await rateLimit(db, `recovery-start:${subjectKey}`, 5, 3600, nowMs);
  await rateLimit(db, "recovery-start:all", 100, 3600, nowMs);
  const transactionId = `rtx_${randomToken(18)}`;
  const expiresAt = toInstant(nowMs + RECOVERY_TTL_MS);
  const audit = await auditStatement({ userId: null, kind: "recovery.start", outcome: "ok", identity, channel: "web", nowMs });
  await db.batch(
    [
      stmt(
        "INSERT INTO recovery_transactions (transaction_id, issuer, subject, display_email, created_at, expires_at, attempts, max_attempts, status) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'open')",
        transactionId,
        identity.issuer,
        identity.subject,
        identity.email,
        toInstant(nowMs),
        expiresAt,
        RECOVERY_MAX_ATTEMPTS,
      ),
      audit.statement,
    ].map((s) => prepare(db, s)),
  );
  return { transactionId, expiresAt, attemptsRemaining: RECOVERY_MAX_ATTEMPTS };
}

export interface RecoveryOutcome {
  userId: string;
  identityLinked: boolean;
  sessionsRevokedBefore: string;
  assistantGrantsRevoked: number;
  previousIdentitiesUnlinked: number;
  replacementKit: Kit;
  receiptId: string;
  connectionsUnchanged: true;
}

/**
 * Complete recovery: prove possession of the one-time credential inside an open transaction that the
 * SAME verified identity started. On success, in one batch: the credential is spent, the identity is
 * bound to the existing internal user, earlier sessions and every consumer-assistant grant are
 * revoked, and a replacement kit is issued. Email, biography or wardrobe knowledge are never inputs.
 * Third-party connections are untouched: a revoked Google grant stays revoked.
 */
export async function completeRecovery(
  db: Db,
  env: Env,
  identity: VerifiedIdentity,
  input: { transactionId: string; recoveryCode: string; unlinkPreviousIdentities: boolean },
  nowMs: number,
): Promise<RecoveryOutcome> {
  const subjectKey = await identityHash(identity.issuer, identity.subject);
  await rateLimit(db, `recovery:${subjectKey}`, 10, 3600, nowMs);
  await rateLimit(db, "recovery:all", 200, 3600, nowMs);
  const now = toInstant(nowMs);

  const tx = await first<{ issuer: string; subject: string; expires_at: string; attempts: number; max_attempts: number; status: string }>(
    db,
    "SELECT issuer, subject, expires_at, attempts, max_attempts, status FROM recovery_transactions WHERE transaction_id = ?",
    input.transactionId,
  );
  // A transaction is usable only by the identity that opened it.
  if (!tx || tx.issuer !== identity.issuer || tx.subject !== identity.subject) throw new ApiException("not_found", "that recovery attempt was not found; start again");
  if (tx.status !== "open") throw new ApiException("expired", "that recovery attempt is finished; start again", { status: tx.status });
  if (Date.parse(tx.expires_at) <= nowMs) {
    await prepare(db, stmt("UPDATE recovery_transactions SET status = 'expired' WHERE transaction_id = ? AND status = 'open'", input.transactionId)).run();
    throw new ApiException("expired", "that recovery attempt has expired; start again");
  }

  const fail = async (reason: string, kitId: string | null): Promise<never> => {
    const audit = await auditStatement({ userId: null, kind: "recovery.complete", outcome: "refused", identity, channel: "web", detail: { reason, kitId, transactionId: input.transactionId }, nowMs });
    await db.batch(
      [
        stmt("UPDATE recovery_transactions SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE status END WHERE transaction_id = ? AND status = 'open'", input.transactionId),
        audit.statement,
      ].map((s) => prepare(db, s)),
    );
    const remaining = Math.max(0, tx.max_attempts - tx.attempts - 1);
    if (remaining === 0) {
      throw new ApiException("unrecoverable", "the recovery credential was not accepted and no attempts remain. Without a linked sign-in or a valid recovery code this account cannot be recovered through this route.", { attemptsRemaining: 0 });
    }
    throw new ApiException("forbidden", "the recovery credential was not accepted", { reason: "recovery_credential_not_accepted", attemptsRemaining: remaining });
  };

  const parsed = parseRecoveryCode(input.recoveryCode);
  if (!parsed) return fail("malformed", null);
  await rateLimit(db, `recovery-kit:${parsed.kitId}`, 10, 3600, nowMs);
  const credential = await first<{ user_id: string; verifier: string; salt: string; status: string; display_name: string; user_status: string }>(
    db,
    "SELECT c.user_id, c.verifier, c.salt, c.status, u.display_name, u.status AS user_status FROM recovery_credentials c JOIN users u ON u.user_id = c.user_id WHERE c.kit_id = ?",
    parsed.kitId,
  );
  // Always derive, so an unknown kit costs the same as a wrong secret.
  const derived = await recoveryVerifier(parsed.normalized, credential?.salt ?? "AAAAAAAAAAAAAAAAAAAAAA");
  if (!credential || !timingSafeEqual(derived, credential.verifier)) return fail("mismatch", parsed.kitId);
  if (credential.status !== "active") return fail(`credential_${credential.status}`, parsed.kitId);
  if (credential.user_status !== "active") return fail("account_disabled", parsed.kitId);

  const userId = credential.user_id;
  await assertIdentityFree(db, identity, userId);

  const previous = await all<{ issuer: string; subject: string }>(db, "SELECT issuer, subject FROM auth_identities WHERE user_id = ? AND unlinked_at IS NULL", userId);
  const toUnlink = input.unlinkPreviousIdentities ? previous.filter((p) => !(p.issuer === identity.issuer && p.subject === identity.subject)) : [];
  const grants = await all<{ grant_id: string }>(db, "SELECT grant_id FROM mcp_grants WHERE user_id = ? AND status = 'active'", userId);
  const kit = await newRecoveryKit(userId, credential.display_name, nowMs);
  const id = guardId();
  const audit = await auditStatement({
    userId,
    kind: "recovery.complete",
    outcome: "ok",
    identity,
    channel: "web",
    detail: { usedKitId: parsed.kitId, replacementKitId: kit.kit.kitId, grantsRevoked: grants.length, identitiesUnlinked: toUnlink.length, transactionId: input.transactionId },
    nowMs,
  });
  await runGuarded(
    db,
    [
      guard(
        id,
        "recovery credential unused and transaction open",
        "(SELECT status FROM recovery_credentials WHERE kit_id = ?) = 'active' AND (SELECT status FROM recovery_transactions WHERE transaction_id = ?) = 'open'",
        [parsed.kitId, input.transactionId],
      ),
      stmt("UPDATE recovery_credentials SET status = 'used', retired_at = ? WHERE user_id = ? AND kit_id = ?", now, userId, parsed.kitId),
      stmt("UPDATE recovery_transactions SET status = 'completed', user_id = ?, completed_at = ?, attempts = attempts + 1 WHERE transaction_id = ?", userId, now, input.transactionId),
      linkStatement(userId, identity, now),
      ...toUnlink.map((p) => stmt("UPDATE auth_identities SET unlinked_at = ? WHERE user_id = ? AND issuer = ? AND subject = ?", now, userId, p.issuer, p.subject)),
      floorStatement(userId, nowMs, "account_recovery", { hash: subjectKey, notBeforeMs: identity.issuedAtMs }, nowMs),
      ...revokeAllGrantStatements(userId, "account_recovery", now),
      // newRecoveryKit's first statement retires any other active credential; the used one is already 'used'.
      ...kit.statements,
      audit.statement,
      guardCleanup(id),
    ],
    () => new ApiException("expired", "that recovery credential has already been used", { reason: "credential_used" }),
  );
  // Provider-side records (KV) are cleaned up after the authoritative D1 decision; D1 alone already blocks the grants.
  await revokeProviderGrants(env, userId);
  return {
    userId,
    identityLinked: true,
    sessionsRevokedBefore: now,
    assistantGrantsRevoked: grants.length,
    previousIdentitiesUnlinked: toUnlink.length,
    replacementKit: kit.kit,
    receiptId: audit.auditId,
    connectionsUnchanged: true,
  };
}

/* ------------------------------------------------------------------ */
/* Account deletion (separate, confirmed operation)                     */
/* ------------------------------------------------------------------ */

const DELETION_CONSEQUENCE =
  "Confirming deletes this account for good: sign-in, scheduled preparation, calendar updates and connected assistants stop at once, and the stored wardrobe, conversation, photographs, exports, backups, connections and sign-in links are erased. It cannot be undone. Export your wardrobe first if you want a copy. This is not the same as unlinking a sign-in.";

export async function requestAccountDeletion(
  app: App,
  session: OwnerSession,
  confirmationToken: string | undefined,
  nowMs: number,
): Promise<{ state: "confirmation_required" | "disabled_pending_deletion" | "erased"; confirmationToken: string | null; expiresAt: string | null; consequence: string }> {
  const { db, env } = app;
  await rateLimit(db, `account-delete:${session.userId}`, 10, 3600, nowMs);
  const now = toInstant(nowMs);
  if (!confirmationToken) {
    const token = `GRDD-${randomToken(24)}`;
    const expiresAt = toInstant(nowMs + DELETION_CONFIRM_TTL_MS);
    const audit = await auditStatement({ userId: session.userId, kind: "account.delete_requested", outcome: "ok", identity: session.identity, channel: session.principal.channel, nowMs });
    await db.batch(
      [
        stmt(
          "INSERT INTO account_deletions (user_id, token_hash, requested_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, requested_at = excluded.requested_at, expires_at = excluded.expires_at, confirmed_at = NULL",
          session.userId,
          await codeHash(env.STATE_SIGNING_KEY, "account-delete", token),
          now,
          expiresAt,
        ),
        audit.statement,
      ].map((s) => prepare(db, s)),
    );
    return { state: "confirmation_required", confirmationToken: token, expiresAt, consequence: DELETION_CONSEQUENCE };
  }
  const row = await first<{ token_hash: string; expires_at: string; confirmed_at: string | null }>(db, "SELECT token_hash, expires_at, confirmed_at FROM account_deletions WHERE user_id = ?", session.userId);
  const presented = await codeHash(env.STATE_SIGNING_KEY, "account-delete", confirmationToken);
  if (!row || row.confirmed_at !== null || !timingSafeEqual(row.token_hash, presented)) throw new ApiException("confirmation_required", "that confirmation was not accepted; request deletion again");
  if (Date.parse(row.expires_at) <= nowMs) throw new ApiException("expired", "that confirmation has expired; request deletion again");
  const id = guardId();
  const audit = await auditStatement({ userId: session.userId, kind: "account.delete_confirmed", outcome: "ok", identity: session.identity, channel: session.principal.channel, nowMs });
  await runGuarded(
    db,
    [
      guard(id, "deletion unconfirmed", "(SELECT confirmed_at IS NULL FROM account_deletions WHERE user_id = ?) = 1", [session.userId]),
      stmt("UPDATE account_deletions SET confirmed_at = ? WHERE user_id = ?", now, session.userId),
      stmt("UPDATE users SET status = 'disabled' WHERE user_id = ?", session.userId),
      floorStatement(session.userId, nowMs + 1000, "account_deletion", null, nowMs),
      ...revokeAllGrantStatements(session.userId, "account_deletion", now),
      await erasureRecordStatement(env, session.userId, nowMs),
      audit.statement,
      guardCleanup(id),
    ],
    () => new ApiException("confirmation_required", "that confirmation was already used"),
  );
  await revokeProviderGrants(env, session.userId);
  // The account is disabled from this point whatever happens next; erasure that cannot finish here is
  // finished by the scheduled sweep.
  const erasure = await eraseAccount(app, session.userId, nowMs);
  return { state: erasure.state === "erased" ? "erased" : "disabled_pending_deletion", confirmationToken: null, expiresAt: null, consequence: DELETION_CONSEQUENCE };
}
