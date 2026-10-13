#!/usr/bin/env node
/**
 * End-to-end check of the Wardrobe Codex plugin with the real Codex CLI.
 *
 *   node integrations/codex/scripts/verify-codex.mjs [--marketplace <dir>] [--report <file.json>] [--registration dcr|cimd|auto] [--timezone <IANA zone>] [--app worker|ferrite] [--disposable-test-instance] [--allow-real-swap] [--ai-gateway-unset]
 *
 * --ai-gateway-unset (Ferrite only) states that the app has no WARDROBE_AI_GATEWAY; only then are garderobe_ask and
 * garderobe_research called, and they must refuse by that secret's name and write nothing (otherwise they would run
 * a model, which this verifier never does).
 *
 * --allow-real-swap acknowledges that the piece swap may be sent to the owner's real board (any run other than the
 * local Worker or a declared disposable Ferrite instance at a loopback URL); without it the swap is reported as
 * not run there.
 *
 * No model runs here. Codex can run only OpenAI models, and the project authorizes only claude-opus-5-5 for
 * inference, so there is no model-driven `codex exec` step; every check goes through `codex app-server`, which
 * calls the tools without a model. --codex-model and CODEX_MODEL are refused.
 *
 * --timezone is required for a hosted MCP URL (the owner's timezone from Garderobe settings, which picks the
 * owner's day); against a loopback Worker the timezone is read from the owner's settings, and the run fails if
 * neither is available.
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
 *      undo (`command.undo`), a piece swap (`board.swap_slot`), which the owner's 2026-10-05 contract says
 *      applies at once with a receipt and undo (a `confirmation_required` answer fails that check), and a
 *      restriction lift, which is refused.
 *
 * The MCP URL is the one in the marketplace's plugin/mcp.json (retarget a copy with scripts/retarget.mjs).
 * Environment: CODEX_BIN (default `codex`), GARDEROBE_APP_ORIGIN for the local app origin.
 * Nothing here stores a credential outside the temporary CODEX_HOME, which is deleted at the end.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { adoptAfterWrite, assistantRefusal, authorizationUrlFrom, balancesState, boardState, choiceOf, cleanLaundered, movedToDirty, ownerDay, publishCommand, publishLostRace, realBoardRun, sameWear, setupDecision, swapDecision, unchangedAfterUnapplied, versionsOf, within, writeDecision } from "./board-guard.mjs";
import { ferriteConsent } from "./ferrite-consent.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const marketplaceRoot = path.resolve(opt("--marketplace") ?? PACKAGE_ROOT);
const reportPath = opt("--report");
// No model-driven step: Codex runs only OpenAI models, which the project does not authorize for inference.
if (args.some((a) => a === "--codex-model" || a.startsWith("--codex-model=")) || process.env.CODEX_MODEL) {
  console.error("This verifier runs no model: Codex can run only OpenAI models, and the project authorizes only claude-opus-5-5 for inference. Remove --codex-model / CODEX_MODEL.");
  process.exit(2);
}
const registration = opt("--registration") ?? "dcr";
if (!["auto", "cimd", "dcr"].includes(registration)) throw new Error("--registration must be auto, cimd or dcr");
const CODEX = process.env.CODEX_BIN ?? "codex";
const mcpUrl = new URL(JSON.parse(readFileSync(path.join(marketplaceRoot, "plugin", "mcp.json"), "utf8")).mcpServers.wardrobe.url);
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(mcpUrl.hostname);
// Which Wardrobe app serves the MCP URL: the Cloudflare Worker (default) or the Ferrite port (`--app ferrite`, local
// `ferrite dev` or a Ferrite deployment). The Ferrite consent page needs the app's owner token, from the environment.
const app = opt("--app") ?? "worker";
if (!["worker", "ferrite"].includes(app)) {
  console.error("--app must be worker or ferrite");
  process.exit(2);
}
const ferrite = app === "ferrite";
// The synthetic care report (care.mark_dirty, then undo) leaves a test observation in the app's history: undo does
// not erase it. A loopback URL is no proof of a throwaway instance (a persistent local app, or a tunnel to a
// deployment, also answers on 127.0.0.1), so the write runs only when the operator states that this is a disposable
// test instance started with `ferrite dev --fresh`, and the URL is loopback as well.
const disposableInstance = args.includes("--disposable-test-instance");
if (disposableInstance && !ferrite) {
  console.error("--disposable-test-instance applies only to --app ferrite");
  process.exit(2);
}
// A piece swap on the owner's real board needs the operator's explicit acknowledgement (see swapDecision).
const allowRealSwap = args.includes("--allow-real-swap");
// garderobe_ask and garderobe_research call a model when the app has an inference gateway. This verifier runs no
// model, so it calls them only when the operator states that the app has no gateway credential (--ai-gateway-unset,
// for the Ferrite app: WARDROBE_AI_GATEWAY not set); they must then refuse by that secret's name and write nothing.
const aiGatewayUnset = args.includes("--ai-gateway-unset");
if (aiGatewayUnset && app !== "ferrite") {
  console.error("--ai-gateway-unset applies only to --app ferrite");
  process.exit(2);
}
const ownerToken = process.env.WARDROBE_OWNER_TOKEN ?? "";
if (ferrite && !ownerToken) {
  console.error("--app ferrite needs WARDROBE_OWNER_TOKEN, the Ferrite app's owner token (locally: [secrets] in ferrite/ferrite.local.toml), to give the owner's consent.");
  process.exit(2);
}
// The local Worker's run-mode helpers (owner sign-in stand-in, owner API) exist only for a loopback Worker.
const workerLocal = loopback && !ferrite;
// The owner's day decides which board is read. Locally it comes from the owner's settings (an authenticated read);
// a hosted run has no such read here, so it must be told the owner's timezone: no silent default.
const timeZoneArg = opt("--timezone");
if (timeZoneArg !== undefined) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timeZoneArg });
  } catch {
    console.error(`--timezone ${timeZoneArg} is not an IANA timezone (for example Europe/London)`);
    process.exit(2);
  }
}
if (!workerLocal && !timeZoneArg) {
  console.error(`This run (${mcpUrl}${ferrite ? ", Ferrite app" : ""}) needs --timezone <IANA zone>, the owner's timezone from Garderobe settings, to pick the owner's day.`);
  process.exit(2);
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail: String(detail).slice(0, 600) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ""}`);
  return Boolean(pass);
}

// Nothing from the user's own Codex home is copied: no model runs, so no Codex sign-in is needed.
// Keep the Garderobe OAuth grant in this throw-away home: by default Codex may store MCP credentials in the OS
// keyring, which deleting the directory would not remove. Written before any other command adds to the config;
// if that fails, the directory is removed before the run stops.
let codexHome = null;
try {
  codexHome = mkdtempSync(path.join(os.tmpdir(), "wardrobe-codex-home-"));
  writeFileSync(path.join(codexHome, "config.toml"), 'mcp_oauth_credentials_store = "file"\n');
} catch (error) {
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  console.error(`could not prepare the temporary CODEX_HOME: ${error?.message ?? error}`);
  process.exit(1);
}
// Codex gets no copy of the owner token.
const { WARDROBE_OWNER_TOKEN: _ownerToken, ...inherited } = process.env;
const env = { ...inherited, CODEX_HOME: codexHome };
const codex = (...a) => spawnSync(CODEX, a, { env, encoding: "utf8", input: "", timeout: 60_000, killSignal: "SIGKILL" });
// A setup command that hit its 60 s limit (killed) is reported as such.
const timedOut = (r) => r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
const outcome = (r) => (timedOut(r) ? "timed out after 60 s and was killed" : (r.stdout || r.stderr || String(r.error ?? "")).trim().split("\n")[0]);

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
  const timers = new Set();
  const after = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  let exitCode = null;
  // A spawn failure (missing or non-executable CODEX_BIN) emits `error`, possibly without `exit`: both settle `exited`.
  let spawnError = null;
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve((exitCode = code ?? signal ?? "exited")));
    child.once("error", (error) => {
      spawnError = error;
      resolve((exitCode = `error: ${error.message}`));
    });
  });
  child.stdin.on("error", () => undefined); // EPIPE after Codex exits is reported through `exited`
  let rl = null;
  try {
    const authUrl = await new Promise((resolve, reject) => {
      const timer = after(30_000, () => reject(new Error(`no authorization URL from codex mcp login: ${out.slice(0, 400)}`)));
      const onData = (d) => {
        out += d;
        const url = authorizationUrlFrom(out);
        if (url) {
          clearTimeout(timer);
          timers.delete(timer);
          resolve(url);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      exited.then((code) => reject(spawnError ? new Error(`codex mcp login could not start: ${spawnError.message}`) : new Error(`codex mcp login exited ${code}: ${out.slice(0, 400)}`)));
    });
    check("Codex discovered the Garderobe authorization server and asked for both scopes", authUrl.searchParams.get("scope") === "wardrobe.read wardrobe.write" && authUrl.searchParams.get("resource") === mcpUrl.toString(), `client_id ${authUrl.searchParams.get("client_id")}`);
    let callback;
    if (ferrite) {
      // The Ferrite app's consent page: its form is fetched first and its issued/form_mac fields are posted back.
      // Codex exiting (or the 60 s bound) aborts the consent requests, so no approval is posted after login failed.
      const consentAbort = new AbortController();
      exited.then(() => consentAbort.abort());
      try {
        callback = await within(ferriteConsent(authUrl, { appOrigin: mcpUrl.origin, ownerToken, write: true, signal: consentAbort.signal }), 60_000, "Ferrite consent did not finish within 60 s", exited);
      } finally {
        consentAbort.abort();
      }
      check("the owner allowed the connection on the Ferrite consent page (form fetched, issued and form_mac posted back)", Boolean(callback), callback ? `redirect to ${callback.origin}${callback.pathname}` : "");
    } else if (loopback) {
      const { approveConsent } = await localHelpers();
      // Bounded: fails after 60 s or when Codex exits, so a stalled consent page still reaches the cleanup below.
      callback = await within(approveConsent(authUrl, { allow: true, write: true }), 60_000, "local consent approval did not finish within 60 s", exited);
    } else {
      console.log(`\nOpen this URL, sign in to Garderobe, allow "Make changes", then paste the final URL (the 127.0.0.1 callback) here.\nIf your browser reaches Codex's callback by itself, nothing needs pasting:\n${authUrl}\n`);
      rl = readline.createInterface({ input: process.stdin });
      // Settles on a pasted line, or with null when Codex finishes on its own (the browser delivered the callback to
      // its listener). Fails if Codex exits unsuccessfully, input ends, or nobody answers within 10 minutes.
      const line = await new Promise((resolve, reject) => {
        rl.once("line", resolve);
        rl.once("close", () => (exitCode === 0 ? resolve(null) : reject(new Error("input ended before the callback URL was pasted"))));
        exited.then((code) => (code === 0 ? resolve(null) : reject(new Error(`codex mcp login exited (${code}) while waiting for the callback URL`))));
        after(600_000, () => reject(new Error("no callback URL pasted within 10 minutes")));
      });
      rl.removeAllListeners();
      callback = line === null ? null : new URL(line); // throws on an invalid URL; the finally below still stops Codex
    }
    if (callback) {
      // Deliver the redirect to Codex's own loopback listener, exactly as the browser would. Bounded: aborted after
      // 15 s or as soon as Codex exits, so a callback that never answers cannot keep the cleanup below from running.
      const delivery = new AbortController();
      after(15_000, () => delivery.abort(new Error("callback delivery timed out after 15 s")));
      exited.then(() => delivery.abort(new Error("codex mcp login exited during callback delivery")));
      await fetch(callback, { redirect: "manual", signal: delivery.signal }).catch(() => {
        if (exitCode === null) child.stdin.write(`${callback}\n`);
      });
    }
    const code = await Promise.race([exited, new Promise((resolve) => after(30_000, () => resolve("timeout")))]);
    check("codex mcp login completed with the owner's consent", code === 0, code === "timeout" ? "codex mcp login did not finish within 30 s" : out.trim().split("\n").at(-1));
  } finally {
    // Whatever happened above: no timer left, Codex stopped and awaited, streams closed, before CODEX_HOME is removed.
    for (const t of timers) clearTimeout(t);
    timers.clear();
    rl?.removeAllListeners();
    rl?.close();
    if (exitCode === null) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killer);
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  }
}

/** A minimal JSON-RPC client for `codex app-server` over stdio. */
function appServer() {
  const child = spawn(CODEX, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const rl = readline.createInterface({ input: child.stdout });
  let next = 0;
  const waiting = new Map();
  // If Codex cannot start or stops, every pending and later request is rejected instead of hanging or throwing unhandled.
  let failure = null;
  const fail = (error) => {
    if (failure) return;
    failure = error;
    for (const settle of waiting.values()) settle({ error: { message: error.message } });
    waiting.clear();
  };
  child.on("error", (error) => fail(new Error(`codex app-server could not start: ${error.message}`)));
  child.on("exit", (code, signal) => fail(new Error(`codex app-server exited (${code ?? signal})`)));
  // Settles once Codex is gone: on exit, or on a spawn error (which may come without an exit).
  const gone = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  const alive = () => child.exitCode === null && child.signalCode === null && child.pid !== undefined;
  child.stdin.on("error", (error) => fail(new Error(`codex app-server input closed: ${error.message}`)));
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
      if (failure) return reject(new Error(`${method}: ${failure.message}`));
      const id = ++next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method}: no answer within 120 s`));
      }, 120_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params) => {
    if (!failure) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  };
  return {
    request,
    notify,
    // Stops Codex for good before CODEX_HOME is removed: SIGTERM, SIGKILL after 5 s, awaited; streams closed.
    close: async () => {
      rl.close();
      if (alive()) {
        child.kill("SIGTERM");
        const killer = setTimeout(() => alive() && child.kill("SIGKILL"), 5_000);
        await gone;
        clearTimeout(killer);
      }
      for (const stream of [child.stdin, child.stdout]) stream?.destroy();
    },
  };
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

/**
 * The Ferrite port has no recommender yet: the owner's app publishes the day's board (`board.publish`, owner_tap).
 * A publication has no undo, so the verifier publishes only on an instance the operator declared disposable
 * (--disposable-test-instance) at a loopback URL, and only when that day has no board yet. The two outfits are the
 * owner's seed garments the port's own test publishes (ferrite/tests/mcp.rs, the Codex verifier board steps).
 */
const FERRITE_SEED_OUTFITS = [
  ["gmt_3894b6a6295908d5e687af4f", "gmt_0bd82c642c7606199361d3d4", "gmt_9eb32f6a40ea3e5e4dee484b", "gmt_14bc4338d6760f6a13434b2f"],
  ["gmt_41c2da80e7f41e5dc6a4340b", "gmt_b8744c2627cd88a3b937f851", "gmt_67d3228f744d17138e400729", "gmt_185ccf753d109848f21f7cec"],
];
async function ferriteBoardSetup(call, date) {
  const decision = setupDecision({ outcome: await call("garderobe_today", { date }), loopback, disposable: disposableInstance });
  if (decision.action === "unknown") {
    check("setup: whether tomorrow already has a board could be read", false, `not published: ${decision.reason}`);
    return;
  }
  if (decision.action === "exists") return;
  if (decision.action === "not_disposable") {
    console.log(`note: no board is published for ${date}; ${decision.reason}`);
    return;
  }
  const body = publishCommand(date, FERRITE_SEED_OUTFITS);
  let status = "no answer";
  let ok = false;
  let lostRace = false;
  try {
    const r = await fetch(new URL("/v1/commands", mcpUrl), { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const json = await r.json().catch(() => null);
    ok = r.status === 200 && Boolean(json?.commandId ?? json?.receipt?.commandId);
    lostRace = !ok && publishLostRace(json);
    status = `${r.status} ${json?.summary ?? json?.receipt?.summary ?? json?.error?.code ?? ""}`.trim();
  } catch (error) {
    status = error?.name === "TimeoutError" ? "timed out after 15 s" : "request failed";
  }
  // A board published meanwhile is left as it is (expectedBoardRevision 0 refused to replace it); the steps below use it.
  if (lostRace) {
    console.log(`note: another board for ${date} was published while the verifier was about to publish; it was not replaced (${status})`);
    return;
  }
  check("setup (disposable local Ferrite app, as the owner in the app): tomorrow's board is published", ok, `${date}: ${status}`);
}

/** A GET on the Ferrite app as the owner (owner token, sent only to the MCP URL's own origin). The JSON body, or null. */
async function ferriteOwnerGet(pathname) {
  try {
    const r = await fetch(new URL(pathname, mcpUrl), { redirect: "manual", headers: { authorization: `Bearer ${ownerToken}` }, signal: AbortSignal.timeout(15_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/**
 * The Ferrite app's other tools through Codex: garderobe_recommend (a validated recommendation, nothing published),
 * garderobe_run (the recommendation's run, read back by the runId a repeated request returns), and, only with
 * --ai-gateway-unset, garderobe_ask and garderobe_research, which must refuse by the secret's name and write nothing.
 */
async function ferriteReadTools(call, tools) {
  const date = ownerDay(new Date(), timeZoneArg, 1);
  if (tools.includes("garderobe_recommend")) {
    const request = { date, count: 2, clientRequestId: `codex-verify-recommend-${Date.now()}` };
    const first = await call("garderobe_recommend", request);
    const options = first.data?.options;
    check("read: garderobe_recommend returns validated outfit options through Codex (nothing published)", first.ok && Array.isArray(options) && first.data?.board == null, first.ok ? `${options?.length ?? 0} options for ${first.data?.localDate ?? date}${first.data?.insufficient ? `, insufficient: ${JSON.stringify(first.data.insufficient)}` : ""}` : JSON.stringify(first.error));
    const again = await call("garderobe_recommend", request);
    const third = await call("garderobe_recommend", request);
    // A repeat must be answered from one stored run: the repeats both name the same runId (the first reply may name
    // none, as the run is stored after it; if it names one, it must be that one), with the same options throughout.
    const runId = again.data?.runId;
    const sameRun = typeof runId === "string" && runId.length > 0 && third.data?.runId === runId && (first.data?.runId == null || first.data.runId === runId);
    check("the same request returns the same recommendation, from one stored run", again.ok && third.ok && sameRun && JSON.stringify(again.data?.options) === JSON.stringify(options) && JSON.stringify(third.data?.options) === JSON.stringify(options), again.ok && third.ok ? `runs: first ${first.data?.runId ?? "none"}, repeat ${again.data?.runId}, third ${third.data?.runId}` : JSON.stringify(again.error ?? third.error));
    if (tools.includes("garderobe_run")) {
      const status = sameRun ? await call("garderobe_run", { runId, action: "status" }) : { ok: false, error: { code: "no_run", message: "the two replies did not name one run to read" } };
      // The run itself: McpRunOutput is { run, stopped } (apps/worker/src/mcp/server.ts, ferrite/src/runs.rs).
      const run = status.data?.run;
      check("read: garderobe_run reads the recommendation's run back through Codex", status.ok && run?.runId === runId && run?.state === "completed", status.ok ? `${run?.kind} ${run?.state}` : JSON.stringify(status.error));
    }
  }
  const assistantTools = ["garderobe_ask", "garderobe_research"].filter((t) => tools.includes(t));
  if (!assistantTools.length) return;
  if (!aiGatewayUnset) {
    console.log(`note: ${assistantTools.join(" and ")} not called: with an inference gateway they would run a model, which this verifier never does; pass --ai-gateway-unset for an app without WARDROBE_AI_GATEWAY`);
    return;
  }
  // The newest receipt only (not the read envelope, whose read time changes on every read), or null when unreadable.
  const newestReceipt = async () => {
    const r = await call("garderobe_inventory", { view: "receipts", limit: 1 });
    const receipts = r.data?.data?.receipts ?? r.data?.receipts;
    return r.ok && Array.isArray(receipts) ? JSON.stringify(receipts[0]?.commandId ?? null) : null;
  };
  for (const tool of assistantTools) {
    const before = await newestReceipt();
    const stamp = `codex-verify-${tool.slice(10)}-${Date.now()}`;
    const sent = tool === "garderobe_ask" ? await call(tool, { message: "Which of my coats is warmest?", clientTurnId: stamp }) : await call(tool, { topic: "How often did I wear my navy coat this year?", kind: "history", clientRequestId: stamp });
    const after = await newestReceipt();
    check(`${tool} without an inference gateway refuses by the secret's name (module_unavailable, WARDROBE_AI_GATEWAY)`, assistantRefusal(sent), sent.ok ? `answered: ${JSON.stringify(sent.data).slice(0, 200)}` : `${sent.error?.code}: ${sent.error?.message}`);
    check(`the refused ${tool} wrote nothing (newest receipt unchanged)`, before !== null && before === after, before === null ? "the receipts could not be read" : before === after ? "unchanged" : "a new receipt appeared");
  }
}

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

    // Refused on every contract, before the restriction is looked up: the identifier names no real restriction.
    // Checked before the board steps, which may stop early (an owner's choice on a hosted board), so it always runs.
    const lift = await call("garderobe_command", { type: "restriction.resolve", payload: { restrictionId: "rst_codex_verify_not_a_restriction", evidence: { kind: "owner_statement" } }, idempotencyKey: `codex-verify-lift-${Date.now()}` });
    check("a restriction lift from Codex is refused", !lift.ok && lift.error?.code === "forbidden", lift.ok ? "applied" : `${lift.error?.code}: ${lift.error?.message}`);

    if (ferrite) await ferriteReadTools(call, tools);

    // The Ferrite port publishes the board tools only once they are ported. Until then the board steps are not run,
    // and the routine write with receipt and undo is shown with the one write the port offers, a care report undone
    // at once, only on an instance the operator declared disposable (--disposable-test-instance, `ferrite dev
    // --fresh`) at a loopback URL. Anywhere else it would record a wash the owner did not report, so it is not run.
    if (ferrite && !tools.includes("garderobe_today")) {
      check("board steps (choice, swap and their undos) on the Ferrite app", false, `not run: this Ferrite app publishes ${tools.join(", ")}; garderobe_today is not ported yet`);
      if (!loopback || !disposableInstance) {
        check("routine write with receipt and undo on the Ferrite app", false, `not run: the only write this Ferrite app offers is a care report (care.mark_dirty), which leaves an observation in history even after undo; it is sent only to a disposable test instance (loopback URL and --disposable-test-instance, for \`ferrite dev --fresh\`)${loopback ? "; --disposable-test-instance was not given" : "; this URL is not loopback"}`);
        return null;
      }
      const items = snapshot.data?.data?.items ?? snapshot.data?.items ?? null;
      const garment = cleanLaundered(items);
      if (!check("local Ferrite app: a clean, single, laundered garment is available for the routine write", Boolean(garment), garment ?? "none in the inventory snapshot")) return null;
      const sent = await call("garderobe_command", { type: "care.mark_dirty", payload: { items: [{ garmentId: garment }] }, idempotencyKey: `codex-verify-care-${Date.now()}` });
      const receipt = sent.data?.receipt;
      try {
        check("routine write (local Ferrite app, test report undone below): care.mark_dirty applies at once with a receipt that offers undo", sent.ok && receipt?.commandId && receipt?.undo?.available === true, sent.ok ? `${receipt?.commandId}: ${receipt?.summary}` : JSON.stringify(sent.error));
        const afterWrite = await call("garderobe_inventory", { view: "snapshot" });
        const nowItems = afterWrite.data?.data?.items ?? afterWrite.data?.items ?? null;
        check("exactly that garment moved from clean to dirty, nothing else changed", afterWrite.ok && movedToDirty(items, nowItems, garment), afterWrite.ok ? garment : JSON.stringify(afterWrite.error));
      } finally {
        if (receipt?.commandId) {
          const back = await call("garderobe_command", { type: "command.undo", payload: { commandId: receipt.commandId }, idempotencyKey: `codex-verify-undo-care-${Date.now()}` });
          check("undo: command.undo takes the care report back with its own receipt", back.ok && back.data?.receipt?.commandId, back.ok ? back.data?.receipt?.summary ?? back.data?.receipt?.commandId : JSON.stringify(back.error));
          const restored = await call("garderobe_inventory", { view: "snapshot" });
          const restoredItems = restored.data?.data?.items ?? restored.data?.items ?? null;
          check("after the undo every garment's balances are exactly as before", restored.ok && Array.isArray(restoredItems) && balancesState(restoredItems) === balancesState(items), restored.ok ? `${restoredItems?.length ?? 0} garments compared` : JSON.stringify(restored.error));
        }
      }
      return null;
    }

    // The board for tomorrow in the owner's own day. Locally the owner's app publishes it (the daily service's
    // own route, as the owner); on a deployment the daily service will have published it already.
    const local = workerLocal ? await localHelpers() : null;
    let timeZone = timeZoneArg ?? null;
    if (local) {
      await local.ensureClaimed();
      const fromSettings = (await local.api("GET", "/v1/settings")).json?.settings?.timezone ?? null;
      if (fromSettings && timeZoneArg && fromSettings !== timeZoneArg) console.log(`note: the owner's settings say ${fromSettings}; using it instead of --timezone ${timeZoneArg}`);
      timeZone = fromSettings ?? timeZone;
    }
    if (!check("the owner's timezone is known (owner settings, or --timezone)", Boolean(timeZone), timeZone ?? "no timezone in the owner's settings and no --timezone")) return null;
    const date = ownerDay(new Date(), timeZone, 1);
    if (local) {
      const published = await local.api("POST", "/v1/recommendations", { clientRequestId: `codex-verify-board-${Date.now()}`, date, mode: "board" });
      check("setup (local, as the owner in the app): tomorrow's board is published", published.ok, `${published.status} ${date}`);
    } else if (ferrite) {
      await ferriteBoardSetup(call, date);
    }
    const today = await call("garderobe_today", { date });
    const board = today.data?.board;
    check("read: garderobe_today returns the published board through Codex", today.ok && board?.boardId && board.options?.length > 0, today.ok ? `board ${board?.boardId} revision ${board?.revision}, ${board?.options?.length ?? 0} options` : JSON.stringify(today.error));
    if (!board?.options?.length) return { date, timeZone };

    // The board may already carry the owner's choice (on a hosted run, the owner's real board). The check chooses a
    // different option and its undo must restore exactly the prior choice (option and footwear), never clear it.
    // Every write is preceded by a fresh read and `writeDecision` (scripts/board-guard.mjs), and sends the observed
    // board version as expectedVersions: a concurrent change by the owner stops the verifier instead of being overwritten.
    const hosted = !local;
    const read = async () => {
      const r = await call("garderobe_today", { date });
      return r.ok ? r.data?.board ?? null : null;
    };
    const guard = async (what, lastSeen, ownWrite = false) => {
      const current = await read();
      const decision = writeDecision({ hosted, lastSeen, current, ownWrite });
      if (!decision.ok) check(`${what}: refused before writing`, false, `not run: ${decision.reason}${ownWrite ? "; the verifier's own change is still on the board, undo it in the app" : ""}`);
      return decision.ok ? current : null;
    };
    // After each of its own writes, the next read becomes the baseline only if it shows exactly that write (the
    // receipt's board version and the expected state); otherwise every later write is refused.
    const adopt = (before, after, receipt, expect) => {
      const adoption = adoptAfterWrite({ before, after, receipt, expect });
      if (!adoption.ok) check("the board after the verifier's write shows only that write", false, adoption.reason);
      return adoption.ok ? after : { refused: adoption.reason };
    };
    const initialSelection = board.selection?.optionId ?? null;
    const initialChoice = choiceOf(board);
    const priorBoard = boardState(board);
    // On a hosted deployment (the owner's real board) never write over a choice the owner has made: refuse the
    // board writes and report them as not run. Locally the board is the run's own and the choice is restored.
    if (!local && board.selection) {
      check("board writes (choice, swap) on the owner's real board", false, `not run: the owner has already chosen option ${initialSelection} for ${date}; the verifier does not write over it. Run against a board without a choice, or a test account.`);
      return { date, timeZone, boardId: board.boardId };
    }
    // A choice must change something: pick an option other than the current one, or report that none exists.
    const other = board.options.find((o) => o.optionId !== initialSelection);
    const option = other ?? board.options[0];
    const beforeSelect = other ? await guard("routine write: board.select", board) : null;
    // Choosing is not wearing: the day's wear (read as the owner: the local Worker's owner API, or the Ferrite app's
    // GET /v1/days/<date> with the owner token) must be the same after the choice.
    const readDay = local ? async () => (await local.api("GET", `/v1/days/${date}`)).json : ferrite ? () => ferriteOwnerGet(`/v1/days/${date}`) : null;
    const wearBefore = readDay && beforeSelect ? await readDay() : null;
    const selected = beforeSelect ? await call("garderobe_command", { type: "board.select", payload: { boardId: beforeSelect.boardId, optionId: option.optionId }, expectedVersions: versionsOf(beforeSelect), idempotencyKey: `codex-verify-select-${Date.now()}` }) : { ok: false, data: null, error: other ? { code: "refused_before_writing", message: "the board changed before the choice could be made" } : { code: "no_other_option", message: "the board has no option other than the owner's current choice, so no choice transition can be shown" } };
    const receipt = selected.data?.receipt;
    check("routine write: board.select runs directly with a receipt naming the connected assistant", selected.ok && receipt?.commandId && receipt.channel === "mcp" && receipt.actor === "assistant", selected.ok ? `${receipt?.commandId}: ${receipt?.summary}` : JSON.stringify(selected.error));
    let lastSeen = beforeSelect ?? board;
    let undone = null;
    let beforeUndo = null;
    // Once a choice is recorded it is always taken back, even when a check in between throws.
    try {
      const afterSelect = await read();
      if (receipt?.commandId) lastSeen = adopt(beforeSelect, afterSelect, receipt, (b) => b.selection?.optionId === option.optionId);
      check("the choice is on the board the app shows", afterSelect?.selection?.optionId === option.optionId, `selection ${afterSelect?.selection?.optionId}`);
      if (readDay) {
        const wear = sameWear(wearBefore, await readDay());
        check("choosing is not wearing: the day's recorded wear is unchanged", wear.ok, wear.reason);
      } else {
        console.log("note: choosing is not wearing was not verified on this run (the verifier has no owner read of the day's wear for this app)");
      }
    } finally {
      if (receipt?.commandId) {
        beforeUndo = await guard("undo of the choice", lastSeen, true);
        if (beforeUndo) {
          undone = await call("garderobe_command", { type: "command.undo", payload: { commandId: receipt.commandId }, expectedVersions: versionsOf(beforeUndo), idempotencyKey: `codex-verify-undo-${Date.now()}` });
          check("undo: command.undo takes the choice back with its own receipt", undone.ok && undone.data?.receipt?.commandId, undone.ok && undone.data?.receipt?.commandId ? `${undone.data.receipt.commandId}: ${undone.data.receipt.summary ?? ""}` : JSON.stringify(undone.ok ? undone.data : undone.error));
        }
      }
    }
    if (receipt?.commandId) {
      const restored = await read();
      // The board must be exactly the captured prior state, and only the verifier's undo may have moved it on.
      lastSeen = undone?.ok ? adopt(beforeUndo, restored, undone.data?.receipt, (b) => boardState(b) === priorBoard) : { refused: "the verifier's choice was not taken back" };
      // A failed or malformed read proves nothing: require the board itself before judging its selection.
      check("after the undo the board is exactly as before (board, choice, every option's pieces)", Boolean(restored?.boardId) && restored.boardId === board.boardId && choiceOf(restored) === initialChoice && boardState(restored) === priorBoard, restored?.boardId ? `before ${priorBoard}, after ${boardState(restored)}` : "garderobe_today failed or returned no board, so the restore is not shown");
    }

    // The owner may have chosen or edited the board while this ran: stop before the swap if so.
    const swapAllowed = swapDecision({ realBoard: realBoardRun({ workerLocal, ferrite, loopback, disposable: disposableInstance }), allowRealSwap });
    if (!swapAllowed.ok) {
      check("piece swap on the owner's real board", false, `not run: ${swapAllowed.reason}`);
      return { date, timeZone, boardId: board.boardId };
    }
    const boardNow = await guard("piece swap", lastSeen);
    if (!boardNow) return { date, timeZone, boardId: board.boardId };
    const pieces = (b) => JSON.stringify((b?.options?.find((o) => o.optionId === option.optionId)?.garments ?? []).map((g) => `${g.role}:${g.garmentId}`).sort());
    const inRole = (b, role) => JSON.stringify((b?.options?.find((o) => o.optionId === option.optionId)?.garments ?? []).filter((g) => g.role === role).map((g) => g.garmentId).sort());
    const optionNow = boardNow.options?.find((o) => o.optionId === option.optionId);
    // Swap a role the option actually has (a top when it has one).
    const role = optionNow?.garments?.some((g) => g.role === "top") ? "top" : optionNow?.garments?.[0]?.role;
    const swap = role ? await call("garderobe_command", { type: "board.swap_slot", payload: { boardId: boardNow.boardId, optionId: option.optionId, role }, expectedVersions: versionsOf(boardNow), idempotencyKey: `codex-verify-swap-${Date.now()}` }) : { ok: false, error: { code: "no_role", message: "the option has no pieces to swap" } };
    const proposalId = swap.error?.details?.proposalId;
    if (swap.ok && swap.data?.receipt?.commandId) {
      // The owner asked for it, so under the 2026-10-05 contract it applies at once. Check that it really changed
      // the piece in that role, then always take it back and check the option is exactly as before.
      let back = null;
      let swapSeen = { refused: "the board could not be read after the swap" };
      try {
        const swapped = await read();
        swapSeen = adopt(boardNow, swapped, swap.data.receipt, (b) => inRole(b, role) !== inRole(boardNow, role));
        check(`contract 2026-10-05: a requested piece swap applies at once with a receipt (the ${role} changed)`, Boolean(swapped?.boardId) && inRole(swapped, role) !== "[]" && inRole(swapped, role) !== inRole(boardNow, role), swapped ? `${swap.data.receipt.summary ?? swap.data.receipt.commandId}; ${role} before ${inRole(boardNow, role)}, after ${inRole(swapped, role)}` : "garderobe_today returned no board");
      } finally {
        const beforeSwapUndo = await guard("undo of the swap", swapSeen, true);
        if (beforeSwapUndo) {
          back = await call("garderobe_command", { type: "command.undo", payload: { commandId: swap.data.receipt.commandId }, expectedVersions: versionsOf(beforeSwapUndo), idempotencyKey: `codex-verify-undo-swap-${Date.now()}` });
          check("undo: command.undo takes the swap back with its own receipt", back.ok && back.data?.receipt?.commandId, back.ok && back.data?.receipt ? back.data.receipt.summary ?? back.data.receipt.commandId : JSON.stringify(back.ok ? back.data : back.error));
        }
      }
      // The undo must put the whole board back as it was: same board, same choice, every option's pieces.
      const afterSwapUndo = await call("garderobe_today", { date });
      const restoredBoard = afterSwapUndo.ok ? afterSwapUndo.data?.board : null;
      check("after undoing the swap the board is exactly as before (board, choice, every option's pieces)", Boolean(restoredBoard?.boardId) && restoredBoard.boardId === boardNow.boardId && pieces(boardNow) !== "[]" && boardState(restoredBoard) === boardState(boardNow), afterSwapUndo.ok ? (restoredBoard?.boardId ? `before ${boardState(boardNow)}, after ${boardState(restoredBoard)}` : "garderobe_today returned no board") : JSON.stringify(afterSwapUndo.error));
      // A swap sent with the board version read before the swap (now stale: the swap and its undo advanced it) must
      // be refused as a version conflict and change nothing. This exercises unchangedAfterUnapplied on a server that
      // applies swaps at once. A revision that did not move is a failure, not a reason to skip the check.
      if (back?.ok && restoredBoard?.boardId) {
        const sameBoardRestored = restoredBoard.boardId === boardNow.boardId && boardState(restoredBoard) === boardState(boardNow);
        const advanced = Number.isSafeInteger(restoredBoard.revision) && Number.isSafeInteger(boardNow.revision) && restoredBoard.revision > boardNow.revision;
        if (!sameBoardRestored) {
          check("a swap sent with a stale board version is refused as a conflict", false, `not run: the board after the undo is not the swapped board restored (${restoredBoard.boardId}); the verifier does not write to it`);
        } else if (!advanced) {
          check("a swap sent with a stale board version is refused as a conflict", false, `not shown: the swap and its undo moved the board from revision ${boardNow.revision} to ${restoredBoard.revision}, not forward, so no earlier version is known to be stale`);
        } else {
          const stale = await call("garderobe_command", { type: "board.swap_slot", payload: { boardId: restoredBoard.boardId, optionId: option.optionId, role }, expectedVersions: versionsOf(boardNow), idempotencyKey: `codex-verify-stale-swap-${Date.now()}` });
          const afterStale = await call("garderobe_today", { date });
          const unchanged = unchangedAfterUnapplied(restoredBoard, afterStale.ok ? afterStale.data?.board : null);
          check("a swap sent with a stale board version is refused as a conflict", !stale.ok && stale.error?.code === "conflict", stale.ok ? `applied: ${stale.data?.receipt?.summary ?? stale.data?.receipt?.commandId}` : `${stale.error?.code}: ${stale.error?.message}`);
          check("the refused stale swap left the board unchanged (board, revision, choice, every option's pieces)", unchanged.ok, afterStale.ok ? unchanged.reason : JSON.stringify(afterStale.error));
          // Should a server wrongly apply it, take it back so the run leaves nothing behind.
          if (stale.ok && stale.data?.receipt?.commandId) {
            const current = await read();
            if (current) await call("garderobe_command", { type: "command.undo", payload: { commandId: stale.data.receipt.commandId }, expectedVersions: versionsOf(current), idempotencyKey: `codex-verify-undo-stale-${Date.now()}` });
          }
        }
      }
    } else {
      // Waiting for the owner is the superseded policy for this change, so it fails the contract check.
      check(`contract 2026-10-05: a requested piece swap applies at once with a receipt (the ${role ?? "piece"} changed)`, false, swap.error?.code === "confirmation_required" ? `the server kept it for the owner's confirmation (confirmation_required: ${swap.error?.details?.summary ?? swap.error?.message}); the 2026-10-05 contract is not implemented on this server yet` : `${swap.error?.code}: ${swap.error?.message}`);
      // A swap kept for the owner must name its proposal, so the owner (and the cleanup below) can decide exactly it.
      if (swap.error?.code === "confirmation_required") check("the swap kept for the owner names its proposal", typeof proposalId === "string" && proposalId.length > 0, proposalId ? `proposal ${proposalId}` : "confirmation_required without a proposal identifier");
      // Whatever the answer, a swap that was not applied must leave the board exactly as it was read just before the
      // request (boardNow): same board, same revision, same choice and pieces.
      if (role) {
        const afterRefusedSwap = await call("garderobe_today", { date });
        const unchanged = unchangedAfterUnapplied(boardNow, afterRefusedSwap.ok ? afterRefusedSwap.data?.board : null);
        check("a swap that was not applied left the board unchanged (board, revision, choice, every option's pieces)", unchanged.ok, afterRefusedSwap.ok ? unchanged.reason : JSON.stringify(afterRefusedSwap.error));
      }
    }
    if (local && proposalId) {
      const rejected = await local.api("POST", `/v1/proposals/${proposalId}/decision`, { decision: "reject" });
      check("cleanup (local, as the owner in the app): the proposal is rejected", rejected.ok, rejected.json?.proposal?.state);
    }
    return { date, timeZone, boardId: board.boardId };
  } finally {
    await server.close();
  }
}

try {
  // Each setup step depends on the one before it: a failed one stops the run (reported, then cleaned up below),
  // so a missing or non-executable CODEX_BIN ends here with a FAIL line instead of an unhandled spawn error.
  const require = (passed, what) => {
    if (!passed) throw new Error(`stopped: ${what} failed, so the steps that depend on it were not run`);
  };
  const ran = codex("--version");
  const version = (ran.stdout ?? "").trim();
  require(check("Codex CLI available", !ran.error && ran.status === 0 && version.startsWith("codex"), timedOut(ran) ? outcome(ran) : ran.error ? `${CODEX}: ${ran.error.message}` : version || `exit ${ran.status}`), "the Codex CLI check");
  console.log(`MCP server: ${mcpUrl} (${ferrite ? (loopback ? "LOCAL Ferrite app (ferrite dev), not a hosted deployment" : "Ferrite deployment") : loopback ? "LOCAL Worker, not a hosted deployment" : "hosted"})`);
  const added = codex("plugin", "marketplace", "add", marketplaceRoot);
  require(check("codex plugin marketplace add", added.status === 0, outcome(added)), "codex plugin marketplace add");
  const installed = codex("plugin", "add", "wardrobe@wardrobe-codex");
  require(check("codex plugin add wardrobe@wardrobe-codex", installed.status === 0, outcome(installed)), "codex plugin add");
  const listed = codex("mcp", "list");
  require(check("the plugin's MCP server is configured in Codex", !listed.error && listed.status === 0 && /wardrobe\s+\S*\/mcp/.test(listed.stdout ?? ""), timedOut(listed) || listed.error || listed.status !== 0 ? `${outcome(listed)} (exit ${listed.status})` : (listed.stdout ?? "").trim().split("\n")[1]), "the MCP server configuration check");
  await login();
  await toolsThroughCodex();
} catch (error) {
  check("verification completed without an unexpected error", false, String(error?.stack ?? error));
} finally {
  try {
    // Delete the credentials Codex stored (best effort, bounded to 20 s; a missing Codex has nothing to log out). This
    // removes Codex's local copy only; it is not shown to revoke the grant on the server, which the owner removes in
    // the app under Settings › Connected assistants.
    const loggedOut = spawnSync(CODEX, ["mcp", "logout", "wardrobe"], { env, encoding: "utf8", input: "", timeout: 20_000, killSignal: "SIGKILL" });
    if (!loggedOut.error && loggedOut.status !== 0) console.log(`note: codex mcp logout wardrobe exited ${loggedOut.status}: ${(loggedOut.stderr || loggedOut.stdout || "").trim().split("\n")[0]}`);
    if (loggedOut.error && loggedOut.error.code === "ETIMEDOUT") console.log("note: codex mcp logout wardrobe did not finish within 20 s");
  } finally {
    // The home holds the grant (file store): it is deleted whatever happened to the logout.
    rmSync(codexHome, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.pass);
const summary = { mcpUrl: mcpUrl.toString(), target: ferrite ? (loopback ? "local Ferrite app (not hosted)" : "Ferrite deployment") : loopback ? "local Worker (not hosted)" : "hosted", registration, model: "none (Codex runs only OpenAI models, which the project does not authorize)", at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results };
if (reportPath) writeFileSync(reportPath, JSON.stringify(summary, null, 2) + "\n");
console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
process.exit(failed.length === 0 ? 0 : 1);
