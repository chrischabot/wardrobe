# Coverage gaps: test suites (journeys, adversarial, simulation, acceptance cases)

Audited at `garderobe-rebuild` commit `8445a1e`, by reading files; no test was run by this audit, so nothing here says a test passes. The adversarial and simulation threads were working when this was written; entries about missing directories describe the audited commit. "spec" is `requirements/garderobe-replacement-design.md`; "start prompt" is `requirements/support/wardrobe-start-prompt.md`. Per-row verdicts are in `../rows/`; the part letter after each entry says which file.

What holds: `tests/journeys/test/` holds 14 files with 262 `it` or `defect` call sites that run through the real Worker, its real MCP server and OAuth provider in workerd on local D1, KV, R2, queue and Durable Object, with the owner's real profile and inventory. Stand-ins at every external boundary: scripted Open-Meteo, an in-memory Google Calendar, Google OAuth, APNs, test-signed Access assertions and the fake model (`tests/journeys/README.md:51-66`).

## Kickoff deliverables

| Row | Source | What is missing | Evidence | Closes when |
| --- | --- | --- | --- | --- |
| KO-004 | start prompt L3, L19 | No adversarial suite: `tests/adversarial/` does not exist. Package-level pieces exist: `packages/domain/test/adversarial-defects.test.ts` (11 tests; its header refers to `tests/adversarial/defects/ledger.md` and `profile.md`, absent here), `packages/assistant/test/corpus-adversarial.test.ts` (5), `apps/worker/test/assistant-confirmation.test.ts` (6, two adversarial through the real routes). Only forged-owner and command-class tests go through the MCP server. | (G) | An organised suite covers every domain command, API and MCP surface and assistant authority path, and is part of the root test run. |
| KO-005, KO-025 | start prompt L3, L19 | No seeded MCP simulation: `tests/simulation/` does not exist and nothing selects outfits from a seed. Nearest: `apps/worker/scripts/mcp-smoke.mjs` (hand-run, fixed steps, not in `npm test`) and journey 14 (18 fixed tests). | (G) | A seeded run through the MCP server varies outfit choice, availability, weather, calendar and circumstance and checks state and receipts. |
| KO-003 | start prompt L3, L19 | The row says 265 tests and 24 defects; 262 call sites (one in a loop) and 25 defect IDs in `tests/journeys/DEFECTS.md` were counted. One defect is open (D14-2) and one skipped in the default run (D06-2, `tests/journeys/src/defect.ts:28`), so a green default run does not mean no defects. | (G) | The row's counts match a recorded run. |

## Acceptance cases (spec section 17)

- **S17-001** (spec L1069, open): acceptance rests on local tests with stand-ins at every external boundary; `tests/journeys/README.md:63-66` says so.
- **Of the 28 cases at L1075-L1102**, 19 have an end-to-end journey on the local Worker. Seven are package-level only: S17-003 (omitted model reads), S17-008 (laundry racing composition), S17-012 (shopping), S17-013 (intake), S17-014 (personal context), S17-016 (image fidelity), S17-018 (external actions). Two have no end-to-end test: S17-019 (device usability), S17-020 (cost and operations).
- **Platform cases at L1110-L1125**: S17-030 to S17-036 run only as package tests with a fake model; S17-037, S17-039, S17-041 against fixtures; S17-038, S17-040, S17-042, S17-043 (vision and image editing), S17-044, S17-045 have no executed evidence.
- **S17-059** (spec L1145, partial): zero hard violations is asserted on deterministic boards of one scripted week only; D06-2 (three-neutrals limit is a preference in the composer, `DEFECTS.md:20`) is under watch.

## Missing test cases on rows marked implemented

Each names the area whose test file should gain the case; details are in that area's gap file.

- **domain:** overnight wear and timezone change (S05-071, AM-018); `garment.remove_fabricated` (S08-007); delayed retry (S08-022); changed proposal after a committed one (S08-021); scheduled reset against units in storage or disposed (S05-049); size experiences other than Drake's 46 (PR-031 to PR-034); schema enumeration for `user_id` (S15-014, S15-015).
- **daily:** tentative against accepted event (S07-024); brief over inferred occasion (S07-025); laundry delay or arrival repairing a future outfit (S07-057, S08-035); offline observation during pause (S09-040); week rotation beyond garments (S07-056); calendar location not moving the forecast (S07-017); fourteen-day pattern (S07-054); waterproofing claim in model prose (S07-015); trouser single-wear (S07-048); quiet board accepted (S06-014).
- **API/MCP:** OAuth revocation, PKCE, audience and issuer negatives, consent replay and tamper (S13-042, S13-045, S15-012, S15-013); settings model profile and budget (S13-017); `lastCalendarProjection` (S15-034); export record types (S15-041); protocol fallback (S19-007); streaming with `follow=true` (S13-010); a non-null research verdict over MCP (S13-033); S13-004, S13-007, S13-018, S04-035 each omit one clause.
- **assistant:** failing summarizer (S05-020); summary claiming an arrival (S06-020); pre-inference counts (S06-043); pending tool-pair boundary (S06-046); re-proposal after compaction (S06-049); profile, amendments, precedence order (S06-031); `image_backfill` reservation (S12-016); budget exhausted during compaction (S12-018); Gateway budget rejection (S14-057); photo cases (S03-060, S03-061, S17-015); eviction with calendar event and paid image (S17-030); profile edit reaching the next turn (S17-032); reasoning withheld when the fake emits it (S04-036); colliding tool name (S13-064); refresh under concurrency (S13-061).
- **media/Studio:** two-session browser cap (S11-008); preview beside morning composition (S11-027); changing selfie retention (S11-034).
- **iOS:** Wardrobe filters (S03-025); external-effect wording (S03-045); Stop and send (S04-017); `routingLines`, `budgetLines` (S12-021, S10-040); `RecoveryStatusModel` (S15-034); `AppModel.open(url:)` (S09-021); `TemperaturePreviewModel` (R55); UI tests that open Notifications, Requests to confirm, My style, Trips and Returns.

## Test defects and wrong citations

- `apps/worker/test/backup.test.ts:188-189` posts `{ query }` to `/v1/recall/search`; the schema field is `text`, so both recall assertions in the restore test run on an empty search (S15-048).
- The test cited by S13-055 ("asks first, and executes exactly once when the owner confirms") does not exist; S11-035 quotes a Worker test name that does not exist.
- Rows citing tests that do not exercise them: S05-025, S05-081, S08-015, S08-033, S08-024, S04-003, S04-045, S16-018, S17-006, S18-002, S18-004, S18-017, R03, R33, R50, S21-012, S03-020, AM-030, KO-024. The tests that do are named in the row verdicts.
- `apps/worker/test/surfaces.test.ts:310` is titled "records comfort feedback and a return case" but its body contains no return case; AM-030, KO-024 and S01-012 cite it for returns.
- `packages/assistant/test/memory.test.ts:189` carries a comment saying a restore replays the tombstone, but the code beneath performs no restore, so "a restore does not resurrect removed memories" (S06-080) has no test. It closes with a test that backs up, forgets a message, restores and asserts the message is absent.
