import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { accessToken, apiOwner, b64url, b64urlJson, call, callJson, decodeJwtPart, foreignJwk, idem, installApiScenario, ISSUER, AUDIENCE, type ApiOwner } from '../../helpers/http.js';
import { count } from '../../helpers/seed.js';

/**
 * Forged Cloudflare Access assertions and alternate hostnames against the real Worker fetch handler.
 * The only accepted Access credential is an RS256 assertion signed by the team key (a locally
 * generated RSA key stands in for it) with the right issuer and audience, on a protected hostname.
 */

async function signWith(jwkJson: string, header: Record<string, unknown>, claims: Record<string, unknown>): Promise<string> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true } as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const h = b64urlJson(header);
  const p = b64urlJson(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const now = () => Math.floor(Date.now() / 1000);

describe('forged Access assertions', () => {
  let owner: ApiOwner;
  const claims = (extra: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: [AUDIENCE], sub: owner.subject, email: 'owner@example.invalid', type: 'app', iat: now(), nbf: now(), exp: now() + 600, ...extra });
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  const expectRefused = async (label: string, init: Parameters<typeof callJson>[1]) => {
    const r = await callJson<{ error?: { code: string } }>('/v1/today', init);
    expect([401, 403], `${label}: ${r.status} ${r.text.slice(0, 120)}`).toContain(r.status);
    expect(r.text).not.toContain('"board"');
  };

  it('identity headers without a signed assertion are ignored (Cf-Access-Authenticated-User-Email, X-User-Id, X-Forwarded-User)', async () => {
    await expectRefused('identity headers', { headers: { 'cf-access-authenticated-user-email': 'owner@example.invalid', 'cf-access-authenticated-user-id': owner.subject, 'x-user-id': owner.userId, 'x-forwarded-user': owner.subject, 'x-garderobe-user': owner.userId } });
  });

  it('alg confusion and header tricks: none, HS256 keyed with the public key, embedded jwk/jku, unknown kid, lowercase alg', async () => {
    const pubJwks = JSON.parse(env.ACCESS_JWKS_JSON!) as { keys: JsonWebKey[] };
    const pub = pubJwks.keys[0]!;
    const hsKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(JSON.stringify(pub)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const h = b64urlJson({ alg: 'HS256', typ: 'JWT', kid: 'test-access-key' });
    const p = b64urlJson(claims());
    const hs = `${h}.${p}.${b64url(await crypto.subtle.sign('HMAC', hsKey, new TextEncoder().encode(`${h}.${p}`)))}`;
    const none = `${b64urlJson({ alg: 'none', typ: 'JWT' })}.${p}.`;
    const attacker = await foreignJwk();
    const attackerPub = { ...(JSON.parse(attacker) as JsonWebKey), d: undefined, p: undefined, q: undefined, dp: undefined, dq: undefined, qi: undefined };
    const embedded = await signWith(attacker, { alg: 'RS256', typ: 'JWT', jwk: attackerPub, kid: 'attacker' }, claims());
    const jku = await signWith(attacker, { alg: 'RS256', typ: 'JWT', jku: 'https://evil.example/jwks.json', kid: 'test-access-key' }, claims());
    const unknownKid = await signWith(attacker, { alg: 'RS256', typ: 'JWT', kid: 'rotated-key-2' }, claims());
    const lower = await signWith(env.TEST_ACCESS_PRIVATE_JWK!, { alg: 'rs256', typ: 'JWT', kid: 'test-access-key' }, claims());
    for (const [label, assertion] of Object.entries({ hs, none, embedded, jku, unknownKid, lower })) await expectRefused(label, { assertion });
  });

  it('claim abuse: wrong issuer/audience, issuer with trailing path, expired, not-yet-valid, issued in the future, excessive lifetime, missing or empty subject, audience as a substring', async () => {
    const key = env.TEST_ACCESS_PRIVATE_JWK!;
    const hdr = { alg: 'RS256', typ: 'JWT', kid: 'test-access-key' };
    const cases: Record<string, Record<string, unknown>> = {
      wrongIssuer: claims({ iss: 'https://evil.cloudflareaccess.com' }),
      issuerSuffix: claims({ iss: `${ISSUER}.evil.example` }),
      issuerPath: claims({ iss: `${ISSUER}/extra` }),
      wrongAudience: claims({ aud: ['another-app'] }),
      audienceSubstring: claims({ aud: [`${AUDIENCE}-evil`] }),
      audienceNull: claims({ aud: null }),
      expired: claims({ iat: now() - 7200, nbf: now() - 7200, exp: now() - 3600 }),
      noExp: claims({ exp: undefined }),
      notYetValid: claims({ nbf: now() + 3600, exp: now() + 7200 }),
      futureIat: claims({ iat: now() + 3600, exp: now() + 7200 }),
      hugeLifetime: claims({ iat: now(), exp: now() + 400 * 86_400 }),
      noSubject: claims({ sub: undefined }),
      emptySubject: claims({ sub: '' }),
      numericSubject: claims({ sub: 12345 }),
    };
    for (const [label, c] of Object.entries(cases)) await expectRefused(label, { assertion: await signWith(key, hdr, c) });
  });

  it('a valid assertion whose payload is swapped to another subject, or re-encoded, fails the signature', async () => {
    const other = await apiOwner('Someone else');
    const [h, p, s] = owner.assertion.split('.');
    const payload = decodeJwtPart(p!);
    const swapped = `${h}.${b64urlJson({ ...payload, sub: other.subject })}.${s}`;
    const padded = `${h}.${p}=.${s}`;
    const extraSegment = `${owner.assertion}.AAAA`;
    for (const [label, assertion] of Object.entries({ swapped, padded, extraSegment })) await expectRefused(label, { assertion });
  });

  it('oversized and garbage assertions are rejected without a server error', async () => {
    for (const assertion of ['x'.repeat(20_000), '...', 'a.b.c', 'ÿþ.ÿþ.ÿþ', `${'e'.repeat(3000)}.${'e'.repeat(3000)}.${'e'.repeat(3000)}`]) {
      const r = await call('/v1/today', { assertion });
      expect(r.status, assertion.slice(0, 20)).toBeGreaterThanOrEqual(400);
      expect(r.status, assertion.slice(0, 20)).toBeLessThan(500);
    }
  });

  it('the CF_Authorization cookie is held to the same checks (forged cookie refused; valid cookie on an alternate host refused)', async () => {
    const attacker = await foreignJwk();
    await expectRefused('forged cookie', { headers: { cookie: `CF_Authorization=${await accessToken(owner.subject, { jwk: attacker })}` } });
    await expectRefused('valid cookie, alternate host', { headers: { cookie: `CF_Authorization=${owner.assertion}` }, origin: 'https://garderobe.owner.workers.dev' });
    const ok = await callJson('/v1/auth/session', { headers: { cookie: `CF_Authorization=${owner.assertion}` } });
    expect(ok.status).toBe(200);
  });
});

describe('alternate hostnames', () => {
  let owner: ApiOwner;
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  it('a valid assertion is refused on every unprotected hostname, including look-alikes and forwarded-host headers', async () => {
    // (http://2130706433 is excluded on purpose: the URL parser normalises it to 127.0.0.1, which IS a configured local host.)
    const origins = ['https://garderobe.owner.workers.dev', 'http://localhost.evil.example', 'http://evil.localhost', 'http://127.0.0.2:8787', 'http://[::1]:8787', 'http://0.0.0.0:8787', 'http://LOCALHOST.:8787'];
    for (const origin of origins) {
      const r = await callJson<{ error?: { code: string } }>('/v1/today', { assertion: owner.assertion, origin, headers: { 'x-forwarded-host': 'localhost', forwarded: 'host=localhost', 'x-original-host': 'localhost' } });
      expect(r.status, origin).toBe(403);
    }
  });

  it('writes are refused on an alternate hostname too (no state change)', async () => {
    const before = await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', owner.userId);
    const r = await call('/v1/commands', { assertion: owner.assertion, origin: 'https://garderobe.owner.workers.dev', body: { idempotencyKey: idem(), source: 'app', command: { type: 'laundry_collected' } } });
    expect(r.status).toBe(403);
    expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', owner.userId)).toBe(before);
  });

  it('the consent page is not reachable with an assertion on an unprotected host', async () => {
    const r = await call('/authorize?response_type=code&client_id=x', { assertion: owner.assertion, origin: 'https://garderobe.owner.workers.dev' });
    expect([400, 401, 403, 404]).toContain(r.status);
  });
});

describe('forged owner identifiers in requests', () => {
  let a: ApiOwner;
  let b: ApiOwner;
  let bShirt: string;
  beforeAll(async () => {
    installApiScenario();
    a = await apiOwner();
    b = await apiOwner('Other owner');
    bShirt = await b.byName('Lightweight oxford — gold');
  });

  it('owner fields anywhere in a command body are refused (top level, nested, arrays, alternate spellings)', async () => {
    const shirt = await a.byName('Lightweight oxford — gold');
    const bodies = [
      { idempotencyKey: idem(), source: 'app', userId: b.userId, command: { type: 'mark_in_wash', garmentId: shirt } },
      { idempotencyKey: idem(), source: 'app', command: { type: 'mark_in_wash', garmentId: shirt, ownerId: b.userId } },
      { idempotencyKey: idem(), source: 'app', command: { type: 'record_wear', timezone: 'Europe/London', items: [{ garmentId: shirt, user: b.userId }] } },
      { idempotencyKey: idem(), source: 'app', command: { type: 'mark_in_wash', garmentId: shirt }, tenantId: b.userId },
      { idempotencyKey: idem(), source: 'app', command: { type: 'mark_in_wash', garmentId: shirt }, accountId: b.userId },
      { idempotencyKey: idem(), source: 'app', command: { type: 'mark_in_wash', garmentId: shirt }, owner: { id: b.userId } },
    ];
    const before = await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id IN (?, ?)', a.userId, b.userId);
    for (const body of bodies) {
      const r = await callJson<{ error: { code: string } }>('/v1/commands', { assertion: a.assertion, body });
      expect(r.status, JSON.stringify(body).slice(0, 120)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id IN (?, ?)', a.userId, b.userId)).toBe(before);
  });

  it('a JSON __proto__ / constructor payload cannot inject an owner or bypass the strict schema', async () => {
    const shirt = await a.byName('Lightweight oxford — gold');
    const raw = `{"idempotencyKey":"${idem()}","source":"app","__proto__":{"userId":"${b.userId}"},"command":{"type":"mark_in_wash","garmentId":"${shirt}","constructor":{"prototype":{"userId":"${b.userId}"}}}}`;
    const bReceipts = await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', b.userId);
    const r = await callJson('/v1/commands', { assertion: a.assertion, method: 'POST', rawBody: raw, headers: { 'content-type': 'application/json' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', b.userId)).toBe(bReceipts);
  });

  it('owner query parameters and headers never select another owner: refused outright, or ignored', async () => {
    const forged = await callJson<{ items?: { garment: { garmentId: string } }[] }>(`/v1/wardrobe?userId=${b.userId}&ownerId=${b.userId}&limit=500`, { assertion: a.assertion, headers: { 'x-user-id': b.userId } });
    expect([200, 400, 422], forged.text.slice(0, 200)).toContain(forged.status);
    expect(forged.text).not.toContain(bShirt);
    const r = await callJson<{ items: { garment: { garmentId: string } }[] }>('/v1/wardrobe?limit=500', { assertion: a.assertion, headers: { 'x-user-id': b.userId, 'x-owner-id': b.userId } });
    expect(r.status).toBe(200);
    const ids = new Set(r.body.items.map((i) => i.garment.garmentId));
    expect(ids.has(bShirt)).toBe(false);
    expect(ids.has(await a.byName('Lightweight oxford — gold'))).toBe(true);
  });

  it('SQL-shaped query parameters are data, not SQL', async () => {
    for (const q of ["' OR 1=1 --", '" OR ""="', `x' UNION SELECT user_id, name FROM garments WHERE user_id='${b.userId}' --`, '%', '_', '\\']) {
      const r = await callJson<{ items: { garment: { garmentId: string } }[] }>(`/v1/wardrobe?q=${encodeURIComponent(q)}&limit=500`, { assertion: a.assertion });
      expect(r.status, q).toBeLessThan(500);
      if (r.status === 200) expect(r.body.items.some((i) => i.garment.garmentId === bShirt), q).toBe(false);
    }
    for (const cursor of ["1; DROP TABLE garments", '-1', '9999999999999999999999', 'NaN']) {
      const r = await call(`/v1/wardrobe?cursor=${encodeURIComponent(cursor)}`, { assertion: a.assertion });
      expect(r.status, cursor).toBeLessThan(500);
    }
    expect(await count('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?', b.userId)).toBeGreaterThan(100);
  });
});
