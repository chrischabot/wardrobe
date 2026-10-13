import { defineConfig } from "vitest/config";
import { garderobeWorkerTestPlugin } from "./src/testing/vitest-config.ts";

export default defineConfig(async () => ({
  plugins: [await garderobeWorkerTestPlugin()],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
}));
