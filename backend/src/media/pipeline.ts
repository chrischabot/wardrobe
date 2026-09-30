import type { MediaAsset, PhotosNeeded, StudioSlot } from '@garderobe/contracts';
import { CONTRACTS_VERSION } from '@garderobe/contracts';
import type { Env } from '../env.js';
import { json, parseJson } from '../domain/db.js';
import { DomainError, notFound } from '../domain/errors.js';
import { assertPrincipal, requireScope, SCOPE_READ, SCOPE_WRITE, systemPrincipal, type Principal } from '../domain/principal.js';
import { CompositeService } from '../visual/service.js';
import { matchCandidate, photoRequest, rankCandidates, checkFidelity, type CandidateDecision } from './fidelity.js';
import type { GarmentSearchFacts, ImageDescriptor, MediaProviders, SearchStrategy } from './providers.js';
import { FAITHFUL_CLASSES, isVerifiedCatalogue, loadGarmentAssetRows, selectCatalogue, type MediaAssetRow } from './records.js';
import { MediaService, type MediaServiceDeps } from './service.js';
import { mediaSigningKey } from './signing.js';
import { sniff, validateRaster } from './sniff.js';
import { checkTrustedSvg } from './svg.js';

/**
 * The visual catalogue pipeline (spec section 11) as durable jobs: `media_jobs` rows are the ledger,
 * MEDIA_QUEUE messages carry only (userId, jobId), and every job is idempotent, so a Queue retry or
 * a duplicate delivery never repeats a paid call that already succeeded.
 *
 *  discover   bounded product-image search → deterministic identity match → adopt as an exact
 *             product photo with provenance, or leave the garment in Photos needed / review.
 *  normalize  immutable original → cutout + mask → catalogue view (canvas normalization, or a
 *             generative edit that must pass the fidelity check) → catalogue link.
 *  composite  render and cache an outfit composite.
 *
 * Missing photos never block anything else: the daily service composes without images, and a
 * composite keeps an unphotographed garment's place with a labelled outline.
 */

/** "Try hard", operationally (spec): three strategies, 12 candidate pages, two browser sessions per unresolved garment and job. */
export const DISCOVERY_ALLOWANCE = { strategies: 3, candidatePages: 12, browserSessions: 2 } as const;
const STRATEGY_ORDER: SearchStrategy[] = ['purchase_source', 'manufacturer_archive', 'identifier_search'];
const MAX_QUEUE_ATTEMPTS = 3;

export interface MediaQueueMessage {
  v: 1;
  userId: string;
  jobId: string;
}

export interface QueueLike {
  send(body: MediaQueueMessage): Promise<unknown>;
}

export interface MediaPipelineDeps extends Omit<MediaServiceDeps, 'onGarmentPhoto'> {
  providers?: MediaProviders;
  queue?: QueueLike | null;
}

interface JobRow {
  job_id: string;
  kind: 'discover' | 'normalize' | 'composite';
  garment_id: string | null;
  operation_key: string;
  status: string;
  attempts: number;
  input_json: string;
  result_json: string | null;
}

interface StatusRow {
  garment_id: string;
  status: string;
  strategies_used: number;
  candidate_pages: number;
  browser_sessions: number;
  tried_json: string;
  review_json: string;
  request_text: string | null;
  last_searched_at: string | null;
}

export interface JobOutcome {
  jobId: string;
  kind: string;
  status: 'succeeded' | 'unresolved' | 'waiting_provider' | 'failed' | 'queued' | 'running';
  result: Record<string, unknown>;
}

function jobId(): string {
  return `mjb_${crypto.randomUUID().replace(/-/g, '')}`;
}

export class MediaPipeline {
  readonly media: MediaService;
  readonly composites: CompositeService;
  private readonly db: D1Database;
  private readonly principal: Principal;
  private readonly providers: MediaProviders;
  private readonly now: () => string;

  constructor(private readonly deps: MediaPipelineDeps) {
    assertPrincipal(deps.principal);
    this.db = deps.db;
    this.principal = deps.principal;
    this.providers = deps.providers ?? {};
    this.now = deps.clock ?? (() => new Date().toISOString());
    this.media = new MediaService({ ...deps, onGarmentPhoto: (assetId, garmentId) => this.enqueueNormalize(assetId, garmentId).then(() => undefined) });
    this.composites = new CompositeService(deps);
  }

  private get userId(): string {
    return this.principal.userId;
  }

  // ---------------------------------------------------------------- enqueueing

  /** Insert (or find) the job for an operation key and send its message. Idempotent per key. */
  async enqueue(kind: JobRow['kind'], operationKey: string, input: Record<string, unknown>, garmentId: string | null = null): Promise<string> {
    requireScope(this.principal, SCOPE_WRITE);
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO media_jobs (user_id, job_id, kind, garment_id, operation_key, status, input_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT (user_id, operation_key) DO NOTHING`,
      )
      .bind(this.userId, jobId(), kind, garmentId, operationKey, json(input), now, now)
      .run();
    const row = await this.db.prepare('SELECT job_id, status FROM media_jobs WHERE user_id = ? AND operation_key = ?').bind(this.userId, operationKey).first<{ job_id: string; status: string }>();
    if (row && (row.status === 'queued' || row.status === 'waiting_provider') && this.deps.queue) await this.deps.queue.send({ v: 1, userId: this.userId, jobId: row.job_id });
    return row!.job_id;
  }

  async enqueueDiscovery(garmentId: string, reason = 'initial'): Promise<string> {
    await this.requireGarment(garmentId);
    return this.enqueue('discover', `discover:${garmentId}:${reason}`, { reason }, garmentId);
  }

  async enqueueNormalize(sourceAssetId: string, garmentId: string): Promise<string> {
    return this.enqueue('normalize', `normalize:${sourceAssetId}`, { sourceAssetId }, garmentId);
  }

  async enqueueComposite(slots: StudioSlot[]): Promise<string> {
    const { manifestHash } = await this.composites.manifestFor(slots);
    return this.enqueue('composite', `composite:${manifestHash}`, { slots });
  }

  /** Queue composites for every option of a published board (background; never delays the board). */
  async enqueueBoardComposites(boardDate: string, purpose = 'day'): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT o.option_id FROM boards b JOIN board_options o ON o.user_id = b.user_id AND o.board_id = b.board_id AND o.revision = b.current_revision
         WHERE b.user_id = ? AND b.board_date = ? AND b.purpose = ? AND o.status = 'offerable' ORDER BY o.position`,
      )
      .bind(this.userId, boardDate, purpose)
      .all<{ option_id: string }>();
    const ids: string[] = [];
    for (const r of results) ids.push(await this.enqueueComposite(await this.composites.optionSlots(r.option_id)));
    return ids;
  }

  /**
   * Background image discovery for garments without a verified image, highest expected use first
   * (active, normally planned, most recorded wears), skipping ones already resolved or unresolved.
   */
  async backfill(limit = 25): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT g.garment_id FROM garments g
         LEFT JOIN garment_photo_status s ON s.user_id = g.user_id AND s.garment_id = g.garment_id
         WHERE g.user_id = ? AND g.acquisition = 'owned' AND g.planning_policy <> 'excluded' AND s.garment_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM garment_media gm JOIN media_assets ma ON ma.user_id = gm.user_id AND ma.asset_id = gm.asset_id
                           WHERE gm.user_id = g.user_id AND gm.garment_id = g.garment_id AND gm.verified = 1 AND ma.status = 'final'
                             AND ma.asset_class IN ('exact_product_photo', 'owner_photo', 'edited_rendition'))
         ORDER BY (g.planning_policy = 'normal') DESC,
                  (SELECT COUNT(*) FROM daily_wears w WHERE w.user_id = g.user_id AND w.garment_id = g.garment_id AND w.status = 'active') DESC,
                  g.name, g.garment_id
         LIMIT ?`,
      )
      .bind(this.userId, limit)
      .all<{ garment_id: string }>();
    const ids: string[] = [];
    for (const r of results) ids.push(await this.enqueueDiscovery(r.garment_id));
    return ids;
  }

  /**
   * Retry an unresolved garment. A retry needs something new (a new source the search provider now
   * knows about, or a supplied photo); already-tried sources are skipped, never repeated.
   */
  async retryDiscovery(garmentId: string, reason: string): Promise<string> {
    return this.enqueueDiscovery(garmentId, `retry:${reason}`);
  }

  // ---------------------------------------------------------------- running

  async runJob(id: string): Promise<JobOutcome> {
    requireScope(this.principal, SCOPE_WRITE);
    const job = await this.db.prepare('SELECT * FROM media_jobs WHERE user_id = ? AND job_id = ?').bind(this.userId, id).first<JobRow>();
    if (!job) throw notFound('media_asset', id);
    if (['succeeded', 'unresolved', 'failed'].includes(job.status)) {
      return { jobId: id, kind: job.kind, status: job.status as JobOutcome['status'], result: parseJson(job.result_json, {}) };
    }
    await this.db.prepare("UPDATE media_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE user_id = ? AND job_id = ?").bind(this.now(), this.userId, id).run();
    const input = parseJson<Record<string, unknown>>(job.input_json, {});
    let outcome: { status: JobOutcome['status']; result: Record<string, unknown> };
    try {
      if (job.kind === 'discover') outcome = await this.runDiscovery(job.garment_id!);
      else if (job.kind === 'normalize') outcome = await this.runNormalize(String(input.sourceAssetId), job.garment_id!);
      else {
        const c = await this.composites.compose(input.slots as StudioSlot[]);
        outcome = { status: 'succeeded', result: { manifestHash: c.manifestHash, previewAssetId: c.previewAssetId } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof DomainError) {
        // Permanent (source deleted, not final, garment gone): retrying cannot help.
        await this.failJob(id, message);
        return { jobId: id, kind: job.kind, status: 'failed', result: { error: message, code: err.code } };
      }
      // Transient (provider or network error): back to the queue for a retry.
      await this.db.prepare("UPDATE media_jobs SET status = 'queued', last_error = ?, updated_at = ? WHERE user_id = ? AND job_id = ?").bind(message, this.now(), this.userId, id).run();
      throw err;
    }
    await this.db
      .prepare('UPDATE media_jobs SET status = ?, result_json = ?, last_error = NULL, updated_at = ? WHERE user_id = ? AND job_id = ?')
      .bind(outcome.status, json(outcome.result), this.now(), this.userId, id)
      .run();
    return { jobId: id, kind: job.kind, ...outcome };
  }

  /** Mark a job failed after exhausting queue retries. */
  async failJob(id: string, message: string): Promise<void> {
    await this.db.prepare("UPDATE media_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE user_id = ? AND job_id = ?").bind(message, this.now(), this.userId, id).run();
  }

  /** Run every queued job of this owner inline (local runs, tests, and the due-job sweep). */
  async drain(max = 50): Promise<JobOutcome[]> {
    const out: JobOutcome[] = [];
    for (let i = 0; i < max; i++) {
      const next = await this.db.prepare("SELECT job_id FROM media_jobs WHERE user_id = ? AND status = 'queued' ORDER BY created_at, job_id LIMIT 1").bind(this.userId).first<{ job_id: string }>();
      if (!next) break;
      try {
        out.push(await this.runJob(next.job_id));
      } catch (err) {
        await this.failJob(next.job_id, err instanceof Error ? err.message : String(err));
        out.push({ jobId: next.job_id, kind: 'unknown', status: 'failed', result: { error: String(err) } });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- discovery

  private async requireGarment(garmentId: string) {
    const g = await this.db
      .prepare('SELECT garment_id, name, category, maker, product_name, product_code, color, fabric, attributes_json, acquisition FROM garments WHERE user_id = ? AND garment_id = ?')
      .bind(this.userId, garmentId)
      .first<{ garment_id: string; name: string; category: string; maker: string | null; product_name: string | null; product_code: string | null; color: string | null; fabric: string | null; attributes_json: string; acquisition: string }>();
    if (!g) throw notFound('garment', garmentId);
    return g;
  }

  private async statusRow(garmentId: string): Promise<StatusRow | null> {
    return this.db.prepare('SELECT * FROM garment_photo_status WHERE user_id = ? AND garment_id = ?').bind(this.userId, garmentId).first<StatusRow>();
  }

  private async writeStatus(garmentId: string, s: Omit<StatusRow, 'garment_id'>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO garment_photo_status (user_id, garment_id, status, strategies_used, candidate_pages, browser_sessions, tried_json, review_json, request_text, last_searched_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, garment_id) DO UPDATE SET status = excluded.status, strategies_used = excluded.strategies_used, candidate_pages = excluded.candidate_pages,
           browser_sessions = excluded.browser_sessions, tried_json = excluded.tried_json, review_json = excluded.review_json, request_text = excluded.request_text,
           last_searched_at = excluded.last_searched_at, updated_at = excluded.updated_at`,
      )
      .bind(this.userId, garmentId, s.status, s.strategies_used, s.candidate_pages, s.browser_sessions, s.tried_json, s.review_json, s.request_text, s.last_searched_at, this.now())
      .run();
  }

  private async hasVerifiedCatalogue(garmentId: string): Promise<boolean> {
    return isVerifiedCatalogue(selectCatalogue(await loadGarmentAssetRows(this.db, this.userId, [garmentId])));
  }

  async runDiscovery(garmentId: string): Promise<{ status: JobOutcome['status']; result: Record<string, unknown> }> {
    const g = await this.requireGarment(garmentId);
    if (await this.hasVerifiedCatalogue(garmentId)) return { status: 'succeeded', result: { reason: 'already_resolved' } };
    const { search, fetcher, analyzer } = this.providers;
    if (!search || !fetcher || !analyzer) return { status: 'waiting_provider', result: { reason: 'No image search, fetch and analysis providers are configured' } };

    const facts: GarmentSearchFacts = { garmentId, name: g.name, category: g.category, maker: g.maker, productName: g.product_name, productCode: g.product_code, color: g.color, fabric: g.fabric, attributes: parseJson(g.attributes_json, {}) };
    const prev = await this.statusRow(garmentId);
    const tried = new Set(parseJson<string[]>(prev?.tried_json, []));
    const review = parseJson<{ imageUrl: string; pageUrl: string; reasons: string[] }[]>(prev?.review_json, []);
    const totals = { strategies: prev?.strategies_used ?? 0, pages: prev?.candidate_pages ?? 0, browser: prev?.browser_sessions ?? 0 };
    const run = { strategies: 0, pages: 0, browser: 0 };
    const examined: { strategy: SearchStrategy; pageUrl: string; decision: CandidateDecision['decision'] | 'unfetchable' | 'invalid_image'; reasons: string[] }[] = [];
    const now = this.now();

    for (const strategy of STRATEGY_ORDER) {
      if (run.strategies >= DISCOVERY_ALLOWANCE.strategies || run.pages >= DISCOVERY_ALLOWANCE.candidatePages) break;
      const key = search.sourceKey(facts, strategy);
      if (!key || tried.has(key)) continue; // never repeat the same unsuccessful search
      tried.add(key);
      run.strategies++;
      const candidates = rankCandidates(facts, await search.find(facts, strategy, DISCOVERY_ALLOWANCE.candidatePages - run.pages));
      for (const c of candidates) {
        if (run.pages >= DISCOVERY_ALLOWANCE.candidatePages) break;
        if (c.viaBrowser && run.browser >= DISCOVERY_ALLOWANCE.browserSessions) continue;
        run.pages++;
        if (c.viaBrowser) run.browser++;
        const img = await fetcher.fetchImage(c.imageUrl);
        if (!img) {
          examined.push({ strategy, pageUrl: c.pageUrl, decision: 'unfetchable', reasons: ['The image could not be retrieved'] });
          continue;
        }
        const s = sniff(img.bytes);
        const valid = s.contentType === 'image/svg+xml' ? checkTrustedSvg(new TextDecoder().decode(img.bytes)).ok : s.contentType ? validateRaster(img.bytes, s.contentType, 25_000_000).ok : false;
        if (!valid || !s.contentType || s.contentType === 'image/heic') {
          examined.push({ strategy, pageUrl: c.pageUrl, decision: 'invalid_image', reasons: ['Not a usable image'] });
          continue;
        }
        const d = await analyzer.describe(img.bytes, s.contentType);
        const decision = matchCandidate(facts, c, d);
        examined.push({ strategy, pageUrl: c.pageUrl, decision: decision.decision, reasons: decision.reasons });
        if (decision.decision === 'uncertain') review.push({ imageUrl: c.imageUrl, pageUrl: c.pageUrl, reasons: decision.reasons });
        if (decision.decision !== 'adopt') continue;
        const asset = await this.media.ingest({
          bytes: img.bytes,
          kind: 'source',
          assetClass: 'exact_product_photo',
          garmentId,
          link: 'catalogue',
          verified: true,
          transformation: { op: 'product_image_adopted', provider: search.name, params: { strategy } },
          provenance: {
            sourceUrl: c.imageUrl,
            sourcePageUrl: c.pageUrl,
            retrievedAt: now,
            permittedUse: c.permittedUse ?? 'Private catalogue use only; publication rights are not assumed',
            evidence: { strategy, pageTitle: c.pageTitle, pageIdentifiers: c.pageIdentifiers, match: decision.evidence, reasons: decision.reasons },
          },
        });
        await this.writeStatus(garmentId, {
          status: 'resolved', strategies_used: totals.strategies + run.strategies, candidate_pages: totals.pages + run.pages, browser_sessions: totals.browser + run.browser,
          tried_json: json([...tried]), review_json: '[]', request_text: null, last_searched_at: now,
        });
        await this.enqueueNormalize(asset.assetId, garmentId);
        return { status: 'succeeded', result: { adoptedAssetId: asset.assetId, strategy, examined, usage: run } };
      }
    }
    const request = photoRequest(g.name, g.category);
    await this.writeStatus(garmentId, {
      status: review.length ? 'needs_review' : 'photos_needed', strategies_used: totals.strategies + run.strategies, candidate_pages: totals.pages + run.pages, browser_sessions: totals.browser + run.browser,
      tried_json: json([...tried]), review_json: json(review.slice(-12)), request_text: request, last_searched_at: now,
    });
    return { status: 'unresolved', result: { examined, usage: run, request, reviewCandidates: review.length } };
  }

  // ---------------------------------------------------------------- normalization

  async runNormalize(sourceAssetId: string, garmentId: string): Promise<{ status: JobOutcome['status']; result: Record<string, unknown> }> {
    const { row: source, bytes } = await this.media.readBytes(sourceAssetId); // pending/rejected uploads are refused here
    const faithful = FAITHFUL_CLASSES.includes(source.asset_class);
    const { analyzer, cutout, editor } = this.providers;
    const steps: Record<string, unknown>[] = [];
    let base: { assetId: string; bytes: Uint8Array; contentType: string } = { assetId: source.asset_id, bytes, contentType: source.content_type };
    let catalogueId = source.asset_id;
    let catalogueVerified = faithful;

    if (!analyzer) {
      // Without an analyzer no rendition can be fidelity-checked: the honest original becomes the catalogue image.
      await this.media.setCatalogue(garmentId, source.asset_id, faithful);
      await this.markResolved(garmentId);
      return { status: 'succeeded', result: { catalogueAssetId: source.asset_id, steps: [{ step: 'catalogue', from: 'original', reason: 'no analyzer configured' }] } };
    }
    const original = await analyzer.describe(bytes, source.content_type);

    if (cutout) {
      try {
        const res = await cutout.cutout(bytes, source.content_type);
        const ct = sniff(res.image).contentType ?? source.content_type;
        const d = await analyzer.describe(res.image, ct);
        const fid = checkFidelity(original, d);
        if (fid.passed) {
          const c = await this.media.ingest({ bytes: res.image, kind: 'cutout', assetClass: source.asset_class, sourceAssetId: source.asset_id, garmentId, link: 'supporting', verified: faithful, fidelity: fid, label: source.label, transformation: { op: 'background_removal', provider: cutout.name, params: {} } });
          steps.push({ step: 'cutout', assetId: c.assetId });
          base = { assetId: c.assetId, bytes: res.image, contentType: ct };
          if (res.mask) {
            const m = await this.media.ingest({ bytes: res.mask, kind: 'mask', assetClass: source.asset_class, sourceAssetId: source.asset_id, label: source.label, transformation: { op: 'mask', provider: cutout.name, params: { cutoutAssetId: c.assetId } } });
            steps.push({ step: 'mask', assetId: m.assetId });
          }
        } else {
          const r = await this.media.recordRejected({ kind: 'cutout', assetClass: source.asset_class, sourceAssetId: source.asset_id, contentType: ct, reason: `Cutout failed the fidelity check: ${fid.checks.filter((c) => !c.passed).map((c) => c.detail).join('; ')}`, fidelity: fid, transformation: { op: 'background_removal', provider: cutout.name, params: {} } });
          steps.push({ step: 'cutout', rejectedAssetId: r.assetId });
        }
      } catch (err) {
        const r = await this.media.recordRejected({ kind: 'cutout', assetClass: source.asset_class, sourceAssetId: source.asset_id, contentType: source.content_type, reason: `Cutout failed: ${err instanceof Error ? err.message : String(err)}`, transformation: { op: 'background_removal', provider: cutout.name, params: {} } });
        steps.push({ step: 'cutout', rejectedAssetId: r.assetId });
      }
    }

    if (original.pose === 'front_flat') {
      // Rotation/cropping/canvas normalization precede any generative editing; source pixels are preserved.
      if (base.contentType === 'image/svg+xml') {
        const cat = await this.media.ingest({ bytes: normalizeSvgCanvas(base.bytes), kind: 'catalogue', assetClass: source.asset_class, sourceAssetId: base.assetId, label: source.label, transformation: { op: 'normalize_canvas', provider: 'garderobe-svg', params: { marginRatio: SVG_MARGIN, background: 'transparent' } } });
        catalogueId = cat.assetId;
      } else {
        catalogueId = base.assetId; // raster canvas normalization needs the image transformer; the cutout serves meanwhile
      }
      steps.push({ step: 'catalogue', assetId: catalogueId, via: 'normalize_canvas' });
    } else if (editor) {
      const constraints = { preserve: ['colour', 'pattern_scale', 'pockets', 'buttons', 'seams', 'silhouette'] as const, target: 'front_flat_catalogue' as const, background: '#FFFFFF' as const };
      let edited: Uint8Array | null = null;
      try {
        edited = (await editor.edit(base.bytes, base.contentType, { ...constraints, preserve: [...constraints.preserve] })).image;
      } catch (err) {
        const r = await this.media.recordRejected({ kind: 'catalogue', assetClass: 'edited_rendition', sourceAssetId: base.assetId, contentType: base.contentType, reason: `The edit failed: ${err instanceof Error ? err.message : String(err)}`, transformation: { op: 'generative_edit', provider: editor.name, params: { constraints } } });
        steps.push({ step: 'edit', rejectedAssetId: r.assetId });
      }
      if (edited) {
        const ct = sniff(edited).contentType ?? base.contentType;
        let d: ImageDescriptor | null = null;
        try {
          d = await analyzer.describe(edited, ct);
        } catch {
          d = null;
        }
        const fid = d ? checkFidelity(original, d) : { passed: false, checks: [{ name: 'garment_identity' as const, passed: false, detail: 'The edited image could not be analysed' }], maxColourDeltaE: null };
        if (fid.passed) {
          const cat = await this.media.ingest({ bytes: edited, kind: 'catalogue', assetClass: 'edited_rendition', sourceAssetId: base.assetId, fidelity: fid, transformation: { op: 'generative_edit', provider: editor.name, params: { constraints } } });
          catalogueId = cat.assetId;
          steps.push({ step: 'edit', assetId: cat.assetId });
        } else {
          // A materially changed result is rejected: nothing is stored as the catalogue image; the honest original serves.
          const r = await this.media.recordRejected({ kind: 'catalogue', assetClass: 'edited_rendition', sourceAssetId: base.assetId, contentType: ct, reason: `The edit changed the garment: ${fid.checks.filter((c) => !c.passed).map((c) => c.detail).join('; ')}`, fidelity: fid, transformation: { op: 'generative_edit', provider: editor.name, params: { constraints } } });
          steps.push({ step: 'edit', rejectedAssetId: r.assetId });
          catalogueId = base.assetId;
        }
      } else catalogueId = base.assetId;
    } else {
      catalogueId = base.assetId;
      steps.push({ step: 'catalogue', assetId: catalogueId, via: 'no editor configured' });
    }
    catalogueVerified = faithful;
    await this.media.setCatalogue(garmentId, catalogueId, catalogueVerified);
    await this.markResolved(garmentId);
    return { status: 'succeeded', result: { catalogueAssetId: catalogueId, steps } };
  }

  private async markResolved(garmentId: string): Promise<void> {
    const prev = await this.statusRow(garmentId);
    await this.writeStatus(garmentId, {
      status: 'resolved', strategies_used: prev?.strategies_used ?? 0, candidate_pages: prev?.candidate_pages ?? 0, browser_sessions: prev?.browser_sessions ?? 0,
      tried_json: prev?.tried_json ?? '[]', review_json: '[]', request_text: null, last_searched_at: prev?.last_searched_at ?? null,
    });
  }

  // ---------------------------------------------------------------- Photos needed and review

  /** Only garments the bounded search could not resolve and that still have no verified image. */
  async photosNeeded(): Promise<PhotosNeeded> {
    requireScope(this.principal, SCOPE_READ);
    const { results } = await this.db
      .prepare(
        `SELECT s.*, g.name FROM garment_photo_status s JOIN garments g ON g.user_id = s.user_id AND g.garment_id = s.garment_id
         WHERE s.user_id = ? AND s.status IN ('photos_needed', 'needs_review') AND g.acquisition <> 'disposed' ORDER BY g.name, g.garment_id`,
      )
      .bind(this.userId)
      .all<StatusRow & { name: string }>();
    const items: PhotosNeeded['items'] = [];
    for (const r of results) {
      if (await this.hasVerifiedCatalogue(r.garment_id)) continue;
      items.push({ garmentId: r.garment_id, name: r.name, request: r.request_text ?? '', lastSearchedAt: r.last_searched_at, strategiesTried: r.strategies_used });
    }
    return { schemaVersion: CONTRACTS_VERSION, items };
  }

  /** Uncertain candidates grouped per garment for one short owner review. */
  async reviewQueue(): Promise<{ garmentId: string; name: string; candidates: { imageUrl: string; pageUrl: string; reasons: string[] }[] }[]> {
    requireScope(this.principal, SCOPE_READ);
    const { results } = await this.db
      .prepare("SELECT s.garment_id, s.review_json, g.name FROM garment_photo_status s JOIN garments g ON g.user_id = s.user_id AND g.garment_id = s.garment_id WHERE s.user_id = ? AND s.status = 'needs_review' ORDER BY g.name")
      .bind(this.userId)
      .all<{ garment_id: string; review_json: string; name: string }>();
    return results.map((r) => ({ garmentId: r.garment_id, name: r.name, candidates: parseJson(r.review_json, []) }));
  }

  /** The owner confirms an uncertain candidate is the garment: adopted with the owner's confirmation as evidence. */
  async acceptReviewCandidate(garmentId: string, imageUrl: string): Promise<MediaAsset> {
    requireScope(this.principal, SCOPE_WRITE);
    const s = await this.statusRow(garmentId);
    const cand = parseJson<{ imageUrl: string; pageUrl: string; reasons: string[] }[]>(s?.review_json, []).find((c) => c.imageUrl === imageUrl);
    if (!cand) throw new DomainError('not_found', 'That candidate is not awaiting review');
    const img = await this.providers.fetcher?.fetchImage(imageUrl);
    if (!img) throw new DomainError('invalid_state', 'The candidate image can no longer be retrieved');
    const asset = await this.media.ingest({
      bytes: img.bytes, kind: 'source', assetClass: 'exact_product_photo', garmentId, link: 'catalogue', verified: true,
      transformation: { op: 'product_image_owner_confirmed', provider: this.providers.fetcher?.name ?? null, params: {} },
      provenance: { sourceUrl: imageUrl, sourcePageUrl: cand.pageUrl, retrievedAt: this.now(), permittedUse: 'Private catalogue use only; publication rights are not assumed', evidence: { ownerConfirmed: true, earlierReasons: cand.reasons } },
    });
    await this.markResolved(garmentId);
    await this.enqueueNormalize(asset.assetId, garmentId);
    return asset;
  }
}

const SVG_MARGIN = 0.08;

/** Expand a trusted SVG's viewBox by a fixed margin on every side (consistent generous margins). */
export function normalizeSvgCanvas(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const vb = /^<svg\b[^>]*?\sviewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(text);
  const s = sniff(bytes);
  if (!vb || !s.width || !s.height) return bytes;
  const [x, y, w, h] = vb.slice(1).map(Number) as [number, number, number, number];
  const mx = Math.round(w * SVG_MARGIN);
  const my = Math.round(h * SVG_MARGIN);
  const W = Math.round(s.width * (1 + 2 * SVG_MARGIN));
  const H = Math.round(s.height * (1 + 2 * SVG_MARGIN));
  const out = text
    .replace(/^(<svg\b[^>]*?\s)viewBox="[^"]*"/, `$1viewBox="${x - mx} ${y - my} ${w + 2 * mx} ${h + 2 * my}"`)
    .replace(/^(<svg\b[^>]*?\s)width="[^"]*"/, `$1width="${W}"`)
    .replace(/^(<svg\b[^>]*?\s)height="[^"]*"/, `$1height="${H}"`);
  return new TextEncoder().encode(out);
}

/** Build a pipeline for a verified owner from Worker bindings. Real providers are not configured by default. */
export function createMediaPipeline(env: Env, userId: string, opts: { providers?: MediaProviders; clock?: () => string; urlBase?: string } = {}): MediaPipeline {
  return new MediaPipeline({
    db: env.DB,
    bucket: env.MEDIA,
    principal: systemPrincipal(userId),
    signingKey: mediaSigningKey(env),
    queue: env.MEDIA_QUEUE as unknown as QueueLike,
    providers: opts.providers ?? {},
    clock: opts.clock,
    urlBase: opts.urlBase,
  });
}

function isMessage(body: unknown): body is MediaQueueMessage {
  const b = body as Partial<MediaQueueMessage> | null;
  return Boolean(b && b.v === 1 && typeof b.userId === 'string' && /^usr_[A-Za-z0-9_-]{4,64}$/.test(b.userId) && typeof b.jobId === 'string' && /^mjb_[a-f0-9]{32}$/.test(b.jobId));
}

/**
 * MEDIA_QUEUE consumer. Each message names an owner and a job; the job row is the source of truth.
 * Malformed messages are dropped; transient failures retry with back-off, then the job is marked failed.
 */
export async function handleMediaQueue(batch: MessageBatch<unknown>, env: Env, opts: { providers?: MediaProviders; clock?: () => string } = {}): Promise<void> {
  for (const msg of batch.messages) {
    if (!isMessage(msg.body)) {
      msg.ack();
      continue;
    }
    const user = await env.DB.prepare("SELECT status FROM users WHERE user_id = ?").bind(msg.body.userId).first<{ status: string }>();
    if (!user || user.status !== 'active') {
      msg.ack();
      continue;
    }
    const pipeline = new MediaPipeline({ db: env.DB, bucket: env.MEDIA, principal: systemPrincipal(msg.body.userId), signingKey: mediaSigningKey(env), queue: null, providers: opts.providers ?? {}, clock: opts.clock });
    try {
      await pipeline.runJob(msg.body.jobId);
      msg.ack();
    } catch (err) {
      if (err instanceof DomainError && err.code === 'not_found') {
        msg.ack(); // another owner's job id, or a deleted job: never retried
      } else if (msg.attempts >= MAX_QUEUE_ATTEMPTS) {
        await pipeline.failJob(msg.body.jobId, err instanceof Error ? err.message : String(err));
        msg.ack();
      } else {
        msg.retry({ delaySeconds: 30 * msg.attempts });
      }
    }
  }
}

export type { MediaAssetRow };
