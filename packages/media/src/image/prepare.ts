/**
 * Non-generative preparation of a photograph BEFORE any generative editing (specification section 11:
 * "rotation, cropping and lighting correction precede generative editing"). Rotation is applied at
 * decode time from the EXIF orientation; this module supplies the other two steps:
 *
 *   - cropping: flat neutral bars around the picture (letterbox, pillarbox, a screenshot frame) are
 *     removed. Only rows and columns that are one flat grey-scale colour and end at a full-width change
 *     are ever removed, so no part of the photograph itself is cut;
 *   - lighting correction: an underexposed photograph is brightened by ONE gain applied equally to red,
 *     green and blue, which keeps every colour's hue. The gain is capped, and the result is checked
 *     (clipped highlights, measured hue shift) before it is used; a correction that fails is discarded.
 *
 * Everything is deterministic pixel arithmetic. The thresholds are initial engineering values validated
 * on synthetic fixtures only, not calibrated on real photographs.
 */
import { rgbToLab } from "./colour.ts";
import { cropRaster, type Raster } from "./raster.ts";

export const PREPARE_ALGORITHM_VERSION = "prepare-1";

export const PREPARE_THRESHOLDS = {
  /** Largest per-channel difference from the bar colour for a pixel to count as part of a flat bar. */
  barTolerance: 10,
  /** A bar colour must be neutral (black, white or grey): largest spread between its channels. */
  barMaxChroma: 12,
  /** Share of the first row or column inside a bar that must differ from the bar colour (a full-width change). */
  barTransitionShare: 0.9,
  /** Smallest bar thickness worth removing, as a share of the dimension (never under 2 pixels). */
  barMinShare: 0.01,
  /** A crop that would remove more than this share of either dimension is refused. */
  maxRemovedShare: 0.6,
  /** Lighting is corrected only when the 99th percentile of the brightest channel is below this value. */
  underexposedBelow: 200,
  /** Where the 99th percentile is moved to. */
  targetHighlight: 245,
  maxGain: 1.6,
  /** Largest share of pixels that may become clipped (a channel reaching 255 that was below it). */
  maxNewlyClippedShare: 0.005,
  /** Largest mean hue shift, in degrees, over the coloured pixels sampled. */
  maxMeanHueShiftDegrees: 3,
} as const;

export interface BorderCrop {
  changed: boolean;
  raster: Raster;
  /** The kept box in the source image. */
  box: { x: number; y: number; width: number; height: number };
  removed: { top: number; right: number; bottom: number; left: number };
  /** Largest per-channel difference from its bar colour among the removed pixels (0 when nothing was removed). */
  maxDeviation: number;
  reason: string;
}

interface Band {
  thickness: number;
  deviation: number;
  colour: readonly [number, number, number];
}

const NO_BAND: Band = { thickness: 0, deviation: 0, colour: [0, 0, 0] };

function channelDistance(src: Raster, p: number, colour: readonly [number, number, number]): number {
  return Math.max(Math.abs(src.data[p * 4]! - colour[0]), Math.abs(src.data[p * 4 + 1]! - colour[1]), Math.abs(src.data[p * 4 + 2]! - colour[2]));
}

/** How many whole rows/columns from one side are one flat neutral colour. `line(i)` yields the pixel offsets of the i-th full row/column from that side. */
function flatBand(src: Raster, count: number, line: (i: number) => number[]): Band {
  const T = PREPARE_THRESHOLDS;
  const first = line(0);
  let r = 0, g = 0, b = 0;
  for (const p of first) {
    r += src.data[p * 4]!;
    g += src.data[p * 4 + 1]!;
    b += src.data[p * 4 + 2]!;
  }
  const colour = [r / first.length, g / first.length, b / first.length] as const;
  if (Math.max(...colour) - Math.min(...colour) > T.barMaxChroma) return NO_BAND;
  let thickness = 0;
  let deviation = 0;
  for (; thickness < count; thickness++) {
    let worst = 0;
    for (const p of line(thickness)) worst = Math.max(worst, channelDistance(src, p, colour));
    if (worst > T.barTolerance) break;
    deviation = Math.max(deviation, worst);
  }
  if (thickness === 0 || thickness >= count) return NO_BAND;
  if (thickness < Math.max(2, Math.ceil(count * T.barMinShare))) return NO_BAND;
  return { thickness, deviation, colour };
}

/**
 * A bar ends at a full-width change. A plain margin around a subject ends where the subject begins, with
 * most of that row still margin-coloured: that is part of the photograph and is kept. `inner` is the first
 * row/column past the band, limited to the span between the bars on the adjoining sides.
 */
function endsAtFullChange(src: Raster, band: Band, inner: number[]): boolean {
  if (inner.length === 0) return false;
  let differing = 0;
  for (const p of inner) if (channelDistance(src, p, band.colour) > 2 * PREPARE_THRESHOLDS.barTolerance) differing++;
  return differing / inner.length >= PREPARE_THRESHOLDS.barTransitionShare;
}

/** Remove flat neutral bars around a photograph. Returns the source unchanged when there are none. */
export function cropUniformBorders(src: Raster): BorderCrop {
  const { width: w, height: h } = src;
  const none = (reason: string): BorderCrop => ({ changed: false, raster: src, box: { x: 0, y: 0, width: w, height: h }, removed: { top: 0, right: 0, bottom: 0, left: 0 }, maxDeviation: 0, reason });
  if (w < 16 || h < 16) return none("the image is too small to have borders");
  const row = (y: number, x0: number, x1: number): number[] => {
    const out: number[] = [];
    for (let x = x0; x < x1; x++) out.push(y * w + x);
    return out;
  };
  const column = (x: number, y0: number, y1: number): number[] => {
    const out: number[] = [];
    for (let y = y0; y < y1; y++) out.push(y * w + x);
    return out;
  };
  let top = flatBand(src, h, (i) => row(i, 0, w));
  let bottom = flatBand(src, h, (i) => row(h - 1 - i, 0, w));
  let left = flatBand(src, w, (i) => column(i, 0, h));
  let right = flatBand(src, w, (i) => column(w - 1 - i, 0, h));
  if (top.thickness + bottom.thickness >= h - 8 || left.thickness + right.thickness >= w - 8) return none("no picture would remain between the bars");
  // Each candidate must end at a full change across the span between its neighbours; dropping one widens
  // the span of the others, so repeat until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    const x0 = left.thickness, x1 = w - right.thickness, y0 = top.thickness, y1 = h - bottom.thickness;
    if (top.thickness > 0 && !endsAtFullChange(src, top, row(y0, x0, x1))) (top = NO_BAND), (changed = true);
    else if (bottom.thickness > 0 && !endsAtFullChange(src, bottom, row(y1 - 1, x0, x1))) (bottom = NO_BAND), (changed = true);
    else if (left.thickness > 0 && !endsAtFullChange(src, left, column(x0, y0, y1))) (left = NO_BAND), (changed = true);
    else if (right.thickness > 0 && !endsAtFullChange(src, right, column(x1 - 1, y0, y1))) (right = NO_BAND), (changed = true);
  }
  const x0 = left.thickness, x1 = w - right.thickness, y0 = top.thickness, y1 = h - bottom.thickness;
  if (top.thickness + bottom.thickness + left.thickness + right.thickness === 0) return none("no flat neutral bars were found");
  const T = PREPARE_THRESHOLDS;
  if ((top.thickness + bottom.thickness) / h > T.maxRemovedShare || (left.thickness + right.thickness) / w > T.maxRemovedShare) return none("the bars cover too much of the frame to be a border");
  return {
    changed: true,
    raster: cropRaster(src, x0, y0, x1 - x0, y1 - y0),
    box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    removed: { top: top.thickness, right: right.thickness, bottom: bottom.thickness, left: left.thickness },
    maxDeviation: Math.max(top.deviation, bottom.deviation, left.deviation, right.deviation),
    reason: "flat neutral bars removed",
  };
}

export interface LightingCheck {
  name: "gain_within_cap" | "clipped_highlights" | "hue_preserved";
  passed: boolean;
  score: number;
  threshold: number;
  detail: string;
}

export interface LightingCorrection {
  /** needed: the photograph is underexposed by the measure used. applied: the correction passed its check and `raster` is the corrected image. */
  needed: boolean;
  applied: boolean;
  /** The corrected image when applied; otherwise the source, untouched. */
  raster: Raster;
  gain: number;
  highlightBefore: number;
  verdict: "not_needed" | "passed" | "failed";
  failed: LightingCheck["name"][];
  checks: LightingCheck[];
  algorithmVersion: string;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** 99th percentile of the brightest channel over the pixels that are not transparent. */
export function highlightLevel(src: Raster): number {
  const histogram = new Uint32Array(256);
  let total = 0;
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 8) continue;
    histogram[Math.max(d[i]!, d[i + 1]!, d[i + 2]!)]! += 1;
    total++;
  }
  if (total === 0) return 255;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen >= total * 0.99) return v;
  }
  return 255;
}

function hueDegrees(r: number, g: number, b: number): { hue: number; chroma: number } {
  const lab = rgbToLab([r, g, b]);
  return { hue: (Math.atan2(lab[2], lab[1]) * 180) / Math.PI, chroma: Math.hypot(lab[1], lab[2]) };
}

/**
 * Brighten an underexposed photograph with one gain for all three channels, then check the result against
 * the source. A photograph that is not underexposed is returned as it is (`verdict: "not_needed"`); a
 * correction that fails its check is discarded (`applied: false`, `verdict: "failed"`, source returned).
 */
export function correctLighting(src: Raster): LightingCorrection {
  const T = PREPARE_THRESHOLDS;
  const highlightBefore = highlightLevel(src);
  const base = { raster: src, highlightBefore, algorithmVersion: PREPARE_ALGORITHM_VERSION };
  if (highlightBefore >= T.underexposedBelow || highlightBefore === 0) return { ...base, needed: false, applied: false, gain: 1, verdict: "not_needed", failed: [], checks: [] };
  const wanted = T.targetHighlight / highlightBefore;
  const gain = Math.min(T.maxGain, wanted);
  const out: Raster = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
  const s = src.data, o = out.data;
  let opaque = 0, clipped = 0, hueSum = 0, hueCount = 0;
  const stride = Math.max(1, Math.floor(Math.sqrt((src.width * src.height) / 20_000)));
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      o[i] = Math.round(s[i]! * gain);
      o[i + 1] = Math.round(s[i + 1]! * gain);
      o[i + 2] = Math.round(s[i + 2]! * gain);
      o[i + 3] = s[i + 3]!;
      if (s[i + 3]! < 8) continue;
      opaque++;
      if ((o[i] === 255 && s[i]! < 255) || (o[i + 1] === 255 && s[i + 1]! < 255) || (o[i + 2] === 255 && s[i + 2]! < 255)) clipped++;
      if (x % stride === 0 && y % stride === 0) {
        // Hue is MEASURED on the result, not assumed from the arithmetic: clipping and rounding both move it.
        const before = hueDegrees(s[i]!, s[i + 1]!, s[i + 2]!);
        const after = hueDegrees(o[i]!, o[i + 1]!, o[i + 2]!);
        if (before.chroma > 10 && after.chroma > 10) {
          let shift = Math.abs(after.hue - before.hue);
          if (shift > 180) shift = 360 - shift;
          hueSum += shift;
          hueCount++;
        }
      }
    }
  }
  const clippedShare = opaque === 0 ? 0 : clipped / opaque;
  const hueShift = hueCount === 0 ? 0 : hueSum / hueCount;
  const checks: LightingCheck[] = [
    { name: "gain_within_cap", passed: gain <= T.maxGain, score: round(gain), threshold: T.maxGain, detail: `one gain of ${round(gain)} for red, green and blue${wanted > T.maxGain ? ` (${round(wanted)} would be needed to reach full brightness; capped)` : ""}` },
    { name: "clipped_highlights", passed: clippedShare <= T.maxNewlyClippedShare, score: round(clippedShare), threshold: T.maxNewlyClippedShare, detail: `${round(clippedShare * 100)}% of pixels would lose highlight detail` },
    { name: "hue_preserved", passed: hueShift <= T.maxMeanHueShiftDegrees, score: round(hueShift), threshold: T.maxMeanHueShiftDegrees, detail: `mean hue shift ${round(hueShift)} degrees over ${hueCount} coloured samples` },
  ];
  const failed = checks.filter((c) => !c.passed).map((c) => c.name);
  if (failed.length > 0) return { ...base, needed: true, applied: false, gain: round(gain), verdict: "failed", failed, checks };
  return { needed: true, applied: true, raster: out, gain: round(gain), highlightBefore, verdict: "passed", failed: [], checks, algorithmVersion: PREPARE_ALGORITHM_VERSION };
}
