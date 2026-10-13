/**
 * The Ferrite CLI as the tooling uses it, and what its answers mean for credentials. Every output that reaches the
 * console or evidence goes through redaction first (lib/redact.mjs).
 *
 * Which steps need the owner's Ferrite account credential is listed in STEPS below. The account is a credential
 * document imported with `ferrite login --credentials-file <path>`; FERRITE_OWNER_TOKEN alone is answered 401
 * "present a Ferrite account token" by the platform's MCP endpoint.
 */
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactText } from "./redact.mjs";

export const FERRITE_TOOLING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = path.resolve(FERRITE_TOOLING_DIR, "..", "..");
export const APP_DIR = path.join(REPO_DIR, "ferrite");
export const EVIDENCE_DIR = path.join(FERRITE_TOOLING_DIR, "evidence");
export const STATE_DIR = path.join(FERRITE_TOOLING_DIR, ".state");

/** Each step of the tooling and whether it needs the owner's Ferrite account. */
export const STEPS = Object.freeze([
  { step: "ferrite check", needsAccount: false, what: "admission gate, spec statics, cargo check (local)" },
  { step: "ferrite test", needsAccount: false, what: "the crate's unit and harness tests (local)" },
  { step: "ferrite dev + node deploy/ferrite/verify.mjs --local", needsAccount: false, what: "the HTTP verification against the local plane" },
  { step: "ferrite account", needsAccount: true, what: "confirms the signed-in account with the platform" },
  { step: "ferrite host", needsAccount: true, what: "the app's origin before and after its first deploy" },
  { step: "ferrite secrets set WARDROBE_OWNER_TOKEN / WARDROBE_ASSISTANT_TOKEN / WARDROBE_PUBLIC_ORIGIN", needsAccount: true, what: "the app's bearer tokens and its public origin, from stdin" },
  { step: "ferrite deploy", needsAccount: true, what: "one charged build and rollout" },
  { step: "ferrite status / ferrite logs", needsAccount: true, what: "running instances and recent logs" },
  { step: "node deploy/ferrite/verify.mjs --deployed", needsAccount: true, what: "the same HTTP verification against the deployed origin (needs the host and the deployed tokens)" },
  { step: "node deploy/ferrite/teardown.mjs --execute", needsAccount: true, what: "secrets deleted and the app scaled to zero instances" },
]);

/** Child processes started by spawnAsync that are still running (a forced exit kills them). */
export const activeChildren = new Set();
/**
 * `exitPolicy.keepLocks` is set only by a command's own abort path (deploy, teardown or verify, each of which holds
 * at most one target lock in its process): it keeps that process's lock. Killing commands (abortChildren) never sets
 * it; it marks only the lock scopes of the commands it killed.
 */
export const exitPolicy = { keepLocks: false };
/**
 * The target-lock scope a command runs in (set by withTargetLock in lib/state.mjs): `{ children, keep }`. A command
 * started inside it is registered there, and a command that times out marks it `keep`, so that lock alone is kept
 * while the remote operation may still be settling. Other targets' locks and commands are not affected.
 */
export const lockScope = new AsyncLocalStorage();

/** Send a signal to a child's whole process group when it leads one (started detached), else to the child alone. */
export function signalTree(child, signal) {
  try {
    if (child.pid && child._wardrobeDetached) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

/** SIGKILL a child, and its whole process group when it was started detached (its own children included). */
export function killTree(child) {
  signalTree(child, "SIGKILL");
}

/**
 * On a failure or forced exit: kill every command still running (whole groups). The lock of each target whose
 * command was killed is kept (`keep` on that command's lock scope), since its remote operation may still be
 * settling; a command outside any lock keeps nothing, and no other target's lock is affected. Returns whether any
 * command was running.
 */
export function abortChildren() {
  if (activeChildren.size === 0) return false;
  for (const child of activeChildren) {
    if (child._wardrobeScope) child._wardrobeScope.keep = true;
    killTree(child);
  }
  return true;
}

/**
 * A console echo of a command's output that is safe across line breaks: output is held and the WHOLE of it is
 * redacted once, when the command ends, so a credential spanning lines or chunks (a quoted value with a newline, URL
 * userinfo split across lines) keeps its context. Nothing is written before the command ends. `known` is an array of
 * secrets or a function returning one (read at the end, so secrets created meanwhile are covered). The whole output
 * is held up to `maxUnits` UTF-16 code units (a bound on memory, about 8 MiB at most); output that exceeds it is not
 * shown at all, only a notice, since any cut could separate a credential from the context that identifies it.
 */
function lineEcho(stream, known, maxUnits = 4 << 20) {
  let held = "";
  let overflow = false;
  const secrets = () => (typeof known === "function" ? known() : known) ?? [];
  return {
    push(chunk) {
      if (overflow) return;
      held += chunk;
      if (held.length > maxUnits) {
        held = "";
        overflow = true;
      }
    },
    flush() {
      if (overflow) stream.write("[the command's output exceeded the echo limit and is not shown]\n");
      else if (held) stream.write(redactText(held, secrets(), Number.MAX_SAFE_INTEGER));
      held = "";
      overflow = false;
    },
  };
}

/**
 * Run a command without blocking the event loop, so signal handlers run while it does. Resolves (never rejects);
 * output is returned raw for parsing and must be redacted before it is shown. `echo` (an array of secrets, or a
 * function returning one) also shows the output on the console when the command ends, redacted as a whole; output is
 * never passed
 * through unredacted (`echoTo` names the two console streams). `onChild` receives the child process, e.g. to forward signals to it.
 */
export function spawnAsync(command, args, { cwd = APP_DIR, input, timeoutMs = 600_000, env = process.env, echo = null, echoTo = [process.stdout, process.stderr], detached = true, onChild } = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    // Raw output for parsing is kept as bytes, bounded at 8 MiB per stream; anything beyond is dropped and the
    // command's result carries an error. The bytes are decoded once, when the command ends.
    const raw = { out: [], err: [], outBytes: 0, errBytes: 0 };
    let stdout = "";
    let stderr = "";
    let error = null;
    let settled = false;
    let timedOut = false;
    const outEcho = echo ? lineEcho(echoTo[0], echo) : null;
    const errEcho = echo ? lineEcho(echoTo[1], echo) : null;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      // Ended by a signal (from us or from outside): its remote step may still be settling, so its lock is kept.
      if (signal && scope) scope.keep = true;
      outEcho?.push(outDecoder.decode());
      errEcho?.push(errDecoder.decode());
      outEcho?.flush();
      errEcho?.flush();
      stdout = Buffer.concat(raw.out).toString("utf8");
      stderr = Buffer.concat(raw.err).toString("utf8");
      clearTimeout(timer);
      activeChildren.delete(child);
      scope?.children.delete(child);
      resolve({ args, status: Number.isInteger(status) ? status : null, signal: signal ?? null, stdout, stderr, error: error ?? (outputTruncated ? "output exceeded 8 MiB and was truncated" : null), outputTruncated, timedOut, ms: Date.now() - started });
    };
    // Every command runs in its own process group (`detached`, the default): a terminal Ctrl-C reaches only this
    // process, so the running step finishes (a forwarded signal is explicit), and a timeout or forced exit kills the
    // command's whole group, descendants included, so nothing keeps running or holds its pipes open.
    const child = spawn(command, args, { cwd, env, detached, stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    const scope = lockScope.getStore();
    scope?.children.add(child);
    child._wardrobeScope = scope ?? null;
    child._wardrobeDetached = detached;
    const timer = setTimeout(() => {
      timedOut = true;
      error = `timed out after ${timeoutMs} ms`;
      // The command may have changed the target remotely before it was killed: its lock is kept.
      if (scope) scope.keep = true;
      killTree(child);
    }, timeoutMs);
    onChild?.(child);
    // Raw output for parsing is bounded too (8 MiB per stream); beyond it the command's output is marked truncated.
    const MAX_RAW = 8 << 20;
    let outputTruncated = false;
    const keep = (which, chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const room = MAX_RAW - raw[`${which}Bytes`];
      if (buf.length > room) outputTruncated = true;
      if (room > 0) {
        const part = buf.length > room ? buf.subarray(0, room) : buf;
        raw[which].push(part);
        raw[`${which}Bytes`] += part.length;
      }
    };
    // Echo decodes each stream with its own streaming decoder, so a multi-byte character split across chunks is kept.
    const outDecoder = new TextDecoder();
    const errDecoder = new TextDecoder();
    child.stdout?.on("data", (c) => {
      keep("out", c);
      outEcho?.push(outDecoder.decode(Buffer.isBuffer(c) ? c : Buffer.from(String(c)), { stream: true }));
    });
    child.stderr?.on("data", (c) => {
      keep("err", c);
      errEcho?.push(errDecoder.decode(Buffer.isBuffer(c) ? c : Buffer.from(String(c)), { stream: true }));
    });
    child.once("error", (e) => {
      error = String(e.message);
      finish(null, null);
    });
    child.once("close", finish);
    if (child.stdin) {
      // A command that closes stdin early must not turn into an uncaught EPIPE: record it as the command's error.
      child.stdin.on("error", (e) => {
        error ??= `stdin: ${e.code ?? e.message}`;
      });
      child.stdin.end(input ?? "");
    }
  });
}

/** The CLI, asynchronously (see spawnAsync). Used by every step of deploy, verify and teardown. */
export function ferriteAsync(args, opts = {}) {
  return spawnAsync("ferrite", args, opts);
}

/**
 * A CLI result as it may be WRITTEN to evidence: the command, exit status, signal, timing and output sizes only. No
 * output text goes into evidence; `cliDiagnostics` gives the redacted text for the console.
 */
export function cliEvidence(result) {
  return {
    command: `ferrite ${result.args.join(" ")}`,
    exit: Number.isInteger(result.status) ? result.status : null,
    signal: typeof result.signal === "string" ? result.signal : null,
    ms: Number.isFinite(result.ms) ? result.ms : null,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
    spawnFailed: Boolean(result.error),
  };
}

/**
 * The redacted tail of a CLI result's output, for the console only (never evidence). Redacted whole, then cut. Output
 * that was truncated at capture is not shown at all: a known secret cut at the capture boundary would no longer match.
 */
export function cliDiagnostics(result, known = [], max = 1500) {
  if (result.outputTruncated) return redactText(`output exceeded the capture limit and is not shown${result.error ? `; ${result.error}` : ""}`, known);
  const text = redactText(`${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error ?? ""}`.trim(), known, Number.MAX_SAFE_INTEGER);
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

/**
 * What a CLI answer says about the account. `signed_in` only when `ferrite account` names an account and exits 0;
 * otherwise the exact reason: no endpoint configured, not logged in, or the platform refused the token.
 */
export function accountState(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.error && /ENOENT/.test(result.error)) return { state: "no_cli", reason: "the ferrite CLI is not on PATH" };
  if (/present a Ferrite account token/i.test(text) || /\b401\b/.test(text)) return { state: "token_rejected", reason: "the platform answered 401 \"present a Ferrite account token\": the configured token is not a Ferrite account token" };
  if (/no Ferrite Cloud endpoint configured/i.test(text)) return { state: "no_endpoint", reason: "no Ferrite Cloud endpoint is configured (no credential document has been imported with `ferrite login --credentials-file`)" };
  if (/account:\s*not logged in/i.test(text)) return { state: "not_logged_in", reason: "`ferrite account` reports not logged in: no credential document at ~/.config/ferrite/credentials.toml" };
  const account = /^account:\s*(\S+)/m.exec(text)?.[1];
  if (result.status === 0 && account && account !== "not") return { state: "signed_in", account, reason: null };
  return { state: "unknown", reason: `ferrite exited ${result.status}` };
}

/**
 * Read-only probe of the platform's MCP endpoint with the token in the environment, recording only the status and
 * the error code it answers (never the token). Used to show why a deploy cannot start.
 */
export async function probeEndpoint({ endpoint = process.env.FERRITE_MCP_ENDPOINT, token = process.env.FERRITE_OWNER_TOKEN, fetchImpl = fetch, known = [] } = {}) {
  if (!endpoint) return { probed: false, reason: "FERRITE_MCP_ENDPOINT is not set" };
  const started = Date.now();
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    // Evidence keeps the status, an error CODE only when it is a short identifier, and a fixed classification of the
    // description; no remote text is written.
    const secrets = [token, ...known].filter((v) => typeof v === "string" && v.length > 0);
    const identifier = typeof body?.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(body.error) && !secrets.some((s) => body.error.includes(s) || s.includes(body.error)) && redactText(body.error, secrets) === body.error;
    const code = identifier ? body.error : body?.error == null ? null : "unrecognised";
    const description = typeof body?.error_description === "string" ? body.error_description : "";
    return { probed: true, tokenPresented: Boolean(token), status: res.status, error: code, accountTokenRequired: /present a Ferrite account token/i.test(description), ms: Date.now() - started };
  } catch (error) {
    return { probed: true, tokenPresented: Boolean(token), status: null, error: error?.name === "TimeoutError" ? "timeout" : "unreachable", ms: Date.now() - started };
  }
}

/** Origin validation lives in lib/origin.mjs; re-exported here for the commands. */
export { deployedOrigin, localOrigin, originForEvidence } from "./origin.mjs";

/**
 * The app the CLI deploys, from the port's own spec (read only; wardrobe/ferrite/ belongs to the port thread). The
 * CLI acts on the whole spec, so a spec with more than one application is refused: only one app can be confirmed.
 */
export function appSpec(appDir = APP_DIR) {
  const spec = JSON.parse(readFileSync(path.join(appDir, "ferrite.json"), "utf8"));
  const apps = Array.isArray(spec.applications) ? spec.applications : [];
  if (apps.length !== 1) throw new Error(`ferrite/ferrite.json declares ${apps.length} applications; the tooling deploys exactly one`);
  const app = apps[0];
  return { name: app?.name ?? null, routes: (app?.routes ?? []).map((r) => r.prefix), services: (spec.services ?? []).map((s) => `${s.name}:${s.primitive}`) };
}

/** The local-only bearer tokens `ferrite dev` injects, from `[secrets]` in ferrite/ferrite.local.toml. */
export function localTokens(appDir = APP_DIR) {
  let text = "";
  try {
    text = readFileSync(path.join(appDir, "ferrite.local.toml"), "utf8");
  } catch {
    return { owner: null, assistant: null, publicOrigin: null };
  }
  const section = text.split(/^\[secrets\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
  const value = (name) => new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m").exec(section)?.[1] ?? null;
  return { owner: value("WARDROBE_OWNER_TOKEN"), assistant: value("WARDROBE_ASSISTANT_TOKEN"), publicOrigin: value("WARDROBE_PUBLIC_ORIGIN") };
}
