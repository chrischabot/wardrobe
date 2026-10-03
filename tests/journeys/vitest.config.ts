import { defineConfig } from "vitest/config";
import { garderobeWorkerTestPlugin } from "@garderobe/worker/testing/vitest-config";
import { journeyOutbound } from "./src/outbound.ts";

// The journeys drive the real Worker inside workerd (local D1, KV, R2, queue, conversation actor).
// Only outbound network calls are answered by labelled test doubles (src/outbound.ts); see README.md.
export default defineConfig(async () => ({
  plugins: [await garderobeWorkerTestPlugin({ miniflare: { outboundService: journeyOutbound } })],
  // Strict run: known product defects (src/defect.ts, DEFECTS.md) fail instead of being expected failures.
  define: { __JOURNEYS_STRICT__: JSON.stringify(process.env.JOURNEYS_STRICT === "1") },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
}));
