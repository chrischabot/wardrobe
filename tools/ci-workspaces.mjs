#!/usr/bin/env node
// Lists every npm workspace of this repository that has a `test` script, as a GitHub Actions matrix.
// The backend workflow (.github/workflows/backend.yml) runs one job per entry, so a workspace added under
// packages/, apps/ or tests/ is tested on pull requests without editing the workflow.
//
// Usage: node tools/ci-workspaces.mjs            prints the matrix as JSON
//        node tools/ci-workspaces.mjs --output   also appends `matrix=<json>` to $GITHUB_OUTPUT
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

const include = [];
for (const pattern of readJson(path.join(root, "package.json")).workspaces ?? []) {
  // The root package.json uses only `<directory>/*` patterns; anything else is refused rather than guessed at.
  const match = /^([A-Za-z0-9_.-]+)\/\*$/.exec(pattern);
  if (!match) throw new Error(`unsupported workspace pattern '${pattern}': extend tools/ci-workspaces.mjs`);
  const group = path.join(root, match[1]);
  if (!existsSync(group)) continue;
  for (const entry of readdirSync(group, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const manifest = path.join(group, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    if (pkg.scripts?.test) include.push({ name: pkg.name, dir: `${match[1]}/${entry.name}` });
  }
}
if (include.length === 0) throw new Error("no workspace with a test script was found");

const matrix = JSON.stringify({ include });
console.log(matrix);
if (process.argv.includes("--output")) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("--output needs GITHUB_OUTPUT");
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
}
