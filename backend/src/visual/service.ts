import { CONTRACTS_VERSION, type CompositionManifest, type GarmentRole, type MediaAsset, type OutfitComposite, type StudioSlot } from '@garderobe/contracts';
import { parseJson } from '../domain/db.js';
import { DomainError, notFound } from '../domain/errors.js';
import { assertPrincipal, requireScope, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { loadGarments } from '../domain/records.js';
import { loadGarmentAssetRows, selectCatalogue } from '../media/records.js';
import type { ImageGenerator } from '../media/providers.js';
import { MediaService, type MediaServiceDeps } from '../media/service.js';
import { toBase64 } from '../media/sniff.js';
import { layoutOutfit, manifestHash, type LayoutAsset, type LayoutGarment } from './layout.js';
import { renderCompositeSvg, type EmbeddedImage } from './render.js';

/**
 * Outfit composites (spec section 11): resolve each garment's approved asset, lay them out with the
 * pure versioned layout, and cache the rendered SVG by manifest hash in private R2. Rendering is
 * background work (a `composite` media job); `manifestFor` is instant and writes nothing, so Today and
 * Studio never wait for it. A swap changes one asset reference and therefore one manifest hash.
 */

export type CompositeDeps = Omit<MediaServiceDeps, 'onGarmentPhoto' | 'transformer'>;

export interface OutfitSlotInput {
  garmentId: string;
  role: GarmentRole;
  alternativeGroup?: string | null;
}

export class CompositeService {
  readonly media: MediaService;
  private readonly db: D1Database;
  private readonly principal: Principal;

  constructor(private readonly deps: CompositeDeps) {
    assertPrincipal(deps.principal);
    this.db = deps.db;
    this.principal = deps.principal;
    this.media = new MediaService(deps);
  }

  /** Garment facts and chosen assets for an outfit (owner-scoped; unknown IDs are not found). */
  async resolve(slots: readonly OutfitSlotInput[]): Promise<{ garments: LayoutGarment[]; assets: Record<string, LayoutAsset | null> }> {
    requireScope(this.principal, SCOPE_READ);
    const ids = [...new Set(slots.map((s) => s.garmentId))];
    const rows = await loadGarments(this.db, this.principal.userId, ids);
    for (const id of ids) if (!rows.has(id)) throw notFound('garment', id);
    const media = await loadGarmentAssetRows(this.db, this.principal.userId, ids);
    const garments: LayoutGarment[] = slots.map((s) => {
      const g = rows.get(s.garmentId)!;
      const attrs = parseJson<Record<string, unknown>>(g.attributes_json, {});
      const length = attrs.length === 'long' || attrs.length === 'short' ? (attrs.length as 'long' | 'short') : null;
      return { garmentId: s.garmentId, role: s.role, name: g.name, category: g.category, alternativeGroup: s.alternativeGroup ?? null, length };
    });
    const assets: Record<string, LayoutAsset | null> = {};
    for (const id of ids) {
      // HEIC cannot be embedded in an SVG scene; such a garment keeps a labelled outline until a rendition exists.
      const chosen = selectCatalogue(media.filter((m) => m.garment_id === id && m.content_type !== 'image/heic'));
      assets[id] = chosen && chosen.sha256 ? { assetId: chosen.asset_id, kind: chosen.kind, assetClass: chosen.asset_class, sha256: chosen.sha256, width: chosen.width, height: chosen.height, label: chosen.label } : null;
    }
    return { garments, assets };
  }

  /** The manifest and its hash. Pure read; nothing is written. */
  async manifestFor(slots: readonly OutfitSlotInput[]): Promise<{ manifest: CompositionManifest; manifestHash: string }> {
    const { garments, assets } = await this.resolve(slots);
    const manifest = layoutOutfit(garments, assets);
    return { manifest, manifestHash: await manifestHash(manifest) };
  }

  /** Render (once per manifest hash) and store the SVG preview; returns signed references. */
  async compose(slots: readonly OutfitSlotInput[], opts: { store?: boolean } = {}): Promise<OutfitComposite> {
    const { manifest, manifestHash: hash } = await this.manifestFor(slots);
    let previewAssetId: string | null = null;
    const cached = await this.db.prepare('SELECT asset_id FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?').bind(this.principal.userId, hash).first<{ asset_id: string | null }>();
    if (cached?.asset_id) previewAssetId = cached.asset_id;
    else if (opts.store !== false) {
      requireScope(this.principal, SCOPE_WRITE);
      const svg = await this.renderStored(manifest);
      const asset = await this.media.ingest({
        bytes: new TextEncoder().encode(svg),
        kind: 'composite',
        assetClass: 'composite',
        label: manifest.labels.length ? manifest.labels.join(' · ') : null,
        transformation: { op: 'compose', provider: 'garderobe-layout', params: { layoutVersion: manifest.layoutVersion, template: manifest.template, manifestHash: hash, assetIds: manifest.items.map((i) => i.assetId) } },
      });
      await this.db
        .prepare('INSERT INTO outfit_composites (user_id, manifest_hash, layout_version, manifest_json, garment_ids_json, asset_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, manifest_hash) DO NOTHING')
        .bind(this.principal.userId, hash, manifest.layoutVersion, JSON.stringify(manifest), JSON.stringify(manifest.items.map((i) => i.garmentId)), asset.assetId, asset.createdAt)
        .run();
      const winner = await this.db.prepare('SELECT asset_id FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?').bind(this.principal.userId, hash).first<{ asset_id: string }>();
      if (winner && winner.asset_id !== asset.assetId) await this.media.deleteAsset(asset.assetId); // a concurrent render won
      previewAssetId = winner?.asset_id ?? asset.assetId;
    }
    return this.signed(manifest, hash, previewAssetId);
  }

  /** The stored form embeds the approved asset bytes, so the preview is self-contained and private. */
  async renderStored(manifest: CompositionManifest): Promise<string> {
    const images = new Map<string, EmbeddedImage>();
    for (const it of manifest.items) {
      if (!it.assetId || images.has(it.assetId)) continue;
      const { row, bytes } = await this.media.readBytes(it.assetId);
      if (row.sha256 !== it.renditionSha256) throw new DomainError('conflict', 'An asset changed while the outfit was being composed', { assetId: it.assetId });
      images.set(it.assetId, { contentType: row.content_type as EmbeddedImage['contentType'], base64: toBase64(bytes) });
    }
    return renderCompositeSvg(manifest, images);
  }

  private async signed(manifest: CompositionManifest, hash: string, previewAssetId: string | null): Promise<OutfitComposite> {
    const assetUrls: Record<string, string> = {};
    let expires: string | null = null;
    for (const it of manifest.items) {
      if (!it.assetId || assetUrls[it.assetId]) continue;
      const s = await this.media.signedUrl(it.assetId);
      assetUrls[it.assetId] = s.url;
      expires = s.expiresAt;
    }
    const preview = previewAssetId ? await this.media.signedUrl(previewAssetId) : null;
    return { schemaVersion: CONTRACTS_VERSION, manifest, manifestHash: hash, previewAssetId, previewUrl: preview?.url ?? null, assetUrls, urlsExpireAt: preview?.expiresAt ?? expires };
  }

  /** Slots of a board option (the option's own garments and roles), owner-scoped. */
  async optionSlots(optionId: string): Promise<StudioSlot[]> {
    const { results } = await this.db
      .prepare('SELECT garment_id, role, alternative_group FROM option_garments WHERE user_id = ? AND option_id = ? ORDER BY role, garment_id')
      .bind(this.principal.userId, optionId)
      .all<{ garment_id: string; role: GarmentRole; alternative_group: string | null }>();
    if (!results.length) throw notFound('board', optionId);
    return results.map((r) => ({ garmentId: r.garment_id, role: r.role, ...(r.alternative_group ? { alternativeGroup: r.alternative_group } : {}) }));
  }

  async forOption(optionId: string, opts: { store?: boolean } = {}): Promise<OutfitComposite> {
    return this.compose(await this.optionSlots(optionId), opts);
  }

  /**
   * An imagined rendering of a look (optional generator). It is stored as its own labelled asset,
   * never linked to a garment, never used in a composite, and its manifest-free record says so.
   */
  async recordImaginedRendering(generator: ImageGenerator, prompt: string, garmentIds: string[]): Promise<MediaAsset> {
    requireScope(this.principal, SCOPE_WRITE);
    const { image } = await generator.generate(prompt);
    return this.media.ingest({
      bytes: image,
      kind: 'composite',
      assetClass: 'imagined_rendering',
      transformation: { op: 'imagined_generation', provider: generator.name, params: { garmentIds } },
      provenance: { evidence: { imagined: true, prompt, garmentIds, note: 'Not an image of the actual garments; never a catalogue image.' } },
    });
  }
}
