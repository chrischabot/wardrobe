import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PUBLIC_ORIGIN_SECRET, publicOriginFrom, superviseVerification } from "../deploy.mjs";
import { teardownPlan } from "../teardown.mjs";
import { signalListeners } from "../verify.mjs";

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

test("the public origin: from --public-origin or the platform's report, a bare https origin, never guessed", () => {
  assert.equal(PUBLIC_ORIGIN_SECRET, "WARDROBE_PUBLIC_ORIGIN");
  assert.equal(publicOriginFrom({ argv: ["--public-origin=https://wardrobe.example.app/"] }), "https://wardrobe.example.app", "no trailing slash");
  assert.equal(publicOriginFrom({ hostStdout: JSON.stringify({ origin: "https://w.example.app" }) }), "https://w.example.app");
  assert.equal(publicOriginFrom({ argv: ["--public-origin=https://a.example"], hostStdout: JSON.stringify({ origin: "https://b.example" }) }), "https://a.example", "the explicit origin wins");
  assert.throws(() => publicOriginFrom({ hostStdout: null }), /--public-origin=/);
  assert.throws(() => publicOriginFrom({ hostStdout: "{}" }), /not known before its first deploy/);
  for (const bad of ["http://w.example", "https://w.example/path", "https://u@w.example"]) assert.throws(() => publicOriginFrom({ argv: [`--public-origin=${bad}`] }), /bare https origin/, bad);
  const src = readFileSync(path.join(DIR, "deploy.mjs"), "utf8");
  const at = (fragment) => {
    const i = src.indexOf(fragment);
    assert.ok(i >= 0, `deploy.mjs contains ${fragment}`);
    return i;
  };
  assert.ok(at("publicOriginFrom({ argv, hostStdout })") < at("ensureTokens(target)"), "settled before any remote write");
  assert.ok(at("secrets\", \"set\", PUBLIC_ORIGIN_SECRET") < at('ferriteAsync(["deploy"]'), "set before the deploy");
  assert.ok(at("if (origin !== publicOrigin)") > at('ferriteAsync(["deploy"]'), "the deployed origin must equal it");
});

test("teardown: the plan deletes the app's secrets, scales to zero and removes only this target's state", () => {
  const plan = teardownPlan("wardrobe");
  assert.deepEqual(plan.map((p) => p.command), ["ferrite secrets delete WARDROBE_OWNER_TOKEN", "ferrite secrets delete WARDROBE_ASSISTANT_TOKEN", "ferrite secrets delete WARDROBE_PUBLIC_ORIGIN", "ferrite deploy --instances 0 --force", "rm"]);
  const src = readFileSync(path.join(DIR, "teardown.mjs"), "utf8");
  assert.ok(src.indexOf("if (!execute) {") < src.indexOf("assertTarget("), "the dry run returns before the guard and before any remote command");
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
  try {
    for (const mode of ["reconciles", "stubborn"]) {
      const probe = net.createServer();
      await new Promise((r) => probe.listen(0, "127.0.0.1", r));
      const port = probe.address().port;
      await new Promise((r) => probe.close(r));
      const marker = path.join(dir, `${mode}.marker`);
      const up = () => fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false);
      const run = superviseVerification({ args: [script, String(port), marker, mode], reconcileMs: 1500, timeoutMs: 30_000, quiet: true });
      for (let i = 0; i < 100 && !(await up()); i += 1) await sleep(100);
      assert.equal(await up(), true, `${mode}: the dev server came up`);
      const signalled = Date.now();
      for (const listener of signalListeners) listener("SIGINT");
      const result = await run;
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
    rmSync(dir, { recursive: true, force: true });
  }
});
