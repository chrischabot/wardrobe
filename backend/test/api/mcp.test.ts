import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { CommandReceipt, SettingsResponse, TodayResponse } from '@garderobe/contracts';
import '../helpers/assistant.js';
import { apiOwner, call, callJson, idem, installApiScenario, prepareToday, type ApiClock } from '../helpers/api.js';
import { approveConsent, connectMcp, exchangeCode, MCP_URL, mcpGrant, openConsent, refresh, registerClient } from '../helpers/mcp.js';

/**
 * The inbound MCP server driven by the real MCP TypeScript SDK client (@modelcontextprotocol/client
 * 2.2.0) over HTTP into the Worker, with real OAuth grants from @cloudflare/workers-oauth-provider.
 */

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };

describe('MCP server (2026-07-28) on the owner’s data', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;
  let clock: ApiClock;
  let writeToken: string;
  let readToken: string;
  const q = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;

  beforeAll(async () => {
    ({ clock } = installApiScenario({ now: '2026-10-06T05:30:00.000Z', scenario: 'mild' }));
    owner = await apiOwner();
    a = owner.assertion;
    await prepareToday(a);
    writeToken = (await mcpGrant(a, 'claude', ['wardrobe:read', 'wardrobe:write'])).accessToken;
    readToken = (await mcpGrant(a, 'chatgpt', ['wardrobe:read'])).accessToken;
  });

  it('negotiates 2026-07-28 and lists exactly seven tools with output schemas and grant-accurate annotations', async () => {
    const w = await connectMcp(writeToken);
    expect(w.client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const tools = (await w.client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['garderobe_ask', 'garderobe_command', 'garderobe_inventory', 'garderobe_recommend', 'garderobe_research', 'garderobe_run', 'garderobe_today']);
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations, t.name).toBeTruthy();
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations!]));
    expect(by.garderobe_today).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(by.garderobe_inventory).toMatchObject({ readOnlyHint: true });
    expect(by.garderobe_command).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(by.garderobe_ask).toMatchObject({ readOnlyHint: false });
    expect(by.garderobe_research).toMatchObject({ openWorldHint: true });
    // No tool accepts an owner: the input schemas have no owner or user property anywhere.
    expect(JSON.stringify(tools.map((t) => t.inputSchema))).not.toMatch(/"(userId|ownerId|owner|user)":/);
    await w.close();

    const r = await connectMcp(readToken);
    const rt = Object.fromEntries((await r.client.listTools()).tools.map((t) => [t.name, t.annotations!]));
    expect(rt.garderobe_command).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(rt.garderobe_ask).toMatchObject({ readOnlyHint: true });
    await r.close();
  });

  it('garderobe_today returns the same board revision as GET /v1/today', async () => {
    const c = await connectMcp(writeToken);
    const res = (await c.client.callTool({ name: 'garderobe_today', arguments: {} })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const viaMcp = TodayResponse.parse(res.structuredContent);
    const viaHttp = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
    expect(viaMcp.board!.boardId).toBe(viaHttp.board!.boardId);
    expect(viaMcp.board!.currentRevision).toBe(viaHttp.board!.currentRevision);
    expect(viaMcp.board!.options.map((o) => o.optionId)).toEqual(viaHttp.board!.options.map((o) => o.optionId));
    expect(viaMcp.dayLine).toBe(viaHttp.dayLine);
    expect(res.content[0]!.text).toContain(viaHttp.dayLine!);
    await c.close();
  });

  it('garderobe_inventory reads a complete snapshot with explicit completeness, pages, items and phrases', async () => {
    const c = await connectMcp(readToken);
    const snap = (await c.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'snapshot' } })) as ToolResult;
    expect(snap.structuredContent).toMatchObject({ view: 'snapshot', complete: true, total: 144 });
    expect((snap.structuredContent!.items as unknown[]).length).toBe(144);
    const page = (await c.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'items', category: 'socks', limit: 5 } })) as ToolResult;
    expect(page.structuredContent).toMatchObject({ complete: false, nextCursor: '5' });
    const alias = (await q("SELECT phrase, garment_id FROM garment_aliases WHERE user_id = ? AND kind = 'maker_code' LIMIT 1", owner.userId))[0]!;
    const resolved = (await c.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'resolve', phrase: String(alias.phrase) } })) as ToolResult;
    expect((resolved.structuredContent!.resolution as { status: string }).status).not.toBe('not_found');
    const item = (await c.client.callTool({ name: 'garderobe_inventory', arguments: { view: 'item', garmentId: String(alias.garment_id) } })) as ToolResult;
    expect(((item.structuredContent!.item as { item: { garment: { garmentId: string } } }).item.garment.garmentId)).toBe(alias.garment_id);
    await c.close();
  });

  it('garderobe_recommend returns validated options for a brief without touching the prepared board', async () => {
    const c = await connectMcp(readToken);
    const before = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body).board!.currentRevision;
    const res = (await c.client.callTool({ name: 'garderobe_recommend', arguments: { date: '2026-10-07', count: 3, brief: 'Client lunch, then the office' } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { options: { valid: boolean; slots: { role: string }[] }[]; document: { requestedCount: number } };
    expect(out.options.length).toBeGreaterThan(0);
    expect(out.options.length).toBeLessThanOrEqual(3);
    for (const o of out.options) {
      expect(o.valid).toBe(true);
      expect(o.slots.some((s) => s.role === 'socks')).toBe(true);
    }
    expect(TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body).board!.currentRevision).toBe(before);
    await c.close();
  });

  describe('garderobe_command', () => {
    let shirt: string;
    beforeAll(async () => {
      const t = TodayResponse.parse((await callJson('/v1/today', { assertion: a })).body);
      shirt = t.board!.options[0]!.slots.find((s) => s.role === 'base_top')!.garmentId;
    });

    it('a write grant executes under the command policy and shares idempotency with the HTTP API', async () => {
      const c = await connectMcp(writeToken);
      const key = idem('mcp');
      const command = { type: 'record_wear', timezone: 'Europe/London', wearingDate: '2026-10-06', items: [{ garmentId: shirt }] };
      const res = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: key, command } })) as ToolResult;
      expect(res.isError).toBeFalsy();
      const receipt = CommandReceipt.parse(res.structuredContent!.receipt);
      expect(receipt.outcome).toBe('committed');
      expect(res.structuredContent!.status).toBe('executed');
      // The same key through the native API returns the same receipt (no second effect).
      const viaHttp = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: key, source: 'app', command } })).body);
      expect(viaHttp.commandId).toBe(receipt.commandId);
      expect(viaHttp.replayed).toBe(true);
      // An independent app report of the same garment and date merges into the one counted wear.
      const merged = CommandReceipt.parse((await callJson('/v1/commands', { assertion: a, body: { idempotencyKey: idem(), source: 'app', command } })).body);
      expect(merged.outcome).toBe('merged');
      const rows = await q("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date = '2026-10-06' AND status = 'active'", owner.userId, shirt);
      expect(rows[0]!.n).toBe(1);
      await c.close();
    });

    it('a read-only grant receives a proposal and nothing changes', async () => {
      const c = await connectMcp(readToken);
      const before = (await q('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', owner.userId))[0]!.n;
      const res = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: idem('mcp'), command: { type: 'mark_in_wash', garmentId: shirt } } })) as ToolResult;
      expect(res.structuredContent).toMatchObject({ status: 'proposal', receipt: null });
      expect((await q('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', owner.userId))[0]!.n).toBe(before);
      await c.close();
    });

    it('owner fields and unknown fields in arguments are refused by the schema', async () => {
      const c = await connectMcp(writeToken);
      const forged = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: idem('mcp'), ownerId: 'usr_other', command: { type: 'laundry_collected' } } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))) as ToolResult;
      expect(forged.isError).toBe(true);
      const nested = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: idem('mcp'), command: { type: 'mark_in_wash', garmentId: shirt, userId: 'usr_other' } } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }))) as ToolResult;
      expect(nested.isError).toBe(true);
      await c.close();
    });

    it('another owner’s garment is not found through MCP', async () => {
      const other = await apiOwner();
      const token = (await mcpGrant(other.assertion, 'claude')).accessToken;
      const c = await connectMcp(token);
      const res = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: idem('mcp'), command: { type: 'mark_in_wash', garmentId: shirt } } })) as ToolResult;
      const receipt = CommandReceipt.parse(res.structuredContent!.receipt);
      expect(receipt.outcome).toBe('rejected');
      expect(receipt.error?.code).toBe('not_found');
      await c.close();
    });
  });

  describe('input_required (MRTR) keeps the original command identity', () => {
    let socks: string;
    beforeAll(async () => {
      socks = String((await q("SELECT garment_id FROM garments WHERE user_id = ? AND category = 'socks' AND tracking = 'anonymous_quantity' LIMIT 1", owner.userId))[0]!.garment_id);
    });

    it('asks for confirmation, executes once on the retry, and a replayed retry cannot duplicate the effect', async () => {
      const prompts: string[] = [];
      const c = await connectMcp(writeToken, { onElicit: (p) => (prompts.push(String(p.message)), { action: 'accept', content: { choice: 'confirm' } }) });
      const key = idem('mcp');
      const res = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: key, command: { type: 'reconcile_quantity', garmentId: socks, clean: 1 } } })) as ToolResult;
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('reconcile quantity');
      const receipt = CommandReceipt.parse(res.structuredContent!.receipt);
      expect(receipt.outcome).toBe('committed');
      expect(receipt.idempotencyKey).toBe(key);
      const pending = await q('SELECT status, command_id FROM pending_actions WHERE user_id = ? AND idempotency_key = ?', owner.userId, key);
      expect(pending).toEqual([{ status: 'resolved', command_id: receipt.commandId }]);

      // Replay the exact retry request (same requestState and inputResponses) over raw HTTP.
      const retry = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_command').at(-1)!;
      const retryBody = await retry.clone().text();
      expect(retryBody).toContain('requestState');
      const replayed = await fetchRaw(retry, retryBody);
      const replayResult = JSON.parse(replayed) as { result: { structuredContent: { receipt: { commandId: string; replayed: boolean } } } };
      expect(replayResult.result.structuredContent.receipt.commandId).toBe(receipt.commandId);
      expect(replayResult.result.structuredContent.receipt.replayed).toBe(true);
      expect((await q('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', owner.userId, key))[0]!.n).toBe(1);

      // An altered request carrying that state is refused and changes nothing.
      const altered = retryBody.replace('"clean":1', '"clean":0');
      expect(altered).not.toBe(retryBody);
      const alteredResult = JSON.parse(await fetchRaw(retry, altered)) as { result?: { isError?: boolean; content: { text: string }[] } };
      expect(alteredResult.result?.isError).toBe(true);
      expect(alteredResult.result!.content[0]!.text).toMatch(/request_altered|idempotency/);
      await c.close();
    });

    it('a declined confirmation changes nothing', async () => {
      const c = await connectMcp(writeToken, { onElicit: () => ({ action: 'decline' }) });
      const key = idem('mcp');
      const res = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: key, command: { type: 'reconcile_quantity', garmentId: socks, clean: 0 } } })) as ToolResult;
      expect(res.structuredContent).toMatchObject({ status: 'declined', receipt: null });
      expect((await q('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', owner.userId, key))[0]!.n).toBe(0);
      await c.close();
    });

    it('an expired question executes nothing', async () => {
      const c = await connectMcp(writeToken, {
        onElicit: () => {
          clock.set(new Date(Date.parse(clock.value) + 11 * 60_000).toISOString());
          return { action: 'accept', content: { choice: 'confirm' } };
        },
      });
      const key = idem('mcp');
      const res = (await c.client.callTool({ name: 'garderobe_command', arguments: { idempotencyKey: key, command: { type: 'reconcile_quantity', garmentId: socks, clean: 0 } } })) as ToolResult;
      expect(res.structuredContent).toMatchObject({ status: 'expired', receipt: null });
      expect((await q('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', owner.userId, key))[0]!.n).toBe(0);
      clock.set('2026-10-06T05:30:00.000Z');
      await c.close();
    });

    it('a native answer and the MCP retry resolve the same pending record once', async () => {
      const key = idem('mcp');
      const c = await connectMcp(writeToken, {
        onElicit: () => ({ action: 'accept', content: { choice: 'confirm' } }),
      });
      const res = (await c.client.callTool(
        { name: 'garderobe_command', arguments: { idempotencyKey: key, command: { type: 'reconcile_quantity', garmentId: socks, clean: 2 } } },
      )) as ToolResult;
      // The app answers the same question afterwards: it finds the record resolved and gets the same receipt.
      const pending = (await q('SELECT run_id FROM pending_actions WHERE user_id = ? AND idempotency_key = ?', owner.userId, key))[0]!;
      const answeredNatively = (await callJson<{ status: string; receipt: { commandId: string; replayed: boolean } }>(`/v1/runs/${pending.run_id}/input`, { assertion: a, body: { choiceId: 'confirm' } })).body;
      const receipt = CommandReceipt.parse(res.structuredContent!.receipt);
      expect(answeredNatively).toMatchObject({ status: 'executed', receipt: { commandId: receipt.commandId, replayed: true } });
      const run = (await callJson<{ status: string; pendingAction: { status: string } }>(`/v1/runs/${pending.run_id}`, { assertion: a })).body;
      expect(run).toMatchObject({ status: 'finished', pendingAction: { status: 'resolved' } });
      expect((await q('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', owner.userId, key))[0]!.n).toBe(1);
      await c.close();
    });
  });

  it('garderobe_ask answers through the same assistant; a read-only grant cannot change anything', async () => {
    const c = await connectMcp(readToken);
    const res = (await c.client.callTool({ name: 'garderobe_ask', arguments: { text: 'Which of my oxfords suits a mild day?', waitSeconds: 20 } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { status: string; runId: string; answer: string | null; conversation: string };
    expect(out.status).toBe('answered');
    expect(out.answer).toBeTruthy();
    expect(out.conversation).toMatch(/^cnv_/);
    const run = (await c.client.callTool({ name: 'garderobe_run', arguments: { runId: out.runId } })) as ToolResult;
    expect(run.structuredContent).toMatchObject({ runId: out.runId, status: 'finished' });
    const turn = await q('SELECT intent_json, channel FROM assistant_turns WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', owner.userId);
    expect(turn[0]!.channel).toBe('mcp');
    expect(JSON.parse(String(turn[0]!.intent_json)).grant.scopes).toEqual(['wardrobe:read']);
    const wrongHandle = (await c.client.callTool({ name: 'garderobe_ask', arguments: { text: 'hi', conversation: 'cnv_someone_else' } })) as ToolResult;
    expect(wrongHandle.isError).toBe(true);
    await c.close();
  });

  it('garderobe_research reports honestly when no web capability is connected', async () => {
    const c = await connectMcp(readToken);
    const res = (await c.client.callTool({ name: 'garderobe_research', arguments: { kind: 'product', url: 'https://www.example-shop.com/p/oxford-shirt', size: '16' } })) as ToolResult;
    expect(res.structuredContent).toMatchObject({ kind: 'product', status: 'unresolved' });
    const blocked = (await c.client.callTool({ name: 'garderobe_research', arguments: { kind: 'product', url: 'http://169.254.169.254/latest/meta-data' } })) as ToolResult;
    expect(blocked.structuredContent).toMatchObject({ status: 'blocked' });
    await c.close();
  });

  it('exposes the verbatim style profile as a resource', async () => {
    const c = await connectMcp(readToken);
    const r = await c.client.readResource({ uri: 'garderobe://style/current' });
    const text = (r.contents[0] as { text: string }).text;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(digest.startsWith('e15639d8')).toBe(true);
    await c.close();
  });

  it('the 2025-11-25 compatibility adapter serves the same tools, recorded per connection', async () => {
    const grant = await mcpGrant(a, 'local');
    const c = await connectMcp(grant.accessToken, { mode: 'legacy' });
    expect(c.client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    const tools = (await c.client.listTools()).tools;
    expect(tools).toHaveLength(7);
    const today = (await c.client.callTool({ name: 'garderobe_today', arguments: {} })) as ToolResult;
    expect(TodayResponse.parse(today.structuredContent).board).not.toBeNull();
    await c.close();
    await new Promise((r) => setTimeout(r, 50));
    const rows = await q('SELECT last_protocol FROM mcp_grants WHERE user_id = ? AND client_id = ?', owner.userId, grant.clientId);
    expect(rows[0]!.last_protocol).toBe('2025-11-25');
    const modern = await q("SELECT last_protocol FROM mcp_grants WHERE user_id = ? AND client_kind = 'claude' AND status = 'active'", owner.userId);
    expect(modern[0]!.last_protocol).toBe('2026-07-28');
  });

  it('validates the Mcp-Name routing header against the JSON body', async () => {
    const c = await connectMcp(readToken);
    await c.client.callTool({ name: 'garderobe_today', arguments: {} });
    const req = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_today').at(-1)!;
    const body = await req.clone().text();
    const headers = new Headers(req.headers);
    headers.set('mcp-name', 'garderobe_command');
    const res = await call('/mcp', { method: 'POST', headers: Object.fromEntries(headers), body: JSON.parse(body) });
    const text = await res.text();
    expect(text).toMatch(/"error"/);
    expect(text).not.toContain('structuredContent');
    await c.close();
  });
});

describe('inbound OAuth for Claude and ChatGPT', () => {
  let owner: Awaited<ReturnType<typeof apiOwner>>;
  let a: string;

  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
    a = owner.assertion;
    await prepareToday(a);
  });

  it('publishes protected-resource and authorization-server discovery; unauthenticated MCP gets a challenge', async () => {
    const prm = await callJson<{ resource: string; authorization_servers: string[] }>('/.well-known/oauth-protected-resource/mcp');
    expect(prm.status).toBe(200);
    expect(prm.body.resource).toBe(MCP_URL);
    const as = await callJson<{ issuer: string; code_challenge_methods_supported: string[]; revocation_endpoint: string; scopes_supported: string[] }>('/.well-known/oauth-authorization-server');
    expect(as.body.code_challenge_methods_supported).toContain('S256');
    expect(as.body.scopes_supported).toEqual(['wardrobe:read', 'wardrobe:write']);
    const res = await call('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('the consent page is Access-protected and shows the client, where tokens go and read/write capability', async () => {
    const client = await registerClient('claude');
    const anon = await openConsent('', client, 'wardrobe:read wardrobe:write');
    expect(anon.res.status).toBe(401);
    const consent = await openConsent(a, client, 'wardrobe:read wardrobe:write');
    expect(consent.res.status).toBe(200);
    expect(consent.page).toContain('Claude');
    expect(consent.page).toContain('claude.ai');
    expect(consent.page).toContain('Read your wardrobe');
    expect(consent.page).toContain('Make changes for you');
    expect(consent.res.headers.get('x-frame-options')).toBe('DENY');
    const unknownScope = await openConsent(a, client, 'wardrobe:read admin');
    expect(unknownScope.res.status).toBe(400);
  });

  it('an Access identity alone is not a grant: deny redirects with access_denied and records nothing', async () => {
    const client = await registerClient('chatgpt');
    const consent = await openConsent(a, client, 'wardrobe:read');
    const denied = await approveConsent(a, consent, ['wardrobe:read'], 'deny');
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id = ? AND client_id = ?').bind(owner.userId, client.clientId).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('another signed-in owner cannot approve someone else’s consent transaction', async () => {
    const other = await apiOwner();
    const client = await registerClient('claude');
    const consent = await openConsent(a, client, 'wardrobe:read');
    const hijack = await approveConsent(other.assertion, consent, ['wardrobe:read']);
    expect(hijack.status).toBe(403);
  });

  it('issues 15-minute access tokens with rotating refresh; the owner may grant less than requested', async () => {
    const client = await registerClient('claude');
    const consent = await openConsent(a, client, 'wardrobe:read wardrobe:write');
    const approved = await approveConsent(a, consent, ['wardrobe:read']);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const t = (await (await exchangeCode(client, code, consent.verifier)).json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    expect(t.expires_in).toBe(900);
    expect(t.scope).toBe('wardrobe:read');
    const r1 = (await (await refresh(client.clientId, t.refresh_token)).json()) as { access_token: string; refresh_token: string };
    expect(r1.refresh_token).not.toBe(t.refresh_token);
    const c = await connectMcp(r1.access_token);
    expect((await c.client.listTools()).tools).toHaveLength(7);
    await c.close();
    const wrongVerifier = await exchangeCode(client, code, 'x'.repeat(50));
    expect(wrongVerifier.status).toBe(400);
  });

  it('lists Claude and ChatGPT grants separately, and disconnect revokes immediately (D1 grant check), including refresh', async () => {
    const claude = await mcpGrant(a, 'claude');
    const chatgpt = await mcpGrant(a, 'chatgpt', ['wardrobe:read']);
    const settings = SettingsResponse.parse((await callJson('/v1/settings', { assertion: a })).body);
    const active = settings.connectedAssistants!.filter((g) => g.status === 'active');
    const claudeGrant = active.find((g) => g.clientId === claude.clientId)!;
    const chatgptGrant = active.find((g) => g.clientId === chatgpt.clientId)!;
    expect(claudeGrant).toMatchObject({ client: 'claude', canWrite: true, redirectHost: 'claude.ai' });
    expect(chatgptGrant).toMatchObject({ client: 'chatgpt', canWrite: false, redirectHost: 'chatgpt.com' });
    const connections = (await callJson<{ connections: { kind: string; client: string | null }[] }>('/v1/connections', { assertion: a })).body.connections.filter((x) => x.kind === 'assistant_grant');
    expect(connections.map((x) => x.client)).toEqual(expect.arrayContaining(['claude', 'chatgpt']));

    const c = await connectMcp(claude.accessToken);
    expect((await c.client.callTool({ name: 'garderobe_today', arguments: {} })).isError).toBeFalsy();
    const d = await callJson<{ status: string; remoteRevocation: string }>(`/v1/connections/${claudeGrant.grantId}/disconnect`, { assertion: a, body: {} });
    expect(d.body).toMatchObject({ status: 'disconnected', remoteRevocation: 'revoked' });
    const after = await call('/mcp', { method: 'POST', bearer: claude.accessToken, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    expect(after.status).toBe(401);
    const again = await refresh(claude.clientId, claude.refreshToken);
    expect(again.status).toBe(400);
    // ChatGPT is unaffected.
    const g = await connectMcp(chatgpt.accessToken);
    expect((await g.client.listTools()).tools).toHaveLength(7);
    await g.close();
  });

  it('a revoked D1 grant blocks a still-valid provider token (stale KV cache cannot keep it alive)', async () => {
    const grant = await mcpGrant(a, 'chatgpt');
    await env.DB.prepare("UPDATE mcp_grants SET status = 'revoked', version = version + 1 WHERE user_id = ? AND client_id = ?").bind(owner.userId, grant.clientId).run();
    const res = await call('/mcp', { method: 'POST', bearer: grant.accessToken, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('no longer authorized');
  });

  it('account recovery (grants_valid_after) invalidates every earlier grant', async () => {
    const grant = await mcpGrant(a, 'claude');
    await env.DB.prepare('INSERT INTO identity_security (user_id, grants_valid_after, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET grants_valid_after = excluded.grants_valid_after')
      .bind(owner.userId, new Date(Date.now() + 1000).toISOString(), new Date().toISOString())
      .run();
    const res = await call('/mcp', { method: 'POST', bearer: grant.accessToken, body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
    expect(res.status).toBe(401);
    await env.DB.prepare('DELETE FROM identity_security WHERE user_id = ?').bind(owner.userId).run();
  });

  it('MCP tokens are not app credentials, and app tokens are not MCP credentials', async () => {
    const grant = await mcpGrant(a, 'claude');
    expect((await call('/v1/today', { bearer: grant.accessToken })).status).toBe(401);
    const res = await call('/mcp', { method: 'POST', assertion: a, body: { jsonrpc: '2.0', id: 5, method: 'tools/list' } });
    expect(res.status).toBe(401);
  });
});

/** Re-sends a captured MCP request with a (possibly altered) body through the Worker. */
async function fetchRaw(template: Request, body: string): Promise<string> {
  const headers = Object.fromEntries(template.headers);
  const res = await call('/mcp', { method: 'POST', headers, body: JSON.parse(body) });
  const text = await res.text();
  if (text.startsWith('event:') || text.startsWith('data:') || text.includes('\ndata:')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1)!;
    return data;
  }
  return text;
}
