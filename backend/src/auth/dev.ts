import { b64urlEncode } from './jose.js';

/**
 * Development and test tooling only: signs an RS256 JWT with a local private JWK, standing in for the
 * Cloudflare Access assertion when no Access application is in front of `wrangler dev` or the test
 * runtime. The Worker verifies it through exactly the same path as a real Access assertion (JWKS,
 * issuer, audience, expiry). Nothing in the request path imports this module.
 */
export async function signRs256Jwt(privateJwk: JsonWebKey & { kid?: string }, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk, alg: 'RS256', ext: true } as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'RS256', kid: privateJwk.kid, typ: 'JWT' })));
  const body = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64urlEncode(sig)}`;
}

/** An Access-shaped assertion for a subject (claims as Cloudflare Access issues them). */
export function accessClaims(input: { issuer: string; audience: string; subject: string; email?: string; ttlSeconds?: number; nowSeconds?: number }): Record<string, unknown> {
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return { iss: input.issuer, aud: [input.audience], sub: input.subject, email: input.email ?? 'owner@example.invalid', type: 'app', iat, nbf: iat, exp: iat + (input.ttlSeconds ?? 3600), identity_nonce: crypto.randomUUID() };
}
