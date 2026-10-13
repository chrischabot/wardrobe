import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { garderobeWorkerTestPlugin } from "@garderobe/worker/testing/vitest-config";
import { gatewayRoute } from "./src/node/gateway.mjs";
import { evalOutbound } from "./src/node/outbound.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// The candidate phase: the real Worker in workerd (local D1, KV, R2, queue, conversation actor), with the
// conversation actor's model sent to the application's AI Gateway through the Node-side relay
// (src/worker-entry.ts, src/node/outbound.ts). The gateway token stays in this Node process; the Worker
// only ever sees a placeholder.
export default defineConfig(async () => ({
  plugins: [
    await garderobeWorkerTestPlugin({
      main: path.join(here, "src/worker-entry.ts"),
      miniflare: { outboundService: evalOutbound },
      bindings: { EVAL_GATEWAY_ID: gatewayRoute().gatewayId, EVAL_DRIVER: process.env.EVAL_DRIVER ?? "conversation" },
    }),
  ],
  test: {
    include: ["src/candidate.test.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 10 * 60_000,
    fileParallelism: false,
  },
}));
