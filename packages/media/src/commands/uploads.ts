/**
 * Uploads: short-lived authorization, bytes into a staging key, then an explicit finalization step.
 * Nothing in staging is evidence: an asset exists only after `media.finalize_upload` validated the bytes.
 */
import { z } from "zod";
import { CommandError, define, first, loadGarment, sha256Hex, stableId, stmt, toInstant, parseInstant, type CommandContext, type CommandDefinition, type Stmt } from "@garderobe/domain";
import { MEDIA_COMMANDS as C } from "@garderobe/contracts/ext/media";
import type { MediaAssetKind, MediaSource } from "@garderobe/contracts/ext/media";
import { probeImage } from "../image/index.ts";
import { assertOwnedKey, originalKey, stagingKey } from "../keys.ts";
import { limitsOf, resolveDeps, type MediaDepsSource } from "../runtime.ts";
import { enqueueJob, insertRendition, loadGarmentMediaRow, mediaSettings, upsertGarmentMedia } from "../store.ts";

export interface UploadRow {
  upload_id: string;
  intent: "garment_photo" | "selfie" | "attachment";
  garment_id: string | null;
  content_type: string;
  declared_bytes: number;
  max_bytes: number;
  wearing_date: string | null;
  is_demo: number;
  origin: "owner_upload" | "drive_import" | "image_model";
  origin_ref: string | null;
  state: "authorized" | "finalized" | "rejected";
  rejection_reason: string | null;
  asset_id: string | null;
  expires_at: string;
}

export const UPLOAD_COLUMNS = "upload_id, intent, garment_id, content_type, declared_bytes, max_bytes, wearing_date, is_demo, origin, origin_ref, state, rejection_reason, asset_id, expires_at";

/** Finalization is accepted for this long after the byte-upload window closed. */
export const FINALIZE_GRACE_MS = 60 * 60 * 1000;

export async function loadUpload(ctx: Pick<CommandContext, "db" | "userId">, uploadId: string): Promise<UploadRow | null> {
  return first<UploadRow>(ctx.db, `SELECT ${UPLOAD_COLUMNS} FROM media_uploads WHERE user_id = ? AND upload_id = ?`, ctx.userId, uploadId);
}

function assetKindFor(upload: Pick<UploadRow, "intent" | "origin">): MediaAssetKind {
  if (upload.intent === "selfie") return "selfie";
  if (upload.intent === "attachment") return "attachment";
  return upload.origin === "image_model" ? "generic_illustration" : "owner_photo";
}

function sourceFor(upload: UploadRow, now: string): MediaSource {
  if (upload.is_demo === 1) return { kind: "demo_fixture", imageUrl: null, pageUrl: null, retrievedAt: now, permittedUse: "demo_only", note: "Labelled demo/test placeholder; not the owner's garment." };
  if (upload.origin === "drive_import") return { kind: "drive_import", imageUrl: null, pageUrl: null, retrievedAt: now, permittedUse: "owner_owned", note: upload.origin_ref };
  if (upload.origin === "image_model") return { kind: "image_model", imageUrl: null, pageUrl: null, retrievedAt: now, permittedUse: "private_catalogue_only", note: upload.origin_ref };
  return { kind: "owner_upload", imageUrl: null, pageUrl: null, retrievedAt: now, permittedUse: "owner_owned", note: null };
}

export function uploadCommands(depsSource: MediaDepsSource): CommandDefinition<any>[] {
  const authorize = define({
    type: "media.authorize_upload",
    schema: C["media.authorize_upload"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      const limits = limitsOf(resolveDeps(depsSource));
      if (p.byteLength > limits.maxUploadBytes) {
        throw new CommandError("invalid_command", `an upload may be at most ${limits.maxUploadBytes} bytes; resize the image on the device first`, { maxBytes: limits.maxUploadBytes });
      }
      if (p.intent === "garment_photo" && !p.garmentId) throw new CommandError("invalid_command", "a garment photo must name the garment it shows");
      if (p.intent !== "garment_photo" && p.garmentId) throw new CommandError("invalid_command", "only a garment photo is attached to a garment; a selfie or attachment never is");
      if (p.origin === "image_model" && p.intent !== "garment_photo") throw new CommandError("invalid_command", "an illustration is always for one garment");
      if (p.demo && p.intent !== "garment_photo") throw new CommandError("invalid_command", "a demo placeholder is always for one synthetic garment");
      let garmentName: string | null = null;
      if (p.garmentId) {
        const g = await loadGarment(ctx, p.garmentId);
        garmentName = g.name;
        const synthetic = await first<{ is_synthetic: number }>(ctx.db, "SELECT is_synthetic FROM garments WHERE user_id = ? AND garment_id = ?", ctx.userId, g.garment_id);
        // Placeholders are allowed only as demo/test assets and never on the owner's real garments.
        if (p.demo && synthetic?.is_synthetic !== 1) {
          throw new CommandError("forbidden", "a demo placeholder can only be attached to a synthetic fixture garment, never to a real garment", { garmentId: g.garment_id });
        }
      }
      const uploadId = p.uploadId ?? ctx.newId("upl");
      if (!/^[A-Za-z0-9_-]+$/.test(uploadId)) throw new CommandError("invalid_command", "invalid upload id");
      const expiresAt = toInstant(ctx.nowMs + limits.uploadTtlSeconds * 1000);
      return {
        summary: `Upload authorized${garmentName ? ` for ${garmentName}` : ""} (${p.byteLength} bytes, until ${expiresAt}); nothing is stored until it is finalized`,
        statements: [
          stmt(
            `INSERT INTO media_uploads (user_id, upload_id, intent, garment_id, content_type, declared_bytes, max_bytes, wearing_date, is_demo, origin, origin_ref, state, expires_at, command_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?, ?, ?)`,
            ctx.userId, uploadId, p.intent, p.garmentId, p.contentType, p.byteLength, p.byteLength, p.wearingDate, p.demo, p.origin, p.originRef, expiresAt, ctx.commandId, ctx.now, ctx.now,
          ),
        ],
        preconditions: [{ label: `upload ${uploadId} does not exist yet`, sql: "NOT EXISTS (SELECT 1 FROM media_uploads WHERE user_id = ? AND upload_id = ?)", params: [ctx.userId, uploadId], class: "state" }],
        affected: [{ kind: "media_upload", id: uploadId, version: 1 }],
        result: { uploadId, maxBytes: p.byteLength, contentType: p.contentType, expiresAt },
        undo: { unavailableReason: "an unused upload authorization simply expires" },
      };
    },
  });

  const finalize = define({
    type: "media.finalize_upload",
    schema: C["media.finalize_upload"],
    class: "edit",
    requiredScope: "write",
    async plan(ctx, p) {
      const deps = resolveDeps(depsSource);
      const limits = limitsOf(deps);
      const upload = await loadUpload(ctx, p.uploadId);
      // Another owner's upload is indistinguishable from one that does not exist.
      if (!upload) throw new CommandError("not_found", "no such upload for this owner; nothing was written");
      if (upload.state === "finalized") {
        return { outcome: "noop", summary: "This upload was already finalized", result: { uploadId: upload.upload_id, finalized: true, assetId: upload.asset_id }, undo: { unavailableReason: "nothing changed" } };
      }
      if (upload.state === "rejected") {
        return { outcome: "noop", summary: `This upload was rejected: ${upload.rejection_reason}`, result: { uploadId: upload.upload_id, finalized: false, rejectionReason: upload.rejection_reason }, undo: { unavailableReason: "nothing changed" } };
      }
      const key = stagingKey(ctx.userId, upload.upload_id);
      assertOwnedKey(ctx.userId, key);
      const stillOpen = { label: "upload still awaiting finalization", sql: "(SELECT state FROM media_uploads WHERE user_id = ? AND upload_id = ?) = 'authorized'", params: [ctx.userId, upload.upload_id], class: "state" as const };

      const reject = async (reason: string) => {
        await deps.bucket.delete(key);
        return {
          summary: `Upload rejected: ${reason}. Nothing was added to the wardrobe`,
          statements: [stmt("UPDATE media_uploads SET state = 'rejected', rejection_reason = ?, updated_at = ? WHERE user_id = ? AND upload_id = ?", reason, ctx.now, ctx.userId, upload.upload_id)],
          preconditions: [stillOpen],
          affected: [{ kind: "media_upload", id: upload.upload_id, version: 2 }],
          result: { uploadId: upload.upload_id, finalized: false, rejectionReason: reason },
          undo: { unavailableReason: "authorize a new upload instead" },
        };
      };

      if (ctx.nowMs > parseInstant(upload.expires_at) + FINALIZE_GRACE_MS) return reject("the upload authorization expired before finalization");
      const object = await deps.bucket.get(key);
      if (!object) throw new CommandError("precondition_failed", "no bytes have been received for this upload yet; nothing was written", { uploadId: upload.upload_id });
      if (object.size > upload.max_bytes) return reject(`${object.size} bytes were received but only ${upload.max_bytes} were authorized`);
      const bytes = new Uint8Array(await object.arrayBuffer());

      // Content validation: what the bytes ARE, never what the client said they were.
      const probe = probeImage(bytes);
      if (!probe) return reject("the file is not a recognised image");
      if (probe.contentType !== upload.content_type) return reject(`the file is ${probe.contentType} but ${upload.content_type} was declared`);
      if (probe.animated) return reject("animated images are not accepted");
      if (probe.width !== null && probe.height !== null) {
        if (probe.width < limits.minDimension || probe.height < limits.minDimension) return reject(`the image is only ${probe.width}x${probe.height} pixels`);
        if (probe.width > limits.maxDimension || probe.height > limits.maxDimension || probe.width * probe.height > limits.maxPixels) {
          return reject(`the image is ${probe.width}x${probe.height} pixels, above the accepted size; resize it on the device first`);
        }
      }

      const sha256 = await sha256Hex(bytes);
      const assetId = await stableId("ast", ctx.userId, upload.upload_id);
      const renditionId = await stableId("rnd", ctx.userId, assetId, "original");
      const objectKey = originalKey(ctx.userId, assetId, sha256, probe.contentType);
      // The immutable original. Written before the ledger commit; the key is deterministic, so a re-plan overwrites identical bytes.
      await deps.bucket.put(objectKey, bytes, { httpMetadata: { contentType: probe.contentType }, customMetadata: { assetId, sha256, kind: "original" } });

      const kind = assetKindFor(upload);
      const settings = mediaSettings(ctx.settings);
      const retainUntil = kind === "selfie" && settings.selfieOriginalRetentionDays !== null ? toInstant(ctx.nowMs + settings.selfieOriginalRetentionDays * 86_400_000) : null;
      const statements: Stmt[] = [
        stmt(
          `INSERT INTO media_assets (user_id, asset_id, garment_id, kind, is_demo, status, status_reason, source_json, match_evidence_json, had_location_metadata, wearing_date, retain_original_until, upload_id, version, command_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'processing', NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          ctx.userId, assetId, upload.garment_id, kind, upload.is_demo, JSON.stringify(sourceFor(upload, ctx.now)),
          JSON.stringify(
            upload.is_demo === 1
              ? { basis: "demo_fixture", note: "placeholder on a synthetic garment" }
              : kind === "generic_illustration"
                ? { basis: "illustration_from_description", note: "not a photograph of the garment" }
                : upload.garment_id
                  ? { basis: "owner_statement", note: "the owner supplied this photograph for this garment", channel: ctx.principal.channel }
                  : {},
          ),
          probe.exif.hasGps, upload.wearing_date, retainUntil, upload.upload_id, ctx.commandId, ctx.now, ctx.now,
        ),
        insertRendition(ctx, {
          renditionId, assetId, kind: "original", version: 1, objectKey, contentType: probe.contentType, width: probe.width, height: probe.height,
          byteLength: bytes.length, sha256, sourceRenditionId: null, transformations: [], edited: false,
        }),
        stmt("UPDATE media_uploads SET state = 'finalized', asset_id = ?, updated_at = ? WHERE user_id = ? AND upload_id = ?", assetId, ctx.now, ctx.userId, upload.upload_id),
      ];
      const affected = [
        { kind: "media_upload", id: upload.upload_id, version: 2 },
        { kind: "media_asset", id: assetId, version: 1 },
      ];
      if (upload.garment_id && assetKindFor(upload) !== "generic_illustration") {
        const current = await loadGarmentMediaRow(ctx.db, ctx.userId, upload.garment_id);
        // A photograph arrived: processing starts. An existing approved image stays primary until the new one is ready.
        statements.push(
          upsertGarmentMedia(ctx, upload.garment_id, current, {
            imageState: current?.image_state === "resolved" ? "resolved" : "searching",
            primaryAssetId: current?.primary_asset_id ?? null,
            photoRequest: null,
            lastFailure: null,
          }),
        );
        affected.push({ kind: "garment", id: upload.garment_id, version: 0 });
      }
      const jobId = await stableId("job", ctx.userId, "normalize", assetId, "1");
      const job = enqueueJob(ctx, { jobId, kind: "normalize", subjectId: assetId, dedupeKey: `normalize:${assetId}:1`, payload: { stagingKey: key }, maxAttempts: limits.jobMaxAttempts });
      return {
        summary: `Photo stored privately (${probe.width ?? "?"}x${probe.height ?? "?"} ${probe.contentType}); preparing its catalogue view`,
        statements: [...statements, ...job.statements],
        preconditions: [stillOpen],
        affected: affected.filter((a) => a.kind !== "garment"),
        outbox: job.outbox,
        result: { uploadId: upload.upload_id, finalized: true, assetId, renditionId, jobId, sha256, width: probe.width, height: probe.height, hadLocationMetadata: probe.exif.hasGps },
        undo: { unavailableReason: "delete the photo instead (media.delete_asset)" },
      };
    },
  });

  const expire = define({
    type: "media.expire_uploads",
    schema: ExpireUploads,
    class: "system",
    requiredScope: "write",
    allowedAuthorizations: ["system_schedule", "standing_policy"],
    async plan(ctx, p) {
      if (ctx.principal.actor !== "system") throw new CommandError("forbidden", "this command is scheduled upkeep and is not available to clients");
      const deps = resolveDeps(depsSource);
      const expired: string[] = [];
      for (const uploadId of p.uploadIds) {
        const upload = await loadUpload(ctx, uploadId);
        if (!upload || upload.state !== "authorized" || ctx.nowMs <= parseInstant(upload.expires_at) + FINALIZE_GRACE_MS) continue;
        await deps.bucket.delete(stagingKey(ctx.userId, upload.upload_id));
        expired.push(upload.upload_id);
      }
      if (expired.length === 0) return { outcome: "noop", summary: "No upload authorization had lapsed", result: { expired: 0 }, undo: { unavailableReason: "nothing changed" } };
      return {
        summary: `${expired.length} unfinished upload${expired.length === 1 ? "" : "s"} expired; any bytes received were deleted`,
        statements: expired.map((id) => stmt("UPDATE media_uploads SET state = 'rejected', rejection_reason = 'the upload authorization expired before finalization', updated_at = ? WHERE user_id = ? AND upload_id = ? AND state = 'authorized'", ctx.now, ctx.userId, id)),
        result: { expired: expired.length },
        undo: { unavailableReason: "authorize a new upload instead" },
      };
    },
  });

  return [authorize, finalize, expire];
}

export const ExpireUploads = z.object({ uploadIds: z.array(z.string().min(1).max(64)).min(1).max(200) });
