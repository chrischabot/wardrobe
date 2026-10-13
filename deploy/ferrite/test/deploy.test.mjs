import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PUBLIC_ORIGIN_SECRET, publicOriginFrom, superviseVerification } from "../deploy.mjs";
import { teardownPlan } from "../teardown.mjs";
import { signalListeners } from "../verify.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Every temporary directory is removed once the file's tests have settled.
const tmpDirs = [];
const tmp = (p) => {
  const d = mkdtempSync(path.join(tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
/** The position of `fragment` in `src`, asserting that it is there at all. */
const at = (src, fragment, file) => {
  const i = src.indexOf(fragment);
  assert.ok(i >= 0, `${file} contains ${fragment}`);
  return i;
};

test("the public origin: from --public-origin or the platform's report, a bare https origin, never guessed", () => {
  assert.equal(PUBLIC_ORIGIN_SECRET, "WARDROBE_PUBLIC_ORIGIN");
  assert.equal(publicOriginFrom({ argv: ["--public-origin=https://wardrobe.example.app/"] }), "https://wardrobe.example.app", "no trailing slash");
  assert.equal(publicOriginFrom({ hostStdout: JSON.stringify({ origin: "https://w.example.app" }) }), "https://w.example.app");
  assert.equal(publicOriginFrom({ argv: ["--public-origin=https://a.example"], hostStdout: JSON.stringify({ origin: "https://b.example" }) }), "https://a.example", "the explicit origin wins");
  assert.throws(() => publicOriginFrom({ hostStdout: null }), /--public-origin=/);
  assert.throws(() => publicOriginFrom({ hostStdout: "{}" }), /not known before its first deploy/);
  for (const bad of ["http://w.example", "https://w.example/path", "https://u@w.example"]) assert.throws(() => publicOriginFrom({ argv: [`--public-origin=${bad}`] }), /bare https origin/, bad);
  const src = readFileSync(path.join(DIR, "deploy.mjs"), "utf8");
  const pos = (fragment) => at(src, fragment, "deploy.mjs");
  assert.ok(pos("publicOriginFrom({ argv, hostStdout })") < pos("ensureTokens(target)"), "settled before any remote write");
  assert.ok(pos("secrets\", \"set\", \"--app\", target, PUBLIC_ORIGIN_SECRET") < pos('remote(["deploy"]'), "set before the deploy, for the confirmed app explicitly");
  assert.equal(/remote\(\["(secrets|host)"(?![^\]]*"--app", target)/.test(src), false, "every host and secrets command names the confirmed app");
  assert.ok(pos('child.once("spawn", () => (progress.chargedDeployAttempted = true))') > pos('remote(["deploy"]'), "a charged deploy is recorded only once its process has spawned");
  assert.ok(pos('progress.failedStep = "spec changed during deploy"') > pos('remote(["deploy"]'), "the spec is checked again after the deploy");
  assert.ok(pos("if (origin !== publicOrigin)") > pos('remote(["deploy"]'), "the deployed origin must equal it");
  // Every remote command runs inside the credential snapshot, with its environment, and rechecks the spec's app.
  assert.ok(pos("withTargetLock(target, () => withCredentialSnapshot(async (env)") < pos("const remote = async (args, opts)"));
  assert.ok(pos("return ferriteAsync(args, { ...opts, env })") > pos("if (appSpec().name !== target.split(\"/\")[1])"));
  const inLock = src.slice(pos("const remote = async (args, opts)"), pos("verified = await verifyAndRecord("));
  assert.equal(/ferriteAsync\(\[/.test(inLock), false, "no remote command inside the lock bypasses remote()");
  // remote() rechecks the account through the snapshot before every command.
  assert.ok(pos("await confirmedTarget();\n      checkpoint(`before ferrite ${args.join(\" \")}`);") > pos("const confirmedTarget = async () =>"), "an interrupt during the account read stops the command");
  assert.ok(pos("return ferriteAsync(args, { ...opts, env })") > pos("checkpoint(`before ferrite ${args.join(\" \")}`);"), "the spec is checked again right before the command spawns");
  const td = readFileSync(path.join(DIR, "teardown.mjs"), "utf8");
  assert.ok(at(td, "if ((await accountNow()) !== target) {", "teardown.mjs") < at(td, "// A signal that arrived during the account read stops this command too.", "teardown.mjs"));
  assert.ok(at(td, "// A signal that arrived during the account read stops this command too.", "teardown.mjs") < at(td, "const r = await ferriteAsync(args, { timeoutMs, env })", "teardown.mjs"), "teardown rechecks the account, then the interrupt, before each command");
});

test("teardown: the plan deletes the app's secrets, scales to zero and removes only this target's state", () => {
  const plan = teardownPlan("wardrobe");
  assert.deepEqual(plan.map((p) => p.command), ["ferrite secrets delete --app <account>/wardrobe WARDROBE_OWNER_TOKEN", "ferrite secrets delete --app <account>/wardrobe WARDROBE_ASSISTANT_TOKEN", "ferrite secrets delete --app <account>/wardrobe WARDROBE_PUBLIC_ORIGIN", "ferrite deploy --instances 0 --force", "rm"]);
  const src = readFileSync(path.join(DIR, "teardown.mjs"), "utf8");
  assert.ok(at(src, "if (!execute) {", "teardown.mjs") < at(src, "assertTarget(", "teardown.mjs"), "the dry run returns before the guard and before any remote command");
  assert.ok(src.includes("removeTokens(target)"));
});

test("deploy and teardown evidence holds no CLI output", () => {
  for (const file of ["evidence/deploy-dry-run.json", "evidence/deploy-preflight.json", "evidence/teardown-plan.json"]) {
    const body = JSON.parse(readFileSync(path.join(DIR, file), "utf8"));
    const walk = (v) => (Array.isArray(v) ? v.forEach(walk) : v && typeof v === "object" ? Object.entries(v).forEach(([k, x]) => { assert.notEqual(k, "output", file); walk(x); }) : undefined);
    walk(body);
  }
});

test("deploy and teardown: every error path goes through redaction, with every known secret", () => {
  for (const file of ["deploy.mjs", "teardown.mjs"]) {
    const src = readFileSync(path.join(DIR, file), "utf8");
    assert.equal(/console\.error\([^)]*error\.message/.test(src), false, `${file} prints a raw error message`);
    assert.ok(src.includes("redactError("), `${file} redacts its errors`);
    assert.equal(/\.message\)?\.slice\(/.test(src), false, `${file} shortens an error before redacting it`);
    assert.ok(src.includes("knownSecrets()"), `${file} uses the shared known-secret collector`);
  }
  assert.ok(readFileSync(path.join(DIR, "deploy.mjs"), "utf8").includes('process.on("unhandledRejection"'), "deploy.mjs handles unexpected errors redacted");
});

// A stand-in for verify.mjs --start-dev: it starts a "dev server" (a tiny HTTP server) in its own process group,
// records its PID where the supervisor asks, and on SIGINT "reconciles" for a moment, recording whether the dev
// server still answered at the end of it. In stubborn mode it ignores the interrupt.
const FAKE_VERIFY = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [port, marker, mode] = process.argv.slice(2);
const dev = spawn(process.execPath, ["-e", \`require("node:http").createServer((q, s) => s.end("ok")).listen(\${port}, "127.0.0.1")\`], { detached: true, stdio: "ignore" });
writeFileSync(process.env.WARDROBE_VERIFY_DEV_PIDFILE, String(dev.pid));
dev.unref();
const up = () => fetch(\`http://127.0.0.1:\${port}/\`).then((r) => r.ok, () => false);
process.on("SIGINT", async () => {
  if (mode === "stubborn") return;
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(marker, (await up()) ? "up" : "down");
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

test("supervised verification: an interrupt reaches the verification only; its dev server serves until it has reconciled, then stops", async () => {
  const dir = tmp("wardrobe-supervise-");
  const script = path.join(dir, "fake-verify.mjs");
  writeFileSync(script, FAKE_VERIFY);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The supervision in progress: a failed assertion still interrupts it and waits for it (and its dev server) to
  // stop before the directory holding its PID file is removed.
  let active = null;
  try {
    for (const mode of ["reconciles", "stubborn"]) {
      const probe = net.createServer();
      await new Promise((r) => probe.listen(0, "127.0.0.1", r));
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
      const marker = path.join(dir, `${mode}.marker`);
      const up = () => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false);
      const run = superviseVerification({ args: [script, String(port), marker, mode], reconcileMs: 1500, timeoutMs: 30_000, quiet: true });
      active = run;
      for (let i = 0; i < 100 && !(await up()); i += 1) await sleep(100);
      assert.equal(await up(), true, `${mode}: the dev server came up`);
      const signalled = Date.now();
      for (const listener of signalListeners) listener("SIGINT");
      const result = await run;
      active = null;
      if (mode === "reconciles") {
        assert.equal(readFileSync(marker, "utf8"), "up", "the dev server still served at the end of the child's reconciliation");
        assert.equal(result.status, 0);
      } else {
        assert.equal(existsSync(marker), false);
        assert.equal(result.signal, "SIGKILL", "a child that does not finish reconciling is killed after the timeout");
        assert.ok(Date.now() - signalled >= 1400, "not before the reconciliation timeout");
      }
      for (let i = 0; i < 30 && (await up()); i += 1) await sleep(100);
      assert.equal(await up(), false, `${mode}: the dev server is stopped once the verification has exited`);
    }
    assert.equal(signalListeners.size, 0, "the supervisor removes its signal forwarding");
  } finally {
    if (active) {
      for (const listener of signalListeners) listener("SIGINT");
      await active.catch(() => {});
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
