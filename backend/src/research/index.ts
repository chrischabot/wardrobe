import type { Env } from '../env.js';
import type { ModelService } from '../models/service.js';
import type { AssistantServices } from '../assistant/tools.js';
import { ResearchService, type ResearchProviders } from './service.js';

export { ResearchService, FRESHNESS_MS, type ResearchProviders, type Investigation, type InvestigationInput } from './service.js';
export { sizeAdvice, type SizeAdvice, type SizeAdviceInput, type ChartRow } from './sizing.js';
export { ownerSizeFacts, profileSizeFacts, type SizeFact } from './owner-sizes.js';
export { purchaseVerdict, type Verdict, type VerdictInput, type Gate } from './verdict.js';
export { productFacts, variantAvailability, jsonLdBlocks, type ProductFacts, type VariantFact, type Availability } from './product.js';

let testProviders: ResearchProviders | null = null;

/** Tests and the simulation install fake web providers here. */
export function installTestResearchProviders(p: ResearchProviders | null): void {
  testProviders = p;
}

/**
 * Research service for the assistant. Real providers come from the owner's approved Exa/Tavily
 * connections and a Browser Run account binding (wired by the deployment workstream); with none
 * connected, investigation reports that no capability is available rather than guessing.
 */
export function createResearchService(env: Pick<Env, 'DB'>, userId: string, models: () => ModelService): NonNullable<AssistantServices['research']> & { service: ResearchService } {
  const service = new ResearchService(env.DB, userId, testProviders ?? { search: [] }, { models });
  return {
    service,
    investigate: (p, i) => service.investigate(p, i as never),
    sizeAdvice: (p, i) => service.sizeAdvice(p, i as never),
    verdict: (p, i) => service.verdict(p, i as never),
  };
}
