/**
 * Node-side Vitest configuration helper shared by every workstream.
 *
 * It runs test files inside workerd (the Workers runtime) through
 * `@cloudflare/vitest-pool-workers` with a real local D1 database bound as
 * `DB`, and hands the repository's migrations to the runtime as the
 * `TEST_MIGRATIONS` binding so `@garderobe/domain/testing` can apply them.
 *
 * Usage in a workstream's `vitest.config.ts`:
 *
 *   import { defineConfig } from "vitest/config";
 *   import { garderobeWorkersPlugin } from "@garderobe/domain/testing/vitest-config";
 *   export default defineConfig(async () => ({
 *     plugins: [await garderobeWorkersPlugin()],
 *     test: { include: ["test/**\/*.test.ts"] },
 *   }));
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const MIGRATIONS_DIR = path.join(REPOSITORY_ROOT, "migrations");

/** Compatibility date pinned for local tests; deployment pins its own in wrangler configuration. */
export const TEST_COMPATIBILITY_DATE = "2026-08-15";

export interface GarderobeWorkersPluginOptions {
  /** Extra Miniflare worker options (additional bindings, Durable Objects, queues, R2 buckets...). */
  miniflare?: Record<string, unknown>;
  /** Optional worker entry module, for workstreams that test a fetch handler. */
  main?: string;
  /** Extra plain bindings visible as `env.*` in tests. */
  bindings?: Record<string, unknown>;
}

/**
 * The supplied owner documents, read from requirements/ exactly as committed. They are handed to the
 * Workers runtime as text bindings (workerd tests have no filesystem); tests verify their SHA-256.
 */
export function ownerDocumentBindings(): Record<string, unknown> {
  const read = (rel: string) => readFileSync(path.join(REPOSITORY_ROOT, rel), "utf8");
  const optional = (rel: string) => (existsSync(path.join(REPOSITORY_ROOT, rel)) ? read(rel) : "");
  return {
    OWNER_PROFILE_MD: read("requirements/chris-wardrobe-profile.md"),
    OWNER_INVENTORY_CSV: read("requirements/wardrobe_inventory_clean.csv"),
    SUPPLIED_SHA256SUMS: read("requirements/SHA256SUMS"),
    IMPORT_REPORT_MD: optional("data/import/inventory-import-report.md"),
    REQUIREMENT_CHECKLIST_MD: optional("requirements/CHECKLIST.md"),
  };
}

export async function garderobeWorkersPlugin(options: GarderobeWorkersPluginOptions = {}) {
  const migrations = await readD1Migrations(MIGRATIONS_DIR);
  const extra = options.miniflare ?? {};
  return cloudflareTest({
    ...(options.main ? { main: options.main } : {}),
    miniflare: {
      compatibilityDate: TEST_COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      ...extra,
      bindings: {
        TEST_MIGRATIONS: migrations,
        ...ownerDocumentBindings(),
        ...((extra as { bindings?: Record<string, unknown> }).bindings ?? {}),
        ...(options.bindings ?? {}),
      },
    },
  });
}
