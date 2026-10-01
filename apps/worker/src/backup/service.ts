import { all, createPrincipal, first, json as parseJson, prepare, stmt, toInstant, type Db, type Principal } from "@garderobe/domain";
import type { App } from "../app.ts";
import { auditStatement, rateLimit, type OwnerSession } from "../auth/session.ts";
import { randomBytes, sha256Hex, toBase64Url } from "../crypto.ts";
import { ApiException } from "../errors.ts";
import { advanceExport, exportJobOf, loadExportJob, type BackupHooks, type ExportJobRow } from "../export/job.ts";
import { readSnapshot } from "../export/ledger.ts";
import { ownerRefOf } from "../identity/erasure.ts";
import { createApiRun } from "../runs.ts";

/**
 * Backups and restore (specification section 15): "Backups preserve D1 exports, Think Session messages
 * and compaction overlays, connector metadata, source assets, and manifests with bounded retention. A
 * restore manifest records snapshot times and projection watermarks across stores."
 *
 * A backup is a package built by the export job (the owner's ledger tables, each workstream's records,
 * the conversation in its operational form with compaction overlays and pending turns, connection
 * metadata without credentials, and the stored bytes of every media asset), kept under `backups/` in the
 * private export bucket for a bounded time, with a restore manifest inside it and beside it. One is
 * taken per owner per day by the scheduled sweep.
 *
 * A tombstone journal is kept beside the backups and refreshed on every sweep, so a source the owner
 * forgot AFTER a backup was taken is forgotten again when that backup is restored.
 *
 * Restoring is the import of that package into an empty owner, then `verifyRestore`, which compares
 * the restored state with the restore manifest check by check and replays the tombstone journal.
 * Sign-ins, sessions, credentials and assistant grants are deliberately not in a backup: after a
 * restore the owner signs in through claim or recovery and reconnects services, exactly as after an
 * import. The platform's own D1 restore covers those tables.
 */
export const BACKUP_INTERVAL_MS = 24 * 3_600_000;
const BACKUPS_PER_SWEEP = 2;

export const tombstoneJournalKey = (userId: string) => `backups/${userId}/tombstones.json`;
/**
 * A second copy of the journal, named by the owner's keyed reference (the only owner identity a backup
 * package carries). A restore in this deployment finds it from the package alone, so images deleted
 * after the backup are never written back to storage. It is erased with the account.
 */
export const journalByOwnerRefKey = (ownerRef: string) => `backup-journals/${ownerRef}/tombstones.json`;

/* ------------------------------------------------------------------ */
/* The state digest: what a restore must reproduce                      */
/* ------------------------------------------------------------------ */

export interface StateDigest {
  ledger: { wardrobeRevision: number; styleRevision: number; commandCount: number; lastCommandRecordedAt: string | null };
  inventory: { garments: number; garmentIdsSha256: string; aliases: number; restrictionsActive: number };
  quantities: { byBucket: Record<string, number>; movements: number };
  wear: { countedWears: number; countedWearsSha256: string; observations: number };
  style: { versions: { version: number; contentSha256: string; status: string }[]; rules: number; amendments: number; factConflicts: number };
  effects: Record<string, number>;
  tombstones: { count: number; sha256: string };
  conversation: Record<string, unknown> | null;
  pendingTurns: number;
  media: { assets: number; renditions: number };
  boards: { boards: number; trips: number };
  /** Not restored by design; recorded so the drill can state it. */
  notRestored: { signInIdentities: number; connections: number; assistantGrants: number };
}

async function tableExists(db: Db, table: string): Promise<boolean> {
  return (await first(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", table)) !== null;
}

async function count(db: Db, table: string, userId: string, where = ""): Promise<number> {
  if (!(await tableExists(db, table))) return 0;
  return (await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?${where ? ` AND ${where}` : ""}`, userId))?.n ?? 0;
}

const digestOf = (values: string[]): Promise<string> => sha256Hex(values.join("\n"));

/** The owner's state as a restore must reproduce it. Read with the owner's own principal; nothing is written. */
export async function ownerStateDigest(app: App, principal: Principal): Promise<StateDigest> {
  const { db } = app;
  const userId = principal.userId;
  const snapshot = await readSnapshot(db, userId, toInstant(app.now()));
  const garmentIds = (await all<{ garment_id: string }>(db, "SELECT garment_id FROM garments WHERE user_id = ? ORDER BY garment_id", userId)).map((g) => g.garment_id);
  const balances = await all<{ bucket: string; q: number }>(db, "SELECT bucket, SUM(quantity) AS q FROM stock_balances WHERE user_id = ? GROUP BY bucket ORDER BY bucket", userId);
  const wears = await all<{ garment_id: string; wearing_date: string }>(db, "SELECT garment_id, wearing_date FROM daily_wears WHERE user_id = ? ORDER BY wearing_date, garment_id", userId);
  const versions = await all<{ version: number; content_sha256: string; status: string }>(db, "SELECT version, content_sha256, status FROM style_documents WHERE user_id = ? ORDER BY document_id, version", userId);
  const effects = await all<{ state: string; n: number }>(db, "SELECT state, COUNT(*) AS n FROM effects WHERE user_id = ? GROUP BY state ORDER BY state", userId);
  const tombstones = (await tableExists(db, "source_tombstones")) ? await all<{ source_kind: string; source_id: string }>(db, "SELECT source_kind, source_id FROM source_tombstones WHERE user_id = ? ORDER BY source_kind, source_id", userId) : [];
  let conversation: Record<string, unknown> | null = null;
  if (app.assistant) {
    try {
      conversation = await app.assistant.conversationWatermarks(principal);
    } catch (error) {
      console.warn("conversation watermarks unavailable", String((error as Error)?.message ?? error));
    }
  }
  return {
    ledger: { wardrobeRevision: snapshot.wardrobeRevision, styleRevision: snapshot.styleRevision, commandCount: snapshot.commandCount, lastCommandRecordedAt: snapshot.lastCommandRecordedAt },
    inventory: { garments: garmentIds.length, garmentIdsSha256: await digestOf(garmentIds), aliases: await count(db, "garment_aliases", userId), restrictionsActive: await count(db, "restrictions", userId, "status = 'active'") },
    quantities: { byBucket: Object.fromEntries(balances.map((b) => [b.bucket, b.q])), movements: await count(db, "stock_events", userId) },
    wear: { countedWears: wears.length, countedWearsSha256: await digestOf(wears.map((w) => `${w.wearing_date}|${w.garment_id}`)), observations: await count(db, "wear_observations", userId) },
    style: { versions: versions.map((v) => ({ version: v.version, contentSha256: v.content_sha256, status: v.status })), rules: await count(db, "style_rules", userId), amendments: await count(db, "style_amendments", userId), factConflicts: await count(db, "style_fact_conflicts", userId) },
    effects: Object.fromEntries(effects.map((e) => [e.state, e.n])),
    tombstones: { count: tombstones.length, sha256: await digestOf(tombstones.map((t) => `${t.source_kind}|${t.source_id}`)) },
    conversation,
    pendingTurns: await count(db, "assistant_turns", userId, "status IN ('accepted', 'running', 'needs_input', 'resumable')"),
    media: { assets: await count(db, "media_assets", userId), renditions: await count(db, "media_renditions", userId) },
    boards: { boards: await count(db, "boards", userId), trips: await count(db, "trips", userId) },
    notRestored: { signInIdentities: await count(db, "auth_identities", userId, "unlinked_at IS NULL"), connections: await count(db, "connection_profiles", userId, "state != 'disconnected'"), assistantGrants: await count(db, "mcp_grants", userId, "status = 'active'") },
  };
}

export const RESTORE_MANIFEST_FORMAT = "garderobe-restore-manifest/1";

/* ------------------------------------------------------------------ */
/* Taking backups                                                       */
/* ------------------------------------------------------------------ */

function hooksFor(app: App, principal: Principal, ownerRef: string): BackupHooks {
  return {
    ownerRef,
    restoreManifest: async ({ backupId, snapshot, coherent, components }) => ({
      format: RESTORE_MANIFEST_FORMAT,
      backupId,
      ownerRef,
      /** Snapshot times: when each store was read. The ledger and the workstream records were read under one version boundary. */
      snapshot: { takenAt: snapshot.takenAt, coherent, stores: { ledger: snapshot.takenAt, records: snapshot.takenAt, conversation: toInstant(app.now()), media: toInstant(app.now()) } },
      components,
      /** What the restored owner must show. `conversation` carries the projection watermarks (recall index, search projection). */
      state: await ownerStateDigest(app, principal),
      afterRestore: ["Import replays no external effect: effects that were pending are restored as cancelled, completed ones keep their recorded outcome.", "The recall index is rebuilt from the restored messages before search is reported complete.", "The tombstone journal is replayed so sources forgotten after this backup stay forgotten.", "Sign-ins, credentials and assistant grants are not restored: sign in through claim or recovery and reconnect services."],
    }),
  };
}

async function createBackupJob(app: App, userId: string, clientRequestId: string, channel: Principal["channel"], nowMs: number): Promise<string> {
  const existing = await first<{ export_id: string }>(app.db, "SELECT export_id FROM export_jobs WHERE user_id = ? AND client_request_id = ?", userId, clientRequestId);
  if (existing) return existing.export_id;
  const run = await createApiRun(app.db, { userId, kind: "export", clientRequestId, request: { backup: true }, channel, nowMs });
  const backupId = `bkp_${toBase64Url(randomBytes(12))}`;
  await prepare(
    app.db,
    stmt(
      "INSERT INTO export_jobs (user_id, export_id, run_id, client_request_id, state, encrypted, format_version, requested_at, purpose) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, 'backup') ON CONFLICT (user_id, client_request_id) DO NOTHING",
      userId,
      backupId,
      run.runId,
      clientRequestId,
      "garderobe-export/1",
      toInstant(nowMs),
    ),
  ).run();
  return (await first<{ export_id: string }>(app.db, "SELECT export_id FROM export_jobs WHERE user_id = ? AND client_request_id = ?", userId, clientRequestId))!.export_id;
}

/** Take (or finish) one backup of one owner. */
export async function runBackup(app: App, userId: string, clientRequestId: string, channel: Principal["channel"], nowMs: number): Promise<ExportJobRow> {
  const backupId = await createBackupJob(app, userId, clientRequestId, channel, nowMs);
  const principal = createPrincipal({ userId, actor: "system", channel: "system", scopes: ["read", "write"], authRef: `backup:${backupId}` });
  await advanceExport(app, userId, backupId, undefined, hooksFor(app, principal, await ownerRefOf(app.env, userId)));
  await writeTombstoneJournal(app, userId, nowMs);
  return (await loadExportJob(app, userId, backupId))!;
}

/** The scheduled sweep: owners whose newest backup is older than a day get one; unfinished backups are finished. */
export async function runScheduledBackups(app: App, nowMs: number): Promise<{ taken: string[]; journals: number }> {
  const due = await all<{ user_id: string }>(
    app.db,
    `SELECT u.user_id FROM users u WHERE u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM export_jobs j WHERE j.user_id = u.user_id AND j.purpose = 'backup' AND j.state IN ('completed', 'completed_incomplete') AND j.requested_at > ?)
     ORDER BY u.user_id LIMIT ?`,
    toInstant(nowMs - BACKUP_INTERVAL_MS),
    BACKUPS_PER_SWEEP,
  );
  const taken: string[] = [];
  for (const { user_id: userId } of due) {
    try {
      // One request ID per owner and day: a sweep that is repeated or interrupted continues the same backup.
      const row = await runBackup(app, userId, `backup:${toInstant(nowMs).slice(0, 10)}`, "scheduled", nowMs);
      if (row.state === "completed" || row.state === "completed_incomplete") taken.push(row.export_id);
    } catch (error) {
      console.error("scheduled backup failed", String((error as Error)?.message ?? error));
    }
  }
  // Journals are refreshed for every owner who has a backup, so later deletions reach earlier backups.
  const owners = await all<{ user_id: string }>(app.db, "SELECT DISTINCT j.user_id FROM export_jobs j JOIN users u ON u.user_id = j.user_id WHERE j.purpose = 'backup' AND u.status = 'active' LIMIT 200");
  for (const { user_id: userId } of owners) await writeTombstoneJournal(app, userId, nowMs);
  return { taken, journals: owners.length };
}

/* ------------------------------------------------------------------ */
/* Tombstone journal                                                    */
/* ------------------------------------------------------------------ */

export interface TombstoneJournal {
  format: "garderobe-tombstones/1";
  ownerRef: string;
  writtenAt: string;
  tombstones: { sourceKind: string; sourceId: string; requestedAt: string }[];
  /** The visual wardrobe's deletion journal (`garderobe-media-deletions/1`), when that module is installed. */
  mediaDeletions?: Record<string, unknown>;
}

export async function readTombstones(app: App, userId: string, nowMs: number): Promise<TombstoneJournal> {
  const rows = (await tableExists(app.db, "source_tombstones")) ? await all<{ source_kind: string; source_id: string; requested_at: string }>(app.db, "SELECT source_kind, source_id, requested_at FROM source_tombstones WHERE user_id = ? ORDER BY requested_at, source_kind, source_id", userId) : [];
  const reader = createPrincipal({ userId, actor: "system", channel: "system", scopes: ["read", "write"], authRef: "backup:journal" });
  const mediaDeletions = app.media ? await app.media.listDeletions(reader) : null;
  return { format: "garderobe-tombstones/1", ownerRef: await ownerRefOf(app.env, userId), writtenAt: toInstant(nowMs), tombstones: rows.map((r) => ({ sourceKind: r.source_kind, sourceId: r.source_id, requestedAt: r.requested_at })), ...(mediaDeletions ? { mediaDeletions } : {}) };
}

async function writeTombstoneJournal(app: App, userId: string, nowMs: number): Promise<void> {
  const journal = JSON.stringify(await readTombstones(app, userId, nowMs));
  await app.env.EXPORT_BUCKET.put(tombstoneJournalKey(userId), journal, { httpMetadata: { contentType: "application/json" } });
  await app.env.EXPORT_BUCKET.put(journalByOwnerRefKey(await ownerRefOf(app.env, userId)), journal, { httpMetadata: { contentType: "application/json" } });
}

/** The journal kept in this deployment for the owner a backup package came from, or null. */
export async function journalForOwnerRef(app: App, ownerRef: string): Promise<TombstoneJournal | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(ownerRef)) return null;
  const object = await app.env.EXPORT_BUCKET.get(journalByOwnerRefKey(ownerRef));
  if (!object) return null;
  const journal = parseJson<TombstoneJournal | null>(await object.text(), null);
  return journal && journal.format === "garderobe-tombstones/1" && journal.ownerRef === ownerRef ? journal : null;
}

/* ------------------------------------------------------------------ */
/* Owner-facing reads                                                   */
/* ------------------------------------------------------------------ */

function toBackup(row: ExportJobRow) {
  const job = exportJobOf(row);
  return { backupId: job.exportId, runId: job.runId, state: job.state, complete: job.complete, takenAt: job.snapshot?.takenAt ?? null, requestedAt: job.requestedAt, finishedAt: job.finishedAt, expiresAt: job.expiresAt, byteLength: job.byteLength, sha256: job.sha256, components: job.components, restoreManifest: parseJson<Record<string, unknown> | null>(row.restore_manifest_json, null) };
}

export async function listBackups(app: App, session: OwnerSession) {
  const rows = await all<ExportJobRow>(app.db, "SELECT * FROM export_jobs WHERE user_id = ? AND purpose = 'backup' ORDER BY requested_at DESC LIMIT 60", session.userId);
  return { backups: rows.map(toBackup), retentionDays: 35, intervalHours: BACKUP_INTERVAL_MS / 3_600_000 };
}

export async function requestBackup(app: App, session: OwnerSession, clientRequestId: string) {
  const nowMs = app.now();
  await rateLimit(app.db, `backup:${session.userId}`, 12, 3600, nowMs);
  const audit = await auditStatement({ userId: session.userId, kind: "backup.requested", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: {}, nowMs });
  await prepare(app.db, audit.statement).run();
  return toBackup(await runBackup(app, session.userId, `backup:manual:${clientRequestId}`, session.principal.channel, nowMs));
}

/* ------------------------------------------------------------------ */
/* Restore verification                                                 */
/* ------------------------------------------------------------------ */

export interface RestoreCheck {
  name: string;
  ok: boolean;
  expected: unknown;
  actual: unknown;
  note?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * After a backup package was imported into this (previously empty) owner: replay the tombstone journal,
 * bring the derived indexes up to date, then compare the owner's state with the restore manifest. The
 * restore is only reported complete when every check holds.
 */
export async function verifyRestore(app: App, session: OwnerSession, input: { restoreManifest: Record<string, unknown>; tombstones?: TombstoneJournal | null }): Promise<{ complete: boolean; checks: RestoreCheck[]; tombstonesReplayed: number; mediaDeletionsReplayed: { assetsDeleted: number; originalsPurged: number }; verifiedAt: string }> {
  const manifest = input.restoreManifest as { format?: string; ownerRef?: string; state?: StateDigest };
  if (manifest.format !== RESTORE_MANIFEST_FORMAT || !manifest.state) throw new ApiException("invalid_command", "that is not a Garderobe restore manifest");
  const expected = manifest.state;
  const principal = session.principal;

  // Tombstones recorded after the backup was taken: the source is forgotten again before anything is searched.
  let replayed = 0;
  const journal = input.tombstones ?? null;
  if (journal) {
    if (journal.format !== "garderobe-tombstones/1" || journal.ownerRef !== manifest.ownerRef) throw new ApiException("invalid_command", "the tombstone journal does not belong to this backup's owner");
    const present = new Set((await readTombstones(app, session.userId, app.now())).tombstones.map((t) => `${t.sourceKind}|${t.sourceId}`));
    const missing = journal.tombstones.filter((t) => !present.has(`${t.sourceKind}|${t.sourceId}`));
    const byKind = new Map<string, string[]>();
    for (const t of missing) byKind.set(t.sourceKind, [...(byKind.get(t.sourceKind) ?? []), t.sourceId]);
    for (const [sourceKind, ids] of byKind) {
      for (let i = 0; i < ids.length; i += 200) {
        const sourceIds = ids.slice(i, i + 200);
        await app.service.execute(principal, { type: "conversation.forget_source", payload: { sourceKind, sourceIds, reason: "forgotten after the restored backup was taken" }, idempotencyKey: `restore-tombstones:${await sha256Hex(`${manifest.ownerRef}|${sourceKind}|${sourceIds.join(",")}`)}`, expectedVersions: {}, authorization: "owner_tap", source: { channel: principal.channel } });
        replayed += sourceIds.length;
      }
    }
  }
  // Images deleted (and originals purged) after the backup was taken are deleted again, through the command
  // service, before the media check; the purge of their stored files is dispatched with the other media jobs.
  let mediaReplayed = { assetsDeleted: 0, originalsPurged: 0 };
  if (journal?.mediaDeletions && app.media) {
    mediaReplayed = await app.media.replayDeletions(principal, journal.mediaDeletions);
    await app.media.afterCommit();
  }
  // Erasures and the recall index are brought up to date before the comparison (and before search is relied on).
  if (app.assistant) await app.assistant.maintenance(app.now());

  const actual = await ownerStateDigest(app, principal);
  const checks: RestoreCheck[] = [];
  const check = (name: string, e: unknown, a: unknown, note?: string) => checks.push({ name, ok: same(e, a), expected: e, actual: a, ...(note ? { note } : {}) });
  check("garments and their identifiers", expected.inventory, actual.inventory);
  check("quantities by bucket and movement count", expected.quantities, actual.quantities);
  check("counted wears", expected.wear, actual.wear);
  check("style versions with their content hashes", expected.style.versions, actual.style.versions);
  check("style rules, amendments and open conflicts", { rules: expected.style.rules, amendments: expected.style.amendments, factConflicts: expected.style.factConflicts }, { rules: actual.style.rules, amendments: actual.style.amendments, factConflicts: actual.style.factConflicts });
  check("ledger revisions", { wardrobeRevision: expected.ledger.wardrobeRevision, styleRevision: expected.ledger.styleRevision }, { wardrobeRevision: actual.ledger.wardrobeRevision, styleRevision: actual.ledger.styleRevision });
  // Deleted images keep their records (marked deleted), so the counts are compared as they are; what the
  // journal says is gone must not be readable again.
  check("media assets and renditions", expected.media, actual.media);
  if (journal?.mediaDeletions && app.media) {
    const named = ((journal.mediaDeletions as { deletedAssets?: { assetId: string }[] }).deletedAssets ?? []).map((d) => d.assetId);
    const readable: string[] = [];
    for (const assetId of named) {
      const opened = await app.media.openAsset(principal, assetId, { variant: "display" }).then(() => true, () => false);
      if (opened) readable.push(assetId);
    }
    checks.push({ name: "images deleted after the backup stay deleted", ok: readable.length === 0, expected: [], actual: readable, note: `${named.length} deleted image(s) in the journal; ${mediaReplayed.assetsDeleted} had come back with the backup and were deleted again` });
  }
  check("boards and trips", expected.boards, actual.boards);
  check("pending turns", expected.pendingTurns, actual.pendingTurns);
  const messages = (c: Record<string, unknown> | null) => (c ? { messageCount: c.messageCount ?? null, lastMessageId: c.lastMessageId ?? null, compactionOverlays: c.compactionOverlays ?? null } : null);
  // Messages forgotten through the journal are, correctly, no longer there.
  if (replayed === 0) check("conversation messages and compaction overlays", messages(expected.conversation), messages(actual.conversation));
  else checks.push({ name: "conversation messages and compaction overlays", ok: actual.conversation !== null, expected: messages(expected.conversation), actual: messages(actual.conversation), note: `${replayed} source(s) forgotten after the backup were forgotten again, so the restored conversation is smaller by design` });
  const indexed = actual.conversation ? (actual.conversation.indexedThrough ?? null) : null;
  const lastAuthored = actual.conversation ? (actual.conversation.lastAuthoredAt ?? null) : null;
  checks.push({ name: "recall index rebuilt through the last restored message", ok: actual.conversation === null ? expected.conversation === null : indexed === lastAuthored, expected: lastAuthored, actual: indexed });
  const journalSet = journal ? new Set((await readTombstones(app, session.userId, app.now())).tombstones.map((t) => `${t.sourceKind}|${t.sourceId}`)) : null;
  const journalHeld = journal && journalSet ? journal.tombstones.every((t) => journalSet.has(`${t.sourceKind}|${t.sourceId}`)) : true;
  checks.push({
    name: "deletion tombstones",
    ok: journal ? journalHeld && actual.tombstones.count >= expected.tombstones.count : same(expected.tombstones, actual.tombstones),
    expected: journal ? { everyJournalEntryPresent: true, atLeast: expected.tombstones.count } : expected.tombstones,
    actual: journal ? { everyJournalEntryPresent: journalHeld, count: actual.tombstones.count } : actual.tombstones,
  });
  // Effects: nothing may be left to send; what was completed keeps its recorded outcome.
  const pending = (actual.effects.pending ?? 0) + (actual.effects.in_progress ?? 0);
  checks.push({ name: "no external effect left to send", ok: pending === 0, expected: 0, actual: pending, note: "effects that were pending in the backup are restored as cancelled" });
  const settled = (e: Record<string, number>) => Object.fromEntries(Object.entries(e).filter(([state]) => !["pending", "in_progress", "cancelled"].includes(state)));
  check("completed effects keep their recorded outcome", settled(expected.effects), settled(actual.effects));
  checks.push({ name: "sign-ins, connections and assistant grants", ok: true, expected: expected.notRestored, actual: actual.notRestored, note: "not restored by design: sign in through claim or recovery and reconnect services" });
  return { complete: checks.every((c) => c.ok), checks, tombstonesReplayed: replayed, mediaDeletionsReplayed: mediaReplayed, verifiedAt: toInstant(app.now()) };
}
