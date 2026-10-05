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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATEWAY_VARS, gatewayRoute, probeRoutes, readRegistry } from "./src/node/gateway.mjs";

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

/** The inference configuration of a run, without any secret: which gateway, and how the judge's route is chosen. */
function inferenceConfiguration(registry) {
  return { gatewayId: route().gatewayId, conversationCandidates: registry.conversationCandidates, judgeRouteOrder: process.env.EVAL_JUDGE_ROUTES ?? "registry order, OpenAI route first" };
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
  if (!applicationRunId) return [];
  const dir = path.join(work, "raw", "model-calls", applicationRunId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120));
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
  const structured = Array.isArray(v.options) ? v.options : [];
  const options = structured
    .map((o, i) => ({ id: String(o.optionId ?? o.id ?? `option-${i + 1}`), garment_ids: (o.garments ?? o.slots ?? []).map((g) => toFixture(String(g.garmentId ?? g))), explanation: String(o.reason ?? o.explanation ?? "") }))
    .filter((o) => o.garment_ids.length > 0);
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
      const result = evaluatePy(["check-state", "--case", c.id, "--file", file], { allowFailure: true });
      let errors = null;
      try {
        errors = JSON.parse(result.stdout).errors;
      } catch {
        /* reported below */
      }
      if (errors === null) add("state_assertions", "not_run", `evaluate.py check-state did not return a result: ${result.stderr.trim().split("\n").at(-1)}`);
      else add("state_assertions", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? `every asserted outcome was observed in application state (${Object.keys(corpus.assertions[c.id]).join(", ")})` : errors);
    }
  }

  // 2. A structured board, when the application returned one: the bundle's structural check (synthetic
  //    world, fixture IDs) or the same rules against the application's own wardrobe (real stock).
  const candidate = candidateFile(run, c.scenario.requested_count ?? null);
  if (candidate) writeJson(path.join(caseDir, "candidate.json"), candidate);
  if (candidate && candidate.options.length > 0) {
    if (run.world === "synthetic_fixture") {
      const result = evaluatePy(["check-candidate", "--case", c.id, "--candidate", path.join(caseDir, "candidate.json")], { allowFailure: true });
      const errors = JSON.parse(result.stdout).errors;
      add("board_structure", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? "the bundle's structural check found nothing" : errors);
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

  // 3. Checks from application state that hold for every case that ran.
  if (run.status === "ran") {
    const before = new Set(run.wardrobe_before.map((g) => g.garmentId));
    const created = run.wardrobe_after.filter((g) => !before.has(g.garmentId));
    add("no_garment_created_unasked", created.length === 0 ? "passed" : "review", created.length === 0 ? "the wardrobe has the same garments after the turn as before" : created.map((g) => `created: ${g.name}`));
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

/** What the judge is told about the world the candidate actually answered in. Read from application state. */
function applicationEvidence(run) {
  const wardrobe = run.wardrobe_before.map((g) => ({
    name: g.name,
    ...(g.fixtureId ? { fixture_id: g.fixtureId } : {}),
    category: g.category,
    roles: g.roles,
    units: Object.fromEntries(g.balances.map((b) => [b.bucket, b.quantity])),
    available_now: available(g),
    ...(g.hardExcluded ? { excluded: true } : {}),
    ...(g.attributes.footwearKind ? { footwear_kind: g.attributes.footwearKind } : {}),
  }));
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
  };
}

/**
 * The judge's route for one case. The bundle names the judge ("Codex judges taste") and forbids the
 * candidate grading itself; within the application's gateway that becomes: the registry's OpenAI route
 * first, then the other registry routes, taking the first that answered this run's text probe and did NOT
 * answer this case's candidate. EVAL_JUDGE_ROUTES (comma-separated registry routes) overrides the order.
 */
function judgeRouteFor(candidateRoutes, probes, registry) {
  const answered = new Set(probes.profiles.filter((p) => p.operations.text?.result === "passed").map((p) => p.gatewayRoute));
  const registryRoutes = registry.profiles.map((p) => p.gatewayRoute).filter(Boolean);
  const preferred = process.env.EVAL_JUDGE_ROUTES ? process.env.EVAL_JUDGE_ROUTES.split(",").map((s) => s.trim()) : [...registryRoutes.filter((x) => x.startsWith("openai/")), ...registryRoutes.filter((x) => !x.startsWith("openai/"))];
  for (const x of preferred) if (!registryRoutes.includes(x)) throw new Error(`EVAL_JUDGE_ROUTES names ${x}, which is not a route of the application's registry`);
  return preferred.find((x) => answered.has(x) && !candidateRoutes.includes(x)) ?? null;
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
      if (!run.visible?.reply && (run.visible?.receipts ?? []).length === 0 && (run.visible?.requests_to_confirm ?? []).length === 0) {
        outcomes[c.id] = { status: "not_run", reason: `the candidate produced no visible answer (run state ${run.visible?.state}); there is nothing to judge` };
        continue;
      }
      const candidateRoutes = [...new Set(modelCallsOf(work, run.application_run_id).filter((k) => k.status === 200).map((k) => k.requestedModel))];
      const judgeRoute = judgeRouteFor(candidateRoutes, probes, registry);
      if (!judgeRoute) {
        outcomes[c.id] = { status: "not_run", reason: `no gateway route is left for an independent judge: the candidate was answered by ${candidateRoutes.join(", ") || "no route"} and no other registry route passed this run's text probe` };
        continue;
      }
      const packet = JSON.parse(evaluatePy(["packet", "--case", c.id, "--mode", "judge", "--candidate", candidatePath]).stdout);
      packet.application_evidence = applicationEvidence(run);
      if (run.world === "owner_real_stock") packet.fixture = { note: "Not the candidate's stock in this run; see application_evidence.wardrobe_before_request.", default_date: packet.fixture.default_date, timezone: packet.fixture.timezone };
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
  for (const key of new Set(Object.values(corpus.assertions).flatMap((a) => Object.keys(a)))) needles.push({ kind: "state_assertion_key", case: null, text: key });
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

function caseResult(c, corpus, work, judged, runId, r) {
  const caseDir = path.join(work, "cases", c.id);
  const runFile = path.join(caseDir, "candidate-run.json");
  const base = { case_id: c.id, split: c.split, family: c.family, title: c.title, world: worldOf(c, corpus), run_id: runId };
  if (!existsSync(runFile)) return { ...base, status: "not_run", reason: "the candidate phase recorded nothing for this case (see the candidate process log)", deterministic: [], taste: { status: "not_run", reason: "no candidate answer" } };
  const run = readJson(runFile);
  if (run.status === "adapter_error") return { ...base, driver_mode: run.driver_mode, status: "not_run", reason: `harness adapter error at stage "${run.stage}": ${run.error.message}`, adapter_error: run.error, deterministic: [], taste: { status: "not_run", reason: "no candidate answer" } };
  if (run.status === "not_run") return { ...base, driver_mode: run.driver_mode, status: "not_run", reason: run.not_run_reason, deterministic: [], taste: { status: "not_run", reason: "no candidate answer" } };
  const { checks } = deterministicChecks(c, run, corpus, caseDir, runId);
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
  if (c.id in corpus.assertions && !checks.some((k) => k.name === "state_assertions")) incomplete.push({ name: "state_assertions", status: "not_run", detail: "the state assertions of this case were not checked" });
  const reasons = [];
  let status;
  if (run.driver_mode !== "conversation") {
    status = "not_run";
    reasons.push("the candidate (the application's assistant on its gateway routes) did not run; only the scripted ledger check below ran");
  } else if (inference.kind !== "real") {
    status = "not_run";
    reasons.push(`no model call was answered (${calls.length} attempted); run state ${run.visible?.state}`);
  } else if (failed.length > 0) {
    status = "failed";
    reasons.push(...failed.map((k) => `deterministic check ${k.name} failed`));
  } else if (incomplete.length > 0) {
    status = "not_run";
    reasons.push(...incomplete.map((k) => `deterministic check ${k.name} did not complete (${k.status}): ${typeof k.detail === "string" ? k.detail : JSON.stringify(k.detail)}`.slice(0, 400)));
  } else if (taste.status !== "judged") {
    status = "not_run";
    reasons.push(`not judged: ${taste.reason}`);
  } else if (taste.judgment.hard_violations.length > 0 || taste.judgment.verdict === "fail" || taste.judgment.verdict === "revise") {
    status = "failed";
    reasons.push(`judge verdict ${taste.judgment.verdict}${taste.judgment.hard_violations.length ? ` with ${taste.judgment.hard_violations.length} hard violation(s)` : ""}`);
  } else if (taste.judgment.verdict === "insufficient_evidence") {
    status = "failed";
    reasons.push("not shown to pass: the judge found the evidence insufficient");
  } else status = "passed";
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

async function runSplit(split) {
  const corpus = loadCorpus();
  const registry = readRegistry(repo);
  const r = route();
  const adapterCheck = split === "adapter-check";
  const driver = adapterCheck ? "scripted_commands" : option("driver", r.ready ? "conversation" : "scripted_commands");
  if (!["conversation", "scripted_commands"].includes(driver)) throw new Error(`unknown driver ${driver}`);
  const subset = option("cases");
  const phases = adapterCheck ? ["candidate", "check"] : (option("phases", "candidate,check,judge") ?? "").split(",");
  const shards = Number(option("shards", "4"));
  const prints = fingerprints();
  if (split === "holdout") {
    if (existsSync(holdoutLedger)) throw new Error(`the holdout has already been run (${path.relative(repo, holdoutLedger)}). It is run exactly once; there is no second run.`);
    if (subset || option("phases")) throw new Error("the holdout is run whole, in one piece: --cases and --phases are not accepted");
    if (driver !== "conversation" || !r.ready) throw new Error(`the holdout is only run with the real model route. Missing: ${r.missing.join(", ") || "driver must be conversation"}`);
    if (!existsSync(frozenFile)) throw new Error("tuning has not been declared finished: run `node evals/run.mjs freeze` after the last development run");
    const frozen = readJson(frozenFile);
    for (const key of FINGERPRINT_KEYS) if (frozen.fingerprints[key] !== prints[key]) throw new Error(`the ${key} changed after tuning was frozen; freeze again (which records the change) before the holdout`);
    if (JSON.stringify(frozen.inference) !== JSON.stringify(inferenceConfiguration(registry))) throw new Error(`the inference configuration differs from the frozen one (${JSON.stringify(frozen.inference)}); the holdout runs on the configuration the development run used`);
  }
  if (driver === "conversation" && !r.ready) throw new Error(`the AI Gateway route is not configured. Missing from the environment: ${r.missing.join(", ")}`);
  // The adapter check takes the DEVELOPMENT cases whose outcome the corpus pins in application state. A
  // held-out case is never run before the holdout run, in any form.
  const caseSplit = adapterCheck ? "development" : split;
  const selected = corpus.cases.filter((c) => c.split === caseSplit && (!adapterCheck || c.id in corpus.assertions) && (!subset || subset.split(",").includes(c.id)));
  if (selected.length === 0) throw new Error("no case selected");
  const runId = `${split}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z")}`;
  const work = option("work") ?? path.join(process.env.EVAL_WORK_DIR ?? path.join(os.tmpdir(), "garderobe-evals"), runId);
  mkdirSync(work, { recursive: true });
  const bundleBefore = digest(treeHashes(path.join(repo, "requirements/support")));

  // Real probes of the gateway, before anything is shown to a candidate (and before the holdout ledger is written).
  let probes = { gatewayId: r.gatewayId, gatewayHost: r.host, probedAt: null, profiles: [] };
  if (driver === "conversation") {
    const probesFile = path.join(work, "raw", "probes.json");
    probes = existsSync(probesFile) ? readJson(probesFile) : await probeRoutes(r, registry);
    writeJson(probesFile, probes);
    for (const p of probes.profiles) console.log(`probe ${p.profileId} (${p.gatewayRoute ?? "no route"}): ${Object.entries(p.operations).map(([op, o]) => `${op} ${o.result}`).join(", ") || "not probed"}`);
    const usable = probes.profiles.filter((p) => p.operations.text?.result === "passed" && p.operations.tools?.result === "passed");
    if (usable.length === 0) throw new Error(`no conversation profile of the registry answered on gateway ${r.gatewayId}: ${probes.profiles.map((p) => `${p.gatewayRoute}: ${p.operations.text?.reason ?? p.operations.tools?.reason ?? "no route"}`).join(" | ").slice(0, 1500)}`);
  }

  if (split === "holdout") writeJson(holdoutLedger, { run_id: runId, started_at: new Date().toISOString(), fingerprints: prints, frozen_at: readJson(frozenFile).frozen_at, cases: selected.map((c) => c.id), note: "Written before the first held-out case was shown to the candidate. Its existence is what prevents a second run." });
  console.log(`run ${runId}: ${selected.length} ${split} case(s), driver ${driver}, work directory ${work}`);

  let shardReport = [];
  if (phases.includes("candidate")) {
    const input = candidateInput(corpus, selected, caseSplit, driver, work);
    shardReport = await candidatePhase(input, work, shards);
    console.log(`candidate phase finished: ${shardReport.map((s) => `shard ${s.shard} exit ${s.exitCode}`).join(", ")}`);
  }
  // Assemble candidate files first (the judge needs them), then judge, then score.
  for (const c of selected) {
    const caseDir = path.join(work, "cases", c.id);
    if (existsSync(path.join(caseDir, "candidate-run.json"))) {
      const run = readJson(path.join(caseDir, "candidate-run.json"));
      const candidate = run.status === "ran" ? candidateFile(run, c.scenario.requested_count ?? null) : null;
      if (candidate) writeJson(path.join(caseDir, "candidate.json"), candidate);
    }
  }
  const judged = phases.includes("judge") && driver === "conversation" ? await judgePhase(selected, work, Number(option("judges", "4")), probes, registry) : {};
  const results = selected.map((c) => caseResult(c, corpus, work, judged, runId, r));
  const isolation = isolationAudit(corpus, caseSplit, work, registry);
  const bundleUnchanged = digest(treeHashes(path.join(repo, "requirements/support"))) === bundleBefore;
  const meta = {
    run_id: runId,
    split,
    driver,
    finished_at: new Date().toISOString(),
    route: { gatewayId: r.gatewayId, gatewayHost: r.host, configured: r.ready, missing: r.missing },
    inference: inferenceConfiguration(registry),
    daily_composition: "deterministic. The daily service builds its composition model from the Worker's AI binding, which local workerd does not have, and the product has no other seam for it; boards the daily service publishes in this run were composed without a model. Only the assistant's conversation calls reached the gateway.",
    probes,
    fingerprints: prints,
    candidate_processes: shardReport,
    isolation,
    bundle_unchanged: bundleUnchanged,
    subset: subset ? subset.split(",") : null,
    ...(adapterCheck ? { note: "Adapter check: the scripted driver issued, as the owner, the command each owner sentence states, and the outcome was read from application state and receipts. No model was called, so these are not case results. Development cases only: no held-out case is run in any form before the holdout run." } : {}),
  };
  const { dest, summary } = publish(split, runId, work, results, meta);
  if (split === "holdout") writeJson(holdoutLedger, { ...readJson(holdoutLedger), finished_at: meta.finished_at, totals: summary.totals, isolation_clean: isolation.clean });
  console.log(`results: ${path.relative(repo, dest)}  passed ${summary.totals.passed}, failed ${summary.totals.failed}, not run ${summary.totals.not_run}; scripted ledger checks passed ${summary.scripted_ledger_checks.passed}, failed ${summary.scripted_ledger_checks.failed}; isolation ${isolation.clean ? "clean" : "VIOLATED"}; bundle unchanged ${bundleUnchanged}`);
  if (!isolation.clean || !bundleUnchanged) process.exitCode = 1;
  if (adapterCheck) {
    // Per case, at the end of the output, so a failing run shows what failed where it is read first.
    const unsupported = (x) => String(x.reason ?? "").startsWith("the application cannot be put into this scenario");
    const lines = [];
    for (const s of shardReport) if (s.exitCode !== 0) lines.push(`candidate process ${s.shard} exited ${s.exitCode}; the end of its log:\n${readFileSync(path.join(work, `candidate-process-${s.shard}.log`), "utf8").split("\n").slice(-40).join("\n").slice(-4000)}`);
    for (const x of results) {
      const label = x.adapter_error ? "ADAPTER ERROR" : unsupported(x) ? "unsupported scenario (not run)" : (x.scripted_ledger_check ?? x.status);
      const open = (x.deterministic ?? []).filter((k) => k.status !== "passed");
      const detail = x.adapter_error ? `${x.reason}\n${String(x.adapter_error.stack ?? "").split("\n").slice(1, 4).join("\n")}` : x.scripted_ledger_check === "passed" ? "" : [x.reason, ...open.map((k) => `${k.name} ${k.status}: ${typeof k.detail === "string" ? k.detail : JSON.stringify(k.detail)}`)].filter(Boolean).join("\n");
      lines.push(`${x.case_id}: ${label}${detail ? `\n    ${detail.slice(0, 900).split("\n").join("\n    ")}` : ""}`);
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
    const why = [];
    if (s.driver !== "conversation") why.push("it called no model");
    if (s.subset) why.push("it ran a subset");
    if (s.totals?.cases !== 45) why.push(`it has ${s.totals?.cases} cases, not 45`);
    if (s.totals?.not_run !== 0) why.push(`${s.totals?.not_run} case(s) were not run or not judged`);
    if (!s.isolation?.clean) why.push("its isolation audit is not clean");
    if (!s.bundle_unchanged) why.push("the supplied bundle changed during it");
    for (const key of FINGERPRINT_KEYS) if (s.fingerprints?.[key] !== prints[key]) why.push(`the ${key} has changed since`);
    if (why.length === 0) qualifying = runId;
    else refusals.push(`${runId}: ${why.join("; ")}`);
  }
  if (!qualifying) throw new Error(`there is no complete development run of this build to freeze on. A full 45-case run with real inference, every case passed or failed, is required first.${refusals.length ? ` Runs on record: ${refusals.join(" | ")}` : " No development run is on record."}`);
  writeJson(frozenFile, { frozen_at: new Date().toISOString(), fingerprints: prints, inference: inferenceConfiguration(registry), frozen_on_development_run: qualifying, development_runs_before_freeze: development, statement: "Tuning is finished. The holdout is run against exactly these digests and this inference configuration, which are those of the named development run." });
  console.log(`frozen on ${qualifying}: ${path.relative(repo, frozenFile)}`);
}

/** Guards that need no model and no Worker. Exit 0 only when every one holds. */
function selftest() {
  const corpus = loadCorpus();
  const checks = [];
  const check = (name, fn) => {
    try {
      checks.push({ name, status: "passed", detail: fn() ?? null });
    } catch (error) {
      checks.push({ name, status: "failed", detail: String(error?.message ?? error) });
    }
  };
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
      for (const key of new Set(Object.values(corpus.assertions).flatMap((a) => Object.keys(a)))) must(!text.includes(key), `state assertion key ${key} is in the candidate input`);
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
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    must(source.includes('const caseSplit = adapterCheck ? "development" : split;'), "the adapter check is not limited to development cases");
    must(source.includes("there is no complete development run of this build to freeze on"), "freeze does not require a complete development run");
  });
  check("the model routes are read from the application's registry, and the conversation task has candidates", () => {
    const registry = readRegistry(repo);
    must(registry.conversationCandidates.length > 0 && registry.conversationCandidates.every((id) => registry.profiles.find((p) => p.profileId === id)?.gatewayRoute), "a conversation candidate has no gateway route");
    const source = ["run.mjs", "src/node/gateway.mjs", "src/node/judge.mjs", "src/node/outbound.ts", "src/worker-entry.ts", "src/kit.ts"].map((f) => readFileSync(path.join(here, f), "utf8")).join("\n");
    for (const p of registry.profiles) for (const name of [p.gatewayRoute, p.apiModelId]) must(!name || !source.includes(name), `the harness source names the model ${name} instead of reading it from the registry`);
    must(!/PROVIDER_KEY_[A-Z]/.test(source.replace(/PROVIDER_KEY_\*/g, "").replace(/PROVIDER_KEY_\[A-Z\]/g, "")), "the harness reads a provider key");
    return `conversation candidates: ${registry.conversationCandidates.join(", ")}`;
  });
  check("the judge is never given a route that answered the candidate", () => {
    const registry = readRegistry(repo);
    const routes = registry.profiles.map((p) => p.gatewayRoute).filter(Boolean);
    const probes = { profiles: routes.map((gatewayRoute) => ({ gatewayRoute, operations: { text: { result: "passed" } } })) };
    for (const used of routes) must(judgeRouteFor([used], probes, registry) !== used, `the judge was given ${used}, which answered the candidate`);
    must(judgeRouteFor(routes, probes, registry) === null, "a judge route was chosen although every route answered the candidate");
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
  check("the holdout guard refuses a subset, a scripted run and a second run", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    must(source.includes("the holdout has already been run") && source.includes("--cases and --phases are not accepted") && source.includes("only run with the real model route"), "a guard is missing");
    return existsSync(holdoutLedger) ? "the holdout ledger exists: the holdout has been run" : "the holdout has not been run";
  });
  check("the supplied bundle is unchanged by building packets", () => must(digest(treeHashes(path.join(repo, "requirements/support"))) === before, "a file under requirements/support changed"));
  rmSync(work, { recursive: true, force: true });
  for (const c of checks) console.log(`${c.status === "passed" ? "ok  " : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  if (checks.some((c) => c.status === "failed")) process.exitCode = 1;
}

try {
  if (command === "development" || command === "holdout" || command === "adapter-check") await runSplit(command);
  else if (command === "freeze") freeze();
  else if (command === "selftest") selftest();
  else {
    console.error("usage: node evals/run.mjs development|freeze|holdout|adapter-check|selftest [options]   (see the head of this file)");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`evaluation refused or failed: ${error.message}`);
  process.exitCode = 1;
}
