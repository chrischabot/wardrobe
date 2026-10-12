import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { exitPolicy } from "../lib/cli.mjs";
import { redact } from "../lib/redact.mjs";
import { balancesOf, committedWithUndo, csvSha256, evidenceValue, exactlyChanged, gatePasses, httpClient, installInterruptHandlers, keepLocksForWritesInFlight, launderableClean, lineTail, portFree, refusal, runVerification, sameInventory, verifyLocal, writesInFlight, writesUnanswered } from "../verify.mjs";
import { tokensFile } from "../lib/state.mjs";

// The verification command's tests. The shared library (CLI, state, guard) is tested in lib.test.mjs, redaction and
// origins in redact.test.mjs, and deploy/teardown in deploy.test.mjs.

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("dev output: lines are redacted whole before a tail is kept, even when a token is split across chunks", () => {
  const secret = "tok-split-across-chunks";
  const t = lineTail([secret], 3);
  t.push("line 1\nstarting with tok-spl");
  t.push("it-across-chunks done\n");
  for (let i = 0; i < 10; i++) t.push(`filler ${i}\n`);
  t.push("last tok-split-");
  t.push("across-chunks");
  const text = t.text();
  assert.equal(text.includes("tok-split") || text.includes("across-chunks"), false, text);
  assert.ok(text.includes("filler 9"));
  // A quoted credential with a line break inside it keeps its context, and a huge line without newlines stays bounded.
  const pw = "pass" + "word";
  const m = lineTail([], 10, 4096);
  m.push(`${pw}="alphaQ\nbet`);
  m.push(`aZZ" rest\n`);
  assert.equal(/alphaQ|betaZZ/.test(m.text()), false, m.text());
  const big = lineTail([], 10, 4096);
  for (let i = 0; i < 100; i++) big.push("x".repeat(1000));
  assert.ok(big.text().length <= 1501);
  // Output past the bound is not shown at all: no cut can separate a credential (quoted value, URL userinfo, known
  // secret) from the context that identifies it.
  const known = "knownSecretValue" + "Z9";
  for (const tail of [`${pw}="alphaQ\n`, "url http://u:abcQ", `token ${known.slice(0, 8)}`]) {
    const edge = lineTail([known], 50, 64);
    edge.push("y".repeat(64 - tail.length));
    edge.push(tail);
    edge.push(`\ndefZZ@host.example ${known.slice(8)} betaZZ" more\n`);
    assert.equal(/alphaQ|betaZZ|abcQ|defZZ|knownSec|Z9/.test(edge.text()), false, edge.text());
    assert.match(edge.text(), /not shown/);
  }
});

test("a write answered with a server or gateway error counts as unanswered", async () => {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/504" ? 504 : 400, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const call = httpClient(`http://127.0.0.1:${server.address().port}`);
  try {
    const before = writesUnanswered();
    await call("t", "POST", "/400", { a: 1 });
    assert.equal(writesUnanswered(), before, "an app refusal is an answer");
    await call("t", "POST", "/504", { a: 1 });
    assert.equal(writesUnanswered(), before + 1, "a gateway timeout is not");
    assert.equal(keepLocksForWritesInFlight(false), true);
  } finally {
    exitPolicy.keepLocks = false;
    server.close();
  }
});

test("verification gate: a skipped required check fails it; only not-applicable checks may be skipped", () => {
  assert.equal(gatePasses([{ status: "pass" }, { status: "not_run", required: false }]), true);
  assert.equal(gatePasses([{ status: "pass" }, { status: "not_run", required: true }]), false);
  assert.equal(gatePasses([{ status: "pass" }, { status: "not_run" }]), false, "required unless marked otherwise");
  assert.equal(gatePasses([{ status: "fail" }]), false);
  assert.equal(gatePasses([]), false);
});

test("refusals: only the error object, nothing else, and no details on a sign-in refusal", () => {
  const ok = { status: 401, json: { error: { code: "unauthenticated", message: "sign in first" } } };
  assert.ok(refusal(ok, 401, "unauthenticated"));
  assert.ok(refusal({ status: 401, json: { error: { code: "unauthenticated", message: "m", details: {} } } }, 401, "unauthenticated"), "empty details disclose nothing");
  assert.equal(refusal({ status: 401, json: { error: { code: "unauthenticated", message: "m", details: [] } } }, 401, "unauthenticated"), false, "details that are not an object");
  assert.equal(refusal({ status: 401, json: { error: { code: "unauthenticated", message: "m" }, owner: { name: "Chris" } } }, 401, "unauthenticated"), false, "data beside the error");
  assert.equal(refusal({ status: 401, json: { error: { code: "unauthenticated", message: "m", details: { balances: {} } } } }, 401, "unauthenticated"), false, "data in a sign-in refusal's details");
  assert.equal(refusal({ status: 401, json: { error: { code: "unauthenticated", message: "m", items: [] } } }, 401, "unauthenticated"), false, "an unknown error field");
  assert.ok(refusal({ status: 409, json: { error: { code: "idempotency_key_reuse", message: "m", details: { commandId: "cmd_1" } } } }, 409, "idempotency_key_reuse"));
  assert.equal(refusal({ status: 403, json: { error: { code: "forbidden", message: "m" } } }, 401, "unauthenticated"), false);
});

test("inventory comparisons: exact balance changes and identical reads", () => {
  const g = (id, clean, dirty, extra = {}) => ({ garmentId: id, category: "Shirt", careChannel: "service", quantity: 1, version: 1, balances: { clean, dirty }, ...extra });
  const before = { items: [g("a", 1, 0), g("b", 1, 0), g("c", 1, 0)], counts: { garments: 3 }, source: { sha256: "s" }, wardrobeRevision: 0 };
  const after = { ...before, items: [g("a", 0, 1), g("b", 0, 1), g("c", 1, 0)] };
  assert.ok(exactlyChanged(before, after, { a: { clean: -1, dirty: 1 }, b: { clean: -1, dirty: 1 } }));
  assert.equal(exactlyChanged(before, { ...before, items: [g("a", 0, 1), g("b", 1, 1), g("c", 1, 0)] }, { a: { clean: -1, dirty: 1 }, b: { clean: -1, dirty: 1 } }), false, "a complementary balance wrong");
  assert.equal(exactlyChanged(before, { ...after, items: [g("a", 0, 1), g("b", 0, 1), g("c", 0, 1)] }, { a: { clean: -1, dirty: 1 }, b: { clean: -1, dirty: 1 } }), false, "another garment changed");
  assert.ok(exactlyChanged(before, before));
  // A bucket named only by the expected change must move too: clean down without dirty appearing is not a mark-dirty.
  const noDirty = { ...before, items: [{ ...g("a", 1, 0), balances: { clean: 1 } }] };
  assert.equal(exactlyChanged(noDirty, { ...noDirty, items: [{ ...g("a", 0, 0), balances: { clean: 0 } }] }, { a: { clean: -1, dirty: 1 } }), false);
  assert.ok(sameInventory(before, { ...before, items: [...before.items].reverse() }));
  const other = { ...before, items: [g("x", 1, 0), g("y", 1, 0), g("z", 1, 0)] };
  assert.equal(sameInventory(before, other), false, "same count, different garments");
  assert.equal(sameInventory(before, { ...before, wardrobeRevision: 1 }), false);
  assert.equal(sameInventory(before, { ...before, source: { sha256: "t" } }), false);
});

test("verification judgements and the verify run's structure", () => {
  assert.ok(committedWithUndo({ outcome: "committed", commandId: "cmd_1", undo: { available: true }, wardrobeRevision: 1, summary: "In the wash: x" }));
  assert.equal(committedWithUndo({ outcome: "committed", commandId: "cmd_1", undo: { available: false }, wardrobeRevision: 1, summary: "s" }), false);
  const page = { items: [{ garmentId: "a", careChannel: "service", quantity: 1, balances: { clean: 1, dirty: 0 } }, { garmentId: "b", careChannel: "none", quantity: 1, balances: { clean: 1, dirty: 0 } }, { garmentId: "c", careChannel: "service", quantity: 1, balances: { clean: 0, dirty: 1 } }, { garmentId: "d", careChannel: "service", quantity: 1, balances: { clean: 1, dirty: 0 } }] };
  assert.deepEqual(launderableClean(page), ["a", "d"]);
  assert.deepEqual(balancesOf(page, "c"), { clean: 0, dirty: 1 });
  assert.match(csvSha256(), /^[0-9a-f]{64}$/);
  const src = readFileSync(path.join(DIR, "verify.mjs"), "utf8");
  assert.ok(src.includes("} finally {\n    await cleanUp();"), "every change is taken back in a finally block");
  assert.ok(src.includes("passed: gatePasses(results)"));
});

/**
 * A fake of the port's first-slice HTTP contract (test double for `ferrite dev`; the real app is exercised by
 * `verify.mjs --local --start-dev`). `foreignAfter` lets another client commit a command in the middle of the run.
 */
function fakeApp({ failReceiptList = false, foreignAfter = null, brokenIdempotency = false, staleKeySuffix = null } = {}) {
  const OWNER = "owner-token-for-the-fake-app-0001";
  const ASSISTANT = "assistant-token-for-the-fake-app-01";
  // 127 garments, 144 owned units: seventeen garments are owned twice.
  const items = Array.from({ length: 127 }, (_, i) => {
    const quantity = i >= 109 && i <= 125 ? 2 : 1;
    return { garmentId: `gmt_${String(i).padStart(3, "0")}`, category: i < 5 ? "Shirt" : "Other", careChannel: i === 126 ? "none" : "service", quantity, version: 1, balances: { clean: quantity, dirty: 0 } };
  });
  const state = { revision: 0, receipts: [], keys: new Map(), posts: 0, n: 0 };
  const commit = (type, actor, channel, apply, result) => {
    apply();
    state.revision++;
    const receipt = { commandId: `cmd_${++state.n}`, type, outcome: "committed", actor, channel, summary: `${type} done`, wardrobeRevision: state.revision, result, undo: { available: type !== "command.undo" } };
    state.receipts.unshift(receipt);
    return receipt;
  };
  const markDirty = (ids, sign) => () => ids.forEach((id) => {
    const g = items.find((x) => x.garmentId === id);
    g.balances = { clean: g.balances.clean - sign, dirty: g.balances.dirty + sign };
  });
  const err = (status, code) => [status, { error: { code, message: code, details: {} } }];
  if (staleKeySuffix) {
    // A receipt from long before this run (older than any listed page), reachable by a reused idempotency key.
    state.revision = 5;
    state.stale = { commandId: "cmd_old_1", type: "care.mark_dirty", outcome: "committed", actor: "owner", channel: "ios", summary: "old", wardrobeRevision: 3, result: { units: 1 }, undo: { available: true }, undoIds: ["gmt_101"] };
  }
  const handle = (req, body) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") return [200, { status: "ok", host: "ferrite", contractVersion: "1.1.0" }];
    const auth = /^bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const who = auth === OWNER ? "owner" : auth === ASSISTANT ? "assistant" : null;
    if (!who) return err(401, "unauthenticated");
    if (req.method === "GET" && url.pathname === "/v1/wardrobe") {
      const cat = url.searchParams.get("category");
      return [200, { items: items.filter((i) => !cat || i.category === cat).map((i) => ({ ...i, balances: { ...i.balances } })), counts: { garments: 127, ownedUnits: 144 }, source: { sha256: "f".repeat(64) }, wardrobeRevision: state.revision }];
    }
    if (req.method === "GET" && url.pathname === "/v1/commands") return failReceiptList ? err(500, "internal") : [200, { receipts: state.receipts.slice(0, Number(url.searchParams.get("limit") ?? 50)) }];
    if (req.method === "GET" && url.pathname.startsWith("/v1/commands/")) {
      const r = state.receipts.find((x) => x.commandId === decodeURIComponent(url.pathname.slice(13))) ?? (state.stale?.commandId === decodeURIComponent(url.pathname.slice(13)) ? state.stale : null);
      return r ? [200, r] : err(404, "not_found");
    }
    if (req.method !== "POST" || url.pathname !== "/v1/commands") return err(404, "not_found");
    state.posts++;
    const c = JSON.parse(body);
    if (who === "assistant" && c.authorization === "owner_tap") return err(403, "forbidden");
    if (who === "owner" && c.source?.channel === "mcp") return err(403, "forbidden");
    const { idempotencyKey, ...rest } = c;
    const stale = staleKeySuffix && idempotencyKey.endsWith(staleKeySuffix) ? { body: JSON.stringify(rest), receipt: state.stale } : null;
    const prior = stale ?? (brokenIdempotency ? null : state.keys.get(idempotencyKey));
    if (prior) return prior.body === JSON.stringify(rest) ? [200, { ...prior.receipt, replayed: true }] : err(409, "idempotency_key_reuse");
    let receipt;
    if (c.type === "care.mark_dirty") {
      if (Object.keys(c.payload).some((k) => /^\d+$/.test(k)) || c.payload.items.some((i) => i.quantity !== undefined && !Number.isInteger(i.quantity))) return err(400, "invalid_command");
      if (c.payload.items.some((i) => items.find((x) => x.garmentId === i.garmentId)?.careChannel === "none")) return err(409, "precondition_failed");
      const ids = c.payload.items.map((i) => i.garmentId);
      receipt = commit(c.type, who, c.source.channel, markDirty(ids, 1), { units: ids.length });
      receipt.undoIds = ids;
    } else if (c.type === "command.undo") {
      const t = state.receipts.find((x) => x.commandId === c.payload.commandId) ?? (state.stale?.commandId === c.payload.commandId ? state.stale : null);
      if (!t) return err(404, "not_found");
      if (!t.undo.available) return err(409, "not_undoable");
      t.undo.available = false;
      receipt = commit(c.type, who, c.source.channel, markDirty(t.undoIds, -1), { undoneCommandId: t.commandId });
    } else return err(400, "unknown_command");
    state.keys.set(idempotencyKey, { body: JSON.stringify(rest), receipt });
    if (foreignAfter && idempotencyKey.endsWith(foreignAfter) && !state.foreign) {
      // Another client (the real owner on his phone) commits a change of his own while the run is going on.
      state.foreign = commit("care.mark_dirty", "owner", "ios", markDirty(["gmt_100"], 1), { units: 1 });
      state.foreign.undoIds = ["gmt_100"];
    }
    return [200, receipt];
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const [status, json] = handle(req, body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  return { server, state, items, tokens: { owner: OWNER, assistant: ASSISTANT } };
}

async function runAgainst(app) {
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const log = console.log;
  console.log = () => {};
  try {
    return await runVerification({ origin: `http://127.0.0.1:${app.server.address().port}`, tokens: app.tokens, target: "local", runId: "t1", sourceSha256: "f".repeat(64) });
  } finally {
    console.log = log;
    await new Promise((r) => app.server.close(r));
  }
}

test("verification against a fake app: every check passes and cleanup leaves the wardrobe as it began", async () => {
  const app = fakeApp();
  const report = await runAgainst(app);
  const failed = report.results.filter((r) => r.status === "fail").map((r) => r.name);
  assert.deepEqual(failed, []);
  assert.equal(report.passed, true);
  assert.ok(app.items.every((i) => i.balances.clean === i.quantity && i.balances.dirty === 0));
  assert.ok(app.state.receipts.filter((r) => r.type !== "command.undo").every((r) => r.undo.available === false));
});

test("cleanup undoes only this run's own receipts: a command another client sent meanwhile is left alone, and the run fails honestly", async () => {
  const app = fakeApp({ foreignAfter: "-dirty" });
  const report = await runAgainst(app);
  assert.equal(app.state.foreign.undo.available, true, "the other client's command was not undone");
  assert.deepEqual(app.items.find((i) => i.garmentId === "gmt_100").balances, { clean: 0, dirty: 1 });
  const cleanup = report.results.find((r) => r.group === "cleanup");
  assert.equal(cleanup.status, "fail");
  assert.equal(cleanup.balancesRestored, false);
  assert.equal(cleanup.undoneByCleanup.some((u) => u.commandId === app.state.foreign.commandId), false);
  assert.ok(app.state.receipts.filter((r) => r !== app.state.foreign && r.type !== "command.undo").every((r) => r.undo.available === false), "every receipt of the run's own is closed");
  assert.equal(report.passed, false);
});

test("an app that breaks idempotency: cleanup still undoes the receipts the original requests were answered with", async () => {
  const app = fakeApp({ brokenIdempotency: true });
  const report = await runAgainst(app);
  assert.equal(report.results.find((r) => r.name.startsWith("the same request again")).status, "fail", "the idempotency failure is reported");
  assert.ok(app.state.receipts.filter((r) => r.type !== "command.undo").every((r) => r.undo.available === false), "every receipt the run created, originals included, is closed");
  assert.ok(app.items.every((i) => i.balances.clean === i.quantity && i.balances.dirty === 0), "the wardrobe is back as it began");
  assert.equal(report.passed, false);
});

test("a reused key that reaches a receipt from before the run (outside the listed page) is never undone", async () => {
  const app = fakeApp({ staleKeySuffix: "-dirty" });
  const report = await runAgainst(app);
  assert.equal(app.state.stale.undo.available, true, "the older receipt was not undone");
  const relay = report.results.find((r) => r.name.startsWith("the assistant relays"));
  assert.equal(relay.status, "fail", "a receipt from before the run is not accepted as this run's own");
  assert.equal(relay.ownedByRun, false);
  assert.ok(report.results.filter((r) => r.name.startsWith("the owner taps undo")).every((r) => r.status === "not_run"), "no undo is sent for it");
  const cleanup = report.results.find((r) => r.group === "cleanup");
  assert.equal(cleanup.status, "fail");
  assert.ok(cleanup.keyCollisions > 0, "the collision is reported");
  assert.equal(cleanup.undoneByCleanup.some((u) => u.commandId === "cmd_old_1"), false);
  assert.equal(report.passed, false);
});

test("the owned-unit count is taken from the garments, not only from the reported total", async () => {
  const app = fakeApp();
  app.items.forEach((i) => {
    i.quantity = 1;
    i.balances = { clean: 1, dirty: 0 };
  });
  const report = await runAgainst(app);
  const inv = report.results.find((r) => r.name.startsWith("the owner reads the imported inventory"));
  assert.equal(inv.status, "fail");
  assert.equal(inv.unitsCounted, 127);
  assert.equal(report.passed, false);
});

test("no command is sent when the starting receipt list cannot be read", async () => {
  const app = fakeApp({ failReceiptList: true });
  const report = await runAgainst(app);
  assert.equal(app.state.posts, 0, "nothing was written");
  assert.equal(report.passed, false);
  assert.ok(report.results.some((r) => r.status === "not_run" && /receipt list could not be read/.test(r.reason ?? "")));
});

test("truncation runs only on redacted text: no cut point exposes URL userinfo cut before '@' or a known secret straddling it", () => {
  const known = "knownSecretValue" + "Z9q";
  const text = `start\nfetch http://usr:abcQ\ndefZZ@host.example/x done\nkey ${known} end\n`;
  const leaks = /usr|abcQ|defZZ|knownSec|ecretVal|Z9q/;
  for (let maxChars = 1; maxChars <= text.length + 5; maxChars++) {
    const t = lineTail([known], 50);
    // Fed in pieces cut just before the '@' and inside the known secret.
    const at = text.indexOf("@");
    const mid = text.indexOf(known) + 7;
    t.push(text.slice(0, at));
    t.push(text.slice(at, mid));
    t.push(text.slice(mid));
    const out = t.text(maxChars);
    assert.equal(leaks.test(out), false, `maxChars ${maxChars}: ${out}`);
  }
  // Evidence: redaction runs on the whole detail before the evidence shape reduces it.
  const reduced = evidenceValue(redact({ reason: `see http://usr:abcQ@host and ${known}` }, [known]));
  assert.equal(leaks.test(JSON.stringify(reduced)), false, JSON.stringify(reduced));
});

test("evidence keeps only the promised fields: an unexpected remote field never reaches a file", () => {
  const privateNote = "123-Main-Street";
  assert.deepEqual(evidenceValue({ counts: { garments: 127, ownedUnits: 144, "bad key!": 1, note: "free text with spaces", privateNote }, commandId: "cmd_01HX", sourceSha256: "a".repeat(64), contractVersion: "1.1.0", reason: "our own words, kept", owner: { name: "x" } }), { counts: { garments: 127, ownedUnits: 144 }, commandId: "cmd_01HX", sourceSha256: "a".repeat(64), contractVersion: "1.1.0", reason: "our own words, kept" });
  assert.deepEqual(evidenceValue({ statuses: [200, Number.NaN, "<script>", [1]], undoneByCleanup: [{ commandId: "cmd_1", httpStatus: 200, privateNote }] }), { statuses: [200, null, "unrecognised", "unrecognised"], undoneByCleanup: [{ commandId: "cmd_1", httpStatus: 200 }] });
  // Our own text is exempt only at our own paths, never under the same key inside a remote object.
  assert.deepEqual(evidenceValue({ counts: { reason: "remote prose here", expected: "more prose" }, outcomes: [{ what: "our label", expected: "400 invalid_command" }] }), { counts: {}, outcomes: [{ what: "our label", expected: "400 invalid_command" }] });
});

test("local verification holds its own lock: a second one is refused before any request is sent", async () => {
  const app = fakeApp();
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const lockDir = mkdtempSync(path.join(tmpdir(), "ferrite-local-lock-"));
  // Another local verification (this live process) holds the lock.
  writeFileSync(`${tokensFile("local/wardrobe", lockDir)}.lock`, `${process.pid} ${"0".repeat(32)}`);
  try {
    await assert.rejects(verifyLocal({ origin: `http://127.0.0.1:${app.server.address().port}`, tokens: app.tokens, lockDir }), /is running/);
    assert.equal(app.state.posts, 0, "nothing was written");
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test("dev server: an occupied port is detected before anything starts", async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  assert.equal(await portFree(port), false);
  await new Promise((r) => server.close(r));
  assert.equal(await portFree(port), true);
  const src = readFileSync(path.join(DIR, "verify.mjs"), "utf8");
  assert.ok(src.indexOf("if (!(await portFree(port)))") < src.indexOf('spawn("ferrite"'), "refused before spawning");
  assert.ok(src.includes("ready = running()") && src.includes("child.signalCode === null"), "accepted only while the spawned process is alive, signal exits included");
});

test("verify: every error path goes through redaction, with every known secret", () => {
  for (const file of ["verify.mjs"]) {
    const src = readFileSync(path.join(DIR, file), "utf8");
    assert.equal(/console\.error\([^)]*error\.message/.test(src), false, `${file} prints a raw error message`);
    assert.ok(src.includes("redactError("), `${file} redacts its errors`);
    assert.equal(/\.message\)?\.slice\(/.test(src), false, `${file} shortens an error before redacting it`);
    assert.ok(src.includes("knownSecrets()"), `${file} uses the shared known-secret collector`);
  }
  for (const file of ["verify.mjs"]) assert.ok(readFileSync(path.join(DIR, file), "utf8").includes('process.on("unhandledRejection"'), `${file} handles unexpected errors redacted`);
});

test("a write in flight, or one left unanswered and not confirmed by cleanup, keeps the target lock", async () => {
  let release;
  const server = createServer((req, res) => {
    if (req.method === "GET") return res.end("{}");
    if (req.url === "/drop") return req.socket.destroy();
    if (req.url === "/headers-then-drop") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{\"commandId\":");
      return setTimeout(() => req.socket.destroy(), 20);
    }
    release = () => res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const call = httpClient(`http://127.0.0.1:${server.address().port}`);
  try {
    await call("t", "GET", "/");
    assert.equal(writesInFlight(), 0);
    assert.equal(keepLocksForWritesInFlight(true), false, "nothing in flight: locks are released as usual");
    assert.equal(exitPolicy.keepLocks, false);
    const pending = call("t", "POST", "/v1/commands", { a: 1 });
    for (let i = 0; i < 50 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(writesInFlight(), 1);
    assert.equal(keepLocksForWritesInFlight(true), true, "in flight: kept even when cleanup confirmed everything else");
    assert.equal(exitPolicy.keepLocks, true, "a forced exit now keeps the lock");
    release();
    await pending;
    assert.equal(writesInFlight(), 0);
    exitPolicy.keepLocks = false;
    const before = writesUnanswered();
    await assert.rejects(call("t", "POST", "/drop", { a: 1 }));
    assert.equal(writesUnanswered(), before + 1, "a write that got no answer may still commit remotely");
    await assert.rejects(call("t", "POST", "/headers-then-drop", { a: 1 }));
    assert.equal(writesUnanswered(), before + 2, "headers without the whole body are no answer either");
    assert.equal(keepLocksForWritesInFlight(true), false, "a cleanup that confirmed every own receipt resolves it");
    assert.equal(exitPolicy.keepLocks, false);
    assert.equal(keepLocksForWritesInFlight(false), true, "without that confirmation the lock is kept");
    assert.equal(exitPolicy.keepLocks, true);
  } finally {
    exitPolicy.keepLocks = false;
    server.close();
  }
});

test("the uncaught-error path keeps locks for unconfirmed writes too", () => {
  const src = readFileSync(path.join(DIR, "verify.mjs"), "utf8");
  const fail = src.slice(src.indexOf("const fail = (error) => {"), src.indexOf("process.exit(1);", src.indexOf("const fail = (error) => {")));
  assert.ok(fail.includes("keepLocksForWritesInFlight(false)"), "the fail handler keeps locks before exiting");
});

// Keep this test last: an interrupt is process-wide and stays set for the rest of the process.
test("after a SIGINT no further check or command starts, and the run is recorded as interrupted and not passed", async () => {
  const before = process.listeners("SIGINT").length;
  installInterruptHandlers();
  assert.equal(process.listeners("SIGINT").length, before + 1);
  assert.equal(process.listeners("SIGTERM").length > 0, true);
  const error = console.error;
  console.error = () => {};
  try {
    process.emit("SIGINT", "SIGINT");
  } finally {
    console.error = error;
  }
  const app = fakeApp();
  const report = await runAgainst(app);
  assert.equal(app.state.posts, 0, "no command was sent after the interrupt");
  assert.equal(report.passed, false);
  assert.ok(report.results.filter((r) => r.group !== "cleanup" && r.required !== false).every((r) => r.status === "not_run" && r.reason === "the run was interrupted"));
});
