import type { AssistantGrant, McpScope } from "@garderobe/contracts/ext/api";
import { all, first, json, prepare, stmt, toInstant, type Db, type Stmt } from "@garderobe/domain";
import type { z } from "zod";
import { auditStatement, type OwnerSession } from "../auth/session.ts";
import type { Env } from "../env.ts";
import { ApiException } from "../errors.ts";

type Grant = z.infer<typeof AssistantGrant>;
type Scope = z.infer<typeof McpScope>;

/**
 * Consumer-assistant grants. The Workers OAuth provider stores clients, grants and token hashes in KV;
 * this table is the application's authoritative, immediately effective decision. Every protected MCP
 * operation reads this row, so a token the provider still accepts is refused the moment the owner
 * disconnects the assistant (specification section 13).
 */
interface GrantRow {
  grant_id: string;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  client_domain: string | null;
  scopes_json: string;
  status: "active" | "revoked";
  version: number;
  granted_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function toGrant(row: GrantRow): Grant {
  const scopes = json<Scope[]>(row.scopes_json, []);
  return {
    grantId: row.grant_id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    clientDomain: row.client_domain,
    scopes,
    access: scopes.includes("wardrobe.write") ? "read_write" : "read_only",
    status: row.status,
    grantedAt: row.granted_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    version: row.version,
  };
}

const COLUMNS = "grant_id, client_id, client_name, client_uri, client_domain, scopes_json, status, version, granted_at, last_used_at, revoked_at";

export function recordGrantStatement(input: {
  userId: string;
  grantId: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  clientDomain: string | null;
  redirectHost: string;
  scopes: Scope[];
  now: string;
}): Stmt {
  return stmt(
    "INSERT INTO mcp_grants (user_id, grant_id, client_id, client_name, client_uri, client_domain, redirect_host, scopes_json, status, version, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)",
    input.userId,
    input.grantId,
    input.clientId,
    input.clientName,
    input.clientUri,
    input.clientDomain,
    input.redirectHost,
    JSON.stringify(input.scopes),
    input.now,
  );
}

/** Earlier grants of the same client installation are superseded by a new consent (mirrors the provider's default). */
export function supersedeGrantsStatement(userId: string, clientId: string, redirectHost: string, now: string): Stmt {
  return stmt(
    "UPDATE mcp_grants SET status = 'revoked', version = version + 1, revoked_at = ?, revoked_reason = 'superseded_by_new_consent' WHERE user_id = ? AND client_id = ? AND redirect_host = ? AND status = 'active'",
    now,
    userId,
    clientId,
    redirectHost,
  );
}

export function revokeAllGrantStatements(userId: string, reason: string, now: string): Stmt[] {
  return [stmt("UPDATE mcp_grants SET status = 'revoked', version = version + 1, revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND status = 'active'", now, reason, userId)];
}

/**
 * Remove the provider's KV records for a user's grants (all, or the listed application grant IDs).
 * Best effort by design: the D1 row is what makes a grant ineffective; this removes the stale tokens.
 */
export async function revokeProviderGrants(env: Env, userId: string, grantIds?: string[]): Promise<number> {
  const helpers = env.OAUTH_PROVIDER;
  if (!helpers) return 0;
  let revoked = 0;
  let cursor: string | undefined;
  do {
    const page = await helpers.listUserGrants(userId, cursor ? { cursor } : undefined);
    for (const grant of page.items) {
      const applicationGrantId = (grant.metadata as { grantId?: string } | null)?.grantId;
      if (grantIds && (!applicationGrantId || !grantIds.includes(applicationGrantId))) continue;
      await helpers.revokeGrant(grant.id, userId);
      revoked++;
    }
    cursor = page.cursor;
  } while (cursor);
  return revoked;
}

export async function listGrants(db: Db, userId: string): Promise<Grant[]> {
  const rows = await all<GrantRow>(db, `SELECT ${COLUMNS} FROM mcp_grants WHERE user_id = ? ORDER BY status, granted_at DESC LIMIT 200`, userId);
  return rows.map(toGrant);
}

/** Settings > Connected assistants > Disconnect. Effective for the very next MCP request. */
export async function disconnectGrant(db: Db, env: Env, session: OwnerSession, grantId: string, nowMs: number): Promise<Grant> {
  const row = await first<GrantRow>(db, `SELECT ${COLUMNS} FROM mcp_grants WHERE user_id = ? AND grant_id = ?`, session.userId, grantId);
  if (!row) throw new ApiException("not_found", "that connected assistant was not found");
  if (row.status === "active") {
    const audit = await auditStatement({ userId: session.userId, kind: "assistant.disconnect", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { grantId, clientId: row.client_id }, nowMs });
    await db.batch(
      [
        stmt("UPDATE mcp_grants SET status = 'revoked', version = version + 1, revoked_at = ?, revoked_reason = 'owner_disconnect' WHERE user_id = ? AND grant_id = ? AND status = 'active'", toInstant(nowMs), session.userId, grantId),
        audit.statement,
      ].map((s) => prepare(db, s)),
    );
    await revokeProviderGrants(env, session.userId, [grantId]);
  }
  return toGrant((await first<GrantRow>(db, `SELECT ${COLUMNS} FROM mcp_grants WHERE user_id = ? AND grant_id = ?`, session.userId, grantId))!);
}

export interface ActiveGrant {
  grantId: string;
  clientId: string;
  scopes: Scope[];
  version: number;
}

/**
 * The check made on every protected MCP operation. The provider has validated the token; this decides
 * whether the application still honours the grant, and with which scopes (the D1 record, not the token).
 */
export async function requireActiveGrant(db: Db, userId: string, grantId: string, nowMs: number): Promise<ActiveGrant> {
  const row = await first<{ client_id: string; scopes_json: string; status: string; version: number; last_used_at: string | null; user_status: string }>(
    db,
    "SELECT g.client_id, g.scopes_json, g.status, g.version, g.last_used_at, u.status AS user_status FROM mcp_grants g JOIN users u ON u.user_id = g.user_id WHERE g.user_id = ? AND g.grant_id = ?",
    userId,
    grantId,
  );
  if (!row || row.status !== "active") throw new ApiException("grant_revoked", "this assistant is no longer connected to Garderobe; connect it again from the assistant");
  if (row.user_status !== "active") throw new ApiException("account_disabled", "this account is disabled");
  if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) > 60_000) {
    await prepare(db, stmt("UPDATE mcp_grants SET last_used_at = ? WHERE user_id = ? AND grant_id = ? AND status = 'active'", toInstant(nowMs), userId, grantId)).run();
  }
  return { grantId, clientId: row.client_id, scopes: json<Scope[]>(row.scopes_json, []), version: row.version };
}
