import { defineConfig } from "vitest/config";
import { garderobeWorkersPlugin } from "@garderobe/domain/testing/vitest-config";

/**
 * Tests run inside workerd against REAL local D1, a REAL local R2 bucket and a REAL local queue
 * (Miniflare's implementations of the production bindings). `test/worker.ts` is the queue consumer.
 * MEDIA_SIGNING_KEY below is a test-only value; deployments provide their own Worker secret.
 */
export default defineConfig(async () => ({
  plugins: [
    await garderobeWorkersPlugin({
      main: "./test/worker.ts",
      miniflare: {
        r2Buckets: ["MEDIA_BUCKET"],
        queueProducers: { MEDIA_QUEUE: { queueName: "garderobe-media-test" } },
        queueConsumers: { "garderobe-media-test": { maxBatchSize: 5, maxBatchTimeout: 0.05, maxRetries: 3, retryDelay: 0 } },
      },
      bindings: { MEDIA_SIGNING_KEY: "test-only-media-signing-key-not-a-deployment-secret" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
}));
