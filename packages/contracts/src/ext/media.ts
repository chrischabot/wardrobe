/**
 * Visual-wardrobe contracts (owned by the visual-wardrobe workstream): private media, renditions,
 * fidelity checks, image discovery, composition manifests and the Studio.
 *
 * Every exported schema here is picked up by the contract generator (JSON Schema + Swift).
 * Import as `@garderobe/contracts/ext/media`.
 *
 * Honesty rules encoded in these shapes:
 *  - a garment without a real image says so (`GarmentMedia.hasRealImage = false`, `missingImageNote`);
 *  - an asset always declares what it is (`MediaAssetKind`) and whether it is a demo placeholder
 *    (`isDemo`), and edited or illustrated views are never evidence for fabric or fit;
 *  - D1 holds identities and metadata only; image bytes live in private R2 and are reached through
 *    authenticated reads or short-lived, owner-scoped signed URLs (`SignedMediaUrl`).
 */
import { z } from "zod";
import { GarmentId, Instant, LocalDate } from "../primitives.ts";
import { Role } from "../garment.ts";

export const MEDIA_CONTRACT_VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* Assets and renditions                                                */
/* ------------------------------------------------------------------ */

/** What an asset is. An illustration or an edit can never silently become an exact garment asset. */
export const MediaAssetKind = z.enum([
  "exact_product_photo", // verified photograph of the exact product, colourway and variant
  "owner_photo", // photograph taken or supplied by the owner
  "edited_rendition", // derived by an image-editing model; never evidence for fabric or fit
  "generic_illustration", // drawn from a description; always labelled Illustration
  "selfie", // actual-wear photograph; private, retained per the photo-history setting
  "attachment", // conversation attachment
]);
export type MediaAssetKind = z.infer<typeof MediaAssetKind>;

export const MediaRenditionKind = z.enum([
  "original", // immutable bytes as supplied
  "display", // re-encoded, metadata-stripped, size-bounded copy of the original (no background removal)
  "cutout", // background removed, transparent
  "mask", // the cutout's alpha mask
  "catalogue", // cutout on the neutral canvas
  "edited", // produced by an image-editing model; never evidence for fabric or fit
]);
export type MediaRenditionKind = z.infer<typeof MediaRenditionKind>;

export const MediaSourceKind = z.enum([
  "owner_upload",
  "purchase_source",
  "maker_catalogue",
  "retailer",
  "search_result",
  "drive_import",
  "image_model",
  "demo_fixture",
]);
export type MediaSourceKind = z.infer<typeof MediaSourceKind>;

/** Where an image came from and what may be done with it. Finding a public photo grants no publication right. */
export const MediaSource = z.object({
  kind: MediaSourceKind,
  imageUrl: z.string().nullable(),
  pageUrl: z.string().nullable(),
  retrievedAt: Instant.nullable(),
  permittedUse: z.enum(["owner_owned", "private_catalogue_only", "demo_only"]),
  note: z.string().nullable(),
});
export type MediaSource = z.infer<typeof MediaSource>;

/** One step of a rendition's transformation history, oldest first. */
export const TransformationStep = z.object({
  step: z.string().describe("e.g. decode, exif_orientation, downscale, uniform_background_flood_fill, neutral_canvas, image_model_edit"),
  tool: z.string(),
  version: z.string(),
  generative: z.boolean().describe("True when the step can alter garment details (a model edit)."),
  params: z.record(z.string(), z.unknown()),
});
export type TransformationStep = z.infer<typeof TransformationStep>;

export const FidelityCheckName = z.enum(["garment_identity", "dominant_colours", "important_details", "clipping", "halos", "missing_components"]);
export type FidelityCheckName = z.infer<typeof FidelityCheckName>;

export const FidelityCheckResult = z.object({
  name: FidelityCheckName,
  passed: z.boolean(),
  score: z.number(),
  threshold: z.number(),
  detail: z.string(),
});

/** A recorded comparison of a derived image against the original it came from. Failures are kept and shown. */
export const FidelityReport = z.object({
  checkId: z.string(),
  assetId: z.string(),
  subject: z.enum(["cutout", "edit"]),
  renditionId: z.string().nullable().describe("The derived rendition, when one was stored; null when the derivative was rejected and discarded."),
  verdict: z.enum(["passed", "failed"]),
  failed: z.array(FidelityCheckName),
  checks: z.array(FidelityCheckResult),
  algorithmVersion: z.string(),
  checkedAt: Instant,
});
export type FidelityReport = z.infer<typeof FidelityReport>;

export const MediaRendition = z.object({
  renditionId: z.string(),
  assetId: z.string(),
  kind: MediaRenditionKind,
  version: z.number().int().positive(),
  contentType: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  sourceRenditionId: z.string().nullable().describe("The rendition this one was derived from; null for the immutable original."),
  transformations: z.array(TransformationStep),
  edited: z.boolean().describe("True when any generative step contributed: never evidence for fabric or fit."),
  status: z.enum(["active", "superseded", "rejected", "deleted"]),
  createdAt: Instant,
});
export type MediaRendition = z.infer<typeof MediaRendition>;

/** Label shown with an image wherever it appears. */
export const MediaDisplayLabel = z.enum(["Product photo", "Your photo", "Edited", "Illustration", "Demo placeholder", "Selfie", "Attachment"]);
export type MediaDisplayLabel = z.infer<typeof MediaDisplayLabel>;

export const MediaAsset = z.object({
  assetId: z.string(),
  garmentId: GarmentId.nullable(),
  kind: MediaAssetKind,
  displayLabel: MediaDisplayLabel,
  isDemo: z.boolean().describe("True only for labelled demo/test placeholders; never the owner's garment."),
  status: z.enum(["processing", "active", "needs_review", "rejected", "deleted"]),
  statusReason: z.string().nullable(),
  source: MediaSource,
  matchEvidence: z.record(z.string(), z.unknown()).describe("Why this image was accepted as this garment (identifiers matched, owner statement...)."),
  usableAsEvidence: z.boolean().describe("False for edited renditions, illustrations and demo placeholders."),
  hadLocationMetadata: z.boolean().describe("The original carried GPS metadata; derivatives never do."),
  wearingDate: LocalDate.nullable(),
  retainOriginalUntil: Instant.nullable().describe("Selfies: when the full-resolution original is due for deletion under the photo-history setting."),
  renditions: z.array(MediaRendition),
  fidelity: z.array(FidelityReport),
  version: z.number().int().positive(),
  createdAt: Instant,
});
export type MediaAsset = z.infer<typeof MediaAsset>;

export const GarmentImageState = z.enum([
  "not_started", // no investigation yet; recommendations are not blocked
  "searching", // discovery or normalization is in progress
  "resolved", // an approved asset exists
  "needs_review", // a candidate needs one owner decision
  "photos_needed", // bounded research could not establish a match; a photograph is requested
]);
export type GarmentImageState = z.infer<typeof GarmentImageState>;

/** The image an outfit or grid tile should use for a garment, or an honest statement that none exists. */
export const GarmentImageRef = z.object({
  garmentId: GarmentId,
  hasRealImage: z.boolean(),
  assetId: z.string().nullable(),
  assetKind: MediaAssetKind.nullable(),
  displayLabel: MediaDisplayLabel.nullable(),
  isDemo: z.boolean(),
  renditionId: z.string().nullable().describe("Preferred display rendition: cutout, else catalogue, else original."),
  renditionKind: MediaRenditionKind.nullable(),
  renditionVersion: z.number().int().positive().nullable(),
  renditionSha256: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  missingImageNote: z.string().nullable().describe("Set when there is no image: e.g. 'No photo yet'. Never replaced by an invented picture."),
});
export type GarmentImageRef = z.infer<typeof GarmentImageRef>;

export const GarmentMedia = z.object({
  garmentId: GarmentId,
  imageState: GarmentImageState,
  image: GarmentImageRef,
  photoRequest: z.string().nullable().describe("One sentence describing the useful photograph, when Photos needed."),
  lastFailure: z.string().nullable().describe("Most recent processing or fidelity failure, surfaced rather than hidden."),
  assets: z.array(MediaAsset),
  version: z.number().int().nonnegative(),
});
export type GarmentMedia = z.infer<typeof GarmentMedia>;

/** A short-lived, owner-scoped URL for exactly one rendition. Never embed it in a calendar or any public text. */
export const SignedMediaUrl = z.object({
  url: z.string().describe("Path and query relative to the API origin."),
  renditionId: z.string(),
  width: z.number().int().positive().nullable().describe("One of the fixed thumbnail widths, or null for the stored rendition."),
  expiresAt: Instant,
});
export type SignedMediaUrl = z.infer<typeof SignedMediaUrl>;

/** The fixed set of delivery widths (on-demand thumbnails; nothing else is ever generated). */
export const MEDIA_THUMBNAIL_WIDTHS = [160, 320, 640, 1280] as const;
export const MediaThumbnailWidth = z.union([z.literal(160), z.literal(320), z.literal(640), z.literal(1280)]);

/* ------------------------------------------------------------------ */
/* Uploads                                                              */
/* ------------------------------------------------------------------ */

export const UploadIntent = z.enum(["garment_photo", "selfie", "attachment"]);
export type UploadIntent = z.infer<typeof UploadIntent>;

export const UploadContentType = z.enum(["image/jpeg", "image/png", "image/webp", "image/heic"]);

/** Returned by upload authorization: where and how to send the bytes, and until when. */
export const UploadAuthorization = z.object({
  uploadId: z.string(),
  method: z.literal("PUT"),
  url: z.string().describe("Path relative to the API origin; carries a short-lived token bound to this upload and owner."),
  requiredHeaders: z.record(z.string(), z.string()),
  maxBytes: z.number().int().positive(),
  expiresAt: Instant,
});
export type UploadAuthorization = z.infer<typeof UploadAuthorization>;

export const UploadState = z.enum(["authorized", "finalized", "rejected", "expired"]);

export const UploadStatus = z.object({
  uploadId: z.string(),
  intent: UploadIntent,
  garmentId: GarmentId.nullable(),
  state: UploadState,
  rejectionReason: z.string().nullable(),
  assetId: z.string().nullable(),
  expiresAt: Instant,
});
export type UploadStatus = z.infer<typeof UploadStatus>;

/* ------------------------------------------------------------------ */
/* Discovery, Photos needed and review                                  */
/* ------------------------------------------------------------------ */

export const DiscoveryStrategy = z.enum(["purchase_source", "maker_catalogue", "identifier_search"]);
export type DiscoveryStrategy = z.infer<typeof DiscoveryStrategy>;

export const CandidateRejectionReason = z.enum([
  "wrong_colourway",
  "different_generation",
  "materially_different_cut",
  "uncertain_lookalike",
  "insufficient_identity_evidence",
  "image_quality",
  "unsafe_or_unreachable_source",
  "not_an_image",
  "owner_rejected",
]);
export type CandidateRejectionReason = z.infer<typeof CandidateRejectionReason>;

export const PhotosNeededItem = z.object({
  garmentId: GarmentId,
  name: z.string(),
  request: z.string().describe("One sentence describing the useful photograph."),
  since: Instant,
});
export type PhotosNeededItem = z.infer<typeof PhotosNeededItem>;

/** One exception needing an owner decision. The owner sees these grouped in one short review. */
export const MediaReviewItem = z.object({
  candidateId: z.string(),
  garmentId: GarmentId,
  garmentName: z.string(),
  assetId: z.string().nullable(),
  pageUrl: z.string().nullable(),
  question: z.string().describe("The single missing distinction, e.g. 'The page does not state the colourway; is this the rust one?'"),
  evidence: z.record(z.string(), z.unknown()),
  createdAt: Instant,
});
export type MediaReviewItem = z.infer<typeof MediaReviewItem>;

export const MediaReview = z.object({ items: z.array(MediaReviewItem), total: z.number().int().nonnegative() });
export type MediaReview = z.infer<typeof MediaReview>;

/** Backfill progress and an honest completion range under the browser allowance. */
export const BackfillEstimate = z.object({
  totalGarments: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  photosNeeded: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative().describe("Not yet investigated or still searching."),
  browserMinutesPerDay: z.number().nonnegative(),
  interactiveReserveMinutesPerDay: z.number().nonnegative(),
  paidBrowserMinutesBudget: z.number().nonnegative(),
  worstCaseBrowserMinutes: z.number().nonnegative(),
  estimatedDaysMin: z.number().int().nonnegative().nullable().describe("Null when no browser minutes are available for backfill."),
  estimatedDaysMax: z.number().int().nonnegative().nullable(),
  note: z.string(),
});
export type BackfillEstimate = z.infer<typeof BackfillEstimate>;

export const MediaJobStatus = z.object({
  jobId: z.string(),
  kind: z.enum(["normalize", "discover", "render_composite", "purge_objects"]),
  subjectId: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed", "dead"]),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: Instant,
});
export type MediaJobStatus = z.infer<typeof MediaJobStatus>;

/* ------------------------------------------------------------------ */
/* Composition                                                          */
/* ------------------------------------------------------------------ */

export const CompositionTemplateName = z.enum(["separates", "separates_with_jacket", "separates_with_long_coat", "separates_with_knitwear", "one_piece", "one_piece_with_outer"]);
export type CompositionTemplateName = z.infer<typeof CompositionTemplateName>;

/** One garment placed on the canvas. Coordinates are fractions of the canvas (0..1), origin top-left. */
export const CompositionLayer = z.object({
  role: Role,
  garmentId: GarmentId.nullable().describe("Null only for a shopping candidate."),
  shoppingCandidateId: z.string().nullable(),
  name: z.string().describe("Perceptible garment name from the record (for VoiceOver and the text tile)."),
  assetId: z.string().nullable(),
  renditionId: z.string().nullable(),
  renditionVersion: z.number().int().positive().nullable(),
  renditionSha256: z.string().nullable(),
  imageLabel: z.enum(["exact", "owner_photo", "edited", "illustration", "demo_placeholder", "shopping_candidate", "missing"]),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  scale: z.number().describe("Category-based relative size factor applied inside the slot box."),
  z: z.number().int().describe("Layering order; higher draws on top."),
});
export type CompositionLayer = z.infer<typeof CompositionLayer>;

/**
 * A deterministic arrangement of approved assets. SwiftUI renders it interactively; the backend renders
 * the same manifest to SVG and a raster preview. It shows which pieces are combined; it is not a
 * simulation of fit on a body.
 */
export const CompositionManifest = z.object({
  templateVersion: z.string(),
  template: CompositionTemplateName,
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), background: z.string() }),
  layers: z.array(CompositionLayer),
  caption: z.string().describe("Accessible description naming every garment."),
});
export type CompositionManifest = z.infer<typeof CompositionManifest>;

export const Composition = z.object({
  manifestHash: z.string().length(64).describe("SHA-256 of the canonical manifest JSON; identifies the cached preview."),
  manifest: CompositionManifest,
  preview: z.object({
    state: z.enum(["none", "queued", "rendered", "failed"]),
    sha256: z.string().nullable(),
    renderedAt: Instant.nullable(),
    failure: z.string().nullable(),
  }),
  missingImages: z.array(GarmentId).describe("Garments shown as a labelled text tile because no image exists."),
  labels: z.array(z.string()).describe("Labels the presentation must show, e.g. 'Illustration', 'Demo placeholder', 'Shopping candidate'."),
});
export type Composition = z.infer<typeof Composition>;

/* ------------------------------------------------------------------ */
/* Studio                                                               */
/* ------------------------------------------------------------------ */

export const StudioMode = z.enum(["for_today", "explore"]);
export type StudioMode = z.infer<typeof StudioMode>;

/** A product under consideration, shown beside owned garments in Explore. It is never owned stock. */
export const StudioShoppingCandidate = z.object({
  candidateId: z.string().min(1).max(128),
  label: z.string().min(1).max(200),
  sourceUrl: z.string().max(2000).nullable().default(null),
});
export type StudioShoppingCandidate = z.infer<typeof StudioShoppingCandidate>;

/** One slot of a Studio outfit: exactly one of `garmentId` or `shoppingCandidate`. */
export const StudioSlot = z.object({
  role: Role,
  garmentId: GarmentId.nullable().default(null),
  shoppingCandidate: StudioShoppingCandidate.nullable().default(null),
  locked: z.boolean().default(false),
});
export type StudioSlot = z.infer<typeof StudioSlot>;

export const StudioViolation = z.object({
  code: z.string(),
  message: z.string(),
  garmentIds: z.array(GarmentId),
  severity: z.enum(["blocking", "advisory"]),
  ruleKey: z.string().nullable(),
});
export type StudioViolation = z.infer<typeof StudioViolation>;

export const StudioValidation = z.object({
  valid: z.boolean(),
  wearableOn: LocalDate.nullable().describe("The date the outfit was validated for; null when it is exploration only."),
  violations: z.array(StudioViolation),
  validator: z.string().describe("Which validator produced this verdict, e.g. 'daily-service' or 'media-baseline'."),
  wardrobeRevision: z.number().int().nonnegative(),
  checkedAt: Instant,
});
export type StudioValidation = z.infer<typeof StudioValidation>;

export const StudioSelectorItem = z.object({
  garmentId: GarmentId.nullable(),
  shoppingCandidate: StudioShoppingCandidate.nullable(),
  name: z.string(),
  category: z.string(),
  marker: z.enum(["owned", "seasonal_or_stored", "incoming", "shopping_candidate"]),
  eligibleToday: z.boolean(),
  availabilityStatus: z.enum(["available", "estimated", "conditional", "unavailable"]).nullable(),
  reasons: z.array(z.string()),
  image: GarmentImageRef.nullable(),
});
export type StudioSelectorItem = z.infer<typeof StudioSelectorItem>;

export const StudioSelector = z.object({
  role: Role,
  primary: z.boolean().describe("Top, bottom, footwear and outer are always shown; the rest expand on demand."),
  items: z.array(StudioSelectorItem),
});

/** Everything Studio needs to browse locally. Reading it changes nothing. */
export const StudioSelectors = z.object({
  mode: StudioMode,
  forDate: LocalDate,
  selectors: z.array(StudioSelector),
  opening: z.array(StudioSlot).describe("A starting outfit for the canvas (may be empty when nothing is eligible)."),
  wardrobeRevision: z.number().int().nonnegative(),
  readAt: Instant,
});
export type StudioSelectors = z.infer<typeof StudioSelectors>;

export const StudioCombination = z.object({
  combinationId: z.string(),
  name: z.string().nullable(),
  favourite: z.boolean(),
  slots: z.array(StudioSlot),
  containsShoppingCandidate: z.boolean(),
  status: z.enum(["active", "removed"]),
  validation: StudioValidation,
  manifestHash: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type StudioCombination = z.infer<typeof StudioCombination>;

/** An intention for a date. Never a wear, never a reservation. */
export const StudioDayPlan = z.object({
  planId: z.string(),
  localDate: LocalDate,
  combinationId: z.string().nullable(),
  slots: z.array(StudioSlot),
  status: z.enum(["planned", "removed"]),
  needsRevalidation: z.boolean().describe("Availability of a planned garment changed after the plan was made."),
  revalidationReason: z.string().nullable(),
  validation: StudioValidation,
  exposureId: z.string().nullable(),
  version: z.number().int().positive(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type StudioDayPlan = z.infer<typeof StudioDayPlan>;

export const StudioSuggestion = z.object({ slots: z.array(StudioSlot), reason: z.string(), validation: StudioValidation });
export type StudioSuggestion = z.infer<typeof StudioSuggestion>;

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

export const MediaAuthorizeUpload = z.object({
  uploadId: z.string().min(8).max(64).optional().describe("Client-generated stable ID; generated when omitted."),
  intent: UploadIntent,
  garmentId: GarmentId.nullable().default(null).describe("Required for garment_photo."),
  contentType: UploadContentType,
  byteLength: z.number().int().positive(),
  wearingDate: LocalDate.nullable().default(null).describe("Selfies: the day the outfit was worn."),
  demo: z.boolean().default(false).describe("Labelled demo/test placeholder. Accepted only for synthetic fixture garments."),
  origin: z
    .enum(["owner_upload", "drive_import", "image_model"])
    .default("owner_upload")
    .describe("drive_import: authorized bytes copied from the owner's Drive. image_model: a generic illustration drawn from a description (always labelled Illustration)."),
  originRef: z.string().max(2000).nullable().default(null).describe("Provenance reference: Drive file ID, model and prompt version..."),
});

export const MediaFinalizeUpload = z.object({ uploadId: z.string().min(1).max(64) });

export const MediaSetPrimaryAsset = z.object({ garmentId: GarmentId, assetId: z.string().min(1).max(64) });

export const MediaDeleteAsset = z.object({ assetId: z.string().min(1).max(64), reason: z.string().max(300).nullable().default(null) });

export const MediaDecideReview = z.object({ candidateId: z.string().min(1).max(64), decision: z.enum(["adopt", "reject"]) });

export const MediaRequestDiscovery = z.object({
  garmentIds: z.array(GarmentId).max(500).default([]).describe("Empty means every active garment without an approved image."),
  retry: z.boolean().default(false).describe("Allow another bounded attempt for garments already in Photos needed (uses only untried sources)."),
});

export const StudioSaveCombination = z.object({
  combinationId: z.string().min(8).max(64).optional(),
  name: z.string().max(120).nullable().default(null),
  favourite: z.boolean().default(false),
  slots: z.array(StudioSlot).min(1).max(12),
  mode: StudioMode.default("explore"),
  forDate: LocalDate.nullable().default(null).describe("for_today mode: the date to validate against (defaults to the owner's current local date)."),
});

export const StudioRemoveCombination = z.object({ combinationId: z.string().min(1).max(64) });

export const StudioPlanForDay = z.object({
  planId: z.string().min(8).max(64).optional(),
  localDate: LocalDate,
  combinationId: z.string().min(1).max(64).nullable().default(null),
  slots: z.array(StudioSlot).max(12).default([]).describe("Used when no combinationId is given."),
});

export const StudioRemoveDayPlan = z.object({ planId: z.string().min(1).max(64) });

/** Ask for the raster preview of an outfit. Rendering is background work; nothing waits for it. */
export const MediaRequestCompositePreview = z.object({ slots: z.array(StudioSlot).min(1).max(12) });

/** Owner-facing commands of this workstream (sent through `POST /v1/commands` like every other command). */
export const MEDIA_COMMANDS = {
  "media.authorize_upload": MediaAuthorizeUpload,
  "media.finalize_upload": MediaFinalizeUpload,
  "media.set_primary_asset": MediaSetPrimaryAsset,
  "media.delete_asset": MediaDeleteAsset,
  "media.decide_review": MediaDecideReview,
  "media.request_discovery": MediaRequestDiscovery,
  "media.request_composite_preview": MediaRequestCompositePreview,
  "studio.save_combination": StudioSaveCombination,
  "studio.remove_combination": StudioRemoveCombination,
  "studio.plan_for_day": StudioPlanForDay,
  "studio.remove_day_plan": StudioRemoveDayPlan,
} as const;

export type MediaCommandType = keyof typeof MEDIA_COMMANDS;
export type MediaPayload<T extends MediaCommandType> = z.input<(typeof MEDIA_COMMANDS)[T]>;
export const MEDIA_COMMAND_TYPES = Object.keys(MEDIA_COMMANDS) as MediaCommandType[];

/** Settings this workstream reads from `OwnerSettings.extensions.media` (all optional; defaults shown). */
export const MediaSettings = z.object({
  /** Photo history: how long the full-resolution selfie original is kept. 0 = delete the original right after processing; null = keep. */
  selfieOriginalRetentionDays: z.number().int().min(0).max(3650).nullable().default(90),
  /** Browser minutes per day the backfill may use (Free allowance is 10). */
  browserMinutesPerDay: z.number().min(0).max(1440).default(10),
  /** Minutes per day kept back for interactive browsing before any backfill. */
  interactiveReserveMinutesPerDay: z.number().min(0).max(1440).default(5),
  /** Owner-approved paid Browser Run minutes for a faster backfill (bounded; 0 = none). */
  paidBrowserMinutesBudget: z.number().min(0).max(100000).default(0),
});
export type MediaSettings = z.infer<typeof MediaSettings>;
