import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { garderobeWorkersPlugin } from "@garderobe/domain/testing/vitest-config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => ({
  plugins: [
    await garderobeWorkersPlugin({
      main: path.join(here, "test/worker.ts"),
      miniflare: {
        durableObjects: {
          ASSISTANT: { className: "TestAssistant", useSQLite: true },
        },
        // Photo intake tests upload through the REAL media package: local R2 and a local queue producer.
        r2Buckets: ["MEDIA_BUCKET"],
        queueProducers: { MEDIA_QUEUE: { queueName: "garderobe-assistant-test-media" } },
      },
      // Test-only signing value for media upload tokens; deployments provide their own Worker secret.
      bindings: { MEDIA_SIGNING_KEY: "assistant-test-only-media-signing-value-0001" },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
