/**
 * Upload functions for the API thread's `/v1/uploads` routes. They wrap the same commands a client could
 * send through `/v1/commands`; the only extra is minting the short-lived upload token and receiving bytes.
 */
import { assertPrincipal, CommandError, first, parseInstant, requireScope, sha256Hex, type Db, type Principal } from "@garderobe/domain";
import type { CommandReceipt } from "@garderobe/contracts";
import type { MediaAsset, MediaPayload, UploadAuthorization, UploadStatus } from "@garderobe/contracts/ext/media";
import { UPLOAD_COLUMNS, type UploadRow } from "./commands/uploads.ts";
import { execAs } from "./exec.ts";
import { probeImage } from "./image/index.ts";
import { stagingKey } from "./keys.ts";
import { getAsset } from "./reads.ts";
import type { MediaRuntime } from "./runtime.ts";
import { signClaims, verifyToken } from "./signing.ts";

async function loadUploadRow(db: Db, userId: string, uploadId: string): Promise<UploadRow | null> {
  return first<UploadRow>(db, `SELECT ${UPLOAD_COLUMNS} FROM media_uploads WHERE user_id = ? AND upload_id = ?`, userId, uploadId);
}

/** The upload authorization (URL with token) for one of the caller's own authorized uploads. */
export async function mintUploadAuthorization(rt: MediaRuntime, principal: Principal, uploadId: string): Promise<UploadAuthorization> {
  assertPrincipal(principal);
  requireScope(principal, "write");
  const row = await loadUploadRow(rt.db, principal.userId, uploadId);
  if (!row) throw new CommandError("not_found", "no such upload for this owner");
  if (row.state !== "authorized") throw new CommandError("precondition_failed", `this upload is already ${row.state}`);
  const expMs = parseInstant(row.expires_at);
  if (expMs <= rt.clock()) throw new CommandError("precondition_failed", "this upload authorization has expired; authorize a new upload");
  const token = await signClaims(rt.deps.signingKey, { p: "upload", u: principal.userId, r: row.upload_id, m: row.max_bytes, c: row.content_type, exp: Math.floor(expMs / 1000) });
  return {
    uploadId: row.upload_id,
    method: "PUT",
    url: `/v1/uploads/${row.upload_id}/content?token=${token}`,
    requiredHeaders: { "content-type": row.content_type },
    maxBytes: row.max_bytes,
    expiresAt: row.expires_at,
  };
}

export async function authorizeUpload(
  rt: MediaRuntime,
  principal: Principal,
  input: MediaPayload<"media.authorize_upload"> & { idempotencyKey: string },
): Promise<{ receipt: CommandReceipt; authorization: UploadAuthorization; replayed: boolean }> {
  const { idempotencyKey, ...payload } = input;
  const receipt = await execAs(rt, principal, "media.authorize_upload", payload, idempotencyKey);
  const authorization = await mintUploadAuthorization(rt, principal, String(receipt.result.uploadId));
  return { receipt, authorization, replayed: receipt.replayed };
}

/**
 * Receive the bytes of an authorized upload into the owner's STAGING key. The token alone identifies
 * the owner and the upload; if the route also authenticated a principal it must be the same owner.
 * Nothing received here is evidence or enters any task until `media.finalize_upload` validates it.
 */
export async function receiveUploadContent(
  rt: MediaRuntime,
  input: { uploadId: string; token: string; body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array; contentLength: number | null; contentType: string | null; principal?: Principal },
): Promise<{ uploadId: string; receivedBytes: number; sha256: string }> {
  const verified = await verifyToken(rt.deps.signingKey, input.token, "upload", rt.clock());
  if (!verified.ok) throw new CommandError("forbidden", verified.reason === "expired" ? "this upload authorization has expired" : "this upload authorization is not valid");
  const claims = verified.claims;
  if (claims.r !== input.uploadId) throw new CommandError("forbidden", "this upload authorization is for a different upload");
  if (input.principal) {
    assertPrincipal(input.principal);
    if (input.principal.userId !== claims.u) throw new CommandError("forbidden", "this upload authorization belongs to another owner");
  }
  const owner = await first<{ status: string }>(rt.db, "SELECT status FROM users WHERE user_id = ?", claims.u);
  if (!owner || owner.status !== "active") throw new CommandError("forbidden", "this account is disabled");
  const row = await loadUploadRow(rt.db, claims.u, claims.r);
  if (!row) throw new CommandError("not_found", "no such upload");
  if (row.state !== "authorized") throw new CommandError("precondition_failed", `this upload is already ${row.state}; authorize a new upload to replace the photo`);
  if ((input.contentType ?? "").split(";")[0]!.trim().toLowerCase() !== claims.c) throw new CommandError("invalid_command", `this upload was authorized for ${claims.c}`);
  if (input.contentLength !== null && input.contentLength > claims.m) throw new CommandError("invalid_command", `at most ${claims.m} bytes were authorized for this upload`);

  let bytes: Uint8Array;
  if (input.body instanceof ArrayBuffer) bytes = new Uint8Array(input.body);
  else if (input.body instanceof Uint8Array) bytes = input.body;
  else {
    // Count while reading: a missing or false Content-Length cannot push more than the authorized size into memory or storage.
    const reader = input.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > claims.m) {
        await reader.cancel().catch(() => undefined);
        throw new CommandError("invalid_command", `at most ${claims.m} bytes were authorized for this upload`);
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
  }
  if (bytes.length === 0) throw new CommandError("invalid_command", "the upload is empty");
  if (bytes.length > claims.m) throw new CommandError("invalid_command", `at most ${claims.m} bytes were authorized for this upload`);
  // Early refusal of obvious non-images; finalization repeats every check on the stored bytes.
  const probe = probeImage(bytes);
  if (!probe || probe.contentType !== claims.c) throw new CommandError("invalid_command", `the bytes are not a ${claims.c} image`);
  const sha256 = await sha256Hex(bytes);
  await rt.deps.bucket.put(stagingKey(claims.u, claims.r), bytes, { httpMetadata: { contentType: claims.c }, customMetadata: { uploadId: claims.r, sha256, state: "staging" } });
  return { uploadId: claims.r, receivedBytes: bytes.length, sha256 };
}

/** Validate and finalize. A rejection is a committed receipt carrying the reason, not a thrown error. */
export async function finalizeUpload(
  rt: MediaRuntime,
  principal: Principal,
  uploadId: string,
  opts: { idempotencyKey?: string } = {},
): Promise<{ receipt: CommandReceipt; asset: MediaAsset | null; rejected: string | null; jobId: string | null }> {
  const receipt = await execAs(rt, principal, "media.finalize_upload", { uploadId }, opts.idempotencyKey ?? `finalize:${uploadId}`);
  const assetId = typeof receipt.result.assetId === "string" ? receipt.result.assetId : null;
  return {
    receipt,
    asset: assetId ? await getAsset(rt, principal, assetId) : null,
    rejected: receipt.result.finalized === false ? String(receipt.result.rejectionReason ?? "rejected") : null,
    jobId: typeof receipt.result.jobId === "string" ? receipt.result.jobId : null,
  };
}

export async function getUploadStatus(rt: MediaRuntime, principal: Principal, uploadId: string): Promise<UploadStatus> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const row = await loadUploadRow(rt.db, principal.userId, uploadId);
  if (!row) throw new CommandError("not_found", "no such upload for this owner");
  const expired = row.state === "authorized" && parseInstant(row.expires_at) <= rt.clock();
  return { uploadId: row.upload_id, intent: row.intent, garmentId: row.garment_id, state: expired ? "expired" : row.state, rejectionReason: row.rejection_reason, assetId: row.asset_id, expiresAt: row.expires_at };
}

/**
 * Copy image bytes the backend already holds (an authorized Drive file, or an illustration drawn by the
 * image model from a description) into private storage through the ordinary upload path, with provenance.
 */
export async function importImageBytes(
  rt: MediaRuntime,
  principal: Principal,
  input: { garmentId: string; bytes: Uint8Array; origin: "drive_import" | "image_model"; originRef: string; idempotencyKey?: string },
): Promise<{ receipt: CommandReceipt; asset: MediaAsset | null; rejected: string | null; jobId: string | null }> {
  const probe = probeImage(input.bytes);
  if (!probe || !["image/jpeg", "image/png", "image/webp", "image/heic"].includes(probe.contentType)) throw new CommandError("invalid_command", "the bytes are not an accepted image");
  const key = input.idempotencyKey ?? `import:${await sha256Hex(input.bytes)}:${input.garmentId}`;
  const uploadId = `upl_${(await sha256Hex(key)).slice(0, 24)}`;
  const existing = await loadUploadRow(rt.db, principal.userId, uploadId);
  if (!existing) {
    await execAs(rt, principal, "media.authorize_upload", { uploadId, intent: "garment_photo", garmentId: input.garmentId, contentType: probe.contentType, byteLength: input.bytes.length, origin: input.origin, originRef: input.originRef }, `${key}:authorize`);
  }
  if (!existing || existing.state === "authorized") {
    const authorization = await mintUploadAuthorization(rt, principal, uploadId);
    const token = new URLSearchParams(authorization.url.split("?")[1]).get("token")!;
    await receiveUploadContent(rt, { uploadId, token, body: input.bytes, contentLength: input.bytes.length, contentType: probe.contentType, principal });
  }
  return finalizeUpload(rt, principal, uploadId, { idempotencyKey: `${key}:finalize` });
}
