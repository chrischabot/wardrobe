/**
 * Comparison of a discovery candidate with the owner's OWN photograph of the garment (specification
 * section 11, discovery step 4: "compare candidates with the recorded garment and owner photographs").
 *
 * Both images are reduced to their foreground (the owner's stored cutout; the candidate cut out from its
 * plain product-photo background) and two things are measured:
 *   - colour: the distance between the two foreground palettes (see colourDistributionDistance);
 *   - outline: the overlap of the two silhouettes after each is cropped to its own bounds, times the
 *     agreement of their bounding-box proportions.
 *
 * A phone photograph and a studio photograph of the same garment differ in lighting and pose, so there
 * are three outcomes per measure, not two: consistent, different, and an inconclusive band in between.
 * Deterministic pixel arithmetic; no model confidence is involved. The thresholds are initial engineering
 * values validated on synthetic fixtures only, NOT calibrated on real photographs.
 */
import { colourDistributionDistance, dominantColours } from "./colour.ts";
import { uniformBackgroundCutout } from "./cutout.ts";
import { alphaBounds, cropRaster, fitWithin, resizeRaster, type Raster } from "./raster.ts";

export const OWNER_PHOTO_COMPARISON_VERSION = "owner-photo-compare-1";

export const OWNER_PHOTO_THRESHOLDS = {
  /** Palette distance at or below which the colours are taken to agree. */
  colourConsistent: 14,
  /** Palette distance at or above which the colours are clearly another colourway. */
  colourDifferent: 28,
  /** Outline score (silhouette overlap x proportion agreement) at or above which the outlines agree. */
  outlineConsistent: 0.7,
  /** Outline score at or below which the garment is clearly cut differently. */
  outlineDifferent: 0.5,
} as const;

export type OwnerPhotoVerdict = "consistent" | "different_colour" | "different_outline" | "inconclusive";

export interface OwnerPhotoComparison {
  compared: boolean;
  /** Why no comparison could be made (only when `compared` is false). */
  reason: string | null;
  verdict: OwnerPhotoVerdict | null;
  colourDistance: number | null;
  outlineScore: number | null;
  outlineOverlap: number | null;
  proportionAgreement: number | null;
  detail: string;
  thresholds: typeof OWNER_PHOTO_THRESHOLDS;
  algorithmVersion: string;
}

const GRID = 64;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function shrink(r: Raster, edge: number): Raster {
  const s = fitWithin(r.width, r.height, edge, edge);
  return s.width === r.width && s.height === r.height ? r : resizeRaster(r, s.width, s.height);
}

function hasTransparency(r: Raster): boolean {
  let n = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! < 8) n++;
  return n / (r.width * r.height) > 0.02;
}

/** The foreground of an image as a raster with alpha: as it is when already transparent, else cut out from a plain background. */
export function foregroundForComparison(image: Raster): { ok: true; raster: Raster } | { ok: false; reason: string } {
  const small = shrink(image, 384);
  if (hasTransparency(small)) return alphaBounds(small, 127) ? { ok: true, raster: small } : { ok: false, reason: "the image is empty" };
  const cut = uniformBackgroundCutout(small, { featherPx: 0 });
  if (!cut.ok) return { ok: false, reason: cut.reason === "background_not_uniform" ? "its background is not plain, so the garment cannot be separated from it" : cut.detail };
  return { ok: true, raster: cut.raster };
}

function outlineGrid(fg: Raster): { mask: Uint8Array; aspect: number } | null {
  const b = alphaBounds(fg, 127);
  if (!b || b.width < 4 || b.height < 4) return null;
  const grid = resizeRaster(cropRaster(fg, b.x, b.y, b.width, b.height), GRID, GRID);
  const mask = new Uint8Array(GRID * GRID);
  for (let p = 0; p < mask.length; p++) mask[p] = grid.data[p * 4 + 3]! > 127 ? 1 : 0;
  return { mask, aspect: b.width / b.height };
}

const notCompared = (reason: string): OwnerPhotoComparison => ({ compared: false, reason, verdict: null, colourDistance: null, outlineScore: null, outlineOverlap: null, proportionAgreement: null, detail: `not compared with the owner's photo: ${reason}`, thresholds: OWNER_PHOTO_THRESHOLDS, algorithmVersion: OWNER_PHOTO_COMPARISON_VERSION });

/**
 * Compare a candidate image with the owner's photograph of the garment. `ownerForeground` is the owner's
 * photo with its background removed (alpha = garment); `candidate` is the candidate image as fetched.
 */
export function compareWithOwnerPhoto(ownerForeground: Raster, candidate: Raster): OwnerPhotoComparison {
  const T = OWNER_PHOTO_THRESHOLDS;
  const owner = foregroundForComparison(ownerForeground);
  if (!owner.ok) return notCompared(`the owner's photo could not be used (${owner.reason})`);
  const found = foregroundForComparison(candidate);
  if (!found.ok) return notCompared(`the candidate could not be used (${found.reason})`);
  const a = outlineGrid(owner.raster);
  const b = outlineGrid(found.raster);
  if (!a || !b) return notCompared("one of the two images shows no garment");

  const colourDistance = colourDistributionDistance(dominantColours(shrink(owner.raster, 256)), dominantColours(shrink(found.raster, 256)));
  let inter = 0, union = 0;
  for (let p = 0; p < a.mask.length; p++) {
    if (a.mask[p] && b.mask[p]) inter++;
    if (a.mask[p] || b.mask[p]) union++;
  }
  const overlap = union === 0 ? 0 : inter / union;
  const proportion = Math.min(a.aspect, b.aspect) / Math.max(a.aspect, b.aspect);
  const outlineScore = overlap * proportion;

  // Colour is judged first: another colourway of the right cut is still the wrong garment.
  const verdict: OwnerPhotoVerdict =
    colourDistance >= T.colourDifferent ? "different_colour" : outlineScore <= T.outlineDifferent ? "different_outline" : colourDistance <= T.colourConsistent && outlineScore >= T.outlineConsistent ? "consistent" : "inconclusive";
  const words: Record<OwnerPhotoVerdict, string> = {
    consistent: "colours and outline agree with the owner's photo",
    different_colour: "the colours are clearly different from the owner's photo",
    different_outline: "the outline is clearly different from the owner's photo",
    inconclusive: "neither clearly the same nor clearly different from the owner's photo (lighting and pose differ between photographs)",
  };
  return {
    compared: true,
    reason: null,
    verdict,
    colourDistance: round(colourDistance),
    outlineScore: round(outlineScore),
    outlineOverlap: round(overlap),
    proportionAgreement: round(proportion),
    detail: `${words[verdict]}: palette distance ${round(colourDistance)}, outline overlap ${round(overlap)} with proportion agreement ${round(proportion)}`,
    thresholds: T,
    algorithmVersion: OWNER_PHOTO_COMPARISON_VERSION,
  };
}

const ORDER: OwnerPhotoVerdict[] = ["consistent", "inconclusive", "different_outline", "different_colour"];

/** With several owner photographs, the most favourable comparison stands: one clear agreement outweighs a badly lit second photo. */
export function bestOwnerPhotoComparison<T extends { comparison: OwnerPhotoComparison }>(results: T[]): T | null {
  const compared = results.filter((r) => r.comparison.compared && r.comparison.verdict);
  if (compared.length === 0) return results[0] ?? null;
  return [...compared].sort((x, y) => ORDER.indexOf(x.comparison.verdict!) - ORDER.indexOf(y.comparison.verdict!) || (x.comparison.colourDistance ?? 0) - (y.comparison.colourDistance ?? 0))[0]!;
}
