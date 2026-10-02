/**
 * Test helpers for this package and for the journey, adversarial and simulation suites.
 * The ONLY stand-in is the labelled FAKE MODEL at the model boundary; the Durable Object, the Think
 * session, D1, the command service, receipts, recall and the model service around the fake are real.
 */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { GarderobeAssistantBase } from "../agent/assistant.ts";
import type { ModelCallMeta } from "../inference/service.ts";
import type { ProfileSpec } from "../inference/registry.ts";
import type { AssistantPorts } from "../tools/runtime.ts";
import { fakeModelFor } from "./fake-model.ts";

export * from "./fake-model.ts";

/** Gateway name used for probe, breaker and reservation rows in tests. No Gateway is contacted. */
export const TEST_GATEWAY_ID = "garderobe-test-fake";

const clock = { nowMs: null as number | null };
const ports: { value: AssistantPorts } = { value: {} };
const tuning = { compactAfterTokens: null as number | null, compactKeepRecent: null as number | null };

/** Set (or clear with null) the time the test actor sees. */
export function setTestNow(iso: string | null): void {
  clock.nowMs = iso === null ? null : Date.parse(iso);
}
export function setTestPorts(p: AssistantPorts): void {
  ports.value = p;
}
export function setTestCompaction(afterTokens: number | null, keepRecent: number | null = null): void {
  tuning.compactAfterTokens = afterTokens;
  tuning.compactKeepRecent = keepRecent;
}

/**
 * The conversation actor with the FAKE MODEL at the model boundary. Each profile gets its own fake
 * (`fakeModelFor(profileId)`), so tests can script a primary and a fallback independently.
 */
export class TestAssistant extends GarderobeAssistantBase {
  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    if (tuning.compactAfterTokens !== null) this.compactAfterTokens = tuning.compactAfterTokens;
    if (tuning.compactKeepRecent !== null) this.compactKeepRecent = tuning.compactKeepRecent;
  }
  protected override gatewayId(): string {
    return TEST_GATEWAY_ID;
  }
  protected override createLanguageModel(spec: ProfileSpec, _meta: ModelCallMeta): LanguageModelV4 {
    return fakeModelFor(spec.profileId);
  }
  protected override now(): number {
    return clock.nowMs ?? Date.now();
  }
  /**
   * The ports the composition root configured (`configureAssistant({ ports })`), exactly as in production,
   * with any port a test set through `setTestPorts` taking precedence. Only the model is replaced by this
   * class: a Worker-level test therefore has the Worker's real photo, outfit and connection ports.
   */
  protected override ports(): AssistantPorts {
    return { ...super.ports(), ...ports.value };
  }
}
export * from "./fake-google.ts";
export * from "./corpora.ts";
