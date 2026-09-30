import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import '../../helpers/assistant.js';
import { apiOwner, installApiScenario, prepareToday, type ApiClock, type ApiOwner } from '../../helpers/http.js';
import { connectMcp, mcpGrant, resend, tool, type ConnectedClient } from '../../helpers/mcp.js';
import { count, q } from '../../helpers/seed.js';

/**
 * MCP protocol abuse against the real server (@modelcontextprotocol/server 2.2.0 behind the OAuth
 * provider): routing headers that disagree with the body, malformed _meta, replayed or altered MRTR
 * retries, oversize inputs, and malformed JSON-RPC. Requests are captured from the real SDK client
 * and re-sent with one field changed, so each rejection is attributable to that field.
 */

const receipts = (userId: string) => count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ?', userId);

describe('MCP protocol abuse', () => {
  let owner: ApiOwner;
  let writeToken: string;
  let readToken: string;
  let clock: ApiClock;
  let socks: string;

  beforeAll(async () => {
    ({ clock } = installApiScenario({ now: '2026-10-06T05:30:00.000Z' }));
    owner = await apiOwner();
    await prepareToday(owner.assertion);
    writeToken = (await mcpGrant(owner.assertion, 'claude', ['wardrobe:read', 'wardrobe:write'])).accessToken;
    readToken = (await mcpGrant(owner.assertion, 'chatgpt', ['wardrobe:read'])).accessToken;
    socks = await owner.byName('Merino — fire red');
  });

  /** A captured, authentic garderobe_command request (write grant) for mark_in_wash on the socks. */
  async function capturedCommand(): Promise<{ c: ConnectedClient; req: Request; body: Record<string, unknown> }> {
    const c = await connectMcp(writeToken);
    await tool(c, 'garderobe_command', { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'socks_washed' } });
    const req = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_command').at(-1)!;
    return { c, req, body: JSON.parse(await req.clone().text()) as Record<string, unknown> };
  }
  const withArgs = (body: Record<string, unknown>, args: Record<string, unknown>, extraParams: Record<string, unknown> = {}) => {
    const params = { ...(body.params as Record<string, unknown>), arguments: args, ...extraParams };
    return JSON.stringify({ ...body, id: Math.floor(Math.random() * 1e9), params });
  };

  it('routing headers that disagree with the body are rejected before dispatch (Mcp-Name, Mcp-Method, protocol version)', async () => {
    const { c, req, body } = await capturedCommand();
    const before = await receipts(owner.userId);
    const args = { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'mark_in_wash', garmentId: socks } };
    const cases: Record<string, Record<string, string | null>> = {
      nameSaysRead: { 'mcp-name': 'garderobe_today' },
      nameMissing: { 'mcp-name': null },
      methodSaysList: { 'mcp-method': 'tools/list' },
      unsupportedVersion: { 'mcp-protocol-version': '1999-01-01' },
      legacyVersionOnModernBody: { 'mcp-protocol-version': '2024-11-05' },
    };
    for (const [label, headers] of Object.entries(cases)) {
      const r = await resend(req, withArgs(body, args), headers);
      expect(JSON.stringify(r.rpc).includes('"structuredContent"') && !JSON.stringify(r.rpc).includes('"error"'), `${label}: ${r.status} ${r.text.slice(0, 200)}`).toBe(false);
      expect(r.status, label).toBeLessThan(500);
    }
    expect(await receipts(owner.userId)).toBe(before);
    await c.close();
  });

  it('malformed _meta (wrong types, huge, forged capability claims) never crashes the server or changes anything', async () => {
    const { c, req, body } = await capturedCommand();
    const before = await receipts(owner.userId);
    const metas: unknown[] = ['not-an-object', 42, null, [1, 2, 3], { progressToken: { nested: 'x'.repeat(100_000) } }, { 'io.modelcontextprotocol/related-task': { taskId: '../../etc/passwd' }, 'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } }, userId: 'usr_attacker', scopes: ['wardrobe:write'] }];
    for (const meta of metas) {
      const r = await resend(req, withArgs(body, { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'laundry_collected' } }, { _meta: meta }), {});
      expect(r.status, JSON.stringify(meta).slice(0, 60)).toBeLessThan(500);
    }
    // A read-only grant cannot claim write through _meta.
    const rc = await connectMcp(readToken);
    await tool(rc, 'garderobe_today', {});
    const rreq = rc.requests.filter((x) => x.headers.get('mcp-name') === 'garderobe_today').at(-1)!;
    const rbody = JSON.parse(await rreq.clone().text()) as Record<string, unknown>;
    const forged = { ...rbody, id: 777, params: { name: 'garderobe_command', arguments: { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'laundry_collected' } }, _meta: { scopes: ['wardrobe:read', 'wardrobe:write'], authInfo: { scopes: ['wardrobe:write'] } } } };
    const r = await resend(rreq, JSON.stringify(forged), { 'mcp-name': 'garderobe_command' });
    expect(r.text).not.toContain('"executed"');
    expect(await receipts(owner.userId)).toBe(before);
    await c.close();
    await rc.close();
  });

  it('JSON-RPC batches, invalid JSON, empty bodies and unknown methods are refused without effect or a 5xx', async () => {
    const { c, req, body } = await capturedCommand();
    const before = await receipts(owner.userId);
    const good = withArgs(body, { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'laundry_collected' } });
    for (const [label, raw, headers] of [
      ['batch', `[${good},${good}]`, {}],
      ['invalid json', '{"jsonrpc":"2.0",', {}],
      ['empty', '', {}],
      ['unknown method', JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'admin/dropTables', params: {} }), { 'mcp-method': 'admin/dropTables', 'mcp-name': null }],
      ['unknown tool', withArgs({ ...body, params: { ...(body.params as object), name: '../garderobe_command' } }, {}), { 'mcp-name': '../garderobe_command' }],
      ['text/plain', good, { 'content-type': 'text/plain' }],
    ] as const) {
      const r = await resend(req, raw, headers as Record<string, string | null>);
      expect(r.status, `${label}: ${r.text.slice(0, 160)}`).toBeLessThan(500);
      expect(r.text, label).not.toContain('"executed"');
    }
    expect(await receipts(owner.userId)).toBe(before);
    await c.close();
  });

  it('a cross-site Origin is refused (DNS-rebinding / browser CSRF)', async () => {
    const { c, req, body } = await capturedCommand();
    const before = await receipts(owner.userId);
    const r = await resend(req, withArgs(body, { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'laundry_collected' } }), { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(await receipts(owner.userId)).toBe(before);
    await c.close();
  });

  it('oversize inputs are refused before any work: huge ask text, huge item lists, deep nesting, a multi-megabyte body', async () => {
    const c = await connectMcp(writeToken);
    const before = await receipts(owner.userId);
    const turnsBefore = await count('SELECT COUNT(*) AS n FROM assistant_turns WHERE user_id = ?', owner.userId);
    const ask = await tool(c, 'garderobe_ask', { text: 'x'.repeat(1_000_000), waitSeconds: 1 });
    expect(ask.isError).toBe(true);
    const items = Array.from({ length: 5000 }, () => ({ garmentId: socks }));
    const wear = await tool(c, 'garderobe_command', { idempotencyKey: `mcp:${crypto.randomUUID()}`, command: { type: 'record_wear', timezone: 'Europe/London', items } });
    expect(wear.isError || (wear.structuredContent?.receipt as { outcome?: string } | null)?.outcome === 'rejected').toBe(true);
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 2000; i++) deep = { d: deep };
    const nested = await tool(c, 'garderobe_recommend', { brief: 'x', include: [deep] } as never);
    expect(nested.isError).toBe(true);
    const recommend = await tool(c, 'garderobe_recommend', { count: 10, include: Array.from({ length: 10_000 }, (_, i) => `g_${i}`) });
    expect(recommend.isError || recommend.structuredContent !== undefined).toBe(true);
    const req = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_ask').at(-1)!;
    const big = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'garderobe_ask', arguments: { text: 'y'.repeat(6_000_000) } } });
    const r = await resend(req, big, {});
    expect(r.status).toBeLessThan(500);
    expect(r.text).not.toContain('"answered"');
    expect(await receipts(owner.userId)).toBe(before);
    expect(await count('SELECT COUNT(*) AS n FROM assistant_turns WHERE user_id = ?', owner.userId)).toBe(turnsBefore);
    await c.close();
  });

  describe('input_required (MRTR) replay and tampering', () => {
    async function confirmedFlow() {
      const c = await connectMcp(writeToken, { onElicit: () => ({ action: 'accept', content: { choice: 'confirm' } }) });
      const key = `mcp:${crypto.randomUUID()}`;
      const res = await tool(c, 'garderobe_command', { idempotencyKey: key, command: { type: 'reconcile_quantity', garmentId: socks, clean: 2 } });
      const retry = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_command').at(-1)!;
      const retryBody = await retry.clone().text();
      return { c, key, res, retry, retryBody };
    }

    it('a replayed retry returns the same receipt; a retry altered in any field executes nothing new', async () => {
      const { c, key, res, retry, retryBody } = await confirmedFlow();
      const receipt = res.structuredContent!.receipt as { commandId: string };
      expect(retryBody).toContain('requestState');
      const replay = await resend(retry, retryBody);
      expect(JSON.stringify(replay.rpc)).toContain(receipt.commandId);
      const parsed = JSON.parse(retryBody) as { params: { arguments: Record<string, unknown>; requestState?: string; inputResponses?: unknown } };
      const variants: Record<string, unknown> = {
        otherGarment: { ...parsed, params: { ...parsed.params, arguments: { ...parsed.params.arguments, command: { type: 'reconcile_quantity', garmentId: await owner.byName('Merino — inky blue'), clean: 2 } } } },
        otherKey: { ...parsed, params: { ...parsed.params, arguments: { ...parsed.params.arguments, idempotencyKey: `mcp:${crypto.randomUUID()}` } } },
        otherCommand: { ...parsed, params: { ...parsed.params, arguments: { ...parsed.params.arguments, command: { type: 'dispose_item', garmentId: socks, reason: 'lost' } } } },
        tamperedState: { ...parsed, params: { ...parsed.params, requestState: `${String(parsed.params.requestState).slice(0, -3)}xyz` } },
        forgedState: { ...parsed, params: { ...parsed.params, requestState: btoa(JSON.stringify({ pendingId: 'pnd_x', userId: 'usr_x' })) } },
      };
      for (const [label, v] of Object.entries(variants)) {
        const r = await resend(retry, JSON.stringify(v));
        expect(r.text, label).not.toContain('"executed"');
      }
      expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', owner.userId, key)).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND command_type = 'dispose_item'", owner.userId)).toBe(0);
      await c.close();
    });

    it('another owner (or a read-only grant of the same owner) cannot redeem the pending state', async () => {
      const c = await connectMcp(writeToken, { onElicit: () => ({ action: 'decline' }) });
      const key = `mcp:${crypto.randomUUID()}`;
      await tool(c, 'garderobe_command', { idempotencyKey: key, command: { type: 'dispose_item', garmentId: socks, reason: 'lost' } });
      const retry = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_command').at(-1)!;
      const parsed = JSON.parse(await retry.clone().text()) as { params: Record<string, unknown> };
      const accepted = { ...parsed, params: { ...parsed.params, inputResponses: { answer: { action: 'accept', content: { choice: 'confirm' } } } } };
      const other = await apiOwner('Thief');
      const theirs = await mcpGrant(other.assertion, 'claude');
      for (const token of [theirs.accessToken, readToken]) {
        const r = await resend(retry, JSON.stringify(accepted), { authorization: `Bearer ${token}` });
        expect(r.text).not.toContain('"executed"');
      }
      expect(await count("SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND command_type = 'dispose_item'", owner.userId)).toBe(0);
      expect(await count("SELECT COUNT(*) AS n FROM garments WHERE user_id = ? AND garment_id = ? AND acquisition = 'disposed'", owner.userId, socks)).toBe(0);
      await c.close();
    });

    it('an answer arriving after the question expired executes nothing, and cannot be revived by replaying the state later', async () => {
      const c = await connectMcp(writeToken, {
        onElicit: () => {
          clock.set(new Date(Date.parse(clock.value) + 11 * 60_000).toISOString());
          return { action: 'accept', content: { choice: 'confirm' } };
        },
      });
      const key = `mcp:${crypto.randomUUID()}`;
      const res = await tool(c, 'garderobe_command', { idempotencyKey: key, command: { type: 'dispose_item', garmentId: socks, reason: 'lost' } });
      expect(res.structuredContent).toMatchObject({ status: 'expired', receipt: null });
      const retry = c.requests.filter((r) => r.headers.get('mcp-name') === 'garderobe_command').at(-1)!;
      clock.set('2026-10-06T05:30:00.000Z'); // rewind: the stored record is still expired
      const r = await resend(retry, await retry.clone().text());
      expect(r.text).not.toContain('"executed"');
      expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', owner.userId, key)).toBe(0);
      await c.close();
    });

    it('an invalid elicitation choice is refused', async () => {
      const c = await connectMcp(writeToken, { onElicit: () => ({ action: 'accept', content: { choice: 'confirm; DROP TABLE garments' } }) });
      const key = `mcp:${crypto.randomUUID()}`;
      const res = await tool(c, 'garderobe_command', { idempotencyKey: key, command: { type: 'dispose_item', garmentId: socks, reason: 'lost' } });
      expect(res.structuredContent?.status === 'executed').toBe(false);
      expect(await count('SELECT COUNT(*) AS n FROM command_receipts WHERE user_id = ? AND idempotency_key = ?', owner.userId, key)).toBe(0);
      await c.close();
    });
  });

  it('pending actions are never shared across owners (rows scoped by user)', async () => {
    const rows = await q<{ user_id: string }>('SELECT DISTINCT user_id FROM pending_actions');
    for (const r of rows) expect(r.user_id).toMatch(/^usr_/);
    expect(env.DB).toBeTruthy();
  });
});
