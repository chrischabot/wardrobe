/**
 * A LOCAL simulation target: one fresh database, seeded with the owner's real profile and inventory,
 * served by the simulation Worker (worker/entry.ts) under `wrangler dev` on its own port.
 *
 * All state (generated wrangler configuration, local keys, D1/KV/R2 files, logs) lives OUTSIDE the
 * repository, in the directory given as `stateDir`. Nothing here uses a Cloudflare credential: every
 * binding is Miniflare's local simulator.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair } from "jose";

export const SIM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(SIM_DIR, "../..");
const BIN = path.join(REPO_ROOT, "node_modules", ".bin");
const GOOGLE = "https://google.simulation.invalid";

const secret = (bytes) => randomBytes(bytes).toString("base64");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(binary, args, options = {}) {
  return execFileSync(path.join(BIN, binary), args, { cwd: options.cwd ?? REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", ...(options.env ?? {}) } });
}

/**
 * Create and start a local target. `startMs` is the simulated instant the ledger begins at (the import
 * is recorded then). Returns the target description the simulator takes, and `stop()`.
 */
export async function startLocalTarget({ stateDir, port, startMs, label = "local" }) {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
  const kid = `sim-${randomBytes(4).toString("hex")}`;
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: "RS256" };
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const issuer = "https://garderobe-simulation.cloudflareaccess.com";
  const audience = "garderobe-simulation-audience";
  const controlToken = randomBytes(24).toString("hex");
  const stateSigningKey = secret(48);
  const appOrigin = `http://localhost:${port}`;
  const mcpOrigin = `http://127.0.0.1:${port}`;

  // The binding names are the product Worker's (apps/worker/wrangler.jsonc); the values are local.
  const config = {
    name: "garderobe-simulation",
    main: path.join(SIM_DIR, "worker/entry.ts"),
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    workers_dev: false,
    d1_databases: [{ binding: "DB", database_name: "garderobe-simulation", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: path.join(REPO_ROOT, "migrations") }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: "garderobe-simulation-oauth" }],
    r2_buckets: [
      { binding: "MEDIA_BUCKET", bucket_name: "garderobe-simulation-media" },
      { binding: "EXPORT_BUCKET", bucket_name: "garderobe-simulation-exports" },
    ],
    queues: { producers: [{ binding: "MEDIA_QUEUE", queue: "garderobe-simulation-media" }], consumers: [{ queue: "garderobe-simulation-media", max_batch_size: 5, max_batch_timeout: 2, max_retries: 3 }] },
    durable_objects: { bindings: [{ name: "ASSISTANT", class_name: "GarderobeAssistant" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["GarderobeAssistant"] }],
    vars: {
      ENVIRONMENT: "local",
      APP_ORIGIN: appOrigin,
      MCP_ORIGIN: mcpOrigin,
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUD: audience,
      ACCESS_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
      AI_GATEWAY_ID: "garderobe-simulation",
      // Local-only values generated for this run; never deployment secrets.
      CREDENTIAL_KEY: secret(32),
      STATE_SIGNING_KEY: stateSigningKey,
      MEDIA_SIGNING_KEY: secret(48),
      SIM_CONTROL_TOKEN: controlToken,
      GOOGLE_OAUTH_CLIENT_ID: "simulation-google-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "simulation-google-client-secret",
      GOOGLE_OAUTH_AUTHORIZE_URL: `${GOOGLE}/authorize`,
      GOOGLE_OAUTH_TOKEN_URL: `${GOOGLE}/token`,
      GOOGLE_OAUTH_REVOKE_URL: `${GOOGLE}/revoke`,
      GOOGLE_API_BASE_URL: GOOGLE,
    },
  };
  const configPath = path.join(stateDir, "wrangler.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  const persistTo = path.join(stateDir, "state");

  run("wrangler", ["d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", persistTo], { cwd: stateDir });

  const bundle = path.join(stateDir, "seed.mjs");
  run("esbuild", [path.join(SIM_DIR, "worker/seed.ts"), "--bundle", "--platform=node", "--format=esm", "--target=node22", "--external:wrangler", "--log-level=warning", `--outfile=${bundle}`]);
  // The bundle lives outside the repository; it finds `wrangler` (kept external) through this link.
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(stateDir, "node_modules"), "dir");
  const seedOutput = execFileSync(process.execPath, ["--no-warnings", bundle], {
    cwd: stateDir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, SIM_NOW_MS: String(startMs), SIM_WRANGLER_CONFIG: configPath, SIM_PERSIST_PATH: path.join(persistTo, "v3"), SIM_REPO_ROOT: REPO_ROOT, STATE_SIGNING_KEY: stateSigningKey },
  });
  const seeded = JSON.parse(seedOutput.trim().split("\n").at(-1));

  const log = createWriteStream(path.join(stateDir, "worker.log"));
  const child = spawn(path.join(BIN, "wrangler"), ["dev", "--config", configPath, "--persist-to", persistTo, "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(port + 1000), "--show-interactive-dev-session=false"], {
    cwd: stateDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exited = null;
  child.on("exit", (code) => (exited = code ?? -1));
  const stop = async () => {
    if (exited === null) {
      child.kill("SIGTERM");
      for (let i = 0; i < 50 && exited === null; i++) await sleep(100);
      if (exited === null) child.kill("SIGKILL");
    }
    log.end();
  };

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (exited !== null) throw new Error(`the simulation Worker exited with code ${exited}; see ${path.join(stateDir, "worker.log")}`);
    try {
      const response = await fetch(`${mcpOrigin}/__sim/state`, { headers: { "x-sim-control": controlToken } });
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`the simulation Worker did not start within two minutes; see ${path.join(stateDir, "worker.log")}`);
    }
    await sleep(250);
  }

  const target = {
    label,
    kind: "local-simulation-worker",
    appOrigin,
    mcpOrigin,
    signIn: { kind: "local-assertion", issuer, audience, privateJwk },
    owners: {
      primary: { subject: `sim-owner-${randomBytes(6).toString("hex")}`, email: "owner@simulation.invalid", invitationCode: seeded.primary.invitationCode, importedGarments: seeded.primary.garments },
      second: { subject: `sim-second-${randomBytes(6).toString("hex")}`, email: "second@simulation.invalid", invitationCode: seeded.second.invitationCode },
    },
    doors: { kind: "simulation-worker", controlOrigin: mcpOrigin, controlToken, clock: true, weather: true, calendar: true, scheduled: true },
    startMs,
  };
  writeFileSync(path.join(stateDir, "target.json"), JSON.stringify(target, null, 2), { mode: 0o600 });
  return { target, stop, stateDir };
}
