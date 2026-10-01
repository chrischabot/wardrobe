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
import { all, assertPrincipal, CommandError, define, first, requireScope, sha256Hex, stmt, toInstant, type CommandDefinition, type Principal, type Stmt } from "@garderobe/domain";
import { assertOwnedKey, ownerPrefix } from "./keys.ts";
import type { MediaRuntime } from "./runtime.ts";

export const MEDIA_EXPORT_FORMAT = "garderobe-media-export-1";

type Row = Record<string, unknown>;

export interface MediaExportFile {
  assetId: string;
  renditionId: string;
  kind: string;
  /** The key inside the exporting owner's private prefix; the package stores the file under this path. */
  r2Key: string;
  contentType: string;
  byteLength: number;
  sha256: string;
}

export interface MediaExport {
  format: typeof MEDIA_EXPORT_FORMAT;
  exportedAt: string;
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

export async function exportMediaData(rt: MediaRuntime, principal: Principal): Promise<MediaExport> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const u = principal.userId;
  const q = (sql: string) => all<Row>(rt.db, sql, u);
  const assets = await q("SELECT * FROM media_assets WHERE user_id = ? AND status NOT IN ('deleted', 'rejected') ORDER BY created_at, asset_id");
  const renditions = await q("SELECT r.* FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id WHERE r.user_id = ? AND r.status IN ('active', 'superseded') AND a.status NOT IN ('deleted', 'rejected') ORDER BY r.created_at, r.rendition_id");
  const deleted = await all<{ asset_id: string; deleted_at: string | null }>(rt.db, "SELECT asset_id, deleted_at FROM media_assets WHERE user_id = ? AND status IN ('deleted', 'rejected') ORDER BY asset_id", u);
  const live = new Set(assets.map((a) => a.asset_id as string));
  return {
    format: MEDIA_EXPORT_FORMAT,
    exportedAt: toInstant(rt.clock()),
    records: {
      // upload_id points at an upload authorization, which is not exported; the dangling reference is dropped.
      assets: strip(assets).map(({ upload_id: _upload, ...a }) => a),
      renditions: strip(renditions).map(({ object_key, ...r }) => ({ ...r, file: object_key })),
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
    assets: renditions.map((r) => {
      assertOwnedKey(u, r.object_key as string);
      return { assetId: r.asset_id as string, renditionId: r.rendition_id as string, kind: r.kind as string, r2Key: r.object_key as string, contentType: r.content_type as string, byteLength: r.byte_length as number, sha256: r.sha256 as string };
    }),
    notes: [
      "Rows are the stored records with snake_case column names; *_json fields hold JSON text. `file` on a rendition is its path in this package.",
      "Each rendition names the rendition it was derived from (source_rendition_id) and lists its transformation steps (transformations_json); edited = 1 means a generative step contributed and the image is not evidence for fabric or fit.",
      "is_demo = 1 marks a labelled demo placeholder; kind 'generic_illustration' is an illustration, never a photograph of the garment.",
      "Rendered outfit previews are a cache and are not included; they are rebuilt from the composition manifests.",
      "A day plan is an intention for a date, never a wear. Deleted images appear only as tombstones (deletedAssets).",
      "Selfie originals removed under the photo-history setting are absent; their reduced display copies remain.",
    ],
  };
}

const ImportPart = z.object({
  part: z.enum(["assets", "garmentMedia", "discovery", "studio", "composites"]),
  rows: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(400)),
});

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** `media.import_records`: writes exported rows for the importing owner. Requires the import authorization (admin scope). */
export function portabilityCommands(): CommandDefinition<any>[] {
  return [
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
          const key = String(file);
          const rest = /^u\/[^/]+\/(.+)$/.exec(key)?.[1];
          if (!rest) throw new CommandError("invalid_command", "an exported file path is not inside an owner prefix");
          const out = `${ownerPrefix(u)}${rest}`;
          assertOwnedKey(u, out);
          return out;
        };
        if (p.part === "assets") {
          preconditions.push({ label: "the importing owner has no media yet for these IDs", sql: `NOT EXISTS (SELECT 1 FROM media_assets WHERE user_id = ? AND asset_id IN (${rows("assets").map(() => "?").join(",") || "''"}))`, params: [u, ...rows("assets").map((a) => a.asset_id)], class: "state" });
          for (const a of rows("assets")) {
            statements.push(
              stmt(
                `INSERT INTO media_assets (user_id, asset_id, garment_id, kind, is_demo, status, status_reason, source_json, match_evidence_json, derived_from_asset_id, had_location_metadata, wearing_date, retain_original_until, original_purged_at, upload_id, version, command_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
                u, s(a.asset_id), s(a.garment_id), s(a.kind), n(a.is_demo) ?? 0, a.status === "processing" ? "active" : s(a.status), s(a.status_reason), s(a.source_json), s(a.match_evidence_json) ?? "{}", s(a.derived_from_asset_id),
                n(a.had_location_metadata) ?? 0, s(a.wearing_date), s(a.retain_original_until), s(a.original_purged_at), n(a.version) ?? 1, ctx.commandId, s(a.created_at), s(a.updated_at),
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
 */
export async function importMediaData(
  rt: MediaRuntime,
  principal: Principal,
  data: MediaExport,
  readAsset: (file: string) => Promise<ArrayBuffer | Uint8Array | null>,
): Promise<{ imported: { assets: number; renditions: number; files: number }; missing: string[]; mismatched: string[] }> {
  assertPrincipal(principal);
  if (data.format !== MEDIA_EXPORT_FORMAT) throw new CommandError("invalid_command", `unsupported media export format '${String(data.format)}'`);
  const u = principal.userId;
  const existing = await first<{ n: number }>(rt.db, "SELECT (SELECT COUNT(*) FROM media_assets WHERE user_id = ?) + (SELECT COUNT(*) FROM studio_combinations WHERE user_id = ?) + (SELECT COUNT(*) FROM garment_media WHERE user_id = ?) AS n", u, u, u);
  if ((existing?.n ?? 0) > 0) throw new CommandError("precondition_failed", "media can only be imported into an owner that has none yet");

  const missing: string[] = [];
  const mismatched: string[] = [];
  const stored = new Set<string>();
  for (const file of data.assets) {
    const raw = await readAsset(file.r2Key);
    if (!raw) {
      missing.push(file.r2Key);
      continue;
    }
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if ((await sha256Hex(bytes)) !== file.sha256 || bytes.length !== file.byteLength) {
      mismatched.push(file.r2Key);
      continue;
    }
    const rest = /^u\/[^/]+\/(.+)$/.exec(file.r2Key)?.[1];
    if (!rest) {
      mismatched.push(file.r2Key);
      continue;
    }
    const key = `${ownerPrefix(u)}${rest}`;
    assertOwnedKey(u, key);
    await rt.deps.bucket.put(key, bytes, { httpMetadata: { contentType: file.contentType }, customMetadata: { assetId: file.assetId, sha256: file.sha256, kind: file.kind, imported: "true" } });
    stored.add(file.renditionId);
  }
  // Keep only renditions whose file arrived intact and whose source chain is intact; drop assets left without any.
  const renditions = data.records.renditions.filter((r) => stored.has(String(r.rendition_id)));
  const kept = new Set(renditions.map((r) => String(r.rendition_id)));
  let usable = renditions.filter((r) => r.source_rendition_id === null || kept.has(String(r.source_rendition_id)));
  for (let changed = true; changed; ) {
    const ids = new Set(usable.map((r) => String(r.rendition_id)));
    const next = usable.filter((r) => r.source_rendition_id === null || ids.has(String(r.source_rendition_id)));
    changed = next.length !== usable.length;
    usable = next;
  }
  const assetIds = new Set(usable.map((r) => String(r.asset_id)));
  const assets = data.records.assets.filter((a) => assetIds.has(String(a.asset_id)));
  const renditionIds = new Set(usable.map((r) => String(r.rendition_id)));

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
  await chunked("garmentMedia", "garmentMedia", data.records.garmentMedia.map((m) => (m.primary_asset_id && !assetIds.has(String(m.primary_asset_id)) ? { ...m, primary_asset_id: null, image_state: m.image_state === "resolved" ? "not_started" : m.image_state } : m)));
  await chunked("discovery", "discoveryAttempts", data.records.discoveryAttempts, (chunk) => {
    const ids = new Set(chunk.map((a) => String(a.attempt_id)));
    return { candidates: data.records.candidates.filter((c) => ids.has(String(c.attempt_id))).map((c) => (c.asset_id && !assetIds.has(String(c.asset_id)) ? { ...c, asset_id: null } : c)) };
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
  return { imported: { assets: assets.length, renditions: usable.length, files: stored.size }, missing, mismatched };
}
