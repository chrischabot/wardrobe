import { beforeAll, describe, expect, it } from "vitest";
import { outfitValidator, registerDaily } from "@garderobe/daily";
import { listInventory, sha256Hex } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import type { Role } from "@garderobe/contracts";
import { composeOutfit, getComposition, openCompositePreview, requestCompositePreview } from "../src/index.ts";
import { decodePng } from "../src/image/index.ts";
import { createMediaHarness, type MediaHarness } from "../src/testing/index.ts";

// The committed example under examples/real-owner-outfit/ is an outfit preview of four of the owner's REAL
// garments, imported from requirements/wardrobe_inventory_clean.csv through the ordinary command service.
// No photograph of any real garment exists, so every piece in it is a labelled placeholder (an outline, the
// garment's name and NO PHOTO YET). This test draws the preview again through the real path (command, local
// queue, compositor, private local R2) and holds the committed files to it.
//
// To write the files again after an intended change: node tools/composite-example.mjs   (in packages/media)
//
// UNTIL THE FILES ARE COMMITTED (they have to come out of a real run of this test, never be written by
// hand): the comparison with the committed files is reported as SKIPPED, not passed, and the run prints the
// three files so they can be taken from it. Everything else in this file runs either way.

declare const __EMIT_COMPOSITE_EXAMPLE__: boolean;

const DIR = "../examples/real-owner-outfit/";
const committed = import.meta.glob("../examples/real-owner-outfit/*.{json,svg}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const NOT_COMMITTED_YET = Object.keys(committed).length === 0;

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

describe("the committed example of an outfit preview from the owner's real garments", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  let slots: { role: Role; garmentId: string }[];
  let names: Map<string, string>;
  let files: { json: string; svg: string; png: Uint8Array };
  let manifestHash: string;

  beforeAll(async () => {
    h = await createMediaHarness({ adapters: { validator: outfitValidator }, extend: (registry) => registerDaily(registry) });
    owner = (await h.createRealOwner()).owner;
    const inventory = await listInventory(h.db, owner.principal(), {}, { nowMs: h.clock.now() });
    names = new Map(inventory.items.map((i) => [i.garment.garmentId, i.garment.name]));
    // A fixed choice, independent of the day: the first piece by name for each role (sneakers for footwear,
    // the only footwear the owner's standing restriction allows).
    const first = (role: Role, name?: RegExp) => {
      const found = inventory.items
        .filter((i) => i.garment.roles.includes(role) && (!name || name.test(i.garment.name)))
        .sort((a, b) => (a.garment.name < b.garment.name ? -1 : a.garment.name > b.garment.name ? 1 : a.garment.garmentId < b.garment.garmentId ? -1 : 1))[0];
      if (!found) throw new Error(`the real inventory has no garment for the role ${role}`);
      return { role, garmentId: found.garment.garmentId };
    };
    slots = [first("top"), first("bottom"), first("footwear", /^NB 990v4/), first("socks")];

    const composition = await composeOutfit(h.rt, owner.principal(), { slots });
    manifestHash = (await requestCompositePreview(h.rt, owner.principal(), { slots })).manifestHash;
    await h.settle(owner);
    const stored = await getComposition(h.rt, owner.principal(), manifestHash);
    expect(stored.preview.state).toBe("rendered");
    const svg = await new Response((await openCompositePreview(h.rt, owner.principal(), manifestHash, "svg")).body).text();
    const png = new Uint8Array(await new Response((await openCompositePreview(h.rt, owner.principal(), manifestHash)).body).arrayBuffer());
    const raster = await decodePng(png);
    const json =
      JSON.stringify(
        {
          title: "Outfit preview of four real owner garments",
          note: "The garments are the owner's own, imported from requirements/wardrobe_inventory_clean.csv. No photograph of any of them exists, so every piece is a labelled placeholder: an outline, the garment's name and NO PHOTO YET. Nothing in this example is a picture of a garment, and none was invented.",
          writtenBy: "packages/media/tools/composite-example.mjs",
          checkedBy: "packages/media/test/composite-example.test.ts",
          slots: slots.map((s) => ({ role: s.role, garmentId: s.garmentId, name: names.get(s.garmentId) })),
          labels: composition.labels,
          manifestHash,
          manifest: composition.manifest,
          preview: { renderer: "garderobe-compositor-1", width: raster.width, height: raster.height, pixelsSha256: await sha256Hex(new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength)), svgSha256: await sha256Hex(svg) },
        },
        null,
        2,
      ) + "\n";
    files = { json, svg, png };
    if (__EMIT_COMPOSITE_EXAMPLE__ || NOT_COMMITTED_YET) {
      // Read by tools/composite-example.mjs (or from the log of a run), which stores the three files unchanged.
      console.log(`composite example: manifest hash ${manifestHash}`);
      const encoder = new TextEncoder();
      for (const [name, bytes] of [["example.json", encoder.encode(json)], ["preview.svg", encoder.encode(svg)], ["preview.png", png]] as const) console.log(`@@GARDEROBE-EXAMPLE-FILE:${name}:${base64(bytes)}@@`);
    }
  });

  it("shows the four real garments by name, each as a labelled placeholder, with no picture and no colour", async () => {
    const composition = await composeOutfit(h.rt, owner.principal(), { slots });
    expect(composition.labels).toEqual(["No photo yet"]);
    expect(composition.manifest.layers).toHaveLength(4);
    expect(composition.manifest.layers.every((l) => l.imageLabel === "missing" && l.assetId === null && l.renditionId === null)).toBe(true);
    for (const s of slots) {
      expect(names.get(s.garmentId)).toBeTruthy();
      expect(composition.manifest.caption).toContain(`${names.get(s.garmentId)} (no photo yet)`);
    }
    expect(files.svg).not.toContain("<image");
    expect(files.svg.match(/NO PHOTO YET/g)).toHaveLength(4);
    const raster = await decodePng(files.png);
    expect([raster.width, raster.height]).toEqual([composition.manifest.canvas.width, composition.manifest.canvas.height]);
    let coloured = 0;
    for (let i = 0; i < raster.data.length; i += 4) if (Math.abs(raster.data[i]! - raster.data[i + 1]!) > 3 || Math.abs(raster.data[i + 1]! - raster.data[i + 2]!) > 3) coloured++;
    expect(coloured).toBe(0);
  });

  it("is deterministic: the same four garments give the same manifest hash, in any order", async () => {
    const again = await composeOutfit(h.rt, owner.principal(), { slots: [...slots].reverse() });
    expect(again.manifestHash).toBe(manifestHash);
    expect(again.preview.state).toBe("rendered");
    // Changing one piece changes the hash.
    const inventory = await listInventory(h.db, owner.principal(), {}, { nowMs: h.clock.now() });
    const otherTop = inventory.items.find((i) => i.garment.roles.includes("top") && i.garment.garmentId !== slots[0]!.garmentId)!;
    const changed = await composeOutfit(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: otherTop.garment.garmentId }, ...slots.slice(1)] });
    expect(changed.manifestHash).not.toBe(manifestHash);
  });

  it("TEMPORARY SCRATCH-BRANCH ONLY: fails on purpose so that the example files can be read from the log", () => {
    const e = new TextEncoder();
    throw new Error(`\nEXAMPLE-PNG ${base64(files.png)}\nEXAMPLE-JSON ${base64(e.encode(files.json))}\nEXAMPLE-SVG ${base64(e.encode(files.svg))}\nEXAMPLE-HASH ${manifestHash}\nEXAMPLE-END`);
  });

  it.skipIf(__EMIT_COMPOSITE_EXAMPLE__ || NOT_COMMITTED_YET)("equals the committed files: manifest, manifest hash, SVG scene and the pixels of the picture", async () => {
    expect(Object.keys(committed).sort(), "run `node tools/composite-example.mjs` in packages/media to write the example").toEqual([`${DIR}example.json`, `${DIR}preview.svg`]);
    expect(committed[`${DIR}preview.svg`]).toBe(files.svg);
    // Compared as text: the garment IDs, names, layout numbers, the manifest hash and the hash of the drawn pixels.
    expect(committed[`${DIR}example.json`]).toBe(files.json);
    expect(JSON.parse(committed[`${DIR}example.json`]!).manifestHash).toBe(manifestHash);
  });
});
