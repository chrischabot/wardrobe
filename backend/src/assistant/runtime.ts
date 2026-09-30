import type { Env } from '../env.js';
import { FakeModelTransport } from '../models/fake.js';
import { applyRecordedProbes, ModelRegistry } from '../models/registry.js';
import { ModelService } from '../models/service.js';
import { spendCapFromEnv } from '../models/budget.js';
import { GatewayTransport } from '../models/transport-gateway.js';
import type { ModelRoute } from '../models/registry.js';
import type { ModelTransport } from '../models/types.js';
import { LocalSearchIndex } from '../recall/search-index.js';
import { RecallService } from '../recall/service.js';

/**
 * Runtime wiring for the assistant: model service, recall and research services per owner.
 *
 * Model routing:
 *  - Tests install a FakeModelTransport with installTestModelTransport(); the registry then assigns
 *    every task to its fake profile.
 *  - A local environment without Gateway credentials (wrangler dev, the MCP simulation) uses a shared
 *    deterministic FakeModelTransport and says so in every run log (provider `fake`).
 *  - Otherwise the GatewayTransport serves the candidate profiles, which stay unavailable until their
 *    Gateway and Unified Billing probe passes. There is no direct-provider or BYOK path.
 */

let testTransport: FakeModelTransport | null = null;
const localFake = new FakeModelTransport();

export function installTestModelTransport(t: FakeModelTransport): void {
  testTransport = t;
}

export function clearTestModelTransport(): void {
  testTransport = null;
}

export interface RuntimeEnv extends Pick<Env, 'DB' | 'AI' | 'ENVIRONMENT' | 'AI_GATEWAY_ID' | 'AI_GATEWAY_ACCOUNT_ID'> {
  AI_GATEWAY_TOKEN?: string;
  /** Deployment probe records (JSON; see applyRecordedProbes). Without them every candidate stays pending. */
  MODEL_PROBES?: string;
  /** Deployment-wide 30-day model spend ceiling in US dollars (models/budget.ts SpendCap). */
  MODEL_SPEND_CAP_USD?: string;
}

export function usesSimulatedModel(env: RuntimeEnv): boolean {
  return Boolean(testTransport) || (env.ENVIRONMENT === 'local' && !env.AI_GATEWAY_ACCOUNT_ID);
}

export function createModelService(env: RuntimeEnv, userId: string, opts: { now?: () => string } = {}): ModelService {
  const transports: Partial<Record<ModelRoute, ModelTransport>> = {};
  let registry: ModelRegistry;
  if (usesSimulatedModel(env)) {
    registry = ModelRegistry.forTests();
    transports.fake = testTransport ?? localFake;
  } else {
    registry = ModelRegistry.fromEnvironment(env.ENVIRONMENT);
    applyRecordedProbes(registry, env.MODEL_PROBES, env.AI_GATEWAY_ID);
    const gateway = new GatewayTransport({
      accountId: env.AI_GATEWAY_ACCOUNT_ID,
      gatewayId: env.AI_GATEWAY_ID,
      allowedGatewayIds: [env.AI_GATEWAY_ID],
      token: env.AI_GATEWAY_TOKEN,
      ai: env.AI,
    });
    // One transport serves every gateway route it declares (compat, native Anthropic, Workers AI binding).
    for (const route of gateway.routes) transports[route] = gateway;
  }
  return new ModelService({ db: env.DB, userId, registry, transports, gatewayId: env.AI_GATEWAY_ID, now: opts.now, spendCap: spendCapFromEnv(env.MODEL_SPEND_CAP_USD) });
}

export function createRecallService(env: Pick<Env, 'DB'>): RecallService {
  return new RecallService(env.DB, new LocalSearchIndex(env.DB));
}
