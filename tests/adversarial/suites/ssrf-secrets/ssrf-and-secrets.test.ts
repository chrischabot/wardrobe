import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { FakeMcpServer, MemoryCredentialStore, installTestConnectors, connectionRegistry, safeFetch, UrlPolicyError, validateOutboundUrl, redactSecrets, redactDeep } from '../../../../backend/src/connectors/index.js';
import { exportOwnerData } from '../../../../backend/src/export/index.js';
import { apiOwner, callJson, installApiScenario, type ApiOwner } from '../../helpers/http.js';
import { connectMcp, mcpGrant, tool } from '../../helpers/mcp.js';
import { count, q } from '../../helpers/seed.js';
import { knownDefect } from '../../helpers/defects.js';

/**
 * SSRF through outbound MCP registration and research URLs, and secret leakage through records,
 * errors, receipts, run events and exports. Everything stays local: FakeMcpServer stands in for remote
 * MCP servers and a fetch double for the network; no external host is contacted.
 */

const BLOCKED = [
  'https://localhost/mcp', 'https://LOCALHOST./mcp', 'https://localhost.localdomain/', 'https://127.0.0.1/', 'https://127.1/', 'https://127.000.000.001/',
  'https://2130706433/', 'https://0x7f000001/', 'https://0x7f.1/', 'https://0177.0.0.01/', 'https://0/', 'https://0.0.0.0/',
  'https://10.0.0.1/', 'https://172.16.0.1/', 'https://172.31.255.255/', 'https://192.168.0.1/', 'https://100.100.100.200/',
  'https://169.254.169.254/latest/meta-data/iam/', 'https://169.254.170.2/v2/credentials', 'https://metadata.google.internal/', 'https://metadata/', 'https://instance-data/',
  'https://[::1]/', 'https://[::]/', 'https://[0:0:0:0:0:0:0:1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[0:0:0:0:0:ffff:7f00:1]/',
  'https://[fc00::1]/', 'https://[fd12:3456::1]/', 'https://[fe80::1]/', 'https://[ff02::1]/', 'https://[fd00:ec2::254]/',
  'https://198.18.0.1/', 'https://224.0.0.1/', 'https://255.255.255.255/', 'https://192.0.0.8/',
  'https://printer.local/', 'https://nas.lan/', 'https://svc.corp/', 'https://router.home.arpa/', 'https://intranet/',
  'http://mcp.example.com/', 'ftp://mcp.example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'data:text/plain,hi', 'javascript:alert(1)',
  'https://user:pass@mcp.example.com/', 'https://:token@mcp.example.com/', 'https://127。0。0。1/', 'https://１２７.0.0.1/',
];

describe('outbound URL policy', () => {
  it('blocks loopback, private, link-local, metadata, internal names and credentialed or non-HTTPS URLs in every encoding', () => {
    const allowed: string[] = [];
    for (const u of BLOCKED) {
      try {
        validateOutboundUrl(u);
        allowed.push(u);
      } catch (e) {
        expect(e, u).toBeInstanceOf(UrlPolicyError);
      }
    }
    expect(allowed).toEqual([]);
    expect(validateOutboundUrl('https://mcp.exa.ai/mcp').hostname).toBe('mcp.exa.ai');
  });

  // ADV-10 (DEFECTS.md): IPv6 forms that embed an IPv4 address other than ::ffff:a.b.c.d are not recognised.
  it('[ADV-10] IPv6 transition forms embedding loopback or metadata (NAT64, IPv4-compatible, 6to4) are blocked', async () => {
    for (const u of ['https://[64:ff9b::7f00:1]/', 'https://[64:ff9b::a9fe:a9fe]/', 'https://[::7f00:1]/', 'https://[2002:7f00:1::]/', 'https://[2002:a9fe:a9fe::]/']) {
      expect(() => validateOutboundUrl(u), u).toThrow(UrlPolicyError);
    }
  });

  it('safeFetch re-validates every redirect hop: absolute, protocol-relative, relative-to-internal and credentialed redirects', async () => {
    const hops: Record<string, string> = {
      'https://shop.example.com/a': 'http://169.254.169.254/latest/meta-data/',
      'https://shop.example.com/b': '//127.0.0.1/admin',
      'https://shop.example.com/c': 'https://[::ffff:7f00:1]/',
      'https://shop.example.com/d': 'https://user:pw@shop.example.com/x',
      'https://shop.example.com/e': 'https://metadata.google.internal/computeMetadata/v1/',
    };
    const fetcher = (async (u: string) => (hops[u] ? new Response('', { status: 302, headers: { location: hops[u]! } }) : new Response('ok'))) as never;
    for (const start of Object.keys(hops)) await expect(safeFetch(start, { fetch: fetcher }), start).rejects.toThrow(UrlPolicyError);
  });

  it('safeFetch bounds redirect loops', async () => {
    let n = 0;
    const loop = (async () => {
      n++;
      return new Response('', { status: 302, headers: { location: `https://loop.example.com/${n}` } });
    }) as never;
    await expect(safeFetch('https://loop.example.com/0', { fetch: loop })).rejects.toThrow();
    expect(n).toBeLessThan(25);
  });
});

describe('SSRF through the API and MCP', () => {
  let owner: ApiOwner;
  beforeAll(async () => {
    installApiScenario();
    owner = await apiOwner();
  });

  it('POST /v1/connections refuses every internal destination and stores nothing', async () => {
    for (const endpoint of BLOCKED.slice(0, 40)) {
      const r = await callJson('/v1/connections', { assertion: owner.assertion, body: { name: `Probe ${Math.random().toString(36).slice(2, 7)}`, endpoint } });
      expect(r.status, `${endpoint}: ${r.text.slice(0, 120)}`).toBeGreaterThanOrEqual(400);
      expect(r.status, endpoint).toBeLessThan(500);
    }
    expect(await count('SELECT COUNT(*) AS n FROM connections WHERE user_id = ?', owner.userId)).toBe(0);
  });

  it('garderobe_research(product) refuses internal URLs before any fetch', async () => {
    const c = await connectMcp((await mcpGrant(owner.assertion, 'chatgpt', ['wardrobe:read'])).accessToken);
    for (const url of ['http://169.254.169.254/latest/meta-data', 'https://127.0.0.1:8787/v1/today', 'https://[::1]/', 'https://metadata.google.internal/', 'file:///etc/passwd', 'https://localhost:8787/oauth/token']) {
      const r = await tool(c, 'garderobe_research', { kind: 'product', url });
      expect(r.isError || r.structuredContent?.status === 'blocked', `${url}: ${JSON.stringify(r).slice(0, 200)}`).toBe(true);
    }
    expect(await count('SELECT COUNT(*) AS n FROM research_evidence WHERE user_id = ?', owner.userId)).toBe(0);
    await c.close();
  });
});

describe('secret leakage', () => {
  const SECRET = 'tvly-SUPERSECRET-9c1b7e4d2a';

  it('a connector credential never lands in D1, errors, tool results or the export, even when the upstream echoes it', async () => {
    installApiScenario();
    const owner = await apiOwner();
    const creds = new MemoryCredentialStore();
    creds.values.set('env:TAVILY_API_KEY', SECRET);
    const server = new FakeMcpServer([{ name: 'tavily_search', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } }], (_n, args) => {
      if (args.query === 'boom') throw new Error(`401 invalid key ${SECRET} (Authorization: Bearer ${SECRET})`);
      return { echoed: `key=${SECRET}`, results: [] };
    });
    installTestConnectors({ clientFactory: server.factory, credentials: creds });
    try {
      const reg = connectionRegistry(env as never, owner.principal);
      const c = await reg.add({ name: 'Tavily', endpoint: 'https://mcp.tavily.com/mcp/', credentialRef: 'env:TAVILY_API_KEY', credentialPlacement: { type: 'query', param: 'tavilyApiKey' } });
      await reg.discover(c.connectionId);
      const ok = await reg.call(c.connectionId, 'tavily_search', { query: 'loden' });
      const bad = await reg.call(c.connectionId, 'tavily_search', { query: 'boom' });
      expect(JSON.stringify(ok)).not.toContain(SECRET);
      expect(JSON.stringify(bad)).not.toContain(SECRET);
      const listed = await callJson('/v1/connections', { assertion: owner.assertion });
      expect(listed.text).not.toContain(SECRET);
      const pkg = await exportOwnerData(env.DB, owner.principal);
      expect(JSON.stringify(pkg)).not.toContain(SECRET);
      // Full-database scan: no table, no column, anywhere, holds the secret.
      const tables = await q<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
      const hits: string[] = [];
      for (const { name } of tables) {
        const rows = await q(`SELECT * FROM "${name}"`).catch(() => []);
        if (JSON.stringify(rows).includes(SECRET) || JSON.stringify(rows).includes('SUPERSECRET')) hits.push(name);
      }
      expect(hits).toEqual([]);
    } finally {
      installTestConnectors(null);
    }
  });

  it('the redactor removes known secrets and credential formats nested anywhere in a value', () => {
    const v = redactDeep({ a: [`Bearer ${SECRET}`, { url: `https://x.example/?api_key=${SECRET}&token=abc123def456` }], b: `sk-proj-ABCDEFGHIJKLMNOPQRSTUV`, c: 'ya29.a0AfH6SMBxxxxxxxxxxxxxxxxx' }, [SECRET]);
    const s = JSON.stringify(v);
    expect(s).not.toContain(SECRET);
    expect(s).not.toMatch(/sk-proj-ABCDEF|ya29\.a0AfH6/);
    expect(redactSecrets(`error for ${SECRET.toUpperCase()}`, [SECRET])).toBeTruthy();
  });

  it('no API or MCP response carries the Access key, media signing key, MCP state secret or OAuth tokens of other grants', async () => {
    installApiScenario();
    const owner = await apiOwner();
    const other = await mcpGrant(owner.assertion, 'claude');
    const mine = await mcpGrant(owner.assertion, 'chatgpt', ['wardrobe:read']);
    const bodies: string[] = [];
    for (const path of ['/v1/settings', '/v1/connections', '/v1/style/current', '/v1/auth/session', '/v1/receipts?limit=50', '/v1/wardrobe?limit=5']) bodies.push((await callJson(path, { assertion: owner.assertion })).text);
    const c = await connectMcp(mine.accessToken);
    bodies.push(JSON.stringify(await tool(c, 'garderobe_today', {})));
    bodies.push(JSON.stringify(await c.client.listTools()));
    await c.close();
    const all = bodies.join('\n');
    const priv = JSON.parse(env.TEST_ACCESS_PRIVATE_JWK!) as { d: string };
    expect(all).not.toContain(priv.d.slice(0, 24));
    expect(all).not.toContain('garderobe-local-development-only-media-signing-key');
    expect(all).not.toContain(other.accessToken);
    expect(all).not.toContain(other.refreshToken);
    expect(all).not.toContain(mine.refreshToken);
  });
});
