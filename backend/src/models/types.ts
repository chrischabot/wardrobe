import type { LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3FinishReason, LanguageModelV3FunctionTool, LanguageModelV3Prompt, LanguageModelV3ToolChoice } from '@ai-sdk/provider';
import type { ModelProfile, ModelRoute, ModelTask } from './registry.js';

export interface ModelRequest {
  task: ModelTask;
  /**
   * Reasoning depth of a conversational request. `deep` serves a chat request from the research
   * chain (Claude Opus 5.5 medium first); `routine` or absent uses the task's own chain.
   */
  depth?: 'routine' | 'deep';
  prompt: LanguageModelV3Prompt;
  tools?: LanguageModelV3FunctionTool[];
  toolChoice?: LanguageModelV3ToolChoice;
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: LanguageModelV3CallOptions['responseFormat'];
  /** Garderobe run/turn/task reference, attached to Gateway metadata (non-sensitive). */
  runRef: string;
  promptVersion?: string;
  profileVersion?: number | null;
  /** Data classes present in the request; a profile must be permitted to receive all of them. */
  dataClasses?: string[];
  abortSignal?: AbortSignal;
}

export interface TransportResult {
  content: LanguageModelV3Content[];
  finishReason: LanguageModelV3FinishReason;
  usage: { inputTokens: number; outputTokens: number };
  /** Resolved provider model id reported by the provider (aliases can redirect). */
  providerModel?: string;
  /** Embedding vectors, one per input text in order (embeddings task only). */
  embeddings?: number[][];
}

export interface ModelResult extends TransportResult {
  runId: string;
  profileId: string;
  provider: string;
  apiModelId: string;
  route: ModelRoute;
  gatewayId: string;
  costMicroUsd: number;
  fallbackFrom: string[];
}

export interface TransportMeta {
  runId: string;
  runRef: string;
  task: ModelTask;
  gatewayId: string;
}

export type TransportErrorKind = 'transport' | 'timeout' | 'rate_limit' | 'invalid_output' | 'context_overflow' | 'fatal';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportErrorKind,
    message: string,
    /** Whether the request may have reached the provider (outcome unknown -> reservation stays uncertain). */
    readonly dispatched: boolean,
    /** HTTP status the provider or gateway answered with, when there was one. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Only these failure classes fall back to another profile (never an unwelcome but valid answer). */
export const FALLBACK_KINDS: TransportErrorKind[] = ['transport', 'timeout', 'rate_limit', 'invalid_output'];

export interface ModelTransport {
  readonly routes: readonly ModelRoute[];
  call(profile: ModelProfile, request: ModelRequest, meta: TransportMeta): Promise<TransportResult>;
}

export function promptText(prompt: LanguageModelV3Prompt): string {
  const out: string[] = [];
  for (const m of prompt) {
    if (m.role === 'system') out.push(m.content);
    else
      for (const p of m.content as { type: string; text?: string; input?: unknown; output?: unknown }[]) {
        if (p.type === 'text' || p.type === 'reasoning') out.push(p.text ?? '');
        else if (p.type === 'tool-call') out.push(JSON.stringify(p.input ?? ''));
        else if (p.type === 'tool-result') out.push(JSON.stringify(p.output ?? ''));
      }
  }
  return out.join('\n');
}
