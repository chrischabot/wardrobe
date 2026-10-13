#!/usr/bin/env node
/**
 * Checks the bundled 64-case evaluation corpus and its grader controls, from the bundle alone.
 *
 * What this is: validation of the evaluation ASSETS (requirements/support/wardrobe-support/evals) and of
 * the isolation between candidate and judge packets. It calls no model and no provider, runs no
 * candidate and judges nothing. It is NOT evidence that this application passes any evaluation case.
 *
 * What it cannot do: the bundle's own `evaluate.py validate` re-reads the owner's private chat export
 * (492 conversations), which was deliberately not supplied. This script therefore checks every
 * historical excerpt against what the bundle itself carries (identifiers, date, position, the recorded
 * hash of the source message) and says how many excerpts could be re-hashed without the export. The
 * full archive was not rechecked, and the result says so.
 *
 * Nothing is written into the bundle: supplied documents stay byte-identical.
 *
 * Run: `npm run evals:check -w @garderobe/journey-tests` (needs python3 for the bundle's own script).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const evals = join(repo, "requirements/support/wardrobe-support/evals");
const PROFILE_SHA256 = "e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198"; // evals/README.md

const sha = (data) => createHash("sha256").update(data).digest("hex");
const json = (path) => JSON.parse(readFileSync(join(evals, path), "utf8"));
const results = [];
const failures = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, status: "passed", ...(detail ? { detail } : {}) });
  } catch (error) {
    results.push({ name, status: "failed", detail: String(error?.message ?? error) });
    failures.push(name);
  }
}
function must(condition, message) {
  if (!condition) throw new Error(message);
}
function evaluate(args, { expectFailure = false } = {}) {
  // -B: python must not write a bytecode cache into the supplied bundle.
  const run = spawnSync("python3", ["-B", join(evals, "evaluate.py"), ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new Error(`python3 could not be started: ${run.error.message}`);
  if (!expectFailure && run.status !== 0) throw new Error(`evaluate.py ${args.join(" ")} exited ${run.status}: ${run.stderr.trim().split("\n").at(-1)}`);
  return run;
}

/** Every file under the supplied requirements/support directory with its hash, so the run can prove it changed nothing there. */
const support = join(repo, "requirements/support");
function bundleHashes(dir = support, out = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) bundleHashes(path, out);
    else out.set(path.slice(support.length + 1), sha(readFileSync(path)));
  }
  return out;
}
/** Every string value anywhere in a parsed JSON value. */
function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

let cases, evidence, manifest, assertions, fixture, calibration, before;
try {
  before = bundleHashes();
  cases = json("cases.json");
  evidence = json("sources/evidence.json");
  manifest = json("sources/manifest.json");
  assertions = json("fixtures/state-assertions.json");
  fixture = json("fixtures/wardrobe.json");
  calibration = json("sources/calibration-candidates.json");
} catch (error) {
  console.log(JSON.stringify({ status: "failed", scope: "The evaluation bundle could not be read; nothing was checked.", checks: [{ name: "the bundled evaluation assets are present and readable", status: "failed", detail: String(error?.message ?? error) }] }, null, 2));
  process.exit(1);
}
const byId = new Map(cases.map((c) => [c.id, c]));

check("64 cases with unique identifiers: 40 adapted from history, 24 constructed", () => {
  must(cases.length === 64 && byId.size === 64, `${cases.length} cases, ${byId.size} unique`);
  const history = cases.filter((c) => c.origin === "history_adaptation").length;
  const constructed = cases.filter((c) => c.origin === "constructed_from_owner_decision").length;
  must(history === 40 && constructed === 24, `${history} historical, ${constructed} constructed`);
  must(manifest.case_count === 64 && manifest.history_case_count === 40, "the manifest's counts differ");
  for (const c of cases) must(c.prompt && c.judge_criteria?.length && c.source_ids?.length, `${c.id} lacks a prompt, criteria or sources`);
});

check("split of 45 development and 19 held-out cases", () => {
  const development = cases.filter((c) => c.split === "development").length;
  const holdout = cases.filter((c) => c.split === "holdout").length;
  must(development === 45 && holdout === 19, `${development} development, ${holdout} held out`);
  must(manifest.split_counts.development === 45 && manifest.split_counts.holdout === 19, "the manifest's split differs");
});

check("the profile copy is the September 14 profile, byte for byte, and every case names it", () => {
  const bundled = readFileSync(join(evals, "sources/chris-wardrobe-profile.md"));
  must(sha(bundled) === PROFILE_SHA256, `the bundled profile hashes to ${sha(bundled)}`);
  must(manifest.profile_sha256 === PROFILE_SHA256, "the manifest names another profile hash");
  for (const c of cases) must(c.profile_sha256 === PROFILE_SHA256 && c.profile_path === "sources/chris-wardrobe-profile.md", `${c.id} names another profile`);
  // The September 15 decisions are a separate document, not edits to the profile.
  must(readFileSync(join(evals, "sources/owner-amendments.md"), "utf8").trim().length > 0, "the owner amendments are missing");
  for (const c of cases) must(c.amendments_path === "sources/owner-amendments.md", `${c.id} names other amendments`);
});

let rehashed = 0;
let historical = 0;
check("every historical excerpt keeps its conversation, message, date, position and source-message hash", () => {
  for (const c of cases) for (const id of c.source_ids) must(evidence[id], `${c.id} cites ${id}, which is not in the evidence`);
  for (const e of Object.values(evidence)) {
    if (e.kind !== "owner_history") {
      must(e.kind === "current_owner_decision" && (e.paraphrase || e.quote) && e.date && e.source, `${e.id} is neither history nor a labelled owner decision`);
      continue;
    }
    historical += 1;
    must(e.speaker === "human", `${e.id} is not an owner message`);
    must(/^[0-9a-f-]{36}$/.test(e.conversation_id) && /^[0-9a-f-]{36}$/.test(e.message_id), `${e.id} lacks exact identifiers`);
    must(e.id === `history:${e.conversation_id}:${e.message_id}`, `${e.id} does not match its own references`);
    must(!Number.isNaN(Date.parse(e.created_at)) && Number.isInteger(e.message_index) && Number.isInteger(e.quote_start), `${e.id} lacks a date or a position`);
    must(/^[0-9a-f]{64}$/.test(e.message_sha256) && e.quote, `${e.id} lacks a hash or a quotation`);
    // An excerpt that is the whole message can be re-hashed here; a partial excerpt needs the export.
    if (sha(Buffer.from(e.quote, "utf8")) === e.message_sha256) rehashed += 1;
  }
  must(historical === 42 && manifest.historical_evidence_count === 42, `${historical} historical excerpts`);
  // Exactly four excerpts are partial quotations in the bundle as supplied. Pinning the number makes an
  // altered quotation or hash fail here instead of quietly joining the ones that cannot be re-hashed.
  must(rehashed === 38, `${rehashed} of ${historical} excerpts match their recorded hash; 38 did when the bundle was supplied, so a quotation or a hash has changed`);
  return `${rehashed} of ${historical} excerpts are whole messages and match their recorded hash; the other ${historical - rehashed} are partial quotations that can only be checked against the private export, which is absent`;
});

check("no source conversation is in both splits, and calibration uses development conversations only", () => {
  const splits = new Map();
  for (const c of cases) for (const id of c.source_ids) {
    const e = evidence[id];
    if (e.kind !== "owner_history") continue;
    if (!splits.has(e.conversation_id)) splits.set(e.conversation_id, new Set());
    splits.get(e.conversation_id).add(c.split);
  }
  must(splits.size === manifest.selected_conversation_count, `${splits.size} source conversations, manifest says ${manifest.selected_conversation_count}`);
  for (const [conversation, set] of splits) must(set.size === 1, `conversation ${conversation} is in both splits`);
  for (const entry of calibration) {
    const set = splits.get(entry.conversation_id);
    must(set && set.size === 1 && set.has("development"), `calibration reply ${entry.id} does not come from a development conversation`);
    must(byId.get(entry.related_case_id)?.split === "development", `calibration reply ${entry.id} relates to a held-out case`);
    must(sha(Buffer.from(entry.candidate, "utf8")) === entry.candidate_sha256, `calibration reply ${entry.id} does not match its hash`);
  }
  return `${splits.size} conversations; ${calibration.length} calibration replies match their hashes (that they hold visible text only cannot be re-derived without the export)`;
});

check("the wardrobe fixture is labelled constructed test data, not the owner's inventory", () => {
  must(fixture.kind === "constructed_evaluation_fixture" && fixture.not_live_inventory === true, "the fixture is not labelled as constructed");
  for (const c of cases) must(c.fixture_path === "fixtures/wardrobe.json" && c.historical_images_available === false, `${c.id} uses another fixture or claims images`);
});

check("the bundle's own script lists all 64 cases", () => {
  const listed = JSON.parse(evaluate(["list"]).stdout);
  must(listed.length === 64, `${listed.length} listed`);
});

check("candidate packets carry the full profile, amendments, fixture and request, and nothing reserved for the judge", () => {
  const profile = readFileSync(join(evals, "sources/chris-wardrobe-profile.md"), "utf8");
  const amendments = readFileSync(join(evals, "sources/owner-amendments.md"), "utf8");
  const expected = ["candidate_data_boundary", "case_id", "fixture", "full_profile", "instructions", "owner_amendments", "profile_sha256", "request", "scenario"];
  for (const c of cases) {
    const out = evaluate(["packet", "--case", c.id, "--mode", "candidate"]).stdout;
    const packet = JSON.parse(out);
    must(JSON.stringify(Object.keys(packet).sort()) === JSON.stringify(expected), `${c.id}: packet fields are ${Object.keys(packet).sort().join(", ")}`);
    must(packet.full_profile === profile && packet.owner_amendments === amendments && packet.request === c.prompt, `${c.id}: the packet does not carry the complete context`);
    // Judge criteria, source feedback and the expected state never reach a candidate. The parsed
    // packet's own string values are searched, so the check does not depend on how the script escapes text.
    const text = stringsIn(packet).filter((s) => s !== profile && s !== amendments);
    const carries = (needle) => text.some((s) => s.includes(needle));
    for (const criterion of c.judge_criteria) must(!carries(criterion), `${c.id}: a judge criterion is in the candidate packet`);
    for (const id of c.source_ids) {
      must(!carries(id), `${c.id}: a source reference is in the candidate packet`);
      const quote = evidence[id].quote;
      if (quote) must(!carries(quote), `${c.id}: source feedback is in the candidate packet`);
    }
    for (const entry of calibration) must(!carries(entry.candidate), `${c.id}: a historical answer is in the candidate packet`);
    // A scenario may state an input under the same name as an expected field (B012's remote revision); only fields that are not scenario inputs are checked.
    if (assertions[c.id]) for (const key of Object.keys(assertions[c.id]).filter((k) => !(k in c.scenario))) must(!out.includes(`"${key}"`), `${c.id}: the expected state field ${key} is in the candidate packet`);
  }
  return "64 packets built by the bundle's own script, to standard output only";
});

check("the leak search itself finds a criterion when one is present (control)", () => {
  // LABELLED CONTROL: a packet with a judge criterion planted in it must be caught by the same search.
  const c = byId.get("H001");
  const planted = { ...JSON.parse(evaluate(["packet", "--case", "H001", "--mode", "candidate"]).stdout), note: `planted: ${c.judge_criteria[0]}` };
  must(stringsIn(planted).some((s) => s.includes(c.judge_criteria[0])), "the search did not find a planted criterion");
});

check("a judge packet cannot be built without a finished candidate, and then carries the criteria and evidence", () => {
  const refused = evaluate(["packet", "--case", "H001", "--mode", "judge"], { expectFailure: true });
  must(refused.status !== 0 && /require --candidate/.test(refused.stderr), "a judge packet was built with no candidate");
  const scratch = mkdtempSync(join(tmpdir(), "garderobe-evals-"));
  try {
    const candidate = join(scratch, "candidate.json");
    writeFileSync(candidate, JSON.stringify({ response: "LABELLED CONTROL, not a model output.", options: [] }));
    const packet = JSON.parse(evaluate(["packet", "--case", "H001", "--mode", "judge", "--candidate", candidate]).stdout);
    must(packet.judge_criteria?.length && packet.historical_evidence?.length && packet.candidate_id === "anonymous-A", "the judge packet lacks criteria, evidence or an anonymous label");
    must(packet.candidate_sha256 === sha(readFileSync(candidate)), "the judge packet does not pin the candidate it judges");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

check("the structural grader catches each labelled negative control and accepts a complete outfit", () => {
  const scratch = mkdtempSync(join(tmpdir(), "garderobe-evals-"));
  const items = new Map(fixture.items.map((i) => [i.id, i]));
  const wearable = (role, extra = () => true) => fixture.items.find((i) => i.role === role && i.owned && i.quantity > 0 && !["restricted", "unavailable"].includes(i.availability) && i.exists !== false && extra(i));
  const complete = ["shirt", "trousers", "socks", "belt"].map((role) => wearable(role).id).concat(wearable("shoes", (i) => i.footwear_kind === "sneaker").id);
  const welted = fixture.items.find((i) => i.role === "shoes" && i.footwear_kind !== "sneaker");
  const secondShirt = fixture.items.find((i) => i.role === "shirt" && i.id !== complete[0] && i.owned && i.quantity > 0 && !["restricted", "unavailable"].includes(i.availability));
  must(welted && secondShirt, "the fixture lacks a non-sneaker shoe or a second shirt for the controls");
  const run = (label, garmentIds) => {
    const file = join(scratch, `${label}.json`);
    // B014 asks for one outfit and constrains nothing in the fixture; these are LABELLED CONTROLS, not candidates.
    writeFileSync(file, JSON.stringify({ response: `LABELLED CONTROL (${label}), not a model output.`, options: [{ id: "control-1", garment_ids: garmentIds, explanation: "control" }], shortage_reason: "control" }));
    const out = evaluate(["check-candidate", "--case", "B014", "--candidate", file], { expectFailure: true });
    return { status: out.status, errors: JSON.parse(out.stdout).errors };
  };
  try {
    const good = run("complete", complete);
    must(good.status === 0 && good.errors.length === 0, `a complete outfit was rejected: ${good.errors.join("; ")}`);
    const controls = {
      "missing socks": [complete.filter((id) => items.get(id).role !== "socks"), /missing socks/],
      "invented garment": [[...complete, "shirt-that-does-not-exist"], /nonexistent garment/],
      "restricted footwear": [complete.map((id) => (items.get(id).role === "shoes" ? welted.id : id)), /sneaker restriction|prohibited garment/],
      "duplicate primary role": [[...complete, secondShirt.id], /exactly one shirt/],
    };
    for (const [label, [garmentIds, pattern]] of Object.entries(controls)) {
      const result = run(label.replace(/ /g, "-"), garmentIds);
      must(result.status !== 0 && result.errors.some((e) => pattern.test(e)), `the control "${label}" was not caught: ${JSON.stringify(result.errors)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return "missing socks, invented garment, restricted footwear, duplicate primary role";
});

check("the 18 behavioural cases have expected state, and state without an application adapter's provenance is refused", () => {
  const ids = Object.keys(assertions);
  must(ids.length === 18, `${ids.length} behavioural cases`);
  for (const id of ids) must(byId.has(id), `${id} is not a case`);
  const scratch = mkdtempSync(join(tmpdir(), "garderobe-evals-"));
  try {
    const file = join(scratch, "state.json");
    // LABELLED CONTROL: the expected state copied back with no adapter provenance, as a model's prediction would be.
    writeFileSync(file, JSON.stringify({ observed: assertions.B004 }));
    const refused = evaluate(["check-state", "--case", "B004", "--file", file], { expectFailure: true });
    must(refused.status !== 0 && /application adapter/.test(refused.stderr), "a state record with no adapter provenance was accepted");
    // LABELLED CONTROL: adapter provenance with a wrong observation is reported as an error, not passed.
    writeFileSync(file, JSON.stringify({ provenance: { source: "application_adapter", run_id: "control", artifact_paths: ["control"] }, observed: { ...assertions.B012, remote_revision: 11 } }));
    const stale = evaluate(["check-state", "--case", "B012", "--file", file], { expectFailure: true });
    must(stale.status !== 0 && JSON.parse(stale.stdout).errors.length === 1, "a stale Calendar revision was not caught");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

check("the eight bundled historical reviews are well-formed calibration records", () => {
  const run = JSON.parse(evaluate(["check-judgments", "--file", join(evals, "results/initial-judge-review.json")]).stdout);
  must(run.status === "passed" && run.judgments === 8, `${run.judgments} judgments`);
  return "calibration evidence about historical replies only; not a judgment of this application";
});

let exportRechecked = false;
check("the bundle's full validation stops only because the private chat export is absent", () => {
  const run = evaluate(["validate"], { expectFailure: true });
  if (run.status === 0) {
    exportRechecked = true;
    return "the export was present and the bundle's full validation passed";
  }
  must(/FileNotFoundError/.test(run.stderr) && run.stderr.includes(manifest.export_path), `evaluate.py validate failed for another reason: ${run.stderr.trim().split("\n").at(-1)}`);
  return `not run to completion: ${manifest.export_path} is not part of the supplied bundle`;
});

check("the run left everything under requirements/support byte for byte as it was", () => {
  const after = bundleHashes();
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
  must(changed.length === 0, `files added, removed or changed under the bundle: ${changed.join(", ")}`);
  return `${after.size} files hashed before and after`;
});

const report = {
  status: failures.length ? "failed" : "passed",
  scope: "Evaluation assets, packet isolation and grader controls only. No candidate was run, no model or provider was called, nothing was judged, and this is not evidence that the application passes any case.",
  archive: exportRechecked ? "The private chat export was present and was rechecked." : `The private chat export was not rechecked: ${rehashed} of ${historical} historical excerpts were re-hashed from the bundle alone.`,
  checks: results,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
