/**
 * Shared helpers for the Garderobe dev deployment tooling (deploy/scripts/dev.ts).
 *
 * Credentials come only from the Fabric project environment variables described in the credential
 * guide (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_AI_API_TOKEN, CLOUDFLARE_LOGS_API_TOKEN).
 * No value is ever printed: errors from the Cloudflare API are reported by code and message only.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const deployDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const rootDir = join(deployDir, '..');
export const backendDir = join(rootDir, 'backend');
export const dataDir = join(rootDir, 'data');
export const configPath = join(deployDir, 'wrangler.dev.json');
/** Git-ignored local state: the Access service token secret and the MCP test grant. Never committed. */
export const stateDir = join(deployDir, '.state');
export const resourcesPath = join(deployDir, 'dev-resources.json');
export const evidenceDir = join(deployDir, 'evidence');

export const NAMES = {
  worker: 'garderobe-dev',
  d1: 'garderobe-dev',
  r2: 'garderobe-dev-media',
  kvOauth: 'garderobe-dev-oauth',
  kvCache: 'garderobe-dev-cache',
  queueMedia: 'garderobe-media-dev',
  queueIndex: 'garderobe-index-dev',
  workflow: 'garderobe-daily-service-dev',
  aiSearch: 'garderobe-dev-recall',
  gateway: 'garderobe-dev',
  appHost: 'garderobe-dev.chabot.dev',
  mcpHost: 'garderobe-dev-mcp.chabot.dev',
  zone: 'chabot.dev',
  accessApp: 'Garderobe dev (app and web board)',
  accessMcpApp: 'Garderobe dev (MCP consent /authorize)',
  serviceToken: 'garderobe-dev-automation',
  serviceTokenB: 'garderobe-dev-automation-owner-b',
  serviceTokenPolicy: 'Garderobe dev automation (service token)',
} as const;

/** The existing reusable Access policy "owner only" (the owner's email). Attached, never modified. */
export const OWNER_POLICY_ID = 'bbccddd2-7526-4e94-8b22-a9db7de420b2';
export const TEAM_DOMAIN = 'https://raspy-fire-6cac.cloudflareaccess.com';
export const APP_ORIGIN = `https://${NAMES.appHost}`;
export const MCP_ORIGIN = `https://${NAMES.mcpHost}`;
export const UA = 'garderobe-dev-deploy/1.0';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is not set (see the credential guide in the project library)`);
  return v;
}

export const accountId = (): string => requireEnv('CLOUDFLARE_ACCOUNT_ID');

export interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
  result_info?: { page?: number; total_pages?: number; cursor?: string };
}

export class CfError extends Error {
  constructor(
    readonly status: number,
    readonly errors: { code: number; message: string }[],
    path: string,
  ) {
    super(`Cloudflare API ${status} on ${path}: ${errors.map((e) => `${e.code} ${e.message}`).join('; ')}`);
  }
}

/** Cloudflare REST call. `path` is relative to /client/v4. */
export async function cf<T>(method: string, path: string, body?: unknown, tokenVar = 'CLOUDFLARE_API_TOKEN'): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${requireEnv(tokenVar)}`, 'content-type': 'application/json', 'user-agent': UA },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({ success: false, errors: [{ code: res.status, message: 'non-JSON response' }] }))) as CfEnvelope<T>;
  if (!res.ok || !j.success) throw new CfError(res.status, j.errors ?? [], path.replace(/\?.*$/, ''));
  return j.result;
}

/** GraphQL Analytics API. */
export async function graphql<T>(query: string, variables: Record<string, unknown>, tokenVar = 'CLOUDFLARE_LOGS_API_TOKEN'): Promise<T> {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${requireEnv(tokenVar)}`, 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await res.json()) as { data: T; errors?: { message: string }[] | null };
  if (j.errors?.length) throw new Error(`GraphQL: ${j.errors.map((e) => e.message).join('; ')}`);
  return j.data;
}

/** Runs wrangler with the dev config. Output is captured (returned) unless `inherit` is set. */
export function wrangler(args: string[], opts: { inherit?: boolean; input?: string; allowFail?: boolean } = {}): string {
  const o: ExecFileSyncOptions = {
    cwd: deployDir,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
    stdio: opts.inherit ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  };
  try {
    const out = execFileSync(join(rootDir, 'node_modules', '.bin', 'wrangler'), args, o);
    return out ? out.toString() : '';
  } catch (err) {
    if (opts.allowFail) return String((err as { stdout?: Buffer }).stdout ?? '') + String((err as { stderr?: Buffer }).stderr ?? '');
    throw err;
  }
}

export interface DevConfig {
  name: string;
  main: string;
  workers_dev: boolean;
  routes: { pattern: string; custom_domain: boolean }[];
  d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[];
  r2_buckets: { binding: string; bucket_name: string }[];
  kv_namespaces: { binding: string; id: string }[];
  queues: { producers: { binding: string; queue: string }[]; consumers: { queue: string }[] };
  workflows: { name: string; binding: string; class_name: string }[];
  ai_search?: { binding: string; instance_name: string }[];
  vars: Record<string, string>;
  [k: string]: unknown;
}

export function readConfig(): DevConfig {
  return JSON.parse(readFileSync(configPath, 'utf8')) as DevConfig;
}

export function writeConfig(c: DevConfig): void {
  writeFileSync(configPath, JSON.stringify(c, null, 2) + '\n');
}

/**
 * Refuses anything that is not unmistakably the dev environment: a guard against overwriting the
 * existing `garderobe` Worker/D1 (the older application) or touching production.
 */
export function assertDevConfig(c: DevConfig, opts: { allowPlaceholders?: boolean } = {}): void {
  const problems: string[] = [];
  if (c.name !== NAMES.worker) problems.push(`worker name must be ${NAMES.worker}`);
  if (c.workers_dev !== false) problems.push('workers_dev must be false');
  if (c.vars.ENVIRONMENT !== 'dev') problems.push('ENVIRONMENT must be dev');
  if (c.vars.AI_GATEWAY_ID !== NAMES.gateway) problems.push(`AI_GATEWAY_ID must be ${NAMES.gateway} (never garderobe-prod)`);
  const hosts = c.routes.map((r) => r.pattern).sort();
  if (JSON.stringify(hosts) !== JSON.stringify([NAMES.appHost, NAMES.mcpHost].sort()) || c.routes.some((r) => !r.custom_domain)) problems.push('routes must be exactly the two dev custom domains');
  const names = [...c.d1_databases.map((d) => d.database_name), ...c.r2_buckets.map((b) => b.bucket_name), ...c.queues.producers.map((q) => q.queue), ...c.workflows.map((w) => w.name), ...(c.ai_search ?? []).map((a) => a.instance_name)];
  for (const n of names) if (!/(^|-)dev(-|$)/.test(n)) problems.push(`resource ${n} is not marked dev`);
  if (!opts.allowPlaceholders) {
    const json = JSON.stringify(c);
    if (json.includes('PROVISION')) problems.push('config still has PROVISION placeholders: run `npm run dev:provision` first');
  }
  if (problems.length) throw new Error(`Refusing to continue:\n - ${problems.join('\n - ')}`);
}

export interface DevResources {
  accountLabel: string;
  d1: { name: string; id: string };
  r2: { name: string };
  kv: { oauth: { title: string; id: string }; cache: { title: string; id: string } };
  queues: { name: string; id: string }[];
  aiSearch: { name: string; status: string };
  access: {
    teamDomain: string;
    serviceToken: { name: string; id: string; clientId: string; expiresAt: string | null };
    serviceTokenB?: { name: string; id: string; clientId: string; expiresAt: string | null };
    serviceTokenPolicy: { name: string; id: string };
    ownerPolicyId: string;
    appApplication: { name: string; id: string; domain: string; aud: string };
    mcpConsentApplication: { name: string; id: string; domain: string; aud: string };
  };
  updatedAt: string;
}

export function readResources(): DevResources {
  if (!existsSync(resourcesPath)) throw new Error('No deploy/dev-resources.json yet: run `npm run dev:provision` first');
  return JSON.parse(readFileSync(resourcesPath, 'utf8')) as DevResources;
}

export function writeResources(r: DevResources): void {
  writeFileSync(resourcesPath, JSON.stringify(r, null, 2) + '\n');
}

export function writeState(name: string, value: unknown): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
}

export function readState<T>(name: string): T | null {
  const p = join(stateDir, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
}

export function writeEvidence(name: string, value: unknown): string {
  mkdirSync(evidenceDir, { recursive: true });
  const p = join(evidenceDir, name);
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  return p;
}

/** Access service token credentials (git-ignored state file, mode 600). */
export interface ServiceTokenState {
  clientId: string;
  clientSecret: string;
  tokenId: string;
}

export function serviceTokenHeaders(which: 'owner' | 'b' = 'owner'): Record<string, string> {
  const s = readState<ServiceTokenState>(which === 'owner' ? 'access-service-token.json' : 'access-service-token-b.json');
  if (!s) throw new Error('No Access service token state (deploy/.state/access-service-token.json): run `npm run dev:provision`');
  return { 'cf-access-client-id': s.clientId, 'cf-access-client-secret': s.clientSecret };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
