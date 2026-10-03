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
import { all, allIn, assertPrincipal, CommandError, define, first, requireScope, sha256Hex, stmt, toInstant, type CommandDefinition, type PlannedOutbox, type Principal, type Stmt } from "@garderobe/domain";
import { planAssetRemoval } from "./commands/assets.ts";
import { MediaSource } from "@garderobe/contracts/ext/media";
import { execAs } from "./exec.ts";
import { probeImage, withoutLocation } from "./image/index.ts";
import { assertOwnedKey, ownerPrefix } from "./keys.ts";
import { limitsOf, resolveDeps, type MediaDepsSource, type MediaRuntime } from "./runtime.ts";
import { enqueueJob, loadRenditions, type AssetRow } from "./store.ts";

export const MEDIA_EXPORT_FORMAT = "garderobe-media-export-1";
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

function originalsMode(principal: Principal, opts: MediaExportOptions): ExportOriginals {
  const mode = opts.originals ?? "location_removed";
  if (mode !== "location_removed" && mode !== "as_supplied") throw new CommandError("invalid_command", "originals is either 'location_removed' or 'as_supplied'");
  if (mode === "as_supplied" && ((principal.actor !== "owner" && principal.actor !== "system") || principal.channel === "mcp")) {
    throw new CommandError("forbidden", "photographs are exported with their location data only when the owner asks for it in their own app", { reason: "owner_opt_in_required" });
  }
  return mode;
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
  const object = await rt.deps.bucket.get(key);
  if (!object) return null;
  if (mode === "as_supplied") return object.arrayBuffer();
  // Derived files are written by this package from pixels. Anything else (an original, or a file no record describes) is rewritten.
  const record = await first<{ kind: string }>(rt.db, "SELECT kind FROM media_renditions WHERE user_id = ? AND object_key = ?", principal.userId, key);
  if (record && record.kind !== "original") return object.arrayBuffer();
  const clean = withoutLocation(new Uint8Array(await object.arrayBuffer()));
  if (!clean.ok) return null;
  return clean.bytes.buffer.slice(clean.bytes.byteOffset, clean.bytes.byteOffset + clean.bytes.byteLength) as ArrayBuffer;
}

type Row = Record<string, unknown>;

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
  rows: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(400)),
});

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
            if (!head || head.size !== n(r.byte_length) || head.customMetadata?.sha256 !== s(r.sha256) || head.customMetadata?.imported !== "true" || head.httpMetadata?.contentType !== s(r.content_type)) {
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
          // Originals before derivatives, so each rendition's source already exists.
          const ordered = [...rows("renditions")].sort((a, b) => (a.source_rendition_id === null ? 0 : 1) - (b.source_rendition_id === null ? 0 : 1) || String(a.created_at).localeCompare(String(b.created_at)) || (a.kind === "cutout" || a.kind === "edited" || a.kind === "display" ? 0 : 1) - (b.kind === "cutout" || b.kind === "edited" || b.kind === "display" ? 0 : 1));
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
          for (const m of rows("garmentMedia")) {
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
): Promise<{ imported: { assets: number; renditions: number; files: number }; missing: string[]; mismatched: string[]; rejected: string[]; deletionsApplied: { assetsDeleted: number; originalsPurged: number; filesWithheld: number } }> {
  assertPrincipal(principal);
  // Checked before anything is read or stored: an import writes files, so it needs the import authorization.
  requireScope(principal, "admin");
  if (data.format !== MEDIA_EXPORT_FORMAT) throw new CommandError("invalid_command", `unsupported media export format '${String(data.format)}'`);
  const journal = opts.deletions ?? null;
  if (journal && journal.format !== MEDIA_DELETIONS_FORMAT) throw new CommandError("invalid_command", `unsupported media deletion journal '${String((journal as { format?: unknown }).format)}'`);
  const deletedAssetIds = new Set((journal?.deletedAssets ?? []).map((d) => d.assetId));
  const purgedRenditionIds = new Set((journal?.purgedOriginals ?? []).map((d) => d.renditionId));
  let filesWithheld = 0;
  const u = principal.userId;
  const existing = await first<{ n: number }>(rt.db, "SELECT (SELECT COUNT(*) FROM media_assets WHERE user_id = ?) + (SELECT COUNT(*) FROM studio_combinations WHERE user_id = ?) + (SELECT COUNT(*) FROM garment_media WHERE user_id = ?) AS n", u, u, u);
  if ((existing?.n ?? 0) > 0) throw new CommandError("precondition_failed", "media can only be imported into an owner that has none yet");

  const missing: string[] = [];
  const mismatched: string[] = [];
  const rejected: string[] = [];
  const stored = new Set<string>();
  /** What each stored file IS, read from its bytes; the package's own claim is not used. */
  const typeOf = new Map<string, string>();
  let filesStored = 0;
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
    // Content validation, as for an upload: what the bytes ARE. Anything that is not an accepted image is refused.
    const probe = probeImage(bytes);
    if (!probe || !IMPORTABLE_TYPES.has(probe.contentType)) {
      rejected.push(name);
      continue;
    }
    // A derived file is written by this service from pixels and carries no metadata. One that does was not made here.
    if (file.kind !== "original") {
      const clean = withoutLocation(bytes);
      if (clean.ok && clean.changed) {
        rejected.push(name);
        continue;
      }
    }
    const key = `${ownerPrefix(u)}${rest}`;
    assertOwnedKey(u, key);
    await rt.deps.bucket.put(key, bytes, { httpMetadata: { contentType: probe.contentType }, customMetadata: { assetId: file.assetId, sha256: file.sha256, kind: file.kind, imported: "true" } });
    stored.add(file.renditionId);
    typeOf.set(file.renditionId, probe.contentType);
    filesStored++;
  }
  // Rendition records: those whose file arrived intact and verified, with the content type read from the
  // bytes; records that have no file by design (a purged selfie original; every rendition of an image
  // deleted after the package was made) are kept as records marked deleted.
  const renditions = data.records.renditions
    .filter((r) => stored.has(String(r.rendition_id)) || r.status === "deleted" || deletedAssetIds.has(String(r.asset_id)) || purgedRenditionIds.has(String(r.rendition_id)))
    .map((r): Row => (stored.has(String(r.rendition_id)) && r.status !== "deleted" ? { ...r, content_type: typeOf.get(String(r.rendition_id)) } : { ...r, status: "deleted" }));
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
  const deletedAt = new Map((journal?.deletedAssets ?? []).map((d) => [d.assetId, d.deletedAt]));
  const withFile = new Set(usable.filter((r) => r.status !== "deleted").map((r) => String(r.asset_id)));
  const assets = data.records.assets
    .filter((a) => deletedAssetIds.has(String(a.asset_id)) || withFile.has(String(a.asset_id)))
    .map((a): Row =>
      deletedAssetIds.has(String(a.asset_id))
        ? { ...a, status: "deleted", status_reason: "deleted after the restored backup was taken", deleted_at: deletedAt.get(String(a.asset_id)) ?? null }
        : purgedAt.has(String(a.asset_id)) && !a.original_purged_at
          ? { ...a, original_purged_at: purgedAt.get(String(a.asset_id)), status_reason: "full-resolution original removed under the photo-history setting" }
          : a,
    );
  const assetIds = new Set(assets.map((a) => String(a.asset_id)));
  const liveAssetIds = new Set(assets.filter((a) => a.status !== "deleted").map((a) => String(a.asset_id)));
  usable = usable.filter((r) => assetIds.has(String(r.asset_id)));
  const renditionIds = new Set(usable.map((r) => String(r.rendition_id)));
  const tombstoned = assets.filter((a) => a.status === "deleted").length;
  const originalsPurged = usable.filter((r) => purgedRenditionIds.has(String(r.rendition_id)) && liveAssetIds.has(String(r.asset_id))).length;
  /** The image a garment shows when the one recorded for it did not come through: its newest remaining real photo, else any remaining image, else none. */
  const fallbackFor = (garmentId: unknown): Row | null => {
    const own = assets.filter((a) => a.garment_id === garmentId && a.status === "active").sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || String(y.asset_id).localeCompare(String(x.asset_id)));
    const real = (a: Row) => Number(a.is_demo ?? 0) === 0 && ["exact_product_photo", "owner_photo", "edited_rendition"].includes(String(a.kind));
    return own.find(real) ?? own[0] ?? null;
  };

  // The key names the row set as well as the part: two row sets of one part (combinations and day plans are both "studio") are different requests.
  const run = (part: string, rows: Record<string, Row[]>, index: number) =>
    rt.service.execute(principal, { type: "media.import_records", payload: { part, rows }, idempotencyKey: `media-import:${u}:${data.exportedAt}:${part}:${Object.keys(rows)[0] ?? "rows"}:${index}`, expectedVersions: {}, authorization: "data_import", source: { channel: principal.channel } });

  for (let i = 0, index = 0; i < assets.length; i += 25, index++) {
    const chunk = assets.slice(i, i + 25);
    const ids = new Set(chunk.map((a) => String(a.asset_id)));
    await run("assets", {
      assets: chunk.map((a) => (a.derived_from_asset_id && !assetIds.has(String(a.derived_from_asset_id)) ? { ...a, derived_from_asset_id: null } : a)),
      renditions: usable.filter((r) => ids.has(String(r.asset_id))),
      fidelityChecks: data.records.fidelityChecks.filter((f) => ids.has(String(f.asset_id))).map((f) => (f.rendition_id && !renditionIds.has(String(f.rendition_id)) ? { ...f, rendition_id: null } : f)),
    }, index);
  }
  const chunked = async (part: string, name: string, rows: Row[], extra: (chunk: Row[]) => Record<string, Row[]> = () => ({})) => {
    for (let i = 0, index = 0; i < rows.length; i += 100, index++) {
      const chunk = rows.slice(i, i + 100);
      await run(part, { [name]: chunk, ...extra(chunk) }, index);
    }
  };
  await chunked(
    "garmentMedia",
    "garmentMedia",
    data.records.garmentMedia.map((m) => {
      if (!m.primary_asset_id || liveAssetIds.has(String(m.primary_asset_id))) return m;
      const fallback = fallbackFor(m.garment_id);
      if (fallback) return { ...m, primary_asset_id: fallback.asset_id, image_state: m.image_state === "photos_needed" ? "photos_needed" : "resolved" };
      return { ...m, primary_asset_id: null, image_state: m.image_state === "resolved" ? "not_started" : m.image_state };
    }),
  );
  await chunked("discovery", "discoveryAttempts", data.records.discoveryAttempts, (chunk) => {
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
  await chunked("studio", "combinations", data.records.combinations, (chunk) => {
    const ids = new Set(chunk.map((c) => String(c.combination_id)));
    return { combinationItems: data.records.combinationItems.filter((i) => ids.has(String(i.combination_id))) };
  });
  await chunked("studio", "dayPlans", data.records.dayPlans, (chunk) => {
    const ids = new Set(chunk.map((d) => String(d.plan_id)));
    return { dayPlanItems: data.records.dayPlanItems.filter((i) => ids.has(String(i.plan_id))) };
  });
  await chunked("composites", "composites", data.records.composites);
  return { imported: { assets: liveAssetIds.size, renditions: usable.filter((r) => r.status !== "deleted").length, files: filesStored }, missing, mismatched, rejected, deletionsApplied: { assetsDeleted: tombstoned, originalsPurged, filesWithheld } };
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
