/**
 * SYNTHETIC TEST IMAGES - NOT ANYONE'S GARMENTS.
 *
 * Programmatically drawn shapes (a striped shirt, trousers, a pair of shoes, a coat) used as labelled
 * demo/test assets and as fidelity fixtures. They are never presented as the owner's clothes: uploads
 * made from them must carry `demo: true` and belong to synthetic fixture garments.
 */
import { createRaster, type Raster, type Rgb } from "../image/raster.ts";

export const SYNTHETIC_IMAGE_LABEL = "synthetic test image";

export function fillRect(r: Raster, x0: number, y0: number, x1: number, y1: number, c: Rgb, alpha = 255): void {
  const xa = Math.max(0, Math.round(x0)), xb = Math.min(r.width, Math.round(x1));
  const ya = Math.max(0, Math.round(y0)), yb = Math.min(r.height, Math.round(y1));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * r.width + x) * 4;
      r.data[i] = c[0];
      r.data[i + 1] = c[1];
      r.data[i + 2] = c[2];
      r.data[i + 3] = alpha;
    }
  }
}

export function fillEllipse(r: Raster, cx: number, cy: number, rx: number, ry: number, c: Rgb, alpha = 255): void {
  for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(r.height - 1, Math.ceil(cy + ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(r.width - 1, Math.ceil(cx + rx)); x++) {
      if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) {
        const i = (y * r.width + x) * 4;
        r.data[i] = c[0];
        r.data[i + 1] = c[1];
        r.data[i + 2] = c[2];
        r.data[i + 3] = alpha;
      }
    }
  }
}

export function strokeRect(r: Raster, x0: number, y0: number, x1: number, y1: number, c: Rgb, thickness = 2): void {
  fillRect(r, x0, y0, x1, y0 + thickness, c);
  fillRect(r, x0, y1 - thickness, x1, y1, c);
  fillRect(r, x0, y0, x0 + thickness, y1, c);
  fillRect(r, x1 - thickness, y0, x1, y1, c);
}

export interface SyntheticShirtOptions {
  size?: number;
  body?: Rgb;
  /** Vertical stripes; null for a plain shirt. */
  stripe?: Rgb | null;
  stripeWidth?: number;
  sleeve?: "long" | "short";
  buttons?: boolean;
  buttonColour?: Rgb;
  pocket?: boolean;
  background?: Rgb;
  /** Horizontal shift in pixels (a large shift runs the shirt off the frame). */
  shiftX?: number;
}

/** A synthetic striped shirt, front view, on a uniform background. */
export function syntheticShirt(o: SyntheticShirtOptions = {}): Raster {
  const S = o.size ?? 256;
  const bg = o.background ?? [255, 255, 255];
  const body = o.body ?? [40, 90, 200];
  const stripe = o.stripe === undefined ? ([170, 195, 235] as Rgb) : o.stripe;
  const sw = o.stripeWidth ?? Math.max(2, Math.round(S * 0.024));
  const dx = o.shiftX ?? 0;
  const r = createRaster(S, S, [bg[0], bg[1], bg[2], 255]);
  const sleeveBottom = (o.sleeve ?? "long") === "long" ? 0.75 : 0.38;
  const parts: [number, number, number, number][] = [
    [0.3, 0.15, 0.7, 0.88],
    [0.12, 0.15, 0.3, sleeveBottom],
    [0.7, 0.15, 0.88, sleeveBottom],
  ];
  for (const [x0, y0, x1, y1] of parts) {
    fillRect(r, x0 * S + dx, y0 * S, x1 * S + dx, y1 * S, body);
    if (stripe) {
      // Stripes stop short of the hem and shoulder so they are enclosed by the body colour.
      for (let x = x0 * S + sw; x + sw < x1 * S; x += sw * 2) fillRect(r, x + dx, y0 * S + 3, x + sw + dx, y1 * S - 3, stripe);
    }
  }
  if (o.pocket !== false) strokeRect(r, 0.55 * S + dx, 0.3 * S, 0.66 * S + dx, 0.42 * S, [20, 30, 60], Math.max(2, Math.round(S / 128)));
  if (o.buttons !== false) {
    for (const y of [0.25, 0.37, 0.49, 0.61, 0.73]) fillEllipse(r, 0.5 * S + dx, y * S, 0.02 * S, 0.02 * S, o.buttonColour ?? [25, 25, 30]);
  }
  return r;
}

/** Synthetic trousers (two legs from a waistband). `short: true` draws shorts. */
export function syntheticTrousers(o: { size?: number; colour?: Rgb; background?: Rgb; short?: boolean } = {}): Raster {
  const S = o.size ?? 256;
  const bg = o.background ?? [255, 255, 255];
  const c = o.colour ?? [70, 80, 50];
  const r = createRaster(S, S, [bg[0], bg[1], bg[2], 255]);
  const hem = o.short ? 0.5 : 0.92;
  fillRect(r, 0.3 * S, 0.08 * S, 0.7 * S, 0.3 * S, c);
  fillRect(r, 0.3 * S, 0.3 * S, 0.485 * S, hem * S, c);
  fillRect(r, 0.515 * S, 0.3 * S, 0.7 * S, hem * S, c);
  fillRect(r, 0.3 * S, 0.08 * S, 0.7 * S, 0.1 * S, [40, 45, 30]);
  return r;
}

/** A synthetic pair of shoes seen from the side (two separate shapes); `count: 1` draws a single shoe. */
export function syntheticShoes(o: { size?: number; colour?: Rgb; background?: Rgb; count?: 1 | 2 } = {}): Raster {
  const S = o.size ?? 256;
  const bg = o.background ?? [255, 255, 255];
  const c = o.colour ?? [150, 70, 30];
  const r = createRaster(S, S, [bg[0], bg[1], bg[2], 255]);
  const shoe = (cx: number): void => {
    fillEllipse(r, cx * S, 0.55 * S, 0.17 * S, 0.11 * S, c);
    fillRect(r, (cx - 0.17) * S, 0.62 * S, (cx + 0.17) * S, 0.68 * S, [235, 225, 205]);
  };
  shoe(0.28);
  if ((o.count ?? 2) === 2) shoe(0.72);
  return r;
}

/** A synthetic coat: long when `long` is true, otherwise jacket length. */
export function syntheticCoat(o: { size?: number; colour?: Rgb; background?: Rgb; long?: boolean } = {}): Raster {
  const S = o.size ?? 256;
  const bg = o.background ?? [255, 255, 255];
  const c = o.colour ?? [60, 50, 45];
  const r = createRaster(S, S, [bg[0], bg[1], bg[2], 255]);
  const hem = o.long ? 0.95 : 0.7;
  fillRect(r, 0.28 * S, 0.08 * S, 0.72 * S, hem * S, c);
  fillRect(r, 0.1 * S, 0.08 * S, 0.28 * S, 0.66 * S, c);
  fillRect(r, 0.72 * S, 0.08 * S, 0.9 * S, 0.66 * S, c);
  fillRect(r, 0.495 * S, 0.12 * S, 0.505 * S, hem * S, [25, 20, 18]);
  return r;
}

/** A cluttered, non-uniform scene (deterministic stripes and blocks): stands in for a phone photo background. */
export function syntheticClutteredPhoto(size = 256): Raster {
  const r = createRaster(size, size, [120, 110, 100, 255]);
  for (let i = 0; i < 16; i++) {
    const c: Rgb = [(i * 53) % 256, (i * 97 + 40) % 256, (i * 151 + 90) % 256];
    fillRect(r, (i * size) / 16, 0, ((i + 1) * size) / 16, size, c);
  }
  fillRect(r, size * 0.3, size * 0.2, size * 0.7, size * 0.85, [40, 90, 200]);
  return r;
}
