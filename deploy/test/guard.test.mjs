/**
 * The guard that keeps this tooling on development resources. Run: node --test deploy/test/
 * (no network, no credentials).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { ACCESS_BYPASS_PATHS, DEPLOY_DIR, GuardError, HOSTS, NAMES, assertDevEnvironment, assertDevHost, assertDevName } from "../lib/config.mjs";
import { journal, write } from "../lib/cf.mjs";
import { isOurs } from "../lib/provision.mjs";
import { autoConfig, opsConfig, primaryConfig } from "../lib/wrangler-config.mjs";

const refused = (fn) => assert.throws(fn, GuardError);

test("only names under garderobe-rebuild-dev are accepted", () => {
  for (const ok of ["garderobe-rebuild-dev", "garderobe-rebuild-dev-media", "garderobe-rebuild-dev-media-dlq"]) assert.equal(assertDevName(ok), ok);
  for (const bad of [
    "garderobe", "garderobe-dev", "garderobe-dev-media", "garderobe-images", "garderobe-prod", "garderobe-rebuild", "garderobe-rebuild-prod", "garderobe-rebuild-dev-prod",
    "garderobe-rebuild-dev-production-x", "garderobe-rebuild-dev-live", "garderobe-rebuild-development", "x-garderobe-rebuild-dev", "garderobe-rebuild-dev/../other", "garderobe-rebuild-dev ", "GARDEROBE-REBUILD-DEV", "", null, undefined, 7,
    "atlas-prod", "arcwell-media",
  ]) refused(() => assertDevName(bad));
});

test("hostnames must be this build's development names in the configured zone", () => {
  for (const host of Object.values(HOSTS)) assert.equal(assertDevHost(host), host);
  for (const bad of ["chabot.dev", "garderobe.chabot.dev", "garderobe-dev.chabot.dev", "garderobe-rebuild-dev.example.com", "garderobe-rebuild-dev.chabot.dev.evil.com", "garderobe-rebuild-prod.chabot.dev", "api.garderobe-rebuild-dev.chabot.dev"]) refused(() => assertDevHost(bad));
});

test("the command line and the environment can only name the development environment", () => {
  assertDevEnvironment([], {});
  assertDevEnvironment(["--env", "dev"], {});
  assertDevEnvironment(["--env=dev"], { ENVIRONMENT: "dev" });
  for (const argv of [["--env", "production"], ["--env=prod"], ["-e", "staging"], ["--env"]]) refused(() => assertDevEnvironment(argv, {}));
  refused(() => assertDevEnvironment([], { GARDEROBE_ENV: "production" }));
  refused(() => assertDevEnvironment([], { ENVIRONMENT: "prod" }));
});

test("a management write cannot be expressed without a guarded development target", async () => {
  const before = journal.length;
  await assert.rejects(write("POST", "/accounts/x/d1/database", { name: "y" }, { kind: "d1", target: "garderobe-dev", guard: assertDevName, dryRun: true }), GuardError);
  await assert.rejects(write("DELETE", "/accounts/x/r2/buckets/garderobe-images", undefined, { kind: "r2", target: "garderobe-images", guard: assertDevName, dryRun: true }), GuardError);
  await assert.rejects(write("DELETE", "/accounts/x/workers/scripts/z", undefined, { kind: "worker", target: "z", dryRun: true }), GuardError);
  await assert.rejects(write("DELETE", "/accounts/x/workers/scripts/z", undefined, { kind: "worker", guard: assertDevName, dryRun: true }), GuardError);
  assert.equal(journal.length, before, "a refused write is not even journalled as attempted");
  // A guarded dry-run write is journalled and sends nothing (there is no credential in this test).
  assert.equal(await write("POST", "/accounts/x/queues", { queue_name: NAMES.mediaQueue }, { kind: "queue", target: NAMES.mediaQueue, guard: assertDevName, dryRun: true }), null);
  assert.equal(journal.at(-1).target, NAMES.mediaQueue);
  assert.equal(journal.at(-1).status, null);
});

test("what teardown looks for is only this build's resources", () => {
  for (const mine of ["garderobe-rebuild-dev", "garderobe-rebuild-dev-ops", "garderobe-rebuild-dev (bypass /connections/callback)"]) assert.equal(isOurs(mine), true);
  for (const other of ["garderobe", "garderobe-dev", "garderobe-dev-recall", "garderobe-dev-media", "garderobe-images", "garderobe-rebuild-devx", "arcwell-wiki", "atlas-prod", undefined]) assert.equal(isOurs(other), false);
});

test("generated configurations: development names, the product's binding names, no management credential", () => {
  const ids = { d1: "00000000-0000-4000-8000-000000000000", kv: "kv-id", searchNamespace: NAMES.searchNamespace };
  const access = { teamDomain: "https://team.cloudflareaccess.com", audience: "aud" };
  const configs = [primaryConfig({ ids, access }), autoConfig({ ids }), opsConfig({ ids, publicJwk: { kty: "RSA" }, opsTokenSha256: "0".repeat(64) })];
  for (const config of configs) {
    assertDevName(config.name);
    assert.equal(config.workers_dev, false);
    assert.equal(config.vars.ENVIRONMENT, "dev");
    assert.equal(config.vars.AI_GATEWAY_ID, "garderobe-dev");
    assert.equal(config.vars.ACCESS_JWKS_JSON, undefined, "the local-only key override is never deployed");
    for (const route of config.routes) assert.equal(route.custom_domain, true), assertDevHost(route.pattern);
    assert.deepEqual(config.d1_databases.map((d) => d.binding), ["DB"]);
    assert.deepEqual(config.kv_namespaces.map((k) => k.binding), ["OAUTH_KV"]);
    assert.deepEqual(config.r2_buckets.map((b) => b.binding), ["MEDIA_BUCKET", "EXPORT_BUCKET"]);
    for (const bucket of config.r2_buckets) assertDevName(bucket.bucket_name);
    assertDevName(config.d1_databases[0].database_name);
    const text = JSON.stringify(config);
    assert.doesNotMatch(text, /CLOUDFLARE_API_TOKEN|R2_SECRET|R2_ACCESS_KEY|CF_AIG_TOKEN/, "no management credential name appears in a Worker configuration");
    assert.doesNotMatch(text, /"(CREDENTIAL_KEY|STATE_SIGNING_KEY|MEDIA_SIGNING_KEY)"/, "application secrets are uploaded as secrets, not as variables");
  }
  const [primary, auto, ops] = configs;
  // One conversation actor namespace, one queue consumer with a dead-letter queue, one cron sweep: all in the product Worker.
  assert.deepEqual(primary.durable_objects.bindings, [{ name: "ASSISTANT", class_name: "GarderobeAssistant" }]);
  assert.equal(auto.durable_objects.bindings[0].script_name, NAMES.worker);
  assert.equal(primary.queues.consumers[0].dead_letter_queue, NAMES.mediaDlq);
  assert.equal(primary.queues.consumers[0].max_retries, 3);
  assert.equal(auto.queues.consumers, undefined);
  assert.equal(auto.triggers, undefined);
  // Two trust domains per door; the automation door's issuer is the operations Worker, not the Access team.
  assert.notEqual(primary.vars.APP_ORIGIN, primary.vars.MCP_ORIGIN);
  assert.equal(primary.vars.ACCESS_TEAM_DOMAIN, access.teamDomain);
  assert.equal(auto.vars.ACCESS_TEAM_DOMAIN, `https://${HOSTS.ops}`);
  assert.equal(ops.services, undefined, "the rehearsal's pass-through to the product Worker is never deployed");
  assert.equal(ops.vars.REHEARSAL, undefined);
  assert.deepEqual([...ACCESS_BYPASS_PATHS], ["/connections/callback", "/v1/media/signed/*"]);
});

test("the commands refuse a non-development environment before doing anything", () => {
  for (const script of ["deploy.mjs", "teardown.mjs", "verify.mjs"]) {
    assert.throws(() => execFileSync(process.execPath, [path.join(DEPLOY_DIR, script), "--env", "production"], { stdio: "pipe", env: { PATH: process.env.PATH } }), /refused: environment 'production'/, script);
  }
  assert.throws(() => execFileSync(process.execPath, [path.join(DEPLOY_DIR, "teardown.mjs"), "--confirm", "garderobe"], { stdio: "pipe", env: { PATH: process.env.PATH } }), /--confirm must be exactly/);
});

test("without the management token: deploy reports the missing names and stops; teardown prints its plan and removes nothing", () => {
  const env = { PATH: process.env.PATH, GARDEROBE_EVIDENCE_DIR: path.join(process.env.TMPDIR ?? "/tmp", `guard-test-${process.pid}`) };
  let deploy;
  try {
    execFileSync(process.execPath, [path.join(DEPLOY_DIR, "deploy.mjs"), "--commit", "test"], { stdio: "pipe", env });
  } catch (error) {
    deploy = error;
  }
  assert.equal(deploy?.status, 2);
  assert.match(String(deploy.stdout), /ABSENT\s+CLOUDFLARE_API_TOKEN/);
  const plan = execFileSync(process.execPath, [path.join(DEPLOY_DIR, "teardown.mjs")], { encoding: "utf8", env });
  assert.match(plan, /static plan/);
  for (const line of plan.split("\n").filter((l) => l.startsWith("would remove"))) assert.match(line, /garderobe-rebuild-dev/);
});
