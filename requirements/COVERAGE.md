# Requirement coverage audit

This document records an independent audit of `requirements/CHECKLIST.md` against the revision 4 specification, the September 15 owner amendments, the owner profile, the evaluation instructions, the usage research and the kickoff instructions. It was produced by reading the cited code and tests, not by trusting the checklist's wording. The checklist rows themselves stay owned by each area's thread; this document says whether each row's claim holds, lists requirements with no row, and records the document and inventory checks. Final acceptance updates this document when rows are re-audited.

- Audited commit: `8445a1e9d1958da5bc9c307f2c60d727150bf2c9` on `garderobe-rebuild` (5 October 2026); updated at final acceptance on `9b1d4fb485452f899712e997978164f011fb5557` (12 October 2026).
- Scope: all 1,244 checklist rows (at `9b1d4fb48545`: **736 marked implemented, 440 partial, 68 blocked, 0 open, 0 blank cells**; at `8445a1e9`: 692 implemented, 388 partial, 128 open, 36 blocked).
- Method: the row audit read the files and compared every claim against the source and tests; final acceptance re-verified the updated checklist rows and executed every repository suite from a clean `npm ci` install of the committed `garderobe-rebuild` tip (`9b1d4fb485452f899712e997978164f011fb5557`), recording exact commands, exit codes, test counts, and failure owners below.
- Verdicts: `verified` (the row's claim, including its stated status and limitation, is accurate), `weaker` (something exists but does less than the row claims, or the cited test does not really exercise it), `unsupported` (the cited code or test is absent or does not address the requirement).
- A `verified` verdict on a row whose status is partial, open or blocked means only that the row describes its own state honestly. Such a row is still not implemented and is listed as a gap.
- Depth: the audit was done in two passes. The first read each area's code and tests. Because some rows had then been confirmed by test title only, a second pass re-read the cited test body for every row whose evidence did not already state what the test asserts (459 rows), rewrote those evidence cells and changed twelve verdicts from verified to weaker. No row is left resting on a test title. Remaining limits: rows whose evidence already described the assertions were not re-read in the second pass, and for some re-read rows the implementation line reference is carried over from the first pass while the verdict rests on the test body.

## Where everything is

| File | Contents |
| --- | --- |
| `requirements/COVERAGE.md` (this file) | Result summary, owner questions, document hashes, inventory accounting, unmapped-requirement summary |
| `requirements/coverage-audit/gaps/<area>.md` | The gap report, one file per owning area: `domain`, `daily`, `api-mcp`, `assistant`, `media-studio`, `ios`, `deployment`, `tests`, `evaluation`. Each gap has the row, the source line, the evidence path and what would close it. |
| `requirements/coverage-audit/rows/<part>.md` | The verdict and evidence for every checklist row, in checklist order, in seven parts (A to G), each with its own list of unmapped requirements |

## Result

| Part | Checklist rows covered | Rows | Verified | Weaker | Unsupported |
| --- | --- | --- | --- | --- | --- |
| A `rows/A-domain.md` | S05, S08, AM, PR | 229 | 203 | 26 | 0 |
| B `rows/B-daily.md` | S01, S02, S07, S09 | 147 | 125 | 22 | 0 |
| C `rows/C-assistant.md` | S06, S10, S12 | 210 | 166 | 44 | 0 |
| D `rows/D-api-mcp-identity.md` | S04, S13, S15 | 168 | 141 | 27 | 0 |
| E `rows/E-ios-media.md` | S03, S11 | 123 | 109 | 14 | 0 |
| F `rows/F-deployment-acceptance.md` | S14, S16, S17, S19 | 172 | 157 | 15 | 0 |
| G `rows/G-coverage-evaluation-research-kickoff.md` | S18, S20, S21, EV, R, KO | 195 | 177 | 18 | 0 |
| **Total** | | **1,244** | **1,078** | **166** | **0** |

- All three previously `unsupported` rows (`S01-005`, `S06-076` and `S21-012`) were corrected in `d0356f7ed87521ac156ce9c33df2cdee3fdbf853`, verified against the committed tree, and updated in `coverage-audit/rows/{B-daily,C-assistant,G-coverage-evaluation-research-kickoff}.md`:
  - `S01-005` (`implemented`): citations updated to `packages/domain/src/availability/estimator.ts`, `packages/domain/src/handlers/wear-care.ts`, `packages/daily/src/repair.ts`, `packages/daily/src/calendar/projector.ts`, `packages/domain/test/import.test.ts`, `packages/domain/test/availability.test.ts`, `packages/domain/test/wear.test.ts`, `packages/daily/test/repair.test.ts`, and `packages/daily/test/calendar.test.ts`.
  - `S06-076` (`partial`): citations updated to `packages/assistant/src/agent/assistant.ts`, `packages/assistant/src/jobs/runner.ts`, `packages/assistant/src/recall/projection.ts`, `packages/assistant/src/recall/ai-search.ts`, `packages/media/src/store.ts`, `packages/assistant/test/photo.test.ts`, `packages/assistant/test/adapters-jobs.test.ts`, and `packages/assistant/test/search-projection.test.ts`.
  - `S21-012` (`implemented`): citations updated to `packages/assistant/src/commands/feedback.ts`, `packages/domain/src/commands/service.ts`, `migrations/0200_assistant_core.sql`, `packages/assistant/test/commands.test.ts`, `packages/assistant/test/journeys.test.ts`, and `tests/journeys/test/09-comfort-feedback.test.ts`.
- All 128 previously `open` rows were audited and transitioned to `implemented`, `partial`, or `blocked` with concrete committed file citations; `node tools/check-checklist.mjs` passes with exit code 0 on a clean checkout (`checklist ok: 1244 rows; implemented 736, partial 440, blocked 68, open 0`).
- Most of the 166 weaker rows are marked `implemented`. At least nineteen are citation-only: the behaviour exists and is tested, but not by the files the row cites (listed at the end of `coverage-audit/gaps/tests.md`).
- The twelve rows the second pass moved from verified to weaker are S05-018, AM-030, S06-010, S06-080, S10-062, S10-070, S13-022, S13-047, S15-031, S18-017, R43 and KO-024.
- Joining current `requirements/CHECKLIST.md` statuses at `9b1d4fb48545` with the row audit verdicts across `coverage-audit/rows/A..G` yields the exact status-by-verdict cross-tabulation:
  - **`implemented` (736 rows):** **595 `verified`**, **141 `weaker`**, **0 `unsupported`**.
  - **`partial` (440 rows):** **415 `verified`**, **25 `weaker`**, **0 `unsupported`**.
  - **`blocked` (68 rows):** **68 `verified`**, **0 `weaker`**, **0 `unsupported`**.
  - **`open` (0 rows):** **0**.
  - **Total (1,244 rows):** **1,078 `verified`**, **166 `weaker`**, **0 `unsupported`**.

The findings with the widest effect, each detailed in the gap file named:

1. Changes asked for in conversation or by a connected assistant wait for the owner's confirmation in the app, against the specification's "take effect immediately, with an undo" (see Owner questions below).
2. Outfits are ranked by each garment's own availability, not joint availability (S05-057, `gaps/daily.md`).
3. No Workflow exists; long work runs in the cron handler and `waitUntil` (S04-002, S04-009, S13-030, `gaps/deployment.md`).
4. Several assistant capabilities marked implemented are library code with no production caller: browser policy, claim assessment, model probes, Drive, inventory export (`gaps/assistant.md`).
5. The weather skill and its typed tools reach neither a model nor the assistant (S07-005, `gaps/daily.md`).
6. MRTR and the 2026-07-28 outbound MCP contract are not implemented; `garderobe_ask` returns no evidence or structured objects; two stream objects are never emitted (`gaps/api-mcp.md`).
7. The importer accepts only the profile and the inventory sheet, and the reconciliation report lacks most of the sections the specification lists (S16-009, S16-015, `gaps/domain.md`).
8. Every media test image is synthetic and the owner's 127 garments have no image; no media provider is wired in the Worker (`gaps/media-studio.md`).
9. No device run of the iOS client of any kind (`S03-082`, `gaps/ios.md`). Bounded GitHub-hosted macOS Xcode builds and simulator tests ran on `garderobe-rebuild`, while local Linux checks skip Swift compilation (`swift: command not found`) and physical-device Sign in with Apple / Keychain / camera checks remain unrun.
10. Since `8445a1e9`, the evaluation harness and application adapter (`evals/`), the five-seed local MCP simulation (`tests/simulation/`), the functional/UX journey suite (`tests/journeys/`), the adversarial test suite (`tests/adversarial/`), the Codex/Claude Code integration plugins (`integrations/`), and the Rust Ferrite port (`ferrite/` and `deploy/ferrite/`) have all landed on `garderobe-rebuild`. What remains unlanded, parked, or blocked on external credentials is itemized in the sections below.

## Owner questions

These need the owner's answer; no code or checklist change can settle them.

### 1. Is confirmation in the app the intended rule for changes asked for in conversation and by connected assistants?

What the build does. In conversation, only a wear or wash report in the owner's own words is recorded at once. Every other change (adding, correcting, moving or retiring a piece, an arrival, a rule, a day brief, a profile fact, a measurement, a restriction, an order, a return, a reminder, an undo) becomes a request the owner confirms in the app under Settings, Requests to confirm. A connected assistant's typed command follows the same allow-list and can never confirm.

Where the code cites an owner decision.

- `packages/assistant/src/policy/classes.ts:2`: "How a change asked for in conversation takes effect (the owner's decision of 2026-10-01)."
- `packages/assistant/src/context/mandatory.ts:36-38`: the model's standing instructions for the two classes.
- `packages/contracts/src/ext/api.ts:1169-1175`: "Since 2026-10-03 a connected assistant's typed command (`garderobe_command`) follows an allow-list ...".
- `requirements/CHECKLIST.md` rows S13-051 and S13-054: "since 2026-10-02 ... per the owner's sensitive-change decision".
- `apps/worker/src/mcp/server.ts:285-308` and `apps/worker/src/proposals/` implement it.

No such decision is recorded in `requirements/`. `requirements/support/wardrobe-support/evals/sources/owner-amendments.md` holds only the 15 September decisions, and no checklist row states the confirmation flow as a requirement.

Specification lines it contradicts (`requirements/garderobe-replacement-design.md`):

- L316: "Explicit directions take effect immediately, with an undo action rather than a confirmation ritual."
- L334: "A later explicit correction updates the relevant structured fact immediately and records a profile amendment with its provenance."
- L629: "'Log the order' authorizes intake. ... Arrival is a separate observation, including a simple sentence from the owner."
- L677: "Apply direct statements of discomfort immediately to the relevant recommendation context."
- L841: "write-enabled clients can execute authorized intents under the same policy as the app."
- L858 and L862 (MRTR `input_required` and `inputResponses`), which the flow replaced.

Affected rows: S06-009, S06-030, S06-032, S10-050, S10-085, S13-036, S13-051, S13-054, S13-055, and the notes on S10-051 and S10-083.

Consequence of each answer. If the owner confirms the decision, it should be added to the requirement documents as a dated amendment and these rows reworded or superseded. If not, the conversation and MCP paths need to record explicit owner directions immediately with undo, keeping confirmation only where the specification itself asks for it.

### 2. Smaller points only the owner can settle

- The import report lists thirteen profile-versus-inventory conflicts, three of which need the owner (see Inventory accounting below), and three sock rows with no stated quantity.
- Five usage-research thresholds are stored as `pending_reconciliation` and not applied (R11, R20; `packages/domain/src/import/profile.ts:253-257`).
- Usage research L352 leaves open whether five options a day is right in winter; no row records it.
- START-HERE L11, "No public publication or external messages", has neither a row nor a "superseded" note.
- The bundle's evaluation README L26 lists `sources/garderobe-replacement-design.revision-3.md`, and the specification at L1222 and L1248 refers to two peer-review JSON files; none of the three is in the supplied archive.

## Supplied documents

Checked on 5 October 2026 against the originals in the project's `.attachments/` directory with `sha256sum`, `cmp` and `node tools/verify-documents.mjs --attachments <dir>`; every command exited 0.

| Document | SHA-256 | Bytes | Result |
| --- | --- | --- | --- |
| `requirements/garderobe-replacement-design.md` | `7f47ffd7aa5a7bcd92738c4eaa48d2ec0af79486440f490790007a8678558238` | 212,448 | Byte-identical to the original attachment |
| `requirements/chris-wardrobe-profile.md` | `e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198` | 14,960 | Byte-identical to the original attachment; equals the hash the specification and the evaluation README record |
| `requirements/wardrobe_inventory_clean.csv` | `ca9a5e06edbb2646ad91f102cb242a81b1776bd39e86e99300c0eb387254c946` | 21,800 | Byte-identical to the original attachment |
| `requirements/wardrobe-requirements-and-evals.tar.gz` | `28a6c8705c7f8a829602c5083c942dd12355686aff0b8476b33b80ef21698063` | 376,966 | Byte-identical to the original attachment |

- `requirements/SHA256SUMS` matches all four files.
- A fresh extraction of the archive into a scratch directory is identical to `requirements/support/` (`diff -r`, 47 files, no difference, no extra file).
- The copies of the specification, profile and inventory inside the bundle are identical to the supplied ones (five bundled copies).
- The brief mentions `data/README.md` for the hashes. That file does not exist on `garderobe-rebuild`; the hashes are recorded in `requirements/SHA256SUMS`, and the supplied documents live in `requirements/`, not `data/`.

## Inventory accounting

The CSV was parsed independently (Python `csv`, not the importer) and compared with `data/import/inventory-import-report.json`.

| Check | Result |
| --- | --- |
| Lines in the file | 132 physical lines, 132 CSV records, no blank record |
| Non-data lines | 2 (line 1 sheet title, line 2 column header) |
| Data rows | 130 |
| Report lists every line exactly once | Yes, lines 1 to 132 |
| Imported as a garment | 127 rows |
| Merged into another row's garment | 3 rows: line 63 into 62, line 66 into 65, line 75 into 74 (each a "pair 2" of the same Proper Cloth trouser with identical colour, fabric, size and status) |
| Held or dropped | 0 |
| Garments | 127; every garment cites its source lines and the cited lines equal the rows that point at it; no garment without a source row |
| Units | 144 (trousers 25 units in 22 garments; socks 29 units in 15 garments from the sheet's "2x", "3x", "4x" notes) |
| Categories (source rows) | footwear 7, shirt 43, trousers 25, outerwear 25, socks 15, accessories 15 (belt 3, pocket square 1, scarf 6, tie 5) |
| Planning policy | 113 normal, 13 excluded (exactly the 13 rows whose status starts with "Benched"), 1 occasional (the row whose status is "Occasional") |

Exceptions and open points the import report itself records, none of which is an unaccounted row:

- Lines 118, 119 and 120 (socks) state no quantity; one unit each was imported and the question is left for the owner.
- Nine rows (82 to 87, 107, 109, 111) have a Link cell whose URL did not survive the export; no purchase link was recorded.
- Thirteen profile-versus-inventory conflicts are listed (three need the owner: the profile's New Balance 990v6 and 993 are not in the sheet; the profile says Games blazers, a jungle jacket and rugbies were sold while the sheet lists Games blazers and a jungle jacket; garments the profile describes that the sheet lacks). The importer created no garment the sheet does not list.
- The four "Breaking in" welted shoes and boot (lines 3, 7, 8, 9) are imported as owned with a normal planning policy and are kept out of recommendations by the profile's sneakers-only healing restriction rather than by the import. The row audit confirms the restriction is imported and enforced by the validator (`rows/A-domain.md`, owner profile rows; `packages/daily/test/board.test.ts:305` rejects welted shoes).

## Requirements with no checklist row

Each part walked its source text sentence by sentence against the Source cells of its rows. Every table row, endpoint, MCP tool, numbered step, R-number, amendment and profile entry has a row. About 100 individual statements have no row or are covered only by a row whose wording drops a material part; each is quoted with its line in the "Unmapped requirements" section of the part file. Counts: A 9, B 20, C 10, D 14, E 5, F 14, G 30.

The ones that correspond to something missing in the build:

- **Usage research sections 5, 6 and 8 (L146-L248) have no rows at all**; the checklist maps only L278-L348. No counterpart was found in code for: mesh sneakers on hot days (L157), the full-length mac on a dry long walk (L158), rain fitness per garment (L159), the `no_10k_walks` tag on welted shoes (L164), "venting is not logging" (L199), no narration of his own words back (L247), no stock line about professional help (L248), and the ledger fields colour value, temperature, saturation, pattern scale, rain fitness and walk fitness (L209).
- **The owner-confirmation flow has no requirement row** although four test files cover it (see Owner questions).
- **Spec L391** (the weather skill's instructions reach a model and its tools obtain current data) is dropped from S07-005's wording, which is how that row is marked implemented while neither is true. The skill's own `SKILL.md` L28 and L34 have no row.
- **Spec L312** (a store and capture path for dated examples of outfits that worked or were rejected), **L276** ("recording trousers still on the owner's body establishes current use"), **L619** (fit or care claims checked against sufficient surrounding content), **L744** (probing reasoning parameters), **L746** (Gateway limits as a second control), **L812** (mutation responses distinguish success from proposed work), **L849** (`global_fetch_strictly_public` on the deployed configuration), **L893** (do not rebuild a platform capability because it is in preview), **L1051** (the importer classifies), **L1059** (compare records and manually assess boards before cutover), **L1147** (owner feedback corrects the judge's rubric).
- **Profile L28** (every verdict names the gate it passed) and **L95** (the "slides as he walks" clause is not in the stored size note).
- **Evaluation README L89** (provenance fields are not proof by themselves), which matters once the application adapter exists.

## Updating this document

When an area closes a gap it updates its own checklist row. Final acceptance then re-reads the row's code and test, changes the verdict in the part file under `coverage-audit/rows/`, removes or amends the entry in `coverage-audit/gaps/<area>.md`, and updates the totals and the audited commit above.

## Final acceptance verification (`9b1d4fb48545`)

### 1. What landed on `garderobe-rebuild` after the initial audit (`8445a1e9` → `9b1d4fb4`)

- **Evaluation harness and application adapter (`35db1537`, `8fb84644`):** `evals/run.mjs`, `evals/src/*`, `evals/test/harness.test.mjs` (`61/61` self-tests), and `evals/run.mjs adapter-check --strict` (`12/13` development behavioural cases passing deterministically against an in-process application instance; `B018` reported as `not_run` because `pause.start` refuses a past start date and no time-travel route exists).
- **Seeded MCP simulation (`4f3fe400`, `7e7e8625`, `98393b20`, `37e63a49`):** `tests/simulation/` (`@garderobe/simulation`, `30/30` self-tests) plus five 28-day seeded runs across spring, summer, autumn, winter, and cross-trip scenarios in `tests/simulation/results/local/`. Commit `98393b20` fixed `wear.record` undo unit-location restoration (resolving the 41 `garment_conservation` checks in Seed 2), and commit `37e63a49` raised the MCP `trip.propose_packing` subrequest budget and committed the clean Seed 4 rerun (`350 / 350` steps, `12,931` checks passed, `0` failed). `tests/simulation/results/local/README.md` has been regenerated from the five committed `seed-{1..5}.json` artifacts.
- **Adversarial suites (`0f1ac8b0`, `e9d5b102`, `292eb608`, `218df261`, `dfde37fe`, `e09d4cb3`, `b8770e6f`, `743d1d40`):** `tests/adversarial/harness/harness.test.ts` (`7/7`), `tests/adversarial/daily-media/media/` (`5` files, `46/46` tests), and `tests/adversarial/api-mcp/worker/` (`9` files, `247` tests including `08-imports-exports.test.ts` and `09-recovery-confirmation.test.ts` landed in `743d1d40`). Six additional adversarial test files (`07-outbound-ssrf.test.ts`, `08-daily-rules.test.ts`, `09-laundry-trips.test.ts`, `10-returns-pause-export.test.ts`, `11-migration-import.test.ts`, `12-degraded-services.test.ts`, totaling 179 tests) remain unlanded in the shared working tree under `wi_ad60d17763fe0122`.
- **Functional & UX journey suite (`6b640c6a`, `3c3ef99a`) and API/MCP Worker (`c1b57ce8`, `4c49f582`):** `6b640c6a` updated `tests/journeys/` (`14` files, `276` tests) to assert the 2026-10-05 apply-at-once contract. Commit `4c49f582` fixed `D14-2` (`garderobe_ask` turn-id scoping for receipts and pending proposals) and OAuth metadata URL alignment, and commit `3c3ef99a` unflagged `D14-2` in `tests/journeys/test/14-mcp-assistant.test.ts` and skipped `D08-2` in default mode. Per the project finish plan, the assistant apply-at-once implementation (`packages/assistant/`) and the 52-file API Worker + `migrations/0306..0311` batch that imports it remain parked in the shared working tree.
- **Daily service & visual wardrobe (`b883f26f`, `189a95dd`), Codex/Claude integrations (`1ace2dea`), and Rust Ferrite port (`e8bb614c`..`9b1d4fb4`):** `@garderobe/daily` (`450/450`), `@garderobe/media` (`276/276` + `5/5` composite checks), `deploy/ferrite` (`69/69`), and `ferrite/` (`155/155` Rust tests across 18 targets, `ferrite check --json` ok).

### 2. Five-seed local MCP simulation summary (`tests/simulation/results/local/README.md`)

| Seed | Simulated days | Season | Steps run / planned | Step errors | Checks passed | Checks failed | Not applicable | MCP tool calls | Commands | Plan digest | Outcome digest | Real time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2027-03-08 to 2027-04-04 (28) | spring (summer time begins on 28 March) | 351 / 351 | 0 | 12,850 | 0 | 5 | 3,014 | 128 | `2c92379c01f31770` | `94d203fd37719644` | 217 s |
| 2 | 2027-05-31 to 2027-06-27 (28) | early summer | 354 / 354 | 0 | 13,063 | 41 | 4 | 3,107 | 132 | `f6eb348a37466c48` | `91f7dedc92a87140` | 248 s |
| 3 | 2027-07-19 to 2027-08-15 (28) | high summer | 350 / 350 | 0 | 12,725 | 0 | 5 | 3,100 | 138 | `1a85788fff84d6b7` | `3bdbb0fa872a1d5c` | 227 s |
| 4 | 2027-09-06 to 2027-10-03 (28) | autumn | 350 / 350 | 0 | 12,931 | 0 | 3 | 3,033 | 129 | `3580fda298760236` | `e7bb527090c7f90a` | 213 s |
| 5 | 2027-10-11 to 2027-11-07 (28) | late autumn (summer time ends on 31 October) | 355 / 355 | 0 | 13,151 | 0 | 3 | 3,057 | 129 | `2a6dd87d008a37b6` | `1b9702ff458bad71` | 238 s |

- In the committed `tests/simulation/results/local/` artifacts, all **5 seeds complete every planned step** (`1,760 / 1,760` steps, `0` step errors, `64,720` invariant checks passed). Seeds 1, 3, 4 (regenerated after `37e63a49`), and 5 have `0` failed checks.
- The committed `tests/simulation/results/local/seed-2.json` artifact (captured before commit `98393b20`) records `41` failed invariant checks on `Heavy rustic linen — sage`: `availability.what_the_owner_made_unavailable_stays_unavailable` (`40` times, starting at step 82 `undo_a_report` on day 6) and `laundry.a_late_piece_moves_exactly_one_unit_home` (`1` time at step 122 `laundry_late_return` on day 9), caused by `command.undo` of `wear.record` restoring a unit that was at the laundry service to `home/clean`. Commit `98393b20` fixed `wear.record` undo unit-location restoration in `packages/domain/src/handlers/wear-care.ts`, and `tests/simulation/reports/SUMMARY.md` documents that defect and fix; `tests/simulation/results/local/seed-2.json` itself has not been re-recorded in git.
- Live simulation against a deployed Cloudflare or Ferrite endpoint (`node tests/simulation/bin/run.mjs --target https://...`) has **not** been run.

### 3. Evaluation corpus status (64 cases: 45 development, 19 holdout)

- **Harness self-test (`node evals/run.mjs selftest`):** **61 passed, 0 failed** (`exit 0`). Verifies the 45-case development split and 19-case holdout split, 27 `owner_real_stock` and 37 `synthetic_fixture` worlds, candidate/judge route disjunction across 3 gateway routes (`deepseek-v41-flash`, `fable-5-1`, `gpt-6-astra`), holdout one-shot lock (`the holdout has not been run`), and support-bundle immutability.
- **Deterministic adapter check (`node evals/run.mjs adapter-check --strict`):** **12 passed, 0 failed, 1 `not_run` (`B018`)** (`exit 0`). `B001`, `B002`, `B003`, `B005`, `B006`, `B007`, `B009`, `B010`, `B011`, `B015`, `B017`, and `B019` pass their deterministic ledger and receipt checks; `B018` is recorded as `not_run` because `pause.start` refuses a past start date (`400 invalid_command: a pause cannot start in the past`) and no clock-advance route exists.
- **Live 64-case candidate & judge model runs:** **Blocked** (`exit 2`). Running `node evals/run.mjs development` reaches Cloudflare AI Gateway `garderobe-dev`, which returns HTTP 401 `{"error":{"type":"authentication_error","message":"Invalid Anthropic API Key"}}` on route `anthropic/claude-odango-eap`.
- **Taste judging & holdout split:** Under the conservative default (owner decision `dec_1a9c98a0a9562d6d` open), **taste is reported as "not judged"** and the **19-case holdout split has not been run** (`evals/results/holdout/.holdout-runs.jsonl` is absent).

### 4. Clean-install suite verification on committed tip `9b1d4fb48545`

Every suite below was executed in a clean checkout of `garderobe-rebuild` (`9b1d4fb485452f899712e997978164f011fb5557` plus this final-acceptance update) with a fresh `npm ci` (`added 442 packages in 7s`, `exit 0`), free of the uncommitted working-tree files in the shared workspace.

| Suite / Command | Exit code | Result & counts | Failure owner & root cause on clean committed tip |
| --- | --- | --- | --- |
| `npm ci` | `0` | 442 packages installed cleanly | — |
| `npm run verify:documents` (`node tools/verify-documents.mjs`) | `0` | 4 attachment SHA-256 digests, 47 support bundle files, and 5 bundled copies verified | — |
| `npm run verify:checklist` (`node tools/check-checklist.mjs`) | `0` | `checklist ok: 1244 rows; implemented 736, partial 440, blocked 68, open 0` | — |
| `npm run check:import-report` | `0` | `import report is up to date` (130 data rows → 127 garments, 3 merged, 144 units) | — |
| `npm run check:contracts` (`npm run check:generated -w @garderobe/contracts`) | `1` | `out of date generated/garderobe-contracts.schema.json`, `out of date generated/swift/GarderobeContracts.swift` | **API & MCP (`wi_981bd507c48d334d`):** commit `4c49f582` added 3 schemas (`AcknowledgedRestrictionIds`, `AssetImageWithLocationQuery`, `ProposalDecisionWithRestrictionsRequest`) to `packages/contracts/src/commands.ts` without committing regenerated contract outputs |
| `npm run typecheck` | `1` | 9 of 10 workspaces pass (`exit 0`); `@garderobe/adversarial-tests` fails at `api-mcp/worker/test/05-injection.test.ts(63,10): TS2305` (`setJobModelsForTests` missing from `apps/worker/src/scheduled/assistant.ts`) | **Adversarial (`wi_ad60d17763fe0122`) / API & MCP (`wi_981bd507c48d334d`):** `b8770e6f` landed `05-injection.test.ts` importing `setJobModelsForTests`, which lives in the parked `apps/worker/` changes in the shared working tree (where `npm run typecheck` exits `0` across all 10 workspaces) |
| `npm test -w @garderobe/assistant` | `0` | 32 test files passed (32), **320 tests passed (320)** | — |
| `npm test -w @garderobe/contracts` | `1` | 1 test file: **15 passed, 1 failed (16)** (`are up to date with the zod schemas and generate deterministically`) | **API & MCP (`wi_981bd507c48d334d`):** same stale generated contract files from `4c49f582` |
| `npm test -w @garderobe/daily` | `0` | 31 test files passed (31), **450 tests passed (450)** | — |
| `npm test -w @garderobe/domain` | `0` | 18 test files passed (18), **186 tests passed (186)** | — |
| `npm test -w @garderobe/media` | `0` | 31 test files passed (31), **276 tests passed (276)** + `composite-example.mjs --check` **5 passed (5)** | — |
| `npm test -w @garderobe/worker` | `0` | 27 test files passed (27), **256 tests passed (256)** | — |
| `npm test -w @garderobe/simulation` | `0` | **30 tests passed (30)**, 0 failed | — |
| `npm test -w @garderobe/evals-check` | `0` | `selftest` **61 passed (61)**; `adapter-check --strict` **12 passed, 0 failed, 1 `not_run` (`B018`)** | — |
| `node --test deploy/test/guard.test.mjs` | `0` | **8 tests passed (8)**, 0 failed | — |
| `node --test deploy/ferrite/test/*.test.mjs` | `0` | **69 tests passed (69)**, 0 failed | — |
| `node --test integrations/codex/test/plugin.test.mjs` | `1` | **24 passed, 1 failed (25)** (`m.isUnboundedChange is not a function`) | **Integrations (`wi_3fb5671a3a505107`) / API & MCP (`wi_981bd507c48d334d`):** `1ace2dea` calls `isUnboundedChange` on `apps/worker/src/mcp/policy.ts`, which is part of the parked API Worker apply-at-once change |
| `npm test -w @garderobe/journey-tests` (default mode) | `1` | 9 files passed, 5 failed (14): **246 passed, 29 failed, 1 skipped (276)** (`07-trips-packing`: 14 failed; `08-returns-exchanges`: 5 failed; `09-comfort-feedback`: 2 failed; `11-conversation-capture`: 6 failed; `14-mcp-assistant`: 2 failed) | **Journeys (`wi_75c0126a78317a20`) / Parked Assistant (`wi_18947932bb1272b9`) & API (`wi_981bd507c48d334d`):** `6b640c6a` landed 2026-10-05 apply-at-once journey assertions while the assistant and API Worker apply-at-once implementations remain parked in the shared working tree (where default mode passes `275/276` with 1 skipped `D08-2`) |
| `npm run test:strict -w @garderobe/journey-tests` (strict mode) | `1` | 9 files passed, 5 failed (14): **245 passed, 31 failed (276)** (same 29 failures plus `DEFECT D08-1` and `DEFECT D14-3`) | Same parked apply-at-once dependency as default mode, plus open defects `D08-1` / `D08-2` (Daily / API) and `D14-3` (Assistant / API) |
| `npm test -w @garderobe/adversarial-tests` | `1` | `shared`: **7 passed (7)** (`1` file); `daily-media/media`: **46 passed (46)** (`5` files); `api-mcp/worker`: 4 files passed, 5 failed (9), **220 passed, 17 failed, 8 expected fail, 2 skipped (247)** (`03-replay-races`: 1 failed; `04-time`: 4 failed; `05-injection`: 9 failed; `08-imports-exports`: 1 failed [`D08-3`]; `09-recovery-confirmation`: 2 failed [`R09-1`, `R09-2`]) | **Adversarial (`wi_ad60d17763fe0122`) / Parked Assistant (`wi_18947932bb1272b9`) & API (`wi_981bd507c48d334d`):** `04-time` (4 failures), `05-injection` (9 failures), `08-imports-exports` (`D08-3`), and `09-recovery-confirmation` (`R09-1`, `R09-2`) assert fixes and 2026-10-05 apply-at-once behavior whose implementation is in the parked `apps/worker/` and `packages/assistant/` changes; `03-replay-races` has 1 parallel board-publication race failure |
| `npm run test:daily-media -w @garderobe/adversarial-tests` | `0` | 5 test files passed (5), **46 tests passed (46)** | — |
| `npm run test:api-mcp -w @garderobe/adversarial-tests` | `1` | 4 files passed, 5 failed (9): **219 passed, 18 failed, 8 expected fail, 2 skipped (247)** | Same 17 failures as above plus 1 concurrent confirmation-vs-rejection race in `03-replay-races.test.ts` |
| `ferrite --version` / `ferrite check --json` / `ferrite test` (`cwd: ferrite`) | `0` | `ferrite 0.1.20`; `ferrite check --json` `"ok": true` (0 errors, 0 warnings); `ferrite test` **155 passed, 0 failed across 18 targets** | — |
| `bash ios/Tools/check.sh` | `127` | `ios/Tools/check.sh: line 21: swift: command not found` | **iOS (`wi_88628492e804843d`) / Linux sandbox environment:** Swift toolchain is not installed on the Linux sandbox; Xcode/Swift checks run on GitHub-hosted macOS runners (`.github/workflows/ios.yml`) |

### 5. Remaining deployment and iOS acceptance checklist

No unrun cloud, live-gateway, Ferrite-hosted, or Xcode/device check is claimed as passed. The exact remaining steps to complete live deployment, live evaluation, and Apple-platform acceptance are:

1. **Reconcile and land the remaining working-tree batches on `garderobe-rebuild`:**
   - Regenerate and commit `packages/contracts/generated/garderobe-contracts.schema.json` and `packages/contracts/generated/swift/GarderobeContracts.swift` (`npm run generate -w @garderobe/contracts`) so `npm run check:contracts` and `npm test -w @garderobe/contracts` exit `0` on a clean checkout.
   - Once the allow-list / 2026-10-05 apply-at-once decision is settled, land the parked assistant (`packages/assistant/`) and API Worker (`apps/worker/`, `migrations/0306..0311`, `packages/contracts/src/ext/api.ts`) batches, the parked `ferrite/tests/conversation_apply.rs` test, and the remaining `D08-1` / `D08-2` / `D14-3` fixes, then re-run `npm test -w @garderobe/journey-tests`, `npm run test:strict -w @garderobe/journey-tests`, and `npm test -w @garderobe/adversarial-tests` from a clean install.
   - Land adversarial batches 7–10 (`tests/adversarial/api-mcp/07-outbound-ssrf.test.ts`, `tests/adversarial/daily-media/08-daily-rules.test.ts`, `09-laundry-trips.test.ts`, `10-returns-pause-export.test.ts`, `11-migration-import.test.ts`, `12-degraded-services.test.ts`) and the iOS local SQLite persistence batch (`ios/GarderobeCore/`).
2. **Cloudflare AI Gateway `garderobe-dev` Unified Billing routing & 64-case evaluation corpus (`EV-015`..`EV-026`, `S12-009`, `S14-051`, `S17-043`, `S19-009`, `S19-010`):**
   - Diagnose and restore the authenticated Unified Billing route on Cloudflare AI Gateway `garderobe-dev` (`gatewayMetadata.keySource = Unified`, where requests carry `cf-aig-authorization` only and no provider key or BYOK fallback, and where route `anthropic/claude-odango-eap` currently returns HTTP 401 `Invalid Anthropic API Key`), without introducing a BYOK provider key unless the owner explicitly authorizes a billing-policy change.
   - Run the 45-case development split end to end: `node evals/run.mjs development --work-dir <dir>` and `node evals/run.mjs freeze --work-dir <dir>`.
   - Once owner decision `dec_1a9c98a0a9562d6d` (independent taste judge route when `fable-5-1` is prohibited) is answered and every development gate passes, run the one-shot 19-case holdout split: `node evals/run.mjs holdout --work-dir <dir> --confirm-holdout-one-shot`.
3. **Cloudflare development deployment & live acceptance (`S04-001`..`S04-048`, `S16-001`..`S16-018`, `S19-001`..`S19-018`):**
   - Provide `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, R2 development bucket credentials, Cloudflare Access credentials, and OAuth/signing secrets in the deployment environment.
   - Run `node deploy/bin/garderobe-deploy.mjs preflight` and `node deploy/bin/garderobe-deploy.mjs apply` to provision and migrate the development D1 database (`garderobe-dev-db`), R2 media bucket (`garderobe-dev-media`), Queues (`garderobe-dev-media-jobs`, `garderobe-dev-media-dlq`), AI Search index (`garderobe-dev-search`), Think Durable Objects, and Worker (`garderobe-dev`), and import the owner profile and 130-row inventory into development D1.
   - Run `node deploy/bin/garderobe-deploy.mjs verify` and record the live verification receipt under `deploy/evidence/`.
   - Run the 5-seed MCP simulation against the deployed development endpoint: `node tests/simulation/bin/run.mjs --target https://<dev-host> --token <mcp-oauth-token> --seed all`.
4. **Optional hosted Ferrite deployment (`deploy/ferrite/`):**
   - With a reachable hosted Ferrite target and gateway secret, run `node deploy/ferrite/bin/garderobe-ferrite.mjs deploy` and `node deploy/ferrite/bin/garderobe-ferrite.mjs verify` to record the live hosted receipt alongside the local 155-test `ferrite test` verification.
5. **Native iOS Xcode simulator & physical-device acceptance (`S03-001`..`S03-085`):**
   - Trigger `.github/workflows/ios.yml` (`gh workflow run ios.yml --ref garderobe-rebuild`) on `macos-15` after landing the iOS local SQLite persistence batch and regenerated `GarderobeContracts.swift`, and verify `bash ios/Tools/check.sh` (all 9 gates: toolchain, contract drift, `swift build`, `swift test`, boundary check, `xcodegen`, `xcodebuild` for iOS Simulator, `xcodebuild test` for `GarderobeAppTests` and `GarderobeAppUITests`, and archive).
   - Configure the Apple Developer team ID and Sign in with Apple entitlement in `ios/project.yml`, build and install onto a physical iPhone pointed at the deployed Cloudflare development backend, and verify live Sign in with Apple, Keychain session persistence, camera/photo-library garment capture, offline command queueing/replay, and Today/Wardrobe/Studio/Conversation screens.
6. **Final merge into `main`:**
   - Once the above gates are green on `garderobe-rebuild`, open, review, and merge the single pull request from `garderobe-rebuild` into `main`.
