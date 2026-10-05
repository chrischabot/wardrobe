/**
 * Evaluation entry: the real Worker (`apps/worker/src/index.ts`: same fetch, scheduled and queue handlers,
 * same router, same OAuth provider) with ONE difference, at the transport of the conversation actor's model.
 *
 * Production routes inference through the Worker's `AI` binding on the named AI Gateway. That binding does
 * not exist in a local workerd. So this entry uses the seam the product defines for the model
 * (`GarderobeAssistantBase.createLanguageModel`, the same one the test entry uses for its fake model) and
 * returns a REAL model: the registry route the product's model service selected (`spec.gatewayRoute`, for
 * example the first selectable candidate of the conversation task), sent to the SAME gateway over HTTP by
 * the harness's Node-side relay (`src/node/outbound.ts`, `src/node/gateway.mjs`), which holds the gateway
 * token. No profile is added, replaced or renamed: which profile serves a task is the product's own routing
 * over the product's own registry, fed by real probes of the gateway made at the start of the run.
 *
 * Everything else of a turn is the product's: the mandatory context, the tools, the policy that turns a
 * tool call into a receipt or a request to confirm, the model service's reservations and fallbacks.
 */
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { GarderobeAssistantBase } from "@garderobe/assistant";
import type { Env } from "../../apps/worker/src/env.ts";
import worker from "../../apps/worker/src/index.ts";
import { bindEnv } from "../../apps/worker/src/lanes/index.ts";

/** Placeholder host: every request to it is taken by the Node-side relay, which adds the gateway token and forwards. */
export const EVAL_MODEL_HOST = "https://model.eval-harness.test";

interface EvalEnv extends Env {
  /** The application gateway this run uses (the orchestrator's EVAL_GATEWAY_ID, `garderobe-dev` by default). */
  EVAL_GATEWAY_ID: string;
}

export class GarderobeAssistant extends GarderobeAssistantBase {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    bindEnv(env);
  }
  protected override gatewayId(): string {
    return (this.env as EvalEnv).EVAL_GATEWAY_ID || "garderobe-dev";
  }
  protected override createLanguageModel(spec: { profileId: string; gatewayRoute: string | null; label: string }, meta: { runId: string; task: string; attempt: number }): LanguageModelV4 {
    if (!spec.gatewayRoute) throw new Error(`${spec.label} has no gateway route in the registry; inference is unavailable`);
    const headers = { "x-eval-run": String(meta.runId).slice(0, 96), "x-eval-task": meta.task, "x-eval-attempt": String(meta.attempt), "x-eval-profile": spec.profileId };
    return createOpenAI({ baseURL: EVAL_MODEL_HOST, apiKey: "held-by-the-harness-relay", headers }).chat(spec.gatewayRoute) as unknown as LanguageModelV4;
  }
}

export default worker;
