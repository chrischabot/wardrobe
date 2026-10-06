#!/usr/bin/env node
// SHARED FILE (owned by the domain adversarial thread).
//
// Runs the adversarial suite: first the shared configuration (vitest.config.ts: every `*.test.ts` below
// harness/, domain/, api-mcp/, assistant/ and daily-media/), then every directory below an area that
// has its own `vitest.config.ts`, each as its own vitest run with that directory as its root. The exit
// code is 0 only when every run exited 0.
//
//   node scripts/run.mjs                      everything
//   node scripts/run.mjs --area domain        one area (its shared-config files and its nested runs)
//   node scripts/run.mjs --area domain -t x   further arguments go to vitest unchanged
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AREAS = ["harness", "domain", "api-mcp", "assistant", "daily-media"];

const args = process.argv.slice(2);
let area = null;
const at = args.indexOf("--area");
if (at !== -1) {
  area = args[at + 1];
  args.splice(at, 2);
  if (!AREAS.includes(area)) {
    console.error(`unknown area '${area}'; one of: ${AREAS.join(", ")}`);
    process.exit(2);
  }
}

function nestedConfigDirs(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    if (existsSync(path.join(child, "vitest.config.ts"))) found.push(child);
    else nestedConfigDirs(child, found);
  }
  return found;
}

const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const runs = [{ label: area ? `shared configuration, ${area}/` : "shared configuration", cwd: root, argv: ["run", "--passWithNoTests", ...(area ? [`${area}/`] : []), ...args] }];
for (const name of area ? [area] : AREAS) {
  for (const dir of nestedConfigDirs(path.join(root, name)).sort()) runs.push({ label: path.relative(root, dir), cwd: dir, argv: ["run", "--passWithNoTests", ...args] });
}

const results = [];
for (const run of runs) {
  console.log(`\n=== adversarial: ${run.label} ===`);
  const done = spawnSync(process.execPath, [vitest, ...run.argv], { cwd: run.cwd, stdio: "inherit", env: process.env });
  results.push({ label: run.label, status: done.status ?? 1 });
}

console.log("\n=== adversarial: summary ===");
for (const r of results) console.log(`${r.status === 0 ? "ok    " : "FAILED"} ${r.label}${r.status === 0 ? "" : ` (exit ${r.status})`}`);
process.exit(results.every((r) => r.status === 0) ? 0 : 1);
