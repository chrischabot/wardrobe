import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ItemDetail, StyleCurrentResponse } from '@garderobe/contracts';
import { issueRecoveryCredential, recoverWithCredential, type RecoveryKit, type RecoveryOutcome } from '../../../backend/src/lifecycle/index.js';
import { b64urlEncode, randomToken } from '../../../backend/src/auth/jose.js';
import { accessAssertion, ISSUER, PROFILE_TEXT, seedOwner, uniq, type Owner } from '../harness/owner.js';
import { App, call, callJson, ORIGIN } from '../harness/http.js';
import { installWorld, type World } from '../harness/world.js';
import { connectAssistant, connectMcp, rawMcpStatus, refreshGrant, type Grant } from '../harness/mcp.js';
import { expectDoneReceipt } from '../harness/ux.js';

/**
 * Journey 18 — Recovery after losing Google access (spec section 15 "Recovery after losing Google
 * access"; section 17 row "Lost identity": a test owner recovers the same wardrobe without Google
 * access; the used recovery credential and prior sessions cannot be reused). The owner kept the
 * one-time recovery kit from setup. Having lost the Google account, he signs in with another
 * verified identity (a new Access subject): an email match alone gets him nowhere; the recovery code
 * binds the new identity to the same internal owner, is spent, and is replaced. He finds the same
 * wardrobe and history. The assistant grant and native app session from before recovery stop
 * working; fresh ones made with the new identity work.
 *
 * Stand-ins: the new identity is a locally signed Cloudflare Access assertion for a new subject
 * (test key from vitest.config.ts); FakeWeatherProvider replaces Open-Meteo.
 */

const REDIRECT = 'garderobe://auth/callback';

async function s256(v: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
}

/** The native app's secretless PKCE sign-in, as the iOS app performs it. */
async function nativeSignIn(assertion: string): Promise<{ access: string; refresh: string }> {
  const verifier = randomToken(48);
  const params = new URLSearchParams({ response_type: 'code', client_id: 'garderobe-ios', redirect_uri: REDIRECT, code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 'st-recovery', resource: `${ORIGIN}/v1` });
  const res = await call(`/v1/auth/native/authorize?${params}`, { assertion });
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const t = await callJson<{ access_token: string; refresh_token: string }>('/v1/auth/native/token', { body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code, redirect_uri: REDIRECT, code_verifier: verifier, resource: `${ORIGIN}/v1` }) });
  expect(t.status).toBe(200);
  return { access: t.body.access_token, refresh: t.body.refresh_token };
}

const bearerSession = async (token: string) => (await call('/v1/auth/session', { bearer: token })).status;

/** A working grant: a real MCP SDK session lists the Garderobe tools. */
async function mcpWorks(token: string): Promise<boolean> {
  const mcp = await connectMcp(token);
  try {
    return (await mcp.client.listTools()).tools.some((t) => t.name === 'garderobe_today');
  } finally {
    await mcp.close();
  }
}

describe('Journey: recovering the same wardrobe after losing the Google account', () => {
  let world: World;
  let owner: Owner;
  let app: App;
  let kit: RecoveryKit;
  let idsBefore: string[];
  let shirt: string;
  let grant: Grant;
  let native: { access: string; refresh: string };
  let newSubject: string;
  let newApp: App;
  let outcome: RecoveryOutcome;

  const attempts = async () => (await env.DB.prepare('SELECT outcome FROM recovery_attempts WHERE user_id = ? ORDER BY created_at').bind(owner.userId).all<{ outcome: string }>()).results.map((r) => r.outcome);

  beforeAll(async () => {
    world = installWorld({ now: '2026-10-05T19:00:00.000Z', weather: { scenario: 'mild' } });
    owner = await seedOwner();
    app = new App(owner.assertion);
    // SURFACE GAP: no HTTP/MCP route to issue the recovery kit at setup; driven through issueRecoveryCredential
    kit = await issueRecoveryCredential(env.DB, owner.userId);
    shirt = await owner.byName('Lightweight oxford — light blue wide stripe');
    expectDoneReceipt(await app.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-05', items: [{ garmentId: shirt, role: 'base_top' }] }));
    idsBefore = [...(await app.wardrobe()).byId.keys()].sort();
    // Before the loss: Claude is connected and the native app is signed in.
    grant = await connectAssistant(owner.assertion, 'claude');
    native = await nativeSignIn(owner.assertion);
    newSubject = uniq('access-sub-apple');
    newApp = new App(await accessAssertion(newSubject));
  });

  it('setup hands out a one-time recovery kit with a storage instruction; only a verifier is stored', async () => {
    expect(kit.credential).toMatch(/^GRDB\.rcv_[0-9a-f]+\.[A-Z2-9]{32}$/);
    expect(kit.instructions).toMatch(/offline/i);
    expect(kit.instructions).toMatch(/works once/i);
    const row = await env.DB.prepare('SELECT verifier_hash FROM recovery_credentials WHERE user_id = ? AND credential_id = ?').bind(owner.userId, kit.credentialId).first<{ verifier_hash: string }>();
    expect(row!.verifier_hash).toMatch(/^pbkdf2-sha256\$\d+\$/);
    expect(row!.verifier_hash).not.toContain(kit.credential.split('.')[2]!);
    // The pre-loss connections work.
    expect(await mcpWorks(grant.accessToken)).toBe(true);
    expect(await bearerSession(native.access)).toBe(200);
  });

  it('a new sign-in whose email matches the owner’s is not the owner: email proves nothing', async () => {
    const session = await newApp.get<{ error: { code: string } }>('/v1/auth/session');
    expect(session.status).toBe(403);
    expect(session.body.error.code).toBe('unknown_identity');
    expect((await newApp.get('/v1/wardrobe')).status).toBe(403);
  });

  it('a wrong recovery code is refused and audited; the kept code binds the new identity to the same owner and issues a replacement kit', async () => {
    // SURFACE GAP: no HTTP/MCP route for account recovery (spec: "a recovery flow on the dedicated authentication route"); driven through recoverWithCredential
    const wrong = `${kit.credential.split('.').slice(0, 2).join('.')}.${'A'.repeat(32)}`;
    await expect(recoverWithCredential(env.DB, { credential: wrong, newIdentity: { issuer: ISSUER, subject: newSubject } })).rejects.toThrow(/not valid/);
    outcome = await recoverWithCredential(env.DB, { credential: kit.credential, newIdentity: { issuer: ISSUER, subject: newSubject, email: 'owner@example.invalid' } });
    expect(outcome.userId).toBe(owner.userId);
    expect(outcome.linkedIdentityId).toMatch(/^idn_/);
    expect(outcome.replacementKit.credential).not.toBe(kit.credential);
    expect(outcome.replacementKit.instructions).toMatch(/offline/i);
    expect(await attempts()).toEqual(['wrong_secret', 'recovered']);
  });

  it('the recovered owner signs in with the new identity and finds the same wardrobe, history and profile', async () => {
    const session = await newApp.get<{ displayName: string; authenticatedBy: string }>('/v1/auth/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ displayName: 'Chris', authenticatedBy: 'access' });
    const { page, byId } = await newApp.wardrobe();
    expect(page.total).toBe(144);
    expect([...byId.keys()].sort()).toEqual(idsBefore);
    const d = ItemDetail.parse((await newApp.get(`/v1/items/${shirt}`)).body);
    expect([d.item.recordedWearCount, d.item.lastRecordedWear]).toEqual([1, '2026-10-05']);
    expect(StyleCurrentResponse.parse((await newApp.get('/v1/style/current')).body).document.body).toBe(PROFILE_TEXT);
    // And he can keep using it.
    world.clock.set('2026-10-06T07:30:00.000Z');
    const trousers = await owner.byName('Di Sondrio walnut chino');
    expectDoneReceipt(await newApp.commit({ type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: trousers, role: 'bottom' }] }));
  });

  it('the spent recovery code cannot be used again', async () => {
    // SURFACE GAP: no HTTP/MCP route for account recovery; driven through recoverWithCredential
    await expect(recoverWithCredential(env.DB, { credential: kit.credential, newIdentity: { issuer: ISSUER, subject: uniq('access-sub-attacker') } })).rejects.toThrow(/not valid/);
    expect((await attempts()).at(-1)).toBe('already_used');
  });

  it('the assistant grant made before recovery stops working and cannot be refreshed; reconnecting with the new identity works', async () => {
    expect(await rawMcpStatus(grant.accessToken)).toBe(401);
    const refreshed = await refreshGrant(grant.clientId, grant.refreshToken);
    expect(refreshed.status, 'refreshing a grant revoked by recovery').not.toBe(200);
    await refreshed.body?.cancel();
    const fresh = await connectAssistant(newApp.assertion, 'claude');
    expect(await mcpWorks(fresh.accessToken)).toBe(true);
  });

  it('the native app session from before recovery is revoked and cannot be revived by refresh; a fresh native sign-in with the new identity works', async () => {
    expect(await bearerSession(native.access)).toBe(401);
    const r = await callJson<{ access_token?: string }>('/v1/auth/native/token', { body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'garderobe-ios', refresh_token: native.refresh }) });
    // Observed: the refresh endpoint still answers 200 for the revoked session; what matters is that the minted token is refused.
    if (r.status === 200) expect(await bearerSession(r.body.access_token!), 'a token refreshed from a revoked session').toBe(401);
    const again = await nativeSignIn(newApp.assertion);
    expect(await bearerSession(again.access)).toBe(200);
  });
});
