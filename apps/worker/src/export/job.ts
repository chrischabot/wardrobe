import { CONTRACT_VERSION } from "@garderobe/contracts";
import { EXPORT_FORMAT_VERSION, type ExportComponent, type ExportJob } from "@garderobe/contracts/ext/api";
import { all, first, json as parseJson, prepare, stmt, systemPrincipalFor, toInstant, type Principal } from "@garderobe/domain";
import type { z } from "zod";
import type { App } from "../app.ts";
import { auditStatement, rateLimit, type OwnerSession } from "../auth/session.ts";
import { codeHash, randomBytes, randomToken, toBase64Url } from "../crypto.ts";
import { ApiException } from "../errors.ts";
import { BASE_HEADERS } from "../http.ts";
import { appendRunEvent, createApiRun } from "../runs.ts";
import { LEDGER_COMPONENTS, LEDGER_TABLES, NEVER_EXPORTED, README, csv, dumpTable, readSnapshot, sameBoundary, type Snapshot, type TableDump } from "./ledger.ts";
import { PackageWriter, type PackageFile } from "./package.ts";

type Job = z.infer<typeof ExportJob>;
type Component = z.infer<typeof ExportComponent>;

const LEASE_MS = 120_000;
const DOWNLOAD_WINDOW_MS = 24 * 3_600_000;
const TICKET_TTL_MS = 5 * 60_000;
const BOUNDARY_ATTEMPTS = 3;

interface JobRow {
  user_id: string;
  export_id: string;
  run_id: string;
  state: Job["state"];
  encrypted: number;
  format_version: string;
  snapshot_json: string | null;
  components_json: string;
  progress_json: string;
  object_key: string | null;
  byte_length: number | null;
  sha256: string | null;
  requested_at: string;
  finished_at: string | null;
  expires_at: string | null;
}

function toJob(row: JobRow): Job {
  const components = parseJson<Component[]>(row.components_json, []);
  const snapshot = parseJson<Snapshot | null>(row.snapshot_json, null);
  return {
    exportId: row.export_id,
    runId: row.run_id,
    state: row.state,
    complete: row.state === "completed" && components.length > 0 && components.every((c) => c.state === "complete"),
    encrypted: row.encrypted === 1,
    formatVersion: row.format_version,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
    snapshot: snapshot ? { takenAt: snapshot.takenAt, wardrobeRevision: snapshot.wardrobeRevision, styleRevision: snapshot.styleRevision, lastCommandRecordedAt: snapshot.lastCommandRecordedAt } : null,
    components,
    byteLength: row.byte_length,
    sha256: row.sha256,
  };
}

const loadJob = (app: App, userId: string, exportId: string) => first<JobRow>(app.db, "SELECT * FROM export_jobs WHERE user_id = ? AND export_id = ?", userId, exportId);

const stagingKey = (userId: string, exportId: string, name: string) => `exports/${userId}/${exportId}/staging/${name}.json`;
const packageKey = (userId: string, exportId: string) => `exports/${userId}/${exportId}/package`;

interface Staged {
  name: string;
  title: string;
  state: Component["state"];
  records: number;
  note: string | null;
}

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "image/gif": "gif" };

/* ------------------------------------------------------------------ */
/* Collection                                                           */
/* ------------------------------------------------------------------ */

async function stage(app: App, userId: string, exportId: string, name: string, value: unknown): Promise<void> {
  await app.env.EXPORT_BUCKET.put(stagingKey(userId, exportId, name), JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
}

async function readStaged<T>(app: App, userId: string, exportId: string, name: string): Promise<T | null> {
  const object = await app.env.EXPORT_BUCKET.get(stagingKey(userId, exportId, name));
  return object ? ((await object.json()) as T) : null;
}

function countRecords(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : v && typeof v === "object" ? countRecords(v) : 0), 0);
  return 0;
}

/** Read every component into staging. Components already staged for the same version boundary are kept (resume). */
async function collect(app: App, principal: Principal, exportId: string, done: Map<string, Staged>): Promise<void> {
  const userId = principal.userId;
  for (const component of LEDGER_COMPONENTS) {
    if (done.has(component.name)) continue;
    const tables: Record<string, TableDump> = {};
    let records = 0;
    for (const spec of LEDGER_TABLES.filter((t) => t.component === component.name)) {
      const dump = await dumpTable(app.db, spec, userId);
      tables[spec.table] = dump;
      records += dump.rows.length;
    }
    await stage(app, userId, exportId, component.name, { component: component.name, title: component.title, tables });
    done.set(component.name, { name: component.name, title: component.title, state: "complete", records, note: null });
  }

  const lane = async (name: string, title: string, mounted: boolean, read: () => Promise<unknown>) => {
    if (done.has(name)) return;
    if (!mounted) {
      done.set(name, { name, title, state: "unavailable", records: 0, note: "This part of Garderobe is not installed in this deployment, so its records are not in the package." });
      return;
    }
    try {
      const value = await read();
      await stage(app, userId, exportId, name, value);
      done.set(name, { name, title, state: "complete", records: countRecords(value), note: null });
    } catch (error) {
      console.error(`export component ${name} failed`, String((error as Error)?.message ?? error));
      done.set(name, { name, title, state: "incomplete", records: 0, note: "These records could not be read; they are missing from this package." });
    }
  };

  await lane("daily", "Boards and their revisions, trips and packing proposals, pause records, weather and calendar snapshots", app.daily !== null, () => app.daily!.exportData(principal));
  let assistantExport: { records: unknown; conversation: unknown } | null = null;
  const readAssistant = async () => (assistantExport ??= await app.assistant!.exportData(principal));
  await lane("assistant", "Orders, returns and exchanges, lifecycle projects, research with source references, comfort feedback, remembered conclusions", app.assistant !== null, async () => (await readAssistant()).records);
  await lane("conversation", "Original conversation messages with their dates and channels", app.assistant !== null, async () => (await readAssistant()).conversation);
  await lane("media", "Photographs and derived images with transformation provenance; saved combinations and day plans", app.media !== null, () => app.media!.exportData(principal));

  if (!done.has("account")) {
    const user = await first<{ display_name: string; created_at: string; is_synthetic: number }>(app.db, "SELECT display_name, created_at, is_synthetic FROM users WHERE user_id = ?", userId);
    const connections = await all(app.db, "SELECT connection_id, kind, name, endpoint, namespace, protocol, auth_type, state, capabilities_json, created_at FROM connection_profiles WHERE user_id = ?", userId);
    const assistants = await all(app.db, "SELECT client_name, client_uri, scopes_json, status, granted_at, revoked_at FROM mcp_grants WHERE user_id = ?", userId);
    const value = {
      note: "For your information only. An import never creates sign-ins, sessions, connections or connected assistants from this file; reconnect those yourself.",
      account: { displayName: user?.display_name ?? null, createdAt: user?.created_at ?? null, synthetic: user?.is_synthetic === 1 },
      connections,
      connectedAssistants: assistants,
    };
    await stage(app, userId, exportId, "account", value);
    done.set("account", { name: "account", title: "Account summary and connection list (no credentials)", state: "complete", records: connections.length + assistants.length + 1, note: null });
  }
}

/* ------------------------------------------------------------------ */
/* Views                                                                */
/* ------------------------------------------------------------------ */

type LedgerFile = { tables: Record<string, TableDump> };

function buildViews(ledger: Record<string, LedgerFile | null>, conversation: unknown, components: Staged[], snapshot: Snapshot): { path: string; text: string }[] {
  const rows = (component: string, table: string) => ledger[component]?.tables[table]?.rows ?? [];
  const garments = rows("inventory", "garments");
  const balances = rows("quantities", "stock_balances");
  const wears = rows("wear", "daily_wears");
  const names = new Map(garments.map((g) => [String(g.garment_id), String(g.name)]));
  const buckets = ["clean", "dirty", "service", "storage", "tailor", "trip", "incoming", "gone"];
  const byGarment = new Map<string, Record<string, number>>();
  for (const b of balances) {
    const entry = byGarment.get(String(b.garment_id)) ?? {};
    entry[String(b.bucket)] = (entry[String(b.bucket)] ?? 0) + Number(b.quantity ?? 0);
    byGarment.set(String(b.garment_id), entry);
  }
  const wearCount = new Map<string, { n: number; last: string }>();
  for (const w of wears) {
    if (w.active === 0 || w.status === "retracted") continue;
    const id = String(w.garment_id);
    const entry = wearCount.get(id) ?? { n: 0, last: "" };
    entry.n++;
    if (String(w.wearing_date) > entry.last) entry.last = String(w.wearing_date);
    wearCount.set(id, entry);
  }
  const inventory = csv(
    ["garment_id", "name", "category", "maker", "product", "colour", "pattern", "fabric", "size", "acquisition", "care_channel", "planning_policy", ...buckets, "recorded_wears", "last_recorded_wear"],
    garments.map((g) => {
      const b = byGarment.get(String(g.garment_id)) ?? {};
      const w = wearCount.get(String(g.garment_id));
      return [g.garment_id, g.name, g.category, g.maker, g.product, g.colour, g.pattern, g.fabric, g.size, g.acquisition, g.care_channel, g.planning_policy, ...buckets.map((k) => b[k] ?? 0), w?.n ?? 0, w?.last ?? ""];
    }),
  );
  const wearHistory = csv(["wearing_date", "garment_id", "garment_name"], [...wears].sort((a, b) => String(a.wearing_date).localeCompare(String(b.wearing_date))).map((w) => [w.wearing_date, w.garment_id, names.get(String(w.garment_id)) ?? ""]));
  const events = rows("quantities", "stock_events");
  const eventColumns = ledger.quantities?.tables.stock_events?.columns ?? [];
  const movements = csv([...eventColumns, "garment_name"], events.map((e) => [...eventColumns.map((c) => e[c]), names.get(String(e.garment_id)) ?? ""]));

  const documents = rows("style", "style_documents");
  const current = [...documents].sort((a, b) => Number(b.version) - Number(a.version)).find((d) => d.status === "active") ?? [...documents].sort((a, b) => Number(b.version) - Number(a.version))[0];
  const profile = current ? String(current.content ?? "") : "No profile document is stored.\n";

  const summary = [
    "# Wardrobe summary",
    "",
    `Snapshot taken ${snapshot.takenAt} (wardrobe revision ${snapshot.wardrobeRevision}, style revision ${snapshot.styleRevision}).`,
    "",
    `- Garments (including incoming and retired): ${garments.length}`,
    `- Counted daily wears: ${wears.length}`,
    `- Quantity movements: ${events.length}`,
    `- Command receipts: ${rows("receipts", "commands").length}`,
    `- Profile versions: ${documents.length}`,
    "",
    "## Components",
    "",
    "| Component | State | Records | Note |",
    "| --- | --- | --- | --- |",
    ...components.map((c) => `| ${c.title} | ${c.state} | ${c.records} | ${c.note ?? ""} |`),
    "",
    "A wear count of zero means no wear was recorded since logging began; it does not mean a piece is unworn.",
    "",
  ].join("\n");

  const messages = Array.isArray((conversation as { messages?: unknown[] } | null)?.messages) ? ((conversation as { messages: Record<string, unknown>[] }).messages) : null;
  const conversationText = messages
    ? ["# Conversation", "", ...messages.map((m) => `**${String(m.authoredAt ?? m.createdAt ?? "undated")} — ${String(m.role ?? "")}${m.channel ? ` (${String(m.channel)})` : ""}**\n\n${m.forgotten ? "(forgotten at the owner's request)" : String(m.text ?? "")}\n`)].join("\n")
    : "# Conversation\n\nThe conversation is not included as a readable view in this package; see `records/conversation.json` if that component is present.\n";

  return [
    { path: "views/inventory.csv", text: inventory },
    { path: "views/wear-history.csv", text: wearHistory },
    { path: "views/quantity-movements.csv", text: movements },
    { path: "views/summary.md", text: summary },
    { path: "views/profile.md", text: profile },
    { path: "views/conversation.md", text: conversationText },
  ];
}

/* ------------------------------------------------------------------ */
/* Job                                                                  */
/* ------------------------------------------------------------------ */

async function acquireLease(app: App, userId: string, exportId: string, nowMs: number): Promise<boolean> {
  const result = await prepare(
    app.db,
    stmt(
      "UPDATE export_jobs SET state = 'running', progress_json = json_set(progress_json, '$.leaseUntil', ?) WHERE user_id = ? AND export_id = ? AND state IN ('queued', 'running') AND COALESCE(json_extract(progress_json, '$.leaseUntil'), '') < ?",
      toInstant(nowMs + LEASE_MS),
      userId,
      exportId,
      toInstant(nowMs),
    ),
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function failJob(app: App, row: JobRow, code: string, message: string): Promise<void> {
  const nowMs = app.now();
  await prepare(app.db, stmt("UPDATE export_jobs SET state = 'failed', finished_at = ?, progress_json = json_set(progress_json, '$.leaseUntil', '', '$.error', ?) WHERE user_id = ? AND export_id = ?", toInstant(nowMs), message, row.user_id, row.export_id)).run();
  await appendRunEvent(app.db, row.user_id, row.run_id, "run_finished", { state: "failed" }, { state: "failed", activity: null, error: { code, message, resumable: false } }, nowMs);
}

/**
 * Run (or resume) an export. Safe to call repeatedly: a lease keeps one runner at a time, staged
 * components are reused while the wardrobe has not changed, and the package is only published as a
 * whole. The passphrase exists only in the memory of the request that supplied it.
 */
export async function advanceExport(app: App, userId: string, exportId: string, passphrase?: string): Promise<void> {
  const row = await loadJob(app, userId, exportId);
  if (!row || (row.state !== "queued" && row.state !== "running")) return;
  if (!(await acquireLease(app, userId, exportId, app.now()))) return;
  if (row.encrypted === 1 && !passphrase) {
    // Never fall back to an unencrypted package when encryption was requested.
    await failJob(app, row, "expired", "The export was interrupted before it could be encrypted, and the passphrase is not stored. Request the export again.");
    return;
  }
  const { db } = app;
  let writer: PackageWriter | null = null;
  try {
    const principal = await systemPrincipalFor(db, userId, `export:${exportId}`, "system");
    await appendRunEvent(db, userId, row.run_id, "activity", { text: "Reading your wardrobe" }, { state: "running", activity: "Reading your wardrobe" }, app.now());

    // Collect under a version boundary: the same revisions and command count before and after reading.
    const progress = parseJson<{ staged?: Staged[] }>(row.progress_json, {});
    const previous = parseJson<Snapshot | null>(row.snapshot_json, null);
    let snapshot = await readSnapshot(db, userId, toInstant(app.now()));
    let done = new Map<string, Staged>(previous && sameBoundary(previous, snapshot) ? (progress.staged ?? []).map((s) => [s.name, s]) : []);
    if (previous && sameBoundary(previous, snapshot)) snapshot = { ...snapshot, takenAt: previous.takenAt };
    let coherent = false;
    for (let attempt = 1; attempt <= BOUNDARY_ATTEMPTS; attempt++) {
      await collect(app, principal, exportId, done);
      await prepare(db, stmt("UPDATE export_jobs SET snapshot_json = ?, progress_json = json_set(progress_json, '$.staged', json(?), '$.leaseUntil', ?) WHERE user_id = ? AND export_id = ?", JSON.stringify(snapshot), JSON.stringify([...done.values()]), toInstant(app.now() + LEASE_MS), userId, exportId)).run();
      const after = await readSnapshot(db, userId, snapshot.takenAt);
      if (sameBoundary(snapshot, after)) {
        coherent = true;
        break;
      }
      snapshot = { ...after, takenAt: toInstant(app.now()) };
      if (attempt < BOUNDARY_ATTEMPTS) done = new Map();
    }
    const components = [...done.values()];
    if (!coherent) {
      for (const c of components) if (c.state === "complete" && c.name !== "account") Object.assign(c, { state: "incomplete", note: "The wardrobe kept changing while it was being read, so these records may not describe one moment. Export again." });
    }

    await appendRunEvent(db, userId, row.run_id, "activity", { text: "Building the package" }, { activity: "Building the package" }, app.now());
    const exportedAt = toInstant(app.now());
    writer = await PackageWriter.open(app.env.EXPORT_BUCKET, packageKey(userId, exportId), { ...(passphrase ? { passphrase } : {}), metadata: { exportId, formatVersion: EXPORT_FORMAT_VERSION } });
    const componentFiles = new Map<string, string[]>();
    const addFile = async (component: string | null, path: string, data: Uint8Array | string, store = false): Promise<PackageFile> => {
      const file = await writer!.add(path, data, { store });
      if (component) componentFiles.set(component, [...(componentFiles.get(component) ?? []), path]);
      return file;
    };

    const ledger: Record<string, LedgerFile | null> = {};
    let conversation: unknown = null;
    for (const c of components) {
      if (c.state === "unavailable") continue;
      const value = await readStaged<unknown>(app, userId, exportId, c.name);
      if (value === null) continue;
      if (LEDGER_COMPONENTS.some((l) => l.name === c.name)) ledger[c.name] = value as LedgerFile;
      if (c.name === "conversation") conversation = value;
      if (c.name === "media") continue; // written below, together with its files
      await addFile(c.name, `records/${c.name}.json`, JSON.stringify(value, null, 1));
    }

    // Media: records plus the stored bytes of every asset, one at a time.
    const media = components.find((c) => c.name === "media");
    if (media && media.state !== "unavailable" && app.media) {
      const staged = await readStaged<{ records: unknown; assets: { assetId: string; renditionId: string | null; kind: string; r2Key: string; contentType: string; byteLength: number; sha256: string }[] }>(app, userId, exportId, "media");
      if (staged) {
        const files: Record<string, string> = {};
        const missing: string[] = [];
        const used = new Set<string>();
        for (const asset of staged.assets ?? []) {
          const bytes = await app.media.readExportAsset(principal, asset.r2Key);
          if (!bytes) {
            missing.push(asset.r2Key);
            continue;
          }
          let path = `media/${asset.assetId}${asset.renditionId ? `-${asset.renditionId}` : ""}-${asset.kind}.${EXTENSIONS[asset.contentType] ?? "bin"}`.replace(/[^A-Za-z0-9._/-]/g, "_");
          for (let n = 2; used.has(path); n++) path = path.replace(/(\.[a-z0-9]+)$/, `-${n}$1`);
          used.add(path);
          await addFile("media", path, new Uint8Array(bytes), true);
          files[asset.r2Key] = path;
        }
        await addFile("media", "records/media.json", JSON.stringify({ ...staged, files, missing }, null, 1));
        if (missing.length > 0) Object.assign(media, { state: "incomplete", note: `${missing.length} stored image file(s) could not be read and are missing from this package.` });
      }
    }

    for (const view of buildViews(ledger, conversation, components, snapshot)) await addFile(null, view.path, view.text);
    const complete = components.every((c) => c.state === "complete");
    await addFile(null, "README.md", README({ exportedAt, formatVersion: EXPORT_FORMAT_VERSION, complete }));

    const manifest = {
      format: EXPORT_FORMAT_VERSION,
      contractVersion: CONTRACT_VERSION,
      exportId,
      exportedAt,
      complete,
      /** The moment and version boundary this package describes. */
      snapshot: { takenAt: snapshot.takenAt, wardrobeRevision: snapshot.wardrobeRevision, styleRevision: snapshot.styleRevision, lastCommandRecordedAt: snapshot.lastCommandRecordedAt, commandCount: snapshot.commandCount, coherent },
      /** Store watermarks: what each store had been read through. */
      watermarks: { ledger: { wardrobeRevision: snapshot.wardrobeRevision, lastCommandRecordedAt: snapshot.lastCommandRecordedAt }, components: Object.fromEntries(components.map((c) => [c.name, { readAt: snapshot.takenAt, records: c.records }])) },
      components: components.map((c) => ({ name: c.name, title: c.title, state: c.state, records: c.records, note: c.note, files: componentFiles.get(c.name) ?? [] })),
      excluded: NEVER_EXPORTED,
      files: [...writer.files],
    };
    await writer.add("manifest.json", JSON.stringify(manifest, null, 1));
    await writer.add("checksums.sha256", writer.files.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n");
    const stored = await writer.close();
    writer = null;

    const finishedMs = app.now();
    const state: Job["state"] = complete ? "completed" : "completed_incomplete";
    const publicComponents: Component[] = components.map((c) => ({ name: c.name, state: c.state, records: c.records, note: c.note }));
    await prepare(
      db,
      stmt(
        "UPDATE export_jobs SET state = ?, components_json = ?, object_key = ?, byte_length = ?, sha256 = ?, finished_at = ?, expires_at = ?, progress_json = json_set(progress_json, '$.leaseUntil', '') WHERE user_id = ? AND export_id = ?",
        state,
        JSON.stringify(publicComponents),
        packageKey(userId, exportId),
        stored.bytes,
        stored.sha256,
        toInstant(finishedMs),
        toInstant(finishedMs + DOWNLOAD_WINDOW_MS),
        userId,
        exportId,
      ),
    ).run();
    await appendRunEvent(db, userId, row.run_id, "run_finished", { state: "completed" }, { state: "completed", activity: null, result: { exportId } }, finishedMs);
    for (const c of components) await app.env.EXPORT_BUCKET.delete(stagingKey(userId, exportId, c.name));
  } catch (error) {
    if (writer) await writer.abort();
    console.error("export failed", String((error as Error)?.stack ?? error));
    await failJob(app, row, "internal", "The export could not be completed. Request it again.");
  }
}

export async function requestExport(app: App, session: OwnerSession, input: { clientRequestId: string; passphrase?: string }): Promise<Job> {
  const userId = session.userId;
  const nowMs = app.now();
  const existing = await first<JobRow>(app.db, "SELECT * FROM export_jobs WHERE user_id = ? AND client_request_id = ?", userId, input.clientRequestId);
  let exportId: string;
  if (existing) {
    if ((existing.encrypted === 1) !== Boolean(input.passphrase)) throw new ApiException("idempotency_key_reuse", "that request ID was already used for a different export request");
    exportId = existing.export_id;
  } else {
    await rateLimit(app.db, `export:${userId}`, 12, 3600, nowMs);
    const run = await createApiRun(app.db, { userId, kind: "export", clientRequestId: input.clientRequestId, request: { encrypted: Boolean(input.passphrase) }, channel: session.principal.channel, nowMs });
    exportId = `exp_${toBase64Url(randomBytes(12))}`;
    const audit = await auditStatement({ userId, kind: "export.requested", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { exportId, encrypted: Boolean(input.passphrase) }, nowMs });
    await app.db.batch(
      [
        stmt(
          "INSERT INTO export_jobs (user_id, export_id, run_id, client_request_id, state, encrypted, format_version, requested_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT (user_id, client_request_id) DO NOTHING",
          userId,
          exportId,
          run.runId,
          input.clientRequestId,
          input.passphrase ? 1 : 0,
          EXPORT_FORMAT_VERSION,
          toInstant(nowMs),
        ),
        audit.statement,
      ].map((s) => prepare(app.db, s)),
    );
    exportId = (await first<{ export_id: string }>(app.db, "SELECT export_id FROM export_jobs WHERE user_id = ? AND client_request_id = ?", userId, input.clientRequestId))!.export_id;
  }
  await advanceExport(app, userId, exportId, input.passphrase);
  return toJob((await loadJob(app, userId, exportId))!);
}

/** Read a job; an unencrypted job whose runner disappeared is resumed in the background. */
export async function getExport(app: App, session: OwnerSession, exportId: string, exec: ExecutionContext): Promise<Job> {
  const row = await loadJob(app, session.userId, exportId);
  if (!row) throw new ApiException("not_found", "that export was not found");
  if (row.state === "queued" || row.state === "running") exec.waitUntil(advanceExport(app, session.userId, exportId));
  return toJob(row);
}

export async function listExports(app: App, session: OwnerSession): Promise<Job[]> {
  const rows = await all<JobRow>(app.db, "SELECT * FROM export_jobs WHERE user_id = ? ORDER BY requested_at DESC LIMIT 20", session.userId);
  return rows.map(toJob);
}

function fileName(row: JobRow): string {
  return `garderobe-export-${row.requested_at.slice(0, 10)}-${row.export_id.slice(4, 10)}.zip${row.encrypted === 1 ? ".enc" : ""}`;
}

/** A short-lived, single-use download ticket for a finished package. Only its hash is stored. */
export async function issueDownloadTicket(app: App, session: OwnerSession, exportId: string): Promise<{ url: string; expiresAt: string; fileName: string }> {
  const row = await loadJob(app, session.userId, exportId);
  if (!row) throw new ApiException("not_found", "that export was not found");
  if (row.state !== "completed" && row.state !== "completed_incomplete") throw new ApiException("precondition_failed", "this export has no package to download", { state: row.state });
  const nowMs = app.now();
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) throw new ApiException("expired", "this export has expired; request a new one");
  await rateLimit(app.db, `export-ticket:${session.userId}`, 30, 3600, nowMs);
  const ticket = randomToken(32);
  const expiresAt = toInstant(nowMs + TICKET_TTL_MS);
  const audit = await auditStatement({ userId: session.userId, kind: "export.ticket", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { exportId }, nowMs });
  await app.db.batch(
    [
      stmt("INSERT INTO export_tickets (ticket_hash, user_id, export_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", await codeHash(app.env.STATE_SIGNING_KEY, "export-ticket", ticket), session.userId, exportId, toInstant(nowMs), expiresAt),
      audit.statement,
    ].map((s) => prepare(app.db, s)),
  );
  return { url: `/v1/exports/${exportId}/download?ticket=${ticket}`, expiresAt, fileName: fileName(row) };
}

/** Serve the package for a valid ticket. The ticket is spent before a byte is sent. */
export async function downloadExport(app: App, exportId: string, ticket: string): Promise<Response> {
  const nowMs = app.now();
  const hash = await codeHash(app.env.STATE_SIGNING_KEY, "export-ticket", ticket);
  const row = await first<{ user_id: string; export_id: string; expires_at: string; used_at: string | null }>(app.db, "SELECT user_id, export_id, expires_at, used_at FROM export_tickets WHERE ticket_hash = ?", hash);
  if (!row || row.export_id !== exportId) throw new ApiException("unauthenticated", "this download link is not valid");
  if (row.used_at !== null || Date.parse(row.expires_at) <= nowMs) throw new ApiException("expired", "this download link has expired or was already used");
  const spent = await prepare(app.db, stmt("UPDATE export_tickets SET used_at = ? WHERE ticket_hash = ? AND used_at IS NULL", toInstant(nowMs), hash)).run();
  if ((spent.meta?.changes ?? 0) !== 1) throw new ApiException("expired", "this download link has expired or was already used");
  const job = await loadJob(app, row.user_id, exportId);
  const user = await first<{ status: string }>(app.db, "SELECT status FROM users WHERE user_id = ?", row.user_id);
  if (!job || !job.object_key || user?.status !== "active") throw new ApiException("not_found", "that export is no longer available");
  if (job.expires_at && Date.parse(job.expires_at) <= nowMs) throw new ApiException("expired", "this export has expired; request a new one");
  const object = await app.env.EXPORT_BUCKET.get(job.object_key);
  if (!object) throw new ApiException("not_found", "that export is no longer available");
  return new Response(object.body, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": job.encrypted === 1 ? "application/octet-stream" : "application/zip",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${fileName(job)}"`,
      "X-Garderobe-Export-Sha256": job.sha256 ?? "",
    },
  });
}
