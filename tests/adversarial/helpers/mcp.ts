import { exports } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client-v2-2';
import { call, ORIGIN, randomVerifier, s256 } from './http.js';

/**
 * Real OAuth 2.1 + PKCE grants against the Worker's own authorization server
 * (@cloudflare/workers-oauth-provider) and a real MCP SDK client (@modelcontextprotocol/client 2.2.0)
 * whose HTTP requests go to the Worker fetch handler.
 */

export const MCP_URL = `${ORIGIN}/mcp`;

export const CLIENTS = {
  claude: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
  chatgpt: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
  local: { client_name: 'Local test client', redirect_uris: ['http://127.0.0.1:33418/callback'] },
} as const;

export interface ClientRef {
  clientId: string;
  redirectUri: string;
}

export interface Grant extends ClientRef {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresIn: number;
}

function cookiesFrom(res: Response): string {
  const all = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  return all
    .filter(Boolean)
    .map((c) => c.split(';')[0]!)
    .join('; ');
}

export async function registerClient(kind: keyof typeof CLIENTS, override: Record<string, unknown> = {}): Promise<ClientRef> {
  const body = { ...CLIENTS[kind], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...override };
  const res = await call('/oauth/register', { body });
  const out = (await res.json()) as { client_id: string; redirect_uris?: string[] };
  if (res.status !== 201) throw new Error(`registration failed ${res.status} ${JSON.stringify(out)}`);
  return { clientId: out.client_id, redirectUri: (body.redirect_uris as readonly string[])[0]! };
}

export type Consent = Awaited<ReturnType<typeof openConsent>>;

export async function openConsent(assertion: string, client: ClientRef, scope: string, extra: Record<string, string> = {}) {
  const verifier = randomVerifier();
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

export async function approveConsent(assertion: string, consent: Consent, scopes: string[], decision: 'approve' | 'deny' = 'approve', extraForm: Record<string, string> = {}, cookie?: string): Promise<Response> {
  const form = new URLSearchParams({ handle: consent.handle, owner: consent.owner, decision, ...extraForm });
  for (const s of scopes) form.append('scope', s);
  return call('/authorize', { assertion, body: form, headers: { cookie: cookie ?? consent.cookie } });
}

export async function exchangeCode(client: ClientRef, code: string, verifier: string, extra: Record<string, string> = {}): Promise<Response> {
  return call('/oauth/token', { body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: verifier, resource: MCP_URL, ...extra }) });
}

export async function refresh(clientId: string, refreshToken: string, extra: Record<string, string> = {}): Promise<Response> {
  return call('/oauth/token', { body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, resource: MCP_URL, ...extra }) });
}

/** Consent approved; returns the authorization code and the verifier. */
export async function authorizeCode(assertion: string, client: ClientRef, scopes: string[], requested = 'wardrobe:read wardrobe:write') {
  const consent = await openConsent(assertion, client, requested);
  if (consent.res.status !== 200) throw new Error(`consent page ${consent.res.status}: ${consent.page.slice(0, 300)}`);
  const approved = await approveConsent(assertion, consent, scopes);
  const location = approved.headers.get('location');
  if (approved.status !== 302 || !location) throw new Error(`approval failed ${approved.status}: ${(await approved.text()).slice(0, 300)}`);
  const url = new URL(location);
  return { code: url.searchParams.get('code')!, state: url.searchParams.get('state'), iss: url.searchParams.get('iss'), verifier: consent.verifier, consent, location: url };
}

export async function mcpGrant(assertion: string, kind: keyof typeof CLIENTS, scopes: string[] = ['wardrobe:read', 'wardrobe:write']): Promise<Grant> {
  const client = await registerClient(kind);
  const { code, verifier } = await authorizeCode(assertion, client, scopes);
  const tokenRes = await exchangeCode(client, code, verifier);
  const t = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number };
  if (tokenRes.status !== 200) throw new Error(`token exchange ${tokenRes.status} ${JSON.stringify(t)}`);
  return { ...client, accessToken: t.access_token, refreshToken: t.refresh_token, scope: t.scope, expiresIn: t.expires_in };
}

export interface ConnectedClient {
  client: Client;
  requests: Request[];
  close: () => Promise<void>;
}

export type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };

export async function connectMcp(token: string, opts: { mode?: 'modern' | 'legacy'; onElicit?: (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>; elicitation?: boolean } = {}): Promise<ConnectedClient> {
  const requests: Request[] = [];
  const recordingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    requests.push(req.clone());
    return exports.default.fetch(req);
  }) as typeof fetch;
  const client = new Client(
    { name: 'garderobe-adversarial-test', version: '1.0.0' },
    { capabilities: opts.elicitation === false ? {} : { elicitation: { form: {} } }, versionNegotiation: opts.mode === 'legacy' ? { mode: 'legacy' } : { mode: { pin: '2026-07-28' } } },
  );
  if (opts.elicitation !== false) client.setRequestHandler('elicitation/create', async (req: { params: Record<string, unknown> }) => (opts.onElicit ? await opts.onElicit(req.params) : { action: 'decline' }) as never);
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: recordingFetch, authProvider: { token: async () => token } } as never);
  await client.connect(transport as never);
  return { client, requests, close: () => client.close() };
}

/** Calls a tool; protocol-level errors (thrown by the SDK) come back as an isError result. */
export async function tool(c: ConnectedClient, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return (await c.client.callTool({ name, arguments: args })) as ToolResult;
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
  }
}

/** Parses a JSON or SSE MCP response body into the last JSON-RPC message. */
export function parseRpc(text: string): Record<string, unknown> {
  if (text.startsWith('event:') || text.startsWith('data:') || text.includes('\ndata:')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1)!;
    return JSON.parse(data) as Record<string, unknown>;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

/** Re-sends a captured MCP request with a (possibly altered) body and headers. */
export async function resend(template: Request, body: string, headerOverrides: Record<string, string | null> = {}): Promise<{ status: number; text: string; rpc: Record<string, unknown> }> {
  const headers: Record<string, string> = Object.fromEntries(template.headers);
  for (const [k, v] of Object.entries(headerOverrides)) {
    if (v === null) delete headers[k.toLowerCase()];
    else headers[k.toLowerCase()] = v;
  }
  const res = await call('/mcp', { method: 'POST', headers, rawBody: body });
  const text = await res.text();
  return { status: res.status, text, rpc: parseRpc(text) };
}
