import { alphaBounds, compositeOver, createRaster, cropRaster, resizeRaster, type Raster, type Rgb } from "./raster.ts";

export interface CatalogueOptions {
  /** Square canvas edge in pixels. Default 1200. */
  size?: number;
  /** Margin per side as a fraction of the canvas. Default 0.1 (generous). */
  margin?: number;
  /** Neutral canvas colour. Default white. */
  background?: Rgb;
  /** Restrained soft contact shadow beneath the garment. Default true. */
  shadow?: boolean;
}

/**
 * The normalized catalogue view: the cutout centred on a consistent neutral canvas with generous
 * margins. The garment's pixels are composited unchanged; it is scaled down to fit, and enlarged (at
 * most 2x) only when it would otherwise occupy less than a third of the canvas.
 */
export function catalogueView(cutout: Raster, opts: CatalogueOptions = {}): Raster {
  const size = opts.size ?? 1200;
  const margin = opts.margin ?? 0.1;
  const background = opts.background ?? [255, 255, 255];
  const canvas = createRaster(size, size, [background[0], background[1], background[2], 255]);
  const bounds = alphaBounds(cutout, 8);
  if (!bounds) return canvas;
  const garment = cropRaster(cutout, bounds.x, bounds.y, bounds.width, bounds.height);
  const box = size * (1 - 2 * margin);
  let scale = Math.min(box / garment.width, box / garment.height);
  if (scale > 1) scale = Math.max(garment.width, garment.height) < size / 3 ? Math.min(scale, 2) : 1;
  const w = Math.max(1, Math.round(garment.width * scale));
  const h = Math.max(1, Math.round(garment.height * scale));
  const placed = scale === 1 ? garment : resizeRaster(garment, w, h);
  const x = Math.round((size - w) / 2);
  const y = Math.round((size - h) / 2);

  if (opts.shadow !== false) {
    // A low, soft ellipse just below the garment: at most 8% darkening, fading quadratically.
    const cx = size / 2;
    const cy = Math.min(size - 1, y + h + size * 0.012);
    const rx = Math.max(8, w * 0.36);
    const ry = Math.max(3, size * 0.014);
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(size - 1, Math.ceil(cy + ry));
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(size - 1, Math.ceil(cx + rx));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const d = ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;
        if (d >= 1) continue;
        const k = 1 - 0.08 * (1 - d) * (1 - d);
        const i = (py * size + px) * 4;
        canvas.data[i] = Math.round(canvas.data[i]! * k);
        canvas.data[i + 1] = Math.round(canvas.data[i + 1]! * k);
        canvas.data[i + 2] = Math.round(canvas.data[i + 2]! * k);
      }
    }
  }
  compositeOver(canvas, placed, x, y);
  return canvas;
}
