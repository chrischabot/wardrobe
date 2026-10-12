#!/usr/bin/env node
/**
 * Teardown of the Wardrobe Ferrite app. A dry run by default: it prints and records exactly what it would do.
 *
 *   node deploy/ferrite/teardown.mjs                                         the plan; nothing is changed
 *   node deploy/ferrite/teardown.mjs --execute --confirm=<account>/wardrobe   do it (needs the owner's Ferrite account)
 *
 * The Ferrite CLI (0.1.20) has no verb that deletes an app, so teardown is: delete the app's secrets (both bearer
 * tokens and the public origin), deploy once with zero instances (the deploy delivers the deleted secrets and stops every instance), and remove that
 * target's local token file only, all under the target's lock. The APE state and the request queue stay with the
 * platform. Evidence holds commands, exit statuses, timings and sizes only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EVIDENCE_DIR, abortChildren, accountState, appSpec, cliDiagnostics, cliEvidence, exitPolicy, ferriteAsync } from "./lib/cli.mjs";
import { GuardRefusal, assertTarget } from "./lib/guard.mjs";
import { redactError } from "./lib/redact.mjs";
import { knownSecrets, removeTokens, withTargetLock } from "./lib/state.mjs";
import { installInterruptHandlers, interrupted } from "./verify.mjs";

const SECRET_NAMES = Object.freeze(["WARDROBE_OWNER_TOKEN", "WARDROBE_ASSISTANT_TOKEN", "WARDROBE_PUBLIC_ORIGIN"]);

/** What a teardown removes, in order. */
export function teardownPlan(appName) {
  return [
    ...SECRET_NAMES.map((name) => ({ action: "delete secret", target: name, command: `ferrite secrets delete ${name}` })),
    { action: "scale to zero", target: appName, command: "ferrite deploy --instances 0 --force" },
    { action: "remove local state", target: `deploy/ferrite/.state/<account>__${appName}.tokens.json`, command: "rm" },
  ];
}

function known() {
  return knownSecrets();
}

function evidence(file, body) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, file), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`-> deploy/ferrite/evidence/${file}`);
}

export async function main(argv) {
  const spec = appSpec();
  const plan = teardownPlan(spec.name);
  const execute = argv.includes("--execute");
  for (const p of plan) console.log(`${execute ? "will" : "would"} ${p.action.padEnd(18)} ${p.target}`);
  console.log("not removed: the app's APE state and request queue (the CLI has no delete verb for an app)");
  if (!execute) {
    evidence("teardown-plan.json", { mode: "dry run: nothing was changed", at: new Date().toISOString(), app: spec.name, plan, notRemoved: ["APE state", "request queue"] });
    return 0;
  }
  const account = accountState(await ferriteAsync(["account"], { timeoutMs: 60_000 }));
  if (interrupted()) throw new Error("interrupted before anything was changed");
  const target = assertTarget({ appName: spec.name, account, argv });
  return withTargetLock(target, async () => {
    // Read the account and the spec again under the lock: they must still be exactly the confirmed target before
    // any secret is deleted or any local token file removed.
    const now = accountState(await ferriteAsync(["account"], { timeoutMs: 60_000 }));
    const nowTarget = now.state === "signed_in" ? `${now.account}/${appSpec().name}` : null;
    if (nowTarget !== target) throw new GuardRefusal(`the signed-in account or the app changed since ${target} was confirmed; nothing was changed`);
    const done = [];
    let stopped = null;
    // Commands run asynchronously, so a signal is handled while one runs; it finishes and no further one starts.
    const run = async (args, timeoutMs) => {
      if (interrupted() || stopped) {
        stopped ??= `ferrite ${args.join(" ")}`;
        return;
      }
      const r = await ferriteAsync(args, { timeoutMs });
      if (r.status !== 0) console.error(cliDiagnostics(r, known()));
      done.push(cliEvidence(r));
      if (r.timedOut) {
        // Killed locally, perhaps still running remotely: keep the lock and start nothing further.
        exitPolicy.keepLocks = true;
        stopped ??= `timeout of ferrite ${args.join(" ")}`;
      }
    };
    for (const name of SECRET_NAMES) await run(["secrets", "delete", name], 120_000);
    await run(["deploy", "--instances", "0", "--force"], 3_600_000);
    const ok = !stopped && !interrupted() && done.length === SECRET_NAMES.length + 1 && done.every((d) => d.exit === 0);
    if (ok) removeTokens(target);
    evidence("teardown.json", { at: new Date().toISOString(), target, steps: done, interruptedBefore: stopped, localStateRemoved: ok });
    return ok ? 0 : 1;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fail = (error) => {
    // Commands still running are killed (whole groups) and any held lock is then kept.
    abortChildren();
    console.error(error instanceof GuardRefusal ? redactError(error, known()) : `FAILED: ${redactError(error, known())}`);
    process.exit(error instanceof GuardRefusal ? 2 : 1);
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  // A first signal lets the current command finish and starts no further one; a second exits at once.
  installInterruptHandlers();
  main(process.argv.slice(2)).then((code) => process.exit(code), fail);
}
