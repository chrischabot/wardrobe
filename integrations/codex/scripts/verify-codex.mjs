#!/usr/bin/env node
/**
 * End-to-end check of the Wardrobe Codex plugin with the real Codex CLI.
 *
 *   node integrations/codex/scripts/verify-codex.mjs [--marketplace <dir>] [--report <file.json>] [--no-model] [--registration dcr|cimd|auto]
 *
 * Steps, each printed as PASS/FAIL and written to the JSON report:
 *   1. a fresh, throw-away CODEX_HOME; `codex plugin marketplace add <dir>` and
 *      `codex plugin add wardrobe@wardrobe-codex` (the plugin as a user installs it);
 *   2. `codex mcp login wardrobe --no-browser --scopes wardrobe.read,wardrobe.write`: Codex discovers the
 *      Garderobe authorization server, registers itself (dynamic client registration by default; `--registration
 *      cimd` tries Codex's Client ID Metadata Document instead) and waits for the
 *      owner's consent. Against a loopback Worker (`npm run dev` in apps/worker) the consent is given with
 *      the local run mode's owner sign-in, the stand-in for Cloudflare Access; against any other host the
 *      authorization URL is printed and the owner approves it in a browser and pastes the final URL here;
 *   3. `codex app-server` (the protocol the Codex IDE extension and desktop app use): start a thread, list
 *      the wardrobe server's tools, then call them through Codex: a read (`garderobe_today`, the complete
 *      inventory snapshot), a routine write with its receipt (`board.select` on the published board) and its
 *      undo (`command.undo`), and a change that must wait for the owner (`board.swap_slot` answers
 *      `confirmation_required`);
 *   4. unless --no-model, a model-driven `codex exec` session that is asked to read today's board through
 *      the plugin. It uses the user's existing Codex sign-in (`auth.json` from CODEX_HOME or ~/.codex, copied
 *      into the temporary home) or, when there is none, OPENAI_API_KEY.
 *
 * The MCP URL is the one in the marketplace's plugin/mcp.json (retarget a copy with scripts/retarget.mjs).
 * Environment: CODEX_BIN (default `codex`), GARDEROBE_APP_ORIGIN for the local app origin.
 * Nothing here stores a credential outside the temporary CODEX_HOME, which is deleted at the end.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const marketplaceRoot = path.resolve(opt("--marketplace") ?? PACKAGE_ROOT);
const reportPath = opt("--report");
const withModel = !args.includes("--no-model");
const registration = opt("--registration") ?? "dcr";
if (!["auto", "cimd", "dcr"].includes(registration)) throw new Error("--registration must be auto, cimd or dcr");
const CODEX = process.env.CODEX_BIN ?? "codex";
const mcpUrl = new URL(JSON.parse(readFileSync(path.join(marketplaceRoot, "plugin", "mcp.json"), "utf8")).mcpServers.wardrobe.url);
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(mcpUrl.hostname);

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 600) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ""}`);
  return Boolean(pass);
}

const codexHome = mkdtempSync(path.join(os.tmpdir(), "wardrobe-codex-home-"));
// The user's own Codex sign-in (for the model step), copied into the throw-away home; nothing else is copied.
const userCodexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
if (existsSync(path.join(userCodexHome, "auth.json"))) copyFileSync(path.join(userCodexHome, "auth.json"), path.join(codexHome, "auth.json"));
const env = { ...process.env, CODEX_HOME: codexHome };
const codex = (...a) => spawnSync(CODEX, a, { env, encoding: "utf8", input: "" });

/** The local run mode's helpers (owner sign-in stand-in), loaded only for a loopback Worker. */
async function localHelpers() {
  const local = await import(path.join(REPO_ROOT, "apps/worker/scripts/lib/local.mjs"));
  const client = await import(path.join(REPO_ROOT, "apps/worker/scripts/lib/mcp-client.mjs"));
  return { ...local, approveConsent: client.approveConsent };
}

/** `codex mcp login`: read the authorization URL, have the owner consent, deliver the redirect to Codex's loopback callback. */
async function login() {
  const child = spawn(CODEX, ["mcp", "login", "wardrobe", "--no-browser", "--scopes", "wardrobe.read,wardrobe.write", "--oauth-client-registration", registration], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const authUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no authorization URL from codex mcp login: ${out.slice(0, 400)}`)), 30_000);
    const onData = (d) => {
      out += d;
      const m = /(https?:\/\/\S*\/oauth\/authorize\?\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(new URL(m[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    exited.then((code) => reject(new Error(`codex mcp login exited ${code}: ${out.slice(0, 400)}`)));
  });
  check("Codex discovered the Garderobe authorization server and asked for both scopes", authUrl.searchParams.get("scope") === "wardrobe.read wardrobe.write" && authUrl.searchParams.get("resource") === mcpUrl.toString(), `client_id ${authUrl.searchParams.get("client_id")}`);
  let callback;
  if (loopback) {
    const { approveConsent } = await localHelpers();
    callback = await approveConsent(authUrl, { allow: true, write: true });
  } else {
    console.log(`\nOpen this URL, sign in to Garderobe, allow "Make changes", then paste the final URL (the 127.0.0.1 callback) here:\n${authUrl}\n`);
    const rl = readline.createInterface({ input: process.stdin });
    callback = new URL(await new Promise((resolve) => rl.once("line", resolve)));
    rl.close();
  }
  // Deliver the redirect to Codex's own loopback listener, exactly as the browser would.
  await fetch(callback, { redirect: "manual" }).catch(() => child.stdin.write(`${callback}\n`));
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 30_000))]);
  if (code === "timeout") child.kill();
  check("codex mcp login completed with the owner's consent", code === 0, out.trim().split("\n").at(-1));
}

/** A minimal JSON-RPC client for `codex app-server` over stdio. */
function appServer() {
  const child = spawn(CODEX, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: child.stdout });
  let next = 0;
  const waiting = new Map();
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // A request from Codex to the client (approval, elicitation): decline; nothing here confirms on the owner's behalf.
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "mcpServer/elicitation/request" ? { action: "decline" } : { decision: "decline" } }) + "\n");
    } else if (msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => reject(new Error(`${method}: no answer within 120 s`)), 120_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  return { request, notify, close: () => child.kill() };
}

/** The structured result of a tool called through Codex: `{ ok, data, error }`. */
function toolOutcome(result) {
  const text = (result?.content ?? []).find((c) => c.type === "text")?.text ?? "";
  if (result?.isError) {
    let error;
    try {
      error = JSON.parse(text).error;
    } catch {
      error = { code: "unknown", message: text };
    }
    return { ok: false, data: null, error };
  }
  let data = result?.structuredContent ?? null;
  if (!data) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: true, data, error: null };
}

const ownerDayIso = (offsetDays, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));

async function toolsThroughCodex() {
  const server = appServer();
  try {
    await server.request("initialize", { clientInfo: { name: "wardrobe-codex-verify", version: "1.0.0" } });
    server.notify("initialized");
    const { thread } = await server.request("thread/start", { cwd: process.cwd(), ephemeral: true });
    const status = (await server.request("mcpServerStatus/list", { threadId: thread.id, serverName: "wardrobe" })).data.find((s) => s.name === "wardrobe");
    const tools = Object.keys(status?.tools ?? {}).map((k) => status.tools[k].name ?? k).sort();
    check("Codex lists the plugin's MCP server as authenticated and ready", status?.pluginId === "wardrobe@wardrobe-codex" && status?.authStatus !== "notLoggedIn" && !status?.toolsError, `${status?.runtimeStatus} / ${status?.authStatus}${status?.toolsError ? ` / ${status.toolsError.slice(0, 200)}` : ""}`);
    check("Codex lists all seven Wardrobe tools, including the write tool", tools.length === 7 && tools.includes("garderobe_command"), tools.join(", "));

    const call = async (tool, toolArgs) => toolOutcome(await server.request("mcpServer/tool/call", { threadId: thread.id, server: "wardrobe", tool, arguments: toolArgs }));

    const snapshot = await call("garderobe_inventory", { view: "snapshot" });
    check("read: garderobe_inventory returns the complete inventory through Codex", snapshot.ok && snapshot.data?.complete === true && snapshot.data?.total > 0, snapshot.ok ? `${snapshot.data?.total} garments, complete=${snapshot.data?.complete}` : JSON.stringify(snapshot.error));

    // The board for tomorrow in the owner's own day. Locally the owner's app publishes it (the daily service's
    // own route, as the owner); on a deployment the daily service will have published it already.
    const local = loopback ? await localHelpers() : null;
    let timeZone = "Europe/London";
    if (local) {
      await local.ensureClaimed();
      timeZone = (await local.api("GET", "/v1/settings")).json?.settings?.timezone ?? timeZone;
    }
    const date = ownerDayIso(1, timeZone);
    if (local) {
      const published = await local.api("POST", "/v1/recommendations", { clientRequestId: `codex-verify-board-${Date.now()}`, date, mode: "board" });
      check("setup (local, as the owner in the app): tomorrow's board is published", published.ok, `${published.status} ${date}`);
    }
    const today = await call("garderobe_today", { date });
    const board = today.data?.board;
    check("read: garderobe_today returns the published board through Codex", today.ok && board?.boardId && board.options?.length > 0, today.ok ? `board ${board?.boardId} revision ${board?.revision}, ${board?.options?.length ?? 0} options` : JSON.stringify(today.error));
    if (!board?.options?.length) return { date, timeZone };

    const option = board.options[0];
    const selected = await call("garderobe_command", { type: "board.select", payload: { boardId: board.boardId, optionId: option.optionId }, expectedVersions: { [`board:${board.boardId}`]: board.revision }, idempotencyKey: `codex-verify-select-${Date.now()}` });
    const receipt = selected.data?.receipt;
    check("routine write: board.select runs directly with a receipt naming the connected assistant", selected.ok && receipt?.commandId && receipt.channel === "mcp" && receipt.actor === "assistant", selected.ok ? `${receipt?.commandId}: ${receipt?.summary}` : JSON.stringify(selected.error));
    // Once a choice is recorded it is always taken back, even when a check in between throws.
    try {
      const afterSelect = await call("garderobe_today", { date });
      check("the choice is on the board the app shows", afterSelect.data?.board?.selection?.optionId === option.optionId, `selection ${afterSelect.data?.board?.selection?.optionId}`);
      if (local) {
        const day = (await local.api("GET", `/v1/days/${date}`)).json;
        check("choosing is not wearing: no wear is recorded for that day", Array.isArray(day?.garments) && day.garments.length === 0, `${day?.garments?.length} garments worn`);
      }
    } finally {
      if (receipt?.commandId) {
        const undone = await call("garderobe_command", { type: "command.undo", payload: { commandId: receipt.commandId }, idempotencyKey: `codex-verify-undo-${Date.now()}` });
        check("undo: command.undo takes the choice back with its own receipt", undone.ok && undone.data?.receipt?.commandId, undone.ok ? `${undone.data.receipt.commandId}: ${undone.data.receipt.summary}` : JSON.stringify(undone.error));
      }
    }
    if (receipt?.commandId) {
      const afterUndo = await call("garderobe_today", { date });
      check("after the undo the board has no choice again", (afterUndo.data?.board?.selection?.optionId ?? null) === null, `selection ${afterUndo.data?.board?.selection?.optionId ?? null}`);
    }

    const boardNow = (await call("garderobe_today", { date })).data?.board ?? board;
    const swap = await call("garderobe_command", { type: "board.swap_slot", payload: { boardId: boardNow.boardId, optionId: option.optionId, role: "top" }, idempotencyKey: `codex-verify-swap-${Date.now()}` });
    if (swap.ok && swap.data?.receipt?.commandId) {
      // It should never run directly; if it did, take it back before reporting the failure.
      await call("garderobe_command", { type: "command.undo", payload: { commandId: swap.data.receipt.commandId }, idempotencyKey: `codex-verify-undo-swap-${Date.now()}` });
    }
    const proposalId = swap.error?.details?.proposalId;
    check("a change outside the routine actions waits for the owner (confirmation_required, nothing changed)", !swap.ok && swap.error?.code === "confirmation_required", swap.ok ? "ran directly" : `${swap.error?.code}: ${swap.error?.details?.summary ?? swap.error?.message}`);
    if (local && proposalId) {
      const rejected = await local.api("POST", `/v1/proposals/${proposalId}/decision`, { decision: "reject" });
      check("cleanup (local, as the owner in the app): the proposal is rejected", rejected.ok, rejected.json?.proposal?.state);
    }
    return { date, timeZone, boardId: board.boardId };
  } finally {
    server.close();
  }
}

function modelSession(date) {
  // `codex login status` reports on stderr.
  const signedIn = () => {
    const s = codex("login", "status");
    return `${s.stdout}${s.stderr}`.includes("Logged in");
  };
  if (!signedIn() && process.env.OPENAI_API_KEY) {
    spawnSync(CODEX, ["login", "--with-api-key"], { env, input: process.env.OPENAI_API_KEY, encoding: "utf8" });
  }
  if (!signedIn()) return { signedIn: false };
  const prompt = `Use the wardrobe MCP server's garderobe_today tool with date ${date} and reply with only the board id it returns.`;
  const run = spawnSync(CODEX, ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-c", 'plugins."wardrobe@wardrobe-codex".mcp_servers.wardrobe.tools.garderobe_today.approval_mode="approve"', prompt], { env, encoding: "utf8", timeout: 300_000, input: "" });
  const events = (run.stdout ?? "").split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const calls = events.filter((e) => e.item?.type === "mcp_tool_call" && e.type === "item.completed");
  const used = calls.find((e) => e.item.server === "wardrobe" && e.item.tool === "garderobe_today");
  const answer = events.filter((e) => e.item?.type === "agent_message").at(-1)?.item?.text ?? "";
  return { signedIn: true, exit: run.status, used, answer, calls: calls.map((e) => `${e.item.server}.${e.item.tool}:${e.item.status}`), stderr: (run.stderr ?? "").trim().split("\n").slice(-3).join(" | ") };
}

try {
  const version = codex("--version").stdout.trim();
  check("Codex CLI available", version.startsWith("codex"), version);
  console.log(`MCP server: ${mcpUrl} (${loopback ? "LOCAL Worker, not a hosted deployment" : "hosted"})`);
  const added = codex("plugin", "marketplace", "add", marketplaceRoot);
  check("codex plugin marketplace add", added.status === 0, (added.stdout || added.stderr).trim().split("\n")[0]);
  const installed = codex("plugin", "add", "wardrobe@wardrobe-codex");
  check("codex plugin add wardrobe@wardrobe-codex", installed.status === 0, (installed.stdout || installed.stderr).trim().split("\n")[0]);
  const listed = codex("mcp", "list");
  check("the plugin's MCP server is configured in Codex", /wardrobe\s+\S*\/mcp/.test(listed.stdout), listed.stdout.trim().split("\n")[1]);
  await login();
  const state = await toolsThroughCodex();
  if (withModel && state?.boardId) {
    const model = modelSession(state.date);
    if (!check("model session: Codex is signed in (your existing Codex sign-in, or OPENAI_API_KEY)", model.signedIn, model.signedIn ? "" : "sign in with `codex login`, set OPENAI_API_KEY, or pass --no-model")) throw new Error("model session skipped: Codex is not signed in");
    check("model session: codex exec called garderobe_today through the plugin", model.exit === 0 && model.used?.item?.status === "completed", `exit ${model.exit}; calls ${model.calls.join(", ") || "none"}${model.exit ? `; ${model.stderr}` : ""}`);
    check("model session: the answer names the board Codex read", model.answer.includes(state.boardId), model.answer.slice(0, 200));
  }
} catch (error) {
  check("verification completed without an unexpected error", false, String(error?.stack ?? error));
} finally {
  rmSync(codexHome, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
const summary = { mcpUrl: mcpUrl.toString(), target: loopback ? "local Worker (not hosted)" : "hosted", registration, at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results };
if (reportPath) writeFileSync(reportPath, JSON.stringify(summary, null, 2) + "\n");
console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
process.exit(failed.length === 0 ? 0 : 1);
