/**
 * Measured usage of the dev deployment from Cloudflare's own records (no estimates):
 *  - Workers Observability events for garderobe-dev: CPU and wall time per request type (fetch by
 *    method + route pattern, Durable Object, queue, workflow), p50/p95/max;
 *  - GraphQL Analytics: Worker invocations, Durable Object duration and CPU, D1 reads/writes,
 *    R2 operations, Queue operations, AI Gateway requests/cost, Workers AI neurons.
 *   npm run dev:measure -- [--since <ISO>]      (default: the last 24 hours)
 * Writes deploy/evidence/usage.json. Uses CLOUDFLARE_LOGS_API_TOKEN (read-only analytics/logs).
 */
import { accountId, cf, graphql, NAMES, readResources, requireEnv, UA, writeEvidence } from './lib.js';

interface ObsEvent {
  $workers?: { eventType?: string; executionModel?: string; outcome?: string; cpuTimeMs?: number; wallTimeMs?: number; event?: { request?: { method?: string; url?: string }; path?: string; response?: { status?: number }; queue?: string } };
  $metadata?: { id?: string };
  timestamp?: number;
}

function routeOf(e: ObsEvent): string {
  const w = e.$workers ?? {};
  if (w.executionModel === 'durableObject') return `DO ${w.eventType ?? ''}`.trim();
  if (w.eventType && w.eventType !== 'fetch') return w.eventType;
  const url = w.event?.request?.url ?? '';
  let host = '';
  let path = w.event?.path ?? '';
  try {
    const u = new URL(url);
    host = u.hostname === NAMES.mcpHost ? 'mcp' : 'app';
    path = u.pathname;
  } catch {
    /* keep path */
  }
  const norm = path
    .replace(/\/(usr|g|cmd|run|mjb|ast|opt|brd|trp|mgr|idn|xfr|pkg)_[A-Za-z0-9]+/g, '/:$1')
    .replace(/\/[0-9a-f]{32,}/g, '/:id')
    .replace(/\/\d{4}-\d{2}-\d{2}/g, '/:date');
  return `${host} ${w.event?.request?.method ?? ''} ${norm}`.replace(/\s+/g, ' ').trim();
}

function stats(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]! : null);
  return { n: v.length, p50: q(0.5), p95: q(0.95), max: v.length ? v[v.length - 1]! : null, total: v.reduce((a, b) => a + b, 0) };
}

async function observabilityEvents(from: number, to: number): Promise<ObsEvent[]> {
  const out: ObsEvent[] = [];
  const seen = new Set<string>();
  const step = 15 * 60_000;
  for (let t = from; t < to; t += step) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId()}/workers/observability/telemetry/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${requireEnv('CLOUDFLARE_LOGS_API_TOKEN')}`, 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ queryId: 'garderobe-dev-usage', timeframe: { from: t, to: Math.min(to, t + step) }, view: 'events', limit: 2000, parameters: { filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: NAMES.worker }] } }),
    });
    const j = (await res.json()) as { success: boolean; result?: { events?: { events?: ObsEvent[] } } };
    for (const e of j.result?.events?.events ?? []) {
      const id = e.$metadata?.id ?? JSON.stringify(e).slice(0, 200);
      if (seen.has(id)) continue;
      seen.add(id);
      // Only invocation records carry CPU time; console lines are separate events.
      if (typeof e.$workers?.cpuTimeMs === 'number') out.push(e);
    }
  }
  return out;
}

async function gql<T>(name: string, query: string, vars: Record<string, unknown>): Promise<T | { error: string }> {
  try {
    return await graphql<T>(query, vars);
  } catch (err) {
    return { error: `${name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
  }
}

export async function measure(args: string[]): Promise<void> {
  const sinceArg = args.indexOf('--since');
  const since = sinceArg >= 0 ? new Date(args[sinceArg + 1]!) : new Date(Date.now() - 24 * 3600e3);
  const until = new Date();
  const res = readResources();
  const acct = accountId();
  const vars = { acct, since: since.toISOString(), until: until.toISOString(), sinceDate: since.toISOString().slice(0, 10), untilDate: until.toISOString().slice(0, 10) };

  const events = await observabilityEvents(since.getTime(), until.getTime());
  const byRoute = new Map<string, { cpu: number[]; wall: number[]; errors: number }>();
  for (const e of events) {
    const k = routeOf(e);
    const b = byRoute.get(k) ?? { cpu: [], wall: [], errors: 0 };
    b.cpu.push(e.$workers!.cpuTimeMs!);
    b.wall.push(e.$workers!.wallTimeMs ?? 0);
    if (e.$workers!.outcome && e.$workers!.outcome !== 'ok') b.errors++;
    byRoute.set(k, b);
  }
  const perRoute = [...byRoute.entries()].map(([route, b]) => ({ route, cpuMs: stats(b.cpu), wallMs: stats(b.wall), nonOkOutcomes: b.errors })).sort((a, b) => b.cpuMs.total - a.cpuMs.total);

  const workers = await gql('workers', `query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
    workersInvocationsAdaptive(limit: 100, filter: {scriptName: "${NAMES.worker}", datetime_geq: $since, datetime_leq: $until}) { sum { requests errors subrequests wallTime } quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 } dimensions { status } }
  } } }`, vars);

  const doNamespace = (await cf<{ id: string; script: string }[]>('GET', `/accounts/${acct}/workers/durable_objects/namespaces?per_page=100`)).find((n) => n.script === NAMES.worker)?.id ?? 'none';
  const durableObjects = await gql('durableObjects', `query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
    durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {namespaceId: "${doNamespace}", datetime_geq: $since, datetime_leq: $until}) { sum { requests errors wallTime } quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 } }
    durableObjectsPeriodicGroups(limit: 100, filter: {namespaceId: "${doNamespace}", datetime_geq: $since, datetime_leq: $until}) { sum { activeTime cpuTime duration exceededCpuErrors storageReadUnits storageWriteUnits storageDeletes rowsRead rowsWritten } }
  } } }`, vars);

  const d1 = await gql('d1', `query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
    d1AnalyticsAdaptiveGroups(limit: 100, filter: {databaseId: "${res.d1.id}", datetime_geq: $since, datetime_leq: $until}) { sum { readQueries writeQueries rowsRead rowsWritten queryBatchResponseBytes } quantiles { queryBatchTimeMsP50 queryBatchTimeMsP90 } }
  } } }`, vars);

  const r2 = await gql('r2', `query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
    r2OperationsAdaptiveGroups(limit: 100, filter: {bucketName: "${NAMES.r2}", datetime_geq: $since, datetime_leq: $until}) { sum { requests } dimensions { actionType } }
    r2StorageAdaptiveGroups(limit: 5, filter: {bucketName: "${NAMES.r2}", datetime_geq: $since, datetime_leq: $until}) { max { objectCount payloadSize metadataSize } }
  } } }`, vars);

  const queues = await gql('queues', `query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
    queueMessageOperationsAdaptiveGroups(limit: 100, filter: {queueId_in: [${res.queues.map((q) => `"${q.id}"`).join(',')}], datetime_geq: $since, datetime_leq: $until}) { count sum { billableOperations bytes } dimensions { queueId actionType } }
  } } }`, vars);

  const gateway = await gql('aiGateway', `query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
    aiGatewayRequestsAdaptiveGroups(limit: 100, filter: {gateway: "${NAMES.gateway}", datetime_geq: $since, datetime_leq: $until}) { count sum { cost cachedRequests erroredRequests uncachedTokensIn uncachedTokensOut } dimensions { model provider } }
  } } }`, vars);

  const workersAi = await gql('workersAi', `query($acct: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
    aiInferenceAdaptiveGroups(limit: 100, filter: {datetime_geq: $since, datetime_leq: $until}) { count sum { totalNeurons totalInputTokens totalOutputTokens } dimensions { modelId } }
  } } }`, vars);

  // Gateway configuration as recorded by Cloudflare (spend rule), read-only.
  let spendRule: unknown = null;
  try {
    const g = await cf<{ spend_limits?: unknown; authentication?: boolean; collect_logs?: boolean }>('GET', `/accounts/${acct}/ai-gateway/gateways/${NAMES.gateway}`);
    spendRule = { spendLimits: g.spend_limits ?? null, authentication: g.authentication, collectLogs: g.collect_logs };
  } catch (err) {
    spendRule = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }

  const out = { measuredAt: until.toISOString(), window: { since: since.toISOString(), until: until.toISOString() }, source: { perRequest: 'Workers Observability events (garderobe-dev)', totals: 'GraphQL Analytics API' }, invocationsObserved: events.length, perRoute, workers, durableObjects, d1, r2, queues, aiGateway: gateway, workersAiAccountWide: workersAi, gatewaySettings: spendRule };
  writeEvidence('usage.json', out);
  console.log(`Observed ${events.length} invocations with CPU time between ${since.toISOString()} and ${until.toISOString()}.`);
  for (const r of perRoute.slice(0, 40)) console.log(`${r.route.padEnd(58)} n=${String(r.cpuMs.n).padStart(4)} cpu p50=${r.cpuMs.p50}ms p95=${r.cpuMs.p95}ms max=${r.cpuMs.max}ms  wall p50=${r.wallMs.p50}ms`);
  for (const [k, v] of Object.entries({ workers, durableObjects, d1, r2, queues, aiGateway: gateway, workersAi })) console.log(`${k}: ${JSON.stringify(v).slice(0, 700)}`);
  console.log(`gateway settings: ${JSON.stringify(spendRule)}`);
}
