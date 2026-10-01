/** Row types, mappers to the contract shapes, and small statement builders shared by the media commands. */
import { all, allIn, first, json, stmt, type CommandContext, type Db, type PlannedOutbox, type Stmt } from "@garderobe/domain";
import { MediaSettings } from "@garderobe/contracts/ext/media";
import type { FidelityReport, GarmentImageRef, GarmentImageState, MediaAsset, MediaAssetKind, MediaDisplayLabel, MediaRendition, MediaRenditionKind, MediaSource, TransformationStep } from "@garderobe/contracts/ext/media";
import type { OwnerSettings } from "@garderobe/contracts";

export const NO_PHOTO_NOTE = "No photo yet";

export interface AssetRow {
  user_id: string;
  asset_id: string;
  garment_id: string | null;
  kind: MediaAssetKind;
  is_demo: number;
  status: MediaAsset["status"];
  status_reason: string | null;
  source_json: string;
  match_evidence_json: string;
  derived_from_asset_id: string | null;
  had_location_metadata: number;
  wearing_date: string | null;
  retain_original_until: string | null;
  original_purged_at: string | null;
  upload_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RenditionRow {
  user_id: string;
  rendition_id: string;
  asset_id: string;
  kind: MediaRenditionKind;
  version: number;
  object_key: string;
  content_type: string;
  width: number | null;
  height: number | null;
  byte_length: number;
  sha256: string;
  source_rendition_id: string | null;
  transformations_json: string;
  edited: number;
  status: MediaRendition["status"];
  created_at: string;
}

export interface FidelityRow {
  check_id: string;
  asset_id: string;
  subject: "cutout" | "edit";
  rendition_id: string | null;
  verdict: "passed" | "failed";
  failed_json: string;
  checks_json: string;
  algorithm_version: string;
  created_at: string;
}

export interface GarmentMediaRow {
  garment_id: string;
  image_state: GarmentImageState;
  primary_asset_id: string | null;
  photo_request: string | null;
  photos_needed_at: string | null;
  last_failure: string | null;
  discovery_json: string;
  version: number;
  updated_at: string;
}

export function mediaSettings(settings: OwnerSettings): MediaSettings {
  const parsed = MediaSettings.safeParse((settings.extensions as Record<string, unknown>)?.media ?? {});
  return parsed.success ? parsed.data : MediaSettings.parse({});
}

export function displayLabelFor(kind: MediaAssetKind, isDemo: boolean, edited: boolean): MediaDisplayLabel {
  if (isDemo) return "Demo placeholder";
  if (kind === "generic_illustration") return "Illustration";
  if (kind === "edited_rendition" || edited) return "Edited";
  if (kind === "exact_product_photo") return "Product photo";
  if (kind === "owner_photo") return "Your photo";
  if (kind === "selfie") return "Selfie";
  return "Attachment";
}

/** Only a non-demo photograph of the actual garment counts as a real image. */
export function isRealGarmentImage(kind: MediaAssetKind, isDemo: boolean): boolean {
  return !isDemo && (kind === "exact_product_photo" || kind === "owner_photo" || kind === "edited_rendition");
}

export function toRendition(r: RenditionRow): MediaRendition {
  return {
    renditionId: r.rendition_id,
    assetId: r.asset_id,
    kind: r.kind,
    version: r.version,
    contentType: r.content_type,
    width: r.width,
    height: r.height,
    byteLength: r.byte_length,
    sha256: r.sha256,
    sourceRenditionId: r.source_rendition_id,
    transformations: json<TransformationStep[]>(r.transformations_json, []),
    edited: r.edited === 1,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function toFidelity(r: FidelityRow): FidelityReport {
  return {
    checkId: r.check_id,
    assetId: r.asset_id,
    subject: r.subject,
    renditionId: r.rendition_id,
    verdict: r.verdict,
    failed: json(r.failed_json, []),
    checks: json(r.checks_json, []),
    algorithmVersion: r.algorithm_version,
    checkedAt: r.created_at,
  };
}

export function toAsset(a: AssetRow, renditions: RenditionRow[], fidelity: FidelityRow[]): MediaAsset {
  const active = renditions.filter((r) => r.status === "active");
  const anyEdited = active.some((r) => r.edited === 1 && r.kind !== "original");
  const isDemo = a.is_demo === 1;
  return {
    assetId: a.asset_id,
    garmentId: a.garment_id,
    kind: a.kind,
    displayLabel: displayLabelFor(a.kind, isDemo, false),
    isDemo,
    status: a.status,
    statusReason: a.status_reason,
    source: json<MediaSource>(a.source_json, { kind: "owner_upload", imageUrl: null, pageUrl: null, retrievedAt: null, permittedUse: "owner_owned", note: null }),
    matchEvidence: json(a.match_evidence_json, {}),
    // A photograph is evidence only for what it shows; edits, illustrations and placeholders never are.
    usableAsEvidence: !isDemo && (a.kind === "exact_product_photo" || a.kind === "owner_photo" || a.kind === "selfie") && !(anyEdited && active.every((r) => r.kind === "original" || r.edited === 1) && active.length === 1),
    hadLocationMetadata: a.had_location_metadata === 1,
    wearingDate: a.wearing_date,
    retainOriginalUntil: a.retain_original_until,
    renditions: renditions.map(toRendition),
    fidelity: fidelity.map(toFidelity),
    version: a.version,
    createdAt: a.created_at,
  };
}

/** Display preference for garment imagery: transparent cutout, else catalogue view, else an accepted edit, else the display copy, else the original. */
const DISPLAY_ORDER: MediaRenditionKind[] = ["cutout", "catalogue", "edited", "display", "original"];

export function pickDisplayRendition(renditions: RenditionRow[], order: MediaRenditionKind[] = DISPLAY_ORDER): RenditionRow | null {
  for (const kind of order) {
    const found = renditions.filter((r) => r.kind === kind && r.status === "active").sort((a, b) => b.version - a.version)[0];
    if (found) return found;
  }
  return null;
}

export function missingImageRef(garmentId: string): GarmentImageRef {
  return {
    garmentId,
    hasRealImage: false,
    assetId: null,
    assetKind: null,
    displayLabel: null,
    isDemo: false,
    renditionId: null,
    renditionKind: null,
    renditionVersion: null,
    renditionSha256: null,
    width: null,
    height: null,
    missingImageNote: NO_PHOTO_NOTE,
  };
}

export function imageRefFor(garmentId: string, asset: AssetRow | null, renditions: RenditionRow[]): GarmentImageRef {
  if (!asset || asset.status !== "active") return missingImageRef(garmentId);
  const r = pickDisplayRendition(renditions);
  if (!r) return missingImageRef(garmentId);
  const isDemo = asset.is_demo === 1;
  return {
    garmentId,
    hasRealImage: isRealGarmentImage(asset.kind, isDemo),
    assetId: asset.asset_id,
    assetKind: asset.kind,
    displayLabel: displayLabelFor(asset.kind, isDemo, r.edited === 1),
    isDemo,
    renditionId: r.rendition_id,
    renditionKind: r.kind,
    renditionVersion: r.version,
    renditionSha256: r.sha256,
    width: r.width,
    height: r.height,
    missingImageNote: null,
  };
}

/** Image references for many garments in a bounded number of queries. */
export async function loadImageRefs(db: Db, userId: string, garmentIds: string[]): Promise<Map<string, GarmentImageRef>> {
  const out = new Map<string, GarmentImageRef>();
  const unique = [...new Set(garmentIds)];
  for (const id of unique) out.set(id, missingImageRef(id));
  if (unique.length === 0) return out;
  const gm = await allIn<{ garment_id: string; primary_asset_id: string | null }>(db, "SELECT garment_id, primary_asset_id FROM garment_media WHERE user_id = ? AND primary_asset_id IS NOT NULL AND garment_id IN (:ids)", [userId], unique);
  const assetIds = gm.map((g) => g.primary_asset_id!).filter(Boolean);
  if (assetIds.length === 0) return out;
  const assets = await allIn<AssetRow>(db, "SELECT * FROM media_assets WHERE user_id = ? AND asset_id IN (:ids)", [userId], assetIds);
  const renditions = await allIn<RenditionRow>(db, "SELECT * FROM media_renditions WHERE user_id = ? AND status = 'active' AND asset_id IN (:ids)", [userId], assetIds);
  const assetById = new Map(assets.map((a) => [a.asset_id, a]));
  for (const g of gm) {
    const asset = assetById.get(g.primary_asset_id!) ?? null;
    out.set(g.garment_id, imageRefFor(g.garment_id, asset, renditions.filter((r) => r.asset_id === g.primary_asset_id)));
  }
  return out;
}

export async function loadAsset(db: Db, userId: string, assetId: string): Promise<AssetRow | null> {
  return first<AssetRow>(db, "SELECT * FROM media_assets WHERE user_id = ? AND asset_id = ?", userId, assetId);
}

export async function loadRenditions(db: Db, userId: string, assetId: string): Promise<RenditionRow[]> {
  return all<RenditionRow>(db, "SELECT * FROM media_renditions WHERE user_id = ? AND asset_id = ? ORDER BY created_at, rendition_id", userId, assetId);
}

export async function loadGarmentMediaRow(db: Db, userId: string, garmentId: string): Promise<GarmentMediaRow | null> {
  return first<GarmentMediaRow>(db, "SELECT garment_id, image_state, primary_asset_id, photo_request, photos_needed_at, last_failure, discovery_json, version, updated_at FROM garment_media WHERE user_id = ? AND garment_id = ?", userId, garmentId);
}

/* ------------------------------ statement builders ------------------------------ */

export interface GarmentMediaPatch {
  imageState: GarmentImageState;
  primaryAssetId: string | null;
  photoRequest: string | null;
  lastFailure: string | null;
  discovery?: Record<string, unknown>;
}

/** Upsert the per-garment image state (one row per garment), bumping its version. */
export function upsertGarmentMedia(ctx: Pick<CommandContext, "userId" | "now">, garmentId: string, current: GarmentMediaRow | null, patch: GarmentMediaPatch): Stmt {
  const discovery = JSON.stringify(patch.discovery ?? json(current?.discovery_json, {}));
  const photosNeededAt = patch.imageState === "photos_needed" ? (current?.image_state === "photos_needed" && current.photos_needed_at ? current.photos_needed_at : ctx.now) : null;
  return stmt(
    `INSERT INTO garment_media (user_id, garment_id, image_state, primary_asset_id, photo_request, photos_needed_at, last_failure, discovery_json, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (user_id, garment_id) DO UPDATE SET image_state = excluded.image_state, primary_asset_id = excluded.primary_asset_id, photo_request = excluded.photo_request,
       photos_needed_at = excluded.photos_needed_at, last_failure = excluded.last_failure, discovery_json = excluded.discovery_json, version = garment_media.version + 1, updated_at = excluded.updated_at`,
    ctx.userId, garmentId, patch.imageState, patch.primaryAssetId, patch.photoRequest, photosNeededAt, patch.lastFailure, discovery, ctx.now,
  );
}

export interface NewRendition {
  renditionId: string;
  assetId: string;
  kind: MediaRenditionKind;
  version: number;
  objectKey: string;
  contentType: string;
  width: number | null;
  height: number | null;
  byteLength: number;
  sha256: string;
  sourceRenditionId: string | null;
  transformations: TransformationStep[];
  edited: boolean;
}

export function insertRendition(ctx: Pick<CommandContext, "userId" | "now" | "commandId">, r: NewRendition): Stmt {
  return stmt(
    `INSERT INTO media_renditions (user_id, rendition_id, asset_id, kind, version, object_key, content_type, width, height, byte_length, sha256, source_rendition_id, transformations_json, edited, status, command_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ctx.userId, r.renditionId, r.assetId, r.kind, r.version, r.objectKey, r.contentType, r.width, r.height, r.byteLength, r.sha256, r.sourceRenditionId, JSON.stringify(r.transformations), r.edited, ctx.commandId, ctx.now,
  );
}

export type MediaJobKind = "normalize" | "discover" | "render_composite" | "purge_objects";

/**
 * A durable job row plus the outbox entry that gets it onto the queue. `dedupeKey` makes enqueueing
 * idempotent: the same work is never queued twice.
 */
export function enqueueJob(
  ctx: Pick<CommandContext, "userId" | "now" | "commandId">,
  job: { jobId: string; kind: MediaJobKind; subjectId: string; dedupeKey: string; payload?: Record<string, unknown>; maxAttempts?: number },
): { statements: Stmt[]; outbox: PlannedOutbox[] } {
  return {
    statements: [
      stmt(
        `INSERT INTO media_jobs (user_id, job_id, kind, subject_id, dedupe_key, state, attempts, max_attempts, payload_json, command_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?) ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
        ctx.userId, job.jobId, job.kind, job.subjectId, job.dedupeKey, job.maxAttempts ?? 3, JSON.stringify(job.payload ?? {}), ctx.commandId, ctx.now, ctx.now,
      ),
    ],
    outbox: [{ topic: "media.job", entityKind: "media_job", entityId: job.jobId, revision: 1, payload: { kind: job.kind, dedupeKey: job.dedupeKey } }],
  };
}
