#!/usr/bin/env node
/**
 * One command: gate, verify locally, set the bearer tokens and deploy the Wardrobe Ferrite app, then verify it.
 *
 *   node deploy/ferrite/deploy.mjs --dry-run                       local only: ferrite check, the plan, the account state
 *   node deploy/ferrite/deploy.mjs --confirm=<account>/wardrobe    deploy (needs the owner's Ferrite account)
 *
 * Without a signed-in Ferrite account nothing remote runs: the reason and a read-only probe of the platform endpoint
 * (status and error code only) go to evidence/deploy-preflight.json. With one, the guard (lib/guard.mjs) requires the
 * exact `<account>/<app>` target, then `ferrite check`, `ferrite test` and the local HTTP verification must pass before
 * anything remote is written. Token generation, `ferrite secrets set` (stdin) and the one `ferrite deploy` run under
 * the target's exclusive lock, with the target's own tokens (lib/state.mjs). A deploy is a charged build and is never
 * retried here (`ferrite deploy resume` reattaches). Evidence holds commands, exit statuses, timings and sizes only;
 * CLI output is printed redacted to the console and never written.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EVIDENCE_DIR, FERRITE_TOOLING_DIR, REPO_DIR, STEPS, abortChildren, accountState, appSpec, cliDiagnostics, cliEvidence, deployedOrigin, exitPolicy, ferriteAsync, killTree, originForEvidence, probeEndpoint, spawnAsync } from "./lib/cli.mjs";
import { GuardRefusal, assertTarget } from "./lib/guard.mjs";
import { redactError } from "./lib/redact.mjs";
import { ensureTokens, knownSecrets, withTargetLock } from "./lib/state.mjs";
import { installInterruptHandlers, interrupted, keepLocksForWritesInFlight, signalListeners, verifyAndRecord } from "./verify.mjs";

const SECRET_NAMES = Object.freeze(["WARDROBE_OWNER_TOKEN", "WARDROBE_ASSISTANT_TOKEN"]);
/**
 * The app's own public origin (the port's OAuth discovery, /oauth/ and /mcp need it exactly, with no trailing slash;
 * without it they answer 500, and /mcp refuses any other Origin with 403). Not a credential.
 */
export const PUBLIC_ORIGIN_SECRET = "WARDROBE_PUBLIC_ORIGIN";

/**
 * The public origin to set before the deploy: `--public-origin=<https origin>` when given, else the origin
 * `ferrite host --json` reports for the app. Either must be a bare https origin; returned canonical, without a
 * trailing slash. Throws (before anything remote is written) when neither yields one.
 */
export function publicOriginFrom({ argv = [], hostStdout = null } = {}) {
  const flag = argv.find((a) => a.startsWith("--public-origin="));
  if (flag) return deployedOrigin(flag.slice("--public-origin=".length));
  let reported = null;
  try {
    reported = JSON.parse(hostStdout || "{}").origin ?? null;
  } catch {
    reported = null;
  }
  if (!reported) throw new Error(`the app's public origin is not known before its first deploy; nothing remote was written. Run again with --public-origin=https://<the app's origin> (it becomes ${PUBLIC_ORIGIN_SECRET})`);
  return deployedOrigin(reported);
}

const known = () => knownSecrets();

/** What a run has done so far, written to evidence on success AND failure (structured fields only). */
const progress = { target: null, steps: [], failedStep: null, chargedDeployAttempted: false };

function evidence(file, body) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, file), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`-> deploy/ferrite/evidence/${file}`);
}

/** Pid files naming the dev-server process group of a verification still being supervised (killed on failure). */
const devPidFiles = new Set();

/** SIGKILL the process group a verification recorded for its dev server, if that group still exists. */
export function killRecordedGroup(file) {
  let pid;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Run a verification child and supervise it. A signal this process receives is forwarded to the child's own PID
 * only, never to a process group: the dev server it started runs in a group of its own and keeps serving while the
 * child undoes its own receipts. The dev server is stopped only after the child has exited (it normally stops it
 * itself), or after `reconcileMs` from the first signal, when a child still running is killed first. A second signal
 * is a forced abort without cleanup: the dev server is killed at once.
 */
export async function superviseVerification({ args = [path.join(FERRITE_TOOLING_DIR, "verify.mjs"), "--local", "--start-dev"], reconcileMs = 300_000, timeoutMs = 1_800_000, quiet = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wardrobe-verify-"));
  const pidFile = path.join(dir, "dev.pid");
  devPidFiles.add(pidFile);
  let child = null;
  let signals = 0;
  let reconcileTimer = null;
  const alive = () => child && child.exitCode === null && child.signalCode === null;
  const forward = (signal) => {
    signals += 1;
    if (signals >= 2) killRecordedGroup(pidFile);
    if (!alive()) return;
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
    if (signals === 1) {
      reconcileTimer = setTimeout(() => {
        if (alive()) killTree(child);
      }, reconcileMs);
    }
  };
  signalListeners.add(forward);
  try {
    return await spawnAsync(process.execPath, args, { cwd: REPO_DIR, echo: quiet ? null : () => knownSecrets(), timeoutMs, env: { ...process.env, WARDROBE_VERIFY_DEV_PIDFILE: pidFile }, onChild: (c) => (child = c) });
  } finally {
    clearTimeout(reconcileTimer);
    signalListeners.delete(forward);
    // The child has exited: whatever dev server it left behind (a timeout, a crash) stops now.
    killRecordedGroup(pidFile);
    devPidFiles.delete(pidFile);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function localVerification() {
  return (await superviseVerification()).status;
}

export async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const spec = appSpec();
  const account = accountState(await ferriteAsync(["account"], { timeoutMs: 60_000 }));
  if (interrupted()) throw new Error("interrupted before anything else started; nothing was changed");
  const plan = [
    "ferrite check and ferrite test (local)",
    "node deploy/ferrite/verify.mjs --local --start-dev (local)",
    `under the target's lock: the public origin (--public-origin=, else ferrite host --json), its bearer tokens, generated once into deploy/ferrite/.state/<account>__<app>.tokens.json (0600), set as ${SECRET_NAMES.join(" and ")} and the origin as ${PUBLIC_ORIGIN_SECRET} with ferrite secrets set (stdin), then one ferrite deploy for app ${spec.name} (routes ${spec.routes.join(", ")}; services ${spec.services.join(", ")})`,
    "ferrite host --json must report the origin that was set, then node deploy/ferrite/verify.mjs --deployed",
  ];

  if (dryRun) {
    const check = await ferriteAsync(["check"], { timeoutMs: 900_000 });
    if (check.status !== 0) console.error(cliDiagnostics(check, known()));
    evidence("deploy-dry-run.json", { mode: "dry run: nothing remote was written", at: new Date().toISOString(), app: spec, account: account.state, accountReason: account.reason, plan, steps: STEPS, check: cliEvidence(check) });
    console.log(plan.map((p, i) => `${i + 1}. ${p}`).join("\n"));
    console.log(`account: ${account.state}${account.reason ? ` (${account.reason})` : ""}`);
    return check.status === 0 ? 0 : 1;
  }

  if (account.state !== "signed_in") {
    const probe = await probeEndpoint({ known: known() });
    evidence("deploy-preflight.json", {
      at: new Date().toISOString(),
      result: "blocked",
      deployed: false,
      app: spec.name,
      account: account.state,
      reason: account.reason,
      endpointProbe: probe,
      needsOwnerAccount: STEPS.filter((s) => s.needsAccount).map((s) => s.step),
      runsWithoutAccount: STEPS.filter((s) => !s.needsAccount).map((s) => s.step),
      remaining: "the owner supplies his Ferrite account credential document (endpoint, account id, token) and imports it with `ferrite login --credentials-file <path>` (0600); then run this command again with --confirm=<account>/wardrobe",
    });
    console.error(`blocked: ${account.reason}; nothing was deployed`);
    return 2;
  }

  const target = assertTarget({ appName: spec.name, account, argv });
  progress.target = target;
  const steps = progress.steps;
  // Every step runs asynchronously, so signal handlers run while it does; nothing further starts once one arrived.
  const checkpoint = (where) => {
    if (interrupted()) {
      progress.failedStep = `interrupted ${where}`;
      throw new Error(`interrupted ${where}; no further step was started`);
    }
  };
  const step = async (name, run) => {
    checkpoint(`before ${name}`);
    const result = await run();
    steps.push({ name, ...cliEvidence(result) });
    if (result.timedOut) {
      // The CLI was killed, but its remote operation may still be running: keep the target lock.
      exitPolicy.keepLocks = true;
      progress.failedStep = `${name} timed out`;
      throw new Error(`${name} timed out; the target lock is kept until \`ferrite status\` shows it settled (then remove the lock file)`);
    }
    if (result.status !== 0 || result.error) {
      progress.failedStep = name;
      console.error(cliDiagnostics(result, known()));
      throw new Error(`${name} failed (exit ${result.status}${result.error ? ", with a command error such as a refused input" : ""})`);
    }
    checkpoint(`after ${name}`);
    return result;
  };
  await step("ferrite check", () => ferriteAsync(["check"], { timeoutMs: 900_000 }));
  await step("ferrite test", () => ferriteAsync(["test"], { timeoutMs: 1_800_000 }));
  checkpoint("before the local verification");
  if ((await localVerification()) !== 0) {
    progress.failedStep = "local verification";
    throw new Error("the local verification did not pass; nothing remote was written");
  }
  steps.push({ name: "local verification", exit: 0, evidence: "deploy/ferrite/evidence/verify-local.json" });
  checkpoint("after the local verification; nothing remote was written");

  let created = false;
  let origin = null;
  let verified = null;
  await withTargetLock(target, async () => {
    // The local checks take minutes: the signed-in account and the spec are read again right before the first remote
    // write, and must still be exactly the confirmed target.
    const now = accountState(await ferriteAsync(["account"], { timeoutMs: 60_000 }));
    checkpoint("before the first remote write");
    const nowTarget = now.state === "signed_in" ? `${now.account}/${appSpec().name}` : null;
    if (nowTarget !== target) {
      progress.failedStep = "target revalidation";
      throw new GuardRefusal(`the signed-in account or the app changed since ${target} was confirmed; nothing remote was written`);
    }
    // The public origin is settled before any remote write: from --public-origin=, else what the platform reports.
    let publicOrigin;
    try {
      let hostStdout = null;
      if (!argv.some((a) => a.startsWith("--public-origin="))) {
        checkpoint("before ferrite host");
        const pre = await ferriteAsync(["host", "--json"], { timeoutMs: 60_000 });
        steps.push({ name: "ferrite host --json (before deploy)", ...cliEvidence(pre) });
        hostStdout = pre.status === 0 ? pre.stdout : null;
      }
      publicOrigin = publicOriginFrom({ argv, hostStdout });
    } catch (error) {
      progress.failedStep = "public origin";
      throw error;
    }
    const t = ensureTokens(target);
    created = t.created;
    await step(`ferrite secrets set ${SECRET_NAMES[0]}`, () => ferriteAsync(["secrets", "set", SECRET_NAMES[0]], { input: t.tokens.owner, timeoutMs: 120_000 }));
    await step(`ferrite secrets set ${SECRET_NAMES[1]}`, () => ferriteAsync(["secrets", "set", SECRET_NAMES[1]], { input: t.tokens.assistant, timeoutMs: 120_000 }));
    await step(`ferrite secrets set ${PUBLIC_ORIGIN_SECRET}`, () => ferriteAsync(["secrets", "set", PUBLIC_ORIGIN_SECRET], { input: publicOrigin, timeoutMs: 120_000 }));
    // One charged build: never retried here. An interrupted deploy is reattached with `ferrite deploy resume`.
    checkpoint("before ferrite deploy");
    progress.chargedDeployAttempted = true;
    await step("ferrite deploy", () => ferriteAsync(["deploy"], { timeoutMs: 3_600_000 }));
    const host = await step("ferrite host --json", () => ferriteAsync(["host", "--json"], { timeoutMs: 60_000 }));
    try {
      origin = deployedOrigin(JSON.parse(host.stdout || "{}").origin);
    } catch (error) {
      progress.failedStep = "origin validation";
      throw error;
    }
    if (origin !== publicOrigin) {
      progress.failedStep = "public origin mismatch";
      throw new Error(`the deployed origin differs from the ${PUBLIC_ORIGIN_SECRET} that was set, so OAuth discovery, /oauth/ and /mcp will refuse; run again with --public-origin=${origin} (a second charged deploy)`);
    }
    // The deployed verification changes the owner's wardrobe and takes it back: it runs in this process, inside the
    // same lock, so no teardown or second deploy of this target can run between its commands and its cleanup.
    verified = await verifyAndRecord({ origin, tokens: t.tokens, target: "deployed" });
  });
  evidence("deploy.json", { at: new Date().toISOString(), target, origin: originForEvidence(origin), tokensCreated: created, secrets: [...SECRET_NAMES, PUBLIC_ORIGIN_SECRET], steps, chargedDeployAttempted: progress.chargedDeployAttempted, verification: verified === 0 ? "passed: deploy/ferrite/evidence/verify-deployed.json" : `failed (exit ${verified})` });
  return verified === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fail = (error) => {
    // Commands still running are killed (whole groups) and any held lock is then kept.
    abortChildren();
    keepLocksForWritesInFlight(false);
    for (const file of devPidFiles) killRecordedGroup(file);
    const message = redactError(error, known());
    console.error(error instanceof GuardRefusal ? message : `FAILED: ${message}`);
    try {
      // Structured progress only; the message goes to the console, never to evidence.
      evidence("deploy-failed.json", { at: new Date().toISOString(), refused: error instanceof GuardRefusal, target: progress.target, failedStep: progress.failedStep, chargedDeployAttempted: progress.chargedDeployAttempted, steps: progress.steps });
    } catch {
      // evidence is best effort once the command has failed
    }
    process.exit(error instanceof GuardRefusal ? 2 : 1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  // A signal stops the next step from starting and lets a running verification undo its own changes.
  installInterruptHandlers();
  main(process.argv.slice(2)).then((code) => process.exit(code), fail);
}
