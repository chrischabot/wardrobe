import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { importDataset } from '../../src/import/index.js';
import { syntheticOwnerB } from '@garderobe/demo';
import { MediaService } from '../../src/media/service.js';
import { signToken } from '../../src/media/signing.js';
import { handleMediaQueue } from '../../src/media/pipeline.js';
import { run } from '../helpers/fixtures.js';
import { makeJpeg, SIGNING_KEY, tokenOf, uploadGarmentPhoto, visualKit, visualScenario } from '../helpers/visual.js';

const DATE = '2026-10-06';
const deps = { db: env.DB, bucket: env.MEDIA, signingKey: SIGNING_KEY };

/** Owner A (the real owner) and synthetic owner B, each with media, composites and Studio records. */
async function twoOwners() {
  const a = await visualScenario({ placeholders: true });
  const b = await visualScenario({ placeholders: true });
  const aShirt = await a.byName('Lightweight oxford — gold');
  const aTrousers = await a.byName('Di Sondrio beige chino');
  const aPhoto = await uploadGarmentPhoto(a.media, aShirt);
  const aComposite = await a.composites.compose([{ garmentId: aShirt, role: 'base_top' }, { garmentId: aTrousers, role: 'bottom' }]);
  const aSaved = await run(a.principal, { type: 'save_combination', slots: [{ garmentId: aShirt, role: 'base_top' }, { garmentId: aTrousers, role: 'bottom' }] });
  return { a, b, aShirt, aTrousers, aPhoto, aComposite, aCombination: (aSaved.facts as { combinationId: string }).combinationId };
}

describe('two-user isolation of the visual wardrobe', () => {
  it('B cannot read, serve, sign, link, derive from or delete A’s assets; answers are indistinguishable from missing', async () => {
    const { a, b, aShirt, aPhoto, aComposite } = await twoOwners();
    expect(await b.media.getAsset(aPhoto)).toBeNull();
    expect((await b.media.serve(aPhoto)).status).toBe(404);
    expect((await b.media.serve('med_doesnotexist000000000000000000')).status).toBe(404);
    await expect(b.media.signedUrl(aPhoto)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.media.readBytes(aPhoto)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.media.deleteAsset(aPhoto)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.media.thumbnail(aPhoto, 160)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.media.ingest({ bytes: makeJpeg(100, 100), kind: 'cutout', assetClass: 'owner_photo', sourceAssetId: aPhoto, transformation: { op: 'x', provider: null, params: {} } })).rejects.toMatchObject({ code: 'not_found' });
    const bShirt = await b.byName('Lightweight oxford — gold');
    await expect(b.media.setCatalogue(bShirt, aPhoto, true)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.media.setCatalogue(aShirt, aPhoto, true)).rejects.toMatchObject({ code: 'not_found' });
    // The compound foreign key stops a cross-owner link even for raw SQL.
    await expect(env.DB.prepare("INSERT INTO garment_media (user_id, garment_id, asset_id, role, verified, created_at) VALUES (?, ?, ?, 'supporting', 1, '2026-10-05T00:00:00Z')").bind(b.userId, bShirt, aPhoto).run()).rejects.toThrow();
    // Garment media and composites are owner-scoped.
    expect((await b.media.garmentMedia([aShirt])).get(aShirt)).toMatchObject({ catalogueImageUrl: null, photos: [] });
    await expect(b.composites.compose([{ garmentId: aShirt, role: 'base_top' }])).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.composites.forOption('opt_notmine')).rejects.toMatchObject({ code: 'not_found' });
    expect(await b.media.derivationTree(aComposite.previewAssetId!)).toEqual([]);
    // A still has everything.
    expect((await a.media.serve(aPhoto)).status).toBe(200);
  });

  it('signed URLs are owner-scoped: a token names one owner and one object and cannot be re-pointed', async () => {
    const { a, b, aPhoto } = await twoOwners();
    const bShirt = await b.byName('Lightweight oxford — gold');
    const bAsset = (await b.media.garmentMedia([bShirt])).get(bShirt)!;
    const aUrl = (await a.media.signedUrl(aPhoto)).url;
    // A's token cannot fetch B's asset, and B's token cannot fetch A's.
    expect((await MediaService.serveSigned(deps, bAsset.catalogueAssetId!, tokenOf(aUrl))).status).toBe(404);
    expect((await MediaService.serveSigned(deps, aPhoto, tokenOf(bAsset.catalogueImageUrl!))).status).toBe(404);
    // A token minted for B's user id but naming A's asset finds nothing (rows are looked up under B).
    const forged = await signToken(SIGNING_KEY, { purpose: 'media', userId: b.userId, objectId: aPhoto, exp: Math.floor(Date.now() / 1000) + 300 });
    expect((await MediaService.serveSigned(deps, aPhoto, forged)).status).toBe(404);
    expect((await MediaService.serveSigned(deps, aPhoto, tokenOf(aUrl))).status).toBe(200);
  });

  it('uploads: B cannot complete or overwrite A’s upload, and the upload token only works for its own upload', async () => {
    const { a, b } = await twoOwners();
    const bytes = makeJpeg(800, 800);
    const auth = await a.media.authorizeUpload({ purpose: 'identify', contentType: 'image/jpeg', byteLength: bytes.length });
    await expect(b.media.completeUpload(auth.uploadId)).rejects.toMatchObject({ code: 'not_found' });
    const bAuth = await b.media.authorizeUpload({ purpose: 'identify', contentType: 'image/jpeg', byteLength: bytes.length });
    expect(await MediaService.receiveUpload(deps, auth.uploadId, tokenOf(bAuth.uploadUrl), bytes, 'image/jpeg')).toMatchObject({ ok: false, status: 404 });
    const aShirt = await a.byName('Lightweight oxford — gold');
    await expect(b.media.authorizeUpload({ purpose: 'garment_photo', contentType: 'image/jpeg', byteLength: 100, garmentId: aShirt })).rejects.toMatchObject({ code: 'not_found' });
    // Owner fields in the body are rejected outright.
    await expect(b.media.authorizeUpload({ purpose: 'identify', contentType: 'image/jpeg', byteLength: 100, userId: a.userId })).rejects.toMatchObject({ code: 'forbidden_owner_field' });
  });

  it('Studio and its commands never see or touch the other owner’s garments or combinations', async () => {
    const { a, b, aShirt, aTrousers, aCombination } = await twoOwners();
    const locked = [{ garmentId: aShirt, role: 'base_top' as const }];
    const sug = await b.studio.suggest({ mode: 'explore', date: DATE, locked, roles: ['bottom', 'socks', 'footwear'] });
    expect(sug.found).toBe(false);
    expect(sug.slots).toEqual(locked);
    expect(sug.explanation).not.toContain('Lightweight oxford'); // no name leaked for a foreign id
    expect(sug.manifest).toBeNull();
    const v = await b.studio.validate({ mode: 'today', date: DATE, slots: [...locked, { garmentId: aTrousers, role: 'bottom' }] });
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain('integrity.known_garment');
    const bChoices = await b.studio.choices({ mode: 'explore', date: DATE, role: 'base_top' });
    expect(bChoices.items.map((i) => i.garmentId)).not.toContain(aShirt);
    const save = await run(b.principal, { type: 'save_combination', slots: locked });
    expect(save).toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
    const plan = await run(b.principal, { type: 'plan_outfit', date: DATE, slots: locked });
    expect(plan.error?.code).toBe('not_found');
    const remove = await run(b.principal, { type: 'remove_combination', combinationId: aCombination });
    expect(remove.error?.code).toBe('not_found');
    expect(await b.studio.listCombinations({ includeInactive: true })).toEqual([]);
    expect((await a.studio.listCombinations()).map((c) => c.combinationId)).toEqual([aCombination]);
    const forged = await run(b.principal, { type: 'save_combination', slots: [{ garmentId: aShirt, role: 'base_top', ownerId: a.userId } as never] });
    expect(forged.error?.code).toBe('forbidden_owner_field');
    await expect(b.studio.validate({ mode: 'today', date: DATE, slots: locked, userId: a.userId })).rejects.toMatchObject({ code: 'forbidden_owner_field' });
  });

  it('jobs, Photos needed and queue messages are owner-scoped', async () => {
    const { a, b, aShirt } = await twoOwners();
    const aJob = await a.pipeline.enqueueDiscovery(aShirt);
    await expect(b.pipeline.runJob(aJob)).rejects.toMatchObject({ code: 'not_found' });
    await expect(b.pipeline.enqueueDiscovery(aShirt)).rejects.toMatchObject({ code: 'not_found' });
    await env.DB.prepare("INSERT INTO garment_photo_status (user_id, garment_id, status, request_text, updated_at) VALUES (?, ?, 'photos_needed', 'A photo', ?)").bind(a.userId, aShirt, a.clock.now()).run();
    expect((await a.pipeline.photosNeeded()).items.map((i) => i.garmentId)).toEqual([aShirt]);
    expect((await b.pipeline.photosNeeded()).items).toEqual([]);
    // A queue message naming B with A's job id does nothing to either owner and is not retried.
    const acked: number[] = [];
    await handleMediaQueue({ queue: 'garderobe-media', messages: [{ id: 'm', timestamp: new Date(), attempts: 1, body: { v: 1, userId: b.userId, jobId: aJob }, ack: () => acked.push(0), retry: () => undefined }] } as unknown as MessageBatch<unknown>, env);
    expect(acked).toEqual([0]);
    expect((await env.DB.prepare('SELECT status FROM media_jobs WHERE user_id = ? AND job_id = ?').bind(a.userId, aJob).first<{ status: string }>())!.status).toBe('queued');
  });

  it('the synthetic second owner B (garderobe/demo) gets its own placeholders without seeing the real owner’s wardrobe', async () => {
    const { a } = await twoOwners();
    const { newUser } = await import('../helpers/fixtures.js');
    const synthetic = await newUser('Synthetic Test Owner B');
    await importDataset(env.DB, synthetic, syntheticOwnerB, { sourceSystem: 'synthetic-test-owner-b' });
    const kit = visualKit(synthetic, () => new Date().toISOString());
    const { applyDemoPlaceholders } = await import('@garderobe/demo');
    const res = await applyDemoPlaceholders(env.DB, kit.media);
    const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(synthetic.userId).all<{ n: number }>();
    expect(res.created).toBe(results[0]!.n);
    const aCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ? AND asset_class = 'demo_placeholder'").bind(a.userId).first<{ n: number }>();
    expect(aCount!.n).toBeGreaterThan(100);
    // Idempotent re-run.
    expect((await applyDemoPlaceholders(env.DB, kit.media)).created).toBe(0);
  });
});
