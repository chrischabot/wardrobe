/** RGBA raster with straight (non-premultiplied) alpha, row-major. All operations are deterministic. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Rgb = [number, number, number];

export function createRaster(width: number, height: number, fill?: [number, number, number, number]): Raster {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill && (fill[0] | fill[1] | fill[2] | fill[3]) !== 0) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = fill[3];
    }
  }
  return { width: w, height: h, data };
}

export function cloneRaster(src: Raster): Raster {
  return { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
}

/** Aspect-preserving fit inside a box. Never upscales; each edge is at least 1. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Resize. Shrinking uses an exact area average, enlarging uses bilinear interpolation. Colour is
 * averaged alpha-weighted (premultiplied) so transparent pixels never bleed their colour into edges.
 */
export function resizeRaster(src: Raster, width: number, height: number): Raster {
  const dw = Math.max(1, Math.floor(width));
  const dh = Math.max(1, Math.floor(height));
  if (dw === src.width && dh === src.height) return cloneRaster(src);
  const out = createRaster(dw, dh);
  const s = src.data;
  const d = out.data;
  const xRatio = src.width / dw;
  const yRatio = src.height / dh;
  if (xRatio >= 1 && yRatio >= 1) {
    for (let y = 0; y < dh; y++) {
      const y0 = y * yRatio;
      const y1 = Math.min(src.height, (y + 1) * yRatio);
      for (let x = 0; x < dw; x++) {
        const x0 = x * xRatio;
        const x1 = Math.min(src.width, (x + 1) * xRatio);
        let r = 0, g = 0, b = 0, a = 0, area = 0;
        for (let sy = Math.floor(y0); sy < y1; sy++) {
          const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
          if (wy <= 0) continue;
          for (let sx = Math.floor(x0); sx < x1; sx++) {
            const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
            if (wx <= 0) continue;
            const w = wx * wy;
            const i = (sy * src.width + sx) * 4;
            const alpha = s[i + 3]! * w;
            r += s[i]! * alpha;
            g += s[i + 1]! * alpha;
            b += s[i + 2]! * alpha;
            a += alpha;
            area += w;
          }
        }
        const o = (y * dw + x) * 4;
        if (a > 0) {
          d[o] = Math.round(r / a);
          d[o + 1] = Math.round(g / a);
          d[o + 2] = Math.round(b / a);
        }
        d[o + 3] = area > 0 ? Math.round(a / area) : 0;
      }
    }
    return out;
  }
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = fx - x0;
      let r = 0, g = 0, b = 0, a = 0;
      const taps: [number, number, number][] = [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x1, y0, tx * (1 - ty)],
        [x0, y1, (1 - tx) * ty],
        [x1, y1, tx * ty],
      ];
      for (const [sx, sy, w] of taps) {
        const i = (sy * src.width + sx) * 4;
        const alpha = s[i + 3]! * w;
        r += s[i]! * alpha;
        g += s[i + 1]! * alpha;
        b += s[i + 2]! * alpha;
        a += alpha;
      }
      const o = (y * dw + x) * 4;
      if (a > 0) {
        d[o] = Math.round(r / a);
        d[o + 1] = Math.round(g / a);
        d[o + 2] = Math.round(b / a);
      }
      d[o + 3] = Math.round(a);
    }
  }
  return out;
}

/** Crop; the rectangle is clamped to the source bounds (result is at least 1x1). */
export function cropRaster(src: Raster, x: number, y: number, width: number, height: number): Raster {
  const x0 = Math.min(src.width - 1, Math.max(0, Math.floor(x)));
  const y0 = Math.min(src.height - 1, Math.max(0, Math.floor(y)));
  const w = Math.max(1, Math.min(src.width - x0, Math.floor(width)));
  const h = Math.max(1, Math.min(src.height - y0, Math.floor(height)));
  const out = createRaster(w, h);
  for (let row = 0; row < h; row++) {
    const start = ((y0 + row) * src.width + x0) * 4;
    out.data.set(src.data.subarray(start, start + w * 4), row * w * 4);
  }
  return out;
}

export function rotateRaster(src: Raster, quarterTurnsClockwise: 0 | 1 | 2 | 3): Raster {
  if (quarterTurnsClockwise === 0) return cloneRaster(src);
  const swap = quarterTurnsClockwise % 2 === 1;
  const out = createRaster(swap ? src.height : src.width, swap ? src.width : src.height);
  const { width: w, height: h } = src;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number, dy: number;
      if (quarterTurnsClockwise === 1) {
        dx = h - 1 - y;
        dy = x;
      } else if (quarterTurnsClockwise === 2) {
        dx = w - 1 - x;
        dy = h - 1 - y;
      } else {
        dx = y;
        dy = w - 1 - x;
      }
      const i = (y * w + x) * 4;
      const o = (dy * out.width + dx) * 4;
      out.data[o] = src.data[i]!;
      out.data[o + 1] = src.data[i + 1]!;
      out.data[o + 2] = src.data[i + 2]!;
      out.data[o + 3] = src.data[i + 3]!;
    }
  }
  return out;
}

/** Mirror: "h" flips left-right, "v" flips top-bottom. */
export function flipRaster(src: Raster, axis: "h" | "v"): Raster {
  const out = createRaster(src.width, src.height);
  const { width: w, height: h } = src;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const o = ((axis === "v" ? h - 1 - y : y) * w + (axis === "h" ? w - 1 - x : x)) * 4;
      out.data[o] = src.data[i]!;
      out.data[o + 1] = src.data[i + 1]!;
      out.data[o + 2] = src.data[i + 2]!;
      out.data[o + 3] = src.data[i + 3]!;
    }
  }
  return out;
}

/** Turn stored pixels upright according to the EXIF Orientation tag (1..8). Other values return the source. */
export function applyExifOrientation(src: Raster, orientation: number): Raster {
  switch (orientation) {
    case 2:
      return flipRaster(src, "h");
    case 3:
      return rotateRaster(src, 2);
    case 4:
      return flipRaster(src, "v");
    case 5:
      return flipRaster(rotateRaster(src, 1), "h");
    case 6:
      return rotateRaster(src, 1);
    case 7:
      return flipRaster(rotateRaster(src, 3), "h");
    case 8:
      return rotateRaster(src, 3);
    default:
      return src;
  }
}

/** Source-over composite of `src` onto `dst` at an integer offset, clipped to `dst`. */
export function compositeOver(dst: Raster, src: Raster, x: number, y: number): void {
  const ox = Math.round(x);
  const oy = Math.round(y);
  for (let sy = 0; sy < src.height; sy++) {
    const dy = sy + oy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = sx + ox;
      if (dx < 0 || dx >= dst.width) continue;
      const i = (sy * src.width + sx) * 4;
      const sa = src.data[i + 3]! / 255;
      if (sa === 0) continue;
      const o = (dy * dst.width + dx) * 4;
      const da = dst.data[o + 3]! / 255;
      const outA = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst.data[o + c] = Math.round((src.data[i + c]! * sa + dst.data[o + c]! * da * (1 - sa)) / outA);
      }
      dst.data[o + 3] = Math.round(outA * 255);
    }
  }
}

/** Bounding box of pixels whose alpha exceeds the threshold, or null when there are none. */
export function alphaBounds(src: Raster, alphaThreshold = 8): { x: number; y: number; width: number; height: number } | null {
  let minX = src.width, minY = src.height, maxX = -1, maxY = -1;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.data[(y * src.width + x) * 4 + 3]! > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
