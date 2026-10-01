import {
  authorizeUpload,
  composeOutfit,
  createMediaRuntime,
  dispatchMediaJobs,
  exportMediaData,
  finalizeUpload,
  garmentImageRefs,
  getGarmentMedia,
  getComposition,
  openCompositePreview,
  requestCompositePreview,
  getStudioSelectors,
  getUploadStatus,
  handleMediaQueue,
  importMediaData,
  listMediaDeletions,
  MEDIA_RESPONSE_HEADERS,
  readExportFile,
  replayMediaDeletions,
  serveSignedMedia,
  signRenditionUrl,
  knownCombinationsForGarment,
  listMediaReview,
  listPhotosNeeded,
  listStudioCombinations,
  listStudioDayPlans,
  openAssetImage,
  openRendition,
  ownerPrefix,
  purgeOwnerMediaCache,
  receiveUploadContent,
  registerMedia,
  runMediaMaintenance,
  suggestStudioOutfits,
  validateStudioOutfit,
  type MediaDeps,
} from "@garderobe/media";
import { CommandError } from "@garderobe/domain";
import type { MediaPort } from "../ports.ts";
import type { LaneContext } from "./index.ts";

/** The headers every image response carries (the visual wardrobe's own set): an image is only ever an image. */
export const IMAGE_RESPONSE_HEADERS: Readonly<Record<string, string>> = MEDIA_RESPONSE_HEADERS;

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
    signRendition: (principal, renditionId, opts) => signRenditionUrl(rt, principal, renditionId, { ...(opts.width ? { width: opts.width } : {}), ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}), audience: "app" }),
    serveSigned: (token, request) => serveSignedMedia(rt, token, request),
    listDeletions: async (principal) => (await listMediaDeletions(rt, principal)) as unknown as Record<string, unknown>,
    replayDeletions: (principal, journal) => replayMediaDeletions(rt, principal, journal as never),
    // Only the caller's own files are ever read into a package; the visual wardrobe resolves the path.
    readExportAsset: (principal, file) => readExportFile(rt, principal, file),
    photosNeeded: (principal) => listPhotosNeeded(rt, principal),
    review: (principal) => listMediaReview(rt, principal),
    studio: (principal, query) => getStudioSelectors(rt, principal, { mode: query.mode, forDate: query.date ?? null }),
    combinations: (principal) => listStudioCombinations(rt, principal),
    combinationsForGarment: (principal, garmentId) => knownCombinationsForGarment(rt, principal, garmentId),
    dayPlans: (principal) => listStudioDayPlans(rt, principal),
    validate: (principal, input) => validateStudioOutfit(rt, principal, { slots: input.slots, mode: input.mode, forDate: input.date ?? null }),
    suggest: (principal, input) => suggestStudioOutfits(rt, principal, { slots: input.slots, mode: input.mode, forDate: input.date ?? null, ...(input.limit ? { limit: input.limit } : {}) }),
    compose: (principal, slots) => composeOutfit(rt, principal, { slots }),
    requestPreview: (principal, slots, clientRequestId) => requestCompositePreview(rt, principal, { slots: slots as never, idempotencyKey: `composite-preview:${clientRequestId}` }),
    composition: (principal, manifestHash) => getComposition(rt, principal, manifestHash),
    openPreview: (principal, manifestHash) => openCompositePreview(rt, principal, manifestHash, "png"),
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
    importData: async (principal, records, readAsset, deletions) => {
      // Restoring images writes to private storage: it needs the owner's admin authority before any byte is read or stored.
      if (!principal.scopes.includes("admin")) throw new CommandError("forbidden", "importing images needs the owner's admin authority", { reason: "admin_scope_required" });
      return importMediaData(rt, principal, records as never, readAsset, { deletions: (deletions ?? null) as never });
    },
    eraseOwner: async (userId) => {
      // The cache keys are derived from the owner's rendition records, so this runs before any row is deleted.
      const cache = await purgeOwnerMediaCache(rt, userId);
      let objects = 0;
      let cursor: string | undefined;
      do {
        const page = await deps.bucket.list({ prefix: ownerPrefix(userId), ...(cursor ? { cursor } : {}), limit: 500 });
        const keys = page.objects.map((o) => o.key);
        if (keys.length > 0) await deps.bucket.delete(keys);
        objects += keys.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return { objects, cachedThumbnails: cache.purged };
    },
  };
}
