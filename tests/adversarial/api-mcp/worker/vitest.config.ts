import { defineConfig } from "vitest/config";
import { garderobeWorkerTestPlugin } from "@garderobe/worker/testing/vitest-config";
import { adversarialOutbound, CONTROL_KEY } from "./src/outbound.ts";

// The attacks drive the real Worker inside workerd (local D1, KV, R2, queue, conversation actor).
// Only outbound network calls are answered by labelled test doubles (src/outbound.ts); see README.md.
export default defineConfig(async () => ({
  plugins: [await garderobeWorkerTestPlugin({ miniflare: { outboundService: adversarialOutbound } })],
  // Strict run: open product defects (src/harness.ts `defect`, DEFECTS.md) fail instead of being expected failures.
  define: {
    __ADVERSARIAL_STRICT__: JSON.stringify(process.env.ADVERSARIAL_STRICT === "1"),
    // The per-run key of the suite's control channel (src/outbound.ts), known to the tests only.
    __ADVERSARIAL_CONTROL_KEY__: JSON.stringify(CONTROL_KEY),
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
}));
