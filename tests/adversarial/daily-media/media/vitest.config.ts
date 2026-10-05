import { defineConfig } from "vitest/config";
import { garderobeWorkerTestPlugin } from "@garderobe/worker/testing/vitest-config";

/*
 * Media abuse cases, run on their own:
 *
 *   npx vitest run --config tests/adversarial/daily-media/media/vitest.config.ts      (from the repository root)
 *
 * The cases drive the REAL Worker inside workerd (same fetch, queue and scheduled handlers as the deployed
 * Worker) with Miniflare's local D1, R2 buckets, KV and queue. Stand-ins, at external boundaries only:
 * test-signed sign-in assertions in place of Cloudflare Access, and the Worker test plugin's outbound
 * fixture (no real network). No Images binding is configured, so thumbnails are served as stored.
 * The files import nothing from the other adversarial directories, so a shared adversarial configuration
 * can include them unchanged.
 */
export default defineConfig(async () => ({
  root: import.meta.dirname,
  plugins: [await garderobeWorkerTestPlugin()],
  test: {
    include: ["*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
}));
