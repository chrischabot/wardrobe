#!/usr/bin/env node
/**
 * Local rehearsal of the development deployment's own tooling. NOT a deployment and NOT platform
 * evidence: every binding is Miniflare's local simulator, and the bindings that have no simulator (AI,
 * AI Search, Browser Rendering) are absent.
 *
 *   node deploy/rehearse.mjs            generate the configurations, migrate a fresh local database, start
 *                                       the operations and product Workers in one local session, seed
 *                                       through the real importer, write the import reference, run verify
 *   node deploy/rehearse.mjs --keep     leave the local session running afterwards (prints the origin)
 *
 * What it is for: proving that the generated configurations build, that every migration applies in
 * order, that the seed and its reconciliation work through the operations Worker, and that the
 * verification run's checks are sound, before any of it touches the platform. It also writes
 * `evidence/reference-import.json`, the local import the deployed database is compared with.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EVIDENCE_DIR, GENERATED_DIR, NAMES } from "./lib/config.mjs";
import { clientFor, targetFor } from "./lib/http.mjs";
import { seedUntilComplete, sleep, wrangler, wranglerBackground } from "./lib/run.mjs";
import { ensureState, updateState } from "./lib/state.mjs";
import { autoConfig, opsConfig, primaryConfig, writeConfig } from "./lib/wrangler-config.mjs";
import { runVerification } from "./verify.mjs";

const keep = process.argv.includes("--keep");
const target = targetFor("rehearsal");
const port = new URL(target.appOrigin).port;
const persist = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "garderobe-rehearsal-"));

const state = await ensureState();
const ids = { d1: "00000000-0000-4000-8000-000000000001", kv: `${NAMES.kv}-local`, searchNamespace: null };
const primary = writeConfig("rehearsal-primary.jsonc", primaryConfig({ ids, local: true, origins: { app: target.appOrigin, mcp: target.mcpOrigin }, access: { teamDomain: target.issuer, audience: target.audience } }));
const ops = writeConfig("rehearsal-ops.jsonc", opsConfig({ ids, publicJwk: state.issuer.publicJwk, opsTokenSha256: createHash("sha256").update(state.opsToken).digest("hex"), rehearsal: { app: target.appOrigin, mcp: target.mcpOrigin, issuer: target.issuer } }));
// Local secrets for both Workers of the session (same directory as the generated configurations; git-ignored).
writeFileSync(path.join(GENERATED_DIR, ".dev.vars"), Object.entries(state.secrets).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });

const migrated = wrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", persist, "-c", primary]);
console.log(`migrations applied to a fresh local database (${migrated.ms} ms)`);

if (await fetch(`${target.opsOrigin}/cdn-cgi/access/certs`).then(() => true, () => false)) {
  console.error(`something already answers on ${target.opsOrigin}; stop it or set GARDEROBE_REHEARSAL_PORT`);
  process.exit(2);
}
const log = [];
const child = wranglerBackground(["dev", "-c", ops, "-c", primary, "--port", port, "--ip", "127.0.0.1", "--persist-to", persist, "--show-interactive-dev-session=false"], { onLine: (line) => log.push(line) });
let exited = null;
child.on("exit", (code) => (exited = code ?? 1));
const stop = () => {
  if (exited === null) child.stopGroup();
  rmSync(path.join(GENERATED_DIR, ".dev.vars"), { force: true });
};

let code = 1;
try {
  for (let i = 0; i < 120 && exited === null; i++) {
    const up = await fetch(`${target.opsOrigin}/cdn-cgi/access/certs`).then((r) => r.ok, () => false);
    if (up) break;
    await sleep(500);
  }
  if (exited !== null) throw new Error(`the local session exited (${exited}):\n${log.slice(-25).join("\n")}`);
  const client = clientFor(target, state);

  const seeded = await seedUntilComplete(client, { invite: ["owner", "synthetic"] });
  updateState({ rehearsal: { invitations: seeded.result.invitations } });
  const reference = (await client.ops("/ops/reconcile")).json;
  const again = await seedUntilComplete(client);
  const afterReplay = (await client.ops("/ops/reconcile")).json;
  const idempotent = reference.inventoryDigest === afterReplay.inventoryDigest && reference.importCommands === afterReplay.importCommands;
  console.log(`seeded through the importer in ${seeded.calls.length} call(s): ${reference.garments} garments, ${reference.units} units; a second seed changed nothing: ${idempotent}`);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const { ms: _ms, linkedIdentities: _l, syntheticOwners: _s, ...importFacts } = reference;
  writeFileSync(
    path.join(EVIDENCE_DIR, "reference-import.json"),
    `${JSON.stringify({ what: "The owner's profile and inventory imported by the real importer into a fresh LOCAL database (Miniflare D1). The deployed development database must reconcile to exactly these values.", source: "node deploy/rehearse.mjs", secondSeedChangedNothing: idempotent, secondSeedReplayedReceipts: again.result.owner.replayed, import: importFacts }, null, 2)}\n`,
  );

  const report = await runVerification({ target, state: { ...state, invitations: seeded.result.invitations }, evidenceFile: "rehearsal-local.json" });

  // The three configurations the deploy command would upload (placeholder resource identifiers), built without uploading.
  const deployIds = { d1: "00000000-0000-4000-8000-000000000000", kv: "placeholder", searchNamespace: NAMES.searchNamespace };
  const builds = {};
  for (const [name, config] of [
    [NAMES.worker, primaryConfig({ ids: deployIds, access: { teamDomain: "https://placeholder.cloudflareaccess.com", audience: "placeholder" } })],
    [NAMES.autoWorker, autoConfig({ ids: deployIds })],
    [NAMES.opsWorker, opsConfig({ ids: deployIds, publicJwk: state.issuer.publicJwk, opsTokenSha256: "0".repeat(64) })],
  ]) {
    const built = wrangler(["deploy", "--dry-run", "-c", writeConfig(`build-check-${name}.jsonc`, config)], { allowFailure: true });
    builds[name] = { builds: built.ok, ms: built.ms, upload: /Total Upload: ([^\n]+)/.exec(built.stdout)?.[1]?.trim() ?? null, ...(built.ok ? {} : { error: built.stdout.trim().split("\n").slice(-6).join(" | ").slice(0, 600) }) };
    console.log(`${built.ok ? "builds" : "FAILS "}  ${name}  ${builds[name].upload ?? ""}`);
  }
  writeFileSync(path.join(EVIDENCE_DIR, "build-check.json"), `${JSON.stringify({ what: "`wrangler deploy --dry-run` of the three deployment configurations with placeholder resource identifiers: the bundles build; nothing was uploaded.", source: "node deploy/rehearse.mjs", builds }, null, 2)}\n`);
  code = report.summary.failed === 0 && idempotent && Object.values(builds).every((b) => b.builds) ? 0 : 1;
  if (keep) {
    console.log(`local session left running at ${target.appOrigin} (Ctrl-C to stop)`);
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.stopGroup());
    await new Promise((resolve) => child.on("exit", resolve));
  }
} catch (error) {
  console.error(String(error?.stack ?? error));
  console.error(`--- last lines of the local session ---\n${log.slice(-30).join("\n")}`);
} finally {
  stop();
  rmSync(persist, { recursive: true, force: true });
}
process.exit(code);
