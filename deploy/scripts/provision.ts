/**
 * Idempotent provisioning of the Garderobe dev environment's account resources:
 * D1, private R2 bucket, KV (OAUTH_KV, CACHE_KV), Queues, the AI Search probe instance, and the
 * Cloudflare Access pieces (service token, its reusable policy, the app application and the MCP
 * consent-path application). Existing resources are found by name and reused; nothing outside the
 * dev names is created, changed or deleted. The existing "owner only" reusable Access policy is
 * attached to the new applications by id and is never modified.
 *
 * Writes deploy/dev-resources.json (ids, no secrets) and the resource ids into wrangler.dev.json.
 * The service token secret goes only to deploy/.state/access-service-token.json (git-ignored, 600).
 */
import {
  accountId,
  assertDevConfig,
  cf,
  CfError,
  MCP_ORIGIN,
  NAMES,
  OWNER_POLICY_ID,
  readConfig,
  readState,
  sleep,
  TEAM_DOMAIN,
  wrangler,
  writeConfig,
  writeResources,
  writeState,
  type DevResources,
  type ServiceTokenState,
} from './lib.js';

const A = () => `/accounts/${accountId()}`;

async function listAll<T>(path: string, perPage = 100): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page < 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await cf<T[]>('GET', `${path}${sep}page=${page}&per_page=${perPage}`);
    out.push(...r);
    if (r.length < perPage) break;
  }
  return out;
}

async function ensureD1(): Promise<{ name: string; id: string }> {
  const found = (await cf<{ uuid: string; name: string }[]>('GET', `${A()}/d1/database?name=${NAMES.d1}`)).find((d) => d.name === NAMES.d1);
  if (found) return { name: found.name, id: found.uuid };
  const created = await cf<{ uuid: string; name: string }>('POST', `${A()}/d1/database`, { name: NAMES.d1, primary_location_hint: 'weur' });
  console.log(`created D1 ${NAMES.d1}`);
  return { name: created.name, id: created.uuid };
}

async function ensureR2(): Promise<{ name: string }> {
  try {
    await cf('GET', `${A()}/r2/buckets/${NAMES.r2}`);
  } catch (err) {
    if (!(err instanceof CfError) || err.status !== 404) throw err;
    await cf('POST', `${A()}/r2/buckets`, { name: NAMES.r2, locationHint: 'weur' });
    console.log(`created R2 bucket ${NAMES.r2} (private: no public access, no r2.dev URL)`);
  }
  return { name: NAMES.r2 };
}

async function ensureKv(title: string): Promise<{ title: string; id: string }> {
  const found = (await listAll<{ id: string; title: string }>(`${A()}/storage/kv/namespaces`)).find((n) => n.title === title);
  if (found) return { title, id: found.id };
  const created = await cf<{ id: string }>('POST', `${A()}/storage/kv/namespaces`, { title });
  console.log(`created KV ${title}`);
  return { title, id: created.id };
}

async function ensureQueue(name: string): Promise<{ name: string; id: string }> {
  const found = (await listAll<{ queue_id: string; queue_name: string }>(`${A()}/queues`)).find((q) => q.queue_name === name);
  if (found) return { name, id: found.queue_id };
  const created = await cf<{ queue_id: string }>('POST', `${A()}/queues`, { queue_name: name });
  console.log(`created queue ${name}`);
  return { name, id: created.queue_id };
}

async function ensureAiSearch(): Promise<{ name: string; status: string }> {
  const exists = async () => {
    try {
      return await cf<{ ai_gateway_id?: string }>('GET', `${A()}/ai-search/instances/${NAMES.aiSearch}`);
    } catch (err) {
      if (!(err instanceof CfError) || (err.status !== 404 && err.status !== 400)) throw err;
      return null;
    }
  };
  let status = 'exists';
  let info = await exists();
  let out = '';
  if (!info) {
    out = wrangler(['ai-search', 'create', NAMES.aiSearch, '--type', 'builtin', '--hybrid-search', '--json'], { allowFail: true });
    for (let i = 0; i < 10 && !info; i++) {
      await sleep(2000); // creation is eventually consistent
      info = await exists();
    }
    if (!info) return { name: NAMES.aiSearch, status: `refused: ${out.replace(/\s+/g, ' ').slice(0, 400)}` };
    status = 'created';
    console.log(`created AI Search instance ${NAMES.aiSearch} (builtin)`);
  }
  // Its internal model calls go through the dev gateway (never the account default or garderobe-prod).
  if (info.ai_gateway_id !== NAMES.gateway) await cf('PUT', `${A()}/ai-search/instances/${NAMES.aiSearch}`, { ai_gateway_id: NAMES.gateway });
  return { name: NAMES.aiSearch, status };
}

interface ServiceToken {
  id: string;
  name: string;
  client_id: string;
  client_secret?: string;
  expires_at?: string;
}

async function ensureServiceToken(tokenName: string = NAMES.serviceToken, stateFile = 'access-service-token.json'): Promise<{ token: ServiceToken; state: ServiceTokenState }> {
  const existing = (await listAll<ServiceToken>(`${A()}/access/service_tokens`)).find((t) => t.name === tokenName);
  const saved = readState<ServiceTokenState>(stateFile);
  if (existing && saved && saved.tokenId === existing.id) return { token: existing, state: saved };
  let token: ServiceToken;
  if (existing) {
    // The secret is shown only once; without the saved state the only safe recovery is rotation.
    token = { ...existing, ...(await cf<ServiceToken>('POST', `${A()}/access/service_tokens/${existing.id}/rotate`)) };
    console.log(`rotated Access service token ${tokenName} (local state was missing)`);
  } else {
    token = await cf<ServiceToken>('POST', `${A()}/access/service_tokens`, { name: tokenName, duration: '8760h' });
    console.log(`created Access service token ${tokenName}`);
  }
  const state: ServiceTokenState = { clientId: token.client_id, clientSecret: token.client_secret!, tokenId: token.id };
  writeState(stateFile, state);
  return { token, state };
}

async function ensureServiceTokenPolicy(tokenIds: string[]): Promise<{ name: string; id: string }> {
  const body = { name: NAMES.serviceTokenPolicy, decision: 'non_identity', include: tokenIds.map((token_id) => ({ service_token: { token_id } })), exclude: [], require: [] };
  const found = (await listAll<{ id: string; name: string }>(`${A()}/access/policies`)).find((p) => p.name === NAMES.serviceTokenPolicy);
  if (found) {
    await cf('PUT', `${A()}/access/policies/${found.id}`, body);
    return { name: NAMES.serviceTokenPolicy, id: found.id };
  }
  const created = await cf<{ id: string }>('POST', `${A()}/access/policies`, body);
  console.log(`created reusable Access policy ${NAMES.serviceTokenPolicy}`);
  return { name: NAMES.serviceTokenPolicy, id: created.id };
}

async function ensureAccessApp(name: string, domain: string, policyIds: string[]): Promise<{ name: string; id: string; domain: string; aud: string }> {
  const body = {
    name,
    type: 'self_hosted',
    domain,
    destinations: [{ type: 'public', uri: domain }],
    session_duration: '24h',
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: 'lax',
    policies: policyIds.map((id, i) => ({ id, precedence: i + 1 })),
    tags: [],
  };
  const found = (await listAll<{ id: string; name: string; aud: string; domain: string }>(`${A()}/access/apps`)).find((a) => a.name === name);
  if (found) {
    const updated = await cf<{ id: string; aud: string; domain: string }>('PUT', `${A()}/access/apps/${found.id}`, body);
    return { name, id: updated.id, domain: updated.domain, aud: updated.aud };
  }
  const created = await cf<{ id: string; aud: string; domain: string }>('POST', `${A()}/access/apps`, body);
  console.log(`created Access application ${name} (${domain})`);
  return { name, id: created.id, domain: created.domain, aud: created.aud };
}

export async function provision(): Promise<DevResources> {
  const config = readConfig();
  assertDevConfig(config, { allowPlaceholders: true });
  const d1 = await ensureD1();
  const r2 = await ensureR2();
  const oauth = await ensureKv(NAMES.kvOauth);
  const cache = await ensureKv(NAMES.kvCache);
  const queues = [await ensureQueue(NAMES.queueMedia), await ensureQueue(NAMES.queueIndex)];
  const aiSearch = await ensureAiSearch();
  const { token } = await ensureServiceToken();
  // A second automation identity, linked only to the synthetic test owner B, for cross-owner isolation checks.
  const { token: tokenB } = await ensureServiceToken(NAMES.serviceTokenB, 'access-service-token-b.json');
  const policy = await ensureServiceTokenPolicy([token.id, tokenB.id]);
  const app = await ensureAccessApp(NAMES.accessApp, NAMES.appHost, [OWNER_POLICY_ID, policy.id]);
  const mcp = await ensureAccessApp(NAMES.accessMcpApp, `${new URL(MCP_ORIGIN).hostname}/authorize`, [OWNER_POLICY_ID, policy.id]);

  config.d1_databases[0]!.database_id = d1.id;
  for (const kv of config.kv_namespaces) kv.id = kv.binding === 'OAUTH_KV' ? oauth.id : cache.id;
  config.vars.ACCESS_AUD = [app.aud, mcp.aud].join(',');
  config.vars.ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
  // AI_GATEWAY_ACCOUNT_ID and DEV_PROBE_SUBJECTS are bound as Worker secrets at deploy time (never in
  // the committed file, and never echoed in wrangler's binding table).
  delete config.vars.AI_GATEWAY_ACCOUNT_ID;
  delete config.vars.DEV_PROBE_SUBJECTS;
  if (aiSearch.status.startsWith('refused')) delete config.ai_search;
  else config.ai_search = [{ binding: 'AI_SEARCH_PROBE', instance_name: NAMES.aiSearch }];
  writeConfig(config);

  const resources: DevResources = {
    accountLabel: "the owner's Cloudflare account (CLOUDFLARE_ACCOUNT_ID)",
    d1,
    r2,
    kv: { oauth, cache },
    queues,
    aiSearch,
    access: {
      teamDomain: TEAM_DOMAIN,
      serviceToken: { name: token.name, id: token.id, clientId: '(in deploy/.state only)', expiresAt: token.expires_at ?? null },
      serviceTokenB: { name: tokenB.name, id: tokenB.id, clientId: '(in deploy/.state only)', expiresAt: tokenB.expires_at ?? null },
      serviceTokenPolicy: policy,
      ownerPolicyId: OWNER_POLICY_ID,
      appApplication: app,
      mcpConsentApplication: mcp,
    },
    updatedAt: new Date().toISOString(),
  };
  writeResources(resources);
  console.log('Provisioned. Resource ids are in deploy/dev-resources.json and deploy/wrangler.dev.json.');
  return resources;
}
