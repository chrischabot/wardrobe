import {
  authorizeUpload,
  composeOutfit,
  createMediaRuntime,
  dispatchMediaJobs,
  exportMediaData,
  finalizeUpload,
  garmentImageRefs,
  getGarmentMedia,
  getStudioSelectors,
  getUploadStatus,
  handleMediaQueue,
  importMediaData,
  knownCombinationsForGarment,
  listMediaReview,
  listPhotosNeeded,
  listStudioCombinations,
  listStudioDayPlans,
  openAssetImage,
  openRendition,
  ownerPrefix,
  receiveUploadContent,
  registerMedia,
  runMediaMaintenance,
  suggestStudioOutfits,
  validateStudioOutfit,
  type MediaDeps,
} from "@garderobe/media";
import type { MediaPort } from "../ports.ts";
import type { LaneContext } from "./index.ts";

/**
 * The visual wardrobe, mounted. Image bytes live in a private R2 bucket reached only through the
 * binding: uploads and reads go through this Worker, owner-scoped, never through a public URL.
 */
export function createMediaPort(ctx: LaneContext, deps: MediaDeps): MediaPort {
  const rt = createMediaRuntime({ db: ctx.db, service: ctx.service, deps, clock: ctx.now });
  return {
    register: (registry) => registerMedia(registry, deps),
    authorizeUpload: async (principal, input) => {
      const result = await authorizeUpload(rt, principal, {
        intent: input.intent,
        contentType: input.contentType as never,
        byteLength: input.byteLength,
        garmentId: input.garmentId ?? null,
        wearingDate: input.wearingDate ?? null,
        idempotencyKey: `upload:${input.clientUploadId}`,
      });
      return { authorization: result.authorization, replayed: result.replayed };
    },
    receiveUpload: (input) => receiveUploadContent(rt, input),
    finalizeUpload: (principal, uploadId) => finalizeUpload(rt, principal, uploadId),
    uploadStatus: (principal, uploadId) => getUploadStatus(rt, principal, uploadId),
    garmentMedia: (principal, garmentId) => getGarmentMedia(rt, principal, garmentId),
    garmentImage: async (principal, garmentId) => (await garmentImageRefs(rt, principal, [garmentId])).get(garmentId) ?? null,
    openRendition: (principal, renditionId, width) => openRendition(rt, principal, renditionId, { ...(width ? { width } : {}) }),
    openAsset: (principal, assetId, opts) => openAssetImage(rt, principal, assetId, { ...(opts.variant ? { variant: opts.variant } : {}), ...(opts.width ? { width: opts.width } : {}) }),
    readExportAsset: async (principal, r2Key) => {
      // Only objects under this owner's own prefix are ever read into a package.
      if (!r2Key.startsWith(ownerPrefix(principal.userId))) return null;
      const object = await deps.bucket.get(r2Key);
      return object ? object.arrayBuffer() : null;
    },
    photosNeeded: (principal) => listPhotosNeeded(rt, principal),
    review: (principal) => listMediaReview(rt, principal),
    studio: (principal, query) => getStudioSelectors(rt, principal, { mode: query.mode, forDate: query.date ?? null }),
    combinations: (principal) => listStudioCombinations(rt, principal),
    combinationsForGarment: (principal, garmentId) => knownCombinationsForGarment(rt, principal, garmentId),
    dayPlans: (principal) => listStudioDayPlans(rt, principal),
    validate: (principal, input) => validateStudioOutfit(rt, principal, { slots: input.slots, mode: input.mode, forDate: input.date ?? null }),
    suggest: (principal, input) => suggestStudioOutfits(rt, principal, { slots: input.slots, mode: input.mode, forDate: input.date ?? null, ...(input.limit ? { limit: input.limit } : {}) }),
    compose: (principal, slots) => composeOutfit(rt, principal, { slots }),
    afterCommit: async () => {
      await dispatchMediaJobs(rt);
    },
    scheduled: async () => {
      await dispatchMediaJobs(rt);
      return runMediaMaintenance(rt);
    },
    queue: async (batch) => {
      await handleMediaQueue(rt, batch);
    },
    exportData: async (principal) => {
      const data = await exportMediaData(rt, principal);
      return { records: data, assets: data.assets };
    },
    importData: (principal, records, readAsset) => importMediaData(rt, principal, records as never, readAsset),
  };
}
