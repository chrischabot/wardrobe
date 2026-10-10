#!/usr/bin/env node
/**
 * Run the simulation LOCALLY: for each seed, a fresh database seeded with the owner's real profile and
 * inventory, served by the simulation Worker under `wrangler dev`, driven by the simulator over HTTP.
 *
 *   node bin/local.mjs [--seeds 1,2,3,4,5] [--weeks 4] [--parallel 2] [--out results/local]
 *                      [--state <directory outside the repository>] [--port 8850] [--until-day N]
 *
 * `--out` writes one JSON result per seed and a Markdown summary. Without it nothing is written into
 * the repository. All local state (databases, keys, logs) goes under `--state`, by default a directory
 * in the system's temporary directory; it is removed and recreated for each seed.
 *
 * Exit code: 0 when every seed ran to its last step and no invariant check failed; 1 otherwise.
 */
import os from "node:os";
import path from "node:path";
import { startLocalTarget } from "../lib/local-target.mjs";
import { runSimulation, startInstantOf } from "../lib/runner.mjs";
import { buildPlan } from "../lib/timeline.mjs";
import { exitCodeOf, parseArgs, writeResults } from "./run.mjs";

const args = parseArgs(process.argv.slice(2));
const seeds = String(args.seeds ?? "1,2,3,4,5").split(",").map((s) => s.trim()).filter(Boolean);
const weeks = Number(args.weeks ?? 4);
const parallel = Math.max(1, Number(args.parallel ?? 2));
const stateRoot = path.resolve(String(args.state ?? path.join(os.tmpdir(), "garderobe-simulation")));
const portBase = Number(args.port ?? 8850);
const untilDay = args["until-day"] === undefined ? null : Number(args["until-day"]) - 1;

async function runSeed(seed, slot) {
  const plan = buildPlan({ seed, weeks });
  const stateDir = path.join(stateRoot, `seed-${String(seed).replace(/[^a-z0-9_-]/gi, "_")}`);
  const { target, stop } = await startLocalTarget({ stateDir, port: portBase + slot, startMs: startInstantOf(plan), label: "local simulation Worker" });
  try {
    return await runSimulation({ targetDescription: target, seed, weeks, untilDay, log: (line) => console.log(line) });
  } finally {
    await stop();
  }
}

const results = new Array(seeds.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(parallel, seeds.length) }, async (_unused, slot) => {
    for (;;) {
      const index = next++;
      if (index >= seeds.length) return;
      try {
        results[index] = await runSeed(seeds[index], slot);
      } catch (error) {
        console.error(`seed ${seeds[index]}: could not run: ${String(error?.stack ?? error)}`);
        process.exitCode = 1;
      }
    }
  }),
);

const done = results.filter(Boolean);
if (args.out && done.length > 0) {
  writeResults(path.resolve(String(args.out)), done, {
    title: "Simulation results: local simulation Worker",
    command: `node bin/local.mjs ${process.argv.slice(2).join(" ")}`.trim(),
    notes: [
      "Target: the product Worker inside the simulation Worker entry (`worker/entry.ts`) under `wrangler dev`, with local D1, KV, R2, queue and Durable Object, seeded with the owner's real profile and inventory by the product's importer.",
      "Stand-ins, at external boundaries only, all labelled: the settable clock, the scripted Open-Meteo forecast, the in-memory Google Calendar and OAuth, and a locally signed sign-in in place of Cloudflare Access. No model is reachable locally, so `garderobe_ask` and `garderobe_research` return durable runs that end in a reported failure and every board comes from the deterministic composer. Nothing in this run touched a deployment.",
    ],
  });
}
for (const r of done) console.log(`seed ${r.seed}: ${r.completed ? "completed" : "NOT completed"}, ${r.steps.run}/${r.steps.planned} steps, ${r.invariantChecks.passed} checks passed, ${r.invariantChecks.failed} failed, ${r.steps.errors.length} step errors, plan ${r.timeline.planDigest}, outcome ${r.outcomeDigest}`);
process.exit(done.length === seeds.length ? exitCodeOf(done) : 1);
