/**
 * Portable export and clean import of the visual wardrobe (specification section 15, "Portable owner export").
 *
 * Export: documented JSON records (assets with source and match evidence, renditions with their
 * transformation history, fidelity reports, discovery attempts and candidates, per-garment image state,
 * saved combinations, day plans) plus the list of image files to include, each with its checksum.
 * Excluded: upload authorizations, job bookkeeping, signing material, and rendered previews (a cache that
 * is rebuilt from the manifests). Deleted assets are exported as tombstones only.
 *
 * Import: into an EMPTY owner, preserving every ID. Files are re-keyed under the new owner's prefix and
 * verified against their checksums before any row is written. Nothing external is replayed: no job is
 * queued, and day plans arrive flagged for re-validation.
 */
import { z } from "zod";
import { all, allIn, assertPrincipal, CommandError, define, first, prepare, requireScope, sha256Hex, stmt, toInstant, type CommandDefinition, type PlannedOutbox, type Principal, type Stmt } from "@garderobe/domain";
import { planAssetRemoval } from "./commands/assets.ts";
import { MediaSource } from "@garderobe/contracts/ext/media";
import { execAs } from "./exec.ts";
import { decodeImage, probeImage, withoutLocation } from "./image/index.ts";
import { jpegScanDataBytes } from "./image/jpeg.ts";
import { assertOwnedKey, extensionFor, ownerPrefix } from "./keys.ts";
import { limitsOf, resolveDeps, type MediaDepsSource, type MediaRuntime } from "./runtime.ts";
import { enqueueJob, loadRenditions, type AssetRow } from "./store.ts";

export const MEDIA_EXPORT_FORMAT = "garderobe-media-export-1";
/** The most rows of one kind a single import command carries. */
const IMPORT_ROWS_PER_SET = 400;
export const MEDIA_DELETIONS_FORMAT = "garderobe-media-deletions/1";

/**
 * What was deleted, for backups. A backup taken before a deletion still holds the image until the backup
 * expires; this journal is kept beside the backups (rebuilt at any time from the rows that remain after a
 * deletion) and applied whenever a backup is restored, so a deleted image never comes back.
 */
export interface MediaDeletionJournal {
  format: typeof MEDIA_DELETIONS_FORMAT;
  writtenAt: string;
  /** Images deleted by the owner, rejected in review or unusable: every file of the asset is gone. */
  deletedAssets: { assetId: string; deletedAt: string | null; renditionIds: string[]; files: string[] }[];
  /** Selfies whose full-resolution original was removed under the photo-history setting; the reduced copy remains. */
  purgedOriginals: { assetId: string; renditionId: string; purgedAt: string; file: string }[];
}

/** Image types that may be imported (and are the only ones ever served). */
const IMPORTABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

/**
 * Package-relative path of a stored object: the storage key without the owner's prefix, e.g.
 * `assets/<assetId>/cutout-v1-<sha16>.png`. Exports and journals carry these, never storage keys: the
 * bucket layout and the owner's ID are not part of what a read returns.
 */
function relativeFile(userId: string, key: string): string {
  assertOwnedKey(userId, key);
  return key.slice(ownerPrefix(userId).length);
}

/** The package-relative path named by an export entry: accepts the current relative form and the earlier `u/<owner>/...` form. */
function toRelative(file: unknown): string | null {
  const text = String(file ?? "");
  const rest = /^u\/[^/]+\/(.+)$/.exec(text)?.[1] ?? text;
  return /^assets\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_.-]{1,160}$/.test(rest) && !rest.includes("..") ? rest : null;
}

/**
 * How the supplied photographs (the `original` files) leave in a package.
 *
 *  - `location_removed` (the default): every original is written without its location data and other
 *    metadata (lossless; the image data is copied as it is), and the package's checksums describe the files
 *    as written. An original in a format that cannot be rewritten here (HEIC) is left out and listed.
 *  - `as_supplied`: the originals exactly as stored, location data included. For two callers only: the
 *    owner, who chose it for this one export after being told what the files contain, and the service's
 *    own backups, which never leave the service. An assistant, or anything on the `mcp` channel, cannot ask.
 */
export type ExportOriginals = "location_removed" | "as_supplied";

export interface MediaExportOptions {
  originals?: ExportOriginals;
}

/**
 * Who may take the photographs as supplied: the owner outside the `mcp` channel, and the service's own
 * background work (a backup runs as the system actor on the `system` or `scheduled` channel). The system
 * actor on any other channel (an import, a conversation turn, a connection) cannot.
 */
function mayTakeAsSupplied(principal: Principal): boolean {
  if (principal.actor === "owner") return principal.channel !== "mcp";
  return principal.actor === "system" && (principal.channel === "system" || principal.channel === "scheduled");
}

function originalsMode(principal: Principal, opts: MediaExportOptions): ExportOriginals {
  const mode = opts.originals ?? "location_removed";
  if (mode !== "location_removed" && mode !== "as_supplied") throw new CommandError("invalid_command", "originals is either 'location_removed' or 'as_supplied'");
  if (mode === "as_supplied" && !mayTakeAsSupplied(principal)) {
    throw new CommandError("forbidden", "photographs are exported with their location data only when the owner asks for it in their own app", { reason: "owner_opt_in_required" });
  }
  return mode;
}

/**
 * The service's background work builds both portable exports and backups as the system actor. A backup must
 * keep every photograph, so when such a caller did not say how originals leave and some original cannot be
 * written without its location data, the package is refused rather than built with that photograph missing
 * (it would read as deleted, and a restore would lose it). Naming `location_removed` or `as_supplied` settles it.
 */
function refuseSilentWithholding(principal: Principal, opts: MediaExportOptions, withheld: number): void {
  if (withheld === 0 || opts.originals !== undefined || principal.actor !== "system") return;
  throw new CommandError("precondition_failed", "some photographs cannot be written without their location data; the package must say whether originals leave as supplied (a backup) or without their location (a portable export)", { reason: "originals_choice_required", withheld });
}

/**
 * Read one exported file of the caller's OWN media by its package-relative path (as listed in
 * `exportMediaData().assets[].file`). Returns null when there is no such file. Used by the code that
 * builds export and backup packages; it never reads outside the caller's own images.
 *
 * Pass the same `originals` choice as to `exportMediaData`. By default an original is returned without
 * its location data (the bytes the package's checksum describes), and one that cannot be rewritten is
 * not returned at all.
 */
export async function readExportFile(rt: MediaRuntime, principal: Principal, file: string, opts: MediaExportOptions = {}): Promise<ArrayBuffer | null> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const mode = originalsMode(principal, opts);
  if (/^u\//.test(file) && !file.startsWith(ownerPrefix(principal.userId))) return null; // another owner's key in the earlier form
  const rest = toRelative(file);
  if (!rest) return null;
  const key = `${ownerPrefix(principal.userId)}${rest}`;
  assertOwnedKey(principal.userId, key);
  // Only a file the package lists: an active or superseded rendition of an image that is neither deleted nor
  // rejected. A deleted image whose stored files are still waiting for the purge is never read, in either mode.
  const record = await first<{ kind: string }>(
    rt.db,
    "SELECT r.kind FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id WHERE r.user_id = ? AND r.object_key = ? AND r.status IN ('active', 'superseded') AND a.status NOT IN ('deleted', 'rejected')",
    principal.userId,
    key,
  );
  if (!record) return null;
  const object = await rt.deps.bucket.get(key);
  if (!object) return null;
  if (mode === "as_supplied") return object.arrayBuffer();
  // Derived files are written by this package from pixels. An original is rewritten without its location data.
  if (record.kind !== "original") return object.arrayBuffer();
  const clean = withoutLocation(new Uint8Array(await object.arrayBuffer()));
  if (!clean.ok) return null;
  return clean.bytes.buffer.slice(clean.bytes.byteOffset, clean.bytes.byteOffset + clean.bytes.byteLength) as ArrayBuffer;
}

type Row = Record<string, unknown>;

/**
 * Rendition rows in dependency order: a rendition comes after the rendition its `source_rendition_id` names.
 * Rows without a source keep their relative order. A source that is not among the rows, or a cycle, is an
 * invalid import.
 */
/**
 * Exported for tests: rendition rows in dependency order (see the import command). `external` names renditions
 * this same import already committed in an earlier command (images are packed into several commands, so a
 * derived image's source may be in an earlier one); a source neither among the rows nor there is refused.
 */
export function sourceOrder(rows: Row[], external: ReadonlySet<string> = new Set()): Row[] {
  const byId = new Map<string, Row>();
  for (const r of rows) {
    const id = String(r.rendition_id ?? "");
    if (!id || byId.has(id)) throw new CommandError("invalid_command", "every imported file record needs its own ID");
    byId.set(id, r);
  }
  const out: Row[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (r: Row) => {
    const id = String(r.rendition_id);
    const seen = state.get(id);
    if (seen === "done") return;
    if (seen === "visiting") throw new CommandError("invalid_command", `file ${id} is derived, through other files, from itself`);
    state.set(id, "visiting");
    const source = r.source_rendition_id;
    if (source !== null && source !== undefined) {
      const parent = byId.get(String(source));
      if (parent) visit(parent);
      else if (!external.has(String(source))) throw new CommandError("invalid_command", `file ${id} names a source file that is not in the same import`);
    }
    state.set(id, "done");
    out.push(r);
  };
  for (const r of rows) visit(r);
  return out;
}

export interface MediaExportFile {
  assetId: string;
  renditionId: string;
  kind: string;
  /** The key inside the exporting owner's private prefix; the package stores the file under this path. */
  /** Path of the file inside the package (relative; never a storage key): `assets/<assetId>/<kind>-...`. */
  file: string;
  contentType: string;
  byteLength: number;
  sha256: string;
  /** For an original: `removed` when the file is written without its location data, `as_supplied` when it is the stored photograph. */
  location?: "removed" | "as_supplied";
}

export interface MediaExport {
  format: typeof MEDIA_EXPORT_FORMAT;
  exportedAt: string;
  /** How the supplied photographs were written (see `ExportOriginals`). */
  originals: ExportOriginals;
  /** Originals left out because their location data could not be removed; their derived copies are included. */
  withheldOriginals: { assetId: string; renditionId: string; reason: string }[];
  records: {
    assets: Row[];
    renditions: Row[];
    fidelityChecks: Row[];
    garmentMedia: Row[];
    discoveryAttempts: Row[];
    candidates: Row[];
    combinations: Row[];
    combinationItems: Row[];
    dayPlans: Row[];
    dayPlanItems: Row[];
    composites: Row[];
    deletedAssets: { assetId: string; deletedAt: string | null }[];
  };
  assets: MediaExportFile[];
  notes: string[];
}

function strip(rows: Row[]): Row[] {
  return rows.map(({ user_id: _owner, command_id: _command, ...rest }) => rest);
}

export async function exportMediaData(rt: MediaRuntime, principal: Principal, opts: MediaExportOptions = {}): Promise<MediaExport> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const mode = originalsMode(principal, opts);
  const u = principal.userId;
  const q = (sql: string) => all<Row>(rt.db, sql, u);
  const assets = await q("SELECT * FROM media_assets WHERE user_id = ? AND status NOT IN ('deleted', 'rejected') ORDER BY created_at, asset_id");
  // A selfie original removed under the photo-history setting is exported as a record without a file, so the
  // reduced copy derived from it keeps its recorded source.
  const renditions = await q("SELECT r.* FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id WHERE r.user_id = ? AND (r.status IN ('active', 'superseded') OR (r.status = 'deleted' AND r.kind = 'original')) AND a.status NOT IN ('deleted', 'rejected') ORDER BY r.created_at, r.rendition_id");
  const deleted = await all<{ asset_id: string; deleted_at: string | null }>(rt.db, "SELECT asset_id, deleted_at FROM media_assets WHERE user_id = ? AND status IN ('deleted', 'rejected') ORDER BY asset_id", u);
  const live = new Set(assets.map((a) => a.asset_id as string));
  // By default the supplied photographs leave without their location data. The package's records and
  // checksums describe each original as it is written, so an import verifies exactly those bytes.
  const rewritten = new Map<string, { sha256: string; byteLength: number }>();
  const withheld = new Map<string, string>();
  if (mode === "location_removed") {
    for (const r of renditions) {
      if (r.kind !== "original" || r.status === "deleted") continue;
      assertOwnedKey(u, r.object_key as string);
      const object = await rt.deps.bucket.get(r.object_key as string);
      if (!object) continue; // a missing file stays listed; the package builder reports it as missing
      const clean = withoutLocation(new Uint8Array(await object.arrayBuffer()));
      if (clean.ok) rewritten.set(r.rendition_id as string, { sha256: await sha256Hex(clean.bytes), byteLength: clean.bytes.length });
      else withheld.set(r.rendition_id as string, clean.reason);
    }
  }
  refuseSilentWithholding(principal, opts, withheld.size);
  const withoutItsLocation = new Set(renditions.filter((r) => rewritten.has(r.rendition_id as string) || withheld.has(r.rendition_id as string)).map((r) => r.asset_id as string));
  const asWritten = (r: Row): Row => {
    const id = r.rendition_id as string;
    // A withheld original is exported as a record without a file, as a purged selfie original is, so the copies derived from it keep their recorded source.
    if (withheld.has(id)) return { ...r, status: "deleted" };
    const written = rewritten.get(id);
    return written ? { ...r, sha256: written.sha256, byte_length: written.byteLength } : r;
  };
  return {
    format: MEDIA_EXPORT_FORMAT,
    exportedAt: toInstant(rt.clock()),
    originals: mode,
    withheldOriginals: renditions.filter((r) => withheld.has(r.rendition_id as string)).map((r) => ({ assetId: r.asset_id as string, renditionId: r.rendition_id as string, reason: withheld.get(r.rendition_id as string)! })),
    records: {
      // upload_id points at an upload authorization, which is not exported; the dangling reference is dropped.
      // had_location_metadata describes the file in this package: 0 once the location data has been left out.
      assets: strip(assets).map(({ upload_id: _upload, ...a }) => (withoutItsLocation.has(a.asset_id as string) ? { ...a, had_location_metadata: 0 } : a)),
      renditions: strip(renditions).map(asWritten).map(({ object_key, ...r }) => ({ ...r, file: relativeFile(u, object_key as string) })),
      fidelityChecks: strip((await q("SELECT * FROM media_fidelity_checks WHERE user_id = ? ORDER BY created_at, check_id")).filter((f) => live.has(f.asset_id as string))),
      garmentMedia: strip(await q("SELECT * FROM garment_media WHERE user_id = ? ORDER BY garment_id")),
      discoveryAttempts: strip(await q("SELECT * FROM media_discovery_attempts WHERE user_id = ? ORDER BY created_at, attempt_id")),
      candidates: strip(await q("SELECT * FROM media_candidates WHERE user_id = ? ORDER BY created_at, candidate_id")).map((c) => (c.asset_id && !live.has(c.asset_id as string) ? { ...c, asset_id: null } : c)),
      combinations: strip(await q("SELECT * FROM studio_combinations WHERE user_id = ? ORDER BY created_at, combination_id")),
      combinationItems: strip(await q("SELECT * FROM studio_combination_items WHERE user_id = ? ORDER BY combination_id, role, garment_id")),
      dayPlans: strip(await q("SELECT * FROM studio_day_plans WHERE user_id = ? ORDER BY local_date, plan_id")),
      dayPlanItems: strip(await q("SELECT * FROM studio_day_plan_items WHERE user_id = ? ORDER BY plan_id, role, garment_id")),
      composites: strip(await q("SELECT manifest_hash, manifest_json, template_version, created_at, user_id FROM outfit_composites WHERE user_id = ? ORDER BY manifest_hash")),
      deletedAssets: deleted.map((d) => ({ assetId: d.asset_id, deletedAt: d.deleted_at })),
    },
    assets: renditions.filter((r) => r.status !== "deleted" && !withheld.has(r.rendition_id as string)).map((r) => {
      const written = rewritten.get(r.rendition_id as string);
      return {
        assetId: r.asset_id as string, renditionId: r.rendition_id as string, kind: r.kind as string, file: relativeFile(u, r.object_key as string), contentType: r.content_type as string,
        byteLength: written?.byteLength ?? (r.byte_length as number), sha256: written?.sha256 ?? (r.sha256 as string),
        ...(r.kind === "original" ? { location: mode === "as_supplied" ? ("as_supplied" as const) : ("removed" as const) } : {}),
      };
    }),
    notes: [
      mode === "as_supplied"
        ? "The supplied photographs (kind 'original') are included exactly as stored, with whatever location data and other metadata they carry."
        : "The supplied photographs (kind 'original') are written without their location data and other metadata; the picture itself is unchanged, and each checksum describes the file as written. An original whose location data could not be removed is left out and listed in withheldOriginals.",
      "Rows are the stored records with snake_case column names; *_json fields hold JSON text. `file` on a rendition and in the file list is its path inside this package, relative to the package's media folder.",
      "Each rendition names the rendition it was derived from (source_rendition_id) and lists its transformation steps (transformations_json); edited = 1 means a generative step contributed and the image is not evidence for fabric or fit.",
      "is_demo = 1 marks a labelled demo placeholder; kind 'generic_illustration' is an illustration, never a photograph of the garment.",
      "Rendered outfit previews are a cache and are not included; they are rebuilt from the composition manifests.",
      "A day plan is an intention for a date, never a wear. Deleted images appear only as tombstones (deletedAssets).",
      "Selfie originals removed under the photo-history setting are absent (their rendition record has status 'deleted' and no file); their reduced display copies remain.",
    ],
  };
}

const ImportPart = z.object({
  part: z.enum(["assets", "garmentMedia", "discovery", "studio", "composites"]),
  rows: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(IMPORT_ROWS_PER_SET)),
  /** The package digest of the import that holds the owner's import lock; checked inside the commit. Required: there is no lock-free import. */
  importDigest: z.string().regex(/^[0-9a-f]{32}$/),
  /** The plan digest of that import; checked inside the commit together with importDigest. */
  importPlanDigest: z.string().regex(/^[0-9a-f]{32}$/),
});

/** SQL (three parameters: user, package digest, plan digest): that import holds the owner's import lock. */
const IMPORT_LOCK_HELD = "EXISTS (SELECT 1 FROM media_import_locks WHERE user_id = ? AND package_digest = ? AND plan_digest = ?)";
/**
 * SQL (four parameters: user, user, key prefix, key prefix): no media or Studio command other than this import's own
 * was written for the owner after the lock was taken (ordered by command row, see migration 0404).
 */
const NOTHING_ELSE_SINCE_LOCK =
  "NOT EXISTS (SELECT 1 FROM commands c WHERE c.user_id = ? AND c.rowid > (SELECT command_rowid FROM media_import_locks WHERE user_id = ?) AND (c.type LIKE 'media.%' OR c.type LIKE 'studio.%') AND NOT (c.type = 'media.import_records' AND substr(c.idempotency_key, 1, length(?)) = ?))";
/** The idempotency-key prefix every command of one import into this owner carries. */
const importKeyPrefix = (userId: string, packageDigest: string) => `media-import:${userId}:${packageDigest}:`;

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const ReapplyDeletions = z.object({
  assetIds: z.array(z.string().min(1).max(64)).max(100).default([]),
  purgedOriginalAssetIds: z.array(z.string().min(1).max(64)).max(100).default([]),
  reason: z.string().max(300).default("deleted after the restored backup was taken"),
});

/** `media.import_records`: writes exported rows for the importing owner. Requires the import authorization (admin scope). */
export function portabilityCommands(depsSource?: MediaDepsSource): CommandDefinition<any>[] {
  const maxAttempts = () => (depsSource ? limitsOf(resolveDeps(depsSource)).jobMaxAttempts : 3);
  return [
    define({
      // Applies a deletion journal to an owner restored from a backup: whatever the backup brought back is deleted again.
      type: "media.reapply_deletions",
      schema: ReapplyDeletions,
      class: "edit",
      requiredScope: "write",
      allowedAuthorizations: ["owner_tap", "system_schedule", "data_import"],
      async plan(ctx, p) {
        if (ctx.principal.actor === "assistant") throw new CommandError("forbidden", "a restore is completed by the owner or the system, not by an assistant");
        const named = await allIn<AssetRow>(ctx.db, "SELECT * FROM media_assets WHERE user_id = ? AND asset_id IN (:ids)", [ctx.userId], [...new Set(p.assetIds)]);
        const live = named.filter((a) => a.status !== "deleted" && a.status !== "rejected");
        const derived = await allIn<AssetRow>(ctx.db, "SELECT * FROM media_assets WHERE user_id = ? AND status NOT IN ('deleted', 'rejected') AND derived_from_asset_id IN (:ids)", [ctx.userId], live.map((a) => a.asset_id));
        const removing = [...live, ...derived.filter((d) => !live.some((a) => a.asset_id === d.asset_id))];
        const statements: Stmt[] = [];
        const outbox: PlannedOutbox[] = [];
        const affected: { kind: string; id: string; version: number }[] = [];
        if (removing.length > 0) {
          const removal = await planAssetRemoval(ctx, removing, "deleted", p.reason, maxAttempts());
          statements.push(...(removal.statements ?? []));
          outbox.push(...(removal.outbox ?? []));
          affected.push(...(removal.affected ?? []));
          for (const a of removing) {
            statements.push(stmt("UPDATE media_candidates SET decision = 'rejected', rejection_reasons_json = '[\"owner_rejected\"]', decided_by = 'owner', updated_at = ? WHERE user_id = ? AND asset_id = ? AND decision != 'rejected'", ctx.now, ctx.userId, a.asset_id));
            outbox.push({ topic: "media.asset", entityKind: "media_asset", entityId: a.asset_id, revision: a.version + 1, payload: { deleted: true } });
          }
        }
        // Full-resolution selfie originals that had been removed: removed again, the reduced copy is kept.
        const removedIds = new Set(removing.map((a) => a.asset_id));
        const candidates = await allIn<AssetRow>(ctx.db, "SELECT * FROM media_assets WHERE user_id = ? AND asset_id IN (:ids)", [ctx.userId], [...new Set(p.purgedOriginalAssetIds)].filter((id) => !removedIds.has(id)));
        const keys: string[] = [];
        const cacheShas: string[] = [];
        let originalsPurged = 0;
        for (const a of candidates) {
          if (a.status === "deleted" || a.status === "rejected") continue;
          const renditions = await loadRenditions(ctx.db, ctx.userId, a.asset_id);
          const original = renditions.find((r) => r.kind === "original" && r.status !== "deleted");
          if (!original) continue;
          assertOwnedKey(ctx.userId, original.object_key);
          keys.push(original.object_key);
          cacheShas.push(original.sha256);
          const keepsCopy = renditions.some((r) => r.kind !== "original" && r.status === "active");
          statements.push(
            stmt("UPDATE media_renditions SET status = 'deleted' WHERE user_id = ? AND rendition_id = ?", ctx.userId, original.rendition_id),
            stmt("UPDATE media_assets SET original_purged_at = COALESCE(original_purged_at, ?), status = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND asset_id = ?", ctx.now, keepsCopy ? a.status : "deleted", "full-resolution original removed under the photo-history setting", ctx.now, ctx.userId, a.asset_id),
          );
          affected.push({ kind: "media_asset", id: a.asset_id, version: a.version + 1 });
          originalsPurged++;
        }
        if (keys.length > 0) {
          const job = enqueueJob(ctx, { jobId: ctx.newId("job"), kind: "purge_objects", subjectId: candidates[0]!.asset_id, dedupeKey: `purge-originals:${ctx.commandId}`, payload: { keys, cacheShas }, maxAttempts: maxAttempts() });
          statements.push(...job.statements);
          outbox.push(...job.outbox);
        }
        if (statements.length === 0) return { outcome: "noop", summary: "Nothing that was deleted has come back", result: { assetsDeleted: 0, originalsPurged: 0 }, undo: { unavailableReason: "nothing changed" } };
        return {
          summary: `Deleted again after the restore: ${removing.length} image(s)${originalsPurged > 0 ? ` and ${originalsPurged} full-resolution selfie original(s)` : ""}; their stored files are being purged`,
          statements,
          outbox,
          affected,
          result: { assetsDeleted: removing.length, originalsPurged },
          undo: { unavailableReason: "deleted image files are purged and cannot be restored" },
        };
      },
    }),
    define({
      type: "media.import_records",
      schema: ImportPart,
      class: "system",
      requiredScope: "admin",
      allowedAuthorizations: ["data_import"],
      async plan(ctx, p) {
        const u = ctx.userId;
        const statements: Stmt[] = [];
        const rows = (name: string) => p.rows[name] ?? [];
        const preconditions: { label: string; sql: string; params: unknown[]; class: "state" }[] = [];
        // Every import command names its package and plan (the schema requires both). It commits only while that
        // import holds the owner's lock and no other media or Studio command was written for the owner since the
        // lock was taken, both checked inside this commit: two packages are never mixed, and a continuation never
        // mixes restored records with changes made after the import began.
        const prefix = importKeyPrefix(u, p.importDigest);
        preconditions.push({ label: "this import still holds the owner's import lock", sql: IMPORT_LOCK_HELD, params: [u, p.importDigest, p.importPlanDigest], class: "state" });
        preconditions.push({ label: "nothing else changed this owner's media or Studio records since the import began", sql: NOTHING_ELSE_SINCE_LOCK, params: [u, u, prefix, prefix], class: "state" });
        const rekey = (file: unknown): string => {
          const rest = toRelative(file);
          if (!rest) throw new CommandError("invalid_command", "an exported file path is not a media file path");
          const out = `${ownerPrefix(u)}${rest}`;
          assertOwnedKey(u, out);
          return out;
        };
        if (p.part === "assets") {
          // Nothing is taken on trust from the package: every image record must say where it came from, be of
          // a known kind and state, and have at least one file that THIS import verified and stored (checked
          // against storage here, not against what the caller says). A record without a verified file would
          // make a garment claim a photograph that does not exist.
          const deps = depsSource ? resolveDeps(depsSource) : null;
          if (!deps) throw new CommandError("internal", "media import is not configured with storage");
          const liveAssets = rows("assets").filter((a) => a.status !== "deleted");
          const garmentIds = [...new Set(liveAssets.map((a) => s(a.garment_id)).filter((id): id is string => id !== null))];
          const garments = new Map((await allIn<{ garment_id: string; is_synthetic: number }>(ctx.db, "SELECT garment_id, is_synthetic FROM garments WHERE user_id = ? AND garment_id IN (:ids)", [u], garmentIds)).map((g) => [g.garment_id, g]));
          for (const a of rows("assets")) {
            const id = s(a.asset_id);
            if (!id) throw new CommandError("invalid_command", "an imported image record has no ID");
            if (!["active", "needs_review", "processing", "deleted"].includes(String(a.status))) throw new CommandError("invalid_command", `image ${id} has a state that cannot be imported`);
            const own = rows("renditions").filter((r) => r.asset_id === a.asset_id);
            if (a.status === "deleted") {
              // A tombstone: an image deleted after the package was made. It may carry no live file.
              if (own.some((r) => r.status !== "deleted")) throw new CommandError("invalid_command", `deleted image ${id} cannot bring files with it`);
              continue;
            }
            let source: unknown = null;
            try {
              source = JSON.parse(String(a.source_json ?? ""));
            } catch {
              source = null;
            }
            if (!MediaSource.safeParse(source).success) throw new CommandError("invalid_command", `image ${id} does not say where it came from; it was not imported`);
            const garmentId = s(a.garment_id);
            if (garmentId !== null && !garments.has(garmentId)) throw new CommandError("invalid_command", `image ${id} belongs to a garment that is not in this wardrobe`);
            // The same rule as for uploads: a demo placeholder is only ever attached to a synthetic fixture garment.
            if ((n(a.is_demo) ?? 0) === 1 && (garmentId === null || garments.get(garmentId)!.is_synthetic !== 1)) throw new CommandError("forbidden", `image ${id} is a demo placeholder and can only be attached to a synthetic fixture garment`);
            if (!own.some((r) => r.status !== "deleted")) throw new CommandError("invalid_command", `image ${id} has no verified file; it was not imported`);
          }
          for (const r of rows("renditions")) {
            if (!rows("assets").some((a) => a.asset_id === r.asset_id)) throw new CommandError("invalid_command", "a file record must belong to an image in the same import");
            if (r.status === "deleted") continue; // a record without a file (purged original, or part of a tombstone)
            if (!IMPORTABLE_TYPES.has(String(r.content_type))) throw new CommandError("invalid_command", `file ${String(r.rendition_id)} is not an accepted image type`);
            const head = await deps.bucket.head(rekey(r.file));
            if (!head || head.size !== n(r.byte_length) || head.customMetadata?.sha256 !== s(r.sha256) || head.customMetadata?.imported !== "true" || head.customMetadata?.kind !== s(r.kind) || head.customMetadata?.assetId !== s(r.asset_id) || head.httpMetadata?.contentType !== s(r.content_type)) {
              throw new CommandError("invalid_command", `file ${String(r.rendition_id)} was not verified and stored by this import; nothing was written`);
            }
          }
          preconditions.push({ label: "the importing owner has no media yet for these IDs", sql: `NOT EXISTS (SELECT 1 FROM media_assets WHERE user_id = ? AND asset_id IN (${rows("assets").map(() => "?").join(",") || "''"}))`, params: [u, ...rows("assets").map((a) => a.asset_id)], class: "state" });
          for (const a of rows("assets")) {
            statements.push(
              stmt(
                `INSERT INTO media_assets (user_id, asset_id, garment_id, kind, is_demo, status, status_reason, source_json, match_evidence_json, derived_from_asset_id, had_location_metadata, wearing_date, retain_original_until, original_purged_at, upload_id, version, command_id, created_at, updated_at, deleted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
                u, s(a.asset_id), s(a.garment_id), s(a.kind), n(a.is_demo) ?? 0, a.status === "processing" ? "active" : s(a.status), s(a.status_reason), s(a.source_json), s(a.match_evidence_json) ?? "{}", s(a.derived_from_asset_id),
                n(a.had_location_metadata) ?? 0, s(a.wearing_date), s(a.retain_original_until), s(a.original_purged_at), n(a.version) ?? 1, ctx.commandId, s(a.created_at), s(a.updated_at), a.status === "deleted" ? (s(a.deleted_at) ?? ctx.now) : null,
              ),
            );
          }
          // Sources before derivatives: each rendition after the one its source_rendition_id names (a cutout
          // after the edited copy it was cut from). A source may also be a rendition an earlier command of this
          // same import committed (the lock and the nothing-else-since check make every rendition the owner
          // holds this import's own). Any other source, or a cycle, is refused.
          const inCommand = new Set(rows("renditions").map((r) => String(r.rendition_id)));
          const outside = [...new Set(rows("renditions").map((r) => r.source_rendition_id).filter((x) => x !== null && x !== undefined).map(String).filter((id) => !inCommand.has(id)))];
          const external = new Set(outside.length === 0 ? [] : (await allIn<{ rendition_id: string }>(ctx.db, "SELECT rendition_id FROM media_renditions WHERE user_id = ? AND rendition_id IN (:ids)", [u], outside)).map((r) => r.rendition_id));
          const ordered = sourceOrder(rows("renditions"), external);
          for (const r of ordered) {
            statements.push(
              stmt(
                `INSERT INTO media_renditions (user_id, rendition_id, asset_id, kind, version, object_key, content_type, width, height, byte_length, sha256, source_rendition_id, transformations_json, edited, status, command_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                u, s(r.rendition_id), s(r.asset_id), s(r.kind), n(r.version), rekey(r.file), s(r.content_type), n(r.width), n(r.height), n(r.byte_length), s(r.sha256), s(r.source_rendition_id), s(r.transformations_json) ?? "[]", n(r.edited) ?? 0, s(r.status), ctx.commandId, s(r.created_at),
              ),
            );
          }
          for (const f of rows("fidelityChecks")) {
            statements.push(
              stmt(
                "INSERT INTO media_fidelity_checks (user_id, check_id, asset_id, subject, rendition_id, verdict, failed_json, checks_json, algorithm_version, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                u, s(f.check_id), s(f.asset_id), s(f.subject), s(f.rendition_id), s(f.verdict), s(f.failed_json) ?? "[]", s(f.checks_json), s(f.algorithm_version), ctx.commandId, s(f.created_at),
              ),
            );
          }
        } else if (p.part === "garmentMedia") {
          const media = rows("garmentMedia");
          // An import fills an owner that has no image state yet; a garment that already has some is refused
          // as a state conflict (a 4xx), never left to fail as a database constraint.
          const ids = media.map((m) => s(m.garment_id));
          if (ids.some((id) => id === null)) throw new CommandError("invalid_command", "an imported image-state record names no garment");
          if (new Set(ids).size !== ids.length) throw new CommandError("invalid_command", "the same garment appears twice in the imported image state");
          if (ids.length > 0) {
            const present = await allIn<{ garment_id: string }>(ctx.db, "SELECT garment_id FROM garment_media WHERE user_id = ? AND garment_id IN (:ids)", [u], ids as string[]);
            if (present.length > 0) throw new CommandError("precondition_failed", `${present.length} garment(s) already have image state; media can only be imported into an owner that has none yet`, { reason: "already_present", garmentIds: present.map((g) => g.garment_id) });
            // One check per batch of IDs, so a large import stays within the database's limit on bound parameters.
            const BATCH = 80;
            for (let i = 0; i < ids.length; i += BATCH) {
              const batch = ids.slice(i, i + BATCH);
              preconditions.push({ label: "these garments have no image state yet", sql: `NOT EXISTS (SELECT 1 FROM garment_media WHERE user_id = ? AND garment_id IN (${batch.map(() => "?").join(",")}))`, params: [u, ...batch], class: "state" });
            }
          }
          for (const m of media) {
            // A search that was in flight on the old service is not resumed: it becomes "not started" (or resolved when an image exists).
            const state = m.image_state === "searching" ? (m.primary_asset_id ? "resolved" : "not_started") : s(m.image_state);
            statements.push(
              stmt(
                "INSERT INTO garment_media (user_id, garment_id, image_state, primary_asset_id, photo_request, photos_needed_at, last_failure, discovery_json, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                u, s(m.garment_id), state, s(m.primary_asset_id), s(m.photo_request), s(m.photos_needed_at), s(m.last_failure), s(m.discovery_json) ?? "{}", n(m.version) ?? 1, s(m.updated_at),
              ),
            );
          }
        } else if (p.part === "discovery") {
          for (const a of rows("discoveryAttempts")) {
            statements.push(
              stmt(
                `INSERT INTO media_discovery_attempts (user_id, attempt_id, garment_id, strategy, query_hash, query_json, provider, pages_examined, browser_sessions, browser_seconds, outcome, detail, command_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                u, s(a.attempt_id), s(a.garment_id), s(a.strategy), s(a.query_hash), s(a.query_json), s(a.provider), n(a.pages_examined) ?? 0, n(a.browser_sessions) ?? 0, n(a.browser_seconds) ?? 0, s(a.outcome), s(a.detail), ctx.commandId, s(a.created_at),
              ),
            );
          }
          for (const c of rows("candidates")) {
            statements.push(
              stmt(
                `INSERT INTO media_candidates (user_id, candidate_id, garment_id, attempt_id, page_url, image_url, identifiers_json, evidence_json, decision, rejection_reasons_json, review_question, asset_id, image_sha256, retrieved_at, decided_by, command_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                u, s(c.candidate_id), s(c.garment_id), s(c.attempt_id), s(c.page_url), s(c.image_url), s(c.identifiers_json) ?? "{}", s(c.evidence_json) ?? "{}", s(c.decision), s(c.rejection_reasons_json) ?? "[]", s(c.review_question), s(c.asset_id), s(c.image_sha256), s(c.retrieved_at),
                s(c.decided_by) ?? "pipeline", ctx.commandId, s(c.created_at), s(c.updated_at),
              ),
            );
          }
        } else if (p.part === "studio") {
          for (const c of rows("combinations")) {
            statements.push(
              stmt(
                `INSERT INTO studio_combinations (user_id, combination_id, name, favourite, slots_json, signature, has_candidate, status, validation_json, manifest_hash, version, command_id, created_at, updated_at, removed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                u, s(c.combination_id), s(c.name), n(c.favourite) ?? 0, s(c.slots_json), s(c.signature), n(c.has_candidate) ?? 0, s(c.status), s(c.validation_json), s(c.manifest_hash), n(c.version) ?? 1, ctx.commandId, s(c.created_at), s(c.updated_at), s(c.removed_at),
              ),
            );
          }
          for (const i of rows("combinationItems")) statements.push(stmt("INSERT INTO studio_combination_items (user_id, combination_id, role, garment_id) VALUES (?, ?, ?, ?)", u, s(i.combination_id), s(i.role), s(i.garment_id)));
          for (const d of rows("dayPlans")) {
            statements.push(
              stmt(
                `INSERT INTO studio_day_plans (user_id, plan_id, local_date, combination_id, slots_json, status, needs_revalidation, revalidation_reason, validation_json, exposure_id, version, command_id, created_at, updated_at, removed_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, 'imported: re-check against current availability', ?, NULL, ?, ?, ?, ?, ?)`,
                u, s(d.plan_id), s(d.local_date), s(d.combination_id), s(d.slots_json), s(d.status), s(d.validation_json), n(d.version) ?? 1, ctx.commandId, s(d.created_at), s(d.updated_at), s(d.removed_at),
              ),
            );
          }
          for (const i of rows("dayPlanItems")) statements.push(stmt("INSERT INTO studio_day_plan_items (user_id, plan_id, role, garment_id) VALUES (?, ?, ?, ?)", u, s(i.plan_id), s(i.role), s(i.garment_id)));
        } else {
          for (const c of rows("composites")) {
            statements.push(stmt("INSERT INTO outfit_composites (user_id, manifest_hash, manifest_json, template_version, preview_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'none', ?, ?)", u, s(c.manifest_hash), s(c.manifest_json), s(c.template_version), s(c.created_at), ctx.now));
          }
        }
        if (statements.length === 0) return { outcome: "noop", summary: `No ${p.part} records to import`, undo: { unavailableReason: "nothing changed" } };
        return { summary: `Imported ${statements.length} ${p.part} record(s) of the visual wardrobe`, statements, preconditions, result: { part: p.part, rows: statements.length }, undo: { unavailableReason: "an import is not undone record by record; delete the imported owner instead" } };
      },
    }),
  ];
}

/**
 * Import an export into an EMPTY owner. `readAsset(file)` returns the bytes stored in the package for an
 * exported file path, or null when the package does not contain it. Missing or checksum-mismatched files
 * are reported and their renditions (and assets left without an original) are not imported.
 *
 * With `opts.deletions` (the journal kept beside the backups) the files of images deleted after the
 * package was made are never written back to storage, and their records are imported only to be marked
 * deleted again through the command service, so the garment falls back exactly as it did at deletion.
 */
export async function importMediaData(
  rt: MediaRuntime,
  principal: Principal,
  data: MediaExport,
  readAsset: (file: string) => Promise<ArrayBuffer | Uint8Array | null>,
  opts: { deletions?: MediaDeletionJournal | null } = {},
): Promise<{ imported: { assets: number; renditions: number; files: number }; missing: string[]; mismatched: string[]; rejected: string[]; deletionsApplied: { assetsDeleted: number; tombstonesImported: number; originalsPurged: number; filesWithheld: number } }> {
  assertPrincipal(principal);
  // Checked before anything is read or stored: an import writes files, so it needs the import authorization.
  requireScope(principal, "admin");
  if (data.format !== MEDIA_EXPORT_FORMAT) throw new CommandError("invalid_command", `unsupported media export format '${String(data.format)}'`);
  const journal = opts.deletions ?? null;
  if (journal && journal.format !== MEDIA_DELETIONS_FORMAT) throw new CommandError("invalid_command", `unsupported media deletion journal '${String((journal as { format?: unknown }).format)}'`);
  // Images the package itself records as deleted before it was made count exactly like those the journal records as
  // deleted after: their files are never read or written back, an older live record of them in the same package is
  // imported only as deleted, and the clean-up removes whatever another run left under them.
  const packageTombstones = (data.records.deletedAssets ?? []).filter((d) => /^[A-Za-z0-9_-]{1,120}$/.test(String(d?.assetId ?? "")));
  const journalDeleted = new Set((journal?.deletedAssets ?? []).map((d) => d.assetId));
  const deletedAssetIds = new Set([...journalDeleted, ...packageTombstones.map((d) => String(d.assetId))]);
  const purgedRenditionIds = new Set((journal?.purgedOriginals ?? []).map((d) => d.renditionId));
  let filesWithheld = 0;
  const u = principal.userId;
  // An import is identified by the owner and the digest of exactly what is imported (records, file list and
  // deletion journal). Every command of it has a deterministic idempotency key under this prefix, so only the
  // same package can continue an import that stopped part way; any other package with the same export time
  // is a different import and is refused while the owner has media.
  const packageDigest = (await sha256Hex(JSON.stringify({ data, deletions: journal }))).slice(0, 32);
  const keyPrefix = importKeyPrefix(u, packageDigest);
  // Every record family an import writes counts: an owner holding only day plans, discovery records or
  // composites is not empty, and a package must not be mixed into it.
  const IMPORTED_TABLES = ["media_assets", "media_renditions", "media_fidelity_checks", "garment_media", "media_discovery_attempts", "media_candidates", "studio_combinations", "studio_combination_items", "studio_day_plans", "studio_day_plan_items", "outfit_composites"];
  const existing = await first<{ n: number }>(rt.db, `SELECT ${IMPORTED_TABLES.map((t) => `(SELECT COUNT(*) FROM ${t} WHERE user_id = ?)`).join(" + ")} AS n`, ...IMPORTED_TABLES.map(() => u));
  // The owner's import lock (migration 0404) names the package an import into this owner began with.
  const lock = await first<{ package_digest: string; plan_digest: string; created_at: string; command_rowid: number }>(rt.db, "SELECT package_digest, plan_digest, created_at, command_rowid FROM media_import_locks WHERE user_id = ?", u);
  /** Images this package withholds: deleted before it was made (its own tombstones), or deleted or their original purged after (the journal). */
  const withheldAssetIds = [...new Set([...(data.records.deletedAssets ?? []).map((d) => String(d?.assetId ?? "")), ...deletedAssetIds, ...(journal?.purgedOriginals ?? []).map((d) => d.assetId)])].filter((id) => /^[A-Za-z0-9_-]{1,120}$/.test(id)).sort();
  let changedSinceLock = false;
  if ((existing?.n ?? 0) > 0) {
    // Only the import that began with this exact package may continue, and only if nothing else changed this
    // owner's media or Studio records since it began (earlier history, such as an upload authorization, does not count).
    if (!lock || lock.package_digest !== packageDigest) throw new CommandError("precondition_failed", "media can only be imported into an owner that has none yet");
    const other = await first<{ n: number }>(
      rt.db,
      "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND rowid > ? AND (type LIKE 'media.%' OR type LIKE 'studio.%') AND NOT (type = 'media.import_records' AND substr(idempotency_key, 1, length(?)) = ?)",
      u, lock.command_rowid, keyPrefix, keyPrefix,
    );
    // Refused below, once the plan is known: a run that finds this import already complete still finishes its clean-up first.
    changedSinceLock = (other?.n ?? 0) > 0;
  }

  const missing: string[] = [];
  const mismatched: string[] = [];
  const rejected: string[] = [];
  const stored = new Set<string>();
  /** What each stored file IS, read from its bytes; the package's own claim is not used. */
  const typeOf = new Map<string, string>();
  /** Where each verified file is stored, relative to the owner: rebuilt from its bytes, not taken from the package. */
  const relOf = new Map<string, string>();
  const limits = limitsOf(rt.deps);
  /** Files that passed every check, to be written only after the whole import has been planned and found runnable. */
  const verified: { name: string; key: string; file: MediaExport["assets"][number]; contentType: string }[] = [];
  for (const file of data.assets) {
    const name = String((file as { file?: unknown; r2Key?: unknown }).file ?? (file as { r2Key?: unknown }).r2Key ?? ""); // `r2Key`: packages made before paths became relative
    if (deletedAssetIds.has(file.assetId) || purgedRenditionIds.has(file.renditionId)) {
      // Deleted after this package was made: the bytes are not read and never written back.
      filesWithheld++;
      continue;
    }
    const rest = toRelative(name);
    if (!rest || !rest.startsWith(`assets/${file.assetId}/`)) {
      mismatched.push(name);
      continue;
    }
    // The file name must have the storage shape `<kind>[-v<n>]-<16 hex>.<ext>`. The key it is stored under is
    // rebuilt below from the verified bytes (their own SHA-256 prefix and detected type), so storage stays
    // content-addressed: one key always holds the same bytes and metadata, whichever run of whichever import
    // writes it, and a racing import can never replace a file with different bytes.
    const base = rest.slice(`assets/${file.assetId}/`.length);
    const shape = /^([a-z_]{1,32})(-v\d{1,6})?-[0-9a-f]{16}\.[a-z0-9]{2,5}$/.exec(base);
    if (!shape || shape[1] !== String(file.kind) || !/^[0-9a-f]{64}$/.test(String(file.sha256))) {
      mismatched.push(name);
      continue;
    }
    // The file-list entry must describe exactly the rendition record that will be imported: same image,
    // kind, path, checksum and size. Otherwise a file could be checked as one kind and recorded as another.
    const record = data.records.renditions.find((r) => String(r.rendition_id) === file.renditionId);
    if (
      !record || record.status === "deleted" || String(record.asset_id) !== file.assetId || String(record.kind) !== file.kind ||
      toRelative(record.file) !== rest || String(record.sha256) !== file.sha256 || Number(record.byte_length) !== file.byteLength
    ) {
      mismatched.push(name);
      continue;
    }
    const raw = await readAsset(name);
    if (!raw) {
      missing.push(name);
      continue;
    }
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if ((await sha256Hex(bytes)) !== file.sha256 || bytes.length !== file.byteLength) {
      mismatched.push(name);
      continue;
    }
    // Content validation, as for an upload: what the bytes ARE, within the same size, dimension and animation
    // limits, and (for the formats read here) a picture that actually decodes.
    const probe = probeImage(bytes);
    if (!probe || !IMPORTABLE_TYPES.has(probe.contentType) || bytes.length > limits.maxUploadBytes || probe.animated) {
      rejected.push(name);
      continue;
    }
    if (probe.width !== null && probe.height !== null && (probe.width > limits.maxDimension || probe.height > limits.maxDimension || probe.width * probe.height > limits.maxPixels)) {
      rejected.push(name);
      continue;
    }
    if (probe.format === "jpeg" || probe.format === "png") {
      if (probe.format === "jpeg" && jpegScanDataBytes(bytes) === 0) {
        rejected.push(name);
        continue;
      }
      try {
        await decodeImage(bytes, { maxPixels: limits.maxPixels });
      } catch {
        rejected.push(name);
        continue;
      }
    }
    // A derived file is written by this service from pixels and carries no metadata. One that does was not made here.
    if (file.kind !== "original") {
      const clean = withoutLocation(bytes);
      // Delivery serves derived files as stored, so one that cannot be checked clean is refused too.
      if (!clean.ok || clean.changed) {
        rejected.push(name);
        continue;
      }
    }
    const storedRel = `assets/${file.assetId}/${shape[1]}${shape[2] ?? ""}-${file.sha256.slice(0, 16)}.${extensionFor(probe.contentType)}`;
    const key = `${ownerPrefix(u)}${storedRel}`;
    assertOwnedKey(u, key);
    verified.push({ name, key, file, contentType: probe.contentType });
    stored.add(file.renditionId);
    typeOf.set(file.renditionId, probe.contentType);
    relOf.set(file.renditionId, storedRel);
  }
  // Rendition records: those whose file arrived intact and verified, with the content type read from the
  // bytes; records that have no file by design (a purged selfie original; every rendition of an image
  // deleted after the package was made) are kept as records marked deleted.
  const renditions = data.records.renditions
    .filter((r) => stored.has(String(r.rendition_id)) || r.status === "deleted" || deletedAssetIds.has(String(r.asset_id)) || purgedRenditionIds.has(String(r.rendition_id)))
    .map((r): Row => (stored.has(String(r.rendition_id)) && r.status !== "deleted" ? { ...r, content_type: typeOf.get(String(r.rendition_id)), file: relOf.get(String(r.rendition_id)) } : { ...r, status: "deleted" }));
  const kept = new Set(renditions.map((r) => String(r.rendition_id)));
  let usable = renditions.filter((r) => r.source_rendition_id === null || kept.has(String(r.source_rendition_id)));
  for (let changed = true; changed; ) {
    const ids = new Set(usable.map((r) => String(r.rendition_id)));
    const next = usable.filter((r) => r.source_rendition_id === null || ids.has(String(r.source_rendition_id)));
    changed = next.length !== usable.length;
    usable = next;
  }
  // An image is imported when it has at least one verified file. An image deleted after the package was made
  // is imported as a tombstone only: its record marked deleted, no file, so it can never be shown and the
  // restored owner's own deletion journal still names it.
  const purgedAt = new Map((journal?.purgedOriginals ?? []).map((d) => [d.assetId, d.purgedAt]));
  const deletedAt = new Map([...packageTombstones.map((d) => [String(d.assetId), typeof d.deletedAt === "string" && d.deletedAt ? d.deletedAt : data.exportedAt] as const), ...(journal?.deletedAssets ?? []).map((d) => [d.assetId, d.deletedAt] as const)]);
  const withFile = new Set(usable.filter((r) => r.status !== "deleted").map((r) => String(r.asset_id)));
  const imported = data.records.assets
    .filter((a) => deletedAssetIds.has(String(a.asset_id)) || withFile.has(String(a.asset_id)))
    .map((a): Row =>
      deletedAssetIds.has(String(a.asset_id))
        ? { ...a, status: "deleted", status_reason: journalDeleted.has(String(a.asset_id)) ? "deleted after the restored backup was taken" : "deleted before this package was made", deleted_at: deletedAt.get(String(a.asset_id)) ?? null }
        : purgedAt.has(String(a.asset_id)) && !a.original_purged_at
          ? { ...a, original_purged_at: purgedAt.get(String(a.asset_id)), status_reason: "full-resolution original removed under the photo-history setting" }
          : a,
    );
  // Images deleted before the package was made travel as tombstones only. They are imported as deleted
  // records without files, so the restored owner's own deletion journal still names them and a restore of
  // an even older backup cannot bring them back.
  const named = new Set(imported.map((a) => String(a.asset_id)));
  const tombstones: Row[] = [];
  // Both the package's own tombstones and every deletion in the journal given with it: an image created and
  // deleted after the package was made appears in neither the records nor deletedAssets, only in the journal,
  // and its deletion history must survive the restore.
  const fromPackage = (data.records.deletedAssets ?? []).map((d) => ({ d, reason: "deleted before this package was made" }));
  const fromJournal = (journal?.deletedAssets ?? []).map((d) => ({ d, reason: "deleted after the restored backup was taken" }));
  for (const { d, reason } of [...fromPackage, ...fromJournal]) {
    const id = String(d?.assetId ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || named.has(id)) continue;
    named.add(id);
    const at = typeof d.deletedAt === "string" && d.deletedAt ? d.deletedAt : data.exportedAt;
    tombstones.push({
      asset_id: id, garment_id: null, kind: "attachment", is_demo: 0, status: "deleted", status_reason: reason,
      source_json: JSON.stringify({ kind: "tombstone", type: "tombstone" }), match_evidence_json: "{}", derived_from_asset_id: null, had_location_metadata: 0,
      wearing_date: null, retain_original_until: null, original_purged_at: null, version: 1, created_at: at, updated_at: at, deleted_at: at,
    });
  }
  const assets = [...imported, ...tombstones];
  const assetIds = new Set(assets.map((a) => String(a.asset_id)));
  const liveAssetIds = new Set(assets.filter((a) => a.status !== "deleted").map((a) => String(a.asset_id)));
  usable = usable.filter((r) => assetIds.has(String(r.asset_id)));
  const renditionIds = new Set(usable.map((r) => String(r.rendition_id)));
  const tombstoned = imported.filter((a) => a.status === "deleted").length;
  const originalsPurged = usable.filter((r) => purgedRenditionIds.has(String(r.rendition_id)) && liveAssetIds.has(String(r.asset_id))).length;
  /** The image a garment shows when the one recorded for it did not come through: its newest remaining real photo, else any remaining image, else none. */
  const fallbackFor = (garmentId: unknown): Row | null => {
    const own = assets.filter((a) => a.garment_id === garmentId && a.status === "active").sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || String(y.asset_id).localeCompare(String(x.asset_id)));
    const real = (a: Row) => Number(a.is_demo ?? 0) === 0 && ["exact_product_photo", "owner_photo", "edited_rendition"].includes(String(a.kind));
    return own.find(real) ?? own[0] ?? null;
  };

  // Every command is built, and checked against the per-command row limit, before the first one commits: a
  // package that cannot be imported is refused with nothing written. Parents are packed so that no row set
  // of a command exceeds IMPORT_ROWS_PER_SET, with each parent's children in the same command.
  type Call = { part: string; rows: Record<string, Row[]>; key: string };
  const calls: Call[] = [];
  const pack = (part: string, name: string, parents: Row[], maxParents: number, children: (chunk: Row[]) => Record<string, Row[]>) => {
    let chunk: Row[] = [];
    let index = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      const rows = { [name]: chunk, ...children(chunk) };
      calls.push({ part, rows, key: `${keyPrefix}${part}:${name}:${index}` });
      index++;
      chunk = [];
    };
    for (const parent of parents) {
      const own = children([parent]);
      if (Object.values(own).some((set) => set.length > IMPORT_ROWS_PER_SET)) {
        throw new CommandError("invalid_command", `one ${name} record has more than ${IMPORT_ROWS_PER_SET} related records and cannot be imported; nothing was written`);
      }
      const next = [...chunk, parent];
      if (next.length > maxParents || Object.values(children(next)).some((set) => set.length > IMPORT_ROWS_PER_SET)) flush();
      chunk.push(parent);
    }
    flush();
  };
  const assetRows = (chunk: Row[]): Record<string, Row[]> => {
    const ids = new Set(chunk.map((a) => String(a.asset_id)));
    return {
      renditions: usable.filter((r) => ids.has(String(r.asset_id))),
      fidelityChecks: data.records.fidelityChecks.filter((f) => ids.has(String(f.asset_id))).map((f) => (f.rendition_id && !renditionIds.has(String(f.rendition_id)) ? { ...f, rendition_id: null } : f)),
    };
  };
  // Images are packed with every image an image was derived from ahead of it, so a derived image's source
  // renditions are always committed by the same or an earlier command.
  const derivedFrom = new Map(assets.map((a) => [String(a.asset_id), a.derived_from_asset_id ? String(a.derived_from_asset_id) : null]));
  const depth = (id: string): number => {
    let d = 0;
    for (let at = derivedFrom.get(id) ?? null; at !== null && derivedFrom.has(at) && d <= assets.length; at = derivedFrom.get(at) ?? null) d++;
    return d;
  };
  const packedAssets = assets.map((a, i) => ({ a, i, d: depth(String(a.asset_id)) })).sort((x, y) => x.d - y.d || x.i - y.i).map((x) => x.a);
  pack("assets", "assets", packedAssets.map((a) => (a.derived_from_asset_id && !assetIds.has(String(a.derived_from_asset_id)) ? { ...a, derived_from_asset_id: null } : a)), 25, assetRows);
  pack(
    "garmentMedia",
    "garmentMedia",
    data.records.garmentMedia.map((m) => {
      if (!m.primary_asset_id || liveAssetIds.has(String(m.primary_asset_id))) return m;
      const fallback = fallbackFor(m.garment_id);
      if (fallback) return { ...m, primary_asset_id: fallback.asset_id, image_state: m.image_state === "photos_needed" ? "photos_needed" : "resolved" };
      return { ...m, primary_asset_id: null, image_state: m.image_state === "resolved" ? "not_started" : m.image_state };
    }),
    100,
    () => ({}),
  );
  pack("discovery", "discoveryAttempts", data.records.discoveryAttempts, 100, (chunk) => {
    const ids = new Set(chunk.map((a) => String(a.attempt_id)));
    return {
      candidates: data.records.candidates
        .filter((c) => ids.has(String(c.attempt_id)))
        .map((c) =>
          !c.asset_id || liveAssetIds.has(String(c.asset_id))
            ? c
            : assetIds.has(String(c.asset_id))
              ? { ...c, decision: "rejected", rejection_reasons_json: '["owner_rejected"]', decided_by: "owner" } // its image was deleted after the package was made
              : { ...c, asset_id: null, ...(c.decision === "rejected" ? {} : { decision: "rejected", rejection_reasons_json: '["image_quality"]' }) }, // its image did not come through
        ),
    };
  });
  pack("studio", "combinations", data.records.combinations, 100, (chunk) => {
    const ids = new Set(chunk.map((c) => String(c.combination_id)));
    return { combinationItems: data.records.combinationItems.filter((i) => ids.has(String(i.combination_id))) };
  });
  pack("studio", "dayPlans", data.records.dayPlans, 100, (chunk) => {
    const ids = new Set(chunk.map((d) => String(d.plan_id)));
    return { dayPlanItems: data.records.dayPlanItems.filter((i) => ids.has(String(i.plan_id))) };
  });
  pack("composites", "composites", data.records.composites, 100, () => ({}));

  // A run that finds every command of this import already committed is a repeat, not a continuation. Checked
  // before any file is written, so a refused repeat stores nothing. It first finishes the clean-up of withheld
  // images, which an earlier run may have stopped before (its records committed, its clean-up not yet run);
  // the clean-up decides from the committed ledger only, so running it again is always safe.
  const planDigest = (await sha256Hex(JSON.stringify(calls.map((c) => [c.key, c.rows])))).slice(0, 32);
  /** Marks that this import's records are in and its clean-up listing starts now (see migration 0404). */
  const markCleanupStarted = () =>
    prepare(rt.db, stmt("UPDATE media_import_locks SET cleanup_started_at = COALESCE(cleanup_started_at, ?) WHERE user_id = ? AND package_digest = ? AND plan_digest = ?", toInstant(rt.clock()), u, packageDigest, planDigest)).run();
  if ((existing?.n ?? 0) > 0 && calls.length > 0) {
    const done = await allIn<{ idempotency_key: string }>(rt.db, "SELECT idempotency_key FROM commands WHERE user_id = ? AND idempotency_key IN (:ids)", [u], calls.map((c) => c.key));
    if (done.length === calls.length) {
      await markCleanupStarted();
      await removeWithheldFiles(rt, u, withheldAssetIds, { absentIsWithheld: true });
      await removeAbandonedImportFiles(rt, u, planDigest);
      throw new CommandError("precondition_failed", "this package has already been imported for this owner; media can only be imported into an owner that has none yet");
    }
  }
  if (changedSinceLock) throw new CommandError("precondition_failed", "this owner's media changed after the import began, so it cannot be continued; media can only be imported into an owner that has none yet");
  // Every command's own checks that do not need storage are run now, before any write: the rendition
  // dependency order of each image command (a cycle, or a source neither in it nor in an earlier command, is refused).
  const earlier = new Set<string>();
  for (const call of calls) {
    if (call.part !== "assets") continue;
    sourceOrder(call.rows.renditions ?? [], earlier);
    for (const r of call.rows.renditions ?? []) earlier.add(String(r.rendition_id));
  }
  // The owner's import lock is taken atomically before anything is written. It names this package and this
  // plan (which depends on which files were verified); it is taken over only while the owner holds no imported
  // record. Every import command re-checks it in its commit, so two packages are never mixed.
  const ownerEmpty = IMPORTED_TABLES.map((t) => `NOT EXISTS (SELECT 1 FROM ${t} WHERE user_id = ?)`).join(" AND ");
  await prepare(
    rt.db,
    stmt(
      `INSERT INTO media_import_locks (user_id, package_digest, plan_digest, created_at, command_rowid) SELECT ?, ?, ?, ?, (SELECT COALESCE(MAX(rowid), 0) FROM commands WHERE user_id = ?) WHERE ${ownerEmpty}
       ON CONFLICT (user_id) DO UPDATE SET package_digest = excluded.package_digest, plan_digest = excluded.plan_digest, created_at = excluded.created_at, command_rowid = excluded.command_rowid, cleanup_started_at = NULL
       WHERE (media_import_locks.package_digest != excluded.package_digest OR media_import_locks.plan_digest != excluded.plan_digest) AND ${ownerEmpty}`,
      u, packageDigest, planDigest, toInstant(rt.clock()), u, ...IMPORTED_TABLES.map(() => u), ...IMPORTED_TABLES.map(() => u),
    ),
  ).run();
  const held = await first<{ package_digest: string; plan_digest: string }>(rt.db, "SELECT package_digest, plan_digest FROM media_import_locks WHERE user_id = ?", u);
  if (!held || held.package_digest !== packageDigest) throw new CommandError("precondition_failed", "another media import is under way for this owner; nothing was written");
  if (held.plan_digest !== planDigest) throw new CommandError("precondition_failed", "the package's files do not read as they did when this import began, so it cannot be continued; nothing was written");
  // The files are written only now that the whole import is planned. A file already at its key (written by an
  // earlier run of this same import) is kept when it is the same file, and never replaced by different bytes.
  for (const v of verified) {
    const head = await rt.deps.bucket.head(v.key);
    if (head && head.customMetadata?.sha256 !== v.file.sha256) throw new CommandError("precondition_failed", "a different file is already stored where this package's file belongs; nothing was imported", { file: v.name });
  }
  let filesStored = 0;
  /** This import still holds the lock and nothing else changed the owner's media since: checked right before each write. */
  const holdsLock = async () => ((await first<{ n: number }>(rt.db, `SELECT (${IMPORT_LOCK_HELD}) AND (${NOTHING_ELSE_SINCE_LOCK}) AS n`, u, packageDigest, planDigest, u, u, keyPrefix, keyPrefix))?.n ?? 0) === 1;
  for (const v of verified) {
    // A file already at its key is kept only when THIS import (same plan) wrote it; a file left there by a superseded
    // run of another package or plan is written again under this import's own name, so that run's own clean-up
    // (below) can never remove a file this import relies on.
    const existing = await rt.deps.bucket.head(v.key);
    if (existing && existing.customMetadata?.importPlan === planDigest) {
      filesStored++;
      continue;
    }
    // Read again and checked again: the bytes written are the bytes that were verified.
    const raw = await readAsset(v.name);
    const bytes = raw ? (raw instanceof Uint8Array ? raw : new Uint8Array(raw)) : null;
    if (!bytes || bytes.length !== v.file.byteLength || (await sha256Hex(bytes)) !== v.file.sha256) throw new CommandError("invalid_command", "a file of the package changed while it was being imported; nothing more was written", { file: v.name });
    // Checked last, immediately before the write (after every read and hash): a run whose lock was taken over, or
    // whose owner's media changed meanwhile, writes nothing more.
    if (!(await holdsLock())) throw new CommandError("precondition_failed", "another media import took over this owner's import, or the owner's media changed; this one stopped");
    await rt.deps.bucket.put(v.key, bytes, { httpMetadata: { contentType: v.contentType }, customMetadata: { assetId: v.file.assetId, sha256: v.file.sha256, kind: v.file.kind, imported: "true", importPlan: planDigest } });
    // Checked again once the write has landed. Keys are content-addressed, so this run's write put exactly the bytes
    // any other import would put at this key: it can never spoil a file another import relies on, and is never
    // removed merely because another import may have written the same key. If the lock was lost meanwhile, the
    // file is removed when the committed ledger says it is withheld (its image deleted, or its original purged),
    // and also when its image has no record at all once the winning import's clean-up has started: that clean-up's
    // listing may have run before this write landed, and the winner's records, all committed by then, do not
    // include the image. Before that moment the winner's own clean-up will list and remove this write.
    if (!(await holdsLock())) {
      const now = await first<{ package_digest: string; plan_digest: string; cleanup_started_at: string | null }>(rt.db, "SELECT package_digest, plan_digest, cleanup_started_at FROM media_import_locks WHERE user_id = ?", u);
      const winnerCleaning = !!now && (now.package_digest !== packageDigest || now.plan_digest !== planDigest) && now.cleanup_started_at !== null;
      await removeWithheldFiles(rt, u, [v.file.assetId], { absentIsWithheld: winnerCleaning, onlyKeys: [v.key] });
      throw new CommandError("precondition_failed", "another media import took over this owner's import while a file was being written; this one stopped");
    }
    filesStored++;
  }
  // Committed commands of an import that stopped part way replay their receipts (same keys, same rows); the rest run.
  for (const call of calls) {
    await rt.service.execute(principal, { type: "media.import_records", payload: { part: call.part, rows: call.rows, importDigest: packageDigest, importPlanDigest: planDigest }, idempotencyKey: call.key, expectedVersions: {}, authorization: "data_import", source: { channel: principal.channel } });
  }
  // An image this package withholds must not be left in storage by anyone: a superseded run of another package or
  // plan may have written its file before it noticed it had lost the lock. Once this import's records are
  // committed, such files are removed (see removeWithheldFiles). So is every file a superseded run imported for
  // an image this import has no record of, whether or not this package mentions that image.
  await markCleanupStarted();
  await removeWithheldFiles(rt, u, withheldAssetIds, { absentIsWithheld: true });
  await removeAbandonedImportFiles(rt, u, planDigest);
  return { imported: { assets: liveAssetIds.size, renditions: usable.filter((r) => r.status !== "deleted").length, files: filesStored }, missing, mismatched, rejected, deletionsApplied: { assetsDeleted: tombstoned, tombstonesImported: tombstones.length, originalsPurged, filesWithheld } };
}

/**
 * Remove stored files of images an import withholds, deciding from the ledger as committed at the moment of the
 * decision (read after the listing, per image), never from an earlier snapshot:
 * - an image recorded as deleted or rejected: every file under it goes;
 * - a live image whose original was purged: only an ORIGINAL file that none of its active or superseded renditions
 *   names goes (originals are written only when an image is created, so no later rendition can come to name it;
 *   derived files of a live image are left, whichever job is writing them);
 * - an image with no record: its files go only when `absentIsWithheld` (after this import's own records are
 *   committed, a withheld image it did not import has no record and never will); a run that lost its lock leaves
 *   them, because the winning import may not have committed that image yet, and its own clean-up runs after it does.
 * Every listing page is read. Safe to run any number of times.
 */
async function removeWithheldFiles(rt: MediaRuntime, u: string, assetIds: string[], opts: { absentIsWithheld: boolean; onlyKeys?: string[] }): Promise<void> {
  for (const assetId of assetIds) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(assetId)) continue;
    const prefix = `${ownerPrefix(u)}assets/${assetId}/`;
    let keys: string[];
    if (opts.onlyKeys) keys = opts.onlyKeys.filter((k) => k.startsWith(prefix));
    else {
      keys = [];
      let cursor: string | undefined;
      do {
        const listed = await rt.deps.bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        keys.push(...listed.objects.map((o) => o.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
    if (keys.length === 0) continue;
    const asset = await first<{ status: string; original_purged_at: string | null }>(rt.db, "SELECT status, original_purged_at FROM media_assets WHERE user_id = ? AND asset_id = ?", u, assetId);
    let stray: string[];
    if (!asset) stray = opts.absentIsWithheld ? keys : [];
    else if (asset.status === "deleted" || asset.status === "rejected") stray = keys;
    else if (!asset.original_purged_at) stray = [];
    else {
      const named = new Set((await all<{ object_key: string }>(rt.db, "SELECT object_key FROM media_renditions WHERE user_id = ? AND asset_id = ? AND status IN ('active', 'superseded')", u, assetId)).map((r) => r.object_key));
      stray = keys.filter((k) => !named.has(k) && /^original(-v\d{1,6})?-[0-9a-f]{16}\.[a-z0-9]{2,5}$/.test(k.slice(prefix.length)));
    }
    for (const k of stray) assertOwnedKey(u, k);
    for (let i = 0; i < stray.length; i += 500) await rt.deps.bucket.delete(stray.slice(i, i + 500));
  }
}

/**
 * Remove every file an import other than `planDigest` wrote (customMetadata `imported: "true"` with another
 * `importPlan`) under an image the owner's committed ledger has no record of. Run by the holding import after its
 * records are committed: a superseded run may have written files for images this import never mentions, and no
 * record will ever name them. Files written by uploads (not marked imported) and files of recorded images are
 * left; a recorded image's withheld files are handled by removeWithheldFiles. Every listing page is read.
 */
async function removeAbandonedImportFiles(rt: MediaRuntime, u: string, planDigest: string): Promise<void> {
  const prefix = `${ownerPrefix(u)}assets/`;
  const byAsset = new Map<string, string[]>();
  let cursor: string | undefined;
  do {
    const listed = await rt.deps.bucket.list({ prefix, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    for (const o of listed.objects) {
      const meta = o.customMetadata ?? (await rt.deps.bucket.head(o.key))?.customMetadata;
      if (meta?.imported !== "true" || meta.importPlan === planDigest) continue;
      const assetId = o.key.slice(prefix.length).split("/")[0] ?? "";
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(assetId)) continue;
      byAsset.set(assetId, [...(byAsset.get(assetId) ?? []), o.key]);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  for (const [assetId, keys] of byAsset) await removeWithheldFiles(rt, u, [assetId], { absentIsWithheld: true, onlyKeys: keys });
}

/**
 * The owner's deletion journal: what backups taken earlier may still hold and a restore must not bring
 * back. Reads only, but it is an operational record for backup code, not something a read-only client
 * (an assistant connection) needs: it requires write scope. Files are package-relative paths.
 */
export async function listMediaDeletions(rt: MediaRuntime, principal: Principal): Promise<MediaDeletionJournal> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const u = principal.userId;
  const assets = await all<{ asset_id: string; deleted_at: string | null; updated_at: string }>(rt.db, "SELECT asset_id, deleted_at, updated_at FROM media_assets WHERE user_id = ? AND status IN ('deleted', 'rejected') ORDER BY asset_id", u);
  const files = await all<{ asset_id: string; rendition_id: string; object_key: string }>(
    rt.db,
    "SELECT r.asset_id, r.rendition_id, r.object_key FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id WHERE r.user_id = ? AND a.status IN ('deleted', 'rejected') ORDER BY r.asset_id, r.rendition_id",
    u,
  );
  const purged = await all<{ asset_id: string; rendition_id: string; object_key: string; original_purged_at: string }>(
    rt.db,
    `SELECT a.asset_id, r.rendition_id, r.object_key, a.original_purged_at FROM media_assets a JOIN media_renditions r ON r.user_id = a.user_id AND r.asset_id = a.asset_id
      WHERE a.user_id = ? AND a.original_purged_at IS NOT NULL AND a.status NOT IN ('deleted', 'rejected') AND r.kind = 'original' AND r.status = 'deleted' ORDER BY a.asset_id`,
    u,
  );
  return {
    format: MEDIA_DELETIONS_FORMAT,
    writtenAt: toInstant(rt.clock()),
    deletedAssets: assets.map((a) => {
      const own = files.filter((f) => f.asset_id === a.asset_id);
      return { assetId: a.asset_id, deletedAt: a.deleted_at ?? a.updated_at, renditionIds: own.map((f) => f.rendition_id), files: own.map((f) => relativeFile(u, f.object_key)) };
    }),
    purgedOriginals: purged.map((p) => ({ assetId: p.asset_id, renditionId: p.rendition_id, purgedAt: p.original_purged_at, file: relativeFile(u, p.object_key) })),
  };
}

/**
 * Apply a deletion journal to an owner that was restored from a backup: every image the journal names that
 * is present again is deleted through the command service (receipt, fallback image, purge of stored files
 * and cached copies). Safe to repeat; an image that is already gone is left alone.
 */
export async function replayMediaDeletions(rt: MediaRuntime, principal: Principal, journal: MediaDeletionJournal): Promise<{ assetsDeleted: number; originalsPurged: number }> {
  assertPrincipal(principal);
  if (journal.format !== MEDIA_DELETIONS_FORMAT) throw new CommandError("invalid_command", `unsupported media deletion journal '${String((journal as { format?: unknown }).format)}'`);
  const assetIds = [...new Set(journal.deletedAssets.map((d) => d.assetId))].sort();
  const originals = [...new Set(journal.purgedOriginals.map((d) => d.assetId))].sort();
  const out = { assetsDeleted: 0, originalsPurged: 0 };
  for (let i = 0; i < Math.max(assetIds.length, originals.length); i += 50) {
    const payload = { assetIds: assetIds.slice(i, i + 50), purgedOriginalAssetIds: originals.slice(i, i + 50) };
    const receipt = await execAs(rt, principal, "media.reapply_deletions", payload, `media-deletions:${principal.userId}:${await sha256Hex(JSON.stringify(payload))}`);
    // A replayed receipt describes work already done, not new deletions.
    if (!receipt.replayed) {
      out.assetsDeleted += Number(receipt.result.assetsDeleted ?? 0);
      out.originalsPurged += Number(receipt.result.originalsPurged ?? 0);
    }
  }
  return out;
}
