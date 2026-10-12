#!/usr/bin/env node
/**
 * Evaluation of this build against the bundled 64-case corpus (requirements/support/wardrobe-support/evals).
 *
 *   node evals/run.mjs development            # the 45 development cases
 *   node evals/run.mjs freeze                 # declare tuning finished; records what the holdout will be run against
 *   node evals/run.mjs holdout                # the 19 held-out cases, exactly once
 *   node evals/run.mjs adapter-check          # NO model: the scripted ledger check of the DEVELOPMENT behavioural cases
 *   node evals/run.mjs selftest               # isolation and split guards, no model, no Worker
 *
 * Inference: the application's AI Gateway (CF_AIG_TOKEN, CLOUDFLARE_ACCOUNT_ID; EVAL_GATEWAY_ID defaults to
 * garderobe-dev). The candidate is the application on its own registry routes; the judge is a different
 * registry route in a process of its own. See src/node/gateway.mjs and README.md.
 *
 * Options (development only unless noted):
 *   --driver conversation|scripted_commands   default: conversation when the gateway is configured
 *   --cases H001,B007                         a subset (never allowed for the holdout)
 *   --shards N                                parallel candidate processes (default 4; also for holdout)
 *   --phases candidate,check,judge            default: all three
 *   --work DIR                                work directory (default: $EVAL_WORK_DIR or the system temp directory)
 *
 * This file is the ONLY reader of cases.json, the state assertions and the evidence. It hands each phase
 * what that phase may see and nothing more; README.md describes the isolation and the split rules.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_VARS, chat, gatewayRoute, parseRegistry, probeRoutes, readRegistry } from "./src/node/gateway.mjs";

/** A registry with three distinct synthetic routes, written with constants as the application's is, for the judge-routing self-tests. */
function syntheticRegistry() {
  return parseRegistry(
    [
      'export const ROUTE_A = "selftest/route-a";',
      'const ROUTE_B = "openai/selftest-route-b";',
      'export const PROFILE_A = "sp-a";',
      '{ profileId: PROFILE_A, apiModelId: "sm-a", gatewayRoute: ROUTE_A },',
      '{ profileId: "sp-b", apiModelId: "sm-b", gatewayRoute: ROUTE_B },',
      '{ profileId: "sp-c", apiModelId: "sm-c", gatewayRoute: "selftest/route-c" },',
      '{ profileId: "sp-none", apiModelId: null, gatewayRoute: null },',
      'conversation: { task: "conversation", candidates: [PROFILE_A, "sp-b", "sp-c"] },',
    ].join("\n"),
  );
}
import { judgmentProblem } from "./src/node/judge-format.mjs";
import { anySessionValid, garmentsCreated, recoveryReuseOutcome, sessionOutcome, candidateRoutes, checksumCoverage, comfortObservationMatch, countsAsMorningNotice, credentialOutcome, credentialShapesIn, distinctRequests, exportOfRequest, homeOnlyItems, importDrained, importOutcome, judgeAvailability, lateDeliveryCoverage, listIn, otherWaitingRuns, pendingCount, pendingInputForm, proposalForm, replacedNamesListed, scoredRemoteRevision, newGarmentProhibitions, ownerQuestions, ownerScenario, phaseRefusal, questionnaireOutcome, questionsIn, relayModel, repairApprovalQuestions, requestsInReply, reserveJudgeRoute, safeName, selectCases, suitcaseLaundry, wearConfirmationRequests, wearConfirmationTasks } from "./src/rules.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const bundle = path.join(repo, "requirements/support/wardrobe-support/evals");
const resultsRoot = path.join(here, "results");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
};

/* ------------------------------------------------------------------ */
/* Arguments and route                                                  */
/* ------------------------------------------------------------------ */

const [command, ...rest] = process.argv.slice(2);
const option = (name, fallback = null) => {
  const at = rest.indexOf(`--${name}`);
  return at === -1 ? fallback : (rest[at + 1] ?? fallback);
};

/** The gateway route of this run; `missing` names exactly what is absent from the environment. */
const route = () => gatewayRoute(process.env);
/** The environment a phase process gets: the system basics and the gateway variables, nothing else of this process. */
function phaseEnv(extra = {}) {
  const keep = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "USER", "SHELL", "npm_config_cache", "XDG_CACHE_HOME", ...GATEWAY_VARS];
  const env = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

/* ------------------------------------------------------------------ */
/* Corpus access (orchestrator only)                                    */
/* ------------------------------------------------------------------ */

function evaluatePy(args, { allowFailure = false } = {}) {
  // -B: python must not write a bytecode cache into the supplied bundle.
  const run = spawnSync("python3", ["-B", path.join(bundle, "evaluate.py"), ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new Error(`python3 could not be started: ${run.error.message}`);
  if (!allowFailure && run.status !== 0) throw new Error(`evaluate.py ${args.join(" ")} exited ${run.status}: ${run.stderr.trim().split("\n").at(-1)}`);
  return run;
}

/**
 * The outcome of a bundle checker (check-candidate, check-state). It exits 0 with no errors or 1 with errors;
 * anything else (a crash, another exit status, output that is not its JSON, an exit status that disagrees with
 * its errors) is a failing checker, and a failing checker fails the check: it never passes and never quietly
 * becomes not_run.
 */
function checkerOutcome(result) {
  const tail = String(result?.stderr ?? "").trim().split("\n").at(-1) ?? "";
  let errors;
  try {
    errors = JSON.parse(String(result?.stdout ?? "")).errors;
  } catch {
    return { status: "failed", detail: `the checker failed (exit ${result?.status ?? "unknown"}) without a result: ${tail}`.slice(0, 600), checkerFailed: true };
  }
  if (!Array.isArray(errors)) return { status: "failed", detail: `the checker failed: its result has no errors list (exit ${result?.status})`, checkerFailed: true };
  if (result.status === 0 && errors.length === 0) return { status: "passed", errors, checkerFailed: false };
  if (result.status === 1 && errors.length > 0) return { status: "failed", errors, checkerFailed: false };
  return { status: "failed", detail: `the checker failed: exit ${result.status} with ${errors.length} error(s)${tail ? `: ${tail}` : ""}`.slice(0, 600), errors, checkerFailed: true };
}

function treeHashes(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "results" || name === ".wrangler" || name === "__pycache__") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) treeHashes(full, base, out);
    else out[path.relative(base, full).split(path.sep).join("/")] = sha(readFileSync(full));
  }
  return out;
}
const digest = (hashes) => sha(JSON.stringify(Object.entries(hashes).sort()));

/**
 * What a run was made against, each as one digest: the corpus, the harness, the application source, the
 * journey suite's helpers and doubles the harness runs on, the owner's supplied data, and the lockfile.
 */
function fingerprints() {
  const application = {};
  for (const dir of ["apps", "packages", "migrations"]) Object.assign(application, Object.fromEntries(Object.entries(treeHashes(path.join(repo, dir))).map(([k, v]) => [`${dir}/${k}`, v])));
  application["tsconfig.base.json"] = sha(readFileSync(path.join(repo, "tsconfig.base.json")));
  const harness = treeHashes(here);
  delete harness["README.md"];
  return {
    corpus: digest(treeHashes(bundle)),
    harness: digest(harness),
    application: digest(application),
    journey_helpers: digest(treeHashes(path.join(repo, "tests/journeys/src"))),
    owner_data: digest(treeHashes(path.join(repo, "data"))),
    lockfile: sha(readFileSync(path.join(repo, "package-lock.json"))),
  };
}
const FINGERPRINT_KEYS = ["corpus", "harness", "application", "journey_helpers", "owner_data", "lockfile"];

/** The trees `fingerprints()` hashes. A run's own writes must never land in one, or they would change the build it checks. */
function fingerprintedTrees() {
  return [bundle, here, ...["apps", "packages", "migrations", "tests/journeys/src", "data"].map((d) => path.join(repo, d))].map((d) => path.resolve(d));
}

/** A path with every symbolic link resolved; a part that does not exist yet is appended to its nearest existing ancestor's real path. */
function realPath(p) {
  let existing = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(realpathSync(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.join(existing, ...rest);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Whether `child` is `parent` or lies inside it (a name such as `..work` is a child, not a way out). */
function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why a work directory cannot be used, or null: one inside (or holding) a fingerprinted tree is refused, symbolic links resolved. */
function workDirRefusal(work) {
  const w = realPath(work);
  for (const tree of fingerprintedTrees().map(realPath)) {
    if (within(tree, w) || within(w, tree)) {
      return `the work directory ${w} overlaps the fingerprinted tree ${tree}; the run's own files would change the build fingerprints it checks. Choose a directory outside it (the default is under the system temporary directory)`;
    }
  }
  return null;
}

/** The inference configuration of a run, without any secret: which gateway (its id and a digest of its full
 * endpoint, which carries the account and host), and how the judge's route is chosen. */
function inferenceConfiguration(registry) {
  const r = route();
  return { gatewayId: r.gatewayId, gatewayEndpointSha256: r.baseUrl ? sha(r.baseUrl) : null, conversationCandidates: registry.conversationCandidates, judgeRouteOrder: process.env.EVAL_JUDGE_ROUTES ?? "registry order, OpenAI route first" };
}

function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) {
    out.push(k);
    stringsIn(v, out);
  }
  return out;
}

/**
 * Names of the expected outcomes, as needles for the isolation checks. A name the corpus itself uses as a
 * scenario field is left out: the bundle's own candidate packet shows it to the candidate.
 */
function assertionKeys(corpus) {
  const scenarioWords = new Set(corpus.cases.flatMap((c) => stringsIn(c.scenario)));
  return [...new Set(Object.values(corpus.assertions).flatMap((a) => Object.keys(a)))].filter((key) => !scenarioWords.has(key));
}

function loadCorpus() {
  const cases = readJson(path.join(bundle, "cases.json"));
  const assertions = readJson(path.join(bundle, "fixtures/state-assertions.json"));
  const fixture = readJson(path.join(bundle, "fixtures/wardrobe.json"));
  const evidence = readJson(path.join(bundle, "sources/evidence.json"));
  if (cases.length !== 64) throw new Error(`the corpus has ${cases.length} cases, not 64`);
  const counts = { development: cases.filter((c) => c.split === "development").length, holdout: cases.filter((c) => c.split === "holdout").length };
  if (counts.development !== 45 || counts.holdout !== 19) throw new Error(`unexpected split sizes ${JSON.stringify(counts)}`);
  return { cases, assertions, fixture, evidence };
}

/**
 * The world a case runs in, decided by a rule and not by hand: a case whose scenario names garments of the
 * corpus's constructed fixture, or whose outcome the corpus pins with state assertions, is a boundary
 * condition defined by the corpus and runs on the labelled SYNTHETIC fixture wardrobe. Every other case
 * runs on the owner's real profile and real stock.
 */
function worldOf(c, corpus) {
  const ids = new Set(corpus.fixture.items.map((i) => i.id));
  const names = stringsIn(c.scenario).some((s) => ids.has(s));
  return names || c.id in corpus.assertions ? "synthetic_fixture" : "owner_real_stock";
}

const CANDIDATE_FORBIDDEN = ["judge_criteria", "source_ids", "historical_evidence", "title", "construction_note", "family", "origin", "split", "expected", "assertions"];

/** Candidate input for one split: built from the bundle's own candidate packets, then reduced further. */
function candidateInput(corpus, selected, split, driver, work) {
  const cases = [];
  for (const c of selected) {
    if (c.split !== split) throw new Error(`split guard: ${c.id} belongs to ${c.split}, not ${split}`);
    const packetFile = path.join(work, "packets", `${c.id}-candidate.json`);
    mkdirSync(path.dirname(packetFile), { recursive: true });
    const packet = JSON.parse(evaluatePy(["packet", "--case", c.id, "--mode", "candidate"]).stdout);
    for (const key of CANDIDATE_FORBIDDEN) if (key in packet) throw new Error(`isolation guard: the candidate packet of ${c.id} contains ${key}`);
    writeJson(packetFile, packet);
    cases.push({ id: packet.case_id, request: packet.request, scenario: packet.scenario, world: worldOf(c, corpus) });
  }
  return { split, driver, fixture: corpus.fixture, cases };
}

/* ------------------------------------------------------------------ */
/* Phase: candidate                                                     */
/* ------------------------------------------------------------------ */

function runProcess(cmd, args, options) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output }));
    child.on("error", (error) => resolve({ code: -1, output: `${output}\n${error.message}` }));
  });
}

async function candidatePhase(input, work, shards) {
  const groups = Array.from({ length: Math.max(1, Math.min(shards, input.cases.length)) }, () => []);
  input.cases.forEach((c, i) => groups[i % groups.length].push(c));
  const vitest = path.join(repo, "node_modules/.bin/vitest");
  const runs = groups.map(async (group, k) => {
    const file = path.join(work, `candidate-input-${k}.json`);
    writeJson(file, { ...input, cases: group });
    const result = await runProcess(vitest, ["run", "--root", here], { cwd: here, env: phaseEnv({ EVAL_RUN_DIR: work, EVAL_CASES_FILE: file, EVAL_DRIVER: input.driver }) });
    writeFileSync(path.join(work, `candidate-process-${k}.log`), result.output);
    return { shard: k, cases: group.map((c) => c.id), exitCode: result.code };
  });
  return Promise.all(runs);
}

/* ------------------------------------------------------------------ */
/* Phase: assemble and deterministic checks                             */
/* ------------------------------------------------------------------ */

function modelCallsOf(work, applicationRunId) {
  const name = safeName(applicationRunId);
  if (!name) return [];
  const dir = path.join(work, "raw", "model-calls", name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((name) => {
    const call = readJson(path.join(dir, name));
    return { status: call.status ?? null, profileId: call.profileId ?? null, resolvedModel: call.resolvedModel ?? null, requestedModel: call.requestedModel, inputTokens: call.inputTokens ?? null, outputTokens: call.outputTokens ?? null, elapsedMs: call.elapsedMs ?? null, stopReason: call.stopReason ?? null, requestSha256: sha(JSON.stringify(call.request)), responseSha256: call.response ? sha(call.response) : null, error: call.error ?? null };
  });
}

/** The candidate file in the corpus's own shape, from what the owner could see. No identifiers of the model, no trace. */
function candidateFile(run, requestedCount = null) {
  const v = run.visible;
  if (!v) return null;
  const toFixture = (id) => Object.entries(run.fixture_ids ?? {}).find(([, g]) => g.garmentId === id)?.[0] ?? id;
  // Both shapes the application answers with: options on the run's result, or a published board's options.
  // Every option of a source is kept as given, malformed (no garments) and repeated ones included, so the judge
  // and the checks see them. Only a source that mirrors the other exactly (the result carrying the same options
  // as the board it published) is taken once.
  const shape = (o, i) => ({ id: String(o?.optionId ?? o?.id ?? `option-${i + 1}`), garment_ids: (Array.isArray(o?.garments) ? o.garments : Array.isArray(o?.slots) ? o.slots : []).map((g) => toFixture(String(g?.garmentId ?? g))), footwear_alternative_ids: (Array.isArray(o?.footwearAlternatives) ? o.footwearAlternatives : []).map((g) => toFixture(String(g?.garmentId ?? g))), explanation: String(o?.reason ?? o?.explanation ?? "") });
  const fromResult = (Array.isArray(v.options) ? v.options : []).map(shape);
  const fromBoard = (Array.isArray(v.board?.options) ? v.board.options : []).map(shape);
  const mirrored = fromResult.length > 0 && JSON.stringify(fromResult) === JSON.stringify(fromBoard);
  const options = mirrored ? fromResult : [...fromResult, ...fromBoard];
  return {
    response: v.reply,
    options,
    // A board with fewer outfits than asked for carries the application's own notice as its stated reason.
    ...(requestedCount && options.length > 0 && options.length < requestedCount && v.board?.notice ? { shortage_reason: String(v.board.notice) } : {}),
    actions_recorded_by_the_application: v.receipts.map((r) => ({ type: r.type, outcome: r.outcome, summary: r.summary })),
    requests_waiting_for_the_owner: v.requests_to_confirm,
    question_asked_of_the_owner: v.question_asked,
    run_state: v.state,
  };
}

const available = (g) => !g.hardExcluded && g.acquisition === "owned" && g.balances.some((b) => b.bucket === "clean" && b.quantity > 0);

/** Problems with the footwear alternatives of a board, against the wardrobe as it was before the turn. */
function alternativeErrors(alternatives, byId, fixtureIds) {
  const errors = [];
  for (const { option, id } of alternatives) {
    const g = byId.get(fixtureIds[id]?.garmentId ?? id);
    if (!g) errors.push(`Option ${option}: footwear alternative ${id} is not a garment of this wardrobe.`);
    else {
      if (!g.roles.includes("footwear")) errors.push(`Option ${option}: footwear alternative ${g.name} is not footwear.`);
      if (!available(g)) errors.push(`Option ${option}: footwear alternative ${g.name} is not available in application state.`);
      if (g.roles.includes("footwear") && g.attributes?.footwearKind !== "sneaker") errors.push(`Option ${option}: footwear alternative ${g.name} breaks the active footwear restriction.`);
    }
  }
  return errors;
}

function deterministicChecks(c, run, corpus, caseDir, runId) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const conversation = run.driver_mode === "conversation";

  // 1. Observed application state against the corpus's state assertions, by the bundle's own checker.
  if (c.id in corpus.assertions) {
    if (!run.observation) add("state_assertions", "not_run", "the adapter recorded no observation for this case");
    else {
      const file = path.join(caseDir, "observed-state.json");
      writeJson(file, { case_id: c.id, observed: run.observation.observed, evidence: run.observation.evidence, provenance: { source: "application_adapter", run_id: runId, artifact_paths: [`cases/${c.id}/candidate-run.json`], driver_mode: run.driver_mode } });
      const outcome = checkerOutcome(evaluatePy(["check-state", "--case", c.id, "--file", file], { allowFailure: true }));
      add("state_assertions", outcome.status, outcome.checkerFailed ? `evaluate.py check-state: ${outcome.detail}` : outcome.status === "passed" ? `every asserted outcome was observed in application state (${Object.keys(corpus.assertions[c.id]).join(", ")})` : outcome.errors);
    }
  }

  // 2. A structured board, when the application returned one: the bundle's structural check (synthetic
  //    world, fixture IDs) or the same rules against the application's own wardrobe (real stock).
  const candidate = candidateFile(run, c.scenario.requested_count ?? null);
  if (candidate) writeJson(path.join(caseDir, "candidate.json"), candidate);
  // A malformed option (no garments) or the same outfit offered twice is a defect of the board, never dropped.
  if (candidate && candidate.options.length > 0) {
    const problems = [];
    candidate.options.forEach((o, i) => {
      if (o.garment_ids.length === 0) problems.push(`Option ${i} (${o.id}) names no garment.`);
    });
    const outfits = candidate.options.filter((o) => o.garment_ids.length > 0).map((o) => [...o.garment_ids].sort().join(","));
    const repeated = outfits.filter((key, i) => outfits.indexOf(key) !== i);
    if (repeated.length > 0) problems.push(`${repeated.length} option(s) repeat an outfit already offered.`);
    add("options_well_formed", problems.length === 0 ? "passed" : "failed", problems.length === 0 ? `${candidate.options.length} option(s), each naming garments, none repeated` : problems);
  }
  if (candidate && candidate.options.length > 0) {
    if (run.world === "synthetic_fixture") {
      const outcome = checkerOutcome(evaluatePy(["check-candidate", "--case", c.id, "--candidate", path.join(caseDir, "candidate.json")], { allowFailure: true }));
      add("board_structure", outcome.status, outcome.checkerFailed ? `evaluate.py check-candidate: ${outcome.detail}` : outcome.status === "passed" ? "the bundle's structural check found nothing" : outcome.errors);
    } else {
      const byId = new Map(run.wardrobe_before.map((g) => [g.garmentId, g]));
      const errors = [];
      candidate.options.forEach((o, i) => {
        const roles = new Set();
        for (const id of o.garment_ids) {
          const g = byId.get(id);
          if (!g) errors.push(`Option ${i}: ${id} is not a garment of this wardrobe.`);
          else {
            g.roles.forEach((r) => roles.add(r));
            if (!available(g)) errors.push(`Option ${i}: ${g.name} is not available in application state.`);
            if (g.roles.includes("footwear") && g.attributes.footwearKind !== "sneaker") errors.push(`Option ${i}: ${g.name} breaks the active footwear restriction.`);
          }
        }
        for (const role of ["top", "bottom", "socks", "footwear"]) if (!roles.has(role)) errors.push(`Option ${i}: no ${role}.`);
        if (new Set(o.garment_ids).size !== o.garment_ids.length) errors.push(`Option ${i}: duplicated garment.`);
      });
      // The same count rules as the bundle's structural check.
      const count = c.scenario.requested_count;
      if (count && candidate.options.length > count) errors.push(`Too many options for the requested board (${candidate.options.length} for ${count}).`);
      if (count && candidate.options.length < count && !candidate.shortage_reason) errors.push(`A board of ${candidate.options.length} for ${count} requested states no reason for the shortage.`);
      add("board_structure", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? `every option uses available garments of the real wardrobe, with top, bottom, socks and permitted footwear${count ? `; ${candidate.options.length} of ${count} requested` : ""}` : errors);
    }
  } else if (conversation && c.scenario.requested_count) {
    add("board_structure", "unverified", `${c.scenario.requested_count} outfit(s) were asked for and the application answered in prose without a structured board, so the count, the garment identities, their availability and the footwear restriction could not be checked mechanically`);
  }
  // 2b. Footwear alternatives offered beside an option are recommendations too: each must exist, be available
  //     and keep to the footwear restriction, in either world (fixture IDs map back to the application's garments).
  const alternatives = (candidate?.options ?? []).flatMap((o, i) => (o.footwear_alternative_ids ?? []).map((id) => ({ option: i, id })));
  if (alternatives.length > 0) {
    const byId = new Map(run.wardrobe_before.map((g) => [g.garmentId, g]));
    const errors = alternativeErrors(alternatives, byId, run.fixture_ids ?? {});
    add("footwear_alternatives", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? `${alternatives.length} footwear alternative(s) exist, are available and keep to the footwear restriction` : errors);
  }

  // 3. Checks from application state that hold for every case that ran.
  if (run.status === "ran") {
    const before = new Set(run.wardrobe_before.map((g) => g.garmentId));
    const created = run.wardrobe_after.filter((g) => !before.has(g.garmentId));
    add("no_garment_created_unasked", created.length === 0 ? "passed" : "review", created.length === 0 ? "the wardrobe has the same garments after the turn as before" : created.map((g) => `created: ${g.name} (shown to the judge as garments_created_during_request; whether it was asked for is decided there, and the case cannot pass unjudged)`));
    if (conversation) {
      const shown = (run.run_document?.receipts ?? []).map((r) => r.commandId).filter(Boolean);
      const stored = new Set((run.receipts_after_act ?? []).map((r) => r.commandId));
      const missing = shown.filter((id) => !stored.has(id));
      add("receipts_are_stored", missing.length === 0 ? "passed" : "failed", missing.length === 0 ? `${shown.length} receipt(s) shown by the run are stored receipts of the ledger` : `${missing.length} receipt(s) shown by the run are not in the ledger`);
      const excluded = run.wardrobe_before.filter((g) => g.hardExcluded && g.name.length >= 8 && run.visible.reply.toLowerCase().includes(g.name.toLowerCase()));
      add("excluded_garments_named_in_reply", excluded.length === 0 ? "passed" : "review", excluded.length === 0 ? "the reply names no garment the application holds as excluded" : excluded.map((g) => `${g.name} is excluded in application state and is named in the reply (naming is not recommending; the judge decides)`));
      add("run_settled", run.visible.state === "completed" ? "passed" : run.visible.state === "needs_input" ? "review" : "failed", `the run ended in state ${run.visible.state}${run.visible.error ? `: ${JSON.stringify(run.visible.error).slice(0, 300)}` : ""}`);
    }
  }
  return { checks, candidate };
}

/* ------------------------------------------------------------------ */
/* Phase: judge                                                         */
/* ------------------------------------------------------------------ */

/** The descriptive attributes of a garment, scalar values and short lists only, without notes or identifiers. */
function publicAttributes(attributes) {
  const out = {};
  for (const [k, v] of Object.entries(attributes ?? {})) {
    if (k === "footwearKind" || /note|id$|ids$|source|provenance|secret|token/i.test(k)) continue;
    if (typeof v === "string" && v.length > 0 && v.length <= 80) out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.length <= 8 && v.every((x) => typeof x === "string" && x.length <= 40)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Exactly what the judge is given for a case: the bundle's judge packet over the candidate file (every option
 * with its garments and its footwear alternatives, verbatim) plus the application's evidence.
 */
function judgePacket(c, run, candidatePath) {
  const packet = JSON.parse(evaluatePy(["packet", "--case", c.id, "--mode", "judge", "--candidate", candidatePath]).stdout);
  packet.application_evidence = applicationEvidence(run);
  if (run.world === "owner_real_stock") packet.fixture = { note: "Not the candidate's stock in this run; see application_evidence.wardrobe_before_request.", default_date: packet.fixture.default_date, timezone: packet.fixture.timezone };
  return packet;
}

/** What the judge is told about the world the candidate actually answered in. Read from application state. */
function applicationEvidence(run) {
  const wardrobe = run.wardrobe_before.map((g) => ({
    // The identifier the candidate's structured options use (the fixture id in a fixture world, else the garment id).
    garment_id: g.fixtureId ?? g.garmentId,
    name: g.name,
    ...(g.fixtureId ? { fixture_id: g.fixtureId } : {}),
    category: g.category,
    roles: g.roles,
    units: Object.fromEntries(g.balances.map((b) => [b.bucket, b.quantity])),
    available_now: available(g),
    ...(g.hardExcluded ? { excluded: true } : {}),
    ...(g.attributes.footwearKind ? { footwear_kind: g.attributes.footwearKind } : {}),
    // The garment's public description (fabric, fit, size, colour and the like), so taste is judged on what the
    // candidate could see. Free-text notes and internal fields are left out.
    ...(publicAttributes(g.attributes) ? { attributes: publicAttributes(g.attributes) } : {}),
  }));
  const known = new Set(run.wardrobe_before.map((g) => g.garmentId));
  const created = (run.wardrobe_after ?? []).filter((g) => !known.has(g.garmentId)).map((g) => ({ garment_id: g.fixtureId ?? g.garmentId, name: g.name, category: g.category, roles: g.roles, acquisition: g.acquisition }));
  return {
    world: run.world,
    world_note:
      run.world === "owner_real_stock"
        ? "The candidate answered inside the application holding the owner's REAL imported wardrobe, listed here as the application reported it before the request. The corpus's synthetic fixture was not the candidate's stock: judge garment existence and availability against THIS list."
        : "The candidate answered inside the application holding the corpus's constructed fixture wardrobe (labelled synthetic), listed here as the application reported it before the request.",
    owner_message_as_sent: run.owner_message,
    run_date: run.today,
    date_note: `The application runs on the real calendar. The corpus fixture's "today" (2026-09-15) corresponds to ${run.today} in this run.`,
    wardrobe_before_request: wardrobe,
    garments_created_during_request: created,
    garments_created_note: "Garments that exist after the request and did not before. Whether the owner asked for each one is for the judge to decide: a garment created unasked is a hard violation.",
  };
}

/**
 * The judge's route for one case. The bundle names the judge ("Codex judges taste") and forbids the
 * candidate grading itself; within the application's gateway that becomes: the registry's OpenAI route
 * first, then the other registry routes, taking the first that answered this run's text probe and did NOT
 * answer this case's candidate. EVAL_JUDGE_ROUTES (comma-separated registry routes) overrides the order.
 */
/** The judge's route order: EVAL_JUDGE_ROUTES when set (every entry must be a registry route), else the registry's OpenAI route first. */
function judgeRouteOrder(registry) {
  const registryRoutes = registry.profiles.map((p) => p.gatewayRoute).filter(Boolean);
  const preferred = process.env.EVAL_JUDGE_ROUTES ? process.env.EVAL_JUDGE_ROUTES.split(",").map((s) => s.trim()).filter(Boolean) : [...registryRoutes.filter((x) => x.startsWith("openai/")), ...registryRoutes.filter((x) => !x.startsWith("openai/"))];
  for (const x of preferred) if (!registryRoutes.includes(x)) throw new Error(`EVAL_JUDGE_ROUTES names ${x}, which is not a route of the application's registry`);
  if (preferred.length === 0) throw new Error("EVAL_JUDGE_ROUTES names no route");
  return preferred;
}

/** The gateway routes of the conversation task's candidate profiles, in the registry's order. */
const conversationRoutes = (registry) => registry.conversationCandidates.map((id) => registry.profiles.find((p) => p.profileId === id)?.gatewayRoute).filter(Boolean);

/**
 * Why independent judging cannot be guaranteed for every case, or null. A judge route must have answered the
 * text probe and lie outside EVERY route the candidate can use (conversation candidates whose text and tool
 * probes passed, minus the route kept for the judge), so whichever routes a candidate ends up using, a judge
 * route is left. Checked before the holdout ledger is written, so a run that could not be judged never
 * consumes the holdout.
 */
function judgeAvailabilityRefusal(probes, registry) {
  return judgeAvailability(probes, judgeRouteOrder(registry), conversationRoutes(registry));
}

function judgeRouteFor(candidateRoutes, probes, registry) {
  const answered = new Set(probes.profiles.filter((p) => p.operations.text?.result === "passed").map((p) => p.gatewayRoute));
  const preferred = judgeRouteOrder(registry);
  return preferred.find((x) => answered.has(x) && !candidateRoutes.includes(x)) ?? null;
}

/** Whether the candidate showed the owner anything: prose, structured options or a board, receipts, requests to confirm or a question. */
function hasVisibleAnswer(shown) {
  const v = shown ?? {};
  return Boolean(v.reply) || (v.receipts ?? []).length > 0 || (v.requests_to_confirm ?? []).length > 0 || (v.options ?? []).length > 0 || (v.board?.options ?? []).length > 0 || Boolean(v.question_asked);
}

async function judgePhase(selected, work, concurrency, probes, registry) {
  const queue = [...selected];
  const outcomes = {};
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const caseDir = path.join(work, "cases", c.id);
      const run = existsSync(path.join(caseDir, "candidate-run.json")) ? readJson(path.join(caseDir, "candidate-run.json")) : null;
      const candidatePath = path.join(caseDir, "candidate.json");
      if (!run || run.status !== "ran" || run.driver_mode !== "conversation" || !existsSync(candidatePath)) {
        outcomes[c.id] = { status: "not_run", reason: !run ? "the candidate phase recorded nothing" : run.driver_mode !== "conversation" ? "no candidate answer exists: the case ran with scripted commands, without the model" : run.status !== "ran" ? `the candidate did not run (${run.status})` : "no candidate answer" };
        continue;
      }
      if (!hasVisibleAnswer(run.visible)) {
        outcomes[c.id] = { status: "not_run", reason: `the candidate produced no visible answer (run state ${run.visible?.state}); there is nothing to judge` };
        continue;
      }
      const candidateRoutes = [...new Set(modelCallsOf(work, run.application_run_id).filter((k) => k.status === 200).map((k) => k.requestedModel))];
      const judgeRoute = judgeRouteFor(candidateRoutes, probes, registry);
      if (!judgeRoute) {
        outcomes[c.id] = { status: "not_run", reason: `no gateway route is left for an independent judge: the candidate was answered by ${candidateRoutes.join(", ") || "no route"} and no other registry route passed this run's text probe` };
        continue;
      }
      const packet = judgePacket(c, run, candidatePath);
      const packetPath = path.join(work, "judge", c.id, "judge-packet.json");
      writeJson(packetPath, packet);
      const out = path.join(work, "judge", c.id, "judgment.json");
      const log = path.join(work, "raw", "judge-calls", `${c.id}.json`);
      mkdirSync(path.dirname(log), { recursive: true });
      // A process of its own, started in an empty directory, given one path: the packet.
      const result = await runProcess(process.execPath, [path.join(here, "src/node/judge.mjs"), packetPath, out, log], { cwd: path.join(work, "judge", c.id), env: phaseEnv({ EVAL_JUDGE_ROUTE: judgeRoute }) });
      const calls = existsSync(log) ? readJson(log) : { calls: [] };
      const separation = { judgeRoute, candidateRoutes, sharesProviderWithCandidate: candidateRoutes.some((x) => x.split("/")[0] === judgeRoute.split("/")[0]) };
      if (result.code === 0) outcomes[c.id] = { status: "judged", judgment: readJson(out).judgment, packetSha256: sha(readFileSync(packetPath)), calls: calls.calls, ...separation };
      else outcomes[c.id] = { status: "not_run", reason: result.code === 3 ? `the judge returned no valid judgment after one retry: ${readJson(out).problem}` : `the judge route ${judgeRoute} was not available (${calls.error ?? calls.calls?.at(-1)?.errorBody ?? `exit ${result.code}`})`.slice(0, 600), calls: calls.calls ?? [], ...separation };
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return outcomes;
}

/* ------------------------------------------------------------------ */
/* Isolation audit                                                      */
/* ------------------------------------------------------------------ */

/** After the fact, from what was actually sent: did anything the candidate must not see reach the model? */
function isolationAudit(corpus, split, work, registry) {
  const needles = [];
  for (const c of corpus.cases) {
    for (const criterion of c.judge_criteria) needles.push({ kind: "judge_criterion", case: c.id, text: criterion });
    if (c.title.length >= 24) needles.push({ kind: "case_title", case: c.id, text: c.title });
    if (c.split !== split) needles.push({ kind: `request_of_${c.split}_case`, case: c.id, text: c.prompt });
  }
  for (const key of assertionKeys(corpus)) needles.push({ kind: "state_assertion_key", case: null, text: key });
  for (const [id, e] of Object.entries(corpus.evidence)) if (typeof e.quote === "string" && e.quote.length >= 60) needles.push({ kind: "historical_evidence_quote", case: id, text: e.quote });
  const findings = [];
  let requests = 0;
  const root = path.join(work, "raw", "model-calls");
  if (existsSync(root)) {
    for (const dir of readdirSync(root)) {
      for (const name of readdirSync(path.join(root, dir))) {
        const call = readJson(path.join(root, dir, name));
        const sent = JSON.stringify(call.request);
        requests++;
        for (const n of needles) if (sent.includes(JSON.stringify(n.text).slice(1, -1))) findings.push({ kind: n.kind, case: n.case, in: `raw/model-calls/${dir}/${name}` });
      }
    }
  }
  // The other direction: nothing of the candidate's machinery in what the judge was given.
  const judgeFindings = [];
  const judgeRoot = path.join(work, "judge");
  let packets = 0;
  if (existsSync(judgeRoot)) {
    for (const id of readdirSync(judgeRoot)) {
      const file = path.join(judgeRoot, id, "judge-packet.json");
      if (!existsSync(file)) continue;
      packets++;
      const text = readFileSync(file, "utf8");
      const rubric = readFileSync(path.join(bundle, "judge.md"), "utf8");
      const shown = JSON.stringify(readJson(file).candidate);
      const identities = registry.profiles.flatMap((p) => [p.gatewayRoute, p.apiModelId, p.profileId]).filter(Boolean);
      for (const marker of [...identities, "tool_use", "toolCalls", "tool_calls", "x-eval-run", "cf-aig", "reasoning"]) if (text.includes(marker) && !rubric.includes(marker) && !shown.includes(marker)) judgeFindings.push({ marker: identities.includes(marker) ? `a model identity of the registry (${marker})` : marker, in: `judge/${id}/judge-packet.json` });
    }
  }
  return { candidate_requests_scanned: requests, needles: needles.length, candidate_leaks: findings, judge_packets_scanned: packets, judge_leaks: judgeFindings, clean: findings.length === 0 && judgeFindings.length === 0 };
}

/* ------------------------------------------------------------------ */
/* Results                                                              */
/* ------------------------------------------------------------------ */

/**
 * The outcome of a case whose candidate answered. A negative result (a failed deterministic check, a failing
 * or revising verdict, a hard violation, insufficient evidence) is reported before anything left incomplete,
 * so an unverifiable board never hides a judgment that the answer is wrong. Only a case with no negative
 * result and something incomplete is not_run; a pass needs every check complete and a passing verdict.
 */
function caseStatus({ failed, incomplete, taste }) {
  const reasons = [];
  const judgment = taste?.status === "judged" ? taste.judgment : null;
  const negativeVerdict = judgment && (judgment.hard_violations.length > 0 || judgment.verdict === "fail" || judgment.verdict === "revise");
  if (failed.length > 0) reasons.push(...failed.map((k) => `deterministic check ${k.name} failed`));
  if (negativeVerdict) reasons.push(`judge verdict ${judgment.verdict}${judgment.hard_violations.length ? ` with ${judgment.hard_violations.length} hard violation(s)` : ""}`);
  else if (judgment?.verdict === "insufficient_evidence") reasons.push("not shown to pass: the judge found the evidence insufficient");
  if (reasons.length > 0) {
    for (const k of incomplete) reasons.push(`also: deterministic check ${k.name} did not complete (${k.status})`);
    return { status: "failed", reasons };
  }
  if (incomplete.length > 0) return { status: "not_run", reasons: incomplete.map((k) => `deterministic check ${k.name} did not complete (${k.status}): ${typeof k.detail === "string" ? k.detail : JSON.stringify(k.detail)}`.slice(0, 400)) };
  if (!judgment) return { status: "not_run", reasons: [`not judged: ${taste?.reason ?? "no judgment"}`] };
  return { status: "passed", reasons };
}

function caseResult(c, corpus, work, judged, runId, r, checkPhase = true) {
  const caseDir = path.join(work, "cases", c.id);
  const runFile = path.join(caseDir, "candidate-run.json");
  const base = { case_id: c.id, split: c.split, family: c.family, title: c.title, world: worldOf(c, corpus), run_id: runId };
  if (!existsSync(runFile)) return { ...base, status: "not_run", reason: "the candidate phase recorded nothing for this case (see the candidate process log)", deterministic: [], taste: { status: "not_run", reason: "no candidate answer" } };
  const run = readJson(runFile);
  if (run.status === "adapter_error") return { ...base, driver_mode: run.driver_mode, status: "not_run", reason: `harness adapter error at stage "${run.stage}": ${run.error.message}`, adapter_error: run.error, deterministic: [], taste: { status: "not_run", reason: "no candidate answer" } };
  if (run.status === "not_run") return { ...base, driver_mode: run.driver_mode, status: "not_run", reason: run.not_run_reason, deterministic: [], taste: { status: "not_run", reason: "no candidate answer" } };
  // The deterministic checks run only in the check phase; without it every case says so and none is passed.
  const { checks } = checkPhase ? deterministicChecks(c, run, corpus, caseDir, runId) : { checks: [{ name: "deterministic_checks", status: "not_run", detail: "the check phase was not part of this run" }] };
  const calls = modelCallsOf(work, run.application_run_id);
  const answered = calls.filter((k) => k.status === 200);
  const inference =
    run.driver_mode === "conversation"
      ? { kind: answered.length > 0 ? "real" : "none_answered", gateway: r.gatewayId, routes_answered: [...new Set(answered.map((k) => k.requestedModel))], application_profiles: [...new Set(answered.map((k) => k.profileId).filter(Boolean))], resolved_models: [...new Set(answered.map((k) => k.resolvedModel).filter(Boolean))], calls: calls.length, calls_answered: answered.length, input_tokens: answered.reduce((n, k) => n + (k.inputTokens ?? 0), 0), output_tokens: answered.reduce((n, k) => n + (k.outputTokens ?? 0), 0), call_digests: calls }
      : { kind: "scripted", note: "No model was called. The harness issued, as the owner, the command the owner's sentence states. This exercises the ledger and the services, not the assistant." };
  const taste = judged[c.id] ?? { status: "not_run", reason: "the judge phase was not part of this run" };
  const failed = checks.filter((k) => k.status === "failed");
  // A deterministic check that applies to the case and did not complete (no observation, an unreadable
  // result, a board that could not be checked mechanically) is never treated as passed.
  const incomplete = checks.filter((k) => k.status === "not_run" || k.status === "unverified");
  if (c.id in corpus.assertions && checkPhase && !checks.some((k) => k.name === "state_assertions")) incomplete.push({ name: "state_assertions", status: "not_run", detail: "the state assertions of this case were not checked" });
  const reasons = [];
  let status;
  if (run.driver_mode !== "conversation") {
    status = "not_run";
    reasons.push("the candidate (the application's assistant on its gateway routes) did not run; only the scripted ledger check below ran");
  } else if (inference.kind !== "real") {
    status = "not_run";
    reasons.push(`no model call was answered (${calls.length} attempted); run state ${run.visible?.state}`);
  } else {
    const decided = caseStatus({ failed, incomplete, taste });
    status = decided.status;
    reasons.push(...decided.reasons);
  }
  // A check left for review (garments created, excluded garments named, a run waiting for input) is settled by
  // the judge, who was shown the same facts; it is recorded beside the pass.
  const reviewed = checks.filter((k) => k.status === "review").map((k) => k.name);
  if (status === "passed" && reviewed.length > 0) reasons.push(`passed with ${reviewed.join(", ")} left to the judge, whose verdict covers them`);
  const scripted = run.driver_mode !== "conversation" ? { scripted_ledger_check: checks.some((k) => k.status === "failed") ? "failed" : checks.some((k) => k.name === "state_assertions" && k.status === "passed") ? "passed" : "not_run" } : {};
  return { ...base, driver_mode: run.driver_mode, status, reasons, ...scripted, inference, deterministic: checks, taste: taste.status === "judged" ? { status: "judged", independent_context: true, judge_route: taste.judgeRoute, candidate_routes: taste.candidateRoutes, shares_route_with_candidate: taste.candidateRoutes.includes(taste.judgeRoute), shares_provider_with_candidate: taste.sharesProviderWithCandidate, packet_sha256: taste.packetSha256, calls: taste.calls, ...taste.judgment } : taste, turn_elapsed_ms: run.turn_elapsed_ms, started_at: run.started_at, finished_at: run.finished_at };
}

function publish(split, runId, work, results, meta) {
  const dest = split === "holdout" ? path.join(resultsRoot, "holdout") : path.join(resultsRoot, split, runId);
  for (const result of results) {
    writeJson(path.join(dest, "cases", result.case_id, "result.json"), result);
    for (const name of ["candidate.json", "observed-state.json"]) {
      const from = path.join(work, "cases", result.case_id, name);
      if (existsSync(from)) cpSync(from, path.join(dest, "cases", result.case_id, name));
    }
    const runFile = path.join(work, "cases", result.case_id, "candidate-run.json");
    if (existsSync(runFile)) {
      // The adapter's record without the two full wardrobe listings (kept as digests) and without the raw run document.
      const { wardrobe_before, wardrobe_after, run_document, ...kept } = readJson(runFile);
      writeJson(path.join(dest, "cases", result.case_id, "application-record.json"), { ...kept, wardrobe_before_sha256: wardrobe_before ? sha(JSON.stringify(wardrobe_before)) : null, wardrobe_garments: wardrobe_before?.length ?? null, wardrobe_after_sha256: wardrobe_after ? sha(JSON.stringify(wardrobe_after)) : null });
    }
  }
  const count = (status) => results.filter((x) => x.status === status).length;
  const summary = { ...meta, totals: { cases: results.length, passed: count("passed"), failed: count("failed"), not_run: count("not_run") }, scripted_ledger_checks: { passed: results.filter((x) => x.scripted_ledger_check === "passed").length, failed: results.filter((x) => x.scripted_ledger_check === "failed").length }, cases: results.map((x) => ({ case_id: x.case_id, status: x.status, reasons: x.reasons ?? [x.reason], world: x.world, driver_mode: x.driver_mode ?? null, inference: x.inference?.kind ?? null, scripted_ledger_check: x.scripted_ledger_check ?? null, verdict: x.taste?.verdict ?? null, hard_violations: x.taste?.hard_violations?.length ?? null })) };
  writeJson(path.join(dest, "summary.json"), summary);
  const lines = [
    `# Evaluation run ${runId}: ${split === "adapter-check" ? "adapter check (scripted, development cases only; NOT case results)" : `${split} split`}`,
    "",
    `- Driver: ${meta.driver}${meta.driver === "conversation" ? ` (candidate: the application's registry routes through gateway ${meta.route.gatewayId}; judge: a different registry route, a process of its own)` : " (NO model was called; scripted commands only)"}`,
    `- Cases: ${summary.totals.cases}. Passed ${summary.totals.passed}, failed ${summary.totals.failed}, not run ${summary.totals.not_run}.`,
    ...(meta.driver === "conversation" ? [] : [`- Scripted ledger checks (not case results): passed ${summary.scripted_ledger_checks.passed}, failed ${summary.scripted_ledger_checks.failed}.`]),
    `- Isolation audit: ${meta.isolation.clean ? "clean" : "VIOLATIONS FOUND"} (${meta.isolation.candidate_requests_scanned} candidate model requests and ${meta.isolation.judge_packets_scanned} judge packets scanned).`,
    `- Supplied bundle unchanged by the run: ${meta.bundle_unchanged}.`,
    `- Daily-service composition: ${meta.daily_composition}`,
    "",
    "| Case | Status | World | Inference | Scripted ledger check | Judge verdict | Reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...summary.cases.map((x) => `| ${x.case_id} | ${x.status} | ${x.world} | ${x.inference ?? "-"} | ${x.scripted_ledger_check ?? "-"} | ${x.verdict ?? "-"} | ${(x.reasons ?? []).join("; ").replace(/\|/g, "/").slice(0, 300)} |`),
    "",
  ];
  writeFileSync(path.join(dest, "SUMMARY.md"), lines.join("\n"));
  return { dest, summary };
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

const frozenFile = path.join(resultsRoot, "TUNING-FROZEN.json");
const holdoutLedger = path.join(resultsRoot, "holdout", "LEDGER.json");
const holdoutLock = path.join(resultsRoot, "holdout", ".RUNNING");

/** Create `file` only if it does not exist (atomic); false when it already exists. */
function createExclusive(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = openSync(file, "wx");
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(value, null, 1)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Pure guards, used by the commands and exercised directly by the self-test. */

/** Why the holdout may not start now, or null. */
function holdoutRefusal({ ledgerExists, subset, phasesGiven, driver, ready, missing = [] }) {
  if (ledgerExists) return "the holdout has already been run. It is run exactly once; there is no second run.";
  if (subset || phasesGiven) return "the holdout is run whole, in one piece: --cases and --phases are not accepted";
  if (driver !== "conversation" || !ready) return `the holdout is only run with the real model route. Missing: ${missing.join(", ") || "driver must be conversation"}`;
  return null;
}

/** Why a work directory may not be used for this run, or null. */
function workDirectoryRefusal({ recorded, manifest, phases, hasArtifacts }) {
  if (recorded?.invalidated) return `a run in it was invalidated because the build changed while it ran (${[].concat(recorded.invalidated).join(", ")}), so its artifacts describe no one build; use a fresh --work directory`;
  if (recorded) return sameJson(recorded, manifest) ? null : "it was produced against a different build, configuration or case set; use a fresh --work directory";
  if (!phases.includes("candidate") || hasArtifacts) return "it holds no record of what its artifacts were made against; a run without the candidate phase needs the work directory of a run of this exact build and configuration";
  return null;
}

/** Fingerprint keys whose digest differs between the start and the end of a run. */
function changedFingerprints(before, after) {
  return FINGERPRINT_KEYS.filter((key) => before?.[key] !== after?.[key]);
}

/** Why a published development summary cannot be frozen on (empty when it can). */
function freezeRefusals(s, prints, inference) {
  const why = [];
  if (s.driver !== "conversation") why.push("it called no model");
  if (s.subset) why.push("it ran a subset");
  if (!sameJson(s.phases, ["candidate", "check", "judge"])) why.push("it did not run the candidate, check and judge phases together");
  if (s.totals?.cases !== 45) why.push(`it has ${s.totals?.cases} cases, not 45`);
  if (s.totals?.not_run !== 0) why.push(`${s.totals?.not_run} case(s) were not run or not judged`);
  const unjudged = (s.cases ?? []).filter((x) => !x.verdict).map((x) => x.case_id);
  if (!Array.isArray(s.cases) || s.cases.length !== 45 || unjudged.length > 0) why.push(`not every case was judged${unjudged.length ? ` (${unjudged.join(", ")})` : ""}`);
  if (!Array.isArray(s.candidate_processes) || s.candidate_processes.length === 0 || s.candidate_processes.some((p) => p.exitCode !== 0)) why.push("a candidate process did not exit cleanly");
  if (!sameJson(s.inference, inference)) why.push(`its inference configuration ${JSON.stringify(s.inference)} is not the current one`);
  if (!s.isolation?.clean) why.push("its isolation audit is not clean");
  if (!s.bundle_unchanged) why.push("the supplied bundle changed during it");
  if (s.build_unchanged !== true) why.push(`the build changed while it ran (${(s.build_changed_during_run ?? ["not recorded"]).join(", ")})`);
  for (const key of FINGERPRINT_KEYS) if (s.fingerprints?.[key] !== prints[key]) why.push(`the ${key} has changed since`);
  return why;
}

async function runSplit(split) {
  if (split !== "holdout") return runSplitInner(split, () => {});
  // Exactly once, also against a concurrent start: only the process that creates the lock proceeds.
  if (existsSync(holdoutLedger)) throw new Error(holdoutRefusal({ ledgerExists: true }));
  if (!createExclusive(holdoutLock, { pid: process.pid, started_at: new Date().toISOString() })) throw new Error(`${path.relative(repo, holdoutLock)} exists: another holdout run is starting or running. Remove it only if no holdout run is in progress and no ledger exists.`);
  let ledgerWritten = false;
  try {
    await runSplitInner(split, () => {
      ledgerWritten = true;
    });
  } finally {
    // Released only when no ledger was written; once the ledger exists, it is what refuses a second run.
    if (!ledgerWritten && !existsSync(holdoutLedger)) rmSync(holdoutLock, { force: true });
  }
}

async function runSplitInner(split, onLedgerWritten) {
  const corpus = loadCorpus();
  const registry = readRegistry(repo);
  const r = route();
  const adapterCheck = split === "adapter-check";
  const driver = adapterCheck ? "scripted_commands" : option("driver", r.ready ? "conversation" : "scripted_commands");
  if (!["conversation", "scripted_commands"].includes(driver)) throw new Error(`unknown driver ${driver}`);
  const subset = option("cases");
  const phases = adapterCheck ? ["candidate", "check"] : (option("phases", "candidate,check,judge") ?? "").split(",").map((p) => p.trim());
  const badPhases = phaseRefusal(phases);
  if (badPhases) throw new Error(badPhases);
  const shards = Number(option("shards", "4"));
  const judges = Number(option("judges", "4"));
  // Validated before anything is written (in particular before the holdout ledger): a run that could not
  // run its candidates or judges must not consume the holdout.
  for (const [name, value] of [["--shards", shards], ["--judges", judges]]) if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error(`${name} must be a whole number from 1 to 64`);
  if (driver === "conversation") judgeRouteOrder(registry); // an invalid EVAL_JUDGE_ROUTES is refused before anything runs
  const prints = fingerprints();
  if (split === "holdout") {
    const refusal = holdoutRefusal({ ledgerExists: existsSync(holdoutLedger), subset, phasesGiven: option("phases") !== null, driver, ready: r.ready, missing: r.missing });
    if (refusal) throw new Error(refusal);
    if (!existsSync(frozenFile)) throw new Error("tuning has not been declared finished: run `node evals/run.mjs freeze` after the last development run");
    const frozen = readJson(frozenFile);
    for (const key of FINGERPRINT_KEYS) if (frozen.fingerprints[key] !== prints[key]) throw new Error(`the ${key} changed after tuning was frozen; freeze again (which records the change) before the holdout`);
    if (JSON.stringify(frozen.inference) !== JSON.stringify(inferenceConfiguration(registry))) throw new Error(`the inference configuration differs from the frozen one (${JSON.stringify(frozen.inference)}); the holdout runs on the configuration the development run used`);
  }
  if (driver === "conversation" && !r.ready) throw new Error(`the AI Gateway route is not configured. Missing from the environment: ${r.missing.join(", ")}`);
  // The adapter check takes the DEVELOPMENT cases whose outcome the corpus pins in application state. A
  // held-out case is never run before the holdout run, in any form.
  const { caseSplit, selected } = selectCases(corpus.cases, Object.keys(corpus.assertions), split, adapterCheck, subset);
  if (selected.length === 0) throw new Error("no case selected");
  // Unique per start (two runs in the same second never share a work or result directory).
  const runId = `${split}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z")}-${crypto.randomUUID().slice(0, 8)}`;
  // Always absolute: phase processes run in other working directories (evals/, the case's judge directory).
  const work = path.resolve(option("work") ?? path.join(process.env.EVAL_WORK_DIR ?? path.join(os.tmpdir(), "garderobe-evals"), runId));
  {
    const refusal = workDirRefusal(work);
    if (refusal) throw new Error(refusal);
  }
  mkdirSync(work, { recursive: true });
  // One run at a time per work directory: the lock is created exclusively and removed when this run ends.
  const workLock = path.join(work, ".IN-USE");
  if (!createExclusive(workLock, { pid: process.pid, run_id: runId, started_at: new Date().toISOString() })) throw new Error(`the work directory ${work} is in use by another run (${workLock}); remove the lock only if no run is using it`);
  try {
    await runInWork({ split, corpus, registry, r, adapterCheck, driver, subset, phases, shards, judges, prints, caseSplit, selected, runId, work, onLedgerWritten });
  } finally {
    rmSync(workLock, { force: true });
  }
}

async function runInWork({ split, corpus, registry, r, adapterCheck, driver, subset, phases, shards, judges, prints, caseSplit, selected, runId, work, onLedgerWritten }) {
  const bundleBefore = digest(treeHashes(path.join(repo, "requirements/support")));
  // What this work directory's artifacts are made against. A run that reuses a work directory (a later phase
  // over earlier candidate output, or saved probes) is refused unless it matches the current build,
  // configuration and case set exactly, so results are never stamped with fingerprints they were not made against.
  const inference = inferenceConfiguration(registry);
  const manifest = { split: caseSplit, driver, fingerprints: prints, inference, gatewayId: r.gatewayId, cases: selected.map((c) => c.id) };
  const manifestFile = path.join(work, "WORK-MANIFEST.json");
  const workRefusal = workDirectoryRefusal({ recorded: existsSync(manifestFile) ? readJson(manifestFile) : null, manifest, phases, hasArtifacts: existsSync(path.join(work, "cases")) || existsSync(path.join(work, "raw")) });
  if (workRefusal) throw new Error(`the work directory ${work}: ${workRefusal}`);
  if (!existsSync(manifestFile)) writeJson(manifestFile, manifest);

  // Real probes of the gateway, before anything is shown to a candidate (and before the holdout ledger is written).
  let probes = { gatewayId: r.gatewayId, gatewayHost: r.host, probedAt: null, profiles: [] };
  if (driver === "conversation") {
    const probesFile = path.join(work, "raw", "probes.json");
    const saved = existsSync(probesFile);
    probes = saved ? readJson(probesFile) : { ...(await probeRoutes(r, registry)), gatewayEndpointSha256: inference.gatewayEndpointSha256 };
    if (probes.gatewayId !== r.gatewayId || probes.gatewayEndpointSha256 !== inference.gatewayEndpointSha256) throw new Error(`the saved probes in ${probesFile} are of another gateway endpoint than ${r.gatewayId} at the current account and host`);
    // One answering route is kept for the independent judge before any candidate runs: the relay refuses it to
    // the candidate and the application is told it is unavailable. Saved probes keep their reservation.
    if (!saved) {
      const kept = reserveJudgeRoute(probes, judgeRouteOrder(registry), conversationRoutes(registry));
      probes.reservedForJudging = kept ? [kept] : [];
    }
    writeJson(probesFile, probes);
    for (const p of probes.profiles) console.log(`probe ${p.profileId} (${p.gatewayRoute ?? "no route"}): ${Object.entries(p.operations).map(([op, o]) => `${op} ${o.result}`).join(", ") || "not probed"}${(probes.reservedForJudging ?? []).includes(p.gatewayRoute) ? " (kept for the judge)" : ""}`);
    const usable = candidateRoutes(probes, conversationRoutes(registry));
    if (usable.length === 0) throw new Error(`no conversation profile of the registry answered on gateway ${r.gatewayId}: ${probes.profiles.map((p) => `${p.gatewayRoute}: ${p.operations.text?.reason ?? p.operations.tools?.reason ?? "no route"}`).join(" | ").slice(0, 1500)}`);
    // The judge order is validated (EVAL_JUDGE_ROUTES) and independent judging is shown to be possible before
    // any case is shown to a candidate; for the holdout this is before its ledger is written.
    if (phases.includes("judge") || split === "holdout") {
      const judgeRefusal = judgeAvailabilityRefusal(probes, registry);
      if (judgeRefusal) throw new Error(`independent judging is not possible on gateway ${r.gatewayId}: ${judgeRefusal}`);
    }
  }

  if (split === "holdout") {
    if (!createExclusive(holdoutLedger, { run_id: runId, started_at: new Date().toISOString(), fingerprints: prints, frozen_at: readJson(frozenFile).frozen_at, cases: selected.map((c) => c.id), note: "Written before the first held-out case was shown to the candidate. Its existence is what prevents a second run." })) throw new Error("the holdout has already been run: its ledger appeared while this run was starting");
    onLedgerWritten();
  }
  console.log(`run ${runId}: ${selected.length} ${split} case(s), driver ${driver}, work directory ${work}`);

  let shardReport = [];
  const shardsFile = path.join(work, "candidate-processes.json");
  if (phases.includes("candidate")) {
    // A candidate phase starts from nothing: earlier candidate output in this directory is never consumed.
    rmSync(path.join(work, "cases"), { recursive: true, force: true });
    rmSync(path.join(work, "raw", "model-calls"), { recursive: true, force: true });
    // Judgments of earlier candidate output are stale once new output exists, and are never reused.
    rmSync(path.join(work, "judge"), { recursive: true, force: true });
    const input = candidateInput(corpus, selected, caseSplit, driver, work);
    shardReport = await candidatePhase(input, work, shards);
    writeJson(shardsFile, shardReport);
    console.log(`candidate phase finished: ${shardReport.map((s) => `shard ${s.shard} exit ${s.exitCode}`).join(", ")}`);
  } else if (existsSync(shardsFile)) shardReport = readJson(shardsFile);
  // A case whose candidate process did not exit cleanly is not run, whatever that process left behind.
  const failedShardCases = new Set(shardReport.filter((s) => s.exitCode !== 0).flatMap((s) => s.cases));
  for (const id of failedShardCases) rmSync(path.join(work, "cases", id, "candidate-run.json"), { force: true });
  // Assemble candidate files first (the judge needs them), then judge, then score.
  for (const c of selected) {
    const caseDir = path.join(work, "cases", c.id);
    if (existsSync(path.join(caseDir, "candidate-run.json"))) {
      const run = readJson(path.join(caseDir, "candidate-run.json"));
      const candidate = run.status === "ran" ? candidateFile(run, c.scenario.requested_count ?? null) : null;
      if (candidate) writeJson(path.join(caseDir, "candidate.json"), candidate);
    }
  }
  const judged = phases.includes("judge") && driver === "conversation" ? await judgePhase(selected, work, judges, probes, registry) : {};
  const results = selected.map((c) => caseResult(c, corpus, work, judged, runId, r, phases.includes("check")));
  const isolation = isolationAudit(corpus, caseSplit, work, registry);
  const bundleUnchanged = digest(treeHashes(path.join(repo, "requirements/support"))) === bundleBefore;
  // The tree is shared and edited while a run executes: the fingerprints are taken again at the end, and a run
  // whose application, harness, helpers, owner data or lockfile changed under it is not a run of the build its
  // starting fingerprints name. It is published as such, fails, and can never be frozen on.
  const printsAfter = fingerprints();
  const buildChanged = changedFingerprints(prints, printsAfter);
  // Artifacts made while the build changed describe no one build: the work directory is marked so no later run
  // (a check or judge phase over them, after the tree is restored) can consume them.
  if (buildChanged.length > 0) writeJson(manifestFile, { ...readJson(manifestFile), invalidated: buildChanged });
  const meta = {
    run_id: runId,
    split,
    driver,
    finished_at: new Date().toISOString(),
    route: { gatewayId: r.gatewayId, gatewayHost: r.host, configured: r.ready, missing: r.missing },
    inference,
    phases,
    daily_composition: "deterministic. The daily service builds its composition model from the Worker's AI binding, which local workerd does not have, and the product has no other seam for it; boards the daily service publishes in this run were composed without a model. Only the assistant's conversation calls reached the gateway.",
    probes,
    fingerprints: prints,
    fingerprints_after: printsAfter,
    build_unchanged: buildChanged.length === 0,
    build_changed_during_run: buildChanged,
    candidate_processes: shardReport,
    isolation,
    bundle_unchanged: bundleUnchanged,
    subset: subset ? subset.split(",") : null,
    ...(adapterCheck ? { note: "Adapter check: the scripted driver issued, as the owner, the command each owner sentence states, and the outcome was read from application state and receipts. No model was called, so these are not case results. Development cases only: no held-out case is run in any form before the holdout run." } : {}),
  };
  const { dest, summary } = publish(split, runId, work, results, meta);
  if (split === "holdout") writeJson(holdoutLedger, { ...readJson(holdoutLedger), finished_at: meta.finished_at, totals: summary.totals, isolation_clean: isolation.clean });
  console.log(`results: ${path.relative(repo, dest)}  passed ${summary.totals.passed}, failed ${summary.totals.failed}, not run ${summary.totals.not_run}; scripted ledger checks passed ${summary.scripted_ledger_checks.passed}, failed ${summary.scripted_ledger_checks.failed}; isolation ${isolation.clean ? "clean" : "VIOLATED"}; bundle unchanged ${bundleUnchanged}`);
  if (!isolation.clean || !bundleUnchanged || buildChanged.length > 0) process.exitCode = 1;
  if (buildChanged.length > 0) console.log(`the build changed while this run executed (${buildChanged.join(", ")}): its results do not describe one build`);
  if (adapterCheck) {
    // Per case, at the end of the output, so a failing run shows what failed where it is read first.
    const unsupported = (x) => String(x.reason ?? "").startsWith("the application cannot be put into this scenario");
    const lines = [];
    for (const s of shardReport) if (s.exitCode !== 0) lines.push(`candidate process ${s.shard} exited ${s.exitCode}; the end of its log:\n${readFileSync(path.join(work, `candidate-process-${s.shard}.log`), "utf8").split("\n").slice(-40).join("\n").slice(-4000)}`);
    for (const x of results) {
      const label = x.adapter_error ? "ADAPTER ERROR" : unsupported(x) ? "unsupported scenario (not run)" : (x.scripted_ledger_check ?? x.status);
      const open = (x.deterministic ?? []).filter((k) => k.status !== "passed");
      const detail = x.adapter_error ? `${x.reason}\n${String(x.adapter_error.stack ?? "").split("\n").filter((line) => line.includes("/evals/")).slice(0, 1).join("\n")}` : x.scripted_ledger_check === "passed" ? "" : [x.reason, ...open.map((k) => `${k.name} ${k.status}: ${typeof k.detail === "string" ? k.detail : JSON.stringify(k.detail)}`)].filter(Boolean).join("\n");
      lines.push(`${x.case_id}: ${label}${detail ? ` :: ${detail.slice(0, 700).split("\n").join(" // ")}` : ""}`);
    }
    console.log(`\n==== adapter check, per case ====\n${lines.join("\n")}`);
    const open = results.filter((x) => x.scripted_ledger_check !== "passed" && !unsupported(x));
    if (rest.includes("--strict") && (open.length > 0 || shardReport.some((s) => s.exitCode !== 0))) {
      console.log(`\nadapter check --strict: ${open.length} case(s) without a passed scripted ledger check: ${open.map((x) => x.case_id).join(", ")}`);
      process.exitCode = 1;
    }
  }
}

/**
 * Tuning is declared finished only on evidence: a published development run of all 45 cases with real
 * inference, every case accounted for and judged, a clean isolation audit, made against exactly the corpus,
 * harness, application, helpers, owner data and lockfile that are being frozen.
 */
function freeze() {
  if (existsSync(holdoutLedger)) throw new Error("the holdout has already been run");
  const prints = fingerprints();
  const registry = readRegistry(repo);
  const developmentRoot = path.join(resultsRoot, "development");
  const development = existsSync(developmentRoot) ? readdirSync(developmentRoot).sort() : [];
  const refusals = [];
  let qualifying = null;
  for (const runId of development) {
    const file = path.join(developmentRoot, runId, "summary.json");
    if (!existsSync(file)) continue;
    const s = readJson(file);
    const why = freezeRefusals(s, prints, inferenceConfiguration(registry));
    if (why.length === 0) qualifying = runId;
    else refusals.push(`${runId}: ${why.join("; ")}`);
  }
  if (!qualifying) throw new Error(`there is no complete development run of this build to freeze on. A full 45-case run with real inference, every case passed or failed, is required first.${refusals.length ? ` Runs on record: ${refusals.join(" | ")}` : " No development run is on record."}`);
  writeJson(frozenFile, { frozen_at: new Date().toISOString(), fingerprints: prints, inference: inferenceConfiguration(registry), frozen_on_development_run: qualifying, development_runs_before_freeze: development, statement: "Tuning is finished. The holdout is run against exactly these digests and this inference configuration, which are those of the named development run." });
  console.log(`frozen on ${qualifying}: ${path.relative(repo, frozenFile)}`);
}

/** Guards that need no model and no Worker. Exit 0 only when every one holds. */
async function selftest() {
  const corpus = loadCorpus();
  const checks = [];
  const check = (name, fn) => {
    try {
      checks.push({ name, status: "passed", detail: fn() ?? null });
    } catch (error) {
      checks.push({ name, status: "failed", detail: String(error?.message ?? error) });
    }
  };
  const checkAsync = async (name, fn) => {
    try {
      checks.push({ name, status: "passed", detail: (await fn()) ?? null });
    } catch (error) {
      checks.push({ name, status: "failed", detail: String(error?.message ?? error) });
    }
  };
  check("a negative result is reported before an incomplete check", () => {
    const board = [{ name: "board_structure", status: "unverified", detail: "prose only" }];
    const judged = (verdict, hard = []) => ({ status: "judged", judgment: { verdict, hard_violations: hard } });
    const expect = (got, want, label) => {
      if (got.status !== want) throw new Error(`${label}: expected ${want}, got ${got.status} (${got.reasons.join("; ")})`);
    };
    expect(caseStatus({ failed: [], incomplete: board, taste: judged("fail") }), "failed", "unverified board with a failing verdict");
    expect(caseStatus({ failed: [], incomplete: board, taste: judged("pass", ["suede in rain"]) }), "failed", "unverified board with a hard violation");
    expect(caseStatus({ failed: [], incomplete: board, taste: judged("insufficient_evidence") }), "failed", "unverified board with insufficient evidence");
    expect(caseStatus({ failed: [{ name: "x", status: "failed" }], incomplete: board, taste: { status: "not_run", reason: "no judge" } }), "failed", "failed check with an incomplete one");
    expect(caseStatus({ failed: [], incomplete: board, taste: judged("pass") }), "not_run", "unverified board with a passing verdict");
    expect(caseStatus({ failed: [], incomplete: [], taste: { status: "not_run", reason: "no judge" } }), "not_run", "complete checks without a judgment");
    expect(caseStatus({ failed: [], incomplete: [], taste: judged("pass") }), "passed", "complete checks with a passing verdict");
  });
  const must = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const work = path.join(os.tmpdir(), "garderobe-evals", `selftest-${process.pid}`);
  const before = digest(treeHashes(path.join(repo, "requirements/support")));
  for (const split of ["development", "holdout"]) {
    check(`candidate input of the ${split} split holds only identifier, request, scenario and world`, () => {
      const input = candidateInput(corpus, corpus.cases.filter((c) => c.split === split), split, "conversation", work);
      const other = corpus.cases.filter((c) => c.split !== split);
      const text = JSON.stringify(input.cases);
      for (const c of input.cases) must(Object.keys(c).sort().join() === "id,request,scenario,world", `${c.id} has fields ${Object.keys(c)}`);
      for (const c of corpus.cases) for (const criterion of c.judge_criteria) must(!text.includes(JSON.stringify(criterion).slice(1, -1)), `a judge criterion of ${c.id} is in the ${split} candidate input`);
      for (const c of other) must(!input.cases.some((x) => x.id === c.id), `${c.id} of the other split is in the ${split} candidate input`);
      for (const key of assertionKeys(corpus)) must(!text.includes(key), `state assertion key ${key} is in the candidate input`);
      return `${input.cases.length} cases`;
    });
  }
  check("a case of the other split cannot be put into a candidate input", () => {
    let refused = false;
    try {
      candidateInput(corpus, [corpus.cases.find((c) => c.split === "holdout")], "development", "conversation", work);
    } catch {
      refused = true;
    }
    must(refused, "a held-out case was accepted into a development input");
  });
  check("the adapter check and freeze cannot reach a held-out case or skip the development run", () => {
    const assertionIds = Object.keys(corpus.assertions);
    const held = corpus.cases.filter((c) => c.split === "holdout").map((c) => c.id);
    const all = corpus.cases.map((c) => c.id).join(",");
    for (const subset of [null, all, held.join(",")]) {
      const { caseSplit, selected } = selectCases(corpus.cases, assertionIds, "adapter-check", true, subset);
      must(caseSplit === "development", "the adapter check is not limited to development cases");
      must(selected.every((c) => c.split === "development" && assertionIds.includes(c.id)), `the adapter check selected ${selected.filter((c) => c.split !== "development").map((c) => c.id).join(", ")} with subset ${subset ? "given" : "none"}`);
    }
    must(selectCases(corpus.cases, assertionIds, "development", false, held.join(",")).selected.length === 0, "a development run selected a held-out case");
    must(selectCases(corpus.cases, assertionIds, "holdout", false, null).selected.length === held.length, "the holdout does not select every held-out case");
    const inference = { gatewayId: "g" };
    must(freezeRefusals({}, fingerprints(), inference).length > 0, "freeze accepted a summary of no run");
    must(freezeRefusals({ driver: "scripted_commands", phases: ["candidate", "check"], totals: { cases: 13, not_run: 13 }, cases: [], candidate_processes: [{ shard: 0, exitCode: 0 }], inference, isolation: { clean: true }, bundle_unchanged: true, fingerprints: fingerprints() }, fingerprints(), inference).length > 0, "freeze accepted an adapter check in place of a development run");
  });
  check("phase names are validated, and without the check phase no deterministic check runs or passes", () => {
    must(phaseRefusal(["candidate", "check", "judge"]) === null, "the three phases were refused");
    must(phaseRefusal(["check", "judge"]) === null, "a later pass over earlier candidate output was refused");
    for (const bad of [["candidate", "chek"], [], [""], ["judge", "judge"]]) must(phaseRefusal(bad) !== null, `phases ${JSON.stringify(bad)} were accepted`);
    const c = corpus.cases.find((x) => x.split === "development" && x.id in corpus.assertions);
    const dir = path.join(work, "phase-selftest");
    mkdirSync(path.join(dir, "cases", c.id), { recursive: true });
    writeJson(path.join(dir, "cases", c.id, "candidate-run.json"), { status: "ran", driver_mode: "conversation", world: worldOf(c, corpus), wardrobe_before: [], wardrobe_after: [], observation: null, visible: { state: "completed", reply: "" } });
    const result = caseResult(c, corpus, dir, {}, "selftest", { gatewayId: "g" }, false);
    must(result.deterministic.length === 1 && result.deterministic[0].name === "deterministic_checks" && result.deterministic[0].status === "not_run", `without the check phase the deterministic checks were ${JSON.stringify(result.deterministic.map((k) => k.name))}`);
    must(result.status !== "passed", "a case passed without its check phase");
  });
  check("the model routes are read from the application's registry, and the conversation task has candidates", () => {
    const registry = readRegistry(repo);
    must(registry.conversationCandidates.length > 0 && registry.conversationCandidates.every((id) => registry.profiles.find((p) => p.profileId === id)?.gatewayRoute), "a conversation candidate has no gateway route");
    const source = ["run.mjs", "src/node/gateway.mjs", "src/node/judge.mjs", "src/node/outbound.ts", "src/worker-entry.ts", "src/kit.ts"].map((f) => readFileSync(path.join(here, f), "utf8")).join("\n");
    for (const p of registry.profiles) for (const name of [p.gatewayRoute, p.apiModelId]) must(!name || !source.includes(name), `the harness source names the model ${name} instead of reading it from the registry`);
    must(!/PROVIDER_KEY_[A-Z]/.test(source.replace(/PROVIDER_KEY_\*/g, "").replace(/PROVIDER_KEY_\[A-Z\]/g, "")), "the harness reads a provider key");
    const synthetic = syntheticRegistry();
    must(synthetic.conversationCandidates.join() === "sp-a,sp-b,sp-c" && synthetic.profiles.find((p) => p.profileId === "sp-a")?.gatewayRoute === "selftest/route-a", `string constants in the registry were not resolved (${JSON.stringify(synthetic)})`);
    let refused = false;
    try {
      parseRegistry(`const X = 1;\n{ profileId: "p", apiModelId: "m", gatewayRoute: UNKNOWN_ROUTE }\nconversation: { candidates: ["p"] }`);
    } catch {
      refused = true;
    }
    must(refused, "a route naming no string constant was accepted");
    const distinct = new Set(registry.profiles.map((p) => p.gatewayRoute).filter(Boolean));
    return `conversation candidates: ${registry.conversationCandidates.join(", ")}; distinct gateway routes: ${distinct.size}`;
  });
  check("the judge is never given a route that answered the candidate", () => {
    for (const registry of [syntheticRegistry(), readRegistry(repo)]) {
      const routes = [...new Set(registry.profiles.map((p) => p.gatewayRoute).filter(Boolean))];
      const probes = { profiles: routes.map((gatewayRoute) => ({ gatewayRoute, operations: { text: { result: "passed" } } })) };
      for (const used of routes) must(judgeRouteFor([used], probes, registry) !== used, `the judge was given ${used}, which answered the candidate`);
      must(judgeRouteFor(routes, probes, registry) === null, "a judge route was chosen although every route answered the candidate");
    }
  });
  check("the world of every case follows the rule", () => {
    const worlds = corpus.cases.map((c) => worldOf(c, corpus));
    return `owner_real_stock ${worlds.filter((w) => w === "owner_real_stock").length}, synthetic_fixture ${worlds.filter((w) => w === "synthetic_fixture").length}`;
  });
  check("the judge process refuses to start without a route and reads only its packet", () => {
    const dir = path.join(work, "judge-selftest");
    mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "packet.json"), { case_id: "SELFTEST", instructions: "none", candidate_id: "anonymous-A" });
    const run = spawnSync(process.execPath, [path.join(here, "src/node/judge.mjs"), path.join(dir, "packet.json"), path.join(dir, "out.json"), path.join(dir, "log.json")], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    must(run.status === 4, `expected exit 4 without a route, got ${run.status}`);
    const source = readFileSync(path.join(here, "src/node/judge.mjs"), "utf8");
    must(!/cases\.json|state-assertions|raw\/|model-calls/.test(source), "the judge source names candidate-side or corpus files");
  });
  check("the candidate-side sources name no judging material", () => {
    for (const [file] of Object.entries(treeHashes(path.join(here, "src")))) {
      if (file.startsWith("node/judge")) continue;
      const source = readFileSync(path.join(here, "src", file), "utf8");
      must(!/cases\.json|judge_criteria|evidence\.json|judge\.md/.test(source), `src/${file} names judging material`);
      for (const c of corpus.cases) for (const criterion of c.judge_criteria) must(!source.includes(criterion), `src/${file} contains a judge criterion of ${c.id}`);
    }
  });
  check("the holdout guard refuses a second run, a subset, chosen phases and a run without the real model route", () => {
    const ok = { ledgerExists: false, subset: null, phasesGiven: false, driver: "conversation", ready: true };
    must(holdoutRefusal(ok) === null, "a complete, configured first holdout was refused");
    must(holdoutRefusal({ ...ok, ledgerExists: true }) !== null, "a second holdout run was accepted");
    must(holdoutRefusal({ ...ok, subset: "H001" }) !== null, "a holdout subset was accepted");
    must(holdoutRefusal({ ...ok, phasesGiven: true }) !== null, "a holdout with chosen phases was accepted");
    must(holdoutRefusal({ ...ok, driver: "scripted_commands" }) !== null, "a scripted holdout was accepted");
    must(holdoutRefusal({ ...ok, ready: false, missing: ["CF_AIG_TOKEN"] }) !== null, "a holdout without the model route was accepted");
    return existsSync(holdoutLedger) ? "the holdout ledger exists: the holdout has been run" : "the holdout has not been run";
  });
  check("the holdout ledger and lock are created exclusively, so a concurrent second start is refused", () => {
    const file = path.join(work, "exclusive-selftest", "LEDGER.json");
    must(createExclusive(file, { first: true }) === true, "the first create failed");
    must(createExclusive(file, { second: true }) === false, "a second create succeeded");
    must(readJson(file).first === true, "the second create overwrote the first");
  });
  check("a reused work directory must match the current build, configuration and cases exactly", () => {
    const manifest = { split: "development", driver: "conversation", fingerprints: { harness: "a" }, inference: { gatewayId: "g", gatewayEndpointSha256: "e1" }, gatewayId: "g", cases: ["H001"] };
    must(workDirectoryRefusal({ recorded: null, manifest, phases: ["candidate", "check", "judge"], hasArtifacts: false }) === null, "a fresh directory was refused");
    must(workDirectoryRefusal({ recorded: manifest, manifest, phases: ["check", "judge"], hasArtifacts: true }) === null, "a matching directory was refused");
    must(workDirectoryRefusal({ recorded: { ...manifest, fingerprints: { harness: "b" } }, manifest, phases: ["check", "judge"], hasArtifacts: true }) !== null, "a directory of another build was accepted");
    must(workDirectoryRefusal({ recorded: { ...manifest, inference: { gatewayId: "g", gatewayEndpointSha256: "e2" } }, manifest, phases: ["check", "judge"], hasArtifacts: true }) !== null, "a directory of another gateway account was accepted");
    must(workDirectoryRefusal({ recorded: null, manifest, phases: ["check", "judge"], hasArtifacts: true }) !== null, "an unrecorded directory was accepted without the candidate phase");
    must(workDirectoryRefusal({ recorded: null, manifest, phases: ["candidate"], hasArtifacts: true }) !== null, "an unrecorded directory with artifacts was accepted");
    must(workDirectoryRefusal({ recorded: { ...manifest, invalidated: ["application"] }, manifest, phases: ["check"], hasArtifacts: true }) !== null, "a work directory whose run saw the build change was reused");
    must(workDirectoryRefusal({ recorded: { ...manifest, invalidated: ["application"] }, manifest, phases: ["candidate"], hasArtifacts: true }) !== null, "a work directory whose run saw the build change was reused for a new candidate phase");
  });
  check("freeze accepts only a complete, judged, clean development run of this build and configuration", () => {
    const prints = fingerprints();
    const inference = { gatewayId: "g", gatewayEndpointSha256: "e1", conversationCandidates: ["x"], judgeRouteOrder: "o" };
    const cases = Array.from({ length: 45 }, (_, i) => ({ case_id: `C${i}`, status: "passed", verdict: "pass" }));
    const good = { driver: "conversation", subset: null, phases: ["candidate", "check", "judge"], totals: { cases: 45, passed: 45, failed: 0, not_run: 0 }, cases, candidate_processes: [{ shard: 0, exitCode: 0 }], inference, isolation: { clean: true }, bundle_unchanged: true, build_unchanged: true, build_changed_during_run: [], fingerprints: prints };
    must(freezeRefusals(good, prints, inference).length === 0, `a qualifying run was refused: ${freezeRefusals(good, prints, inference).join("; ")}`);
    const failedUnjudged = { ...good, totals: { cases: 45, passed: 44, failed: 1, not_run: 0 }, cases: cases.map((x, i) => (i === 0 ? { ...x, status: "failed", verdict: null } : x)) };
    must(freezeRefusals(failedUnjudged, prints, inference).some((w) => w.startsWith("not every case was judged")), "a deterministic failure stood in for judging");
    must(freezeRefusals(good, prints, { ...inference, gatewayEndpointSha256: "e2" }).length > 0, "another gateway account was accepted");
    must(freezeRefusals(good, prints, { ...inference, judgeRouteOrder: "other" }).length > 0, "another judge route order was accepted");
    must(freezeRefusals({ ...good, phases: ["check", "judge"] }, prints, inference).length > 0, "a run without its own candidate phase was accepted");
    must(freezeRefusals({ ...good, candidate_processes: [{ shard: 0, exitCode: 1 }] }, prints, inference).length > 0, "a run with a failed candidate process was accepted");
    must(freezeRefusals({ ...good, fingerprints: { ...prints, application: "other" } }, prints, inference).length > 0, "a run of another application was accepted");
    must(freezeRefusals({ ...good, build_unchanged: false, build_changed_during_run: ["application"] }, prints, inference).some((w) => w.includes("changed while it ran")), "a run whose application changed while it ran was accepted");
    const { build_unchanged: _dropped, ...unrecorded } = good;
    must(freezeRefusals(unrecorded, prints, inference).some((w) => w.includes("changed while it ran")), "a run that did not recheck its build was accepted");
  });
  check("the build is fingerprinted again after a run, and any change is named", () => {
    const before = fingerprints();
    must(changedFingerprints(before, fingerprints()).length === 0, "two readings of an unchanged tree differ");
    must(changedFingerprints(before, { ...before, harness: "x", lockfile: "y" }).join() === "harness,lockfile", "changed fingerprints were not named");
  });
  check("B001, B006, B007: a question asked only in a completed reply counts", () => {
    must(ownerQuestions({ replyText: "Recorded. Did you also wear the moss shirt on Wednesday?" }).total === 1, "a completed reply's question with no proposal or pending input was not counted");
    must(ownerQuestions({ turnAsked: 1, replyText: "Which shirt did you mean?" }).total === 1, "the turn's own question was counted twice with its reply");
    must(ownerQuestions({ proposals: 1, otherRunsWaiting: 1, replyText: "Noted." }).total === 2, "structured requests were not counted");
    must(ownerQuestions({ replyText: "Recorded: the moss shirt was worn yesterday and washed this morning." }).total === 0, "a statement was counted as a question");
    must(ownerQuestions({ replyText: "Please confirm whether you wore yesterday's outfit." }).total === 1, "a request to confirm without a question mark was not counted");
    must(ownerQuestions({ replyText: "Recorded.", runsUncertain: true }).total === null, "zero questions were reported although an older waiting run could hide a new one");
    must(ownerQuestions({ replyText: "Did you wear it Monday?", runsUncertain: true }).total === 1, "a question in the reply was lost when the run count was uncertain");
  });
  check("questions formatted with Markdown or quotation marks are found", () => {
    must(questionsIn("**Did you wear the moss shirt today?**").length === 1, "a bold question was missed");
    must(questionsIn("\u201cDid you wear this?\u201d").length === 1, "a quoted question was missed");
    must(questionsIn("Noted. _Which day was it?_ Thanks.").length === 1, "an emphasised question inside a reply was missed");
    must(questionsIn("- **Was it Monday?**\n- `Or Tuesday?`").length === 2, "formatted bulleted questions were missed");
    must(questionsIn("**Recorded.**").length === 0, "a formatted statement was taken for a question");
  });
  check("rule helpers are safe with global expressions and single-use iterables", () => {
    const asked = requestsInReply([], "Did you wear it Monday? Did you wear it Tuesday?", /wear/g);
    must(asked.matching.length === 2 && asked.other.length === 0, `a global topic expression skipped or double-classified questions (${JSON.stringify(asked)})`);
    const a = "a".repeat(64);
    const once = (function* () {
      yield "records/wear.json";
      yield "manifest.json";
    })();
    must(checksumCoverage(`${a}  records/wear.json\n`, once).failures.some((f) => f.includes("manifest.json")), "a missing file passed when the required files came from a single-use iterator");
  });
  check("a work directory is held by one run at a time", () => {
    const lock = path.join(work, "work-lock-selftest", ".IN-USE");
    must(createExclusive(lock, { run: 1 }) === true, "the first run could not take the work directory");
    must(createExclusive(lock, { run: 2 }) === false, "a second run took a work directory in use");
  });
  check("the judge's wardrobe listing carries the identifiers the candidate's options use", () => {
    const g = { garmentId: "g_1", name: "Navy oxford", category: "shirt", roles: ["top"], acquisition: "owned", balances: [{ bucket: "clean", quantity: 1 }], attributes: {} };
    const real = applicationEvidence({ world: "owner_real_stock", wardrobe_before: [g], today: "2026-10-12" }).wardrobe_before_request[0];
    must(real.garment_id === "g_1", "a real-stock garment has no garment_id");
    const options = candidateFile({ visible: { reply: "x", options: [{ optionId: "a", garments: [{ garmentId: "g_1" }] }], receipts: [], requests_to_confirm: [], question_asked: null, state: "completed" }, fixture_ids: {} })?.options ?? [];
    must(options[0]?.garment_ids?.[0] === real.garment_id, "the candidate's option and the judge's listing name the garment differently");
    const fixture = applicationEvidence({ world: "synthetic_fixture", wardrobe_before: [{ ...g, fixtureId: "shirt-navy" }], today: "2026-10-12" }).wardrobe_before_request[0];
    must(fixture.garment_id === "shirt-navy", "a fixture garment is not listed by its fixture id");
  });
  check("the holdout cannot start unless independent judging is possible and the judge order is valid", () => {
    const live = readRegistry(repo);
    const liveRoutes = [...new Set(live.profiles.map((p) => p.gatewayRoute).filter(Boolean))];
    const registry = syntheticRegistry();
    const routes = registry.profiles.map((p) => p.gatewayRoute).filter(Boolean);
    must(routes.length >= 2, "the synthetic registry has fewer than two routes");
    const probe = (route, text, tools) => ({ gatewayRoute: route, operations: { text: { result: text ? "passed" : "failed" }, tools: { result: tools ? "passed" : "failed" } } });
    const saved = process.env.EVAL_JUDGE_ROUTES;
    try {
      delete process.env.EVAL_JUDGE_ROUTES;
      const order = judgeRouteOrder(registry);
      const candidates = conversationRoutes(registry);
      const everyRoute = { profiles: routes.map((x) => probe(x, true, true)) };
      // Every route answers and nothing is kept for the judge: every judge route is a usable candidate route.
      must(judgeAvailabilityRefusal(everyRoute, registry) !== null, "judging was accepted although every answering judge route is a usable candidate route");
      must(judgeAvailabilityRefusal({ profiles: [probe(routes[0], true, true), probe(routes[1], true, true), ...routes.slice(2).map((x) => probe(x, false, false))] }, registry) !== null, "two answering routes that are both usable candidate routes were accepted");
      // With one route kept for the judge, judging is guaranteed and the candidate cannot use that route.
      const kept = reserveJudgeRoute(everyRoute, order, candidates);
      must(kept === order[0], `the judge route kept was ${kept}, not the first of the judge order (${order[0]})`);
      const reserved = { ...everyRoute, reservedForJudging: [kept] };
      must(judgeAvailabilityRefusal(reserved, registry) === null, `judging was refused with a route kept for the judge: ${judgeAvailabilityRefusal(reserved, registry)}`);
      must(!candidateRoutes(reserved, candidates).includes(kept) && candidateRoutes(reserved).length === routes.length - 1, "the route kept for the judge is still a candidate route");
      // A route that answers text but not tools is not a candidate route, so it can judge.
      const textOnly = { profiles: routes.map((x) => probe(x, true, x !== order[0])) };
      must(judgeAvailabilityRefusal(textOnly, registry) === null, "a text-only route outside the candidate routes was not accepted as a judge");
      // Only one route answers: it cannot be both kept for the judge and left for the candidate.
      const single = { profiles: [probe(routes[0], true, true), ...routes.slice(1).map((x) => probe(x, false, false))] };
      must(reserveJudgeRoute(single, order, candidates) === null, "the only answering route was kept for the judge, leaving the candidate none");
      must(judgeAvailabilityRefusal(single, registry) !== null, "one route that answers both candidate and judge was accepted");
      must(judgeAvailabilityRefusal({ profiles: routes.map((x) => probe(x, false, false)) }, registry) !== null, "no answering judge route was accepted");
      // A route outside the conversation task never counts as a candidate route.
      must(candidateRoutes(everyRoute, []).length === 0, "a route outside the conversation candidates was counted as a candidate route");
      process.env.EVAL_JUDGE_ROUTES = "no-such/route";
      let refused = false;
      try {
        judgeRouteOrder(registry);
      } catch {
        refused = true;
      }
      must(refused, "an EVAL_JUDGE_ROUTES naming no registry route was accepted");
      delete process.env.EVAL_JUDGE_ROUTES;
      // The application's own registry: with a single distinct route, independent judging is impossible and the holdout is refused.
      const liveAll = { profiles: live.profiles.filter((p) => p.gatewayRoute).map((p) => probe(p.gatewayRoute, true, true)) };
      const liveKept = reserveJudgeRoute(liveAll, judgeRouteOrder(live), conversationRoutes(live));
      const liveRefusal = judgeAvailabilityRefusal(liveKept ? { ...liveAll, reservedForJudging: [liveKept] } : liveAll, live);
      if (liveRoutes.length < 2) must(liveRefusal !== null, "the application's registry has one distinct route, yet independent judging was accepted");
      return `application registry: ${liveRoutes.length} distinct route(s); independent judging ${liveRefusal === null ? "possible" : `refused (${liveRefusal})`}`;
    } finally {
      if (saved === undefined) delete process.env.EVAL_JUDGE_ROUTES;
      else process.env.EVAL_JUDGE_ROUTES = saved;
    }
  });
  check("an answer of structured options alone counts as a visible answer to judge", () => {
    const boardOnly = { visible: { reply: "", options: [], board: { options: [{ optionId: "b1", garments: [{ garmentId: "g_1" }, { garmentId: "g_2" }] }] }, receipts: [], requests_to_confirm: [], question_asked: null, state: "completed" }, fixture_ids: {} };
    const extracted = candidateFile(boardOnly, 1);
    must(extracted?.options.length === 1 && extracted.options[0].garment_ids.join() === "g_1,g_2", `a board-only answer reached the judge without its outfits (${JSON.stringify(extracted?.options)})`);
    const both = candidateFile({ ...boardOnly, visible: { ...boardOnly.visible, options: boardOnly.visible.board.options } }, 1);
    must(both?.options.length === 1, "an option carried both on the result and on the board was counted twice");
    must(hasVisibleAnswer({ reply: "", options: [{ optionId: "a" }], receipts: [], requests_to_confirm: [] }), "an options-only answer was not judged");
    must(hasVisibleAnswer({ reply: "", board: { options: [{}] } }), "a board-only answer was not judged");
    must(hasVisibleAnswer({ reply: "", question_asked: { prompt: "which day?" } }), "a question-only answer was not judged");
    must(!hasVisibleAnswer({ reply: "", options: [], receipts: [], requests_to_confirm: [], board: null, question_asked: null }), "an empty answer was treated as visible");
    const created = applicationEvidence({ world: "owner_real_stock", wardrobe_before: [], wardrobe_after: [{ garmentId: "g_new", name: "New coat", category: "coat", roles: ["outer"], acquisition: "owned", balances: [], attributes: {} }], today: "2026-10-12" }).garments_created_during_request;
    must(created.length === 1 && created[0].garment_id === "g_new", "a garment created during the request is not shown to the judge");
  });
  check("B011: an approval question asked only in the reply counts as a repair approval question", () => {
    const asked = repairApprovalQuestions([], "Noted, the gold shirt is worn today. Should I replace it in tomorrow's outfit?");
    must(asked.count === 1, `a completed reply asking for repair approval, with no proposal or pending input, counted ${asked.count}`);
    must(repairApprovalQuestions([], "Recorded: the gold shirt is worn today. Tomorrow's outfit now uses the white oxford.").count === 0, "a reply that asks nothing counted a question");
    must(repairApprovalQuestions([{ keys: ["proposal:p1"], texts: ["Replace the gold shirt in tomorrow's outfit"] }], "Done.").count === 1, "a structured request was not counted");
    must(repairApprovalQuestions([], "Anything else today?").count === null, "an unclassifiable question was reported as no approval question");
  });
  check("B011, B018: one confirmation request shown in several forms counts once, by identity and wording", () => {
    const proposal = { proposalId: "p1", type: "wear.record", summary: "Did you wear the navy oxford on Tuesday?" };
    const pending = { inputId: "in_1", question: "Did you wear the navy oxford on Tuesday?", choices: [], actionId: "act_1" };
    const reply = "Welcome back. **Did you wear the navy oxford on Tuesday?**";
    // The same ask as a proposal, the pending input, a repair line and a reply question.
    const b011 = repairApprovalQuestions([proposalForm({ proposalId: "p9", summary: "Replace the gold shirt in tomorrow's outfit with the white oxford" }), pendingInputForm({ inputId: "in_9", question: "Should I replace the gold shirt in tomorrow's outfit with the white oxford?", actionId: null }), { keys: [], texts: ["Replace the gold shirt in tomorrow's outfit with the white oxford?"] }], "Should I replace the gold shirt in tomorrow's outfit with the white oxford?");
    must(b011.count === 1, `one repair approval in four forms counted ${b011.count}`);
    const b018 = wearConfirmationTasks({ proposals: [proposal], pendingInput: pending, replyText: reply });
    must(b018.count === 1, `one wear request as a proposal, the pending input and a reply question counted ${b018.count}`);
    must(wearConfirmationRequests([proposalForm(proposal), pendingInputForm(pending)], reply).count === 1, "wearConfirmationRequests counted one ask twice");
    // Shared identity links forms whose wording differs.
    must(distinctRequests([{ keys: ["action:act_1"], texts: ["Confirm Tuesday"] }, { keys: ["action:act_1"], texts: ["Which outfit did you wear?"] }]).count === 1, "two forms with the same action identity counted twice");
    // Two different asks stay two.
    must(wearConfirmationTasks({ proposals: [proposal], replyText: "Did you wear the chinos on Monday?" }).count === 2, "two different wear requests were merged");
    must(distinctRequests([{ keys: ["proposal:a"], texts: ["Did you wear it?"] }, { keys: ["proposal:b"], texts: ["Did you wear it on Monday?"] }]).count === 2, "short wording contained in another merged two proposals");
  });
  check("B018: a wear-confirmation request asked only in the reply counts", () => {
    const asked = wearConfirmationRequests([], "Welcome back. Did you wear anything from the wardrobe while you were away?");
    must(asked.count === 1, `a reply asking to confirm missed wears counted ${asked.count}`);
    must(wearConfirmationRequests([], "Welcome back. Today's board is ready.").count === 0, "a reply that asks nothing counted a request");
    must(wearConfirmationRequests([{ keys: ["input:i1"], texts: ["Can you confirm what you wore on Tuesday?"] }], "Can you confirm what you wore on Tuesday?").count === 1, "one request shown both as a structured request and in the reply was counted twice");
    must(wearConfirmationRequests([{ keys: ["proposal:p1"], texts: ["Did you wear the oxford on Monday?"] }], "Did you wear the oxford on Monday? Did you wear the chinos on Tuesday?").count === 2, "a second reply request was not counted beside a structured one");
  });
  check("B020: credentials that could not be seeded leave the outcome unobserved, not passed", () => {
    const unseeded = credentialOutcome([], ["a connection holding a secret key could not be added: 400"]);
    must(unseeded.value === null && typeof unseeded.reason === "string" && unseeded.reason.length > 0, `a clean export without the seeded connection secret was reported as ${unseeded.value}`);
    must(credentialOutcome([], ["a connected assistant could not be added: 500"]).value === null, "a clean export without the connected assistant was reported as observed");
    must(credentialOutcome(["the recovery code in records/x.json"], ["a connected assistant could not be added"]).value === true, "a leak was not reported when seeding was partial");
    must(credentialOutcome([], []).value === false, "a clean export with every credential seeded was not reported as clean");
    must(credentialOutcome(null, []).value === null && credentialOutcome(undefined, []).value === null, "a missing leak-search result was reported as a clean search");
  });
  check("B020: an import counts only when its report says it completed; zero writes without one prove nothing", () => {
    const quiet = { sourceQuiet: true, writesBefore: 4, writesAfter: 4 };
    const failedReport = importOutcome({ status: 200, report: { state: "failed", error: "records/wears.json: unknown table", externalEffectsReplayed: 0 }, ...quiet });
    must(!failedReport.done && failedReport.replayed === null, `an HTTP 200 import whose report failed was counted (${JSON.stringify(failedReport)})`);
    must(importOutcome({ status: 200, report: { state: "running" }, ...quiet }).replayed === null, "an unfinished import passed the no-replay check");
    must(importOutcome({ status: 200, report: { state: "completed", error: "partial" }, ...quiet }).replayed === null, "a completed import carrying an error passed");
    must(importOutcome({ status: 200, report: null, ...quiet }).replayed === null, "an unreadable import report passed");
    must(importOutcome({ status: 409, report: null, ...quiet }).replayed === null, "a refused import passed");
    must(importOutcome({ status: 200, report: { state: "completed", externalEffectsReplayed: 0 }, ...quiet, sourceQuiet: false }).replayed === null, "a done import into a busy source account was measured");
    must(importOutcome({ status: 200, report: { state: "completed", externalEffectsReplayed: 0 }, ...quiet }).replayed === 0, "a done import with no writes was not measured as zero replays");
    must(importOutcome({ status: 200, report: { state: "completed", externalEffectsReplayed: 1 }, sourceQuiet: true, writesBefore: 4, writesAfter: 6 }).replayed === 3, "replays were not counted");
  });
  check("B020: only an export this request produced is evaluated", () => {
    const older = { exportId: "exp_old", complete: true, requestedAt: "2026-10-11T08:00:00Z" };
    const fresh = { exportId: "exp_new", complete: false, requestedAt: "2026-10-12T08:00:00Z" };
    must(exportOfRequest([older], ["exp_old"]) === null, "an older complete package stood in for an export the request never produced");
    must(exportOfRequest([older, fresh], ["exp_old"]) === "exp_new", "the request's own (unfinished) export was not chosen over the older complete one");
    must(exportOfRequest([older, fresh, { exportId: "exp_done", complete: true, requestedAt: "2026-10-12T07:00:00Z" }], ["exp_old"]) === "exp_done", "a finished export of the request was not preferred");
    must(exportOfRequest([older], ["exp_old"], "exp_followed") === "exp_followed", "the export the scripted step followed was not used");
    must(exportOfRequest([older], undefined) === null && exportOfRequest([older], null) === null, "without the seed's baseline an older export was chosen");
  });
  check("B017: only real multiple questions make a questionnaire", () => {
    must(questionnaireOutcome({ replyQuestions: ["Which train?", "Which layer?"] }).value === true, "two questions in the reply were not a questionnaire");
    must(questionnaireOutcome({ replyQuestions: ["Which train?"], pendingInput: { prompt: "Which layer felt warm?" } }).value === true, "a reply question plus a pending question were not a questionnaire");
    must(questionnaireOutcome({ replyQuestions: [], pendingInput: { prompt: "Which train was it?" } }).value === null, "a single pending clarification was taken for a questionnaire");
    must(questionnaireOutcome({ replyQuestions: ["Which train?"] }).value === null, "a single reply question was not left unobserved");
    must(questionnaireOutcome({ replyQuestions: [], proposals: 1 }).value === null, "an unrelated proposal was taken for a questionnaire");
    must(questionnaireOutcome({ replyQuestions: [], unprompted: 1 }).value === null, "an application-started message was taken for a questionnaire");
    must(questionnaireOutcome({ replyQuestions: [] }).value === false, "asking nothing was not reported as no questionnaire");
  });
  check("B018: only proposals and inputs about missed wears count as wear-confirmation tasks", () => {
    const deadline = { proposalId: "p1", type: "return.update_deadline", summary: "Confirm the return deadline for the boots" };
    const wear = { proposalId: "p2", type: "wear.record", summary: "Did you wear the navy oxford on Tuesday?" };
    must(wearConfirmationTasks({ proposals: [deadline] }).count === 0, "a return-deadline proposal was counted as a wear-confirmation task");
    must(wearConfirmationTasks({ proposals: [deadline, wear] }).count === 1, "a missed-wear proposal was not counted, or the deadline one was");
    must(wearConfirmationTasks({ pendingInput: { prompt: "Which return should I extend?" } }).count === 0, "an unrelated clarification was counted");
    must(wearConfirmationTasks({ pendingInput: { prompt: "What did you wear while the service was paused?" } }).count === 1, "a pending input about missed wears was not counted");
    must(wearConfirmationTasks({ proposals: [deadline], unclassified: 1 }).count === null, "an unclassifiable waiting run was reported as no task");
    must(wearConfirmationTasks({ replyText: "Welcome back. Did you wear anything while you were away?" }).count === 1, "a reply question about wears was not counted");
    const opaque = wearConfirmationTasks({ pendingInput: { kind: "choice" } });
    must(opaque.count === null && opaque.pending_input_about_wears === null, `pending input with no readable text was taken as not about wears (${JSON.stringify(opaque)})`);
    must(wearConfirmationTasks({ pendingInput: { kind: "choice" }, proposals: [wear] }).count === null, "an unreadable pending input beside a wear proposal was taken as no second request");
    const unreadable = wearConfirmationTasks({ proposals: [{ proposalId: "p3" }] });
    must(unreadable.count === null && unreadable.unreadable_proposals.length === 1, `a proposal with no readable topic established that no wear confirmation was asked (${JSON.stringify(unreadable)})`);
    must(wearConfirmationTasks({ proposals: [{ proposalId: "p3" }, wear] }).count === null, "an unreadable proposal beside a wear proposal was taken as no second request");
    const once = wearConfirmationTasks({ proposals: [wear], pendingInput: { prompt: "Did you wear the navy oxford on Tuesday?" }, replyText: "Did you wear the navy oxford on Tuesday?" });
    must(once.count === 1, `one wear request shown as a proposal, the pending input and the reply was counted ${once.count} times`);
  });
  check("B017: one clarification both pending and repeated in the reply is one question", () => {
    must(questionnaireOutcome({ replyQuestions: ["Which train was it?"], pendingInput: { prompt: "Which train was it?" } }).value === null, "the same clarification in the reply and in pending input made a questionnaire");
    must(questionnaireOutcome({ replyQuestions: ["Which train was it?"], pendingInput: { kind: "text" } }).value === null, "an unreadable pending question was added to the reply's single question");
    must(questionnaireOutcome({ replyQuestions: ["Which train was it?", "Which layer?"], pendingInput: { prompt: "Which train was it?" } }).value === true, "two distinct questions were not a questionnaire");
  });
  check("every option of a source reaches the candidate file; only a mirrored source is taken once", () => {
    const visible = (options, board) => ({ visible: { reply: "", options, board: board ? { options: board } : null, receipts: [], requests_to_confirm: [], question_asked: null, state: "completed" }, fixture_ids: {} });
    const a = { optionId: "a", garments: [{ garmentId: "g1" }, { garmentId: "g2" }] };
    const repeated = candidateFile(visible([a, a]), 2);
    must(repeated.options.length === 2, "an option repeated within one result was merged away");
    const malformed = candidateFile(visible([a, { optionId: "b", garments: [] }]), 2);
    must(malformed.options.length === 2 && malformed.options[1].garment_ids.length === 0, "an option with no garments was dropped");
    must(candidateFile(visible([a], [a]), 1).options.length === 1, "a result mirroring its board was counted twice");
    must(candidateFile(visible([a], [{ ...a, optionId: "c" }]), 2).options.length === 2, "a board that differs from the result was merged into it");
  });
  check("the number of outfits asked for reaches the application with the request", () => {
    const stated = ownerScenario({ task: "board", requested_count: 3, peak_c: 18 });
    must(stated["outfits asked for"] === 3, `the requested count was dropped from what the owner says (${JSON.stringify(stated)})`);
    must(!("task" in stated), "the corpus's internal task label reached the application");
    must(stated.peak_c === 18, "another scenario fact was dropped");
    const c = corpus.cases.find((k) => typeof k.scenario?.requested_count === "number");
    if (c) must(ownerScenario(c.scenario)["outfits asked for"] === c.scenario.requested_count, `case ${c.id}: its requested count does not reach the application`);
  });
  check("footwear alternatives reach the judge's packet", () => {
    const c = corpus.cases.find((k) => k.split === "development");
    const run = { world: "owner_real_stock", today: "2026-10-12", visible: { reply: "Two looks.", board: { options: [{ optionId: "a", garments: [{ garmentId: "g_top" }, { garmentId: "g_sneaker" }], footwearAlternatives: [{ garmentId: "g_loafer" }], reason: "easy" }] }, receipts: [], requests_to_confirm: [], question_asked: null, state: "completed" }, fixture_ids: {}, wardrobe_before: [], wardrobe_after: [] };
    const file = path.join(work, "judge-alternatives", "candidate.json");
    writeJson(file, candidateFile(run, 1));
    const packet = judgePacket(c, run, file);
    const shown = JSON.parse(packet.candidate);
    must(shown.options?.[0]?.footwear_alternative_ids?.join() === "g_loafer", `the judge was not shown the footwear alternative (${packet.candidate.slice(0, 300)})`);
    must(shown.options[0].garment_ids.join() === "g_top,g_sneaker", "the judge was not shown the option's garments");
    const twoAlternatives = candidateFile({ ...run, visible: { ...run.visible, options: [{ optionId: "a", garments: [{ garmentId: "g_top" }, { garmentId: "g_sneaker" }], footwearAlternatives: [{ garmentId: "g_boot" }] }] } }, 1);
    must(twoAlternatives.options.length === 2, "options differing only in their footwear alternatives were merged, losing one alternative");
  });
  check("a failing checker fails the check, and with it the case", () => {
    const crash = checkerOutcome({ status: 1, stdout: "", stderr: "Traceback (most recent call last):\nKeyError: 'options'" });
    must(crash.status === "failed" && crash.checkerFailed, `a crashed checker was reported as ${crash.status}`);
    must(checkerOutcome({ status: 2, stdout: '{"errors": []}', stderr: "usage" }).status === "failed", "a checker exiting 2 with no errors passed");
    must(checkerOutcome({ status: 1, stdout: '{"errors": []}', stderr: "" }).status === "failed", "a checker exiting 1 with no errors passed");
    must(checkerOutcome({ status: 0, stdout: '{"errors": ["x"]}', stderr: "" }).status === "failed", "a checker reporting errors with exit 0 passed");
    must(checkerOutcome({ status: 0, stdout: '{"result": 1}', stderr: "" }).status === "failed", "a checker result without an errors list passed");
    must(checkerOutcome({ status: 0, stdout: '{"errors": []}', stderr: "" }).status === "passed", "a clean checker result did not pass");
    must(checkerOutcome({ status: 1, stdout: '{"errors": ["Option 0: no socks."]}', stderr: "" }).status === "failed", "checker errors did not fail the check");
    // The real checker, given a candidate file it cannot read, fails rather than passing or being skipped.
    const c = corpus.cases.find((k) => k.split === "development");
    const real = checkerOutcome(evaluatePy(["check-candidate", "--case", c.id, "--candidate", path.join(work, "no-such-candidate.json")], { allowFailure: true }));
    must(real.status === "failed" && real.checkerFailed, `evaluate.py failing on a missing file was reported as ${real.status}`);
    const decided = caseStatus({ failed: [{ name: "board_structure", status: real.status }], incomplete: [], taste: { status: "judged", judgment: { verdict: "pass", hard_violations: [] } } });
    must(decided.status === "failed", `a case whose checker failed was ${decided.status}`);
  });
  check("footwear alternatives are carried to the candidate file and checked", () => {
    const withAlt = candidateFile({ visible: { reply: "x", board: { options: [{ optionId: "a", garments: [{ garmentId: "g_top" }], footwearAlternatives: [{ garmentId: "g_loafer" }] }] }, receipts: [], requests_to_confirm: [], question_asked: null, state: "completed" }, fixture_ids: { "loafer-fx": { garmentId: "g_loafer" } } }, 1);
    must(withAlt?.options[0]?.footwear_alternative_ids?.join() === "loafer-fx", `a footwear alternative was dropped (${JSON.stringify(withAlt?.options)})`);
    const shoe = (garmentId, footwearKind, clean = 1) => ({ garmentId, name: garmentId, roles: ["footwear"], acquisition: "owned", balances: [{ bucket: "clean", quantity: clean }], attributes: { footwearKind } });
    const byId = new Map([["g_loafer", shoe("g_loafer", "loafer")], ["g_sneaker", shoe("g_sneaker", "sneaker")], ["g_dirty", shoe("g_dirty", "sneaker", 0)]]);
    const fx = { "loafer-fx": { garmentId: "g_loafer" } };
    must(alternativeErrors([{ option: 0, id: "g_sneaker" }], byId, fx).length === 0, "an available sneaker alternative was refused");
    must(alternativeErrors([{ option: 0, id: "loafer-fx" }], byId, fx).some((e) => e.includes("restriction")), "a restricted alternative named by fixture id was not caught");
    must(alternativeErrors([{ option: 0, id: "g_dirty" }], byId, fx).some((e) => e.includes("not available")), "an unavailable alternative was not caught");
    must(alternativeErrors([{ option: 0, id: "g_ghost" }], byId, fx).some((e) => e.includes("not a garment")), "a missing alternative was not caught");
  });
  check("B018: only a successful presentation whose morning notification was delivered is a morning notice", () => {
    const reminder = (state) => ({ effectId: "e", kind: "notification.morning_board", state });
    must(countsAsMorningNotice({ type: "board.present", outcome: "committed", effects: [reminder("projected")] }), "a delivered presentation was not counted");
    must(!countsAsMorningNotice({ type: "board.present", outcome: "committed", effects: [] }), "a presentation with no delivered notification was counted");
    for (const outcome of ["noop", "merged", "rejected", undefined]) must(!countsAsMorningNotice({ type: "board.present", outcome, effects: [reminder("projected")] }), `a presentation with outcome ${outcome} was counted`);
    for (const state of ["pending", "in_progress", "cancelled", "superseded", "failed"]) must(!countsAsMorningNotice({ type: "board.present", outcome: "committed", effects: [reminder(state)] }), `a presentation whose notification is ${state} was counted as delivered`);
    must(!countsAsMorningNotice({ type: "daily.run", outcome: "committed", effects: [reminder("projected")] }), "a command other than board.present was counted");
    must(!countsAsMorningNotice({ type: "board.present", outcome: "committed", effects: [{ effectId: "e", kind: "calendar.project_board", state: "projected" }] }) && !countsAsMorningNotice(null), "a presentation without a morning notification was counted");
  });
  check("B012: only a missing late delivery leaves the case uncovered; the application's handling is scored", () => {
    must(lateDeliveryCoverage({ olderStatesAtFirstSync: ["pending"] }).covered, "a queued older projection at the first run was not accepted at the seed");
    for (const now of [["projected"], ["superseded"], ["failed"], ["cancelled"]]) must(lateDeliveryCoverage({ olderStatesAtFirstSync: ["pending"], olderStatesNow: now }).covered, `an older projection that ended ${now} was skipped instead of scored`);
    must(!lateDeliveryCoverage({ olderStatesAtFirstSync: ["projected"] }).covered, "an older projection processed before the newer delivery was taken as covered");
    must(!lateDeliveryCoverage({ olderStatesAtFirstSync: null }).covered && !lateDeliveryCoverage({ olderStatesAtFirstSync: [] }).covered, "unreadable states at the first run were taken as covered");
    must(!lateDeliveryCoverage({ olderStatesAtFirstSync: ["pending"], olderStatesNow: ["in_progress"] }).covered, "a projection still queued at the end was taken as covered");
    must(!lateDeliveryCoverage({ olderStatesAtFirstSync: ["pending"], olderStatesNow: null }).covered, "unreadable final states were taken as covered");
    const source = readFileSync(path.join(here, "src/drivers/features.ts"), "utf8");
    const b012 = source.slice(source.indexOf("const B012: BehaviourDriver"), source.indexOf("/* B015") > 0 ? source.indexOf("/* B015") : undefined);
    must(b012.length > 0 && !b012.includes("UnsupportedScenario"), "the B012 driver can still skip a case as unsupported instead of scoring or failing it");
  });
  check("an unreadable list is never taken for an empty one", () => {
    must(listIn({ proposals: [] }, "proposals")?.length === 0, "an empty list was not read as empty");
    for (const body of [null, undefined, 7, "x", {}, { proposals: null }, { proposals: {} }, { proposals: "none" }]) must(listIn(body, "proposals") === null, `the body ${JSON.stringify(body)} was read as a list`);
    const old = { exportId: "x_old", complete: true, requestedAt: "2026-10-01" };
    const fresh = { exportId: "x_new", complete: true, requestedAt: "2026-10-12" };
    must(exportOfRequest([old, fresh], ["x_old"]) === "x_new", "the request's own export was not chosen");
    must(exportOfRequest(null, ["x_old"]) === null, "an export was chosen from an unreadable list");
    must(exportOfRequest([old], null) === null, "a pre-existing export was chosen without the seed's baseline");
    must(questionnaireOutcome({ replyQuestions: [], proposals: null }).value === null, "an unreadable proposal list established that no questionnaire was created");
    must(questionnaireOutcome({ replyQuestions: ["Which train?", "Which seat?"], proposals: null }).value === true, "two questions were not a questionnaire when the proposals were unreadable");
  });
  check("a work directory inside a fingerprinted tree is refused", () => {
    must(workDirRefusal(path.join(here, "work")) !== null, "evals/work was accepted although the harness tree is fingerprinted");
    must(workDirRefusal(path.join(repo, "packages", "x")) !== null, "a directory in the application tree was accepted");
    must(workDirRefusal(repo) !== null, "the repository root, which holds fingerprinted trees, was accepted");
    must(workDirRefusal(path.join(os.tmpdir(), "garderobe-evals", "r1")) === null, "the default temporary work directory was refused");
    must(workDirRefusal(path.join(here, "..work")) !== null, "evals/..work, which is inside the harness tree, was accepted");
    const linkDir = path.join(os.tmpdir(), `garderobe-evals-link-${process.pid}`);
    rmSync(linkDir, { recursive: true, force: true });
    symlinkSync(here, linkDir);
    try {
      must(workDirRefusal(path.join(linkDir, "work")) !== null, "a work path through a symbolic link into the harness tree was accepted");
    } finally {
      rmSync(linkDir, { force: true });
    }
  });
  check("B012: a newer revision missing at the first scheduled run is scored even if it arrives later", () => {
    must(scoredRemoteRevision({ atFirstSync: 12, newer: 12, final: 12 }) === 12, "the in-order delivery was not scored by the final revision");
    must(scoredRemoteRevision({ atFirstSync: 12, newer: 12, final: 11 }) === 11, "a later overwrite by the older revision was hidden");
    must(scoredRemoteRevision({ atFirstSync: 10, newer: 12, final: 12 }) === 10, "a newer revision missing at the first run was repaired by a later run");
    must(scoredRemoteRevision({ atFirstSync: null, newer: 12, final: 12 }) === null, "an unreadable first-run revision was scored as the final one");
  });
  check("B011, B018: identities that conflict are never merged, through a chain or beside a shared identity", () => {
    const reply = { keys: [], texts: ["Did you wear the navy oxford on Tuesday?"] };
    const a = { keys: ["proposal:a"], texts: ["Did you wear the navy oxford on Tuesday?"] };
    const b = { keys: ["proposal:b"], texts: ["Did you wear the navy oxford on Tuesday?"] };
    must(distinctRequests([a, reply, b]).count === 2 && distinctRequests([reply, a, b]).count === 2, "two proposals were merged through an identity-free reply question");
    must(distinctRequests([{ keys: ["action:x", "input:1"], texts: [] }, { keys: ["action:x", "input:2"], texts: [] }]).count === 2, "two inputs sharing an action identity were merged despite conflicting input identities");
    must(distinctRequests([{ keys: ["input:1", "action:x"], texts: [] }, { keys: ["action:x"], texts: ["Confirm Tuesday"] }, reply]).count === 2, "an identity link was lost");
  });
  check("B011, B018: a confirmation request made without a question mark counts", () => {
    const wear = wearConfirmationTasks({ replyText: "Welcome back. Please confirm whether you wore yesterday's outfit." });
    must(wear.count === 1, `an imperative wear-confirmation request counted ${wear.count}`);
    must(wearConfirmationTasks({ replyText: "Let me know which of the boards you wore while you were away." }).count === 1, "a 'let me know' wear request was missed");
    must(repairApprovalQuestions([], "Tomorrow's outfit uses the gold shirt. Let me know if I should swap it for the white oxford.").count === 1, "an imperative repair approval request was missed");
    must(repairApprovalQuestions([], "I need your approval to replace the gold shirt in tomorrow's outfit.").count === 1, "an 'I need your approval' request was missed");
    must(wearConfirmationTasks({ replyText: "Recorded: you wore the navy oxford yesterday. Today's board is ready." }).count === 0, "a report of a recorded wear was taken for a request");
    must(wearConfirmationTasks({ proposals: [{ proposalId: "p1", type: "wear.record", summary: "Please confirm whether you wore yesterday's outfit" }], replyText: "Please confirm whether you wore yesterday's outfit." }).count === 1, "one imperative request in a proposal and the reply was counted twice");
    must(questionsIn("Please confirm whether you wore yesterday's outfit.").length === 0, "questionsIn (used for questionnaires) changed");
  });
  check("B018: the turn's own waiting run is classified once, by its pending input", () => {
    const returnQuestion = { inputId: "in_1", question: "Which return should I extend?", choices: [], actionId: null };
    must(otherWaitingRuns(1, returnQuestion) === 0, "the turn's own waiting run was counted again as unclassified");
    must(otherWaitingRuns(2, returnQuestion) === 1 && otherWaitingRuns(1, null) === 1 && otherWaitingRuns(0, returnQuestion) === 0, "other waiting runs were miscounted");
    const outcome = wearConfirmationTasks({ pendingInput: returnQuestion, unclassified: otherWaitingRuns(1, returnQuestion) });
    must(outcome.count === 0, `an unrelated return question left the wear outcome at ${outcome.count} instead of establishing zero`);
  });
  check("B019: only the application's own refusal shows a credential or session ended; an error fails the check", () => {
    must(recoveryReuseOutcome({ status: 200 }) === true, "reuse that was accepted was not reported");
    must(recoveryReuseOutcome({ status: 403, code: "forbidden", reason: "recovery_credential_not_accepted" }) === false, "the app's refusal of a spent code was not taken as a rejection");
    must(recoveryReuseOutcome({ status: 403, code: "unrecoverable" }) === false, "the app's unrecoverable refusal was not taken as a rejection");
    for (const r of [{ status: 500, code: "internal" }, { status: 429, code: "rate_limited" }, { status: 0 }, { status: 503 }, { status: 403, code: "forbidden", reason: "cross_origin" }, { status: 404, code: "not_found" }, { status: 410, code: "expired" }, { status: 401, code: "unauthenticated" }]) must(recoveryReuseOutcome(r) === null, `${JSON.stringify(r)} was taken as proof that the spent code is refused`);
    must(sessionOutcome({ status: 401, code: "session_revoked" }) === false && sessionOutcome({ status: 403, code: "identity_not_linked" }) === false, "the app's session refusals were not taken as ended");
    for (const r of [{ status: 500 }, { status: 429, code: "rate_limited" }, { status: 401, code: "unauthenticated" }, { status: 403, code: "forbidden" }, { status: 0 }]) must(sessionOutcome(r) === null, `${JSON.stringify(r)} was taken as proof that a session ended`);
    must(anySessionValid([{ status: 401, code: "session_revoked" }, { status: 403, code: "identity_not_linked" }]) === false, "every session refused was not reported as invalid");
    must(anySessionValid([{ status: 401, code: "session_revoked" }, { status: 200 }]) === true, "an accepted old session was missed");
    must(anySessionValid([{ status: 401, code: "session_revoked" }, { status: 502 }]) === null, "a server error among the sessions established that all ended");
  });
  check("B018: any unclassified item leaves the wear-request count unobserved, even beside a readable request", () => {
    const wear = { proposalId: "p2", type: "wear.record", summary: "Did you wear the navy oxford on Tuesday?" };
    must(wearConfirmationTasks({ proposals: [wear], pendingInput: { inputId: "i", choices: [] } }).count === null, "an unreadable pending input beside a wear proposal was taken as no second request");
    must(wearConfirmationTasks({ proposals: [wear, { proposalId: "p3" }] }).count === null, "an unreadable proposal beside a wear proposal was taken as no second request");
    must(wearConfirmationTasks({ proposals: [wear], unclassified: 1 }).count === null, "an unclassified waiting run beside a wear proposal was taken as no second request");
    must(wearConfirmationTasks({ proposals: [wear] }).count === 1, "a single readable wear proposal was not counted");
    for (const p of [{ proposalId: "p4", type: "command" }, { proposalId: "p5", type: "wear.record", summary: "  " }, { proposalId: "p6", type: "settings.update", summary: null }]) {
      const r = wearConfirmationTasks({ proposals: [p] });
      must(r.count === null && r.unreadable_proposals.length === 1, `a proposal with no readable summary (${JSON.stringify(p)}) gave count ${r.count}`);
    }
  });
  check("B020: the Google OAuth values connectOutfitCalendar seeds are found by the credential scan", () => {
    // connectOutfitCalendar completes Google's OAuth with code `fixture-code`; the Worker's labelled Google test
    // double answers it with fixed tokens. They are read from that fixture here, never copied into the harness.
    const fixture = readFileSync(path.join(repo, "apps/worker/src/testing/vitest-config.ts"), "utf8");
    const at = fixture.indexOf('code === "fixture-code"');
    must(at > 0, "the Google test double's fixture-code answer was not found");
    const line = fixture.slice(at, fixture.indexOf("\n", at));
    const issued = [...line.matchAll(/(access_token|refresh_token): "([^"]+)"/g)].map((m) => m[2]);
    must(issued.length === 2, `expected an access and a refresh token in the fixture-code answer, found ${issued.length}`);
    for (const value of issued) must(credentialShapesIn(JSON.stringify({ note: value })).length > 0, "a seeded Google OAuth token value was not found by the scan");
    const secretAt = fixture.indexOf("client_secret") ;
    const clientSecret = /form\.get\("client_secret"\) !== "([^"]+)"/.exec(fixture)?.[1];
    must(secretAt > 0 && typeof clientSecret === "string" && credentialShapesIn(JSON.stringify({ note: clientSecret })).length > 0, "the Google client secret the test double expects was not found by the scan");
  });
  check("B020: credential names in either case and the Google test-double tokens are found in an export", () => {
    for (const name of ["accessToken", "refreshToken", "clientSecret", "access_token", "refresh_token", "client_secret", "apiKey", "recoveryCode"]) must(credentialShapesIn(`{"${name}": "x"}`).length > 0, `the field ${name} was not found`);
    must(credentialShapesIn('{"note": "fixture-oauth-access-7"}').length > 0 && credentialShapesIn('{"t": "fixture-refresh-revoked"}').length > 0 && credentialShapesIn('{"x":"test-google-client-secret"}').length > 0, "a Google test-double credential value was not found");
    must(credentialShapesIn('{"auth": {"type": "secret"}, "summary": "Recorded the access token rotation"}').length === 0, "a non-credential value was taken for a credential");
    must(credentialShapesIn('{"secret": null, "password": "", "accessToken": []}').length === 0, "an empty credential field was taken for a leaked credential");
    must(credentialShapesIn('{"password": true}').length > 0 && credentialShapesIn('{"secret": false}').length > 0, "a credential-named field with a boolean value was exempted");
  });
  check("B012: a replaced garment is found in an outfit line even when a current name is part of it, and a current name containing it hides nothing else", () => {
    must(replacedNamesListed(["- Long Navy Coat"], ["Coat"], ["Long Navy Coat"]).join() === "Long Navy Coat", "a replaced name containing a current one was missed");
    must(replacedNamesListed(["- Long Navy Coat"], ["Long Navy Coat"], ["Navy Coat"]).length === 0, "a current name containing a replaced one was reported as the replaced one");
    must(replacedNamesListed(["- Long Navy Coat", "- Navy Coat"], ["Long Navy Coat"], ["Navy Coat"]).join() === "Navy Coat", "a replaced name on its own line was missed");
    must(replacedNamesListed(["- Long Navy Coat and Navy Coat"], ["Long Navy Coat"], ["Navy Coat"]).join() === "Navy Coat", "a replaced name beside a current name containing it, on one line, was missed");
  });
  check("B020: replays are counted only once imported work has drained from the target", () => {
    must(importDrained([2, 0]) === true, "a drained target was not recognised");
    must(importDrained([2, 1]) === false, "a target with pending imported work was taken as settled");
    must(importDrained([]) === false && importDrained([Number.NaN]) === false, "an unreadable pending count was taken as settled");
    must(["", false, [], null, undefined, "0"].every((v) => Number.isNaN(pendingCount(v))) && pendingCount(0) === 0, "an unreadable pending count was coerced to a number");
    must(importDrained([pendingCount("")]) === false && importDrained([pendingCount([])]) === false, "an unreadable pending count was taken as drained");
  });
  check("B009: a duplicate garment is counted by identity, even when another garment was removed meanwhile", () => {
    must(garmentsCreated(["g1", "g2"], ["g1", "g3"])?.join() === "g3", "a duplicate created while another garment was removed was not counted");
    must(garmentsCreated(["g1", "g2"], ["g1", "g2"])?.length === 0, "an unchanged wardrobe counted a garment");
    must(garmentsCreated(null, ["g1"]) === null && garmentsCreated(["g1"], undefined) === null, "an unreadable list established a count");
  });
  check("B011, B018: polite requests without a question mark count; a proposal is classified from its summary", () => {
    must(wearConfirmationTasks({ replyText: "Could you confirm whether you wore yesterday's outfit." }).count === 1, "a polite interrogative without a question mark was missed");
    must(wearConfirmationTasks({ replyText: "Did you wear the navy oxford on Tuesday." }).count === 1, "a wear question ending in a full stop was missed");
    must(repairApprovalQuestions([], "Would you confirm I can swap the gold shirt in tomorrow's outfit.").count === 1, "a polite repair request without a question mark was missed");
    must(wearConfirmationTasks({ replyText: "I recorded what you wore yesterday. Your board is ready." }).count === 0, "a plain report was taken for a request");
    must(wearConfirmationTasks({ proposals: [{ proposalId: "p7", type: "wear.record", summary: "Extend the return window for the boots" }] }).count === 0, "a proposal was classified as a wear request by its type, against its summary");
  });
  check("the judge validator refuses malformed judgments without throwing", () => {
    const scores = { personal_fit: 4, composition: 4, comfort_and_fabric: null, variety_and_scope: 3, practical_usefulness: 4, voice_and_teaching: 3 };
    const good = { verdict: "pass", scores, findings: [{ candidate_excerpt: "x", basis: "y", judgment: "z" }], summary: "fine", hard_violations: [] };
    must(judgmentProblem(good) === null, `a valid judgment was refused: ${judgmentProblem(good)}`);
    for (const [label, bad] of [
      ["a primitive", 7],
      ["null", null],
      ["an array", []],
      ["scores as a number", { ...good, scores: 5 }],
      ["scores as a string", { ...good, scores: "personal_fit" }],
      ["scores as an array", { ...good, scores: [1, 2, 3, 4, 5, 6] }],
      ["a score of 6", { ...good, scores: { ...scores, composition: 6 } }],
      ["findings as a string", { ...good, findings: "good" }],
      ["an empty finding", { ...good, findings: [""] }],
      ["a numeric finding", { ...good, findings: [3] }],
      ["summary as an object", { ...good, summary: { text: "x" } }],
      ["an empty summary", { ...good, summary: "  " }],
      ["hard violations that pass", { ...good, hard_violations: ["x"] }],
    ]) {
      let problem;
      try {
        problem = judgmentProblem(bad);
      } catch (error) {
        throw new Error(`the validator threw on ${label}: ${error.message}`);
      }
      must(problem !== null, `${label} was accepted as a judgment`);
    }
    const expected = { case_id: "H001", candidate_id: "anonymous-A" };
    const filed = { ...good, ...expected, mode: "candidate_evaluation" };
    must(judgmentProblem(filed, expected) === null, `a judgment naming its packet was refused: ${judgmentProblem(filed, expected)}`);
    for (const [label, bad] of [
      ["no mode", { ...good, ...expected }],
      ["the historical-review mode", { ...filed, mode: "historical_response_review" }],
      ["another case", { ...filed, case_id: "H002" }],
      ["another candidate", { ...filed, candidate_id: "anonymous-B" }],
      ["no identifiers", { ...good, mode: "candidate_evaluation" }],
    ]) must(judgmentProblem(bad, expected) !== null, `a judgment with ${label} was accepted for its packet`);
    must(judgmentProblem(filed, null) !== null, "a judgment was accepted against a missing packet");
  });
  check("the relay accepts only an object naming a candidate route, and the recorder only plain names", () => {
    for (const body of [null, 3, "x", [], {}, { model: 5 }, { model: "" }]) must(relayModel(body) === null, `the relay accepted the body ${JSON.stringify(body)}`);
    must(relayModel({ model: "a/b" }) === "a/b", "the relay refused a body naming a model");
    const report = { reservedForJudging: ["r/judge"], profiles: [{ gatewayRoute: "r/ok", operations: { text: { result: "passed" }, tools: { result: "passed" } } }, { gatewayRoute: "r/failed", operations: { text: { result: "failed" }, tools: { result: "failed" } } }, { gatewayRoute: "r/textonly", operations: { text: { result: "passed" }, tools: { result: "failed" } } }, { gatewayRoute: "r/judge", operations: { text: { result: "passed" }, tools: { result: "passed" } } }] };
    must(JSON.stringify(candidateRoutes(report)) === JSON.stringify(["r/ok"]), `the relay would allow ${JSON.stringify(candidateRoutes(report))}`);
    for (const name of ["", ".", "..", "...", null, undefined]) must(safeName(name) === null, `the recorder accepted the name ${JSON.stringify(name)}`);
    must(safeName("../../etc/passwd") === ".._.._etc_passwd" && !safeName("a/b").includes("/"), "a name with a separator was kept as a path");
    must(safeName("B015") === "B015" && safeName("candidate-run.json") === "candidate-run.json", "a plain name was changed");
  });
  check("B015: destination options are counted only from the evaluated action, and laundry in a suitcase is caught from the seed", () => {
    must(homeOnlyItems([], ["g1"]).count === null, "no option at all was counted as zero home-only pieces");
    must(homeOnlyItems([{ source: "reply", date: null, options: [] }], ["g1"]).count === null, "an empty option list was counted as zero home-only pieces");
    const options = [{ garments: [{ garmentId: "g1", name: "packed" }], footwearAlternatives: [{ garmentId: "g9", name: "at home" }] }];
    const offered = homeOnlyItems([{ source: "reply", date: null, options }], ["g1"]);
    must(offered.count === 1 && offered.outside[0].garmentId === "g9", `a home-only footwear alternative was not counted (${JSON.stringify(offered)})`);
    must(homeOnlyItems([{ source: "reply", date: null, options: [{ garments: [{ garmentId: "g1" }] }] }], ["g1"]).count === 0, "an option of packed pieces only was not counted as zero");
    must(homeOnlyItems([{ source: "reply", date: null, options: [{}] }], ["g1"]).count === null, "an option with no readable garments was counted as zero home-only pieces");
    must(homeOnlyItems([{ source: "reply", date: null, options: [{ garments: [{ garmentId: "g1" }] }, { garments: [{ name: "no id" }] }] }], ["g1"]).count === null, "an unreadable option beside a packed one was counted as zero home-only pieces");
    must(homeOnlyItems([{ source: "reply", date: null, options: [{ garments: [{ garmentId: ["g1"] }] }] }], ["g1"]).count === null && homeOnlyItems([{ source: "reply", date: null, options: [{ garments: [{ garmentId: 1 }] }] }], ["1"]).count === null, "a malformed garment identifier was read as a garment");
    const seed = [{ garmentId: "s", name: "shirt", clean: 1, worn: 1 }, { garmentId: "t", name: "trousers", clean: 1, worn: 0 }];
    must(suitcaseLaundry(seed, [{ garmentId: "s", clean: 2, worn: 0 }, { garmentId: "t", clean: 1, worn: 0 }], { packingRuledOut: true }).applied === true, "a wash in the suitcase during the turn was not caught");
    must(suitcaseLaundry(seed, [{ garmentId: "s", clean: 2, worn: 0 }, { garmentId: "t", clean: 1, worn: 0 }]).applied === null, "worn turning clean was taken for a wash although packing was not ruled out (an unpack and repack reads the same)");
    must(suitcaseLaundry(seed, [{ garmentId: "t", clean: 1, worn: 0 }]).applied === null, "a worn piece that left the suitcase (unpacking or a wash) was not reported as ambiguous");
    must(suitcaseLaundry(seed, [{ garmentId: "s", clean: 1, worn: 1 }, { garmentId: "t", clean: 2, worn: 0 }]).applied === null, "packing more clean units was taken for a wash");
    must(suitcaseLaundry(seed, [{ garmentId: "s", clean: 1, worn: 0 }, { garmentId: "t", clean: 1, worn: 0 }]).applied === null, "a worn unit leaving the suitcase was taken for a wash");
    const worn = suitcaseLaundry(seed, [{ garmentId: "s", clean: 1, worn: 1 }, { garmentId: "t", clean: 0, worn: 1 }]);
    must(!worn.applied && worn.worn.length === 1, "a wear was mistaken for laundry");
    must(suitcaseLaundry(seed, seed).applied === false, "an unchanged suitcase was reported as laundered");
    for (const [b, a] of [[null, seed], [seed, null], [null, null], [undefined, seed]]) must(suitcaseLaundry(b, a).applied === null, `a missing reading (${b ? "after" : "before"}) was reported as an observed result`);
    must(questionsIn("Noted. Was it the morning train? Which layer felt warm? How long was the ride?").length === 3, "the questions of a questionnaire reply were not all found");
    must(questionsIn("1. Which train?\n2. Which layer?").length === 2, "numbered questions were not found");
    must(questionsIn("Noted: the oxford runs warm on the train.").length === 0, "a statement was taken for a question");
  });
  check("B017: the comfort note must be the remark, and a ban written as a style rule or direction is caught", () => {
    const note = { garmentIds: ["g1"], kind: "too_warm", text: "too warm on the train", scope: null, conditions: null };
    must(comfortObservationMatch(note, "g1", "too_warm", "train").matches, "the remark itself was not matched");
    must(!comfortObservationMatch({ ...note, garmentIds: ["g2"] }, "g1", "too_warm", "train").matches, "a note about another garment was matched");
    must(!comfortObservationMatch({ ...note, kind: "too_cold" }, "g1", "too_warm", "train").matches, "a note of another comfort kind was matched");
    must(!comfortObservationMatch({ ...note, text: "too warm" }, "g1", "too_warm", "train").matches, "a note without the train was matched");
    must(comfortObservationMatch({ ...note, text: "warm", conditions: { where: "on the train" } }, "g1", "too_warm", "train").matches, "the train in the conditions was not matched");
    const garment = { garmentId: "g_123", name: "Blue linen shirt" };
    const before = [{ text: "Prefer navy" }];
    must(newGarmentProhibitions(before, [...before, { text: "Never suggest the blue linen shirt" }], garment).length === 1, "a new rule banning the garment by name was missed");
    must(newGarmentProhibitions(null, { a: { garmentIds: ["g_123"], effect: "exclude" } }, garment).length === 1, "a new structured direction excluding the garment by id was missed");
    must(newGarmentProhibitions(before, [...before, { text: "Blue linen shirt is too warm on trains" }], garment).length === 0, "a contextual note was taken for a ban");
    must(newGarmentProhibitions([{ text: "Never suggest the blue linen shirt" }], [{ text: "Never suggest the blue linen shirt" }], garment).length === 0, "a rule present at the seed was reported as new");
    must(newGarmentProhibitions(before, [...before, { text: "Blue linen shirt: warm on trains", banned: false, avoid: false }], garment).length === 0, "a prohibition flag set to false was taken for a ban");
    must(newGarmentProhibitions(before, [...before, { text: "The blue linen shirt is not banned; just skip it on long rides" }], garment).length === 0, "a negated prohibition was taken for a ban");
    must(newGarmentProhibitions(before, [...before, { text: "No need to avoid the blue linen shirt" }], garment).length === 0, "'no need to avoid' was taken for a ban");
    must(newGarmentProhibitions(before, [...before, { kind: "exclusion_note_never_shown", note: "Blue linen shirt runs warm" }], garment).length === 0, "a prohibition word in a key name was taken for a ban");
    must(newGarmentProhibitions(before, [...before, { garmentIds: ["g_123"], banned: true }], garment).length === 1, "a prohibition flag set to true was missed");
  });
  check("B020: the checksum list must cover every manifest file and the manifest, each once", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const required = ["records/wear.json", "manifest.json"];
    must(checksumCoverage(`${a}  records/wear.json\n${b}  manifest.json\n`, required).failures.length === 0, "a complete list was refused");
    must(checksumCoverage(`${a}  records/wear.json\n`, required).failures.some((f) => f.includes("manifest.json")), "a list without the manifest was accepted");
    must(checksumCoverage(`${a}  records/wear.json\n${a}  records/wear.json\n${b}  manifest.json\n`, required).failures.some((f) => f.includes("more than once")), "a duplicated entry was accepted");
    must(checksumCoverage(`${a} records/wear.json\n${b}  manifest.json\n`, required).failures.length > 0, "a malformed line was accepted");
    must(checksumCoverage("", required).failures.length === 2, "an empty list was accepted");
    must(checksumCoverage(`${a}  records/wear.json\n${b}  manifest.json\n${a}  secrets/extra.json\n`, required).failures.some((f) => f.includes("secrets/extra.json")), "an entry outside the manifest was accepted");
  });
  await checkAsync("a gateway call that does not finish within its deadline ends with status 0", async () => {
    const server = http.createServer(() => {
      /* never answers */
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address();
      const started = Date.now();
      const result = await chat({ baseUrl: `http://127.0.0.1:${port}` }, "probe", { model: "x", messages: [] }, { EVAL_GATEWAY_TIMEOUT_MS: "300" });
      must(result.status === 0 && !result.ok, `a stalled gateway answered ${result.status}`);
      must(Date.now() - started < 10_000, "the deadline did not stop the call");
      return result.errorBody;
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
  await checkAsync("a gateway call never follows a redirect, so its credential stays on the gateway's origin", async () => {
    let followed = false;
    const target = http.createServer((_, res) => {
      followed = true;
      res.end("{}");
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    const redirector = http.createServer((_, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/elsewhere` });
      res.end();
    });
    await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    try {
      const result = await chat({ baseUrl: `http://127.0.0.1:${redirector.address().port}` }, "probe", { model: "x", messages: [] }, { EVAL_GATEWAY_TIMEOUT_MS: "5000" });
      must(!followed, "the redirect was followed to another origin");
      must(result.status === 0 && !result.ok, `a redirect was answered as ${result.status}`);
    } finally {
      target.close();
      redirector.close();
    }
  });
  check("the supplied bundle is unchanged by building packets", () => must(digest(treeHashes(path.join(repo, "requirements/support"))) === before, "a file under requirements/support changed"));
  rmSync(work, { recursive: true, force: true });
  for (const c of checks) console.log(`${c.status === "passed" ? "ok  " : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  if (checks.some((c) => c.status === "failed")) process.exitCode = 1;
}

try {
  if (command === "development" || command === "holdout" || command === "adapter-check") await runSplit(command);
  else if (command === "freeze") freeze();
  else if (command === "selftest") await selftest();
  else {
    console.error("usage: node evals/run.mjs development|freeze|holdout|adapter-check|selftest [options]   (see the head of this file)");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`evaluation refused or failed: ${error.message}`);
  process.exitCode = 1;
}
