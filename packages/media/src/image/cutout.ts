import { labDistance, rgbToLab } from "./colour.ts";
import { alphaBounds, createRaster, type Raster, type Rgb } from "./raster.ts";

export interface CutoutOptions {
  /** Colour difference (deltaE) within which a pixel counts as background. Default 12. */
  tolerance?: number;
  /** Share of border pixels that must match the background colour. Default 0.8 (a garment may run off one edge). */
  minBorderUniformity?: number;
  minForegroundShare?: number;
  maxForegroundShare?: number;
  /** Width in pixels of the boundary ring whose alpha is softened. Default 1; 0 disables. */
  featherPx?: number;
}

export type CutoutOutcome =
  | {
      ok: true;
      raster: Raster;
      mask: Raster;
      method: "uniform_background_flood_fill";
      background: Rgb;
      foregroundShare: number;
      bounds: { x: number; y: number; width: number; height: number };
      touchesEdge: boolean;
    }
  | { ok: false; reason: "background_not_uniform" | "no_foreground" | "foreground_fills_frame" | "already_transparent"; detail: string };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

/** Median colour of the one-pixel border ring, and the share of border pixels within `tolerance` of it. */
export function estimateBackground(src: Raster, tolerance = 12): { colour: Rgb; uniformity: number } {
  const { width: w, height: h, data } = src;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  for (const p of border) {
    rs.push(data[p * 4]!);
    gs.push(data[p * 4 + 1]!);
    bs.push(data[p * 4 + 2]!);
  }
  const colour: Rgb = [median(rs), median(gs), median(bs)];
  const lab = rgbToLab(colour);
  let close = 0;
  for (const p of border) {
    if (labDistance(lab, rgbToLab([data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!])) <= tolerance) close++;
  }
  return { colour, uniformity: close / border.length };
}

/**
 * Background removal that PRESERVES SOURCE PIXELS. The background colour is estimated from the border;
 * background is then flood-filled inwards from the border through pixels of that colour, so
 * background-coloured areas enclosed by the garment (a white stripe, a white button) are kept. Kept
 * pixels retain their exact RGB; only alpha changes. When the border is not uniform (a photograph on a
 * cluttered background) the function declines and the caller needs a model-based remover.
 */
export function uniformBackgroundCutout(src: Raster, opts: CutoutOptions = {}): CutoutOutcome {
  const tolerance = opts.tolerance ?? 12;
  const { width: w, height: h, data } = src;
  const total = w * h;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 8) transparent++;
  if (transparent / total > 0.02) return { ok: false, reason: "already_transparent", detail: `${Math.round((100 * transparent) / total)}% of pixels are already transparent` };

  const bg = estimateBackground(src, tolerance);
  if (bg.uniformity < (opts.minBorderUniformity ?? 0.8)) {
    return { ok: false, reason: "background_not_uniform", detail: `only ${Math.round(bg.uniformity * 100)}% of the border matches one background colour` };
  }
  const bgLab = rgbToLab(bg.colour);
  // 0 = unknown, 1 = background (reached from the border), 2 = foreground
  const state = new Uint8Array(total);
  const isBackgroundColour = (p: number): boolean => labDistance(bgLab, rgbToLab([data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!])) <= tolerance;
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  const visit = (p: number): void => {
    if (state[p] !== 0) return;
    if (isBackgroundColour(p)) {
      state[p] = 1;
      queue[tail++] = p;
    } else state[p] = 2;
  };
  for (let x = 0; x < w; x++) {
    visit(x);
    visit((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    visit(y * w);
    visit(y * w + w - 1);
  }
  while (head < tail) {
    const p = queue[head++]!;
    const x = p % w;
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < total - w) visit(p + w);
  }
  let foreground = 0;
  for (let p = 0; p < total; p++) if (state[p] !== 1) foreground++;
  const share = foreground / total;
  if (share < (opts.minForegroundShare ?? 0.03)) return { ok: false, reason: "no_foreground", detail: `only ${(share * 100).toFixed(1)}% of the image differs from the background` };
  if (share > (opts.maxForegroundShare ?? 0.92)) return { ok: false, reason: "foreground_fills_frame", detail: `${(share * 100).toFixed(1)}% of the image is foreground; there is no margin to cut along` };

  const raster = createRaster(w, h);
  const mask = createRaster(w, h);
  const feather = opts.featherPx ?? 1;
  for (let p = 0; p < total; p++) {
    if (state[p] === 1) continue;
    let alpha = 255;
    if (feather > 0) {
      const x = p % w;
      const y = (p - x) / w;
      let nearBackground = false;
      for (let dy = -feather; dy <= feather && !nearBackground; dy++) {
        for (let dx = -feather; dx <= feather; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (state[ny * w + nx] === 1) {
            nearBackground = true;
            break;
          }
        }
      }
      if (nearBackground) {
        // Boundary pixels are usually a blend of garment and background: weight alpha by how far the
        // pixel is from the background colour. RGB is left exactly as photographed.
        const dist = labDistance(bgLab, rgbToLab([data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!]));
        alpha = Math.round(255 * Math.min(1, Math.max(0.4, dist / (tolerance * 4))));
      }
    }
    const i = p * 4;
    raster.data[i] = data[i]!;
    raster.data[i + 1] = data[i + 1]!;
    raster.data[i + 2] = data[i + 2]!;
    raster.data[i + 3] = alpha;
    mask.data[i] = mask.data[i + 1] = mask.data[i + 2] = mask.data[i + 3] = alpha;
  }
  const bounds = alphaBounds(raster, 8)!;
  const touchesEdge = bounds.x === 0 || bounds.y === 0 || bounds.x + bounds.width === w || bounds.y + bounds.height === h;
  return { ok: true, raster, mask, method: "uniform_background_flood_fill", background: bg.colour, foregroundShare: share, bounds, touchesEdge };
}
