/**
 * Real-platform probes against the deployed garderobe-dev Worker. Each writes deploy/evidence/<name>.json
 * (ids, statuses, timings, counts; no wardrobe content, no secrets).
 *
 *   npm run dev:probe -- models          # entitlement through garderobe-dev; writes MODEL_PROBES into wrangler.dev.json
 *   npm run dev:probe -- product-models  # the product ModelService path (after a redeploy with MODEL_PROBES)
 *   npm run dev:probe -- d1 | queue | workflow | ai-search | r2 | do-write | do-read | all
 */
import { accountId, APP_ORIGIN, cf, readConfig, serviceTokenHeaders, sleep, UA, writeConfig, writeEvidence } from './lib.js';

export async function api(path: string, init: { method?: string; body?: unknown; as?: 'owner' | 'b'; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any; ms: number; headers: Headers }> {
  const t0 = Date.now();
  const res = await fetch(`${APP_ORIGIN}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { 'user-agent': UA, ...serviceTokenHeaders(init.as ?? 'owner'), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, ms: Date.now() - t0, headers: res.headers };
}

const londonDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** Model entitlement: every candidate model on every route the product can use, plus reference models. */
async function models() {
  const cases = [
    { label: 'chat reference (Workers AI via binding)', via: 'ai.run', model: '@cf/meta/llama-3.1-8b-instruct-fast' },
    { label: 'compaction.workers-ai candidate (binding)', via: 'ai.run', model: '@cf/moonshotai/kimi-k2.7-code' },
    { label: 'embeddings.workers-ai candidate (binding)', via: 'embed', model: '@cf/baai/bge-m3' },
    { label: 'AI Search default embedding (binding)', via: 'embed', model: '@cf/qwen/qwen3-embedding-0.6b' },
    { label: 'chat.deepseek-flash candidate (binding gateway().run compat)', via: 'gateway.run', model: 'deepseek/deepseek-flash' },
    { label: 'chat reference (binding gateway().run compat)', via: 'gateway.run', model: 'workers-ai/@cf/meta/llama-3.1-8b-instruct-fast' },
    { label: 'chat.deepseek-flash candidate (product compat route, token)', via: 'compat-fetch', model: 'deepseek/deepseek-flash' },
    // The assistant's chat models, each on its own product route through the product transport.
    { label: 'chat.gpt-6-1-sol (product transport, OpenAI Responses route, with a tool)', via: 'profile', profileId: 'chat.gpt-6-1-sol' },
    { label: 'chat.opus-5-5-medium (product transport, Anthropic route, with a tool)', via: 'profile', profileId: 'chat.opus-5-5-medium' },
  ];
  const r = await api('/__dev/probe/models', { body: { cases } });
  if (r.status !== 200) throw new Error(`models probe ${r.status}: ${JSON.stringify(r.body)}`);
  const results = r.body.results as { label: string; via: string; model: string; profileId?: string; ok: boolean; output?: string | null; error?: string | null; status?: number }[];
  const find = (via: string, model: string) => results.find((x) => x.via === via && x.model === model);
  const byProfile = (profileId: string) => results.find((x) => x.via === 'profile' && x.profileId === profileId);
  const at = r.body.checkedAt as string;
  const rec = (x: (typeof results)[number] | undefined, extra?: (x: (typeof results)[number]) => string | null) => {
    if (!x) return { status: 'failed', checkedAt: at, gatewayId: 'garderobe-dev', reason: 'not probed' };
    const why = !x.ok ? (x.error ?? `HTTP ${x.status}`) : extra?.(x) ?? null;
    return why ? { status: 'failed', checkedAt: at, gatewayId: 'garderobe-dev', reason: why.slice(0, 200) } : { status: 'passed', checkedAt: at, gatewayId: 'garderobe-dev' };
  };
  // A profile passes only on the exact route and model id the product would use for it. Claude Fable 5.1
  // is no longer probed: it is above the owner's model ceiling and is not assigned to any task.
  const probes = {
    'chat.deepseek-flash': rec(find('compat-fetch', 'deepseek/deepseek-flash')),
    'chat.gpt-6-1-sol': rec(byProfile('chat.gpt-6-1-sol')),
    'chat.opus-5-5-medium': rec(byProfile('chat.opus-5-5-medium')),
    'compaction.workers-ai': rec(find('ai.run', '@cf/moonshotai/kimi-k2.7-code'), (x) => (x.output ? null : 'the binding reply carried no text for the fixed prompt')),
    'embeddings.workers-ai': rec(find('embed', '@cf/baai/bge-m3')),
  };
  const config = readConfig();
  config.vars.MODEL_PROBES = JSON.stringify(probes);
  writeConfig(config);
  writeEvidence('models.json', { ...r.body, recordedProbes: probes });
  for (const x of results) console.log(`${x.ok ? 'OK  ' : 'FAIL'} ${x.via.padEnd(12)} ${(x.model ?? x.profileId ?? '').padEnd(48)} ${x.ok ? `output=${JSON.stringify(x.output ?? null)}` : (x.error ?? '').slice(0, 160)}`);
  console.log(`MODEL_PROBES written to deploy/wrangler.dev.json: ${Object.entries(probes).map(([k, v]) => `${k}=${v.status}`).join(', ')}. Redeploy (npm run deploy:dev) to apply.`);
}

async function productModels() {
  const cases = [
    { label: 'product chat (routine: gpt-6.1-sol)', via: 'product', task: 'chat', depth: 'routine' },
    { label: 'product chat (deep: opus-5.5 medium)', via: 'product', task: 'chat', depth: 'deep' },
    { label: 'product compaction', via: 'product', task: 'compaction' },
    { label: 'product extraction', via: 'product', task: 'extraction' },
    { label: 'product embeddings', via: 'product', task: 'embeddings' },
  ];
  const r = await api('/__dev/probe/models', { body: { cases } });
  writeEvidence('product-models.json', r.body);
  for (const x of r.body.results ?? []) console.log(`${x.ok ? 'OK  ' : 'FAIL'} ${`${x.task}${x.depth ? `/${x.depth}` : ''}`.padEnd(14)} ${x.ok ? `${x.profileId} ${x.apiModelId} via ${x.route} gateway=${x.gatewayId} run=${x.runId} fallbackFrom=${JSON.stringify(x.fallbackFrom)} cost=${x.costMicroUsd}µ$ usage=${JSON.stringify(x.usage)} ${x.embeddings ? `embeddings=${JSON.stringify(x.embeddings)}` : `output=${JSON.stringify(x.output)}`}` : `${x.error} ${JSON.stringify(x.details ?? '')}`.slice(0, 400)}`);
}

async function d1() {
  const r = await api('/__dev/probe/d1', { body: {} });
  writeEvidence('d1.json', r.body);
  for (const c of r.body.checks ?? []) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name} (${c.ms} ms) ${JSON.stringify(c.observed).slice(0, 200)}`);
  if (!r.body.passed) process.exitCode = 1;
}

async function ensureTodayBoard() {
  const today = await api('/v1/today');
  if (today.body?.board) return { prepared: false, revision: today.body.board.currentRevision };
  const p = await api('/v1/today/prepare', { body: {} });
  return { prepared: true, status: p.status, published: p.body?.published, reason: p.body?.reason, ms: p.ms };
}

async function queue() {
  const board = await ensureTodayBoard();
  const e = await api('/__dev/probe/queue', { body: {} });
  if (e.status !== 200) throw new Error(`queue enqueue ${e.status}: ${JSON.stringify(e.body)}`);
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < 120_000) {
    last = (await api(`/__dev/probe/queue?jobs=${e.body.jobId}`)).body.jobs[0];
    if (['succeeded', 'failed', 'unresolved'].includes(last.status)) break;
    await sleep(2000);
  }
  const out = { board, enqueued: e.body, final: last, observedWithinMs: Date.now() - t0, deliveryLatencyMs: last?.updated_at ? Date.parse(last.updated_at) - Date.parse(e.body.enqueuedAt) : null };
  writeEvidence('queue.json', out);
  console.log(`Queue: job ${e.body.jobId} ${last?.status} after ${out.deliveryLatencyMs} ms (attempts ${last?.attempts}); board ${JSON.stringify(board)}`);
  if (last?.status !== 'succeeded') process.exitCode = 1;
}

async function workflow(args: string[] = []) {
  // Evening composition: 21:05 London on the evening day composes and publishes the next day's board.
  // --days N moves the evening N days ahead (each date's evening phase runs once; later runs are deduplicated).
  const shift = Number(args[args.indexOf('--days') + 1]) || 0;
  const today = londonDate(new Date(Date.now() + shift * 86_400_000));
  const tomorrow = londonDate(new Date(Date.now() + (shift + 1) * 86_400_000));
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value === 'GMT+1' ? 1 : 0;
  const at = new Date(`${today}T${String(21 - offset).padStart(2, '0')}:05:00.000Z`).toISOString();
  const c = await api('/__dev/probe/workflow', { body: { at } });
  if (c.status !== 200) throw new Error(`workflow create ${c.status}: ${JSON.stringify(c.body)}`);
  const t0 = Date.now();
  let s: any = null;
  while (Date.now() - t0 < 300_000) {
    s = (await api(`/__dev/probe/workflow?id=${c.body.instanceId}`)).body;
    if (['complete', 'errored', 'terminated'].includes(s.status)) break;
    await sleep(3000);
  }
  const board = await api(`/v1/today?date=${tomorrow}`);
  const out = {
    instanceId: c.body.instanceId,
    at,
    status: s?.status,
    elapsedMs: Date.now() - t0,
    output: s?.output,
    error: s?.error,
    tomorrow: { date: tomorrow, status: board.status, hasBoard: Boolean(board.body?.board), revision: board.body?.board?.currentRevision ?? null, options: board.body?.board?.options?.length ?? 0, sources: board.body?.sources ?? null },
  };
  writeEvidence('workflow.json', out);
  writeEvidence(`workflow-${out.tomorrow.date}-${out.instanceId}.json`, out);
  console.log(`Workflow ${out.instanceId}: ${out.status} in ${out.elapsedMs} ms; phases ${JSON.stringify(s?.output?.phases)}; tomorrow ${tomorrow}: board=${out.tomorrow.hasBoard} options=${out.tomorrow.options}`);
  if (out.status !== 'complete') process.exitCode = 1;
}

async function aiSearch() {
  const r = await api('/__dev/probe/ai-search', { body: {} });
  writeEvidence('ai-search.json', r.body);
  console.log(`AI Search: HTTP ${r.status} indexed in ${r.body.indexedMs} ms; item ${JSON.stringify(r.body.item).slice(0, 200)}; search ${JSON.stringify(r.body.search)}`);
}

/** R2: signed media URLs from the owner's wardrobe, tampered and cross-owner reads. */
async function r2() {
  const w = await api('/v1/wardrobe?limit=3');
  const item = (w.body.items as { media?: { catalogue?: { url?: string } | null; url?: string; thumbnails?: unknown } | unknown }[]).find((i) => JSON.stringify(i).includes('/v1/media/'));
  const url = JSON.stringify(item).match(/\/v1\/media\/[A-Za-z0-9_]+\?t=[A-Za-z0-9._~-]+/)?.[0];
  if (!url) throw new Error('no signed media URL in the wardrobe listing');
  const read = async (p: string, as: 'owner' | 'b' = 'owner') => {
    const r = await fetch(`${APP_ORIGIN}${p}`, { headers: { 'user-agent': UA, ...serviceTokenHeaders(as) } });
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), bytes: bytes.length, cache: r.headers.get('cache-control') };
  };
  const [path, token] = url.split('?t=');
  const out = {
    signed: await read(url),
    tampered: await read(`${path}?t=${token!.slice(0, -4)}AAAA`),
    noTokenOwnerSession: await read(path!),
    noTokenOtherOwner: await read(path!, 'b'),
    signedFromOtherOwnerSession: await read(url, 'b'),
    withoutAccess: await fetch(`${APP_ORIGIN}${url}`, { headers: { 'user-agent': UA }, redirect: 'manual' }).then((r) => ({ status: r.status, redirectsToAccess: (r.headers.get('location') ?? '').includes('cloudflareaccess.com') })),
  };
  writeEvidence('r2.json', out);
  console.log(JSON.stringify(out, null, 1));
}

/** The Worker version currently deployed (a new version restarts every Durable Object actor). */
async function currentVersion(): Promise<{ versionId: string | null; createdOn: string | null }> {
  const d = await cf<{ deployments: { created_on: string; versions: { version_id: string; percentage: number }[] }[] }>('GET', `/accounts/${accountId()}/workers/scripts/garderobe-dev/deployments`);
  const latest = [...d.deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))[0];
  return { versionId: latest?.versions[0]?.version_id ?? null, createdOn: latest?.created_on ?? null };
}

/** Think/Durable Object persistence: write a turn now, read it back after the actor restarts (redeploy). */
async function doWrite() {
  const clientTurnId = `dev-probe-${Date.now()}`;
  const t = await api('/v1/conversation/turns', { body: { clientTurnId, text: 'Deployment probe: in one short sentence, which of my coats suits drizzle best?' } });
  const runId = t.body?.runId;
  let run: any = null;
  const t0 = Date.now();
  while (runId && Date.now() - t0 < 120_000) {
    run = (await api(`/v1/runs/${runId}`)).body;
    if (['completed', 'finished', 'failed', 'cancelled', 'succeeded', 'awaiting_input'].includes(run?.status)) break;
    await sleep(2000);
  }
  const page = await api('/v1/conversation/messages?limit=50');
  const msgs = (page.body?.messages ?? []) as { messageId: string; role: string; clientTurnId?: string; runId?: string }[];
  const out = { clientTurnId, turn: { status: t.status, turnStatus: t.body?.status, runId, ms: t.ms }, run: { status: run?.status, elapsedMs: Date.now() - t0, receipts: run?.receipts?.length ?? 0, messageChars: typeof run?.message === 'string' ? run.message.length : null }, transcript: { count: msgs.length, ids: msgs.map((m) => m.messageId), roles: msgs.map((m) => m.role) }, workerVersion: await currentVersion(), writtenAt: new Date().toISOString() };
  writeEvidence('do-before-restart.json', out);
  console.log(`Turn ${clientTurnId}: ${t.status}/${t.body?.status} run ${run?.status}; transcript ${msgs.length} messages`);
}

async function doRead() {
  const before = JSON.parse((await import('node:fs')).readFileSync(new URL('../evidence/do-before-restart.json', import.meta.url), 'utf8'));
  const page = await api('/v1/conversation/messages?limit=50');
  const msgs = (page.body?.messages ?? []) as { messageId: string; role: string }[];
  const ids = msgs.map((m) => m.messageId);
  const version = await currentVersion();
  if (version.versionId === before.workerVersion?.versionId) throw new Error('The Worker has not been redeployed since do-write: deploy first so the actor restarts');
  const missing = (before.transcript.ids as string[]).filter((id) => !ids.includes(id));
  const replay = await api('/v1/conversation/turns', { body: { clientTurnId: before.clientTurnId, text: 'Deployment probe: in one short sentence, which of my coats suits drizzle best?' } });
  const out = { readAt: new Date().toISOString(), writtenAt: before.writtenAt, versionAtWrite: before.workerVersion, versionAtRead: version, countBefore: before.transcript.count, countAfter: msgs.length, missingAfterRestart: missing, sameTurnReplay: { status: replay.status, turnStatus: replay.body?.status, sameRun: replay.body?.runId === before.turn.runId } };
  writeEvidence('do-after-restart.json', out);
  console.log(JSON.stringify(out));
  if (missing.length) process.exitCode = 1;
}

export async function probe(args: string[]): Promise<void> {
  const which = args[0] ?? 'all';
  const table: Record<string, () => Promise<void>> = { models, 'product-models': productModels, d1, queue, workflow: () => workflow(args.slice(1)), 'ai-search': aiSearch, r2, 'do-write': doWrite, 'do-read': doRead, 'import-race': async () => (await import('./import-race.js')).importRace(args.slice(1)) };
  if (which === 'all') {
    for (const k of ['d1', 'queue', 'workflow', 'ai-search', 'r2']) {
      console.log(`\n== ${k}`);
      await table[k]!();
    }
    return;
  }
  if (!table[which]) throw new Error(`probe must be one of ${Object.keys(table).join(', ')}, all`);
  await table[which]!();
}
