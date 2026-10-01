import { FOUNDATION_COMMANDS as C } from "@garderobe/contracts";
import { first, stmt, type Stmt } from "../db.ts";
import { define } from "./garments.ts";

/** Import bookkeeping: one run per source document hash, one accounting row per source line. */
export const importRecordRun = define({
  type: "import.record_run",
  schema: C["import.record_run"],
  class: "system",
  requiredScope: "admin",
  allowedAuthorizations: ["data_import"],
  async plan(ctx, p) {
    const existing = await first<{ import_run_id: string }>(ctx.db, "SELECT import_run_id FROM import_runs WHERE user_id = ? AND source_name = ? AND source_sha256 = ?", ctx.userId, p.sourceName, p.sourceSha256);
    if (existing) {
      return { outcome: "noop", summary: `This exact file was already imported (run ${existing.import_run_id})`, result: { importRunId: existing.import_run_id }, undo: { unavailableReason: "nothing changed" } };
    }
    const statements: Stmt[] = [
      stmt(
        "INSERT INTO import_runs (user_id, import_run_id, source_name, source_sha256, source_bytes, importer, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ctx.userId, p.importRunId, p.sourceName, p.sourceSha256, p.sourceBytes, p.importer, JSON.stringify(p.summary), ctx.now,
      ),
    ];
    for (const r of p.rows) {
      statements.push(
        stmt(
          "INSERT INTO import_refs (user_id, import_run_id, source_row, source_key, disposition, garment_id, reason, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, p.importRunId, r.sourceRow, r.sourceKey, r.disposition, r.garmentId, r.reason, JSON.stringify(r.raw),
        ),
      );
    }
    for (const i of p.issues) {
      statements.push(
        stmt(
          "INSERT INTO migration_issues (user_id, issue_id, import_run_id, kind, severity, detail, garment_id, source_rows_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, i.issueId, p.importRunId, i.kind, i.severity, i.detail, i.garmentId, JSON.stringify(i.sourceRows),
        ),
      );
    }
    const count = (d: string) => p.rows.filter((r) => r.disposition === d).length;
    return {
      summary: `Import recorded for ${p.sourceName}: ${p.rows.length} lines accounted for (${count("imported")} imported, ${count("merged")} merged, ${count("held")} held, ${count("not_a_data_row")} not data), ${p.issues.length} issue(s) noted`,
      statements,
      affected: [{ kind: "import_run", id: p.importRunId, version: 1 }],
      result: { importRunId: p.importRunId, rows: p.rows.length, issues: p.issues.length },
      undo: { unavailableReason: "an import record is an audit trail; correct individual garments instead" },
    };
  },
});
