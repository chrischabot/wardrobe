#!/usr/bin/env node
/**
 * Run the simulation against ANY target described by a JSON file:
 *
 *   node bin/run.mjs --target <target.json> [--seeds 1,2,3,4,5] [--weeks 4] [--out <directory>]
 *
 * The target file names the app origin, the MCP origin, how the script signs in as the owner on the app
 * hostname, the two owners, and which test doors the target has (see README.md, "Targets"). For a local
 * target use `bin/local.mjs`, which creates one per seed and calls the same runner.
 *
 * Exit code: 0 when every seed ran to its last step and no invariant check failed; 1 otherwise.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { summarize } from "../lib/report.mjs";
import { runSimulation } from "../lib/runner.mjs";

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument '${arg}'`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[arg.slice(2)] = true;
    else {
      args[arg.slice(2)] = next;
      i++;
    }
  }
  return args;
}

/** The committed form of a result: everything except the per-command trace, which goes to a separate file. */
export function writeResults(outDir, results, { title, command, notes }) {
  mkdirSync(outDir, { recursive: true });
  for (const result of results) {
    const { commandLog, ...committed } = result;
    writeFileSync(path.join(outDir, `seed-${result.seed}.json`), `${JSON.stringify(committed, null, 2)}\n`);
    writeFileSync(path.join(outDir, `seed-${result.seed}.commands.json`), `${JSON.stringify(commandLog, null, 1)}\n`);
  }
  writeFileSync(path.join(outDir, "README.md"), `${summarize(results, { title, command, notes })}\n`);
}

export const exitCodeOf = (results) => (results.every((r) => r.completed && r.invariantChecks.failed === 0 && r.steps.errors.length === 0) ? 0 : 1);

if (path.basename(process.argv[1] ?? "") === "run.mjs") {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    console.error("usage: node bin/run.mjs --target <target.json> [--seeds 1,2,3,4,5] [--weeks 4] [--out <directory>]");
    process.exit(2);
  }
  const targetDescription = JSON.parse(readFileSync(args.target, "utf8"));
  const seeds = String(args.seeds ?? "1,2,3,4,5").split(",").map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (const seed of seeds) results.push(await runSimulation({ targetDescription, seed, weeks: Number(args.weeks ?? 4), log: (line) => console.log(line) }));
  if (args.out) writeResults(path.resolve(String(args.out)), results, { title: `Simulation results: ${targetDescription.label}`, command: `node bin/run.mjs ${process.argv.slice(2).join(" ")}`, notes: [] });
  for (const r of results) console.log(`seed ${r.seed}: ${r.completed ? "completed" : "NOT completed"}, ${r.steps.run}/${r.steps.planned} steps, ${r.invariantChecks.passed} checks passed, ${r.invariantChecks.failed} failed, ${r.steps.errors.length} step errors`);
  process.exit(exitCodeOf(results));
}
