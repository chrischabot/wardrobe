/**
 * Static checks of the Codex plugin package (no network, no Codex needed):
 *   node --test integrations/codex/test/plugin.test.mjs
 *
 * They pin the package to what Codex 0.162.1 actually loads (see README "Codex format"), and keep the
 * plugin's skill in step with the server: the tool names come from the published contract and the routine
 * actions from the API Worker's allow-list, read from their source files.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkMcpUrl, retarget } from "../scripts/retarget.mjs";
import { adoptAfterWrite, authorizationUrlFrom, balancesState, boardState, cleanLaundered, movedToDirty, ownerDay, sameWear, unchangedAfterUnapplied, versionsOf, within, writeDecision } from "../scripts/board-guard.mjs";
import { ferriteConsent, formAction, hiddenFields } from "../scripts/ferrite-consent.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(ROOT, "../..");
const json = (p) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));
const skill = readFileSync(path.join(ROOT, "plugin/skills/wardrobe/SKILL.md"), "utf8");

test("the marketplace lists the plugin with the fields Codex requires", () => {
  const m = json(".agents/plugins/marketplace.json");
  assert.equal(m.name, "wardrobe-codex");
  assert.equal(m.plugins.length, 1);
  const [entry] = m.plugins;
  assert.equal(entry.name, "wardrobe");
  assert.deepEqual(entry.source, { source: "local", path: "./plugin" });
  assert.ok(entry.policy.installation && entry.policy.authentication && entry.category);
  assert.ok(existsSync(path.join(ROOT, entry.source.path, "plugin.json")));
});

test("the portable manifest identifies the plugin", () => {
  const p = json("plugin/plugin.json");
  assert.equal(p.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(p.name, "wardrobe");
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
  assert.ok(p.description.length > 20);
  assert.equal(p.extensions["com.openai"].interface.displayName, "Wardrobe");
});

test("mcp.json declares one streamable HTTP server with only the fields Codex 0.162.1 accepts", () => {
  const m = json("plugin/mcp.json");
  assert.equal(m.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(Object.keys(m.mcpServers), ["wardrobe"]);
  // Codex 0.162.1 silently drops a server that carries any other field (for example extensions.com.openai.auth).
  assert.deepEqual(Object.keys(m.mcpServers.wardrobe).sort(), ["type", "url"]);
  assert.equal(m.mcpServers.wardrobe.type, "streamable-http");
  assert.ok(new URL(m.mcpServers.wardrobe.url).pathname.endsWith("/mcp"));
  assert.equal(checkMcpUrl(m.mcpServers.wardrobe.url), m.mcpServers.wardrobe.url);
});

test("the skill has a name and description and names only tools the server publishes", () => {
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(front, "frontmatter with name and description");
  assert.equal(front[1], "wardrobe");
  const contract = readFileSync(path.join(REPO, "packages/contracts/src/ext/api.ts"), "utf8");
  const published = JSON.parse(/MCP_TOOL_NAMES = (\[[^\]]+\])/.exec(contract)[1]);
  const named = [...new Set(skill.match(/garderobe_[a-z]+/g))].sort();
  assert.deepEqual(named, [...published].sort());
});

test("the skill's routine actions are ones the server runs directly, and it defers every other decision to the server's answer", () => {
  const routineLine = skill.split("\n").find((l) => l.startsWith("- **Applied:**"));
  assert.ok(routineLine, "the skill describes applied changes");
  const inSkill = [...routineLine.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((m) => m[1]).filter((t) => t !== "command.undo").sort();
  assert.deepEqual(inSkill, ["board.select", "laundry.collect", "laundry.return", "stock.pack", "stock.unpack"]);
  // The server's typed-command policy (2026-10-05 contract) classifies every change with the assistant's
  // classifyChange: only the section 3 types wait for the owner and restriction lifts are refused. Every
  // parse below must succeed: if the policy's shape changes, this test fails instead of silently passing.
  const policy = readFileSync(path.join(REPO, "apps/worker/src/mcp/policy.ts"), "utf8");
  assert.match(policy, /forbiddenForConnectedAssistant\(type, payload\)/, "policy.ts no longer refuses restriction lifts through forbiddenForConnectedAssistant: update this test to the new policy");
  assert.match(policy, /classifyChange\(type, payload, "mcp"\) === "confirm" \? "owner" : "direct"/, "policy.ts no longer decides through classifyChange: update this test to the new policy");
  const classes = readFileSync(path.join(REPO, "packages/assistant/src/policy/classes.ts"), "utf8");
  const setOf = (name) => {
    const m = new RegExp(`export const ${name}: ReadonlySet<string> = new Set\\(\\[([^\\]]*)\\]\\)`).exec(classes);
    assert.ok(m, `could not parse ${name} in packages/assistant/src/policy/classes.ts: update this test to the new policy`);
    const types = [...m[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((t) => t[1]);
    assert.ok(types.length > 0, `${name} parsed as empty`);
    return new Set(types);
  };
  const waits = setOf("SECTION3_CONFIRM_TYPES");
  const refused = setOf("RESTRICTION_LIFT_TYPES");
  assert.ok(refused.has("restriction.resolve"), "restriction.resolve is refused for a connected assistant");
  for (const t of inSkill) {
    assert.ok(!waits.has(t), `${t} waits for the owner on the server, but the skill calls it applied`);
    assert.ok(!refused.has(t), `${t} is refused on the server, but the skill calls it applied`);
  }
  assert.match(skill, /confirmation_required/);
  assert.match(skill, /Only ask for a change the owner asked for/);
  assert.match(skill, /restriction can never be lifted/);
  assert.match(skill, /Never infer one/);
  // No blanket rule that every other change waits: which changes wait is the server's decision.
  assert.doesNotMatch(skill, /Everything else/);
});

test("the package contains no credentials", () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /sk-(proj-)?[A-Za-z0-9_-]{16,}/, file);
    assert.doesNotMatch(text, /Bearer [A-Za-z0-9._-]{20,}/, file);
    assert.doesNotMatch(text, /client_secret"\s*:/, file);
  }
});

test("retarget writes a copy pointing at another deployment and leaves the package unchanged", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wardrobe-codex-retarget-"));
  const out = path.join(dir, "hosted");
  try {
    const before = readFileSync(path.join(ROOT, "plugin/mcp.json"), "utf8");
    retarget("https://wardrobe-mcp.example.org/mcp", out);
    const copy = JSON.parse(readFileSync(path.join(out, "plugin/mcp.json"), "utf8"));
    assert.equal(copy.mcpServers.wardrobe.url, "https://wardrobe-mcp.example.org/mcp");
    assert.deepEqual(Object.keys(copy.mcpServers.wardrobe).sort(), ["type", "url"]);
    assert.ok(existsSync(path.join(out, ".agents/plugins/marketplace.json")));
    assert.ok(existsSync(path.join(out, "plugin/skills/wardrobe/SKILL.md")));
    assert.equal(readFileSync(path.join(ROOT, "plugin/mcp.json"), "utf8"), before);
    assert.throws(() => retarget("https://wardrobe-mcp.example.org/mcp", out), /already exists/);
    assert.throws(() => retarget("https://wardrobe-mcp.example.org/mcp", path.join(ROOT, "tmp-out")), /outside the committed package/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retarget refuses unsafe MCP URLs", () => {
  assert.throws(() => checkMcpUrl("http://wardrobe.example.org/mcp"), /https/);
  assert.throws(() => checkMcpUrl("https://user:pw@wardrobe.example.org/mcp"), /credentials/);
  assert.throws(() => checkMcpUrl("https://wardrobe.example.org/mcp?token=x"), /query/);
  assert.throws(() => checkMcpUrl("ftp://wardrobe.example.org/mcp"), /http/);
  assert.throws(() => checkMcpUrl("not a url"), /absolute/);
  assert.throws(() => checkMcpUrl("https://wardrobe.example.org"), /ending in \/mcp/);
  assert.throws(() => checkMcpUrl("https://wardrobe.example.org/api"), /ending in \/mcp/);
  assert.equal(checkMcpUrl("https://wardrobe.example.org/garderobe/mcp"), "https://wardrobe.example.org/garderobe/mcp");
  assert.equal(checkMcpUrl("http://127.0.0.1:8787/mcp"), "http://127.0.0.1:8787/mcp");
});

// Synthetic boards (labelled test data, not owner data) for the verifier's write guard.
const syntheticBoard = (overrides = {}) => ({
  boardId: "brd_synthetic",
  revision: 3,
  selection: null,
  options: [
    { optionId: "opt_a", garments: [{ role: "top", garmentId: "g_top_1" }, { role: "bottom", garmentId: "g_bottom_1" }] },
    { optionId: "opt_b", garments: [{ role: "top", garmentId: "g_top_2" }, { role: "bottom", garmentId: "g_bottom_2" }] },
  ],
  ...overrides,
});

test("write guard: an unchanged board without the owner's choice may be written, with its observed version", () => {
  const seen = syntheticBoard();
  assert.deepEqual(writeDecision({ hosted: true, lastSeen: seen, current: syntheticBoard() }), { ok: true });
  assert.deepEqual(versionsOf(seen), { "board:brd_synthetic": 3 });
});

test("write guard: the verifier refuses to write when the board changed between steps", () => {
  const seen = syntheticBoard();
  // The owner chose an option between the verifier's steps (the revision moves with it).
  const ownerChose = syntheticBoard({ revision: 4, selection: { optionId: "opt_b", footwearGarmentId: null } });
  const chose = writeDecision({ hosted: true, lastSeen: seen, current: ownerChose });
  assert.equal(chose.ok, false);
  assert.match(chose.reason, /changed between steps \(revision 3 -> 4\)/);
  // The owner edited the board (a piece swapped in the app): refused even on the local Worker.
  const edited = syntheticBoard({ revision: 4, options: [{ optionId: "opt_a", garments: [{ role: "top", garmentId: "g_top_9" }] }] });
  assert.equal(writeDecision({ hosted: false, lastSeen: seen, current: edited }).ok, false);
  // A newly published board replaced the one the verifier was working on.
  assert.match(writeDecision({ hosted: false, lastSeen: seen, current: syntheticBoard({ boardId: "brd_other" }) }).reason, /different board/);
  // The board could not be read just before the write.
  assert.equal(writeDecision({ hosted: false, lastSeen: seen, current: null }).ok, false);
  // A read without a usable revision cannot protect a write, even when the previous read also lacked one.
  assert.match(writeDecision({ hosted: false, lastSeen: syntheticBoard({ revision: undefined }), current: syntheticBoard({ revision: undefined }) }).reason, /no usable revision/);
  assert.throws(() => versionsOf(syntheticBoard({ revision: undefined })), /no usable board version/);
  // And the undo of the verifier's own change stops too when the owner changed the board after it.
  assert.equal(writeDecision({ hosted: true, lastSeen: seen, current: syntheticBoard({ revision: 5 }), ownWrite: true }).ok, false);
});

test("write guard: on the owner's real board a choice the owner made is never written over", () => {
  const chosen = syntheticBoard({ selection: { optionId: "opt_a", footwearGarmentId: null } });
  const decision = writeDecision({ hosted: true, lastSeen: chosen, current: chosen });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /owner has chosen option opt_a/);
  // Locally the board is the run's own; taking back the verifier's own choice is allowed at the same revision.
  assert.equal(writeDecision({ hosted: false, lastSeen: chosen, current: chosen }).ok, true);
  assert.equal(writeDecision({ hosted: true, lastSeen: chosen, current: chosen, ownWrite: true }).ok, true);
});

test("after its own write the verifier adopts the board only when it shows exactly that write", () => {
  const before = syntheticBoard();
  const receipt = { commandId: "cmd_synthetic", affected: [{ kind: "board", id: "brd_synthetic", version: 4 }] };
  const chose = (b) => b.selection?.optionId === "opt_b";
  const afterOwn = syntheticBoard({ revision: 4, selection: { optionId: "opt_b", footwearGarmentId: null } });
  assert.deepEqual(adoptAfterWrite({ before, after: afterOwn, receipt, expect: chose }), { ok: true });
  // The owner changed the board right after the verifier's write: the revision is past the one the receipt names.
  const ownerAfter = syntheticBoard({ revision: 5, selection: { optionId: "opt_a", footwearGarmentId: null } });
  assert.match(adoptAfterWrite({ before, after: ownerAfter, receipt, expect: chose }).reason, /revision 5, not 4/);
  // Right revision but not the expected state, a missing read, a receipt without the board, another board.
  assert.equal(adoptAfterWrite({ before, after: syntheticBoard({ revision: 4 }), receipt, expect: chose }).ok, false);
  assert.equal(adoptAfterWrite({ before, after: null, receipt, expect: chose }).ok, false);
  assert.equal(adoptAfterWrite({ before, after: afterOwn, receipt: { affected: [] }, expect: chose }).ok, false);
  assert.equal(adoptAfterWrite({ before, after: { ...afterOwn, boardId: "brd_other" }, receipt, expect: chose }).ok, false);
  // A baseline that could not be adopted stops every later write.
  assert.match(writeDecision({ hosted: false, lastSeen: { refused: "owner changed it" }, current: afterOwn, ownWrite: true }).reason, /owner changed it/);
});

test("the owner's tomorrow is the next calendar date, also across daylight-saving changes", () => {
  // Europe/London springs forward at 01:00 UTC on 2026-03-29 (a 23-hour day): at 23:30 on the 28th, 24 hours later
  // would already be the 30th.
  assert.equal(ownerDay(new Date("2026-03-28T23:30:00Z"), "Europe/London", 1), "2026-03-29");
  // It falls back at 01:00 UTC on 2026-10-25 (a 25-hour day): at 00:30 BST on the 25th, 24 hours later is still the 25th.
  assert.equal(ownerDay(new Date("2026-10-24T23:30:00Z"), "Europe/London", 1), "2026-10-26");
  // The owner's day, not UTC's: 23:30 UTC on 2026-06-30 is already 1 July in Tokyo.
  assert.equal(ownerDay(new Date("2026-06-30T23:30:00Z"), "Asia/Tokyo", 1), "2026-07-02");
  // Month and year ends.
  assert.equal(ownerDay(new Date("2026-12-31T12:00:00Z"), "Europe/London", 1), "2027-01-01");
});

test("board state compares the board, the choice and every option's pieces, but not the revision", () => {
  assert.equal(boardState(syntheticBoard()), boardState(syntheticBoard({ revision: 9 })));
  assert.notEqual(boardState(syntheticBoard()), boardState(syntheticBoard({ selection: { optionId: "opt_a" } })));
  const otherPiece = syntheticBoard();
  otherPiece.options[1].garments[0].garmentId = "g_top_9";
  assert.notEqual(boardState(syntheticBoard()), boardState(otherPiece));
});

test("a wait that never settles is bounded by its deadline or by the process ending", async () => {
  const never = new Promise(() => undefined);
  await assert.rejects(within(never, 20, "consent did not finish"), /consent did not finish/);
  await assert.rejects(within(never, 10_000, "consent did not finish", Promise.resolve(0)), /the process ended first/);
  await assert.rejects(within(never, 10_000, "consent did not finish", Promise.reject(new Error("spawn failed"))), /the process ended first/);
  assert.equal(await within(Promise.resolve("ok"), 10_000, "unused"), "ok");
  await assert.rejects(within(Promise.reject(new Error("denied")), 10_000, "unused"), /denied/);
});

// A stand-in for the Ferrite app's consent endpoints (test double, not the app): GET answers a consent page in the
// markup ferrite/src/oauth.rs writes; POST accepts only a form carrying the issued/form_mac it handed out.
function fakeFerrite({ getStatus = 200, withMac = true, postStatus = 302 } = {}) {
  const requests = [];
  const origin = "http://127.0.0.1:8790";
  const hidden = (n, v) => `<input type="hidden" name="${n}" value="${v}">`;
  const html = `<form method="post" action="${origin}/oauth/authorize">${withMac ? hidden("issued", "1791800000000") + hidden("form_mac", "ab12") : ""}${hidden("response_type", "code")}${hidden("client_id", "cl_1")}${hidden("redirect_uri", "http://127.0.0.1:1455/callback")}${hidden("state", "s&amp;1")}<input type="password" name="owner_token"></form>`;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? "GET", body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
    if ((init.method ?? "GET") === "GET") return { status: getStatus, text: async () => html, headers: new Headers() };
    const b = Object.fromEntries(new URLSearchParams(init.body));
    const ok = postStatus === 302 && b.issued === "1791800000000" && b.form_mac === "ab12";
    return { status: ok ? 302 : 400, text: async () => "", headers: new Headers(ok ? { location: "http://127.0.0.1:1455/callback?code=wac.grt_1.x&state=s%261" } : {}) };
  };
  return { fetchImpl, requests, authUrl: `${origin}/oauth/authorize?response_type=code&client_id=cl_1` };
}

const APP = "http://127.0.0.1:8790";

test("Ferrite consent: the form is fetched first and its issued/form_mac fields are posted back with the owner's decision", async () => {
  const f = fakeFerrite();
  const callback = await ferriteConsent(f.authUrl, { appOrigin: APP, ownerToken: "owner-secret", fetchImpl: f.fetchImpl });
  assert.equal(callback.toString(), "http://127.0.0.1:1455/callback?code=wac.grt_1.x&state=s%261");
  assert.deepEqual(f.requests.map((r) => r.method), ["GET", "POST"]);
  assert.equal(f.requests[0].url, f.authUrl);
  assert.equal(f.requests[1].url, "http://127.0.0.1:8790/oauth/authorize");
  const posted = f.requests[1].body;
  assert.equal(posted.issued, "1791800000000");
  assert.equal(posted.form_mac, "ab12");
  assert.equal(posted.client_id, "cl_1");
  assert.equal(posted.state, "s&1");
  assert.equal(posted.owner_token, "owner-secret");
  assert.equal(posted.decision, "allow");
  assert.equal(posted.write, "on");
  // Read-only consent leaves "Make changes" off.
  const ro = fakeFerrite();
  await ferriteConsent(ro.authUrl, { appOrigin: APP, ownerToken: "owner-secret", write: false, fetchImpl: ro.fetchImpl });
  assert.equal(ro.requests[1].body.write, undefined);
});

test("Ferrite consent fails without the server-issued fields, on a refused form or without an owner token, never echoing the token", async () => {
  const noMac = fakeFerrite({ withMac: false });
  await assert.rejects(ferriteConsent(noMac.authUrl, { appOrigin: APP, ownerToken: "owner-secret", fetchImpl: noMac.fetchImpl }), /issued\/form_mac/);
  assert.equal(noMac.requests.length, 1, "nothing is posted without the issued form");
  const page404 = fakeFerrite({ getStatus: 404 });
  await assert.rejects(ferriteConsent(page404.authUrl, { appOrigin: APP, ownerToken: "owner-secret", fetchImpl: page404.fetchImpl }), /answered 404/);
  const refused = fakeFerrite({ postStatus: 400 });
  await assert.rejects(ferriteConsent(refused.authUrl, { appOrigin: APP, ownerToken: "owner-secret", fetchImpl: refused.fetchImpl }), (e) => /not accepted: 400/.test(e.message) && !e.message.includes("owner-secret"));
  await assert.rejects(ferriteConsent(refused.authUrl, { appOrigin: APP, ownerToken: "", fetchImpl: refused.fetchImpl }), /WARDROBE_OWNER_TOKEN/);
  // A discovered authorization URL on any other origin never receives a request, let alone the owner token.
  const elsewhere = fakeFerrite();
  await assert.rejects(
    ferriteConsent(elsewhere.authUrl, { appOrigin: "https://wardrobe.example", ownerToken: "owner-secret", fetchImpl: elsewhere.fetchImpl }),
    (e) => /not on the Ferrite app's origin/.test(e.message) && !e.message.includes("owner-secret"),
  );
  assert.equal(elsewhere.requests.length, 0, "nothing is fetched from an authorization server on another origin");
  const noOrigin = fakeFerrite();
  await assert.rejects(ferriteConsent(noOrigin.authUrl, { ownerToken: "owner-secret", fetchImpl: noOrigin.fetchImpl }), /no app origin/);
  assert.equal(noOrigin.requests.length, 0);
  // The form must post to the page's own origin.
  assert.throws(() => formAction('<form method="post" action="https://evil.example/oauth/authorize">', new URL("http://127.0.0.1:8790/oauth/authorize?x=1")), /another origin/);
  assert.deepEqual(hiddenFields('<input type="hidden" name="a" value="&lt;b&gt;&amp;&quot;&#39;">'), { a: `<b>&"'` });
});

test("care round trip helpers: pick a clean single laundered garment and require exactly one unit moved", () => {
  // Synthetic inventory items (labelled test data, not owner data).
  const items = [
    { garmentId: "g_shoe", careChannel: "none", quantity: 1, balances: { clean: 1, dirty: 0 } },
    { garmentId: "g_pair", careChannel: "service", quantity: 2, balances: { clean: 2, dirty: 0 } },
    { garmentId: "g_worn", careChannel: "service", quantity: 1, balances: { clean: 0, dirty: 1 } },
    { garmentId: "g_shirt", careChannel: "service", quantity: 1, balances: { clean: 1, dirty: 0 } },
  ];
  assert.equal(cleanLaundered(items), "g_shirt");
  assert.equal(cleanLaundered(items.slice(0, 3)), null);
  const after = items.map((i) => (i.garmentId === "g_shirt" ? { ...i, balances: { clean: 0, dirty: 1 } } : i));
  assert.equal(movedToDirty(items, after, "g_shirt"), true);
  assert.equal(movedToDirty(items, items, "g_shirt"), false);
  const extra = after.map((i) => (i.garmentId === "g_pair" ? { ...i, balances: { clean: 1, dirty: 1 } } : i));
  assert.equal(movedToDirty(items, extra, "g_shirt"), false);
  assert.equal(movedToDirty([], [], "g_shirt"), false);
  assert.equal(balancesState(items), balancesState([...items].reverse()));
  assert.notEqual(balancesState(items), balancesState(after));
});

test("choosing is not wearing: the day's wear must be unchanged, not merely empty", () => {
  // Synthetic days (labelled test data, not owner data).
  const worn = { garments: [{ garmentId: "g_top_1" }, { garmentId: "g_bottom_1" }] };
  assert.equal(sameWear(worn, { garments: [{ garmentId: "g_bottom_1" }, { garmentId: "g_top_1" }] }).ok, true);
  assert.equal(sameWear({ garments: [] }, { garments: [] }).ok, true);
  assert.equal(sameWear(worn, { garments: [...worn.garments, { garmentId: "g_shoe_1" }] }).ok, false);
  assert.equal(sameWear({ garments: [] }, worn).ok, false);
  assert.equal(sameWear(null, worn).ok, false);
  assert.equal(sameWear(worn, {}).ok, false);
});

test("a swap kept for the owner (or refused) must leave the board exactly as it was read before the request", () => {
  const before = syntheticBoard({ revision: 3 });
  assert.equal(unchangedAfterUnapplied(before, syntheticBoard({ revision: 3 })).ok, true);
  // A piece changed anyway, though the server answered confirmation_required.
  const swapped = syntheticBoard({ revision: 3 });
  swapped.options[0].garments[0].garmentId = "g_top_9";
  assert.equal(unchangedAfterUnapplied(before, swapped).ok, false);
  // The choice changed, the revision moved, another board, an unreadable board, no usable baseline.
  assert.equal(unchangedAfterUnapplied(before, syntheticBoard({ revision: 3, selection: { optionId: "opt_a" } })).ok, false);
  assert.match(unchangedAfterUnapplied(before, syntheticBoard({ revision: 4 })).reason, /revision 3 to 4/);
  assert.equal(unchangedAfterUnapplied(before, { ...syntheticBoard({ revision: 3 }), boardId: "brd_other" }).ok, false);
  assert.equal(unchangedAfterUnapplied(before, null).ok, false);
  assert.equal(unchangedAfterUnapplied(null, before).ok, false);
  assert.equal(unchangedAfterUnapplied(syntheticBoard({ revision: undefined }), syntheticBoard({ revision: undefined })).ok, false);
});

test("the authorization URL is taken only once Codex has printed all of it", () => {
  const full = "https://garderobe.example/oauth/authorize?response_type=code&client_id=c1&scope=wardrobe.read%20wardrobe.write&resource=https%3A%2F%2Fgarderobe.example%2Fmcp&state=s1";
  const printed = `Authorize Codex by opening:\n${full}\nWaiting for the callback...\n`;
  // Every possible pipe chunk boundary: before the newline after the URL arrives, no URL; after it, the whole URL.
  const end = printed.indexOf(full) + full.length;
  for (let cut = 0; cut <= printed.length; cut++) {
    const url = authorizationUrlFrom(printed.slice(0, cut));
    if (cut <= end) assert.equal(url, null, `cut at ${cut}`);
    else assert.equal(url?.toString(), full, `cut at ${cut}`);
  }
  assert.equal(authorizationUrlFrom(full), null);
  assert.equal(authorizationUrlFrom(`${full}\r\n`)?.searchParams.get("scope"), "wardrobe.read wardrobe.write");
});
