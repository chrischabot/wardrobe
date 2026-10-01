import { CommandError } from "@garderobe/domain";

/**
 * R2 key scheme. EVERY object lives under the owner's prefix `u/<userId>/`; nothing in this package
 * builds a key any other way, and every read re-checks the prefix against the authenticated owner.
 *
 *   u/<userId>/staging/<uploadId>                          bytes received but not finalized (never evidence)
 *   u/<userId>/assets/<assetId>/original-<sha16>.<ext>     immutable original
 *   u/<userId>/assets/<assetId>/<kind>-v<n>-<sha16>.<ext>  derived renditions
 *   u/<userId>/composites/<manifestHash>.png|.svg          outfit previews
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function safe(part: string, what: string): string {
  if (!SAFE_ID.test(part)) throw new CommandError("invalid_command", `invalid ${what}`);
  return part;
}

export function ownerPrefix(userId: string): string {
  return `u/${safe(userId, "owner id")}/`;
}

export function stagingKey(userId: string, uploadId: string): string {
  return `${ownerPrefix(userId)}staging/${safe(uploadId, "upload id")}`;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/avif": "avif", "image/gif": "gif", "image/svg+xml": "svg" };

export function extensionFor(contentType: string): string {
  return EXT[contentType] ?? "bin";
}

export function originalKey(userId: string, assetId: string, sha256: string, contentType: string): string {
  return `${ownerPrefix(userId)}assets/${safe(assetId, "asset id")}/original-${sha256.slice(0, 16)}.${extensionFor(contentType)}`;
}

export function renditionKey(userId: string, assetId: string, kind: string, version: number, sha256: string, contentType: string): string {
  return `${ownerPrefix(userId)}assets/${safe(assetId, "asset id")}/${safe(kind, "rendition kind")}-v${version}-${sha256.slice(0, 16)}.${extensionFor(contentType)}`;
}

export function compositeKey(userId: string, manifestHash: string, contentType: "image/png" | "image/svg+xml"): string {
  return `${ownerPrefix(userId)}composites/${safe(manifestHash, "manifest hash")}.${extensionFor(contentType)}`;
}

export function keyBelongsTo(userId: string, key: string): boolean {
  return key.startsWith(ownerPrefix(userId)) && !key.includes("..");
}

/** Throws unless the key is inside this owner's prefix. Called before every R2 read, write and delete. */
export function assertOwnedKey(userId: string, key: string): void {
  if (!keyBelongsTo(userId, key)) throw new CommandError("forbidden", "this object does not belong to the authenticated owner");
}
