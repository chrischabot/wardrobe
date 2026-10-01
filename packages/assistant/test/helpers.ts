/** Shared setup for the assistant tests: real D1, real command service, real owner data, the real Durable Object. */
import { env } from "cloudflare:test";
import { createFoundationRegistry, listInventory, type CommandRegistry, type Principal } from "@garderobe/domain";
import { createHarness, type Harness, type TestOwner } from "@garderobe/domain/testing";
import type { ModelOperation } from "@garderobe/contracts/ext/assistant";
import { assistantClient, registerAssistant, type AssistantClient } from "../src/index.ts";
import { TEST_GATEWAY_ID, resetFakeModels, setTestNow, setTestPorts, fakeModelFor, type FakeModel } from "../src/testing/index.ts";

export const START = "2026-09-15T08:00:00Z";

export interface World {
  h: Harness;
  owner: TestOwner;
  client: AssistantClient;
  /** The FAKE MODEL standing in for the primary conversation profile. */
  model: FakeModel;
  garment(search: string): Promise<{ garmentId: string; name: string }>;
  clientFor(principal: Principal): AssistantClient;
}

export async function passProbes(h: Harness, owner: TestOwner, profileId: string, operations: ModelOperation[] = ["text", "tools", "structured_output", "vision"]): Promise<void> {
  for (const operation of operations) {
    await owner.exec(
      "inference.record_probe",
      { profileId, operation, result: "passed", billing: "unified_billing", reason: "TEST FIXTURE: the route is served by the FAKE MODEL; no Gateway was probed", gatewayId: TEST_GATEWAY_ID },
      { actor: "system", channel: "system", scopes: ["read", "write", "admin"], authorization: "system_schedule" },
    );
  }
}

export async function createWorld(opts: { real?: boolean; probes?: string[]; startAt?: string; extend?: (registry: CommandRegistry) => void } = {}): Promise<World> {
  resetFakeModels();
  setTestPorts({});
  setTestNow(opts.startAt ?? START);
  const registry = registerAssistant(createFoundationRegistry());
  opts.extend?.(registry);
  const h = await createHarness({ registry, startAt: opts.startAt ?? START });
  const owner = opts.real === false ? await h.createSyntheticOwner() : (await h.createRealOwner()).owner;
  for (const profileId of opts.probes ?? ["deepseek-v41-flash"]) await passProbes(h, owner, profileId);
  const clientFor = (principal: Principal) => assistantClient(env as never, principal);
  return {
    h,
    owner,
    client: clientFor(owner.principal({ channel: "ios" })),
    model: fakeModelFor("deepseek-v41-flash"),
    clientFor,
    async garment(search: string) {
      const page = await listInventory(h.db, owner.principal(), { search });
      const hit = page.items[0];
      if (!hit) throw new Error(`test setup: no garment matches "${search}"`);
      return { garmentId: hit.garment.garmentId, name: hit.garment.name };
    },
  };
}

let counter = 0;
export function submission(label = "t"): string {
  return `sub-${label}-${Date.now()}-${counter++}`;
}

/** Move both clocks (the harness command service and the conversation actor). */
export function setNow(w: World, iso: string): void {
  w.h.clock.set(iso);
  setTestNow(iso);
}
