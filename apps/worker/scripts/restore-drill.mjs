#!/usr/bin/env node
/**
 * Restore drill: take a backup of one owner, restore it into an EMPTY owner, and verify the result
 * against the backup's restore manifest (specification section 15: "A restore drill must recover
 * identities, quantities, wear revisions, style versions, the continuous transcript, media links,
 * pending turns, deletion tombstones and effects", and section 17: "a backup can be restored").
 *
 * Against a deployment (run by the deployment thread on real resources):
 *
 *   GARDEROBE_SOURCE_ASSERTION=<Access assertion of the owner to back up> \
 *   GARDEROBE_TARGET_ASSERTION=<Access assertion of a second sign-in> \
 *   node scripts/restore-drill.mjs --base https://<app hostname> [--target-invitation <code>] [--out report.json]
 *
 *   The target must be an empty owner. If the second sign-in has no account yet, pass the invitation
 *   code of a freshly created empty owner and the script claims it. The assertions are read from the
 *   environment only, never from the command line, and are never printed.
 *
 * Against the local Worker (`npm run dev` running):
 *
 *   npm run dev -- empty-owner          (with the Worker stopped) prints an invitation code
 *   npm run dev                         (start the Worker)
 *   node scripts/restore-drill.mjs --local --target-invitation <code>
 *
 * What it does, in order: reads the source's current state; takes a backup now; downloads the package
 * with a single-use ticket and checks its SHA-256; reads the source's tombstone journal; signs in as
 * the target (claiming the empty account when asked); imports the package; asks the service to verify
 * the restore (which replays the journal, rebuilds the recall index and compares every store with the
 * manifest); prints one line per check. Exit code 0 only when the restore is reported complete.
 *
 * What it does NOT restore, by design: sign-ins, sessions, recovery credentials, third-party
 * credentials and assistant grants. Those are re-established by claim or recovery and by reconnecting,
 * and are covered at the database level by the platform's own D1 restore.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const local = flag("--local");

let base = value("--base");
let sourceAssertion = process.env.GARDEROBE_SOURCE_ASSERTION;
let targetAssertion = process.env.GARDEROBE_TARGET_ASSERTION;
if (local) {
  const { LOCAL, localAssertion, readState } = await import("./lib/local.mjs");
  base ??= LOCAL.appOrigin;
  sourceAssertion = await localAssertion();
  const state = readState();
  targetAssertion = await localAssertion({ subject: `${state.identity.subject}-restore-target-${value("--target-invitation")?.slice(-8) ?? "existing"}`, email: null });
}
if (!base || !sourceAssertion || !targetAssertion) {
  console.error("usage: see the header of scripts/restore-drill.mjs (needs --base and both assertions in the environment, or --local)");
  process.exit(2);
}

const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function call(assertion, method, route, body, raw) {
  const headers = { "Cf-Access-Jwt-Assertion": assertion };
  if (raw) headers["Content-Type"] = "application/zip";
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${base}${route}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: response.status, ok: response.ok, json, text };
}

let report = null;
try {
  const me = await call(sourceAssertion, "GET", "/v1/me");
  step("source owner signed in", me.ok, me.ok ? "" : `${me.status} ${me.text.slice(0, 200)}`);
  if (!me.ok) throw new Error("cannot continue without the source owner");
  const sourceWardrobe = (await call(sourceAssertion, "GET", "/v1/wardrobe")).json;

  const backup = (await call(sourceAssertion, "POST", "/v1/backups", { clientRequestId: `restore-drill-${Date.now()}` })).json;
  step("backup taken and complete", backup?.state === "completed" && backup?.complete === true, backup ? `${backup.backupId}, ${backup.byteLength} bytes, snapshot ${backup.takenAt}` : "no backup");
  if (!backup?.restoreManifest) throw new Error("the backup has no restore manifest");

  const ticket = (await call(sourceAssertion, "POST", `/v1/backups/${backup.backupId}/ticket`, {})).json;
  const download = await fetch(`${base}${ticket.url}`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  step("package downloaded and its checksum matches", download.ok && sha256 === backup.sha256, `${bytes.length} bytes`);

  const journal = (await call(sourceAssertion, "GET", "/v1/backups/tombstones")).json;
  step("tombstone journal read", journal?.format === "garderobe-tombstones/1", `${journal?.tombstones?.length ?? 0} tombstone(s)`);

  let target = await call(targetAssertion, "GET", "/v1/me");
  if (!target.ok && value("--target-invitation")) {
    const claim = await call(targetAssertion, "POST", "/auth/claim", { invitationCode: value("--target-invitation") });
    step("empty target account claimed", claim.ok, claim.ok ? "" : `${claim.status} ${claim.text.slice(0, 200)}`);
    target = await call(targetAssertion, "GET", "/v1/me");
  }
  step("target owner signed in", target.ok, target.ok ? "" : `${target.status}; create an empty owner and pass --target-invitation`);
  if (!target.ok) throw new Error("cannot continue without the target owner");
  step("target is a different owner", target.json.userId !== me.json.userId);
  const before = (await call(targetAssertion, "GET", "/v1/wardrobe")).json;
  step("target is empty", before?.total === 0, `${before?.total} garments`);
  if (before?.total !== 0 || target.json.userId === me.json.userId) throw new Error("refusing to restore into an owner that is not empty");

  const imported = await call(targetAssertion, "POST", "/v1/imports", undefined, bytes);
  step("package imported: checksums verified, identifiers kept, no external effect replayed", imported.ok && imported.json?.state === "completed" && imported.json?.checksumsVerified === true && imported.json?.idsPreserved === true && imported.json?.externalEffectsReplayed === 0, imported.ok ? "" : `${imported.status} ${imported.text.slice(0, 300)}`);

  const verified = await call(targetAssertion, "POST", "/v1/restore/verify", { restoreManifest: backup.restoreManifest, tombstones: journal });
  report = verified.json;
  for (const check of report?.checks ?? []) step(check.name, check.ok, check.ok ? (check.note ?? "") : `expected ${JSON.stringify(check.expected)} got ${JSON.stringify(check.actual)}`);
  step("restore reported complete by the service", verified.ok && report?.complete === true, `${report?.tombstonesReplayed ?? 0} tombstone(s) replayed`);

  const restored = (await call(targetAssertion, "GET", "/v1/wardrobe")).json;
  step("restored wardrobe has the same garments", restored?.total === sourceWardrobe?.total, `${restored?.total} of ${sourceWardrobe?.total}`);
} catch (error) {
  step("drill finished without an unexpected error", false, String(error?.message ?? error).slice(0, 400));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (value("--out")) writeFileSync(value("--out"), JSON.stringify({ base, ranAt: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results, report }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
