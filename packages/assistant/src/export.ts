/**
 * Portable export and clean import of the assistant's records (specification section 15).
 * No credentials: connection secret references are omitted. Import restores rows with their original IDs
 * directly; it runs no command, so it creates no effect, no outbox row and no external write.
 */
import { all, assertPrincipal, prepare, requireScope, stmt, type Db, type Principal } from "@garderobe/domain";

/** Tables exported in dependency order. Operational and derived stores are rebuilt, not exported. */
const TABLES: { table: string; omit?: string[] }[] = [
  { table: "orders" },
  { table: "order_lines" },
  { table: "order_events" },
  { table: "products" },
  { table: "product_observations" },
  { table: "fit_assessments" },
  { table: "research_notes" },
  { table: "return_cases" },
  { table: "lifecycle_projects" },
  { table: "lifecycle_project_items" },
  { table: "lifecycle_events" },
  { table: "comfort_feedback" },
  { table: "comfort_feedback_garments" },
  { table: "memory_conclusions" },
  { table: "source_tombstones" },
  { table: "inference_routing" },
  // The registry row is kept so the owner can reconnect; the credential reference is never exported.
  { table: "connections", omit: ["secret_ref"] },
  { table: "assistant_jobs" },
];

export interface AssistantExport {
  version: 1;
  kind: "garderobe-assistant-export";
  tables: Record<string, Record<string, unknown>[]>;
  excluded: string[];
}

export async function exportAssistantData(db: Db, principal: Principal): Promise<AssistantExport> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const tables: AssistantExport["tables"] = {};
  for (const { table, omit } of TABLES) {
    const rows = await all<Record<string, unknown>>(db, `SELECT * FROM ${table} WHERE user_id = ?`, principal.userId);
    tables[table] = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) if (k !== "user_id" && !(omit ?? []).includes(k)) out[k] = v;
      return out;
    });
  }
  return {
    version: 1,
    kind: "garderobe-assistant-export",
    tables,
    excluded: ["connection credentials and secret references", "inference reservations (operational accounting)", "turn ledger and retrieval projection (rebuilt from the conversation export)", "forgotten content"],
  };
}

export async function importAssistantData(db: Db, principal: Principal, data: AssistantExport): Promise<{ imported: Record<string, number> }> {
  assertPrincipal(principal);
  requireScope(principal, "admin");
  if (data.version !== 1 || data.kind !== "garderobe-assistant-export") throw new Error("unsupported assistant export");
  const imported: Record<string, number> = {};
  for (const { table } of TABLES) {
    const existing = await all(db, `SELECT 1 AS x FROM ${table} WHERE user_id = ? LIMIT 1`, principal.userId);
    if (existing.length > 0) throw new Error(`import needs an empty owner: ${table} already has records`);
  }
  for (const { table, omit } of TABLES) {
    const rows = data.tables[table] ?? [];
    for (const row of rows) {
      // Column names come from this module's own table list and the row keys are checked as identifiers.
      const keys = Object.keys(row).filter((k) => /^[a-z_]+$/.test(k) && k !== "user_id" && !(omit ?? []).includes(k));
      await prepare(db, stmt(`INSERT INTO ${table} (user_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`, principal.userId, ...keys.map((k) => row[k]))).run();
    }
    imported[table] = rows.length;
  }
  return { imported };
}
