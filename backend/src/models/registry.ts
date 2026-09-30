/**
 * Model task profiles (spec section 12). A profile names the exact provider route, API model id,
 * supported inputs, effort parameters, limits, prices (with observation date) and ordered fallbacks.
 *
 * A profile is selectable only when its authenticated capability and Unified Billing probe has passed.
 * The candidate profiles below are all `pending` until the deployment probe records a result; nothing
 * here claims an enabled production route. The `fake` provider exists for tests and the simulation and
 * is refused outside local/test environments.
 */

export const MODEL_TASKS = ['chat', 'compaction', 'vision', 'extraction', 'embeddings', 'generation', 'composition', 'research'] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

export type ModelProviderFamily = 'workers-ai' | 'deepseek' | 'anthropic' | 'openai' | 'moonshot' | 'zai' | 'fake';

export type ModelRoute =
  /** OpenAI-compatible Unified Billing endpoint of the named gateway: /v1/{account}/{gateway}/compat. */
  | 'gateway-compat'
  /**
   * Anthropic's own Messages API through the named gateway: /v1/{account}/{gateway}/anthropic/v1/messages,
   * Unified Billing (gateway token only). Used where the compat endpoint drops a provider parameter the
   * profile depends on: Claude's `output_config.effort` (verified on garderobe-dev, 2026-09-29).
   */
  | 'gateway-anthropic'
  /**
   * OpenAI's Responses API through the named gateway: /v1/{account}/{gateway}/openai/responses, Unified
   * Billing. gpt-6.1-sol refuses function tools with reasoning on /chat/completions ("use /v1/responses"),
   * and the assistant always offers tools (verified on garderobe-dev, 2026-09-29).
   */
  | 'gateway-openai-responses'
  /** Workers AI binding with an explicit `gateway: { id }` option. */
  | 'workers-ai-binding'
  /** Deterministic in-process fake (tests and simulation only). */
  | 'fake';

export interface ModelProfile {
  profileId: string;
  tasks: ModelTask[];
  provider: ModelProviderFamily;
  /** Exact API model id as sent on the route (e.g. `deepseek/deepseek-flash`). */
  apiModelId: string;
  route: ModelRoute;
  inputTypes: ('text' | 'image')[];
  supportsTools: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Provider-specific effective request parameters, recorded verbatim; never a fake common scale. */
  effort: Record<string, unknown>;
  /**
   * Wire differences the route must honour: the output-limit field name (OpenAI reasoning models
   * refuse `max_tokens`) and whether sampling parameters such as temperature may be sent.
   */
  wire?: { maxTokensField?: 'max_tokens' | 'max_completion_tokens'; sampling?: boolean };
  pricing: { inputMicroUsdPerMTok: number; outputMicroUsdPerMTok: number; observedOn: string };
  fallbacks: string[];
  /** Data classes this provider may receive (profile, email_excerpt, calendar, image, ...). */
  dataClasses: string[];
  probe: { status: 'pending' | 'passed' | 'failed'; checkedAt?: string; reason?: string };
}

const ALL_DATA = ['profile', 'wardrobe', 'conversation', 'email_excerpt', 'calendar', 'image', 'research'];

/**
 * The assistant's two chat models, chosen by the owner (2026-09-29): GPT-6.1 Sol for routine turns and
 * Claude Opus 5.5 at medium effort where deeper reasoning is needed. No task defaults to a higher tier.
 * Prices are the published standard rates, cross-checked against the garderobe-dev gateway: the
 * gateway's model catalogue lists claude-opus-5-5 at $4 / $20 per million input / output tokens
 * (Anthropic's price sheet agrees); gpt-6.1-sol is not yet in that catalogue, and OpenAI lists it at
 * $2 / $10.
 */
export const ASSISTANT_CHAT_PROFILES = ['chat.gpt-6-1-sol', 'chat.opus-5-5-medium'] as const;

/** Tasks served by the assistant's chat models (routine versus deeper-reasoning turns). */
const CHAT_TASKS: ModelTask[] = ['chat', 'research', 'composition', 'vision', 'compaction', 'extraction'];

export const CANDIDATE_PROFILES: ModelProfile[] = [
  {
    profileId: 'chat.gpt-6-1-sol',
    tasks: CHAT_TASKS,
    provider: 'openai',
    apiModelId: 'gpt-6.1-sol',
    route: 'gateway-openai-responses',
    inputTypes: ['text', 'image'],
    supportsTools: true,
    maxInputTokens: 272_000,
    maxOutputTokens: 8_000,
    timeoutMs: 90_000,
    // Verified through garderobe-dev: reasoning effort low | medium | high | xhigh ("none" is refused).
    effort: { reasoning: { effort: 'medium' } },
    wire: { sampling: false },
    pricing: { inputMicroUsdPerMTok: 2_000_000, outputMicroUsdPerMTok: 10_000_000, observedOn: '2026-09-29' },
    fallbacks: ['chat.opus-5-5-medium'],
    dataClasses: ALL_DATA,
    probe: { status: 'pending', reason: 'Gateway and Unified Billing probe not yet recorded for this deployment' },
  },
  {
    profileId: 'chat.opus-5-5-medium',
    tasks: CHAT_TASKS,
    provider: 'anthropic',
    apiModelId: 'claude-opus-5-5',
    // The compat endpoint silently drops Anthropic's effort parameter; the native route validates it.
    route: 'gateway-anthropic',
    inputTypes: ['text', 'image'],
    supportsTools: true,
    maxInputTokens: 200_000,
    // Thinking cannot be disabled on Opus 5.5 and counts as output: leave room for it.
    maxOutputTokens: 12_000,
    timeoutMs: 120_000,
    effort: { output_config: { effort: 'medium' } },
    wire: { sampling: false },
    pricing: { inputMicroUsdPerMTok: 4_000_000, outputMicroUsdPerMTok: 20_000_000, observedOn: '2026-09-29' },
    fallbacks: ['chat.gpt-6-1-sol'],
    dataClasses: ALL_DATA,
    probe: { status: 'pending', reason: 'Gateway and Unified Billing probe not yet recorded for this deployment' },
  },
  {
    profileId: 'chat.deepseek-flash',
    tasks: ['chat', 'composition', 'research', 'vision'],
    provider: 'deepseek',
    apiModelId: 'deepseek/deepseek-flash',
    route: 'gateway-compat',
    inputTypes: ['text', 'image'],
    supportsTools: true,
    maxInputTokens: 128_000,
    maxOutputTokens: 8_000,
    timeoutMs: 60_000,
    effort: {},
    pricing: { inputMicroUsdPerMTok: 300_000, outputMicroUsdPerMTok: 1_200_000, observedOn: '2026-09-10' },
    // Not assigned to any task: not entitled on garderobe-dev, and enabling it is the owner's call.
    fallbacks: [],
    dataClasses: ALL_DATA,
    probe: { status: 'pending', reason: 'Gateway and Unified Billing probe not yet run for this account' },
  },
  {
    profileId: 'chat.fable-5-1',
    tasks: ['chat', 'composition', 'research', 'vision', 'compaction'],
    provider: 'anthropic',
    apiModelId: 'anthropic/claude-fable-5-1',
    route: 'gateway-compat',
    inputTypes: ['text', 'image'],
    supportsTools: true,
    maxInputTokens: 200_000,
    maxOutputTokens: 8_000,
    timeoutMs: 90_000,
    effort: {},
    // Observed on the garderobe-dev gateway's analytics (Unified Billing): $1.2410 for 123,956 input and
    // 29 output tokens, and $1.7179 for 164,952 input and 1,367 output tokens.
    pricing: { inputMicroUsdPerMTok: 10_000_000, outputMicroUsdPerMTok: 50_000_000, observedOn: '2026-09-29' },
    // Above the owner's ceiling: kept for the record of earlier runs, never assigned or used as a fallback.
    fallbacks: [],
    dataClasses: ALL_DATA,
    probe: { status: 'pending', reason: 'Unified Billing eligibility for this model not verified' },
  },
  {
    profileId: 'compaction.workers-ai',
    tasks: ['compaction', 'extraction'],
    provider: 'workers-ai',
    apiModelId: '@cf/moonshotai/kimi-k2.7-code',
    route: 'workers-ai-binding',
    inputTypes: ['text'],
    supportsTools: false,
    maxInputTokens: 128_000,
    maxOutputTokens: 4_000,
    timeoutMs: 60_000,
    effort: {},
    pricing: { inputMicroUsdPerMTok: 600_000, outputMicroUsdPerMTok: 2_500_000, observedOn: '2026-09-15' },
    fallbacks: ['chat.gpt-6-1-sol'],
    dataClasses: ['conversation', 'profile', 'wardrobe', 'email_excerpt', 'research'],
    probe: { status: 'pending' },
  },
  {
    profileId: 'embeddings.workers-ai',
    tasks: ['embeddings'],
    provider: 'workers-ai',
    apiModelId: '@cf/baai/bge-m3',
    route: 'workers-ai-binding',
    inputTypes: ['text'],
    supportsTools: false,
    maxInputTokens: 8_000,
    maxOutputTokens: 0,
    timeoutMs: 30_000,
    effort: {},
    pricing: { inputMicroUsdPerMTok: 12_000, outputMicroUsdPerMTok: 0, observedOn: '2026-09-15' },
    fallbacks: [],
    dataClasses: ['conversation', 'wardrobe', 'research'],
    probe: { status: 'pending' },
  },
];

/** Deterministic test/simulation profiles: one per task, all on the fake route. */
export const FAKE_PROFILES: ModelProfile[] = MODEL_TASKS.map((task) => ({
  profileId: `fake.${task}`,
  tasks: [task],
  provider: 'fake',
  apiModelId: `fake/${task}-1`,
  route: 'fake',
  inputTypes: ['text', 'image'],
  supportsTools: true,
  maxInputTokens: 200_000,
  maxOutputTokens: 4_000,
  timeoutMs: 5_000,
  effort: {},
  pricing: { inputMicroUsdPerMTok: 300_000, outputMicroUsdPerMTok: 1_200_000, observedOn: 'n/a (fake)' },
  fallbacks: [],
  dataClasses: ALL_DATA,
  probe: { status: 'passed', reason: 'deterministic fake; local and test only' },
}));

export interface ModelRegistryConfig {
  environment: string;
  profiles: ModelProfile[];
  /** Task -> ordered profile ids (owner-visible configuration). */
  assignments: Partial<Record<ModelTask, string[]>>;
}

export class ModelRegistry {
  private readonly byId: Map<string, ModelProfile>;
  constructor(private readonly config: ModelRegistryConfig) {
    // Own copies: recording a probe must never mutate the shared candidate definitions.
    this.byId = new Map(config.profiles.map((p) => [p.profileId, structuredClone(p)]));
  }

  static forTests(): ModelRegistry {
    return new ModelRegistry({
      environment: 'test',
      profiles: [...FAKE_PROFILES, ...CANDIDATE_PROFILES],
      assignments: Object.fromEntries(MODEL_TASKS.map((t) => [t, [`fake.${t}`]])),
    });
  }

  static fromEnvironment(environment: string, overrides: Partial<Record<ModelTask, string[]>> = {}): ModelRegistry {
    const local = environment === 'local' || environment === 'test';
    const defaults: Partial<Record<ModelTask, string[]>> = {
      // Routine conversation: Sol, falling back to Opus 5.5 medium on a transport-class failure.
      chat: ['chat.gpt-6-1-sol', 'chat.opus-5-5-medium'],
      // Deeper-reasoning turns (shopping, sizing, provenance, research; assistant/model-routing.ts).
      research: ['chat.opus-5-5-medium', 'chat.gpt-6-1-sol'],
      composition: ['chat.gpt-6-1-sol', 'chat.opus-5-5-medium'],
      vision: ['chat.gpt-6-1-sol', 'chat.opus-5-5-medium'],
      compaction: ['compaction.workers-ai', 'chat.gpt-6-1-sol'],
      extraction: ['compaction.workers-ai', 'chat.gpt-6-1-sol'],
      embeddings: ['embeddings.workers-ai'],
      generation: [],
    };
    return new ModelRegistry({
      environment,
      profiles: local ? [...CANDIDATE_PROFILES, ...FAKE_PROFILES] : CANDIDATE_PROFILES,
      assignments: { ...defaults, ...overrides },
    });
  }

  get environment(): string {
    return this.config.environment;
  }

  profile(id: string): ModelProfile | undefined {
    return this.byId.get(id);
  }

  /** Why a profile cannot be used now, or null when it is selectable. */
  unavailableReason(p: ModelProfile): string | null {
    if (p.route === 'fake' && !(this.config.environment === 'local' || this.config.environment === 'test')) return 'The fake provider is limited to local and test environments';
    if (p.probe.status !== 'passed') return `Capability and Unified Billing probe ${p.probe.status}${p.probe.reason ? `: ${p.probe.reason}` : ''}`;
    return null;
  }

  /** Ordered, selectable profiles for a task (primary then fallbacks), with the reasons others were skipped. */
  chain(task: ModelTask): { profiles: ModelProfile[]; skipped: { profileId: string; reason: string }[] } {
    const ids = this.config.assignments[task] ?? [];
    const seen = new Set<string>();
    const profiles: ModelProfile[] = [];
    const skipped: { profileId: string; reason: string }[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const p = this.byId.get(id);
      if (!p) return skipped.push({ profileId: id, reason: 'unknown profile' });
      if (!p.tasks.includes(task)) return skipped.push({ profileId: id, reason: `does not support ${task}` });
      const why = this.unavailableReason(p);
      if (why) skipped.push({ profileId: id, reason: why });
      else profiles.push(p);
      p.fallbacks.forEach(visit);
    };
    ids.forEach(visit);
    return { profiles, skipped };
  }

  /** Owner-visible listing (settings screen): every profile with its availability. */
  describe(): { profileId: string; tasks: ModelTask[]; apiModelId: string; route: ModelRoute; available: boolean; reason: string | null }[] {
    return [...this.byId.values()].map((p) => ({ profileId: p.profileId, tasks: p.tasks, apiModelId: p.apiModelId, route: p.route, available: this.unavailableReason(p) === null, reason: this.unavailableReason(p) }));
  }

  /** Record a probe outcome (deployment workstream calls this after an authenticated probe). */
  recordProbe(profileId: string, status: 'passed' | 'failed', reason?: string, checkedAt = new Date().toISOString()): void {
    const p = this.byId.get(profileId);
    if (p) p.probe = { status, reason, checkedAt };
  }
}

/** One deployment probe record (the `MODEL_PROBES` Worker variable is a JSON object of these by profile id). */
export interface RecordedProbe {
  status: 'passed' | 'failed';
  checkedAt: string;
  /** The gateway the probe ran through; a record for any other gateway is ignored. */
  gatewayId: string;
  reason?: string;
}

/**
 * Applies the probe outcomes a deployment recorded (deploy/scripts/probe.ts writes them into the
 * `MODEL_PROBES` variable). Only known, non-fake profiles are affected, and only by records made
 * through this deployment's gateway; malformed input changes nothing. Returns the profile ids applied.
 */
export function applyRecordedProbes(registry: ModelRegistry, raw: string | undefined, gatewayId: string): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const applied: string[] = [];
  for (const [profileId, rec] of Object.entries(parsed as Record<string, Partial<RecordedProbe>>)) {
    const p = registry.profile(profileId);
    if (!p || p.route === 'fake' || !rec || typeof rec !== 'object') continue;
    if (rec.gatewayId !== gatewayId || (rec.status !== 'passed' && rec.status !== 'failed') || typeof rec.checkedAt !== 'string' || Number.isNaN(Date.parse(rec.checkedAt))) continue;
    registry.recordProbe(profileId, rec.status, typeof rec.reason === 'string' ? rec.reason.slice(0, 300) : undefined, rec.checkedAt);
    applied.push(profileId);
  }
  return applied;
}
