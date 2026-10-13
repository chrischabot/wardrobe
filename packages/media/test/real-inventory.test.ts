import { beforeAll, describe, expect, it } from "vitest";
import { outfitValidator, registerDaily } from "@garderobe/daily";
import { all, isCommandError, listInventory } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import type { Role } from "@garderobe/contracts";
import {
  authorizeUpload, composeOutfit, exportMediaData, garmentImageRefs, getBackfillEstimate, getComposition, getGarmentMedia, getStudioSelectors, listMediaReview, listPhotosNeeded, listStudioCombinations, listStudioDayPlans,
  openCompositePreview, requestCompositePreview, suggestStudioOutfits, validateStudioOutfit, type DiscoveryProvider, type ImageFetcher,
} from "../src/index.ts";
import { decodePng, encodePng } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, type MediaHarness } from "../src/testing/index.ts";

// FINAL INTEGRATION against the finished foundation: the owner's REAL profile and REAL inventory, imported
// through the ordinary command service from the documents under requirements/. No image exists for any of
// these garments and none is created here: every assertion below is about saying so honestly.
// The two search providers are TEST DOUBLES that find nothing (there is no network in tests); they stand in
// for the purchase-link fetcher and the assistant lane's search providers.

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
    return { code: "ok", message: "" };
  } catch (e) {
    if (isCommandError(e)) return { code: e.code, message: e.message };
    throw e;
  }
}

describe("the owner's real imported inventory", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  let garments: { garmentId: string; name: string; category: string; roles: string[]; acquisition: string }[];
  const searched: { strategy: string; garmentId: string; text: string }[] = [];
  const fetched: string[] = [];
  const record = (name: string, strategies: DiscoveryProvider["strategies"]): DiscoveryProvider => ({
    name, strategies, usesBrowser: false,
    async search(q) {
      searched.push({ strategy: q.strategy, garmentId: q.garment.garmentId, text: q.text });
      return { pages: [], browserSessions: 0, browserSeconds: 0 };
    },
  });
  const fetcher: ImageFetcher = { async fetchImage(url) { fetched.push(url); return { ok: false, reason: "no network in tests" }; } };

  beforeAll(async () => {
    h = await createMediaHarness({
      adapters: { validator: outfitValidator, discoveryProviders: [record("test-double-purchase-link", ["purchase_source"]), record("test-double-search", ["maker_catalogue", "identifier_search"])], imageFetcher: fetcher },
      extend: (registry) => registerDaily(registry),
    });
    const real = await h.createRealOwner();
    owner = real.owner;
    const inventory = await listInventory(h.db, owner.principal(), {}, { nowMs: h.clock.now() });
    garments = inventory.items.map((i) => ({ garmentId: i.garment.garmentId, name: i.garment.name, category: i.garment.category, roles: i.garment.roles, acquisition: i.garment.acquisition }));
  });

  it("has 127 garments and not one image: every garment says 'No photo yet' and nothing is stored", async () => {
    expect(garments).toHaveLength(127);
    const refs = await garmentImageRefs(h.rt, owner.principal(), garments.map((g) => g.garmentId));
    expect(refs.size).toBe(127);
    for (const ref of refs.values()) {
      expect(ref).toMatchObject({ hasRealImage: false, assetId: null, assetKind: null, renditionId: null, isDemo: false, displayLabel: null, missingImageNote: "No photo yet" });
    }
    const one = await getGarmentMedia(h.rt, owner.principal(), garments[0]!.garmentId);
    expect(one).toMatchObject({ imageState: "not_started", photoRequest: null, assets: [], version: 0 });
    expect(await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/` })).objects).toHaveLength(0);
    expect(await listPhotosNeeded(h.rt, owner.principal())).toEqual([]);
    expect((await listMediaReview(h.rt, owner.principal())).total).toBe(0);
    // The honest backfill range for this wardrobe on the free allowance: 254 browser minutes at worst.
    expect(await getBackfillEstimate(h.rt, owner.principal())).toMatchObject({ totalGarments: 127, resolved: 0, photosNeeded: 0, unresolved: 127, worstCaseBrowserMinutes: 254, estimatedDaysMin: 26, estimatedDaysMax: 51 });
  });

  it("refuses a demo placeholder on every kind of real garment", async () => {
    const png = await encodePng(syntheticShirt({ size: 128 }));
    const byCategory = new Map(garments.map((g) => [g.category, g]));
    expect(byCategory.size).toBeGreaterThan(3);
    for (const g of byCategory.values()) {
      const attempt = await refusal(authorizeUpload(h.rt, owner.principal(), { intent: "garment_photo", garmentId: g.garmentId, contentType: "image/png", byteLength: png.length, demo: true, idempotencyKey: `demo-on-real:${g.garmentId}` }));
      expect(attempt).toEqual({ code: "forbidden", message: "a demo placeholder can only be attached to a synthetic fixture garment, never to a real garment" });
    }
    expect(await all(h.db, "SELECT 1 FROM media_uploads WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("Studio offers the real wardrobe under the real profile: sneakers only while the restriction stands", async () => {
    const today = await getStudioSelectors(h.rt, owner.principal(), { mode: "for_today" });
    const explore = await getStudioSelectors(h.rt, owner.principal(), { mode: "explore" });
    const items = (sel: typeof today, role: Role) => sel.selectors.find((s) => s.role === role)!.items;
    // Only the three 990v4 pairs are wearable today; the boots and Paraboots are shown in Explore as restricted, never as wearable.
    expect(items(today, "footwear").map((i) => i.name).sort()).toEqual(["NB 990v4 — grey", "NB 990v4 — navy", "NB 990v4 — olive/cream"]);
    const restricted = items(explore, "footwear").filter((i) => !i.eligibleToday);
    expect(restricted.map((i) => i.name).sort()).toEqual(["Drake's Clifford boot", "Paraboot Michael Cerf", "Paraboot Reims — café/marron", "Paraboot Reims — noir (black)"]);
    expect(restricted.every((i) => i.marker === "seasonal_or_stored" && i.reasons.includes("restricted"))).toBe(true);
    // Every selector item is one of the 127 imported garments, each without a picture.
    const known = new Set(garments.map((g) => g.garmentId));
    for (const sel of explore.selectors) {
      for (const i of sel.items) {
        expect(known.has(i.garmentId!)).toBe(true);
        expect(i.image).toMatchObject({ hasRealImage: false, missingImageNote: "No photo yet" });
      }
    }
    expect(items(today, "top").length).toBeGreaterThan(10);
    expect(items(today, "bottom").length).toBeGreaterThan(5);

    // The opening outfit is the daily service's own suggestion from real stock, with sneakers and socks.
    expect(today.opening.map((s) => s.role).sort()).toEqual(["bottom", "footwear", "socks", "top"]);
    const footwear = today.opening.find((s) => s.role === "footwear")!;
    expect(items(today, "footwear").map((i) => i.garmentId)).toContain(footwear.garmentId);

    // A boot cannot be worn or planned while the restriction stands; exploring with it is shown as an advisory.
    const boot = restricted.find((i) => i.name === "Paraboot Michael Cerf")!;
    const withBoot = today.opening.map((s) => (s.role === "footwear" ? { role: s.role, garmentId: boot.garmentId! } : { role: s.role, garmentId: s.garmentId! }));
    const verdict = await validateStudioOutfit(h.rt, owner.principal(), { slots: withBoot, mode: "for_today" });
    expect(verdict).toMatchObject({ valid: false, validator: "daily-service" });
    expect(verdict.violations.find((v) => v.severity === "blocking" && v.garmentIds.includes(boot.garmentId!))).toBeDefined();
    const exploring = await validateStudioOutfit(h.rt, owner.principal(), { slots: withBoot, mode: "explore" });
    expect(exploring).toMatchObject({ valid: true, wearableOn: null });
    expect(exploring.violations.find((v) => v.garmentIds.includes(boot.garmentId!))).toMatchObject({ severity: "advisory" });
    const planned = await refusal(owner.exec("studio.plan_for_day", { localDate: "2026-09-16", slots: withBoot }));
    expect(planned.code).toBe("precondition_failed");
    expect(planned.message).toMatch(/^This outfit cannot be planned for 2026-09-16: .*Paraboot Michael Cerf/);
    // No sockless outfit, on the real profile too.
    const sockless = await validateStudioOutfit(h.rt, owner.principal(), { slots: today.opening.filter((s) => s.role !== "socks"), mode: "for_today" });
    expect(sockless.violations.find((v) => v.severity === "blocking")).toMatchObject({ code: "socks_required" });
    // Locking a real shirt: every suggestion keeps it and wears sneakers.
    const shirt = items(today, "top")[0]!;
    const around = await suggestStudioOutfits(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: shirt.garmentId, locked: true }], mode: "for_today", limit: 3 });
    expect(around.length).toBeGreaterThan(0);
    const sneakers = new Set(items(today, "footwear").map((i) => i.garmentId));
    for (const s of around) {
      expect(s.slots.find((x) => x.role === "top")).toMatchObject({ garmentId: shirt.garmentId, locked: true });
      expect(sneakers.has(s.slots.find((x) => x.role === "footwear")!.garmentId)).toBe(true);
    }
  });

  it("saves and plans a real outfit through the command service; its composition names the pieces and shows no invented picture", async () => {
    const opening = (await getStudioSelectors(h.rt, owner.principal(), { mode: "for_today" })).opening;
    const names = new Map(garments.map((g) => [g.garmentId, g.name]));
    const saved = await owner.exec("studio.save_combination", { name: "Tuesday", slots: opening, mode: "for_today" });
    expect(saved).toMatchObject({ outcome: "committed", result: { validation: { valid: true, validator: "daily-service" } } });
    for (const s of opening) expect(saved.summary).toContain(names.get(s.garmentId!)!);
    const planned = await owner.exec("studio.plan_for_day", { localDate: "2026-09-16", combinationId: saved.result.combinationId });
    expect(planned.summary).toMatch(/^Planned for 2026-09-16: .* \(an intention, not a recorded wear\)$/);
    expect(await listStudioCombinations(h.rt, owner.principal())).toHaveLength(1);
    expect(await listStudioDayPlans(h.rt, owner.principal())).toEqual([expect.objectContaining({ localDate: "2026-09-16", needsRevalidation: false })]);
    // Still no wear history: the import created none and planning creates none.
    expect(await all(h.db, "SELECT 1 FROM daily_wears WHERE user_id = ?", owner.userId)).toHaveLength(0);

    const composition = await composeOutfit(h.rt, owner.principal(), { slots: opening });
    expect(composition.labels).toEqual(["No photo yet"]);
    expect(composition.missingImages.sort()).toEqual(opening.map((s) => s.garmentId!).sort());
    expect(composition.manifest.layers.every((l) => l.imageLabel === "missing" && l.assetId === null && l.renditionId === null)).toBe(true);
    for (const s of opening) expect(composition.manifest.caption).toContain(`${names.get(s.garmentId!)} (no photo yet)`);
    // The rendered preview is text tiles only: outlines and names, no image element and no colour.
    const { manifestHash } = await requestCompositePreview(h.rt, owner.principal(), { slots: opening });
    await h.settle(owner);
    expect((await getComposition(h.rt, owner.principal(), manifestHash)).preview.state).toBe("rendered");
    const svg = await new Response((await openCompositePreview(h.rt, owner.principal(), manifestHash, "svg")).body).text();
    expect(svg).not.toContain("<image");
    expect(svg.match(/NO PHOTO YET/g)).toHaveLength(opening.length);
    const png = await decodePng(new Uint8Array(await new Response((await openCompositePreview(h.rt, owner.principal(), manifestHash)).body).arrayBuffer()));
    let coloured = 0;
    for (let i = 0; i < png.data.length; i += 4) if (Math.abs(png.data[i]! - png.data[i + 1]!) > 3 || Math.abs(png.data[i + 1]! - png.data[i + 2]!) > 3) coloured++;
    expect(coloured).toBe(0);
  });

  it("investigates all 127 garments in bounded batches and, finding nothing, asks for a photo of each instead of inventing one", async () => {
    const batches: number[] = [];
    for (let i = 0; i < 8; i++) {
      const receipt = await owner.exec("media.request_discovery", { garmentIds: [] });
      if (receipt.outcome === "noop") break;
      batches.push(Number(receipt.result.queued));
      await h.settle(owner, 120_000);
      if ((await all(h.db, "SELECT 1 FROM garment_media WHERE user_id = ?", owner.userId)).length === 127) break;
    }
    // Never more than one bounded batch per request; the whole wardrobe takes four requests
    // (a garment that could not be searched at all stays eligible, so it can be re-queued in a later batch).
    expect(batches[0]).toBe(40);
    expect(batches.every((n) => n > 0 && n <= 40)).toBe(true);
    expect(batches).toHaveLength(4);
    expect(await all(h.db, "SELECT 1 FROM garment_media WHERE user_id = ? AND image_state = 'searching'", owner.userId)).toHaveLength(0);
    expect(fetched).toEqual([]); // nothing was found, so nothing was fetched
    // Bounded: at most three searches per garment, each made once, built only from the garment's own record.
    const perGarment = new Map<string, number>();
    for (const s of searched) perGarment.set(s.garmentId, (perGarment.get(s.garmentId) ?? 0) + 1);
    expect(Math.max(...perGarment.values())).toBeLessThanOrEqual(3);
    expect(new Set(searched.map((s) => `${s.garmentId}|${s.strategy}|${s.text}`)).size).toBe(searched.length);
    const known = new Set(garments.map((g) => g.garmentId));
    expect(searched.every((s) => known.has(s.garmentId) && s.text.trim().length > 0)).toBe(true);

    // Every garment ends in one of two honest states, and none has an image.
    const states = await all<{ garment_id: string; image_state: string; photo_request: string | null; last_failure: string | null; primary_asset_id: string | null }>(h.db, "SELECT garment_id, image_state, photo_request, last_failure, primary_asset_id FROM garment_media WHERE user_id = ?", owner.userId);
    expect(states).toHaveLength(127);
    expect(states.every((s) => s.primary_asset_id === null)).toBe(true);
    const needed = await listPhotosNeeded(h.rt, owner.principal());
    const unsearchable = states.filter((s) => s.image_state === "not_started");
    expect(needed.length + unsearchable.length).toBe(127);
    expect(needed.length).toBe(perGarment.size); // searched and not found -> Photos needed
    expect(needed.length).toBeGreaterThan(100);
    // A garment with nothing to search by is not declared a failed search: the reason is surfaced instead.
    for (const s of unsearchable) expect(s.last_failure).toMatch(/no purchase link, maker or product code to search with/);
    // One sentence each, naming the garment, worded for its category.
    const byId = new Map(garments.map((g) => [g.garmentId, g]));
    for (const item of needed) {
      const g = byId.get(item.garmentId)!;
      expect(item.name).toBe(g.name);
      expect(item.request).toContain(g.name);
      expect(item.request.endsWith(".")).toBe(true);
      expect(item.request.slice(0, -1)).not.toMatch(/[.!?]\s/); // a single sentence
      if (g.category === "footwear") expect(item.request).toMatch(/^A side-on photo of the pair of /);
    }
    expect(await all(h.db, "SELECT 1 FROM media_assets WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect((await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${owner.userId}/assets/` })).objects).toHaveLength(0);
    const refs = await garmentImageRefs(h.rt, owner.principal(), garments.map((g) => g.garmentId));
    expect([...refs.values()].every((r) => !r.hasRealImage && r.renditionId === null && r.missingImageNote === "No photo yet")).toBe(true);
    expect(await getBackfillEstimate(h.rt, owner.principal())).toMatchObject({ totalGarments: 127, resolved: 0, photosNeeded: needed.length, unresolved: unsearchable.length });

    // Asking again repeats no search; the export carries the state and no image file.
    const before = searched.length;
    await owner.exec("media.request_discovery", { garmentIds: needed.slice(0, 5).map((n) => n.garmentId), retry: true });
    await h.settle(owner);
    expect(searched.length).toBe(before);
    const exported = await exportMediaData(h.rt, owner.principal());
    expect(exported.assets).toEqual([]);
    expect(exported.records.assets).toEqual([]);
    expect(exported.records.garmentMedia).toHaveLength(127);
  });
});
