/** Media reads. Every function requires an authenticated principal and returns only that owner's records. */
import { all, allIn, assertPrincipal, CommandError, first, getSettings, json, requireScope, type Principal } from "@garderobe/domain";
import type { BackfillEstimate, GarmentImageRef, GarmentMedia, MediaAsset, MediaReview, PhotosNeededItem } from "@garderobe/contracts/ext/media";
import { limitsOf, type MediaRuntime } from "./runtime.ts";
import { imageRefFor, loadAsset, loadGarmentMediaRow, loadImageRefs, loadRenditions, mediaSettings, missingImageRef, toAsset, type AssetRow, type FidelityRow, type RenditionRow } from "./store.ts";

function guard(principal: Principal): string {
  assertPrincipal(principal);
  requireScope(principal, "read");
  return principal.userId;
}

const FIDELITY_COLS = "check_id, asset_id, subject, rendition_id, verdict, failed_json, checks_json, algorithm_version, created_at";

export async function getAsset(rt: MediaRuntime, principal: Principal, assetId: string): Promise<MediaAsset> {
  const userId = guard(principal);
  const asset = await loadAsset(rt.db, userId, assetId);
  // A deleted image is gone for every read: its metadata and checksums are not returned either.
  if (!asset || asset.status === "deleted") throw new CommandError("not_found", "no such image for this owner");
  const renditions = await loadRenditions(rt.db, userId, assetId);
  const fidelity = await all<FidelityRow>(rt.db, `SELECT ${FIDELITY_COLS} FROM media_fidelity_checks WHERE user_id = ? AND asset_id = ? ORDER BY created_at, check_id`, userId, assetId);
  return toAsset(asset, renditions, fidelity);
}

/** A garment's image state, its display image (or the honest statement that there is none) and all its assets with provenance. */
export async function getGarmentMedia(rt: MediaRuntime, principal: Principal, garmentId: string): Promise<GarmentMedia> {
  const userId = guard(principal);
  const garment = await first<{ garment_id: string }>(rt.db, "SELECT garment_id FROM garments WHERE user_id = ? AND garment_id = ?", userId, garmentId);
  if (!garment) throw new CommandError("not_found", `no garment '${garmentId}' in this wardrobe`);
  const row = await loadGarmentMediaRow(rt.db, userId, garmentId);
  const assets = await all<AssetRow>(rt.db, "SELECT * FROM media_assets WHERE user_id = ? AND garment_id = ? AND status != 'deleted' ORDER BY created_at, asset_id", userId, garmentId);
  const ids = assets.map((a) => a.asset_id);
  const renditions = await allIn<RenditionRow>(rt.db, "SELECT * FROM media_renditions WHERE user_id = ? AND asset_id IN (:ids) ORDER BY created_at, rendition_id", [userId], ids);
  const fidelity = await allIn<FidelityRow & { asset_id: string }>(rt.db, `SELECT ${FIDELITY_COLS} FROM media_fidelity_checks WHERE user_id = ? AND asset_id IN (:ids) ORDER BY created_at, check_id`, [userId], ids);
  const primary = row?.primary_asset_id ? assets.find((a) => a.asset_id === row.primary_asset_id) ?? null : null;
  return {
    garmentId,
    imageState: row?.image_state ?? "not_started",
    image: primary ? imageRefFor(garmentId, primary, renditions.filter((r) => r.asset_id === primary.asset_id)) : missingImageRef(garmentId),
    photoRequest: row?.photo_request ?? null,
    lastFailure: row?.last_failure ?? null,
    assets: assets.map((a) => toAsset(a, renditions.filter((r) => r.asset_id === a.asset_id), fidelity.filter((f) => f.asset_id === a.asset_id))),
    version: row?.version ?? 0,
  };
}

/** Display image references for many garments at once (grids, boards). Garments without an image get `hasRealImage: false` and a note. */
export async function garmentImageRefs(rt: MediaRuntime, principal: Principal, garmentIds: string[]): Promise<Map<string, GarmentImageRef>> {
  return loadImageRefs(rt.db, guard(principal), garmentIds);
}

/** The small collection of garments research could not resolve, each with the one sentence describing the useful photo. */
export async function listPhotosNeeded(rt: MediaRuntime, principal: Principal): Promise<PhotosNeededItem[]> {
  const userId = guard(principal);
  const rows = await all<{ garment_id: string; name: string; photo_request: string; photos_needed_at: string | null; updated_at: string }>(
    rt.db,
    `SELECT m.garment_id, g.name, m.photo_request, m.photos_needed_at, m.updated_at FROM garment_media m JOIN garments g ON g.user_id = m.user_id AND g.garment_id = m.garment_id
      WHERE m.user_id = ? AND m.image_state = 'photos_needed' AND g.acquisition != 'disposed' AND g.merged_into IS NULL AND g.removed_reason IS NULL ORDER BY m.photos_needed_at, g.name`,
    userId,
  );
  return rows.map((r) => ({ garmentId: r.garment_id, name: r.name, request: r.photo_request, since: r.photos_needed_at ?? r.updated_at }));
}

/** Exceptions needing an owner decision, grouped as one short review (never one interruption per garment). */
export async function listMediaReview(rt: MediaRuntime, principal: Principal): Promise<MediaReview> {
  const userId = guard(principal);
  const rows = await all<{ candidate_id: string; garment_id: string; name: string; asset_id: string | null; page_url: string | null; review_question: string | null; evidence_json: string; created_at: string }>(
    rt.db,
    `SELECT c.candidate_id, c.garment_id, g.name, c.asset_id, c.page_url, c.review_question, c.evidence_json, c.created_at FROM media_candidates c JOIN garments g ON g.user_id = c.user_id AND g.garment_id = c.garment_id
      WHERE c.user_id = ? AND c.decision = 'needs_review' ORDER BY g.name, c.created_at, c.candidate_id`,
    userId,
  );
  return {
    items: rows.map((r) => ({ candidateId: r.candidate_id, garmentId: r.garment_id, garmentName: r.name, assetId: r.asset_id, pageUrl: r.page_url, question: r.review_question ?? `Is this ${r.name}?`, evidence: json(r.evidence_json, {}), createdAt: r.created_at })),
    total: rows.length,
  };
}

/**
 * Backfill progress and an honest completion range. Worst case every unresolved garment needs its full
 * browser allowance (two sessions of about a minute); exact-page fetches need none, so the minimum is
 * lower. Free-tier browsing is not a promise of quick completion, and the estimate says so.
 */
export async function getBackfillEstimate(rt: MediaRuntime, principal: Principal): Promise<BackfillEstimate> {
  const userId = guard(principal);
  const limits = limitsOf(rt.deps);
  const m = mediaSettings((await getSettings(rt.db, principal)).settings);
  const rows = await all<{ image_state: string | null; n: number }>(
    rt.db,
    `SELECT m.image_state AS image_state, COUNT(*) AS n FROM garments g LEFT JOIN garment_media m ON m.user_id = g.user_id AND m.garment_id = g.garment_id
      WHERE g.user_id = ? AND g.acquisition != 'disposed' AND g.merged_into IS NULL AND g.removed_reason IS NULL GROUP BY m.image_state`,
    userId,
  );
  const count = (state: string | null) => rows.filter((r) => r.image_state === state).reduce((n, r) => n + r.n, 0);
  const total = rows.reduce((n, r) => n + r.n, 0);
  const resolved = count("resolved");
  const photosNeeded = count("photos_needed");
  const needsReview = count("needs_review");
  const unresolved = total - resolved - photosNeeded - needsReview;
  const worstCaseMinutes = unresolved * limits.discovery.maxBrowserSessions;
  const backfillPerDay = Math.max(0, m.browserMinutesPerDay - m.interactiveReserveMinutesPerDay);
  const days = (minutesPerDay: number, minutes: number): number | null => (minutes === 0 ? 0 : minutesPerDay <= 0 ? null : Math.ceil(minutes / minutesPerDay));
  const afterPaid = Math.max(0, worstCaseMinutes - m.paidBrowserMinutesBudget);
  // Minimum: nothing held in reserve; maximum: the interactive reserve is kept back every day.
  const estimatedDaysMin = days(m.browserMinutesPerDay, afterPaid);
  const estimatedDaysMax = days(backfillPerDay, afterPaid);
  return {
    totalGarments: total,
    resolved,
    photosNeeded,
    needsReview,
    unresolved,
    browserMinutesPerDay: m.browserMinutesPerDay,
    interactiveReserveMinutesPerDay: m.interactiveReserveMinutesPerDay,
    paidBrowserMinutesBudget: m.paidBrowserMinutesBudget,
    worstCaseBrowserMinutes: worstCaseMinutes,
    estimatedDaysMin,
    estimatedDaysMax,
    note:
      unresolved === 0
        ? "Every garment has been investigated."
        : `Worst case ${worstCaseMinutes} browser minutes for ${unresolved} garment(s) at ${limits.discovery.maxBrowserSessions} one-minute sessions each. Interactive browsing is served first (${m.interactiveReserveMinutesPerDay} min/day reserved). Pages fetched directly need no browser time, so it may finish sooner; the free allowance is not a promise of quick completion.${m.paidBrowserMinutesBudget > 0 ? ` ${m.paidBrowserMinutesBudget} paid browser minutes are approved.` : " A bounded paid browser budget can be approved in settings to finish sooner."}`,
  };
}
