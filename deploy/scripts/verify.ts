/**
 * Deployment-targeted verification of garderobe-dev over HTTPS (the journey and adversarial suites run
 * in-process in workerd and cannot target a URL, so their relevant cases are repeated here):
 *  - authentication: Cloudflare Access at the edge and in the Worker, host policy, OAuth provider on
 *    /mcp, MCP tokens refused by /v1, unlink/relink of a service token;
 *  - the inbound OAuth flow end to end (registration, Access-protected consent, PKCE S256 code
 *    exchange, rotating refresh with replay refusal, revocation);
 *  - owner isolation with the synthetic test owner B;
 *  - idempotent commands on the app surface and over MCP;
 *  - the owner's section 8 hard constraints on the deployed boards (tests/journeys/harness/profile.ts);
 *  - the MCP SDK client smoke of all seven tools on 2026-07-28 and the 2025-11-25 adapter.
 * Writes deploy/evidence/verify.json (statuses and counts only).
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client-v2-2';
import type { TodayResponse } from '@garderobe/contracts';
import { hardConstraintViolations } from '../../tests/journeys/harness/profile.js';
import { APP_ORIGIN, backendDir, MCP_ORIGIN, serviceTokenHeaders, TEAM_DOMAIN, UA, writeEvidence, writeState } from './lib.js';
import { api } from './probe.js';

const SPEC_PROFILE_SHA256 = 'e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198';
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url' as BufferEncoding);

interface Check {
  area: string;
  name: string;
  pass: boolean;
  observed: unknown;
}
const checks: Check[] = [];
async function check(area: string, name: string, fn: () => Promise<{ pass: boolean; observed: unknown }>) {
  try {
    const r = await fn();
    checks.push({ area, name, ...r });
    console.log(`${r.pass ? 'PASS' : 'FAIL'} [${area}] ${name} ${JSON.stringify(r.observed).slice(0, 220)}`);
  } catch (err) {
    checks.push({ area, name, pass: false, observed: `threw: ${err instanceof Error ? err.message : String(err)}` });
    console.log(`FAIL [${area}] ${name} threw ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function raw(url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'user-agent': UA, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* html or empty */
  }
  return { status: res.status, body, text, headers: res.headers };
}

const CLIENTS = {
  claude: { client_name: 'Claude (garderobe-dev verification)', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
  chatgpt: { client_name: 'ChatGPT (garderobe-dev verification)', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
} as const;

interface Grant {
  clientId: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
}

/** The full inbound OAuth flow against the deployed server, with Access in front of /authorize. */
async function oauthGrant(kind: keyof typeof CLIENTS, access: 'read' | 'write', as: 'owner' | 'b'): Promise<{ grant: Grant; steps: Record<string, number> }> {
  const meta = CLIENTS[kind];
  const steps: Record<string, number> = {};
  const reg = await raw(`${MCP_ORIGIN}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...meta, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  steps.register = reg.status;
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`register ${reg.status}`);
  const clientId = reg.body.client_id as string;
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: meta.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256', state: 'verify', scope: 'wardrobe:read wardrobe:write', resource: `${MCP_ORIGIN}/mcp` });
  const page = await raw(`${MCP_ORIGIN}/authorize?${params}`, { headers: serviceTokenHeaders(as) });
  steps.consentPage = page.status;
  if (page.status !== 200) throw new Error(`consent page ${page.status}: ${page.text.slice(0, 200)}`);
  const field = (n: string) => (new RegExp(`name="${n}" value="([^"]*)"`).exec(page.text)?.[1] ?? '').replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c))).replace(/&amp;/g, '&');
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const form = new URLSearchParams({ handle: field('handle'), owner: field('owner'), decision: 'approve' });
  form.append('scope', 'wardrobe:read');
  if (access === 'write') form.append('scope', 'wardrobe:write');
  const approved = await raw(`${MCP_ORIGIN}/authorize`, { method: 'POST', headers: { ...serviceTokenHeaders(as), cookie, 'content-type': 'application/x-www-form-urlencoded', origin: MCP_ORIGIN }, body: form.toString() });
  steps.approve = approved.status;
  const code = new URL(approved.headers.get('location') ?? 'x:/').searchParams.get('code');
  if (!code) throw new Error(`approval ${approved.status}: ${approved.text.slice(0, 200)}`);
  const t = await raw(`${MCP_ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: meta.redirect_uris[0], client_id: clientId, code_verifier: verifier, resource: `${MCP_ORIGIN}/mcp` }).toString() });
  steps.token = t.status;
  if (t.status !== 200) throw new Error(`token ${t.status}: ${t.text.slice(0, 200)}`);
  const grant = { clientId, ...(t.body as Omit<Grant, 'clientId'>) };
  writeState(`mcp-grant-${kind}-${access}-${as}.json`, { ...grant, mcpUrl: `${MCP_ORIGIN}/mcp` });
  return { grant, steps };
}

async function mcpClient(token: string, legacy = false): Promise<Client> {
  const client = new Client({ name: 'garderobe-dev-verify', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: legacy ? { mode: 'legacy' } : { mode: 'auto' } } as never);
  client.setRequestHandler('elicitation/create' as never, (async () => ({ action: 'accept', content: { choice: 'confirm' } })) as never);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${MCP_ORIGIN}/mcp`), { authProvider: { token: async () => token } } as never) as never);
  return client;
}
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[]; structuredContent?: Record<string, any> };
const tool = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as ToolResult;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const londonDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** Runs backend/scripts/mcp-smoke.ts against the deployment; keeps only protocol, tool list and statuses. */
function smoke(token: string, legacy: boolean): { exitCode: number; lines: string[] } {
  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync(join(backendDir, '..', 'node_modules', '.bin', 'tsx'), ['scripts/mcp-smoke.ts', ...(legacy ? ['--legacy'] : [])], { cwd: backendDir, env: { ...process.env, GARDEROBE_MCP_URL: `${MCP_ORIGIN}/mcp`, GARDEROBE_MCP_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 }).toString();
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    exitCode = e.status ?? 1;
    out = `${e.stdout?.toString() ?? ''}\n${e.stderr?.toString() ?? ''}`;
  }
  // Drop free text (outfit reasons, day lines, answers, research prose): it can describe the owner's garments.
  const lines = out
    .split('\n')
    .map((l) => (l.startsWith('Connected') ? l.replace(/^Connected to (\S+) — (protocol \S+).*$/, 'Connected to $1, $2') : l.replace(/(day line:|first:|answer:| — |ERROR ).*$/, '$1 [text omitted]')).replace(/usr_[A-Za-z0-9]+/g, 'usr_…').trim())
    .filter(Boolean)
    .slice(0, 40);
  return { exitCode, lines };
}

export async function verify(args: string[]): Promise<void> {
  const skipSmoke = args.includes('--no-smoke');

  // ------------------------------------------------------------------ authentication at the edge
  await check('auth', 'app hostname without credentials is sent to the Access login', async () => {
    const r = await raw(`${APP_ORIGIN}/v1/today`);
    return { pass: r.status === 302 && (r.headers.get('location') ?? '').startsWith(TEAM_DOMAIN), observed: { status: r.status } };
  });
  const forged = `${b64url(Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'x', typ: 'JWT' })))}.${b64url(Buffer.from(JSON.stringify({ iss: TEAM_DOMAIN, aud: ['x'], sub: 'attacker', exp: 9999999999 })))}.${b64url(randomBytes(256))}`;
  await check('auth', 'a forged Cf-Access-Jwt-Assertion without Access sign-in never reaches the API', async () => {
    const r = await raw(`${APP_ORIGIN}/v1/auth/session`, { headers: { 'cf-access-jwt-assertion': forged } });
    return { pass: r.status === 302, observed: { status: r.status } };
  });
  await check('auth', 'a forged assertion added next to a valid service token cannot change who the caller is', async () => {
    const r = await raw(`${APP_ORIGIN}/v1/auth/session`, { headers: { ...serviceTokenHeaders('b'), 'cf-access-jwt-assertion': forged } });
    return { pass: (r.status === 200 && r.body.displayName === 'Synthetic Test Owner B') || r.status === 401, observed: { status: r.status, displayName: r.body?.displayName ?? null, code: r.body?.error?.code ?? null } };
  });
  await check('auth', 'the MCP hostname (outside Access except /authorize) refuses app routes even with a self-made assertion', async () => {
    const r = await raw(`${MCP_ORIGIN}/v1/auth/session`, { headers: { 'cf-access-jwt-assertion': forged } });
    return { pass: r.status === 403 && r.body?.error?.code === 'host_not_protected', observed: { status: r.status, code: r.body?.error?.code } };
  });
  await check('auth', '/authorize on the MCP hostname is behind Access', async () => {
    const r = await raw(`${MCP_ORIGIN}/authorize?client_id=x`);
    return { pass: r.status === 302 && (r.headers.get('location') ?? '').startsWith(TEAM_DOMAIN), observed: { status: r.status } };
  });
  await check('auth', '/mcp, /.well-known and /oauth are outside Access; /mcp without a bearer is 401 with resource metadata', async () => {
    const m = await raw(`${MCP_ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    const wk = await raw(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`);
    const prm = await raw(`${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    const www = m.headers.get('www-authenticate') ?? '';
    return { pass: m.status === 401 && /resource_metadata/.test(www) && wk.status === 200 && prm.status === 200 && prm.body.resource === `${MCP_ORIGIN}/mcp`, observed: { mcp: m.status, wwwAuthenticateHasResourceMetadata: /resource_metadata/.test(www), authorizationServerMetadata: wk.status, protectedResourceMetadata: prm.status, issuer: wk.body?.issuer } };
  });
  await check('auth', 'an Access service token alone is not an MCP credential', async () => {
    const r = await raw(`${MCP_ORIGIN}/mcp`, { method: 'POST', headers: { ...serviceTokenHeaders(), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    return { pass: r.status === 401, observed: { status: r.status } };
  });
  await check('auth', 'no workers.dev route serves the dev Worker', async () => {
    const r = await raw('https://garderobe-dev.chabotc.workers.dev/health').catch((e: Error) => ({ status: -1, text: e.message, body: null, headers: new Headers() }));
    return { pass: r.status !== 200 || !String(r.text).includes('garderobe'), observed: { status: r.status } };
  });
  await check('auth', 'unlinking a service token turns it into unknown_identity; relinking restores it (audited)', async () => {
    const { linkServiceToken } = await import('./seed.js');
    await linkServiceToken('unlink', 'b');
    const off = await raw(`${APP_ORIGIN}/v1/auth/session`, { headers: serviceTokenHeaders('b') });
    await linkServiceToken('link', 'b');
    const on = await raw(`${APP_ORIGIN}/v1/auth/session`, { headers: serviceTokenHeaders('b') });
    return { pass: off.status === 403 && off.body?.error?.code === 'unknown_identity' && on.status === 200, observed: { unlinked: { status: off.status, code: off.body?.error?.code }, relinked: on.status } };
  });

  // ------------------------------------------------------------------------------ OAuth grants
  let claude: Grant | null = null;
  let chatgpt: Grant | null = null;
  let ownerB: Grant | null = null;
  await check('oauth', 'Claude write grant end to end (register, Access consent, PKCE S256, token)', async () => {
    const r = await oauthGrant('claude', 'write', 'owner');
    claude = r.grant;
    return { pass: r.grant.scope.split(' ').sort().join(' ') === 'wardrobe:read wardrobe:write' && r.grant.expires_in <= 900, observed: { steps: r.steps, scope: r.grant.scope, expiresIn: r.grant.expires_in, refreshToken: Boolean(r.grant.refresh_token) } };
  });
  await check('oauth', 'ChatGPT read-only grant: the owner approves less than requested', async () => {
    const r = await oauthGrant('chatgpt', 'read', 'owner');
    chatgpt = r.grant;
    return { pass: r.grant.scope === 'wardrobe:read', observed: { steps: r.steps, scope: r.grant.scope } };
  });
  await check('oauth', 'test owner B gets its own grant through its own Access identity', async () => {
    const r = await oauthGrant('claude', 'write', 'b');
    ownerB = r.grant;
    return { pass: Boolean(r.grant.access_token), observed: { steps: r.steps, scope: r.grant.scope } };
  });
  await check('oauth', 'refresh rotates; replaying the used refresh token is refused', async () => {
    const g = (await oauthGrant('claude', 'write', 'owner')).grant;
    const form = (rt: string) => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: g.clientId, resource: `${MCP_ORIGIN}/mcp` }).toString();
    const first = await raw(`${MCP_ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(g.refresh_token) });
    const second = first.status === 200 ? await raw(`${MCP_ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(first.body.refresh_token) }) : null;
    const replay = await raw(`${MCP_ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(g.refresh_token) });
    const rotated = first.status === 200 && first.body.refresh_token !== g.refresh_token;
    return { pass: rotated && second?.status === 200 && replay.status >= 400, observed: { refresh: first.status, rotated, secondRefresh: second?.status ?? null, replayOfFirstRefreshToken: { status: replay.status, error: replay.body?.error ?? null } } };
  });
  await check('oauth', 'an MCP access token is not accepted by the app API', async () => {
    const r = await raw(`${APP_ORIGIN}/v1/auth/session`, { headers: { ...serviceTokenHeaders('b'), authorization: `Bearer ${claude!.access_token}` } });
    return { pass: r.status === 401 && r.body?.error?.code === 'invalid_token', observed: { status: r.status, code: r.body?.error?.code } };
  });

  // ----------------------------------------------------------------------------------- isolation
  const ownerItems = (await api('/v1/wardrobe?limit=500')).body;
  const idOf = (i: { garment: { garmentId: string } }) => i.garment.garmentId;
  const ownerGarment = idOf(ownerItems.items[0]);
  if (!ownerGarment || !/^g_/.test(ownerGarment)) throw new Error('could not read a garment id from the owner wardrobe listing');
  await check('isolation', "owner B cannot read the owner's item and sees only its own wardrobe (app API)", async () => {
    const item = await api(`/v1/items/${ownerGarment}`, { as: 'b' });
    const bw = await api('/v1/wardrobe?limit=500', { as: 'b' });
    const ownerIds = new Set((ownerItems.items as { garment: { garmentId: string } }[]).map(idOf));
    const bIds = (bw.body.items as { garment: { garmentId: string } }[]).map(idOf);
    const leak = bIds.some((id) => ownerIds.has(id));
    const ownOk = (await api(`/v1/items/${ownerGarment}`)).status;
    return { pass: ownOk === 200 && item.status === 404 && bIds.length > 0 && bIds.every((id) => /^g_/.test(id)) && !leak && bw.body.total < ownerItems.total, observed: { ownerReadsOwnItem: ownOk, itemStatusForB: item.status, ownerTotal: ownerItems.total, ownerBTotal: bw.body.total, overlap: leak } };
  });
  await check('isolation', "owner B's MCP grant cannot resolve the owner's garment and counts only its own", async () => {
    const c = await mcpClient(ownerB!.access_token);
    const snap = await tool(c, 'garderobe_inventory', { view: 'snapshot' });
    const item = await tool(c, 'garderobe_inventory', { view: 'item', garmentId: ownerGarment });
    await c.close();
    const found = Boolean(item.structuredContent?.item);
    return { pass: !found && snap.structuredContent?.total < ownerItems.total, observed: { ownerBTotal: snap.structuredContent?.total, itemFound: found, isError: item.isError ?? false } };
  });
  await check('isolation', 'a forged owner field in an MCP command is refused', async () => {
    const c = await mcpClient(ownerB!.access_token);
    const r = await tool(c, 'garderobe_command', { idempotencyKey: `verify-forged-${Date.now()}`, command: { type: 'mark_in_wash', garmentId: ownerGarment, userId: 'usr_owner' } });
    await c.close();
    const receipt = r.structuredContent?.receipt;
    return { pass: Boolean(r.isError) || receipt?.outcome === 'rejected', observed: { isError: r.isError ?? false, outcome: receipt?.outcome ?? null, code: receipt?.error?.code ?? null } };
  });

  // ------------------------------------------------------------------------------- idempotency
  const today = await api('/v1/today');
  const firstOption = (today.body as TodayResponse).board?.options?.[0];
  await check('idempotency', 'app surface: same key replays, same key with a different body is 409; Undo works', async () => {
    const slots = firstOption!.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, ...(s.alternativeGroup ? { alternativeGroup: s.alternativeGroup } : {}) }));
    const key = `verify:${Date.now()}`;
    const body = { idempotencyKey: key, source: 'app', command: { type: 'save_combination', name: 'Deployment verification (dev)', slots } };
    const a = await api('/v1/commands', { body });
    const b = await api('/v1/commands', { body });
    const c = await api('/v1/commands', { body: { ...body, command: { ...body.command, name: 'Different body' } } });
    const undo = await api('/v1/commands', { body: { idempotencyKey: `${key}:undo`, source: 'app', command: { type: 'undo', targetCommandId: a.body.commandId } } });
    return { pass: a.status === 201 && b.status === 200 && b.body.replayed === true && b.body.commandId === a.body.commandId && c.status === 409 && [200, 201].includes(undo.status), observed: { first: a.status, replay: { status: b.status, replayed: b.body.replayed }, reusedKey: { status: c.status, code: c.body?.error?.code ?? c.body?.error?.code }, undo: { status: undo.status, outcome: undo.body?.outcome } } };
  });
  await check('idempotency', 'MCP garderobe_command: a retry with the same key returns the original receipt', async () => {
    const c = await mcpClient(claude!.access_token);
    const slots = firstOption!.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, ...(s.alternativeGroup ? { alternativeGroup: s.alternativeGroup } : {}) }));
    const args = { idempotencyKey: `verify-mcp:${Date.now()}`, command: { type: 'save_combination', name: 'Deployment verification over MCP (dev)', slots } };
    const a = await tool(c, 'garderobe_command', args);
    const b = await tool(c, 'garderobe_command', args);
    await c.close();
    const ra = a.structuredContent?.receipt;
    const rb = b.structuredContent?.receipt;
    return { pass: ra?.outcome === 'committed' && rb?.replayed === true && rb?.commandId === ra?.commandId, observed: { first: ra?.outcome, retry: { replayed: rb?.replayed, sameCommand: rb?.commandId === ra?.commandId } } };
  });
  await check('scopes', 'a read-only grant gets a proposal and changes nothing', async () => {
    const c = await mcpClient(chatgpt!.access_token);
    const before = (await api('/v1/receipts?limit=1')).body.receipts?.[0]?.commandId ?? null;
    const r = await tool(c, 'garderobe_command', { idempotencyKey: `verify-ro:${Date.now()}`, command: { type: 'mark_in_wash', garmentId: firstOption!.slots[0]!.garmentId } });
    await c.close();
    const after = (await api('/v1/receipts?limit=1')).body.receipts?.[0]?.commandId ?? null;
    return { pass: r.structuredContent?.status === 'proposal' && before === after, observed: { status: r.structuredContent?.status, newestReceiptUnchanged: before === after } };
  });

  // ------------------------------------------------------------------------ profile constraints
  await check('profile', 'the verbatim profile on dev is the spec profile (SHA-256)', async () => {
    const r = await api('/v1/style/current');
    const sha: string[] = JSON.stringify(r.body).match(/[0-9a-f]{64}/g) ?? [];
    return { pass: sha.includes(SPEC_PROFILE_SHA256), observed: { status: r.status, matchesSpec: sha.includes(SPEC_PROFILE_SHA256) } };
  });
  {
    const c = await mcpClient(claude!.access_token);
    for (const date of [londonDate(), addDays(londonDate(), 1)]) {
      await check('profile', `section 8 hard constraints on the deployed board for ${date}`, async () => {
        const t = (await api(`/v1/today?date=${date}`)).body as TodayResponse & { board: { document?: { weather?: { peakTempC?: number; departureTempC?: number } } } };
        if (!t.board) return { pass: false, observed: 'no published board' };
        const w = t.board.document!.weather!;
        const hist = await tool(c, 'garderobe_inventory', { view: 'history', from: addDays(date, -7), to: addDays(date, -1) });
        const worn = new Set(((hist.structuredContent?.wears ?? []) as { garmentId: string; status: string }[]).filter((x) => x.status === 'active').map((x) => x.garmentId));
        const violations = hardConstraintViolations(t as TodayResponse, { peakC: w.peakTempC!, departureC: w.departureTempC!, wornLastSevenDays: worn });
        return { pass: violations.length === 0, observed: { options: t.board.options.filter((o) => o.status === 'offerable').length, peakC: w.peakTempC, departureC: w.departureTempC, wornLastSevenDays: worn.size, violations: violations.length } };
      });
    }
    await c.close();
  }

  // --------------------------------------------------------------------------- revocation
  await check('oauth', 'disconnecting a grant in Garderobe stops its MCP calls at once', async () => {
    const conns = await api('/v1/connections');
    const target = (conns.body.connections as { connectionId: string; kind: string; client: string | null; status: string; scopes: string[] }[]).find((x) => x.kind === 'assistant_grant' && x.client === 'chatgpt' && x.status === 'connected' && x.scopes.join(' ') === 'wardrobe:read');
    const id = target?.connectionId;
    if (!id) return { pass: false, observed: 'no connected ChatGPT read grant listed' };
    const beforeClient = await mcpClient(chatgpt!.access_token);
    const ok = await tool(beforeClient, 'garderobe_today', {});
    await beforeClient.close();
    const d = await api(`/v1/connections/${id}/disconnect`, { body: {} });
    let after: string;
    try {
      const c2 = await mcpClient(chatgpt!.access_token);
      const r = await tool(c2, 'garderobe_today', {});
      after = r.isError ? 'tool error' : 'still works';
      await c2.close();
    } catch (err) {
      after = `refused: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`;
    }
    return { pass: !ok.isError && d.status === 200 && after !== 'still works', observed: { beforeDisconnect: ok.isError ? 'error' : 'ok', disconnect: d.status, afterDisconnect: after } };
  });

  // ------------------------------------------------------------------------------- web board
  await check('web', 'the private web board renders for the signed-in owner: HTML, no script, framing denied', async () => {
    const r = await raw(`${APP_ORIGIN}/board`, { headers: serviceTokenHeaders() });
    const anon = await raw(`${APP_ORIGIN}/board`);
    return {
      pass: r.status === 200 && /text\/html/.test(r.headers.get('content-type') ?? '') && !/<script/i.test(r.text) && (r.headers.get('x-frame-options') ?? '').toUpperCase() === 'DENY' && anon.status === 302,
      observed: { status: r.status, contentType: r.headers.get('content-type'), scriptTags: (r.text.match(/<script/gi) ?? []).length, xFrameOptions: r.headers.get('x-frame-options'), csp: Boolean(r.headers.get('content-security-policy')), withoutAccess: anon.status, bytes: r.text.length },
    };
  });

  // ------------------------------------------------------------------------------- MCP smoke
  const smokes: Record<string, unknown> = {};
  if (!skipSmoke) {
    const fresh = (await oauthGrant('claude', 'write', 'owner')).grant;
    for (const legacy of [false, true]) {
      const s = smoke(fresh.access_token, legacy);
      smokes[legacy ? 'legacy-2025-11-25' : 'modern-2026-07-28'] = s;
      await check('mcp', `MCP SDK client over HTTPS, all seven tools (${legacy ? '2025-11-25 adapter' : 'negotiated 2026-07-28'})`, async () => {
        const askStatus = s.lines.find((l) => l.startsWith('garderobe_ask:'))?.match(/status=(\S+)/)?.[1] ?? null;
        // A tool call without a protocol error is not enough: the assistant run behind garderobe_ask must also complete.
        return { pass: s.exitCode === 0 && s.lines.some((l) => /All seven tools called successfully/.test(l)) && askStatus !== 'failed', observed: { exitCode: s.exitCode, protocol: s.lines.find((l) => l.startsWith('Connected'))?.replace(/^.*, protocol /, ''), tools: s.lines.find((l) => /^\d+ tools:/.test(l)), askRunStatus: askStatus } };
      });
    }
  }

  const passed = checks.filter((c) => c.pass).length;
  writeEvidence('verify.json', { verifiedAt: new Date().toISOString(), app: APP_ORIGIN, mcp: `${MCP_ORIGIN}/mcp`, passed, failed: checks.length - passed, checks, smokes });
  console.log(`\n${passed}/${checks.length} checks passed.`);
  if (passed !== checks.length) process.exitCode = 1;
}
