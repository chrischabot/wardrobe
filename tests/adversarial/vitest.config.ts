import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { garderobeWorkerTestPlugin } from "@garderobe/worker/testing/vitest-config";
import { journeyOutbound } from "../journeys/src/outbound.ts";

// SHARED FILE (owned by the domain adversarial thread). Area threads add files under their own
// subdirectory only; a `*.test.ts` file placed there is picked up without any edit here.
//
// The suite drives the real Worker inside workerd: local D1 with every migration, KV, R2, the queue
// and the conversation actor. Only outbound network calls are answered by the labelled test doubles
// the journey suite already documents (tests/journeys/src/outbound.ts): scripted weather, an in-memory
// Calendar, and the Worker package's own fixtures. See README.md.
//
// A directory below an area that has its OWN `vitest.config.ts` (because it needs different outbound
// doubles, for example) is a separate vitest run: scripts/run.mjs runs it with that directory as its
// root, and this configuration leaves its files alone.
const here = path.dirname(fileURLToPath(import.meta.url));
const AREAS = ["harness", "domain", "api-mcp", "assistant", "daily-media"];

function nestedConfigDirs(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    if (existsSync(path.join(child, "vitest.config.ts"))) found.push(path.relative(here, child).split(path.sep).join("/"));
    else nestedConfigDirs(child, found);
  }
  return found;
}

export default defineConfig(async () => ({
  plugins: [await garderobeWorkerTestPlugin({ miniflare: { outboundService: journeyOutbound } })],
  // Strict run: known open defects (harness/defect.ts, <area>/DEFECTS.md) fail instead of being expected failures.
  define: { __ADVERSARIAL_STRICT__: JSON.stringify(process.env.ADVERSARIAL_STRICT === "1") },
  test: {
    include: AREAS.map((area) => `${area}/**/*.test.ts`),
    exclude: ["**/node_modules/**", ...AREAS.flatMap((area) => nestedConfigDirs(path.join(here, area))).map((dir) => `${dir}/**`)],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
}));
