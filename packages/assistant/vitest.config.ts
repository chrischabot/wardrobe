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
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
