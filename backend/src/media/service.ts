import {
  CONTRACTS_VERSION,
  MAX_UPLOAD_BYTES,
  UploadRequest,
  type AssetClass,
  type FidelityReport,
  type GarmentMedia,
  type MediaAsset,
  type RenditionKind,
  type Transformation,
  type UploadAuthorization,
  type UploadCompleteResponse,
} from '@garderobe/contracts';
import { json } from '../domain/db.js';
import { DomainError, notFound } from '../domain/errors.js';
import { assertPrincipal, findForgedOwnerFields, requireScope, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { assetId as newAssetId, defaultLabel, isVerifiedCatalogue, loadGarmentAssetRows, r2KeyFor, rowToAsset, selectCatalogue, transformationsOf, type MediaAssetRow } from './records.js';
import { signToken, verifyToken } from './signing.js';
import { sha256Bytes, sniff, stripLocationMetadata, validateRaster } from './sniff.js';
import { checkTrustedSvg } from './svg.js';

/**
 * Media service (spec section 11): identities and metadata in D1, bytes in private R2.
 *
 *  - Uploads: short-lived signed PUT URL with a declared size and type → bytes land under an upload
 *    key (not evidence) → explicit `completeUpload` validates the bytes and only then creates a final
 *    `source` asset. Pending or rejected uploads can never be linked, normalized or composed (D1
 *    triggers enforce the link rule too).
 *  - Renditions: every derived asset records its source asset and the full transformation chain;
 *    derivatives are stripped of location metadata.
 *  - Serving: authenticated (`serve`) or by a short-lived token that names one owner and one asset
 *    (`MediaService.serveSigned`). Another owner's asset is indistinguishable from a missing one.
 */

export interface MediaServiceDeps {
  db: D1Database;
  bucket: R2Bucket;
  principal: Principal;
  signingKey: string;
  clock?: () => string;
  /** Prefix for generated URLs, e.g. "https://garderobe.example" (default: relative paths). */
  urlBase?: string;
  uploadTtlSeconds?: number;
  urlTtlSeconds?: number;
  /** Called after an owner's garment photo is finalized (e.g. to queue normalization). */
  onGarmentPhoto?: (assetId: string, garmentId: string) => Promise<void>;
  /** Raster resize adapter (Cloudflare Images in deployment) for on-demand thumbnails. */
  transformer?: ImageTransformer | null;
}

export interface ImageTransformer {
  readonly name: string;
  resize(bytes: Uint8Array, contentType: string, width: number): Promise<{ bytes: Uint8Array; contentType: string; width: number; height: number }>;
}

export interface IngestInput {
  bytes: Uint8Array;
  kind: RenditionKind;
  assetClass: AssetClass;
  transformation: Omit<Transformation, 'at'> & { at?: string };
  sourceAssetId?: string | null;
  garmentId?: string | null;
  /** How to link the asset to the garment; omitted = not linked. */
  link?: 'catalogue' | 'supporting' | null;
  verified?: boolean;
  provenance?: { sourceUrl?: string | null; sourcePageUrl?: string | null; retrievedAt?: string | null; permittedUse?: string | null; evidence?: Record<string, unknown> };
  fidelity?: FidelityReport | null;
  label?: string | null;
}

export interface RejectInput {
  kind: RenditionKind;
  assetClass: AssetClass;
  sourceAssetId: string | null;
  contentType: string;
  transformation: Omit<Transformation, 'at'> & { at?: string };
  reason: string;
  fidelity?: FidelityReport | null;
  sha256?: string | null;
}

export const THUMBNAIL_WIDTHS = [160, 480, 960] as const;
export type ThumbnailWidth = (typeof THUMBNAIL_WIDTHS)[number];

interface UploadRow {
  user_id: string;
  upload_id: string;
  purpose: string;
  content_type: string;
  declared_bytes: number;
  received_bytes: number | null;
  garment_id: string | null;
  r2_key: string;
  status: string;
  rejection_reason: string | null;
  asset_id: string | null;
  expires_at: string;
}

export type ReceiveResult = { ok: true; uploadId: string; receivedBytes: number } | { ok: false; status: 400 | 403 | 404 | 409 | 413 | 415; code: string; message: string };

const SVG_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

function uploadId(): string {
  return `upl_${crypto.randomUUID().replace(/-/g, '')}`;
}

export class MediaService {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  readonly principal: Principal;
  private readonly now: () => string;

  constructor(private readonly deps: MediaServiceDeps) {
    assertPrincipal(deps.principal);
    this.db = deps.db;
    this.bucket = deps.bucket;
    this.principal = deps.principal;
    this.now = deps.clock ?? (() => new Date().toISOString());
  }

  private get userId(): string {
    return this.principal.userId;
  }

  private nowSeconds(): number {
    return Math.floor(Date.parse(this.now()) / 1000);
  }

  // ---------------------------------------------------------------- uploads

  /** POST /v1/uploads: a short-lived, single-object PUT authorization. */
  async authorizeUpload(input: unknown): Promise<UploadAuthorization> {
    requireScope(this.principal, SCOPE_WRITE);
    const forged = findForgedOwnerFields(input);
    if (forged.length) throw new DomainError('forbidden_owner_field', 'Owner identity comes from the authenticated connection', { fields: forged });
    const parsed = UploadRequest.safeParse(input);
    if (!parsed.success) throw new DomainError('validation_failed', 'The upload request is not valid', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const req = parsed.data;
    if (req.garmentId) {
      const g = await this.db.prepare('SELECT 1 AS ok FROM garments WHERE user_id = ? AND garment_id = ?').bind(this.userId, req.garmentId).first();
      if (!g) throw notFound('garment', req.garmentId);
    }
    const id = uploadId();
    const now = this.now();
    const ttl = this.deps.uploadTtlSeconds ?? 600;
    const exp = this.nowSeconds() + ttl;
    const expiresAt = new Date(exp * 1000).toISOString();
    await this.db
      .prepare(
        `INSERT INTO media_uploads (user_id, upload_id, purpose, content_type, declared_bytes, garment_id, r2_key, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?, ?)`,
      )
      .bind(this.userId, id, req.purpose, req.contentType, req.byteLength, req.garmentId ?? null, `u/${this.userId}/uploads/${id}`, expiresAt, now, now)
      .run();
    const token = await signToken(this.deps.signingKey, { purpose: 'upload', userId: this.userId, objectId: id, exp });
    return {
      schemaVersion: CONTRACTS_VERSION,
      uploadId: id,
      uploadUrl: `${this.deps.urlBase ?? ''}/v1/uploads/${id}?t=${encodeURIComponent(token)}`,
      method: 'PUT',
      headers: { 'Content-Type': req.contentType },
      expiresAt,
    };
  }

  /**
   * PUT on the signed upload URL. The token identifies the owner; the bytes are stored under the
   * upload key only. They are not evidence until `completeUpload` validates them.
   */
  static async receiveUpload(
    deps: { db: D1Database; bucket: R2Bucket; signingKey: string; clock?: () => string },
    id: string,
    token: string,
    body: ArrayBuffer | Uint8Array,
    contentType: string | null,
  ): Promise<ReceiveResult> {
    const now = deps.clock?.() ?? new Date().toISOString();
    const v = await verifyToken(deps.signingKey, token, { purpose: 'upload', objectId: id, nowSeconds: Math.floor(Date.parse(now) / 1000) });
    if (!v.ok) return v.reason === 'expired' ? { ok: false, status: 403, code: 'expired', message: 'The upload authorization has expired' } : { ok: false, status: 404, code: 'not_found', message: 'No such upload' };
    const row = await deps.db.prepare('SELECT * FROM media_uploads WHERE user_id = ? AND upload_id = ?').bind(v.claims.userId, id).first<UploadRow>();
    if (!row) return { ok: false, status: 404, code: 'not_found', message: 'No such upload' };
    if (row.status !== 'authorized') return { ok: false, status: 409, code: 'already_received', message: 'This upload has already been received' };
    if (Date.parse(row.expires_at) <= Date.parse(now)) return { ok: false, status: 403, code: 'expired', message: 'The upload authorization has expired' };
    if ((contentType ?? '').split(';')[0]!.trim().toLowerCase() !== row.content_type) return { ok: false, status: 415, code: 'type_mismatch', message: `Expected ${row.content_type}` };
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    if (bytes.length > row.declared_bytes || bytes.length > MAX_UPLOAD_BYTES) return { ok: false, status: 413, code: 'too_large', message: `At most ${row.declared_bytes} bytes were authorized` };
    if (bytes.length === 0) return { ok: false, status: 400, code: 'empty', message: 'The upload is empty' };
    await deps.bucket.put(row.r2_key, bytes, { httpMetadata: { contentType: row.content_type }, customMetadata: { userId: row.user_id, uploadId: id, state: 'unvalidated' } });
    await deps.db
      .prepare("UPDATE media_uploads SET status = 'uploaded', received_bytes = ?, updated_at = ? WHERE user_id = ? AND upload_id = ? AND status = 'authorized'")
      .bind(bytes.length, now, row.user_id, id)
      .run();
    return { ok: true, uploadId: id, receivedBytes: bytes.length };
  }

  /** POST /v1/uploads/{id}/complete: validate the stored bytes and create the final source asset. */
  async completeUpload(id: string): Promise<UploadCompleteResponse> {
    requireScope(this.principal, SCOPE_WRITE);
    const row = await this.db.prepare('SELECT * FROM media_uploads WHERE user_id = ? AND upload_id = ?').bind(this.userId, id).first<UploadRow>();
    if (!row) throw notFound('media_asset', id);
    const done = (status: 'finalized' | 'rejected', reason: string | null, asset: string | null): UploadCompleteResponse => ({ schemaVersion: CONTRACTS_VERSION, uploadId: id, status, reason, assetId: asset });
    if (row.status === 'finalized') return done('finalized', null, row.asset_id);
    if (row.status === 'rejected') return done('rejected', row.rejection_reason, null);
    const reject = async (reason: string) => {
      await this.bucket.delete(row.r2_key);
      await this.db.prepare("UPDATE media_uploads SET status = 'rejected', rejection_reason = ?, updated_at = ? WHERE user_id = ? AND upload_id = ?").bind(reason, this.now(), this.userId, id).run();
      return done('rejected', reason, null);
    };
    if (row.status !== 'uploaded') return reject('Nothing was uploaded before the authorization expired');
    const obj = await this.bucket.get(row.r2_key);
    if (!obj) return reject('The uploaded bytes are missing');
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const v = validateRaster(bytes, row.content_type, row.declared_bytes);
    if (!v.ok) return reject(v.problem.message);
    const now = this.now();
    const id2 = newAssetId();
    const sha = await sha256Bytes(bytes);
    const transformation: Transformation = { op: 'upload_finalized', provider: null, at: now, params: { uploadId: id, purpose: row.purpose, declaredBytes: row.declared_bytes, receivedBytes: bytes.length } };
    const statements = [
      this.db
        .prepare(
          `INSERT INTO media_assets (user_id, asset_id, r2_key, kind, source_asset_id, transformation_json, content_type, width, height, sha256, status, created_at, asset_class, byte_length, evidence_json, label)
           VALUES (?, ?, ?, 'source', NULL, ?, ?, ?, ?, ?, 'final', ?, 'owner_photo', ?, ?, NULL)`,
        )
        .bind(this.userId, id2, row.r2_key, json([transformation]), row.content_type, v.sniffed.width, v.sniffed.height, sha, now, bytes.length, json({ purpose: row.purpose })),
      this.db.prepare("UPDATE media_uploads SET status = 'finalized', asset_id = ?, updated_at = ? WHERE user_id = ? AND upload_id = ? AND status = 'uploaded'").bind(id2, now, this.userId, id),
    ];
    if (row.purpose === 'garment_photo' && row.garment_id) {
      // The owner says this photo is this garment: a verified supporting photograph (the original stays immutable).
      statements.push(this.db.prepare("INSERT INTO garment_media (user_id, garment_id, asset_id, role, verified, created_at) VALUES (?, ?, ?, 'supporting', 1, ?)").bind(this.userId, row.garment_id, id2, now));
    }
    await this.db.batch(statements);
    if (row.purpose === 'garment_photo' && row.garment_id && this.deps.onGarmentPhoto) await this.deps.onGarmentPhoto(id2, row.garment_id);
    return done('finalized', null, id2);
  }

  // ---------------------------------------------------------------- trusted ingestion and renditions

  /** Evidence rule: only final, undeleted assets of this owner may feed a task. */
  async requireEvidence(id: string): Promise<MediaAssetRow> {
    const row = await this.loadRow(id);
    if (!row || row.deleted_at) throw notFound('media_asset', id);
    if (row.status !== 'final') throw new DomainError('invalid_state', 'This image has not been finalized and cannot be used yet', { assetId: id, status: row.status });
    return row;
  }

  async readBytes(id: string): Promise<{ row: MediaAssetRow; bytes: Uint8Array }> {
    const row = await this.requireEvidence(id);
    const obj = await this.bucket.get(row.r2_key);
    if (!obj) throw new DomainError('invalid_state', 'The image bytes are missing', { assetId: id });
    return { row, bytes: new Uint8Array(await obj.arrayBuffer()) };
  }

  /**
   * Store a trusted image (pipeline output, demo placeholder, composite). Raster bytes are validated;
   * SVG must pass the allowlist. A derivative must name a final source and is stripped of metadata.
   */
  async ingest(input: IngestInput): Promise<MediaAsset> {
    requireScope(this.principal, SCOPE_WRITE);
    if (input.assetClass === 'imagined_rendering' && input.link === 'catalogue') throw new DomainError('validation_failed', 'An imagined rendering cannot be a catalogue image');
    let source: MediaAssetRow | null = null;
    if (input.sourceAssetId) source = await this.requireEvidence(input.sourceAssetId);
    let bytes = input.bytes;
    const s = sniff(bytes);
    if (!s.contentType) throw new DomainError('validation_failed', 'Not a recognised image');
    if (s.contentType === 'image/svg+xml') {
      const check = checkTrustedSvg(new TextDecoder().decode(bytes));
      if (!check.ok) throw new DomainError('validation_failed', 'The SVG contains markup outside the allowed drawing vocabulary', { problems: check.problems });
    } else {
      const v = validateRaster(bytes, s.contentType, MAX_UPLOAD_BYTES);
      if (!v.ok) throw new DomainError('validation_failed', v.problem.message, { code: v.problem.code });
    }
    const removed: string[] = [];
    if (source) {
      const stripped = stripLocationMetadata(bytes);
      bytes = stripped.bytes;
      removed.push(...stripped.removed);
    }
    if (input.garmentId) {
      const g = await this.db.prepare('SELECT 1 AS ok FROM garments WHERE user_id = ? AND garment_id = ?').bind(this.userId, input.garmentId).first();
      if (!g) throw notFound('garment', input.garmentId);
    }
    const now = this.now();
    const id = newAssetId();
    const key = r2KeyFor(this.userId, id);
    const sha = await sha256Bytes(bytes);
    const chain: Transformation[] = [...(source ? transformationsOf(source) : []), { ...input.transformation, at: input.transformation.at ?? now, params: { ...input.transformation.params, ...(source ? { sourceAssetId: source.asset_id, sourceSha256: source.sha256, metadataRemoved: removed } : {}) } }];
    const p = input.provenance ?? {};
    const label = input.label !== undefined ? input.label : defaultLabel(input.assetClass);
    await this.bucket.put(key, bytes, { httpMetadata: { contentType: s.contentType }, customMetadata: { userId: this.userId, assetId: id } });
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO media_assets (user_id, asset_id, r2_key, kind, source_asset_id, transformation_json, content_type, width, height, sha256, status, created_at,
             asset_class, byte_length, source_url, source_page_url, retrieved_at, permitted_use, evidence_json, fidelity_json, label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          this.userId, id, key, input.kind, source?.asset_id ?? null, json(chain), s.contentType, s.width, s.height, sha, now,
          input.assetClass, bytes.length, p.sourceUrl ?? null, p.sourcePageUrl ?? null, p.retrievedAt ?? null, p.permittedUse ?? null, json(p.evidence ?? {}), input.fidelity ? json(input.fidelity) : null, label,
        ),
    ];
    if (input.garmentId && input.link) statements.push(...this.linkStatements(input.garmentId, id, input.link, input.verified ?? false, now));
    try {
      await this.db.batch(statements);
    } catch (err) {
      await this.bucket.delete(key);
      throw err;
    }
    return rowToAsset((await this.loadRow(id))!, input.garmentId && input.link ? [input.garmentId] : []);
  }

  /** Record a rejected rendition (failed or identity-altering edit). No bytes are kept and nothing links to it. */
  async recordRejected(input: RejectInput): Promise<MediaAsset> {
    requireScope(this.principal, SCOPE_WRITE);
    const now = this.now();
    const id = newAssetId();
    const source = input.sourceAssetId ? await this.loadRow(input.sourceAssetId) : null;
    const chain: Transformation[] = [...(source ? transformationsOf(source) : []), { ...input.transformation, at: input.transformation.at ?? now }];
    await this.db
      .prepare(
        `INSERT INTO media_assets (user_id, asset_id, r2_key, kind, source_asset_id, transformation_json, content_type, sha256, status, created_at, asset_class, evidence_json, fidelity_json, label, rejection_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?, '{}', ?, NULL, ?)`,
      )
      .bind(this.userId, id, `u/${this.userId}/rejected/${id}`, input.kind, input.sourceAssetId, json(chain), input.contentType, input.sha256 ?? null, now, input.assetClass, input.fidelity ? json(input.fidelity) : null, input.reason)
      .run();
    return rowToAsset((await this.loadRow(id))!);
  }

  private linkStatements(garmentId: string, id: string, role: 'catalogue' | 'supporting', verified: boolean, now: string): D1PreparedStatement[] {
    const out: D1PreparedStatement[] = [];
    if (role === 'catalogue') {
      // One catalogue image per garment: the previous one becomes a supporting image (history kept).
      out.push(this.db.prepare("UPDATE garment_media SET role = 'supporting' WHERE user_id = ? AND garment_id = ? AND role = 'catalogue'").bind(this.userId, garmentId));
    }
    out.push(
      this.db
        .prepare('INSERT INTO garment_media (user_id, garment_id, asset_id, role, verified, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, garment_id, asset_id) DO UPDATE SET role = excluded.role, verified = excluded.verified')
        .bind(this.userId, garmentId, id, role, verified ? 1 : 0, now),
    );
    return out;
  }

  /** Make a final asset the garment's catalogue image. */
  async setCatalogue(garmentId: string, id: string, verified: boolean): Promise<void> {
    requireScope(this.principal, SCOPE_WRITE);
    const row = await this.requireEvidence(id);
    if (row.asset_class === 'imagined_rendering' || row.asset_class === 'composite') throw new DomainError('validation_failed', 'An imagined rendering or composite cannot be a catalogue image');
    const g = await this.db.prepare('SELECT 1 AS ok FROM garments WHERE user_id = ? AND garment_id = ?').bind(this.userId, garmentId).first();
    if (!g) throw notFound('garment', garmentId);
    await this.db.batch(this.linkStatements(garmentId, id, 'catalogue', verified, this.now()));
  }

  // ---------------------------------------------------------------- reads

  async loadRow(id: string): Promise<MediaAssetRow | null> {
    return this.db.prepare('SELECT * FROM media_assets WHERE user_id = ? AND asset_id = ?').bind(this.userId, id).first<MediaAssetRow>();
  }

  async getAsset(id: string): Promise<MediaAsset | null> {
    requireScope(this.principal, SCOPE_READ);
    const row = await this.loadRow(id);
    if (!row) return null;
    const { results } = await this.db.prepare('SELECT garment_id FROM garment_media WHERE user_id = ? AND asset_id = ? ORDER BY garment_id').bind(this.userId, id).all<{ garment_id: string }>();
    return rowToAsset(row, results.map((r) => r.garment_id));
  }

  /** Every rendition derived (directly or transitively) from an asset, oldest first. */
  async derivationTree(id: string): Promise<MediaAsset[]> {
    const { results } = await this.db
      .prepare(
        `WITH RECURSIVE tree(asset_id) AS (SELECT asset_id FROM media_assets WHERE user_id = ?1 AND asset_id = ?2
           UNION SELECT m.asset_id FROM media_assets m JOIN tree t ON m.source_asset_id = t.asset_id WHERE m.user_id = ?1)
         SELECT m.* FROM media_assets m JOIN tree t ON t.asset_id = m.asset_id WHERE m.user_id = ?1 ORDER BY m.created_at, m.asset_id`,
      )
      .bind(this.userId, id)
      .all<MediaAssetRow>();
    return results.map((r) => rowToAsset(r));
  }

  async listGarmentAssets(garmentId: string): Promise<MediaAsset[]> {
    requireScope(this.principal, SCOPE_READ);
    return (await loadGarmentAssetRows(this.db, this.userId, [garmentId])).map((r) => rowToAsset(r, [garmentId]));
  }

  // ---------------------------------------------------------------- serving

  /** A short-lived URL for one final asset of this owner. */
  async signedUrl(id: string, ttlSeconds?: number): Promise<{ url: string; expiresAt: string }> {
    requireScope(this.principal, SCOPE_READ);
    const row = await this.loadRow(id);
    if (!row || row.status !== 'final' || row.deleted_at) throw notFound('media_asset', id);
    return this.sign(id, ttlSeconds);
  }

  /** Sign without a lookup: only for IDs just read from this owner's final, undeleted rows. */
  private async sign(id: string, ttlSeconds?: number): Promise<{ url: string; expiresAt: string }> {
    const exp = this.nowSeconds() + (ttlSeconds ?? this.deps.urlTtlSeconds ?? 900);
    const token = await signToken(this.deps.signingKey, { purpose: 'media', userId: this.userId, objectId: id, exp });
    return { url: `${this.deps.urlBase ?? ''}/v1/media/${id}?t=${encodeURIComponent(token)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** GET /v1/media/{assetId}?t=… : no session needed; the token names the owner and the asset. */
  static async serveSigned(deps: { db: D1Database; bucket: R2Bucket; signingKey: string; clock?: () => string }, id: string, token: string): Promise<Response> {
    const now = deps.clock?.() ?? new Date().toISOString();
    const v = await verifyToken(deps.signingKey, token, { purpose: 'media', objectId: id, nowSeconds: Math.floor(Date.parse(now) / 1000) });
    if (!v.ok) return v.reason === 'expired' ? errorResponse(403, 'expired', 'This image link has expired') : errorResponse(404, 'not_found', 'No such image');
    return serveRow(deps.db, deps.bucket, v.claims.userId, id, true);
  }

  /** Authenticated GET (session or bearer): the principal's own assets only. */
  async serve(id: string): Promise<Response> {
    requireScope(this.principal, SCOPE_READ);
    return serveRow(this.db, this.bucket, this.userId, id, false);
  }

  /**
   * Display media for garments (Today, Wardrobe, Studio). Three D1 queries for any number of garments
   * (links, thumbnails, Photos needed) plus HMAC signing; no R2 reads.
   */
  async garmentMedia(garmentIds: readonly string[]): Promise<Map<string, GarmentMedia>> {
    requireScope(this.principal, SCOPE_READ);
    const ids = [...new Set(garmentIds)];
    const out = new Map<string, GarmentMedia>();
    if (!ids.length) return out;
    const rows = await loadGarmentAssetRows(this.db, this.userId, ids);
    const [{ results: needed }, catalogues] = await Promise.all([
      this.db
        .prepare("SELECT garment_id FROM garment_photo_status WHERE user_id = ? AND status IN ('photos_needed', 'needs_review') AND garment_id IN (SELECT value FROM json_each(?))")
        .bind(this.userId, JSON.stringify(ids))
        .all<{ garment_id: string }>(),
      Promise.resolve(new Map(ids.map((gid) => [gid, selectCatalogue(rows.filter((r) => r.garment_id === gid))]))),
    ]);
    const catIds = [...catalogues.values()].filter((c): c is NonNullable<typeof c> => Boolean(c)).map((c) => c.asset_id);
    const { results: thumbs } = catIds.length
      ? await this.db
          .prepare(
            "SELECT source_asset_id, asset_id FROM media_assets WHERE user_id = ? AND kind = 'thumbnail' AND status = 'final' AND deleted_at IS NULL AND source_asset_id IN (SELECT value FROM json_each(?)) ORDER BY width, asset_id",
          )
          .bind(this.userId, JSON.stringify(catIds))
          .all<{ source_asset_id: string; asset_id: string }>()
      : { results: [] as { source_asset_id: string; asset_id: string }[] };
    const thumbFor = new Map<string, string>();
    for (const t of thumbs) if (!thumbFor.has(t.source_asset_id)) thumbFor.set(t.source_asset_id, t.asset_id);
    const neededSet = new Set(needed.map((n) => n.garment_id));
    for (const gid of ids) {
      const mine = rows.filter((r) => r.garment_id === gid);
      const cat = catalogues.get(gid) ?? null;
      let catalogueUrl: string | null = null;
      let thumbUrl: string | null = null;
      let expiresAt: string | null = null;
      if (cat) {
        const s = await this.sign(cat.asset_id);
        catalogueUrl = s.url;
        expiresAt = s.expiresAt;
        const t = thumbFor.get(cat.asset_id);
        thumbUrl = t ? (await this.sign(t)).url : catalogueUrl;
      }
      const photos: GarmentMedia['photos'] = [];
      for (const r of mine) {
        if (r.kind !== 'source' || r.asset_id === cat?.asset_id || !['owner_photo', 'exact_product_photo'].includes(r.asset_class)) continue;
        photos.push({ url: (await this.sign(r.asset_id)).url, caption: r.asset_class === 'owner_photo' ? 'Your photo' : 'Product photo' });
      }
      out.set(gid, {
        thumbnailUrl: thumbUrl,
        catalogueImageUrl: catalogueUrl,
        aspectRatio: cat?.width && cat.height ? Math.round((cat.width / cat.height) * 1000) / 1000 : null,
        photos,
        verified: isVerifiedCatalogue(cat),
        catalogueAssetId: cat?.asset_id ?? null,
        assetClass: cat?.asset_class ?? null,
        label: cat ? cat.label : null,
        photosNeeded: neededSet.has(gid) && !isVerifiedCatalogue(cat),
        urlsExpireAt: expiresAt,
      });
    }
    return out;
  }

  /**
   * On-demand display thumbnail at a fixed width (spec: fixed dimensions, generated on request rather
   * than precomputing every size). Recorded as a `thumbnail` rendition of its source.
   */
  async thumbnail(id: string, width: ThumbnailWidth): Promise<MediaAsset | null> {
    if (!THUMBNAIL_WIDTHS.includes(width)) throw new DomainError('validation_failed', `Thumbnail width must be one of ${THUMBNAIL_WIDTHS.join(', ')}`);
    const existing = await this.db
      .prepare("SELECT * FROM media_assets WHERE user_id = ? AND source_asset_id = ? AND kind = 'thumbnail' AND status = 'final' AND deleted_at IS NULL AND width = ?")
      .bind(this.userId, id, width)
      .first<MediaAssetRow>();
    if (existing) return rowToAsset(existing);
    const { row, bytes } = await this.readBytes(id);
    let out: Uint8Array;
    let provider: string;
    if (row.content_type === 'image/svg+xml') {
      out = resizeSvg(bytes, width);
      provider = 'garderobe-svg';
    } else {
      if (!this.deps.transformer) return null;
      out = (await this.deps.transformer.resize(bytes, row.content_type, width)).bytes;
      provider = this.deps.transformer.name;
    }
    return this.ingest({ bytes: out, kind: 'thumbnail', assetClass: row.asset_class, sourceAssetId: id, label: row.label, transformation: { op: 'resize', provider, params: { width } } });
  }

  // ---------------------------------------------------------------- deletion

  /**
   * Delete an asset and everything derived from it: renditions, garment links, composites that
   * reference any of them, and the R2 bytes. D1 keeps a tombstone (metadata without bytes).
   */
  async deleteAsset(id: string): Promise<{ deletedAssetIds: string[]; compositesRemoved: number }> {
    requireScope(this.principal, SCOPE_WRITE);
    const root = await this.loadRow(id);
    if (!root) throw notFound('media_asset', id);
    const tree = await this.derivationTree(id);
    const ids = tree.map((a) => a.assetId);
    const { results: composites } = await this.db
      .prepare('SELECT manifest_hash, asset_id, manifest_json FROM outfit_composites WHERE user_id = ?')
      .bind(this.userId)
      .all<{ manifest_hash: string; asset_id: string | null; manifest_json: string }>();
    const affected = composites.filter((c) => ids.some((a) => c.manifest_json.includes(`"${a}"`)));
    const allIds = [...ids, ...affected.map((c) => c.asset_id).filter((x): x is string => Boolean(x))];
    const rows = await Promise.all(allIds.map((a) => this.loadRow(a)));
    const now = this.now();
    const statements: D1PreparedStatement[] = [];
    for (const c of affected) statements.push(this.db.prepare('DELETE FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?').bind(this.userId, c.manifest_hash));
    for (const a of allIds) {
      statements.push(this.db.prepare('DELETE FROM garment_media WHERE user_id = ? AND asset_id = ?').bind(this.userId, a));
      statements.push(this.db.prepare("UPDATE media_assets SET deleted_at = ?, status = 'rejected', rejection_reason = 'deleted by owner' WHERE user_id = ? AND asset_id = ?").bind(now, this.userId, a));
    }
    await this.db.batch(statements);
    for (const r of rows) if (r) await this.bucket.delete(r.r2_key);
    return { deletedAssetIds: allIds, compositesRemoved: affected.length };
  }
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ schemaVersion: CONTRACTS_VERSION, error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function serveRow(db: D1Database, bucket: R2Bucket, userId: string, id: string, signed: boolean): Promise<Response> {
  const row = await db.prepare('SELECT * FROM media_assets WHERE user_id = ? AND asset_id = ?').bind(userId, id).first<MediaAssetRow>();
  if (!row || row.status !== 'final' || row.deleted_at) return errorResponse(404, 'not_found', 'No such image');
  const obj = await bucket.get(row.r2_key);
  if (!obj) return errorResponse(404, 'not_found', 'No such image');
  const headers = new Headers({
    'Content-Type': row.content_type,
    'Cache-Control': signed ? 'private, max-age=300' : 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Cross-Origin-Resource-Policy': 'same-site',
  });
  if (row.sha256) headers.set('ETag', `"${row.sha256}"`);
  if (row.content_type === 'image/svg+xml') headers.set('Content-Security-Policy', SVG_CSP);
  if (row.label) headers.set('X-Garderobe-Image-Label', encodeURIComponent(row.label)); // percent-encoded: header values must be ASCII
  return new Response(obj.body, { status: 200, headers });
}

/** Set the rendered size of a trusted SVG (its viewBox keeps the drawing). */
export function resizeSvg(bytes: Uint8Array, width: number): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const s = sniff(bytes);
  const height = s.width && s.height ? Math.round((width * s.height) / s.width) : width;
  const out = text.replace(/^(<svg\b[^>]*?\s)width="[^"]*"/, `$1width="${width}"`).replace(/^(<svg\b[^>]*?\s)height="[^"]*"/, `$1height="${height}"`);
  return new TextEncoder().encode(out);
}
