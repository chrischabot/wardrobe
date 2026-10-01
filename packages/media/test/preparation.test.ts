import { beforeAll, describe, expect, it } from "vitest";
import type { TestOwner } from "@garderobe/domain/testing";
import { getGarmentMedia, openAssetImage } from "../src/index.ts";
import type { ImageEditProvider } from "../src/index.ts";
import { compositeOver, createRaster, decodeImage, decodePng, encodePng, highlightLevel, type Raster } from "../src/image/index.ts";
import { createMediaHarness, fillRect, syntheticClutteredPhoto, syntheticShirt, type MediaHarness } from "../src/testing/index.ts";

// SYNTHETIC TEST IMAGES on synthetic fixture garments. The image editor is a TEST DOUBLE standing in for the
// image-editing model behind the model service; it records what it was sent.

/** A shirt-coloured subject on the cluttered scene's exact layout (as in pipeline.test.ts), so a faithful edit keeps the same silhouette. */
function clutteredShirtPhoto(): Raster {
  const shirt = syntheticShirt({ size: 256 });
  const scene = syntheticClutteredPhoto(256);
  for (let p = 0; p < 256 * 256; p++) {
    const white = shirt.data[p * 4]! > 250 && shirt.data[p * 4 + 1]! > 250 && shirt.data[p * 4 + 2]! > 250;
    if (!white) for (let c = 0; c < 4; c++) scene.data[p * 4 + c] = shirt.data[p * 4 + c]!;
  }
  return scene;
}

function dimmed(src: Raster, factor: number): Raster {
  const out: Raster = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(out.data[i + c]! * factor);
  return out;
}

describe("cropping and lighting correction precede generative editing (real local queue and R2)", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  const sent: Raster[] = [];
  const editor = (reply: "faithful" | "unavailable"): ImageEditProvider => ({
    name: "test-double-editor",
    async edit(request) {
      sent.push(await decodePng(request.image.bytes));
      if (reply === "unavailable") return { status: "failed", reason: "no capacity" };
      return { status: "ok", bytes: await encodePng(syntheticShirt({ size: 256 })), contentType: "image/png", model: "test-double-1", providerJobId: "job-1", reconstructsUnseen: false };
    },
  });
  const fixture = (id: string) => owner.exec("garment.create", { garmentId: id, name: `fixture ${id}`, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test fixture" } });

  beforeAll(async () => {
    h = await createMediaHarness();
    owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (preparation)" });
  });

  it("crops letterbox bars and then cuts the garment out from its own pixels, without calling the editing model", async () => {
    h.deps.imageEditor = editor("faithful");
    sent.length = 0;
    await fixture("prep-letterbox");
    const shirt = syntheticShirt({ size: 256 });
    const photo = createRaster(256, 336, [0, 0, 0, 255]);
    compositeOver(photo, shirt, 0, 40);
    const up = await h.upload(owner, { garmentId: "prep-letterbox", raster: photo });
    await h.settle(owner);
    h.deps.imageEditor = undefined;
    expect(sent).toHaveLength(0); // nothing generative was needed

    const media = await getGarmentMedia(h.rt, owner.principal(), "prep-letterbox");
    const asset = media.assets.find((a) => a.assetId === up.asset!.assetId)!;
    expect(asset.renditions.map((r) => r.kind).sort()).toEqual(["catalogue", "cutout", "mask", "original"]);
    const cutout = asset.renditions.find((r) => r.kind === "cutout")!;
    expect(cutout.transformations.map((t) => t.step)).toEqual(["decode", "crop_uniform_borders", "uniform_background_flood_fill"]);
    expect(cutout.transformations.every((t) => !t.generative)).toBe(true);
    expect(cutout.edited).toBe(false);
    const crop = cutout.transformations.find((t) => t.step === "crop_uniform_borders")!;
    expect(crop.params).toMatchObject({ from: [256, 336], box: { x: 0, y: 40, width: 256, height: 256 }, removed: { top: 40, right: 0, bottom: 40, left: 0 }, fidelity: { verdict: "passed", score: 0, sourcePixelsPreserved: true } });
    expect([cutout.width, cutout.height]).toEqual([256, 256]);
    // The cutout passed the ordinary fidelity check against the cropped photograph, and its pixels are the source's.
    expect(asset.fidelity).toHaveLength(1);
    expect(asset.fidelity[0]).toMatchObject({ subject: "cutout", verdict: "passed", renditionId: cutout.renditionId });
    const stored = await decodePng(new Uint8Array(await new Response((await openAssetImage(h.rt, owner.principal(), asset.assetId, { variant: "cutout" })).body).arrayBuffer()));
    const at = (128 * 256 + 100) * 4;
    expect([...stored.data.subarray(at, at + 4)]).toEqual([...shirt.data.subarray(at, at + 3), 255]);
    expect(stored.data[3]).toBe(0);
    expect(media.lastFailure).toBeNull();
    // The original is untouched: bars and all.
    const original = (await decodeImage(new Uint8Array(await new Response((await openAssetImage(h.rt, owner.principal(), asset.assetId, { variant: "original" })).body).arrayBuffer()))).raster;
    expect([original.width, original.height]).toEqual([256, 336]);
  });

  it("brightens an underexposed photo before the editor sees it and records the correction with its check", async () => {
    h.deps.imageEditor = editor("faithful");
    sent.length = 0;
    await fixture("prep-dark");
    const dark = dimmed(clutteredShirtPhoto(), 0.7);
    const up = await h.upload(owner, { garmentId: "prep-dark", raster: dark });
    await h.settle(owner);
    h.deps.imageEditor = undefined;

    // The editor received the actual photograph, corrected: brighter than what was uploaded, same size.
    expect(sent).toHaveLength(1);
    expect([sent[0]!.width, sent[0]!.height]).toEqual([256, 256]);
    expect(highlightLevel(dark)).toBeLessThan(200);
    expect(highlightLevel(sent[0]!)).toBeGreaterThanOrEqual(240);

    const media = await getGarmentMedia(h.rt, owner.principal(), "prep-dark");
    const asset = media.assets.find((a) => a.assetId === up.asset!.assetId)!;
    const edited = asset.renditions.find((r) => r.kind === "edited")!;
    expect(edited.transformations.map((t) => t.step)).toEqual(["decode", "lighting_correction", "image_model_edit"]);
    const lighting = edited.transformations.find((t) => t.step === "lighting_correction")!;
    expect(lighting.generative).toBe(false);
    expect(lighting.params).toMatchObject({ applied: true, fidelity: { verdict: "passed", failed: [] } });
    expect((lighting.params as { gain: number }).gain).toBeGreaterThan(1.3);
    expect((lighting.params as { fidelity: { checks: { name: string }[] } }).fidelity.checks.map((c) => c.name)).toEqual(["gain_within_cap", "clipped_highlights", "hue_preserved"]);
    // The edit was still checked, and everything downstream carries the history and the edited flag.
    expect(asset.fidelity.find((f) => f.subject === "edit")).toMatchObject({ verdict: "passed", renditionId: edited.renditionId });
    const cutout = asset.renditions.find((r) => r.kind === "cutout")!;
    expect(cutout.transformations.map((t) => t.step)).toEqual(["decode", "lighting_correction", "image_model_edit", "uniform_background_flood_fill"]);
    expect(cutout.edited).toBe(true);
    expect(media.image.displayLabel).toBe("Edited");
  });

  it("discards a lighting correction that fails its check, says so, and sends the photo as taken", async () => {
    h.deps.imageEditor = editor("unavailable");
    sent.length = 0;
    await fixture("prep-highlight");
    const dark = dimmed(clutteredShirtPhoto(), 0.45);
    fillRect(dark, 4, 4, 27, 27, [205, 200, 190]); // a small bright reflection
    const up = await h.upload(owner, { garmentId: "prep-highlight", raster: dark });
    await h.settle(owner);
    h.deps.imageEditor = undefined;

    expect(sent).toHaveLength(1);
    expect(sent[0]!.data).toEqual(dark.data); // exactly the uploaded pixels: the failed correction was not used

    const media = await getGarmentMedia(h.rt, owner.principal(), "prep-highlight");
    expect(media.lastFailure).toMatch(/The lighting correction failed its check \(clipped highlights\) and was discarded; the photo was used as taken/);
    expect(media.lastFailure).toMatch(/could not produce a catalogue view: no capacity/);
    const asset = media.assets.find((a) => a.assetId === up.asset!.assetId)!;
    expect(asset.statusReason).toBe(media.lastFailure);
    // The honest photo is kept as a display copy, and the discarded step is on its record with the failed check.
    expect(asset.renditions.map((r) => r.kind).sort()).toEqual(["display", "original"]);
    const display = asset.renditions.find((r) => r.kind === "display")!;
    const step = display.transformations.find((t) => t.step === "lighting_correction")!;
    expect(step.params).toMatchObject({ applied: false, fidelity: { verdict: "failed", failed: ["clipped_highlights"] } });
    expect(display.edited).toBe(false);
    const shown = (await decodeImage(new Uint8Array(await new Response((await openAssetImage(h.rt, owner.principal(), asset.assetId)).body).arrayBuffer()))).raster;
    expect(highlightLevel(shown)).toBeLessThan(140); // still as dark as it was taken
    expect(media.imageState).toBe("resolved");
  });
});
