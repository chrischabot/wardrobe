import { CommandError } from "@garderobe/domain";

/**
 * R2 key scheme. EVERY object lives under the owner's prefix `u/<userId>/`; nothing in this package
 * builds a key any other way, and every read re-checks the prefix against the authenticated owner.
 *
 *   u/<userId>/staging/<uploadId>                          bytes received but not finalized (never evidence)
 *   u/<userId>/assets/<assetId>/original-<sha16>.<ext>     immutable original
 *   u/<userId>/assets/<assetId>/<kind>-v<n>-<sha16>.<ext>  derived renditions
 *   u/<userId>/composites/<manifestHash>.<renderJobId>.<sha16>.png|.svg   outfit previews, one generation per render request
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

/**
 * An outfit preview file. With the render job and the preview's checksum the key is generation- and
 * content-addressed (`<manifestHash>.<renderJobId>.<sha16>.png|svg`): two runners of the same render write the
 * same bytes to the same object, a runner whose claim was taken over cannot replace the files another runner
 * committed, and a purge of one discarded generation never reaches the files of a newer request, even when
 * that request draws byte-identical pixels. Without a job and checksum the key is the pre-generation name, still
 * purged when its composite is discarded.
 */
export function compositeKey(userId: string, manifestHash: string, contentType: "image/png" | "image/svg+xml", previewSha256?: string, renderJobId?: string): string {
  if (previewSha256 && !renderJobId) throw new CommandError("invalid_command", "a preview file is named by its render job and checksum together");
  const version = previewSha256 && renderJobId ? `.${safe(renderJobId, "render job id")}.${safe(previewSha256.slice(0, 16), "preview checksum")}` : "";
  return `${ownerPrefix(userId)}composites/${safe(manifestHash, "manifest hash")}${version}.${extensionFor(contentType)}`;
}

/** Every file of one outfit preview, whichever render wrote it, starts with this. */
export function compositePrefix(userId: string, manifestHash: string): string {
  return `${ownerPrefix(userId)}composites/${safe(manifestHash, "manifest hash")}.`;
}

/** Every file one render request (one generation) of an outfit preview wrote starts with this. */
export function compositeGenerationPrefix(userId: string, manifestHash: string, renderJobId: string): string {
  return `${compositePrefix(userId, manifestHash)}${safe(renderJobId, "render job id")}.`;
}

export function keyBelongsTo(userId: string, key: string): boolean {
  return key.startsWith(ownerPrefix(userId)) && !key.includes("..");
}

/** Throws unless the key is inside this owner's prefix. Called before every R2 read, write and delete. */
export function assertOwnedKey(userId: string, key: string): void {
  if (!keyBelongsTo(userId, key)) throw new CommandError("forbidden", "this object does not belong to the authenticated owner");
}
