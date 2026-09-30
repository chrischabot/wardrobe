import type { LanguageModelV3Content, LanguageModelV3Prompt } from '@ai-sdk/provider';
import { DATE_STAMP } from '../assistant/turn-dates.js';
import type { ModelProfile } from './registry.js';
import { promptText, TransportError, type ModelRequest, type ModelTransport, type TransportMeta, type TransportResult } from './types.js';

/**
 * Deterministic fake model provider for tests and the MCP simulation. It records every request it
 * receives (so tests can prove what reached "the model") and answers from a script. With no script it
 * produces a short, deterministic acknowledgement that never states inventory facts.
 */
export interface FakeReply {
  text?: string;
  toolCalls?: { toolName: string; input: unknown; toolCallId?: string }[];
  error?: TransportError;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface FakeCall {
  profileId: string;
  task: string;
  request: ModelRequest;
  system: string;
  lastUserText: string;
  toolNames: string[];
  meta: TransportMeta;
}

export type FakeResponder = (call: FakeCall, history: FakeCall[]) => FakeReply | undefined;

export function systemText(prompt: LanguageModelV3Prompt): string {
  return prompt
    .filter((m) => m.role === 'system')
    .map((m) => m.content as string)
    .join('\n');
}

export function lastUserText(prompt: LanguageModelV3Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!;
    // The owner's words, without the date stamp the assistant adds to his messages (assistant/turn-dates.ts).
    if (m.role === 'user') return m.content.filter((p) => p.type === 'text' && !DATE_STAMP.test((p as { text: string }).text)).map((p) => (p as { text: string }).text).join('\n');
  }
  return '';
}

/** True when the last prompt message is a tool result (the model is being asked to continue). */
export function lastToolResults(prompt: LanguageModelV3Prompt): { toolName: string; output: unknown }[] {
  const last = prompt[prompt.length - 1];
  if (!last || last.role !== 'tool') return [];
  return last.content.filter((p) => p.type === 'tool-result').map((p) => ({ toolName: (p as { toolName: string }).toolName, output: (p as { output: unknown }).output }));
}

export class FakeModelTransport implements ModelTransport {
  readonly routes = ['fake'] as const;
  readonly calls: FakeCall[] = [];
  private readonly queue: FakeReply[] = [];
  private responder: FakeResponder | null = null;
  private seq = 0;
  /** Optional artificial latency (ms) so tests can exercise queued turns and Stop. */
  delayMs = 0;

  enqueue(...replies: FakeReply[]): this {
    this.queue.push(...replies);
    return this;
  }

  respondWith(fn: FakeResponder | null): this {
    this.responder = fn;
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.queue.length = 0;
    this.responder = null;
    this.delayMs = 0;
  }

  async call(profile: ModelProfile, request: ModelRequest, meta: TransportMeta): Promise<TransportResult> {
    const call: FakeCall = {
      profileId: profile.profileId,
      task: request.task,
      request,
      system: systemText(request.prompt),
      lastUserText: lastUserText(request.prompt),
      toolNames: (request.tools ?? []).map((t) => t.name),
      meta,
    };
    this.calls.push(call);
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        request.abortSignal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new TransportError('timeout', 'aborted', true));
        });
      });
    }
    // A tool result continuation gets a closing sentence unless the script says otherwise.
    const toolResults = lastToolResults(request.prompt);
    const reply = this.queue.shift() ?? this.responder?.(call, this.calls) ?? defaultReply(call, toolResults);
    if (reply.error) throw reply.error;
    const content: LanguageModelV3Content[] = [];
    if (reply.text) content.push({ type: 'text', text: reply.text });
    for (const tc of reply.toolCalls ?? []) {
      content.push({ type: 'tool-call', toolCallId: tc.toolCallId ?? `fake_call_${++this.seq}`, toolName: tc.toolName, input: JSON.stringify(tc.input ?? {}) });
    }
    const inputTokens = Math.ceil(promptText(request.prompt).length / 4);
    return {
      content,
      finishReason: reply.toolCalls?.length ? { unified: 'tool-calls', raw: 'tool_calls' } : { unified: 'stop', raw: 'stop' },
      usage: reply.usage ?? { inputTokens, outputTokens: Math.ceil((reply.text ?? '').length / 4) + 1 },
      providerModel: profile.apiModelId,
    };
  }
}

function defaultReply(call: FakeCall, toolResults: { toolName: string; output: unknown }[]): FakeReply {
  if (call.task === 'compaction') {
    return { text: '## Summary\n- Earlier discussion summarised by the fake compaction model.\n## Open requests\n- none recorded\n## Entities\n- none' };
  }
  if (toolResults.length) {
    const summaries = toolResults.map((r) => {
      const v = (r.output as { value?: { summary?: string } } | undefined)?.value;
      return typeof v?.summary === 'string' ? v.summary : `${r.toolName} finished.`;
    });
    return { text: summaries.join(' ') };
  }
  return { text: 'Understood.' };
}
