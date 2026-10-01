/**
 * @garderobe/media - the visual wardrobe: private R2 media, upload and finalization, queue-driven
 * normalization and discovery with fidelity checks, Photos needed, deterministic outfit composites and
 * the Studio backend.
 *
 * Composition (apps/worker):
 *
 *   const deps = depsFromBindings(env, { validator: outfitValidator });   // from @garderobe/daily
 *   registerMedia(registry, deps);
 *   const rt = createMediaRuntime({ db: env.DB, service, deps });
 *   // queue(batch, env)  -> handleMediaQueue(rt, batch)
 *   // after a command    -> ctx.waitUntil(dispatchMediaJobs(rt))
 *   // scheduled sweep    -> runMediaMaintenance(rt)
 */
import type { CommandRegistry } from "@garderobe/domain";
import { assetCommands } from "./commands/assets.ts";
import { compositeCommands } from "./commands/composites.ts";
import { discoveryCommands } from "./commands/discovery.ts";
import { registerStudioHooks, studioCommands } from "./commands/studio.ts";
import { uploadCommands } from "./commands/uploads.ts";
import { portabilityCommands } from "./portability.ts";
import type { MediaDepsSource } from "./runtime.ts";

/** Command types that record pipeline results. They require the system actor and are not offered to clients. */
export const MEDIA_SYSTEM_COMMAND_TYPES = ["media.record_normalization", "media.record_discovery", "media.record_composite", "media.fail_job", "media.complete_job", "media.apply_retention", "media.expire_uploads"] as const;

/** Register every media and Studio command, the Studio commit hook and the version resolvers. */
export function registerMedia(registry: CommandRegistry, deps: MediaDepsSource): void {
  for (const def of [...uploadCommands(deps), ...assetCommands(deps), ...discoveryCommands(deps), ...compositeCommands(deps), ...studioCommands(deps), ...portabilityCommands()]) registry.register(def);
  registerStudioHooks(registry);
  registry.registerVersionResolver("media_asset", (userId, id) => ({ sql: "SELECT version FROM media_assets WHERE user_id = ? AND asset_id = ?", params: [userId, id] }));
  registry.registerVersionResolver("garment_media", (userId, id) => ({ sql: "SELECT version FROM garment_media WHERE user_id = ? AND garment_id = ?", params: [userId, id] }));
}

export { createMediaRuntime, depsFromBindings, DEFAULT_MEDIA_LIMITS, type MediaBindings, type MediaDeps, type MediaDepsSource, type MediaLimits, type MediaQueueMessage, type MediaRuntime } from "./runtime.ts";
export type { BackgroundRemover, DiscoveryCandidatePage, DiscoveryGarment, DiscoveryProvider, DiscoveryProviderResult, DiscoveryQuery, ImageEditProvider, ImageEditRequest, ImageEditResult, ImageFetcher, ImageTranscoder, OutfitValidator, RasterPreviewExporter, ValidatorResult, ValidatorSlot, ValidatorViolation } from "./adapters.ts";
export { EDIT_CONSTRAINTS } from "./adapters.ts";
export { authorizeUpload, finalizeUpload, getUploadStatus, importImageBytes, mintUploadAuthorization, receiveUploadContent } from "./uploads.ts";
export { garmentImageRefs, getAsset, getBackfillEstimate, getGarmentMedia, listMediaReview, listPhotosNeeded } from "./reads.ts";
export { openAssetImage, openRendition, purgeOwnerMediaCache, serveSignedMedia, signRenditionUrl, type OpenedImage } from "./delivery.ts";
export { dispatchMediaJobs, handleMediaQueue, listMediaJobs, runMediaJob, runQueuedMediaJobs } from "./jobs.ts";
export { runMediaMaintenance, type MaintenanceResult } from "./maintenance.ts";
export { composeOutfit, getComposition, getStudioSelectors, knownCombinationsForGarment, listStudioCombinations, listStudioDayPlans, openCompositePreview, requestCompositePreview, suggestStudioOutfits, validateStudioOutfit } from "./studio/reads.ts";
export { buildManifest, manifestHash, manifestLabels, TEMPLATE_VERSION, type ComposeSlot } from "./compose/manifest.ts";
export { renderSvg } from "./compose/svg.ts";
export { renderRaster } from "./compose/raster.ts";
export { baselineValidator, BASELINE_VALIDATOR_NAME } from "./validator.ts";
export { createCloudflareImagesTranscoder, createCloudflareImagesBackgroundRemover } from "./cloudflare-images.ts";
export { createPurchaseLinkProvider, extractProductPage } from "./pipeline/purchase-link.ts";
export { createSafeImageFetcher, refuseUrl, safeFetch } from "./pipeline/safe-fetch.ts";
export { evaluateCandidate } from "./pipeline/evaluate.ts";
export { exportMediaData, importMediaData, type MediaExport } from "./portability.ts";
export { ownerPrefix } from "./keys.ts";
