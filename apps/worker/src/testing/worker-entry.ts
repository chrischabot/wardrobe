/**
 * Test entry: the real Worker (`src/index.ts`: same fetch, scheduled and queue handlers, same router,
 * same OAuth provider) with ONE difference: the conversation actor uses the assistant workstream's
 * labelled FAKE MODEL instead of AI Gateway, because no model is reachable from a local test run.
 */
import "./clock.ts"; // first: installs the shifted clock when a whole-suite run asks for one
import { testClockOffsetMs } from "./clock.ts";
import { TestAssistant } from "@garderobe/assistant/testing";
import type { Env } from "../env.ts";
import worker from "../index.ts";
import { bindEnv } from "../lanes/index.ts";

/**
 * Durable Object alarms are kept by the runtime on the real clock. Under a shifted test clock (clock.ts)
 * the actor computes alarm times from the shifted `Date`, so they are translated back here; otherwise
 * every alarm would be due most of a day late and no turn would ever run.
 */
function alignAlarms(ctx: DurableObjectState): void {
  const offset = testClockOffsetMs();
  if (!offset) return;
  const storage = ctx.storage;
  const setAlarm = storage.setAlarm.bind(storage);
  const getAlarm = storage.getAlarm.bind(storage);
  storage.setAlarm = ((time: number | Date, options?: DurableObjectSetAlarmOptions) => setAlarm((time instanceof Date ? time.getTime() : time) - offset, options)) as typeof storage.setAlarm;
  storage.getAlarm = (async (options?: DurableObjectGetAlarmOptions) => {
    const at = await getAlarm(options);
    return at === null ? null : at + offset;
  }) as typeof storage.getAlarm;
}

export class GarderobeAssistant extends TestAssistant {
  constructor(ctx: DurableObjectState, env: Env) {
    alignAlarms(ctx);
    super(ctx, env);
    bindEnv(env);
  }
}

export default worker;
