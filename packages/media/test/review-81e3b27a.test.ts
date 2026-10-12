import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, first, isCommandError, toInstant } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { createCloudflareImagesTranscoder, exportMediaData, getGarmentMedia, heifWithoutMetadata, importMediaData, readExportFile, type BackgroundRemover, type DiscoveryCandidatePage, type DiscoveryProvider, type ImageFetcher } from "../src/index.ts";
import type { DiscoveryBudget } from "../src/adapters.ts";
import { execSystem } from "../src/exec.ts";
import { runMediaJob } from "../src/jobs.ts";
import { compositeKey } from "../src/keys.ts";
import { encodeJpeg, type Raster } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt } from "../src/testing/index.ts";

// Regression tests for the review of prepared patch 81e3b27a: job fencing and abandonment, the background
// remover's unusable output, import packing, repeat and identity, discovery deferral, WebP candidates, browser
// reservations and HEIC cleaning. SYNTHETIC TEST IMAGES on synthetic fixture garments or test records. The
// background remover, search providers and image fetcher are TEST DOUBLES; the WebP converter is the local
// runtime's implementation of the Images binding. The HEIC structures are hand-built TEST DATA.

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCommandError(e) ? e.code : `threw:${String(e)}`));
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("");
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u16 = (n: number) => new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
const jobRow = (h: { db: unknown }, userId: string, jobId: string) => first<{ state: string; attempts: number; max_attempts: number }>(h.db as never, "SELECT state, attempts, max_attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", userId, jobId);

describe("review of 81e3b27a: job results are fenced by the runner's claim", () => {
  it("refuses a result from a runner whose claim was taken over, writing nothing, and records the current claim's result", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (job fence)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    const jobId = up.jobId!;
    // TEST SETUP: runner 1's claim (attempt 1) lapsed and runner 2 claimed the job (attempt 2), lease still valid.
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 2, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() + 600_000), owner.userId, jobId).run();
    expect(await code(execSystem(h.rt, owner.userId, "media.fail_job", { jobId, attempt: 1, error: "stale runner" }, `stale:${jobId}`))).toBe("precondition_failed");
    expect(await jobRow(h, owner.userId, jobId)).toMatchObject({ state: "running", attempts: 2 });
    expect(await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND idempotency_key = ?", owner.userId, `stale:${jobId}`)).toHaveLength(0);
    await execSystem(h.rt, owner.userId, "media.fail_job", { jobId, attempt: 2, error: "current runner" }, `current:${jobId}`);
    expect((await jobRow(h, owner.userId, jobId))!.state).not.toBe("running");
  });

  it("abandons an exhausted job only while its lease has lapsed; a renewed one is neither abandoned nor taken", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (abandonment fence)" });
    const lapsed = (await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true })).jobId!;
    const renewed = (await h.upload(owner, { garmentId: "shirt-gold", raster: syntheticShirt({ size: 128 }), demo: true })).jobId!;
    // TEST SETUP: both jobs have used every attempt; one runner vanished (lease lapsed), the other renewed its lease.
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = max_attempts, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() - 1000), owner.userId, lapsed).run();
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = max_attempts, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() + 600_000), owner.userId, renewed).run();
    expect(await runMediaJob(h.rt, owner.userId, lapsed)).toBe("dead");
    expect((await jobRow(h, owner.userId, lapsed))!.state).not.toBe("running");
    expect(await runMediaJob(h.rt, owner.userId, renewed)).toBe("skipped");
    const live = (await jobRow(h, owner.userId, renewed))!;
    expect(live.state).toBe("running");
    // An abandonment planned against the renewed claim is refused inside its commit.
    expect(await code(execSystem(h.rt, owner.userId, "media.fail_job", { jobId: renewed, attempt: live.attempts, abandonExpiredBefore: toInstant(h.clock.now()), error: "abandoned" }, `abandon:${renewed}`))).toBe("precondition_failed");
    expect((await jobRow(h, owner.userId, renewed))!.state).toBe("running");
  });

  it("a claim returns the attempt it took, and the job runs to completion under it", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (claim)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true })).jobId!;
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(await jobRow(h, owner.userId, jobId)).toMatchObject({ state: "succeeded", attempts: 1 });
    // A second delivery of the same message finds nothing to claim.
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("skipped");
  });
});

/** SYNTHETIC TEST IMAGE: a block of colour on a patterned (not uniform) background, so no source-pixel cutout is possible. */
function onPatternedBackground(size: number): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = x > size / 4 && x < (3 * size) / 4 && y > size / 4 && y < (3 * size) / 4;
      const v = ((x * 37 + y * 91) % 160) + 40;
      data[i] = inside ? 30 : v;
      data[i + 1] = inside ? 90 : (v * 3) % 255;
      data[i + 2] = inside ? 60 : (v * 7) % 255;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

describe("review of 81e3b27a: a background remover's unusable output is discarded", () => {
  it("a remover that returns bytes that are not a picture leaves the job successful with the photo as taken, not failed", async () => {
    const calls: number[] = [];
    // TEST DOUBLE: a background remover that answers with something that is not a PNG.
    const remover: BackgroundRemover = { name: "test-double-remover", version: "0", async remove() { calls.push(1); return { ok: true, png: ascii("TEST: not a png") }; } };
    const h = await createMediaHarness({ adapters: { backgroundRemover: remover } });
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (remover output)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true });
    await h.settle(owner);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect((await jobRow(h, owner.userId, up.jobId!))!.state).toBe("succeeded");
    const kinds = (await all<{ kind: string }>(h.db, "SELECT kind FROM media_renditions WHERE user_id = ? AND asset_id = ?", owner.userId, up.asset!.assetId)).map((r) => r.kind);
    expect(kinds).toContain("original");
    expect(kinds).not.toContain("cutout");
  });
});

describe("review of 81e3b27a: imports are packed, identified by their contents, and a repeat writes nothing", () => {
  const importer = (o: TestOwner) => o.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });

  it("refuses an import command with more than 400 rows of one kind", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (row limit)" });
    const rows = Array.from({ length: 401 }, (_, i) => ({ garment_id: `g-${i}`, image_state: "not_started", primary_asset_id: null, version: 1, updated_at: h.clock.iso() }));
    expect(await code(h.service.execute(importer(owner), { type: "media.import_records", payload: { part: "garmentMedia", rows: { garmentMedia: rows } }, idempotencyKey: "row-limit", expectedVersions: {}, authorization: "data_import", source: { channel: "import" } }))).toBe("invalid_command");
  });

  it("splits many images into several commands, refuses a repeat before writing any file, and refuses a different package with the same export time", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (packing source)" });
    for (let i = 0; i < 26; i++) await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 96 + i }), demo: true });
    await h.settle(source);
    const data = await exportMediaData(h.rt, source.principal());
    expect(data.records.assets.length).toBe(26);
    const fromSource = (file: string) => readExportFile(h.rt, source.principal(), file);
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (packing target)" });
    const result = await importMediaData(h.rt, importer(target), data, fromSource);
    expect(result.imported.assets).toBe(26);
    // At most 25 images per command: 26 images take two.
    const assetCommands = await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'media.import_records' AND idempotency_key LIKE '%:assets:assets:%'", target.userId);
    expect(assetCommands).toHaveLength(2);

    const stored = async () => (await h.bindings.MEDIA_BUCKET.list({ prefix: `u/${target.userId}/` })).objects.map((o) => [o.key, o.uploaded.toISOString(), o.etag]).sort();
    const before = await stored();
    expect(await code(importMediaData(h.rt, importer(target), data, fromSource))).toBe("precondition_failed");
    expect(await stored()).toEqual(before);
    // Same owner, same export time, different contents: a different import, refused while the owner has media.
    expect(await code(importMediaData(h.rt, importer(target), { ...data, records: { ...data.records, combinations: [], combinationItems: [] } }, fromSource))).toBe("precondition_failed");
    expect(await stored()).toEqual(before);
  });

  it("an owner holding only Studio or composite records is not empty, and every journal deletion survives as a tombstone", async () => {
    const h = await createMediaHarness();
    const source = await h.createSyntheticOwner({ displayName: "Synthetic owner (journal source)" });
    await h.upload(source, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(source);
    const data = await exportMediaData(h.rt, source.principal());
    const fromSource = (file: string) => readExportFile(h.rt, source.principal(), file);
    // TEST SETUP: an owner whose only media-family record is one outfit composite.
    const occupied = await h.createSyntheticOwner({ displayName: "Synthetic owner (composite only)" });
    await h.db.prepare("INSERT INTO outfit_composites (user_id, manifest_hash, manifest_json, template_version, preview_state, created_at, updated_at) VALUES (?, ?, '{}', 1, 'none', ?, ?)").bind(occupied.userId, "a".repeat(64), h.clock.iso(), h.clock.iso()).run();
    expect(await code(importMediaData(h.rt, importer(occupied), data, fromSource))).toBe("precondition_failed");
    // An image created and deleted after the package was made is in neither its records nor its tombstones,
    // only in the deletion journal given with it: its deletion history is still imported.
    const journal = { format: "garderobe-media-deletions/1" as const, writtenAt: h.clock.iso(), deletedAssets: [{ assetId: "ast_after_backup", deletedAt: h.clock.iso(), renditionIds: [], files: [] }], purgedOriginals: [] };
    const target = await h.createSyntheticOwner({ displayName: "Synthetic owner (journal target)" });
    const result = await importMediaData(h.rt, importer(target), data, fromSource, { deletions: journal });
    expect(result.deletionsApplied.tombstonesImported).toBeGreaterThanOrEqual(1);
    expect(await first(h.db, "SELECT status, status_reason FROM media_assets WHERE user_id = ? AND asset_id = 'ast_after_backup'", target.userId)).toEqual({ status: "deleted", status_reason: "deleted after the restored backup was taken" });
  });
});

describe("review of 81e3b27a: discovery defers unfinished investigations, checks WebP candidates and reserves browser time", () => {
  const images = (env as unknown as { IMAGES: ImagesBinding }).IMAGES;
  const page = (over: Partial<DiscoveryCandidatePage>): DiscoveryCandidatePage => ({ pageUrl: "https://maker.example.org/p", imageUrl: "https://img.example.org/p.webp", title: null, sourceClass: "maker", identifiers: {}, retrievedAt: "2026-09-15T08:00:00Z", ...over });
  const create = (owner: TestOwner, id: string, extra: Record<string, unknown> = {}) =>
    owner.exec("garment.create", { garmentId: id, name: `test record ${id}`, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", source: { kind: "system", note: "test record" }, ...extra });

  it("a strategy no provider can search keeps the garment deferred, not in Photos needed", async () => {
    // TEST DOUBLE: a maker-catalogue search that finds nothing; nothing can search by identifiers.
    const makerOnly: DiscoveryProvider = { name: "test-double-maker", strategies: ["maker_catalogue"], usesBrowser: false, async search() { return { pages: [], browserSessions: 0, browserSeconds: 0 }; } };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [makerOnly] } });
    const owner = await h.createOwner({ synthetic: false, displayName: "Discovery deferral owner (test records only)" });
    await create(owner, "defer-1", { aliases: [{ phrase: "PCF7001", kind: "code" }] });
    await owner.exec("media.request_discovery", { garmentIds: ["defer-1"] });
    await h.settle(owner);
    const media = await getGarmentMedia(h.rt, owner.principal(), "defer-1");
    expect(media.imageState).not.toBe("photos_needed");
    expect(media.lastFailure).toMatch(/no provider is configured for identifier search/);
  });

  it("a WebP candidate is taken only after its pixels were read through the converter", async () => {
    const webp = new Uint8Array(await new Response((await images.input(new Response(encodeJpeg(syntheticShirt({ size: 512 }), 90)).body!).output({ format: "image/webp", quality: 90 })).image()).arrayBuffer());
    const pages = new Map<string, DiscoveryCandidatePage[]>();
    const search: DiscoveryProvider = { name: "test-double-search", strategies: ["maker_catalogue", "identifier_search"], usesBrowser: false, async search(q) { return { pages: pages.get(`${q.garment.garmentId}:${q.strategy}`) ?? [], browserSessions: 0, browserSeconds: 0 }; } };
    // TEST DOUBLE for the network: every candidate image is the same WebP picture.
    const fetcher: ImageFetcher = { async fetchImage(url) { return { ok: true, bytes: webp, contentType: "image/webp", finalUrl: url }; } };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [search], imageFetcher: fetcher } });
    const owner = await h.createOwner({ synthetic: false, displayName: "Discovery WebP owner (test records only)" });

    await create(owner, "webp-unchecked", { aliases: [{ phrase: "PCF7101", kind: "code" }] });
    pages.set("webp-unchecked:maker_catalogue", [page({ identifiers: { productCodes: ["PCF7101"], maker: "Test Maker" } })]);
    await owner.exec("media.request_discovery", { garmentIds: ["webp-unchecked"] });
    await h.settle(owner);
    expect((await getGarmentMedia(h.rt, owner.principal(), "webp-unchecked")).imageState).not.toBe("resolved");
    const refused = await all<{ rejection_reasons_json: string }>(h.db, "SELECT rejection_reasons_json FROM media_candidates WHERE user_id = ? AND garment_id = 'webp-unchecked'", owner.userId);
    expect(refused.map((r) => r.rejection_reasons_json)).toContain('["image_quality"]');

    h.deps.transcoder = createCloudflareImagesTranscoder(images);
    await create(owner, "webp-checked", { aliases: [{ phrase: "PCF7102", kind: "code" }] });
    pages.set("webp-checked:maker_catalogue", [page({ identifiers: { productCodes: ["PCF7102"], maker: "Test Maker" } })]);
    await owner.exec("media.request_discovery", { garmentIds: ["webp-checked"] });
    await h.settle(owner);
    expect((await getGarmentMedia(h.rt, owner.principal(), "webp-checked")).imageState).toBe("resolved");
  });

  it("browser time another job has reserved is not spent again; a search gets its reserved seconds and the reservation is released", async () => {
    const budgets: DiscoveryBudget[] = [];
    // TEST DOUBLE: a browser search that finds nothing and reports one minute used.
    const browser: DiscoveryProvider = { name: "test-double-browser", strategies: ["maker_catalogue", "identifier_search"], usesBrowser: true, async search(_q, budget) { budgets.push(budget); return { pages: [], browserSessions: 1, browserSeconds: 60 }; } };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [browser] } });
    const owner = await h.createOwner({ synthetic: false, displayName: "Discovery reservation owner (test records only)" });
    await owner.exec("settings.update", { patch: { extensions: { media: { browserMinutesPerDay: 6, interactiveReserveMinutesPerDay: 5 } } } });
    // TEST SETUP: another job holds the whole minute available for backfill today.
    await h.db.prepare("INSERT INTO media_browser_reservations (user_id, reservation_id, job_id, seconds, expires_at, created_at) VALUES (?, 'other', 'job_other', 60, ?, ?)").bind(owner.userId, toInstant(h.clock.now() + 3_600_000), h.clock.iso()).run();
    await create(owner, "reserve-1");
    await owner.exec("media.request_discovery", { garmentIds: ["reserve-1"] });
    await h.settle(owner);
    expect(budgets).toHaveLength(0);
    expect((await getGarmentMedia(h.rt, owner.principal(), "reserve-1")).lastFailure).toMatch(/today's browser allowance for backfill is used/);

    await h.db.prepare("DELETE FROM media_browser_reservations WHERE user_id = ? AND reservation_id = 'other'").bind(owner.userId).run();
    await create(owner, "reserve-2");
    await owner.exec("media.request_discovery", { garmentIds: ["reserve-2"] });
    await h.settle(owner);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ maxBrowserSeconds: 60 });
    expect(budgets[0]!.signal).toBeDefined();
    expect(await all(h.db, "SELECT 1 FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("a search whose run stopped before recording it is recorded from what it returned, not repeated, and its browser time stays spent", async () => {
    let calls = 0;
    let fetches = 0;
    // TEST DOUBLE: a browser search that finds one candidate page and reports one minute used.
    const browser: DiscoveryProvider = { name: "test-double-browser", strategies: ["maker_catalogue"], usesBrowser: true, async search() { calls++; return { pages: [page({ imageUrl: "https://img.example.org/p.jpg", identifiers: { productCodes: ["PCF7301"], maker: "Test Maker" } })], browserSessions: 1, browserSeconds: 60 }; } };
    // TEST DOUBLE for the network: the first run stops (throws) while fetching the candidate image; later the image is not found.
    const fetcher: ImageFetcher = { async fetchImage() { if (fetches++ === 0) throw new Error("simulated stop after the search"); return { ok: false, reason: "not found (test double)" }; } };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [browser], imageFetcher: fetcher } });
    const owner = await h.createOwner({ synthetic: false, displayName: "Discovery stopped-run owner (test records only)" });
    await owner.exec("settings.update", { patch: { extensions: { media: { browserMinutesPerDay: 7, interactiveReserveMinutesPerDay: 5 } } } });
    await create(owner, "stopped-1", { aliases: [{ phrase: "PCF7301", kind: "code" }] });
    await owner.exec("media.request_discovery", { garmentIds: ["stopped-1"] });
    const jobId = (await first<{ job_id: string }>(h.db, "SELECT job_id FROM media_jobs WHERE user_id = ? AND subject_id = 'stopped-1'", owner.userId))!.job_id;
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
    expect(calls).toBe(1);
    // The search's claim was settled the moment it returned: the minute it used is held against the allowance.
    expect(await first(h.db, "SELECT seconds, browser_sessions, settled_at IS NOT NULL AS settled FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toEqual({ seconds: 60, browser_sessions: 1, settled: 1 });
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(calls).toBe(1); // not repeated
    expect(fetches).toBe(2); // the candidate it returned was evaluated by the run that recorded it
    const attempts = await all<{ outcome: string; browser_seconds: number; pages_examined: number }>(h.db, "SELECT outcome, browser_seconds, pages_examined FROM media_discovery_attempts WHERE user_id = ? AND garment_id = 'stopped-1'", owner.userId);
    expect(attempts).toEqual([{ outcome: "no_match", browser_seconds: 60, pages_examined: 1 }]);
    expect(await all(h.db, "SELECT 1 FROM media_candidates WHERE user_id = ? AND garment_id = 'stopped-1'", owner.userId)).toHaveLength(1);
    expect(await all(h.db, "SELECT 1 FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("an unavailable provider keeps the garment deferred to try again; a permanent refusal is final and leads to Photos needed", async () => {
    // TEST DOUBLE: a search that always fails, retryable or not depending on the garment.
    const failing: DiscoveryProvider = {
      name: "test-double-failing", strategies: ["maker_catalogue", "identifier_search"], usesBrowser: false,
      async search(q) { return q.garment.garmentId.startsWith("down") ? { pages: [], browserSessions: 0, browserSeconds: 0, error: "service unavailable (simulated)" } : { pages: [], browserSessions: 0, browserSeconds: 0, error: "refused (simulated)", retryable: false }; },
    };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [failing] } });
    const owner = await h.createOwner({ synthetic: false, displayName: "Discovery provider-failure owner (test records only)" });
    await create(owner, "down-1");
    await create(owner, "refused-1");
    await owner.exec("media.request_discovery", { garmentIds: ["down-1", "refused-1"] });
    await h.settle(owner);
    const outcomes = async (id: string) => (await all<{ outcome: string }>(h.db, "SELECT outcome FROM media_discovery_attempts WHERE user_id = ? AND garment_id = ?", owner.userId, id)).map((a) => a.outcome);
    expect(await outcomes("down-1")).toEqual(["provider_unavailable", "provider_unavailable"]);
    const down = await getGarmentMedia(h.rt, owner.principal(), "down-1");
    expect(down.imageState).not.toBe("photos_needed");
    expect(down.lastFailure).toMatch(/tried again later/);
    expect(await outcomes("refused-1")).toEqual(["provider_error", "provider_error"]);
    expect((await getGarmentMedia(h.rt, owner.principal(), "refused-1")).imageState).toBe("photos_needed");
  });

  it("a WebP candidate goes to the converter only without its metadata", async () => {
    const plain = new Uint8Array(await new Response((await images.input(new Response(encodeJpeg(syntheticShirt({ size: 512 }), 90)).body!).output({ format: "image/webp", quality: 90 })).image()).arrayBuffer());
    const tagged = webpWithXmp(plain, 512, 512, "<x:xmpmeta>TEST-WEBP-XMP-POSITION</x:xmpmeta>");
    expect(latin1(tagged)).toContain("TEST-WEBP-XMP-POSITION");
    const search: DiscoveryProvider = { name: "test-double-search", strategies: ["maker_catalogue"], usesBrowser: false, async search() { return { pages: [page({ identifiers: { productCodes: ["PCF7201"], maker: "Test Maker" } })], browserSessions: 0, browserSeconds: 0 }; } };
    const fetcher: ImageFetcher = { async fetchImage(url) { return { ok: true, bytes: tagged, contentType: "image/webp", finalUrl: url }; } };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [search], imageFetcher: fetcher } });
    // The real local Images converter, observed: every input it receives is kept for inspection.
    const real = createCloudflareImagesTranscoder(images);
    const sent: Uint8Array[] = [];
    h.deps.transcoder = { ...real, async toPng(input) { sent.push(input.bytes); return real.toPng(input); } };
    const owner = await h.createOwner({ synthetic: false, displayName: "Discovery WebP metadata owner (test records only)" });
    await create(owner, "webp-tagged", { aliases: [{ phrase: "PCF7201", kind: "code" }] });
    await owner.exec("media.request_discovery", { garmentIds: ["webp-tagged"] });
    await h.settle(owner);
    expect(sent.length).toBeGreaterThan(0);
    for (const bytes of sent) expect(latin1(bytes)).not.toContain("TEST-WEBP-XMP-POSITION");
  });
});

/** TEST DATA: a WebP picture with an XMP chunk added (extended format), for the metadata-removal checks. */
function webpWithXmp(webp: Uint8Array, width: number, height: number, xmp: string): Uint8Array {
  const le32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const le24 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);
  const chunk = (type: string, payload: Uint8Array) => concat(ascii(type), le32(payload.length), payload, payload.length % 2 ? new Uint8Array(1) : new Uint8Array(0));
  let chunks = webp.subarray(12);
  if (latin1(chunks.subarray(0, 4)) === "VP8X") {
    chunks = chunks.slice();
    chunks[8] = chunks[8]! | 0x04; // the XMP flag
  } else chunks = concat(chunk("VP8X", concat(new Uint8Array([0x04, 0, 0, 0]), le24(width - 1), le24(height - 1))), chunks);
  const body = concat(ascii("WEBP"), chunks, chunk("XMP ", ascii(xmp)));
  return concat(ascii("RIFF"), le32(body.length), body);
}

/** TEST DATA: a HEIC file with a named picture item, an Exif item, optionally a MIME item, and bytes no item uses. */
function heic(opts: { mimeType?: string; trailing?: Uint8Array; exifAt?: "overlapping_picture" | "in_header"; dinf?: Uint8Array; ilocTail?: Uint8Array; pictureMethod?: number; dataRef?: number; pictureUnlocated?: boolean; noExif?: boolean; noIloc?: boolean } = {}): { bytes: Uint8Array; picture: Uint8Array } {
  const box = (type: string, ...payload: Uint8Array[]) => {
    const body = concat(...payload);
    return concat(u32(8 + body.length), ascii(type), body);
  };
  const full = (type: string, version: number, ...payload: Uint8Array[]) => box(type, new Uint8Array([version, 0, 0, 0]), ...payload);
  const picture = concat(u32("TEST-HEVC-PICTURE-DATA-KEPT".length + 2), new Uint8Array([1 << 1, 0x01]), ascii("TEST-HEVC-PICTURE-DATA-KEPT")); // one length-prefixed HEVC slice unit
  const exif = concat(u32(0), ascii("TEST-EXIF-GPS-POSITION"));
  const mime = ascii("<x:xmpmeta>TEST-XMP-POSITION</x:xmpmeta>");
  const stale = ascii("TEST-STALE-UNREFERENCED-POSITION");
  const ftyp = box("ftyp", ascii("heic"), u32(0), ascii("mif1"), ascii("heic"));
  // An HEVC decoder configuration with 4-byte unit lengths and no parameter-set arrays.
  const hvcC = new Uint8Array(23);
  hvcC[0] = 1;
  hvcC[21] = 0xff;
  const items = [full("infe", 2, u16(1), u16(0), ascii("hvc1"), ascii("TEST-PICTURE-NAME-POSITION\0")), ...(opts.noExif ? [] : [full("infe", 2, u16(2), u16(0), ascii("Exif"), ascii("\0"))])];
  if (opts.mimeType !== undefined) items.push(full("infe", 2, u16(3), u16(0), ascii("mime"), ascii("\0"), ascii(`${opts.mimeType}\0`)));
  // Version 0 has no construction method; with `pictureMethod` the box is version 1 and every item states one.
  const method = (m: number) => (opts.pictureMethod === undefined ? new Uint8Array(0) : u16(m));
  const iloc = (at: number) =>
    full("iloc", opts.pictureMethod === undefined ? 0 : 1, new Uint8Array([0x44, 0x00]), u16(items.length),
      opts.pictureUnlocated ? concat(u16(1), method(opts.pictureMethod ?? 0), u16(opts.dataRef ?? 0), u16(0)) : concat(u16(1), method(opts.pictureMethod ?? 0), u16(opts.dataRef ?? 0), u16(1), u32(at), u32(picture.length)),
      ...(opts.noExif ? [] : [u16(2), method(0), u16(0), u16(1), u32(opts.exifAt === "overlapping_picture" ? at : opts.exifAt === "in_header" ? 8 : at + picture.length), u32(exif.length)]),
      ...(opts.mimeType !== undefined ? [u16(3), method(0), u16(0), u16(1), u32(at + picture.length + exif.length), u32(mime.length)] : []),
      opts.ilocTail ?? new Uint8Array(0));
  const meta = (at: number) =>
    full("meta", 0,
      full("hdlr", 0, u32(0), ascii("pict"), ascii("TEST-RESERVED"), ascii("TEST-HDLR-NAME-POSITION\0")),
      full("iinf", 0, u16(items.length), ...items),
      box("iprp", box("ipco", full("ispe", 0, u32(512), u32(512)), box("hvcC", hvcC)), full("ipma", 0, u32(1), u16(1), new Uint8Array([2, 0x81, 0x82]))),
      opts.noIloc ? new Uint8Array(0) : iloc(at),
      opts.dinf ?? new Uint8Array(0));
  const at = ftyp.length + meta(0).length + 8;
  const data = opts.mimeType !== undefined ? concat(picture, exif, mime, stale) : concat(picture, exif, stale);
  return { bytes: concat(ftyp, meta(at), box("mdat", data), opts.trailing ?? new Uint8Array(0)), picture };
}

describe("review of 81e3b27a: HEIC cleaning passes on only the picture", () => {
  it("clears image data no picture uses, the handler's name and every item's descriptive text, and keeps the picture bytes", () => {
    const { bytes, picture } = heic();
    // "TEST-RESERVED" is 13 bytes: the hdlr reserved field (12) plus the first byte of the name area.
    expect(latin1(bytes)).toContain("TEST-STALE-UNREFERENCED-POSITION");
    const out = heifWithoutMetadata(bytes);
    expect(out).toMatchObject({ ok: true, removedItems: 1 });
    const clean = (out as { bytes: Uint8Array }).bytes;
    expect(clean.length).toBe(bytes.length);
    expect(latin1(clean)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    expect(latin1(clean)).not.toContain("TEST-RESERVED");
    expect(latin1(clean)).toContain(latin1(picture));
  });

  it("accepts an XMP item whose content type has parameters, clearing them, and refuses any other content type", () => {
    const withParams = heifWithoutMetadata(heic({ mimeType: "application/rdf+xml; note=TEST-PARAM-POSITION" }).bytes);
    expect(withParams).toMatchObject({ ok: true, removedItems: 2 });
    expect(latin1((withParams as { bytes: Uint8Array }).bytes)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    for (const other of ["application/rdf+xml-TEST", "text/plain; xmp", "application/xmp"]) {
      expect(heifWithoutMetadata(heic({ mimeType: other }).bytes), other).toMatchObject({ ok: false });
    }
  });

  it("refuses a file with stray bytes after its last box", () => {
    expect(heifWithoutMetadata(heic({ trailing: new Uint8Array([1, 2, 3]) }).bytes)).toMatchObject({ ok: false });
  });

  it("refuses, rather than damages, a file without a metadata box, an unknown construction method, or bytes after the item locations", () => {
    const box = (type: string, ...payload: Uint8Array[]) => concat(u32(8 + concat(...payload).length), ascii(type), ...payload);
    // No metadata box: the pictures cannot be located, so the image data is neither kept nor zeroed; the file is refused.
    const noMeta = concat(box("ftyp", ascii("heic"), u32(0), ascii("mif1"), ascii("heic")), box("mdat", ascii("TEST-HEVC-PICTURE-DATA")));
    expect(heifWithoutMetadata(noMeta)).toMatchObject({ ok: false, reason: expect.stringMatching(/no metadata box/) });
    // Version 1 with method 0 is read; a reserved method (3) is refused.
    expect(heifWithoutMetadata(heic({ pictureMethod: 0 }).bytes)).toMatchObject({ ok: true });
    expect(heifWithoutMetadata(heic({ pictureMethod: 3 }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/not read here/) });
    // Bytes after the declared items in the location box (an older GPS copy) are refused, not passed on.
    expect(heifWithoutMetadata(heic({ ilocTail: ascii("TEST-ILOC-TAIL-POSITION") }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/item locations are followed/) });
  });

  it("refuses a metadata item that shares bytes with the picture or lies outside the image data, changing nothing", () => {
    expect(heifWithoutMetadata(heic({ exifAt: "overlapping_picture" }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/shares bytes with a picture/) });
    expect(heifWithoutMetadata(heic({ exifAt: "in_header" }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/outside the file's data/) });
  });

  it("clears anything after the flags of a self-contained data reference, and refuses a reference to data elsewhere", () => {
    const box = (type: string, ...payload: Uint8Array[]) => {
      const body = concat(...payload);
      return concat(u32(8 + body.length), ascii(type), body);
    };
    const dinf = (flags: number) => box("dinf", box("dref", new Uint8Array([0, 0, 0, 0]), u32(1), box("url ", new Uint8Array([0, 0, 0, flags]), ascii("TEST-DREF-POSITION\0"))));
    const local = heifWithoutMetadata(heic({ dinf: dinf(1) }).bytes);
    expect(local).toMatchObject({ ok: true });
    expect(latin1((local as { bytes: Uint8Array }).bytes)).not.toMatch(/TEST-[A-Z-]*POSITION/);
    expect(heifWithoutMetadata(heic({ dinf: dinf(0) }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/outside itself/) });
  });

  it("accepts a picture only where it is located in this file: refuses a missing location box, an unlocated picture and a data reference the file does not have", () => {
    const box = (type: string, ...payload: Uint8Array[]) => {
      const body = concat(...payload);
      return concat(u32(8 + body.length), ascii(type), body);
    };
    const dinf = box("dinf", box("dref", new Uint8Array([0, 0, 0, 0]), u32(1), box("url ", new Uint8Array([0, 0, 0, 1]))));
    // A picture-only file (no metadata items) without item locations: its picture cannot be told from other bytes.
    expect(heifWithoutMetadata(heic({ noExif: true }).bytes)).toMatchObject({ ok: true });
    expect(heifWithoutMetadata(heic({ noExif: true, noIloc: true }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/no item locations/) });
    // A picture item listed with no extent would have its bytes cleared as unused: refused instead.
    expect(heifWithoutMetadata(heic({ pictureUnlocated: true }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/picture item has no location/) });
    // Data reference 1 names the file's own self-contained entry; 2 names an entry that does not exist.
    expect(heifWithoutMetadata(heic({ dinf, dataRef: 1 }).bytes)).toMatchObject({ ok: true });
    expect(heifWithoutMetadata(heic({ dinf, dataRef: 2 }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/data reference the file does not have/) });
    expect(heifWithoutMetadata(heic({ dataRef: 1 }).bytes)).toMatchObject({ ok: false, reason: expect.stringMatching(/data reference the file does not have/) });
  });
});

describe("review of 81e3b27a: an outdated render job cannot reset or overwrite a newer preview request", () => {
  it("a discard or a result from a superseded job leaves the current request queued", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (render generation)" });
    await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(owner);
    const requested = await owner.exec("media.request_composite_preview", { slots: [{ role: "top", garmentId: "shirt-moss" }, { role: "bottom", garmentId: "trouser-olive" }] });
    const hash = String(requested.result.manifestHash);
    const oldJob = String(requested.result.jobId);
    // TEST SETUP: a newer request now owns the preview (its job is the current render).
    await h.db.prepare("UPDATE outfit_composites SET render_job_id = 'job_newer_request' WHERE user_id = ? AND manifest_hash = ?").bind(owner.userId, hash).run();
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 1, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() + 600_000), owner.userId, oldJob).run();
    // A file each generation wrote, with byte-identical content (the same pixels draw the same checksum).
    const sha = "c".repeat(64);
    const oldPng = compositeKey(owner.userId, hash, "image/png", sha, oldJob);
    const newPng = compositeKey(owner.userId, hash, "image/png", sha, "job_newer_request");
    await h.bindings.MEDIA_BUCKET.put(oldPng, "same bytes");
    await h.bindings.MEDIA_BUCKET.put(newPng, "same bytes");
    // The outdated job's result closes it as obsolete even though the newer request is queued with every image present.
    const recorded = await execSystem(h.rt, owner.userId, "media.record_composite", { manifestHash: hash, jobId: oldJob, attempt: 1, previewSha256: sha, previewBytes: 10, hasSvg: true, renderer: "outdated" }, `outdated-record:${oldJob}`);
    expect(recorded.result).toMatchObject({ discarded: true, obsolete: true });
    expect(await first(h.db, "SELECT state FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, oldJob)).toEqual({ state: "succeeded" });
    expect(await first(h.db, "SELECT preview_state, render_job_id FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?", owner.userId, hash)).toEqual({ preview_state: "queued", render_job_id: "job_newer_request" });
    // The delayed purge removes only the outdated generation's file; the newer request's identical file stays.
    await h.settle(owner);
    expect(await h.bindings.MEDIA_BUCKET.head(oldPng)).toBeNull();
    expect(await h.bindings.MEDIA_BUCKET.head(newPng)).not.toBeNull();
  });
});
