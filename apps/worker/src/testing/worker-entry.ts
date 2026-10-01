/**
 * Test entry: the real Worker (`src/index.ts`: same fetch, scheduled and queue handlers, same router,
 * same OAuth provider) with ONE difference: the conversation actor uses the assistant workstream's
 * labelled FAKE MODEL instead of AI Gateway, because no model is reachable from a local test run.
 */
import { TestAssistant } from "@garderobe/assistant/testing";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import { bindEnv } from "../lanes/index.ts";

export class GarderobeAssistant extends TestAssistant {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    bindEnv(env);
  }
}

export default worker;
