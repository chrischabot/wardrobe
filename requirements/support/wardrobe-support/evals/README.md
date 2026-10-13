# Garderobe evaluation suite

This private suite tests whether wardrobe advice suits Chris and whether routine observations produce correct accounting without requiring him to maintain the system. It contains 64 cases: 40 adapted from historical conversations and 24 constructed from his September 15 decisions, full profile, and requested features. Codex judges taste; deterministic checks cover explicit inventory constraints and observed application state.

## Evidence and scope

The supplied export contains 492 conversations dated from October 18, 2024 through June 2, 2026. A title and owner-message keyword scan identified 98 candidate conversations. The suite selects 42 exact owner-message excerpts from 13 conversations; it is not an exhaustive annotation of every fashion discussion. Each excerpt retains its conversation ID, message ID, date, source position, and source-message hash.

The complete September 14 profile is copied unchanged into `sources/chris-wardrobe-profile.md`. Its SHA-256 is `e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198`. The September 15 decisions are applied separately through `sources/owner-amendments.md`. Historical preferences can evolve: an old watch inquiry does not override the later absence of watches, and historical leather-shoe use does not clear an active restriction.

All wardrobe and scenario fixtures are constructed test data. They do not assert that the owner still owns an item or wears a historical size. Each case states its specific observations; those override the fixture defaults. Missing photos are not reconstructed. The export's assistant `text` field can include internal thinking; calibration candidates use only structured `content` parts with `type: "text"`. Tool results and internal reasoning are excluded from those candidate answers.

## Contents

The package contains these assets:

- `cases.json` contains prompts, scenario state, source references, and judge criteria.
- `sources/evidence.json` contains exact historical excerpts and labeled current-decision paraphrases.
- `sources/manifest.json` records source hashes, coverage, selection method, and dates.
- `sources/chris-wardrobe-profile.md` and `sources/owner-amendments.md` supply the complete active context.
- `fixtures/wardrobe.json` supplies synthetic stock and garment identities.
- `fixtures/state-assertions.json` specifies expected application outcomes for 18 behavioral cases.
- `judge.md` defines independent, evidence-based Codex judgments.
- `evaluate.py` prepares packets and validates sources, structured candidates, observed state, and judgment format.
- `sources/calibration-candidates.json` and `results/initial-judge-review.json` retain eight actual historical replies and the initial Codex judgments.
- `sources/garderobe-replacement-design.revision-3.md` preserves the specification before the authorized edits.

The case catalogue is also available as [readable cases](cases.md). The [initial judge review](results/initial-judge-review.md) explains what the first eight historical responses reveal.

## Candidate and judge separation

There are 45 development cases and 19 held-out cases. Historical conversations belong entirely to one split. Initial calibration uses development conversations only. A candidate receives the complete profile, owner amendments, fixture state, and request. It does not receive source feedback, judge criteria, expected state assertions, or historical candidate answers. The judge receives those evaluation materials after the candidate finishes.

The holdout measures generalization to withheld tasks and feedback, not ignorance of the owner's profile: the full profile is deliberately supplied to every candidate. A packet is the isolation boundary. When running a held-out candidate, do not give it filesystem access to this suite or attach the case catalogue. Record a candidate's exposure if a test is later used for tuning and move that case out of the untouched holdout. Inspecting holdouts as the judge does not make them candidate input.

## Run the evaluations

Use Python 3 from the project directory to validate the source assets:

```bash
python3 evals/evaluate.py validate
python3 evals/evaluate.py list
```

Prepare an isolated candidate packet:

```bash
python3 evals/evaluate.py packet --case H001 --mode candidate \
  --output evals/packets/H001-candidate.json
```

Run the chosen candidate assistant against that packet. Save its complete output, exact model/profile and prompt versions, date, run ID, elapsed time, and any tool evidence in a run directory. Board outputs use this structure:

```json
{
  "response": "A short introduction to the options.",
  "options": [
    {
      "id": "option-1",
      "garment_ids": ["shirt-moss", "trouser-beige", "belt-brown",
        "sock-navy", "shoe-navy"],
      "explanation": "Why this particular combination works."
    }
  ]
}
```

The example demonstrates the schema only; it is not a complete three-option answer to H001. A smaller-than-requested board includes `shortage_reason`, which the judge checks against feasibility. Prose does not establish a successful write. Command cases need the application's actual receipts and observed state when testing an implementation.

Check the structured inventory facts and prepare the judge packet:

```bash
python3 evals/evaluate.py check-candidate --case H001 \
  --candidate RUN_DIRECTORY/candidate.json
python3 evals/evaluate.py packet --case H001 --mode judge \
  --candidate RUN_DIRECTORY/candidate.json \
  --output RUN_DIRECTORY/judge-packet.json
```

Ask Codex to read the judge packet and return the judgment specified in `judge.md`. Do not ask the candidate to grade its own output. The script does not call a model or require API credentials. It deliberately leaves inference to Codex or a later authorized application adapter; no provider billing path is silently selected.

For behavioral integration cases, the adapter collects actual outcomes under `observed` and records `provenance.source: "application_adapter"`, a `run_id`, and retained `artifact_paths`. Check that record with the following command:

```bash
python3 evals/evaluate.py check-state --case B004 \
  --file RUN_DIRECTORY/observed-state.json
```

A model-generated prediction of the expected state is not a passing integration test. Provenance fields describe where to inspect evidence; they are not proof by themselves. The checker compares normalized adapter observations to the semantic expectations in `state-assertions.json`. It does not implement the wardrobe ledger.

## Taste evaluation

Score personal fit, composition, comfort and fabric, variety and scope, practical usefulness, and voice and teaching on a one-to-five scale. The judge can mark a dimension inapplicable, request further evidence, or accept two different combinations as equally good. Every material judgment cites exact candidate text and relevant source evidence. Keep hard violations separate from subjective scores.

The initial release targets are no hard violations, personal fit and practical usefulness of at least four in 80% of repeated applicable cases, and at least one recommendable option in every feasible full-board case. These are proposed starting thresholds, not achieved results. Feature/accounting cases can have inapplicable taste dimensions and are assessed through their behavioral contract.

Repeat a representative group at least five times, including a quiet outfit, a dramatic brief, a swap, a depleted wardrobe, a purchase judgment, and a correction. For model comparisons, use identical snapshots and anonymous labels, reverse pairwise presentation order, permit ties, and retain individual judgments. Include repeated judge passes so disagreement is visible. Record whether candidate and judge share a model family. A single pass from one judge does not establish reliability or agreement with the owner across all situations.

Do not convert the profile into a fashion formula. Brown remains welcome despite the repeated-brown failure. Pink can be welcome generally and wrong for a particular interview. A quiet white-tee outfit can work; three competing statement colors can fail. Formality tension can succeed without a tie, and a tie can work without business signaling. The explanations must be about the actual clothes and circumstances.

## What has been run

Source, profile, split, packet-isolation, and visible-response extraction checks pass. Codex has judged eight historical replies using the complete profile and current amendments. Those reviews expose rubric behavior and historical failure patterns; they are not a candidate-model comparison, repeated judge calibration, or evidence that the replacement application passes any scenario. No replacement application exists in this workspace yet.

The first end-to-end application run must collect real receipts, state transitions, board outputs, and Calendar read-backs. It must also demonstrate missing-confirmation tolerance, weekly reset exceptions, cross-client duplicate merging, authoritative late observations, automatic future repair, and all six feature journeys.

## Rebuild the source assets

The source scripts use the explicitly supplied local files. They do not call historical tools or external services. Rebuilding is appropriate after a reviewed source update:

```bash
python3 evals/scripts/build_corpus.py
python3 evals/scripts/extract_calibration.py
python3 evals/evaluate.py validate
```

The specification edit script is an archived one-time migration from revision 3. It refuses to reapply after revision 4; later design edits require an explicit review rather than running that migration again.
