import { beforeAll, describe, expect, it } from "vitest";
import { all, first, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { CompositionManifest } from "@garderobe/contracts/ext/media";
import type { GarmentImageRef } from "@garderobe/contracts/ext/media";
import { buildManifest, composeOutfit, getComposition, getGarmentMedia, manifestHash, manifestLabels, openCompositePreview, renderRaster, renderSvg, requestCompositePreview, type ComposeSlot } from "../src/index.ts";
import { decodePng } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, syntheticShoes, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

// SYNTHETIC TEST IMAGES on synthetic fixture garments (labelled demo placeholders). No image model is involved anywhere.

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return isCommandError(e) ? e.code : `threw:${String(e)}`;
  }
}

const image = (garmentId: string, over: Partial<GarmentImageRef> = {}): GarmentImageRef => ({
  garmentId, hasRealImage: true, assetId: `ast_${garmentId}`, assetKind: "owner_photo", displayLabel: "Your photo", isDemo: false, renditionId: `rnd_${garmentId}`, renditionKind: "cutout", renditionVersion: 1,
  renditionSha256: "a".repeat(64), width: 800, height: 800, missingImageNote: null, ...over,
});
const slot = (role: ComposeSlot["role"], garmentId: string, name: string, category: string, extra: Partial<ComposeSlot> = {}): ComposeSlot => ({ role, garmentId, shoppingCandidateId: null, name, category, image: image(garmentId), ...extra });

const SHIRT = slot("top", "g-shirt", "blue oxford", "shirt");
const TROUSERS = slot("bottom", "g-trousers", "olive fatigues", "trousers");
const SHOES = slot("footwear", "g-shoes", "navy sneakers", "footwear");
const SOCKS = slot("socks", "g-socks", "grey socks", "socks");
const BELT = slot("belt", "g-belt", "brown belt", "belt");
const SCARF = slot("neckwear", "g-scarf", "navy scarf", "scarf");

describe("composition manifest (pure and deterministic)", () => {
  it("gives the same manifest and hash for the same pieces in any order, and a valid contract shape", async () => {
    const a = buildManifest([SHIRT, TROUSERS, SHOES, SOCKS, BELT]);
    const b = buildManifest([BELT, SOCKS, SHOES, TROUSERS, SHIRT]);
    expect(b).toEqual(a);
    expect(await manifestHash(b)).toBe(await manifestHash(a));
    expect(CompositionManifest.parse(a)).toEqual(a);
    expect(a).toMatchObject({ templateVersion: "layout-1", template: "separates", canvas: { width: 900, height: 1200, background: "#FFFFFF" } });
    // Every layer records the item, the rendition and its version, position, scale and layering order.
    for (const l of a.layers) {
      expect(l).toMatchObject({ garmentId: expect.any(String), renditionId: expect.any(String), renditionVersion: 1, x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number), scale: expect.any(Number), z: expect.any(Number) });
      expect(l.x >= 0 && l.y >= 0 && l.x + l.width <= 1 && l.y + l.height <= 1).toBe(true); // nothing is placed off the canvas
    }
    expect(a.caption).toBe("Top: blue oxford. Bottom: olive fatigues. Footwear: navy sneakers. Socks: grey socks. Belt: brown belt.");
  });

  it("puts top and trousers in the main column with shoes beneath, and accessories in fixed side positions", () => {
    const m = buildManifest([SHIRT, TROUSERS, SHOES, SOCKS, BELT, SCARF]);
    const at = (id: string) => m.layers.find((l) => l.garmentId === id)!;
    const centre = (id: string) => at(id).x + at(id).width / 2;
    expect(centre("g-shirt")).toBeCloseTo(0.5, 2);
    expect(centre("g-trousers")).toBeCloseTo(0.5, 2);
    expect(centre("g-shoes")).toBeCloseTo(0.5, 2);
    expect(at("g-shirt").y).toBeLessThan(at("g-trousers").y);
    expect(at("g-trousers").y + at("g-trousers").height).toBeLessThanOrEqual(at("g-shoes").y + 0.02);
    expect(at("g-shirt").z).toBeGreaterThan(at("g-trousers").z); // the shirt hem overlaps the waistband, not the reverse
    // Accessories sit to the side of the column, and in the same place whatever else is in the outfit.
    for (const id of ["g-belt", "g-scarf"]) expect(at(id).x).toBeGreaterThan(at("g-shirt").x + at("g-shirt").width);
    const other = buildManifest([slot("top", "g-other", "another shirt", "shirt"), TROUSERS, SHOES, BELT, SCARF]);
    for (const id of ["g-belt", "g-scarf"]) expect(other.layers.find((l) => l.garmentId === id)).toMatchObject({ x: at(id).x, y: at(id).y, width: at(id).width, height: at(id).height });
    // Two accessories of the same role stack instead of covering each other.
    const two = buildManifest([SHIRT, TROUSERS, SHOES, slot("accessory", "g-a1", "pocket square", "pocket_square"), slot("accessory", "g-a2", "watch", "accessory")]);
    expect(two.layers.find((l) => l.garmentId === "g-a2")!.y).toBeGreaterThan(two.layers.find((l) => l.garmentId === "g-a1")!.y);
  });

  it("has templates for long coats, short jackets, knitwear and one-piece garments", () => {
    const jacket = slot("outer", "g-jacket", "blue work jacket", "outerwear");
    const coat = slot("outer", "g-coat", "grey wool overcoat", "outerwear");
    const knit = slot("mid_layer", "g-knit", "navy shetland jumper", "knitwear");
    const boiler = slot("one_piece", "g-boiler", "indigo boiler suit", "one_piece");
    const template = (slots: ComposeSlot[]) => buildManifest(slots).template;
    expect(template([SHIRT, TROUSERS, SHOES])).toBe("separates");
    expect(template([SHIRT, TROUSERS, SHOES, jacket])).toBe("separates_with_jacket");
    expect(template([SHIRT, TROUSERS, SHOES, coat])).toBe("separates_with_long_coat");
    expect(template([SHIRT, TROUSERS, SHOES, knit])).toBe("separates_with_knitwear");
    expect(template([slot("top", "g-rollneck", "cream rollneck", "knitwear"), TROUSERS, SHOES])).toBe("separates_with_knitwear");
    expect(template([boiler, SHOES])).toBe("one_piece");
    expect(template([boiler, SHOES, coat])).toBe("one_piece_with_outer");
    // A recorded length beats the name: a "coat" recorded as short is laid out as a jacket.
    expect(template([SHIRT, TROUSERS, SHOES, { ...coat, outerLength: "short" }])).toBe("separates_with_jacket");
    expect(template([SHIRT, TROUSERS, SHOES, { ...jacket, outerLength: "long" }])).toBe("separates_with_long_coat");

    const withCoat = buildManifest([SHIRT, TROUSERS, SHOES, coat]);
    const withJacket = buildManifest([SHIRT, TROUSERS, SHOES, jacket]);
    const outer = (m: typeof withCoat) => m.layers.find((l) => l.role === "outer")!;
    const top = (m: typeof withCoat) => m.layers.find((l) => l.role === "top")!;
    // The outer layer sits beside the column, partly layered beneath it; a long coat runs most of the canvas height.
    expect(outer(withCoat).x).toBeLessThan(top(withCoat).x);
    expect(outer(withCoat).x + outer(withCoat).width).toBeGreaterThan(top(withCoat).x);
    expect(outer(withCoat).z).toBeLessThan(top(withCoat).z);
    expect(outer(withCoat).height).toBeGreaterThan(outer(withJacket).height * 1.5);
    // Under knitwear the shirt is the smaller piece behind the jumper, which takes the main top position.
    const layered = buildManifest([SHIRT, TROUSERS, SHOES, knit]);
    const shirt = layered.layers.find((l) => l.garmentId === "g-shirt")!;
    const jumper = layered.layers.find((l) => l.garmentId === "g-knit")!;
    expect(shirt.width).toBeLessThan(jumper.width);
    expect(shirt.z).toBeLessThan(jumper.z);
    // A one-piece takes the height of top and bottom together.
    const suit = buildManifest([boiler, SHOES]).layers.find((l) => l.role === "one_piece")!;
    expect(suit.height).toBeGreaterThan(0.7);
    // Relative size comes from the category, not from the pixel size of whatever image happens to exist.
    const bigImage = buildManifest([{ ...SHIRT, image: image("g-shirt", { width: 4000, height: 3000 }) }, TROUSERS, SHOES]).layers.find((l) => l.role === "top")!;
    expect([bigImage.width, bigImage.height]).toEqual([top(buildManifest([SHIRT, TROUSERS, SHOES])).width, top(buildManifest([SHIRT, TROUSERS, SHOES])).height]);
  });

  it("a single-slot swap changes exactly one layer and the hash; a new rendition version changes the hash too", async () => {
    const before = buildManifest([SHIRT, TROUSERS, SHOES, SOCKS]);
    const after = buildManifest([SHIRT, TROUSERS, slot("footwear", "g-boots", "brown boots", "footwear"), SOCKS]);
    const changed = after.layers.filter((l, i) => JSON.stringify(l) !== JSON.stringify(before.layers[i]));
    expect(changed.map((l) => l.garmentId)).toEqual(["g-boots"]);
    expect(changed[0]).toMatchObject({ x: before.layers.find((l) => l.role === "footwear")!.x, y: before.layers.find((l) => l.role === "footwear")!.y }); // same position, another asset reference
    expect(await manifestHash(after)).not.toBe(await manifestHash(before));
    const reprocessed = buildManifest([{ ...SHIRT, image: image("g-shirt", { renditionVersion: 2, renditionSha256: "b".repeat(64) }) }, TROUSERS, SHOES, SOCKS]);
    expect(await manifestHash(reprocessed)).not.toBe(await manifestHash(before));
  });

  it("labels illustrations, demo placeholders, edits, shopping candidates and missing images, and never passes one off as exact", () => {
    const m = buildManifest([
      { ...SHIRT, image: image("g-shirt", { assetKind: "generic_illustration", displayLabel: "Illustration", hasRealImage: false }) },
      { ...TROUSERS, image: image("g-trousers", { isDemo: true, displayLabel: "Demo placeholder", hasRealImage: false }) },
      { ...SHOES, image: image("g-shoes", { displayLabel: "Edited" }) },
      { ...SOCKS, image: null },
      { ...BELT, image: { ...image("g-belt"), renditionId: null } },
      { role: "outer", garmentId: null, shoppingCandidateId: "cand-1", name: "Waxed jacket (considering)", category: "other", image: null },
      slot("neckwear", "g-scarf", "navy scarf", "scarf", { image: image("g-scarf", { assetKind: "exact_product_photo", displayLabel: "Product photo" }) }),
    ]);
    const label = (role: string) => m.layers.find((l) => l.role === role)!.imageLabel;
    expect([label("top"), label("bottom"), label("footwear"), label("socks"), label("belt"), label("outer"), label("neckwear")]).toEqual(["illustration", "demo_placeholder", "edited", "missing", "missing", "shopping_candidate", "exact"]);
    expect(manifestLabels(m)).toEqual(["Illustration", "Demo placeholder", "Shopping candidate", "Edited", "No photo yet"]);
    // A missing image carries no asset reference at all: there is nothing a renderer could draw in its place.
    expect(m.layers.find((l) => l.role === "socks")).toMatchObject({ assetId: null, renditionId: null, renditionSha256: null, name: "grey socks" });
    expect(m.caption).toContain("Top: blue oxford (illustration)");
    expect(m.caption).toContain("Bottom: olive fatigues (demo placeholder)");
    expect(m.caption).toContain("Socks: grey socks (no photo yet)");
    expect(m.caption).toContain("Outer layer: Waxed jacket (considering) (shopping candidate, not owned)");
  });
});

describe("SVG scene and raster preview", () => {
  it("escapes garment names and accepts no markup, external reference or unvalidated image data", () => {
    const hostile = `"><script>alert(1)</script><image href="https://evil.example/x.png"/><foreignObject>`;
    const m = buildManifest([slot("top", "g-shirt", hostile, "shirt"), { ...TROUSERS, name: "a & b <c>", image: null }, SHOES]);
    const svg = renderSvg(m);
    expect(svg).not.toMatch(/<script|<foreignObject/i); // the hostile text survives only as escaped, inert character data
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).toContain("a &amp; b &lt;c&gt;");
    // The only elements are the fixed templates, and the only image references are this package's own rendition scheme.
    expect([...new Set([...svg.matchAll(/<([a-zA-Z]+)/g)].map((x) => x[1]))].sort()).toEqual(["g", "image", "rect", "svg", "text", "title"]);
    expect([...svg.matchAll(/href="([^"]*)"/g)].map((x) => x[1])).toEqual(["garderobe-rendition:rnd_g-shirt", "garderobe-rendition:rnd_g-shoes"]);
    expect(svg.match(/<image /g)).toHaveLength(2);
    expect(svg).toContain("NO PHOTO YET");

    // A manifest that did not come from buildManifest (tampered storage, a model, an external page) cannot inject either.
    const tampered = (patch: (x: typeof m) => void) => {
      const copy = structuredClone(m);
      patch(copy);
      return () => renderSvg(copy);
    };
    expect(tampered((x) => { x.layers[0]!.renditionId = `x" onload="alert(1)`; })).toThrow(/invalid rendition reference/);
    expect(tampered((x) => { x.canvas.background = `#FFF"/><script>`; })).toThrow(/invalid canvas background/);
    expect(tampered((x) => { x.layers[0]!.x = Number.NaN; })).toThrow(/non-finite/);
    const id = m.layers.find((l) => l.renditionId)!.renditionId!;
    expect(() => renderSvg(m, new Map([[id, "https://evil.example/x.png"]]))).toThrow(/only validated image data URIs/);
    expect(() => renderSvg(m, new Map([[id, "data:image/svg+xml;base64,PHN2Zz4="]]))).toThrow(/only validated image data URIs/);
    expect(renderSvg(m, new Map([[id, "data:image/png;base64,iVBORw0KGgo="]]))).toContain('href="data:image/png;base64,iVBORw0KGgo="');
  });

  it("composites the images into their slots and draws a named outline where there is none", () => {
    const m = buildManifest([SHIRT, { ...TROUSERS, image: null }, SHOES]);
    const shirt = syntheticShirt({ size: 128 });
    const canvas = renderRaster(m, new Map([["rnd_g-shirt", shirt]]));
    expect([canvas.width, canvas.height]).toEqual([900, 1200]);
    const px = (x: number, y: number) => [...canvas.data.subarray((Math.round(y) * 900 + Math.round(x)) * 4, (Math.round(y) * 900 + Math.round(x)) * 4 + 3)];
    const top = m.layers.find((l) => l.role === "top")!;
    const edge = Math.min(top.width * 900, top.height * 1200); // the square image is contained in its slot
    const left = top.x * 900 + (top.width * 900 - edge) / 2, upper = top.y * 1200 + (top.height * 1200 - edge) / 2;
    const body = px(left + edge * 0.36, upper + edge * 0.8);
    expect(body[2]!).toBeGreaterThan(body[0]! + 60); // the blue shirt body
    expect(px(left + edge * 0.5, upper + edge * 0.05)).toEqual([255, 255, 255]); // above the collar: canvas
    expect(px(5, 5)).toEqual([255, 255, 255]);
    // The trousers have no image: a dashed outline (grey) and text, never a drawn garment.
    const bottom = m.layers.find((l) => l.role === "bottom")!;
    expect(px(bottom.x * 900 + 2, bottom.y * 1200)).toEqual([189, 189, 189]);
    let dark = 0, coloured = 0;
    for (let y = Math.round(bottom.y * 1200) + 4; y < Math.round((bottom.y + bottom.height) * 1200) - 4; y++) {
      for (let x = Math.round(bottom.x * 900) + 4; x < Math.round((bottom.x + bottom.width) * 900) - 4; x++) {
        const i = (y * 900 + x) * 4;
        const r = canvas.data[i]!, g = canvas.data[i + 1]!, b = canvas.data[i + 2]!;
        if (r === 255 && g === 255 && b === 255) continue;
        if (Math.abs(r - g) < 4 && Math.abs(g - b) < 4) dark++;
        else coloured++;
      }
    }
    expect(dark).toBeGreaterThan(50); // the name and "NO PHOTO YET" in grey
    expect(coloured).toBe(0);
    // The shoes' rendition was not supplied to the renderer (deleted meanwhile): also an outline, not a crash.
    const shoes = m.layers.find((l) => l.role === "footwear")!;
    expect(px(shoes.x * 900 + 2, shoes.y * 1200)).toEqual([189, 189, 189]);
    // Same input, same pixels.
    const again = renderRaster(m, new Map([["rnd_g-shirt", shirt]])).data;
    let same = again.length === canvas.data.length;
    for (let i = 0; same && i < again.length; i++) same = again[i] === canvas.data[i];
    expect(same).toBe(true);
  });
});

describe("outfit previews through the command service, the queue and private storage", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  let bob: TestOwner;
  const outfit = [{ role: "top", garmentId: "shirt-moss" }, { role: "bottom", garmentId: "trouser-olive" }, { role: "footwear", garmentId: "shoe-navy" }, { role: "socks", garmentId: "sock-navy" }] as const;
  const swapped = [outfit[0], outfit[1], { role: "footwear", garmentId: "shoe-olive" }, outfit[3]] as const;
  let hash: string;
  let swappedHash: string;

  beforeAll(async () => {
    h = await createMediaHarness();
    owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (composites)" });
    bob = await h.createSyntheticOwner({ displayName: "Synthetic owner B (composites)" });
    await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 320 }), demo: true });
    await h.upload(owner, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 320 }), demo: true });
    await h.upload(owner, { garmentId: "shoe-navy", raster: syntheticShoes({ size: 320, colour: [30, 40, 110] }), demo: true });
    await h.settle(owner);
  });

  it("composing is a read: it writes nothing and says which garments have no image", async () => {
    const commandsBefore = (await all(h.db, "SELECT 1 FROM commands WHERE user_id = ?", owner.userId)).length;
    const composition = await composeOutfit(h.rt, owner.principal(), { slots: [...outfit] });
    hash = composition.manifestHash;
    expect(composition.manifestHash).toBe(await manifestHash(composition.manifest));
    expect(composition.preview).toEqual({ state: "none", sha256: null, renderedAt: null, failure: null });
    expect(composition.missingImages).toEqual(["sock-navy"]);
    expect(composition.labels).toEqual(["Demo placeholder", "No photo yet"]); // fixtures are labelled; nothing is passed off as a real garment photo
    expect(composition.manifest.layers.filter((l) => l.imageLabel === "demo_placeholder").map((l) => l.garmentId).sort()).toEqual(["shirt-moss", "shoe-navy", "trouser-olive"]);
    // The manifest points at the approved renditions by ID, version and content hash.
    const shirt = (await getGarmentMedia(h.rt, owner.principal(), "shirt-moss")).image;
    expect(composition.manifest.layers.find((l) => l.garmentId === "shirt-moss")).toMatchObject({ assetId: shirt.assetId, renditionId: shirt.renditionId, renditionVersion: shirt.renditionVersion, renditionSha256: shirt.renditionSha256 });
    expect((await composeOutfit(h.rt, owner.principal(), { slots: [...outfit].reverse() })).manifestHash).toBe(hash);
    expect(await all(h.db, "SELECT 1 FROM outfit_composites WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect((await all(h.db, "SELECT 1 FROM commands WHERE user_id = ?", owner.userId)).length).toBe(commandsBefore);
    // Another owner's garment is not composable, and an unknown one is refused rather than drawn.
    expect(await code(composeOutfit(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "no-such-garment" }] }))).toBe("not_found");
    expect(await code(composeOutfit(h.rt, owner.principal({ scopes: [] }), { slots: [...outfit] }))).toBe("forbidden");
  });

  it("queues the preview with a receipt, renders it in the background and stores it privately", async () => {
    const { receipt, manifestHash: requested } = await requestCompositePreview(h.rt, owner.principal(), { slots: [...outfit] });
    expect(requested).toBe(hash);
    expect(receipt).toMatchObject({ type: "media.request_composite_preview", outcome: "committed" });
    expect(receipt.result).toMatchObject({ manifestHash: hash, previewState: "queued" });
    // The command returned before anything was rendered: rendering cannot delay whoever asked.
    expect((await first<{ state: string }>(h.db, "SELECT state FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, String(receipt.result.jobId)))!.state).toBe("queued");
    expect((await composeOutfit(h.rt, owner.principal(), { slots: [...outfit] })).preview.state).toBe("queued");
    expect(await code(openCompositePreview(h.rt, owner.principal(), hash))).toBe("not_found");
    // Asking again while it is queued does not queue a second render.
    expect((await owner.exec("media.request_composite_preview", { slots: [...outfit] })).outcome).toBe("noop");

    await h.settle(owner);
    const done = await getComposition(h.rt, owner.principal(), hash);
    expect(done.preview).toMatchObject({ state: "rendered", failure: null });
    expect(done.preview.renderedAt).toBeTruthy();
    const opened = await openCompositePreview(h.rt, owner.principal(), hash);
    expect(opened.contentType).toBe("image/png");
    const png = new Uint8Array(await new Response(opened.body).arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", png))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(done.preview.sha256).toBe(digest);
    const raster = await decodePng(png);
    expect([raster.width, raster.height]).toEqual([900, 1200]);
    // The shirt was drawn where the manifest puts it (a moss-labelled fixture drawn in the synthetic shirt's blue).
    const top = done.manifest.layers.find((l) => l.role === "top")!;
    const edge = Math.min(top.width * 900, top.height * 1200);
    const x = Math.round(top.x * 900 + (top.width * 900 - edge) / 2 + edge * 0.36), y = Math.round(top.y * 1200 + (top.height * 1200 - edge) / 2 + edge * 0.8);
    expect(raster.data[(y * 900 + x) * 4 + 2]!).toBeGreaterThan(raster.data[(y * 900 + x) * 4]! + 60);

    const svg = await new Response((await openCompositePreview(h.rt, owner.principal(), hash, "svg")).body).text();
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain("DEMO PLACEHOLDER");
    expect(svg).toContain("navy merino socks");
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no external reference of any kind

    // Stored under the owner's prefix only; the ledger row has the key, the read model does not.
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/composites/` })).objects.map((o) => o.key).sort()).toEqual([`u/${owner.userId}/composites/${hash}.png`, `u/${owner.userId}/composites/${hash}.svg`]);
    expect(JSON.stringify(done)).not.toContain(`u/${owner.userId}`);
    const receipts = await h.service.listReceipts(owner.principal(), { kind: "outfit_composite", entityId: hash });
    expect(receipts.map((r) => r.type).sort()).toEqual(["media.record_composite", "media.request_composite_preview"]);
    // The content hash identifies the cached output: the same outfit is not rendered twice.
    const again = await requestCompositePreview(h.rt, owner.principal(), { slots: [...outfit].reverse(), idempotencyKey: "preview-again-1" });
    expect(again.receipt).toMatchObject({ outcome: "noop", summary: "That outfit's preview already exists" });
    expect(await all(h.db, "SELECT 1 FROM media_jobs WHERE user_id = ? AND kind = 'render_composite'", owner.userId)).toHaveLength(1);
  });

  it("keeps previews private to their owner and recording them to the pipeline", async () => {
    expect(await code(getComposition(h.rt, bob.principal(), hash))).toBe("not_found");
    expect(await code(openCompositePreview(h.rt, bob.principal(), hash))).toBe("not_found");
    expect(await code(openCompositePreview(h.rt, bob.principal(), hash, "svg"))).toBe("not_found");
    // Bob's garments with the same IDs are his own records without images: a different manifest, nothing of the first owner's.
    const his = await composeOutfit(h.rt, bob.principal(), { slots: [...outfit] });
    expect(his.manifestHash).not.toBe(hash);
    expect(his.manifest.layers.every((l) => l.renditionId === null && l.imageLabel === "missing")).toBe(true);
    expect(his.preview.state).toBe("none");
    // A client cannot record a preview (and the command names no storage location, so it could not point into another owner's storage).
    const forged = { manifestHash: hash, jobId: "job_x", previewSha256: "c".repeat(64), previewBytes: 10, hasSvg: false, renderer: "forged" };
    expect(await code(bob.exec("media.record_composite", forged, { authorization: "system_schedule" }))).toBe("forbidden");
    expect(await code(owner.exec("media.record_composite", forged, { authorization: "system_schedule" }))).toBe("forbidden");
  });

  it("a single-slot swap is a separate composite; deleting an image invalidates only the composites that used it", async () => {
    const other = await requestCompositePreview(h.rt, owner.principal(), { slots: [...swapped] });
    swappedHash = other.manifestHash;
    expect(swappedHash).not.toBe(hash);
    await h.settle(owner);
    const first_ = await getComposition(h.rt, owner.principal(), hash);
    const second = await getComposition(h.rt, owner.principal(), swappedHash);
    expect(second.preview.state).toBe("rendered");
    expect(second.missingImages.sort()).toEqual(["shoe-olive", "sock-navy"]);
    // Only the footwear layer differs between the two manifests; the first preview was not re-rendered.
    const differing = second.manifest.layers.filter((l, i) => JSON.stringify(l) !== JSON.stringify(first_.manifest.layers[i]));
    expect(differing.map((l) => l.role)).toEqual(["footwear"]);
    expect(await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'media.record_composite'", owner.userId)).toHaveLength(2);

    // Delete the navy shoes' image: the composite that drew it loses its preview; the other is untouched.
    const shoe = await getGarmentMedia(h.rt, owner.principal(), "shoe-navy");
    await owner.exec("media.delete_asset", { assetId: shoe.image.assetId });
    await h.settle(owner);
    const invalidated = await getComposition(h.rt, owner.principal(), hash);
    expect(invalidated.preview).toMatchObject({ state: "none", sha256: null, failure: "an image it used was deleted" });
    expect(await code(openCompositePreview(h.rt, owner.principal(), hash))).toBe("not_found");
    expect((await getComposition(h.rt, owner.principal(), swappedHash)).preview).toMatchObject({ state: "rendered", sha256: second.preview.sha256 });
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/composites/` })).objects.map((o) => o.key).sort()).toEqual([`u/${owner.userId}/composites/${swappedHash}.png`, `u/${owner.userId}/composites/${swappedHash}.svg`]);
    // The same slots now compose to a new manifest in which the shoes are honestly missing.
    const now = await composeOutfit(h.rt, owner.principal(), { slots: [...outfit] });
    expect(now.manifestHash).not.toBe(hash);
    expect(now.missingImages.sort()).toEqual(["shoe-navy", "sock-navy"]);
  });

  it("falls back to the built-in compositor when an optional exporter declines, and records a render that keeps failing", async () => {
    const slots: { role: "top" | "bottom" | "footwear"; garmentId: string }[] = [{ role: "top", garmentId: "shirt-moss" }, { role: "bottom", garmentId: "trouser-olive" }, { role: "footwear", garmentId: "shoe-olive" }];
    // TEST DOUBLE for a browser-rendering exporter that cannot render: the deterministic compositor takes over.
    h.deps.previewExporter = { name: "test-double-exporter", async renderSvgToPng() { return { ok: false, reason: "no browser available" }; } };
    const declined = await requestCompositePreview(h.rt, owner.principal(), { slots });
    await h.settle(owner);
    expect((await getComposition(h.rt, owner.principal(), declined.manifestHash)).preview.state).toBe("rendered");
    const job = await first<{ result_json: string }>(h.db, "SELECT result_json FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, String(declined.receipt.result.jobId));
    expect(JSON.parse(job!.result_json).renderer).toBe("garderobe-compositor-1");

    // TEST DOUBLE that throws every time: the job is retried, then recorded as failed and surfaced on the composition.
    h.deps.previewExporter = { name: "test-double-exporter", async renderSvgToPng() { throw new Error("renderer crashed"); } };
    const failing = await requestCompositePreview(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "shirt-gold" }, { role: "bottom", garmentId: "trouser-beige" }] });
    await h.settle(owner, 60_000);
    h.deps.previewExporter = undefined;
    const failed = await getComposition(h.rt, owner.principal(), failing.manifestHash);
    expect(failed.preview).toMatchObject({ state: "failed", sha256: null, failure: "renderer crashed" });
    expect(await code(openCompositePreview(h.rt, owner.principal(), failing.manifestHash))).toBe("not_found");
    expect((await h.service.listReceipts(owner.principal(), { kind: "media_job", entityId: String(failing.receipt.result.jobId) })).map((r) => r.type)).toEqual(["media.fail_job"]);
    // A failed preview can be requested again and then renders.
    const retry = await requestCompositePreview(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "shirt-gold" }, { role: "bottom", garmentId: "trouser-beige" }], idempotencyKey: "preview-retry-1" });
    expect(retry.receipt.outcome).toBe("committed");
    await h.settle(owner);
    expect((await getComposition(h.rt, owner.principal(), failing.manifestHash)).preview.state).toBe("rendered");
  });
});
