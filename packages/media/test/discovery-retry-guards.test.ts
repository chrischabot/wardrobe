import { beforeAll, describe, expect, it } from "vitest";
import { all, first, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { createPurchaseLinkProvider, getGarmentMedia, listPhotosNeeded } from "../src/index.ts";
import type { DiscoveryProvider, ImageFetcher } from "../src/index.ts";
import { execSystem } from "../src/exec.ts";
import { encodeJpeg } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt, type MediaHarness } from "../src/testing/index.ts";

// The recorded purchase link is retried when its server is failing (429/5xx) before the garment goes to Photos
// needed; a second image search is never queued while one is outstanding; and a discovery result is accepted
// only for the garment's current search. Real local queue, R2 and ledger. The network behind the purchase-link
// step, the catalogue search provider and the image fetcher are TEST DOUBLES; images are SYNTHETIC TEST IMAGES;
// garments are test records.

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCommandError(e) ? e.code : `threw:${String(e)}`));
const productPage = (sku: string) =>
  `<html><head><script type="application/ld+json">{"@type":"Product","name":"Oxford Shirt","sku":"${sku}","color":"Blue","brand":"Test Maker","image":"/img/${sku}.jpg"}</script></head></html>`;

describe("the purchase-link step retries a failing server before Photos needed (real queue, R2 and ledger)", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  /** Per garment link: the HTTP status each successive request answers with (200 serves the product page). */
  const script = new Map<string, number[]>();
  const requests = new Map<string, number>();
  // TEST DOUBLE for the network behind the recorded purchase link.
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const n = requests.get(url) ?? 0;
    requests.set(url, n + 1);
    const steps = script.get(url) ?? [200];
    const status = steps[Math.min(n, steps.length - 1)]!;
    if (status !== 200) return new Response("failing (test double)", { status });
    return new Response(productPage(url.split("/").pop()!.toUpperCase()), { headers: { "content-type": "text/html" } });
  };
  // TEST DOUBLE: the catalogue and identifier searches find nothing, so only the purchase link can resolve a garment.
  const nothing: DiscoveryProvider = { name: "test-double-empty-search", strategies: ["maker_catalogue", "identifier_search"], usesBrowser: false, async search() { return { pages: [], browserSessions: 0, browserSeconds: 0 }; } };
  const shirtJpeg = encodeJpeg(syntheticShirt({ size: 512 }), 90);
  // TEST DOUBLE for the network: every candidate image is the same synthetic shirt.
  const fetcher: ImageFetcher = { async fetchImage(url) { return { ok: true, bytes: shirtJpeg, contentType: "image/jpeg", finalUrl: url }; } };

  /** A test-record garment with a product code and a recorded purchase link (written as the inventory import does). */
  async function linkedGarment(id: string, sku: string, statuses: number[]): Promise<string> {
    await owner.exec("garment.create", { garmentId: id, name: `test record ${id}`, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", aliases: [{ phrase: sku, kind: "code" }], source: { kind: "system", note: "test record" } });
    const link = `https://shop.example.org/products/${sku.toLowerCase()}`;
    // TEST SETUP: the purchase-link fact, as data/import records it from the inventory's link column.
    await h.db.prepare("INSERT INTO garment_facts (user_id, fact_id, garment_id, attribute, value_json, source_json, scope, superseded_by, command_id, recorded_at) VALUES (?, ?, ?, 'purchase_link', ?, '{\"kind\":\"system\"}', NULL, NULL, NULL, ?)").bind(owner.userId, `fact-${id}`, id, JSON.stringify(link), h.clock.iso()).run();
    script.set(link, statuses);
    return link;
  }
  const round = async (id: string) => {
    await owner.exec("media.request_discovery", { garmentIds: [id] });
    await h.settle(owner);
    return getGarmentMedia(h.rt, owner.principal(), id);
  };
  // The test clock does not move between rounds, so outcomes are compared as a sorted list.
  const purchaseOutcomes = async (id: string) => (await all<{ outcome: string }>(h.db, "SELECT outcome FROM media_discovery_attempts WHERE user_id = ? AND garment_id = ? AND strategy = 'purchase_source'", owner.userId, id)).map((r) => r.outcome).sort();
  const needed = async (id: string) => (await listPhotosNeeded(h.rt, owner.principal())).some((p) => p.garmentId === id);

  beforeAll(async () => {
    h = await createMediaHarness({ adapters: { discoveryProviders: [createPurchaseLinkProvider({ fetchImpl, resolver: null, now: () => Date.parse("2026-09-15T08:00:00Z") }), nothing], imageFetcher: fetcher } });
    owner = await h.createOwner({ synthetic: false, displayName: "Purchase-link retry owner (test records only)" });
  });

  it("a 500 from the purchase link defers the search instead of Photos needed, and the next round adopts the page's photo", async () => {
    const link = await linkedGarment("r-500", "PCF9001", [500, 200]);
    const first_ = await round("r-500");
    expect(first_.imageState).not.toBe("photos_needed");
    expect(await needed("r-500")).toBe(false);
    expect(await purchaseOutcomes("r-500")).toEqual(["provider_unavailable"]);
    const second = await round("r-500");
    expect(requests.get(link)).toBe(2);
    expect(second.imageState).toBe("resolved");
    expect(second.image).toMatchObject({ hasRealImage: true, assetKind: "exact_product_photo", isDemo: false });
    expect(await purchaseOutcomes("r-500")).toEqual(["adopted", "provider_unavailable"]);
  });

  it("a link that keeps failing with 503 reaches Photos needed only after three attempts, while a 404 is final at once", async () => {
    const down = await linkedGarment("r-503", "PCF9002", [503]);
    expect((await round("r-503")).imageState).not.toBe("photos_needed");
    expect((await round("r-503")).imageState).not.toBe("photos_needed");
    expect((await round("r-503")).imageState).toBe("photos_needed");
    expect(requests.get(down)).toBe(3);
    expect(await purchaseOutcomes("r-503")).toEqual(["provider_error", "provider_unavailable", "provider_unavailable"]);
    expect(await needed("r-503")).toBe(true);

    const gone = await linkedGarment("r-404", "PCF9003", [404]);
    expect((await round("r-404")).imageState).toBe("photos_needed");
    expect(requests.get(gone)).toBe(1);
    expect(await purchaseOutcomes("r-404")).toEqual(["provider_error"]);
  });
});

describe("one image search per garment at a time, and results only for the current search (real ledger)", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  const create = (id: string) =>
    owner.exec("garment.create", { garmentId: id, name: `test record ${id}`, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", source: { kind: "system", note: "test record" } });
  const discoverJobs = (id: string) => all<{ job_id: string; state: string }>(h.db, "SELECT job_id, state FROM media_jobs WHERE user_id = ? AND kind = 'discover' AND subject_id = ? ORDER BY created_at, job_id", owner.userId, id);
  const emptyResult = (garmentId: string, jobId: string, attempt: number) => ({ garmentId, jobId, attempt, attempts: [], candidates: [], conclusion: "deferred" as const, note: "test record" });

  beforeAll(async () => {
    h = await createMediaHarness();
    owner = await h.createOwner({ synthetic: false, displayName: "Discovery guard owner (test records only)" });
  });

  it("a second request for a product photo beside the owner's own queues nothing while the first is outstanding", async () => {
    await create("q-own");
    await h.upload(owner, { garmentId: "q-own", raster: syntheticShirt({ size: 256 }) });
    await h.settle(owner);
    const firstRequest = await owner.exec("media.request_discovery", { garmentIds: ["q-own"], seekProductPhoto: true });
    expect(firstRequest.result).toMatchObject({ queued: 1 });
    // The garment keeps showing the owner's photo (resolved) while the search is queued.
    expect((await getGarmentMedia(h.rt, owner.principal(), "q-own")).imageState).toBe("resolved");
    const again = await owner.exec("media.request_discovery", { garmentIds: ["q-own"], seekProductPhoto: true });
    expect(again.outcome).toBe("noop");
    expect(await discoverJobs("q-own")).toEqual([{ job_id: expect.any(String), state: "queued" }]);
  });

  it("refuses a discovery result for another garment's job, a job of another kind, or a search a newer round replaced", async () => {
    await create("q-a");
    await create("q-b");
    await owner.exec("media.request_discovery", { garmentIds: ["q-a", "q-b"] });
    const [jobA] = await discoverJobs("q-a");
    const [jobB] = await discoverJobs("q-b");
    // TEST SETUP: both searches are running under their first attempt.
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 1, lease_until = ? WHERE user_id = ? AND kind = 'discover' AND subject_id IN ('q-a', 'q-b')").bind(new Date(h.clock.now() + 600_000).toISOString(), owner.userId).run();
    // Another garment's job.
    expect(await code(execSystem(h.rt, owner.userId, "media.record_discovery", emptyResult("q-a", jobB!.job_id, 1), "wrong-garment"))).toBe("invalid_command");
    // A job of another kind (a photograph's normalization).
    await create("q-c");
    await h.upload(owner, { garmentId: "q-c", raster: syntheticShirt({ size: 256 }) });
    const normalize = await first<{ job_id: string }>(h.db, "SELECT job_id FROM media_jobs WHERE user_id = ? AND kind = 'normalize' LIMIT 1", owner.userId);
    expect(await code(execSystem(h.rt, owner.userId, "media.record_discovery", emptyResult("q-a", normalize!.job_id, 1), "wrong-kind"))).toBe("invalid_command");
    // TEST SETUP: a newer request replaced q-a's search (its record names round 2).
    await h.db.prepare("UPDATE garment_media SET discovery_json = json_set(discovery_json, '$.rounds', 2) WHERE user_id = ? AND garment_id = 'q-a'").bind(owner.userId).run();
    expect(await code(execSystem(h.rt, owner.userId, "media.record_discovery", emptyResult("q-a", jobA!.job_id, 1), "replaced-round"))).toBe("precondition_failed");
    expect(await first(h.db, "SELECT state FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobA!.job_id)).toEqual({ state: "running" });
    // TEST SETUP: a superseded search job for the same garment, still running under its first attempt.
    await h.db.prepare("INSERT INTO media_jobs (user_id, job_id, kind, subject_id, dedupe_key, state, attempts, max_attempts, lease_until, payload_json, command_id, created_at, updated_at) SELECT user_id, 'job_q-b_superseded', kind, subject_id, 'q-b-superseded', 'running', 1, max_attempts, lease_until, payload_json, command_id, created_at, updated_at FROM media_jobs WHERE user_id = ? AND job_id = ?").bind(owner.userId, jobB!.job_id).run();
    expect(await code(execSystem(h.rt, owner.userId, "media.record_discovery", emptyResult("q-b", "job_q-b_superseded", 1), "superseded-job"))).toBe("precondition_failed");
    expect(await all(h.db, "SELECT 1 FROM media_discovery_attempts WHERE user_id = ? AND garment_id = 'q-b'", owner.userId)).toHaveLength(0);
    // The current search's own result is accepted.
    expect(await code(execSystem(h.rt, owner.userId, "media.record_discovery", emptyResult("q-b", jobB!.job_id, 1), "current-search"))).toBe("ok");
    expect(await first(h.db, "SELECT state FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobB!.job_id)).toEqual({ state: "succeeded" });
  });
});
