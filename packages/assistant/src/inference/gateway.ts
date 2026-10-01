/**
 * AI Gateway adapter - the ONLY place application inference leaves the Worker.
 *
 * Verified against the installed `workers-ai-provider` 4.0.0 (bundled with @cloudflare/think 0.19.0):
 * `createWorkersAI({ binding, gateway: { id }, providers })("<provider>/<model>", callOptions)` dispatches a
 * third-party catalog model through AI Gateway on the Worker-side `AI` binding. Without `byok`, upstream
 * provider auth headers are stripped so Unified Billing applies; this adapter never sets `byok`, never
 * sends a provider key and never falls back to a direct provider. The gateway is always named: the
 * implicit `default` gateway is refused. No per-call cache option is set: in this provider release
 * `cacheTtl`/`skipCache` force the BYOK gateway path, so response caching is disabled in the Gateway's own
 * configuration instead (a deployment setting) and the call stays on the Unified Billing run path.
 *
 * The package marks third-party catalog routing as experimental; whether a given route answers and is
 * billed through Unified Billing is established only by the deployment probes (`inference.record_probe`),
 * never assumed here.
 */
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { anthropic } from "workers-ai-provider/anthropic";
import { openai } from "workers-ai-provider/openai";
import type { ProfileSpec } from "./registry.ts";

export class GatewayConfigError extends Error {
  readonly code = "gateway_config";
}

/** Gateway IDs this application may use, fixed in trusted configuration (never chosen by a model or client). */
export const ALLOWED_GATEWAY_IDS = ["garderobe-dev", "garderobe-prod"] as const;

export function assertGatewayId(gatewayId: string | undefined | null, allowed: readonly string[] = ALLOWED_GATEWAY_IDS): string {
  if (!gatewayId) throw new GatewayConfigError("no AI Gateway is configured (AI_GATEWAY_ID); inference is unavailable rather than routed implicitly");
  if (gatewayId === "default") throw new GatewayConfigError("the implicit 'default' gateway is never used; name the intended gateway");
  if (!allowed.includes(gatewayId)) throw new GatewayConfigError(`gateway '${gatewayId}' is not one of this application's gateways (${allowed.join(", ")})`);
  return gatewayId;
}

export interface GatewayCallMeta {
  /** Garderobe run and task IDs, attached as non-sensitive Gateway metadata for accounting. */
  runId: string;
  task: string;
  attempt: number;
  environment: string;
}

/** Only short, non-personal identifiers ever go into Gateway metadata. */
export function gatewayMetadata(meta: GatewayCallMeta): Record<string, string | number> {
  return { garderobe_run: meta.runId.slice(0, 64), garderobe_task: meta.task, garderobe_attempt: meta.attempt, garderobe_env: meta.environment };
}

export function createGatewayModel(env: { AI?: Ai }, gatewayIdInput: string | undefined, spec: ProfileSpec, meta: GatewayCallMeta, allowed?: readonly string[]): LanguageModel {
  const gatewayId = assertGatewayId(gatewayIdInput, allowed);
  if (!env.AI) throw new GatewayConfigError("the Workers AI binding (AI) is not configured; inference is unavailable");
  if (!spec.gatewayRoute || !spec.apiModelId) throw new GatewayConfigError(`${spec.label} has no verified Gateway route: ${spec.pendingReason ?? "unverified"}`);
  const metadata = gatewayMetadata(meta);
  const provider = createWorkersAI({
    binding: env.AI,
    gateway: { id: gatewayId, metadata },
    providers: [openai, anthropic],
  });
  // No `byok`, no `extraHeaders`: provider credentials are never part of a request.
  return provider(spec.gatewayRoute as `${string}/${string}`, { metadata, resume: false, transport: "run" } as never) as unknown as LanguageModel;
}
