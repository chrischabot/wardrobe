#!/usr/bin/env node
/**
 * Local run mode.
 *
 *   npm run dev              set up (first time) and start the Worker at http://localhost:8787
 *   npm run dev -- setup     only set up: local keys, .dev.vars, migrations, seed with the real owner data
 *   npm run dev -- reset     delete the local state (database, buckets, keys) and set up again
 *   npm run dev -- empty-owner   (Worker stopped) add an empty test owner and print its invitation code
 *
 * App/API origin: http://localhost:8787    MCP origin: http://127.0.0.1:8787/mcp (same process; the two
 * hostnames are kept apart exactly as in a deployment). Sign in locally with a token from
 * `npm run dev:token`. Everything stays on this machine: Miniflare simulates D1, KV, R2, the queue and
 * the Durable Object. No model is reachable locally (there is no AI binding), so conversation turns end
 * in a reported failure; every other surface works.
 */
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { DEV_VARS, STATE_DIR, WORKER_DIR, ensureLocalSecrets, readState, writeState } from "./lib/local.mjs";

const command = process.argv[2] ?? "start";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args, env = {}) => execFileSync(npx, args, { cwd: WORKER_DIR, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env }, encoding: "utf8" });

function migrate() {
  run(["wrangler", "d1", "migrations", "apply", "DB", "--local"], { CI: "1" });
  console.log("migrations applied to the local database");
}

/** Bundle the seed script (it shares the Worker's TypeScript sources) and run it; returns its last JSON line. */
function runSeed(state, env = {}) {
  const bundle = path.join(STATE_DIR, "seed-local.mjs");
  run(["esbuild", path.join(WORKER_DIR, "scripts/seed-local.ts"), "--bundle", "--platform=node", "--format=esm", "--target=node22", "--external:wrangler", "--log-level=warning", `--outfile=${bundle}`]);
  const output = execFileSync(process.execPath, ["--no-warnings", bundle], {
    cwd: WORKER_DIR,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    env: { ...process.env, STATE_SIGNING_KEY: state.secrets.STATE_SIGNING_KEY, ...env },
  });
  return JSON.parse(output.trim().split("\n").at(-1));
}

async function setup() {
  const state = await ensureLocalSecrets();
  console.log("local keys and .dev.vars ready");
  migrate();
  const seed = runSeed(state);
  writeState({ ...readState(), userId: seed.userId, ...(seed.invitationCode ? { invitationCode: seed.invitationCode } : {}) });
  console.log(`owner ${seed.userId}: ${seed.garments} garments from the real inventory${seed.importedNow ? " (imported now)" : ""}${seed.alreadyClaimed ? "" : "; the local sign-in claims the account on first use"}`);
}

if (command === "reset") {
  rmSync(path.join(WORKER_DIR, ".wrangler"), { recursive: true, force: true });
  rmSync(DEV_VARS, { force: true });
  await setup();
} else if (command === "setup") {
  await setup();
} else if (command === "empty-owner") {
  // An empty, labelled test owner with a one-time invitation (the target of scripts/restore-drill.mjs).
  // Run it while the Worker is stopped: it writes to the same local database file.
  if (!readState()?.userId) await setup();
  const state = await ensureLocalSecrets();
  migrate();
  const created = runSeed(state, { SEED_MODE: "empty-owner" });
  console.log(`empty owner ${created.userId}; invitation code: ${created.invitationCode}`);
} else if (command === "start") {
  if (!readState()?.userId) await setup();
  else {
    await ensureLocalSecrets();
    // Migrations added since the last run are applied on every start, so an existing local database never lags the code.
    migrate();
  }
  console.log("starting the Worker: app http://localhost:8787  mcp http://127.0.0.1:8787/mcp");
  const child = spawn(npx, ["wrangler", "dev", "--port", process.env.PORT ?? "8787", "--ip", "0.0.0.0", "--show-interactive-dev-session=false"], { cwd: WORKER_DIR, stdio: "inherit", env: { ...process.env, CI: "1" } });
  child.on("exit", (code) => process.exit(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} else {
  console.error(`unknown command '${command}': use start, setup, reset or empty-owner`);
  process.exit(2);
}
