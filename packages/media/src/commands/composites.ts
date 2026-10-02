/** Composite preview commands: queue the background render of an outfit manifest, and record its result. */
import { z } from "zod";
import { CommandError, define, first, stableId, stmt, type CommandContext, type CommandDefinition, type CommandPlan, type Db, type Stmt } from "@garderobe/domain";
import { CompositionManifest, MEDIA_COMMANDS as C } from "@garderobe/contracts/ext/media";
import { compositeKey } from "../keys.ts";
import { limitsOf, resolveDeps, type MediaDepsSource } from "../runtime.ts";
import { enqueueJob } from "../store.ts";
import { composeResolved, resolveSlots } from "../studio/shared.ts";
import { finishJob, requireSystemActor, SYSTEM_AUTH } from "./assets.ts";

/*
 * No storage location is named: a preview's files live where `compositeKey` puts them for this owner and
 * manifest, so the command record never holds a storage key and cannot point at any other object.
 */
export const RecordComposite = z.object({
  manifestHash: z.string().length(64),
  jobId: z.string().min(1).max(64),
  previewSha256: z.string().length(64),
  previewBytes: z.number().int().positive(),
  /** Whether the SVG scene was stored beside the PNG. */
  hasSvg: z.boolean(),
  renderer: z.string().max(120),
});

export interface CompositeRow {
  manifest_hash: string;
  manifest_json: string;
  preview_state: "none" | "queued" | "rendered" | "failed";
  preview_key: string | null;
  preview_sha256: string | null;
  svg_key: string | null;
  failure: string | null;
  rendered_at: string | null;
}

export const COMPOSITE_COLS = "manifest_hash, manifest_json, preview_state, preview_key, preview_sha256, svg_key, failure, rendered_at";

export const DiscardComposite = z.object({ manifestHash: z.string().length(64), jobId: z.string().min(1).max(64), reason: z.string().max(300) });

const STALE_ITEMS_SQL = `(SELECT COUNT(*) FROM outfit_composite_items i
   LEFT JOIN media_renditions r ON r.user_id = i.user_id AND r.rendition_id = i.rendition_id
   LEFT JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id
  WHERE i.user_id = ? AND i.manifest_hash = ? AND i.rendition_id IS NOT NULL AND (r.rendition_id IS NULL OR r.status != 'active' OR a.status != 'active'))`;

/** How many images a composite's manifest refers to that are no longer there (deleted, rejected or replaced). */
export async function staleCompositeItems(db: Db, userId: string, manifestHash: string): Promise<number> {
  return (await first<{ n: number }>(db, `SELECT ${STALE_ITEMS_SQL} AS n`, userId, manifestHash))?.n ?? 0;
}

/**
 * A preview that must not exist: an image it drew was deleted (or replaced) while it was being prepared.
 * The composite is reset, the job is closed, and whatever the render wrote is purged from storage.
 */
function planDiscard(ctx: CommandContext, manifestHash: string, jobId: string, reason: string, maxAttempts: number): CommandPlan {
  const keys = [compositeKey(ctx.userId, manifestHash, "image/png"), compositeKey(ctx.userId, manifestHash, "image/svg+xml")];
  const purge = enqueueJob(ctx, { jobId: ctx.newId("job"), kind: "purge_objects", subjectId: manifestHash, dedupeKey: `purge-composite:${ctx.commandId}`, payload: { keys, cacheShas: [] }, maxAttempts });
  return {
    summary: `The outfit preview was discarded: ${reason}`,
    statements: [
      stmt("UPDATE outfit_composites SET preview_state = 'none', preview_key = NULL, preview_sha256 = NULL, preview_bytes = NULL, svg_key = NULL, rendered_at = NULL, failure = ?, updated_at = ? WHERE user_id = ? AND manifest_hash = ?", reason, ctx.now, ctx.userId, manifestHash),
      finishJob(ctx, jobId, "succeeded", { discarded: true, reason }, null),
      ...purge.statements,
    ],
    outbox: purge.outbox,
    affected: [{ kind: "outfit_composite", id: manifestHash, version: 1 }],
    result: { manifestHash, discarded: true, reason, purgeJobId: purge.outbox[0]?.entityId ?? null },
    undo: { unavailableReason: "a discarded preview is simply requested again" },
  };
}

export const PREVIEW_INVALIDATED = "an image it used was deleted or replaced while the preview was being prepared";

export function compositeCommands(depsSource: MediaDepsSource): CommandDefinition<any>[] {
  const request = define({
    type: "media.request_composite_preview",
    schema: C["media.request_composite_preview"],
    class: "edit",
    requiredScope: "write",
    // Also schedulable: the daily service may queue previews for a prepared board without the owner present.
    allowedAuthorizations: ["owner_tap", "owner_statement", "system_schedule", "standing_policy"],
    async plan(ctx, p) {
      const resolved = await resolveSlots(ctx.db, ctx.userId, p.slots);
      const { manifest, hash } = await composeResolved(resolved);
      const existing = await first<CompositeRow>(ctx.db, `SELECT ${COMPOSITE_COLS} FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?`, ctx.userId, hash);
      if (existing && (existing.preview_state === "rendered" || existing.preview_state === "queued")) {
        // The content hash identifies the cached output: the same outfit is never rendered twice.
        return { outcome: "noop", summary: existing.preview_state === "rendered" ? "That outfit's preview already exists" : "That outfit's preview is already being prepared", result: { manifestHash: hash, previewState: existing.preview_state }, undo: { unavailableReason: "nothing changed" } };
      }
      const attempt = existing ? `${existing.preview_state}:${ctx.commandId}` : "1";
      const jobId = await stableId("job", ctx.userId, "render", hash, attempt);
      const job = enqueueJob(ctx, { jobId, kind: "render_composite", subjectId: hash, dedupeKey: `render:${hash}:${attempt}`, maxAttempts: limitsOf(resolveDeps(depsSource)).jobMaxAttempts });
      const statements: Stmt[] = [
        stmt(
          `INSERT INTO outfit_composites (user_id, manifest_hash, manifest_json, template_version, preview_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)
           ON CONFLICT (user_id, manifest_hash) DO UPDATE SET preview_state = 'queued', failure = NULL, updated_at = excluded.updated_at`,
          ctx.userId, hash, JSON.stringify(manifest), manifest.templateVersion, ctx.now, ctx.now,
        ),
        stmt("DELETE FROM outfit_composite_items WHERE user_id = ? AND manifest_hash = ?", ctx.userId, hash),
      ];
      const seen = new Set<string>();
      for (const layer of manifest.layers) {
        if (!layer.garmentId || seen.has(layer.garmentId)) continue;
        seen.add(layer.garmentId);
        statements.push(stmt("INSERT INTO outfit_composite_items (user_id, manifest_hash, garment_id, rendition_id) VALUES (?, ?, ?, ?)", ctx.userId, hash, layer.garmentId, layer.renditionId));
      }
      return {
        summary: `Preview queued for ${manifest.layers.length} piece${manifest.layers.length === 1 ? "" : "s"}; it is prepared in the background`,
        statements: [...statements, ...job.statements],
        outbox: job.outbox,
        affected: [{ kind: "outfit_composite", id: hash, version: 1 }],
        result: { manifestHash: hash, previewState: "queued", jobId },
        undo: { unavailableReason: "a queued preview simply renders" },
      };
    },
  });

  const record = define({
    type: "media.record_composite",
    schema: RecordComposite,
    class: "system",
    requiredScope: "write",
    allowedAuthorizations: SYSTEM_AUTH,
    async plan(ctx, p) {
      requireSystemActor(ctx);
      const previewKey = compositeKey(ctx.userId, p.manifestHash, "image/png");
      const svgKey = p.hasSvg ? compositeKey(ctx.userId, p.manifestHash, "image/svg+xml") : null;
      const row = await first<CompositeRow>(ctx.db, `SELECT ${COMPOSITE_COLS} FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?`, ctx.userId, p.manifestHash);
      if (!row) throw new CommandError("not_found", "no such composite for this owner");
      CompositionManifest.parse(JSON.parse(row.manifest_json));
      // The render ran outside any transaction: an image may have been deleted while it was being drawn.
      // A preview is recorded only if the request is still open and every image it used is still there.
      if (row.preview_state !== "queued" || (await staleCompositeItems(ctx.db, ctx.userId, p.manifestHash)) > 0) {
        return planDiscard(ctx, p.manifestHash, p.jobId, row.preview_state === "none" && row.failure ? row.failure : PREVIEW_INVALIDATED, limitsOf(resolveDeps(depsSource)).jobMaxAttempts);
      }
      return {
        summary: "Outfit preview rendered and stored privately",
        statements: [
          stmt("UPDATE outfit_composites SET preview_state = 'rendered', preview_key = ?, preview_sha256 = ?, preview_bytes = ?, svg_key = ?, failure = NULL, rendered_at = ?, updated_at = ? WHERE user_id = ? AND manifest_hash = ?", previewKey, p.previewSha256, p.previewBytes, svgKey, ctx.now, ctx.now, ctx.userId, p.manifestHash),
          finishJob(ctx, p.jobId, "succeeded", { renderer: p.renderer, sha256: p.previewSha256 }, null),
        ],
        // Checked again inside the commit: a deletion that lands between this plan and its commit fails the
        // command, the job runs again, and the next attempt discards the preview.
        preconditions: [
          { label: "the preview request is still open", sql: "(SELECT preview_state FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?) = 'queued'", params: [ctx.userId, p.manifestHash], class: "state" },
          { label: "every image the preview used is still there", sql: `${STALE_ITEMS_SQL} = 0`, params: [ctx.userId, p.manifestHash], class: "state" },
        ],
        affected: [{ kind: "outfit_composite", id: p.manifestHash, version: 1 }],
        outbox: [{ topic: "media.composite", entityKind: "outfit_composite", entityId: p.manifestHash, revision: 1 }],
        result: { manifestHash: p.manifestHash, previewSha256: p.previewSha256 },
        undo: { unavailableReason: "a rendered preview is a cache; it is not undone" },
      };
    },
  });

  const discard = define({
    type: "media.discard_composite",
    schema: DiscardComposite,
    class: "system",
    requiredScope: "write",
    allowedAuthorizations: SYSTEM_AUTH,
    async plan(ctx, p) {
      requireSystemActor(ctx);
      const row = await first<CompositeRow>(ctx.db, `SELECT ${COMPOSITE_COLS} FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?`, ctx.userId, p.manifestHash);
      if (!row) throw new CommandError("not_found", "no such composite for this owner");
      return planDiscard(ctx, p.manifestHash, p.jobId, p.reason, limitsOf(resolveDeps(depsSource)).jobMaxAttempts);
    },
  });

  return [request, record, discard];
}
