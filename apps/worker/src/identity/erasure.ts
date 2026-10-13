import { all, createPrincipal, first, prepare, stmt, toInstant, type Db } from "@garderobe/domain";
import type { App } from "../app.ts";
import { revokeAllRemoteGrants } from "../connections/service.ts";
import { codeHash, randomBytes, toBase64Url } from "../crypto.ts";
import type { Env } from "../env.ts";
import { revokeProviderGrants } from "../mcp/grants.ts";

/**
 * Account erasure (specification section 15: account deletion is its own operation; section 6 and 11:
 * deletion covers source messages, recall projections, memories, summaries, attachments, derived media
 * and backups). A confirmed deletion removes every stored record of the owner from every store this
 * deployment controls:
 *
 *   - the conversation actor's storage and research task actors, and the owner's AI Search instance
 *     (the assistant workstream's functions; they run first because they read the owner's rows);
 *   - cached thumbnails, then every object under the owner's prefix in the private media bucket;
 *   - export packages and backups in the export bucket;
 *   - third-party grants: revocation is attempted at the provider, and the stored credentials go with the rows;
 *   - assistant (MCP) grants in the OAuth provider's KV, when the provider is reachable from this request;
 *   - every row of every D1 table that has a `user_id` column, in one transaction, including the user,
 *     the sign-in identities, credentials, audit trail and receipts.
 *
 * What remains is one `account_erasures` row with no personal data. Every step is idempotent; an
 * erasure that fails part-way stays `pending` and the scheduled sweep finishes it.
 */
export interface ErasureReport {
  state: "erased" | "pending";
  stores: Record<string, unknown>;
}

export const ownerRefOf = (env: Env, userId: string): Promise<string> => codeHash(env.STATE_SIGNING_KEY, "account-erasure", userId);

/** The statement that records a confirmed deletion; it belongs in the same batch that disables the account. */
export async function erasureRecordStatement(env: Env, userId: string, nowMs: number) {
  return stmt(
    "INSERT INTO account_erasures (erasure_id, owner_ref, pending_owner_id, state, confirmed_at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT (owner_ref) DO NOTHING",
    `ers_${toBase64Url(randomBytes(12))}`,
    await ownerRefOf(env, userId),
    userId,
    toInstant(nowMs),
  );
}

/** Every table that holds rows of an owner. Discovered from the schema, so a table added by any workstream is covered. */
export async function ownerTables(db: Db): Promise<string[]> {
  const tables = await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name");
  const owned: string[] = [];
  for (const { name } of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const column = await first<{ name: string }>(db, `SELECT name FROM pragma_table_info('${name}') WHERE name = 'user_id'`);
    if (column) owned.push(name);
  }
  return owned;
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}), limit: 500 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    deleted += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

export async function remainingOwnerRows(db: Db, userId: string): Promise<Record<string, number>> {
  const remaining: Record<string, number> = {};
  for (const table of await ownerTables(db)) {
    const row = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId);
    if ((row?.n ?? 0) > 0) remaining[table] = row!.n;
  }
  return remaining;
}

/** Erase a confirmed, disabled account. Refuses anything else. Safe to call again after a failure. */
export async function eraseAccount(app: App, userId: string, nowMs: number): Promise<ErasureReport> {
  const { db, env } = app;
  const ownerRef = await ownerRefOf(env, userId);
  const record = await first<{ erasure_id: string; state: string; pending_owner_id: string | null }>(db, "SELECT erasure_id, state, pending_owner_id FROM account_erasures WHERE owner_ref = ?", ownerRef);
  if (!record) throw new Error("account erasure was not confirmed");
  if (record.state === "erased") return { state: "erased", stores: {} };
  const user = await first<{ status: string }>(db, "SELECT status FROM users WHERE user_id = ?", userId);
  if (user && user.status !== "disabled") throw new Error("only a disabled account is erased");
  await prepare(db, stmt("UPDATE account_erasures SET attempts = attempts + 1 WHERE erasure_id = ?", record.erasure_id)).run();

  const stores: Record<string, unknown> = {};
  try {
    // A system principal built directly: the account is disabled, so the usual lookup would refuse it.
    const system = createPrincipal({ userId, actor: "system", channel: "system", scopes: ["read", "write", "admin"], authRef: `account-erasure:${record.erasure_id}` });
    stores.thirdPartyGrants = await revokeAllRemoteGrants(env, db, userId);
    stores.assistantGrantsInProvider = await revokeProviderGrants(env, userId).catch(() => "provider not reachable from this context; grants are already refused by their erased records");
    // These read the owner's rows, so they run before the rows are deleted.
    stores.conversation = app.assistant ? await app.assistant.eraseOwner(system) : "assistant not installed";
    stores.media = app.media ? await app.media.eraseOwner(userId) : "visual wardrobe not installed";
    stores.exportsAndBackups = {
      objects: (await deletePrefix(env.EXPORT_BUCKET, `exports/${userId}/`)) + (await deletePrefix(env.EXPORT_BUCKET, `backups/${userId}/`)) + (await deletePrefix(env.EXPORT_BUCKET, `backup-journals/${ownerRef}/`)),
    };

    const tables = await ownerTables(db);
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const row = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId);
      if ((row?.n ?? 0) > 0) counts[table] = row!.n;
    }
    // One transaction; foreign keys are checked at its end, so the order of the tables does not matter.
    await db.batch(
      [
        stmt("PRAGMA defer_foreign_keys = ON"),
        ...tables.map((table) => stmt(`DELETE FROM ${table} WHERE user_id = ?`, userId)),
        // Rate-limit buckets are named after what they limit; the ones naming this owner go too.
        stmt("DELETE FROM auth_rate_limits WHERE instr(bucket, ?) > 0", userId),
      ].map((s) => prepare(db, s)),
    );
    stores.database = { tables: Object.keys(counts).length, rows: Object.values(counts).reduce((a, b) => a + b, 0) };

    const remaining = await remainingOwnerRows(db, userId);
    if (Object.keys(remaining).length > 0) throw new Error(`rows remain in ${Object.keys(remaining).join(", ")}`);
    await prepare(db, stmt("UPDATE account_erasures SET state = 'erased', pending_owner_id = NULL, erased_at = ?, stores_json = ?, last_error = NULL WHERE erasure_id = ?", toInstant(nowMs), JSON.stringify(stores), record.erasure_id)).run();
    return { state: "erased", stores };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 300);
    console.error("account erasure incomplete", message);
    await prepare(db, stmt("UPDATE account_erasures SET last_error = ?, stores_json = ? WHERE erasure_id = ?", message, JSON.stringify(stores), record.erasure_id)).run();
    return { state: "pending", stores };
  }
}

/** Finish erasures that did not complete in their request (scheduled sweep). */
export async function resumeErasures(app: App, nowMs: number): Promise<number> {
  const pending = await all<{ pending_owner_id: string }>(app.db, "SELECT pending_owner_id FROM account_erasures WHERE state = 'pending' AND pending_owner_id IS NOT NULL ORDER BY confirmed_at LIMIT 5");
  let erased = 0;
  for (const row of pending) if ((await eraseAccount(app, row.pending_owner_id, nowMs)).state === "erased") erased++;
  return erased;
}

/** Whether a keyed owner reference belongs to an erased (or being erased) account. */
export async function isErasedOwnerRef(db: Db, ownerRef: string): Promise<boolean> {
  return (await first(db, "SELECT 1 AS x FROM account_erasures WHERE owner_ref = ?", ownerRef)) !== null;
}
