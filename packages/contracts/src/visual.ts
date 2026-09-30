import { z } from 'zod';
import { GarmentRole, Instant, LocalDate, OpaqueId } from './enums.js';
import { CONTRACTS_VERSION } from './version.js';

/**
 * Visual wardrobe and Studio contracts (spec sections 3 "Studio" and 11).
 *
 * - Media: every image is a record in D1 with its bytes in private R2. A rendition names its source
 *   asset and the transformation that produced it. Images are served only through authenticated
 *   requests or short-lived signed URLs scoped to one owner and one asset.
 * - Asset classes keep an exact product photograph, an owner photograph, an edited rendition, a
 *   generic illustration, a demo placeholder and an imagined rendering apart. An imagined rendering
 *   never substitutes for a catalogue asset.
 * - Composition: a deterministic, versioned layout of verified garment assets on a white canvas.
 *   The manifest's content hash identifies the cached composite.
 * - Studio: browsing and validation never mutate; Save combination, Plan for a day and Wear this are
 *   three distinct commands (save_combination, plan_outfit, record_wear).
 */

// ------------------------------------------------------------------ media assets

/** Rendition kind (D1 media_assets.kind). */
export const RenditionKind = z.enum(['source', 'cutout', 'catalogue', 'mask', 'thumbnail', 'composite']);
export type RenditionKind = z.infer<typeof RenditionKind>;

/** What an image is evidence of. */
export const AssetClass = z.enum([
  /** The maker's or a retailer's photograph of this exact product, colourway and generation. */
  'exact_product_photo',
  /** A photograph the owner took of the garment itself. */
  'owner_photo',
  /** A generatively edited view derived from a real photo; passed the fidelity check; not evidence for fabric or fit. */
  'edited_rendition',
  /** A generic drawing from a description. Labelled "Illustration" wherever shown. */
  'illustration',
  /** Generated placeholder for local demos and tests. Labelled "Demo placeholder". */
  'demo_placeholder',
  /** An imagined rendering of a look. Never a catalogue asset, never in a composite. */
  'imagined_rendering',
  /** A deterministic composition of other assets. */
  'composite',
]);
export type AssetClass = z.infer<typeof AssetClass>;

export const AssetStatus = z.enum(['pending', 'final', 'rejected']);
export type AssetStatus = z.infer<typeof AssetStatus>;

export const Transformation = z.object({
  /** e.g. upload_finalized, background_removal, mask, normalize_canvas, generative_edit, resize, compose, placeholder_generation */
  op: z.string(),
  provider: z.string().nullable(),
  at: Instant,
  params: z.record(z.string(), z.unknown()),
});
export type Transformation = z.infer<typeof Transformation>;

export const FidelityCheck = z.object({
  name: z.enum(['garment_identity', 'dominant_colours', 'pattern', 'details', 'silhouette', 'clipping', 'halo', 'components']),
  passed: z.boolean(),
  detail: z.string(),
});
export type FidelityCheck = z.infer<typeof FidelityCheck>;

export const FidelityReport = z.object({
  passed: z.boolean(),
  checks: z.array(FidelityCheck),
  /** Largest colour difference found (CIE76 ΔE) between matched dominant colours. */
  maxColourDeltaE: z.number().nullable(),
});
export type FidelityReport = z.infer<typeof FidelityReport>;

export const AssetProvenance = z.object({
  sourceUrl: z.string().nullable(),
  sourcePageUrl: z.string().nullable(),
  retrievedAt: Instant.nullable(),
  /** Permitted-use note; the catalogue is private and finding a photo does not grant publication rights. */
  permittedUse: z.string().nullable(),
  /** Evidence for the product match (identifiers, colourway, page text anchors). */
  evidence: z.record(z.string(), z.unknown()),
});

export const MediaAsset = z.object({
  assetId: OpaqueId,
  kind: RenditionKind,
  assetClass: AssetClass,
  status: AssetStatus,
  contentType: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  byteLength: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  /** The asset this rendition was derived from (null for an original). */
  sourceAssetId: OpaqueId.nullable(),
  /** Full derivation chain, oldest first. */
  transformations: z.array(Transformation),
  provenance: AssetProvenance,
  fidelity: FidelityReport.nullable(),
  /** Human label shown with the image when it is not an exact photograph ("Illustration", "Edited", "Demo placeholder"). */
  label: z.string().nullable(),
  garmentIds: z.array(OpaqueId),
  createdAt: Instant,
});
export type MediaAsset = z.infer<typeof MediaAsset>;

/** Display media for one garment (Today, Wardrobe, Studio). URLs are short-lived and owner-scoped. */
export const GarmentMedia = z.object({
  thumbnailUrl: z.string().nullable(),
  catalogueImageUrl: z.string().nullable(),
  /** width / height of the catalogue image, so the app reserves space before download. */
  aspectRatio: z.number().positive().nullable(),
  photos: z.array(z.object({ url: z.string(), caption: z.string().nullable() })),
  /** True when the catalogue asset is a verified photograph (or faithful rendition) of this exact garment. */
  verified: z.boolean(),
  catalogueAssetId: OpaqueId.nullable().optional(),
  assetClass: AssetClass.nullable().optional(),
  /** "Illustration", "Edited", "Demo placeholder", or null for an exact photograph. */
  label: z.string().nullable().optional(),
  /** The garment is in Photos needed (the bounded search could not resolve it). */
  photosNeeded: z.boolean().optional(),
  urlsExpireAt: Instant.nullable().optional(),
});
export type GarmentMedia = z.infer<typeof GarmentMedia>;

/** One entry of the Photos needed collection: only items research could not resolve. */
export const PhotosNeededItem = z.object({
  garmentId: OpaqueId,
  name: z.string(),
  /** One sentence describing the useful photograph. */
  request: z.string(),
  lastSearchedAt: Instant.nullable(),
  strategiesTried: z.number().int().nonnegative(),
});
export const PhotosNeeded = z.object({ schemaVersion: z.literal(CONTRACTS_VERSION), items: z.array(PhotosNeededItem) });
export type PhotosNeeded = z.infer<typeof PhotosNeeded>;

// ------------------------------------------------------------------ uploads

export const UploadPurpose = z.enum(['garment_photo', 'identify', 'what_i_wore', 'product', 'receipt']);
export const UploadContentType = z.enum(['image/jpeg', 'image/heic', 'image/png']);
export const MAX_UPLOAD_BYTES = 25_000_000;

/** POST /v1/uploads */
export const UploadRequest = z.strictObject({
  purpose: UploadPurpose,
  contentType: UploadContentType,
  byteLength: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  /** For garment_photo: the garment the owner is photographing. */
  garmentId: OpaqueId.optional(),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

export const UploadAuthorization = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  uploadId: OpaqueId,
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: Instant,
});
export type UploadAuthorization = z.infer<typeof UploadAuthorization>;

/** POST /v1/uploads/{id}/complete: the explicit finalization step before an image becomes evidence. */
export const UploadCompleteResponse = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  uploadId: OpaqueId,
  status: z.enum(['finalized', 'rejected']),
  reason: z.string().nullable(),
  assetId: OpaqueId.nullable().optional(),
});
export type UploadCompleteResponse = z.infer<typeof UploadCompleteResponse>;

// ------------------------------------------------------------------ composition

export const LAYOUT_VERSION = 'outfit-layout/1';

export const CompositionTemplate = z.enum(['separates', 'separates_layered', 'separates_long_coat', 'one_piece']);
export type CompositionTemplate = z.infer<typeof CompositionTemplate>;

export const CompositionItem = z.object({
  garmentId: OpaqueId,
  role: GarmentRole,
  name: z.string(),
  /** Null when the garment has no usable asset yet: the layout keeps its place with a labelled outline. */
  assetId: OpaqueId.nullable(),
  renditionKind: RenditionKind.nullable(),
  /** Content hash of the referenced rendition (the "rendition version"). */
  renditionSha256: z.string().nullable(),
  assetClass: AssetClass.nullable(),
  label: z.string().nullable(),
  placeholder: z.boolean(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  z: z.number().int(),
  /** Footwear alternatives share a group and sit side by side. */
  alternativeGroup: z.string().nullable(),
});
export type CompositionItem = z.infer<typeof CompositionItem>;

export const CompositionManifest = z.object({
  layoutVersion: z.literal(LAYOUT_VERSION),
  template: CompositionTemplate,
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), background: z.literal('#FFFFFF') }),
  items: z.array(CompositionItem),
  /** Labels the visual outfit must show ("Illustration", "Demo placeholder", "No photo yet"). */
  labels: z.array(z.string()),
  /** Always false: a composition arranges real assets; imagined renderings are separate. */
  imagined: z.literal(false),
});
export type CompositionManifest = z.infer<typeof CompositionManifest>;

export const OutfitComposite = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  manifest: CompositionManifest,
  /** SHA-256 of the canonical manifest JSON: the cache identity of the composite. */
  manifestHash: z.string(),
  /** Rendered SVG preview asset (null until the background render has run). */
  previewAssetId: OpaqueId.nullable(),
  previewUrl: z.string().nullable(),
  /** Signed URL per asset for client-side (SwiftUI) rendering of the manifest. */
  assetUrls: z.record(z.string(), z.string()),
  urlsExpireAt: Instant.nullable(),
});
export type OutfitComposite = z.infer<typeof OutfitComposite>;

// ------------------------------------------------------------------ Studio

export const StudioMode = z.enum(['today', 'explore']);
export type StudioMode = z.infer<typeof StudioMode>;

export const StudioSlot = z.strictObject({
  garmentId: OpaqueId,
  role: GarmentRole,
  /** Footwear alternatives share one group. */
  alternativeGroup: z.string().min(1).max(40).nullable().optional(),
});
export type StudioSlot = z.infer<typeof StudioSlot>;

const Slots = z.array(StudioSlot).min(1).max(12);

/** POST /v1/studio/choices: what a selector offers for one role. Browsing mutates nothing. */
export const StudioChoicesRequest = z.strictObject({ mode: StudioMode, date: LocalDate, role: GarmentRole });
export type StudioChoicesRequest = z.infer<typeof StudioChoicesRequest>;

export const StudioBadge = z.enum(['in_storage', 'incoming', 'occasional', 'not_clean', 'restricted', 'away', 'not_for_today_weather', 'recently_worn', 'shopping_candidate']);
export type StudioBadge = z.infer<typeof StudioBadge>;

export const StudioChoice = z.object({
  garmentId: OpaqueId,
  name: z.string(),
  role: GarmentRole,
  category: z.string(),
  badges: z.array(StudioBadge),
  /** True when the piece may appear in a For today combination. */
  eligibleToday: z.boolean(),
  catalogueAssetId: OpaqueId.nullable(),
  assetClass: AssetClass.nullable(),
  label: z.string().nullable(),
});
export type StudioChoice = z.infer<typeof StudioChoice>;

export const StudioChoices = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  mode: StudioMode,
  date: LocalDate,
  role: GarmentRole,
  items: z.array(StudioChoice),
});
export type StudioChoices = z.infer<typeof StudioChoices>;

/** POST /v1/studio/validate */
export const StudioValidateRequest = z.strictObject({ mode: StudioMode, date: LocalDate, slots: Slots });
export type StudioValidateRequest = z.infer<typeof StudioValidateRequest>;

export const StudioIssue = z.object({
  code: z.string(),
  message: z.string(),
  garmentId: OpaqueId.nullable(),
  strength: z.enum(['hard', 'soft']).optional(),
  /** Explore mode: a day-bound issue (weather, cleanliness, repeats) that does not block exploring. */
  dayBound: z.boolean().optional(),
});
export type StudioIssue = z.infer<typeof StudioIssue>;

export const StudioValidation = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  mode: StudioMode.optional(),
  /** today: passes the daily-service validator for the date. explore: passes every rule that is not day-bound. */
  valid: z.boolean(),
  /** Passes the full daily-service validation for the date (what Plan for a day requires). */
  validForDate: z.boolean().optional(),
  issues: z.array(StudioIssue),
  warnings: z.array(StudioIssue).optional(),
  checkedAt: Instant,
});
export type StudioValidation = z.infer<typeof StudioValidation>;

/** POST /v1/studio/suggest: "Find something that works with this". Only the listed unlocked roles change. */
export const StudioSuggestRequest = z.strictObject({
  mode: StudioMode,
  date: LocalDate,
  locked: z.array(StudioSlot).max(12),
  /** Unlocked roles the backend may fill. Required roles (top, trousers, socks, footwear) are filled when missing. */
  roles: z.array(GarmentRole).min(1).max(11),
});
export type StudioSuggestRequest = z.infer<typeof StudioSuggestRequest>;

export const StudioSuggestion = z.object({
  schemaVersion: z.literal(CONTRACTS_VERSION),
  /** Null when nothing valid works with the locked pieces; the locked pieces are never changed to make one. */
  slots: z.array(StudioSlot),
  explanation: z.string(),
  validation: StudioValidation,
  found: z.boolean().optional(),
  changedRoles: z.array(GarmentRole).optional(),
  manifest: CompositionManifest.nullable().optional(),
});
export type StudioSuggestion = z.infer<typeof StudioSuggestion>;

export const SavedCombination = z.object({
  combinationId: OpaqueId,
  kind: z.enum(['saved', 'plan']),
  name: z.string().nullable(),
  slots: z.array(StudioSlot),
  mode: StudioMode,
  plannedForDate: LocalDate.nullable(),
  status: z.enum(['active', 'removed', 'superseded']),
  createdAt: Instant,
  version: z.number().int().positive(),
});
export type SavedCombination = z.infer<typeof SavedCombination>;

// ------------------------------------------------------------------ Studio commands

/** Save combination: stores the combination. It is not a plan and not a wear. */
export const SaveCombinationCommand = z.strictObject({
  type: z.literal('save_combination'),
  name: z.string().min(1).max(120).optional(),
  slots: Slots,
  mode: StudioMode.optional(),
  favorite: z.boolean().optional(),
});

/** Plan for a day: one active plan per date (a new plan supersedes the old). It is an intention, not a wear. */
export const PlanOutfitCommand = z.strictObject({
  type: z.literal('plan_outfit'),
  date: LocalDate,
  slots: Slots,
  name: z.string().min(1).max(120).optional(),
});

/** Remove a saved combination or plan (kept as history with status removed). */
export const RemoveCombinationCommand = z.strictObject({
  type: z.literal('remove_combination'),
  combinationId: OpaqueId,
});
