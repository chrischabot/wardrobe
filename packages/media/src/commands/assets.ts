/**
 * Asset commands: the pipeline's results (system commands, recorded with receipts like everything else)
 * and the owner's direct actions on assets.
 */
import { z } from "zod";
import { all, allIn, CommandError, define, first, loadGarment, stmt, type CommandContext, type CommandDefinition, type CommandPlan, type Stmt } from "@garderobe/domain";
import { FidelityCheckResult, FidelityCheckName, MEDIA_COMMANDS as C, MediaRenditionKind, TransformationStep } from "@garderobe/contracts/ext/media";
import { assertOwnedKey } from "../keys.ts";
import { limitsOf, resolveDeps, type MediaDepsSource } from "../runtime.ts";
import { enqueueJob, insertRendition, isRealGarmentImage, loadAsset, loadGarmentMediaRow, loadRenditions, upsertGarmentMedia, type AssetRow, type GarmentMediaRow } from "../store.ts";

/** Pipeline results may only be recorded by the system actor (a queue consumer under the job's verified owner). */
export function requireSystemActor(ctx: CommandContext): void {
  if (ctx.principal.actor !== "system") throw new CommandError("forbidden", "this command records pipeline results and is not available to clients");
}

export const SYSTEM_AUTH = ["system_schedule" as const, "standing_policy" as const];

export function photoRequestFor(name: string, category: string): string {
  if (category === "footwear") return `A side-on photo of the pair of ${name} on a plain, light surface in daylight.`;
  if (category === "socks" || category === "belt" || category === "tie" || category === "scarf" || category === "pocket_square" || category === "accessory") {
    return `A photo of ${name} laid flat on a plain, light surface in daylight.`;
  }
  return `A front-on photo of ${name} laid flat or on a hanger against a plain, light background in daylight.`;
}

export const RecordedRendition = z.object({
  renditionId: z.string().min(1).max(64),
  kind: MediaRenditionKind,
  version: z.number().int().positive(),
  objectKey: z.string().min(1).max(512),
  contentType: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  sourceRenditionId: z.string().min(1).max(64),
  transformations: z.array(TransformationStep),
  edited: z.boolean(),
});
export type RecordedRendition = z.infer<typeof RecordedRendition>;

export const RecordedFidelity = z.object({
  subject: z.enum(["cutout", "edit"]),
  /** The stored rendition this report is about; null when the derivative failed and was discarded. */
  renditionId: z.string().nullable(),
  verdict: z.enum(["passed", "failed"]),
  failed: z.array(FidelityCheckName),
  checks: z.array(FidelityCheckResult),
  algorithmVersion: z.string(),
});
export type RecordedFidelity = z.infer<typeof RecordedFidelity>;

export const RecordNormalization = z.object({
  assetId: z.string().min(1).max(64),
  jobId: z.string().min(1).max(64),
  /** normalized: derivatives stored. kept_original: the honest original is used as supplied. failed: the bytes cannot be used at all. */
  outcome: z.enum(["normalized", "kept_original", "failed"]),
  renditions: z.array(RecordedRendition).max(8),
  fidelity: z.array(RecordedFidelity).max(8),
  /** Shown to the owner when something did not work (fidelity failure, undecodable format, uncertain provider charge). */
  note: z.string().max(600).nullable(),
});

export const FailJob = z.object({ jobId: z.string().min(1).max(64), error: z.string().max(600) });
export const CompleteJob = z.object({ jobId: z.string().min(1).max(64), result: z.record(z.string(), z.unknown()).default({}) });
export const ApplyRetention = z.object({ assetIds: z.array(z.string().min(1).max(64)).min(1).max(100) });

export function finishJob(ctx: CommandContext, jobId: string, state: "succeeded" | "dead", result: Record<string, unknown> | null, error: string | null): Stmt {
  return stmt("UPDATE media_jobs SET state = ?, result_json = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE user_id = ? AND job_id = ?", state, result ? JSON.stringify(result) : null, error, ctx.now, ctx.userId, jobId);
}

/** The best remaining image for a garment once `excludeAssetId` is gone: newest active real photograph, else newest active other. */
export async function fallbackPrimary(ctx: CommandContext, garmentId: string, excludeAssetIds: string[]): Promise<AssetRow | null> {
  const rows = await all<AssetRow>(ctx.db, "SELECT * FROM media_assets WHERE user_id = ? AND garment_id = ? AND status = 'active' ORDER BY created_at DESC, asset_id DESC", ctx.userId, garmentId);
  const candidates = rows.filter((r) => !excludeAssetIds.includes(r.asset_id));
  return candidates.find((r) => isRealGarmentImage(r.kind, r.is_demo === 1)) ?? candidates[0] ?? null;
}

/** Statements that mark assets deleted, detach them from garments and composites, and queue the purge of their bytes. */
export async function planAssetRemoval(
  ctx: CommandContext,
  assets: AssetRow[],
  status: "deleted" | "rejected",
  reason: string | null,
  maxAttempts: number,
): Promise<Pick<CommandPlan, "statements" | "outbox" | "affected"> & { purgedKeys: number; jobId: string | null }> {
  const statements: Stmt[] = [];
  const keys: string[] = [];
  const cacheShas: string[] = [];
  const affected: NonNullable<CommandPlan["affected"]> = [];
  const ids = assets.map((a) => a.asset_id);
  const garments = new Set<string>();
  for (const a of assets) {
    const renditions = await loadRenditions(ctx.db, ctx.userId, a.asset_id);
    for (const r of renditions) {
      if (r.status !== "deleted") {
        assertOwnedKey(ctx.userId, r.object_key);
        keys.push(r.object_key);
        cacheShas.push(r.sha256);
      }
    }
    statements.push(
      stmt("UPDATE media_assets SET status = ?, status_reason = ?, deleted_at = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND asset_id = ?", status, reason, ctx.now, ctx.now, ctx.userId, a.asset_id),
      stmt("UPDATE media_renditions SET status = 'deleted' WHERE user_id = ? AND asset_id = ?", ctx.userId, a.asset_id),
    );
    affected.push({ kind: "media_asset", id: a.asset_id, version: a.version + 1 });
    // Composites that drew this asset lose their cached preview; other composites are untouched.
    const composites = await all<{ manifest_hash: string; preview_key: string | null; svg_key: string | null }>(
      ctx.db,
      `SELECT DISTINCT c.manifest_hash, c.preview_key, c.svg_key FROM outfit_composites c JOIN outfit_composite_items i ON i.user_id = c.user_id AND i.manifest_hash = c.manifest_hash
        WHERE c.user_id = ? AND i.rendition_id IN (SELECT rendition_id FROM media_renditions WHERE user_id = ? AND asset_id = ?)`,
      ctx.userId, ctx.userId, a.asset_id,
    );
    for (const c of composites) {
      for (const k of [c.preview_key, c.svg_key]) if (k) keys.push(k);
      statements.push(stmt("UPDATE outfit_composites SET preview_state = 'none', preview_key = NULL, preview_sha256 = NULL, preview_bytes = NULL, svg_key = NULL, failure = 'an image it used was deleted', updated_at = ? WHERE user_id = ? AND manifest_hash = ?", ctx.now, ctx.userId, c.manifest_hash));
    }
    if (a.garment_id) garments.add(a.garment_id);
  }
  for (const garmentId of garments) {
    const current = await loadGarmentMediaRow(ctx.db, ctx.userId, garmentId);
    if (!current || !current.primary_asset_id || !ids.includes(current.primary_asset_id)) continue;
    const next = await fallbackPrimary(ctx, garmentId, ids);
    statements.push(
      upsertGarmentMedia(ctx, garmentId, current, {
        imageState: next ? "resolved" : "not_started",
        primaryAssetId: next?.asset_id ?? null,
        photoRequest: null,
        lastFailure: current.last_failure,
      }),
    );
  }
  if (keys.length === 0) return { statements, outbox: [], affected, purgedKeys: 0, jobId: null };
  const jobId = ctx.newId("job");
  const job = enqueueJob(ctx, { jobId, kind: "purge_objects", subjectId: ids[0] ?? "objects", dedupeKey: `purge:${ctx.commandId}`, payload: { keys: [...new Set(keys)], cacheShas: [...new Set(cacheShas)] }, maxAttempts });
  return { statements: [...statements, ...job.statements], outbox: job.outbox, affected, purgedKeys: keys.length, jobId };
}

export function assetCommands(depsSource: MediaDepsSource): CommandDefinition<any>[] {
  const maxAttempts = () => limitsOf(resolveDeps(depsSource)).jobMaxAttempts;

  const recordNormalization = define({
    type: "media.record_normalization",
    schema: RecordNormalization,
    class: "system",
    requiredScope: "write",
    allowedAuthorizations: SYSTEM_AUTH,
    async plan(ctx, p) {
      requireSystemActor(ctx);
      const asset = await loadAsset(ctx.db, ctx.userId, p.assetId);
      if (!asset) throw new CommandError("not_found", "no such asset for this owner");
      if (asset.status === "deleted" || asset.status === "rejected") {
        // The owner removed the photo while it was being processed: store nothing, purge what the job wrote.
        const keys = p.renditions.map((r) => r.objectKey);
        keys.forEach((k) => assertOwnedKey(ctx.userId, k));
        const purge = keys.length > 0 ? enqueueJob(ctx, { jobId: ctx.newId("job"), kind: "purge_objects", subjectId: p.assetId, dedupeKey: `purge:${ctx.commandId}`, payload: { keys, cacheShas: [] }, maxAttempts: maxAttempts() }) : { statements: [], outbox: [] };
        return { outcome: "noop", summary: "The photo was removed before processing finished; its derivatives were discarded", statements: [finishJob(ctx, p.jobId, "succeeded", { discarded: true }, null), ...purge.statements], outbox: purge.outbox, undo: { unavailableReason: "nothing was stored" } };
      }
      const existing = await loadRenditions(ctx.db, ctx.userId, p.assetId);
      const original = existing.find((r) => r.kind === "original");
      const statements: Stmt[] = [];
      for (const r of p.renditions) {
        assertOwnedKey(ctx.userId, r.objectKey);
        if (r.kind === "original") throw new CommandError("invalid_command", "the original is immutable and cannot be re-recorded");
        if (!existing.some((e) => e.rendition_id === r.sourceRenditionId) && !p.renditions.some((o) => o.renditionId === r.sourceRenditionId)) {
          throw new CommandError("invalid_command", "a rendition must name the rendition it was derived from");
        }
        // An edited source makes every derivative edited: the flag cannot be laundered away downstream.
        const source = existing.find((e) => e.rendition_id === r.sourceRenditionId) ?? p.renditions.find((o) => o.renditionId === r.sourceRenditionId);
        const sourceEdited = source ? ("edited" in source && typeof source.edited === "boolean" ? source.edited : (source as { edited: number }).edited === 1) : false;
        const edited = r.edited || sourceEdited || r.kind === "edited" || r.transformations.some((t) => t.generative);
        statements.push(stmt("UPDATE media_renditions SET status = 'superseded' WHERE user_id = ? AND asset_id = ? AND kind = ? AND status = 'active'", ctx.userId, p.assetId, r.kind));
        statements.push(insertRendition(ctx, { ...r, assetId: p.assetId, edited }));
      }
      // Order matters: renditions inserted after their sources (sources first in the payload).
      for (const f of p.fidelity) {
        statements.push(
          stmt(
            "INSERT INTO media_fidelity_checks (user_id, check_id, asset_id, subject, rendition_id, verdict, failed_json, checks_json, algorithm_version, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ctx.userId, ctx.newId("fid"), p.assetId, f.subject, f.renditionId, f.verdict, JSON.stringify(f.failed), JSON.stringify(f.checks), f.algorithmVersion, ctx.commandId, ctx.now,
          ),
        );
        // A failed derivative is never kept as a usable rendition.
        if (f.verdict === "failed" && f.renditionId && p.renditions.some((r) => r.renditionId === f.renditionId)) {
          throw new CommandError("invalid_command", "a derivative that failed its fidelity check cannot be stored as a rendition");
        }
      }
      const usable = p.outcome !== "failed";
      const nextStatus = asset.status === "needs_review" ? "needs_review" : usable ? "active" : "rejected";
      statements.push(
        stmt("UPDATE media_assets SET status = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND asset_id = ?", nextStatus, p.note, ctx.now, ctx.userId, p.assetId),
      );
      if (!usable && original) statements.push(stmt("UPDATE media_renditions SET status = 'rejected' WHERE user_id = ? AND asset_id = ?", ctx.userId, p.assetId));

      let garmentSummary = "";
      if (asset.garment_id && asset.status !== "needs_review") {
        const current = await loadGarmentMediaRow(ctx.db, ctx.userId, asset.garment_id);
        statements.push(upsertGarmentMedia(ctx, asset.garment_id, current, await garmentStateAfter(ctx, asset, current, usable, p.note)));
        garmentSummary = usable ? "" : "; the garment still has no usable photo";
      }
      statements.push(finishJob(ctx, p.jobId, "succeeded", { outcome: p.outcome, renditions: p.renditions.map((r) => r.kind), fidelityFailed: p.fidelity.filter((f) => f.verdict === "failed").flatMap((f) => f.failed) }, null));
      const failedChecks = p.fidelity.filter((f) => f.verdict === "failed");
      const purge = !usable && original ? enqueueJob(ctx, { jobId: ctx.newId("job"), kind: "purge_objects", subjectId: p.assetId, dedupeKey: `purge:${ctx.commandId}`, payload: { keys: [original.object_key], cacheShas: [original.sha256] }, maxAttempts: maxAttempts() }) : { statements: [], outbox: [] };
      return {
        summary:
          p.outcome === "normalized"
            ? `Catalogue view prepared (${p.renditions.map((r) => r.kind).join(", ")})${failedChecks.length > 0 ? `; ${failedChecks.length} derivative(s) failed the fidelity check and were discarded` : ""}`
            : p.outcome === "kept_original"
              ? `The photo is kept as supplied: ${p.note ?? "no derivative could be made"}`
              : `The photo could not be used: ${p.note ?? "unreadable"}${garmentSummary}`,
        statements: [...statements, ...purge.statements],
        affected: [{ kind: "media_asset", id: p.assetId, version: asset.version + 1 }],
        outbox: [{ topic: "media.asset", entityKind: "media_asset", entityId: p.assetId, revision: asset.version + 1 }, ...purge.outbox],
        result: { assetId: p.assetId, outcome: p.outcome, status: nextStatus, fidelityFailures: failedChecks.map((f) => ({ subject: f.subject, failed: f.failed })) },
        undo: { unavailableReason: "delete the photo instead" },
      };
    },
  });

  const failJob = define({
    type: "media.fail_job",
    schema: FailJob,
    class: "system",
    requiredScope: "write",
    allowedAuthorizations: SYSTEM_AUTH,
    async plan(ctx, p) {
      requireSystemActor(ctx);
      const job = await first<{ kind: string; subject_id: string; state: string }>(ctx.db, "SELECT kind, subject_id, state FROM media_jobs WHERE user_id = ? AND job_id = ?", ctx.userId, p.jobId);
      if (!job) throw new CommandError("not_found", "no such job for this owner");
      const statements: Stmt[] = [finishJob(ctx, p.jobId, "dead", null, p.error)];
      const message = `${job.kind.replace("_", " ")} did not complete: ${p.error}`;
      let garmentId: string | null = null;
      if (job.kind === "normalize") {
        const asset = await loadAsset(ctx.db, ctx.userId, job.subject_id);
        if (asset) {
          statements.push(stmt("UPDATE media_assets SET status_reason = ?, updated_at = ? WHERE user_id = ? AND asset_id = ?", message, ctx.now, ctx.userId, asset.asset_id));
          garmentId = asset.garment_id;
        }
      } else if (job.kind === "discover") garmentId = job.subject_id;
      else if (job.kind === "render_composite") {
        statements.push(stmt("UPDATE outfit_composites SET preview_state = 'failed', failure = ?, updated_at = ? WHERE user_id = ? AND manifest_hash = ?", p.error, ctx.now, ctx.userId, job.subject_id));
      }
      if (garmentId) {
        const current = await loadGarmentMediaRow(ctx.db, ctx.userId, garmentId);
        // The failure is surfaced on the garment; a garment left "searching" would hide it.
        statements.push(
          upsertGarmentMedia(ctx, garmentId, current, {
            imageState: current?.image_state === "searching" ? (current.primary_asset_id ? "resolved" : "not_started") : (current?.image_state ?? "not_started"),
            primaryAssetId: current?.primary_asset_id ?? null,
            photoRequest: current?.photo_request ?? null,
            lastFailure: message,
          }),
        );
      }
      return { summary: `Background work failed and was recorded: ${message}`, statements, affected: [{ kind: "media_job", id: p.jobId, version: 1 }], result: { jobId: p.jobId, state: "dead" }, undo: { unavailableReason: "a failure record is not undone" } };
    },
  });

  const completeJob = define({
    type: "media.complete_job",
    schema: CompleteJob,
    class: "system",
    requiredScope: "write",
    allowedAuthorizations: SYSTEM_AUTH,
    async plan(ctx, p) {
      requireSystemActor(ctx);
      return { summary: "Background work completed", statements: [finishJob(ctx, p.jobId, "succeeded", p.result, null)], result: { jobId: p.jobId }, undo: { unavailableReason: "completed background work is not undone" } };
    },
  });

  const setPrimary = define({
    type: "media.set_primary_asset",
    schema: C["media.set_primary_asset"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      const garment = await loadGarment(ctx, p.garmentId);
      const asset = await loadAsset(ctx.db, ctx.userId, p.assetId);
      if (!asset || asset.garment_id !== garment.garment_id) throw new CommandError("not_found", "that image does not belong to this garment");
      if (asset.status !== "active") throw new CommandError("precondition_failed", `that image is ${asset.status.replace("_", " ")} and cannot be shown yet`);
      const current = await loadGarmentMediaRow(ctx.db, ctx.userId, garment.garment_id);
      if (current?.primary_asset_id === asset.asset_id) return { outcome: "noop", summary: `${garment.name} already uses that image`, undo: { unavailableReason: "nothing changed" } };
      const real = isRealGarmentImage(asset.kind, asset.is_demo === 1);
      return {
        summary: `${garment.name} now shows the chosen ${real ? "photo" : asset.is_demo === 1 ? "demo placeholder" : "illustration"}`,
        statements: [
          upsertGarmentMedia(ctx, garment.garment_id, current, {
            imageState: real || asset.is_demo === 1 ? "resolved" : current?.image_state === "photos_needed" ? "photos_needed" : "resolved",
            primaryAssetId: asset.asset_id,
            photoRequest: real ? null : (current?.photo_request ?? null),
            lastFailure: current?.last_failure ?? null,
          }),
        ],
        affected: [{ kind: "media_asset", id: asset.asset_id, version: asset.version }],
        result: { garmentId: garment.garment_id, primaryAssetId: asset.asset_id },
        undo: { data: { garmentId: garment.garment_id, previousAssetId: current?.primary_asset_id ?? null, previousState: current?.image_state ?? "not_started", previousRequest: current?.photo_request ?? null } },
      };
    },
    async planUndo(ctx, _original, data) {
      const current = await loadGarmentMediaRow(ctx.db, ctx.userId, data.garmentId);
      const previous = data.previousAssetId ? await loadAsset(ctx.db, ctx.userId, data.previousAssetId) : null;
      const usable = previous && previous.status === "active" ? previous : null;
      return {
        summary: usable ? "The previous image is shown again" : "The image choice was cleared (the previous image no longer exists)",
        statements: [
          upsertGarmentMedia(ctx, data.garmentId, current, {
            imageState: usable ? (data.previousState === "photos_needed" && data.previousRequest ? "photos_needed" : "resolved") : "not_started",
            primaryAssetId: usable?.asset_id ?? null,
            photoRequest: usable && data.previousState === "photos_needed" ? data.previousRequest : null,
            lastFailure: current?.last_failure ?? null,
          }),
        ],
        undo: { unavailableReason: "this is already an undo; choose the image again instead" },
      };
    },
  });

  const deleteAsset = define({
    type: "media.delete_asset",
    schema: C["media.delete_asset"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      const asset = await loadAsset(ctx.db, ctx.userId, p.assetId);
      if (!asset) throw new CommandError("not_found", "no such image for this owner; nothing was written");
      if (asset.status === "deleted") return { outcome: "noop", summary: "That image was already deleted", undo: { unavailableReason: "nothing changed" } };
      // Deletion propagates to everything derived from this asset.
      const derived = await all<AssetRow>(ctx.db, "SELECT * FROM media_assets WHERE user_id = ? AND derived_from_asset_id = ? AND status != 'deleted'", ctx.userId, asset.asset_id);
      const removal = await planAssetRemoval(ctx, [asset, ...derived], "deleted", p.reason ?? "deleted by the owner", maxAttempts());
      const candidates = stmt("UPDATE media_candidates SET decision = 'rejected', rejection_reasons_json = '[\"owner_rejected\"]', decided_by = 'owner', updated_at = ? WHERE user_id = ? AND asset_id = ? AND decision != 'rejected'", ctx.now, ctx.userId, asset.asset_id);
      return {
        summary: `Image deleted${derived.length > 0 ? ` with ${derived.length} derived image(s)` : ""}; its stored files, previews and cached copies are being purged`,
        statements: [...(removal.statements ?? []), candidates],
        preconditions: [{ label: "image not already deleted", sql: "(SELECT status FROM media_assets WHERE user_id = ? AND asset_id = ?) != 'deleted'", params: [ctx.userId, asset.asset_id], class: "state" }],
        affected: removal.affected,
        outbox: [...(removal.outbox ?? []), { topic: "media.asset", entityKind: "media_asset", entityId: asset.asset_id, revision: asset.version + 1, payload: { deleted: true } }],
        result: { assetId: asset.asset_id, derivedDeleted: derived.map((d) => d.asset_id), objectsQueuedForPurge: removal.purgedKeys, purgeJobId: removal.jobId, modelFileReferences: "none retained: providers receive image bytes per job and no provider file ID is stored" },
        undo: { unavailableReason: "deleted image files are purged and cannot be restored; upload the photo again" },
      };
    },
  });

  const applyRetention = define({
    type: "media.apply_retention",
    schema: ApplyRetention,
    class: "system",
    requiredScope: "write",
    allowedAuthorizations: SYSTEM_AUTH,
    async plan(ctx, p) {
      requireSystemActor(ctx);
      const rows = await allIn<AssetRow>(ctx.db, "SELECT * FROM media_assets WHERE user_id = ? AND asset_id IN (:ids)", [ctx.userId], p.assetIds);
      const due = rows.filter((a) => a.kind === "selfie" && a.status !== "deleted" && a.original_purged_at === null && a.retain_original_until !== null && a.retain_original_until <= ctx.now);
      if (due.length === 0) return { outcome: "noop", summary: "No full-resolution selfie is due for removal", undo: { unavailableReason: "nothing changed" } };
      const statements: Stmt[] = [];
      const keys: string[] = [];
      const cacheShas: string[] = [];
      for (const a of due) {
        const renditions = await loadRenditions(ctx.db, ctx.userId, a.asset_id);
        const original = renditions.find((r) => r.kind === "original" && r.status !== "deleted");
        const hasDisplay = renditions.some((r) => r.kind === "display" && r.status === "active");
        if (!original) continue;
        assertOwnedKey(ctx.userId, original.object_key);
        keys.push(original.object_key);
        cacheShas.push(original.sha256);
        statements.push(
          stmt("UPDATE media_renditions SET status = 'deleted' WHERE user_id = ? AND rendition_id = ?", ctx.userId, original.rendition_id),
          // The outfit-history copy (the reduced display rendition) is kept; without one the selfie is gone entirely.
          stmt("UPDATE media_assets SET original_purged_at = ?, status = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND asset_id = ?", ctx.now, hasDisplay ? a.status : "deleted", "full-resolution original removed under the photo-history setting", ctx.now, ctx.userId, a.asset_id),
        );
      }
      if (keys.length === 0) return { outcome: "noop", summary: "No full-resolution selfie is due for removal", undo: { unavailableReason: "nothing changed" } };
      const job = enqueueJob(ctx, { jobId: ctx.newId("job"), kind: "purge_objects", subjectId: due[0]!.asset_id, dedupeKey: `purge:${ctx.commandId}`, payload: { keys, cacheShas }, maxAttempts: maxAttempts() });
      return {
        summary: `Removed ${keys.length} full-resolution selfie original(s) under the photo-history setting; the outfit-history copies are kept`,
        statements: [...statements, ...job.statements],
        outbox: job.outbox,
        affected: due.map((a) => ({ kind: "media_asset", id: a.asset_id, version: a.version + 1 })),
        result: { purgedOriginals: keys.length },
        undo: { unavailableReason: "purged originals cannot be restored" },
      };
    },
  });

  return [recordNormalization, failJob, completeJob, setPrimary, deleteAsset, applyRetention];
}

/** The garment's image state after one of its assets finished (or failed) processing. */
async function garmentStateAfter(ctx: CommandContext, asset: AssetRow, current: GarmentMediaRow | null, usable: boolean, note: string | null) {
  const garmentId = asset.garment_id!;
  const isDemo = asset.is_demo === 1;
  const real = isRealGarmentImage(asset.kind, isDemo);
  if (!usable) {
    const keep = current?.primary_asset_id && current.primary_asset_id !== asset.asset_id ? current.primary_asset_id : null;
    return {
      imageState: keep ? ("resolved" as const) : ("not_started" as const),
      primaryAssetId: keep,
      photoRequest: null,
      lastFailure: note ?? "the photo could not be used",
    };
  }
  let primary = current?.primary_asset_id ?? null;
  if (primary && primary !== asset.asset_id) {
    const existing = await loadAsset(ctx.db, ctx.userId, primary);
    const existingReal = existing ? existing.status === "active" && isRealGarmentImage(existing.kind, existing.is_demo === 1) : false;
    // A real photograph replaces an illustration or placeholder; a newer real photograph replaces an older one.
    if (!existing || existing.status !== "active" || real || !existingReal) primary = real || !existingReal ? asset.asset_id : primary;
  } else primary = asset.asset_id;
  if (real || isDemo) return { imageState: "resolved" as const, primaryAssetId: primary, photoRequest: null, lastFailure: note };
  // An illustration never resolves the need for a real photograph.
  const state = current?.image_state === "photos_needed" && current.photo_request ? ("photos_needed" as const) : ("resolved" as const);
  return { imageState: state, primaryAssetId: primary, photoRequest: state === "photos_needed" ? current!.photo_request : null, lastFailure: note };
}
