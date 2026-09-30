/**
 * Real-platform probes for the dev deployment (evidence for the deployment item). Each probe runs
 * inside the deployed Worker against its real bindings and returns a JSON record. No probe returns
 * wardrobe content: only ids, counts, statuses, timings and short model outputs to a fixed prompt.
 */
import type { Env } from '../../backend/src/env.js';
import { HttpError, apiError, errorResponse, json, readJson } from '../../backend/src/api/http.js';
import { authenticateAccess } from '../../backend/src/auth/app.js';
import { CommandService, createUser, ownerPrincipal, type Principal } from '../../backend/src/domain/index.js';
import { createModelService } from '../../backend/src/assistant/runtime.js';
import { CANDIDATE_PROFILES } from '../../backend/src/models/registry.js';
import { GatewayTransport } from '../../backend/src/models/transport-gateway.js';
import { createMediaPipeline } from '../../backend/src/media/pipeline.js';
import { localDateOf } from '../../backend/src/domain/time.js';
import { probeImportRace } from './import-race-probe.js';

export type DevEnv = Env & {
  AI_GATEWAY_TOKEN?: string;
  DEV_PROBE_SUBJECTS?: string;
  MODEL_PROBES?: string;
  AI_SEARCH_PROBE?: AiSearchInstance;
};

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export async function handleDevProbe(request: Request, env: DevEnv, _ctx: ExecutionContext): Promise<Response> {
  if (env.ENVIRONMENT !== 'dev') return apiError(404, 'not_found', 'Not found');
  try {
    const auth = await authenticateAccess(env, request);
    if (!auth.identity || !list(env.DEV_PROBE_SUBJECTS).includes(auth.identity.subject)) throw new HttpError(403, 'probe_forbidden', 'This identity may not run deployment probes');
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const principal = auth.principal;
    switch (route) {
      case 'GET /__dev/whoami':
        return json({ userId: principal.userId, via: auth.via, issuer: auth.identity.issuer, subjectKind: auth.identity.subject.split(':')[0] });
      case 'POST /__dev/probe/models':
        return json(await probeModels(env, principal, (await readJson(request)) as ModelProbeRequest));
      case 'POST /__dev/probe/d1':
        return json(await probeD1(env));
      case 'POST /__dev/probe/queue':
        return json(await probeQueueEnqueue(env, principal));
      case 'GET /__dev/probe/queue':
        return json(await probeQueueStatus(env, principal, list(url.searchParams.get('jobs') ?? '')));
      case 'POST /__dev/probe/workflow':
        return json(await probeWorkflowCreate(env, principal, (await readJson(request)) as { at?: string }));
      case 'GET /__dev/probe/workflow':
        return json(await probeWorkflowStatus(env, url.searchParams.get('id') ?? ''));
      case 'POST /__dev/probe/ai-search':
        return json(await probeAiSearch(env));
      case 'POST /__dev/probe/import-race':
        return json(await probeImportRace(env, _ctx, (await readJson(request).catch(() => ({}))) as { rounds?: number }));
      default:
        throw new HttpError(404, 'not_found', 'Unknown probe');
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// ------------------------------------------------------------------------------------------ models

interface ModelCase {
  label: string;
  /** ai.run: Workers AI binding with the gateway option; gateway.run: AI binding's gateway().run (compat);
   *  compat-fetch: the product transport's HTTPS route with the gateway token; embed: embeddings via ai.run;
   *  profile: the product GatewayTransport itself with a registry profile (its own route, wire settings
   *  and effort), bypassing only the probe gate that this probe exists to open;
   *  product: the product ModelService (registry + MODEL_PROBES) for a task, recorded in model_runs. */
  via: 'ai.run' | 'gateway.run' | 'compat-fetch' | 'embed' | 'profile' | 'product';
  model?: string;
  profileId?: string;
  task?: 'chat' | 'compaction' | 'extraction' | 'embeddings';
  depth?: 'routine' | 'deep';
}
interface ModelProbeRequest {
  cases: ModelCase[];
}

const PROMPT = 'Reply with the single word: ok';

async function probeModels(env: DevEnv, principal: Principal, body: ModelProbeRequest) {
  if (!Array.isArray(body?.cases) || body.cases.length > 20) throw new HttpError(422, 'validation_failed', 'cases: 1-20 probe cases');
  const gatewayId = env.AI_GATEWAY_ID;
  const out = [];
  for (const c of body.cases) {
    const t0 = Date.now();
    const meta = { probe: 'garderobe-dev-deploy', label: c.label.slice(0, 60) };
    try {
      if (c.via === 'ai.run') {
        // 256, not 16: reasoning models (kimi-k2.7-code) can spend a tiny allowance entirely on thinking.
        const r = (await env.AI.run(c.model as never, { messages: [{ role: 'user', content: PROMPT }], max_tokens: 256 } as never, { gateway: { id: gatewayId, skipCache: true, metadata: meta } } as never)) as Record<string, unknown>;
        out.push({ ...c, ok: true, latencyMs: Date.now() - t0, output: textOf(r), usage: r.usage ?? null, shape: Object.keys(r) });
      } else if (c.via === 'embed') {
        const r = (await env.AI.run(c.model as never, { text: ['Garderobe deployment probe sentence.'] } as never, { gateway: { id: gatewayId, skipCache: true, metadata: meta } } as never)) as { data?: number[][]; shape?: number[] };
        out.push({ ...c, ok: Array.isArray(r.data) && r.data.length === 1, latencyMs: Date.now() - t0, dimensions: r.data?.[0]?.length ?? null, shape: r.shape ?? null });
      } else if (c.via === 'gateway.run') {
        const res = await env.AI.gateway(gatewayId).run({ provider: 'compat', endpoint: 'chat/completions', headers: { 'content-type': 'application/json', 'cf-aig-metadata': JSON.stringify(meta) } as never, query: { model: c.model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 16 } });
        const text = await res.text();
        const j = safeJson(text) as { model?: string; usage?: unknown; choices?: { message?: { content?: string } }[] } | null;
        out.push({ ...c, ok: res.ok && Boolean(j?.choices), status: res.status, latencyMs: Date.now() - t0, providerModel: j?.model ?? null, output: j?.choices?.[0]?.message?.content?.slice(0, 40) ?? null, usage: j?.usage ?? null, error: res.ok ? null : text.slice(0, 300) });
      } else if (c.via === 'compat-fetch') {
        if (!env.AI_GATEWAY_TOKEN) throw new Error('AI_GATEWAY_TOKEN secret is not bound');
        const accountId = env.AI_GATEWAY_ACCOUNT_ID;
        const res = await fetch(`https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/compat/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}`, 'cf-aig-metadata': JSON.stringify(meta), 'cf-aig-skip-cache': 'true' },
          body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 16 }),
        });
        const text = await res.text();
        const j = safeJson(text) as { model?: string; usage?: unknown; choices?: { message?: { content?: string } }[] } | null;
        out.push({ ...c, ok: res.ok && Boolean(j?.choices), status: res.status, latencyMs: Date.now() - t0, providerModel: j?.model ?? null, output: j?.choices?.[0]?.message?.content?.slice(0, 40) ?? null, usage: j?.usage ?? null, error: res.ok ? null : text.slice(0, 300) });
      } else if (c.via === 'profile') {
        const profile = CANDIDATE_PROFILES.find((p) => p.profileId === c.profileId);
        if (!profile) throw new Error(`unknown profile ${String(c.profileId)}`);
        const transport = new GatewayTransport({ accountId: env.AI_GATEWAY_ACCOUNT_ID, gatewayId, allowedGatewayIds: [gatewayId], token: env.AI_GATEWAY_TOKEN, ai: env.AI });
        // The assistant always offers tools, so the probe does too: a route that cannot take tools fails here.
        const tools = [{ type: 'function' as const, name: 'noop', description: 'Not needed for this probe', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false } }];
        const r = await transport.call(profile, { task: 'chat', prompt: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }], tools, maxOutputTokens: 2000, runRef: `dev-probe:${profile.profileId}` }, { runId: `mrun_probe_${crypto.randomUUID().replace(/-/g, '')}`, runRef: `dev-probe:${profile.profileId}`, task: 'chat', gatewayId });
        const text = r.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
        out.push({ ...c, model: profile.apiModelId, ok: text.length > 0, latencyMs: Date.now() - t0, route: profile.route, providerModel: r.providerModel ?? null, usage: r.usage, output: text.slice(0, 40), ...(text ? {} : { error: 'no text in the reply' }) });
      } else if (c.via === 'product') {
        const svc = createModelService(env, principal.userId);
        const task = c.task ?? 'chat';
        const r = await svc.generate({ task, depth: c.depth, prompt: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }], maxOutputTokens: 2000, runRef: `dev-probe:${task}${c.depth ? `:${c.depth}` : ''}`, promptVersion: 'dev-probe/1', dataClasses: [] });
        const text = r.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
        const embeddings = r.embeddings ? { vectors: r.embeddings.length, dimensions: r.embeddings[0]?.length ?? 0 } : null;
        // A product call passes only with a usable answer: text for text tasks, vectors for embeddings.
        const usable = task === 'embeddings' ? Boolean(embeddings?.vectors && embeddings.dimensions) : text.length > 0;
        out.push({ ...c, ok: usable, latencyMs: Date.now() - t0, runId: r.runId, profileId: r.profileId, apiModelId: r.apiModelId, route: r.route, gatewayId: r.gatewayId, providerModel: r.providerModel ?? null, fallbackFrom: r.fallbackFrom, costMicroUsd: r.costMicroUsd, usage: r.usage, output: text.slice(0, 40), embeddings, ...(usable ? {} : { error: 'the product model service returned no usable output' }) });
      } else {
        throw new Error(`unknown via ${String(c.via)}`);
      }
    } catch (err) {
      const e = err as Error & { details?: unknown; code?: string };
      out.push({ ...c, ok: false, latencyMs: Date.now() - t0, error: `${e.name}: ${e.message}`.slice(0, 400), details: e.details ?? null });
    }
  }
  return { gatewayId, checkedAt: new Date().toISOString(), results: out };
}

function textOf(r: Record<string, unknown>): string | null {
  if (typeof r.response === 'string') return r.response.slice(0, 40);
  const choices = r.choices as { message?: { content?: string | null; reasoning_content?: string | null } }[] | undefined;
  if (choices?.[0]?.message) return (choices[0].message.content ?? '').slice(0, 40);
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------- D1

/**
 * The foundation's atomicity, idempotency and race checks (backend/test/commands.test.ts,
 * wear.test.ts), repeated on deployed D1 with a fresh synthetic probe owner so the real owner's
 * ledger is untouched. The probe owner is labelled and has no identity anyone can sign in with.
 */
async function probeD1(env: DevEnv) {
  const db = env.DB;
  const TZ = 'Europe/London';
  const at = '2026-10-06T09:00:00.000Z';
  const { userId } = await createUser(db, {
    displayName: 'Deployment probe owner (synthetic, not the owner)',
    identity: { issuer: 'garderobe-dev-probe', subject: `probe-${crypto.randomUUID()}` },
    settings: { homeLocationLabel: 'London', timezone: TZ, wearLoggingSince: '2026-01-01' },
  });
  const p = ownerPrincipal(userId, 'dev-probe');
  const svc = (opts: ConstructorParameters<typeof CommandService>[2] = {}) => new CommandService(db, p, opts);
  let n = 0;
  const key = () => `probe-${userId}-${++n}-${crypto.randomUUID().slice(0, 8)}`;
  const env1 = (command: unknown, extra: Record<string, unknown> = {}) => ({ idempotencyKey: key(), source: 'app', ...extra, command }) as never;
  const add = async (name: string, category: string, extra: Record<string, unknown> = {}) => {
    const r = await svc().execute(env1({ type: 'add_item', explicit: true, name, category, roles: [], ...extra }));
    if (r.outcome !== 'committed') throw new Error(`add_item ${r.outcome} ${r.error?.code}`);
    return r.facts.garmentId as string;
  };
  const w = {
    shirtA: await add('Probe shirt A', 'shirt', { roles: ['base_top'] }),
    shirtB: await add('Probe shirt B', 'shirt', { roles: ['base_top'] }),
    trousers: await add('Probe trousers', 'trousers', { roles: ['bottom'] }),
    socks: await add('Probe socks', 'socks', { roles: ['socks'], quantity: 4, tracking: 'anonymous_quantity' }),
    blazer: await add('Probe blazer', 'blazer', { roles: ['outer_layer'] }),
  };
  const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).bind(userId).first<{ n: number }>())!.n;
  const buckets = async (garmentId: string) =>
    (await db.prepare('SELECT COALESCE(SUM(clean_qty),0) AS clean, COALESCE(SUM(hamper_qty),0) AS hamper, COALESCE(SUM(worn_qty),0) AS worn FROM stock_lots WHERE user_id = ? AND garment_id = ?').bind(userId, garmentId).first<{ clean: number; hamper: number; worn: number }>())!;
  const checks: { name: string; pass: boolean; observed: unknown; ms: number }[] = [];
  const check = async (name: string, fn: () => Promise<{ pass: boolean; observed: unknown }>) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      checks.push({ name, ...r, ms: Date.now() - t0 });
    } catch (err) {
      checks.push({ name, pass: false, observed: `threw ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), ms: Date.now() - t0 });
    }
  };

  await check('same key and body replays the stored receipt; same key with a different body is refused', async () => {
    const body = env1({ type: 'mark_in_wash', garmentId: w.shirtA });
    const a = await svc().execute(body);
    const b = await svc().execute(body);
    const c = await svc().execute({ ...(body as object), command: { type: 'mark_in_wash', garmentId: w.shirtB } } as never);
    const bShirt = await buckets(w.shirtB);
    return { pass: a.outcome === 'committed' && b.replayed === true && b.commandId === a.commandId && c.error?.code === 'idempotency_key_reused' && bShirt.hamper === 0, observed: { first: a.outcome, second: { replayed: b.replayed, sameCommand: b.commandId === a.commandId }, reused: c.error?.code, shirtBHamper: bShirt.hamper } };
  });

  await check('three concurrent retransmissions with one key commit exactly once', async () => {
    const body = env1({ type: 'record_wear', timezone: TZ, items: [{ garmentId: w.socks }] });
    const results = await Promise.all([1, 2, 3].map(() => svc({ now: () => at }).execute(body)));
    const obs = await count('wear_observations');
    const s = await buckets(w.socks);
    return { pass: new Set(results.map((r) => r.commandId)).size === 1 && results.filter((r) => r.replayed).length === 2 && obs === 1 && s.clean === 3 && s.hamper === 1, observed: { distinctCommands: new Set(results.map((r) => r.commandId)).size, replayed: results.filter((r) => r.replayed).length, wearObservations: obs, socks: s } };
  });

  await check('twenty concurrent identical wear reports: one committed, nineteen merged, one counted wear', async () => {
    const cmd = { type: 'record_wear', timezone: TZ, items: [{ garmentId: w.shirtB }, { garmentId: w.trousers }] };
    const outs = await Promise.all(Array.from({ length: 20 }, () => svc({ now: () => '2026-10-07T09:00:00.000Z' }).execute(env1(cmd))));
    const wears = (await db.prepare("SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'").bind(userId, w.shirtB).first<{ n: number }>())!.n;
    const outcomes = outs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] ?? 0) + 1 }), {});
    const shirt = await buckets(w.shirtB);
    const trousers = await buckets(w.trousers);
    const day = await db.prepare("SELECT observation_count, revision FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'").bind(userId, w.shirtB).first<{ observation_count: number; revision: number }>().catch((e: unknown) => ({ error: String(e) }));
    const movements = (await db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE user_id = ? AND garment_id = ?').bind(userId, w.shirtB).first<{ n: number }>().catch(() => null))?.n ?? null;
    const committedReceipts = outs.filter((r) => r.outcome === 'committed').map((r) => ({ summary: r.summary.replace(/Probe [a-z ]+/gi, 'Probe item'), affected: r.affected.length }));
    return { pass: outcomes.committed === 1 && outcomes.merged === 19 && wears === 1, observed: { outcomes, countedWears: wears, shirt, trousers, day, shirtMovements: movements, committedReceiptSummaries: [...new Set(committedReceipts.map((c) => `${c.summary} (affected ${c.affected})`))], errors: outs.map((r) => r.error?.code).filter(Boolean) } };
  });

  await check('a forced late-statement failure leaves no receipt, partial mutation or effect', async () => {
    const before = { receipts: await count('command_receipts'), obs: await count('wear_observations'), moves: await count('stock_movements'), effects: await count('command_effects') };
    const shirtBefore = await buckets(w.blazer);
    let error = '';
    try {
      await svc({ now: () => '2026-10-08T09:00:00.000Z', afterStatements: (d) => [d.prepare('UPDATE stock_lots SET clean_qty = -1 WHERE user_id = ? AND garment_id = ?').bind(userId, w.trousers)] }).execute(env1({ type: 'record_wear', timezone: TZ, items: [{ garmentId: w.blazer }] }));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const after = { receipts: await count('command_receipts'), obs: await count('wear_observations'), moves: await count('stock_movements'), effects: await count('command_effects') };
    const shirtAfter = await buckets(w.blazer);
    return { pass: /CHECK constraint failed/.test(error) && JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(shirtBefore) === JSON.stringify(shirtAfter), observed: { error: error.slice(0, 120), before, after } };
  });

  await check('a bulk wear with one unresolvable target changes nothing', async () => {
    const before = await count('wear_observations');
    const r = await svc().execute(env1({ type: 'record_wear', timezone: TZ, items: [{ garmentId: w.shirtA }, { garmentId: 'g_doesnotexist' }] }));
    const after = await count('wear_observations');
    return { pass: r.outcome === 'rejected' && r.error?.code === 'not_found' && before === after, observed: { outcome: r.outcome, code: r.error?.code, before, after } };
  });

  await check('racing edits with the same expected version: one committed, one stale conflict', async () => {
    const set = await svc().execute(env1({ type: 'set_restriction', kind: 'repair', scope: { garmentIds: [w.blazer] }, reason: 'Probe: loose button' }));
    const restrictionId = set.facts.restrictionId as string;
    const lift = (evidence: string) => env1({ type: 'lift_restriction', restrictionId, evidence }, { expectedVersions: [{ entityType: 'restriction', entityId: restrictionId, version: 1 }] });
    const [a, b] = await Promise.all([svc().execute(lift('Button sewn on')), svc().execute(lift('Tailor fixed it'))]);
    const row = await db.prepare('SELECT version FROM restrictions WHERE user_id = ? AND restriction_id = ?').bind(userId, restrictionId).first<{ version: number }>();
    const outcomes = [a.outcome, b.outcome].sort();
    const loser = a.outcome === 'conflict' ? a : b;
    return { pass: JSON.stringify(outcomes) === JSON.stringify(['committed', 'conflict']) && loser.error?.code === 'stale_version' && row?.version === 2, observed: { outcomes, loserCode: loser.error?.code, version: row?.version } };
  });

  await check('receipts cannot be deleted or rewritten with SQL (immutability triggers)', async () => {
    const one = await db.prepare('SELECT command_id FROM command_receipts WHERE user_id = ? LIMIT 1').bind(userId).first<{ command_id: string }>();
    const attempts: Record<string, string> = {};
    for (const [label, sql] of [
      ['delete', 'DELETE FROM command_receipts WHERE user_id = ? AND command_id = ?'],
      ['rewrite', "UPDATE command_receipts SET receipt_json = '{}' WHERE user_id = ? AND command_id = ?"],
      ['reassign', "UPDATE command_receipts SET user_id = 'usr_other' WHERE user_id = ? AND command_id = ?"],
    ] as const) {
      try {
        await db.prepare(sql).bind(userId, one!.command_id).run();
        attempts[label] = 'ALLOWED';
      } catch (err) {
        attempts[label] = (err instanceof Error ? err.message : String(err)).replace(/^.*?:\s*/, '').slice(0, 80);
      }
    }
    return { pass: Object.values(attempts).every((v) => v !== 'ALLOWED'), observed: attempts };
  });

  return { probeUserId: userId, checkedAt: new Date().toISOString(), passed: checks.every((c) => c.pass), checks };
}

// ----------------------------------------------------------------------------------------- Queue

/** Enqueues a fresh composite job for the first option of today's published board (real product job). */
async function probeQueueEnqueue(env: DevEnv, principal: Principal) {
  const tz = env.DEFAULT_TIMEZONE || 'Europe/London';
  const today = localDateOf(new Date().toISOString(), tz);
  const opt = await env.DB.prepare(
    `SELECT o.option_id FROM boards b JOIN board_options o ON o.user_id = b.user_id AND o.board_id = b.board_id AND o.revision = b.current_revision
     WHERE b.user_id = ? AND b.board_date = ? AND o.status = 'offerable' ORDER BY o.position LIMIT 1`,
  )
    .bind(principal.userId, today)
    .first<{ option_id: string }>();
  if (!opt) throw new HttpError(409, 'no_board', `No published board for ${today}: prepare one first`);
  const pipeline = createMediaPipeline(env, principal.userId);
  const slots = await pipeline.composites.optionSlots(opt.option_id);
  const enqueuedAt = new Date().toISOString();
  const jobId = await pipeline.enqueue('composite', `composite:dev-probe:${crypto.randomUUID()}`, { slots });
  return { boardDate: today, jobId, enqueuedAt, slots: slots.length };
}

async function probeQueueStatus(env: DevEnv, principal: Principal, jobs: string[]) {
  if (!jobs.length || jobs.length > 20) throw new HttpError(422, 'validation_failed', 'jobs: 1-20 ids');
  const rows = [];
  for (const id of jobs) {
    const r = await env.DB.prepare('SELECT job_id, kind, status, attempts, created_at, updated_at FROM media_jobs WHERE user_id = ? AND job_id = ?').bind(principal.userId, id).first();
    rows.push(r ?? { job_id: id, status: 'missing' });
  }
  return { jobs: rows };
}

// -------------------------------------------------------------------------------------- Workflow

async function probeWorkflowCreate(env: DevEnv, principal: Principal, body: { at?: string }) {
  const at = body?.at && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : undefined;
  const instance = await env.DAILY_SERVICE_WORKFLOW.create({ params: { userId: principal.userId, ...(at ? { at } : {}) } });
  return { instanceId: instance.id, at: at ?? null, createdAt: new Date().toISOString() };
}

async function probeWorkflowStatus(env: DevEnv, id: string) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new HttpError(422, 'validation_failed', 'id');
  const instance = await env.DAILY_SERVICE_WORKFLOW.get(id);
  const status = await instance.status();
  return { instanceId: id, status: status.status, error: status.error ?? null, output: status.output ?? null };
}

// ------------------------------------------------------------------------------------- AI Search

/** Upload one synthetic, non-personal document to the dev AI Search instance and query it back. */
async function probeAiSearch(env: DevEnv) {
  if (!env.AI_SEARCH_PROBE) throw new HttpError(503, 'not_bound', 'AI_SEARCH_PROBE is not bound');
  const marker = `heliotrope-lantern-${Math.floor(Date.now() / 1000)}`;
  const name = `deploy-probe/${marker}.md`;
  const t0 = Date.now();
  const steps: Record<string, unknown> = {};
  try {
    const info = (await env.AI_SEARCH_PROBE.info()) as unknown as Record<string, unknown>;
    // Keep configuration only: drop account identity fields such as created_by / modified_by.
    steps.info = Object.fromEntries(Object.entries(info).filter(([k]) => !/(_by|token_id|email)$/i.test(k)));
  } catch (err) {
    steps.info = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const text = `# Garderobe deployment probe\n\nThis synthetic note exists only to test retrieval in the dev environment. The marker phrase is ${marker}. It mentions a navy wool travel blazer and a lightweight rain shell as generic examples.\n`;
  let item: unknown = null;
  try {
    item = await env.AI_SEARCH_PROBE.items.uploadAndPoll(name, text, { pollIntervalMs: 2000, timeoutMs: 90_000 } as never);
  } catch (err) {
    item = `error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }
  const indexedMs = Date.now() - t0;
  let search: unknown = null;
  const t1 = Date.now();
  try {
    const r = await env.AI_SEARCH_PROBE.search({ query: `marker phrase ${marker}`, ai_search_options: { retrieval: { retrieval_type: 'hybrid', max_num_results: 3 } } });
    const chunks = (r as { chunks?: { text?: string; score?: number; item?: { key?: string } }[] }).chunks ?? [];
    search = { chunks: chunks.length, markerFound: chunks.some((c) => (c.text ?? '').includes(marker)), topScore: chunks[0]?.score ?? null, topKey: chunks[0]?.item?.key ?? null };
  } catch (err) {
    search = `error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  }
  return { instance: 'garderobe-dev-recall', document: name, indexedMs, searchMs: Date.now() - t1, item, search, info: steps.info };
}
