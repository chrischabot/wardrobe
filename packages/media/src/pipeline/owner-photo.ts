/**
 * The owner's own photographs of a garment as reference images for discovery (specification section 11,
 * discovery step 4). Only a photograph the owner supplied, of this garment, with a background-removed
 * cutout made from its own pixels is used: a demo placeholder, an illustration, an edited view or a
 * photo on a cluttered background is no reference for what the garment looks like.
 */
import { all } from "@garderobe/domain";
import { bestOwnerPhotoComparison, compareWithOwnerPhoto, decodePng, type OwnerPhotoComparison, type Raster } from "../image/index.ts";
import { assertOwnedKey } from "../keys.ts";
import { limitsOf, type MediaRuntime } from "../runtime.ts";

export interface OwnerReference {
  assetId: string;
  renditionId: string;
  sha256: string;
  raster: Raster;
}

export interface OwnerReferences {
  references: OwnerReference[];
  /** Owner photographs of the garment that exist but cannot serve as a reference (no clean cutout). */
  unusable: number;
}

const MAX_REFERENCES = 2;

export async function loadOwnerReferences(rt: MediaRuntime, userId: string, garmentId: string): Promise<OwnerReferences> {
  const photos = await all<{ asset_id: string }>(rt.db, "SELECT asset_id FROM media_assets WHERE user_id = ? AND garment_id = ? AND kind = 'owner_photo' AND is_demo = 0 AND status = 'active' ORDER BY created_at DESC, asset_id DESC", userId, garmentId);
  if (photos.length === 0) return { references: [], unusable: 0 };
  const cutouts = await all<{ asset_id: string; rendition_id: string; object_key: string; sha256: string }>(
    rt.db,
    `SELECT r.asset_id, r.rendition_id, r.object_key, r.sha256 FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id
      WHERE r.user_id = ? AND a.garment_id = ? AND a.kind = 'owner_photo' AND a.is_demo = 0 AND a.status = 'active' AND r.kind = 'cutout' AND r.status = 'active' AND r.edited = 0
      ORDER BY a.created_at DESC, r.version DESC`,
    userId, garmentId,
  );
  const references: OwnerReference[] = [];
  for (const c of cutouts) {
    if (references.length >= MAX_REFERENCES) break;
    if (references.some((r) => r.assetId === c.asset_id)) continue;
    assertOwnedKey(userId, c.object_key);
    const object = await rt.deps.bucket.get(c.object_key);
    if (!object) continue;
    try {
      references.push({ assetId: c.asset_id, renditionId: c.rendition_id, sha256: c.sha256, raster: await decodePng(new Uint8Array(await object.arrayBuffer()), { maxPixels: limitsOf(rt.deps).maxPixels }) });
    } catch {
      // an unreadable cutout is simply not a reference
    }
  }
  return { references, unusable: photos.length - new Set(references.map((r) => r.assetId)).size };
}

/** What is recorded on the candidate (and on the asset made from it) about the comparison. */
export interface OwnerPhotoEvidence extends OwnerPhotoComparison {
  /** The owner's photo the verdict rests on; null when none could be compared. */
  ownerAssetId: string | null;
  ownerRenditionId: string | null;
  ownerRenditionSha256: string | null;
  ownerPhotosCompared: number;
  /** What the comparison did to the candidate. */
  effect: "none" | "rejected" | "sent_to_owner_review";
}

export function compareCandidateWithOwnerPhotos(refs: OwnerReferences, candidate: Raster | null): OwnerPhotoEvidence | null {
  if (refs.references.length === 0 && refs.unusable === 0) return null; // the owner has no photograph of this garment
  const blank = { ownerAssetId: null, ownerRenditionId: null, ownerRenditionSha256: null, ownerPhotosCompared: 0, effect: "none" as const };
  const none = (reason: string): OwnerPhotoEvidence => ({ ...compareWithOwnerPhoto(createEmpty(), createEmpty()), compared: false, reason, verdict: null, detail: `not compared with the owner's photo: ${reason}`, ...blank });
  if (refs.references.length === 0) return none("the owner's photo has no background-removed cutout to compare with");
  if (!candidate) return none("the candidate's format cannot be read here");
  const best = bestOwnerPhotoComparison(refs.references.map((reference) => ({ reference, comparison: compareWithOwnerPhoto(reference.raster, candidate) })))!;
  return { ...best.comparison, ownerAssetId: best.reference.assetId, ownerRenditionId: best.reference.renditionId, ownerRenditionSha256: best.reference.sha256, ownerPhotosCompared: refs.references.length, effect: "none" };
}

function createEmpty(): Raster {
  return { width: 4, height: 4, data: new Uint8ClampedArray(64) };
}
