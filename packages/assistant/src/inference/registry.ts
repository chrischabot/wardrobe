/**
 * Model registry: candidate profiles and task routing (specification section 12).
 *
 * NOTHING here is an enabled production profile. A profile becomes selectable only after an
 * authenticated capability AND Unified Billing probe passed on the environment's named Gateway for
 * every operation the task needs (recorded with `inference.record_probe`). Prices and context sizes
 * are reservation hypotheses with no observation date until a deployment probe records one; they are
 * deliberately conservative and only bound spend, they are not claims about provider pricing.
 */
import type { BudgetClass, InferenceTask, ModelOperation, ModelProbe, ModelProfile } from "@garderobe/contracts/ext/assistant";

export interface ProfileSpec {
  profileId: string;
  label: string;
  provider: string;
  apiModelId: string | null;
  gatewayRoute: string | null;
  supportedOperations: ModelOperation[];
  inputTypes: ("text" | "image")[];
  /** Provider-specific request parameters, sent exactly as written. No universal effort scale. */
  effort: Record<string, unknown>;
  contextTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  price: { inputMicroUsdPerMTok: number; outputMicroUsdPerMTok: number; observedOn: string | null };
  /** Provider rate limits; unknown until a deployment probe observes them. */
  rateLimit?: { requestsPerMinute: number | null; tokensPerMinute: number | null; observedOn: string | null };
  dataPermissions: string;
  /** Why the profile cannot be used at all (for example an unverified model ID). */
  pendingReason: string | null;
}

const NO_TRAINING = "Requests go through the named AI Gateway with prompt and response body logging disabled; no provider key is sent (Unified Billing).";

export const PROFILE_SPECS: readonly ProfileSpec[] = [
  {
    profileId: "deepseek-v41-flash",
    label: "DeepSeek V4.1 Flash",
    provider: "deepseek",
    apiModelId: "deepseek-flash",
    gatewayRoute: "deepseek/deepseek-flash",
    supportedOperations: ["text", "tools", "structured_output", "vision"],
    inputTypes: ["text", "image"],
    effort: {},
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    timeoutMs: 60_000,
    price: { inputMicroUsdPerMTok: 1_000_000, outputMicroUsdPerMTok: 4_000_000, observedOn: null },
    dataPermissions: NO_TRAINING,
    pendingReason: null,
  },
  {
    profileId: "fable-5-1",
    label: "Fable 5.1 (heavyweight fallback candidate)",
    provider: "anthropic",
    apiModelId: "claude-fable-5-1",
    gatewayRoute: "anthropic/claude-fable-5-1",
    supportedOperations: ["text", "tools", "structured_output", "vision"],
    inputTypes: ["text", "image"],
    // Forced tool use is restricted on this model; the application never depends on forcing a read.
    effort: {},
    contextTokens: 200_000,
    maxOutputTokens: 8_000,
    timeoutMs: 120_000,
    price: { inputMicroUsdPerMTok: 15_000_000, outputMicroUsdPerMTok: 75_000_000, observedOn: null },
    dataPermissions: NO_TRAINING,
    pendingReason: null,
  },
  {
    profileId: "gpt-6-astra",
    label: "GPT-6 Astra",
    provider: "openai",
    apiModelId: "gpt-6-astra",
    gatewayRoute: "openai/gpt-6-astra",
    supportedOperations: ["text", "tools", "structured_output", "vision"],
    inputTypes: ["text", "image"],
    effort: {},
    contextTokens: 200_000,
    maxOutputTokens: 8_000,
    timeoutMs: 120_000,
    price: { inputMicroUsdPerMTok: 15_000_000, outputMicroUsdPerMTok: 60_000_000, observedOn: null },
    dataPermissions: NO_TRAINING,
    pendingReason: null,
  },
  {
    profileId: "kimi",
    label: "Kimi (provider family)",
    provider: "moonshot",
    apiModelId: null,
    gatewayRoute: null,
    supportedOperations: ["text", "tools"],
    inputTypes: ["text"],
    effort: {},
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    timeoutMs: 60_000,
    price: { inputMicroUsdPerMTok: 2_000_000, outputMicroUsdPerMTok: 8_000_000, observedOn: null },
    dataPermissions: NO_TRAINING,
    pendingReason: "the exact Kimi model ID and its parameter contract have not been verified for this Gateway",
  },
  {
    profileId: "glm",
    label: "GLM (provider family)",
    provider: "zai",
    apiModelId: null,
    gatewayRoute: null,
    supportedOperations: ["text", "tools"],
    inputTypes: ["text"],
    effort: {},
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    timeoutMs: 60_000,
    price: { inputMicroUsdPerMTok: 2_000_000, outputMicroUsdPerMTok: 8_000_000, observedOn: null },
    dataPermissions: NO_TRAINING,
    pendingReason: "the exact GLM model ID and its parameter contract have not been verified for this Gateway",
  },
  {
    profileId: "gpt-extra",
    label: "GPT Extra (requested label)",
    provider: "openai",
    apiModelId: null,
    gatewayRoute: null,
    supportedOperations: ["text"],
    inputTypes: ["text"],
    effort: {},
    contextTokens: 128_000,
    maxOutputTokens: 8_000,
    timeoutMs: 120_000,
    price: { inputMicroUsdPerMTok: 15_000_000, outputMicroUsdPerMTok: 60_000_000, observedOn: null },
    dataPermissions: NO_TRAINING,
    pendingReason: "the requested label 'GPT Extra' does not resolve to a verified API model name; it is not equated with GPT-6 Astra",
  },
  {
    profileId: "search-embedding",
    label: "AI Search embedding model",
    provider: "workers-ai",
    apiModelId: null,
    gatewayRoute: null,
    supportedOperations: ["embedding"],
    inputTypes: ["text"],
    effort: {},
    contextTokens: 8_000,
    maxOutputTokens: 1,
    timeoutMs: 30_000,
    price: { inputMicroUsdPerMTok: 500_000, outputMicroUsdPerMTok: 0, observedOn: null },
    dataPermissions: NO_TRAINING,
    pendingReason: "the embedding model has not been verified through the Gateway and Unified Billing; lexical and entity search stay available",
  },
  {
    profileId: "image-edit",
    label: "Catalogue image editing provider",
    provider: "unselected",
    apiModelId: null,
    gatewayRoute: null,
    supportedOperations: ["image_edit"],
    inputTypes: ["image"],
    effort: {},
    contextTokens: 8_000,
    maxOutputTokens: 1,
    timeoutMs: 120_000,
    price: { inputMicroUsdPerMTok: 0, outputMicroUsdPerMTok: 0, observedOn: null },
    dataPermissions: NO_TRAINING,
    pendingReason: "no image-editing route has passed a Gateway image-edit probe; originals are retained and assets stay unresolved",
  },
];

export interface TaskSpec {
  task: InferenceTask;
  budgetClass: BudgetClass;
  /** Operations a profile must have PASSED probes for before it can serve this task. */
  requiredOperations: ModelOperation[];
  /** Candidate order; the first selectable one is used. */
  candidates: string[];
  maxOutputTokens: number;
  /** Bounded retries on the same profile before the next fallback. */
  retries: number;
}

export const TASK_SPECS: Record<InferenceTask, TaskSpec> = {
  conversation: { task: "conversation", budgetClass: "interactive", requiredOperations: ["text", "tools"], candidates: ["deepseek-v41-flash", "fable-5-1", "gpt-6-astra"], maxOutputTokens: 4_000, retries: 1 },
  outfit_composition: { task: "outfit_composition", budgetClass: "daily_board", requiredOperations: ["text", "structured_output"], candidates: ["deepseek-v41-flash", "fable-5-1", "gpt-6-astra"], maxOutputTokens: 6_000, retries: 1 },
  extraction: { task: "extraction", budgetClass: "research", requiredOperations: ["text", "structured_output"], candidates: ["deepseek-v41-flash", "fable-5-1"], maxOutputTokens: 4_000, retries: 1 },
  photo_matching: { task: "photo_matching", budgetClass: "interactive", requiredOperations: ["vision"], candidates: ["deepseek-v41-flash", "fable-5-1", "gpt-6-astra"], maxOutputTokens: 2_000, retries: 1 },
  historical_research: { task: "historical_research", budgetClass: "research", requiredOperations: ["text", "tools"], candidates: ["fable-5-1", "gpt-6-astra", "deepseek-v41-flash"], maxOutputTokens: 6_000, retries: 1 },
  catalogue_editing: { task: "catalogue_editing", budgetClass: "image_backfill", requiredOperations: ["image_edit"], candidates: ["image-edit"], maxOutputTokens: 1, retries: 0 },
  compaction: { task: "compaction", budgetClass: "maintenance", requiredOperations: ["text"], candidates: ["deepseek-v41-flash", "fable-5-1"], maxOutputTokens: 3_000, retries: 1 },
  recall_enrichment: { task: "recall_enrichment", budgetClass: "maintenance", requiredOperations: ["text", "structured_output"], candidates: ["deepseek-v41-flash", "fable-5-1"], maxOutputTokens: 2_000, retries: 1 },
  semantic_indexing: { task: "semantic_indexing", budgetClass: "search", requiredOperations: ["embedding"], candidates: ["search-embedding"], maxOutputTokens: 1, retries: 1 },
};

/** Daily application budgets in micro-USD (personal-use defaults; owner-editable under settings.extensions.assistant.budgets). */
export const DEFAULT_DAILY_BUDGETS: Record<BudgetClass, number> = {
  daily_board: 500_000, // reserved for tomorrow's board; never consumed by chat or research
  interactive: 1_000_000,
  research: 1_500_000,
  image_backfill: 1_000_000,
  maintenance: 300_000,
  search: 200_000,
};

export function profileSpec(profileId: string): ProfileSpec | undefined {
  return PROFILE_SPECS.find((p) => p.profileId === profileId);
}

export interface ProbeRow {
  profile_id: string;
  operation: string;
  result: string;
  billing: string;
  reason: string | null;
  resolved_model: string | null;
  probed_at: string;
}

/** A profile is selectable for a set of operations only when each passed its probe with Unified Billing. */
export function selectability(spec: ProfileSpec, probes: ProbeRow[], required: ModelOperation[]): { selectable: boolean; reason: string | null } {
  if (spec.pendingReason) return { selectable: false, reason: spec.pendingReason };
  if (!spec.gatewayRoute || !spec.apiModelId) return { selectable: false, reason: "no verified Gateway route" };
  for (const op of required) {
    if (!spec.supportedOperations.includes(op)) return { selectable: false, reason: `this profile does not support ${op}` };
    const probe = probes.find((p) => p.profile_id === spec.profileId && p.operation === op);
    if (!probe) return { selectable: false, reason: `the ${op} capability has not been probed on this Gateway` };
    if (probe.result !== "passed") return { selectable: false, reason: `the ${op} probe failed${probe.reason ? `: ${probe.reason}` : ""}` };
    if (probe.billing !== "unified_billing") return { selectable: false, reason: `Cloudflare Unified Billing is not available for this route${probe.reason ? `: ${probe.reason}` : ""}; there is no direct-provider or BYOK fallback` };
  }
  return { selectable: true, reason: null };
}

export function toModelProfile(spec: ProfileSpec, probes: ProbeRow[], fallbacks: string[]): ModelProfile {
  const rows: ModelProbe[] = spec.supportedOperations.map((operation) => {
    const p = probes.find((r) => r.profile_id === spec.profileId && r.operation === operation);
    return p
      ? { operation, result: p.result as ModelProbe["result"], billing: p.billing as ModelProbe["billing"], reason: p.reason, probedAt: p.probed_at, resolvedModel: p.resolved_model }
      : { operation, result: "not_probed", billing: "not_probed", reason: null, probedAt: null, resolvedModel: null };
  });
  // "Selectable" in the app means usable for plain text work; task routing applies the task's own operations.
  const base = selectability(spec, probes, spec.supportedOperations.includes("text") ? ["text"] : [spec.supportedOperations[0] ?? "text"]);
  return {
    profileId: spec.profileId,
    label: spec.label,
    provider: spec.provider,
    apiModelId: spec.apiModelId,
    gatewayRoute: spec.gatewayRoute,
    supportedOperations: [...spec.supportedOperations],
    inputTypes: [...spec.inputTypes],
    effort: spec.effort,
    contextTokens: spec.contextTokens,
    maxOutputTokens: spec.maxOutputTokens,
    timeoutMs: spec.timeoutMs,
    price: spec.price,
    rateLimit: spec.rateLimit ?? { requestsPerMinute: null, tokensPerMinute: null, observedOn: null },
    dataPermissions: spec.dataPermissions,
    fallbacks,
    probes: rows,
    selectable: base.selectable,
    unavailableReason: base.reason,
  };
}

/** Conservative reservation for one call: full context in, maximum output out, at the hypothesis price. */
export function estimateReservationMicroUsd(spec: ProfileSpec, inputTokens: number, maxOutputTokens: number): number {
  const input = Math.min(inputTokens, spec.contextTokens);
  return Math.ceil((input * spec.price.inputMicroUsdPerMTok + maxOutputTokens * spec.price.outputMicroUsdPerMTok) / 1_000_000);
}

export function actualCostMicroUsd(spec: ProfileSpec, inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * spec.price.inputMicroUsdPerMTok + outputTokens * spec.price.outputMicroUsdPerMTok) / 1_000_000);
}
