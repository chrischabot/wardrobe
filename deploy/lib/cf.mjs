/**
 * Cloudflare management API client for the deployment tooling.
 *
 * The management token is read from the environment (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID), is
 * sent only to api.cloudflare.com, and is never printed, stored, bound to a Worker or used as an
 * application login. Every write goes through `write()`, which requires the target's name and refuses
 * anything the guard in config.mjs does not accept. Reads are unrestricted (listing what exists).
 */
import { GuardError } from "./config.mjs";

const BASE = "https://api.cloudflare.com/client/v4";

export class CfError extends Error {
  constructor(method, path, status, errors) {
    super(`${method} ${path} -> HTTP ${status}: ${JSON.stringify(errors)}`);
    this.status = status;
    this.errors = errors;
  }
}

export class MissingCredentialError extends Error {
  constructor(missing) {
    super(`not set in the environment: ${missing.join(", ")} (project secrets; names only are reported, values are never printed)`);
    this.name = "MissingCredentialError";
    this.missing = missing;
  }
}

/** Which of the given variable names are set. Names and booleans only. */
export function presence(names, env = process.env) {
  return Object.fromEntries(names.map((name) => [name, Boolean(env[name])]));
}

export function credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const missing = [...(token ? [] : ["CLOUDFLARE_API_TOKEN"]), ...(accountId ? [] : ["CLOUDFLARE_ACCOUNT_ID"])];
  if (missing.length) throw new MissingCredentialError(missing);
  return { token, accountId };
}

/** Journal of every write attempted in this process (names, kinds and statuses only). */
export const journal = [];

async function call(method, path, body) {
  const { token } = credentials();
  const started = Date.now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: response.status, ok: response.ok && json?.success !== false, json, ms: Date.now() - started };
}

/** Read-only request. Returns `result`; throws CfError on failure. */
export async function read(path) {
  const r = await call("GET", path);
  if (!r.ok) throw new CfError("GET", path, r.status, r.json?.errors ?? null);
  return r.json.result;
}

/** Read that reports failure instead of throwing (permission probes). */
export async function tryRead(path) {
  const r = await call("GET", path);
  return { ok: r.ok, status: r.status, result: r.json?.result ?? null, errors: r.json?.errors ?? null, resultInfo: r.json?.result_info ?? null };
}

/** All pages of a list endpoint. */
export async function readAll(path, perPage = 100) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const r = await call("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}&page=${page}`);
    if (!r.ok) throw new CfError("GET", path, r.status, r.json?.errors ?? null);
    const items = Array.isArray(r.json.result) ? r.json.result : (r.json.result?.buckets ?? []);
    out.push(...items);
    const info = r.json.result_info;
    if (!info || !info.total_pages || page >= info.total_pages || items.length === 0) break;
  }
  return out;
}

/**
 * A write. `guard` is the function that validates the target (`assertDevName`, `assertDevHost`, ...)
 * and `target` the name it is applied to; a write without a guarded target cannot be expressed.
 */
export async function write(method, path, body, { kind, target, guard, dryRun = false }) {
  if (typeof guard !== "function" || !target) throw new GuardError(`write ${method} ${path} has no guarded target`);
  guard(target, kind);
  const entry = { at: new Date().toISOString(), method, kind, target, dryRun, status: null };
  journal.push(entry);
  if (dryRun) return null;
  const r = await call(method, path, body);
  entry.status = r.status;
  entry.ms = r.ms;
  if (!r.ok) throw new CfError(method, path, r.status, r.json?.errors ?? null);
  return r.json?.result ?? null;
}

export const accountPath = (suffix) => `/accounts/${credentials().accountId}${suffix}`;
