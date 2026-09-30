import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { placeholderSvg } from '@garderobe/demo';
import { FakeBackgroundRemover, FakeImageAnalyzer, FakeImageEditor, FakeImageFetcher, FakeImageGenerator, FakeProductImageSearch, type FakeEditMode } from '../../src/media/fakes.js';
import { DISCOVERY_ALLOWANCE, handleMediaQueue, type MediaQueueMessage } from '../../src/media/pipeline.js';
import type { ImageCandidate, SearchStrategy } from '../../src/media/providers.js';
import { ok } from '../helpers/fixtures.js';
import { ownerPhotoSvg, visualScenario, type VisualScenario } from '../helpers/visual.js';

const enc = new TextEncoder();

async function addShirt(s: VisualScenario, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await ok(s.principal, { type: 'add_item', explicit: true, name: 'Test oxford — gold', category: 'shirt', roles: ['base_top'], maker: 'Drake’s', productName: 'Gold Oxford Cloth Button-Down Shirt', productCode: 'DRK-OX-GLD-01', color: 'Gold', ...extra });
  return (r.facts as { garmentId: string }).garmentId;
}

function candidate(i: number, ids: ImageCandidate['pageIdentifiers'], extra: Partial<ImageCandidate> = {}): ImageCandidate {
  return { imageUrl: `https://shop.example/img/${i}.svg`, pageUrl: `https://shop.example/p/${i}`, pageTitle: `Product ${i}`, pageIdentifiers: ids, viaBrowser: false, ...extra };
}

function providersFor(images: Record<string, { name: string; category: string; color: string }>, search: FakeProductImageSearch, opts: { editor?: FakeEditMode; cutout?: ConstructorParameters<typeof FakeBackgroundRemover>[0] } = {}) {
  const fetcher = new FakeImageFetcher();
  for (const [url, g] of Object.entries(images)) fetcher.put(url, enc.encode(placeholderSvg(g).svg), 'image/svg+xml');
  return { search, fetcher, analyzer: new FakeImageAnalyzer(), cutout: new FakeBackgroundRemover(opts.cutout), editor: new FakeImageEditor(opts.editor ?? 'faithful') };
}

describe('asset discovery through provider interfaces (fakes)', () => {
  it('adopts only an exact-identifier match, records provenance, then normalizes into cutout, mask and catalogue renditions', async () => {
    const s = await visualScenario();
    const shirt = await addShirt(s);
    const search = new FakeProductImageSearch();
    search.set(shirt, 'purchase_source', [
      candidate(1, { maker: 'Drake’s', productName: 'Gold Oxford Cloth Button-Down Shirt', colourway: 'Navy', productCode: 'DRK-OX-NVY-01' }, { providerConfidence: 0.97 }),
      candidate(2, { maker: 'Drake’s', productCode: 'DRK-OX-GLD-01', colourway: 'Gold' }),
    ]);
    const kit = s.withProviders(providersFor({ 'https://shop.example/img/1.svg': { name: 'x', category: 'shirt', color: 'Navy' }, 'https://shop.example/img/2.svg': { name: 'x', category: 'shirt', color: 'Gold' } }, search));
    const job = await kit.pipeline.enqueueDiscovery(shirt);
    expect(kit.queue.sent.map((m) => m.jobId)).toEqual([job]);
    const [discovered, normalized] = await kit.pipeline.drain();
    expect(discovered).toMatchObject({ kind: 'discover', status: 'succeeded' });
    const examined = discovered!.result.examined as { pageUrl: string; decision: string; reasons: string[] }[];
    // Exact identifier ranks first; the wrong colourway would have been rejected despite its high provider confidence.
    expect(examined[0]).toMatchObject({ pageUrl: 'https://shop.example/p/2', decision: 'adopt' });
    const adopted = await kit.media.getAsset(discovered!.result.adoptedAssetId as string);
    expect(adopted).toMatchObject({ assetClass: 'exact_product_photo', kind: 'source', provenance: { sourceUrl: 'https://shop.example/img/2.svg', sourcePageUrl: 'https://shop.example/p/2' } });
    expect(adopted!.provenance.retrievedAt).toBe(s.clock.now());
    expect(adopted!.provenance.permittedUse).toMatch(/Private/);
    expect(adopted!.provenance.evidence).toMatchObject({ match: { identifierMatch: true } });

    expect(normalized).toMatchObject({ kind: 'normalize', status: 'succeeded' });
    const tree = await kit.media.derivationTree(adopted!.assetId);
    const kinds = tree.map((a) => `${a.kind}:${a.status}`);
    expect(kinds).toEqual(expect.arrayContaining(['source:final', 'cutout:final', 'mask:final', 'catalogue:final']));
    const catalogue = tree.find((a) => a.kind === 'catalogue')!;
    const cutout = tree.find((a) => a.kind === 'cutout')!;
    expect(catalogue.sourceAssetId).toBe(cutout.assetId);
    expect(cutout.sourceAssetId).toBe(adopted!.assetId);
    expect(catalogue.transformations.map((t) => t.op)).toEqual(['product_image_adopted', 'background_removal', 'normalize_canvas']);
    expect(cutout.fidelity).toMatchObject({ passed: true });
    const media = (await kit.media.garmentMedia([shirt])).get(shirt)!;
    expect(media).toMatchObject({ verified: true, catalogueAssetId: catalogue.assetId, assetClass: 'exact_product_photo', label: null, photosNeeded: false });
    // The original stays immutable and available as a supporting photo.
    expect(media.photos).toHaveLength(1);
  });

  it.each([
    ['a different colourway', { maker: 'Drake’s', productName: 'Gold Oxford Cloth Button-Down Shirt', colourway: 'Pink' }, { category: 'shirt', color: 'Pink' }, /Wrong colourway/],
    ['a different generation', { maker: 'Drake’s', productCode: 'DRK-OX-GLD-01', colourway: 'Gold', generation: 'mk2' }, { category: 'shirt', color: 'Gold' }, /Different generation/],
    ['a different garment type', { maker: 'Drake’s', productCode: 'DRK-OX-GLD-01', colourway: 'Gold' }, { category: 'trousers', color: 'Gold' }, /not a shirt/],
    ['a different product code', { maker: 'Drake’s', productCode: 'DRK-OX-GLD-02', colourway: 'Gold' }, { category: 'shirt', color: 'Gold' }, /Different product code/],
  ])('rejects %s and leaves the garment in Photos needed with one useful sentence', async (_l, ids, img, reason) => {
    const s = await visualScenario();
    const shirt = await addShirt(s, { attributes: { generation: 'mk1' } });
    const search = new FakeProductImageSearch();
    search.set(shirt, 'purchase_source', [candidate(1, ids)]);
    const kit = s.withProviders(providersFor({ 'https://shop.example/img/1.svg': { name: 'x', ...img } }, search));
    await kit.pipeline.enqueueDiscovery(shirt);
    const [r] = await kit.pipeline.drain();
    expect(r!.status).toBe('unresolved');
    const ex = r!.result.examined as { decision: string; reasons: string[] }[];
    expect(ex[0]!.decision).toBe('reject');
    expect(ex[0]!.reasons.join(' ')).toMatch(reason);
    const needed = await kit.pipeline.photosNeeded();
    expect(needed.items).toEqual([expect.objectContaining({ garmentId: shirt, name: 'Test oxford — gold' })]);
    expect(needed.items[0]!.request).toMatch(/^A front-on photo of the Test oxford — gold .*collar, buttons/);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ? AND asset_class = 'exact_product_photo'").bind(s.userId).first<{ n: number }>())!.n).toBe(0);
  });

  it('an uncertain lookalike is never promoted by a provider confidence number; it goes to one grouped owner review', async () => {
    const s = await visualScenario();
    const shirt = await addShirt(s, { productCode: undefined });
    const search = new FakeProductImageSearch();
    search.set(shirt, 'identifier_search', [candidate(1, { maker: 'Drake’s', productName: 'Oxford shirt', colourway: 'Gold' }, { providerConfidence: 0.99 })]);
    const kit = s.withProviders(providersFor({ 'https://shop.example/img/1.svg': { name: 'x', category: 'shirt', color: 'Gold' } }, search));
    await kit.pipeline.enqueueDiscovery(shirt);
    const [r] = await kit.pipeline.drain();
    expect(r!.status).toBe('unresolved');
    expect((r!.result.examined as { decision: string }[])[0]!.decision).toBe('uncertain');
    const review = await kit.pipeline.reviewQueue();
    expect(review).toEqual([{ garmentId: shirt, name: 'Test oxford — gold', candidates: [expect.objectContaining({ imageUrl: 'https://shop.example/img/1.svg', reasons: expect.arrayContaining([expect.stringMatching(/lookalike/)]) })] }]);
    expect((await kit.media.garmentMedia([shirt])).get(shirt)).toMatchObject({ catalogueImageUrl: null, photosNeeded: true });
    // The owner confirms it: adopted with the confirmation as evidence, and it leaves Photos needed.
    const adopted = await kit.pipeline.acceptReviewCandidate(shirt, 'https://shop.example/img/1.svg');
    expect(adopted.provenance.evidence).toMatchObject({ ownerConfirmed: true });
    expect((await kit.pipeline.photosNeeded()).items).toEqual([]);
  });

  it(`respects the "try hard" allowance: ${DISCOVERY_ALLOWANCE.strategies} strategies, ${DISCOVERY_ALLOWANCE.candidatePages} pages, ${DISCOVERY_ALLOWANCE.browserSessions} browser sessions`, async () => {
    const s = await visualScenario();
    const shirt = await addShirt(s, { productCode: undefined });
    const search = new FakeProductImageSearch();
    const images: Record<string, { name: string; category: string; color: string }> = {};
    let i = 0;
    for (const strategy of ['purchase_source', 'manufacturer_archive', 'identifier_search'] as SearchStrategy[]) {
      const list: ImageCandidate[] = [];
      for (let k = 0; k < 8; k++) {
        i++;
        list.push(candidate(i, { maker: 'Other', colourway: 'Gold' }, { viaBrowser: k % 2 === 0 }));
        images[`https://shop.example/img/${i}.svg`] = { name: 'x', category: 'shirt', color: 'Gold' };
      }
      search.set(shirt, strategy, list);
    }
    const kit = s.withProviders(providersFor(images, search));
    await kit.pipeline.enqueueDiscovery(shirt);
    const [r] = await kit.pipeline.drain();
    const usage = r!.result.usage as { strategies: number; pages: number; browser: number };
    expect(usage.strategies).toBeLessThanOrEqual(3);
    expect(usage.pages).toBeLessThanOrEqual(12);
    expect(usage.browser).toBeLessThanOrEqual(2);
    expect((r!.result.examined as unknown[]).length).toBe(usage.pages);
    expect(search.calls.reduce((n, c) => n + c.maxPages, 0)).toBeGreaterThan(0);

    // A retry does not repeat the same unsuccessful searches ...
    const before = search.calls.length;
    await kit.pipeline.retryDiscovery(shirt, 'weekly');
    const [again] = await kit.pipeline.drain();
    expect(search.calls.length).toBe(before);
    expect((again!.result.usage as { strategies: number }).strategies).toBe(0);
    // ... but a new source is searched.
    search.newSource(shirt);
    await kit.pipeline.retryDiscovery(shirt, 'owner-supplied-link');
    await kit.pipeline.drain();
    expect(search.calls.length).toBeGreaterThan(before);
  });

  it('Photos needed lists only unresolved items; unsearched, resolved and waiting items are absent', async () => {
    const s = await visualScenario();
    const unresolved = await addShirt(s, { name: 'Unresolvable shirt', productCode: undefined });
    const resolved = await addShirt(s, { name: 'Resolvable shirt' });
    const search = new FakeProductImageSearch();
    search.set(resolved, 'purchase_source', [candidate(9, { productCode: 'DRK-OX-GLD-01', colourway: 'Gold' })]);
    const kit = s.withProviders(providersFor({ 'https://shop.example/img/9.svg': { name: 'x', category: 'shirt', color: 'Gold' } }, search));
    await kit.pipeline.enqueueDiscovery(unresolved);
    await kit.pipeline.enqueueDiscovery(resolved);
    await kit.pipeline.drain();
    expect((await kit.pipeline.photosNeeded()).items.map((x) => x.garmentId)).toEqual([unresolved]);
    // The owner then supplies a photo of the unresolved shirt: it leaves the collection.
    await kit.media.ingest({ bytes: ownerPhotoSvg({ name: 'Unresolvable shirt', category: 'shirt', color: 'Gold' }, 'front_flat'), kind: 'source', assetClass: 'owner_photo', garmentId: unresolved, link: 'supporting', verified: true, transformation: { op: 'upload_finalized', provider: null, params: {} } });
    expect((await kit.pipeline.photosNeeded()).items).toEqual([]);
    // Without providers a job waits; it never lands in Photos needed.
    const bare = s.withProviders({});
    const waiting = await addShirt(s, { name: 'Waiting shirt' });
    const id = await bare.pipeline.enqueueDiscovery(waiting);
    expect((await bare.pipeline.runJob(id)).status).toBe('waiting_provider');
    expect((await bare.pipeline.photosNeeded()).items).toEqual([]);
  });

  it('the backfill prioritises active garments of the real wardrobe and skips garments that already have verified images', async () => {
    const s = await visualScenario();
    const kit = s.withProviders({});
    const jobs = await kit.pipeline.backfill(10);
    expect(jobs).toHaveLength(10);
    const { results } = await env.DB.prepare("SELECT g.planning_policy FROM media_jobs j JOIN garments g ON g.user_id = j.user_id AND g.garment_id = j.garment_id WHERE j.user_id = ? AND j.kind = 'discover'").bind(s.userId).all<{ planning_policy: string }>();
    expect(results.every((r) => r.planning_policy === 'normal')).toBe(true);
    // Idempotent: the same backfill does not duplicate jobs.
    expect(await kit.pipeline.backfill(10)).toEqual(jobs);
  });
});

describe('normalization rejects failed or identity-altering edits', () => {
  async function onBodyPhoto(s: VisualScenario, mode: FakeEditMode, cutout: ConstructorParameters<typeof FakeBackgroundRemover>[0] = {}) {
    const trousers = await s.byName('Di Sondrio walnut chino');
    const editor = new FakeImageEditor(mode);
    const kit = s.withProviders({ analyzer: new FakeImageAnalyzer(), cutout: new FakeBackgroundRemover(cutout), editor });
    const photo = await kit.media.ingest({ bytes: ownerPhotoSvg({ name: 'Di Sondrio walnut chino', category: 'trousers', color: 'Walnut' }), kind: 'source', assetClass: 'owner_photo', garmentId: trousers, link: 'supporting', verified: true, transformation: { op: 'upload_finalized', provider: null, params: {} } });
    await kit.pipeline.enqueueNormalize(photo.assetId, trousers);
    const [r] = await kit.pipeline.drain();
    return { kit, r: r!, photo, trousers, editor };
  }

  it('a faithful edit becomes an "Edited" catalogue rendition with its fidelity report and the preservation constraints', async () => {
    const s = await visualScenario();
    const { kit, r, trousers, editor } = await onBodyPhoto(s, 'faithful');
    expect(r.status).toBe('succeeded');
    expect(editor.lastConstraints).toEqual({ preserve: ['colour', 'pattern_scale', 'pockets', 'buttons', 'seams', 'silhouette'], target: 'front_flat_catalogue', background: '#FFFFFF' });
    const m = (await kit.media.garmentMedia([trousers])).get(trousers)!;
    const cat = await kit.media.getAsset(m.catalogueAssetId!);
    expect(cat).toMatchObject({ kind: 'catalogue', assetClass: 'edited_rendition', label: 'Edited', fidelity: { passed: true } });
    expect(m).toMatchObject({ verified: true, label: 'Edited' });
  });

  it.each([
    ['recolour', 'dominant_colours'],
    ['drop_pockets', 'details'],
    ['change_silhouette', 'silhouette'],
    ['change_pattern', 'pattern'],
  ] as [FakeEditMode, string][])('an edit that changes the garment (%s) is rejected, not stored as the catalogue image', async (mode, failed) => {
    const s = await visualScenario();
    const { kit, r, trousers, photo } = await onBodyPhoto(s, mode);
    expect(r.status).toBe('succeeded');
    const rejected = await env.DB.prepare("SELECT asset_id, fidelity_json, rejection_reason FROM media_assets WHERE user_id = ? AND status = 'rejected' AND asset_class = 'edited_rendition'").bind(s.userId).all<{ asset_id: string; fidelity_json: string; rejection_reason: string }>();
    expect(rejected.results).toHaveLength(1);
    const fid = JSON.parse(rejected.results[0]!.fidelity_json) as { passed: boolean; checks: { name: string; passed: boolean }[] };
    expect(fid.passed).toBe(false);
    expect(fid.checks.find((c) => c.name === failed)!.passed).toBe(false);
    expect(rejected.results[0]!.rejection_reason).toMatch(/changed the garment/);
    // No bytes kept and no link to the rejected edit; the honest cutout serves as the catalogue image.
    const links = await env.DB.prepare('SELECT COUNT(*) AS n FROM garment_media WHERE user_id = ? AND asset_id = ?').bind(s.userId, rejected.results[0]!.asset_id).first<{ n: number }>();
    expect(links!.n).toBe(0);
    const m = (await kit.media.garmentMedia([trousers])).get(trousers)!;
    const cat = await kit.media.getAsset(m.catalogueAssetId!);
    expect(cat).toMatchObject({ kind: 'cutout', assetClass: 'owner_photo', sourceAssetId: photo.assetId });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ? AND asset_class = 'edited_rendition' AND status = 'final'").bind(s.userId).first<{ n: number }>())!.n).toBe(0);
  });

  it('a provider failure is recorded as a rejected edit and the original remains usable', async () => {
    const s = await visualScenario();
    const { kit, trousers } = await onBodyPhoto(s, 'throw');
    const rej = await env.DB.prepare("SELECT rejection_reason FROM media_assets WHERE user_id = ? AND status = 'rejected'").bind(s.userId).first<{ rejection_reason: string }>();
    expect(rej!.rejection_reason).toMatch(/The edit failed: fake editor: provider error/);
    expect((await kit.media.garmentMedia([trousers])).get(trousers)!.verified).toBe(true);
  });

  it('a cutout with a halo or clipping is rejected; the original is kept as the base', async () => {
    const s = await visualScenario();
    const { kit, trousers, photo } = await onBodyPhoto(s, 'faithful', { halo: true });
    const rej = await env.DB.prepare("SELECT kind, rejection_reason FROM media_assets WHERE user_id = ? AND status = 'rejected'").bind(s.userId).first<{ kind: string; rejection_reason: string }>();
    expect(rej).toMatchObject({ kind: 'cutout' });
    expect(rej!.rejection_reason).toMatch(/halo/i);
    const cat = await kit.media.getAsset((await kit.media.garmentMedia([trousers])).get(trousers)!.catalogueAssetId!);
    expect(cat!.sourceAssetId).toBe(photo.assetId); // the edit was made from the untouched original
  });
});

describe('missing photos never block recommendations', () => {
  it('an owner with no images at all gets a published board, Studio suggestions and labelled placeholder composites', async () => {
    const s = await visualScenario();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ?').bind(s.userId).first<{ n: number }>())!.n).toBe(0);
    const out = await s.rec.composeAndPublish({ date: '2026-10-06' });
    expect(out.published).toBe(true);
    expect(out.board!.options.length).toBeGreaterThanOrEqual(3);
    const c = await s.composites.forOption(out.board!.options[0]!.optionId);
    expect(c.manifest.items.every((i) => i.placeholder && i.label === 'No photo yet')).toBe(true);
    expect(c.manifest.labels).toEqual(['No photo yet']);
    const sug = await s.studio.suggest({ mode: 'today', date: '2026-10-06', locked: [], roles: ['base_top', 'bottom'] });
    expect(sug.found).toBe(true);
    // A discovery job that cannot run leaves everything else working.
    await s.pipeline.enqueueDiscovery(out.board!.options[0]!.slots[0]!.garmentId);
    expect((await s.pipeline.drain())[0]!.status).toBe('waiting_provider');
    expect((await s.rec.composeAndPublish({ date: '2026-10-07' })).published).toBe(true);
  });
});

describe('imagined renderings are marked and never substitute for catalogue assets', () => {
  it('stored as imagined, never linked, refused as a catalogue image by service and database', async () => {
    const s = await visualScenario({ placeholders: true });
    const shirt = await s.byName('Lightweight oxford — gold');
    const img = await s.composites.recordImaginedRendering(new FakeImageGenerator(), 'gold oxford with walnut chinos', [shirt]);
    expect(img).toMatchObject({ assetClass: 'imagined_rendering', label: 'Imagined rendering, not your actual garments', garmentIds: [] });
    await expect(s.media.setCatalogue(shirt, img.assetId, false)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(env.DB.prepare("INSERT INTO garment_media (user_id, garment_id, asset_id, role, verified, created_at) VALUES (?, ?, ?, 'catalogue', 0, ?)").bind(s.userId, shirt, img.assetId, s.clock.now()).run()).rejects.toThrow(/imagined renderings/);
    await expect(s.media.ingest({ bytes: (await new FakeImageGenerator().generate('x')).image, kind: 'catalogue', assetClass: 'imagined_rendering', garmentId: shirt, link: 'catalogue', transformation: { op: 'x', provider: null, params: {} } })).rejects.toMatchObject({ code: 'validation_failed' });
    // Even linked as "supporting", the composer and the catalogue selector ignore it.
    await env.DB.prepare("INSERT INTO garment_media (user_id, garment_id, asset_id, role, verified, created_at) VALUES (?, ?, ?, 'supporting', 0, ?)").bind(s.userId, shirt, img.assetId, s.clock.now()).run();
    const m = await s.composites.manifestFor([{ garmentId: shirt, role: 'base_top' }]);
    expect(m.manifest.items[0]!.assetClass).toBe('demo_placeholder');
    expect(m.manifest.imagined).toBe(false);
  });
});

describe('media jobs run from the queue idempotently', () => {
  function batch(bodies: unknown[], attempts = 1) {
    const acked: number[] = [];
    const retried: number[] = [];
    const messages = bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), body, attempts, ack: () => acked.push(i), retry: () => retried.push(i) }));
    return { b: { queue: 'garderobe-media', messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<unknown>, acked, retried };
  }

  it('runs owner jobs once, drops malformed and foreign messages, retries failures then marks them failed', async () => {
    const s = await visualScenario({ placeholders: true });
    const other = await visualScenario();
    const board = (await s.rec.composeAndPublish({ date: '2026-10-06' })).board!;
    const ids = await s.pipeline.enqueueBoardComposites('2026-10-06');
    expect(ids.length).toBe(board.options.filter((o) => o.status === 'offerable').length);
    const msg = s.queue.sent[0]!;
    const { b, acked, retried } = batch([msg, msg, { v: 1, userId: s.userId, jobId: 'nonsense' }, { hello: 'world' }, { v: 1, userId: other.userId, jobId: msg.jobId } satisfies MediaQueueMessage]);
    await handleMediaQueue(b, env);
    expect(acked.sort()).toEqual([0, 1, 2, 3, 4]);
    expect(retried).toEqual([]);
    const jobs = await env.DB.prepare("SELECT status FROM media_jobs WHERE user_id = ? AND job_id = ?").bind(s.userId, msg.jobId).first<{ status: string }>();
    expect(jobs!.status).toBe('succeeded');
    // Duplicate delivery produced one composite.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ? AND asset_class = 'composite'").bind(s.userId).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ?').bind(other.userId).first<{ n: number }>())!.n).toBe(0);

    // A job whose source image vanished is permanently failed at once (no pointless retries).
    const trousers = await s.byName('Di Sondrio walnut chino');
    const src = (await s.media.garmentMedia([trousers])).get(trousers)!.catalogueAssetId!;
    const jobId = await s.pipeline.enqueueNormalize(src, trousers);
    await s.media.deleteAsset(src);
    const gone = batch([{ v: 1, userId: s.userId, jobId }], 1);
    await handleMediaQueue(gone.b, env);
    expect(gone.acked).toEqual([0]);
    expect((await env.DB.prepare('SELECT status, last_error FROM media_jobs WHERE user_id = ? AND job_id = ?').bind(s.userId, jobId).first<{ status: string; last_error: string }>())).toMatchObject({ status: 'failed' });

    // A transient provider error is retried with back-off, then failed after the last attempt.
    const flaky = { name: 'flaky-search', sourceKey: () => 'k', find: async () => { throw new Error('search provider timed out'); } };
    const providers = { search: flaky, fetcher: new FakeImageFetcher(), analyzer: new FakeImageAnalyzer() };
    const discover = await s.pipeline.enqueueDiscovery(trousers);
    const first = batch([{ v: 1, userId: s.userId, jobId: discover }], 1);
    await handleMediaQueue(first.b, env, { providers });
    expect(first.retried).toEqual([0]);
    expect((await env.DB.prepare('SELECT status, last_error FROM media_jobs WHERE user_id = ? AND job_id = ?').bind(s.userId, discover).first<{ status: string; last_error: string }>())).toEqual({ status: 'queued', last_error: 'search provider timed out' });
    const last = batch([{ v: 1, userId: s.userId, jobId: discover }], 3);
    await handleMediaQueue(last.b, env, { providers });
    expect(last.acked).toEqual([0]);
    expect((await env.DB.prepare('SELECT status FROM media_jobs WHERE user_id = ? AND job_id = ?').bind(s.userId, discover).first<{ status: string }>())!.status).toBe('failed');
  });
});
