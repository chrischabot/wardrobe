import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { signRs256Jwt } from '../../src/auth/dev.js';
import { apiOwner, AUDIENCE, callJson, installApiScenario, ISSUER } from '../helpers/api.js';

/**
 * Cloudflare Access service tokens (automated test identity for deployed environments). Access issues
 * them an assertion with `type: "app"`, an empty `sub` and the Client ID in `common_name` (observed on
 * the garderobe-dev deployment). The Worker maps it to `service-token:<Client ID>`, which, like any
 * subject, reaches an owner only through an explicit auth_identities link.
 */

const CLIENT_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.access';

function serviceTokenAssertion(extra: Record<string, unknown> = {}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const jwk = JSON.parse(env.TEST_ACCESS_PRIVATE_JWK!) as JsonWebKey & { kid?: string };
  return signRs256Jwt(jwk, { type: 'app', iat, exp: iat + 3600, iss: ISSUER, sub: '', aud: AUDIENCE, common_name: CLIENT_ID, ...extra });
}

describe('Access service-token assertions', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  it('an unlinked service token is a verified but unknown identity', async () => {
    const r = await callJson<{ error: { code: string } }>('/v1/auth/session', { assertion: await serviceTokenAssertion() });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('unknown_identity');
  });

  it('a linked service token signs in as that owner, and only through its own subject', async () => {
    await env.DB.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, email, linked_at) VALUES (?, ?, ?, ?, NULL, ?)')
      .bind(owner.userId, `idn_${crypto.randomUUID().replace(/-/g, '')}`, ISSUER, `service-token:${CLIENT_ID}`, '2026-09-29T00:00:00.000Z')
      .run();
    const ok = await callJson('/v1/auth/session', { assertion: await serviceTokenAssertion() });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ displayName: 'Chris', authenticatedBy: 'access' });
    const other = await callJson<{ error: { code: string } }>('/v1/auth/session', { assertion: await serviceTokenAssertion({ common_name: 'ffffffffffffffffffffffffffffffff.access' }) });
    expect(other.body.error.code).toBe('unknown_identity');
  });

  it('an empty subject is refused unless it is a well-formed service-token assertion', async () => {
    for (const extra of [{ type: 'org' }, { common_name: '' }, { common_name: undefined }, { common_name: 'bad name with spaces' }, { sub: undefined }]) {
      const r = await callJson<{ error: { code: string; details?: { reason?: string } } }>('/v1/auth/session', { assertion: await serviceTokenAssertion(extra) });
      expect(r.status, JSON.stringify(extra)).toBe(401);
      expect(r.body.error.details?.reason).toBe('subject');
    }
  });

  it('a user assertion whose sub imitates the service-token form stays a user subject', async () => {
    const jwk = JSON.parse(env.TEST_ACCESS_PRIVATE_JWK!) as JsonWebKey & { kid?: string };
    const iat = Math.floor(Date.now() / 1000);
    const imitation = await signRs256Jwt(jwk, { type: 'app', iat, exp: iat + 3600, iss: ISSUER, sub: 'someone', aud: AUDIENCE, common_name: CLIENT_ID });
    const r = await callJson<{ error: { code: string } }>('/v1/auth/session', { assertion: imitation });
    expect(r.body.error.code).toBe('unknown_identity');
  });
});
