/**
 * Local sign-in tooling for `wrangler dev` (no Cloudflare Access in front of localhost).
 *
 *   npm run dev:auth --workspace @garderobe/backend -- setup        # key pair + .dev.vars + link the seeded owner
 *   npm run dev:auth --workspace @garderobe/backend -- assertion    # print an Access assertion (12 h) for curl
 *   npm run dev:auth --workspace @garderobe/backend -- prepare      # compose + publish today's board now
 *   npm run dev:auth --workspace @garderobe/backend -- native       # native PKCE S256 flow -> app bearer token
 *   npm run dev:auth --workspace @garderobe/backend -- mcp-grant [claude|chatgpt|local] [read|write]
 *
 * `setup` must run before `wrangler dev` starts (it writes ACCESS_JWKS_JSON to backend/.dev.vars); the
 * other commands talk to the running server at GARDEROBE_URL (default http://localhost:8787).
 *
 * The local Access stand-in: a locally generated RSA key signs assertions with the configured issuer
 * and audience; the Worker verifies them exactly as it verifies real Access assertions. The private
 * key is kept in backend/.wrangler/ (git-ignored) and never leaves this machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessClaims, signRs256Jwt } from '../src/auth/dev.js';
import { b64urlEncode } from '../src/auth/jose.js';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = join(backendDir, '.wrangler');
const keyFile = join(stateDir, 'dev-access-key.json');
const grantFile = join(stateDir, 'dev-mcp-grant.json');
const devVars = join(backendDir, '.dev.vars');
const BASE = (process.env.GARDEROBE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const SUBJECT = 'local-owner';

function wranglerVars(): Record<string, string> {
  const text = readFileSync(join(backendDir, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return (JSON.parse(text) as { vars: Record<string, string> }).vars;
}

const vars = wranglerVars();
const b64url = (b: Uint8Array) => b64urlEncode(b);

async function assertion(ttlSeconds = 12 * 3600): Promise<string> {
  if (!existsSync(keyFile)) throw new Error('Run `setup` first (no local Access key yet).');
  const jwk = JSON.parse(readFileSync(keyFile, 'utf8')) as JsonWebKey & { kid: string };
  return signRs256Jwt(jwk, accessClaims({ issuer: vars.ACCESS_TEAM_DOMAIN!, audience: vars.ACCESS_AUD!.split(',')[0]!, subject: SUBJECT, email: 'owner@localhost', ttlSeconds }));
}

async function setup(): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(keyFile)) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyFile, JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: 'local-dev-access', alg: 'RS256' }), { mode: 0o600 });
    writeFileSync(join(stateDir, 'dev-access-jwks.json'), JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'local-dev-access', alg: 'RS256', use: 'sig' }] }));
  }
  const jwks = readFileSync(join(stateDir, 'dev-access-jwks.json'), 'utf8').trim();
  const existing = existsSync(devVars) ? readFileSync(devVars, 'utf8').split('\n').filter((l) => l && !l.startsWith('ACCESS_JWKS_JSON=')) : [];
  // Single quotes: dotenv keeps the JSON literally (no escape processing).
  writeFileSync(devVars, [...existing, `ACCESS_JWKS_JSON='${jwks}'`].join('\n') + '\n');
  // Link the seeded owner (npm run seed:demo) to the local Access subject in local D1.
  const sql = `INSERT INTO auth_identities (user_id, identity_id, issuer, subject, email, linked_at)
    SELECT a.user_id, 'idn_localaccess', '${vars.ACCESS_TEAM_DOMAIN}', '${SUBJECT}', 'owner@localhost', datetime('now')
    FROM auth_identities a WHERE a.issuer = 'local-dev' AND a.subject = 'owner'
    AND NOT EXISTS (SELECT 1 FROM auth_identities WHERE issuer = '${vars.ACCESS_TEAM_DOMAIN}' AND subject = '${SUBJECT}');`;
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--command', sql.replace(/\s+/g, ' ')], { cwd: backendDir, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--json', '--command', `SELECT COUNT(*) AS n FROM auth_identities WHERE issuer = '${vars.ACCESS_TEAM_DOMAIN}' AND subject = '${SUBJECT}'`], { cwd: backendDir, env: { ...process.env, CI: '1' } }).toString();
  const n = (JSON.parse(out) as { results: { n: number }[] }[])[0]!.results[0]!.n;
  if (n !== 1) throw new Error('The seeded owner was not found in local D1: run `npm run seed:demo` from garderobe/ first.');
  console.log(`Local Access ready: ${devVars} has ACCESS_JWKS_JSON; subject "${SUBJECT}" is linked to the seeded owner. Start (or restart) \`npm run dev --workspace @garderobe/backend\`.`);
}

function formBody(form: Record<string, string>): { body: string; headers: Record<string, string> } {
  return { body: new URLSearchParams(form).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(new Uint8Array(randomBytes(48)));
  return { verifier, challenge: b64url(new Uint8Array(createHash('sha256').update(verifier).digest())) };
}

async function prepare(): Promise<void> {
  const res = await fetch(`${BASE}/v1/today/prepare`, { method: 'POST', headers: { 'cf-access-jwt-assertion': await assertion(), 'content-type': 'application/json' }, body: '{}' });
  console.log(res.status, await res.text());
}

async function native(): Promise<void> {
  const { verifier, challenge } = pkce();
  const redirect = 'garderobe://auth/callback';
  const params = new URLSearchParams({ response_type: 'code', client_id: 'garderobe-ios', redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'cli', resource: `${vars.APP_ORIGIN}/v1` });
  const auth = await fetch(`${BASE}/v1/auth/native/authorize?${params}`, { headers: { 'cf-access-jwt-assertion': await assertion() }, redirect: 'manual' });
  const code = new URL(auth.headers.get('location') ?? 'x:/').searchParams.get('code');
  if (!code) throw new Error(`authorize failed: ${auth.status} ${await auth.text()}`);
  const t = await fetch(`${BASE}/v1/auth/native/token`, { method: 'POST', ...formBody({ grant_type: 'authorization_code', client_id: 'garderobe-ios', code, redirect_uri: redirect, code_verifier: verifier }) });
  console.log(JSON.stringify(await t.json(), null, 2));
}

const CLIENTS: Record<string, { client_name: string; redirect_uris: string[] }> = {
  claude: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
  chatgpt: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] },
  local: { client_name: 'Local MCP client', redirect_uris: ['http://127.0.0.1:33418/callback'] },
};

/** Registers a client, approves the consent page as the local owner and exchanges the code (PKCE S256). */
async function mcpGrant(kind = 'local', access = 'write'): Promise<void> {
  const meta = CLIENTS[kind];
  if (!meta) throw new Error(`client must be one of ${Object.keys(CLIENTS).join(', ')}`);
  const reg = await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...meta, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  const client = (await reg.json()) as { client_id: string };
  if (!reg.ok) throw new Error(`registration failed: ${JSON.stringify(client)}`);
  const { verifier, challenge } = pkce();
  const a = await assertion();
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: meta.redirect_uris[0]!, code_challenge: challenge, code_challenge_method: 'S256', state: 'cli', scope: 'wardrobe:read wardrobe:write', resource: `${vars.MCP_ORIGIN}/mcp` });
  const page = await fetch(`${BASE}/authorize?${params}`, { headers: { 'cf-access-jwt-assertion': a } });
  const html = await page.text();
  if (!page.ok) throw new Error(`consent page ${page.status}: ${html.slice(0, 400)}`);
  const field = (n: string) => (new RegExp(`name="${n}" value="([^"]*)"`).exec(html)?.[1] ?? '').replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c)));
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const form = new URLSearchParams({ handle: field('handle'), owner: field('owner'), decision: 'approve' });
  form.append('scope', 'wardrobe:read');
  if (access === 'write') form.append('scope', 'wardrobe:write');
  const approved = await fetch(`${BASE}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'cf-access-jwt-assertion': a, cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const code = new URL(approved.headers.get('location') ?? 'x:/').searchParams.get('code');
  if (!code) throw new Error(`approval failed: ${approved.status} ${await approved.text()}`);
  const t = await fetch(`${BASE}/oauth/token`, { method: 'POST', ...formBody({ grant_type: 'authorization_code', code, redirect_uri: meta.redirect_uris[0]!, client_id: client.client_id, code_verifier: verifier, resource: `${vars.MCP_ORIGIN}/mcp` }) });
  const tokens = (await t.json()) as Record<string, unknown>;
  if (!t.ok) throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
  writeFileSync(grantFile, JSON.stringify({ clientId: client.client_id, client: kind, ...tokens }, null, 2), { mode: 0o600 });
  console.log(`Granted ${kind} (${access}) for 15 minutes; refresh token included. Saved to ${grantFile}.`);
  console.log(`MCP endpoint: ${vars.MCP_ORIGIN}/mcp`);
  console.log(`Authorization: Bearer ${String(tokens.access_token)}`);
}

const [cmd, ...args] = process.argv.slice(2);
const run: Record<string, () => Promise<void>> = {
  setup,
  assertion: async () => console.log(await assertion()),
  prepare,
  native,
  'mcp-grant': () => mcpGrant(args[0], args[1]),
};
if (!cmd || !run[cmd]) {
  console.error(`Usage: dev-auth <${Object.keys(run).join('|')}>`);
  process.exit(2);
}
await run[cmd]!();
