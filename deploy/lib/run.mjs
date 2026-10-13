/**
 * Running Wrangler and the operations Worker's resumable calls, shared by deploy, verify and rehearse.
 */
import { execFileSync, spawn } from "node:child_process";
import { REPO_ROOT } from "./config.mjs";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

/** Run Wrangler to completion. Output is returned, never echoed, so nothing Wrangler prints reaches a log by accident. */
export function wrangler(args, { env = {}, allowFailure = false } = {}) {
  const started = Date.now();
  try {
    const stdout = execFileSync(npx, ["wrangler", ...args], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", ...env }, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout, ms: Date.now() - started };
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (!allowFailure) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed (exit ${error.status}): ${output.trim().split("\n").slice(-12).join("\n")}`);
    return { ok: false, stdout: output, ms: Date.now() - started, status: error.status };
  }
}

export function wranglerBackground(args, { env = {}, onLine = () => undefined } = {}) {
  // Its own process group, so stopping it also stops the runtime processes Wrangler starts.
  const child = spawn(npx, ["wrangler", ...args], { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", ...env } });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => String(chunk).split("\n").forEach((line) => line && onLine(line)));
  child.stopGroup = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  return child;
}

/**
 * Seed through the operations Worker until it reports completion. One invocation of a Worker has a
 * bounded number of database queries, so the import may take several calls; each call replays what is
 * already stored and continues. The number of calls is part of the evidence.
 */
export async function seedUntilComplete(client, { invite = [], maxCalls = 40 } = {}) {
  const calls = [];
  for (let i = 1; i <= maxCalls; i++) {
    // Invitations are requested only on the call that completes, so an interrupted call never strands a code.
    const r = await client.ops("/ops/seed", { invite: [] });
    calls.push({ call: i, status: r.status, complete: r.json?.complete === true, ms: r.json?.ms ?? null, error: r.json?.error ?? null });
    if (r.status !== 200) throw new Error(`seed call ${i} answered HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    if (r.json?.complete === true) {
      const final = invite.length ? await client.ops("/ops/seed", { invite }) : r;
      if (final.json?.complete !== true) throw new Error(`the invitation call failed: ${final.text.slice(0, 200)}`);
      return { calls, result: final.json };
    }
  }
  throw new Error(`the seed did not complete in ${maxCalls} calls; last error: ${calls.at(-1)?.error}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
