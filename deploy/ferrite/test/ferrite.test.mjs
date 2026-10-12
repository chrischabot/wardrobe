import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exitPolicy } from "../lib/cli.mjs";
import { redact } from "../lib/redact.mjs";
import { balancesOf, cleanupUnresolved, committedWithUndo, csvSha256, evidenceValue, exactlyChanged, gatePasses, hiddenFields, authParams, invalidTokenRefusal, pkcePair, httpClient, installInterruptHandlers, keepLocksForWritesInFlight, launderableClean, lineTail, portFree, refusal, runVerification, sameInventory, verifyLocal, writesInFlight, writesUnanswered } from "../verify.mjs";
import { createHash } from "node:crypto";
import { tokensFile, withTargetLock } from "../lib/state.mjs";

// The verification command's tests. The shared library (CLI, state, guard) is tested in lib.test.mjs, redaction and
// origins in redact.test.mjs, and deploy/teardown in deploy.test.mjs.

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The position of `fragment` in `src`, asserting that it is there at all. */
const at = (src, fragment) => {
  const i = src.indexOf(fragment);
  assert.ok(i >= 0, `verify.mjs contains ${fragment}`);
  return i;
};

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
  const ledger = { writes: 0, unanswered: 0 };
  const call = httpClient(`http://127.0.0.1:${server.address().port}`, ledger);
  try {
    const before = writesUnanswered();
    await call("t", "POST", "/400", { a: 1 });
    assert.equal(writesUnanswered(), before, "an app refusal is an answer");
    await call("t", "POST", "/504", { a: 1 });
    assert.equal(writesUnanswered(), before + 1, "a gateway timeout is not");
    assert.equal(ledger.unanswered, 1, "counted in the run's own ledger too");
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
  // Two readers that serialise the same balances and counts in another key order see the same inventory.
  const ka = { items: [{ garmentId: "a", category: "Shirt", careChannel: "service", quantity: 1, version: 1, balances: { clean: 1, dirty: 0 } }], counts: { garments: 1, ownedUnits: 1 }, source: { sha256: "s" }, wardrobeRevision: 2 };
  const kb = { ...ka, counts: { ownedUnits: 1, garments: 1 }, items: [{ ...ka.items[0], balances: { dirty: 0, clean: 1 } }] };
  assert.ok(sameInventory(ka, kb), "key order of counts and balances does not matter");
  assert.equal(sameInventory(ka, { ...kb, counts: { ownedUnits: 2, garments: 1 } }), false, "values still do");
  // An ended grant's token counts as refused only with the documented invalid_token body and nothing else.
  assert.ok(invalidTokenRefusal({ status: 401, json: { error: "invalid_token", error_description: "x" } }));
  for (const bad of [{ status: 401, json: { error: "invalid_token", result: { tools: [] } } }, { status: 401, json: { error: "invalid_token", error_description: { result: { tools: [] } } } }, { status: 401, json: { jsonrpc: "2.0", id: 1, result: {} } }, { status: 401, json: null }, { status: 403, json: { error: "invalid_token" } }]) {
    assert.equal(invalidTokenRefusal(bad), false, JSON.stringify(bad));
  }
  // A grant whose end could not be confirmed keeps the target lock even when every OAuth write was answered.
  assert.equal(cleanupUnresolved([{ group: "oauth", unansweredOauth: 0, grantsUnconfirmed: true }]), true);
  assert.equal(cleanupUnresolved([{ group: "oauth", unansweredOauth: 0, grantsUnconfirmed: false }]), false);
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
 * A fake of the port's HTTP contract (test double for `ferrite dev`; the real app is exercised by
 * `verify.mjs --local --start-dev`): the first slice's API and, unless `mcp` is false, the subset of milestone 1a's
 * OAuth server and MCP endpoint the verification uses (ferrite/src/oauth.rs, ferrite/src/mcp.rs). Its metadata
 * advertises PUBLIC, another origin than the one it listens on, as a local dev secret may. `foreignAfter` lets another
 * client commit a command in the middle of the run; `leakWriteTool` offers and runs the write tool for read-only grants.
 */
const PUBLIC = "https://wardrobe.example";
function fakeApp({ failReceiptList = false, foreignAfter = null, brokenIdempotency = false, staleKeySuffix = null, mcp = true, leakWriteTool = false, breakToken = false, failFirstDisconnect = false, refreshAfterEnd = false, refreshUnavailable = false, forbiddenUnanswered = false, accessSurvivesEnd = false, readOnlyCannotRead = false, grantOnWrongToken = false, commitThenUnavailable = false } = {}) {
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
    if (mcp && (url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/oauth/") || url.pathname === "/mcp")) return oauthRoute(req, url, body);
    const auth = /^bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const who = auth === OWNER ? "owner" : auth === ASSISTANT ? "assistant" : null;
    if (!who) return err(401, "unauthenticated");
    if (req.method === "GET" && url.pathname === "/v1/wardrobe") return [200, wardrobePage(url.searchParams.get("category"))];
    if (req.method === "GET" && url.pathname === "/v1/commands") return failReceiptList ? err(500, "internal") : [200, { receipts: state.receipts.slice(0, Number(url.searchParams.get("limit") ?? 50)) }];
    if (req.method === "GET" && url.pathname.startsWith("/v1/commands/")) {
      const r = state.receipts.find((x) => x.commandId === decodeURIComponent(url.pathname.slice(13))) ?? (state.stale?.commandId === decodeURIComponent(url.pathname.slice(13)) ? state.stale : null);
      return r ? [200, r] : err(404, "not_found");
    }
    if (mcp && who === "owner" && req.method === "GET" && url.pathname === "/v1/connections") return [200, { connections: [...oauth.grants.values()].map((g) => ({ grantId: g.id, clientId: g.clientId, status: g.active ? "active" : "revoked" })) }];
    const disconnect = /^\/v1\/connections\/([^/]+)\/disconnect$/.exec(url.pathname);
    if (mcp && who === "owner" && req.method === "POST" && disconnect) {
      if (failFirstDisconnect && !oauth.failedOnce) {
        oauth.failedOnce = true;
        return err(503, "unavailable");
      }
      const g = oauth.grants.get(decodeURIComponent(disconnect[1]));
      if (!g) return err(404, "not_found");
      g.active = false;
      return [200, { grantId: g.id, status: "revoked" }];
    }
    if (req.method !== "POST" || url.pathname !== "/v1/commands") return err(404, "not_found");
    return runCommand(who, JSON.parse(body));
  };
  const wardrobePage = (cat = null) => ({ items: items.filter((i) => !cat || i.category === cat).map((i) => ({ ...i, balances: { ...i.balances } })), counts: { garments: 127, ownedUnits: 144 }, source: { sha256: "f".repeat(64) }, wardrobeRevision: state.revision });
  const runCommand = (who, c) => {
    state.posts++;
    if (who === "assistant" && c.authorization === "owner_tap") return err(403, "forbidden");
    if (who === "owner" && c.source?.channel === "mcp") {
      // A gateway that times out the first time: the original send gets no definitive answer.
      if (forbiddenUnanswered && !state.forbiddenOnce) {
        state.forbiddenOnce = true;
        return [503, "<p>gateway timeout</p>"];
      }
      return err(403, "forbidden");
    }
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
    // A gateway that loses the answer of the first mark-dirty AFTER it committed: the replay then finds the receipt.
    if (commitThenUnavailable && c.type === "care.mark_dirty" && !state.unavailableOnce) {
      state.unavailableOnce = true;
      return [503, "<p>gateway timeout</p>"];
    }
    return [200, receipt];
  };
  // The OAuth server and MCP endpoint (a subset of milestone 1a, enough for the verification's client).
  const oauth = { clients: new Set(), forms: new Set(), grants: new Map(), n: 0 };
  const hex = (n) => createHash("sha256").update(`fake-${++oauth.n}`).digest("hex").slice(0, n);
  const oerr = (status, error, headers = {}) => [status, { error, error_description: error }, headers];
  const form = (body) => Object.fromEntries(new URLSearchParams(body));
  const metadataUrl = `${PUBLIC}/.well-known/oauth-protected-resource/mcp`;
  const consentPage = (p) => {
    const issued = String(Date.now());
    const mac = hex(64);
    oauth.forms.add(`${issued}/${mac}`);
    const fields = { issued, form_mac: mac, response_type: "code", client_id: p.client_id, redirect_uri: p.redirect_uri, scope: p.scope, code_challenge: p.code_challenge, code_challenge_method: "S256", state: p.state, resource: p.resource };
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    return `<form>${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}</form>`;
  };
  const grantOf = (req) => {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    // A broken server (accessSurvivesEnd): an ended grant's access token keeps working until it is revoked itself.
    return [...oauth.grants.values()].find((g) => (g.active || (accessSurvivesEnd && !g.accessRevoked)) && g.access === t) ?? null;
  };
  const tools = (g) => [{ name: "garderobe_inventory" }, ...(g.scopes.includes("wardrobe.write") || leakWriteTool ? [{ name: "garderobe_command" }] : [])];
  const oauthRoute = (req, url, body) => {
    const p = url.pathname;
    if (req.method === "GET" && p === "/.well-known/oauth-protected-resource/mcp") return [200, { resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC], scopes_supported: ["wardrobe.read", "wardrobe.write"] }];
    if (req.method === "GET" && p === "/.well-known/oauth-authorization-server") {
      return [200, { issuer: PUBLIC, authorization_endpoint: `${PUBLIC}/oauth/authorize`, token_endpoint: `${PUBLIC}/oauth/token`, registration_endpoint: `${PUBLIC}/oauth/register`, revocation_endpoint: `${PUBLIC}/oauth/revoke`, scopes_supported: ["wardrobe.read", "wardrobe.write"], code_challenge_methods_supported: ["S256"] }];
    }
    if (req.method === "POST" && p === "/oauth/register") {
      const id = `cli_${hex(32)}`;
      oauth.clients.add(id);
      return [201, { client_id: id, token_endpoint_auth_method: "none", redirect_uris: JSON.parse(body).redirect_uris }];
    }
    if (req.method === "GET" && p === "/oauth/authorize") {
      const q = Object.fromEntries(url.searchParams);
      return oauth.clients.has(q.client_id) && q.resource === `${PUBLIC}/mcp` ? [200, consentPage(q)] : [400, "<p>Cannot connect</p>"];
    }
    if (req.method === "POST" && p === "/oauth/authorize") {
      const f = form(body);
      if (!oauth.forms.has(`${f.issued}/${f.form_mac}`)) return [400, "<p>This page expired. Nothing was granted.</p>"];
      if (f.owner_token !== OWNER) {
        // A broken server: the refused consent still creates a grant.
        if (grantOnWrongToken) {
          const id = `grt_${hex(32)}`;
          oauth.grants.set(id, { id, clientId: f.client_id, scopes: ["wardrobe.read"], active: true, access: null, refresh: null });
        }
        return [401, "<p>That owner token is not valid.</p>"];
      }
      const id = `grt_${hex(32)}`;
      const code = `wac.${id}.${hex(64)}`;
      oauth.grants.set(id, { id, clientId: f.client_id, code, challenge: f.code_challenge, scopes: f.write === "on" ? ["wardrobe.read", "wardrobe.write"] : ["wardrobe.read"], active: true, access: null, refresh: null });
      return [302, null, { location: `${f.redirect_uri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(f.state)}&iss=${encodeURIComponent(PUBLIC)}` }];
    }
    if (req.method === "POST" && p === "/oauth/token") {
      const f = form(body);
      if (breakToken) return [500, "<p>upstream error</p>"];
      if (f.grant_type === "refresh_token") {
        if (refreshUnavailable) return [503, "<p>unavailable</p>"];
        const r = oauth.grants.get(String(f.refresh_token).split(".")[1]);
        if (!r || r.refresh !== f.refresh_token || (!r.active && !refreshAfterEnd)) return oerr(400, "invalid_grant");
        // A broken server: an ended grant's refresh token still mints tokens.
        r.refresh = `wrt.${r.id}.${hex(64)}`;
        oauth.minted = (oauth.minted ?? 0) + 1;
        return [200, { access_token: `wat.${r.id}.${hex(64)}`, token_type: "Bearer", refresh_token: r.refresh, scope: r.scopes.join(" ") }];
      }
      const g = oauth.grants.get(String(f.code).split(".")[1]);
      if (!g || g.code !== f.code || createHash("sha256").update(f.code_verifier ?? "").digest("base64url") !== g.challenge || g.access) return oerr(400, "invalid_grant");
      g.access = `wat.${g.id}.${hex(64)}`;
      g.refresh = `wrt.${g.id}.${hex(64)}`;
      return [200, { access_token: g.access, token_type: "Bearer", expires_in: 900, refresh_token: g.refresh, scope: g.scopes.join(" ") }];
    }
    if (req.method === "POST" && p === "/oauth/revoke") {
      const t = form(body).token;
      for (const g of oauth.grants.values()) {
        if (g.refresh === t) g.active = false;
        if (g.access && g.access === t) {
          g.active = false;
          g.accessRevoked = true;
          oauth.revokedAccess = (oauth.revokedAccess ?? 0) + 1;
        }
      }
      return [200, {}];
    }
    if (p !== "/mcp") return oerr(404, "not_found");
    const g = grantOf(req);
    if (!g) return oerr(401, "invalid_token", { "www-authenticate": `Bearer resource_metadata="${metadataUrl}", scope="wardrobe.read"` });
    const msg = JSON.parse(body);
    if (msg.id === undefined) return [202, null];
    const ok = (result) => [200, { jsonrpc: "2.0", id: msg.id, result }];
    if (msg.method === "initialize") return ok({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "garderobe" } });
    if (msg.method === "tools/list") return ok({ tools: tools(g) });
    const { name, arguments: args = {} } = msg.params ?? {};
    if (name === "garderobe_inventory" && readOnlyCannotRead && !g.scopes.includes("wardrobe.write")) return [200, { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "read failed" } }];
    if (name === "garderobe_inventory") return ok({ structuredContent: args.view === "receipts" ? { complete: true, data: { receipts: state.receipts.slice(0, args.limit ?? 50) } } : { complete: true, data: wardrobePage() } });
    if (name === "garderobe_command") {
      if (!g.scopes.includes("wardrobe.write") && !leakWriteTool) return oerr(403, "insufficient_scope", { "www-authenticate": `Bearer error="insufficient_scope", scope="wardrobe.read wardrobe.write", resource_metadata="${metadataUrl}"` });
      const [status, json] = runCommand("assistant", { type: args.type, payload: args.payload, idempotencyKey: args.idempotencyKey, authorization: "owner_statement", source: { channel: "mcp" } });
      return ok(status === 200 ? { structuredContent: { receipt: json } } : { isError: true, content: [{ type: "text", text: JSON.stringify(json) }] });
    }
    return [200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } }];
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const [status, out, headers = {}] = handle(req, body);
      if (out === null) {
        res.writeHead(status, headers);
        return res.end();
      }
      res.writeHead(status, { "content-type": typeof out === "string" ? "text/html" : "application/json", ...headers });
      res.end(typeof out === "string" ? out : JSON.stringify(out));
    });
  });
  return { server, state, items, oauth, tokens: { owner: OWNER, assistant: ASSISTANT } };
}

async function runAgainst(app) {
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const log = console.log;
  console.log = () => {};
  try {
    return await runVerification({ origin: `http://127.0.0.1:${app.server.address().port}`, tokens: app.tokens, target: "local", runId: "t1", sourceSha256: "f".repeat(64), publicOrigin: PUBLIC });
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
  // OAuth and MCP ran as a client would, and every grant the run obtained was ended.
  for (const group of ["oauth", "mcp", "scopes"]) assert.ok(report.results.some((r) => r.group === group && r.status === "pass"), group);
  assert.equal(app.oauth.grants.size, 2);
  assert.ok([...app.oauth.grants.values()].every((g) => !g.active), "every grant of the run is ended");
  assert.ok(app.state.receipts.some((r) => r.channel === "mcp" && r.type === "care.mark_dirty" && r.actor === "assistant"), "a write went through the MCP tool");
  // No OAuth code or token reaches the report (the evidence file is this report).
  const text = JSON.stringify(report);
  for (const g of app.oauth.grants.values()) for (const secret of [g.code, g.access, g.refresh]) assert.equal(text.includes(secret.split(".")[2]), false);
});

test("a read-only grant that is offered and allowed the write tool fails the scope check; its write is still taken back", async () => {
  const app = fakeApp({ leakWriteTool: true });
  const report = await runAgainst(app);
  const scope = report.results.find((r) => r.group === "scopes");
  assert.equal(scope.status, "fail");
  assert.ok(scope.tools.includes("garderobe_command"));
  assert.equal(report.passed, false);
  assert.ok(app.items.every((i) => i.balances.clean === i.quantity && i.balances.dirty === 0), "the leaked write was undone by cleanup");
  assert.equal(report.results.find((r) => r.group === "cleanup").status, "pass");
});

test("a read-only grant that cannot actually read fails the scope check", async () => {
  const app = fakeApp({ readOnlyCannotRead: true });
  const report = await runAgainst(app);
  assert.equal(report.results.find((r) => r.group === "scopes").status, "fail");
  assert.equal(report.passed, false);
});

test("an ended grant whose refresh token still mints tokens fails the grant-ending check", async () => {
  const app = fakeApp({ refreshAfterEnd: true });
  const report = await runAgainst(app);
  const end = report.results.find((r) => r.name.startsWith("the run's OAuth grants end"));
  assert.equal(end.status, "fail");
  assert.ok(end.grants.every((g) => g.refreshRefused === false));
  assert.equal(app.oauth.minted, 2);
  assert.equal(report.passed, false);
});

test("grants the consent created are ended even when the token exchange fails", async () => {
  const app = fakeApp({ breakToken: true });
  const report = await runAgainst(app);
  assert.equal(report.passed, false);
  assert.equal(app.oauth.grants.size, 2);
  assert.ok([...app.oauth.grants.values()].every((g) => !g.active), "every grant the consent created is ended");
  const end = report.results.find((r) => r.name.startsWith("the run's OAuth grants end"));
  // The exchanges were answered with a server error: they may still mint tokens, so the check fails and the lock stays.
  assert.equal(end.unansweredOauth, 2);
  assert.equal(end.status, "fail");
  const { cleanupUnresolved } = await import("../verify.mjs");
  assert.equal(cleanupUnresolved(report.results), true, "the unanswered OAuth writes keep the target lock");
});

test("a refresh probe answered with a server error counts as an unanswered OAuth write and keeps the lock", async () => {
  const app = fakeApp({ refreshUnavailable: true });
  const report = await runAgainst(app);
  const end = report.results.find((r) => r.name.startsWith("the run's OAuth grants end"));
  assert.equal(end.status, "fail");
  assert.equal(end.unansweredOauth, 2);
  const { cleanupUnresolved } = await import("../verify.mjs");
  assert.equal(cleanupUnresolved(report.results), true);
});

test("a replay refused for a request whose original send got no definitive answer leaves cleanup unresolved and keeps the lock", async () => {
  const app = fakeApp({ forbiddenUnanswered: true });
  const report = await runAgainst(app);
  const c = report.results.find((r) => r.group === "cleanup");
  assert.equal(c.status, "fail");
  assert.ok(c.unresolvedReplays >= 1, "the refused replay does not settle the unanswered original");
  const { cleanupUnresolved } = await import("../verify.mjs");
  assert.equal(cleanupUnresolved(report.results), true);
});

test("a send that committed but was answered 503 is undone through its replayed receipt, yet stays unresolved and keeps the lock", async () => {
  const app = fakeApp({ commitThenUnavailable: true });
  const report = await runAgainst(app);
  const c = report.results.find((r) => r.group === "cleanup");
  assert.equal(c.status, "fail", "a receipt from the replay does not prove the unanswered send settled");
  assert.ok(c.unresolvedReplays >= 1);
  assert.ok(app.state.receipts.filter((r) => r.type !== "command.undo").every((r) => r.undo.available === false), "the committed receipt was still undone");
  assert.ok(app.items.every((i) => i.balances.clean === i.quantity && i.balances.dirty === 0), "the wardrobe is back as it began");
  const { cleanupUnresolved } = await import("../verify.mjs");
  assert.equal(cleanupUnresolved(report.results), true);
  assert.equal(report.passed, false);
});

test("a grant whose access token still works after it was ended is ended every other way and probed again; the check still fails", async () => {
  const app = fakeApp({ accessSurvivesEnd: true });
  const report = await runAgainst(app);
  const end = report.results.find((r) => r.name.startsWith("the run's OAuth grants end"));
  assert.equal(end.status, "fail");
  assert.ok(end.grants.every((g) => g.tokenRefused === false && g.retryRefused === true), "the retry revoked the surviving tokens");
  assert.ok(app.oauth.revokedAccess >= 1, "the access token itself was revoked");
});

test("a failed disconnect falls back to revocation so the grant still ends, but the grant-ending check fails", async () => {
  const app = fakeApp({ failFirstDisconnect: true });
  const report = await runAgainst(app);
  assert.ok([...app.oauth.grants.values()].every((g) => !g.active), "both grants ended");
  const end = report.results.find((r) => r.name.startsWith("the run's OAuth grants end"));
  assert.equal(end.status, "fail", "a fallback never turns a failed primary into a pass");
  assert.ok(end.unansweredOauth > 0, "the 503 disconnect is an unanswered OAuth write");
  const { cleanupUnresolved } = await import("../verify.mjs");
  assert.equal(cleanupUnresolved(report.results), true, "the target lock is kept");
  assert.equal(end.grants[0].endedBy, "owner_disconnect");
  assert.equal(end.grants[0].httpStatus, 503);
  assert.equal(end.grants[0].fallbackStatus, 200);
  assert.equal(end.grants[1].fallbackStatus, null);
});

test("a consent refused for a wrong owner token that still creates a grant fails the refusal check, and the grant is ended", async () => {
  const app = fakeApp({ grantOnWrongToken: true });
  const report = await runAgainst(app);
  const refusal = report.results.find((r) => r.name.startsWith("the consent page refuses"));
  assert.equal(refusal.status, "fail");
  assert.equal(refusal.items, 1);
  assert.ok([...app.oauth.grants.values()].every((g) => !g.active), "the wrongly created grant is ended too");
  assert.equal(report.passed, false);
});

test("an app that does not serve MCP: the OAuth and MCP checks are not run, which fails the gate", async () => {
  const app = fakeApp({ mcp: false });
  const report = await runAgainst(app);
  const discovery = report.results.find((r) => r.group === "oauth");
  assert.equal(discovery.status, "not_run");
  assert.equal(discovery.required, true);
  assert.ok(report.results.filter((r) => r.group === "mcp" || r.group === "scopes").every((r) => r.status === "not_run"));
  assert.equal(report.passed, false);
  assert.ok(app.items.every((i) => i.balances.clean === i.quantity && i.balances.dirty === 0));
});

test("OAuth helpers: consent form fields, challenge parameters and PKCE", () => {
  assert.deepEqual(hiddenFields('<form><input type="hidden" name="issued" value="17"><input type="hidden" name="state" value="a&amp;b&quot;c"><input type="password" name="owner_token"></form>'), { issued: "17", state: 'a&b"c' });
  assert.deepEqual(authParams('Bearer error="insufficient_scope", scope="wardrobe.read wardrobe.write", resource_metadata="https://w.example/.well-known/oauth-protected-resource/mcp"'), { error: "insufficient_scope", scope: "wardrobe.read wardrobe.write", resource_metadata: "https://w.example/.well-known/oauth-protected-resource/mcp" });
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
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
    rmSync(lockDir, { recursive: true, force: true });
  }
});

test("each run keeps its own write ledger: an earlier unanswered write or another run's write in flight does not hold a clean run's lock", async () => {
  const gateway = createServer((req, res) => {
    if (req.url === "/slow") return setTimeout(() => res.end("{}"), 300);
    res.writeHead(504);
    res.end();
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const other = httpClient(`http://127.0.0.1:${gateway.address().port}`);
  let slow = null;
  try {
    await other("t", "POST", "/x", { a: 1 });
    assert.ok(writesUnanswered() > 0, "the process tally holds an earlier unanswered write");
    const report = await runAgainst(fakeApp());
    slow = other("t", "POST", "/slow", { a: 1 });
    assert.equal(writesInFlight(), 1, "another client's write is in flight");
    assert.equal(report.unansweredWrites, 0);
    assert.deepEqual(report.ledger, { writes: 0, unanswered: 0 });
    assert.equal(keepLocksForWritesInFlight(false, report.ledger), false, "the clean run is judged by its own writes");
    assert.equal(exitPolicy.keepLocks, false);
  } finally {
    await slow;
    gateway.close();
  }
});

test("a finished run's unresolved write keeps only the lock it runs under, never another target's", async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "ferrite-run-lock-")), "s");
  try {
    await withTargetLock("a/wardrobe", async () => {
      assert.equal(keepLocksForWritesInFlight(false, { writes: 0, unanswered: 1 }), true);
    }, dir);
    assert.equal(exitPolicy.keepLocks, false, "the process-wide flag is untouched");
    await withTargetLock("b/wardrobe", async () => "clean", dir);
    assert.equal(existsSync(`${tokensFile("a/wardrobe", dir)}.lock`), true, "the unresolved run's lock is kept");
    assert.equal(existsSync(`${tokensFile("b/wardrobe", dir)}.lock`), false, "a later clean run's lock is released");
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
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
  assert.ok(at(src, "if (!(await portFree(port)))") < at(src, 'spawn("ferrite"'), "refused before spawning");
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

test("a cleanup that left a write unresolved keeps the target lock even when every write was answered", async () => {
  const { cleanupUnresolved } = await import("../verify.mjs");
  assert.equal(cleanupUnresolved([{ group: "cleanup", status: "fail", unresolvedReplays: 1, ownReceiptsStillOpen: 0 }]), true, "a replay with an unusable answer");
  assert.equal(cleanupUnresolved([{ group: "cleanup", status: "fail", unresolvedReplays: 0, ownReceiptsStillOpen: 1 }]), true, "an own receipt still open");
  assert.equal(cleanupUnresolved([{ group: "cleanup", status: "fail", reason: "cleanup raised an error" }]), true);
  assert.equal(cleanupUnresolved([{ group: "cleanup", status: "fail", unresolvedReplays: 0, ownReceiptsStillOpen: 0, balancesRestored: false }]), false, "only a foreign change: everything of ours is settled");
  assert.equal(cleanupUnresolved([{ group: "cleanup", status: "pass" }]), false);
  assert.equal(cleanupUnresolved([{ group: "cleanup", status: "pass" }, { group: "oauth", status: "fail", unansweredOauth: 1 }]), true, "an unanswered OAuth write");
  const src = readFileSync(path.join(DIR, "verify.mjs"), "utf8");
  assert.ok(src.includes("} else if (cleanupUnresolved(report.results)) {\n    // Every write was answered") && src.includes("keepThisLock();\n    report.passed = false;\n    report.lockKept = \"cleanup left"), "verifyAndRecord keeps the lock for it");
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
