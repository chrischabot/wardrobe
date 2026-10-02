/** Image discovery commands: requesting the bounded investigation, recording its results, and the owner's review decisions. */
import { z } from "zod";
import { all, CommandError, define, first, json, loadGarment, stableId, stmt, type CommandContext, type CommandDefinition, type PlannedOutbox, type Stmt } from "@garderobe/domain";
import { CandidateRejectionReason, DiscoveryStrategy, MEDIA_COMMANDS as C } from "@garderobe/contracts/ext/media";
import type { MediaSource } from "@garderobe/contracts/ext/media";
import { originalKey } from "../keys.ts";
import { limitsOf, resolveDeps, type MediaDepsSource } from "../runtime.ts";
import { enqueueJob, insertRendition, isRealGarmentImage, loadAsset, loadGarmentMediaRow, upsertGarmentMedia, type AssetRow, type GarmentMediaRow } from "../store.ts";
import { finishJob, photoRequestFor, planAssetRemoval, requireSystemActor, SYSTEM_AUTH } from "./assets.ts";

/** Garments queued per request; the daily maintenance sweep continues the backfill. */
export const DISCOVERY_BATCH = 40;

const StoredImage = z.object({
  assetId: z.string().min(1).max(64),
  renditionId: z.string().min(1).max(64),
  // No storage location: the file lives where `originalKey` puts it for this owner, asset, checksum and type.
  contentType: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  sourceKind: z.enum(["purchase_source", "maker_catalogue", "retailer", "search_result"]),
});

export const RecordDiscovery = z.object({
  garmentId: z.string().min(1).max(64),
  jobId: z.string().min(1).max(64),
  attempts: z
    .array(
      z.object({
        attemptId: z.string().min(1).max(64),
        strategy: DiscoveryStrategy,
        queryHash: z.string().length(64),
        query: z.record(z.string(), z.unknown()),
        provider: z.string().max(120),
        pagesExamined: z.number().int().nonnegative(),
        browserSessions: z.number().int().nonnegative(),
        browserSeconds: z.number().int().nonnegative(),
        outcome: z.enum(["adopted", "needs_review", "no_match", "provider_unavailable", "provider_error", "budget_exhausted"]),
        detail: z.string().max(500).nullable(),
      }),
    )
    .max(12),
  candidates: z
    .array(
      z.object({
        candidateId: z.string().min(1).max(64),
        attemptId: z.string().min(1).max(64),
        pageUrl: z.string().max(2000).nullable(),
        imageUrl: z.string().max(2000).nullable(),
        identifiers: z.record(z.string(), z.unknown()),
        evidence: z.record(z.string(), z.unknown()),
        decision: z.enum(["adopted", "needs_review", "rejected"]),
        rejectionReasons: z.array(CandidateRejectionReason),
        reviewQuestion: z.string().max(400).nullable(),
        retrievedAt: z.string().nullable(),
        stored: StoredImage.nullable(),
      }),
    )
    .max(24),
  /** deferred: nothing could be investigated now (no provider, or today's browser allowance is spent); NOT a failed investigation. */
  conclusion: z.enum(["adopted", "needs_review", "photos_needed", "deferred", "already_resolved"]),
  note: z.string().max(600).nullable(),
});
export type RecordDiscoveryPayload = z.infer<typeof RecordDiscovery>;

interface DiscoveryState {
  rounds?: number;
  lastOutcome?: string;
  lastNote?: string | null;
  lastRunAt?: string;
  /** This round looks for a product photo although the owner's own photograph already shows the garment. */
  seekProductPhoto?: boolean;
}

/** The garment's current image when it is a real one (not a demo placeholder or an illustration), else null. */
async function realPrimary(ctx: CommandContext, row: GarmentMediaRow | null): Promise<AssetRow | null> {
  if (!row?.primary_asset_id) return null;
  const asset = await loadAsset(ctx.db, ctx.userId, row.primary_asset_id);
  return asset && asset.status === "active" && isRealGarmentImage(asset.kind, asset.is_demo === 1) ? asset : null;
}

export function discoveryCommands(depsSource: MediaDepsSource): CommandDefinition<any>[] {
  const maxAttempts = () => limitsOf(resolveDeps(depsSource)).jobMaxAttempts;

  const request = define({
    type: "media.request_discovery",
    schema: C["media.request_discovery"],
    class: "edit",
    requiredScope: "write",
    allowedAuthorizations: ["owner_tap", "owner_statement", "system_schedule", "standing_policy"],
    async plan(ctx, p) {
      // Active garments with high expected use first: normal planning policy, owned, most recorded wears.
      const rows = await all<{ garment_id: string; name: string; planning_policy: string; acquisition: string; wears: number }>(
        ctx.db,
        `SELECT g.garment_id, g.name, g.planning_policy, g.acquisition,
                (SELECT COUNT(*) FROM daily_wears w WHERE w.user_id = g.user_id AND w.garment_id = g.garment_id AND w.status = 'active') AS wears
           FROM garments g WHERE g.user_id = ? AND g.acquisition != 'disposed' AND g.merged_into IS NULL AND g.removed_reason IS NULL
          ORDER BY CASE g.planning_policy WHEN 'normal' THEN 0 WHEN 'occasional' THEN 1 ELSE 2 END, CASE g.acquisition WHEN 'owned' THEN 0 ELSE 1 END, wears DESC, g.name, g.garment_id`,
        ctx.userId,
      );
      const wanted = p.garmentIds.length > 0 ? new Set(p.garmentIds) : null;
      if (wanted) {
        const known = new Set(rows.map((r) => r.garment_id));
        const missing = [...wanted].filter((id) => !known.has(id));
        if (missing.length > 0) throw new CommandError("not_found", `unknown garment${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}; nothing was written`, { missing });
      }
      const media = new Map((await all<GarmentMediaRow>(ctx.db, "SELECT garment_id, image_state, primary_asset_id, photo_request, photos_needed_at, last_failure, discovery_json, version, updated_at FROM garment_media WHERE user_id = ?", ctx.userId)).map((m) => [m.garment_id, m]));
      const statements: Stmt[] = [];
      const outbox: PlannedOutbox[] = [];
      const queued: string[] = [];
      let eligible = 0;
      for (const g of rows) {
        if (wanted && !wanted.has(g.garment_id)) continue;
        const current = media.get(g.garment_id) ?? null;
        const state = current?.image_state ?? "not_started";
        if (state === "searching" || state === "needs_review") continue;
        if (state === "photos_needed" && !p.retry) continue;
        const shown = state === "resolved" ? await realPrimary(ctx, current) : null;
        // A garment with a real image is left alone, unless the owner asked for a product photo of one that
        // so far only has their own photograph (candidates are then compared with that photograph).
        const seek = !!shown && p.seekProductPhoto && shown.kind === "owner_photo";
        if (shown && !seek) continue;
        eligible++;
        if (queued.length >= DISCOVERY_BATCH) continue;
        const discovery = json<DiscoveryState>(current?.discovery_json, {});
        const round = (discovery.rounds ?? 0) + 1;
        const job = enqueueJob(ctx, { jobId: await stableId("job", ctx.userId, "discover", g.garment_id, String(round)), kind: "discover", subjectId: g.garment_id, dedupeKey: `discover:${g.garment_id}:${round}`, maxAttempts: maxAttempts() });
        statements.push(
          ...job.statements,
          // While a product photo is sought the garment keeps showing the owner's photo and stays resolved.
          upsertGarmentMedia(ctx, g.garment_id, current, { imageState: seek ? "resolved" : "searching", primaryAssetId: current?.primary_asset_id ?? null, photoRequest: null, lastFailure: null, discovery: { ...discovery, rounds: round, seekProductPhoto: seek } }),
        );
        outbox.push(...job.outbox);
        queued.push(g.garment_id);
      }
      if (queued.length === 0) return { outcome: "noop", summary: "No garment needs an image search right now", result: { queued: 0, remaining: 0 }, undo: { unavailableReason: "nothing changed" } };
      return {
        summary: `Image search queued for ${queued.length} garment${queued.length === 1 ? "" : "s"}${eligible > queued.length ? ` (${eligible - queued.length} more will follow)` : ""}; recommendations do not wait for it`,
        statements,
        outbox,
        result: { queued: queued.length, remaining: eligible - queued.length, garmentIds: queued },
        undo: { unavailableReason: "a queued search simply runs; delete an unwanted image afterwards" },
      };
    },
  });

  const record = define({
    type: "media.record_discovery",
    schema: RecordDiscovery,
    class: "system",
    requiredScope: "write",
    allowedAuthorizations: SYSTEM_AUTH,
    async plan(ctx, p) {
      requireSystemActor(ctx);
      const garment = await loadGarment(ctx, p.garmentId);
      const current = await loadGarmentMediaRow(ctx.db, ctx.userId, garment.garment_id);
      const statements: Stmt[] = [];
      const outbox: PlannedOutbox[] = [];
      const affected: { kind: string; id: string; version: number }[] = [];
      for (const a of p.attempts) {
        statements.push(
          stmt(
            `INSERT INTO media_discovery_attempts (user_id, attempt_id, garment_id, strategy, query_hash, query_json, provider, pages_examined, browser_sessions, browser_seconds, outcome, detail, command_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ctx.userId, a.attemptId, garment.garment_id, a.strategy, a.queryHash, JSON.stringify(a.query), a.provider, a.pagesExamined, a.browserSessions, a.browserSeconds, a.outcome, a.detail, ctx.commandId, ctx.now,
          ),
        );
      }
      let adoptedAssetId: string | null = null;
      let reviewCount = 0;
      for (const c of p.candidates) {
        if (!p.attempts.some((a) => a.attemptId === c.attemptId)) throw new CommandError("invalid_command", "a candidate must belong to an attempt in the same record");
        // Adoption without an identity basis is refused here too, whatever the pipeline claims.
        if (c.decision === "adopted" && !c.stored) throw new CommandError("invalid_command", "an adopted candidate must have a stored, validated image");
        if (c.decision === "adopted" && adoptedAssetId) throw new CommandError("invalid_command", "only one candidate can be adopted per investigation");
        if (c.stored) {
          const source: MediaSource = { kind: c.stored.sourceKind, imageUrl: c.imageUrl, pageUrl: c.pageUrl, retrievedAt: c.retrievedAt ?? ctx.now, permittedUse: "private_catalogue_only", note: "Found by image discovery; kept in the private catalogue only. Finding it grants no publication right." };
          statements.push(
            stmt(
              `INSERT INTO media_assets (user_id, asset_id, garment_id, kind, is_demo, status, status_reason, source_json, match_evidence_json, had_location_metadata, version, command_id, created_at, updated_at)
               VALUES (?, ?, ?, 'exact_product_photo', 0, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
              ctx.userId, c.stored.assetId, garment.garment_id, c.decision === "adopted" ? "processing" : "needs_review", c.decision === "adopted" ? null : c.reviewQuestion,
              JSON.stringify(source), JSON.stringify(c.evidence), ctx.commandId, ctx.now, ctx.now,
            ),
            insertRendition(ctx, {
              renditionId: c.stored.renditionId, assetId: c.stored.assetId, kind: "original", version: 1, objectKey: originalKey(ctx.userId, c.stored.assetId, c.stored.sha256, c.stored.contentType), contentType: c.stored.contentType,
              width: c.stored.width, height: c.stored.height, byteLength: c.stored.byteLength, sha256: c.stored.sha256, sourceRenditionId: null, transformations: [], edited: false,
            }),
          );
          affected.push({ kind: "media_asset", id: c.stored.assetId, version: 1 });
          if (c.decision === "adopted") {
            adoptedAssetId = c.stored.assetId;
            const job = enqueueJob(ctx, { jobId: await stableId("job", ctx.userId, "normalize", c.stored.assetId, "1"), kind: "normalize", subjectId: c.stored.assetId, dedupeKey: `normalize:${c.stored.assetId}:1`, maxAttempts: maxAttempts() });
            statements.push(...job.statements);
            outbox.push(...job.outbox);
          }
        }
        if (c.decision === "needs_review") reviewCount++;
        statements.push(
          stmt(
            `INSERT INTO media_candidates (user_id, candidate_id, garment_id, attempt_id, page_url, image_url, identifiers_json, evidence_json, decision, rejection_reasons_json, review_question, asset_id, image_sha256, retrieved_at, decided_by, command_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pipeline', ?, ?, ?)`,
            ctx.userId, c.candidateId, garment.garment_id, c.attemptId, c.pageUrl, c.imageUrl, JSON.stringify(c.identifiers), JSON.stringify(c.evidence), c.decision, JSON.stringify(c.rejectionReasons),
            c.reviewQuestion, c.stored?.assetId ?? null, c.stored?.sha256 ?? null, c.retrievedAt, ctx.commandId, ctx.now, ctx.now,
          ),
        );
      }
      if (p.conclusion === "adopted" && !adoptedAssetId) throw new CommandError("invalid_command", "the conclusion says adopted but no candidate was adopted");
      if (p.conclusion === "needs_review" && reviewCount === 0) throw new CommandError("invalid_command", "the conclusion says review is needed but no candidate needs review");

      const discovery = { ...json<DiscoveryState>(current?.discovery_json, {}), lastOutcome: p.conclusion, lastNote: p.note, lastRunAt: ctx.now };
      const keepPrimary = current?.primary_asset_id ?? null;
      const request = photoRequestFor(garment.name, garment.category);
      const patch =
        p.conclusion === "adopted"
          ? { imageState: keepPrimary ? ("resolved" as const) : ("searching" as const), primaryAssetId: keepPrimary, photoRequest: null, lastFailure: null }
          : p.conclusion === "needs_review"
            ? { imageState: "needs_review" as const, primaryAssetId: keepPrimary, photoRequest: null, lastFailure: null }
            : p.conclusion === "photos_needed"
              ? { imageState: "photos_needed" as const, primaryAssetId: keepPrimary, photoRequest: request, lastFailure: null }
              : p.conclusion === "already_resolved"
                ? { imageState: "resolved" as const, primaryAssetId: keepPrimary, photoRequest: null, lastFailure: current?.last_failure ?? null }
                : // deferred: not a failed investigation, so NOT Photos needed. The reason is surfaced.
                  { imageState: keepPrimary ? ("resolved" as const) : ("not_started" as const), primaryAssetId: keepPrimary, photoRequest: null, lastFailure: p.note ?? "the image search could not run yet" };
      if (patch.imageState === "resolved" && !keepPrimary) patch.imageState = "not_started" as never;
      statements.push(upsertGarmentMedia(ctx, garment.garment_id, current, { ...patch, discovery }));
      statements.push(finishJob(ctx, p.jobId, "succeeded", { conclusion: p.conclusion, attempts: p.attempts.length, candidates: p.candidates.length }, null));
      const rejected = p.candidates.filter((c) => c.decision === "rejected").length;
      const summary =
        p.conclusion === "adopted"
          ? `Found a verified product photo of ${garment.name}; preparing its catalogue view`
          : p.conclusion === "needs_review"
            ? `A possible photo of ${garment.name} needs one decision from the owner`
            : p.conclusion === "photos_needed"
              ? `No verified photo of ${garment.name} was found (${p.attempts.length} search${p.attempts.length === 1 ? "" : "es"}, ${rejected} candidate${rejected === 1 ? "" : "s"} rejected); added to Photos needed`
              : p.conclusion === "already_resolved"
                ? `${garment.name} already has a photo`
                : `The image search for ${garment.name} could not run yet: ${p.note ?? "deferred"}`;
      return { summary, statements, outbox, affected, result: { garmentId: garment.garment_id, conclusion: p.conclusion, adoptedAssetId, needsReview: reviewCount, rejected }, undo: { unavailableReason: "delete an unwanted image instead" } };
    },
  });

  const decide = define({
    type: "media.decide_review",
    schema: C["media.decide_review"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      // An image is adopted on the owner's own decision, never an assistant's guess.
      if (ctx.principal.actor !== "owner") throw new CommandError("forbidden", "only the owner can decide whether a found image shows their garment");
      const candidate = await first<{ candidate_id: string; garment_id: string; decision: string; asset_id: string | null }>(ctx.db, "SELECT candidate_id, garment_id, decision, asset_id FROM media_candidates WHERE user_id = ? AND candidate_id = ?", ctx.userId, p.candidateId);
      if (!candidate) throw new CommandError("not_found", "no such review item for this owner; nothing was written");
      if (candidate.decision !== "needs_review") throw new CommandError("precondition_failed", "this review item was already decided");
      const garment = await loadGarment(ctx, candidate.garment_id);
      const current = await loadGarmentMediaRow(ctx.db, ctx.userId, garment.garment_id);
      const asset = candidate.asset_id ? await loadAsset(ctx.db, ctx.userId, candidate.asset_id) : null;
      const others = await all<{ candidate_id: string; asset_id: string | null }>(ctx.db, "SELECT candidate_id, asset_id FROM media_candidates WHERE user_id = ? AND garment_id = ? AND decision = 'needs_review' AND candidate_id != ?", ctx.userId, garment.garment_id, candidate.candidate_id);
      const open = { label: "review item still undecided", sql: "(SELECT decision FROM media_candidates WHERE user_id = ? AND candidate_id = ?) = 'needs_review'", params: [ctx.userId, candidate.candidate_id], class: "state" as const };
      const mark = (id: string, decision: "adopted" | "rejected"): Stmt =>
        stmt("UPDATE media_candidates SET decision = ?, rejection_reasons_json = ?, decided_by = 'owner', updated_at = ? WHERE user_id = ? AND candidate_id = ?", decision, decision === "rejected" ? '["owner_rejected"]' : "[]", ctx.now, ctx.userId, id);
      const removeAssets = async (ids: (string | null)[]) => {
        const rows: AssetRow[] = [];
        for (const id of ids) {
          const a = id ? await loadAsset(ctx.db, ctx.userId, id) : null;
          if (a && a.status !== "deleted") rows.push(a);
        }
        return rows.length > 0 ? planAssetRemoval(ctx, rows, "rejected", "rejected by the owner in review", maxAttempts()) : { statements: [] as Stmt[], outbox: [] as PlannedOutbox[], affected: [] };
      };

      if (p.decision === "adopt") {
        if (!asset || asset.status !== "needs_review") throw new CommandError("precondition_failed", "the image for this review item is no longer available");
        const job = enqueueJob(ctx, { jobId: await stableId("job", ctx.userId, "normalize", asset.asset_id, "1"), kind: "normalize", subjectId: asset.asset_id, dedupeKey: `normalize:${asset.asset_id}:1`, maxAttempts: maxAttempts() });
        const removal = await removeAssets(others.map((o) => o.asset_id));
        const evidence = { ...json<Record<string, unknown>>(asset.match_evidence_json, {}), ownerDecision: { adopted: true, at: ctx.now, channel: ctx.principal.channel } };
        return {
          summary: `The found photo is now used for ${garment.name}; preparing its catalogue view`,
          statements: [
            mark(candidate.candidate_id, "adopted"),
            ...others.map((o) => mark(o.candidate_id, "rejected")),
            stmt("UPDATE media_assets SET status = 'processing', status_reason = NULL, match_evidence_json = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND asset_id = ?", JSON.stringify(evidence), ctx.now, ctx.userId, asset.asset_id),
            ...(removal.statements ?? []),
            upsertGarmentMedia(ctx, garment.garment_id, current, { imageState: "searching", primaryAssetId: current?.primary_asset_id ?? null, photoRequest: null, lastFailure: null }),
            ...job.statements,
          ],
          preconditions: [open],
          outbox: [...job.outbox, ...(removal.outbox ?? [])],
          affected: [{ kind: "media_asset", id: asset.asset_id, version: asset.version + 1 }],
          result: { garmentId: garment.garment_id, assetId: asset.asset_id, decision: "adopt" },
          undo: { unavailableReason: "delete the image instead (media.delete_asset)" },
        };
      }
      const removal = await removeAssets([candidate.asset_id]);
      const stillOpen = others.length > 0;
      return {
        summary: stillOpen ? `That is not ${garment.name}; ${others.length} other possible photo(s) remain to review` : `That is not ${garment.name}; it was added to Photos needed`,
        statements: [
          mark(candidate.candidate_id, "rejected"),
          ...(removal.statements ?? []),
          upsertGarmentMedia(ctx, garment.garment_id, current, {
            imageState: stillOpen ? "needs_review" : current?.primary_asset_id ? "resolved" : "photos_needed",
            primaryAssetId: current?.primary_asset_id ?? null,
            photoRequest: stillOpen || current?.primary_asset_id ? null : photoRequestFor(garment.name, garment.category),
            lastFailure: null,
          }),
        ],
        preconditions: [open],
        outbox: removal.outbox ?? [],
        affected: removal.affected ?? [],
        result: { garmentId: garment.garment_id, decision: "reject" },
        undo: { unavailableReason: "the rejected image was removed; request another search instead" },
      };
    },
  });

  return [request, record, decide];
}
