/**
 * One-command dev deployment: provision (idempotent) -> D1 migrations on the remote dev database ->
 * runtime secrets (generated once, never printed) -> `wrangler deploy` of garderobe-dev.
 *
 * Runtime secrets bound to the Worker:
 *  - MCP_STATE_SECRET, MEDIA_URL_SIGNING_KEY: 64-character random values generated here the first time;
 *    later deploys keep the existing values (wrangler applies the secrets file additively).
 *  - AI_GATEWAY_TOKEN: the AI inference token (CLOUDFLARE_AI_API_TOKEN), used as `cf-aig-authorization`
 *    for the Unified Billing compat route. It is not the deployment/management token, which is never bound.
 *  - AI_GATEWAY_ACCOUNT_ID, DEV_PROBE_SUBJECTS: identifiers kept out of the committed config and out of
 *    wrangler's printed binding table.
 * The secrets file lives in the OS temp dir with mode 600 and is deleted as soon as wrangler returns.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountId, APP_ORIGIN, assertDevConfig, configPath, MCP_ORIGIN, readConfig, readState, requireEnv, serviceTokenHeaders, sleep, UA, wrangler, type ServiceTokenState } from './lib.js';

/** The Access subject the Worker derives for the automation service token (see backend/src/auth/access.ts). */
export function serviceTokenSubject(): string {
  const s = readState<ServiceTokenState>('access-service-token.json');
  if (!s) throw new Error('No service token state: run provision first');
  return `service-token:${s.clientId}`;
}

export function sanitize(text: string): string {
  let out = text;
  const secrets = [process.env.CLOUDFLARE_ACCOUNT_ID, readState<ServiceTokenState>('access-service-token.json')?.clientId].filter((v): v is string => Boolean(v));
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out;
}

function existingSecrets(): Set<string> {
  const out = wrangler(['secret', 'list', '--config', configPath, '--format', 'json'], { allowFail: true });
  try {
    return new Set((JSON.parse(out.slice(out.indexOf('['))) as { name: string }[]).map((s) => s.name));
  } catch {
    return new Set(); // the Worker does not exist yet
  }
}

export async function deploy(opts: { provisionFirst: boolean; rotate?: string[] }): Promise<void> {
  if (opts.provisionFirst) await (await import('./provision.js')).provision();
  const config = readConfig();
  assertDevConfig(config);

  console.log('Applying D1 migrations to garderobe-dev (remote)...');
  console.log(sanitize(wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath])).split('\n').filter((l) => /Migrations|✅|applied|No migrations|│ 0/.test(l)).join('\n'));

  const have = existingSecrets();
  const secrets: Record<string, string> = {};
  for (const name of ['MCP_STATE_SECRET', 'MEDIA_URL_SIGNING_KEY']) if (!have.has(name) || opts.rotate?.includes(name)) secrets[name] = Buffer.from(randomBytes(48)).toString('base64url' as BufferEncoding);
  secrets.AI_GATEWAY_TOKEN = requireEnv('CLOUDFLARE_AI_API_TOKEN');
  secrets.AI_GATEWAY_ACCOUNT_ID = accountId();
  secrets.DEV_PROBE_SUBJECTS = serviceTokenSubject();
  for (const [k, v] of Object.entries(secrets)) if ((k === 'MCP_STATE_SECRET' || k === 'MEDIA_URL_SIGNING_KEY') && v.length < 32) throw new Error(`${k} too short`);
  console.log(`Secrets bound with this version: ${Object.keys(secrets).join(', ')} (values not shown); already present and kept: ${[...have].filter((n) => !(n in secrets)).join(', ') || 'none'}`);

  const dir = mkdtempSync(join(tmpdir(), 'garderobe-dev-secrets-'));
  const file = join(dir, 'secrets.json');
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    const out = wrangler(['deploy', '--config', configPath, '--secrets-file', file], { allowFail: true });
    console.log(sanitize(out));
    if (!/Current Version ID|Deployed garderobe-dev/.test(out)) throw new Error('wrangler deploy did not report a deployed version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Post-deploy smoke: the public OAuth metadata on the MCP host, and the app host through Access.
  for (let i = 0; i < 20; i++) {
    try {
      const meta = await fetch(`${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`, { headers: { 'user-agent': UA } });
      const health = await fetch(`${APP_ORIGIN}/health`, { headers: { 'user-agent': UA, ...serviceTokenHeaders() } });
      console.log(`MCP resource metadata: ${meta.status}; app /health through Access (service token): ${health.status}`);
      if (meta.ok) return;
    } catch (err) {
      console.log(`waiting for the custom domains (${err instanceof Error ? err.message : String(err)})`);
    }
    await sleep(5000);
  }
  throw new Error('The deployed hostnames did not answer within 100 s');
}
