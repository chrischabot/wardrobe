/**
 * Portable export and clean import of the daily service's per-owner records. The shared weather cache
 * holds no personal data and is not exported. Import restores rows into an EMPTY owner with their IDs
 * and enqueues no external effect: a restored board is not re-projected to Calendar by the import.
 */
import { all, assertPrincipal, CommandError, first, prepare, requireScope, stmt, type Db, type Principal } from "@garderobe/domain";

/** Per-owner tables, in an order that satisfies their foreign keys on import. */
export const DAILY_TABLES = [
  "weather_snapshots",
  "calendar_snapshots",
  "trips",
  "trip_packing_proposals",
  "boards",
  "board_revisions",
  "board_options",
  "board_option_garments",
  "board_suppressions",
  "calendar_projections",
  "service_pauses",
  "day_runs",
] as const;

export const DAILY_SHARED_TABLES = ["weather_cache"] as const;
export const DAILY_EXPORT_VERSION = 1;

export interface DailyExport {
  version: number;
  component: "daily";
  tables: Record<string, Record<string, unknown>[]>;
  counts: Record<string, number>;
}

export async function exportDailyData(db: Db, principal: Principal): Promise<DailyExport> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const tables: DailyExport["tables"] = {};
  const counts: DailyExport["counts"] = {};
  for (const table of DAILY_TABLES) {
    const rows = await all<Record<string, unknown>>(db, `SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`, principal.userId);
    // The owner's internal ID is not part of the portable form; import binds rows to the importing owner.
    tables[table] = rows.map(({ user_id: _owner, lock_until: _lock, ...rest }) => rest);
    counts[table] = rows.length;
  }
  return { version: DAILY_EXPORT_VERSION, component: "daily", tables, counts };
}

export async function importDailyData(db: Db, principal: Principal, data: DailyExport): Promise<{ imported: Record<string, number> }> {
  assertPrincipal(principal);
  requireScope(principal, "admin");
  if (data.component !== "daily" || data.version !== DAILY_EXPORT_VERSION) throw new CommandError("invalid_command", "unsupported daily-service export version");
  for (const table of DAILY_TABLES) {
    const row = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, principal.userId);
    if ((row?.n ?? 0) > 0) throw new CommandError("precondition_failed", `this owner already has ${table} records; daily data is imported only into an empty owner`);
  }
  const imported: Record<string, number> = {};
  for (const table of DAILY_TABLES) {
    const rows = data.tables[table] ?? [];
    const info = await all<{ name: string }>(db, `PRAGMA table_info(${table})`);
    const known = new Set(info.map((c) => c.name));
    const statements = [];
    for (const row of rows) {
      const columns = Object.keys(row).filter((c) => known.has(c) && c !== "user_id");
      // Calendar delivery is not replayed, and nothing is assumed about the importing owner's calendar: a
      // restored projection starts over as pending, so the next real publication creates or adopts the
      // event instead of mistaking its absence for a deletion by the owner.
      const reset: Record<string, unknown> = table === "calendar_projections" ? { etag: null, state: row.state === "suppressed" && row.suppression_reason !== "deleted_externally" ? "suppressed" : "pending", suppression_reason: row.suppression_reason === "deleted_externally" ? null : row.suppression_reason, projected_revision: null, managed_text: null, last_verified_at: null, last_error: null, calendar_id: null } : {};
      const values = columns.map((c) => (c in reset ? reset[c] : row[c]));
      statements.push(prepare(db, stmt(`INSERT INTO ${table} (user_id, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`, principal.userId, ...values)));
    }
    for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40));
    imported[table] = rows.length;
  }
  return { imported };
}
