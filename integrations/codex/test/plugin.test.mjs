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
  const policy = readFileSync(path.join(REPO, "apps/worker/src/mcp/policy.ts"), "utf8");
  const routineLine = skill.split("\n").find((l) => l.startsWith("- **Applied:**"));
  assert.ok(routineLine, "the skill describes applied changes");
  const inSkill = [...routineLine.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((m) => m[1]).filter((t) => t !== "command.undo").sort();
  assert.deepEqual(inSkill, ["board.select", "laundry.collect", "laundry.return", "stock.pack", "stock.unpack"]);
  // While the server keeps an explicit typed-command allow-list, each routine action the skill names must be on it.
  const listed = /TYPED_DIRECT_BY_OWNER_DECISION: ReadonlySet<string> = new Set<string>\((\[[^\]]+\])\)/.exec(policy);
  if (listed) for (const t of inSkill) assert.ok(JSON.parse(listed[1]).includes(t), `${t} is not run directly by the server`);
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
  assert.equal(checkMcpUrl("http://127.0.0.1:8787/mcp"), "http://127.0.0.1:8787/mcp");
});
