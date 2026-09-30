import { BudgetExhaustedError, BudgetLedger, costMicroUsd, estimateTokens, type SpendCap } from './budget.js';
import type { ModelProfile, ModelRegistry, ModelRoute, ModelTask } from './registry.js';
import { compactTools } from './tool-schema.js';
import { FALLBACK_KINDS, promptText, TransportError, type ModelRequest, type ModelResult, type ModelTransport } from './types.js';

/**
 * The application model service: the only path from Garderobe code to inference (spec section 12).
 * Chat turns (through the Think adapter), compaction, extraction, vision, embeddings and generation
 * all call `generate()`. It resolves the task's profile chain, refuses profiles that are not
 * permitted to receive the request's data classes, reserves budget before dispatch, settles against
 * usage, falls back only on defined failure classes and logs every run with its provider, model,
 * effort, prompt version and profile version.
 */

export class ModelUnavailableError extends Error {
  readonly code = 'model_unavailable';
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

export interface ModelServiceDeps {
  db: D1Database;
  userId: string;
  registry: ModelRegistry;
  /** Transports by route. The fake route exists only in local/test registries. */
  transports: Partial<Record<ModelRoute, ModelTransport>>;
  gatewayId: string;
  now?: () => string;
  /** Deployment-wide sliding-window spend ceiling (MODEL_SPEND_CAP_USD); null or absent means none. */
  spendCap?: SpendCap | null;
}

/** Per-isolate circuit breaker: skip a profile after repeated transport failures for a short window. */
const breaker = new Map<string, { failures: number; openUntil: number }>();
const BREAKER_THRESHOLD = 3;
const BREAKER_WINDOW_MS = 60_000;

export function resetCircuitBreakers(): void {
  breaker.clear();
}

export class ModelService {
  private readonly ledger: BudgetLedger;
  private readonly now: () => string;
  constructor(private readonly deps: ModelServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.ledger = new BudgetLedger(deps.db, deps.userId, this.now, deps.spendCap ?? null);
  }

  get budget(): BudgetLedger {
    return this.ledger;
  }

  get registry(): ModelRegistry {
    return this.deps.registry;
  }

  async generate(input: ModelRequest): Promise<ModelResult> {
    // Tool schemas go out in their compact wire form (validation still uses each tool's own schema).
    const request: ModelRequest = input.tools?.length ? { ...input, tools: compactTools(input.tools) } : input;
    // A deep conversational turn is served, reserved and logged as the research task.
    const task = chainTaskFor(request);
    const { profiles, skipped } = this.deps.registry.chain(task);
    const inputTokens = estimateTokens(promptText(request.prompt)) + estimateTokens(JSON.stringify(request.tools ?? []));
    const tried: string[] = [];
    const reasons: { profileId: string; reason: string }[] = [...skipped];
    for (const profile of profiles) {
      const why = this.refuse(profile, request, inputTokens);
      if (why) {
        reasons.push({ profileId: profile.profileId, reason: why });
        continue;
      }
      const transport = this.deps.transports[profile.route];
      if (!transport) {
        reasons.push({ profileId: profile.profileId, reason: `no transport for route ${profile.route}` });
        continue;
      }
      const maxOut = Math.min(request.maxOutputTokens ?? profile.maxOutputTokens, profile.maxOutputTokens);
      const runId = `mrun_${crypto.randomUUID().replace(/-/g, '')}`;
      // Throws BudgetExhaustedError: the caller keeps the request durable and resumable.
      const reservation = await this.ledger.reserve({ task, profile, inputTokens, maxOutputTokens: maxOut, runRef: request.runRef });
      try {
        const result = await transport.call(profile, { ...request, maxOutputTokens: maxOut }, { runId, runRef: request.runRef, task, gatewayId: this.deps.gatewayId });
        const cost = costMicroUsd(profile, result.usage.inputTokens, result.usage.outputTokens);
        await this.ledger.settle(reservation.reservationId, cost);
        breaker.delete(profile.profileId);
        await this.logRun(runId, reservation.reservationId, { ...request, task }, profile, 'succeeded', result.usage, null, tried[tried.length - 1] ?? null, result.providerModel);
        return { ...result, runId, profileId: profile.profileId, provider: profile.provider, apiModelId: profile.apiModelId, route: profile.route, gatewayId: this.deps.gatewayId, costMicroUsd: cost, fallbackFrom: tried };
      } catch (err) {
        const te = err instanceof TransportError ? err : new TransportError('transport', err instanceof Error ? err.message : String(err), true);
        if (te.dispatched) await this.ledger.markUncertain(reservation.reservationId);
        else await this.ledger.release(reservation.reservationId);
        await this.logRun(runId, reservation.reservationId, { ...request, task }, profile, 'failed', { inputTokens: 0, outputTokens: 0 }, te.kind, tried[tried.length - 1] ?? null, undefined, te);
        tried.push(profile.profileId);
        if (request.abortSignal?.aborted) throw te; // Stop: never fall back after a cancellation
        if (!FALLBACK_KINDS.includes(te.kind)) throw te;
        const b = breaker.get(profile.profileId) ?? { failures: 0, openUntil: 0 };
        b.failures++;
        if (b.failures >= BREAKER_THRESHOLD) b.openUntil = Date.now() + BREAKER_WINDOW_MS;
        breaker.set(profile.profileId, b);
        reasons.push({ profileId: profile.profileId, reason: `${te.kind}: ${te.message}` });
      }
    }
    // The reasons are the diagnosis: each profile tried or skipped, with the provider's status and message.
    const why = reasons.map((r) => `${r.profileId}: ${r.reason}`).join('; ');
    throw new ModelUnavailableError(`No model profile could serve ${task}${why ? ` (${why})` : ''}`.slice(0, 1000), { task, reasons });
  }

  /** Reasons a selectable profile is still refused for this particular request. */
  private refuse(profile: ModelProfile, request: ModelRequest, inputTokens: number): string | null {
    const b = breaker.get(profile.profileId);
    if (b && b.openUntil > Date.now()) return 'circuit open after repeated failures';
    const forbidden = (request.dataClasses ?? []).filter((d) => !profile.dataClasses.includes(d));
    if (forbidden.length) return `not permitted to receive ${forbidden.join(', ')}`;
    if (request.tools?.length && !profile.supportsTools) return 'does not support tools';
    const hasImage = request.prompt.some((m) => m.role === 'user' && m.content.some((p) => p.type === 'file'));
    if (hasImage && !profile.inputTypes.includes('image')) return 'does not accept images';
    if (inputTokens > profile.maxInputTokens * 0.95) return `input of about ${inputTokens} tokens exceeds its context budget`;
    return null;
  }

  private async logRun(
    runId: string,
    reservationId: string,
    request: ModelRequest,
    profile: ModelProfile,
    status: string,
    usage: { inputTokens: number; outputTokens: number },
    errorClass: string | null,
    fallbackOf: string | null,
    providerModel?: string,
    failure?: TransportError,
  ): Promise<void> {
    if (failure) {
      // Workers Logs: enough to diagnose a failed run without opening D1 (the message is already redacted).
      console.error(JSON.stringify({ event: 'model_run_failed', runId, runRef: request.runRef.slice(0, 64), task: request.task, profileId: profile.profileId, model: profile.apiModelId, route: profile.route, errorClass: failure.kind, providerStatus: failure.status ?? null, message: failure.message.slice(0, 500) }));
    }
    await this.deps.db
      .prepare(
        `INSERT INTO model_runs (user_id, run_id, reservation_id, task, profile_id, provider, model, gateway_id, route, prompt_version, profile_version, input_tokens, output_tokens, status, error_class, error_message, provider_status, fallback_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        this.deps.userId,
        runId,
        reservationId,
        request.task,
        profile.profileId,
        profile.provider,
        providerModel ?? profile.apiModelId,
        this.deps.gatewayId,
        profile.route,
        request.promptVersion ?? null,
        request.profileVersion ?? null,
        usage.inputTokens,
        usage.outputTokens,
        status,
        errorClass,
        failure ? failure.message.slice(0, 500) : null,
        failure?.status ?? null,
        fallbackOf,
        this.now(),
      )
      .run();
  }
}

export { BudgetExhaustedError };
export type { ModelTask };

/** The task whose profile chain serves a request: a deep chat turn uses the research chain. */
export function chainTaskFor(request: Pick<ModelRequest, 'task' | 'depth'>): ModelTask {
  return request.task === 'chat' && request.depth === 'deep' ? 'research' : request.task;
}
