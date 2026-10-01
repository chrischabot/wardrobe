/**
 * The application model service (specification section 12).
 *
 * Every application-owned model call goes through `ModelService`: it picks the task's profile chain
 * (owner routing or defaults, only profiles whose probes passed, breaker closed), RESERVES spend in the
 * D1 command ledger before dispatch, calls the model through the isolated Gateway adapter, falls back on
 * a defined class of failure only, and SETTLES against reported usage. Budget exhaustion never triggers
 * an unbudgeted request: the caller gets `BudgetExceededError` and keeps its turn resumable.
 */
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { BudgetClass, InferenceTask, ModelOperation } from "@garderobe/contracts/ext/assistant";
import { all, first, getSettings, isCommandError, json, localDateOf, newId, prepare, stmt, systemPrincipalFor, toInstant, type CommandService, type Db } from "@garderobe/domain";
import { DEFAULT_DAILY_BUDGETS, TASK_SPECS, actualCostMicroUsd, estimateReservationMicroUsd, profileSpec, selectability, type ProbeRow, type ProfileSpec } from "./registry.ts";

export class BudgetExceededError extends Error {
  readonly code = "budget_exceeded";
  constructor(readonly budgetClass: BudgetClass, readonly budgetDay: string) {
    super(`today's ${budgetClass.replace(/_/g, " ")} budget is used up; the request is kept and can be resumed`);
  }
}

export class NoSelectableProfileError extends Error {
  readonly code = "no_selectable_profile";
  constructor(readonly task: InferenceTask, readonly reasons: { profileId: string; reason: string }[]) {
    super(`no model profile is available for ${task.replace(/_/g, " ")}: ${reasons.map((r) => `${r.profileId}: ${r.reason}`).join("; ")}`);
  }
}

export class InferenceFailedError extends Error {
  readonly code = "inference_failed";
  constructor(readonly task: InferenceTask, readonly attempts: { profileId: string; errorClass: string; message: string }[]) {
    super(`the model could not answer (${attempts.map((a) => `${a.profileId}: ${a.errorClass}`).join(", ")})`);
  }
}

export type ErrorClass = "transport" | "timeout" | "provider_rejected" | "context_overflow" | "aborted" | "unknown";

/** Fallback happens on transport errors and timeouts only - never because an answer is unwelcome. */
export function classifyError(error: unknown): ErrorClass {
  const e = error as { name?: string; message?: string; statusCode?: number; status?: number; code?: string } | undefined;
  const message = String(e?.message ?? error ?? "").toLowerCase();
  if (e?.name === "AbortError" || message.includes("aborted")) return "aborted";
  if (e?.name === "TimeoutError" || message.includes("timed out") || message.includes("timeout")) return "timeout";
  if (message.includes("context length") || message.includes("context_length") || message.includes("prompt is too long") || message.includes("maximum context")) return "context_overflow";
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number") {
    if (status === 408 || status === 429 || status >= 500) return "transport";
    if (status >= 400) return "provider_rejected";
  }
  if (message.includes("network") || message.includes("fetch failed") || message.includes("connection") || message.includes("econnreset") || message.includes("gateway") || message.includes("unavailable") || message.includes("overloaded")) return "transport";
  return "unknown";
}

/** Fallback happens only for a transport failure or a timeout (and, in generateStructured, invalid structured output). An error that is not understood is not retried elsewhere. */
const FALLBACK_CLASSES: ErrorClass[] = ["transport", "timeout"];
export const BREAKER_THRESHOLD = 3;
/** Model calls one owner may have in flight at once. */
export const MAX_OPEN_RESERVATIONS = 6;
export const BREAKER_COOLDOWN_MS = 5 * 60_000;

export interface ModelCallMeta {
  runId: string;
  task: InferenceTask;
  attempt: number;
}

export interface ModelServiceDeps {
  db: Db;
  service: CommandService;
  /** Named Gateway of this environment; probes, breakers and reservations are recorded against it. */
  gatewayId: string;
  clock?: () => number;
  /** The model boundary. Production: the AI Gateway adapter. Tests: a labelled deterministic fake. */
  createLanguageModel(spec: ProfileSpec, meta: ModelCallMeta): LanguageModelV4;
}

export interface RunScope {
  userId: string;
  task: InferenceTask;
  parent: { kind: "turn" | "job" | "workflow" | "compaction"; id: string };
  promptVersion?: string;
  /** Estimated input tokens, for the reservation. */
  estimatedInputTokens?: number;
  /** Profiles whose context window is smaller than this are skipped (the complete profile is never trimmed to fit). */
  minContextTokens?: number;
  onAttempt?(info: { profileId: string; attempt: number; fallbackOf: string | null }): void;
  /** Extra operations the chosen profile must have passed probes for (for example `vision` when a photograph is attached). */
  requiredOperations?: ModelOperation[];
  /** Profiles not to use for this run (already tried and rejected for invalid structured output). */
  excludeProfiles?: string[];
  /** Recorded with every reservation of the run: structured-output schema version and input versions. */
  schemaVersion?: string;
  evidence?: Record<string, unknown>;
  /** Called with the typed error when a call ends without an answer (budget, no verified profile, outage). */
  onFailure?(error: unknown): void;
}

export interface RunRecord {
  profileId: string;
  resolvedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  attempts: { profileId: string; errorClass: string; message: string }[];
}

export class ModelService {
  private readonly db: Db;
  private readonly service: CommandService;
  readonly gatewayId: string;
  private readonly clock: () => number;
  private readonly createLanguageModel: ModelServiceDeps["createLanguageModel"];

  constructor(deps: ModelServiceDeps) {
    this.db = deps.db;
    this.service = deps.service;
    this.gatewayId = deps.gatewayId;
    this.clock = deps.clock ?? (() => Date.now());
    this.createLanguageModel = deps.createLanguageModel;
  }

  /** The ordered profiles that may serve a task right now, with the precise reason for each one skipped. */
  async profileChain(userId: string, task: InferenceTask, minContextTokens = 0, extra: { requiredOperations?: ModelOperation[]; excludeProfiles?: string[] } = {}): Promise<{ chain: ProfileSpec[]; skipped: { profileId: string; reason: string }[] }> {
    const spec = { ...TASK_SPECS[task], requiredOperations: [...new Set([...TASK_SPECS[task].requiredOperations, ...(extra.requiredOperations ?? [])])] };
    const routing = await first<{ profile_id: string; fallbacks_json: string }>(this.db, "SELECT profile_id, fallbacks_json FROM inference_routing WHERE user_id = ? AND task = ?", userId, task);
    const order = routing ? [routing.profile_id, ...json<string[]>(routing.fallbacks_json, [])] : spec.candidates;
    const probes = await all<ProbeRow>(this.db, "SELECT profile_id, operation, result, billing, reason, resolved_model, probed_at FROM model_probes WHERE gateway_id = ?", this.gatewayId);
    const breakers = await all<{ profile_id: string; state: string; opened_at: string | null }>(this.db, "SELECT profile_id, state, opened_at FROM model_breakers WHERE gateway_id = ?", this.gatewayId);
    const chain: ProfileSpec[] = [];
    const skipped: { profileId: string; reason: string }[] = [];
    for (const id of [...new Set(order)]) {
      const p = profileSpec(id);
      if (!p) {
        skipped.push({ profileId: id, reason: "unknown profile" });
        continue;
      }
      if (extra.excludeProfiles?.includes(id)) {
        skipped.push({ profileId: id, reason: "its structured output stayed invalid after a bounded repair" });
        continue;
      }
      const s = selectability(p, probes, spec.requiredOperations);
      if (!s.selectable) {
        skipped.push({ profileId: id, reason: s.reason ?? "not selectable" });
        continue;
      }
      if (p.contextTokens < minContextTokens) {
        skipped.push({ profileId: id, reason: `its context window (${p.contextTokens} tokens) cannot hold the complete profile and context (${minContextTokens} tokens)` });
        continue;
      }
      const breaker = breakers.find((b) => b.profile_id === id);
      if (breaker?.state === "open" && breaker.opened_at && this.clock() - Date.parse(breaker.opened_at) < BREAKER_COOLDOWN_MS) {
        skipped.push({ profileId: id, reason: "temporarily paused after repeated provider failures" });
        continue;
      }
      chain.push(p);
    }
    return { chain, skipped };
  }

  private async recordOutcome(profileId: string, ok: boolean): Promise<void> {
    const now = toInstant(this.clock());
    if (ok) {
      await prepare(this.db, stmt("INSERT INTO model_breakers (gateway_id, profile_id, failures, state, opened_at, updated_at) VALUES (?, ?, 0, 'closed', NULL, ?) ON CONFLICT (gateway_id, profile_id) DO UPDATE SET failures = 0, state = 'closed', opened_at = NULL, updated_at = excluded.updated_at", this.gatewayId, profileId, now)).run();
      return;
    }
    await prepare(
      this.db,
      stmt(
        `INSERT INTO model_breakers (gateway_id, profile_id, failures, state, opened_at, updated_at) VALUES (?, ?, 1, 'closed', NULL, ?)
         ON CONFLICT (gateway_id, profile_id) DO UPDATE SET failures = failures + 1,
           state = CASE WHEN failures + 1 >= ? THEN 'open' ELSE state END,
           opened_at = CASE WHEN failures + 1 >= ? THEN excluded.updated_at ELSE opened_at END,
           updated_at = excluded.updated_at`,
        this.gatewayId, profileId, now, BREAKER_THRESHOLD, BREAKER_THRESHOLD,
      ),
    ).run();
  }

  private async reserve(scope: RunScope, spec: ProfileSpec, runId: string, attempt: number, maxOutputTokens: number): Promise<string> {
    const principal = await systemPrincipalFor(this.db, scope.userId, `inference:${runId}`, "system");
    const { settings } = await getSettings(this.db, principal);
    const task = TASK_SPECS[scope.task];
    const budgetDay = localDateOf(this.clock(), settings.timezone);
    const custom = (settings.extensions["assistant"] as { budgets?: Record<string, number> } | undefined)?.budgets ?? {};
    const limit = custom[task.budgetClass] ?? DEFAULT_DAILY_BUDGETS[task.budgetClass];
    const reservationId = newId("rsv");
    try {
      await this.service.execute(principal, {
        type: "inference.reserve",
        payload: {
          reservationId,
          runId,
          task: scope.task,
          budgetClass: task.budgetClass,
          profileId: spec.profileId,
          attempt,
          reservedMicroUsd: estimateReservationMicroUsd(spec, scope.estimatedInputTokens ?? spec.contextTokens, maxOutputTokens),
          budgetDay,
          dailyLimitMicroUsd: limit,
          parent: scope.parent,
          promptVersion: scope.promptVersion ?? null,
          gatewayId: this.gatewayId,
          schemaVersion: scope.schemaVersion ?? null,
          effort: spec.effort,
          evidence: scope.evidence ?? {},
          maxOpenReservations: MAX_OPEN_RESERVATIONS,
          // Optional work stops first: once 80% of the day's combined budgets is committed, research and image backfill wait.
          discretionaryCeilingMicroUsd: Math.floor(0.8 * (Object.keys(DEFAULT_DAILY_BUDGETS) as BudgetClass[]).reduce((n, c) => n + (custom[c] ?? DEFAULT_DAILY_BUDGETS[c]), 0)),
        },
        idempotencyKey: `inference-reserve:${reservationId}`,
        authorization: "system_schedule",
        source: { channel: "system", parentKind: scope.parent.kind === "compaction" ? "job" : scope.parent.kind, parentId: scope.parent.id },
      });
    } catch (e) {
      if (isCommandError(e) && e.code === "precondition_failed") throw new BudgetExceededError(task.budgetClass, budgetDay);
      throw e;
    }
    return reservationId;
  }

  private async settle(userId: string, reservationId: string, payload: { outcome: "settled" | "released" | "uncertain"; actualMicroUsd?: number; inputTokens?: number | null; outputTokens?: number | null; resolvedModel?: string | null; errorClass?: string | null }): Promise<void> {
    const principal = await systemPrincipalFor(this.db, userId, `inference:${reservationId}`, "system");
    await this.service.execute(principal, {
      type: "inference.settle",
      payload: { reservationId, ...payload },
      idempotencyKey: `inference-settle:${reservationId}:${payload.outcome}`,
      authorization: "system_schedule",
      source: { channel: "system" },
    });
  }

  /**
   * A language model for one task run. Each call the harness (Think, compaction, extraction) makes on it is
   * reserved, dispatched down the profile chain and settled. Hand this to Think instead of a raw provider model.
   */
  modelFor(scope: RunScope): LanguageModelV4 & { readonly lastRun: RunRecord | null } {
    const self = this;
    const taskSpec = TASK_SPECS[scope.task];
    let lastRun: RunRecord | null = null;

    async function dispatch<T>(options: LanguageModelV4CallOptions, call: (model: LanguageModelV4, options: LanguageModelV4CallOptions) => PromiseLike<T>, onResult: Parameters<typeof dispatchInner<T>>[2]): Promise<T> {
      try {
        return await dispatchInner(options, call, onResult);
      } catch (error) {
        scope.onFailure?.(error);
        throw error;
      }
    }

    async function dispatchInner<T>(options: LanguageModelV4CallOptions, call: (model: LanguageModelV4, options: LanguageModelV4CallOptions) => PromiseLike<T>, onResult: (result: T, ctx: { spec: ProfileSpec; reservationId: string; finish: (ok: boolean, usage: { input: number | null; output: number | null }, errorClass?: string, reportedModel?: string | null) => Promise<void> }) => T): Promise<T> {
      const { chain, skipped } = await self.profileChain(scope.userId, scope.task, scope.minContextTokens ?? 0, { ...(scope.requiredOperations ? { requiredOperations: scope.requiredOperations } : {}), ...(scope.excludeProfiles ? { excludeProfiles: scope.excludeProfiles } : {}) });
      if (chain.length === 0) throw new NoSelectableProfileError(scope.task, skipped);
      const runId = newId("run");
      const attempts: RunRecord["attempts"] = [];
      let attempt = 0;
      for (let i = 0; i < chain.length; i++) {
        const spec = chain[i]!;
        for (let retry = 0; retry <= taskSpec.retries; retry++) {
          attempt++;
          const maxOut = Math.min(options.maxOutputTokens ?? taskSpec.maxOutputTokens, spec.maxOutputTokens);
          // Reservation precedes dispatch. A budget refusal propagates: it is never a reason to try another route.
          const reservationId = await self.reserve(scope, spec, runId, attempt, maxOut);
          scope.onAttempt?.({ profileId: spec.profileId, attempt, fallbackOf: i > 0 ? chain[0]!.profileId : null });
          const finish = async (ok: boolean, usage: { input: number | null; output: number | null }, errorClass?: string, reportedModel?: string | null) => {
            if (ok) {
              // The model the provider says answered is recorded (an alias such as `deepseek-flash` can redirect).
              const resolvedModel = reportedModel ?? spec.apiModelId;
              await self.settle(scope.userId, reservationId, { outcome: "settled", actualMicroUsd: actualCostMicroUsd(spec, usage.input ?? 0, usage.output ?? 0), inputTokens: usage.input, outputTokens: usage.output, resolvedModel });
              lastRun = { profileId: spec.profileId, resolvedModel, inputTokens: usage.input, outputTokens: usage.output, attempts };
            } else {
              // A rejected request was not charged; an unknown outcome stays reserved until reconciled.
              await self.settle(scope.userId, reservationId, { outcome: errorClass === "provider_rejected" || errorClass === "context_overflow" ? "released" : "uncertain", errorClass: errorClass ?? "unknown" });
            }
            await self.recordOutcome(spec.profileId, ok || errorClass === "aborted" || errorClass === "context_overflow" || errorClass === "provider_rejected");
          };
          let timer: ReturnType<typeof setTimeout> | undefined;
          const clear = () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
          };
          const finishAndClear: typeof finish = async (ok, usage, errorClass, reportedModel) => {
            clear();
            await finish(ok, usage, errorClass, reportedModel);
          };
          try {
            const model = self.createLanguageModel(spec, { runId, task: scope.task, attempt });
            // A cleared timer, not AbortSignal.timeout(): a pending timer would keep the actor from hibernating.
            const timeout = new AbortController();
            timer = setTimeout(() => timeout.abort(new DOMException("the model call timed out", "TimeoutError")), spec.timeoutMs);
            const signal = options.abortSignal ? AbortSignal.any([options.abortSignal, timeout.signal]) : timeout.signal;
            const result = await call(model, { ...options, maxOutputTokens: maxOut, abortSignal: signal, providerOptions: { ...(options.providerOptions ?? {}) } });
            return onResult(result, { spec, reservationId, finish: finishAndClear });
          } catch (error) {
            clear();
            const errorClass = options.abortSignal?.aborted ? "aborted" : classifyError(error);
            attempts.push({ profileId: spec.profileId, errorClass, message: String((error as Error)?.message ?? error).slice(0, 300) });
            await finish(false, { input: null, output: null }, errorClass);
            if (!FALLBACK_CLASSES.includes(errorClass)) throw error;
          }
        }
      }
      throw new InferenceFailedError(scope.task, attempts);
    }

    const tokens = (usage: any): { input: number | null; output: number | null } => ({ input: usage?.inputTokens?.total ?? null, output: usage?.outputTokens?.total ?? null });

    return {
      specificationVersion: "v4",
      provider: "garderobe-model-service",
      modelId: `task:${scope.task}`,
      supportedUrls: {},
      get lastRun() {
        return lastRun;
      },
      async doGenerate(options: LanguageModelV4CallOptions) {
        let settling: Promise<void> = Promise.resolve();
        const result = await dispatch(options, (m, o) => m.doGenerate(o), (r: any, ctx) => {
          settling = ctx.finish(true, tokens(r.usage), undefined, typeof r.response?.modelId === "string" ? r.response.modelId : null);
          return r;
        });
        await settling;
        return result;
      },
      async doStream(options: LanguageModelV4CallOptions) {
        return dispatch(options, (m, o) => m.doStream(o), (result: any, ctx) => {
          let settled = false;
          let reportedModel: string | null = null;
          const settleOnce = async (ok: boolean, usage: { input: number | null; output: number | null }, errorClass?: string) => {
            if (settled) return;
            settled = true;
            await ctx.finish(ok, usage, errorClass, reportedModel);
          };
          const stream = (result.stream as ReadableStream<LanguageModelV4StreamPart>).pipeThrough(
            new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
              async transform(part, controller) {
                if (part.type === "response-metadata" && typeof (part as { modelId?: unknown }).modelId === "string") reportedModel = (part as { modelId: string }).modelId;
                if (part.type === "finish") await settleOnce(true, tokens(part.usage));
                else if (part.type === "error") await settleOnce(false, { input: null, output: null }, classifyError(part.error));
                controller.enqueue(part);
              },
              async flush() {
                // A stream that ended without a finish part has an unknown charge.
                await settleOnce(false, { input: null, output: null }, "unknown");
              },
              async cancel() {
                await settleOnce(false, { input: null, output: null }, "aborted");
              },
            } as Transformer<LanguageModelV4StreamPart, LanguageModelV4StreamPart>),
          );
          return { ...result, stream };
        });
      },
    } as unknown as LanguageModelV4 & { readonly lastRun: RunRecord | null };
  }

  /** One non-streamed text generation for mechanical subtasks (compaction, extraction). */
  async generateText(scope: RunScope, input: { system: string; prompt: string; maxOutputTokens?: number; abortSignal?: AbortSignal }): Promise<{ text: string; run: RunRecord | null }> {
    const model = this.modelFor(scope);
    const result: any = await model.doGenerate({
      prompt: [
        { role: "system", content: input.system },
        { role: "user", content: [{ type: "text", text: input.prompt }] },
      ],
      ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    } as LanguageModelV4CallOptions);
    const text = (result.content as any[]).filter((c) => c.type === "text").map((c) => c.text).join("");
    return { text, run: model.lastRun };
  }

  /**
   * Structured output with a bounded repair: the answer must parse as JSON and satisfy the schema. One repair
   * attempt per profile shows the model its own validation errors; a profile whose output stays invalid is
   * set aside and the next verified profile is tried. Nothing invalid is ever returned.
   */
  async generateStructured<T>(scope: RunScope, input: { system: string; prompt: string; schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } }; schemaVersion: string; maxOutputTokens?: number; abortSignal?: AbortSignal }): Promise<{ value: T; run: RunRecord | null; repaired: boolean }> {
    const tried: string[] = [];
    const attempts: RunRecord["attempts"] = [];
    const parse = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end <= start) return { ok: false, error: "the answer contained no JSON object" };
      let raw: unknown;
      try {
        raw = JSON.parse(text.slice(start, end + 1));
      } catch (e) {
        return { ok: false, error: `the JSON did not parse: ${(e as Error).message}` };
      }
      const checked = input.schema.safeParse(raw);
      return checked.success ? { ok: true, value: checked.data } : { ok: false, error: checked.error.message.slice(0, 1500) };
    };
    for (;;) {
      const scoped: RunScope = { ...scope, schemaVersion: input.schemaVersion, excludeProfiles: [...(scope.excludeProfiles ?? []), ...tried] };
      let first: { text: string; run: RunRecord | null };
      try {
        first = await this.generateText(scoped, input);
      } catch (e) {
        if (e instanceof NoSelectableProfileError && tried.length > 0) throw new InferenceFailedError(scope.task, attempts);
        throw e;
      }
      const a = parse(first.text);
      if (a.ok) return { value: a.value, run: first.run, repaired: false };
      const profileId = first.run?.profileId ?? "unknown";
      const second = await this.generateText({ ...scoped, excludeProfiles: [...(scoped.excludeProfiles ?? [])] }, { ...input, prompt: `${input.prompt}\n\nYour previous answer was rejected: ${a.error}\nAnswer again with ONLY a JSON object that satisfies the schema.` });
      const b = parse(second.text);
      if (b.ok) return { value: b.value, run: second.run, repaired: true };
      attempts.push({ profileId, errorClass: "invalid_structured_output", message: b.error.slice(0, 300) });
      tried.push(profileId);
    }
  }
}
