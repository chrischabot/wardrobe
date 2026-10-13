# Requirement coverage audit

This document records an independent audit of `requirements/CHECKLIST.md` against the revision 4 specification, the September 15 owner amendments, the owner profile, the evaluation instructions, the usage research and the kickoff instructions. It was produced by reading the cited code and tests, not by trusting the checklist's wording. The checklist rows themselves stay owned by each area's thread; this document says whether each row's claim holds, lists requirements with no row, and records the document and inventory checks. Final acceptance updates this document when rows are re-audited.

- Audited commit: `8445a1e9d1958da5bc9c307f2c60d727150bf2c9` on `garderobe-rebuild` (5 October 2026); updated at final acceptance on `fee6eb1af317` (13 October 2026).
- Scope: all 1,244 checklist rows (at `fee6eb1af317`: **736 marked implemented, 440 partial, 68 blocked, 0 open, 0 blank cells**; at `8445a1e9`: 692 implemented, 388 partial, 128 open, 36 blocked).
- Method: the row audit read the files and compared every claim against the source and tests; final acceptance re-verified the updated checklist rows and executed every repository suite from a clean `npm ci` install at `garderobe-rebuild` tip `fee6eb1af317`, distinguishing the exact committed `fee6eb1af317` results from the shared-workspace results (where uncommitted files exist) and recording exact commands, exit codes, test counts, parked items, and failure owners below.
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
- Joining current `requirements/CHECKLIST.md` statuses at `fee6eb1af317` with the row audit verdicts across `coverage-audit/rows/A..G` yields the exact status-by-verdict cross-tabulation:
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

Consequence of each answer. If the owner confirms the decision, it should be added to the requirement documents as a dated amendment and these rows reworded or superseded. If not, the conversation and MCP paths need to record explicit owner directions immediately with undo, keeping confirmation only where the specification itself asks for it. *(Update at final acceptance: following the 2026-10-05 contract and owner decision `dec_q84451128ec13537`, the owner directed that only the short list of fully understood sentence forms applies at once, while everything else becomes a one-tap proposal confirmed in the app with undo, unparking the assistant and API Worker changes.)*

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

## Final acceptance verification (`fee6eb1af317`)

### 1. What landed on `garderobe-rebuild` after the initial audit (`8445a1e9` → `fee6eb1a`)

- **Evaluation harness and application adapter (`35db1537`, `8fb84644`):** `evals/run.mjs`, `evals/src/*`, `evals/test/harness.test.mjs` (`61/61` self-tests), and `evals/run.mjs adapter-check --strict` (`12/13` development behavioural cases passing deterministically against an in-process application instance; `B018` reported as `not_run` because `pause.start` refuses a past start date and no time-travel route exists).
- **Seeded MCP simulation (`4f3fe400`, `7e7e8625`, `98393b20`, `37e63a49`, `35ef09d4`):** `tests/simulation/` (`@garderobe/simulation`, `30/30` self-tests) plus five 28-day seeded runs across spring, early summer, high summer, autumn, and late-autumn clock-change and trip scenarios in `tests/simulation/results/local/`. Commit `98393b20` fixed `wear.record` undo unit-location restoration, commit `37e63a49` raised the MCP `trip.propose_packing` subrequest budget, and re-running all five seeds on `fee6eb1af317` (`node bin/local.mjs --seeds 1,2,3,4,5 --parallel 5 --out results/local`) completes **`1,760 / 1,760` steps with `64,728` invariant checks passed, `0` failed checks, and `0` step errors**.
- **Assistant (`2bfb2aba`..`daf52d4e`):** Implemented the 8-form owner sentence allow-list and ended-condition allow-list (`dec_q84451128ec13537`), change classes and per-turn applied-change cap (`MAX_APPLIED_CHANGES_PER_TURN`), composite/purchase/return undo and commerce guards (`5d41122f`), single-model routing to `claude-odango-eap` (`9fbc646e`), outbound search restriction-reason refusal (`3aca3ea1`, `I05-5`), tool-call input bounding and failed-submission settlement (`b2f6a501`, `I06-4`, `I06-5`), secret redaction in assistant replies across session, recall, export and context (`2569a4cd`, `I06-2`, `D12-2`), and return-case refund reconciliation on order lines (`fa8b0908`, `daf52d4e`, `D08-1`). `@garderobe/assistant` passes **`36/36` files (`394/394` tests)**.
- **API & MCP Worker (`c1b57ce8`..`fee6eb1a`) and contracts (`b43e004e`, `9427ce1f`):** Wired the 2026-10-05 immediate-apply contract and section-3 confirm policy (`5ada4cdb`, `3dd18061`), aligned `mcp-smoke.mjs` (`7cced16c`, `1e03b534`), added export location opt-in and storage-key stripping (`a8bff49a`), enforced MCP upload-session refusal and asset location stripping (`a117ba0a`, `D10-3`), guarded concurrent identity unlinking (`c3c84354`, `R09-3`), shared the 40-request waiting cap across grants of the same OAuth client (`e518452e`, `M14-6`), validated media rendition derivation graphs before import writes (`227b7b47`, `D08-2`), converted OAuth metadata validation errors into `400 invalid_command` (`ece31159`, `D11-3`), captured `expectedVersionsFor` on submitted proposals and verified `proposal_id` integrity (`1633256c`, `M14-3`, `M14-4`), and enforced per-turn proposal reservation and relayed-turn admission leases in D1 (`9c673eb5`, `fee6eb1a`, `M14-7`, `M14-8`). On the committed `fee6eb1a` tree, `@garderobe/worker` passes **`31/31` files (`280/280` tests)** (and **`282/282` tests** in the shared workspace with 2 uncommitted tests in `apps/worker/test/studio-forecast.test.ts` under `wi_a387a5bbbeb05ad1`), and `npm run smoke:mcp -w @garderobe/worker` passes **`21/21` checks**. Because commits `5d41122f`, `9427ce1f`, `5ada4cdb`, and `3dd18061` updated `packages/contracts/src/ext/{assistant,api}.ts` after `b43e004e` without committing the regenerated outputs, `npm run check:contracts` and `npm test -w @garderobe/contracts` exit **`1` on the pure committed `fee6eb1a` tree** (`15 passed, 1 failed`) and exit **`0` (`16/16` passed) in the shared workspace** where `packages/contracts/generated/*` is regenerated under `wi_981bd507c48d334d`.
- **Functional & UX journey suite (`6b640c6a`, `3c3ef99a`, `dde67272`, `80fe9973`):** All `14` journey test files pass on the committed `fee6eb1a` tree: **`276/276` passed (`0` failed) in strict mode** (`npm run test:strict -w @garderobe/journey-tests`) and **`275/276` passed with `1` skipped (`D06-2` under watch) in default mode** (`npm test -w @garderobe/journey-tests`).
- **Adversarial suites (`0f1ac8b0`..`e4abdc9a`):** `npm test -w @garderobe/adversarial-tests` exits `0` with **`0` unexpected failures**: `shared` passes **`7/7`**, `daily-media/media` passes **`46/46` (`5` files)**, and on the committed `fee6eb1a` tree `api-mcp/worker` passes **`14/14` committed files (`362` passed, `5` expected fail [`L03-2`, `L03-4`, `I05-9`, `I06-7`, `M14-10`], `1` skipped [`I06-6`], `0` failed; `368` total)**. In the shared workspace (which includes the uncommitted `tests/adversarial/api-mcp/worker/test/07-profile-constraints.test.ts` with `57` passing tests under `wi_ad60d17763fe0122`), `api-mcp/worker` passes **`15/15` files (`419` passed, `5` expected fail, `1` skipped, `0` failed; `425` total)**.
- **Daily service & visual wardrobe (`b883f26f`, `189a95dd`, `00541280`), Codex/Claude integrations (`1ace2dea`, `85feb377`), and Rust Ferrite port (`e8bb614c`..`63afb615`):** `@garderobe/daily` (`31` files, **`450/450`**), `@garderobe/media` (`31` files, **`276/276`** + `5/5` composite checks), `integrations/codex` (**`25/25`**), `deploy/ferrite` unit tests (**`69/69`**), and `ferrite/` (`ferrite check --json` and `ferrite check --target upstream --json` `"ok": true` with 0 errors and 0 warnings; `ferrite test` **`296/296` passed across `36` test targets**; hosted preview deployed at `https://0ldnjvqe9q4auks8.ferrite.cloud`).

### 2. Five-seed local MCP simulation summary (`tests/simulation/results/local/README.md`)

| Seed | Simulated days | Season | Steps run / planned | Step errors | Checks passed | Checks failed | Not applicable | MCP tool calls | Commands | Plan digest | Outcome digest | Real time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2027-03-08 to 2027-04-04 (28) | spring (summer time begins on 28 March) | 351 / 351 | 0 | 12,856 | 0 | 5 | 3,014 | 128 | `2c92379c01f31770` | `07809d6dc72172a8` | 168 s |
| 2 | 2027-05-31 to 2027-06-27 (28) | early summer | 354 / 354 | 0 | 13,089 | 0 | 5 | 3,099 | 131 | `f6eb348a37466c48` | `8e5af3c9d5690c26` | 169 s |
| 3 | 2027-07-19 to 2027-08-15 (28) | high summer | 350 / 350 | 0 | 12,707 | 0 | 6 | 3,088 | 137 | `1a85788fff84d6b7` | `a2b1b766f41cfba6` | 164 s |
| 4 | 2027-09-06 to 2027-10-03 (28) | autumn | 350 / 350 | 0 | 12,933 | 0 | 3 | 3,033 | 129 | `3580fda298760236` | `08d7354ed66ec6cc` | 167 s |
| 5 | 2027-10-11 to 2027-11-07 (28) | late autumn (summer time ends on 31 October) | 355 / 355 | 0 | 13,143 | 0 | 3 | 3,057 | 129 | `2a6dd87d008a37b6` | `dc4e80474d2ee294` | 173 s |

- Re-run on `fee6eb1af317` with `node bin/local.mjs --seeds 1,2,3,4,5 --parallel 5 --out results/local` (`exit 0`): all **5 seeds complete every planned step (`1,760 / 1,760` steps, `0` step errors, `64,728` invariant checks passed, `0` failed)**. Both earlier simulation defects (Seed 2 `wear.record` undo unit-location restoration fixed in `98393b20` and Seed 4 `trip.propose_packing` subrequest budget / swap revision check fixed in `37e63a49`) are verified resolved in the committed `tests/simulation/results/local/` artifacts.
- Live simulation against a deployed endpoint (`node tests/simulation/bin/run.mjs --target https://...`) has **not** been run (blocked on the Ferrite preview edge gate at `https://0ldnjvqe9q4auks8.ferrite.cloud`; see Section 5).

### 3. Evaluation corpus status (64 cases: 45 development, 19 holdout)

- **Owner decisions in force (`dec_1a9c98a0a9562d6d`, `dec_qb0385279ef78ada`, `dec_7253ba37c2a1cabd`):** Keep one model (`anthropic/claude-odango-eap`), with no second judge route and no new provider key. Skip the model-backed 64-case corpus run for now and report it as skipped with the exact blocker (development AI Gateway `garderobe-dev` rejects its route with `"Invalid Anthropic API Key"`). Run the candidate-free deterministic parts supported by the harness (`selftest`, `adapter-check --strict`, state/receipt and corpus integrity checks), and report **taste as "not judged"**.
- **Harness self-test (`node evals/run.mjs selftest`):** **61 passed, 0 failed** (`exit 0`). Verifies the 45-case development split and 19-case holdout split, 27 `owner_real_stock` and 37 `synthetic_fixture` worlds, candidate/judge route disjunction across 3 gateway routes (`deepseek-v41-flash`, `fable-5-1`, `gpt-6-astra`), holdout one-shot lock (`the holdout has not been run`), and support-bundle immutability.
- **Deterministic adapter state & receipt checks (`node evals/run.mjs adapter-check --strict`):** **12 passed, 0 failed, 1 `not_run` (`B018`)** (`exit 0`). Runs the 13 development behavioural cases against a real in-process application instance, verifies `evaluate.py check-state` with `provenance.source: "application_adapter"`, and passes the 337-needle candidate/judge leak audit (`0` leaks). `B001`, `B002`, `B003`, `B005`, `B006`, `B007`, `B009`, `B010`, `B011`, `B015`, `B017`, and `B019` pass their deterministic ledger and receipt checks; `B018` is recorded as `not_run` because `pause.start` refuses a past start date (`400 invalid_command: a pause cannot start in the past`) and no clock-advance route exists.
- **Deterministic corpus & negative-control checks (`node --test tests/journeys/evals/corpus-check.mjs`):** **13 passed, 0 failed** (`exit 0`). Verifies all 64 cases (40 historical, 24 constructed), the 45/19 development/holdout split with zero conversation overlap, byte-identical September 14 profile (`e15639d8...`), historical excerpt hashes, structural grader rejection of negative controls (missing socks, active welted-shoe restriction, unowned garment, duplicate daily wear), and that the 8 bundled calibration reviews are never treated as application pass evidence.
- **Model-backed 64-case corpus run:** **Skipped (blocked on `garderobe-dev` HTTP 401 `Invalid Anthropic API Key`)** per owner decisions `dec_7253ba37c2a1cabd` and `dec_qb0385279ef78ada`. Running `node evals/run.mjs development` reaches Cloudflare AI Gateway `garderobe-dev` (`gatewayMetadata.keySource = Unified`), which rejects its single configured route `anthropic/claude-odango-eap` with HTTP 401 `{"error":{"type":"authentication_error","message":"Invalid Anthropic API Key"}}` (`exit 2`).
- **Taste judging & holdout split:** Per owner decisions `dec_1a9c98a0a9562d6d` and `dec_qb0385279ef78ada`, **taste is reported as "not judged"** (one model is kept, with no second judge route and no new provider key), and the **19-case holdout split has not been run** (`evals/results/holdout/.holdout-runs.jsonl` is absent).

### 4. Clean-install suite verification: committed `fee6eb1af317` vs shared workspace

Every gate below was executed after `repo_update` (`garderobe-rebuild` at `fee6eb1af317`) and a clean `npm ci` (`added 442 packages in 27s`, `exit 0`). The table separates the exact outcome on the **pure committed `fee6eb1af317` tree** from the outcome in the **shared workspace** (where 87 uncommitted files owned by other threads are present).

| Suite / Command | Committed `fee6eb1af317` | Shared workspace (with uncommitted files) | Owner of any failure or uncommitted delta |
| --- | --- | --- | --- |
| `npm ci` | `exit 0` — 442 packages installed | `exit 0` — 442 packages installed | — |
| `npm run verify:documents` (`node tools/verify-documents.mjs`) | `exit 0` — 4 attachment SHA-256 digests, 47 bundle files, 5 bundled copies verified | `exit 0` — identical (no uncommitted changes) | — |
| `npm run verify:checklist` (`node tools/check-checklist.mjs`) | `exit 0` — `1244 rows; implemented 736, partial 440, blocked 68, open 0` | `exit 0` — identical | — |
| `npm run check:import-report` | `exit 0` — `import report is up to date` (130 rows → 127 garments, 3 merged, 144 units) | `exit 0` — identical (no uncommitted changes) | — |
| `npm run check:contracts` (`npm run generate:check -w @garderobe/contracts`) | **`exit 1`** — `out of date generated/garderobe-contracts.schema.json`, `out of date generated/swift/GarderobeContracts.swift` | **`exit 0`** — `up to date generated/garderobe-contracts.schema.json` & `generated/swift/GarderobeContracts.swift` | **API & MCP (`wi_981bd507c48d334d`):** commits `5d41122f`, `9427ce1f`, `5ada4cdb`, and `3dd18061` updated `packages/contracts/src/ext/{assistant,api}.ts` after `b43e004e`; the regenerated `packages/contracts/generated/*` files are in the shared workspace under `wi_981bd507c48d334d` and not yet committed |
| `npm run verify` (`verify:documents && verify:checklist && check:import-report && check:contracts`) | **`exit 1`** (3 of 4 sub-gates exit `0`; `check:contracts` exits `1`) | **`exit 0`** (all 4 sub-gates exit `0`) | **API & MCP (`wi_981bd507c48d334d`):** same uncommitted `packages/contracts/generated/*` regeneration |
| `npm run typecheck` | `exit 0` — **10 of 10 workspaces pass** | `exit 0` — **10 of 10 workspaces pass** | — |
| `npm test` (root: `typecheck` + all 10 workspaces) | **`exit 1`** (9 of 10 workspaces pass; `@garderobe/contracts` fails 1 of 16 tests on generated contract drift) | **`exit 0`** (all 10 workspaces pass, `0` failed tests) | **API & MCP (`wi_981bd507c48d334d`):** same uncommitted `packages/contracts/generated/*` regeneration |
| `npm test -w @garderobe/assistant` | `exit 0` — 36 files passed (36), **394 passed (394)** | `exit 0` — identical (no uncommitted changes in `packages/assistant/`) | — |
| `npm test -w @garderobe/contracts` | **`exit 1`** — 1 file: **15 passed, 1 failed (16)** (`are up to date with the zod schemas and generate deterministically`) | **`exit 0`** — 1 file: **16 passed, 0 failed (16)** | **API & MCP (`wi_981bd507c48d334d`):** uncommitted `packages/contracts/generated/*` regeneration |
| `npm test -w @garderobe/daily` | `exit 0` — 31 files passed (31), **450 passed (450)** | `exit 0` — identical (no uncommitted changes in `packages/daily/`) | — |
| `npm test -w @garderobe/domain` | `exit 0` — 18 files passed (18), **186 passed (186)** | `exit 0` — identical (no uncommitted changes in `packages/domain/`) | — |
| `npm test -w @garderobe/media` | `exit 0` — 31 files passed (31), **276 passed (276)** + `composite-example.mjs --check` ok + `composite-example.test.mjs` **5 passed (5)** | `exit 0` — identical (no uncommitted changes in `packages/media/`) | — |
| `npm test -w @garderobe/worker` | `exit 0` — 31 files passed (31), **280 passed (280)** (`studio-forecast.test.ts` has 10 tests at `fee6eb1a`) | `exit 0` — 31 files passed (31), **282 passed (282)** (`studio-forecast.test.ts` has 12 tests in the shared workspace) | **Visual wardrobe (`wi_a387a5bbbeb05ad1`):** 2 additional uncommitted tests in `apps/worker/test/studio-forecast.test.ts` |
| `npm run smoke:mcp -w @garderobe/worker` (against `npm run dev -w @garderobe/worker`) | `exit 0` — **21 passed, 0 failed (21)** | `exit 0` — identical (no uncommitted changes in `apps/worker/src/` or `scripts/`) | — |
| `npm test -w @garderobe/journey-tests` (default mode) | `exit 0` — 14 files passed (14): **275 passed, 1 skipped (`D06-2` under watch), 0 failed (276)** | `exit 0` — identical (no uncommitted changes in `tests/journeys/`) | — |
| `npm run test:strict -w @garderobe/journey-tests` (strict mode) | `exit 0` — 14 files passed (14): **276 passed, 0 failed (276)** | `exit 0` — identical (no uncommitted changes in `tests/journeys/`) | — |
| `npm test -w @garderobe/adversarial-tests` | `exit 0` — `shared`: **7 passed (7)** (`1` file); `daily-media/media`: **46 passed (46)** (`5` files); `api-mcp/worker`: **14 committed files passed (14), 362 passed, 5 expected fail (`L03-2`, `L03-4`, `I05-9`, `I06-7`, `M14-10`), 1 skipped (`I06-6`), 0 failed (368)** | `exit 0` — `shared`: **7 passed (7)**; `daily-media/media`: **46 passed (46)**; `api-mcp/worker`: **15 files passed (15), 419 passed, 5 expected fail, 1 skipped, 0 failed (425)** | **Adversarial (`wi_ad60d17763fe0122`):** uncommitted `tests/adversarial/api-mcp/worker/test/07-profile-constraints.test.ts` adds 57 passing tests (`362 + 57 = 419`) |
| `npm test -w @garderobe/evals-check` | `exit 0` — `selftest` **61 passed (61)**; `adapter-check --strict` **12 passed, 0 failed, 1 `not_run` (`B018`)** | `exit 0` — identical (no uncommitted changes in `evals/`) | — |
| `node --test tests/journeys/evals/corpus-check.mjs` | `exit 0` — **13 checks passed (13)** (`1` subtest), 0 failed | `exit 0` — identical | — |
| `npm test -w @garderobe/simulation` | `exit 0` — **30 tests passed (30)**, 0 failed | `exit 0` — identical | — |
| `node bin/local.mjs --seeds 1,2,3,4,5 --parallel 5 --out results/local` (`cwd: tests/simulation`) | `exit 0` — **5 seeds completed (`1,760 / 1,760` steps, `64,728` checks passed, `0` failed, `0` step errors)** | `exit 0` — identical (no uncommitted changes in `tests/simulation/` or Worker runtime) | — |
| `node --test integrations/codex/test/plugin.test.mjs` | `exit 0` — **25 tests passed (25)**, 0 failed | `exit 0` — identical (no uncommitted changes in `integrations/`) | — |
| `node --test deploy/ferrite/test/*.test.mjs` | `exit 0` — **69 tests passed (69)**, 0 failed | `exit 0` — identical (no uncommitted changes in `deploy/ferrite/`) | — |
| `node --test deploy/test/guard.test.mjs` | `exit 0` — **8 tests passed (8)**, 0 failed | `exit 0` — **53 tests passed (53)**, 0 failed | **Cloudflare deploy (`wi_bcb612ab5981c947`):** 27 uncommitted files in `deploy/` add 45 guard tests (parked per `dec_8c5d9068a2aa2826`) |
| `ferrite --version` / `ferrite check --json` / `ferrite check --target upstream --json` / `ferrite test` (`cwd: ferrite`) | `exit 0` — `ferrite 0.1.20`; `ferrite check` & `ferrite check --target upstream` `"ok": true` (0 errors, 0 warnings); `ferrite test` **296 passed, 0 failed across 36 test targets** | `exit 0` — identical (no uncommitted changes in `ferrite/`) | — |
| `node deploy/ferrite/verify.mjs --local --start-dev` | **`exit 1`** — `12 passed, 3 failed, 16 not run` | **`exit 1`** — identical | **Deploy (`wi_bcb612ab5981c947`) / Ferrite port (`wi_0034dbbd2b2ddff8`):** commit `97ed5ffc` updated `GET /v1/wardrobe` in `ferrite/` to the `InventoryPage` contract shape (`items: [{garment, stock, availability}]`), while `deploy/ferrite/verify.mjs` (`7345f584`) still reads the earlier Milestone 0 flat `items: [{garmentId, balances}]` shape |
| `bash ios/Tools/check.sh` | **`exit 127`** — `ios/Tools/check.sh: line 21: swift: command not found` | **`exit 127`** — identical on Linux | **iOS (`wi_7fca966a614d64a0`) / Linux sandbox environment:** Swift toolchain is not installed on the Linux sandbox; Xcode/Swift checks run on GitHub-hosted macOS runners (`.github/workflows/ios.yml`) |

### 5. Parked items, open defects, and remaining deployment and iOS acceptance steps

No unrun cloud, live-gateway, Ferrite-hosted, or Xcode/device check is claimed as passed.

#### A. Parked items and uncommitted working-tree batches
1. **Parked patches in `wardrobe/.fabric-parked/` (three-strikes rule):**
   - `wardrobe/.fabric-parked/api-batch-2-3.patch` (`.md`, `wi_981bd507c48d334d`): atomic `restore_replay_commands` recording and `restore_baselines` tombstone verification in `apps/worker/src/backup/service.ts` (`migrations/0308_api_restore_baselines.sql`), plus `ensureOutfitCalendar` lease-holder and `network_error` recovery in `apps/worker/src/connections/service.ts` (`migrations/0309_api_connection_refresh_calendar_ops.sql`). Note: the `D11-3` OAuth metadata validation fix from this batch was extracted and landed in `ece31159`.
   - `wardrobe/.fabric-parked/api-batch-4b-proposals.patch` (`.md`, `wi_981bd507c48d334d`): historical parked patch for `M14-3`, `M14-4`, `M14-7`, and `M14-8`; superseded by commits `1633256c`, `9c673eb5`, `e4abdc9a`, and `fee6eb1a` on `garderobe-rebuild`.
   - `wardrobe/.fabric-parked/api-patch-5b-export-lease.patch` (`.md`, `wi_981bd507c48d334d`): export package staging lease and expiration cleanup in `apps/worker/src/export/job.ts` and `apps/worker/src/maintenance.ts` (2 open review findings on legacy bare `package` key deletion and `$.expiredCleanup` generation token).
   - `wardrobe/.fabric-parked/assistant-recovery-import-discard.md` (`.fabric-parked/assistant-allowlist.patch`, `wi_18947932bb1272b9`): assistant conversation recovery and `discardImportedConversation` hunks in `packages/assistant/src/agent/assistant.ts` and `packages/assistant/src/export.ts` (4 open review findings on `assertOnlyImportedRows`, `restoreTurnRow`, `restoreConversation`, and research task actor erasure ordering).
   - **Ferrite media deletion & selfie retention (`wi_0034dbbd2b2ddff8`):** parked after three review rounds as documented in `ferrite/README.md` (`L1647-L1649`); remaining unported Ferrite milestones (garment create/correct/move/retire/merge, wear amendments, weekly laundry reset and exceptions, style commands, purchase order import, conversation actor, scheduled sweeps, and Calendar/weather egress) are itemized in `ferrite/README.md`.
2. **Uncommitted working-tree files owned by other threads (87 files outside `tests/simulation/results/local/`):**
   - **API & MCP (`wi_981bd507c48d334d`, 2 generated contract files + 6 `.fabric-parked/` files):** `packages/contracts/generated/garderobe-contracts.schema.json` and `packages/contracts/generated/swift/GarderobeContracts.swift` regenerated after `5d41122f`, `9427ce1f`, `5ada4cdb`, and `3dd18061` (needed on `garderobe-rebuild` so `npm run check:contracts` exits `0` on a fresh checkout without running `npm run generate -w @garderobe/contracts`).
   - **Adversarial (`wi_ad60d17763fe0122`, 2 files):** `tests/adversarial/api-mcp/worker/test/07-profile-constraints.test.ts` (`57/57` tests passing) and `tests/adversarial/api-mcp/worker/defects/profile.md`.
   - **Visual wardrobe (`wi_a387a5bbbeb05ad1`, 1 file):** `apps/worker/test/studio-forecast.test.ts` (`12/12` tests passing; `10/10` on committed `fee6eb1a`).
   - **Cloudflare deployment (`wi_bcb612ab5981c947`, 27 files + `deploy/evidence/access-probe.json`):** `deploy/*` rehearsal and guard updates (`53/53` tests passing in `deploy/test/guard.test.mjs`), parked because owner decisions `dec_8c5d9068a2aa2826` and `dec_q8222cdab71f86bd` moved hosting to Ferrite.
   - **Native iOS client (`wi_7fca966a614d64a0`, 46 files):** `ios/App/Garderobe/*`, `ios/GarderobeKit/*`, `ios/README.md`, and `ios/Tools/contract-check/validate.mjs`.
3. **Open defects & post-landing review findings:**
   - **Adversarial suite (`tests/adversarial/api-mcp/worker/`):** `0` unexpected failures; `5` tracked `defect(...)` expected failures (`L03-2` foundation 80-report burst concurrency, `L03-4` daily `POST /v1/recommendations` board-mode retransmission fingerprint, `I05-9` assistant relayed whole-category wash kept as proposal instead of refused as `change_exceeds_bound`, `I06-7` assistant research run unretrieved source check, and `M14-10` media/API `media.decide_review` connected-assistant refusal vs `/v1/command-types` flag) and `1` strict-only skip (`I06-6` 3,000-level nested tool-call argument).
   - **Journey suite (`tests/journeys/`):** `0` open defects; `1` intermittent test under watch (`D06-2`, skipped in default mode and passing in strict mode `276/276`).
   - **Assistant intent policy (`packages/assistant/src/policy/intent.ts`, `wi_18947932bb1272b9`):** post-landing review noted 5 findings on `intent.ts` (`garment.retire` imperative vs completed disposition, `return.update_case` clause binding, `refund\w*` request vs completion, `wordsWithPolarity` negation scope, and `purchase.record_event` UTC vs owner timezone date check).
   - **Ferrite local verifier (`deploy/ferrite/verify.mjs`, `wi_bcb612ab5981c947`):** needs updating for the `InventoryPage` shape returned by `GET /v1/wardrobe` since commit `97ed5ffc`.

#### B. Owner-only blockers vs remaining engineering and acceptance tasks

1. **Owner-only / external platform blockers:**
   - **Evaluation corpus & taste judging (`EV-001`..`EV-039`, `S17-058`..`S17-064`, `S21-007`, `AM-027`, `AM-028`):**
     - Per owner decisions `dec_1a9c98a0a9562d6d`, `dec_qb0385279ef78ada`, and `dec_7253ba37c2a1cabd`: keep one model (`anthropic/claude-odango-eap`), add no second judge route and no new provider key, **skip the model-backed 64-case corpus run for now** and report it with the exact blocker (Cloudflare AI Gateway `garderobe-dev` rejects its single route `anthropic/claude-odango-eap` with HTTP 401 `"Invalid Anthropic API Key"`), run the candidate-free deterministic checks (`node evals/run.mjs selftest` `61/61`, `node evals/run.mjs adapter-check --strict` `12/13` with `B018` `not_run`, and `node --test tests/journeys/evals/corpus-check.mjs` `13/13`), and report **taste as "not judged"**.
     - If the upstream provider credential on `garderobe-dev` is later restored, run the single-model candidate and deterministic checks (`node evals/run.mjs development --work-dir <dir>`, `node evals/run.mjs freeze --work-dir <dir>`, and, once development gates pass, `node evals/run.mjs holdout --work-dir <dir> --confirm-holdout-one-shot`) while continuing to report taste as "not judged".
   - **Hosted Ferrite preview edge gate & secrets (`ferrite/`, `https://0ldnjvqe9q4auks8.ferrite.cloud`):**
     - Per owner decisions `dec_8c5d9068a2aa2826` and `dec_q8222cdab71f86bd`, the backend is hosted on Ferrite (`https://0ldnjvqe9q4auks8.ferrite.cloud`) rather than Cloudflare development resources.
     - External client and simulation requests without a Ferrite account bearer are redirected (`302`) by the Ferrite preview edge gate (`login.ferrite.cloud/edge/start`), which consumes the single `Authorization` header the app reads; allowing the app's `/v1/*`, `/oauth/*`, and `/mcp` routes through the preview edge gate, supplying `WARDROBE_APP_CLIENT_ID` and `WARDROBE_APP_REDIRECT_URI` for iOS OAuth sign-in, and supplying a working `WARDROBE_AI_GATEWAY` key require platform/owner action.
   - **Physical iOS device signing & Apple entitlements (`ios/`):**
     - Configuring the Apple Developer team ID, OAuth client settings, and Sign in with Apple / APNs entitlements in `ios/project.yml` and running on a physical iPhone pointed at the deployed backend require the owner's Apple Developer account and device.
2. **Remaining engineering and acceptance tasks:**
   - **Commit the remaining working-tree files on `garderobe-rebuild`:** commit the regenerated `packages/contracts/generated/garderobe-contracts.schema.json` and `packages/contracts/generated/swift/GarderobeContracts.swift` (`wi_981bd507c48d334d`, so `npm run check:contracts` and root `npm test` exit `0` on a fresh checkout), `tests/adversarial/api-mcp/worker/test/07-profile-constraints.test.ts` + `defects/profile.md` (`wi_ad60d17763fe0122`), `apps/worker/test/studio-forecast.test.ts` (`wi_a387a5bbbeb05ad1`), and the `ios/` changes (`wi_7fca966a614d64a0`).
   - **Ferrite verifier & live acceptance (`deploy/ferrite/`, `wi_bcb612ab5981c947`):** update `deploy/ferrite/verify.mjs` for the `InventoryPage` shape from `97ed5ffc`, then (once the preview edge gate allows app routes through) run `node deploy/ferrite/verify.mjs --deployed`, `node integrations/codex/scripts/verify-codex.mjs --app ferrite`, and the 5-seed MCP simulation (`node tests/simulation/bin/run.mjs --target https://0ldnjvqe9q4auks8.ferrite.cloud --token <mcp-oauth-token> --seed all`).
   - **Native iOS Xcode simulator milestone run (`wi_7fca966a614d64a0`):** trigger `.github/workflows/ios.yml` (`gh workflow run ios.yml --ref garderobe-rebuild`) on `macos-15` after committing the `ios/` and regenerated `GarderobeContracts.swift` files, and verify `bash ios/Tools/check.sh` (all 9 gates).
   - **Final merge into `main`:** once the above gates are green on `garderobe-rebuild`, open, review, and merge the single pull request from `garderobe-rebuild` into `main`.
