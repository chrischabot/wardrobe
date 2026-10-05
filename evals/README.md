# Evaluation of this build against the bundled 64-case corpus

The corpus in `requirements/support/wardrobe-support/evals/` (64 cases: 45 development, 19 held out) is
calibration and input. It proves nothing about this build until the build is run against it. This directory
is the harness that does that run, against the real application, and `results/` holds what each run found.

Nothing here is part of `npm test`: a run needs the application's AI Gateway.

## Commands

From the repository root, after `npm ci`:

```bash
node evals/run.mjs selftest        # isolation and split guards; no model, no Worker
node evals/run.mjs adapter-check   # NO model: scripted ledger check of the development behavioural cases
node evals/run.mjs development     # the 45 development cases, candidate and judge on the gateway
node evals/run.mjs freeze          # declare tuning finished
node evals/run.mjs holdout         # the 19 held-out cases, exactly once
```

Environment for `development` and `holdout`:

| Variable | Meaning |
| --- | --- |
| `CF_AIG_TOKEN` | Token of the authenticated AI Gateway. Read from the environment only; never written to a file or a log. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the gateway. |
| `EVAL_GATEWAY_ID` | Optional. One of the application's gateways; `garderobe-dev` by default. |
| `EVAL_JUDGE_ROUTES` | Optional. Comma-separated registry routes, in the order the judge should prefer them. |
| `EVAL_WORK_DIR` | Optional. Where the working files of a run go (default: the system temporary directory). |

Without `CF_AIG_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, `development` runs with `--driver scripted_commands`
(every case is then reported as not run, with the scripted ledger check beside it) and `holdout` refuses to
start. Provider keys are not read anywhere in this harness.

## What runs

**The candidate is the application.** `src/worker-entry.ts` is the real Worker (`apps/worker/src/index.ts`:
same handlers, router, D1 ledger, conversation actor, tools and policy) in local workerd. Each case gets an
owner of its own. The owner's message goes through the app's own conversation route
(`POST /v1/conversation/turns`) and the run is followed to its end as a client would.

**Its model is the application's own.** The product's model service chooses the profile for a task from the
product's registry (`packages/assistant/src/inference/registry.ts`); the harness adds, removes and renames
no profile and holds no model name (the self-test checks that). At the start of a run the harness probes
the conversation task's candidate routes on the gateway (one text call, one tool call each) and records the
results with the product's own `inference.record_probe` command, so the product's routing selects among
the profiles that really answered.

One thing differs from a deployment, and it is the transport only: on Cloudflare the product calls the
gateway through the Worker's `AI` binding, which does not exist in local workerd. The harness therefore
sends the same `{provider}/{model}` route to the same gateway over the gateway's OpenAI-compatible HTTP
endpoint, authenticated with `cf-aig-authorization` and with no provider key on the request
(`src/node/gateway.mjs`). Two consequences are stated in every result rather than hidden:

- The daily service's own composition model (`apps/worker/src/lanes/daily.ts`) is built from the `AI`
  binding and has no seam. Locally it is absent, so boards published by the daily service are composed by
  the product's deterministic composer. Boards and advice written by the assistant in conversation use the
  model.
- Weather and Google Calendar are the journey suite's labelled doubles (`tests/journeys/src/outbound.ts`).

**Worlds.** A case whose scenario names garments of the corpus's constructed fixture, or whose outcome the
corpus pins with state assertions, is a boundary condition the corpus defines: it runs on a labelled
SYNTHETIC owner holding the owner's real profile and the corpus fixture wardrobe (each garment created with
`garment.create`, `isSynthetic: true`, carrying the fixture's fabric, size, collar and care facts). A
scenario's `stock_override` patches an item before it is created; a garment the fixture or the scenario
gives as restricted or unavailable is excluded in the application (by the owner's own rules where they
already cover it, otherwise by a labelled restriction), and the world is refused unless the application's
exclusions match the corpus's before the request is made. Every other case runs on the owner's real profile and real
127-garment inventory, imported by the product's importer. The rule is code (`worldOf` in `run.mjs`), not a
list. Scenario dates are written against the fixture's 15 September 2026; the application runs on the real
calendar, so they are shifted to the run's date going in and shifted back when reported.

## Isolation

`run.mjs` is the only reader of `cases.json`, the state assertions and the evidence. It hands each phase
what that phase may see.

- **Candidate.** The candidate process gets, per case, the identifier, the request, the scenario and the
  world: built from the bundle's own `evaluate.py packet --mode candidate` and then reduced. No criteria, no
  evidence, no expected state, no title, no case of the other split. The process is started with an
  environment of its own (system basics and the gateway variables). After the run, every request that was
  actually sent to a model is searched for every judge criterion, case title, assertion key, evidence quote
  and other-split request (`isolation` in `summary.json`); a hit fails the run.
- **Judge.** One process per case (`src/node/judge.mjs`), started in an empty directory with one path: the
  judge packet, built by the bundle's `evaluate.py packet --mode judge` from the candidate's VISIBLE output
  (reply, structured options, receipts shown, requests waiting, question asked) under the label
  `anonymous-A`, plus the application's wardrobe as it stood before the request. It gets no tool trace, no
  reasoning, no prompt and no model or profile name; packets are searched for those after the run.
- **Different model.** The bundle names the judge ("Codex judges taste") and forbids a candidate grading
  itself. Within the application's gateway that becomes: the registry's OpenAI route first, then the other
  registry routes, taking the first that answered the text probe and did NOT answer that case's candidate.
  Each result records the judge's route, the candidate's routes and whether they share a provider. When no
  such route is left, the case is reported as not judged. One judge pass per case is not a reliability
  study; the bundle's repeated and pairwise protocols are not run by this harness.
- **Split.** A candidate input of one split cannot hold a case of the other (guard in `candidateInput`).
  `freeze` is accepted only on evidence: a published development run of all 45 cases with real inference,
  every case passed or failed (none unrun or unjudged), a clean isolation audit, made against exactly the
  digests being frozen. `holdout` runs once: it refuses a subset, a scripted run and a run before `freeze`;
  it refuses when the corpus, the harness, the application source, the journey helpers and doubles the
  harness runs on, the owner's data, the lockfile or the inference configuration differ from what `freeze`
  recorded; and it writes `results/holdout/LEDGER.json` before the first held-out case is shown, which is
  what refuses a second run.

`adapter-check` exercises the adapters of the DEVELOPMENT behavioural cases without a model: the scripted
driver issues, as the owner, the command the owner's sentence states, and the outcome is read from
application state. Its output is a ledger check, never a case result. No held-out case is run in any form
before the holdout run, so the held-out adapters run for the first time in that run; an adapter that fails
there leaves its case reported as not run.

A scenario the application cannot be put into is not replaced by a nearer one: the adapter reports the case
as not run with the reason (`UnsupportedScenario`). Known today: B018 needs a pause that began fourteen
days ago, and the application refuses a pause starting in the past while nothing makes time pass.

## Scoring

Per case, `results/<split>/.../cases/<id>/result.json` holds:

- `deterministic`: checks from application state and receipts. For the 18 behavioural cases the adapter
  (`src/drivers/`) reads the outcome through the public API and the bundle's own
  `evaluate.py check-state` compares it with the corpus's state assertions. A structured board is checked by
  the bundle's `check-candidate` (fixture world) or the same rules against the application's wardrobe (real
  stock). Every run is also checked for receipts shown that are not stored, and garments created unasked.
- `taste`: the judge's verdict, six scores, hard violations and findings, or why it was not judged.
- `inference`: `real` (which gateway routes answered, tokens, digests of each call), `none_answered`, or
  `scripted`.
- `status`: `passed` only when real inference answered, every deterministic check that applies completed
  and none failed, and the judge's verdict is `pass` with no hard violation. `failed` on a failed
  deterministic check or a judge verdict of `revise`, `fail` or `insufficient_evidence`. Otherwise
  `not_run`, with the reason: this includes a deterministic check that did not complete, and a board that
  was asked for and answered in prose only, whose count and garments cannot be checked mechanically. A
  scripted run never produces `passed`: its ledger check is reported in a column of its own.

Taste and accounting are never merged into one number: an outfit that fails a deterministic check fails
whatever the judge thought of it.
