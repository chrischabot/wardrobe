/**
 * Short-lived, owner-scoped signed URLs (spec section 11 and 15). A token names exactly one owner,
 * one object (asset or upload) and one purpose, and expires. It never grants access to anything
 * else in the bucket; a calendar link never embeds a permanent bearer URL.
 */

export type TokenPurpose = 'media' | 'upload';

export interface TokenClaims {
  purpose: TokenPurpose;
  userId: string;
  objectId: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error('MEDIA_URL_SIGNING_KEY must be at least 32 characters');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(secret: string, claims: TokenClaims): Promise<string> {
  const payload = enc.encode(['v1', claims.purpose, claims.userId, claims.objectId, String(claims.exp)].join('|'));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), payload));
  return `${b64url(payload)}.${b64url(sig)}`;
}

export type VerifyResult = { ok: true; claims: TokenClaims } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_object' | 'wrong_purpose' };

export async function verifyToken(secret: string, token: string, expect: { purpose: TokenPurpose; objectId: string; nowSeconds: number }): Promise<VerifyResult> {
  const [p, s, extra] = token.split('.');
  if (!p || !s || extra !== undefined) return { ok: false, reason: 'malformed' };
  const payload = fromB64url(p);
  const sig = fromB64url(s);
  if (!payload || !sig) return { ok: false, reason: 'malformed' };
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, payload);
  if (!valid) return { ok: false, reason: 'bad_signature' };
  const parts = new TextDecoder().decode(payload).split('|');
  if (parts.length !== 5 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const claims: TokenClaims = { purpose: parts[1] as TokenPurpose, userId: parts[2]!, objectId: parts[3]!, exp: Number(parts[4]) };
  if (claims.purpose !== expect.purpose) return { ok: false, reason: 'wrong_purpose' };
  if (claims.objectId !== expect.objectId) return { ok: false, reason: 'wrong_object' };
  if (!Number.isFinite(claims.exp) || claims.exp <= expect.nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/** Local-only development key. Deployed environments must set the MEDIA_URL_SIGNING_KEY secret. */
export const LOCAL_DEV_SIGNING_KEY = 'garderobe-local-development-only-media-signing-key';

export function mediaSigningKey(env: { MEDIA_URL_SIGNING_KEY?: string; ENVIRONMENT?: string }): string {
  if (env.MEDIA_URL_SIGNING_KEY) return env.MEDIA_URL_SIGNING_KEY;
  if (env.ENVIRONMENT === 'local' || env.ENVIRONMENT === 'test') return LOCAL_DEV_SIGNING_KEY;
  throw new Error('MEDIA_URL_SIGNING_KEY is not configured');
}
