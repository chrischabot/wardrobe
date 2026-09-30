/**
 * Where the simulation runs and how it authenticates.
 *  - local: `wrangler dev --local` with the config from scripts/setup-local.ts; app requests carry a
 *    local Access assertion signed with the run's own key (the Worker verifies it like real Access).
 *  - dev: https://garderobe-dev.chabot.dev and https://garderobe-dev-mcp.chabot.dev; app requests
 *    carry the `garderobe-dev-automation-sim` Access service token (Cloudflare Access at the edge,
 *    then the Worker's own verification and the audited identity link to the simulation owner).
 * MCP always goes through the real inbound OAuth flow (registration, Access-protected consent, PKCE
 * S256 code exchange) and the real MCP SDK client, with the access token refreshed before it expires.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client-v2-2';
import { accessClaims, signRs256Jwt } from '../../../backend/src/auth/dev.js';
import { APP_ORIGIN, MCP_ORIGIN, readState, type ServiceTokenState } from '../../../deploy/scripts/lib.js';
import { SIM_HEADER } from './sim-state.js';

export interface Target {
  kind: 'local' | 'dev';
  appOrigin: string;
  mcpOrigin: string;
  simSecret: string;
  userId: string;
  /** Headers that authenticate an app/API request as the simulation owner. */
  appHeaders(): Promise<Record<string, string>>;
}

export function resolveTarget(kind: 'local' | 'dev'): Target {
  if (kind === 'local') {
    const file = join(process.env.GARDEROBE_SIM_WORKDIR ?? join(tmpdir(), 'garderobe-simulation'), 'local-target.json');
    if (!existsSync(file)) throw new Error(`No ${file}: run npx tsx tests/simulation/scripts/setup-local.ts first`);
    const t = JSON.parse(readFileSync(file, 'utf8')) as { baseUrl: string; simSecret: string; accessKeyFile: string; issuer: string; audience: string; subject: string; userId: string };
    const jwk = JSON.parse(readFileSync(t.accessKeyFile, 'utf8')) as JsonWebKey & { kid: string };
    return {
      kind,
      appOrigin: t.baseUrl,
      mcpOrigin: t.baseUrl,
      simSecret: t.simSecret,
      userId: t.userId,
      appHeaders: async () => ({ 'cf-access-jwt-assertion': await signRs256Jwt(jwk, accessClaims({ issuer: t.issuer, audience: t.audience, subject: t.subject, email: 'simulation@localhost', ttlSeconds: 3600 })) }),
    };
  }
  const token = readState<ServiceTokenState>('access-service-token-sim.json');
  const secret = readState<{ secret: string }>('dev-sim-secret.json');
  const owner = readState<{ userId: string }>('simulation-owner.json');
  if (!token || !secret || !owner) throw new Error('No simulation state in deploy/.state: run npx tsx tests/simulation/scripts/setup-dev.ts first');
  return { kind, appOrigin: APP_ORIGIN, mcpOrigin: MCP_ORIGIN, simSecret: secret.secret, userId: owner.userId, appHeaders: async () => ({ 'cf-access-client-id': token.clientId, 'cf-access-client-secret': token.clientSecret }) };
}

export interface HttpResult {
  status: number;
  body: any;
  text: string;
  headers: Headers;
  ms: number;
}

export async function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResult> {
  const t0 = Date.now();
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: init.method ?? 'GET', headers: { 'user-agent': 'garderobe-simulation/1', ...(init.headers ?? {}) }, body: init.body, redirect: 'manual' });
      const text = await res.text();
      let body: any = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* html or text */
      }
      if (res.status >= 502 && res.status <= 504 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return { status: res.status, body, text, headers: res.headers, ms: Date.now() - t0 };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');

export interface Grant {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  obtainedAt: number;
  expiresIn: number;
}

/** The consumer OAuth flow: dynamic registration, consent as the owner (Access), PKCE S256 code exchange. */
export async function oauthGrant(target: Target, simHeader: () => Promise<string>): Promise<Grant> {
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await http(`${target.mcpOrigin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude (garderobe simulation)', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  if (reg.status !== 201 && reg.status !== 200) throw new Error(`OAuth registration ${reg.status}: ${reg.text.slice(0, 200)}`);
  const clientId = reg.body.client_id as string;
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'simulation', scope: 'wardrobe:read wardrobe:write', resource: `${target.mcpOrigin}/mcp` });
  const auth = await target.appHeaders();
  const page = await http(`${target.mcpOrigin}/authorize?${params}`, { headers: { ...auth, [SIM_HEADER]: await simHeader() } });
  if (page.status !== 200) throw new Error(`consent page ${page.status}: ${page.text.slice(0, 200)}`);
  const field = (n: string) => (new RegExp(`name="${n}" value="([^"]*)"`).exec(page.text)?.[1] ?? '').replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c))).replace(/&amp;/g, '&');
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const form = new URLSearchParams({ handle: field('handle'), owner: field('owner'), decision: 'approve' });
  form.append('scope', 'wardrobe:read');
  form.append('scope', 'wardrobe:write');
  const approved = await http(`${target.mcpOrigin}/authorize`, { method: 'POST', headers: { ...auth, cookie, 'content-type': 'application/x-www-form-urlencoded', origin: target.mcpOrigin, [SIM_HEADER]: await simHeader() }, body: form.toString() });
  const code = new URL(approved.headers.get('location') ?? 'x:/').searchParams.get('code');
  if (!code) throw new Error(`consent approval ${approved.status}: ${approved.text.slice(0, 200)}`);
  const t = await http(`${target.mcpOrigin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: `${target.mcpOrigin}/mcp` }).toString() });
  if (t.status !== 200) throw new Error(`token exchange ${t.status}: ${t.text.slice(0, 200)}`);
  return { clientId, accessToken: t.body.access_token, refreshToken: t.body.refresh_token, scope: t.body.scope, obtainedAt: Date.now(), expiresIn: t.body.expires_in ?? 900 };
}

export async function refreshGrant(target: Target, g: Grant): Promise<Grant> {
  const t = await http(`${target.mcpOrigin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: g.refreshToken, client_id: g.clientId, resource: `${target.mcpOrigin}/mcp` }).toString() });
  if (t.status !== 200) throw new Error(`token refresh ${t.status}: ${t.text.slice(0, 200)}`);
  return { ...g, accessToken: t.body.access_token, refreshToken: t.body.refresh_token ?? g.refreshToken, scope: t.body.scope ?? g.scope, obtainedAt: Date.now(), expiresIn: t.body.expires_in ?? 900 };
}

export type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content: { type: string; text?: string }[] };

export interface ToolCall {
  tool: string;
  ms: number;
  isError: boolean;
  error?: string;
}

/** A real MCP SDK client (2026-07-28) whose every request carries the current signed simulation header. */
export class McpSession {
  private client: Client | null = null;
  readonly calls: ToolCall[] = [];
  refreshes = 0;
  protocol: string | null = null;

  constructor(
    private readonly target: Target,
    private grant: Grant,
    private readonly simHeader: () => Promise<string>,
    private readonly onElicitation: (params: unknown) => { action: 'accept' | 'decline'; content?: Record<string, unknown> },
  ) {}

  private async token(): Promise<string> {
    if (Date.now() - this.grant.obtainedAt > (this.grant.expiresIn - 180) * 1000) {
      this.grant = await refreshGrant(this.target, this.grant);
      this.refreshes++;
    }
    return this.grant.accessToken;
  }

  async connect(): Promise<void> {
    const client = new Client({ name: 'garderobe-simulation', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } } as never);
    client.setRequestHandler('elicitation/create' as never, (async (req: { params?: unknown }) => this.onElicitation(req?.params)) as never);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set(SIM_HEADER, await this.simHeader());
      return fetch(input, { ...init, headers });
    }) as typeof fetch;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${this.target.mcpOrigin}/mcp`), { fetch: fetcher, authProvider: { token: () => this.token() } } as never) as never);
    this.client = client;
    this.protocol = (client as unknown as { getNegotiatedProtocolVersion?: () => string }).getNegotiatedProtocolVersion?.() ?? '2026-07-28 (pinned)';
  }

  async tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.client) await this.connect();
    const t0 = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const r = (await this.client!.callTool({ name, arguments: args })) as ToolResult;
        this.calls.push({ tool: name, ms: Date.now() - t0, isError: Boolean(r.isError), ...(r.isError ? { error: r.content.map((c) => c.text ?? '').join(' ').slice(0, 300) } : {}) });
        return r;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Transient transport failures and an expired token: reconnect once or twice, then report.
        if (attempt < 2 && /fetch failed|ECONNRESET|socket|502|503|504|401|timed out/i.test(message)) {
          if (/401/.test(message)) {
            this.grant = await refreshGrant(this.target, this.grant);
            this.refreshes++;
          }
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          await this.connect();
          continue;
        }
        this.calls.push({ tool: name, ms: Date.now() - t0, isError: true, error: message.slice(0, 300) });
        return { isError: true, content: [{ type: 'text', text: `client error: ${message}` }] };
      }
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }
}
