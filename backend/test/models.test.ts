import { describe, expect, it, vi } from 'vitest';
import { db, newUser } from './helpers/fixtures.js';
import { BudgetExhaustedError, CANDIDATE_PROFILES, FakeModelTransport, GatewayTransport, ModelRegistry, ModelService, ModelUnavailableError, TransportError, resetCircuitBreakers, type ModelRequest } from '../src/models/index.js';
import { spendCapFromEnv } from '../src/models/budget.js';
import { createModelService, usesSimulatedModel } from '../src/assistant/runtime.js';
import type { ModelProfile } from '../src/models/registry.js';

const prompt = (text: string): ModelRequest['prompt'] => [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text }] }];

function service(userId: string, transport: FakeModelTransport, registry = ModelRegistry.forTests()) {
  resetCircuitBreakers();
  return new ModelService({ db: db(), userId, registry, transports: { fake: transport }, gatewayId: 'garderobe-dev' });
}

describe('model service: every inference through the gateway-routed service with task profiles and budgets', () => {
  it('candidate provider profiles stay unavailable until their Gateway and Unified Billing probe passes', () => {
    const reg = ModelRegistry.fromEnvironment('production');
    const chain = reg.chain('chat');
    expect(chain.profiles).toHaveLength(0);
    expect(chain.skipped.map((s) => s.reason).every((r) => /probe pending/.test(r))).toBe(true);
    reg.recordProbe('chat.gpt-6-1-sol', 'passed', 'probe ok');
    expect(reg.chain('chat').profiles.map((p) => p.profileId)).toEqual(['chat.gpt-6-1-sol']);
    expect(reg.describe().find((d) => d.profileId === 'fake.chat')).toBeUndefined();
  });

  it('the fake provider is refused outside local and test environments', () => {
    const reg = new ModelRegistry({ environment: 'production', profiles: ModelRegistry.forTests().describe().length ? [...CANDIDATE_PROFILES] : [], assignments: { chat: ['fake.chat'] } });
    expect(reg.chain('chat').profiles).toHaveLength(0);
    const prodWithFake = new ModelRegistry({ environment: 'production', profiles: [{ ...CANDIDATE_PROFILES[0]!, profileId: 'fake.chat', route: 'fake', probe: { status: 'passed' } }], assignments: { chat: ['fake.chat'] } });
    expect(prodWithFake.chain('chat').skipped[0]!.reason).toMatch(/local and test/);
  });

  it('each task has its own profile: chat, compaction, vision, extraction, embeddings, generation', async () => {
    const u = await newUser();
    const fake = new FakeModelTransport();
    const svc = service(u.userId, fake);
    for (const task of ['chat', 'compaction', 'vision', 'extraction', 'embeddings', 'generation'] as const) {
      const r = await svc.generate({ task, prompt: prompt(`task ${task}`), runRef: `t:${task}` });
      expect(r.profileId).toBe(`fake.${task}`);
      expect(r.gatewayId).toBe('garderobe-dev');
    }
    const runs = await db().prepare('SELECT COUNT(*) AS n FROM model_runs WHERE user_id = ?').bind(u.userId).first<{ n: number }>();
    expect(runs!.n).toBe(6);
  });

  it('reserves the worst case before dispatch and settles against reported usage', async () => {
    const u = await newUser();
    const fake = new FakeModelTransport().enqueue({ text: 'ok', usage: { inputTokens: 100, outputTokens: 10 } });
    const svc = service(u.userId, fake);
    const r = await svc.generate({ task: 'chat', prompt: prompt('hello'), runRef: 'r1', maxOutputTokens: 1000 });
    const row = await db().prepare('SELECT reserved_micro_usd, actual_micro_usd, status FROM model_reservations WHERE user_id = ?').bind(u.userId).first<{ reserved_micro_usd: number; actual_micro_usd: number; status: string }>();
    expect(row!.status).toBe('settled');
    expect(row!.reserved_micro_usd).toBeGreaterThan(row!.actual_micro_usd);
    expect(row!.actual_micro_usd).toBe(r.costMicroUsd);
  });

  it('refuses to dispatch when the budget cannot cover the request, holding back the board reserve', async () => {
    const u = await newUser();
    await db().prepare('UPDATE owner_settings SET budget_json = ? WHERE user_id = ?').bind(JSON.stringify({ monthlyMicroUsd: 3000, boardReserveMicroUsd: 2500 }), u.userId).run();
    const fake = new FakeModelTransport();
    const svc = service(u.userId, fake);
    await expect(svc.generate({ task: 'chat', prompt: prompt('x'.repeat(4000)), runRef: 'r', maxOutputTokens: 1000 })).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fake.calls).toHaveLength(0);
    // Composition may use the reserve held back for tomorrow's board.
    const ok = await svc.generate({ task: 'composition', prompt: prompt('x'.repeat(4000)), runRef: 'board', maxOutputTokens: 200 });
    expect(ok.profileId).toBe('fake.composition');
  });

  it('the deployment spend cap counts every owner and model over a sliding 30 days, including models the gateway does not price (Sol)', async () => {
    expect(spendCapFromEnv(undefined)).toBeNull();
    expect(spendCapFromEnv('')).toBeNull();
    expect(spendCapFromEnv('50')).toEqual({ microUsd: 50_000_000, windowDays: 30 });
    expect(() => spendCapFromEnv('fifty')).toThrow(/MODEL_SPEND_CAP_USD/);
    const a = await newUser('Owner A');
    const b = await newUser('Owner B');
    const now = () => '2031-03-01T10:00:00.000Z';
    const row = (userId: string, id: string, createdAt: string, microUsd: number, profileId: string) =>
      db()
        .prepare("INSERT INTO model_reservations (user_id, reservation_id, task, profile_id, run_ref, reserved_micro_usd, actual_micro_usd, status, period, created_at) VALUES (?, ?, 'chat', ?, 'r', ?, ?, 'settled', ?, ?)")
        .bind(userId, id, profileId, microUsd, microUsd, createdAt.slice(0, 7), createdAt)
        .run();
    // Another owner's Sol spend nine days ago counts; this owner's own spend 45 days ago does not.
    await row(b.userId, 'mres_cap_b', '2031-02-20T10:00:00.000Z', 45_000, 'chat.gpt-6-1-sol');
    await row(a.userId, 'mres_cap_a_old', '2031-01-15T10:00:00.000Z', 45_000, 'chat.opus-5-5-medium');
    resetCircuitBreakers();
    const fake = new FakeModelTransport();
    const svc = new ModelService({ db: db(), userId: a.userId, registry: ModelRegistry.forTests(), transports: { fake }, gatewayId: 'garderobe-dev', now, spendCap: spendCapFromEnv('0.05') });
    const request = { task: 'chat' as const, prompt: prompt('x'.repeat(4000)), runRef: 'cap', maxOutputTokens: 4000 };
    const refused = await svc.generate(request).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BudgetExhaustedError);
    expect((refused as BudgetExhaustedError).details).toMatchObject({ scope: 'deployment', spentMicroUsd: 45_000, limitMicroUsd: 50_000, windowDays: 30 });
    expect(fake.calls).toHaveLength(0);
    // Once that spend leaves the window, the same request goes through.
    await db().prepare("UPDATE model_reservations SET created_at = '2031-01-20T10:00:00.000Z' WHERE reservation_id = 'mres_cap_b'").run();
    expect((await svc.generate(request)).profileId).toBe('fake.chat');
  });

  it('falls back only on transport-class failures, keeps a timed-out reservation uncertain, and never on a valid answer', async () => {
    const u = await newUser();
    const reg = new ModelRegistry({
      environment: 'test',
      profiles: [
        { ...ModelRegistry.forTests().profile('fake.chat')!, profileId: 'fake.primary', fallbacks: ['fake.secondary'] },
        { ...ModelRegistry.forTests().profile('fake.chat')!, profileId: 'fake.secondary', fallbacks: [] },
      ],
      assignments: { chat: ['fake.primary'] },
    });
    const fake = new FakeModelTransport().enqueue({ error: new TransportError('timeout', 'slow', true) }, { text: 'from secondary' });
    const r = await service(u.userId, fake, reg).generate({ task: 'chat', prompt: prompt('q'), runRef: 'r' });
    expect(r.profileId).toBe('fake.secondary');
    expect(r.fallbackFrom).toEqual(['fake.primary']);
    const statuses = (await db().prepare('SELECT status FROM model_reservations WHERE user_id = ? ORDER BY created_at').bind(u.userId).all<{ status: string }>()).results.map((x) => x.status);
    expect(statuses).toContain('uncertain');
    const fatal = new FakeModelTransport().enqueue({ error: new TransportError('fatal', 'bad request', true) });
    await expect(service(u.userId, fatal, reg).generate({ task: 'chat', prompt: prompt('q'), runRef: 'r' })).rejects.toBeInstanceOf(TransportError);
    expect(fatal.calls).toHaveLength(1);
  });

  it('refuses profiles not permitted to receive the request’s data classes or too small for its context', async () => {
    const u = await newUser();
    const reg = new ModelRegistry({ environment: 'test', profiles: [{ ...ModelRegistry.forTests().profile('fake.chat')!, dataClasses: ['conversation'], maxInputTokens: 50 }], assignments: { chat: ['fake.chat'] } });
    const svc = service(u.userId, new FakeModelTransport(), reg);
    await expect(svc.generate({ task: 'chat', prompt: prompt('hi'), runRef: 'r', dataClasses: ['email_excerpt'] })).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(svc.generate({ task: 'chat', prompt: prompt('x'.repeat(2000)), runRef: 'r' })).rejects.toThrow(/No model profile/);
  });

  it('the gateway transport names the allowed gateway, sends no provider key and uses the Unified Billing compat route', async () => {
    expect(() => new GatewayTransport({ accountId: 'acc', gatewayId: 'default', allowedGatewayIds: ['garderobe-dev'] })).toThrow(/allow-list/);
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const t = new GatewayTransport({
      accountId: 'acc123',
      gatewayId: 'garderobe-dev',
      allowedGatewayIds: ['garderobe-dev'],
      token: 'cf-run-token',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
        return Response.json({ model: 'deepseek-flash-2026-09', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'wardrobe_search', arguments: '{"q":"oxford"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
      }) as never,
    });
    const deepseek = CANDIDATE_PROFILES.find((p) => p.profileId === 'chat.deepseek-flash')!;
    const r = await t.call(deepseek, { task: 'chat', prompt: prompt('hi'), runRef: 'turn:1', tools: [{ type: 'function', name: 'wardrobe_search', inputSchema: { type: 'object' } }] }, { runId: 'mrun_1', runRef: 'turn:1', task: 'chat', gatewayId: 'garderobe-dev' });
    expect(seen[0]!.url).toBe('https://gateway.ai.cloudflare.com/v1/acc123/garderobe-dev/compat/chat/completions');
    expect(Object.keys(seen[0]!.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(seen[0]!.headers['cf-aig-authorization']).toBe('Bearer cf-run-token');
    expect(seen[0]!.body.model).toBe('deepseek/deepseek-flash');
    expect(r.content[0]).toMatchObject({ type: 'tool-call', toolName: 'wardrobe_search' });
    expect(r.providerModel).toBe('deepseek-flash-2026-09');
  });

  it('no application code outside the model service calls inference directly (no AI binding, provider SDK or provider host bypass)', () => {
    const sources = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      if (path.includes('/src/models/')) continue;
      if (/\.AI\.run\(|ai\.run\(|from ['"]@ai-sdk\/(openai|anthropic)['"]|from ['"]workers-ai-provider['"]|api\.openai\.com|api\.anthropic\.com|api\.deepseek\.com|streamText\(|generateText\(/.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    // The Think actor is given a model object bound to the service, never a string id Think would resolve itself.
    const agent = sources['../src/assistant/agent.ts']!;
    expect(agent).toMatch(/override getModel\(\) \{\s*return new GarderobeLanguageModel\(/);
    expect(agent).toMatch(/override sendReasoning = false/);
    expect(agent).toMatch(/override includeMcpTools = false/);
  });

  it('the runtime uses the deterministic fake only in tests or a local environment without gateway credentials', () => {
    expect(usesSimulatedModel({ DB: db(), AI: {} as Ai, ENVIRONMENT: 'production', AI_GATEWAY_ID: 'garderobe-prod', AI_GATEWAY_ACCOUNT_ID: 'acc' })).toBe(false);
    expect(usesSimulatedModel({ DB: db(), AI: {} as Ai, ENVIRONMENT: 'local', AI_GATEWAY_ID: 'garderobe-dev', AI_GATEWAY_ACCOUNT_ID: '' })).toBe(true);
    const prod = createModelService({ DB: db(), AI: {} as Ai, ENVIRONMENT: 'production', AI_GATEWAY_ID: 'garderobe-prod', AI_GATEWAY_ACCOUNT_ID: 'acc' }, 'usr_test0001');
    expect(prod.registry.chain('chat').profiles).toHaveLength(0); // nothing enabled until probes pass; no silent fallback
  });
});

// ---------------------------------------------------------------------------------------------------
// Workers AI binding route and provider errors (dev deployment defects 1 and 2). Reply shapes are the
// ones the deployed binding returned for these models (deploy/evidence/models.json).

const META = { runId: 'mrun_t', runRef: 'turn:t', task: 'compaction' as const, gatewayId: 'garderobe-dev' };
const profileNamed = (id: string) => ModelRegistry.forTests().profile(id)!;
const KIMI = profileNamed('compaction.workers-ai');
const BGE = profileNamed('embeddings.workers-ai');
const LLAMA: ModelProfile = { ...KIMI, profileId: 'test.llama', apiModelId: '@cf/meta/llama-3.1-8b-instruct-fast' };
const QWEN: ModelProfile = { ...BGE, profileId: 'test.qwen3-embedding', apiModelId: '@cf/qwen/qwen3-embedding-0.6b' };

function bindingTransport(reply: (model: string, input: Record<string, unknown>) => unknown) {
  const seen: { model: string; input: Record<string, unknown>; options: unknown }[] = [];
  const ai = {
    run: async (model: string, input: Record<string, unknown>, options: unknown) => {
      seen.push({ model, input, options });
      return reply(model, input);
    },
  } as unknown as Ai;
  return { seen, transport: new GatewayTransport({ accountId: 'acc', gatewayId: 'garderobe-dev', allowedGatewayIds: ['garderobe-dev'], ai }) };
}

const usage = { prompt_tokens: 15, completion_tokens: 2, total_tokens: 17 };

describe('gateway transport: Workers AI replies, embedding input and provider errors', () => {
  it('reads each Workers AI text reply shape: OpenAI choices (kimi), choices plus response (llama) and the classic response', async () => {
    const shapes: [ModelProfile, unknown][] = [
      [KIMI, { id: 'id-1', object: 'chat.completion', created: 1, model: '@cf/moonshotai/kimi-k2.7-code', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok from kimi', reasoning_content: 'thinking' } }], usage }],
      [LLAMA, { id: 'id-2', object: 'chat.completion', model: '@cf/meta/llama-3.1-8b-instruct-fast', response: 'ok from llama', tool_calls: [], choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok from llama' } }], usage }],
      [LLAMA, { response: 'ok classic', usage }],
      [KIMI, { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: 'ok ' }, { type: 'text', text: 'in parts' }] } }], usage }],
    ];
    const texts: string[] = [];
    for (const [profile, reply] of shapes) {
      const { seen, transport } = bindingTransport(() => reply);
      const r = await transport.call(profile, { task: 'compaction', prompt: prompt('Summarise'), runRef: 'turn:t', maxOutputTokens: 64 }, META);
      texts.push(r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
      expect(r.usage).toEqual({ inputTokens: 15, outputTokens: 2 });
      expect(seen[0]!.input.messages).toBeDefined();
      expect(seen[0]!.options).toMatchObject({ gateway: { id: 'garderobe-dev', skipCache: true } });
    }
    expect(texts).toEqual(['ok from kimi', 'ok from llama', 'ok classic', 'ok in parts']);
  });

  it('reads tool calls in both shapes and treats a reply with no text or tool call as invalid output, not an empty answer', async () => {
    const openAi = bindingTransport(() => ({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'wardrobe_search', arguments: '{"q":"oxford"}' } }] } }], usage }));
    const a = await openAi.transport.call(KIMI, { task: 'compaction', prompt: prompt('x'), runRef: 'r' }, META);
    expect(a.content).toEqual([{ type: 'tool-call', toolCallId: 'c1', toolName: 'wardrobe_search', input: '{"q":"oxford"}' }]);
    expect(a.finishReason.unified).toBe('tool-calls');
    const classic = bindingTransport(() => ({ response: null, tool_calls: [{ name: 'wardrobe_search', arguments: { q: 'cords' } }], usage }));
    const b = await classic.transport.call(LLAMA, { task: 'compaction', prompt: prompt('x'), runRef: 'r' }, META);
    expect(b.content[0]).toMatchObject({ type: 'tool-call', toolName: 'wardrobe_search', input: '{"q":"cords"}' });
    // A reasoning model that spends the whole allowance thinking returns no content: a fallback-class failure.
    const empty = bindingTransport(() => ({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'still thinking' } }], usage }));
    const err = await empty.transport.call(KIMI, { task: 'compaction', prompt: prompt('x'), runRef: 'r' }, META).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('invalid_output');
    expect((err as TransportError).message).toMatch(/no text or tool call.*finish_reason length/);
  });

  it('embedding profiles send embedding input to bge-m3 and qwen3-embedding and return one vector per text', async () => {
    for (const profile of [BGE, QWEN]) {
      const { seen, transport } = bindingTransport((_m, input) => ({ shape: [(input.text as string[]).length, 1024], data: (input.text as string[]).map((_, i) => Array.from({ length: 1024 }, (_, j) => (i + j) / 1024)) }));
      const r = await transport.call(profile, { task: 'embeddings', prompt: [{ role: 'system', content: 'ignored' }, { role: 'user', content: [{ type: 'text', text: 'Navy herringbone Games blazer' }, { type: 'text', text: 'Mid-wash jeans' }] }], runRef: 'r' }, { ...META, task: 'embeddings' });
      expect(seen[0]!.model).toBe(profile.apiModelId);
      expect(seen[0]!.input).toEqual({ text: ['Navy herringbone Games blazer', 'Mid-wash jeans'] });
      expect(r.embeddings).toHaveLength(2);
      expect(r.embeddings![0]).toHaveLength(1024);
      expect(r.usage.inputTokens).toBeGreaterThan(0);
    }
    const short = bindingTransport(() => ({ shape: [0, 1024], data: [] }));
    const err = await short.transport.call(BGE, { task: 'embeddings', prompt: prompt('a'), runRef: 'r' }, { ...META, task: 'embeddings' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    const wrong = bindingTransport(() => ({ response: 'not vectors' }));
    await expect(wrong.transport.call(BGE, { task: 'embeddings', prompt: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }], runRef: 'r' }, { ...META, task: 'embeddings' })).rejects.toThrow(/expected 2 embedding vector/);
  });

  it('gateway failures keep the HTTP status and the provider message, with credentials redacted', async () => {
    const token = 'cfut_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78';
    const replies: [number, string][] = [
      [503, JSON.stringify({ error: { message: 'API key validation is temporarily unavailable', type: 'api_error' } })],
      [401, JSON.stringify([{ code: 2009, message: 'Authentication Fails (governor)' }])],
      [429, JSON.stringify({ errors: [{ message: 'Rate limited by provider' }] })],
      [400, JSON.stringify({ error: { message: `prompt is too long: 210000 tokens > 200000 maximum; token was ${token} and key sk-abcdefghijklmnopqrstuvwx` } })],
      [404, '<html><body>model: claude-fable-5-1 not found</body></html>'],
    ];
    const errors: TransportError[] = [];
    for (const [status, body] of replies) {
      const t = new GatewayTransport({ accountId: 'acc', gatewayId: 'garderobe-dev', allowedGatewayIds: ['garderobe-dev'], token, fetch: (async () => new Response(body, { status })) as never });
      errors.push((await t.call(CANDIDATE_PROFILES.find((p) => p.profileId === 'chat.gpt-6-1-sol')!, { task: 'chat', prompt: prompt('hi'), runRef: 'r' }, { ...META, task: 'chat' }).catch((e: unknown) => e)) as TransportError);
    }
    expect(errors.map((e) => [e.kind, e.status])).toEqual([['transport', 503], ['fatal', 401], ['rate_limit', 429], ['context_overflow', 400], ['fatal', 404]]);
    expect(errors[0]!.message).toBe('Gateway 503: API key validation is temporarily unavailable');
    expect(errors[1]!.message).toBe('Gateway 401: Authentication Fails (governor) (code 2009)');
    expect(errors[2]!.message).toBe('Gateway 429: Rate limited by provider');
    expect(errors[3]!.message).toMatch(/^Gateway 400: prompt is too long/);
    expect(errors[3]!.message).not.toContain(token);
    expect(errors[3]!.message).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(errors[4]!.message).toBe('Gateway 404: model: claude-fable-5-1 not found');
  });

  it('Workers AI binding errors keep the provider message and are classed by it', async () => {
    const cases: [Error, string][] = [
      [new Error('3040: Capacity temporarily exceeded, please try again.'), 'rate_limit'],
      [new Error('5007: No such model @cf/moonshotai/kimi-k2.7-code or task'), 'fatal'],
      [new Error('InferenceUpstreamError: upstream connect error'), 'transport'],
    ];
    for (const [thrown, kind] of cases) {
      const { transport } = bindingTransport(() => {
        throw thrown;
      });
      const err = (await transport.call(KIMI, { task: 'compaction', prompt: prompt('x'), runRef: 'r' }, META).catch((e: unknown) => e)) as TransportError;
      expect(err.kind).toBe(kind);
      expect(err.message).toBe(`Workers AI @cf/moonshotai/kimi-k2.7-code: ${thrown.message}`);
    }
  });

  it('a failed run records the provider status and message in model_runs, the log and the unavailable reason', async () => {
    const u = await newUser();
    const reg = new ModelRegistry({ environment: 'test', profiles: [profileNamed('fake.chat')], assignments: { chat: ['fake.chat'] } });
    const fake = new FakeModelTransport().enqueue({ error: new TransportError('transport', 'Gateway 503: API key validation is temporarily unavailable', true, 503) });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const err = (await service(u.userId, fake, reg).generate({ task: 'chat', prompt: prompt('q'), runRef: 'turn:x' }).catch((e: unknown) => e)) as ModelUnavailableError;
      expect(err).toBeInstanceOf(ModelUnavailableError);
      expect(err.message).toBe('No model profile could serve chat (fake.chat: transport: Gateway 503: API key validation is temporarily unavailable)');
      const row = await db().prepare('SELECT status, error_class, error_message, provider_status FROM model_runs WHERE user_id = ?').bind(u.userId).first();
      expect(row).toEqual({ status: 'failed', error_class: 'transport', error_message: 'Gateway 503: API key validation is temporarily unavailable', provider_status: 503 });
      const line = logged.mock.calls.map((c) => String(c[0])).find((s) => s.includes('model_run_failed'))!;
      expect(JSON.parse(line)).toMatchObject({ event: 'model_run_failed', task: 'chat', profileId: 'fake.chat', errorClass: 'transport', providerStatus: 503, message: 'Gateway 503: API key validation is temporarily unavailable' });
    } finally {
      logged.mockRestore();
    }
  });
});
