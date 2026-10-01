/** Composite preview commands: queue the background render of an outfit manifest, and record its result. */
import { z } from "zod";
import { CommandError, define, first, stableId, stmt, type CommandDefinition, type Stmt } from "@garderobe/domain";
import { CompositionManifest, MEDIA_COMMANDS as C } from "@garderobe/contracts/ext/media";
import { assertOwnedKey } from "../keys.ts";
import { limitsOf, resolveDeps, type MediaDepsSource } from "../runtime.ts";
import { enqueueJob } from "../store.ts";
import { composeResolved, resolveSlots } from "../studio/shared.ts";
import { finishJob, requireSystemActor, SYSTEM_AUTH } from "./assets.ts";

export const RecordComposite = z.object({
  manifestHash: z.string().length(64),
  jobId: z.string().min(1).max(64),
  previewKey: z.string().min(1).max(512),
  previewSha256: z.string().length(64),
  previewBytes: z.number().int().positive(),
  svgKey: z.string().min(1).max(512).nullable(),
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
      assertOwnedKey(ctx.userId, p.previewKey);
      if (p.svgKey) assertOwnedKey(ctx.userId, p.svgKey);
      const row = await first<CompositeRow>(ctx.db, `SELECT ${COMPOSITE_COLS} FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?`, ctx.userId, p.manifestHash);
      if (!row) throw new CommandError("not_found", "no such composite for this owner");
      CompositionManifest.parse(JSON.parse(row.manifest_json));
      return {
        summary: "Outfit preview rendered and stored privately",
        statements: [
          stmt("UPDATE outfit_composites SET preview_state = 'rendered', preview_key = ?, preview_sha256 = ?, preview_bytes = ?, svg_key = ?, failure = NULL, rendered_at = ?, updated_at = ? WHERE user_id = ? AND manifest_hash = ?", p.previewKey, p.previewSha256, p.previewBytes, p.svgKey, ctx.now, ctx.now, ctx.userId, p.manifestHash),
          finishJob(ctx, p.jobId, "succeeded", { renderer: p.renderer, sha256: p.previewSha256 }, null),
        ],
        affected: [{ kind: "outfit_composite", id: p.manifestHash, version: 1 }],
        outbox: [{ topic: "media.composite", entityKind: "outfit_composite", entityId: p.manifestHash, revision: 1 }],
        result: { manifestHash: p.manifestHash, previewSha256: p.previewSha256 },
        undo: { unavailableReason: "a rendered preview is a cache; it is not undone" },
      };
    },
  });

  return [request, record];
}
