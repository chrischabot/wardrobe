import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { STEPS, abortChildren, accountState, appSpec, cliDiagnostics, cliEvidence, exitPolicy, localTokens, probeEndpoint, spawnAsync } from "../lib/cli.mjs";
import { GuardRefusal, assertTarget } from "../lib/guard.mjs";
import { allStoredTokens, ensureTokens, readTokens, removeTokens, tokensFile, withTargetLock } from "../lib/state.mjs";

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));

test("CLI evidence holds the command, exit status, timing and sizes only; diagnostics are redacted", () => {
  const leaked = "leaked-" + "value";
  const r = { args: ["check"], status: 1, signal: null, stdout: `Authorization: Bearer ${leaked}\nmore text`, stderr: "error: x", error: null, ms: 12 };
  const ev = cliEvidence(r);
  assert.deepEqual(Object.keys(ev).sort(), ["command", "exit", "ms", "signal", "spawnFailed", "stderrBytes", "stdoutBytes"]);
  assert.equal(JSON.stringify(ev).includes("leaked"), false);
  assert.equal(cliDiagnostics(r, []).includes(leaked), false);
});

test("account state: each CLI answer maps to its exact reason", () => {
  const r = (stdout, status = 0, stderr = "") => ({ stdout, stderr, status, error: null });
  assert.equal(accountState(r("account: not logged in\nendpoint: not configured\n")).state, "not_logged_in");
  assert.equal(accountState(r("", 2, "error: no Ferrite Cloud endpoint configured — run `ferrite login`")).state, "no_endpoint");
  assert.equal(accountState(r("", 1, 'HTTP 401 {"error":"unauthenticated","error_description":"present a Ferrite account token"}')).state, "token_rejected");
  assert.deepEqual(accountState(r("account: chris\nendpoint: https://mcp.example/mcp\n")), { state: "signed_in", account: "chris", reason: null });
  assert.equal(accountState({ stdout: "", stderr: "", status: null, error: "spawnSync ferrite ENOENT" }).state, "no_cli");
});

test("steps: every remote step is marked as needing the owner's account, the local ones are not", () => {
  const needs = Object.fromEntries(STEPS.map((s) => [s.step, s.needsAccount]));
  assert.equal(needs["ferrite check"], false);
  assert.equal(needs["ferrite dev + node deploy/ferrite/verify.mjs --local"], false);
  for (const remote of ["ferrite deploy", "ferrite host", "ferrite account", "node deploy/ferrite/teardown.mjs --execute", "node deploy/ferrite/verify.mjs --deployed"]) assert.equal(needs[remote], true, remote);
});

test("guard: refuses another app, no account, or a target not confirmed exactly; a multi-application spec is refused", () => {
  const account = { state: "signed_in", account: "chris", reason: null };
  assert.equal(assertTarget({ appName: "wardrobe", account, argv: ["--confirm=chris/wardrobe"] }), "chris/wardrobe");
  assert.throws(() => assertTarget({ appName: "shop", account, argv: ["--confirm=chris/shop"] }), GuardRefusal);
  for (const name of ["wardrobe-dev", "wardrobe-dev-2", "wardrobes", "Wardrobe", "wardrobe\n", "wardrobe ", null]) {
    assert.throws(() => assertTarget({ appName: name, account, argv: [`--confirm=chris/${name}`] }), GuardRefusal, JSON.stringify(name));
  }
  assert.throws(() => assertTarget({ appName: "wardrobe", account: { state: "not_logged_in", reason: "x" }, argv: ["--confirm=chris/wardrobe"] }), GuardRefusal);
  assert.throws(() => assertTarget({ appName: "wardrobe", account, argv: [] }), /--confirm=chris\/wardrobe/);
  assert.throws(() => assertTarget({ appName: "wardrobe", account, argv: ["--confirm=other/wardrobe"] }), GuardRefusal);
  const two = tmp("spec-");
  writeFileSync(path.join(two, "ferrite.json"), JSON.stringify({ applications: [{ name: "wardrobe" }, { name: "other" }] }));
  assert.throws(() => appSpec(two), /2 applications/);
  assert.equal(appSpec().name, "wardrobe");
});

test("tokens: one file per target, created once, 0600, validated, and removed per target", () => {
  const dir = path.join(tmp("ferrite-state-"), "s");
  const a = ensureTokens("chris/wardrobe", dir);
  const b = ensureTokens("chrisdev/wardrobe", dir);
  assert.throws(() => tokensFile("chris/wardrobe-dev", dir), /not a target/);
  assert.equal(a.created && b.created, true);
  assert.notEqual(a.tokens.owner, b.tokens.owner, "targets never share credentials");
  assert.equal(statSync(tokensFile("chris/wardrobe", dir)).mode & 0o077, 0);
  assert.equal(statSync(dir).mode & 0o077, 0);
  assert.deepEqual(ensureTokens("chris/wardrobe", dir).tokens, readTokens("chris/wardrobe", dir));
  // An existing file readable by others is tightened; an invalid one is refused.
  chmodSync(tokensFile("chris/wardrobe", dir), 0o644);
  readTokens("chris/wardrobe", dir);
  assert.equal(statSync(tokensFile("chris/wardrobe", dir)).mode & 0o077, 0);
  writeFileSync(tokensFile("other/wardrobe", dir), JSON.stringify({ owner: "", assistant: "" }));
  assert.throws(() => ensureTokens("other/wardrobe", dir), /two distinct/);
  writeFileSync(tokensFile("same/wardrobe", dir), JSON.stringify({ owner: "x".repeat(50), assistant: "x".repeat(50) }));
  assert.throws(() => readTokens("same/wardrobe", dir), /two distinct/);
  // Tokens must be header-safe base64url: an embedded newline or space is refused before anything is set remotely.
  writeFileSync(tokensFile("bad/wardrobe", dir), JSON.stringify({ owner: `${"a".repeat(45)}\nX-Evil: 1`, assistant: "b".repeat(50) }));
  assert.throws(() => readTokens("bad/wardrobe", dir), /base64url/);
  assert.match(a.tokens.owner, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => tokensFile("chris/shop", dir), /not a target/);
  for (const bad of ["chris/wardrobe\n", "chris\n/wardrobe", "chris/wardrobe/x", "/wardrobe", "Chris/wardrobe", "chris /wardrobe"]) assert.throws(() => tokensFile(bad, dir), /not a target/, JSON.stringify(bad));
  assert.ok(allStoredTokens(dir).includes(b.tokens.assistant));
  removeTokens("chris/wardrobe", dir);
  assert.equal(readTokens("chris/wardrobe", dir), null);
  assert.ok(readTokens("chrisdev/wardrobe", dir), "the other target's tokens stay");
});

test("tokens: the target lock admits one run at a time, refuses a stale lock, and releases only its own", async () => {
  const dir = path.join(tmp("ferrite-lock-"), "s");
  let inside = 0;
  let max = 0;
  const body = async () => {
    inside++;
    max = Math.max(max, inside);
    await new Promise((r) => setTimeout(r, 20));
    inside--;
    return "ok";
  };
  const lock = `${tokensFile("chris/wardrobe", dir)}.lock`;
  const first = withTargetLock("chris/wardrobe", body, dir);
  // The lock is published whole: a contender never reads an empty owner record.
  assert.match(readFileSync(lock, "utf8"), new RegExp(`^${process.pid} [0-9a-f]{32}$`));
  await assert.rejects(withTargetLock("chris/wardrobe", body, dir), /is running/);
  assert.equal(await first, "ok");
  assert.equal(max, 1);
  assert.equal(existsSync(lock), false, "released");
  // A dead holder's lock is never taken over automatically: the operator removes it.
  writeFileSync(lock, "999999999 deadbeef");
  await assert.rejects(withTargetLock("chris/wardrobe", body, dir), /stale lock .* process 999999999/);
  assert.equal(readFileSync(lock, "utf8"), "999999999 deadbeef", "the stale lock is left as it was");
  rmSync(lock);
  // Release never removes a lock that is no longer this run's own.
  await withTargetLock("chris/wardrobe", async () => writeFileSync(lock, "1 someone-else"), dir);
  assert.equal(readFileSync(lock, "utf8"), "1 someone-else");
  assert.equal(readdirSync(dir).some((n) => n.endsWith(".tmp")), false, "no temporary owner records are left");
});

test("commands run asynchronously: the event loop keeps running, exits and spawn failures resolve", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const r = await spawnAsync(process.execPath, ["-e", "setTimeout(() => process.exit(3), 200)"], { cwd: DIR });
  clearInterval(timer);
  assert.equal(r.status, 3);
  assert.ok(ticks >= 5, `timers ran while the command ran (${ticks})`);
  const missing = await spawnAsync("definitely-not-a-command-xyz", [], { cwd: DIR });
  assert.equal(missing.status, null);
  assert.match(missing.error, /ENOENT/);
  const input = await spawnAsync(process.execPath, ["-e", "process.stdin.on('data', d => process.stdout.write(String(d).length + ''))"], { cwd: DIR, input: "twelve chars" });
  assert.equal(input.stdout, "12", "input reaches the command on stdin");
  const slow = await spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: DIR, timeoutMs: 100 });
  assert.equal(slow.timedOut, true, "a timeout is reported as such, so callers keep their lock");
  // A grandchild holding the output pipes is killed with its group, so the call settles at once.
  const tree = await spawnAsync(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' }); setTimeout(() => {}, 20000)"], { cwd: DIR, timeoutMs: 300 });
  assert.equal(tree.timedOut, true);
  assert.ok(tree.ms < 5000, `settled after ${tree.ms} ms`);
  // A command that closes stdin before reading it does not become an uncaught EPIPE.
  const closed = await spawnAsync(process.execPath, ["-e", "process.stdin.destroy(); setTimeout(() => process.exit(0), 50)"], { cwd: DIR, input: "x".repeat(1 << 20) });
  assert.equal(closed.status, 0);
});

test("a forced exit while holding the target lock still releases it", async () => {
  const dir = path.join(tmp("ferrite-exit-"), "s");
  const script = `import(${JSON.stringify(new URL("../lib/state.mjs", import.meta.url).href)}).then((m) => m.withTargetLock("chris/wardrobe", async () => process.exit(130), ${JSON.stringify(dir)}))`;
  const r = await spawnAsync(process.execPath, ["-e", script], { cwd: DIR });
  assert.equal(r.status, 130);
  assert.equal(existsSync(`${tokensFile("chris/wardrobe", dir)}.lock`), false);
});

test("a plain process.exit while a command is running keeps the lock and kills the command", async () => {
  const dir = path.join(tmp("ferrite-exit-running-"), "s");
  const marker = path.join(tmp("ferrite-exit-marker-"), "pid");
  const cli = JSON.stringify(new URL("../lib/cli.mjs", import.meta.url).href);
  const state = JSON.stringify(new URL("../lib/state.mjs", import.meta.url).href);
  const script = [
    `import { writeFileSync } from "node:fs";`,
    `const cli = await import(${cli}); const st = await import(${state});`,
    `await st.withTargetLock("chris/wardrobe", async () => {`,
    `  cli.spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { onChild: (c) => writeFileSync(${JSON.stringify(marker)}, String(c.pid)) });`,
    `  await new Promise((r) => setTimeout(r, 300));`,
    `  process.exit(1);`,
    `}, ${JSON.stringify(dir)});`,
  ].join("\n");
  const r = await spawnAsync(process.execPath, ["--input-type=module", "-e", script], { cwd: DIR, timeoutMs: 20_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(existsSync(`${tokensFile("chris/wardrobe", dir)}.lock`), true, "the lock stays while a remote step may be settling");
  const pid = Number(readFileSync(marker, "utf8"));
  assert.ok(pid > 0);
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((res) => setTimeout(res, 50));
    } catch {
      gone = true;
    }
  }
  assert.equal(gone, true, "the running command was killed");
});

test("a command that times out inside the lock keeps that lock, since the remote step may still be settling", async () => {
  const dir = path.join(tmp("ferrite-timeout-"), "s");
  const r = await withTargetLock("chris/wardrobe", () => spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: DIR, timeoutMs: 100 }), dir);
  assert.equal(r.timedOut, true);
  assert.equal(existsSync(`${tokensFile("chris/wardrobe", dir)}.lock`), true, "kept for the operator");
});

test("one target's lock release never touches another target's running command or lock", async () => {
  const dir = path.join(tmp("ferrite-two-"), "s");
  let started;
  const running = new Promise((r) => (started = r));
  const b = withTargetLock("other/wardrobe", async () => {
    const p = spawnAsync(process.execPath, ["-e", "setTimeout(() => process.exit(7), 600)"], { cwd: DIR, onChild: () => started() });
    return p;
  }, dir);
  await running;
  await withTargetLock("chris/wardrobe", async () => "done", dir);
  assert.equal(existsSync(`${tokensFile("chris/wardrobe", dir)}.lock`), false, "the finished target's lock is released");
  // An unrelated command outside any lock does not affect either.
  await spawnAsync(process.execPath, ["-e", ""], { cwd: DIR });
  const result = await b;
  assert.equal(result.status, 7, "the other target's command ran to completion");
  assert.equal(existsSync(`${tokensFile("other/wardrobe", dir)}.lock`), false, "and its lock was released normally");
});

test("an abort keeps only the lock of the target whose command it killed", async () => {
  const dir = path.join(tmp("ferrite-abort-"), "s");
  let started;
  const running = new Promise((r) => (started = r));
  // Target B runs a command; an unrelated command runs outside any lock; target A is idle.
  const b = withTargetLock("other/wardrobe", () => spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { cwd: DIR, onChild: () => started() }), dir);
  const unrelated = spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { cwd: DIR });
  await running;
  await withTargetLock("chris/wardrobe", async () => {
    assert.equal(abortChildren(), true);
  }, dir);
  await Promise.all([b, unrelated]);
  assert.equal(exitPolicy.keepLocks, false, "killing commands sets no process-wide policy");
  assert.equal(existsSync(`${tokensFile("chris/wardrobe", dir)}.lock`), false, "the idle target's lock is released");
  assert.equal(existsSync(`${tokensFile("other/wardrobe", dir)}.lock`), true, "the target whose command was killed keeps its lock");
});

test("echoed command output is redacted line by line, even when a secret is split across writes", async () => {
  const secret = "s3cr" + "etValue" + "X".repeat(12);
  const half = secret.length >> 1;
  const script = `process.stdout.write(${JSON.stringify("line one " + secret.slice(0, half))}); setTimeout(() => process.stdout.write(${JSON.stringify(secret.slice(half) + " end\nline two\n")}), 100);`;
  const shown = [];
  const sink = { write: (chunk) => shown.push(String(chunk)) };
  const r = await spawnAsync(process.execPath, ["-e", script], { cwd: DIR, echo: [secret], echoTo: [sink, sink] });
  const text = shown.join("");
  assert.equal(text.includes(secret), false, "the secret is not shown");
  assert.equal(text.includes(secret.slice(0, half)), false, "no half of it is shown either");
  assert.ok(text.includes("line two"));
  assert.ok(r.stdout.includes(secret), "the raw output is still returned for parsing");
  assert.equal(readFileSync(new URL("../lib/cli.mjs", import.meta.url), "utf8").includes('"inherit"'), false, "output is never passed through unredacted");
});

test("the app and its local tokens are read from the port's files", () => {
  assert.equal(appSpec().name, "wardrobe");
  const tokens = localTokens();
  assert.ok(tokens.owner && tokens.assistant);
});

test("the endpoint probe records status and error code, never the token", async () => {
  const fake = async (_url, init) => ({ status: 401, text: async () => JSON.stringify({ error: "unauthenticated", error_description: "present a Ferrite account token", echo: init.headers.authorization }) });
  const out = await probeEndpoint({ endpoint: "https://mcp.example/mcp", token: "ftok-123", fetchImpl: fake });
  assert.equal(out.status, 401);
  assert.equal(out.error, "unauthenticated");
  assert.equal(out.accountTokenRequired, true);
  assert.deepEqual(Object.keys(out).sort(), ["accountTokenRequired", "error", "ms", "probed", "status", "tokenPresented"], "no remote text in evidence");
  const odd = await probeEndpoint({ endpoint: "https://mcp.example/mcp", token: "t", fetchImpl: async () => ({ status: 400, text: async () => JSON.stringify({ error: { nested: "anything at all" } }) }) });
  assert.equal(odd.error, "unrecognised");
  const echoed = await probeEndpoint({ endpoint: "https://mcp.example/mcp", token: "t", known: ["abcsecret"], fetchImpl: async () => ({ status: 401, text: async () => JSON.stringify({ error: "abcsecret" }) }) });
  assert.equal(echoed.error, "unrecognised", "an error code equal to a known secret is never written");
  assert.equal(JSON.stringify(out).includes("ftok-123"), false);
  assert.deepEqual(await probeEndpoint({ endpoint: "" }), { probed: false, reason: "FERRITE_MCP_ENDPOINT is not set" });
});
