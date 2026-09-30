import { exports } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client-v2-2';
import { b64urlEncode, randomToken } from '../../../backend/src/auth/jose.js';
import { call, ORIGIN } from './http.js';

/**
 * Connected assistants: a real OAuth 2.1 + PKCE grant against the Worker's own authorization server
 * (@cloudflare/workers-oauth-provider), consented as the owner through the Access-protected page,
 * and a real MCP SDK client (@modelcontextprotocol/client 2.2.0) whose requests go to the Worker.
 */

export const MCP_URL = `${ORIGIN}/mcp`;

export const CLIENTS = {
  claude: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
  chatgpt: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
} as const;

export interface Grant {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  redirectUri: string;
}

async function s256(verifier: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

function cookiesFrom(res: Response): string {
  const all = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return all
    .filter(Boolean)
    .map((c) => c.split(';')[0]!)
    .join('; ');
}

export async function registerClient(kind: keyof typeof CLIENTS): Promise<{ clientId: string; redirectUri: string }> {
  const res = await call('/oauth/register', { body: { ...CLIENTS[kind], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } });
  const body = (await res.json()) as { client_id: string };
  if (res.status !== 201) throw new Error(`registration failed ${res.status} ${JSON.stringify(body)}`);
  return { clientId: body.client_id, redirectUri: CLIENTS[kind].redirect_uris[0] };
}

export async function openConsent(assertion: string, client: { clientId: string; redirectUri: string }, scope: string) {
  const verifier = randomToken(48);
  const params = new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: client.redirectUri, code_challenge: await s256(verifier), code_challenge_method: 'S256', state: `st-${crypto.randomUUID()}`, scope, resource: MCP_URL });
  const res = await call(`/authorize?${params}`, { assertion });
  const page = await res.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1]?.replace(/&#(\d+);/g, (_, x: string) => String.fromCharCode(Number(x))) ?? '';
  return { res, page, verifier, cookie: cookiesFrom(res), handle: field('handle'), owner: field('owner') };
}

/** The complete consumer flow from a phone browser: register, consent as the owner, exchange the code with PKCE. */
export async function connectAssistant(assertion: string, kind: keyof typeof CLIENTS, scopes: string[] = ['wardrobe:read', 'wardrobe:write']): Promise<Grant & { consentPage: string }> {
  const client = await registerClient(kind);
  const consent = await openConsent(assertion, client, 'wardrobe:read wardrobe:write');
  if (consent.res.status !== 200) throw new Error(`consent page ${consent.res.status}: ${consent.page.slice(0, 300)}`);
  const form = new URLSearchParams({ handle: consent.handle, owner: consent.owner, decision: 'approve' });
  for (const s of scopes) form.append('scope', s);
  const approved = await call('/authorize', { assertion, body: form, headers: { cookie: consent.cookie } });
  const location = approved.headers.get('location');
  if (approved.status !== 302 || !location) throw new Error(`approval failed ${approved.status}: ${(await approved.text()).slice(0, 300)}`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error(`no code in ${location}`);
  const tokenRes = await call('/oauth/token', { body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: consent.verifier, resource: MCP_URL }) });
  const t = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };
  if (tokenRes.status !== 200) throw new Error(`token exchange ${tokenRes.status} ${JSON.stringify(t)}`);
  return { clientId: client.clientId, accessToken: t.access_token, refreshToken: t.refresh_token, scope: t.scope, redirectUri: client.redirectUri, consentPage: consent.page };
}

export async function refreshGrant(clientId: string, refreshToken: string): Promise<Response> {
  return call('/oauth/token', { body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: MCP_URL }) });
}

export type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };

export interface Mcp {
  client: Client;
  tool: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}

/** A real MCP SDK client negotiating the 2026-07-28 revision. */
export async function connectMcp(token: string): Promise<Mcp> {
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => exports.default.fetch(new Request(input as RequestInfo, init))) as typeof fetch;
  const client = new Client({ name: 'garderobe-journeys', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } } as never);
  client.setRequestHandler('elicitation/create' as never, (async () => ({ action: 'decline' })) as never);
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: fetcher, authProvider: { token: async () => token } } as never);
  await client.connect(transport as never);
  return {
    client,
    tool: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as ToolResult,
    close: () => client.close(),
  };
}

/** One MCP request with a raw bearer (for revoked-grant checks where the SDK would throw). */
export async function rawMcpStatus(token: string): Promise<number> {
  const res = await call('/mcp', {
    bearer: token,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
  });
  await res.body?.cancel();
  return res.status;
}
