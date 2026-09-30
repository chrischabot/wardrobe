import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3FunctionTool, LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3StreamResult } from '@ai-sdk/provider';
import type { ModelTask } from './registry.js';
import type { ModelService } from './service.js';
import type { ModelResult } from './types.js';

/**
 * AI SDK language model that routes every Think inference through the application ModelService
 * (AI Gateway, budget reservation, run log). The assistant never returns a string model id to Think,
 * because a string would be resolved by Think's bundled provider directly off the AI binding and
 * bypass this service.
 */
export interface GarderobeModelOptions {
  task: ModelTask;
  /** Reasoning depth for the current call (per-turn routing; see assistant/model-routing.ts). */
  depth?: () => 'routine' | 'deep';
  /** Called before every provider call for the current run reference (turn id, job id). */
  runRef: () => string;
  promptVersion: string;
  profileVersion: () => number | null;
  dataClasses: string[];
  onResult?: (result: ModelResult) => void;
}

export const GARDEROBE_MODEL_PROVIDER = 'garderobe-gateway';

export class GarderobeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3' as const;
  readonly provider = GARDEROBE_MODEL_PROVIDER;
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(
    private readonly service: ModelService,
    private readonly options: GarderobeModelOptions,
  ) {
    this.modelId = `task:${options.task}`;
  }

  private async run(options: LanguageModelV3CallOptions): Promise<ModelResult> {
    const tools = (options.tools ?? []).filter((t): t is LanguageModelV3FunctionTool => t.type === 'function');
    const result = await this.service.generate({
      task: this.options.task,
      depth: this.options.depth?.(),
      prompt: options.prompt,
      tools,
      toolChoice: options.toolChoice,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      responseFormat: options.responseFormat,
      runRef: this.options.runRef(),
      promptVersion: this.options.promptVersion,
      profileVersion: this.options.profileVersion(),
      dataClasses: this.options.dataClasses,
      abortSignal: options.abortSignal,
    });
    this.options.onResult?.(result);
    return result;
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const r = await this.run(options);
    return {
      content: r.content,
      finishReason: r.finishReason,
      usage: usageOf(r),
      warnings: [],
      response: { modelId: r.providerModel ?? r.apiModelId },
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const r = await this.run(options);
    const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }, { type: 'response-metadata', modelId: r.providerModel ?? r.apiModelId }];
    let i = 0;
    for (const c of r.content) {
      if (c.type === 'reasoning') {
        // Kept with its provider metadata (Claude's signature) so the next tool step can return it;
        // Think's sendReasoning = false keeps it from ever reaching a client.
        const id = `rsn_${i++}`;
        parts.push({ type: 'reasoning-start', id, providerMetadata: c.providerMetadata }, { type: 'reasoning-delta', id, delta: c.text }, { type: 'reasoning-end', id, providerMetadata: c.providerMetadata });
      } else if (c.type === 'text') {
        const id = `txt_${i++}`;
        parts.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: c.text }, { type: 'text-end', id });
      } else if (c.type === 'tool-call') {
        parts.push({ type: 'tool-input-start', id: c.toolCallId, toolName: c.toolName }, { type: 'tool-input-delta', id: c.toolCallId, delta: c.input }, { type: 'tool-input-end', id: c.toolCallId }, c);
      }
    }
    parts.push({ type: 'finish', finishReason: r.finishReason, usage: usageOf(r) });
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      }),
    };
  }
}

function usageOf(r: ModelResult) {
  return {
    inputTokens: { total: r.usage.inputTokens, noCache: r.usage.inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: r.usage.outputTokens, text: r.usage.outputTokens, reasoning: 0 },
  };
}
