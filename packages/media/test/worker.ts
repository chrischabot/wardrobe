/**
 * Test Worker entry: the REAL queue consumer. Messages sent to the local queue binding are delivered to
 * `queue()` by the local runtime, which runs the media job runner exactly as the deployed Worker does.
 */
import { CommandService, createFoundationRegistry } from "@garderobe/domain";
import { createMediaRuntime, depsFromBindings, handleMediaQueue, registerMedia, type MediaBindings } from "../src/index.ts";
import { getQueueRuntime } from "../src/testing/queue-runtime.ts";

/** How many batches the local queue delivered to this consumer (read by tests to prove the queue path ran). */
export const delivered = { batches: 0, messages: 0 };

export default {
  async fetch(): Promise<Response> {
    return new Response("garderobe media test worker");
  },
  async queue(batch: MessageBatch<unknown>, env: MediaBindings): Promise<void> {
    delivered.batches++;
    delivered.messages += batch.messages.length;
    let rt = getQueueRuntime();
    if (!rt) {
      const registry = createFoundationRegistry();
      const deps = depsFromBindings(env);
      registerMedia(registry, deps);
      rt = createMediaRuntime({ db: env.DB, service: new CommandService({ db: env.DB, registry }), deps });
    }
    await handleMediaQueue(rt, batch);
  },
};
