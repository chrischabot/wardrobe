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
import { all, first, getSettings, json, prepare, sha256Hex, stableId, stmt, systemPrincipalFor, toInstant } from "@garderobe/domain";
import type { CandidateRejectionReason, DiscoveryStrategy } from "@garderobe/contracts/ext/media";
import type { DiscoveryCandidatePage, DiscoveryGarment, DiscoveryProvider, DiscoveryProviderResult, ImageFetcher } from "../adapters.ts";
import type { RecordDiscoveryPayload } from "../commands/discovery.ts";
import { execSystem } from "../exec.ts";
import { decodeImage, decodePng, probeImage, withoutLocationForConversion, type Raster } from "../image/index.ts";
import type { JobRow } from "../jobs.ts";
import { originalKey } from "../keys.ts";
import { limitsOf, type MediaRuntime } from "../runtime.ts";
import { isRealGarmentImage, loadAsset, loadGarmentMediaRow, mediaSettings } from "../store.ts";
import { evaluateCandidate, type CandidateEvaluation } from "./evaluate.ts";
import { createPurchaseLinkProvider } from "./purchase-link.ts";
import { compareCandidateWithOwnerPhotos, loadOwnerReferences, type OwnerReferences } from "./owner-photo.ts";
import { createSafeImageFetcher } from "./safe-fetch.ts";

/** A search that failed at its provider is tried again later, at most this many times in all. */
export const MAX_PROVIDER_ATTEMPTS = 3;

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
  if (probe.format === "webp") {
    // This package cannot decode WebP itself. A candidate is adopted only once its pixels were read: through the
    // configured converter, bounded in size; without one a WebP candidate cannot be checked and is not taken.
    if (!rt.deps.transcoder) return { ok: false, reason: "image_quality", detail: "a WebP image cannot be checked without a converter, so it was not taken" };
    // The converter gets the picture without its metadata; one whose metadata cannot be removed is not sent.
    const clean = withoutLocationForConversion(fetched.bytes, limits.discovery.maxCandidateBytes);
    if (!clean.ok) return { ok: false, reason: "image_quality", detail: `the WebP image's metadata could not be removed, so it was not sent to the converter: ${clean.reason}`.slice(0, 300) };
    try {
      const out = await rt.deps.transcoder.toPng({ bytes: clean.bytes, contentType: "image/webp", maxEdge: limits.workingEdge });
      if (!out.ok) return { ok: false, reason: "image_quality", detail: `the WebP image could not be read: ${out.reason}`.slice(0, 300) };
      // The converter's output is a generated file: held to the same size limit before it is decoded.
      if (out.png.length > limits.maxDerivedBytes) return { ok: false, reason: "image_quality", detail: "the converted WebP image is larger than a generated file may be" };
      raster = await decodePng(out.png, { maxPixels: limits.maxPixels });
    } catch {
      return { ok: false, reason: "image_quality", detail: "the image is corrupt" };
    }
  } else {
    try {
      raster = (await decodeImage(fetched.bytes, { maxPixels: limits.maxPixels })).raster;
    } catch {
      return { ok: false, reason: "image_quality", detail: "the image is corrupt" };
    }
  }
  return { ok: true, bytes: fetched.bytes, contentType: probe.contentType, width: probe.width, height: probe.height, raster };
}

/** One browser session is one minute (specification section 11). */
const BROWSER_SECONDS_PER_SESSION = 60;

/** All browser seconds this owner has recorded, read before the allowance so later usage can be counted in the claim itself. */
async function recordedBrowserSeconds(rt: MediaRuntime, userId: string): Promise<number> {
  return (await first<{ s: number }>(rt.db, "SELECT COALESCE(SUM(browser_seconds), 0) AS s FROM media_discovery_attempts WHERE user_id = ?", userId))?.s ?? 0;
}

type SearchClaim =
  | { status: "claimed"; seconds: number }
  | { status: "no_budget" }
  | { status: "busy" }
  /** The search was already made (or interrupted) by a run that stopped before recording it: it is recorded with what it returned, not repeated. */
  | { status: "recovered"; seconds: number; sessions: number; pages: number; storedPages: DiscoveryCandidatePage[]; error: string | null; retryable: boolean };

/** The job attempt that owns a claim: only it settles or releases the claim, and it is taken over only from a stopped owner. */
interface ClaimOwner { jobId: string; attempt: number }

/** A job run's effect gate (see jobs.ts): each claim write below is started through it, so none starts after the run's deadline or once its lease is not confirmed. */
type Gate = <T>(effect: () => Promise<T>) => Promise<T>;
const ungated: Gate = (effect) => effect();

type ClaimRow = { job_id: string; job_attempt: number | null; seconds: number; settled_at: string | null; pages_examined: number | null; browser_sessions: number | null; detail: string | null; retryable: number | null; pages_json: string | null };
const CLAIM_COLUMNS = "job_id, job_attempt, seconds, settled_at, pages_examined, browser_sessions, detail, retryable, pages_json";

/**
 * SQL condition (two parameters: job_id, attempt): the requesting job is running under exactly this attempt.
 * Every claim insert and takeover carries it, so a runner whose attempt was superseded (its lease lapsed and
 * the job was claimed again) can neither make new claims nor take one back from the newer attempt.
 */
const REQUESTER_CURRENT = "EXISTS (SELECT 1 FROM media_jobs WHERE user_id = ? AND job_id = ? AND state = 'running' AND attempts = ?)";

/** SQL (two parameters: user, attempt id): this search has not been recorded yet. A recorded search is never claimed or made again. */
const NOT_YET_RECORDED = "NOT EXISTS (SELECT 1 FROM media_discovery_attempts WHERE user_id = ? AND attempt_id = ?)";

/**
 * SQL (three parameters: user, now, now): browser seconds held by claims whose search is not recorded yet (a recorded
 * one counts from its attempt): every open claim, and every claim made today even once it has expired, since an
 * interrupted search whose job was then abandoned is never recorded, yet its time was spent within today's allowance.
 */
const OPEN_CLAIM_SECONDS = "(SELECT COALESCE(SUM(r.seconds), 0) FROM media_browser_reservations r WHERE r.user_id = ? AND (r.expires_at > ? OR substr(r.created_at, 1, 10) = substr(?, 1, 10)) AND NOT EXISTS (SELECT 1 FROM media_discovery_attempts d WHERE d.user_id = r.user_id AND d.attempt_id = r.attempt_id))";

/**
 * Claim one search durably before it is dispatched. A claim that already exists for this search is resolved
 * first, before any budget check: a stopped owner's claim is taken over and recorded (not repeated), a live
 * owner's makes this search busy. A new browser search also reserves its seconds, atomically across concurrent
 * jobs of the same owner: the insert succeeds only while every open claim, plus the browser time recorded since
 * the allowance was read, plus this reservation fit in that allowance, all evaluated in the insert itself.
 */
async function claimSearch(rt: MediaRuntime, c: { userId: string; owner: ClaimOwner; garmentId: string; queryHash: string; attemptId: string; claimId: string; wanted: number; browser: boolean; sessions: number }, g: Gate = ungated): Promise<SearchClaim> {
  const leaseMs = limitsOf(rt.deps).jobLeaseSeconds * 1000;
  const readClaim = () => first<ClaimRow>(rt.db, `SELECT ${CLAIM_COLUMNS} FROM media_browser_reservations WHERE user_id = ? AND reservation_id = ?`, c.userId, c.claimId);
  const existing = await readClaim();
  if (existing) return resolveExistingClaim(rt, c.userId, c.claimId, c.owner, existing, g);
  const seconds = c.browser ? Math.floor(c.wanted) : 0;
  if (c.browser && seconds <= 0) return { status: "no_budget" };
  // An unsettled claim stays live (and counted) for its whole bounded search: its time allowance plus a lease.
  // The clock is read when the insert starts, after every earlier read (which may have stalled while renewal kept
  // the run alive), so the claim is never written already expired or nearly so, and open claims are counted at that moment.
  const fresh = () => {
    const nowMs = rt.clock();
    return { now: toInstant(nowMs), lapse: toInstant(nowMs + Math.max(2 * leaseMs, seconds * 1000 + leaseMs)) };
  };
  // The browser sessions the search may open are held on the claim until it settles with what it used: a search
  // that stops or fails without saying is charged all of them.
  const sessions = c.browser ? Math.max(0, Math.floor(c.sessions)) : 0;
  let changes = 0;
  if (c.browser) {
    const recordedBefore = await recordedBrowserSeconds(rt, c.userId);
    const available = await browserSecondsAvailable(rt, c.userId);
    const res = await g(() => { const { now, lapse } = fresh(); return prepare(
      rt.db,
      stmt(
        `INSERT INTO media_browser_reservations (user_id, reservation_id, job_id, job_attempt, garment_id, query_hash, attempt_id, seconds, browser_sessions, expires_at, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${OPEN_CLAIM_SECONDS}
              + ((SELECT COALESCE(SUM(browser_seconds), 0) FROM media_discovery_attempts WHERE user_id = ?) - ?)
              + ? <= ?
            AND ${REQUESTER_CURRENT}
            AND ${NOT_YET_RECORDED}
         ON CONFLICT (user_id, reservation_id) DO NOTHING`,
        c.userId, c.claimId, c.owner.jobId, c.owner.attempt, c.garmentId, c.queryHash, c.attemptId, seconds, sessions, lapse, now,
        c.userId, now, now, c.userId, recordedBefore, seconds, available,
        c.userId, c.owner.jobId, c.owner.attempt,
        c.userId, c.attemptId,
      ),
    ).run(); });
    changes = res.meta?.changes ?? 0;
  } else {
    const res = await g(() => { const { now, lapse } = fresh(); return prepare(
      rt.db,
      stmt(
        `INSERT INTO media_browser_reservations (user_id, reservation_id, job_id, job_attempt, garment_id, query_hash, attempt_id, seconds, expires_at, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, ? WHERE ${REQUESTER_CURRENT} AND ${NOT_YET_RECORDED}
         ON CONFLICT (user_id, reservation_id) DO NOTHING`,
        c.userId, c.claimId, c.owner.jobId, c.owner.attempt, c.garmentId, c.queryHash, c.attemptId, lapse, now,
        c.userId, c.owner.jobId, c.owner.attempt,
        c.userId, c.attemptId,
      ),
    ).run(); });
    changes = res.meta?.changes ?? 0;
  }
  if (changes === 1) return { status: "claimed", seconds };
  const raced = await readClaim();
  if (raced) return resolveExistingClaim(rt, c.userId, c.claimId, c.owner, raced, g);
  // No claim was written: this attempt is no longer the job's current one, or the search was recorded meanwhile by
  // another run (it must not search either way), or the allowance did not fit.
  const current = await first<{ n: number }>(rt.db, `SELECT (${REQUESTER_CURRENT}) AND (${NOT_YET_RECORDED}) AS n`, c.userId, c.owner.jobId, c.owner.attempt, c.userId, c.attemptId);
  return (current?.n ?? 0) === 1 ? { status: "no_budget" } : { status: "busy" };
}

/** A claim found for this search: busy while its owner runs; otherwise taken over atomically and recorded, never repeated. */
async function resolveExistingClaim(rt: MediaRuntime, userId: string, claimId: string, owner: ClaimOwner, held: ClaimRow, g: Gate = ungated): Promise<SearchClaim> {
  if (held.job_id === owner.jobId && held.job_attempt === owner.attempt) return { status: "busy" }; // cannot happen: this attempt claims each search once
  // The claim changes hands in one statement, and only if, at that moment: it is still exactly as read; this
  // attempt is its job's current running attempt; and the attempt holding it is not running under a live
  // lease (an earlier attempt of this job is superseded by definition; another job is live while it runs
  // under the same attempt with an unexpired lease, since it may still be processing candidates).
  // The row returned is the one taken over, as it stood at that moment (the earlier owner may have settled it since it was read).
  const took = await g(() => prepare(
    rt.db,
    stmt(
      `UPDATE media_browser_reservations SET job_id = ?, job_attempt = ?
        WHERE user_id = ? AND reservation_id = ? AND job_id = ? AND job_attempt IS ?
          AND ${REQUESTER_CURRENT}
          AND NOT EXISTS (SELECT 1 FROM media_jobs WHERE user_id = ? AND job_id = ? AND state = 'running' AND attempts IS ? AND lease_until > ?)
        RETURNING ${CLAIM_COLUMNS}`,
      owner.jobId, owner.attempt, userId, claimId, held.job_id, held.job_attempt,
      userId, owner.jobId, owner.attempt,
      userId, held.job_id, held.job_attempt, toInstant(rt.clock()),
    ),
  ).first<ClaimRow>());
  if (!took) return { status: "busy" };
  if (took.settled_at) {
    // The search completed (or failed) and was settled with what it returned: recorded from that, not searched again.
    const storedPages = json<DiscoveryCandidatePage[]>(took.pages_json, []);
    return {
      status: "recovered", seconds: took.seconds, sessions: took.browser_sessions ?? 0, pages: took.pages_examined ?? storedPages.length, storedPages,
      error: took.detail, retryable: took.detail !== null && took.retryable !== 0,
    };
  }
  // It stopped during the search: recorded as interrupted, with its reserved seconds and sessions counted as spent.
  const reservedSessions = took.browser_sessions ?? 0;
  await settleClaim(rt, userId, claimId, owner, { seconds: took.seconds, sessions: reservedSessions, pages: [], examined: 0, detail: "the search was interrupted when its run stopped", retryable: true }, g);
  return { status: "recovered", seconds: took.seconds, sessions: reservedSessions, pages: 0, storedPages: [], retryable: true, error: "the search was interrupted when its run stopped; it is tried again later" };
}

/** Record at once what a search used and returned, so neither the time, the search nor its results are lost if the job stops before recording its attempts. Only the claim's owner settles it. */
async function settleClaim(rt: MediaRuntime, userId: string, claimId: string, owner: ClaimOwner, used: { seconds: number; sessions: number; pages: DiscoveryCandidatePage[]; examined: number; detail: string | null; retryable: boolean }, g: Gate = ungated): Promise<void> {
  const nowMs = rt.clock();
  // Kept (and counted against the allowance) until the attempt is recorded; two days covers any retry of the job.
  await g(() => prepare(
    rt.db,
    stmt("UPDATE media_browser_reservations SET settled_at = ?, seconds = ?, browser_sessions = ?, pages_examined = ?, pages_json = ?, detail = ?, retryable = ?, expires_at = ? WHERE user_id = ? AND reservation_id = ? AND job_id = ? AND job_attempt = ?",
      toInstant(nowMs), Math.max(0, Math.round(used.seconds)), used.sessions, used.examined, JSON.stringify(used.pages), used.detail?.slice(0, 300) ?? null, used.retryable ? 1 : 0, toInstant(nowMs + 2 * 86_400_000), userId, claimId, owner.jobId, owner.attempt),
  ).run());
}

/** Seconds held by open claims of this owner (in flight, or spent and not yet recorded). */
async function reservedOpen(rt: MediaRuntime, userId: string): Promise<number> {
  const now = toInstant(rt.clock());
  const row = await first<{ s: number }>(rt.db, `SELECT ${OPEN_CLAIM_SECONDS} AS s`, userId, now, now);
  return row?.s ?? 0;
}

/** Run a browser search within its time allowance: past it, the search is abandoned and reported as stopped. */
async function searchWithin(provider: DiscoveryProvider, query: Parameters<DiscoveryProvider["search"]>[0], budget: Parameters<DiscoveryProvider["search"]>[1]): Promise<DiscoveryProviderResult> {
  const allowance = budget.maxBrowserSeconds;
  if (!provider.usesBrowser || allowance === undefined) return provider.search(query, budget);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<DiscoveryProviderResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ pages: [], browserSessions: budget.maxBrowserSessions, browserSeconds: allowance, error: "the browser search ran past its time allowance and was stopped" });
    }, allowance * 1000);
  });
  try {
    return await Promise.race([provider.search(query, { ...budget, signal: controller.signal }), stopped]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runDiscoveryJob(rt: MediaRuntime, job: JobRow): Promise<void> {
  const userId = job.user_id;
  const limits = limitsOf(rt.deps).discovery;
  const garment = await loadDiscoveryGarment(rt, userId, job.subject_id);
  if (!garment || garment.removed || garment.acquisition === "disposed") {
    await execSystem(rt, userId, "media.complete_job", { jobId: job.job_id, attempt: job.attempts, result: { skipped: "the garment is no longer in the collection" } }, `job-done:${job.job_id}:${job.attempts}`);
    return;
  }
  const record = (body: Pick<RecordDiscoveryPayload, "attempts" | "candidates" | "conclusion" | "note">) =>
    execSystem(rt, userId, "media.record_discovery", { garmentId: garment.garmentId, jobId: job.job_id, attempt: job.attempts, ...body }, `discovered:${job.job_id}:${job.attempts}`);

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

  // Within a job run, the claim writes below go through the run's gate, and each search or candidate fetch is
  // started only while the run is live: after its deadline or a lost lease nothing more is claimed, settled,
  // released or searched (a claim left open is recovered by the next run as interrupted).
  const gate = rt.gate ?? (<T>(effect: () => Promise<T>) => effect());
  const admit = rt.admit ?? (() => undefined);
  const prior = await all<{ attempt_id: string; strategy: string; query_hash: string; query_json: string; pages_examined: number; browser_sessions: number; outcome: string }>(rt.db, "SELECT attempt_id, strategy, query_hash, query_json, pages_examined, browser_sessions, outcome FROM media_discovery_attempts WHERE user_id = ? AND garment_id = ?", userId, garment.garmentId);
  // A retried search is recorded under its own hash (the ledger never holds the same search twice for a garment),
  // naming the search it retries; it is counted against that search.
  const searchOf = (p: { query_hash: string; query_json: string }): string => {
    const base = json<{ retryOf?: unknown }>(p.query_json, {}).retryOf;
    return typeof base === "string" && /^[0-9a-f]{64}$/.test(base) ? base : p.query_hash;
  };
  // Claims whose attempts a stopped run did record are released.
  await gate(() => prepare(rt.db, stmt("DELETE FROM media_browser_reservations WHERE user_id = ? AND garment_id = ? AND attempt_id IN (SELECT attempt_id FROM media_discovery_attempts WHERE user_id = ? AND garment_id = ?)", userId, garment.garmentId, userId, garment.garmentId)).run());
  // A search that could not be completed because its provider was unavailable (recorded as provider_unavailable)
  // was not a completed search: it is tried again, at most MAX_PROVIDER_ATTEMPTS times in all, and does not use
  // up one of the garment's strategies. A final failure is recorded as provider_error and counts as tried.
  const providerErrors = new Map<string, number>();
  for (const p of prior) if (p.outcome === "provider_unavailable") providerErrors.set(searchOf(p), (providerErrors.get(searchOf(p)) ?? 0) + 1);
  const tried = new Set(prior.filter((p) => p.outcome !== "provider_unavailable").map(searchOf));
  let strategiesUsed = prior.filter((p) => p.outcome !== "provider_unavailable").length;
  let pagesUsed = prior.reduce((n, p) => n + p.pages_examined, 0);
  let sessionsUsed = prior.reduce((n, p) => n + p.browser_sessions, 0);
  let browserSeconds = Math.max(0, (await browserSecondsAvailable(rt, userId)) - (await reservedOpen(rt, userId)));

  const providers: DiscoveryProvider[] = [...(rt.deps.discoveryProviders ?? [])];
  if (!providers.some((p) => p.strategies.includes("purchase_source"))) providers.unshift(createPurchaseLinkProvider({ now: rt.clock }));
  const fetcher = rt.deps.imageFetcher ?? createSafeImageFetcher();

  const attempts: Attempt[] = [];
  const candidates: Candidate[] = [];
  const deferrals: string[] = [];
  let adopted = false;
  let reviews = 0;
  let untriedQueries = 0;
  let retryableErrors = 0;
  /** Claims this run made or recovered, released once their attempts are recorded. */
  const claims: string[] = [];
  const claimOwner: ClaimOwner = { jobId: job.job_id, attempt: job.attempts };

  outer: for (const strategy of STRATEGY_ORDER) {
    const text = queryTextFor(strategy, garment);
    if (!text) continue;
    const capable = providers.filter((p) => p.strategies.includes(strategy));
    if (capable.length === 0) {
      // A search this garment could have, that no configured provider can make yet: work still outstanding,
      // so the investigation is deferred rather than concluded.
      untriedQueries++;
      deferrals.push(`no provider is configured for ${strategy.replace(/_/g, " ")}`);
      continue;
    }
    for (const provider of capable) {
      if (strategiesUsed >= limits.maxStrategies || pagesUsed >= limits.maxCandidatePages) break outer;
      const queryHash = await sha256Hex(`${strategy}\u001f${provider.name}\u001f${text}`);
      if (tried.has(queryHash)) continue; // never repeat the same unsuccessful search
      untriedQueries++;
      const retry = providerErrors.get(queryHash) ?? 0;
      const claimId = `${garment.garmentId}:${queryHash.slice(0, 32)}:${retry}`;
      // A claim a stopped run left for this search is recovered whatever the allowance now shows: its own reservation
      // may be what used the allowance up, and its results or usage must be recorded, not skipped.
      const heldClaim = await first<{ n: number }>(rt.db, "SELECT 1 AS n FROM media_browser_reservations WHERE user_id = ? AND reservation_id = ?", userId, claimId);
      if (!heldClaim && provider.usesBrowser && sessionsUsed >= limits.maxBrowserSessions) {
        // The garment's browser sessions are used for good (they never come back): this search can never be made, so
        // it is not outstanding work that keeps the investigation deferred.
        untriedQueries--;
        continue;
      }
      if (!heldClaim && provider.usesBrowser && browserSeconds <= 0) {
        deferrals.push("today's browser allowance for backfill is used; interactive browsing is kept in reserve");
        continue;
      }
      tried.add(queryHash);
      const attemptId = retry === 0 ? await stableId("att", userId, garment.garmentId, queryHash) : await stableId("att", userId, garment.garmentId, queryHash, `retry-${retry}`);
      const budget: Parameters<DiscoveryProvider["search"]>[1] = { maxPages: limits.maxCandidatePages - pagesUsed, maxBrowserSessions: limits.maxBrowserSessions - sessionsUsed };
      // Claimed durably first (browser searches also reserve their seconds), so concurrent jobs cannot each spend
      // the same allowance and a run that stops after the search neither loses its usage nor repeats it.
      const claim = await gate(() => claimSearch(rt, { userId, owner: claimOwner, garmentId: garment.garmentId, queryHash, attemptId, claimId, wanted: Math.min(browserSeconds, budget.maxBrowserSessions * BROWSER_SECONDS_PER_SESSION), browser: provider.usesBrowser, sessions: budget.maxBrowserSessions }, gate));
      if (claim.status === "no_budget" || claim.status === "busy") {
        tried.delete(queryHash);
        deferrals.push(claim.status === "busy" ? "another run is making this search now" : "today's browser allowance for backfill is used; interactive browsing is kept in reserve");
        continue;
      }
      claims.push(claimId);
      let result: DiscoveryProviderResult;
      /** Pages a stopped run's search already examined: counted against the garment's page allowance though their results were not kept. */
      let recoveredPages = 0;
      if (claim.status === "recovered") {
        const storedPages = claim.storedPages.slice(0, limits.maxCandidatePages - pagesUsed);
        result = { pages: storedPages, browserSessions: claim.sessions, browserSeconds: claim.seconds, ...(claim.error ? { error: claim.error, retryable: claim.retryable } : {}) };
        // Pages it examined that it did not return (a failed search) still count against the garment's page allowance.
        recoveredPages = Math.max(0, Math.min(claim.pages - storedPages.length, limits.maxCandidatePages - pagesUsed - storedPages.length));
      } else {
        if (provider.usesBrowser) budget.maxBrowserSeconds = claim.seconds;
        admit();
        try {
          result = await searchWithin(provider, { strategy, garment, text }, budget);
        } catch (e) {
          // A provider that throws spent what it reserved, as far as anyone can tell: every reserved second and session.
          result = { pages: [], browserSessions: provider.usesBrowser ? budget.maxBrowserSessions : 0, browserSeconds: claim.seconds, error: `the search failed: ${String((e as Error)?.message ?? e)}`.slice(0, 300) };
        }
        const returned = result.pages.slice(0, limits.maxCandidatePages - pagesUsed);
        await settleClaim(rt, userId, claimId, claimOwner, { seconds: result.browserSeconds, sessions: result.browserSessions, pages: returned, examined: returned.length, detail: result.error ?? null, retryable: !!result.error && result.retryable !== false }, gate);
      }
      const pages = result.pages.slice(0, limits.maxCandidatePages - pagesUsed);
      // A failed search is tried again later only if it can be: within its provider attempts and, for a browser
      // search, while the garment still has a browser session left (a failure charged with the last ones is final).
      const retryLater = !!result.error && result.retryable !== false && retry + 1 < MAX_PROVIDER_ATTEMPTS
        && !(provider.usesBrowser && sessionsUsed + result.browserSessions >= limits.maxBrowserSessions);
      if (!retryLater) strategiesUsed++;
      else {
        // Not a completed search: tried again later instead of being counted as investigated.
        retryableErrors++;
        deferrals.push(`the ${strategy.replace(/_/g, " ")} search could not be completed (${result.error!.slice(0, 120)}); it is tried again later`);
      }
      pagesUsed += pages.length + recoveredPages;
      sessionsUsed += result.browserSessions;
      browserSeconds -= result.browserSeconds;
      const attempt: Attempt = {
        attemptId, strategy, queryHash: retry === 0 ? queryHash : await sha256Hex(`${queryHash}\u001fretry-${retry}`), query: { text: text.slice(0, 500), ...(retry === 0 ? {} : { retryOf: queryHash, retry }) }, provider: provider.name, pagesExamined: pages.length + recoveredPages,
        browserSessions: result.browserSessions, browserSeconds: Math.max(0, Math.round(result.browserSeconds)), outcome: result.error ? (retryLater ? "provider_unavailable" : "provider_error") : "no_match", detail: result.error?.slice(0, 500) ?? null,
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
        admit();
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
  await conclude(investigated);
  // The attempts, with the browser time they actually used, are recorded: their claims are released.
  for (const id of claims) await gate(() => prepare(rt.db, stmt("DELETE FROM media_browser_reservations WHERE user_id = ? AND reservation_id = ? AND job_id = ? AND job_attempt = ?", userId, id, claimOwner.jobId, claimOwner.attempt)).run());

  async function conclude(investigated: boolean): Promise<void> {
  if (adopted) await record({ attempts, candidates, conclusion: "adopted", note: null });
  else if (reviews > 0) await record({ attempts, candidates, conclusion: "needs_review", note: null });
  else if (seekingBesideOwnerPhoto) {
    // Nothing verified was found, and the garment is not short of a picture: the owner's own photo stays.
    await record({ attempts, candidates, conclusion: "already_resolved", note: "no verified product photo was found; the owner's own photo is kept" });
  }
  else if (retryableErrors > 0 || (deferrals.length > 0 && (attempts.length === 0 || strategiesUsed < limits.maxStrategies) && untriedQueries > attempts.length)) {
    // Something could still be tried later (a provider, a search that failed at its provider, or more
    // allowance): not a failed investigation yet.
    await record({ attempts, candidates, conclusion: "deferred", note: [...new Set(deferrals)].join("; ") });
  } else if (!investigated) {
    await record({ attempts, candidates, conclusion: "deferred", note: deferrals.length > 0 ? [...new Set(deferrals)].join("; ") : "there is no purchase link, maker or product code to search with and no search provider is configured" });
  } else {
    await record({ attempts, candidates, conclusion: "photos_needed", note: attempts.length === 0 ? "every available source was already tried" : null });
  }
  }
}
