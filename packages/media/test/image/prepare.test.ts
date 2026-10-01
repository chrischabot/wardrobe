import { describe, expect, it } from "vitest";
import { compositeOver, correctLighting, createRaster, cropUniformBorders, highlightLevel, PREPARE_THRESHOLDS, uniformBackgroundCutout, type Raster } from "../../src/image/index.ts";
import { fillRect, syntheticClutteredPhoto, syntheticShirt } from "../../src/testing/index.ts";

// SYNTHETIC TEST IMAGES throughout.

function framed(inner: Raster, bars: { top?: number; right?: number; bottom?: number; left?: number }, colour: [number, number, number] = [0, 0, 0]): Raster {
  const t = bars.top ?? 0, r = bars.right ?? 0, b = bars.bottom ?? 0, l = bars.left ?? 0;
  const out = createRaster(inner.width + l + r, inner.height + t + b, [colour[0], colour[1], colour[2], 255]);
  compositeOver(out, inner, l, t);
  return out;
}

function dimmed(src: Raster, factor: number): Raster {
  const out: Raster = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(out.data[i + c]! * factor);
  return out;
}

const pixel = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3)];

describe("cropping flat neutral bars before editing", () => {
  it("removes letterbox and pillarbox bars and keeps every pixel of the picture", () => {
    const shirt = syntheticShirt({ size: 200 });
    const letterboxed = cropUniformBorders(framed(shirt, { top: 30, bottom: 30 }));
    expect(letterboxed).toMatchObject({ changed: true, box: { x: 0, y: 30, width: 200, height: 200 }, removed: { top: 30, right: 0, bottom: 30, left: 0 }, maxDeviation: 0 });
    expect(letterboxed.raster.data).toEqual(shirt.data); // exactly the source pixels, nothing resampled
    const boxed = cropUniformBorders(framed(shirt, { top: 12, right: 20, bottom: 8, left: 16 }, [128, 128, 128]));
    expect(boxed.removed).toEqual({ top: 12, right: 20, bottom: 8, left: 16 });
    expect(boxed.raster.data).toEqual(shirt.data);
    // With the bars gone the garment can be cut out from its own pixels, which the bars prevented.
    expect(uniformBackgroundCutout(framed(shirt, { top: 30, bottom: 30 })).ok).toBe(false);
    expect(uniformBackgroundCutout(letterboxed.raster).ok).toBe(true);
    // Slight noise in a bar (compression) is tolerated and reported.
    const noisy = framed(shirt, { top: 30, bottom: 30 }, [4, 4, 4]);
    fillRect(noisy, 50, 10, 60, 12, [10, 9, 11]);
    expect(cropUniformBorders(noisy)).toMatchObject({ changed: true, removed: { top: 30, bottom: 30 }, maxDeviation: 7 });
  });

  it("never cuts into the photograph: plain margins, coloured edges and whole-frame colours are left alone", () => {
    const shirt = syntheticShirt({ size: 200 });
    // A plain white margin around the garment is part of the photograph (the next row is still mostly margin).
    expect(cropUniformBorders(shirt)).toMatchObject({ changed: false, reason: "no flat neutral bars were found" });
    expect(cropUniformBorders(shirt).raster).toBe(shirt);
    // A flat COLOURED edge may be a wall or a door, not a bar: only neutral bars are removed.
    expect(cropUniformBorders(syntheticClutteredPhoto(256)).changed).toBe(false);
    expect(cropUniformBorders(framed(shirt, { top: 30, bottom: 30 }, [40, 90, 200])).changed).toBe(false);
    // A blank frame, a hairline and bars that are most of the image are not borders.
    expect(cropUniformBorders(createRaster(100, 100, [255, 255, 255, 255])).changed).toBe(false);
    expect(cropUniformBorders(framed(shirt, { top: 1 })).changed).toBe(false);
    expect(cropUniformBorders(framed(syntheticShirt({ size: 64 }), { top: 80, bottom: 80 }))).toMatchObject({ changed: false, reason: "the bars cover too much of the frame to be a border" });
    expect(cropUniformBorders(createRaster(8, 8, [0, 0, 0, 255])).changed).toBe(false);
  });
});

describe("lighting correction before editing", () => {
  it("leaves a normally exposed photograph untouched", () => {
    const photo = syntheticClutteredPhoto(128);
    const result = correctLighting(photo);
    expect(result).toMatchObject({ needed: false, applied: false, gain: 1, verdict: "not_needed", checks: [] });
    expect(result.raster).toBe(photo);
    expect(highlightLevel(photo)).toBeGreaterThanOrEqual(PREPARE_THRESHOLDS.underexposedBelow);
  });

  it("brightens an underexposed photograph with one gain for all channels, keeping every hue, and reports the checks", () => {
    const dark = dimmed(syntheticClutteredPhoto(128), 0.7);
    const result = correctLighting(dark);
    expect(result).toMatchObject({ needed: true, applied: true, verdict: "passed", failed: [] });
    expect(result.gain).toBeGreaterThan(1.3);
    expect(result.gain).toBeLessThanOrEqual(PREPARE_THRESHOLDS.maxGain);
    expect(result.checks.map((c) => [c.name, c.passed])).toEqual([["gain_within_cap", true], ["clipped_highlights", true], ["hue_preserved", true]]);
    expect(result.raster).not.toBe(dark);
    expect(dark.data).toEqual(dimmed(syntheticClutteredPhoto(128), 0.7).data); // the source is not modified
    expect(highlightLevel(result.raster)).toBeGreaterThanOrEqual(240);
    // The same factor on red, green and blue: channel ratios (the colour) are unchanged.
    for (const [x, y] of [[4, 64], [40, 30], [64, 64], [100, 100]] as const) {
      const before = pixel(dark, x, y), after = pixel(result.raster, x, y);
      for (let c = 0; c < 3; c++) expect(Math.abs(after[c]! - before[c]! * result.gain)).toBeLessThanOrEqual(0.51);
    }
    // Deterministic.
    expect(correctLighting(dark).raster.data).toEqual(result.raster.data);
  });

  it("caps the gain for a very dark photograph instead of inventing detail", () => {
    const result = correctLighting(dimmed(syntheticClutteredPhoto(128), 0.3));
    expect(result).toMatchObject({ applied: true, gain: PREPARE_THRESHOLDS.maxGain });
    expect(result.checks[0]!.detail).toMatch(/would be needed to reach full brightness; capped/);
    expect(highlightLevel(result.raster)).toBeLessThan(150); // still dark: brighter, not falsified
  });

  it("discards a correction that would burn out highlights and returns the source", () => {
    const dark = dimmed(syntheticClutteredPhoto(256), 0.45);
    fillRect(dark, 4, 4, 27, 27, [205, 200, 190]); // a small bright reflection: under 1% of the frame
    const result = correctLighting(dark);
    expect(result).toMatchObject({ needed: true, applied: false, verdict: "failed", failed: ["clipped_highlights"] });
    expect(result.raster).toBe(dark);
    const clipping = result.checks.find((c) => c.name === "clipped_highlights")!;
    expect(clipping.score).toBeGreaterThan(PREPARE_THRESHOLDS.maxNewlyClippedShare);
    expect(clipping.detail).toMatch(/% of pixels would lose highlight detail/);
  });

  it("ignores transparent pixels when judging exposure", () => {
    const cut = dimmed(syntheticShirt({ size: 128 }), 0.6);
    for (let i = 0; i < cut.data.length; i += 4) if (cut.data[i]! > 140 && cut.data[i + 1]! > 140 && cut.data[i + 2]! > 140) cut.data[i + 3] = 0; // the (dimmed) white background made transparent
    const result = correctLighting(cut);
    expect(result.needed).toBe(true);
    for (let i = 3; i < cut.data.length; i += 4) expect(result.raster.data[i]).toBe(cut.data[i]); // alpha untouched
  });
});
