/**
 * HMAC-SHA-256 tokens for upload authorization and media URLs.
 *
 * A token is `<base64url(JSON claims)>.<base64url(HMAC)>`. The claims always carry the owner (`u`), the
 * single resource the token is good for, a purpose (`p`) and an expiry (`exp`, seconds). Verification is
 * constant-time (`crypto.subtle.verify`). A token never grants bucket-wide access and is useless for
 * another owner, another resource, another purpose, or after expiry.
 */

export interface UploadClaims {
  p: "upload";
  u: string;
  /** upload id */
  r: string;
  /** maximum bytes */
  m: number;
  /** required content type */
  c: string;
  exp: number;
}

export interface RenditionClaims {
  p: "rendition";
  u: string;
  /** rendition id */
  r: string;
  /** thumbnail width, or 0 for the stored rendition */
  w: number;
  exp: number;
}

export interface CompositeClaims {
  p: "composite";
  u: string;
  /** manifest hash */
  r: string;
  w: number;
  exp: number;
}

export type MediaClaims = UploadClaims | RenditionClaims | CompositeClaims;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    if (secret.length < 32) throw new Error("the media signing key must be at least 32 characters");
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, key);
  }
  return key;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export async function signClaims(secret: string, claims: MediaClaims): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(mac))}`;
}

export type VerifyFailure = "malformed" | "bad_signature" | "expired" | "wrong_purpose";

/** Verifies signature first, then purpose and expiry. Returns the claims or the reason for refusal. */
export async function verifyToken<P extends MediaClaims["p"]>(
  secret: string,
  token: string,
  purpose: P,
  nowMs: number,
): Promise<{ ok: true; claims: Extract<MediaClaims, { p: P }> } | { ok: false; reason: VerifyFailure }> {
  if (typeof token !== "string" || token.length > 2048) return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const mac = base64UrlDecode(token.slice(dot + 1));
  const payload = base64UrlDecode(body);
  if (!mac || !payload || mac.length !== 32) return { ok: false, reason: "malformed" };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), mac as unknown as ArrayBuffer, encoder.encode(body));
  if (!valid) return { ok: false, reason: "bad_signature" };
  let claims: MediaClaims;
  try {
    claims = JSON.parse(decoder.decode(payload)) as MediaClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims || typeof claims !== "object" || typeof claims.u !== "string" || typeof claims.r !== "string" || typeof claims.exp !== "number") return { ok: false, reason: "malformed" };
  if (claims.p !== purpose) return { ok: false, reason: "wrong_purpose" };
  if (claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims as Extract<MediaClaims, { p: P }> };
}
