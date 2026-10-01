import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { garderobeWorkerTestPlugin } from "@garderobe/worker/testing/vitest-config";

// Records the iOS client's fixture cassettes from the REAL Worker (workerd, local D1 with every
// migration, the real router and command service) holding the owner's REAL profile and inventory.
// Run from wardrobe/:  bash ios/Tools/fixtures/record.sh
export default defineConfig(async () => ({
  root: path.dirname(fileURLToPath(import.meta.url)),
  plugins: [await garderobeWorkerTestPlugin()],
  test: {
    include: ["*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
}));
