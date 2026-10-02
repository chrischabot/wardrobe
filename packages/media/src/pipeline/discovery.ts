/**
 * The bounded image investigation for one garment (specification section 11):
 *   1. the purchase source / stored product link, 2. the maker's catalogue then retailers, 3. search by
 *   identifiers; 4. candidates compared with the recorded garment and rejected when they are the wrong
 *   colourway, generation or cut, or only a lookalike; 5. the best VERIFIED image adopted with its source,
 *   retrieval date, content hash and match evidence; 6. otherwise Photos needed, with one sentence.
 *
 * "Try hard" is bounded: three search strategies, twelve candidate pages and two browser sessions per
 * garment, within the owner's daily browser allowance (interactive reserve first). A search that was
 * already made is never repeated. With no usable provider the investigation is DEFERRED, not failed.
 */
import { all, first, getSettings, json, sha256Hex, stableId, systemPrincipalFor, toInstant } from "@garderobe/domain";
import type { CandidateRejectionReason, DiscoveryStrategy } from "@garderobe/contracts/ext/media";
import type { DiscoveryCandidatePage, DiscoveryGarment, DiscoveryProvider, ImageFetcher } from "../adapters.ts";
import type { RecordDiscoveryPayload } from "../commands/discovery.ts";
import { execSystem } from "../exec.ts";
import { decodeImage, probeImage, type Raster } from "../image/index.ts";
import type { JobRow } from "../jobs.ts";
import { originalKey } from "../keys.ts";
import { limitsOf, type MediaRuntime } from "../runtime.ts";
import { isRealGarmentImage, loadAsset, loadGarmentMediaRow, mediaSettings } from "../store.ts";
import { evaluateCandidate, type CandidateEvaluation } from "./evaluate.ts";
import { createPurchaseLinkProvider } from "./purchase-link.ts";
import { compareCandidateWithOwnerPhotos, loadOwnerReferences, type OwnerReferences } from "./owner-photo.ts";
import { createSafeImageFetcher } from "./safe-fetch.ts";

export const STRATEGY_ORDER: DiscoveryStrategy[] = ["purchase_source", "maker_catalogue", "identifier_search"];
const MAX_REVIEW_CANDIDATES = 2;

export async function loadDiscoveryGarment(rt: MediaRuntime, userId: string, garmentId: string): Promise<(DiscoveryGarment & { acquisition: string; removed: boolean }) | null> {
  const g = await first<any>(rt.db, "SELECT garment_id, name, category, maker, product, colour, pattern, fabric, size, acquisition, merged_into, removed_reason, attributes_json FROM garments WHERE user_id = ? AND garment_id = ?", userId, garmentId);
  if (!g) return null;
  const codes = await all<{ phrase: string }>(rt.db, "SELECT phrase FROM garment_aliases WHERE user_id = ? AND garment_id = ? AND kind = 'code' AND removed_at IS NULL ORDER BY phrase", userId, garmentId);
  const link = await first<{ value_json: string }>(rt.db, "SELECT value_json FROM garment_facts WHERE user_id = ? AND garment_id = ? AND attribute = 'purchase_link' AND superseded_by IS NULL ORDER BY recorded_at DESC LIMIT 1", userId, garmentId);
  const attributes = json<Record<string, unknown>>(g.attributes_json, {});
  const purchaseLink = link ? json<unknown>(link.value_json, null) : null;
  return {
    garmentId: g.garment_id, name: g.name, category: g.category, maker: g.maker, product: g.product, colour: g.colour, pattern: g.pattern, fabric: g.fabric, size: g.size,
    codes: codes.map((c) => c.phrase),
    model: typeof attributes.model === "string" ? attributes.model : null,
    cut: typeof attributes.cut === "string" ? attributes.cut : null,
    purchaseLink: typeof purchaseLink === "string" ? purchaseLink : null,
    acquisition: g.acquisition,
    removed: g.merged_into !== null || g.removed_reason !== null,
  };
}

/** The canonical query for a strategy, or null when the garment has nothing to search that way with. */
export function queryTextFor(strategy: DiscoveryStrategy, g: DiscoveryGarment): string | null {
  const join = (...parts: (string | null)[]) => parts.filter((p): p is string => !!p && p.trim() !== "").join(" ").replace(/\s+/g, " ").trim();
  if (strategy === "purchase_source") return g.purchaseLink;
  if (strategy === "maker_catalogue") return g.maker ? join(g.maker, g.product ?? g.name, g.colour) : null;
  return g.codes.length > 0 ? join(g.codes.join(" "), g.maker, g.colour) : g.maker || g.product ? join(g.maker, g.product ?? g.name, g.colour, g.fabric, g.size) : null;
}

/** Browser seconds still usable for backfill today: the daily allowance minus the interactive reserve, plus any unspent paid budget. */
export async function browserSecondsAvailable(rt: MediaRuntime, userId: string): Promise<number> {
  const { settings } = await getSettings(rt.db, await systemPrincipalFor(rt.db, userId, "media:budget", "system"));
  const m = mediaSettings(settings);
  const freePerDay = Math.max(0, m.browserMinutesPerDay - m.interactiveReserveMinutesPerDay) * 60;
  const days = await all<{ day: string; seconds: number }>(rt.db, "SELECT substr(created_at, 1, 10) AS day, SUM(browser_seconds) AS seconds FROM media_discovery_attempts WHERE user_id = ? GROUP BY day", userId);
  const today = toInstant(rt.clock()).slice(0, 10);
  const usedToday = days.find((d) => d.day === today)?.seconds ?? 0;
  const paidUsed = days.reduce((n, d) => n + Math.max(0, d.seconds - freePerDay), 0);
  return Math.max(0, freePerDay - usedToday) + Math.max(0, m.paidBrowserMinutesBudget * 60 - paidUsed);
}

function clip(value: unknown, max = 300): unknown {
  if (typeof value === "string") return value.slice(0, max);
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => clip(v, 120));
  return value ?? null;
}

type Candidate = RecordDiscoveryPayload["candidates"][number];
type Attempt = RecordDiscoveryPayload["attempts"][number];

async function fetchAndCheckImage(rt: MediaRuntime, fetcher: ImageFetcher, url: string): Promise<{ ok: true; bytes: Uint8Array; contentType: string; width: number | null; height: number | null; raster: Raster | null } | { ok: false; reason: CandidateRejectionReason; detail: string }> {
  const limits = limitsOf(rt.deps);
  const fetched = await fetcher.fetchImage(url, { maxBytes: limits.discovery.maxCandidateBytes });
  if (!fetched.ok) return { ok: false, reason: "unsafe_or_unreachable_source", detail: fetched.reason };
  const probe = probeImage(fetched.bytes);
  if (!probe || probe.format === "gif" || probe.format === "avif" || probe.format === "heic") return { ok: false, reason: "not_an_image", detail: "the response is not a JPEG, PNG or WebP image" };
  if (probe.animated) return { ok: false, reason: "image_quality", detail: "animated image" };
  if (probe.width !== null && probe.height !== null) {
    if (Math.min(probe.width, probe.height) < limits.discovery.minCandidateEdge) return { ok: false, reason: "image_quality", detail: `only ${probe.width}x${probe.height} pixels` };
    if (probe.width * probe.height > limits.maxPixels) return { ok: false, reason: "image_quality", detail: "image too large to process" };
    const ratio = probe.width / probe.height;
    if (ratio > 3 || ratio < 1 / 3) return { ok: false, reason: "image_quality", detail: "banner-shaped image, not a product photograph" };
  }
  let raster: Raster | null = null;
  if (probe.format !== "webp") {
    try {
      raster = (await decodeImage(fetched.bytes, { maxPixels: limits.maxPixels })).raster;
    } catch {
      return { ok: false, reason: "image_quality", detail: "the image is corrupt" };
    }
  }
  return { ok: true, bytes: fetched.bytes, contentType: probe.contentType, width: probe.width, height: probe.height, raster };
}

export async function runDiscoveryJob(rt: MediaRuntime, job: JobRow): Promise<void> {
  const userId = job.user_id;
  const limits = limitsOf(rt.deps).discovery;
  const garment = await loadDiscoveryGarment(rt, userId, job.subject_id);
  if (!garment || garment.removed || garment.acquisition === "disposed") {
    await execSystem(rt, userId, "media.complete_job", { jobId: job.job_id, result: { skipped: "the garment is no longer in the collection" } }, `job-done:${job.job_id}`);
    return;
  }
  const record = (body: Pick<RecordDiscoveryPayload, "attempts" | "candidates" | "conclusion" | "note">) =>
    execSystem(rt, userId, "media.record_discovery", { garmentId: garment.garmentId, jobId: job.job_id, ...body }, `discovered:${job.job_id}`);

  const current = await loadGarmentMediaRow(rt.db, userId, garment.garmentId);
  // The owner may ask for a product photo of a garment that so far only has their own photograph.
  let seekingBesideOwnerPhoto = false;
  if (current?.primary_asset_id) {
    const primary = await loadAsset(rt.db, userId, current.primary_asset_id);
    if (primary && primary.status === "active" && isRealGarmentImage(primary.kind, primary.is_demo === 1)) {
      seekingBesideOwnerPhoto = primary.kind === "owner_photo" && json<{ seekProductPhoto?: boolean }>(current.discovery_json, {}).seekProductPhoto === true;
      if (!seekingBesideOwnerPhoto) {
        await record({ attempts: [], candidates: [], conclusion: "already_resolved", note: null });
        return;
      }
    }
  }
  // The owner's own photographs of this garment, loaded once, only when a candidate needs comparing.
  let ownerReferences: OwnerReferences | null = null;

  const prior = await all<{ strategy: string; query_hash: string; pages_examined: number; browser_sessions: number }>(rt.db, "SELECT strategy, query_hash, pages_examined, browser_sessions FROM media_discovery_attempts WHERE user_id = ? AND garment_id = ?", userId, garment.garmentId);
  const tried = new Set(prior.map((p) => p.query_hash));
  let strategiesUsed = prior.length;
  let pagesUsed = prior.reduce((n, p) => n + p.pages_examined, 0);
  let sessionsUsed = prior.reduce((n, p) => n + p.browser_sessions, 0);
  let browserSeconds = await browserSecondsAvailable(rt, userId);

  const providers: DiscoveryProvider[] = [...(rt.deps.discoveryProviders ?? [])];
  if (!providers.some((p) => p.strategies.includes("purchase_source"))) providers.unshift(createPurchaseLinkProvider({ now: rt.clock }));
  const fetcher = rt.deps.imageFetcher ?? createSafeImageFetcher();

  const attempts: Attempt[] = [];
  const candidates: Candidate[] = [];
  const deferrals: string[] = [];
  let adopted = false;
  let reviews = 0;
  let untriedQueries = 0;

  outer: for (const strategy of STRATEGY_ORDER) {
    const text = queryTextFor(strategy, garment);
    if (!text) continue;
    const capable = providers.filter((p) => p.strategies.includes(strategy));
    if (capable.length === 0) {
      deferrals.push(`no provider is configured for ${strategy.replace(/_/g, " ")}`);
      continue;
    }
    for (const provider of capable) {
      if (strategiesUsed >= limits.maxStrategies || pagesUsed >= limits.maxCandidatePages) break outer;
      const queryHash = await sha256Hex(`${strategy}\u001f${provider.name}\u001f${text}`);
      if (tried.has(queryHash)) continue; // never repeat the same unsuccessful search
      untriedQueries++;
      if (provider.usesBrowser && (sessionsUsed >= limits.maxBrowserSessions || browserSeconds <= 0)) {
        deferrals.push(sessionsUsed >= limits.maxBrowserSessions ? "this garment's two browser sessions are used" : "today's browser allowance for backfill is used; interactive browsing is kept in reserve");
        continue;
      }
      tried.add(queryHash);
      const attemptId = await stableId("att", userId, garment.garmentId, queryHash);
      const result = await provider.search({ strategy, garment, text }, { maxPages: limits.maxCandidatePages - pagesUsed, maxBrowserSessions: limits.maxBrowserSessions - sessionsUsed });
      const pages = result.pages.slice(0, limits.maxCandidatePages - pagesUsed);
      strategiesUsed++;
      pagesUsed += pages.length;
      sessionsUsed += result.browserSessions;
      browserSeconds -= result.browserSeconds;
      const attempt: Attempt = {
        attemptId, strategy, queryHash, query: { text: text.slice(0, 500) }, provider: provider.name, pagesExamined: pages.length,
        browserSessions: result.browserSessions, browserSeconds: Math.max(0, Math.round(result.browserSeconds)), outcome: result.error ? "provider_error" : "no_match", detail: result.error?.slice(0, 500) ?? null,
      };
      attempts.push(attempt);

      // Exact-identifier candidates rank first, then the purchase source, the maker, retailers.
      const evaluated: { page: DiscoveryCandidatePage; evaluation: CandidateEvaluation }[] = pages.map((page) => ({ page, evaluation: evaluateCandidate(garment, page) }));
      evaluated.sort((a, b) => a.evaluation.rank - b.evaluation.rank);
      for (const { page, evaluation } of evaluated) {
        const candidateId = await stableId("cnd", userId, garment.garmentId, attemptId, page.pageUrl, page.imageUrl);
        const base: Candidate = {
          candidateId, attemptId, pageUrl: page.pageUrl.slice(0, 2000), imageUrl: page.imageUrl.slice(0, 2000),
          identifiers: Object.fromEntries(Object.entries(page.identifiers ?? {}).map(([k, v]) => [k, clip(v)])), evidence: evaluation.evidence,
          decision: "rejected", rejectionReasons: evaluation.rejectionReasons, reviewQuestion: null, retrievedAt: page.retrievedAt, stored: null,
        };
        if (evaluation.decision === "rejected" || adopted || (evaluation.decision === "needs_review" && reviews >= MAX_REVIEW_CANDIDATES)) {
          if (evaluation.decision !== "rejected") base.rejectionReasons = ["uncertain_lookalike"];
          candidates.push(base);
          continue;
        }
        const image = await fetchAndCheckImage(rt, fetcher, page.imageUrl);
        if (!image.ok) {
          candidates.push({ ...base, rejectionReasons: [image.reason], evidence: { ...evaluation.evidence, imageCheck: image.detail } });
          continue;
        }
        // Compare with the owner's own photograph of the garment where one exists. It can only ever count
        // AGAINST a candidate (reject it, or hand the decision to the owner); it never promotes one.
        ownerReferences ??= await loadOwnerReferences(rt, userId, garment.garmentId);
        const ownerPhoto = compareCandidateWithOwnerPhotos(ownerReferences, image.raster);
        let decision: "eligible" | "needs_review" = evaluation.decision;
        let reviewQuestion = evaluation.reviewQuestion;
        if (ownerPhoto?.compared && (ownerPhoto.verdict === "different_colour" || ownerPhoto.verdict === "different_outline")) {
          const what = ownerPhoto.verdict === "different_colour" ? "colours differ" : "outline differs";
          if (ownerPhoto.verdict === "different_colour" && !evaluation.exactIdentifier) {
            // No exact identifier vouches for it and it is visibly another colourway than the owner's own garment.
            candidates.push({ ...base, rejectionReasons: ["wrong_colourway"], evidence: { ...evaluation.evidence, ownerPhotoComparison: { ...ownerPhoto, effect: "rejected" } } });
            continue;
          }
          if (reviews >= MAX_REVIEW_CANDIDATES) {
            candidates.push({ ...base, rejectionReasons: ["uncertain_lookalike"], evidence: { ...evaluation.evidence, ownerPhotoComparison: { ...ownerPhoto, effect: "rejected" } } });
            continue;
          }
          ownerPhoto.effect = "sent_to_owner_review";
          decision = "needs_review";
          reviewQuestion = `The found photo matches the recorded ${evaluation.exactIdentifier ? "product code" : "maker and product"}, but its ${what} from your own photo of ${garment.name}. Is it the same garment?`;
        }
        const sha256 = await sha256Hex(image.bytes);
        const assetId = await stableId("ast", userId, "candidate", candidateId);
        const objectKey = originalKey(userId, assetId, sha256, image.contentType);
        await rt.deps.bucket.put(objectKey, image.bytes, { httpMetadata: { contentType: image.contentType }, customMetadata: { assetId, sha256, kind: "original" } });
        const stored = {
          assetId, renditionId: await stableId("rnd", userId, assetId, "original"), contentType: image.contentType, width: image.width, height: image.height, byteLength: image.bytes.length, sha256,
          sourceKind: page.sourceClass === "purchase_source" ? ("purchase_source" as const) : page.sourceClass === "maker" ? ("maker_catalogue" as const) : page.sourceClass === "retailer" ? ("retailer" as const) : ("search_result" as const),
        };
        const evidence = { ...evaluation.evidence, ...(ownerPhoto ? { ownerPhotoComparison: ownerPhoto } : {}), imageSha256: sha256, imageSize: [image.width, image.height], adoptionBasis: decision === "eligible" ? "product identity evidence and image-quality checks" : "awaiting the owner's decision" };
        if (decision === "eligible") {
          adopted = true;
          attempt.outcome = "adopted";
          candidates.push({ ...base, decision: "adopted", rejectionReasons: [], evidence, stored });
        } else {
          reviews++;
          if (attempt.outcome !== "adopted") attempt.outcome = "needs_review";
          candidates.push({ ...base, decision: "needs_review", rejectionReasons: [], reviewQuestion, evidence, stored });
        }
      }
      if (adopted) break outer;
    }
  }

  const investigated = prior.length + attempts.length > 0;
  if (adopted) await record({ attempts, candidates, conclusion: "adopted", note: null });
  else if (reviews > 0) await record({ attempts, candidates, conclusion: "needs_review", note: null });
  else if (seekingBesideOwnerPhoto) {
    // Nothing verified was found, and the garment is not short of a picture: the owner's own photo stays.
    await record({ attempts, candidates, conclusion: "already_resolved", note: "no verified product photo was found; the owner's own photo is kept" });
  }
  else if (deferrals.length > 0 && (attempts.length === 0 || strategiesUsed < limits.maxStrategies) && untriedQueries > attempts.length) {
    // Something could still be tried later (a provider or more allowance): not a failed investigation yet.
    await record({ attempts, candidates, conclusion: "deferred", note: [...new Set(deferrals)].join("; ") });
  } else if (!investigated) {
    await record({ attempts, candidates, conclusion: "deferred", note: deferrals.length > 0 ? [...new Set(deferrals)].join("; ") : "there is no purchase link, maker or product code to search with and no search provider is configured" });
  } else {
    await record({ attempts, candidates, conclusion: "photos_needed", note: attempts.length === 0 ? "every available source was already tried" : null });
  }
}
