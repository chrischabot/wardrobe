import { describe, expect, it } from 'vitest';
import { db, newOwner } from './helpers/fixtures.js';
import { assistantFor, converse, fake, resetFake } from './helpers/assistant.js';
import { ASSISTANT_CHAT_PROFILES, CANDIDATE_PROFILES, MODEL_TASKS, ModelRegistry } from '../src/models/registry.js';
import { chainTaskFor } from '../src/models/service.js';
import { GatewayTransport, toAnthropicMessages, toResponsesInput } from '../src/models/transport-gateway.js';
import { GarderobeLanguageModel } from '../src/models/language-model.js';
import { reasoningDepthForTurn } from '../src/assistant/model-routing.js';
import { clearTestModelTransport, createModelService, installTestModelTransport } from '../src/assistant/runtime.js';
import type { ModelRequest, TransportMeta } from '../src/models/types.js';

/**
 * The owner's model choice (2026-09-29): GPT-6.1 Sol for routine turns, Claude Opus 5.5 at medium effort
 * where deeper reasoning is needed, never a higher tier by default.
 */
const profile = (id: string) => CANDIDATE_PROFILES.find((p) => p.profileId === id)!;
const SOL = profile('chat.gpt-6-1-sol');
const OPUS = profile('chat.opus-5-5-medium');
const META: TransportMeta = { runId: 'mrun_t', runRef: 'turn:t', task: 'chat', gatewayId: 'garderobe-dev' };

function everyCandidatePassed(): ModelRegistry {
  const reg = ModelRegistry.fromEnvironment('dev');
  // Even when every candidate (Claude Fable 5.1 and DeepSeek included) is entitled, the defaults hold.
  for (const p of CANDIDATE_PROFILES) reg.recordProbe(p.profileId, 'passed');
  return reg;
}

function recordingTransport(reply: (url: string, body: Record<string, unknown>) => Response) {
  const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const t = new GatewayTransport({
    accountId: 'acc123',
    gatewayId: 'garderobe-dev',
    allowedGatewayIds: ['garderobe-dev'],
    token: 'cf-run-token',
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      seen.push({ url, headers: init.headers as Record<string, string>, body });
      return reply(url, body);
    }) as never,
  });
  return { t, seen };
}

const ask = (text: string): ModelRequest['prompt'] => [{ role: 'system', content: 'Mandatory context' }, { role: 'user', content: [{ type: 'text', text }] }];

describe('model selection per task', () => {
  it('assigns routine conversation to Sol and deeper reasoning to Opus 5.5 medium, each the other’s fallback', () => {
    const reg = everyCandidatePassed();
    const ids = (task: (typeof MODEL_TASKS)[number]) => reg.chain(task).profiles.map((p) => p.profileId);
    expect(ids('chat')).toEqual(['chat.gpt-6-1-sol', 'chat.opus-5-5-medium']);
    expect(ids('research')).toEqual(['chat.opus-5-5-medium', 'chat.gpt-6-1-sol']);
    expect(ids('composition')).toEqual(['chat.gpt-6-1-sol', 'chat.opus-5-5-medium']);
    expect(ids('vision')).toEqual(['chat.gpt-6-1-sol', 'chat.opus-5-5-medium']);
    expect(ids('compaction')).toEqual(['compaction.workers-ai', 'chat.gpt-6-1-sol', 'chat.opus-5-5-medium']);
    expect(ids('extraction')).toEqual(['compaction.workers-ai', 'chat.gpt-6-1-sol', 'chat.opus-5-5-medium']);
    expect(ids('embeddings')).toEqual(['embeddings.workers-ai']);
    expect(ids('generation')).toEqual([]);
  });

  it('no task defaults to a profile above the allowed tier, even when a higher tier is entitled', () => {
    const reg = everyCandidatePassed();
    const ceiling = { input: OPUS.pricing.inputMicroUsdPerMTok, output: OPUS.pricing.outputMicroUsdPerMTok };
    const used = new Set(MODEL_TASKS.flatMap((task) => reg.chain(task).profiles));
    for (const p of used) {
      expect(p.pricing.inputMicroUsdPerMTok, p.profileId).toBeLessThanOrEqual(ceiling.input);
      expect(p.pricing.outputMicroUsdPerMTok, p.profileId).toBeLessThanOrEqual(ceiling.output);
    }
    const chatModels = [...used].filter((p) => p.provider !== 'workers-ai').map((p) => p.profileId);
    expect(new Set(chatModels)).toEqual(new Set(ASSISTANT_CHAT_PROFILES));
    expect([...used].map((p) => p.profileId)).not.toContain('chat.fable-5-1');
    expect([...used].map((p) => p.profileId)).not.toContain('chat.deepseek-flash');
  });

  it('a deep conversational request is served from the research chain; other tasks keep their own', () => {
    expect(chainTaskFor({ task: 'chat', depth: 'deep' })).toBe('research');
    expect(chainTaskFor({ task: 'chat', depth: 'routine' })).toBe('chat');
    expect(chainTaskFor({ task: 'chat' })).toBe('chat');
    expect(chainTaskFor({ task: 'compaction', depth: 'deep' })).toBe('compaction');
  });

  it('routes turns by the owner’s own words: dressing and logging are routine; buying, sizing, provenance and keep-or-sell are deep', () => {
    const routine = ['What should I wear tomorrow?', 'I wore the Donegal blazer and the mid jeans today', 'The navy socks are in the wash', 'Swap the shirt on option two', 'Does option three work for dinner?'];
    const deep = [
      "Should I buy the Drake's chore coat in a 46?",
      'Does the De Bonne Facture size chart put me in a 5?',
      'Is this shirtmaker’s collar fused or sewn?',
      'Compare the two Paraboot models for me',
      'Should I sell or alter the PWVC overcoat?',
    ];
    for (const text of routine) expect(reasoningDepthForTurn({ text }), text).toBe('routine');
    for (const text of deep) expect(reasoningDepthForTurn({ text }), text).toBe('deep');
    expect(reasoningDepthForTurn({ text: 'Thoughts?', attachments: [{ kind: 'link' }] })).toBe('deep');
    expect(reasoningDepthForTurn({ text: 'What did I wear here?', attachments: [{ kind: 'image' }] })).toBe('routine');
  });

  it('a routine question quoting a calendar title with a deep-topic word stays on Sol; the owner’s own deep words still go to Opus (simulation D2)', () => {
    const routine = [
      // The simulation's exact wording (6, 12 and 23 October were sent to Opus).
      'I have "Design review" today. Which of this morning\u2019s outfits would you pick, and why? Keep it short.',
      'I have "Design review" today. Put together one outfit for today from what is clean and check it with Garderobe before you show it to me.',
      "I have 'Design review' at ten. Which option?",
      'I have \u201cQuarterly size-up\u201d with finance at noon. Which outfit?',
      'Portfolio review at ten, then drinks. Which of the board works?',
      'Forwarding this:\n> Subject: Should I buy the team lunch?\nWhich outfit for that?',
    ];
    const deep = [
      // The simulation's planned deep questions.
      'I\u2019m tempted by another navy chore coat. Looking at what I already own, would it add anything? Be honest.',
      'How should a Shetland crewneck fit me, and does it layer well under my chore coats given my sizes?',
      'Tell me about the provenance of my Paraboot shoes. What makes the Norwegian split-toe construction worth it?',
      'Which piece in my wardrobe do I wear least relative to how similar it is to other pieces? Should I keep, sell or alter it?',
      // Product reviews are research; a quoted title does not hide the owner's own deep words.
      "Have you read any reviews of Drake's Games blazer?",
      'What do the reviews say about the Paraboot Michael?',
      'I have "Design review" today, but first: should I buy the Drake\u2019s chore coat in a 46?',
      "I'll be honest, I want to buy Drake's chore coat.",
      // Product reviews in other word orders stay deep (change review finding).
      'Can you review this jacket?',
      'Paraboot reviews: are they worth reading?',
      'Any Paraboot reviews?',
    ];
    for (const text of routine) expect(reasoningDepthForTurn({ text }), text).toBe('routine');
    for (const text of deep) expect(reasoningDepthForTurn({ text }), text).toBe('deep');
    // Meeting uses of "review" stay routine, quoted or not.
    for (const text of ['Back-to-back design reviews today. Which outfit?', 'Can you review the options for today?', 'Review the board for tomorrow please', 'I have code reviews all afternoon; which option works?']) {
      expect(reasoningDepthForTurn({ text }), text).toBe('routine');
    }
  });

  it('the assistant sends a routine turn to the chat chain and a deep turn to the research chain, logging which served it', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    await converse(a, 'What should I wear tomorrow?');
    await converse(a, "Should I buy the Drake's chore coat in a 46?");
    const convo = fake.calls.filter((c) => c.task === 'chat');
    expect(convo.map((c) => c.profileId)).toEqual(['fake.chat', 'fake.research']);
    const runs = await db().prepare("SELECT task, profile_id FROM model_runs WHERE user_id = ? AND status = 'succeeded' ORDER BY created_at").bind(owner.userId).all<{ task: string; profile_id: string }>();
    expect(runs.results).toEqual([
      { task: 'chat', profile_id: 'fake.chat' },
      { task: 'research', profile_id: 'fake.research' },
    ]);
  });
});

describe('deployment wiring', () => {
  it('a deployed runtime serves a deep turn from Opus on the Anthropic route and a routine turn from Sol, with no silent skip', async () => {
    const u = await newOwner();
    const at = '2026-09-29T19:00:00.000Z';
    const probes = JSON.stringify(Object.fromEntries(ASSISTANT_CHAT_PROFILES.map((id) => [id, { status: 'passed', checkedAt: at, gatewayId: 'garderobe-dev' }])));
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    // The test helper installs the fake model for this isolate; the deployed path needs it removed.
    clearTestModelTransport();
    // Stands in for the network only; the registry, model service and transport are the deployed code.
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return String(url).endsWith('/anthropic/v1/messages')
        ? Response.json({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'deep answer' }], usage: { input_tokens: 10, output_tokens: 3 } })
        : Response.json({ model: 'gpt-6.1-sol', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'routine answer' }] }], usage: { input_tokens: 10, output_tokens: 3 } });
    }) as typeof fetch;
    try {
      const svc = createModelService({ DB: db(), AI: {} as Ai, ENVIRONMENT: 'dev', AI_GATEWAY_ID: 'garderobe-dev', AI_GATEWAY_ACCOUNT_ID: 'acc', AI_GATEWAY_TOKEN: 'cf-run-token', MODEL_PROBES: probes }, u.userId);
      const deep = await svc.generate({ task: 'chat', depth: 'deep', prompt: ask('Should I buy it?'), runRef: 'turn:deep' });
      const routine = await svc.generate({ task: 'chat', depth: 'routine', prompt: ask('What should I wear?'), runRef: 'turn:routine' });
      expect([deep.profileId, deep.route, deep.fallbackFrom]).toEqual(['chat.opus-5-5-medium', 'gateway-anthropic', []]);
      expect([routine.profileId, routine.route, routine.fallbackFrom]).toEqual(['chat.gpt-6-1-sol', 'gateway-openai-responses', []]);
      expect(urls).toEqual(['https://gateway.ai.cloudflare.com/v1/acc/garderobe-dev/anthropic/v1/messages', 'https://gateway.ai.cloudflare.com/v1/acc/garderobe-dev/openai/responses']);
    } finally {
      globalThis.fetch = realFetch;
      installTestModelTransport(fake);
    }
  });
});

describe('GPT-6.1 Sol on the OpenAI Responses route', () => {
  const tools = [{ type: 'function' as const, name: 'wardrobe_search', description: 'Search the ledger', inputSchema: { type: 'object' as const, properties: { q: { type: 'string' as const } } } }];

  it('sends a stateless request with medium reasoning, tools and max_output_tokens, never a temperature', async () => {
    const { t, seen } = recordingTransport(() => Response.json({ model: 'gpt-6.1-sol', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 13, output_tokens: 4 } }));
    const r = await t.call(SOL, { task: 'chat', prompt: ask('hi'), tools, runRef: 'turn:1', maxOutputTokens: 500, temperature: 0.2 }, META);
    expect(seen[0]!.url).toBe('https://gateway.ai.cloudflare.com/v1/acc123/garderobe-dev/openai/responses');
    expect(seen[0]!.body).toMatchObject({
      model: 'gpt-6.1-sol',
      max_output_tokens: 500,
      reasoning: { effort: 'medium' },
      store: false,
      include: ['reasoning.encrypted_content'],
      tools: [{ type: 'function', name: 'wardrobe_search', description: 'Search the ledger', parameters: { type: 'object', properties: { q: { type: 'string' } } }, strict: false }],
      tool_choice: 'auto',
      input: [{ role: 'system', content: 'Mandatory context' }, { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    });
    expect(seen[0]!.body).not.toHaveProperty('temperature');
    expect(Object.keys(seen[0]!.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(r.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(r.usage).toEqual({ inputTokens: 13, outputTokens: 4 });
  });

  it('reads reasoning, text and function calls, and returns them statelessly on the next step', async () => {
    const { t } = recordingTransport(() =>
      Response.json({
        model: 'gpt-6.1-sol',
        status: 'completed',
        output: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-abc', summary: [{ type: 'summary_text', text: 'Check the ledger.' }] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'wardrobe_search', arguments: '{"q":"chore"}' },
        ],
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );
    const r = await t.call(SOL, { task: 'chat', prompt: ask('Chore coats?'), tools, runRef: 'turn:1' }, META);
    expect(r.content).toEqual([
      { type: 'reasoning', text: 'Check the ledger.', providerMetadata: { openai: { itemId: 'rs_1', encryptedContent: 'enc-abc', model: 'gpt-6.1-sol' } } },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'wardrobe_search', input: '{"q":"chore"}' },
    ]);
    expect(r.finishReason.unified).toBe('tool-calls');
    const input = toResponsesInput(
      [
        ...ask('Chore coats?'),
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'wardrobe_search', input: '{"q":"chore"}' },
            { type: 'reasoning', text: 'Check the ledger.', providerOptions: { openai: { itemId: 'rs_1', encryptedContent: 'enc-abc', model: 'gpt-6.1-sol' } } },
            // Claude's thinking is not OpenAI's and is dropped.
            { type: 'reasoning', text: 'x', providerOptions: { anthropic: { signature: 's', model: 'claude-opus-5-5' } } },
          ],
        },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'wardrobe_search', output: { type: 'json', value: { items: 3 } } }] },
      ],
      'gpt-6.1-sol',
    );
    expect(input.slice(2)).toEqual([
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc-abc', summary: [] },
      // No item id: nothing stored is referenced.
      { type: 'function_call', call_id: 'call_1', name: 'wardrobe_search', arguments: '{"q":"chore"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"items":3}' },
    ]);
  });

  it('a length-limited reply with no text is invalid output (a fallback class), not an empty answer', async () => {
    const { t } = recordingTransport(() => Response.json({ model: 'gpt-6.1-sol', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] }], usage: { input_tokens: 10, output_tokens: 500 } }));
    const err = (await t.call(SOL, { task: 'chat', prompt: ask('x'), runRef: 'r' }, META).catch((e: unknown) => e)) as Error & { kind?: string };
    expect(err).toMatchObject({ kind: 'invalid_output' });
    expect(err.message).toMatch(/no text or tool call \(status incomplete, max_output_tokens\)/);
  });
});

describe('the compat route honours profile wire settings', () => {
  it('sends max_completion_tokens instead of max_tokens and omits temperature when a profile says so', async () => {
    const { t, seen } = recordingTransport(() => Response.json({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const p = { ...SOL, profileId: 'test.compat', route: 'gateway-compat' as const, apiModelId: 'openai/some-reasoning-model', effort: {}, wire: { maxTokensField: 'max_completion_tokens' as const, sampling: false } };
    await t.call(p, { task: 'chat', prompt: ask('hi'), runRef: 'r', maxOutputTokens: 300, temperature: 0.5 }, META);
    expect(seen[0]!.body).toMatchObject({ model: 'openai/some-reasoning-model', max_completion_tokens: 300 });
    expect(seen[0]!.body).not.toHaveProperty('max_tokens');
    expect(seen[0]!.body).not.toHaveProperty('temperature');
  });
});

describe('Claude Opus 5.5 on the native Anthropic route', () => {
  const anthropicReply = {
    model: 'claude-opus-5-5',
    stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: 'The owner wants a size check.', signature: 'sig-abc' },
      { type: 'text', text: 'Let me check the ledger.' },
      { type: 'tool_use', id: 'toolu_01', name: 'wardrobe_search', input: { q: 'chore' } },
    ],
    usage: { input_tokens: 1200, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, output_tokens: 90 },
  };

  it('calls the gateway’s Anthropic endpoint with medium effort, no provider key, automatic tool choice and no temperature', async () => {
    const { t, seen } = recordingTransport(() => Response.json(anthropicReply));
    const tools = [{ type: 'function' as const, name: 'wardrobe_search', description: 'Search the ledger', inputSchema: { type: 'object' as const, properties: { q: { type: 'string' as const } } } }];
    await t.call(OPUS, { task: 'chat', prompt: [{ role: 'system', content: 'Policy' }, { role: 'system', content: 'Profile' }, { role: 'user', content: [{ type: 'text', text: 'Size?' }] }], tools, toolChoice: { type: 'required' }, temperature: 0.3, runRef: 'turn:1', maxOutputTokens: 4000 }, META);
    const call = seen[0]!;
    expect(call.url).toBe('https://gateway.ai.cloudflare.com/v1/acc123/garderobe-dev/anthropic/v1/messages');
    const headers = Object.fromEntries(Object.entries(call.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['cf-aig-authorization']).toBe('Bearer cf-run-token');
    expect(headers).not.toHaveProperty('x-api-key');
    expect(headers).not.toHaveProperty('authorization');
    expect(call.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: { effort: 'medium' },
      system: 'Policy\n\nProfile',
      tools: [{ name: 'wardrobe_search', description: 'Search the ledger', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Size?' }] }],
    });
    expect(call.body).not.toHaveProperty('temperature');
  });

  it('reads thinking, text and tool use, keeping the thinking signature for the next tool step', async () => {
    const { t } = recordingTransport(() => Response.json(anthropicReply));
    const r = await t.call(OPUS, { task: 'chat', prompt: ask('Size?'), runRef: 'turn:1' }, META);
    expect(r.content).toEqual([
      { type: 'reasoning', text: 'The owner wants a size check.', providerMetadata: { anthropic: { signature: 'sig-abc', model: 'claude-opus-5-5' } } },
      { type: 'text', text: 'Let me check the ledger.' },
      { type: 'tool-call', toolCallId: 'toolu_01', toolName: 'wardrobe_search', input: '{"q":"chore"}' },
    ]);
    expect(r.finishReason.unified).toBe('tool-calls');
    expect(r.usage).toEqual({ inputTokens: 1500, outputTokens: 90 });
    expect(r.providerModel).toBe('claude-opus-5-5');
  });

  it('returns thinking blocks first with their signature, sends tool results as user blocks and drops other models’ thinking', () => {
    const { system, messages } = toAnthropicMessages(
      [
        { role: 'system', content: 'Policy' },
        { role: 'user', content: [{ type: 'text', text: 'Earlier question' }] },
        // An earlier turn by another model: its reasoning is not Anthropic's and is dropped.
        { role: 'assistant', content: [{ type: 'reasoning', text: 'other', providerOptions: { anthropic: { signature: 'x', model: 'claude-fable-5-1' } } }, { type: 'text', text: 'Earlier answer' }] },
        { role: 'user', content: [{ type: 'text', text: 'Size?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool-call', toolCallId: 'toolu_01', toolName: 'wardrobe_search', input: '{"q":"chore"}' },
            { type: 'reasoning', text: 'Need the ledger.', providerOptions: { anthropic: { signature: 'sig-abc', model: 'claude-opus-5-5' } } },
          ],
        },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_01', toolName: 'wardrobe_search', output: { type: 'json', value: { items: 1 } } }] },
        { role: 'user', content: [{ type: 'text', text: 'And the 48?' }] },
      ],
      'claude-opus-5-5',
    );
    expect(system).toBe('Policy');
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Earlier question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'Size?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need the ledger.', signature: 'sig-abc' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_01', name: 'wardrobe_search', input: { q: 'chore' } },
        ],
      },
      // The tool result and the next question merge into one user turn (the API requires alternation).
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"items":1}' }, { type: 'text', text: 'And the 48?' }] },
    ]);
  });

  it('a gateway error on the Anthropic route keeps the provider status and message', async () => {
    const { t } = recordingTransport(() => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: "output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'" } }), { status: 400 }));
    const err = await t.call(OPUS, { task: 'chat', prompt: ask('x'), runRef: 'r' }, META).catch((e: unknown) => e as Error & { status?: number; kind?: string });
    expect(err).toMatchObject({ kind: 'fatal', status: 400, message: "Gateway 400: output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'" });
  });

  it('the language model streams reasoning with its metadata so the SDK can return it in the next step', async () => {
    const service = {
      generate: async () => ({
        content: [
          { type: 'reasoning', text: 'Think.', providerMetadata: { anthropic: { signature: 'sig-abc', model: 'claude-opus-5-5' } } },
          { type: 'text', text: 'Answer.' },
        ],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: { inputTokens: 10, outputTokens: 5 },
        runId: 'mrun_x',
        profileId: OPUS.profileId,
        provider: 'anthropic',
        apiModelId: OPUS.apiModelId,
        route: OPUS.route,
        gatewayId: 'garderobe-dev',
        costMicroUsd: 1,
        fallbackFrom: [],
      }),
    };
    const lm = new GarderobeLanguageModel(service as never, { task: 'chat', runRef: () => 'turn:x', promptVersion: 'p', profileVersion: () => 1, dataClasses: [] });
    const { stream } = await lm.doStream({ prompt: ask('x') } as never);
    const parts: { type: string; providerMetadata?: unknown }[] = [];
    const reader = stream.getReader();
    for (let x = await reader.read(); !x.done; x = await reader.read()) parts.push(x.value as never);
    const start = parts.find((p) => p.type === 'reasoning-start');
    expect(start?.providerMetadata).toEqual({ anthropic: { signature: 'sig-abc', model: 'claude-opus-5-5' } });
    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'response-metadata', 'reasoning-start', 'reasoning-delta', 'reasoning-end', 'text-start', 'text-delta', 'text-end', 'finish']);
  });
});
