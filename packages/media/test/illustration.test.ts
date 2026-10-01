import { beforeAll, describe, expect, it } from "vitest";
import { isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { authorizeUpload, composeOutfit, finalizeUpload, getGarmentMedia, listPhotosNeeded, receiveUploadContent, type DiscoveryProvider } from "../src/index.ts";
import { encodePng } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, type MediaHarness } from "../src/testing/index.ts";

// SYNTHETIC TEST IMAGES on test records. The "illustration" bytes stand in for an image model's drawing; the
// search provider is a TEST DOUBLE that finds nothing.

const emptySearch: DiscoveryProvider = { name: "test-double-search", strategies: ["maker_catalogue", "identifier_search"], usesBrowser: false, async search() { return { pages: [], browserSessions: 0, browserSeconds: 0 }; } };

describe("generic illustrations are labelled and never become the garment's real image", () => {
  let h: MediaHarness;
  let owner: TestOwner;

  async function uploadIllustration(garmentId: string, colour: [number, number, number]) {
    const bytes = await encodePng(syntheticShirt({ size: 256, body: colour }));
    const { authorization } = await authorizeUpload(h.rt, owner.principal(), { intent: "garment_photo", garmentId, contentType: "image/png", byteLength: bytes.length, origin: "image_model", originRef: "test-double-image-model prompt-v1", idempotencyKey: `illustration:${garmentId}:${colour.join("-")}` });
    const token = new URLSearchParams(authorization.url.split("?")[1]).get("token")!;
    await receiveUploadContent(h.rt, { uploadId: authorization.uploadId, token, body: bytes, contentLength: bytes.length, contentType: "image/png" });
    const done = await finalizeUpload(h.rt, owner.principal(), authorization.uploadId);
    await h.settle(owner);
    return done.asset!;
  }

  beforeAll(async () => {
    h = await createMediaHarness({ adapters: { discoveryProviders: [emptySearch] } });
    owner = await h.createOwner({ synthetic: false, displayName: "Illustration test owner (test records only)" });
    for (const id of ["ill-shirt", "ill-trousers"]) {
      await owner.exec("garment.create", { garmentId: id, name: `test record ${id}`, category: id === "ill-shirt" ? "shirt" : "trousers", roles: [id === "ill-shirt" ? "top" : "bottom"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Thing", colour: "Blue", source: { kind: "system", note: "test record" } });
    }
    await owner.exec("media.request_discovery", { garmentIds: ["ill-shirt"] });
    await h.settle(owner);
  });

  it("an illustration is labelled Illustration in the item and on the outfit, is not evidence, and leaves Photos needed open", async () => {
    expect((await listPhotosNeeded(h.rt, owner.principal())).map((p) => p.garmentId)).toEqual(["ill-shirt"]);
    const asset = await uploadIllustration("ill-shirt", [200, 60, 60]);
    expect(asset).toMatchObject({ kind: "generic_illustration", displayLabel: "Illustration", isDemo: false, usableAsEvidence: false });
    expect(asset.source).toMatchObject({ kind: "image_model" });

    const media = await getGarmentMedia(h.rt, owner.principal(), "ill-shirt");
    expect(media.image).toMatchObject({ assetId: asset.assetId, assetKind: "generic_illustration", displayLabel: "Illustration", hasRealImage: false });
    // The garment still needs a real photograph, and still says which one.
    expect(media.imageState).toBe("photos_needed");
    expect(media.photoRequest).toMatch(/^A front-on photo of test record ill-shirt/);
    expect((await listPhotosNeeded(h.rt, owner.principal())).map((p) => p.garmentId)).toEqual(["ill-shirt"]);
    // Choosing it explicitly changes nothing about what it is.
    const chosen = await owner.exec("media.set_primary_asset", { garmentId: "ill-shirt", assetId: asset.assetId });
    expect(["noop", "committed"]).toContain(chosen.outcome);
    expect((await getGarmentMedia(h.rt, owner.principal(), "ill-shirt")).image).toMatchObject({ hasRealImage: false, displayLabel: "Illustration" });

    const composition = await composeOutfit(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "ill-shirt" }, { role: "bottom", garmentId: "ill-trousers" }] });
    expect(composition.labels).toEqual(["Illustration", "No photo yet"]);
    expect(composition.manifest.layers.find((l) => l.garmentId === "ill-shirt")!.imageLabel).toBe("illustration");
    expect(composition.manifest.caption).toContain("test record ill-shirt (illustration)");
    // An illustration is never a selfie or attachment, and never a demo placeholder on a real garment.
    const bytes = await encodePng(syntheticShirt({ size: 128 }));
    const wrong = await authorizeUpload(h.rt, owner.principal(), { intent: "selfie", contentType: "image/png", byteLength: bytes.length, origin: "image_model", idempotencyKey: "illustration-as-selfie" }).catch((e) => e);
    expect(isCommandError(wrong) && wrong.code).toBe("invalid_command");
  });

  it("a real photograph replaces the illustration; a later illustration never replaces the photograph", async () => {
    const photo = await h.upload(owner, { garmentId: "ill-shirt", raster: syntheticShirt({ size: 256 }) });
    await h.settle(owner);
    const afterPhoto = await getGarmentMedia(h.rt, owner.principal(), "ill-shirt");
    expect(afterPhoto).toMatchObject({ imageState: "resolved", photoRequest: null, image: { assetId: photo.asset!.assetId, assetKind: "owner_photo", displayLabel: "Your photo", hasRealImage: true } });
    expect(await listPhotosNeeded(h.rt, owner.principal())).toEqual([]);

    const later = await uploadIllustration("ill-shirt", [60, 160, 60]);
    const afterIllustration = await getGarmentMedia(h.rt, owner.principal(), "ill-shirt");
    expect(afterIllustration.image).toMatchObject({ assetId: photo.asset!.assetId, hasRealImage: true, displayLabel: "Your photo" });
    expect(afterIllustration.assets.find((a) => a.assetId === later.assetId)).toMatchObject({ kind: "generic_illustration", displayLabel: "Illustration", usableAsEvidence: false });

    // Deleting the photograph falls back to an illustration, labelled as one: never silently "exact".
    await owner.exec("media.delete_asset", { assetId: photo.asset!.assetId });
    await h.settle(owner);
    const afterDelete = await getGarmentMedia(h.rt, owner.principal(), "ill-shirt");
    expect(afterDelete.image).toMatchObject({ assetKind: "generic_illustration", displayLabel: "Illustration", hasRealImage: false });
  });
});
