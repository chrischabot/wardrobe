/**
 * Fidelity checks: compare a DERIVED image (a cutout, or the output of an editing model) against the
 * ORIGINAL it came from. Everything is deterministic pixel arithmetic; no model confidence is involved.
 */
import { colourDistributionDistance, dominantColours, labDistance, rgbToLab } from "./colour.ts";
import { estimateBackground, uniformBackgroundCutout } from "./cutout.ts";
import { alphaBounds, cropRaster, fitWithin, resizeRaster, type Raster, type Rgb } from "./raster.ts";

export type FidelityCheckName = "garment_identity" | "dominant_colours" | "important_details" | "clipping" | "halos" | "missing_components";

export interface FidelityCheck {
  name: FidelityCheckName;
  passed: boolean;
  score: number;
  threshold: number;
  detail: string;
}

export interface FidelityReport {
  verdict: "passed" | "failed";
  checks: FidelityCheck[];
  failed: FidelityCheckName[];
  algorithmVersion: string;
}

export interface FidelityOptions {
  /** "cutout": derived is a background-removed version of the same pixels. "edit": derived came from an editing model and may be re-framed. */
  mode: "cutout" | "edit";
  /** Optional cutout of the original (same frame, alpha = foreground) to compare silhouettes against. */
  originalForeground?: Raster;
}

export const FIDELITY_ALGORITHM_VERSION = "fidelity-1";

/**
 * Initial engineering values, validated only on synthetic fixtures. They are NOT calibrated on real
 * photographs; treat a pass as "no material change detected by these measures", not as proof.
 */
export const FIDELITY_THRESHOLDS = {
  /** Minimum silhouette intersection-over-union (times bounding-box aspect agreement in edit mode). */
  identityIouCutout: 0.9,
  identityIouEdit: 0.82,
  /** Maximum mean colour difference (deltaE) between kept pixels and their source pixels (cutout mode). */
  pixelPreservationDeltaE: 3,
  /** Maximum palette distance (see colourDistributionDistance). */
  paletteDistance: 8,
  /** Minimum share of interior blocks whose detail statistics agree. */
  detailAgreement: 0.94,
  /** Maximum extra share of the silhouette boundary lying on the frame edge. */
  clippingExtraEdgeShare: 0.03,
  /** Maximum share of boundary-ring pixels that look like leftover background. */
  haloShare: 0.12,
  /** Maximum share of the original foreground missing from the derived foreground. */
  lostArea: 0.05,
  /** Maximum growth in enclosed holes, as a share of the foreground. */
  newHoleShare: 0.004,
} as const;

const GRID = 128;
const BLOCKS = 8;

interface Foreground {
  raster: Raster;
  /** True when the silhouette was established independently (supplied, already transparent, or cut out). */
  independent: boolean;
  background: Rgb | null;
}

function hasTransparency(r: Raster): boolean {
  let n = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! < 8) n++;
  return n / (r.width * r.height) > 0.02;
}

function foregroundOf(image: Raster, supplied?: Raster): Foreground {
  if (supplied && supplied.width === image.width && supplied.height === image.height) {
    return { raster: supplied, independent: true, background: hasTransparency(image) ? null : estimateBackground(image).colour };
  }
  if (hasTransparency(image)) return { raster: image, independent: true, background: null };
  const cut = uniformBackgroundCutout(image, { featherPx: 0 });
  if (cut.ok) return { raster: cut.raster, independent: true, background: cut.background };
  return { raster: image, independent: false, background: estimateBackground(image).colour };
}

function maskOf(r: Raster): Uint8Array {
  const m = new Uint8Array(r.width * r.height);
  for (let p = 0; p < m.length; p++) m[p] = r.data[p * 4 + 3]! > 127 ? 1 : 0;
  return m;
}

function count(m: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i]!;
  return n;
}

/** Cells of background not connected to the frame edge (holes), and the number of foreground components above a minimum size. */
function topology(mask: Uint8Array, w: number, h: number): { holeCells: number; components: number } {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  const flood = (start: number, value: number): number => {
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const neighbours = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < mask.length - w ? p + w : -1];
      for (const n of neighbours) {
        if (n >= 0 && seen[n] === 0 && mask[n] === value) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    return size;
  };
  for (let x = 0; x < w; x++) {
    for (const p of [x, (h - 1) * w + x]) if (mask[p] === 0 && seen[p] === 0) flood(p, 0);
  }
  for (let y = 0; y < h; y++) {
    for (const p of [y * w, y * w + w - 1]) if (mask[p] === 0 && seen[p] === 0) flood(p, 0);
  }
  let holeCells = 0;
  let components = 0;
  const fg = count(mask);
  for (let p = 0; p < mask.length; p++) {
    if (seen[p] !== 0) continue;
    if (mask[p] === 0) holeCells += flood(p, 0);
    else if (flood(p, 1) >= Math.max(4, fg * 0.01)) components++;
  }
  return { holeCells, components };
}

function toGrid(fg: Raster, cropToBounds: boolean): { grid: Raster; aspect: number } {
  const b = alphaBounds(fg, 127);
  if (!b) return { grid: resizeRaster(fg, GRID, GRID), aspect: fg.width / fg.height };
  const source = cropToBounds ? cropRaster(fg, b.x, b.y, b.width, b.height) : fg;
  return { grid: resizeRaster(source, GRID, GRID), aspect: b.width / b.height };
}

function luminance(r: Raster, p: number): number {
  return 0.299 * r.data[p * 4]! + 0.587 * r.data[p * 4 + 1]! + 0.114 * r.data[p * 4 + 2]!;
}

interface BlockStats {
  edge: number;
  dark: number;
  bright: number;
}

/** Detail statistics of one block over the cells valid in both images. */
function blockStats(grid: Raster, valid: Uint8Array, bx: number, by: number, size: number): BlockStats | null {
  const values: number[] = [];
  let edge = 0, pairs = 0;
  for (let y = by; y < by + size; y++) {
    for (let x = bx; x < bx + size; x++) {
      const p = y * GRID + x;
      if (!valid[p]) continue;
      const l = luminance(grid, p);
      values.push(l);
      if (x + 1 < GRID && valid[p + 1]) {
        edge += Math.abs(luminance(grid, p + 1) - l);
        pairs++;
      }
      if (y + 1 < GRID && valid[p + GRID]) {
        edge += Math.abs(luminance(grid, p + GRID) - l);
        pairs++;
      }
    }
  }
  if (values.length < size * size * 0.3 || pairs === 0) return null;
  values.sort((a, b) => a - b);
  const med = values[values.length >> 1]!;
  return { edge: edge / pairs, dark: med - values[Math.min(1, values.length - 1)]!, bright: values[Math.max(0, values.length - 2)]! - med };
}

function edgeShare(mask: Uint8Array, w: number, h: number): number {
  let boundary = 0, onEdge = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      const atEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (atEdge) {
        onEdge++;
        boundary++;
      } else if (!mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) boundary++;
    }
  }
  return boundary === 0 ? 0 : onEdge / boundary;
}

function haloShare(derived: Raster, background: Rgb): { share: number; ring: number } {
  const size = fitWithin(derived.width, derived.height, 800, 800);
  const img = size.width === derived.width ? derived : resizeRaster(derived, size.width, size.height);
  const { width: w, height: h, data } = img;
  const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3]! > 32;
  const ring = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue;
      search: for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (data[(ny * w + nx) * 4 + 3]! <= 32) {
            ring[y * w + x] = 1;
            break search;
          }
        }
      }
    }
  }
  const bgLab = rgbToLab(background);
  let ringCount = 0, halo = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ring[y * w + x]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const nx = x + dx, ny = y + dy;
          if (!solid(nx, ny) || ring[ny * w + nx]) continue;
          const i = (ny * w + nx) * 4;
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
          n++;
        }
      }
      if (n === 0) continue;
      ringCount++;
      const i = (y * w + x) * 4;
      const lab = rgbToLab([data[i]!, data[i + 1]!, data[i + 2]!]);
      if (labDistance(lab, bgLab) < 12 && labDistance(lab, rgbToLab([r / n, g / n, b / n])) > 25) halo++;
    }
  }
  return { share: ringCount === 0 ? 0 : halo / ringCount, ring: ringCount };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Run all six checks. The verdict is "passed" only when every check passes; a failed derivative must
 * be rejected by the caller and the report kept.
 */
export function checkFidelity(original: Raster, derived: Raster, opts: FidelityOptions): FidelityReport {
  const T = FIDELITY_THRESHOLDS;
  const o = foregroundOf(original, opts.originalForeground);
  const d = foregroundOf(derived);
  const sameFrame = opts.mode === "cutout" && Math.abs(original.width / original.height - derived.width / derived.height) < 0.01;
  const og = toGrid(o.raster, !sameFrame);
  const dg = toGrid(d.raster, !sameFrame);
  const om = maskOf(og.grid);
  const dm = maskOf(dg.grid);
  const oCount = count(om);
  const dCount = count(dm);
  let inter = 0, union = 0, lost = 0;
  for (let p = 0; p < om.length; p++) {
    if (om[p] && dm[p]) inter++;
    if (om[p] || dm[p]) union++;
    if (om[p] && !dm[p]) lost++;
  }
  const checks: FidelityCheck[] = [];

  // 1. garment identity: silhouette agreement (and, for a cutout, that kept pixels are the source pixels)
  {
    const iou = union === 0 ? 0 : inter / union;
    const aspectAgreement = Math.min(og.aspect, dg.aspect) / Math.max(og.aspect, dg.aspect);
    const threshold = opts.mode === "cutout" ? T.identityIouCutout : T.identityIouEdit;
    let preservation = 0;
    if (sameFrame) {
      const full = resizeRaster(original, GRID, GRID);
      let sum = 0, n = 0;
      for (let p = 0; p < dm.length; p++) {
        if (dg.grid.data[p * 4 + 3]! < 250) continue;
        sum += labDistance(rgbToLab([dg.grid.data[p * 4]!, dg.grid.data[p * 4 + 1]!, dg.grid.data[p * 4 + 2]!]), rgbToLab([full.data[p * 4]!, full.data[p * 4 + 1]!, full.data[p * 4 + 2]!]));
        n++;
      }
      preservation = n === 0 ? 0 : sum / n;
    }
    if (!o.independent) {
      const passed = dCount > 0 && (!sameFrame || preservation <= T.pixelPreservationDeltaE);
      checks.push({ name: "garment_identity", passed, score: round(sameFrame ? preservation : 0), threshold: T.pixelPreservationDeltaE, detail: "no independent silhouette of the original was available; only pixel preservation of the kept area was verified" });
    } else {
      const score = iou * (sameFrame ? 1 : aspectAgreement);
      const passed = score >= threshold && (!sameFrame || preservation <= T.pixelPreservationDeltaE);
      checks.push({ name: "garment_identity", passed, score: round(score), threshold, detail: `silhouette overlap ${round(iou)}, outline aspect agreement ${round(aspectAgreement)}${sameFrame ? `, mean colour difference of kept pixels ${round(preservation)}` : ""}` });
    }
  }

  // 2. dominant colours of the foreground
  {
    const shrink = (r: Raster): Raster => {
      const s = fitWithin(r.width, r.height, 256, 256);
      return s.width === r.width ? r : resizeRaster(r, s.width, s.height);
    };
    const a = dominantColours(shrink(o.raster));
    const b = dominantColours(shrink(d.raster));
    const distance = colourDistributionDistance(a, b);
    checks.push({ name: "dominant_colours", passed: distance <= T.paletteDistance, score: round(distance), threshold: T.paletteDistance, detail: `palette distance ${round(distance)} across ${a.length} and ${b.length} dominant colours` });
  }

  // 3. important details: per-block edge density and light/dark feature statistics of the interior
  {
    const valid = new Uint8Array(GRID * GRID);
    for (let y = 1; y < GRID - 1; y++) {
      for (let x = 1; x < GRID - 1; x++) {
        const p = y * GRID + x;
        const both = (q: number) => om[q]! && dm[q]!;
        if (both(p) && both(p - 1) && both(p + 1) && both(p - GRID) && both(p + GRID)) valid[p] = 1;
      }
    }
    const size = GRID / BLOCKS;
    let compared = 0, differing = 0;
    for (let by = 0; by < BLOCKS; by++) {
      for (let bx = 0; bx < BLOCKS; bx++) {
        const a = blockStats(og.grid, valid, bx * size, by * size, size);
        const b = blockStats(dg.grid, valid, bx * size, by * size, size);
        if (!a || !b) continue;
        compared++;
        const edgeDiffers = Math.abs(a.edge - b.edge) > Math.max(3, 0.35 * Math.max(a.edge, b.edge));
        if (edgeDiffers || Math.abs(a.dark - b.dark) > 25 || Math.abs(a.bright - b.bright) > 25) differing++;
      }
    }
    const agreement = compared === 0 ? (oCount === 0 && dCount === 0 ? 1 : 0) : 1 - differing / compared;
    checks.push({ name: "important_details", passed: agreement >= T.detailAgreement, score: round(agreement), threshold: T.detailAgreement, detail: `${differing} of ${compared} interior blocks differ in edge density or light/dark features (buttons, pockets, seams, pattern scale)` });
  }

  // 4. clipping by the frame
  {
    const dMask = maskOf(d.raster);
    const dShare = edgeShare(dMask, d.raster.width, d.raster.height);
    const oShare = o.independent ? edgeShare(maskOf(o.raster), o.raster.width, o.raster.height) : 0;
    const extra = dShare - oShare;
    checks.push({ name: "clipping", passed: extra <= T.clippingExtraEdgeShare, score: round(extra), threshold: T.clippingExtraEdgeShare, detail: `${round(dShare * 100)}% of the derived outline lies on the frame edge versus ${round(oShare * 100)}% in the original` });
  }

  // 5. halos: leftover background colour along the cut edge
  {
    if (!hasTransparency(derived) || !o.background) {
      checks.push({ name: "halos", passed: true, score: 0, threshold: T.haloShare, detail: "the derived image has no transparent edge to inspect" });
    } else {
      const { share, ring } = haloShare(derived, o.background);
      checks.push({ name: "halos", passed: share <= T.haloShare, score: round(share), threshold: T.haloShare, detail: `${round(share * 100)}% of ${ring} edge pixels match the original background rather than the garment` });
    }
  }

  // 6. missing components: lost area, new holes, component count
  {
    const ot = topology(om, GRID, GRID);
    const dt = topology(dm, GRID, GRID);
    const lostShare = o.independent && oCount > 0 ? lost / oCount : 0;
    const newHoles = Math.max(0, dt.holeCells / Math.max(1, dCount) - (o.independent ? ot.holeCells / Math.max(1, oCount) : 0));
    const componentsOk = !o.independent || dt.components === ot.components;
    const passed = dCount > 0 && lostShare <= T.lostArea && newHoles <= T.newHoleShare && componentsOk;
    checks.push({ name: "missing_components", passed, score: round(lostShare), threshold: T.lostArea, detail: `${round(lostShare * 100)}% of the original area is missing; enclosed holes grew by ${round(newHoles * 100)}% of the area; ${dt.components} part(s) versus ${o.independent ? ot.components : "unknown"} in the original` });
  }

  const failed = checks.filter((c) => !c.passed).map((c) => c.name);
  return { verdict: failed.length === 0 ? "passed" : "failed", checks, failed, algorithmVersion: FIDELITY_ALGORITHM_VERSION };
}
