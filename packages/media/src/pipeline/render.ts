/**
 * Background rendering of an outfit preview: load the manifest, read the approved renditions from
 * private storage (each key re-checked against the owner), composite deterministically and store the
 * PNG and the SVG scene. Never called on the path that prepares the morning board.
 */
import { all, first, sha256Hex } from "@garderobe/domain";
import { CompositionManifest } from "@garderobe/contracts/ext/media";
import { COMPOSITE_COLS, type CompositeRow } from "../commands/composites.ts";
import { renderRaster } from "../compose/raster.ts";
import { renderSvg } from "../compose/svg.ts";
import { execSystem } from "../exec.ts";
import { decodeImage, decodePng, encodePng, type Raster } from "../image/index.ts";
import type { JobRow } from "../jobs.ts";
import { assertOwnedKey, compositeKey } from "../keys.ts";
import { limitsOf, type MediaRuntime } from "../runtime.ts";

export const RENDERER_NAME = "garderobe-compositor-1";

export async function runRenderJob(rt: MediaRuntime, job: JobRow): Promise<void> {
  const userId = job.user_id;
  const row = await first<CompositeRow>(rt.db, `SELECT ${COMPOSITE_COLS} FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?`, userId, job.subject_id);
  if (!row) {
    await execSystem(rt, userId, "media.complete_job", { jobId: job.job_id, result: { skipped: "the composite no longer exists" } }, `job-done:${job.job_id}`);
    return;
  }
  const manifest = CompositionManifest.parse(JSON.parse(row.manifest_json));
  const ids = [...new Set(manifest.layers.map((l) => l.renditionId).filter((id): id is string => !!id))];
  const images = new Map<string, Raster>();
  if (ids.length > 0) {
    const marks = ids.map(() => "?").join(",");
    // Only this owner's ACTIVE renditions can be drawn; a deleted or foreign rendition renders as missing.
    const renditions = await all<{ rendition_id: string; object_key: string; content_type: string; sha256: string }>(rt.db, `SELECT rendition_id, object_key, content_type, sha256 FROM media_renditions WHERE user_id = ? AND status = 'active' AND rendition_id IN (${marks})`, userId, ...ids);
    for (const r of renditions) {
      assertOwnedKey(userId, r.object_key);
      const object = await rt.deps.bucket.get(r.object_key);
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      try {
        images.set(r.rendition_id, (await decodeImage(bytes, { maxPixels: limitsOf(rt.deps).maxPixels })).raster);
      } catch {
        if (rt.deps.transcoder) {
          const out = await rt.deps.transcoder.toPng({ bytes, contentType: r.content_type, maxEdge: 1200 });
          if (out.ok) images.set(r.rendition_id, await decodePng(out.png));
        }
      }
    }
  }
  const svg = renderSvg(manifest);
  let png: Uint8Array;
  let renderer = RENDERER_NAME;
  if (rt.deps.previewExporter) {
    // Optional browser/image-service export of the SVG scene; the built-in compositor is the fallback.
    const exported = await rt.deps.previewExporter.renderSvgToPng({ svg, width: manifest.canvas.width, height: manifest.canvas.height });
    if (exported.ok) {
      png = exported.png;
      renderer = rt.deps.previewExporter.name;
    } else png = await encodePng(renderRaster(manifest, images));
  } else png = await encodePng(renderRaster(manifest, images));

  const previewKey = compositeKey(userId, row.manifest_hash, "image/png");
  const svgKey = compositeKey(userId, row.manifest_hash, "image/svg+xml");
  const previewSha256 = await sha256Hex(png);
  await rt.deps.bucket.put(previewKey, png, { httpMetadata: { contentType: "image/png" }, customMetadata: { manifestHash: row.manifest_hash, sha256: previewSha256 } });
  await rt.deps.bucket.put(svgKey, svg, { httpMetadata: { contentType: "image/svg+xml" }, customMetadata: { manifestHash: row.manifest_hash } });
  await execSystem(rt, userId, "media.record_composite", { manifestHash: row.manifest_hash, jobId: job.job_id, previewKey, previewSha256, previewBytes: png.length, svgKey, renderer }, `rendered:${job.job_id}`);
}
