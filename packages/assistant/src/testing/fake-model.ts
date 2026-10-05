/**
 * FAKE MODEL - TEST ONLY.
 *
 * A deterministic, scripted stand-in for a language model, used ONLY at the model boundary in tests.
 * It performs no inference. Everything else in a test that uses it (the Think Durable Object, the
 * transcript, D1, the command service, receipts, recall) is the real implementation.
 *
 * A script is a list of steps; each model call consumes the next step. A step is either a fixed
 * response or a function of the request the model received (system prompt, messages, tool names),
 * so tests can assert what context reached the model.
 */
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";

export const FAKE_MODEL_LABEL = "FAKE MODEL (deterministic test double, no inference)";

export interface FakeToolCall {
  toolName: string;
  input: Record<string, unknown>;
  /** Provider tool-call ID; random by default, as real providers issue a fresh one per sample. */
  toolCallId?: string;
}

export interface FakeResponse {
  text?: string;
  /**
   * Raw reasoning the model emits before its answer, as a reasoning model does. Scripted so that a test
   * of "reasoning never reaches a client" has reasoning to withhold; `reasoningEmitted` counts them.
   */
  reasoning?: string;
  toolCalls?: FakeToolCall[];
  /** Throw this error instead of responding (transport failure, timeout...). */
  error?: Error;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface FakeRequest {
  /** Concatenated system prompt text exactly as the model received it. */
  system: string;
  /** Every message (role + flattened text) exactly as the model received it. */
  messages: { role: string; text: string }[];
  toolNames: string[];
  /** Tool results visible to the model in this call, newest last. */
  toolResults: { toolName: string; output: unknown }[];
  /** Image inputs the model received (media type and byte length), in order. */
  images: { mediaType: string; byteLength: number; role: string }[];
  raw: LanguageModelV4CallOptions;
}

export type FakeStep = FakeResponse | ((request: FakeRequest) => FakeResponse | Promise<FakeResponse>);

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (part?.type === "text") return String(part.text ?? "");
      if (part?.type === "tool-call") return `[tool-call ${part.toolName} ${JSON.stringify(part.input)}]`;
      if (part?.type === "tool-result") return `[tool-result ${part.toolName} ${JSON.stringify(part.output)}]`;
      return "";
    })
    .join("");
}

export function describeRequest(options: LanguageModelV4CallOptions): FakeRequest {
  const messages = options.prompt.map((m: any) => ({ role: String(m.role), text: flatten(m.content) }));
  const toolResults: FakeRequest["toolResults"] = [];
  for (const m of options.prompt as any[]) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type === "tool-result") {
        const out = part.output;
        toolResults.push({ toolName: part.toolName, output: out && typeof out === "object" && "value" in out ? (out as any).value : out });
      }
    }
  }
  const images: FakeRequest["images"] = [];
  for (const m of options.prompt as any[]) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part?.type !== "file" || !String(part.mediaType ?? "").startsWith("image/")) continue;
      const data = part.data?.data ?? part.data;
      const byteLength = data instanceof Uint8Array ? data.length : typeof data === "string" ? Math.floor((data.length * 3) / 4) : (data?.byteLength ?? 0);
      images.push({ mediaType: String(part.mediaType), byteLength, role: String(m.role) });
    }
  }
  return {
    images,
    system: messages.filter((m) => m.role === "system").map((m) => m.text).join("\n"),
    messages,
    toolNames: (options.tools ?? []).map((t: any) => t.name),
    toolResults,
    raw: options,
  };
}

export class FakeModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "garderobe-fake";
  readonly modelId: string;
  readonly supportedUrls = {};
  /** Every request this model received, in order. */
  readonly requests: FakeRequest[] = [];
  /** How many responses carried scripted reasoning out of this model (see `FakeResponse.reasoning`). */
  reasoningEmitted = 0;
  private steps: FakeStep[] = [];
  private fallbackStep: FakeStep = { text: `${FAKE_MODEL_LABEL}: no scripted step.` };

  constructor(modelId = "fake-deterministic") {
    this.modelId = modelId;
  }

  /** Replace the script. */
  script(...steps: FakeStep[]): this {
    this.steps = [...steps];
    return this;
  }
  enqueue(...steps: FakeStep[]): this {
    this.steps.push(...steps);
    return this;
  }
  /** Step used when the script is exhausted. */
  otherwise(step: FakeStep): this {
    this.fallbackStep = step;
    return this;
  }
  reset(): this {
    this.steps = [];
    this.requests.length = 0;
    this.reasoningEmitted = 0;
    this.fallbackStep = { text: `${FAKE_MODEL_LABEL}: no scripted step.` };
    return this;
  }
  get remaining(): number {
    return this.steps.length;
  }

  private async next(options: LanguageModelV4CallOptions): Promise<FakeResponse> {
    const request = describeRequest(options);
    this.requests.push(request);
    const step = this.steps.length > 0 ? this.steps.shift()! : this.fallbackStep;
    const response = typeof step === "function" ? await step(request) : step;
    if (response.error) throw response.error;
    return response;
  }

  private usage(r: FakeResponse) {
    const u = r.usage ?? { inputTokens: 100, outputTokens: 20 };
    return {
      inputTokens: { total: u.inputTokens, noCache: u.inputTokens, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: u.outputTokens, text: u.outputTokens, reasoning: 0 },
    };
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<any> {
    const r = await this.next(options);
    const content: any[] = [];
    if (r.reasoning) {
      content.push({ type: "reasoning", text: r.reasoning });
      this.reasoningEmitted++;
    }
    if (r.text) content.push({ type: "text", text: r.text });
    for (const c of r.toolCalls ?? []) content.push({ type: "tool-call", toolCallId: c.toolCallId ?? `call_${crypto.randomUUID()}`, toolName: c.toolName, input: JSON.stringify(c.input) });
    return {
      content,
      finishReason: { unified: (r.toolCalls?.length ?? 0) > 0 ? "tool-calls" : "stop", raw: undefined },
      usage: this.usage(r),
      warnings: [],
      response: { id: `fake_${crypto.randomUUID()}`, modelId: this.modelId, timestamp: new Date(0) },
    };
  }

  async doStream(options: LanguageModelV4CallOptions): Promise<any> {
    const r = await this.next(options);
    const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
    if (r.reasoning) {
      const id = `rsn_${crypto.randomUUID()}`;
      parts.push({ type: "reasoning-start", id }, { type: "reasoning-delta", id, delta: r.reasoning }, { type: "reasoning-end", id });
      this.reasoningEmitted++;
    }
    if (r.text) {
      const id = `txt_${crypto.randomUUID()}`;
      parts.push({ type: "text-start", id }, { type: "text-delta", id, delta: r.text }, { type: "text-end", id });
    }
    for (const c of r.toolCalls ?? []) {
      parts.push({ type: "tool-call", toolCallId: c.toolCallId ?? `call_${crypto.randomUUID()}`, toolName: c.toolName, input: JSON.stringify(c.input) } as LanguageModelV4StreamPart);
    }
    parts.push({ type: "finish", finishReason: { unified: (r.toolCalls?.length ?? 0) > 0 ? "tool-calls" : "stop", raw: undefined }, usage: this.usage(r) });
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      }),
    };
  }
}

/** One shared fake per role for a test process (the test worker entry hands these to the Durable Object). */
const fakes = new Map<string, FakeModel>();
export function fakeModelFor(role: string): FakeModel {
  let m = fakes.get(role);
  if (!m) {
    m = new FakeModel(`fake-${role}`);
    fakes.set(role, m);
  }
  return m;
}
export function resetFakeModels(): void {
  for (const m of fakes.values()) m.reset();
}
