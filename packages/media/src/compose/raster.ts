/**
 * Deterministic raster preview of a composition manifest: the approved renditions are scaled to fit
 * their slots and composited over the white canvas. No inference and no browser are involved. A slot
 * without an image is drawn as a dashed outline with the garment's name and "NO PHOTO YET"; labelled
 * images (illustration, demo placeholder, shopping candidate, edited) carry their label on the image.
 */
import type { CompositionManifest } from "@garderobe/contracts/ext/media";
import { compositeOver, createRaster, resizeRaster, type Raster, type Rgb } from "../image/raster.ts";
import { LAYER_TAG } from "./manifest.ts";

/** 5x7 bitmap glyphs (rows top to bottom, 5 bits each) for labels on previews. */
const GLYPHS: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 27, 17], X: [17, 17, 10, 4, 10, 17, 17], Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31], "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31], "3": [30, 1, 1, 14, 1, 1, 30],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14], "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12], "-": [0, 0, 0, 31, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12], "/": [1, 1, 2, 4, 8, 16, 16], "+": [0, 4, 4, 31, 4, 4, 0], "'": [4, 4, 8, 0, 0, 0, 0], "?": [14, 17, 1, 2, 4, 0, 4],
};

/** Map text to the glyph set: accents are stripped, unknown characters become "?". */
export function labelText(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[\u2013\u2014]/g, "-").replace(/[^A-Z0-9 \-./+'?]/g, "?").replace(/\s+/g, " ").trim();
}

export function textWidth(text: string, scale: number): number {
  return text.length * 6 * scale - scale;
}

export function drawText(dst: Raster, text: string, x: number, y: number, scale: number, colour: Rgb): void {
  let cx = Math.round(x);
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (!(glyph[row]! & (16 >> col))) continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = cx + col * scale + dx, py = Math.round(y) + row * scale + dy;
              if (px < 0 || py < 0 || px >= dst.width || py >= dst.height) continue;
              const i = (py * dst.width + px) * 4;
              dst.data[i] = colour[0];
              dst.data[i + 1] = colour[1];
              dst.data[i + 2] = colour[2];
              dst.data[i + 3] = 255;
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

function drawCentred(dst: Raster, text: string, centreX: number, y: number, maxWidth: number, colour: Rgb, preferred = 2): void {
  let label = labelText(text);
  let scale = preferred;
  while (scale > 1 && textWidth(label, scale) > maxWidth) scale--;
  const maxChars = Math.max(3, Math.floor((maxWidth + scale) / (6 * scale)));
  if (label.length > maxChars) label = `${label.slice(0, maxChars - 1).trimEnd()}.`;
  drawText(dst, label, centreX - textWidth(label, scale) / 2, y, scale, colour);
}

function dashedRect(dst: Raster, x: number, y: number, w: number, h: number, colour: Rgb): void {
  const set = (px: number, py: number): void => {
    if (px < 0 || py < 0 || px >= dst.width || py >= dst.height) return;
    const i = (py * dst.width + px) * 4;
    dst.data[i] = colour[0];
    dst.data[i + 1] = colour[1];
    dst.data[i + 2] = colour[2];
    dst.data[i + 3] = 255;
  };
  for (let i = 0; i < w; i++) {
    if (i % 14 < 8) for (let t = 0; t < 2; t++) {
      set(x + i, y + t);
      set(x + i, y + h - 1 - t);
    }
  }
  for (let i = 0; i < h; i++) {
    if (i % 14 < 8) for (let t = 0; t < 2; t++) {
      set(x + t, y + i);
      set(x + w - 1 - t, y + i);
    }
  }
}

function parseHex(colour: string): Rgb {
  return [parseInt(colour.slice(1, 3), 16), parseInt(colour.slice(3, 5), 16), parseInt(colour.slice(5, 7), 16)];
}

/** Composite the manifest. `images` maps rendition IDs to decoded rasters; a layer whose image is absent from the map is drawn as missing. */
export function renderRaster(manifest: CompositionManifest, images: Map<string, Raster>): Raster {
  const { width: W, height: H } = manifest.canvas;
  const bg = parseHex(manifest.canvas.background);
  const canvas = createRaster(W, H, [bg[0], bg[1], bg[2], 255]);
  for (const layer of [...manifest.layers].sort((a, b) => a.z - b.z)) {
    const x = Math.round(layer.x * W), y = Math.round(layer.y * H), w = Math.round(layer.width * W), h = Math.round(layer.height * H);
    const image = layer.renditionId ? images.get(layer.renditionId) : undefined;
    const tag = LAYER_TAG[layer.imageLabel];
    if (image) {
      // Contain: the whole garment is always visible, centred in its slot, never stretched.
      const scale = Math.min(w / image.width, h / image.height);
      const dw = Math.max(1, Math.round(image.width * scale)), dh = Math.max(1, Math.round(image.height * scale));
      const dx = x + Math.round((w - dw) / 2), dy = y + Math.round((h - dh) / 2);
      compositeOver(canvas, resizeRaster(image, dw, dh), dx, dy);
      if (tag) drawCentred(canvas, tag, x + w / 2, Math.min(H - 16, dy + dh + 4), W - 8, [107, 107, 107], 2);
    } else {
      dashedRect(canvas, x, y, w, h, [189, 189, 189]);
      drawCentred(canvas, layer.name, x + w / 2, y + h / 2 - 18, w - 12, [60, 60, 60], 2);
      drawCentred(canvas, tag ?? "NO PHOTO YET", x + w / 2, y + h / 2 + 4, w - 12, [107, 107, 107], 2);
    }
  }
  return canvas;
}
