/**
 * Minimal JOSE helpers on WebCrypto (no dependency): base64url, RS256 JWT verification against a JWKS,
 * and HMAC-SHA256 signing for server-minted opaque state.
 */

export function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface JwtVerifyOptions {
  keys: Jwk[];
  issuer: string;
  audiences: string[];
  nowSeconds?: number;
  clockSkewSeconds?: number;
  maxLifetimeSeconds?: number;
  /**
   * Accept a Cloudflare Access service-token assertion: `type: "app"`, an empty `sub` and the token's
   * Client ID in `common_name`. The caller must map it to a subject distinct from any user subject.
   */
  allowServiceToken?: boolean;
}

export class JwtError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  email?: string;
  type?: string;
  [k: string]: unknown;
}

/** Verifies an RS256 JWT: header, signature (key by kid), issuer, audience, expiry, not-before and lifetime. */
export async function verifyRs256Jwt(token: string, opts: JwtVerifyOptions): Promise<JwtClaims> {
  if (token.length > 16_384) throw new JwtError('too_large', 'Assertion too large');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed', 'Malformed assertion');
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: JwtClaims;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0]!)));
    claims = JSON.parse(dec.decode(b64urlDecode(parts[1]!)));
  } catch {
    throw new JwtError('malformed', 'Malformed assertion');
  }
  if (header.alg !== 'RS256') throw new JwtError('invalid_alg', 'Only RS256 assertions are accepted');
  const candidates = opts.keys.filter((k) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid));
  if (!candidates.length) throw new JwtError('no_matching_key', 'No signing key matches the assertion');
  const data = enc.encode(`${parts[0]}.${parts[1]}`);
  const signature = b64urlDecode(parts[2]!);
  let verified = false;
  for (const jwk of candidates) {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true } as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data)) {
      verified = true;
      break;
    }
  }
  if (!verified) throw new JwtError('signature_failed', 'Assertion signature is invalid');
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = opts.clockSkewSeconds ?? 60;
  if (typeof claims.iss !== 'string' || claims.iss !== opts.issuer) throw new JwtError('issuer', 'Assertion issuer is not trusted');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === 'string' && opts.audiences.includes(a))) throw new JwtError('audience', 'Assertion audience does not match this application');
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new JwtError('expired', 'Assertion has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new JwtError('not_yet_valid', 'Assertion is not valid yet');
  if (typeof claims.iat === 'number' && claims.iat - skew > now) throw new JwtError('iat_in_future', 'Assertion was issued in the future');
  if (opts.maxLifetimeSeconds && typeof claims.iat === 'number' && claims.exp - claims.iat > opts.maxLifetimeSeconds) throw new JwtError('lifetime', 'Assertion lifetime is too long');
  if (typeof claims.sub !== 'string' || !claims.sub) {
    const serviceToken = opts.allowServiceToken && claims.sub === '' && claims.type === 'app' && typeof claims.common_name === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(claims.common_name);
    if (!serviceToken) throw new JwtError('subject', 'Assertion has no subject');
  }
  return claims;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Signs a JSON payload: `<b64url(payload)>.<b64url(hmac)>`. */
export async function signState(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64urlEncode(mac)}`;
}

/** Verifies and decodes signed state; null when the signature or shape is wrong. */
export async function verifyState<T = Record<string, unknown>>(secret: string, token: string): Promise<T | null> {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(mac), enc.encode(body));
    if (!ok) return null;
    return JSON.parse(dec.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

/** 256-bit random token, base64url. */
export function randomToken(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256B64url(text: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** Constant-time string comparison for equal-length secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
