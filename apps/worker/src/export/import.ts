import { EXPORT_FORMAT_VERSION, type ImportJob } from "@garderobe/contracts/ext/api";
import { first, json as parseJson, prepare, stmt, toInstant, type Stmt } from "@garderobe/domain";
import { z } from "zod";
import type { App } from "../app.ts";
import { auditStatement, rateLimit, type OwnerSession } from "../auth/session.ts";
import { decryptPackage, isEncryptedPackage, randomBytes, sha256Hex, toBase64Url } from "../crypto.ts";
import { ApiException } from "../errors.ts";
import { appendRunEvent, createApiRun } from "../runs.ts";
import { isErasedOwnerRef } from "../identity/erasure.ts";
import { LEDGER_COMPONENTS, LEDGER_TABLES, tableColumns, type TableDump } from "./ledger.ts";
import { readPackage } from "./package.ts";

type Job = z.infer<typeof ImportJob>;
type ComponentReport = Job["components"][number];

const Manifest = z.object({
  format: z.string(),
  exportId: z.string(),
  exportedAt: z.string(),
  complete: z.boolean(),
  components: z.array(z.object({ name: z.string(), state: z.string(), records: z.number(), note: z.string().nullable().optional(), files: z.array(z.string()).default([]) })),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().length(64) })),
  /** Present in a backup package. */
  backup: z.object({ ownerRef: z.string(), restoreManifest: z.string() }).optional(),
});

const LedgerFile = z.object({ tables: z.record(z.string(), z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.unknown())) })) });

const decoder = new TextDecoder();
const BATCH = 100;

function reject(message: string, details: Record<string, unknown> = {}): never {
  throw new ApiException("invalid_command", message, { rejected: true, ...details });
}

/** Verify the package against its own manifest and checksum list. Nothing is written before this passes. */
async function verifyPackage(files: Map<string, Uint8Array>): Promise<z.infer<typeof Manifest>> {
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes) reject("this is not a Garderobe export: it has no manifest");
  let manifest: z.infer<typeof Manifest>;
  try {
    manifest = Manifest.parse(JSON.parse(decoder.decode(manifestBytes)));
  } catch {
    return reject("the package manifest is not valid");
  }
  if (manifest.format !== EXPORT_FORMAT_VERSION) reject("this export format is not supported", { format: manifest.format, supported: EXPORT_FORMAT_VERSION });
  const listed = new Set<string>();
  for (const entry of manifest.files) {
    const data = files.get(entry.path);
    if (!data) reject("a file named in the manifest is missing from the package", { path: entry.path });
    if (data.length !== entry.bytes || (await sha256Hex(data)) !== entry.sha256) reject("a file does not match its checksum; the package was changed or damaged", { path: entry.path });
    listed.add(entry.path);
  }
  // Everything in the package must be accounted for: an unlisted file is not silently accepted.
  for (const path of files.keys()) {
    if (path !== "manifest.json" && path !== "checksums.sha256" && !listed.has(path)) reject("the package contains a file its manifest does not list", { path });
  }
  const checksums = files.get("checksums.sha256");
  if (!checksums) reject("the package has no checksum list");
  for (const line of decoder.decode(checksums).split("\n")) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) reject("the checksum list is malformed");
    const data = files.get(match[2]!);
    if (!data || (await sha256Hex(data)) !== match[1]) reject("a file does not match the checksum list", { path: match[2] });
  }
  return manifest;
}

const EMPTY_CHECK = ["garments", "commands", "style_documents", "wear_observations", "stock_events"];

/**
 * Import a portable package into the signed-in owner, who must be empty.
 *
 * What an import can never do, whatever the package says:
 *  - write for another owner: every row is written with the authenticated owner's ID, and the
 *    package's own owner field is never read;
 *  - plant a sign-in, session, recovery credential, assistant grant or connection credential: only
 *    the allow-listed ledger tables and the modules' own import functions are written;
 *  - repeat an external effect: effect records are imported as history, and any that were still
 *    pending are imported as cancelled;
 *  - change identifiers: rows keep their IDs.
 * It reads only the package: no other service is queried.
 */
export async function importPackage(app: App, session: OwnerSession, body: Uint8Array, passphrase: string | null): Promise<Job> {
  const { db } = app;
  const userId = session.userId;
  const nowMs = app.now();
  await rateLimit(db, `import:${userId}`, 6, 3600, nowMs);
  const packageSha = await sha256Hex(body);

  let plain = body;
  if (isEncryptedPackage(body)) {
    if (!passphrase) throw new ApiException("invalid_command", "this package is encrypted; send its passphrase in the X-Garderobe-Passphrase header", { rejected: true, reason: "passphrase_required" });
    try {
      plain = await decryptPackage(passphrase, body);
    } catch {
      throw new ApiException("invalid_command", "the passphrase is wrong or the package was changed", { rejected: true, reason: "decryption_failed" });
    }
  }
  let files: Map<string, Uint8Array>;
  try {
    files = readPackage(plain);
  } catch {
    return reject("this file is not a readable Garderobe export");
  }
  const manifest = await verifyPackage(files);
  // A backup of an account that was deleted since is never restored: deletion reaches the backups too.
  if (manifest.backup && (await isErasedOwnerRef(db, manifest.backup.ownerRef))) {
    throw new ApiException("forbidden", "this backup belongs to an account that was deleted; it cannot be restored", { rejected: true, reason: "owner_erased" });
  }

  for (const table of EMPTY_CHECK) {
    const row = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, userId);
    if ((row?.n ?? 0) > 0) throw new ApiException("precondition_failed", "a wardrobe can only be imported into an empty account; this account already has records", { table });
  }

  const run = await createApiRun(db, { userId, kind: "import", clientRequestId: `import:${packageSha}`, request: { packageSha }, channel: session.principal.channel, nowMs });
  const importId = `imp_${toBase64Url(randomBytes(12))}`;
  await prepare(db, stmt("INSERT INTO import_jobs (user_id, import_id, run_id, state, package_sha256, created_at) VALUES (?, ?, ?, 'running', ?, ?)", userId, importId, run.runId, packageSha, toInstant(nowMs))).run();

  const reports: ComponentReport[] = [];
  const component = (name: string) => manifest.components.find((c) => c.name === name);
  const jsonFile = (path: string): unknown => {
    const data = files.get(path);
    return data ? JSON.parse(decoder.decode(data)) : null;
  };
  const written: string[] = [];
  const originals: Record<string, Record<string, unknown>[]> = {};

  const finish = async (state: Job["state"], error: string | null): Promise<Job> => {
    const finishedAt = toInstant(app.now());
    const job: Job = { importId, runId: run.runId, state, formatVersion: manifest.format, checksumsVerified: true, components: reports, externalEffectsReplayed: 0, idsPreserved: true, error, finishedAt };
    const audit = await auditStatement({ userId, kind: "import.finished", outcome: state === "completed" ? "ok" : "refused", identity: session.identity, channel: session.principal.channel, detail: { importId, sourceExportId: manifest.exportId, state }, nowMs: app.now() });
    await db.batch([stmt("UPDATE import_jobs SET state = ?, report_json = ?, finished_at = ? WHERE user_id = ? AND import_id = ?", state, JSON.stringify(job), finishedAt, userId, importId), audit.statement].map((s) => prepare(db, s)));
    await appendRunEvent(db, userId, run.runId, "run_finished", { state: state === "completed" ? "completed" : "failed" }, { state: state === "completed" ? "completed" : "failed", activity: null, result: { importId }, ...(error ? { error: { code: "import_failed", message: error, resumable: false } } : {}) }, app.now());
    return job;
  };

  try {
    /* ---------------- ledger ---------------- */
    const ledgerFiles = new Map<string, z.infer<typeof LedgerFile>>();
    for (const c of LEDGER_COMPONENTS) {
      const raw = jsonFile(`records/${c.name}.json`);
      if (raw === null) {
        reports.push({ name: c.name, imported: 0, skipped: 0, note: "Not in the package." });
        continue;
      }
      ledgerFiles.set(c.name, LedgerFile.parse(raw));
      reports.push({ name: c.name, imported: 0, skipped: 0, note: component(c.name)?.state === "complete" ? null : `The package marks this component as ${component(c.name)?.state ?? "unknown"}.` });
    }
    const mergedInto: { garmentId: string; target: string }[] = [];
    for (const spec of LEDGER_TABLES) {
      const dump: TableDump | undefined = ledgerFiles.get(spec.component)?.tables[spec.table] as TableDump | undefined;
      if (!dump || dump.rows.length === 0) continue;
      // Column names come from this database's schema; names in the package only select among them.
      const real = new Set(await tableColumns(db, spec.table));
      const columns = dump.columns.filter((c) => real.has(c) && c !== "user_id" && !(spec.omit ?? []).includes(c));
      const dropped = dump.columns.filter((c) => !columns.includes(c));
      if (spec.upsert) originals[spec.table] = (await db.prepare(`SELECT * FROM ${spec.table} WHERE user_id = ?`).bind(userId).all<Record<string, unknown>>()).results;
      const sql = `INSERT ${spec.upsert ? "OR REPLACE " : ""}INTO ${spec.table} (user_id, ${columns.map((c) => `"${c}"`).join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`;
      const statements: Stmt[] = [];
      for (const row of dump.rows) {
        const values = columns.map((c) => {
          let value = row[c] ?? null;
          if (spec.table === "effects") {
            // History only: work that had not been done stays undone and is never dispatched from an import.
            if (c === "state" && (value === "pending" || value === "in_progress")) value = "cancelled";
            if (c === "claimed_until") value = null;
          }
          if (spec.table === "garments" && c === "merged_into" && value !== null) {
            mergedInto.push({ garmentId: String(row.garment_id), target: String(value) });
            value = null;
          }
          return typeof value === "object" && value !== null ? JSON.stringify(value) : value;
        });
        statements.push(stmt(sql, userId, ...values));
      }
      written.push(spec.table);
      for (let i = 0; i < statements.length; i += BATCH) await db.batch(statements.slice(i, i + BATCH).map((s) => prepare(db, s)));
      const report = reports.find((r) => r.name === spec.component)!;
      report.imported += dump.rows.length;
      if (dropped.length > 0) report.note = [report.note, `Columns not known to this version were not imported from ${spec.table}: ${dropped.join(", ")}.`].filter(Boolean).join(" ");
    }
    for (let i = 0; i < mergedInto.length; i += BATCH) {
      await db.batch(mergedInto.slice(i, i + BATCH).map((m) => prepare(db, stmt("UPDATE garments SET merged_into = ? WHERE user_id = ? AND garment_id = ?", m.target, userId, m.garmentId))));
    }

    /* ---------------- modules ---------------- */
    const lane = async (name: string, mounted: boolean, run: (value: unknown) => Promise<unknown>) => {
      const value = jsonFile(`records/${name}.json`);
      const declared = component(name);
      if (value === null) {
        reports.push({ name, imported: 0, skipped: 0, note: declared ? `Not in the package (${declared.state}).` : "Not in the package." });
        return;
      }
      if (!mounted) {
        reports.push({ name, imported: 0, skipped: declared?.records ?? 0, note: "This part of Garderobe is not installed in this deployment; these records were not imported." });
        return;
      }
      await run(value);
      reports.push({ name, imported: declared?.records ?? 0, skipped: 0, note: null });
    };
    await lane("daily", app.daily !== null, (value) => app.daily!.importData(session.principal, value as never));
    const conversation = jsonFile("records/conversation.json");
    await lane("assistant", app.assistant !== null, (records) => app.assistant!.importData(session.principal, { records, conversation }));
    if (conversation !== null) reports.push({ name: "conversation", imported: app.assistant ? (component("conversation")?.records ?? 0) : 0, skipped: app.assistant ? 0 : (component("conversation")?.records ?? 0), note: app.assistant ? null : "The conversation module is not installed in this deployment." });
    await lane("media", app.media !== null, async (value) => {
      const media = value as { records: unknown; files?: Record<string, string> };
      const paths = media.files ?? {};
      await app.media!.importData(session.principal, media.records, async (exportedKey) => {
        const path = paths[exportedKey];
        const data = path ? files.get(path) : undefined;
        return data ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) : null;
      });
    });
    if (files.has("records/account.json")) reports.push({ name: "account", imported: 0, skipped: component("account")?.records ?? 0, note: "Never imported: sign-ins, sessions, connections and connected assistants are not created from a package." });

    return await finish("completed", null);
  } catch (error) {
    console.error("import failed", String((error as Error)?.stack ?? error));
    // The account was empty before, so removing what this import wrote restores exactly that state.
    for (const table of [...written].reverse()) {
      const spec = LEDGER_TABLES.find((t) => t.table === table)!;
      try {
        if (table === "garments") await prepare(db, stmt("UPDATE garments SET merged_into = NULL WHERE user_id = ?", userId)).run();
        if (!spec.upsert) await prepare(db, stmt(`DELETE FROM ${table} WHERE user_id = ?`, userId)).run();
        else {
          const rows = originals[table] ?? [];
          await prepare(db, stmt(`DELETE FROM ${table} WHERE user_id = ?`, userId)).run();
          for (const row of rows) {
            const cols = Object.keys(row);
            await prepare(db, stmt(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => row[c]))).run();
          }
        }
      } catch (cleanupError) {
        console.error("import cleanup failed", table, String((cleanupError as Error)?.message ?? cleanupError));
      }
    }
    for (const r of reports) {
      r.skipped += r.imported;
      r.imported = 0;
    }
    return finish("failed", "The package could not be imported; nothing from it was kept.");
  }
}

export async function getImport(app: App, session: OwnerSession, importId: string): Promise<Job> {
  const row = await first<{ import_id: string; run_id: string; state: Job["state"]; report_json: string }>(app.db, "SELECT import_id, run_id, state, report_json FROM import_jobs WHERE user_id = ? AND import_id = ?", session.userId, importId);
  if (!row) throw new ApiException("not_found", "that import was not found");
  const report = parseJson<Job | null>(row.report_json, null);
  return report && report.importId ? report : { importId: row.import_id, runId: row.run_id, state: row.state, formatVersion: null, checksumsVerified: false, components: [], externalEffectsReplayed: 0, idsPreserved: true, error: null, finishedAt: null };
}
