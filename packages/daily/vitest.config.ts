import { defineConfig } from "vitest/config";
import { garderobeWorkersPlugin } from "@garderobe/domain/testing/vitest-config";

export default defineConfig(async () => ({
  plugins: [await garderobeWorkersPlugin()],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
