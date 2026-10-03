#!/usr/bin/env node
/**
 * Remove the development deployment of the fresh Garderobe build.
 *
 *   node deploy/teardown.mjs                                   dry run (the default): list exactly what would be removed
 *   node deploy/teardown.mjs --confirm garderobe-rebuild-dev   remove it
 *
 * Only resources this tooling creates are ever considered: they are found by their exact development
 * names (lib/config.mjs), and every deletion passes the same guard as creation. The owner's AI Gateway,
 * the DNS zone, the Access organization and everything else on the account are never touched. A bucket
 * that still holds objects is not removed (R2 refuses it); its object count is reported instead.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_DIR, GATEWAY_ID, GuardError, HOSTS, MANAGEMENT_ENV, NAMES, PREFIX, assertDevEnvironment, assertDevName } from "./lib/config.mjs";
import { accountPath as A, journal, presence, write } from "./lib/cf.mjs";
import { findOurs, isOurs } from "./lib/provision.mjs";

const argv = process.argv.slice(2);
assertDevEnvironment(argv);
const confirmed = argv.includes("--confirm") ? argv[argv.indexOf("--confirm") + 1] : null;
if (confirmed !== null && confirmed !== PREFIX) throw new GuardError(`--confirm must be exactly '${PREFIX}'`);
const dryRun = confirmed === null;

/** Everything this tooling can create, by name: what a teardown looks for. Printed even without credentials. */
export const TEARDOWN_PLAN = [
  { kind: "worker", names: [NAMES.autoWorker, NAMES.opsWorker, NAMES.worker], also: `custom hostnames ${Object.values(HOSTS).join(", ")}; the Durable Object namespace and its stored conversations; the cron trigger; the queue consumer` },
  { kind: "workflow", names: [NAMES.workflow] },
  { kind: "access_app", names: [`every Access application whose name starts with '${PREFIX} '`] },
  { kind: "queue", names: [NAMES.mediaQueue, NAMES.mediaDlq] },
  { kind: "kv", names: [NAMES.kv] },
  { kind: "d1", names: [NAMES.d1], also: "all rows, including the imported development copy of the owner's data" },
  { kind: "r2", names: [NAMES.mediaBucket, NAMES.exportBucket], also: "only when empty" },
  { kind: "ai_search", names: [`namespace ${NAMES.searchNamespace} and every instance inside it`] },
];
const NEVER = [`AI Gateway ${GATEWAY_ID} (owner-created)`, "the DNS zone and any record not created for the hostnames above", "the Access organization and identity providers", "every resource whose name is not under garderobe-rebuild-dev"];

if (!Object.values(presence(MANAGEMENT_ENV)).every(Boolean)) {
  console.log("no management credential in the environment: this is the static plan (nothing was read from the account).\n");
  for (const p of TEARDOWN_PLAN) console.log(`would remove  ${p.kind.padEnd(11)} ${p.names.join(", ")}${p.also ? `  [${p.also}]` : ""}`);
  console.log(`\nnever touched: ${NEVER.join("; ")}`);
  process.exit(dryRun ? 0 : 2);
}

const order = ["worker", "workflow", "access_app", "queue", "kv", "d1", "ai_search_instance", "ai_search_namespace", "r2"];
const workerOrder = [NAMES.autoWorker, NAMES.opsWorker, NAMES.worker];
const ours = (await findOurs()).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || workerOrder.indexOf(a.name) - workerOrder.indexOf(b.name));
const guardFor = (item) => (item.kind === "access_app" ? (name) => (isOurs(name) ? name : (() => { throw new GuardError(`'${name}' is not ours`); })()) : item.kind === "ai_search_instance" ? () => assertDevName(item.namespace, "ai_search_namespace") : assertDevName);
const pathFor = (item) =>
  ({
    worker: A(`/workers/scripts/${item.id}?force=true`),
    workflow: A(`/workflows/${item.id}`),
    access_app: A(`/access/apps/${item.id}`),
    queue: A(`/queues/${item.id}`),
    kv: A(`/storage/kv/namespaces/${item.id}`),
    d1: A(`/d1/database/${item.id}`),
    r2: A(`/r2/buckets/${item.id}`),
    ai_search_instance: A(`/ai-search/namespaces/${item.namespace}/instances/${item.id}`),
    ai_search_namespace: A(`/ai-search/namespaces/${item.id}`),
  })[item.kind];

const results = [];
for (const item of ours) {
  let outcome = dryRun ? "would_remove" : "removed";
  try {
    await write("DELETE", pathFor(item), undefined, { kind: item.kind, target: item.name, guard: guardFor(item), dryRun });
  } catch (error) {
    outcome = `not_removed: ${String(error.message).slice(0, 200)}`;
  }
  results.push({ kind: item.kind, name: item.name, outcome });
  console.log(`${outcome.padEnd(13)} ${item.kind.padEnd(19)} ${item.name}`);
}
if (!ours.length) console.log("nothing of this build exists on the account.");
console.log(`\nnever touched: ${NEVER.join("; ")}`);
if (dryRun) console.log(`\ndry run. To remove the above: node deploy/teardown.mjs --confirm ${PREFIX}`);
mkdirSync(EVIDENCE_DIR, { recursive: true });
writeFileSync(path.join(EVIDENCE_DIR, dryRun ? "teardown-dry-run.json" : "teardown.json"), `${JSON.stringify({ at: new Date().toISOString(), dryRun, results, neverTouched: NEVER, managementWrites: journal }, null, 2)}\n`);
process.exit(results.some((r) => r.outcome.startsWith("not_removed")) ? 1 : 0);
