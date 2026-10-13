import { describe, expect, it } from "vitest";
import {
  alphaBounds, catalogueView, checkFidelity, cloneRaster, colourDistributionDistance, createRaster, deltaE, dominantColours, FIDELITY_THRESHOLDS, uniformBackgroundCutout, type Raster,
} from "../../src/image/index.ts";
import { fillRect, syntheticClutteredPhoto, syntheticShirt, syntheticShoes, syntheticTrousers } from "../../src/testing/fixtures.ts";

// Every image here is a SYNTHETIC TEST IMAGE drawn in code; none depicts a real garment.

function px(r: Raster, x: number, y: number): number[] {
  const i = (y * r.width + x) * 4;
  return [...r.data.subarray(i, i + 4)];
}

function cut(r: Raster): Raster {
  const out = uniformBackgroundCutout(r);
  if (!out.ok) throw new Error(`cutout declined: ${out.reason}`);
  return out.raster;
}

describe("uniformBackgroundCutout", () => {
  it("removes the background and keeps every garment pixel exactly as photographed", () => {
    const shirt = syntheticShirt({ buttonColour: [255, 255, 255] }); // white buttons enclosed by the body
    const out = uniformBackgroundCutout(shirt);
    if (!out.ok) throw new Error(out.reason);
    expect(px(out.raster, 2, 2)[3]).toBe(0);
    expect(px(out.raster, 100, 150)).toEqual(px(shirt, 100, 150)); // interior: untouched RGB, opaque
    expect(px(out.raster, 128, 64)).toEqual([255, 255, 255, 255]); // background-coloured button inside the garment is kept
    expect(out.method).toBe("uniform_background_flood_fill");
    expect(out.background).toEqual([255, 255, 255]);
    expect(out.touchesEdge).toBe(false);
    expect(out.foregroundShare).toBeGreaterThan(0.3);
    // No kept pixel had its colour changed.
    for (let p = 0; p < shirt.width * shirt.height; p++) {
      if (out.raster.data[p * 4 + 3]! > 0) {
        expect(out.raster.data[p * 4]).toBe(shirt.data[p * 4]);
        expect(out.raster.data[p * 4 + 2]).toBe(shirt.data[p * 4 + 2]);
      }
    }
    expect(px(out.mask, 100, 150)).toEqual([255, 255, 255, 255]);
  });

  it("declines a cluttered background instead of guessing", () => {
    expect(uniformBackgroundCutout(syntheticClutteredPhoto())).toMatchObject({ ok: false, reason: "background_not_uniform" });
  });

  it("declines a blank frame, a frame-filling subject and an already transparent image", () => {
    expect(uniformBackgroundCutout(createRaster(64, 64, [250, 250, 250, 255]))).toMatchObject({ ok: false, reason: "no_foreground" });
    const full = createRaster(64, 64, [255, 255, 255, 255]);
    fillRect(full, 1, 1, 63, 63, [10, 80, 10]);
    expect(uniformBackgroundCutout(full)).toMatchObject({ ok: false, reason: "foreground_fills_frame" });
    expect(uniformBackgroundCutout(cut(syntheticShirt()))).toMatchObject({ ok: false, reason: "already_transparent" });
  });

  it("reports a garment that runs off the frame", () => {
    const out = uniformBackgroundCutout(syntheticShirt({ shiftX: 60 }));
    expect(out.ok && out.touchesEdge).toBe(true);
  });
});

describe("colour analysis", () => {
  it("finds dominant colours of the foreground only, deterministically", () => {
    const shirt = cut(syntheticShirt({ stripe: null, buttons: false, pocket: false }));
    const a = dominantColours(shirt);
    expect(a).toEqual(dominantColours(shirt));
    expect(a[0]!.share).toBeGreaterThan(0.95);
    expect(deltaE(a[0]!.rgb, [40, 90, 200])).toBeLessThan(2);
    expect(dominantColours(createRaster(8, 8))).toEqual([]);
  });

  it("separates different colourways and tolerates a small lighting change", () => {
    const blue = dominantColours(cut(syntheticShirt()));
    const green = dominantColours(cut(syntheticShirt({ body: [40, 150, 70] })));
    const slightlyBrighter = dominantColours(cut(syntheticShirt({ body: [42, 94, 209] })));
    expect(colourDistributionDistance(blue, blue)).toBe(0);
    expect(colourDistributionDistance(blue, green)).toBeGreaterThan(20);
    expect(colourDistributionDistance(blue, slightlyBrighter)).toBeLessThan(FIDELITY_THRESHOLDS.paletteDistance);
    // Navy versus black and rust versus brown are different colourways.
    const solid = (rgb: [number, number, number]) => dominantColours(createRaster(8, 8, [...rgb, 255]));
    expect(colourDistributionDistance(solid([20, 30, 70]), solid([15, 15, 18]))).toBeGreaterThan(FIDELITY_THRESHOLDS.paletteDistance);
    expect(colourDistributionDistance(solid([170, 75, 35]), solid([105, 70, 45]))).toBeGreaterThan(FIDELITY_THRESHOLDS.paletteDistance);
  });
});

describe("checkFidelity", () => {
  const original = syntheticShirt();

  it("passes a faithful cutout on all six checks", () => {
    const report = checkFidelity(original, cut(original), { mode: "cutout" });
    expect(report.failed).toEqual([]);
    expect(report.verdict).toBe("passed");
    expect(report.checks.map((c) => c.name).sort()).toEqual(["clipping", "dominant_colours", "garment_identity", "halos", "important_details", "missing_components"]);
    expect(report.algorithmVersion).toBe("fidelity-1");
  });

  it("passes a mild brightness correction of an edit", () => {
    const brighter = cloneRaster(original);
    for (let i = 0; i < brighter.data.length; i += 4) {
      if (brighter.data[i]! > 250 && brighter.data[i + 1]! > 250) continue; // leave the white background
      for (let c = 0; c < 3; c++) brighter.data[i + c] = Math.min(255, Math.round(brighter.data[i + c]! * 1.04));
    }
    expect(checkFidelity(original, brighter, { mode: "edit" }).failed).toEqual([]);
  });

  it("rejects a changed colourway", () => {
    const report = checkFidelity(original, syntheticShirt({ body: [40, 150, 70] }), { mode: "edit" });
    expect(report.verdict).toBe("failed");
    expect(report.failed).toContain("dominant_colours");
  });

  it("rejects a different cut (sleeves shortened)", () => {
    const report = checkFidelity(original, syntheticShirt({ sleeve: "short" }), { mode: "edit" });
    expect(report.failed).toContain("garment_identity");
  });

  it("rejects erased buttons and pocket", () => {
    const report = checkFidelity(original, syntheticShirt({ buttons: false, pocket: false }), { mode: "edit" });
    expect(report.failed).toContain("important_details");
    expect(report.failed).not.toContain("garment_identity");
  });

  it("rejects a changed pattern scale (stripe width doubled)", () => {
    const report = checkFidelity(original, syntheticShirt({ stripeWidth: 12 }), { mode: "edit" });
    expect(report.failed).toContain("important_details");
  });

  it("rejects a halo of leftover background around the cutout", () => {
    const clean = cut(original);
    const haloed = cloneRaster(clean);
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < clean.width && y < clean.height && clean.data[(y * clean.width + x) * 4 + 3]! > 0;
    for (let y = 0; y < clean.height; y++) {
      for (let x = 0; x < clean.width; x++) {
        if (solid(x, y)) continue;
        let near = false;
        for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3; dx++) if (solid(x + dx, y + dy)) { near = true; break; }
        if (near) haloed.data.set([255, 255, 255, 255], (y * clean.width + x) * 4);
      }
    }
    expect(checkFidelity(original, haloed, { mode: "cutout" }).failed).toContain("halos");
    expect(checkFidelity(original, clean, { mode: "cutout" }).checks.find((c) => c.name === "halos")!.score).toBe(0);
  });

  it("rejects a missing component (one shoe of a pair lost, a sleeve lost, a hole punched)", () => {
    const pair = syntheticShoes();
    expect(checkFidelity(pair, cut(syntheticShoes({ count: 1 })), { mode: "cutout" }).failed).toContain("missing_components");
    const noSleeve = cut(original);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 76; x++) noSleeve.data[(y * 256 + x) * 4 + 3] = 0;
    expect(checkFidelity(original, noSleeve, { mode: "cutout" }).failed).toContain("missing_components");
    const holed = cut(original);
    for (let y = 150; y < 175; y++) for (let x = 95; x < 120; x++) holed.data[(y * 256 + x) * 4 + 3] = 0;
    expect(checkFidelity(original, holed, { mode: "cutout" }).failed).toContain("missing_components");
  });

  it("rejects a derivative clipped by the frame", () => {
    const report = checkFidelity(original, cut(syntheticShirt({ shiftX: 60 })), { mode: "cutout" });
    expect(report.failed).toContain("clipping");
  });

  it("distinguishes trousers from shorts", () => {
    const report = checkFidelity(syntheticTrousers(), syntheticTrousers({ short: true }), { mode: "edit" });
    expect(report.failed).toContain("garment_identity");
  });

  it("says so when no independent silhouette exists rather than inventing a score", () => {
    const photo = syntheticClutteredPhoto();
    const derived = createRaster(256, 256);
    for (let y = 51; y < 218; y++) for (let x = 77; x < 179; x++) derived.data.set(photo.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4), (y * 256 + x) * 4);
    const check = checkFidelity(photo, derived, { mode: "cutout" }).checks.find((c) => c.name === "garment_identity")!;
    expect(check.detail).toMatch(/no independent silhouette/);
    expect(check.passed).toBe(true);
  });
});

describe("catalogueView", () => {
  it("centres the unchanged garment on an opaque neutral canvas with margins", () => {
    const cutout = cut(syntheticShirt({ size: 512 }));
    const view = catalogueView(cutout, { size: 600, shadow: false });
    expect([view.width, view.height]).toEqual([600, 600]);
    for (let i = 3; i < view.data.length; i += 4 * 997) expect(view.data[i]).toBe(255);
    expect(px(view, 5, 5)).toEqual([255, 255, 255, 255]);
    // Bounds of non-white content sit inside the 10% margins and are centred.
    const probe = createRaster(600, 600);
    for (let p = 0; p < 600 * 600; p++) if (view.data[p * 4]! < 250) probe.data[p * 4 + 3] = 255;
    const b = alphaBounds(probe)!;
    expect(b.x).toBeGreaterThanOrEqual(59);
    expect(b.x + b.width).toBeLessThanOrEqual(541);
    expect(Math.abs(b.x + b.width / 2 - 300)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.y + b.height / 2 - 300)).toBeLessThanOrEqual(2);
    expect(catalogueView(cutout, { size: 600 }).data).toEqual(catalogueView(cutout, { size: 600 }).data);
  });

  it("does not recolour the garment and never enlarges it more than twice", () => {
    const small = cut(syntheticShirt({ size: 64, stripe: null, buttons: false, pocket: false }));
    const view = catalogueView(small, { size: 1200, shadow: false });
    expect(px(view, 600, 600).slice(0, 3)).toEqual([40, 90, 200]);
    const probe = createRaster(1200, 1200);
    for (let p = 0; p < 1200 * 1200; p++) if (view.data[p * 4]! < 250) probe.data[p * 4 + 3] = 255;
    expect(alphaBounds(probe)!.width).toBeLessThanOrEqual(2 * alphaBounds(small)!.width + 2);
  });
});
