import type { Channel, Scope } from "@garderobe/contracts";
import { first, resolvePrincipal, stmt, toInstant, type Db, type Principal, type Stmt } from "@garderobe/domain";
import { sha256Hex, toBase64Url, randomBytes } from "../crypto.ts";
import { configOf, type Env } from "../env.ts";
import { ApiException } from "../errors.ts";
import { verifyAccessAssertion, type VerifiedIdentity } from "./access.ts";

export const OWNER_SCOPES: Scope[] = ["read", "write", "admin"];

export interface OwnerSession {
  identity: VerifiedIdentity;
  principal: Principal;
  userId: string;
  displayName: string;
}

/** Stable, non-reversible handle of an identity (used for unlinking and audit). */
export async function identityHash(issuer: string, subject: string): Promise<string> {
  return (await sha256Hex(`identity\u0000${issuer}\u0000${subject}`)).slice(0, 32);
}

/**
 * Browser requests that change state must come from the app's own origin. A native client sends no
 * Origin header; a cross-site page always does.
 */
export function assertSameOrigin(request: Request, env: Env): void {
  if (request.method === "GET" || request.method === "HEAD") return;
  const config = configOf(env);
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== config.appOrigin) throw new ApiException("forbidden", "this request did not come from the app", { reason: "cross_origin" });
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") throw new ApiException("forbidden", "this request did not come from the app", { reason: "cross_site" });
}

/** Authenticate a verified identity without requiring it to be linked (claim, link completion, recovery). */
export async function authenticateIdentity(request: Request, env: Env): Promise<VerifiedIdentity> {
  const identity = await verifyAccessAssertion(request, env);
  assertSameOrigin(request, env);
  return identity;
}

export interface IdentityRow {
  user_id: string;
  status: string;
  display_name: string;
  unlinked_at: string | null;
}

export async function findIdentity(db: Db, issuer: string, subject: string): Promise<IdentityRow | null> {
  return first<IdentityRow>(
    db,
    "SELECT a.user_id, a.unlinked_at, u.status, u.display_name FROM auth_identities a JOIN users u ON u.user_id = a.user_id WHERE a.issuer = ? AND a.subject = ?",
    issuer,
    subject,
  );
}

/**
 * Authenticate the owner: a verified Access assertion whose (issuer, subject) is linked to an active
 * internal user, in a session that has not been revoked. The channel comes from how the request was
 * authenticated (browser cookie session = `web`, native bearer = `ios`), never from the body.
 */
export async function authenticateOwner(request: Request, env: Env, db: Db): Promise<OwnerSession> {
  const identity = await authenticateIdentity(request, env);
  const row = await findIdentity(db, identity.issuer, identity.subject);
  if (!row || row.unlinked_at !== null) {
    throw new ApiException("identity_not_linked", "this sign-in is not linked to a Garderobe account", { next: ["claim", "link", "recovery"] });
  }
  if (row.status !== "active") throw new ApiException("account_disabled", "this account is disabled");
  const floor = await first<{ not_before: string; exempt_identity_hash: string | null; exempt_not_before: string | null }>(
    db,
    "SELECT not_before, exempt_identity_hash, exempt_not_before FROM auth_session_floors WHERE user_id = ?",
    row.user_id,
  );
  if (floor) {
    const exempt = floor.exempt_identity_hash !== null && floor.exempt_identity_hash === (await identityHash(identity.issuer, identity.subject));
    const notBefore = Date.parse(exempt && floor.exempt_not_before ? floor.exempt_not_before : floor.not_before);
    // Assertions carry second resolution; compare on whole seconds so the revoking session itself is not cut off.
    if (Math.floor(identity.issuedAtMs / 1000) < Math.floor(notBefore / 1000)) {
      throw new ApiException("session_revoked", "this session was signed out; sign in again");
    }
  }
  const channel: Channel = identity.hasCookie ? "web" : "ios";
  const authRef = `access:${await identityHash(identity.issuer, identity.subject)}`;
  const principal = await resolvePrincipal(db, { issuer: identity.issuer, subject: identity.subject }, { actor: "owner", channel, scopes: [...OWNER_SCOPES], authRef });
  return { identity, principal, userId: row.user_id, displayName: row.display_name };
}

/* ------------------------------------------------------------------ */
/* Rate limits and audit                                                */
/* ------------------------------------------------------------------ */

/**
 * Fixed-window counter in D1. Counts the attempt first, then decides, so concurrent attempts cannot
 * slip past the limit together.
 */
export async function rateLimit(db: Db, bucket: string, limit: number, windowSeconds: number, nowMs: number): Promise<void> {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  const row = await db
    .prepare("INSERT INTO auth_rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 1) > limit) {
    const retryAfter = Math.max(1, windowStart + windowSeconds - Math.floor(nowMs / 1000));
    throw new ApiException("rate_limited", "too many attempts; try again later", { retryAfterSeconds: retryAfter }, { "Retry-After": String(retryAfter) });
  }
}

export interface AuditInput {
  userId: string | null;
  kind: string;
  outcome: "ok" | "refused";
  identity?: { issuer: string; subject: string } | null;
  channel: string;
  detail?: Record<string, unknown>;
  nowMs: number;
}

/** Build the audit-receipt statement (to include in the same batch as the change it records). */
export async function auditStatement(input: AuditInput): Promise<{ auditId: string; statement: Stmt }> {
  const auditId = `aud_${toBase64Url(randomBytes(12))}`;
  const subjectHash = input.identity ? await identityHash(input.identity.issuer, input.identity.subject) : null;
  return {
    auditId,
    statement: stmt(
      "INSERT INTO account_audit (audit_id, user_id, kind, outcome, at, actor_issuer, actor_subject_hash, channel, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      auditId,
      input.userId,
      input.kind,
      input.outcome,
      toInstant(input.nowMs),
      input.identity?.issuer ?? null,
      subjectHash,
      input.channel,
      JSON.stringify(input.detail ?? {}),
    ),
  };
}
