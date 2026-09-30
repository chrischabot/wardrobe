import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MediaService } from '../../src/media/service.js';
import { signToken } from '../../src/media/signing.js';
import { DomainError } from '../../src/domain/errors.js';
import { readOnlyPrincipal } from '../../src/domain/principal.js';
import { bareUserKit, includesBytes, makeJpeg, makePng, SIGNING_KEY, tokenOf, uploadGarmentPhoto, visualScenario } from '../helpers/visual.js';

const deps = (clock?: () => string) => ({ db: env.DB, bucket: env.MEDIA, signingKey: SIGNING_KEY, clock });
const enc = new TextEncoder();

async function authorizeAndPut(media: MediaService, bytes: Uint8Array, declared: 'image/jpeg' | 'image/png' | 'image/heic', opts: { byteLength?: number; putType?: string; garmentId?: string } = {}) {
  const auth = await media.authorizeUpload({ purpose: 'garment_photo', contentType: declared, byteLength: opts.byteLength ?? bytes.length, ...(opts.garmentId ? { garmentId: opts.garmentId } : {}) });
  const put = await MediaService.receiveUpload(deps(), auth.uploadId, tokenOf(auth.uploadUrl), bytes, opts.putType ?? declared);
  return { auth, put };
}

describe('uploads are finalized before they become evidence', () => {
  it('authorize → PUT → complete creates one final source asset linked to the garment with its history', async () => {
    const s = await visualScenario();
    const shirt = await s.byName('Lightweight oxford — blue');
    const bytes = makeJpeg(1200, 1600);
    const { auth, put } = await authorizeAndPut(s.media, bytes, 'image/jpeg', { garmentId: shirt });
    expect(auth.method).toBe('PUT');
    expect(auth.uploadUrl).toMatch(new RegExp(`^/v1/uploads/${auth.uploadId}\\?t=`));
    expect(Date.parse(auth.expiresAt) - Date.parse(s.clock.now())).toBeLessThanOrEqual(600_000);
    expect(put.ok).toBe(true);

    // Received but not finalized: nothing is evidence yet.
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ?').bind(s.userId).first<{ n: number }>();
    expect(before!.n).toBe(0);
    expect((await s.media.garmentMedia([shirt])).get(shirt)!.catalogueImageUrl).toBeNull();

    const done = await s.media.completeUpload(auth.uploadId);
    expect(done).toMatchObject({ status: 'finalized', reason: null });
    const asset = await s.media.getAsset(done.assetId!);
    expect(asset).toMatchObject({ kind: 'source', assetClass: 'owner_photo', status: 'final', contentType: 'image/jpeg', width: 1200, height: 1600, byteLength: bytes.length, sourceAssetId: null, garmentIds: [shirt] });
    expect(asset!.transformations.map((t) => t.op)).toEqual(['upload_finalized']);
    expect(asset!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Completing twice is idempotent.
    expect(await s.media.completeUpload(auth.uploadId)).toMatchObject({ status: 'finalized', assetId: done.assetId });
    // A garment photo queues normalization (queue carries only owner + job ids).
    expect(s.queue.sent).toHaveLength(1);
    expect(Object.keys(s.queue.sent[0]!).sort()).toEqual(['jobId', 'userId', 'v']);
  });

  it('pending and rejected assets can never be linked to a garment or used by a job', async () => {
    const s = await visualScenario();
    const shirt = await s.byName('Lightweight oxford — blue');
    await env.DB.prepare("INSERT INTO media_assets (user_id, asset_id, r2_key, kind, content_type, status, created_at) VALUES (?, 'med_pending0000000000000000000000001', 'u/x/p', 'source', 'image/jpeg', 'pending', ?)")
      .bind(s.userId, s.clock.now())
      .run();
    await expect(env.DB.prepare("INSERT INTO garment_media (user_id, garment_id, asset_id, role, verified, created_at) VALUES (?, ?, 'med_pending0000000000000000000000001', 'catalogue', 1, ?)").bind(s.userId, shirt, s.clock.now()).run()).rejects.toThrow(/only finalized assets/);
    await expect(s.media.requireEvidence('med_pending0000000000000000000000001')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(s.pipeline.runNormalize('med_pending0000000000000000000000001', shirt)).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(s.media.setCatalogue(shirt, 'med_pending0000000000000000000000001', true)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it.each([
    ['PNG bytes declared as JPEG', makePng(800, 800), 'image/jpeg' as const, /Declared image\/jpeg but the bytes are image\/png/],
    ['an SVG disguised as PNG', enc.encode('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script></svg>'), 'image/png' as const, /not a JPEG, PNG or HEIC/],
    ['random bytes', crypto.getRandomValues(new Uint8Array(2048)), 'image/jpeg' as const, /not a JPEG, PNG or HEIC/],
    ['a 4×4 pixel image', makePng(4, 4), 'image/png' as const, /outside 16/],
    ['a 20000 px wide image', makeJpeg(20_000, 100), 'image/jpeg' as const, /outside 16/],
  ])('rejects %s at completion and deletes the bytes', async (_label, bytes, declared, reason) => {
    const k = await bareUserKit();
    const { auth, put } = await authorizeAndPut(k.media, bytes, declared);
    expect(put.ok).toBe(true);
    const done = await k.media.completeUpload(auth.uploadId);
    expect(done.status).toBe('rejected');
    expect(done.reason).toMatch(reason);
    const row = await env.DB.prepare('SELECT r2_key FROM media_uploads WHERE user_id = ? AND upload_id = ?').bind(k.principal.userId, auth.uploadId).first<{ r2_key: string }>();
    expect(await env.MEDIA.get(row!.r2_key)).toBeNull();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ?').bind(k.principal.userId).first<{ n: number }>())!.n).toBe(0);
  });

  it('enforces the authorized size, type, expiry and single use at PUT time', async () => {
    const k = await bareUserKit();
    const bytes = makeJpeg(800, 800);
    const small = await authorizeAndPut(k.media, bytes, 'image/jpeg', { byteLength: 10 });
    expect(small.put).toMatchObject({ ok: false, status: 413 });
    const wrongType = await authorizeAndPut(k.media, bytes, 'image/jpeg', { putType: 'image/svg+xml' });
    expect(wrongType.put).toMatchObject({ ok: false, status: 415 });
    const once = await authorizeAndPut(k.media, bytes, 'image/jpeg');
    expect(once.put.ok).toBe(true);
    expect(await MediaService.receiveUpload(deps(), once.auth.uploadId, tokenOf(once.auth.uploadUrl), bytes, 'image/jpeg')).toMatchObject({ ok: false, status: 409 });
    const auth = await k.media.authorizeUpload({ purpose: 'identify', contentType: 'image/jpeg', byteLength: bytes.length });
    const late = () => new Date(Date.now() + 11 * 60_000).toISOString();
    expect(await MediaService.receiveUpload(deps(late), auth.uploadId, tokenOf(auth.uploadUrl), bytes, 'image/jpeg')).toMatchObject({ ok: false, status: 403, code: 'expired' });
    // An upload that never arrived is rejected at completion.
    expect(await k.media.completeUpload(auth.uploadId)).toMatchObject({ status: 'rejected' });
    await expect(k.media.authorizeUpload({ purpose: 'identify', contentType: 'image/gif', byteLength: 10 })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(k.media.authorizeUpload({ purpose: 'identify', contentType: 'image/jpeg', byteLength: 30_000_000 })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('a read-only connection cannot upload, ingest or delete', async () => {
    const k = await bareUserKit();
    const ro = new MediaService({ ...deps(), principal: readOnlyPrincipal(k.principal.userId) });
    await expect(ro.authorizeUpload({ purpose: 'identify', contentType: 'image/jpeg', byteLength: 100 })).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(ro.ingest({ bytes: makePng(100, 100), kind: 'source', assetClass: 'owner_photo', transformation: { op: 'x', provider: null, params: {} } })).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(ro.deleteAsset('med_x')).rejects.toBeInstanceOf(DomainError);
  });
});

describe('renditions record their source and transformation history; derivatives drop location metadata', () => {
  it('strips EXIF/comments from JPEG derivatives and text/eXIf chunks from PNG derivatives, keeping the original immutable', async () => {
    const k = await bareUserKit();
    const original = await k.media.ingest({ bytes: makeJpeg(900, 1200, { exif: true, comment: true }), kind: 'source', assetClass: 'owner_photo', transformation: { op: 'test_original', provider: null, params: {} } });
    const kept = await k.media.readBytes(original.assetId);
    expect(includesBytes(kept.bytes, 'GPSLatitude')).toBe(true); // the original is immutable
    const derived = await k.media.ingest({ bytes: kept.bytes, kind: 'catalogue', assetClass: 'owner_photo', sourceAssetId: original.assetId, transformation: { op: 'normalize_canvas', provider: 'test', params: {} } });
    const d = await k.media.readBytes(derived.assetId);
    expect(includesBytes(d.bytes, 'GPSLatitude')).toBe(false);
    expect(includesBytes(d.bytes, 'taken at home')).toBe(false);
    expect(d.row.width).toBe(900);
    expect(derived.sourceAssetId).toBe(original.assetId);
    expect(derived.transformations.map((t) => t.op)).toEqual(['test_original', 'normalize_canvas']);
    expect(derived.transformations[1]!.params).toMatchObject({ sourceAssetId: original.assetId, sourceSha256: original.sha256, metadataRemoved: ['0xFFE1', '0xFFFE'] });

    const png = await k.media.ingest({ bytes: makePng(640, 480, { text: true }), kind: 'source', assetClass: 'owner_photo', transformation: { op: 'test_original', provider: null, params: {} } });
    const pngD = await k.media.ingest({ bytes: (await k.media.readBytes(png.assetId)).bytes, kind: 'cutout', assetClass: 'owner_photo', sourceAssetId: png.assetId, transformation: { op: 'background_removal', provider: 'test', params: {} } });
    const pb = (await k.media.readBytes(pngD.assetId)).bytes;
    expect(includesBytes(pb, 'Utrecht')).toBe(false);
    expect(includesBytes(pb, 'eXIf')).toBe(false);
    expect(includesBytes(pb, 'IDAT')).toBe(true);
  });

  it('on-demand thumbnails come in fixed widths only and are recorded as renditions of their source', async () => {
    const s = await visualScenario({ placeholders: true });
    const shirt = await s.byName('Lightweight oxford — gold');
    const cat = (await s.media.garmentMedia([shirt])).get(shirt)!;
    const thumb = await s.media.thumbnail(cat.catalogueAssetId!, 160);
    expect(thumb).toMatchObject({ kind: 'thumbnail', width: 160, sourceAssetId: cat.catalogueAssetId, assetClass: 'demo_placeholder', label: 'Demo placeholder' });
    expect(thumb!.transformations.at(-1)).toMatchObject({ op: 'resize', params: { width: 160 } });
    // Cached: the same request returns the same rendition.
    expect((await s.media.thumbnail(cat.catalogueAssetId!, 160))!.assetId).toBe(thumb!.assetId);
    await expect(s.media.thumbnail(cat.catalogueAssetId!, 333 as 160)).rejects.toMatchObject({ code: 'validation_failed' });
    // Raster thumbnails need the image transformer; without one nothing is fabricated.
    const photo = await uploadGarmentPhoto(s.media, shirt);
    expect(await s.media.thumbnail(photo, 480)).toBeNull();
    const media = (await s.media.garmentMedia([shirt])).get(shirt)!;
    expect(media.thumbnailUrl).toContain('/v1/media/');
  });

  it('refuses untrusted SVG markup even from trusted ingestion', async () => {
    const k = await bareUserKit();
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://evil.example/x.png" width="10" height="10"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><foreignObject><div>x</div></foreignObject></svg>',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">&x;</svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="url(https://evil.example/#a)" width="1" height="1"/></svg>',
    ]) {
      await expect(k.media.ingest({ bytes: enc.encode(bad), kind: 'source', assetClass: 'illustration', transformation: { op: 'x', provider: null, params: {} } })).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });
});

describe('private R2 storage behind signed, owner-scoped URLs', () => {
  it('serves a final asset by a short-lived token with private, no-sniff headers; expiry, tampering and object swaps fail', async () => {
    const k = await bareUserKit();
    const a = await k.media.ingest({ bytes: makePng(300, 300), kind: 'source', assetClass: 'owner_photo', transformation: { op: 'x', provider: null, params: {} } });
    const b = await k.media.ingest({ bytes: makeJpeg(300, 300), kind: 'source', assetClass: 'owner_photo', transformation: { op: 'x', provider: null, params: {} } });
    const { url, expiresAt } = await k.media.signedUrl(a.assetId, 120);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(121_000);
    const t = tokenOf(url);
    const res = await MediaService.serveSigned(deps(), a.assetId, t);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toMatch(/^private/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(makePng(300, 300));

    expect((await MediaService.serveSigned(deps(() => new Date(Date.now() + 3_600_000).toISOString()), a.assetId, t)).status).toBe(403);
    expect((await MediaService.serveSigned(deps(), b.assetId, t)).status).toBe(404); // token names a different object
    const tampered = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
    expect((await MediaService.serveSigned(deps(), a.assetId, tampered)).status).toBe(404);
    expect((await MediaService.serveSigned({ ...deps(), signingKey: 'another-deployment-key-with-enough-length-000' }, a.assetId, t)).status).toBe(404);
    expect((await MediaService.serveSigned(deps(), a.assetId, 'garbage')).status).toBe(404);
    const uploadToken = await signToken(SIGNING_KEY, { purpose: 'upload', userId: k.principal.userId, objectId: a.assetId, exp: Math.floor(Date.now() / 1000) + 60 });
    expect((await MediaService.serveSigned(deps(), a.assetId, uploadToken)).status).toBe(404); // wrong purpose
    // Authenticated serving works for the owner; SVG gets a locking CSP.
    expect((await k.media.serve(a.assetId)).status).toBe(200);
  });

  it('SVG assets are served with a restrictive Content-Security-Policy and their label', async () => {
    const s = await visualScenario({ placeholders: true });
    const shirt = await s.byName('Lightweight oxford — gold');
    const m = (await s.media.garmentMedia([shirt])).get(shirt)!;
    expect(m).toMatchObject({ verified: false, assetClass: 'demo_placeholder', label: 'Demo placeholder' });
    const res = await MediaService.serveSigned(deps(), m.catalogueAssetId!, tokenOf(m.catalogueImageUrl!));
    expect(res.headers.get('Content-Security-Policy')).toMatch(/default-src 'none'/);
    expect(decodeURIComponent(res.headers.get('X-Garderobe-Image-Label')!)).toBe('Demo placeholder');
  });

  it('deleting an original propagates to renditions, links, composites and R2 bytes', async () => {
    const s = await visualScenario({ placeholders: true });
    const shirt = await s.byName('Lightweight oxford — gold');
    const trousers = await s.byName('Di Sondrio beige chino');
    const m = (await s.media.garmentMedia([shirt])).get(shirt)!;
    const thumb = await s.media.thumbnail(m.catalogueAssetId!, 160);
    const composite = await s.composites.compose([{ garmentId: shirt, role: 'base_top' }, { garmentId: trousers, role: 'bottom' }]);
    const keys = await env.DB.prepare('SELECT r2_key FROM media_assets WHERE user_id = ? AND asset_id IN (?, ?, ?)').bind(s.userId, m.catalogueAssetId, thumb!.assetId, composite.previewAssetId).all<{ r2_key: string }>();
    const out = await s.media.deleteAsset(m.catalogueAssetId!);
    expect(out.deletedAssetIds).toEqual(expect.arrayContaining([m.catalogueAssetId, thumb!.assetId, composite.previewAssetId]));
    expect(out.compositesRemoved).toBe(1);
    for (const r of keys.results) expect(await env.MEDIA.get(r.r2_key)).toBeNull();
    expect((await s.media.garmentMedia([shirt])).get(shirt)!.catalogueImageUrl).toBeNull();
    expect((await env.DB.prepare('SELECT deleted_at FROM media_assets WHERE user_id = ? AND asset_id = ?').bind(s.userId, m.catalogueAssetId).first<{ deleted_at: string }>())!.deleted_at).not.toBeNull();
  });
});
