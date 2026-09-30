import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { apiOwner, call, callJson, installApiScenario, randomVerifier, s256, type ApiOwner } from '../../helpers/http.js';
import { approveConsent, authorizeCode, connectMcp, exchangeCode, MCP_URL, mcpGrant, openConsent, refresh, registerClient, tool } from '../../helpers/mcp.js';
import { count, one } from '../../helpers/seed.js';

/**
 * OAuth abuse against the Worker's real authorization server (@cloudflare/workers-oauth-provider plus
 * Garderobe's Access-protected consent page and D1 grant checks), for the MCP consumer flow and the
 * native app's public-client flow.
 */

const tokenBody = async (res: Response) => (await res.json()) as Record<string, string>;
const mcpList = (token: string) => call('/mcp', { method: 'POST', bearer: token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });

describe('authorization request abuse (PKCE, redirect, scope, resource)', () => {
  let owner: ApiOwner;
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  it('refuses a missing or plain PKCE challenge and unknown scopes before any consent', async () => {
    const client = await registerClient('claude');
    const noPkce = await openConsent(owner.assertion, client, 'wardrobe:read', { code_challenge: '', code_challenge_method: '' });
    const plain = await openConsent(owner.assertion, client, 'wardrobe:read', { code_challenge_method: 'plain', code_challenge: 'x'.repeat(50) });
    const admin = await openConsent(owner.assertion, client, 'wardrobe:read wardrobe:admin');
    for (const [label, r] of Object.entries({ noPkce, plain, admin })) {
      expect(r.res.status, `${label}: ${r.page.slice(0, 160)}`).toBeGreaterThanOrEqual(400);
      expect(r.handle, label).toBe('');
    }
  });

  it('refuses a redirect URI that was not registered (open redirect / code theft)', async () => {
    const client = await registerClient('claude');
    for (const redirect of ['https://evil.example/cb', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/../../evil', 'https://claude.ai/api/mcp/auth_callback?next=https://evil.example', 'javascript:alert(1)']) {
      const r = await openConsent(owner.assertion, { clientId: client.clientId, redirectUri: redirect }, 'wardrobe:read');
      expect(r.res.status, redirect).toBeGreaterThanOrEqual(400);
      expect(r.res.headers.get('location') ?? '', redirect).not.toContain('evil');
    }
  });

  it('registration refuses non-HTTPS, credential-bearing or script redirect URIs', async () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@evil.example/cb']) {
      const res = await call('/oauth/register', { body: { client_name: 'Evil', redirect_uris: [uri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] } });
      expect(res.status, uri).toBeGreaterThanOrEqual(400);
    }
  });

  it('the code is bound to its verifier, client, redirect and resource; the redirect carries our issuer', async () => {
    const client = await registerClient('claude');
    const other = await registerClient('chatgpt');
    const { code, verifier, iss, state, consent } = await authorizeCode(owner.assertion, client, ['wardrobe:read']);
    expect(state).toBe(consent.state);
    expect(iss === null || iss === 'http://localhost:8787').toBe(true);
    expect((await exchangeCode(client, code, randomVerifier())).status).toBe(400); // wrong verifier
    expect((await exchangeCode(other, code, verifier)).status).toBeGreaterThanOrEqual(400); // another client
    expect((await exchangeCode({ ...client, redirectUri: 'https://claude.ai/other' }, code, verifier)).status).toBeGreaterThanOrEqual(400); // another redirect
    expect((await exchangeCode(client, code, verifier, { resource: 'https://evil.example/mcp' })).status).toBeGreaterThanOrEqual(400); // another audience
    // The failed attempts must not have burnt a way in for the attacker; whether the legitimate exchange still works
    // afterwards is provider policy, so only the attacker outcomes are asserted.
  });

  it('an authorization code works once (replay refused)', async () => {
    const client = await registerClient('claude');
    const { code, verifier } = await authorizeCode(owner.assertion, client, ['wardrobe:read']);
    const first = await exchangeCode(client, code, verifier);
    expect(first.status).toBe(200);
    const again = await exchangeCode(client, code, verifier);
    expect(again.status).toBe(400);
    expect((await tokenBody(again)).error).toBe('invalid_grant');
  });

  it('consent transaction abuse: a forged binding, a swapped handle, an expired binding or another owner\'s session are refused', async () => {
    const client = await registerClient('claude');
    const c1 = await openConsent(owner.assertion, client, 'wardrobe:read wardrobe:write');
    const c2 = await openConsent(owner.assertion, client, 'wardrobe:read');
    const forgedBinding = await approveConsent(owner.assertion, { ...c1, owner: `${c1.owner.slice(0, -4)}AAAA` }, ['wardrobe:read']);
    expect(forgedBinding.status).toBe(403);
    const swapped = await approveConsent(owner.assertion, { ...c1, handle: c2.handle }, ['wardrobe:read']);
    expect(swapped.status).toBe(403);
    const other = await apiOwner('Intruder');
    expect((await approveConsent(other.assertion, c1, ['wardrobe:read', 'wardrobe:write'])).status).toBe(403);
    expect((await approveConsent('', c1, ['wardrobe:read'])).status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id = ? AND client_id = ?', other.userId, client.clientId)).toBe(0);
  });

  it('a consent approval is single-use (replayed POST refused)', async () => {
    const client = await registerClient('claude');
    const c = await openConsent(owner.assertion, client, 'wardrobe:read');
    expect((await approveConsent(owner.assertion, c, ['wardrobe:read'])).status).toBe(302);
    const replay = await approveConsent(owner.assertion, c, ['wardrobe:read']);
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });
});

describe('scope escalation (read → write)', () => {
  let owner: ApiOwner;
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  it('the owner cannot be tricked into granting more than the client asked for: form-injected scopes are dropped', async () => {
    const client = await registerClient('chatgpt');
    const c = await openConsent(owner.assertion, client, 'wardrobe:read');
    const approved = await approveConsent(owner.assertion, c, ['wardrobe:read', 'wardrobe:write']);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const t = await tokenBody(await exchangeCode(client, code, c.verifier));
    expect(t.scope).toBe('wardrobe:read');
    const row = await one<{ scopes_json: string }>('SELECT scopes_json FROM mcp_grants WHERE user_id = ? AND client_id = ?', owner.userId, client.clientId);
    expect(JSON.parse(row.scopes_json)).toEqual(['wardrobe:read']);
  });

  it('unknown scopes in the approval form are refused', async () => {
    const client = await registerClient('chatgpt');
    const c = await openConsent(owner.assertion, client, 'wardrobe:read');
    expect((await approveConsent(owner.assertion, c, ['wardrobe:read', 'admin'])).status).toBe(400);
    const c2 = await openConsent(owner.assertion, client, 'wardrobe:read wardrobe:write');
    expect((await approveConsent(owner.assertion, c2, ['wardrobe:write'])).status).toBe(400); // read is mandatory
  });

  it('refresh or code exchange asking for write on a read grant never widens it; the MCP session stays read-only', async () => {
    const g = await mcpGrant(owner.assertion, 'chatgpt', ['wardrobe:read']);
    const r = await refresh(g.clientId, g.refreshToken, { scope: 'wardrobe:read wardrobe:write' });
    const body = await tokenBody(r);
    if (r.status === 200) expect(body.scope ?? 'wardrobe:read').not.toContain('wardrobe:write');
    const token = r.status === 200 ? body.access_token! : g.accessToken;
    const c = await connectMcp(token);
    const cmd = await tool(c, 'garderobe_command', { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'laundry_collected' } });
    expect(cmd.structuredContent).toMatchObject({ status: 'proposal', receipt: null });
    await c.close();
  });

  it('an owner who narrows a grant in D1 narrows live tokens immediately', async () => {
    const g = await mcpGrant(owner.assertion, 'claude', ['wardrobe:read', 'wardrobe:write']);
    await env.DB.prepare("UPDATE mcp_grants SET scopes_json = '[\"wardrobe:read\"]' WHERE user_id = ? AND client_id = ?").bind(owner.userId, g.clientId).run();
    const c = await connectMcp(g.accessToken);
    const cmd = await tool(c, 'garderobe_command', { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'laundry_collected' } });
    expect(cmd.structuredContent).toMatchObject({ status: 'proposal' });
    await c.close();
  });
});

describe('refresh token abuse and revocation', () => {
  let owner: ApiOwner;
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  it('a refresh token is bound to its client', async () => {
    const g = await mcpGrant(owner.assertion, 'claude');
    const other = await registerClient('chatgpt');
    expect((await refresh(other.clientId, g.refreshToken)).status).toBeGreaterThanOrEqual(400);
  });

  it('a rotated (replayed) refresh token is refused', async () => {
    const g = await mcpGrant(owner.assertion, 'claude');
    const r1 = await refresh(g.clientId, g.refreshToken);
    expect(r1.status).toBe(200);
    const t1 = await tokenBody(r1);
    const r2 = await refresh(g.clientId, t1.refresh_token!);
    expect(r2.status).toBe(200);
    // The provider keeps the immediately previous token valid for one retry; two generations back must be dead.
    expect((await refresh(g.clientId, g.refreshToken)).status).toBe(400);
  });

  it('disconnect in D1 kills access and refresh at once, whatever the provider KV still holds (stale KV)', async () => {
    const g = await mcpGrant(owner.assertion, 'claude');
    const live = await connectMcp(g.accessToken);
    expect((await live.client.listTools()).tools.length).toBe(7);
    await live.close();
    // Revoke only in D1, leaving the provider's KV records untouched (simulating a failed KV revocation).
    await env.DB.prepare("UPDATE mcp_grants SET status = 'revoked', version = version + 1 WHERE user_id = ? AND client_id = ?").bind(owner.userId, g.clientId).run();
    expect((await mcpList(g.accessToken)).status).toBe(401);
    expect((await refresh(g.clientId, g.refreshToken)).status).toBe(400);
  });

  it('bumping the grant version (reconnect) invalidates tokens minted under the old version', async () => {
    const g = await mcpGrant(owner.assertion, 'claude');
    await env.DB.prepare('UPDATE mcp_grants SET version = version + 1 WHERE user_id = ? AND client_id = ?').bind(owner.userId, g.clientId).run();
    expect((await mcpList(g.accessToken)).status).toBe(401);
  });

  it('a reconnect of the same client revokes the earlier grant and its tokens', async () => {
    const first = await mcpGrant(owner.assertion, 'claude');
    const client = { clientId: first.clientId, redirectUri: first.redirectUri };
    const { code, verifier } = await authorizeCode(owner.assertion, client, ['wardrobe:read']);
    expect((await exchangeCode(client, code, verifier)).status).toBe(200);
    expect((await mcpList(first.accessToken)).status).toBe(401);
  });

  it('a disabled user\'s tokens stop working', async () => {
    const other = await apiOwner('Soon disabled');
    const g = await mcpGrant(other.assertion, 'claude');
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(other.userId).run();
    expect((await mcpList(g.accessToken)).status).toBe(401);
  });

  it('MCP tokens are refused on the app API and at another resource path', async () => {
    const g = await mcpGrant(owner.assertion, 'claude');
    expect((await call('/v1/today', { bearer: g.accessToken })).status).toBe(401);
    expect((await call('/v1/commands', { bearer: g.accessToken, body: { idempotencyKey: 'app:mcp-token-on-app', source: 'app', command: { type: 'laundry_collected' } } })).status).toBe(401);
  });
});

describe('native app public client', () => {
  let owner: ApiOwner;
  const REDIRECT = 'garderobe://auth/callback';
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  async function nativeCode(over: Record<string, string> = {}) {
    const verifier = randomVerifier();
    const params = new URLSearchParams({ response_type: 'code', client_id: 'garderobe-ios', redirect_uri: REDIRECT, code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 'st', resource: 'http://localhost:8787/v1', ...over });
    const res = await call(`/v1/auth/native/authorize?${params}`, { assertion: owner.assertion });
    const loc = res.headers.get('location');
    return { res, verifier, code: loc ? new URL(loc).searchParams.get('code') : null };
  }
  const token = (form: Record<string, string>) => callJson<Record<string, string>>('/v1/auth/native/token', { body: new URLSearchParams(form) });

  it('an unknown client id, another redirect scheme or a missing challenge get no code', async () => {
    for (const over of [{ client_id: 'evil-app' }, { redirect_uri: 'evilapp://auth/callback' }, { redirect_uri: 'garderobe://auth/callback/../../steal' }, { code_challenge: '' }, { response_type: 'token' }] as Record<string, string>[]) {
      const r = await nativeCode(over);
      expect(r.code, JSON.stringify(over)).toBeNull();
    }
  });

  it('the native code is single-use, verifier-bound and cannot be redeemed at the MCP token endpoint', async () => {
    const { code, verifier } = await nativeCode();
    expect(code).toBeTruthy();
    const mcpTry = await call('/oauth/token', { body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, client_id: 'garderobe-ios', redirect_uri: REDIRECT, code_verifier: verifier, resource: MCP_URL }) });
    expect(mcpTry.status).toBeGreaterThanOrEqual(400);
    const ok = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code: code!, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(ok.status).toBe(200);
    expect((await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code: code!, redirect_uri: REDIRECT, code_verifier: verifier })).status).toBe(400);
    // The app bearer token is not an MCP credential.
    expect((await mcpList(ok.body.access_token!)).status).toBe(401);
  });

  it('racing two redemptions of one code yields at most one token', async () => {
    const { code, verifier } = await nativeCode();
    const form = { grant_type: 'authorization_code', client_id: 'garderobe-ios', code: code!, redirect_uri: REDIRECT, code_verifier: verifier };
    const results = await Promise.all([token(form), token(form), token(form)]);
    expect(results.filter((r) => r.status === 200).length).toBe(1);
  });

  it('racing refreshes of one refresh token yield at most one live session', async () => {
    const { code, verifier } = await nativeCode();
    const t = await token({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code: code!, redirect_uri: REDIRECT, code_verifier: verifier });
    const form = { grant_type: 'refresh_token', client_id: 'garderobe-ios', refresh_token: t.body.refresh_token! };
    const results = await Promise.all([token(form), token(form), token(form)]);
    const winners = results.filter((r) => r.status === 200);
    let live = 0;
    for (const w of winners) if ((await call('/v1/auth/session', { bearer: w.body.access_token! })).status === 200) live++;
    expect(live).toBeLessThanOrEqual(1);
  });
});
