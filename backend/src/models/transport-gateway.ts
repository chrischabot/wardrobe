import type { LanguageModelV3Content, LanguageModelV3FinishReason, LanguageModelV3Prompt, LanguageModelV3ToolChoice } from '@ai-sdk/provider';
import { withoutPastedSecrets } from '../assistant/secrets.js';
import { estimateTokens } from './budget.js';
import type { ModelProfile } from './registry.js';
import { TransportError, type ModelRequest, type ModelTransport, type TransportMeta, type TransportResult } from './types.js';

/**
 * Real AI Gateway transport (spec section 12). Every call names the configured gateway; the
 * gateway id comes from trusted configuration and is checked against the allow-list. No provider
 * key or BYOK header is ever sent: Unified Billing authenticates with the Gateway token only.
 *
 * Routes:
 *  - gateway-compat: POST https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat/chat/completions
 *    with `cf-aig-authorization`, OpenAI-compatible body and `provider/model` ids. The output-limit
 *    field and sampling parameters follow the profile's `wire` settings (gpt-6.1-sol needs
 *    `max_completion_tokens` and takes no temperature).
 *  - gateway-anthropic: POST .../{gateway}/anthropic/v1/messages, Anthropic's own Messages API with
 *    Unified Billing (gateway token, no provider key). Claude Opus 5.5 runs here because the compat
 *    endpoint drops `output_config.effort`. Its thinking cannot be disabled, so thinking blocks come
 *    back as reasoning parts carrying their signature and are returned with the next tool step.
 *  - gateway-openai-responses: POST .../{gateway}/openai/responses, OpenAI's Responses API with Unified
 *    Billing. GPT-6.1 Sol runs here because /chat/completions refuses function tools with reasoning for
 *    it. Requests are stateless (`store: false`); reasoning items come back encrypted and are returned
 *    with the next tool step, like Claude's thinking blocks.
 *  - workers-ai-binding: env.AI.run(model, input, { gateway: { id, skipCache: true } }). Chat models
 *    get `messages`; embedding models get `{ text: [...] }`. Both Workers AI reply shapes are read:
 *    the classic `{ response }` (llama) and the OpenAI-style `{ choices }` (kimi-k2.7-code).
 *
 * Failures keep the provider's HTTP status and message (secrets redacted) in the TransportError, so
 * the run log and the turn's failure reason say what went wrong, not only the error class.
 *
 * Tests use recorded reply shapes and FakeModelTransport; the dev deployment exercises it live.
 */
export interface GatewayTransportConfig {
  accountId: string;
  gatewayId: string;
  allowedGatewayIds: readonly string[];
  /** Gateway run token (Worker secret); never exposed to a model, Sandbox, MCP consumer or phone. */
  token?: string;
  ai?: Ai;
  fetch?: typeof fetch;
}

const FORBIDDEN_HEADERS = ['authorization', 'x-api-key', 'api-key', 'anthropic-api-key', 'openai-api-key'];

export class GatewayTransport implements ModelTransport {
  readonly routes = ['gateway-compat', 'gateway-anthropic', 'gateway-openai-responses', 'workers-ai-binding'] as const;
  constructor(private readonly config: GatewayTransportConfig) {
    if (!config.allowedGatewayIds.includes(config.gatewayId)) {
      throw new Error(`Gateway ${config.gatewayId} is not in the trusted allow-list`);
    }
  }

  async call(profile: ModelProfile, request: ModelRequest, meta: TransportMeta): Promise<TransportResult> {
    if (meta.gatewayId !== this.config.gatewayId) throw new TransportError('fatal', 'Gateway mismatch', false);
    if (profile.route === 'gateway-compat') return this.compat(profile, request, meta);
    if (profile.route === 'gateway-anthropic') return this.anthropic(profile, request, meta);
    if (profile.route === 'gateway-openai-responses') return this.responses(profile, request, meta);
    if (profile.route === 'workers-ai-binding') return this.binding(profile, request, meta);
    throw new TransportError('fatal', `Route ${profile.route} is not served by the gateway transport`, false);
  }

  /** Headers for a compat call. Exposed for tests of the no-BYOK rule. */
  headersFor(meta: TransportMeta): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'cf-aig-metadata': JSON.stringify({ run: meta.runId, task: meta.task, ref: meta.runRef.slice(0, 64) }),
      'cf-aig-skip-cache': 'true',
    };
    if (this.config.token) headers['cf-aig-authorization'] = `Bearer ${this.config.token}`;
    for (const h of Object.keys(headers)) if (FORBIDDEN_HEADERS.includes(h.toLowerCase())) throw new Error('Provider credentials are never sent');
    return headers;
  }

  private async compat(profile: ModelProfile, request: ModelRequest, meta: TransportMeta): Promise<TransportResult> {
    const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(this.config.accountId)}/${encodeURIComponent(this.config.gatewayId)}/compat/chat/completions`;
    const body: Record<string, unknown> = {
      model: profile.apiModelId,
      messages: toOpenAiMessages(request.prompt),
      [profile.wire?.maxTokensField ?? 'max_tokens']: Math.min(request.maxOutputTokens ?? profile.maxOutputTokens, profile.maxOutputTokens),
      ...profile.effort,
    };
    if (request.temperature !== undefined && profile.wire?.sampling !== false) body.temperature = request.temperature;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    }
    if (request.responseFormat?.type === 'json') body.response_format = request.responseFormat.schema ? { type: 'json_schema', json_schema: { name: request.responseFormat.name ?? 'result', schema: request.responseFormat.schema } } : { type: 'json_object' };
    const doFetch = this.config.fetch ?? fetch;
    const res = await this.post(doFetch, url, this.headersFor(meta), body, request, profile);
    if (!res.ok) throw await this.gatewayFailure(res);
    const payload = (await res.json().catch(() => null)) as OpenAiResponse | null;
    if (!payload) throw new TransportError('invalid_output', `Gateway ${res.status}: the reply was not JSON`, true, res.status);
    const choice = payload.choices?.[0];
    if (!choice) throw new TransportError('invalid_output', `Gateway ${res.status}: no choice returned`, true, res.status);
    const content: LanguageModelV3Content[] = [];
    if (choice.message?.content) content.push({ type: 'text', text: choice.message.content });
    for (const tc of choice.message?.tool_calls ?? []) content.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: tc.function.arguments });
    return {
      content,
      finishReason: finishReasonOf(choice.finish_reason),
      usage: { inputTokens: payload.usage?.prompt_tokens ?? 0, outputTokens: payload.usage?.completion_tokens ?? 0 },
      providerModel: payload.model,
    };
  }

  private async post(doFetch: typeof fetch, url: string, headers: Record<string, string>, body: unknown, request: ModelRequest, profile: ModelProfile): Promise<Response> {
    try {
      return await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: request.abortSignal ?? AbortSignal.timeout(profile.timeoutMs) });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new TransportError(timeout ? 'timeout' : 'transport', timeout ? 'Model request timed out' : `Model transport failed: ${this.redact(err instanceof Error ? err.message : String(err))}`, true);
    }
  }

  /** Anthropic Messages API through the gateway (Unified Billing; no provider key is ever sent). */
  private async anthropic(profile: ModelProfile, request: ModelRequest, meta: TransportMeta): Promise<TransportResult> {
    const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(this.config.accountId)}/${encodeURIComponent(this.config.gatewayId)}/anthropic/v1/messages`;
    const { system, messages } = toAnthropicMessages(request.prompt, profile.apiModelId);
    const body: Record<string, unknown> = {
      model: profile.apiModelId,
      max_tokens: Math.min(request.maxOutputTokens ?? profile.maxOutputTokens, profile.maxOutputTokens),
      messages,
      ...profile.effort,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined && profile.wire?.sampling !== false) body.temperature = request.temperature;
    const toolChoice = anthropicToolChoice(request.toolChoice);
    if (request.tools?.length && toolChoice !== 'none') {
      body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      // Opus 5.5 refuses forced tool use, so the model always chooses ("auto").
      body.tool_choice = { type: 'auto' };
    }
    const doFetch = this.config.fetch ?? fetch;
    const res = await this.post(doFetch, url, { ...this.headersFor(meta), 'anthropic-version': '2023-06-01' }, body, request, profile);
    if (!res.ok) throw await this.gatewayFailure(res);
    const payload = (await res.json().catch(() => null)) as AnthropicResponse | null;
    if (!payload || !Array.isArray(payload.content)) throw new TransportError('invalid_output', `Gateway ${res.status}: the reply was not an Anthropic message`, true, res.status);
    const content: LanguageModelV3Content[] = [];
    for (const block of payload.content) {
      if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use' && block.id && block.name) content.push({ type: 'tool-call', toolCallId: block.id, toolName: block.name, input: JSON.stringify(block.input ?? {}) });
      else if (block.type === 'thinking') content.push({ type: 'reasoning', text: block.thinking ?? '', providerMetadata: { anthropic: { signature: block.signature ?? '', model: profile.apiModelId } } });
      else if (block.type === 'redacted_thinking') content.push({ type: 'reasoning', text: '', providerMetadata: { anthropic: { redactedData: block.data ?? '', model: profile.apiModelId } } });
    }
    if (!content.some((c) => c.type === 'text' || c.type === 'tool-call')) {
      throw new TransportError('invalid_output', `Anthropic ${profile.apiModelId}: the reply had no text or tool call (stop_reason ${payload.stop_reason ?? 'unknown'})`, true, res.status);
    }
    const u = payload.usage ?? {};
    const stop = payload.stop_reason;
    return {
      content,
      finishReason: { unified: stop === 'tool_use' ? 'tool-calls' : stop === 'max_tokens' ? 'length' : stop === 'refusal' ? 'content-filter' : 'stop', raw: stop ?? 'end_turn' },
      usage: { inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 },
      providerModel: payload.model,
    };
  }

  /** OpenAI Responses API through the gateway (Unified Billing; stateless; no provider key is ever sent). */
  private async responses(profile: ModelProfile, request: ModelRequest, meta: TransportMeta): Promise<TransportResult> {
    const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(this.config.accountId)}/${encodeURIComponent(this.config.gatewayId)}/openai/responses`;
    const body: Record<string, unknown> = {
      model: profile.apiModelId,
      input: toResponsesInput(request.prompt, profile.apiModelId),
      max_output_tokens: Math.min(request.maxOutputTokens ?? profile.maxOutputTokens, profile.maxOutputTokens),
      store: false,
      include: ['reasoning.encrypted_content'],
      ...profile.effort,
    };
    if (request.temperature !== undefined && profile.wire?.sampling !== false) body.temperature = request.temperature;
    if (request.tools?.length && request.toolChoice?.type !== 'none') {
      body.tools = request.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false }));
      body.tool_choice = request.toolChoice?.type === 'required' ? 'required' : request.toolChoice?.type === 'tool' ? { type: 'function', name: request.toolChoice.toolName } : 'auto';
    }
    if (request.responseFormat?.type === 'json') body.text = { format: request.responseFormat.schema ? { type: 'json_schema', name: request.responseFormat.name ?? 'result', schema: request.responseFormat.schema } : { type: 'json_object' } };
    const doFetch = this.config.fetch ?? fetch;
    const res = await this.post(doFetch, url, this.headersFor(meta), body, request, profile);
    if (!res.ok) throw await this.gatewayFailure(res);
    const payload = (await res.json().catch(() => null)) as ResponsesResponse | null;
    if (!payload || !Array.isArray(payload.output)) throw new TransportError('invalid_output', `Gateway ${res.status}: the reply was not a Responses result`, true, res.status);
    if (payload.status === 'failed') throw new TransportError('invalid_output', `OpenAI ${profile.apiModelId}: ${this.redact(payload.error?.message ?? 'the response failed')}`, true, res.status);
    const content: LanguageModelV3Content[] = [];
    let calls = 0;
    for (const item of payload.output) {
      if (item.type === 'reasoning' && item.encrypted_content) {
        content.push({ type: 'reasoning', text: (item.summary ?? []).map((s) => s.text ?? '').join('\n'), providerMetadata: { openai: { itemId: item.id ?? '', encryptedContent: item.encrypted_content, model: profile.apiModelId } } });
      } else if (item.type === 'message') {
        const text = (item.content ?? []).map((c) => (c.type === 'output_text' ? (c.text ?? '') : c.type === 'refusal' ? (c.refusal ?? '') : '')).join('');
        if (text) content.push({ type: 'text', text });
      } else if (item.type === 'function_call' && item.call_id && item.name) {
        calls++;
        content.push({ type: 'tool-call', toolCallId: item.call_id, toolName: item.name, input: item.arguments ?? '{}' });
      }
    }
    if (!content.some((c) => c.type === 'text' || c.type === 'tool-call')) {
      throw new TransportError('invalid_output', `OpenAI ${profile.apiModelId}: the reply had no text or tool call (status ${payload.status ?? 'unknown'}${payload.incomplete_details?.reason ? `, ${payload.incomplete_details.reason}` : ''})`, true, res.status);
    }
    const incomplete = payload.status === 'incomplete';
    return {
      content,
      finishReason: { unified: calls ? 'tool-calls' : incomplete ? (payload.incomplete_details?.reason === 'content_filter' ? 'content-filter' : 'length') : 'stop', raw: incomplete ? (payload.incomplete_details?.reason ?? 'incomplete') : calls ? 'function_call' : 'completed' },
      usage: { inputTokens: payload.usage?.input_tokens ?? 0, outputTokens: payload.usage?.output_tokens ?? 0 },
      providerModel: payload.model,
    };
  }

  /** A non-2xx gateway reply as a TransportError carrying the status and the provider's own message. */
  private async gatewayFailure(res: Response): Promise<TransportError> {
    const detail = this.redact(providerMessage(await res.text().catch(() => '')));
    const message = `Gateway ${res.status}${detail ? `: ${detail}` : ''}`;
    if (res.status === 429) return new TransportError('rate_limit', message, true, res.status);
    if (res.status >= 500) return new TransportError('transport', message, true, res.status);
    if (/context|too long|maximum context|too many tokens/i.test(detail)) return new TransportError('context_overflow', message, true, res.status);
    return new TransportError('fatal', message, true, res.status);
  }

  /** Provider text is logged and shown to the owner: strip credentials, including our own gateway token. */
  private redact(text: string): string {
    let out = text;
    if (this.config.token) out = out.split(this.config.token).join('<redacted>');
    return withoutPastedSecrets(out).replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  private async binding(profile: ModelProfile, request: ModelRequest, meta: TransportMeta): Promise<TransportResult> {
    if (!this.config.ai) throw new TransportError('fatal', 'No AI binding configured', false);
    const embedding = request.task === 'embeddings';
    const texts = embedding ? embeddingInputs(request.prompt) : [];
    if (embedding && !texts.length) throw new TransportError('fatal', 'An embedding request needs at least one text', false);
    const input = embedding ? { text: texts } : { messages: toOpenAiMessages(request.prompt), max_tokens: request.maxOutputTokens ?? profile.maxOutputTokens, ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) };
    let out: unknown;
    try {
      out = await this.config.ai.run(profile.apiModelId as never, input as never, { gateway: { id: this.config.gatewayId, skipCache: true, metadata: { run: meta.runId, task: meta.task } } } as never);
    } catch (err) {
      throw this.bindingFailure(profile, err);
    }
    return embedding ? readEmbeddings(profile, out, texts) : readWorkersAiText(profile, out);
  }

  /** Workers AI binding errors carry the provider message ("3040: Capacity temporarily exceeded", "5007: No such model"). */
  private bindingFailure(profile: ModelProfile, err: unknown): TransportError {
    const e = err as { name?: string; message?: string; status?: number } | null;
    const raw = e?.message ?? String(err);
    const status = typeof e?.status === 'number' ? e.status : undefined;
    const message = `Workers AI ${profile.apiModelId}${status ? ` ${status}` : ''}: ${this.redact(raw) || e?.name || 'call failed'}`;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new TransportError('timeout', message, true, status);
    if (status === 429 || /\b3040\b|capacity|rate limit|too many requests/i.test(raw)) return new TransportError('rate_limit', message, true, status);
    if (/context|too long|too many tokens/i.test(raw)) return new TransportError('context_overflow', message, true, status);
    if ((status !== undefined && status >= 400 && status < 500) || /\b(5006|5007|5016|5018|8001)\b|invalid input|required propert|no such model/i.test(raw)) return new TransportError('fatal', message, true, status);
    return new TransportError('transport', message, true, status);
  }
}

function finishReasonOf(raw: string | null | undefined): LanguageModelV3FinishReason {
  const r = raw ?? 'stop';
  return { unified: r === 'tool_calls' ? 'tool-calls' : r === 'length' ? 'length' : r === 'content_filter' ? 'content-filter' : 'stop', raw: r };
}

/** The error text of a gateway or provider body: JSON error shapes first, else the raw text. */
export function providerMessage(body: string): string {
  let j: unknown = null;
  try {
    j = JSON.parse(body);
  } catch {
    return body.replace(/<[^>]*>/g, ' ');
  }
  const pick = (v: unknown): string | null => {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(pick).filter(Boolean).join('; ') || null;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const msg = pick(o.message) ?? pick(o.error) ?? pick(o.errors) ?? pick(o.detail);
      if (msg) return typeof o.code === 'number' || typeof o.code === 'string' ? `${msg} (code ${o.code})` : msg;
    }
    return null;
  };
  return pick(j) ?? body;
}

/** Each user text part is one embedding input, in order; system text is not embedded. */
function embeddingInputs(prompt: LanguageModelV3Prompt): string[] {
  const out: string[] = [];
  for (const m of prompt) if (m.role === 'user') for (const p of m.content) if (p.type === 'text' && p.text.trim()) out.push(p.text);
  return out;
}

function readEmbeddings(profile: ModelProfile, out: unknown, texts: string[]): TransportResult {
  const o = (out ?? {}) as { data?: unknown; response?: unknown; usage?: { prompt_tokens?: number } };
  const vectors = [o.data, o.response].find((v) => Array.isArray(v) && v.every((row) => Array.isArray(row) && row.every((x) => typeof x === 'number'))) as number[][] | undefined;
  if (!vectors || vectors.length !== texts.length) {
    throw new TransportError('invalid_output', `Workers AI ${profile.apiModelId}: expected ${texts.length} embedding vector(s), got ${vectors ? vectors.length : `a reply with keys ${shapeOf(out)}`}`, true);
  }
  return {
    content: [],
    embeddings: vectors,
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: o.usage?.prompt_tokens ?? estimateTokens(texts.join('\n')), outputTokens: 0 },
    providerModel: profile.apiModelId,
  };
}

type WorkersAiToolCall = { id?: string; name?: string; arguments?: unknown; function?: { name: string; arguments: unknown } };

/**
 * Workers AI text generation replies come in two shapes: the classic `{ response, tool_calls?, usage }`
 * and the OpenAI chat-completion `{ model, choices: [{ message: { content, tool_calls? }, finish_reason }], usage }`.
 * A reply with neither text nor tool calls is invalid output (for example a reasoning model that spent
 * the whole token allowance thinking), never an empty answer.
 */
export function readWorkersAiText(profile: ModelProfile, out: unknown): TransportResult {
  const o = (typeof out === 'string' ? { response: out } : (out ?? {})) as {
    response?: unknown;
    tool_calls?: WorkersAiToolCall[];
    choices?: { finish_reason?: string | null; message?: { content?: unknown; tool_calls?: WorkersAiToolCall[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  const choice = o.choices?.[0];
  let text = '';
  let calls: WorkersAiToolCall[] = [];
  let finish: string | null | undefined;
  if (choice) {
    text = textContent(choice.message?.content);
    calls = choice.message?.tool_calls ?? [];
    finish = choice.finish_reason;
  } else {
    if (o.response !== undefined && o.response !== null) text = typeof o.response === 'string' ? o.response : JSON.stringify(o.response);
    calls = o.tool_calls ?? [];
  }
  const content: LanguageModelV3Content[] = [];
  if (text) content.push({ type: 'text', text });
  calls.forEach((c, i) => {
    const name = c.function?.name ?? c.name;
    if (!name) return;
    const args = c.function?.arguments ?? c.arguments ?? {};
    content.push({ type: 'tool-call', toolCallId: c.id ?? `wai_call_${i + 1}`, toolName: name, input: typeof args === 'string' ? args : JSON.stringify(args) });
  });
  if (!content.length) {
    throw new TransportError('invalid_output', `Workers AI ${profile.apiModelId}: the reply had no text or tool call (keys ${shapeOf(out)}${finish ? `, finish_reason ${finish}` : ''})`, true);
  }
  return {
    content,
    finishReason: finishReasonOf(finish ?? (calls.length ? 'tool_calls' : 'stop')),
    usage: { inputTokens: o.usage?.prompt_tokens ?? 0, outputTokens: o.usage?.completion_tokens ?? 0 },
    providerModel: o.model ?? profile.apiModelId,
  };
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
  return '';
}

function shapeOf(out: unknown): string {
  return out && typeof out === 'object' ? Object.keys(out).sort().join(', ') || 'none' : typeof out;
}

interface OpenAiResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function toOpenAiMessages(prompt: LanguageModelV3Prompt): unknown[] {
  const out: unknown[] = [];
  for (const m of prompt) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content });
    else if (m.role === 'user') {
      const parts = m.content.map((p) =>
        p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: typeof p.data === 'string' ? p.data : p.data instanceof URL ? p.data.toString() : '' } },
      );
      out.push({ role: 'user', content: parts.length === 1 && parts[0]!.type === 'text' ? (parts[0] as { text: string }).text : parts });
    } else if (m.role === 'assistant') {
      const text = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
      const calls = m.content.filter((p) => p.type === 'tool-call') as { toolCallId: string; toolName: string; input: unknown }[];
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.toolCallId, type: 'function', function: { name: c.toolName, arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input) } })) } : {}),
      });
    } else if (m.role === 'tool') {
      for (const p of m.content) {
        if (p.type !== 'tool-result') continue;
        out.push({ role: 'tool', tool_call_id: p.toolCallId, content: JSON.stringify((p.output as { value?: unknown }).value ?? p.output) });
      }
    }
  }
  return out;
}

interface AnthropicResponse {
  model?: string;
  stop_reason?: string | null;
  content: { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string; signature?: string; data?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function anthropicToolChoice(choice: LanguageModelV3ToolChoice | undefined): 'auto' | 'none' {
  return choice?.type === 'none' ? 'none' : 'auto';
}

type AnthropicBlock = Record<string, unknown> & { type: string };
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function anthropicImage(p: { data: unknown; mediaType?: string }): AnthropicBlock | null {
  const d = p.data;
  if (d instanceof URL) return { type: 'image', source: { type: 'url', url: d.toString() } };
  if (typeof d === 'string') {
    if (/^https?:\/\//i.test(d)) return { type: 'image', source: { type: 'url', url: d } };
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(d);
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    return { type: 'image', source: { type: 'base64', media_type: p.mediaType ?? 'image/jpeg', data: d } };
  }
  if (d instanceof Uint8Array) return { type: 'image', source: { type: 'base64', media_type: p.mediaType ?? 'image/jpeg', data: toBase64(d) } };
  return null;
}

/**
 * The AI SDK prompt as Anthropic Messages: system text joined, tool results sent as user
 * `tool_result` blocks, consecutive same-role turns merged (the API requires alternation). Thinking
 * blocks are returned only when they carry a signature from this same model: a signature is tied to
 * the model that produced it, and blocks from any other model are dropped.
 */
export function toAnthropicMessages(prompt: LanguageModelV3Prompt, model: string): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', content: AnthropicBlock[]) => {
    if (!content.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else out.push({ role, content });
  };
  for (const m of prompt) {
    if (m.role === 'system') {
      if (m.content.trim()) system.push(m.content);
    } else if (m.role === 'user') {
      const blocks: AnthropicBlock[] = [];
      for (const p of m.content) {
        if (p.type === 'text') {
          if (p.text.trim()) blocks.push({ type: 'text', text: p.text });
        } else if (p.type === 'file' && (p.mediaType ?? '').startsWith('image/')) {
          const img = anthropicImage(p as { data: unknown; mediaType?: string });
          if (img) blocks.push(img);
        }
      }
      push('user', blocks);
    } else if (m.role === 'assistant') {
      const thinking: AnthropicBlock[] = [];
      const rest: AnthropicBlock[] = [];
      for (const p of m.content as { type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; providerOptions?: Record<string, Record<string, unknown>> }[]) {
        if (p.type === 'reasoning') {
          const a = p.providerOptions?.anthropic;
          if (!a || a.model !== model) continue;
          if (typeof a.redactedData === 'string' && a.redactedData) thinking.push({ type: 'redacted_thinking', data: a.redactedData });
          else if (typeof a.signature === 'string' && a.signature) thinking.push({ type: 'thinking', thinking: p.text ?? '', signature: a.signature });
        } else if (p.type === 'text') {
          if (p.text?.trim()) rest.push({ type: 'text', text: p.text });
        } else if (p.type === 'tool-call') {
          let input: unknown = p.input;
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input || '{}');
            } catch {
              input = {};
            }
          }
          rest.push({ type: 'tool_use', id: p.toolCallId!, name: p.toolName!, input: input ?? {} });
        }
      }
      push('assistant', [...thinking, ...rest]);
    } else if (m.role === 'tool') {
      const blocks: AnthropicBlock[] = [];
      for (const p of m.content) {
        if (p.type !== 'tool-result') continue;
        const o = p.output as { type?: string; value?: unknown };
        const isError = o?.type === 'error-text' || o?.type === 'error-json' || o?.type === 'execution-denied';
        const value = o?.value ?? o;
        blocks.push({ type: 'tool_result', tool_use_id: p.toolCallId, content: typeof value === 'string' ? value : JSON.stringify(value), ...(isError ? { is_error: true } : {}) });
      }
      push('user', blocks);
    }
  }
  return { system: system.join('\n\n'), messages: out };
}

interface ResponsesResponse {
  model?: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output: { type: string; id?: string; call_id?: string; name?: string; arguments?: string; encrypted_content?: string; summary?: { text?: string }[]; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

function responsesImageUrl(p: { data: unknown; mediaType?: string }): string | null {
  const d = p.data;
  if (d instanceof URL) return d.toString();
  if (typeof d === 'string') return /^(https?:|data:)/i.test(d) ? d : `data:${p.mediaType ?? 'image/jpeg'};base64,${d}`;
  if (d instanceof Uint8Array) return `data:${p.mediaType ?? 'image/jpeg'};base64,${toBase64(d)}`;
  return null;
}

/**
 * The AI SDK prompt as OpenAI Responses input items (stateless). Tool calls are sent without their
 * item ids (only `call_id`), so no stored item is referenced; reasoning items are returned only when
 * they carry encrypted content from this same model, placed before that step's calls.
 */
export function toResponsesInput(prompt: LanguageModelV3Prompt, model: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of prompt) {
    if (m.role === 'system') {
      if (m.content.trim()) out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      const parts: Record<string, unknown>[] = [];
      for (const p of m.content) {
        if (p.type === 'text') {
          if (p.text.trim()) parts.push({ type: 'input_text', text: p.text });
        } else if (p.type === 'file' && (p.mediaType ?? '').startsWith('image/')) {
          const url = responsesImageUrl(p as { data: unknown; mediaType?: string });
          if (url) parts.push({ type: 'input_image', image_url: url });
        }
      }
      if (parts.length) out.push({ role: 'user', content: parts });
    } else if (m.role === 'assistant') {
      const reasoning: Record<string, unknown>[] = [];
      const rest: Record<string, unknown>[] = [];
      for (const p of m.content as { type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; providerOptions?: Record<string, Record<string, unknown>> }[]) {
        if (p.type === 'reasoning') {
          const o = p.providerOptions?.openai;
          if (!o || o.model !== model || typeof o.encryptedContent !== 'string' || !o.encryptedContent) continue;
          reasoning.push({ type: 'reasoning', ...(typeof o.itemId === 'string' && o.itemId ? { id: o.itemId } : {}), encrypted_content: o.encryptedContent, summary: [] });
        } else if (p.type === 'text') {
          if (p.text?.trim()) rest.push({ role: 'assistant', content: p.text });
        } else if (p.type === 'tool-call') {
          rest.push({ type: 'function_call', call_id: p.toolCallId, name: p.toolName, arguments: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {}) });
        }
      }
      out.push(...reasoning, ...rest);
    } else if (m.role === 'tool') {
      for (const p of m.content) {
        if (p.type !== 'tool-result') continue;
        const o = p.output as { value?: unknown };
        const value = o?.value ?? o;
        out.push({ type: 'function_call_output', call_id: p.toolCallId, output: typeof value === 'string' ? value : JSON.stringify(value) });
      }
    }
  }
  return out;
}
