import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { generateKeyPair } from '../helpers/keys.js';
import { accessToken, apiOwner, call, callJson, installApiScenario, ISSUER } from '../helpers/api.js';
import { b64urlEncode, randomToken } from '../../src/auth/jose.js';

/**
 * App and web authentication (spec section 15): Cloudflare Access assertions verified by the Worker,
 * identity-subject mapping, host policy, and the secretless native PKCE S256 public-client flow.
 * Every request goes through the Worker's fetch handler on the local workerd runtime.
 */

const REDIRECT = 'garderobe://auth/callback';
const RESOURCE = 'http://localhost:8787/v1';

async function s256(v: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
}

async function authorize(assertion: string, over: Record<string, string> = {}) {
  const verifier = randomToken(48);
  const params = new URLSearchParams({ response_type: 'code', client_id: 'garderobe-ios', redirect_uri: REDIRECT, code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 'st-1', resource: RESOURCE, ...over });
  const res = await call(`/v1/auth/native/authorize?${params}`, { assertion });
  const location = res.headers.get('location');
  return { res, verifier, location: location ? new URL(location) : null };
}

function token(form: Record<string, string>) {
  return callJson<Record<string, unknown>>('/v1/auth/native/token', { body: new URLSearchParams(form) });
}

describe('Cloudflare Access assertion verification', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  it('accepts a verified assertion and maps the subject to the internal owner', async () => {
    const r = await callJson('/v1/auth/session', { assertion: owner.assertion });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ displayName: 'Chris', authenticatedBy: 'access', scopes: ['wardrobe:read', 'wardrobe:write'] });
    expect(JSON.stringify(r.body)).not.toContain(owner.userId);
  });

  it('requires an assertion', async () => {
    const r = await callJson<{ error: { code: string } }>('/v1/today');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('access_required');
    expect(r.res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('rejects unsigned, re-signed, mis-addressed and expired assertions', async () => {
    const [h, p] = owner.assertion.split('.');
    const none = `${b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })))}.${p}.`;
    const otherKey = await generateKeyPair();
    const forged = await accessToken(owner.subject, { jwk: otherKey });
    const tampered = `${h}.${b64urlEncode(new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))), sub: 'someone-else' })))}.${owner.assertion.split('.')[2]}`;
    const wrongAud = await accessToken(owner.subject, { audience: 'another-app' });
    const wrongIss = await accessToken(owner.subject, { issuer: 'https://evil.cloudflareaccess.com' });
    const expired = await accessToken(owner.subject, { nowSeconds: Math.floor(Date.now() / 1000) - 7200, ttlSeconds: 600 });
    for (const [label, assertion] of Object.entries({ none, forged, tampered, wrongAud, wrongIss, expired })) {
      const r = await callJson<{ error: { code: string; details?: { reason?: string } } }>('/v1/today', { assertion });
      expect(r.status, label).toBe(401);
      expect(r.body.error.code, label).toBe('access_invalid');
    }
  });

  it('refuses a verified assertion on a hostname Access does not protect (alternate-route spoofing)', async () => {
    for (const origin of ['https://garderobe.owner.workers.dev', 'http://evil.example']) {
      const r = await callJson<{ error: { code: string } }>('/v1/today', { assertion: owner.assertion, origin });
      expect(r.status, origin).toBe(403);
      expect(r.body.error.code).toBe('host_not_protected');
    }
  });

  it('rejects an unknown subject, even with the owner email', async () => {
    const r = await callJson<{ error: { code: string } }>('/v1/today', { assertion: await accessToken('unknown-subject') });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('unknown_identity');
  });

  it('rejects an identity whose user is disabled', async () => {
    const other = await apiOwner();
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(other.userId).run();
    const r = await callJson<{ error: { code: string } }>('/v1/today', { assertion: other.assertion });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('user_disabled');
  });

  it('never lets a request body name the owner', async () => {
    const r = await callJson<{ error: { code: string } }>('/v1/commands', { assertion: owner.assertion, body: { idempotencyKey: 'app:forged-owner-1', source: 'app', userId: 'usr_someoneelse', command: { type: 'laundry_collected' } } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('forbidden_owner_field');
  });
});

describe('native app sign-in: secretless PKCE S256 public client', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  it('authorizes through Access, exchanges the code with the verifier and calls the API with the bearer token', async () => {
    const a = await authorize(owner.assertion);
    expect(a.res.status).toBe(302);
    expect(a.location!.protocol).toBe('garderobe:');
    expect(a.location!.searchParams.get('state')).toBe('st-1');
    expect(a.location!.searchParams.get('iss')).toBe('http://localhost:8787');
    const code = a.location!.searchParams.get('code')!;
    const t = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code, redirect_uri: REDIRECT, code_verifier: a.verifier, resource: RESOURCE });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'wardrobe:read wardrobe:write' });
    const session = await callJson('/v1/auth/session', { bearer: t.body.access_token as string });
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ authenticatedBy: 'native_token', displayName: 'Chris' });
    // The code works once.
    const again = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code, redirect_uri: REDIRECT, code_verifier: a.verifier });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('refuses a wrong verifier, a client secret, plain PKCE, an unregistered redirect and a foreign resource', async () => {
    const a = await authorize(owner.assertion);
    const code = a.location!.searchParams.get('code')!;
    const wrong = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code, redirect_uri: REDIRECT, code_verifier: randomToken(48) });
    expect(wrong.body.error).toBe('invalid_grant');
    const secret = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', client_secret: 'x', code, redirect_uri: REDIRECT, code_verifier: a.verifier });
    expect(secret.status).toBe(401);
    expect(secret.body.error).toBe('invalid_client');
    const plain = await authorize(owner.assertion, { code_challenge_method: 'plain' });
    expect(plain.location!.searchParams.get('error')).toBe('invalid_request');
    expect(plain.location!.searchParams.get('code')).toBeNull();
    const foreign = await authorize(owner.assertion, { resource: 'https://elsewhere.example/v1' });
    expect(foreign.location!.searchParams.get('error')).toBe('invalid_target');
    const redirect = await authorize(owner.assertion, { redirect_uri: 'https://attacker.example/cb' });
    expect(redirect.res.status).toBe(400);
    expect(redirect.location).toBeNull();
    const noAccess = await call(`/v1/auth/native/authorize?client_id=garderobe-ios&redirect_uri=${encodeURIComponent(REDIRECT)}`);
    expect(noAccess.status).toBe(401);
  });

  it('rotates refresh tokens and revokes the session when a rotated token is replayed', async () => {
    const a = await authorize(owner.assertion);
    const t = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code: a.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: a.verifier });
    const first = t.body.refresh_token as string;
    const r1 = await token({ grant_type: 'refresh_token', client_id: 'garderobe-ios', refresh_token: first });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(first);
    expect((await callJson('/v1/auth/session', { bearer: r1.body.access_token as string })).status).toBe(200);
    const replay = await token({ grant_type: 'refresh_token', client_id: 'garderobe-ios', refresh_token: first });
    expect(replay.body.error).toBe('invalid_grant');
    expect((await callJson('/v1/auth/session', { bearer: r1.body.access_token as string })).status).toBe(401);
  });

  it('sign-out revokes the bearer token immediately; malformed and unknown tokens are refused', async () => {
    const a = await authorize(owner.assertion);
    const t = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code: a.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: a.verifier });
    const access = t.body.access_token as string;
    expect((await call('/v1/auth/native/revoke', { body: new URLSearchParams({ token: access }) })).status).toBe(200);
    expect((await callJson('/v1/auth/session', { bearer: access })).status).toBe(401);
    expect((await callJson('/v1/today', { bearer: randomToken() })).status).toBe(401);
    expect((await callJson('/v1/today', { headers: { authorization: 'Bearer not a token' } })).status).toBe(401);
  });

  it('the native bearer token is only accepted on the protected hostname', async () => {
    const a = await authorize(owner.assertion);
    const t = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code: a.location!.searchParams.get('code')!, redirect_uri: REDIRECT, code_verifier: a.verifier });
    const r = await callJson<{ error: { code: string } }>('/v1/today', { bearer: t.body.access_token as string, origin: 'https://garderobe.owner.workers.dev' });
    expect(r.status).toBe(403);
    expect(ISSUER).toContain('cloudflareaccess.com');
  });
});
