#!/usr/bin/env node
/**
 * One command: provision (idempotently), migrate, bind secrets, deploy and seed the DEVELOPMENT
 * environment of the fresh Garderobe build.
 *
 *   node deploy/deploy.mjs --commit <sha>     do it (the commit is recorded in the evidence)
 *   node deploy/deploy.mjs --dry-run          read the account, list what would be created, build the
 *                                             three Workers without uploading; writes nothing remote
 *   node deploy/deploy.mjs --preflight        only report which required variables are present (names)
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (project secrets). They are
 * used by this tooling and by Wrangler to manage resources; they are never printed, never written to a
 * file, never bound to a Worker and never used as an application login. Optional: GARDEROBE_OWNER_EMAIL,
 * the one identity the Access application admits at the person's door.
 *
 * Only names under `garderobe-rebuild-dev` can be created or changed (lib/config.mjs); anything else on
 * the account is listed in the evidence as found and left.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_DIR, GATEWAY_ID, HOSTS, MANAGEMENT_ENV, MIGRATIONS_DIR, NAMES, assertDevEnvironment } from "./lib/config.mjs";
import { MissingCredentialError, credentials, journal, presence } from "./lib/cf.mjs";
import { clientFor, targetFor } from "./lib/http.mjs";
import { deployWorkers } from "./lib/management.mjs";
import { inventory, provision } from "./lib/provision.mjs";
import { seedUntilComplete, sleep, wrangler } from "./lib/run.mjs";
import { ensureState, updateState } from "./lib/state.mjs";
import { autoConfig, opsConfig, primaryConfig, writeConfig } from "./lib/wrangler-config.mjs";
import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
assertDevEnvironment(argv);
const dryRun = argv.includes("--dry-run");
const commit = argv.includes("--commit") ? argv[argv.indexOf("--commit") + 1] : (process.env.GARDEROBE_COMMIT ?? null);
const evidence = (file, body) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, file), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`-> deploy/evidence/${file}`);
};

const present = presence(MANAGEMENT_ENV);
if (argv.includes("--preflight") || !Object.values(present).every(Boolean)) {
  console.log(Object.entries(present).map(([name, ok]) => `${ok ? "present" : "ABSENT "}  ${name}`).join("\n"));
  if (!Object.values(present).every(Boolean)) {
    evidence("preflight.json", { checkedAt: new Date().toISOString(), requiredEnvironmentVariables: present, result: "blocked", reason: new MissingCredentialError(Object.keys(present).filter((k) => !present[k])).message, deployed: false });
    console.error("nothing was provisioned or deployed.");
    process.exit(2);
  }
  if (argv.includes("--preflight")) process.exit(0);
}
if (!dryRun && !commit) {
  console.error("give the commit being deployed: --commit <sha> (this checkout has no git metadata to read it from)");
  process.exit(2);
}
credentials();

const started = Date.now();
const found = await inventory();
const state = await ensureState();
const provisioned = await provision({ dryRun, ownerEmail: process.env.GARDEROBE_OWNER_EMAIL ?? null });
for (const step of provisioned.steps) console.log(`${step.action.padEnd(13)} ${step.kind} ${step.name}`);
for (const note of provisioned.notes) console.log(`note: ${note}`);

const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const resources = {
  workers: [NAMES.worker, NAMES.autoWorker, NAMES.opsWorker],
  hostnames: HOSTS,
  d1: { name: NAMES.d1, id: provisioned.ids.d1 },
  kv: { name: NAMES.kv, id: provisioned.ids.kv },
  r2: provisioned.buckets,
  queues: provisioned.ids.queues,
  aiSearchNamespace: provisioned.ids.searchNamespace,
  workflow: NAMES.workflow,
  durableObject: { class: "GarderobeAssistant", worker: NAMES.worker, storage: "sqlite" },
  aiGateway: provisioned.gateway,
  access: { configured: provisioned.access.configured, teamDomain: provisioned.access.configured ? provisioned.access.teamDomain : null, applicationId: provisioned.access.appId ?? null },
};
const foundAndLeft = Object.fromEntries(found.map((s) => [s.label, s.ok ? s.others : `unreadable: ${s.error}`]));

if (dryRun) {
  const ids = { d1: provisioned.ids.d1 ?? "00000000-0000-4000-8000-000000000000", kv: provisioned.ids.kv ?? "dry-run", searchNamespace: provisioned.ids.searchNamespace };
  const builds = {};
  for (const [name, config] of [[NAMES.worker, primaryConfig({ ids, access: provisioned.access })], [NAMES.opsWorker, opsConfig({ ids, publicJwk: state.issuer.publicJwk, opsTokenSha256: "0".repeat(64) })], [NAMES.autoWorker, autoConfig({ ids })]]) {
    const r = wrangler(["deploy", "--dry-run", "-c", writeConfig(`dry-run-${name}.jsonc`, config)], { allowFailure: true });
    builds[name] = { builds: r.ok, ms: r.ms, uploadSize: /Total Upload: ([^\n]+)/.exec(r.stdout)?.[1]?.trim() ?? null };
    console.log(`${r.ok ? "builds" : "FAILS "}        worker ${name} ${builds[name].uploadSize ?? ""}`);
  }
  evidence("deploy-dry-run.json", { mode: "dry run: nothing remote was written", at: new Date().toISOString(), wouldCreateOrKeep: provisioned.steps, notes: provisioned.notes, migrations: migrationFiles, builds, writesAttempted: journal, foundAndLeft });
  process.exit(Object.values(builds).every((b) => b.builds) ? 0 : 1);
}

// Migrations: every file in the repository's migrations directory, in order, through Wrangler's own migration table.
const primaryFile = writeConfig("primary.jsonc", primaryConfig({ ids: provisioned.ids, access: provisioned.access }));
const migrated = wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", primaryFile]);
console.log(`migrations applied (${migrationFiles.length} files in the repository, ${migrated.ms} ms)`);

const workers = deployWorkers(state, { ids: provisioned.ids, access: provisioned.access });
for (const [name, w] of Object.entries(workers)) console.log(`deployed      worker ${name} version ${w.versionId}`);
updateState({ deployed: { commit, at: new Date().toISOString(), resources: { queues: provisioned.ids.queues }, inputs: { ids: provisioned.ids, access: provisioned.access } } });

// Seed through the operations Worker (the real importer), then compare with the local import.
const client = clientFor(targetFor("deployed"), state);
for (let i = 0; i < 30; i++) {
  if (await fetch(`${client.target.opsOrigin}/cdn-cgi/access/certs`).then((r) => r.ok, () => false)) break;
  await sleep(4000);
}
const needInvite = ["owner", "synthetic"].filter((who) => !state.invitations?.[who]);
const seeded = await seedUntilComplete(client, { invite: needInvite });
if (Object.keys(seeded.result.invitations ?? {}).length) updateState({ invitations: { ...(state.invitations ?? {}), ...seeded.result.invitations } });
const { ms: _ms, linkedIdentities, syntheticOwners, ...imported } = (await client.ops("/ops/reconcile")).json;
const referenceFile = path.join(EVIDENCE_DIR, "reference-import.json");
const reference = existsSync(referenceFile) ? JSON.parse(readFileSync(referenceFile, "utf8")).import : null;
const differences = reference ? Object.keys(reference).filter((k) => reference[k] !== imported[k]) : null;
console.log(reference ? (differences.length ? `RECONCILIATION DIFFERS from the local import in: ${differences.join(", ")}` : `reconciliation matches the local import (${imported.garments} garments, ${imported.units} units)`) : "no local reference import to compare with; run `node deploy/rehearse.mjs` first");

evidence("deploy.json", {
  environment: "development",
  commit,
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date().toISOString(),
  endpoints: { app: `https://${HOSTS.app}`, mcp: `https://${HOSTS.mcp}/mcp`, automationApp: `https://${HOSTS.autoApp}`, automationMcp: `https://${HOSTS.autoMcp}/mcp` },
  resources,
  provisioning: provisioned.steps,
  notes: provisioned.notes,
  migrations: { repository: migrationFiles, applyMs: migrated.ms },
  workers,
  secrets: { boundToWorkers: Object.keys(state.secrets), managementCredentialsBound: false, source: "generated by the deploy tooling; kept in its git-ignored local state" },
  seed: { calls: seeded.calls.length, callTimingsMs: seeded.calls.map((c) => c.ms), receipts: seeded.result.owner.receipts, replayedReceipts: seeded.result.owner.replayed, conflictsLeftUnresolved: seeded.result.owner.conflicts, syntheticOwners, linkedIdentities },
  reconciliation: { imported, reference, matchesLocalImport: reference ? differences.length === 0 : null, differences },
  managementWrites: journal.map(({ at, method, kind, target, status, ms }) => ({ at, method, kind, target, status, ms })),
  foundAndLeft,
  gatewayDeclaredNotCreated: GATEWAY_ID,
});
process.exit(reference && differences.length === 0 ? 0 : 1);
