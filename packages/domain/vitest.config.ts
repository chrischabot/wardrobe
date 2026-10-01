import { defineConfig } from "vitest/config";
import { garderobeWorkersPlugin } from "./src/testing/vitest-config.ts";

export default defineConfig(async () => ({
  plugins: [await garderobeWorkersPlugin()],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
}));
