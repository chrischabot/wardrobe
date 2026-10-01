import { beforeAll, describe, expect, it } from "vitest";
import { all } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { getGarmentMedia, listMediaReview, listPhotosNeeded } from "../src/index.ts";
import type { DiscoveryCandidatePage, DiscoveryProvider, ImageFetcher } from "../src/index.ts";
import { compareWithOwnerPhoto, encodeJpeg, OWNER_PHOTO_THRESHOLDS, uniformBackgroundCutout, type Raster } from "../src/image/index.ts";
import { createMediaHarness, syntheticClutteredPhoto, syntheticShirt, syntheticShoes, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

// SYNTHETIC TEST IMAGES on test records. "Owner photos" here are synthetic images uploaded through the real
// upload path as an owner's photograph; the search provider and the image fetcher are TEST DOUBLES for the
// assistant lane's search providers and for the network.

const cutoutOf = (r: Raster): Raster => {
  const c = uniformBackgroundCutout(r);
  if (!c.ok) throw new Error(c.reason);
  return c.raster;
};
const relit = (src: Raster, factor: number, tint: [number, number, number] = [1, 1, 1]): Raster => {
  const out: Raster = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(out.data[i + c]! * factor * tint[c]!);
  return out;
};

describe("comparing a candidate with the owner's own photograph (pure)", () => {
  const owner = cutoutOf(syntheticShirt({ size: 300, background: [235, 232, 225] })); // the owner's photo, on an off-white sheet

  it("agrees with a studio photo of the same garment, across size, framing and a moderate lighting change", () => {
    const same = compareWithOwnerPhoto(owner, syntheticShirt({ size: 512 }));
    expect(same).toMatchObject({ compared: true, verdict: "consistent", algorithmVersion: "owner-photo-compare-1", thresholds: OWNER_PHOTO_THRESHOLDS });
    expect(same.colourDistance!).toBeLessThan(OWNER_PHOTO_THRESHOLDS.colourConsistent);
    expect(same.outlineScore!).toBeGreaterThan(0.95);
    expect(compareWithOwnerPhoto(owner, syntheticShirt({ size: 512, shiftX: 20 })).verdict).toBe("consistent");
    expect(compareWithOwnerPhoto(owner, relit(syntheticShirt({ size: 512 }), 0.85)).verdict).toBe("consistent");
    // Deterministic.
    expect(compareWithOwnerPhoto(owner, syntheticShirt({ size: 512 }))).toEqual(same);
  });

  it("says another colourway and another garment are different, and stays undecided in between", () => {
    for (const other of [syntheticShirt({ size: 512, body: [40, 150, 70] }), syntheticShirt({ size: 512, body: [220, 120, 150], stripe: [245, 200, 215] })]) {
      const result = compareWithOwnerPhoto(owner, other);
      expect(result.verdict).toBe("different_colour");
      expect(result.colourDistance!).toBeGreaterThan(OWNER_PHOTO_THRESHOLDS.colourDifferent);
      expect(result.detail).toMatch(/^the colours are clearly different from the owner's photo: palette distance /);
    }
    // The same colours on a different garment: the outline gives it away.
    expect(compareWithOwnerPhoto(owner, syntheticTrousers({ size: 512, colour: [40, 90, 200] }))).toMatchObject({ verdict: "different_outline" });
    expect(compareWithOwnerPhoto(cutoutOf(syntheticTrousers({ size: 300 })), syntheticTrousers({ size: 512, short: true })).verdict).toBe("different_outline");
    expect(compareWithOwnerPhoto(owner, syntheticShoes({ size: 512 })).verdict).toBe("different_colour");
    // A warm indoor light shifts every colour: not clearly the same, not clearly different.
    const warm = compareWithOwnerPhoto(owner, relit(syntheticShirt({ size: 512 }), 0.95, [1, 0.94, 0.85]));
    expect(warm.verdict).toBe("inconclusive");
    expect(warm.colourDistance!).toBeGreaterThan(OWNER_PHOTO_THRESHOLDS.colourConsistent);
    expect(warm.colourDistance!).toBeLessThan(OWNER_PHOTO_THRESHOLDS.colourDifferent);
    // Known limit of these measures, stated rather than hidden: a similar shade is not told apart.
    expect(compareWithOwnerPhoto(owner, syntheticShirt({ size: 512, body: [30, 60, 150] })).verdict).toBe("consistent");
  });

  it("declines to compare when either garment cannot be separated from its background", () => {
    const busy = compareWithOwnerPhoto(owner, syntheticClutteredPhoto(256));
    expect(busy).toMatchObject({ compared: false, verdict: null, colourDistance: null });
    expect(busy.reason).toMatch(/the candidate could not be used \(its background is not plain/);
    expect(compareWithOwnerPhoto(syntheticClutteredPhoto(256), syntheticShirt({ size: 512 })).reason).toMatch(/the owner's photo could not be used/);
  });
});

describe("discovery compares candidates with the owner's own photographs (real queue, R2 and ledger)", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  const pages = new Map<string, DiscoveryCandidatePage[]>();
  const images = new Map<string, Uint8Array>();
  const fetched: string[] = [];
  const search: DiscoveryProvider = {
    name: "test-double-search", strategies: ["maker_catalogue"], usesBrowser: false,
    async search(query) { return { pages: pages.get(query.garment.garmentId) ?? [], browserSessions: 0, browserSeconds: 0 }; },
  };
  const fetcher: ImageFetcher = {
    async fetchImage(url) {
      fetched.push(url);
      const bytes = images.get(url);
      return bytes ? { ok: true, bytes, contentType: "image/jpeg", finalUrl: url } : { ok: false, reason: "not found" };
    },
  };
  const page = (id: string, name: string, identifiers: DiscoveryCandidatePage["identifiers"], image: Raster): DiscoveryCandidatePage => {
    const imageUrl = `https://img.example.org/${id}-${name}.jpg`;
    images.set(imageUrl, encodeJpeg(image, 92));
    return { pageUrl: `https://maker.example.org/${id}/${name}`, imageUrl, title: null, sourceClass: "maker", identifiers, retrievedAt: "2026-09-15T08:00:00Z" };
  };
  const create = (id: string, extra: Record<string, unknown> = {}) =>
    owner.exec("garment.create", { garmentId: id, name: `test record ${id}`, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", source: { kind: "system", note: "test record" }, ...extra });
  const named = { maker: "Test Maker", productName: "Oxford Shirt", colourway: "Blue" };
  const candidatesOf = (id: string) => all<{ page_url: string; decision: string; rejection_reasons_json: string; evidence_json: string; asset_id: string | null; review_question: string | null }>(h.db, "SELECT page_url, decision, rejection_reasons_json, evidence_json, asset_id, review_question FROM media_candidates WHERE user_id = ? AND garment_id = ? ORDER BY created_at, page_url", owner.userId, id);

  beforeAll(async () => {
    h = await createMediaHarness({ adapters: { discoveryProviders: [search], imageFetcher: fetcher } });
    owner = await h.createOwner({ synthetic: false, displayName: "Owner-photo comparison owner (test records only)" });
  });

  it("rejects a candidate that is visibly another colourway than the owner's photo, adopts the one that agrees, and records both comparisons", async () => {
    await create("o-shirt");
    const mine = await h.upload(owner, { garmentId: "o-shirt", raster: syntheticShirt({ size: 256 }) });
    await h.settle(owner);
    const before = await getGarmentMedia(h.rt, owner.principal(), "o-shirt");
    expect(before).toMatchObject({ imageState: "resolved", image: { assetId: mine.asset!.assetId, assetKind: "owner_photo", renditionKind: "cutout" } });

    // The page text claims the right maker, product and colourway for both; only one PICTURE shows the owner's garment.
    pages.set("o-shirt", [page("o-shirt", "green", named, syntheticShirt({ size: 512, body: [40, 150, 70] })), page("o-shirt", "blue", named, syntheticShirt({ size: 512 }))]);
    // A garment that already has the owner's photo is not searched unless a product photo is asked for.
    expect((await owner.exec("media.request_discovery", { garmentIds: ["o-shirt"] })).outcome).toBe("noop");
    const receipt = await owner.exec("media.request_discovery", { garmentIds: ["o-shirt"], seekProductPhoto: true });
    expect(receipt.result).toMatchObject({ queued: 1 });
    // While the search runs the garment keeps showing the owner's photo.
    expect(await getGarmentMedia(h.rt, owner.principal(), "o-shirt")).toMatchObject({ imageState: "resolved", image: { assetId: mine.asset!.assetId } });
    await h.settle(owner);

    const rows = await candidatesOf("o-shirt");
    expect(rows.map((r) => [r.page_url.split("/").pop(), r.decision, r.rejection_reasons_json])).toEqual([["blue", "adopted", "[]"], ["green", "rejected", '["wrong_colourway"]']]);
    const green = JSON.parse(rows[1]!.evidence_json).ownerPhotoComparison;
    expect(green).toMatchObject({ compared: true, verdict: "different_colour", effect: "rejected", ownerAssetId: mine.asset!.assetId, ownerPhotosCompared: 1, algorithmVersion: "owner-photo-compare-1" });
    expect(green.colourDistance).toBeGreaterThan(OWNER_PHOTO_THRESHOLDS.colourDifferent);
    expect(green.ownerRenditionSha256).toBe(before.image.renditionSha256); // which of the owner's images it was compared with
    expect(rows[1]!.asset_id).toBeNull(); // nothing of the rejected candidate was kept

    const after = await getGarmentMedia(h.rt, owner.principal(), "o-shirt");
    expect(after.imageState).toBe("resolved");
    expect(after.image).toMatchObject({ assetKind: "exact_product_photo", displayLabel: "Product photo", hasRealImage: true });
    const adopted = after.assets.find((a) => a.kind === "exact_product_photo")!;
    expect(adopted.matchEvidence.ownerPhotoComparison).toMatchObject({ compared: true, verdict: "consistent", effect: "none", ownerAssetId: mine.asset!.assetId });
    expect(adopted.matchEvidence.adoptionBasis).toBe("product identity evidence and image-quality checks"); // the comparison never promotes; identity evidence does
    // The owner's photograph is still there, untouched.
    expect(after.assets.find((a) => a.assetId === mine.asset!.assetId)).toMatchObject({ kind: "owner_photo", status: "active" });
    expect(await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/assets/` }).then((l) => l.objects.some((o) => o.key.includes("green")))).toBe(false);
  });

  it("hands the decision to the owner when an exact product code is contradicted by the owner's photo, and keeps the owner's photo meanwhile", async () => {
    await create("o-code", { aliases: [{ phrase: "PCF7777", kind: "code" }] });
    const mine = await h.upload(owner, { garmentId: "o-code", raster: syntheticShirt({ size: 256 }) });
    await h.settle(owner);
    pages.set("o-code", [page("o-code", "pink", { productCodes: ["PCF7777"], maker: "Test Maker" }, syntheticShirt({ size: 512, body: [220, 120, 150], stripe: [245, 200, 215] }))]);
    await owner.exec("media.request_discovery", { garmentIds: ["o-code"], seekProductPhoto: true });
    await h.settle(owner);

    const [row] = await candidatesOf("o-code");
    expect(row).toMatchObject({ decision: "needs_review", review_question: "The found photo matches the recorded product code, but its colours differ from your own photo of test record o-code. Is it the same garment?" });
    expect(JSON.parse(row!.evidence_json)).toMatchObject({ matchedCodes: ["pcf7777"], adoptionBasis: "awaiting the owner's decision", ownerPhotoComparison: { verdict: "different_colour", effect: "sent_to_owner_review" } });
    const media = await getGarmentMedia(h.rt, owner.principal(), "o-code");
    expect(media).toMatchObject({ imageState: "needs_review", image: { assetId: mine.asset!.assetId, hasRealImage: true } });
    const review = (await listMediaReview(h.rt, owner.principal())).items.find((i) => i.garmentId === "o-code")!;
    expect(review.question).toMatch(/its colours differ from your own photo/);
    // The owner says no: the candidate is removed and the garment is simply resolved with the owner's photo again.
    await owner.exec("media.decide_review", { candidateId: review.candidateId, decision: "reject" });
    await h.settle(owner);
    expect(await getGarmentMedia(h.rt, owner.principal(), "o-code")).toMatchObject({ imageState: "resolved", photoRequest: null, image: { assetId: mine.asset!.assetId } });
    expect((await listPhotosNeeded(h.rt, owner.principal())).map((p) => p.garmentId)).not.toContain("o-code");
  });

  it("asks the owner when the outline differs from the owner's photo, even though the page text matched", async () => {
    await create("o-trousers", { category: "trousers", roles: ["bottom"], product: "Fatigue Trousers", colour: "Olive" });
    await h.upload(owner, { garmentId: "o-trousers", raster: syntheticTrousers({ size: 256 }) });
    await h.settle(owner);
    pages.set("o-trousers", [page("o-trousers", "shorts", { maker: "Test Maker", productName: "Fatigue Trousers", colourway: "Olive" }, syntheticTrousers({ size: 512, short: true }))]);
    await owner.exec("media.request_discovery", { garmentIds: ["o-trousers"], seekProductPhoto: true });
    await h.settle(owner);
    const [row] = await candidatesOf("o-trousers");
    expect(row!.decision).toBe("needs_review");
    expect(row!.review_question).toBe("The found photo matches the recorded maker and product, but its outline differ from your own photo of test record o-trousers. Is it the same garment?".replace("outline differ", "outline differs"));
    expect(JSON.parse(row!.evidence_json).ownerPhotoComparison).toMatchObject({ verdict: "different_outline", effect: "sent_to_owner_review" });
  });

  it("keeps the owner's photo and asks for nothing when no verified product photo is found", async () => {
    await create("o-none");
    const mine = await h.upload(owner, { garmentId: "o-none", raster: syntheticShirt({ size: 256 }) });
    await h.settle(owner);
    pages.set("o-none", [page("o-none", "lookalike", { maker: "Other Maker", productName: "Oxford Shirt", colourway: "Blue" }, syntheticShirt({ size: 512 }))]);
    fetched.length = 0;
    const receipt = await owner.exec("media.request_discovery", { garmentIds: ["o-none"], seekProductPhoto: true });
    await h.settle(owner);
    expect(fetched).toEqual([]); // rejected on identity before any image was fetched or compared
    const media = await getGarmentMedia(h.rt, owner.principal(), "o-none");
    expect(media).toMatchObject({ imageState: "resolved", photoRequest: null, lastFailure: null, image: { assetId: mine.asset!.assetId, displayLabel: "Your photo" } });
    expect((await listPhotosNeeded(h.rt, owner.principal())).map((p) => p.garmentId)).not.toContain("o-none");
    const job = await all<{ result_json: string }>(h.db, "SELECT result_json FROM media_jobs WHERE user_id = ? AND kind = 'discover' AND subject_id = 'o-none'", owner.userId);
    expect(JSON.parse(job[0]!.result_json)).toMatchObject({ conclusion: "already_resolved" });
    expect(receipt.result).toMatchObject({ queued: 1 });
    // An ordinary request afterwards leaves the garment alone again.
    expect((await owner.exec("media.request_discovery", { garmentIds: ["o-none"] })).outcome).toBe("noop");
  });

  it("says when the owner's photo could not serve as a reference, and never treats a demo placeholder or a missing photo as one", async () => {
    // The owner's only photo is on a cluttered background: it has no cutout, so no comparison is claimed.
    await create("o-busy");
    await h.upload(owner, { garmentId: "o-busy", raster: syntheticClutteredPhoto(256) });
    await h.settle(owner);
    pages.set("o-busy", [page("o-busy", "blue", named, syntheticShirt({ size: 512 }))]);
    await owner.exec("media.request_discovery", { garmentIds: ["o-busy"], seekProductPhoto: true });
    await h.settle(owner);
    const [busy] = await candidatesOf("o-busy");
    expect(busy!.decision).toBe("adopted");
    expect(JSON.parse(busy!.evidence_json).ownerPhotoComparison).toMatchObject({ compared: false, verdict: null, effect: "none", ownerAssetId: null, reason: "the owner's photo has no background-removed cutout to compare with" });

    // A labelled demo placeholder (green) on a fixture garment is not the owner's photograph of anything.
    await create("o-demo", { isSynthetic: true });
    await h.upload(owner, { garmentId: "o-demo", raster: syntheticShirt({ size: 256, body: [40, 150, 70] }), demo: true });
    await h.settle(owner);
    pages.set("o-demo", [page("o-demo", "blue", named, syntheticShirt({ size: 512 }))]);
    await owner.exec("media.request_discovery", { garmentIds: ["o-demo"] });
    await h.settle(owner);
    const [demo] = await candidatesOf("o-demo");
    expect(demo!.decision).toBe("adopted");
    expect(JSON.parse(demo!.evidence_json)).not.toHaveProperty("ownerPhotoComparison");

    // A garment the owner never photographed: nothing to compare, nothing claimed.
    await create("o-bare");
    pages.set("o-bare", [page("o-bare", "blue", named, syntheticShirt({ size: 512 }))]);
    await owner.exec("media.request_discovery", { garmentIds: ["o-bare"] });
    await h.settle(owner);
    expect(JSON.parse((await candidatesOf("o-bare"))[0]!.evidence_json)).not.toHaveProperty("ownerPhotoComparison");
  });
});
