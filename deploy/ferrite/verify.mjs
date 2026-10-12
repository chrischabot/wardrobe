#!/usr/bin/env node
/**
 * Verify the Wardrobe Ferrite app over HTTP, with real requests and the app's own receipts as evidence.
 *
 *   node deploy/ferrite/verify.mjs --local --start-dev [--port N]  start `ferrite dev --fresh` on a FREE port (default
 *                                                                  8790), verify, stop it
 *   node deploy/ferrite/verify.mjs --local [--origin URL]          verify a `ferrite dev` that is already running
 *   node deploy/ferrite/verify.mjs --deployed [--origin URL]       verify the deployed app of the signed-in account
 *                                                                  (needs the owner's Ferrite account; see lib/cli.mjs)
 *
 * Every check is required unless it is marked as not applicable to the slice (cross-owner isolation: one owner per
 * deployment). The run passes only when no check failed AND no required check was skipped, so a wardrobe without the
 * garments a check needs fails the gate instead of passing it untested. No command is sent until the starting
 * inventory and receipt list have both been read. Every command the run sends is tracked with its exact body; a
 * `finally` block replays each one (the app answers a repeated request from its receipt, so the replay names the
 * receipt the run itself created, never anyone else's) and undoes those receipts only. A command another client sent
 * meanwhile is never touched; it leaves the balances changed, and the cleanup check then fails and says so. Evidence
 * holds statuses, ids, counts and timings only, redacted.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { APP_DIR, EVIDENCE_DIR, REPO_DIR, STATE_DIR, abortChildren, accountState, activeChildren, appSpec, deployedOrigin, exitPolicy, ferriteAsync, killTree, localOrigin, localTokens, originForEvidence, signalTree } from "./lib/cli.mjs";
import { redact, redactError, redactText } from "./lib/redact.mjs";
import { knownSecrets, readTokens, withTargetLock } from "./lib/state.mjs";

export const EXPECTED = Object.freeze({ garments: 127, ownedUnits: 144 });
export const CSV_PATH = path.join(REPO_DIR, "requirements", "wardrobe_inventory_clean.csv");

/** SHA-256 of the owner's inventory CSV as supplied, the digest the app must report as its source. */
export function csvSha256(file = CSV_PATH) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * A documented refusal: the expected status and error code, and a body that is the API's error object and nothing
 * else (`{"error":{"code","message","details"?}}`). A sign-in refusal (401) must carry no details either.
 */
export function refusal(res, status, code) {
  const body = res?.json;
  if (res?.status !== status || !body || typeof body !== "object" || Array.isArray(body)) return false;
  if (Object.keys(body).join(",") !== "error") return false;
  const e = body.error;
  if (!e || typeof e !== "object" || e.code !== code || typeof e.message !== "string") return false;
  if (!Object.keys(e).every((k) => ["code", "message", "details"].includes(k))) return false;
  // A sign-in refusal discloses nothing: details absent, null or an empty object.
  if (status === 401 && e.details !== undefined && e.details !== null) {
    if (typeof e.details !== "object" || Array.isArray(e.details) || Object.keys(e.details).length) return false;
  }
  return true;
}

/** The documented refusals a replayed request may get; with them nothing was written. */
const REPLAY_REFUSALS = [[400, "invalid_command"], [400, "unknown_command"], [403, "forbidden"], [404, "not_found"], [409, "precondition_failed"], [409, "idempotency_key_reuse"]];

/** Laundered single garments that are clean now, from an inventory page. */
export function launderableClean(page, n = 2) {
  return (page?.items ?? []).filter((i) => i.careChannel === "service" && Number(i.balances?.clean) >= 1 && Number(i.quantity) === 1).slice(0, n).map((i) => i.garmentId);
}

/** The balances of one garment on a page, or null. */
export function balancesOf(page, garmentId) {
  return (page?.items ?? []).find((i) => i.garmentId === garmentId)?.balances ?? null;
}

/** garmentId → balances for a page. */
function balanceMap(page) {
  return new Map((page?.items ?? []).map((i) => [i.garmentId, i.balances ?? {}]));
}

/**
 * Whether `after` is `before` with exactly the given balance changes (`{ garmentId: { clean: -1, dirty: +1 } }`):
 * the same garments, every named bucket moved by its delta, every other bucket and garment unchanged. With no
 * changes it says whether the two inventories hold the same balances.
 */
export function exactlyChanged(before, after, changes = {}) {
  const b = balanceMap(before);
  const a = balanceMap(after);
  if (b.size === 0 || b.size !== a.size) return false;
  for (const [id, was] of b) {
    const now = a.get(id);
    if (!now) return false;
    const delta = changes[id] ?? {};
    const keys = new Set([...Object.keys(was), ...Object.keys(now), ...Object.keys(delta)]);
    for (const k of keys) if (Number(now[k] ?? 0) !== Number(was[k] ?? 0) + Number(delta[k] ?? 0)) return false;
  }
  return Object.keys(changes).every((id) => b.has(id));
}

/** The parts of an inventory read that two readers must see identically. */
export function inventoryView(page) {
  return {
    items: (page?.items ?? []).map((i) => ({ garmentId: i.garmentId, category: i.category, careChannel: i.careChannel, quantity: i.quantity, version: i.version, balances: i.balances })).sort((x, y) => String(x.garmentId).localeCompare(String(y.garmentId))),
    counts: page?.counts ?? null,
    sourceSha256: page?.source?.sha256 ?? null,
    wardrobeRevision: page?.wardrobeRevision ?? null,
  };
}

export function sameInventory(x, y) {
  return Boolean(x?.items?.length) && JSON.stringify(inventoryView(x)) === JSON.stringify(inventoryView(y));
}

/** A committed receipt of a command applied at once, offering undo. */
export function committedWithUndo(receipt) {
  return receipt?.outcome === "committed" && typeof receipt.commandId === "string" && receipt.commandId.length > 0 && receipt.undo?.available === true && Number.isInteger(receipt.wardrobeRevision) && typeof receipt.summary === "string" && receipt.summary.length > 0;
}

/** Whether a run passes: nothing failed, and every required check ran. */
export function gatePasses(results) {
  return results.length > 0 && !results.some((r) => r.status === "fail" || (r.status === "not_run" && r.required !== false));
}

export function command(type, payload, idempotencyKey, authorization, channel) {
  return { type, payload, idempotencyKey, authorization, source: { channel } };
}

/**
 * Write requests (anything but GET) sent and not yet answered: their remote effect may still be committing. A write
 * that ended without any answer (a client timeout or a connection error) is counted as `unanswered`: the server may
 * still commit it, so only a cleanup that confirmed every own receipt resolves it.
 */
const inFlight = { writes: 0, unanswered: 0 };
export const writesInFlight = () => inFlight.writes;
export const writesUnanswered = () => inFlight.unanswered;

/**
 * Keep every held target lock (as for a running command) while a write may still commit remotely: one is in flight,
 * or one went unanswered and `cleanupConfirmed` is not true. No other verification, deploy or teardown of the target
 * can then overlap with that mutation. Returns whether it did.
 */
export function keepLocksForWritesInFlight(cleanupConfirmed = false) {
  if (inFlight.writes === 0 && (inFlight.unanswered === 0 || cleanupConfirmed)) return false;
  exitPolicy.keepLocks = true;
  return true;
}

export function httpClient(origin) {
  return async (token, method, route, body, scheme = "Bearer") => {
    const started = Date.now();
    const write = method !== "GET";
    let answered = false;
    if (write) inFlight.writes += 1;
    try {
      const res = await fetch(`${origin}${route}`, {
        method,
        headers: { ...(token ? { authorization: `${scheme} ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      // Answered only once the whole body arrived: headers alone carry no usable receipt.
      answered = true;
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, ms: Date.now() - started };
    } finally {
      if (write) {
        inFlight.writes -= 1;
        if (!answered) inFlight.unanswered += 1;
      }
    }
  };
}
const client = httpClient;

/** Set by the first SIGINT/SIGTERM: no further check or command starts, and the cleanup still runs. */
const interruption = { requested: false };
export const interrupted = () => interruption.requested;

/** Called with the signal name on EVERY signal, before it is handled (e.g. to forward it to a child process). */
export const signalListeners = new Set();

/**
 * Install signal handlers for a run that may have changed the wardrobe. The first SIGINT or SIGTERM stops new checks
 * and commands and lets the run undo its own changes and record that it was interrupted; a second one calls `onForce`
 * (which kills a dev server this run started) and exits with 130 without cleanup; a held target lock is still
 * released by its exit hook.
 */
export function installInterruptHandlers(onForce = () => {}) {
  const handler = (signal) => {
    for (const listener of signalListeners) {
      try {
        listener(signal);
      } catch {
        // a listener never stops the handling
      }
    }
    if (!interruption.requested) {
      interruption.requested = true;
      console.error(`${signal}: no further checks or commands; undoing this run's own changes first (send it again to abort without cleanup)`);
      return;
    }
    try {
      onForce();
      // Stop every command this process started (whole groups); if one was running, keep held locks so no other
      // deploy or teardown starts while its remote effect may still be settling.
      if (abortChildren()) console.error("aborted while a command was running: the lock of the target it was changing is kept; check `ferrite status`, then remove the lock file");
      if (keepLocksForWritesInFlight(false)) console.error("aborted while a write request was in flight or unconfirmed: any target lock is kept; check the receipts, then remove the lock file");
    } finally {
      process.exit(130);
    }
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

/**
 * Evidence keeps only the fields this tool promises, at their own paths (EVIDENCE_PATHS); any other field, remote or
 * not, is dropped, so a private value under an unexpected key never reaches a file. Values are numbers, booleans, null
 * and strings that are identifiers, ids, digests or versions; our own explanatory fields (a top-level `reason`, and
 * `what` and `expected` of our refusal outcomes) are kept as written; any other string becomes "unrecognised".
 */
const OWN_TEXT = new Set(["reason", "outcomes[].what", "outcomes[].expected"]);
const SAFE_STRING = /^[A-Za-z0-9_.:+-]{1,128}$/;
export const EVIDENCE_PATHS = new Set([
  "reason", "httpStatus", "contractVersion", "code", "items", "distinctIds", "unitsCounted",
  "counts", "counts.garments", "counts.ownedUnits", "sourceSha256", "expectedSourceSha256", "wardrobeRevision",
  "receipts", "expected", "commandId", "ownedByRun", "units", "revisionBefore", "revisionAfter", "listed",
  "replayed", "undoCommandId", "receiptUndoAvailable", "secondUndoStatus", "statuses", "revisionDelta",
  "outcomes", "outcomes[].what", "outcomes[].httpStatus", "outcomes[].code", "outcomes[].expected", "outcomes[].ok",
  "ownReceipts", "ownReceiptsStillOpen", "undoneByCleanup", "undoneByCleanup[].commandId", "undoneByCleanup[].httpStatus",
  "failedAttempts", "failedAttempts[].commandId", "failedAttempts[].httpStatus", "unresolvedReplays", "keyCollisions", "balancesRestored",
]);
export function evidenceValue(value, at = "") {
  if (value === null || value === undefined || typeof value === "boolean") return value ?? null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return OWN_TEXT.has(at) || SAFE_STRING.test(value) ? value : "unrecognised";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => (Array.isArray(v) ? "unrecognised" : evidenceValue(v, `${at}[]`)));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, v, at ? `${at}.${k}` : k])
        .filter(([, , p]) => EVIDENCE_PATHS.has(p))
        .map(([k, v, p]) => [k, evidenceValue(v, p)]),
    );
  }
  return "unrecognised";
}

/** Run every check against `origin`; returns the redacted results. */
export async function runVerification({ origin, tokens, target, runId = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`, sourceSha256 = csvSha256(), knownExtra = [] }) {
  // Every secret the run may meet: the tokens in use and the shared collector's (local, stored, platform tokens).
  const known = [tokens.owner, tokens.assistant, ...knownExtra].filter((v) => typeof v === "string" && v.length > 0);
  const call = client(origin);
  const results = [];
  const record = (group, name, status, detail = {}, ms = null, required = true) => {
    const safe = evidenceValue(redact(detail, known));
    results.push({ group, name, status, required, ms, ...safe });
    console.log(`${status.toUpperCase().padEnd(7)} ${group}: ${name}${safe.reason ? `  (${safe.reason})` : ""}`);
  };
  const check = async (group, name, run) => {
    const started = Date.now();
    if (interruption.requested) {
      record(group, name, "not_run", { reason: "the run was interrupted" }, null);
      return false;
    }
    try {
      const { pass, notRun, ...detail } = await run();
      if (notRun) record(group, name, "not_run", { ...detail, reason: notRun }, Date.now() - started);
      else record(group, name, pass ? "pass" : "fail", detail, Date.now() - started);
      return Boolean(pass);
    } catch (error) {
      // Evidence gets a fixed classification only; the redacted message goes to the console.
      console.error(`        ${group}: ${redactError(error, known)}`);
      record(group, name, "fail", { reason: "the check raised an error (message on the console only)" }, Date.now() - started);
      return false;
    }
  };
  const owner = (m, r, b) => call(tokens.owner, m, r, b);
  const assistant = (m, r, b) => call(tokens.assistant, m, r, b);
  const page = async () => {
    const r = await owner("GET", "/v1/wardrobe");
    if (r.status !== 200) throw new Error(`the inventory read answered ${r.status}`);
    return r.json;
  };
  // Every request that may have changed the wardrobe, with who sent it and its exact body, so cleanup can replay it
  // to learn the receipt it created (and only that receipt) whatever answer the original got.
  const mutations = [];
  // Every receipt an original (non-undo) request was answered with (id -> its wardrobe revision), before and apart from
  // any replay: if the app broke idempotency and a replay created another receipt, the original's is still undone.
  const answeredIds = new Map();
  const track = (who, body) => {
    if (!mutations.some((m) => m.who === who && JSON.stringify(m.body) === JSON.stringify(body))) mutations.push({ who, body });
  };
  const noteAnswer = (body, r) => {
    if (body?.type !== "command.undo" && r?.status === 200 && typeof r.json?.commandId === "string") answeredIds.set(r.json.commandId, r.json.wardrobeRevision);
    return r;
  };
  const mutate = async (who, body) => {
    if (interruption.requested) throw new Error("the run was interrupted; no further command is sent");
    track(who, body);
    return noteAnswer(body, await who("POST", "/v1/commands", body));
  };
  /** The newest receipt's id: a refusal that "writes nothing" must leave it, and the revision, unchanged. */
  const newestReceipt = async () => {
    const r = await owner("GET", "/v1/commands?limit=1");
    if (r.status !== 200 || !Array.isArray(r.json?.receipts)) throw new Error(`listing receipts answered ${r.status}`);
    return r.json.receipts[0]?.commandId ?? null;
  };

  await check("health", "the public health route answers without a token", async () => {
    const r = await call(null, "GET", "/health");
    return { pass: r.status === 200 && r.json?.status === "ok" && r.json?.host === "ferrite", httpStatus: r.status, contractVersion: r.json?.contractVersion ?? null };
  });

  await check("sign-in", "no token is refused with 401 unauthenticated and an error-only body", async () => {
    const r = await call(null, "GET", "/v1/wardrobe");
    return { pass: refusal(r, 401, "unauthenticated"), httpStatus: r.status, code: r.json?.error?.code ?? null };
  });
  await check("sign-in", "a wrong token is refused with 401 unauthenticated and an error-only body", async () => {
    const r = await call(`not-a-wardrobe-token-${runId}`, "GET", "/v1/wardrobe");
    return { pass: refusal(r, 401, "unauthenticated"), httpStatus: r.status, code: r.json?.error?.code ?? null };
  });

  // The starting point: the inventory and the receipts that existed before this run.
  let first = null;
  let preexisting = null;
  // A receipt is the run's own only if it was committed after the run read its starting revision (every commit raises
  // the wardrobe revision, and a replay answers with the original's), and is not among the receipts listed before the
  // run. Anything older, however it was reached (a reused key outside the listed page), is never undone.
  const ownedByRun = (id, revision) => Boolean(first && preexisting) && typeof id === "string" && Number.isInteger(revision) && revision > first.wardrobeRevision && !preexisting.has(id);
  try {
    await check("inventory", `the owner reads the imported inventory: ${EXPECTED.garments} garments, ${EXPECTED.ownedUnits} owned units, from the supplied CSV`, async () => {
      const r = await owner("GET", "/v1/wardrobe");
      first = r.status === 200 ? r.json : null;
      const items = r.json?.items ?? [];
      const ids = new Set(items.map((i) => i.garmentId));
      // Owned units are counted from the garments themselves, not only taken from the reported total.
      const units = items.reduce((n, i) => n + (Number.isInteger(i.quantity) && i.quantity > 0 ? i.quantity : Number.NaN), 0);
      return {
        pass: r.status === 200 && items.length === EXPECTED.garments && ids.size === items.length && units === EXPECTED.ownedUnits && r.json?.counts?.garments === EXPECTED.garments && r.json?.counts?.ownedUnits === EXPECTED.ownedUnits && r.json?.source?.sha256 === sourceSha256,
        httpStatus: r.status,
        items: items.length,
        distinctIds: ids.size,
        unitsCounted: Number.isNaN(units) ? null : units,
        counts: r.json?.counts ?? null,
        sourceSha256: r.json?.source?.sha256 ?? null,
        expectedSourceSha256: sourceSha256,
        wardrobeRevision: r.json?.wardrobeRevision ?? null,
      };
    });
    await check("inventory", "the receipts that existed before this run are listed (for reconciliation)", async () => {
      const r = await owner("GET", "/v1/commands?limit=200");
      preexisting = r.status === 200 && Array.isArray(r.json?.receipts) ? new Set(r.json.receipts.map((x) => x.commandId)) : null;
      return { pass: preexisting !== null, httpStatus: r.status, receipts: preexisting?.size ?? null };
    });
    await check("sign-in", "a lowercase bearer scheme with the owner's token reads the same inventory", async () => {
      const r = await call(tokens.owner, "GET", "/v1/wardrobe", undefined, "bearer");
      return { pass: r.status === 200 && sameInventory(r.json, first), httpStatus: r.status };
    });
    await check("inventory", "the connected assistant reads the same inventory: garments, balances, versions, counts, source and revision", async () => {
      const r = await assistant("GET", "/v1/wardrobe");
      return { pass: r.status === 200 && sameInventory(r.json, first), httpStatus: r.status, items: (r.json?.items ?? []).length };
    });
    await check("inventory", "a category filter returns exactly that category's garments", async () => {
      const category = first?.items?.[0]?.category;
      if (!category) return { notRun: "the inventory could not be read" };
      const r = await owner("GET", `/v1/wardrobe?category=${encodeURIComponent(category)}`);
      const got = (r.json?.items ?? []).map((i) => i.garmentId).sort();
      const want = first.items.filter((i) => i.category === category).map((i) => i.garmentId).sort();
      return { pass: r.status === 200 && got.length > 0 && JSON.stringify(got) === JSON.stringify(want), httpStatus: r.status, items: got.length, expected: want.length };
    });

    const [a, b] = launderableClean(first);
    // No command is sent without both starting snapshots: the inventory to restore and the receipts that were there.
    const ready = Boolean(first && Number.isInteger(first.wardrobeRevision) && preexisting && a && b);
    const unready = !first || !preexisting ? "the starting inventory or receipt list could not be read, so no command is sent" : "the inventory has fewer than two clean, single, laundered garments, so the command checks cannot run";
    let dirty = null;
    const dirtyCommand = ready ? command("care.mark_dirty", { items: [{ garmentId: a }, { garmentId: b }] }, `verify-${runId}-dirty`, "owner_statement", "mcp") : null;
    await check("command", 'the assistant relays "both in the wash": applied at once, a receipt that offers undo, exactly those balances moved', async () => {
      if (!ready) return { notRun: unready };
      const r = await mutate(assistant, dirtyCommand);
      // Checked the moment it is answered: a receipt from before this run (reached by a reused key) is never used as
      // this run's own, so no later check undoes it.
      const owned = r.status === 200 && ownedByRun(r.json?.commandId, r.json?.wardrobeRevision);
      dirty = owned ? r.json : null;
      const after = await page();
      return {
        pass: owned && committedWithUndo(r.json) && r.json.wardrobeRevision === first.wardrobeRevision + 1 && r.json.actor === "assistant" && r.json.channel === "mcp" && r.json.result?.units === 2 && exactlyChanged(first, after, { [a]: { clean: -1, dirty: 1 }, [b]: { clean: -1, dirty: 1 } }),
        httpStatus: r.status,
        commandId: r.json?.commandId ?? null,
        ownedByRun: r.status === 200 ? owned : null,
        units: r.json?.result?.units ?? null,
        revisionBefore: first?.wardrobeRevision ?? null,
        revisionAfter: r.json?.wardrobeRevision ?? null,
      };
    });
    const needDirty = () => (dirty?.commandId ? null : ready ? "the command check did not commit a receipt of this run's own, so it cannot be examined or undone" : unready);
    await check("command", "the receipt is stored and listed newest first", async () => {
      if (needDirty()) return { notRun: needDirty() };
      const one = await owner("GET", `/v1/commands/${dirty.commandId}`);
      const list = await owner("GET", "/v1/commands?limit=5");
      return { pass: one.status === 200 && one.json?.commandId === dirty.commandId && one.json?.summary === dirty.summary && (list.json?.receipts ?? [])[0]?.commandId === dirty.commandId, httpStatus: one.status, listed: (list.json?.receipts ?? []).length };
    });
    await check("idempotency", "the same request again is answered from its receipt; nothing runs twice", async () => {
      if (needDirty()) return { notRun: needDirty() };
      const before = await page();
      const top = await newestReceipt();
      const r = await mutate(assistant, dirtyCommand);
      const now = await page();
      return { pass: r.status === 200 && r.json?.commandId === dirty.commandId && r.json?.replayed === true && exactlyChanged(before, now) && now.wardrobeRevision === before.wardrobeRevision && (await newestReceipt()) === top, httpStatus: r.status, replayed: r.json?.replayed ?? null };
    });
    await check("idempotency", "the same key with another body is refused with 409 idempotency_key_reuse and writes nothing", async () => {
      if (needDirty()) return { notRun: needDirty() };
      const before = await page();
      const top = await newestReceipt();
      const r = await mutate(assistant, { ...dirtyCommand, payload: { items: [{ garmentId: a }] } });
      const now = await page();
      return { pass: refusal(r, 409, "idempotency_key_reuse") && exactlyChanged(before, now) && now.wardrobeRevision === before.wardrobeRevision && (await newestReceipt()) === top, httpStatus: r.status, code: r.json?.error?.code ?? null };
    });
    await check("isolation", "the assistant cannot claim an owner tap (403 forbidden, nothing written)", async () => {
      if (needDirty()) return { notRun: needDirty() };
      const before = await page();
      const top = await newestReceipt();
      const r = await mutate(assistant, command("command.undo", { commandId: dirty.commandId }, `verify-${runId}-tap`, "owner_tap", "mcp"));
      const now = await page();
      return { pass: refusal(r, 403, "forbidden") && exactlyChanged(before, now) && now.wardrobeRevision === before.wardrobeRevision && (await newestReceipt()) === top, httpStatus: r.status, code: r.json?.error?.code ?? null };
    });
    await check("isolation", "the owner's token cannot send on the assistant's channel (403 forbidden, nothing written)", async () => {
      if (!ready) return { notRun: unready };
      const before = await page();
      const top = await newestReceipt();
      const r = await mutate(owner, command("care.mark_dirty", { items: [{ garmentId: a }] }, `verify-${runId}-channel`, "owner_tap", "mcp"));
      const now = await page();
      return { pass: refusal(r, 403, "forbidden") && exactlyChanged(before, now) && now.wardrobeRevision === before.wardrobeRevision && (await newestReceipt()) === top, httpStatus: r.status, code: r.json?.error?.code ?? null };
    });
    await check("isolation", "a receipt cannot be read without a token", async () => {
      if (needDirty()) return { notRun: needDirty() };
      const r = await call(null, "GET", `/v1/commands/${dirty.commandId}`);
      return { pass: refusal(r, 401, "unauthenticated"), httpStatus: r.status };
    });
    record("isolation", "one owner's data is invisible to another owner", "not_run", { reason: "not applicable to the first slice, which serves one owner per deployment (ferrite/README.md); multi-owner storage arrives in milestone 1" }, null, false);

    await check("command", "the owner taps undo: every balance back as before, the undo receipt names the original", async () => {
      if (needDirty()) return { notRun: needDirty() };
      const r = await mutate(owner, command("command.undo", { commandId: dirty.commandId }, `verify-${runId}-undo`, "owner_tap", "ios"));
      const after = await page();
      return {
        pass: r.status === 200 && r.json?.outcome === "committed" && r.json?.result?.undoneCommandId === dirty.commandId && r.json?.undo?.available === false && exactlyChanged(first, after),
        httpStatus: r.status,
        undoCommandId: r.json?.commandId ?? null,
        revisionAfter: r.json?.wardrobeRevision ?? null,
      };
    });
    await check("command", "the original receipt no longer offers undo, and a second undo is refused (409 not_undoable)", async () => {
      if (needDirty()) return { notRun: needDirty() };
      const one = await owner("GET", `/v1/commands/${dirty.commandId}`);
      const before = await page();
      const top = await newestReceipt();
      const again = await mutate(assistant, command("command.undo", { commandId: dirty.commandId }, `verify-${runId}-undo2`, "owner_statement", "mcp"));
      const now = await page();
      return { pass: one.json?.undo?.available === false && refusal(again, 409, "not_undoable") && exactlyChanged(before, now) && now.wardrobeRevision === before.wardrobeRevision && (await newestReceipt()) === top, receiptUndoAvailable: one.json?.undo?.available ?? null, secondUndoStatus: again.status, code: again.json?.error?.code ?? null };
    });

    await check("idempotency", "two identical requests sent at once commit once and share one receipt", async () => {
      if (!ready) return { notRun: unready };
      const start = await page();
      const body = command("care.mark_dirty", { items: [{ garmentId: a }] }, `verify-${runId}-race`, "owner_tap", "ios");
      track(owner, body);
      if (interruption.requested) throw new Error("the run was interrupted; no further command is sent");
      // Both requests settle before anything else runs, so cleanup never starts while one is still in flight.
      const settled = await Promise.allSettled([owner("POST", "/v1/commands", body), owner("POST", "/v1/commands", body)]);
      const [x, y] = settled.map((s) => (s.status === "fulfilled" ? noteAnswer(body, s.value) : { status: null, json: null }));
      const mid = await page();
      const same = x.status === 200 && y.status === 200 && typeof x.json?.commandId === "string" && x.json.commandId === y.json?.commandId;
      const once = mid.wardrobeRevision === start.wardrobeRevision + 1 && exactlyChanged(start, mid, { [a]: { clean: -1, dirty: 1 } });
      return { pass: same && once && [x.json?.replayed, y.json?.replayed].filter((v) => v === true).length === 1, statuses: [x.status, y.status], replayed: [x.json?.replayed ?? null, y.json?.replayed ?? null], revisionDelta: mid.wardrobeRevision - start.wardrobeRevision };
    });

    await check("refusals", "invalid, unknown and impossible commands are refused with their codes and write nothing", async () => {
      if (!ready) return { notRun: unready };
      const start = await page();
      const shoe = (start.items ?? []).find((i) => i.careChannel === "none")?.garmentId;
      if (!shoe) return { notRun: "the inventory has no garment without laundering" };
      const top = await newestReceipt();
      const tries = [];
      const attempt = async (what, body, status, code) => tries.push([what, await mutate(owner, body), status, code]);
      await attempt("fraction", command("care.mark_dirty", { items: [{ garmentId: a, quantity: 1.5 }] }, `verify-${runId}-frac`, "owner_tap", "ios"), 400, "invalid_command");
      await attempt("unknown type", command("laundry.collect", {}, `verify-${runId}-unknown`, "owner_tap", "ios"), 400, "unknown_command");
      await attempt("digits-only field name", { ...command("care.mark_dirty", { items: [{ garmentId: a }], 123: true }, `verify-${runId}-field`, "owner_tap", "ios") }, 400, "invalid_command");
      await attempt("missing undo target", command("command.undo", { commandId: "cmd_nope" }, `verify-${runId}-nope`, "owner_tap", "ios"), 404, "not_found");
      await attempt("unlaunderable", command("care.mark_dirty", { items: [{ garmentId: shoe }] }, `verify-${runId}-shoe`, "owner_tap", "ios"), 409, "precondition_failed");
      tries.push(["no such route", await owner("GET", "/v1/laundry"), 404, "not_found"]);
      const end = await page();
      const outcomes = tries.map(([what, r, status, code]) => ({ what, httpStatus: r.status, code: r.json?.error?.code ?? null, expected: `${status} ${code}`, ok: refusal(r, status, code) }));
      return { pass: outcomes.every((o) => o.ok) && exactlyChanged(start, end) && end.wardrobeRevision === start.wardrobeRevision && (await newestReceipt()) === top, outcomes };
    });
  } finally {
    await cleanUp();
  }

  /**
   * Take back every change this run made, and only those. Receipts do not carry their idempotency key, so ownership
   * is established from the receipt ids the run's own requests were answered with, and by replaying each tracked
   * request exactly (same sender, same key, same body): the app answers it from the receipt that request created. If
   * the app broke idempotency and a replay created another receipt, both are the run's own and both are undone.
   * A request whose first answer was lost and that never committed commits on
   * the replay and is then undone like the rest, so the net effect is nothing. Undo requests are not replayed: the
   * receipt they target is one of the run's own and is undone here if it is still open. Receipts the run did not
   * create are never undone. The check passes only when every owned receipt is closed, every replay was answered, and
   * the balances end exactly as they began (a concurrent change by someone else therefore fails it, honestly).
   */
  async function cleanUp() {
    const started = Date.now();
    const name = "the wardrobe is left exactly as it began (only this run's own receipts undone, found by replaying its requests)";
    if (mutations.length === 0) {
      record("cleanup", name, "not_run", { reason: "no command was sent" }, Date.now() - started, false);
      return;
    }
    try {
      const ours = new Set();
      const unresolved = [];
      let collisions = 0;
      // Ownership as in ownedByRun; anything else fails the cleanup check as a collision.
      const own = ownedByRun;
      for (const [id, revision] of answeredIds) {
        if (own(id, revision)) ours.add(id);
        else collisions++;
      }
      for (const { who, body } of mutations) {
        if (body.type === "command.undo") continue;
        let r;
        try {
          r = await who("POST", "/v1/commands", body);
        } catch {
          r = { status: null, json: null };
        }
        if (r.status === 200 && typeof r.json?.commandId === "string") {
          if (own(r.json.commandId, r.json.wardrobeRevision)) ours.add(r.json.commandId);
          else collisions++;
        } else if (!REPLAY_REFUSALS.some(([status, code]) => refusal(r, status, code))) {
          // Anything that is neither a receipt nor a documented refusal leaves the request's outcome unknown.
          unresolved.push({ httpStatus: r.status });
        }
      }
      const undone = [];
      const failed = [];
      // Each receipt is reconciled on its own: a failure reading or undoing one never stops the others.
      const safe = async (fn) => {
        try {
          return await fn();
        } catch {
          return { status: null, json: null };
        }
      };
      for (let round = 0; round < 3; round++) {
        const open = [];
        for (const id of ours) {
          const one = await safe(() => owner("GET", `/v1/commands/${encodeURIComponent(id)}`));
          // A receipt that could not be read is tried anyway; undoing a closed one is refused harmlessly.
          if (one.status !== 200 || one.json?.undo?.available === true) open.push(id);
        }
        if (open.length === 0) break;
        for (const id of open) {
          const u = await safe(() => owner("POST", "/v1/commands", command("command.undo", { commandId: id }, `verify-${runId}-cleanup-${id}`, "owner_tap", "ios")));
          if (u.status === 200) undone.push({ commandId: id, httpStatus: u.status });
          else if (!(u.status === 409 && u.json?.error?.code === "not_undoable")) failed.push({ commandId: id, httpStatus: u.status });
        }
      }
      // Every owned receipt must be closed at the end, whatever the undo answers said; this read decides.
      let stillOpen = 0;
      for (const id of ours) {
        const one = await safe(() => owner("GET", `/v1/commands/${encodeURIComponent(id)}`));
        if (one.status !== 200 || one.json?.undo?.available !== false) stillOpen++;
      }
      const end = await page();
      const restored = exactlyChanged(first, end);
      record("cleanup", name, restored && stillOpen === 0 && unresolved.length === 0 && collisions === 0 ? "pass" : "fail", { ownReceipts: ours.size, ownReceiptsStillOpen: stillOpen, undoneByCleanup: undone, failedAttempts: failed, unresolvedReplays: unresolved.length, keyCollisions: collisions, balancesRestored: restored }, Date.now() - started);
    } catch (error) {
      console.error(`        cleanup: ${redactError(error, known)}`);
      record("cleanup", name, "fail", { reason: "cleanup raised an error (message on the console only)" }, Date.now() - started);
    }
  }

  const counts = results.reduce((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {});
  const skippedRequired = results.filter((r) => r.status === "not_run" && r.required !== false).length;
  return { target, origin: originForEvidence(origin), runId, results, counts, skippedRequired, passed: gatePasses(results) };
}

function writeEvidence(file, body) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, file), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`-> deploy/ferrite/evidence/${file}`);
}

async function healthy(origin) {
  try {
    return (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) })).status === 200;
  } catch {
    return false;
  }
}

/** Whether nothing listens on 127.0.0.1:port (a listener is bound and released to find out). */
export function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * Output lines of a child process, each redacted as it completes, keeping a bounded tail of redacted lines only. A
 * partial line waits for the rest of its chunk, so a token split across chunks is redacted whole.
 */
export function lineTail(known, maxLines = 40) {
  const lines = [];
  let partial = "";
  return {
    push(chunk) {
      const parts = (partial + String(chunk)).split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) lines.push(redactText(line, known, Number.MAX_SAFE_INTEGER));
      lines.splice(0, Math.max(0, lines.length - maxLines));
    },
    text(maxChars = 1500) {
      const all = [...lines, ...(partial ? [redactText(partial, known, Number.MAX_SAFE_INTEGER)] : [])].join("\n");
      return all.length > maxChars ? `…${all.slice(all.length - maxChars)}` : all;
    },
  };
}

/** Start `ferrite dev --fresh` on a port that was free, and accept it only while the process it started is alive. */
async function startDev(port, known, onSpawn = () => {}) {
  const stopIfInterrupted = () => {
    if (interruption.requested) throw new Error("interrupted before the dev server was started");
  };
  stopIfInterrupted();
  if (!(await portFree(port))) throw new Error(`port ${port} is already in use; stop what listens there or pass --port with a free port`);
  stopIfInterrupted();
  // Always its own process group: its descendants stop with it, and an interrupt sent to this verification (by a
  // terminal or a supervising deploy, which signals our PID only) never reaches it, so it keeps serving while this run
  // undoes its own receipts. A supervisor learns the group from WARDROBE_VERIFY_DEV_PIDFILE and stops it after we exit.
  const child = spawn("ferrite", ["dev", "--dir", APP_DIR, "--port", String(port), "--fresh", "--no-reload"], { cwd: APP_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child._wardrobeDetached = true;
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  // A child that exited by a signal keeps exitCode null; it is alive only while neither is set.
  const running = () => child.exitCode === null && child.signalCode === null;
  // Registered at once, so a forced interrupt during startup kills it too.
  onSpawn({ kill: () => killTree(child) });
  // Only once it is registered (so every failure path can kill it) is its group published for a supervisor.
  if (process.env.WARDROBE_VERIFY_DEV_PIDFILE && child.pid) {
    try {
      writeFileSync(process.env.WARDROBE_VERIFY_DEV_PIDFILE, String(child.pid), { mode: 0o600 });
    } catch (error) {
      killTree(child);
      throw new Error(`could not record the dev server's process group (${error.code ?? "error"}); it was stopped`);
    }
  }
  // One line assembler per stream, so an interleaved chunk can never split a token on the other stream.
  const out = lineTail(known);
  const err = lineTail(known);
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.on("data", (c) => err.push(c));
  let spawnError = null;
  child.once("error", (e) => {
    spawnError = e;
  });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 900_000;
  let ready = false;
  while (Date.now() < deadline && running() && !spawnError && !interruption.requested) {
    if (await healthy(origin)) {
      ready = running();
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const stop = async () => {
    if (running()) {
      signalTree(child, "SIGINT");
      await new Promise((r) => setTimeout(r, 3000));
    }
    // Whatever the leader did, nothing of the group may outlive the run.
    killTree(child);
  };
  if (!ready) {
    await stop();
    if (interruption.requested) throw new Error("interrupted while the dev server was starting; it was stopped");
    throw new Error(`ferrite dev did not become healthy on ${origin} (process ${running() ? "still running" : `exited ${child.exitCode ?? child.signalCode}`}${spawnError ? `; ${spawnError.message}` : ""}): ${out.text(750)}\n${err.text(750)}`);
  }
  return { origin, stop, alive: running, kill: () => killTree(child) };
}

/** The dev server this process started, so a forced interrupt can kill it. */
let devRef = null;

/** Verify, write the evidence file for `target` and print the summary; returns the exit code. */
export async function verifyAndRecord({ origin, tokens, target, dev = null }) {
  let report;
  try {
    report = await runVerification({ origin, tokens, target, knownExtra: knownSecrets() });
  } catch (error) {
    // Nothing confirmed the run's writes: a held target lock stays while any of them may still commit.
    keepLocksForWritesInFlight(false);
    throw error;
  }
  const cleanupConfirmed = report.results.some((r) => r.group === "cleanup" && r.status === "pass");
  if (keepLocksForWritesInFlight(cleanupConfirmed)) {
    report.passed = false;
    report.lockKept = "a write went unanswered and cleanup did not confirm every own receipt: the target lock is kept";
  }
  if (interruption.requested) {
    report.passed = false;
    report.interrupted = true;
  }
  // The dev server this run started must still be the one that answered.
  if (dev && !dev.alive()) {
    report.passed = false;
    report.devServer = "the ferrite dev process this run started exited during the run";
  }
  writeEvidence(`verify-${target}.json`, { checkedAt: new Date().toISOString(), ...report });
  console.log(`${report.counts.pass ?? 0} passed, ${report.counts.fail ?? 0} failed, ${report.counts.not_run ?? 0} not run (${report.skippedRequired} required); ${report.passed ? "PASSED" : "NOT PASSED"}`);
  return report.passed ? 0 : 1;
}

async function main(argv) {
  const deployed = argv.includes("--deployed");
  const target = deployed ? "deployed" : "local";
  let tokens;
  let origin = argv.includes("--origin") ? argv[argv.indexOf("--origin") + 1] : null;
  if (deployed && origin) origin = deployedOrigin(origin);
  if (!deployed && origin) origin = localOrigin(origin);
  if (deployed) {
    const account = accountState(await ferriteAsync(["account"], { timeoutMs: 60_000 }));
    if (interruption.requested) throw new Error("interrupted before the deployed verification started");
    if (account.state !== "signed_in") {
      writeEvidence("verify-deployed.json", { target, checkedAt: new Date().toISOString(), result: "blocked", account: account.state, reason: account.reason, remaining: "the owner imports his Ferrite account credential with `ferrite login --credentials-file <path>`, then `node deploy/ferrite/deploy.mjs --confirm=<account>/wardrobe` runs and this verification follows" });
      console.error(`blocked: ${account.reason}`);
      return 2;
    }
    const app = appSpec().name;
    const confirmed = `${account.account}/${app}`;
    // Deployed verification changes the owner's real wardrobe and then takes it back: it holds the target's lock so
    // no deploy or teardown of the same target can run in between.
    return withTargetLock(confirmed, async () => {
      const stored = readTokens(confirmed);
      if (!stored) throw new Error(`no stored tokens for ${confirmed}; deploy it with deploy/ferrite/deploy.mjs first`);
      if (!origin) {
        const host = await ferriteAsync(["host", "--json"], { timeoutMs: 60_000 });
        origin = deployedOrigin(JSON.parse(host.stdout || "{}").origin);
      }
      if (interruption.requested) throw new Error("interrupted before the deployed verification started");
      return verifyAndRecord({ origin, tokens: stored, target });
    });
  }
  tokens = localTokens();
  if (!tokens.owner || !tokens.assistant) throw new Error("ferrite/ferrite.local.toml has no WARDROBE_OWNER_TOKEN and WARDROBE_ASSISTANT_TOKEN under [secrets]");
  return verifyLocal({ origin, tokens, startDev: argv.includes("--start-dev"), port: Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8790) });
}

/**
 * The lock every local verification holds: its own state directory, so it can never be confused with a deployed
 * target's lock. Two local verifications therefore never change the local wardrobe at once, and a write left
 * unanswered keeps it (as for a deployed target) until the operator has checked the receipts.
 */
export const LOCAL_LOCK = Object.freeze({ target: "local/wardrobe", dir: path.join(STATE_DIR, "local-verify") });

/** Verify against the local plane, holding the local lock throughout (dev server start, the run, its stop). */
export function verifyLocal({ origin = null, tokens, startDev: start = false, port = 8790, lockDir = LOCAL_LOCK.dir }) {
  return withTargetLock(LOCAL_LOCK.target, async () => {
    let dev = null;
    if (start) {
      dev = await startDev(port, knownSecrets(), (spawned) => {
        devRef = spawned;
      });
      devRef = dev;
      origin = dev.origin;
    }
    origin ??= "http://127.0.0.1:8790";
    try {
      return await verifyAndRecord({ origin, tokens, target: "local", dev });
    } finally {
      await dev?.stop();
    }
  }, lockDir);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fail = (error) => {
    devRef?.kill();
    abortChildren();
    keepLocksForWritesInFlight(false);
    console.error(`FAILED: ${redactError(error, knownSecrets())}`);
    process.exit(1);
  };
  installInterruptHandlers(() => devRef?.kill());
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  main(process.argv.slice(2)).then((code) => process.exit(code), fail);
}
