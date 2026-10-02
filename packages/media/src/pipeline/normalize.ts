/**
 * Catalogue normalization (specification section 11). The original is immutable; this job derives a
 * metadata-free display copy, a background-removed cutout with its mask, and the neutral-canvas
 * catalogue view. Every derivative is checked against the original and a failed derivative is
 * discarded with its report kept. Generative editing is used only through the injected provider and
 * only when the photograph cannot be cut out as it is.
 */
import { json, stableId, sha256Hex } from "@garderobe/domain";
import type { TransformationStep } from "@garderobe/contracts/ext/media";
import {
  catalogueView, checkFidelity, correctLighting, cropUniformBorders, decodeImage, decodePng, encodeJpeg, encodePng, fitWithin, ImageDecodeError, probeImage, resizeRaster, uniformBackgroundCutout,
  FIDELITY_ALGORITHM_VERSION, PREPARE_ALGORITHM_VERSION, type FidelityReport as PixelFidelity, type Raster,
} from "../image/index.ts";
import { EDIT_CONSTRAINTS } from "../adapters.ts";
import type { RecordedFidelity, RecordedRendition } from "../commands/assets.ts";
import { execSystem } from "../exec.ts";
import type { JobRow } from "../jobs.ts";
import { assertOwnedKey, renditionKey } from "../keys.ts";
import { limitsOf, type MediaRuntime } from "../runtime.ts";
import { loadAsset, loadRenditions, type RenditionRow } from "../store.ts";

export const NORMALIZER_VERSION = "normalize-1";

function toRecorded(report: PixelFidelity, subject: "cutout" | "edit", renditionId: string | null): RecordedFidelity {
  return { subject, renditionId, verdict: report.verdict, failed: report.failed, checks: report.checks, algorithmVersion: report.algorithmVersion };
}

function describeFailure(what: string, report: PixelFidelity): string {
  return `${what} failed the fidelity check (${report.failed.join(", ").replace(/_/g, " ")}) and was discarded`;
}

export async function runNormalizeJob(rt: MediaRuntime, job: JobRow): Promise<void> {
  const userId = job.user_id;
  const limits = limitsOf(rt.deps);
  const payload = json<{ stagingKey?: string }>(job.payload_json, {});
  if (payload.stagingKey) {
    // The finalized original is stored; the staging copy is no longer needed.
    assertOwnedKey(userId, payload.stagingKey);
    await rt.deps.bucket.delete(payload.stagingKey);
  }
  const asset = await loadAsset(rt.db, userId, job.subject_id);
  const done = (body: { outcome: "normalized" | "kept_original" | "failed"; renditions?: RecordedRendition[]; fidelity?: RecordedFidelity[]; note?: string | null }) =>
    execSystem(rt, userId, "media.record_normalization", { assetId: job.subject_id, jobId: job.job_id, outcome: body.outcome, renditions: body.renditions ?? [], fidelity: body.fidelity ?? [], note: body.note ?? null }, `normalized:${job.job_id}`);
  if (!asset) {
    await execSystem(rt, userId, "media.complete_job", { jobId: job.job_id, result: { skipped: "asset no longer exists" } }, `job-done:${job.job_id}`);
    return;
  }
  const existing = await loadRenditions(rt.db, userId, asset.asset_id);
  const original = existing.find((r) => r.kind === "original" && r.status === "active");
  if (!original || asset.status === "deleted" || asset.status === "rejected") {
    await done({ outcome: "kept_original", note: null });
    return;
  }
  assertOwnedKey(userId, original.object_key);
  const object = await rt.deps.bucket.get(original.object_key);
  if (!object) throw new Error("the original image is missing from storage");
  const originalBytes = new Uint8Array(await object.arrayBuffer());
  // The stored bytes must still be the bytes that were finalized.
  if ((await sha256Hex(originalBytes)) !== original.sha256) throw new Error("the stored original does not match its recorded checksum");

  const steps: TransformationStep[] = [];
  let source: Raster;
  try {
    const probe = probeImage(originalBytes);
    if (probe && (probe.format === "png" || probe.format === "jpeg")) {
      source = (await decodeImage(originalBytes, { maxPixels: limits.maxPixels })).raster;
      steps.push({ step: "decode", tool: "garderobe-image", version: NORMALIZER_VERSION, generative: false, params: { format: probe.format, exifOrientationApplied: probe.exif.orientation ?? 1 } });
    } else if (rt.deps.transcoder) {
      const out = await rt.deps.transcoder.toPng({ bytes: originalBytes, contentType: original.content_type, maxEdge: limits.workingEdge });
      if (!out.ok) {
        await done({ outcome: "kept_original", note: `The ${original.content_type} photo is stored, but could not be converted for a catalogue view: ${out.reason}` });
        return;
      }
      source = await decodePng(out.png, { maxPixels: limits.maxPixels });
      steps.push({ step: "transcode", tool: rt.deps.transcoder.name, version: rt.deps.transcoder.version, generative: false, params: { from: original.content_type, to: "image/png" } });
    } else {
      await done({ outcome: "kept_original", note: `The ${original.content_type} photo is stored as supplied; no converter is configured, so it has no catalogue view yet` });
      return;
    }
  } catch (e) {
    if (e instanceof ImageDecodeError) {
      await done({ outcome: "failed", note: `The image could not be read (${e.reason.replace("_", " ")}); please supply another photo` });
      return;
    }
    throw e;
  }

  const fit = fitWithin(source.width, source.height, limits.workingEdge, limits.workingEdge);
  let working = source;
  if (fit.width !== source.width || fit.height !== source.height) {
    working = resizeRaster(source, fit.width, fit.height);
    steps.push({ step: "downscale", tool: "garderobe-image", version: NORMALIZER_VERSION, generative: false, params: { from: [source.width, source.height], to: [fit.width, fit.height] } });
  }

  const renditions: RecordedRendition[] = [];
  const fidelity: RecordedFidelity[] = [];
  const notes: string[] = [];
  const nextVersion = (kind: string) => 1 + Math.max(0, ...existing.filter((r: RenditionRow) => r.kind === kind).map((r) => r.version));

  const store = async (kind: RecordedRendition["kind"], bytes: Uint8Array, contentType: string, raster: Raster, sourceRenditionId: string, transformations: TransformationStep[], edited: boolean): Promise<RecordedRendition> => {
    const version = nextVersion(kind);
    const sha256 = await sha256Hex(bytes);
    const objectKey = renditionKey(userId, asset.asset_id, kind, version, sha256, contentType);
    await rt.deps.bucket.put(objectKey, bytes, { httpMetadata: { contentType }, customMetadata: { assetId: asset.asset_id, kind, sha256 } });
    const rendition: RecordedRendition = {
      renditionId: await stableId("rnd", userId, asset.asset_id, kind, String(version)),
      kind, version, contentType, width: raster.width, height: raster.height, byteLength: bytes.length, sha256, sourceRenditionId, transformations, edited,
    };
    renditions.push(rendition);
    return rendition;
  };
  const reencoded: TransformationStep = { step: "reencode_without_metadata", tool: "garderobe-image", version: NORMALIZER_VERSION, generative: false, params: { note: "written from decoded pixels; no EXIF, GPS or other metadata is carried over" } };

  // Selfies and attachments get a metadata-free display copy only: no face or background processing is needed for them.
  if (asset.kind === "selfie" || asset.kind === "attachment") {
    await store("display", encodeJpeg(working, 88), "image/jpeg", working, original.rendition_id, [...steps, reencoded], false);
    await done({ outcome: "normalized", renditions });
    return;
  }

  let base = working;
  let baseRenditionId = original.rendition_id;
  let baseSteps = steps;
  let edited = false;
  let cutout: Raster | null = null;
  let cutoutSteps: TransformationStep[] = [];

  const tryCutout = async (image: Raster): Promise<{ raster: Raster; steps: TransformationStep[] } | { declined: string }> => {
    const out = uniformBackgroundCutout(image);
    if (out.ok) {
      return { raster: out.raster, steps: [{ step: "uniform_background_flood_fill", tool: "garderobe-image", version: NORMALIZER_VERSION, generative: false, params: { background: out.background, foregroundShare: Math.round(out.foregroundShare * 1000) / 1000, touchesEdge: out.touchesEdge, sourcePixelsPreserved: true } }] };
    }
    if (out.reason === "already_transparent") return { raster: image, steps: [{ step: "existing_transparency", tool: "garderobe-image", version: NORMALIZER_VERSION, generative: false, params: {} }] };
    if (out.reason === "background_not_uniform" && rt.deps.backgroundRemover) {
      const removed = await rt.deps.backgroundRemover.remove({ bytes: await encodePng(image), contentType: "image/png" });
      if (!removed.ok) return { declined: `background removal by ${rt.deps.backgroundRemover.name} failed: ${removed.reason}` };
      const decoded = await decodePng(removed.png, { maxPixels: limits.maxPixels });
      const sized = decoded.width === image.width && decoded.height === image.height ? decoded : resizeRaster(decoded, image.width, image.height);
      return { raster: sized, steps: [{ step: "model_background_removal", tool: rt.deps.backgroundRemover.name, version: rt.deps.backgroundRemover.version, generative: false, params: {} }] };
    }
    return { declined: out.detail };
  };

  let attempt = await tryCutout(base);
  // Steps considered but not applied (a correction that failed its check): recorded on the copy that is kept.
  const notApplied: TransformationStep[] = [];
  if (!("raster" in attempt)) {
    // Cropping comes before anything generative: flat neutral bars around the picture are removed, and the
    // source-pixel cutout is tried again on what remains.
    const crop = cropUniformBorders(base);
    if (crop.changed) {
      const cropStep: TransformationStep = {
        step: "crop_uniform_borders", tool: "garderobe-image", version: PREPARE_ALGORITHM_VERSION, generative: false,
        params: { from: [base.width, base.height], box: crop.box, removed: crop.removed, fidelity: { verdict: "passed", measure: "largest channel difference from the bar colour among removed pixels", score: crop.maxDeviation, threshold: 10, sourcePixelsPreserved: true } },
      };
      base = crop.raster;
      baseSteps = [...steps, cropStep];
      attempt = await tryCutout(base);
    }
  }
  if ("raster" in attempt) {
    const report = checkFidelity(base, attempt.raster, { mode: "cutout" });
    if (report.verdict === "passed") {
      cutout = attempt.raster;
      cutoutSteps = attempt.steps;
      fidelity.push(toRecorded(report, "cutout", "pending"));
    } else {
      fidelity.push(toRecorded(report, "cutout", null));
      notes.push(describeFailure("The background-removed cutout", report));
    }
  } else if (rt.deps.imageEditor && asset.kind === "owner_photo") {
    // Lighting correction also precedes generative editing: an underexposed photograph is brightened with
    // one hue-preserving gain, checked, and only then handed to the editor. A failed correction is discarded.
    const lighting = correctLighting(base);
    let editInput = base;
    let editInputSteps = baseSteps;
    if (lighting.needed) {
      const lightingStep: TransformationStep = {
        step: "lighting_correction", tool: "garderobe-image", version: lighting.algorithmVersion, generative: false,
        params: { applied: lighting.applied, gain: lighting.gain, highlightBefore: lighting.highlightBefore, fidelity: { verdict: lighting.verdict, failed: lighting.failed, checks: lighting.checks } },
      };
      if (lighting.applied) {
        editInput = lighting.raster;
        editInputSteps = [...baseSteps, lightingStep];
      } else {
        notApplied.push(lightingStep);
        notes.push(`The lighting correction failed its check (${lighting.failed.join(", ").replace(/_/g, " ")}) and was discarded; the photo was used as taken`);
      }
    }
    // The photograph cannot be cut out as it is: ask the dedicated editing model for a catalogue-style view of THIS image.
    const result = await rt.deps.imageEditor.edit({
      image: { bytes: await encodePng(editInput), contentType: "image/png" },
      instruction: "Show this exact garment, unchanged, front-on on a plain white background with soft even lighting. Do not redraw, restyle or invent any part of it.",
      preserve: EDIT_CONSTRAINTS,
      idempotencyKey: `edit:${asset.asset_id}:${original.sha256.slice(0, 16)}`,
    });
    if (result.status === "unknown_outcome") {
      notes.push(`The image-editing request has an unknown outcome${result.providerJobId ? ` (provider job ${result.providerJobId})` : ""}; it was not retried and may have been charged. ${result.reason}`);
    } else if (result.status === "failed") {
      notes.push(`The image-editing model could not produce a catalogue view: ${result.reason}`);
    } else {
      let editedRaster: Raster | null = null;
      try {
        const decoded = (await decodeImage(result.bytes, { maxPixels: limits.maxPixels })).raster;
        const size = fitWithin(decoded.width, decoded.height, limits.workingEdge, limits.workingEdge);
        editedRaster = size.width === decoded.width ? decoded : resizeRaster(decoded, size.width, size.height);
      } catch {
        notes.push("The image-editing model returned something that is not a readable image; it was discarded");
      }
      if (editedRaster) {
        const report = checkFidelity(editInput, editedRaster, { mode: "edit" });
        if (report.verdict === "failed") {
          fidelity.push(toRecorded(report, "edit", null));
          notes.push(describeFailure("The edited rendition", report));
        } else {
          const editStep: TransformationStep = {
            step: "image_model_edit", tool: rt.deps.imageEditor.name, version: result.model, generative: true,
            params: { preserve: [...EDIT_CONSTRAINTS], providerJobId: result.providerJobId, reconstructsUnseenParts: result.reconstructsUnseen, evidenceForFabricOrFit: false },
          };
          const stored = await store("edited", encodeJpeg(editedRaster, 92), "image/jpeg", editedRaster, original.rendition_id, [...editInputSteps, ...notApplied, editStep], true);
          fidelity.push(toRecorded(report, "edit", stored.renditionId));
          base = editedRaster;
          baseRenditionId = stored.renditionId;
          baseSteps = [...editInputSteps, ...notApplied, editStep];
          edited = true;
          attempt = await tryCutout(base);
          if ("raster" in attempt) {
            const cutReport = checkFidelity(base, attempt.raster, { mode: "cutout" });
            if (cutReport.verdict === "passed") {
              cutout = attempt.raster;
              cutoutSteps = attempt.steps;
              fidelity.push(toRecorded(cutReport, "cutout", "pending"));
            } else {
              fidelity.push(toRecorded(cutReport, "cutout", null));
              notes.push(describeFailure("The cutout of the edited rendition", cutReport));
            }
          }
        }
      }
    }
  } else {
    notes.push(`No cutout was made (${attempt.declined}); the photo is shown as taken`);
  }

  if (cutout) {
    const cutRendition = await store("cutout", await encodePng(cutout), "image/png", cutout, baseRenditionId, [...baseSteps, ...cutoutSteps], edited);
    const pending = fidelity.find((f) => f.renditionId === "pending");
    if (pending) pending.renditionId = cutRendition.renditionId;
    const mask: Raster = { width: cutout.width, height: cutout.height, data: new Uint8ClampedArray(cutout.data.length) };
    for (let i = 0; i < cutout.data.length; i += 4) mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = mask.data[i + 3] = cutout.data[i + 3]!;
    await store("mask", await encodePng(mask), "image/png", mask, cutRendition.renditionId, [...baseSteps, ...cutoutSteps, { step: "alpha_mask", tool: "garderobe-image", version: NORMALIZER_VERSION, generative: false, params: {} }], edited);
    const canvas = catalogueView(cutout, { size: limits.catalogueEdge });
    await store("catalogue", encodeJpeg(canvas, 92), "image/jpeg", canvas, cutRendition.renditionId, [
      ...baseSteps, ...cutoutSteps,
      { step: "neutral_canvas", tool: "garderobe-image", version: NORMALIZER_VERSION, generative: false, params: { size: limits.catalogueEdge, margin: 0.1, background: [255, 255, 255], shadow: "restrained" } },
    ], edited);
  } else if (!edited) {
    // No cutout and no accepted edit: the honest photograph is used, as a metadata-free copy.
    await store("display", encodeJpeg(working, 90), "image/jpeg", working, original.rendition_id, [...steps, ...notApplied, reencoded], false);
  }
  // Sources must be recorded before the renditions derived from them.
  const order = ["edited", "display", "cutout", "mask", "catalogue"];
  renditions.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  await done({ outcome: "normalized", renditions, fidelity: fidelity.filter((f) => f.renditionId !== "pending"), note: notes.length > 0 ? notes.join(". ") : null });
}

export { FIDELITY_ALGORITHM_VERSION };
