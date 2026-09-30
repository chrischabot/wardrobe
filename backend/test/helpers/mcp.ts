import { exports } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client-v2-2';
import { b64urlEncode, randomToken } from '../../src/auth/jose.js';
import { call, ORIGIN } from './api.js';

/**
 * A real OAuth 2.1 + PKCE grant against the Worker's own authorization server, and a real MCP SDK
 * client (@modelcontextprotocol/client 2.2.0) whose HTTP requests go to the Worker fetch handler.
 */

export const MCP_URL = `${ORIGIN}/mcp`;

export const CLIENTS = {
  claude: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
  chatgpt: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
  local: { client_name: 'Local test client', redirect_uris: ['http://127.0.0.1:33418/callback'] },
} as const;

export interface Grant {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresIn: number;
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

/** Opens the consent page as the owner (Access assertion); returns the page and its form fields. */
export async function openConsent(assertion: string, client: { clientId: string; redirectUri: string }, scope: string, extra: Record<string, string> = {}) {
  const verifier = randomToken(48);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
    state: `st-${crypto.randomUUID()}`,
    scope,
    resource: MCP_URL,
    ...extra,
  });
  const res = await call(`/authorize?${params}`, { assertion });
  const page = await res.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1]?.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n))) ?? '';
  return { res, page, verifier, state: params.get('state')!, cookie: cookiesFrom(res), handle: field('handle'), owner: field('owner') };
}

export async function approveConsent(assertion: string, consent: Awaited<ReturnType<typeof openConsent>>, scopes: string[], decision: 'approve' | 'deny' = 'approve'): Promise<Response> {
  const form = new URLSearchParams({ handle: consent.handle, owner: consent.owner, decision });
  for (const s of scopes) form.append('scope', s);
  return call('/authorize', { assertion, body: form, headers: { cookie: consent.cookie } });
}

export async function exchangeCode(client: { clientId: string; redirectUri: string }, code: string, verifier: string): Promise<Response> {
  return call('/oauth/token', { body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: verifier, resource: MCP_URL }) });
}

export async function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return call('/oauth/token', { body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: MCP_URL }) });
}

/** The complete consumer flow: register, consent as the owner, exchange the code with PKCE. */
export async function mcpGrant(assertion: string, kind: keyof typeof CLIENTS, scopes: string[] = ['wardrobe:read', 'wardrobe:write']): Promise<Grant> {
  const client = await registerClient(kind);
  const consent = await openConsent(assertion, client, 'wardrobe:read wardrobe:write');
  if (consent.res.status !== 200) throw new Error(`consent page ${consent.res.status}: ${consent.page.slice(0, 300)}`);
  const approved = await approveConsent(assertion, consent, scopes);
  const location = approved.headers.get('location');
  if (approved.status !== 302 || !location) throw new Error(`approval failed ${approved.status}: ${(await approved.text()).slice(0, 300)}`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error(`no code in ${location}`);
  const tokenRes = await exchangeCode(client, code, consent.verifier);
  const t = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number };
  if (tokenRes.status !== 200) throw new Error(`token exchange ${tokenRes.status} ${JSON.stringify(t)}`);
  return { clientId: client.clientId, accessToken: t.access_token, refreshToken: t.refresh_token, scope: t.scope, expiresIn: t.expires_in, redirectUri: client.redirectUri };
}

/** fetch that sends the SDK's HTTP requests to this Worker's fetch handler. */
export const workerFetch = ((input: RequestInfo | URL, init?: RequestInit) => exports.default.fetch(new Request(input as RequestInfo, init))) as typeof fetch;

export interface ConnectedClient {
  client: Client;
  requests: Request[];
  close: () => Promise<void>;
}

/** A real MCP SDK client, negotiating the 2026-07-28 revision (or the legacy 2025 handshake). */
export async function connectMcp(token: string, opts: { mode?: 'modern' | 'legacy'; onElicit?: (params: Record<string, unknown>) => Record<string, unknown> } = {}): Promise<ConnectedClient> {
  const requests: Request[] = [];
  const recordingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    requests.push(req.clone());
    return exports.default.fetch(req);
  }) as typeof fetch;
  const client = new Client(
    { name: 'garderobe-integration-test', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: opts.mode === 'legacy' ? { mode: 'legacy' } : { mode: { pin: '2026-07-28' } },
    },
  );
  client.setRequestHandler('elicitation/create', async (req: { params: Record<string, unknown> }) => (opts.onElicit ? opts.onElicit(req.params) : { action: 'decline' }) as never);
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: recordingFetch, authProvider: { token: async () => token } } as never);
  await client.connect(transport as never);
  return { client, requests, close: () => client.close() };
}
