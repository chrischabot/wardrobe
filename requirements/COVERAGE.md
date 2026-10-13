# Requirement coverage audit

This document records an independent audit of `requirements/CHECKLIST.md` against the revision 4 specification, the September 15 owner amendments, the owner profile, the evaluation instructions, the usage research and the kickoff instructions. It was produced by reading the cited code and tests, not by trusting the checklist's wording. The checklist rows themselves stay owned by each area's thread; this document says whether each row's claim holds, lists requirements with no row, and records the document and inventory checks. Final acceptance updates this document when rows are re-audited.

- Audited commit: `8445a1e9d1958da5bc9c307f2c60d727150bf2c9` on `garderobe-rebuild` (5 October 2026); updated at final acceptance on `154e66f89d00` (13 October 2026).
- Scope: all 1,244 checklist rows (at `154e66f89d00`, unchanged since `fee6eb1af317`: **736 marked implemented, 440 partial, 68 blocked, 0 open, 0 blank cells**; at `8445a1e9`: 692 implemented, 388 partial, 128 open, 36 blocked).
- Method: the row audit read the files and compared every claim against the source and tests; final acceptance re-verified the updated checklist rows and executed every repository suite from a clean `npm ci` install at `garderobe-rebuild` tip `154e66f89d00`, recording exact commands, exit codes, test counts, parked items, and failure owners below. At `154e66f89d00` no uncommitted file outside `ios/`, the parked Cloudflare `deploy/` tree and `.fabric-parked/` remains, and none of those affects a suite below, so the committed and shared-workspace results are the same.
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
- Joining current `requirements/CHECKLIST.md` statuses at `154e66f89d00` (unchanged since `fee6eb1af317`) with the row audit verdicts across `coverage-audit/rows/A..G` yields the exact status-by-verdict cross-tabulation:
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

## Final acceptance verification (`154e66f89d00`)

### 0. What landed between the previous final-acceptance run (`fee6eb1a`, reported in `72d699fb`) and `154e66f8`

- `4d0ac7dc` committed the regenerated contract outputs (`packages/contracts/generated/garderobe-contracts.schema.json` and `generated/swift/GarderobeContracts.swift`), so `npm run check:contracts`, `npm run verify` and `npm test -w @garderobe/contracts` now pass on the committed tree.
- `dac9deb4` added assistant regression tests for the five historical `intent.ts` review findings under the 8-form allow-list (`@garderobe/assistant` 394 → **399** tests).
- `774fb702` committed the adversarial profile-integrity suite (`tests/adversarial/api-mcp/worker/test/07-profile-constraints.test.ts`, 57 tests, and `defects/profile.md`), so the committed `api-mcp/worker` suite is now 15 files (`419` passed, `5` expected fail, `1` skipped).
- `9a2af295` updated `deploy/ferrite/verify.mjs` to the `InventoryPage` shape and the assistant-grant routes; `node deploy/ferrite/verify.mjs --local --start-dev` now exits `0`, and `deploy/ferrite` unit tests are **70/70**.
- `154e66f8` committed the two remaining Studio forecast tests (`apps/worker/test/studio-forecast.test.ts`, 12 tests), so `@garderobe/worker` is **282/282** on the committed tree.

### 1. What landed on `garderobe-rebuild` after the initial audit (`8445a1e9` → `fee6eb1a`)

The counts in this subsection are the historical ones measured at `fee6eb1a`; the counts at `154e66f8` are in subsections 2 to 4.

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
| 1 | 2027-03-08 to 2027-04-04 (28) | spring (summer time begins on 28 March) | 351 / 351 | 0 | 12,855 | 0 | 5 | 3,013 | 128 | `2c92379c01f31770` | `54c3f67a270634a5` | 233 s |
| 2 | 2027-05-31 to 2027-06-27 (28) | early summer | 354 / 354 | 0 | 13,113 | 0 | 4 | 3,107 | 132 | `f6eb348a37466c48` | `d5e04f80776ae024` | 234 s |
| 3 | 2027-07-19 to 2027-08-15 (28) | high summer | 350 / 350 | 0 | 12,776 | 0 | 3 | 3,118 | 140 | `1a85788fff84d6b7` | `a77dd5d065174913` | 232 s |
| 4 | 2027-09-06 to 2027-10-03 (28) | autumn | 350 / 350 | 0 | 12,939 | 0 | 3 | 3,032 | 129 | `3580fda298760236` | `365c0326b3b8b0b9` | 230 s |
| 5 | 2027-10-11 to 2027-11-07 (28) | late autumn (summer time ends on 31 October) | 355 / 355 | 0 | 13,139 | 0 | 3 | 3,057 | 129 | `2a6dd87d008a37b6` | `c1bf3aa8f4b58e21` | 237 s |

- Re-run on `154e66f89d00`'s code (`9a2af295`; the only later commit adds two Worker tests and changes no runtime code) with `node bin/local.mjs --seeds 1,2,3,4,5 --parallel 5 --out results/local` (`exit 0`): all **5 seeds complete every planned step (`1,760 / 1,760` steps, `0` step errors, `64,822` invariant checks passed, `0` failed)**. The plan digests are identical to the previous run; the outcome digests differ, and the cause has not been established (the commits since `fee6eb1a` listed in subsection 0 change tests, generated contracts and the Ferrite verifier, not obviously the simulated runtime path; asynchronous execution order is another possible source). Both earlier simulation defects (Seed 2 `wear.record` undo unit-location restoration fixed in `98393b20` and Seed 4 `trip.propose_packing` subrequest budget / swap revision check fixed in `37e63a49`) remain resolved; the Seed 2 undo-with-laundry overlap is no longer produced by the seed's plan and is held by `packages/domain/test/review-findings.test.ts`.
- Live simulation against a deployed endpoint (`node tests/simulation/bin/run.mjs --target https://...`) has **not** been run (blocked on the Ferrite preview edge gate at `https://0ldnjvqe9q4auks8.ferrite.cloud`; see Section 5).

### 3. Evaluation corpus status (64 cases: 45 development, 19 holdout)

- **Owner decisions in force (`dec_1a9c98a0a9562d6d`, `dec_qb0385279ef78ada`, `dec_7253ba37c2a1cabd`):** Keep one model (`anthropic/claude-odango-eap`), with no second judge route and no new provider key. Skip the model-backed 64-case corpus run for now and report it as skipped with the exact blocker (development AI Gateway `garderobe-dev` rejects its route with `"Invalid Anthropic API Key"`). Run the candidate-free deterministic parts supported by the harness (`selftest`, `adapter-check --strict`, state/receipt and corpus integrity checks), and report **taste as "not judged"**.
- **Harness self-test (`node evals/run.mjs selftest`):** **61 passed, 0 failed** (`exit 0`). Verifies the 45-case development split and 19-case holdout split, 27 `owner_real_stock` and 37 `synthetic_fixture` worlds, candidate/judge route check against the application's registry (conversation candidates `odango-eap` and `odango-eap-fallback`, `1` distinct gateway route, so independent judging is correctly refused), holdout one-shot lock (`the holdout has not been run`), and support-bundle immutability.
- **Deterministic adapter state & receipt checks (`node evals/run.mjs adapter-check --strict`):** **12 passed, 0 failed, 1 `not_run` (`B018`)** (`exit 0` when run on its own at `154e66f8`). In one of the two root `npm test` runs at `154e66f8` (machine under load from parallel workspaces) `B009` failed once (`duplicate_garments_created: expected 0, got 1`; the record shows a garment created by the turn's receipt that was no longer present afterwards); the isolated rerun at the same tip passed `B009`, and the earlier run at `9a2af295` passed it too. This is reported as an intermittent failure owned by the evaluation harness / daily-wear path, not resolved here. Runs the 13 development behavioural cases against a real in-process application instance, verifies `evaluate.py check-state` with `provenance.source: "application_adapter"`, and passes the 337-needle candidate/judge leak audit (`0` leaks). `B001`, `B002`, `B003`, `B005`, `B006`, `B007`, `B009`, `B010`, `B011`, `B015`, `B017`, and `B019` pass their deterministic ledger and receipt checks; `B018` is recorded as `not_run` because `pause.start` refuses a past start date (`400 invalid_command: a pause cannot start in the past`) and no clock-advance route exists.
- **Deterministic corpus & negative-control checks (`node --test tests/journeys/evals/corpus-check.mjs`):** **15 checks passed, 0 failed** (`exit 0`, `1` subtest). Verifies all 64 cases (40 historical, 24 constructed), the 45/19 development/holdout split with zero conversation overlap, byte-identical September 14 profile (`e15639d8...`), historical excerpt hashes, structural grader rejection of negative controls (missing socks, active welted-shoe restriction, unowned garment, duplicate daily wear), and that the 8 bundled calibration reviews are never treated as application pass evidence.
- **Model-backed 64-case corpus run:** **Skipped (blocked on `garderobe-dev` HTTP 401 `Invalid Anthropic API Key`)** per owner decisions `dec_7253ba37c2a1cabd` and `dec_qb0385279ef78ada`. Running `node evals/run.mjs development` reaches Cloudflare AI Gateway `garderobe-dev` (`gatewayMetadata.keySource = Unified`), which rejects its single configured route `anthropic/claude-odango-eap` with HTTP 401 `{"error":{"type":"authentication_error","message":"Invalid Anthropic API Key"}}` (`exit 2`).
- **Taste judging & holdout split:** Per owner decisions `dec_1a9c98a0a9562d6d` and `dec_qb0385279ef78ada`, **taste is reported as "not judged"** (one model is kept, with no second judge route and no new provider key), and the **19-case holdout split has not been run** (`evals/results/holdout/.holdout-runs.jsonl` is absent).

### 4. Clean-install suite verification at `154e66f89d00`

Every gate below was executed after `repo_update` (`garderobe-rebuild` at `154e66f89d00`) and a clean `npm ci` (`exit 0`). Gates marked `9a2af295` ran before the last `repo_update`; the only later commit (`154e66f8`) adds two tests to `apps/worker/test/studio-forecast.test.ts` and changes no runtime code, and the Worker and root suites were rerun at `154e66f8`. The uncommitted files in the shared workspace (`ios/`, the parked Cloudflare `deploy/` tree and `.fabric-parked/`) are outside every gate except the two named in the table, so the committed and shared-workspace results are the same unless the table says otherwise.

| Suite / Command | Committed `154e66f89d00` | Shared workspace (with uncommitted files) | Owner of any failure or uncommitted delta |
| --- | --- | --- | --- |
| `npm ci` | `exit 0` | `exit 0` | — |
| `npm run verify` (`verify:documents && verify:checklist && check:import-report && check:contracts`) | `exit 0` — 4 attachment SHA-256 digests, 47 bundle files, 5 bundled copies verified; `1244 rows; implemented 736, partial 440, blocked 68, open 0`; `import report is up to date` (130 rows → 127 garments, 3 merged, 144 units); generated schema and Swift contracts up to date | identical | — |
| `npm run typecheck` | `exit 0` — **10 of 10 workspaces pass** | identical | — |
| `npm test` (root: `typecheck` + all 10 workspaces) | **`exit 0`** (third run at `154e66f8`): assistant 399/399, contracts 16/16, daily 450/450, domain 186/186, media 276/276 + 5/5, worker 282/282, adversarial 7/7 + 419 passed/5 expected fail/1 skipped (425) + 46/46, evals selftest 61/61 + adapter-check 12 passed/1 not run (`B018`), journeys 275 passed/1 skipped (276), simulation 30/30. Two earlier root runs exited `1` on one intermittent test each (`9a2af295`: daily `repair.test.ts` 449/450; `154e66f8`: evaluation case `B009`); both passed when rerun | identical | **Daily service thread / evaluation harness:** the two intermittent failures under load (section 5.A.3) |
| `npm test -w @garderobe/assistant` | `exit 0` — 36 files passed (36), **399 passed (399)** | identical | — |
| `npm test -w @garderobe/contracts` | `exit 0` — 1 file: **16 passed (16)** | identical | — |
| `npm test -w @garderobe/daily` | `exit 0` — 31 files passed (31), **450 passed (450)**; in one root run at `9a2af295` one test (`test/repair.test.ts`, "wearing a planned shirt today replaces it in the selected option for Thursday") failed under load (449/450) and passed on rerun, with no daily code changed since `fee6eb1a` | identical | **Daily service thread:** intermittent `repair.test.ts` failure under load |
| `npm test -w @garderobe/domain` | `exit 0` — 18 files passed (18), **186 passed (186)** | identical | — |
| `npm test -w @garderobe/media` | `exit 0` — 31 files passed (31), **276 passed (276)** + `composite-example.mjs --check` ok + `composite-example.test.mjs` **5 passed (5)** | identical | — |
| `npm test -w @garderobe/worker` | `exit 0` — 31 files passed (31), **282 passed (282)** (`studio-forecast.test.ts` 12 tests, committed in `154e66f8`) | identical | — |
| `npm run smoke:mcp -w @garderobe/worker` (against `npm run dev -w @garderobe/worker`) | not rerun at `154e66f8`; last run `exit 0` — **21 passed, 0 failed (21)** at `fee6eb1a` | — | — |
| `npm test -w @garderobe/journey-tests` (default mode) | `exit 0` — 14 files passed (14): **275 passed, 1 skipped (`D06-2` under watch), 0 failed (276)** | identical | — |
| `npm run test:strict -w @garderobe/journey-tests` (strict mode) | `exit 0` — 14 files passed (14): **276 passed, 0 failed (276)** | identical | — |
| `npm test -w @garderobe/adversarial-tests` | `exit 0` — `shared`: **7 passed (7)** (`1` file); `daily-media/media`: **46 passed (46)** (`5` files); `api-mcp/worker`: **15 files passed (15), 419 passed, 5 expected fail (`L03-2`, `L03-4`, `I05-9`, `I06-7`, `M14-10`), 1 skipped (`I06-6`), 0 failed (425)** | identical | — |
| `npm test -w @garderobe/evals-check` | `exit 0` (run on its own) — `selftest` **61 passed (61)**; `adapter-check --strict` **12 passed, 0 failed, 1 `not_run` (`B018`)**; one intermittent `B009` failure inside a root run (see section 3) | identical | **Evaluation harness / daily wear path:** intermittent `B009` under load |
| `node --test tests/journeys/evals/corpus-check.mjs` | `exit 0` — **15 checks passed (15)** (`1` subtest), 0 failed | identical | — |
| `npm test -w @garderobe/simulation` | `exit 0` — **30 tests passed (30)**, 0 failed | identical | — |
| `node bin/local.mjs --seeds 1,2,3,4,5 --parallel 5 --out results/local` (`cwd: tests/simulation`, at `9a2af295`) | `exit 0` — **5 seeds completed (`1,760 / 1,760` steps, `64,822` checks passed, `0` failed, `0` step errors)** | identical | — |
| `node --test integrations/codex/test/plugin.test.mjs` | `exit 0` — **25 tests passed (25)**, 0 failed | identical | — |
| `node --test deploy/ferrite/test/{lib,redact,ferrite,deploy}.test.mjs` | `exit 0` — **70 tests passed (70)**, 0 failed | identical | — |
| `node --test deploy/test/guard.test.mjs` | not rerun at `154e66f8` (Cloudflare deployment parked); at `fee6eb1a`: **8 passed (8)** committed, **53 passed (53)** with the parked files | — | **Cloudflare deploy (`wi_bcb612ab5981c947`):** 27 uncommitted files in `deploy/` (parked per `dec_8c5d9068a2aa2826`) |
| `ferrite --version` / `ferrite check --json` / `ferrite check --target upstream --json` / `ferrite test` (`cwd: ferrite`) | `exit 0` — `ferrite 0.1.20`; `ferrite check --json` `"ok": true` (0 errors, 0 warnings); `ferrite check --target upstream --json` `exit 0`; `ferrite test` **296 passed, 0 failed across 36 test targets** | identical | — |
| `node deploy/ferrite/verify.mjs --local --start-dev` | `exit 0` — **30 passed, 0 failed, 1 not run (0 required)** (cross-owner isolation not applicable locally); evidence in `deploy/ferrite/evidence/verify-local.json` | identical | — |
| `bash ios/Tools/check.sh` | not rerun; last result **`exit 127`** — `swift: command not found` on the Linux sandbox | — | **iOS (`wi_7fca966a614d64a0`) / Linux sandbox environment:** Xcode/Swift checks run on GitHub-hosted macOS runners (`.github/workflows/ios.yml`) |

### 5. Parked items, open defects, and remaining deployment and iOS acceptance steps

No unrun cloud, live-gateway, Ferrite-hosted, or Xcode/device check is claimed as passed.

#### A. Parked items and uncommitted working-tree batches
1. **Parked patches in `wardrobe/.fabric-parked/` (three-strikes rule):**
   - `wardrobe/.fabric-parked/api-batch-2-3.patch` (`.md`, `wi_981bd507c48d334d`): atomic `restore_replay_commands` recording and `restore_baselines` tombstone verification in `apps/worker/src/backup/service.ts` (`migrations/0308_api_restore_baselines.sql`), plus `ensureOutfitCalendar` lease-holder and `network_error` recovery in `apps/worker/src/connections/service.ts` (`migrations/0309_api_connection_refresh_calendar_ops.sql`). Note: the `D11-3` OAuth metadata validation fix from this batch was extracted and landed in `ece31159`.
   - `wardrobe/.fabric-parked/api-batch-4b-proposals.patch` (`.md`, `wi_981bd507c48d334d`): historical parked patch for `M14-3`, `M14-4`, `M14-7`, and `M14-8`; superseded by commits `1633256c`, `9c673eb5`, `e4abdc9a`, and `fee6eb1a` on `garderobe-rebuild`.
   - `wardrobe/.fabric-parked/api-patch-5b-export-lease.patch` (`.md`, `wi_981bd507c48d334d`): export package staging lease and expiration cleanup in `apps/worker/src/export/job.ts` and `apps/worker/src/maintenance.ts` (2 open review findings on legacy bare `package` key deletion and `$.expiredCleanup` generation token).
   - `wardrobe/.fabric-parked/assistant-recovery-import-discard.md` (`.fabric-parked/assistant-allowlist.patch`, `wi_18947932bb1272b9`): assistant conversation recovery and `discardImportedConversation` hunks in `packages/assistant/src/agent/assistant.ts` and `packages/assistant/src/export.ts` (4 open review findings on `assertOnlyImportedRows`, `restoreTurnRow`, `restoreConversation`, and research task actor erasure ordering).
   - **Ferrite media deletion & selfie retention (`wi_0034dbbd2b2ddff8`):** parked after three review rounds as documented in `ferrite/README.md` (`L1647-L1649`); remaining unported Ferrite milestones (garment create/correct/move/retire/merge, wear amendments, weekly laundry reset and exceptions, style commands, purchase order import, conversation actor, scheduled sweeps, and Calendar/weather egress) are itemized in `ferrite/README.md`.
2. **Uncommitted working-tree files owned by other threads at `154e66f8` (82 files):**
   - **API & MCP (`wi_981bd507c48d334d`, 6 `.fabric-parked/` files)** and **Assistant (`wi_18947932bb1272b9`, 2 `.fabric-parked/` files):** the parked patches listed above.
   - **Cloudflare deployment (`wi_bcb612ab5981c947`, 27 files + `deploy/evidence/access-probe.json`):** `deploy/*` rehearsal and guard updates, parked because owner decisions `dec_8c5d9068a2aa2826` and `dec_q8222cdab71f86bd` moved hosting to Ferrite.
   - **Native iOS client (`wi_7fca966a614d64a0`, 46 files):** `ios/App/Garderobe/*`, `ios/GarderobeKit/*`, `ios/README.md`, and `ios/Tools/contract-check/validate.mjs`.
   - The regenerated contract outputs (`4d0ac7dc`), the adversarial profile-integrity suite (`774fb702`) and the Studio forecast tests (`154e66f8`) listed here at `fee6eb1a` are now committed.
3. **Open defects & post-landing review findings:**
   - **Adversarial suite (`tests/adversarial/api-mcp/worker/`):** `0` unexpected failures; `5` tracked `defect(...)` expected failures (`L03-2` foundation 80-report burst concurrency, `L03-4` daily `POST /v1/recommendations` board-mode retransmission fingerprint, `I05-9` assistant relayed whole-category wash kept as proposal instead of refused as `change_exceeds_bound`, `I06-7` assistant research run unretrieved source check, and `M14-10` media/API `media.decide_review` connected-assistant refusal vs `/v1/command-types` flag) and `1` strict-only skip (`I06-6` 3,000-level nested tool-call argument).
   - **Journey suite (`tests/journeys/`):** `0` open defects; `1` intermittent test under watch (`D06-2`, skipped in default mode and passing in strict mode `276/276`).
   - **Intermittent failures under load at final acceptance:** `@garderobe/daily` `test/repair.test.ts` ("wearing a planned shirt today replaces it in the selected option for Thursday", one failure in one root run, passing alone at `450/450`) and evaluation case `B009` (`duplicate_garments_created: expected 0, got 1` in one root run, passing alone). Neither was reproduced in isolation; both are reported to their owners and not resolved here.
   - **Assistant intent policy (`packages/assistant/src/policy/intent.ts`, `wi_18947932bb1272b9`):** post-landing review noted 5 findings on `intent.ts` (`garment.retire` imperative vs completed disposition, `return.update_case` clause binding, `refund\w*` request vs completion, `wordsWithPolarity` negation scope, and `purchase.record_event` UTC vs owner timezone date check); commit `dac9deb4` adds regression tests that the assistant thread says disprove them under the 8-form allow-list. Their disposition is the assistant thread's.

#### B. Owner-only blockers vs remaining engineering and acceptance tasks

1. **Owner-only / external platform blockers:**
   - **Evaluation corpus & taste judging (`EV-001`..`EV-039`, `S17-058`..`S17-064`, `S21-007`, `AM-027`, `AM-028`):**
     - Per owner decisions `dec_1a9c98a0a9562d6d`, `dec_qb0385279ef78ada`, and `dec_7253ba37c2a1cabd`: keep one model (`anthropic/claude-odango-eap`), add no second judge route and no new provider key, **skip the model-backed 64-case corpus run for now** and report it with the exact blocker (Cloudflare AI Gateway `garderobe-dev` rejects its single route `anthropic/claude-odango-eap` with HTTP 401 `"Invalid Anthropic API Key"`), run the candidate-free deterministic checks (`node evals/run.mjs selftest` `61/61`, `node evals/run.mjs adapter-check --strict` `12/13` with `B018` `not_run`, and `node --test tests/journeys/evals/corpus-check.mjs` `15/15`), and report **taste as "not judged"**.
     - If the upstream provider credential on `garderobe-dev` is later restored, run the single-model candidate and deterministic checks (`node evals/run.mjs development --work-dir <dir>`, `node evals/run.mjs freeze --work-dir <dir>`, and, once development gates pass, `node evals/run.mjs holdout --work-dir <dir> --confirm-holdout-one-shot`) while continuing to report taste as "not judged".
   - **Hosted Ferrite preview edge gate & secrets (`ferrite/`, `https://0ldnjvqe9q4auks8.ferrite.cloud`):**
     - Per owner decisions `dec_8c5d9068a2aa2826` and `dec_q8222cdab71f86bd`, the backend is hosted on Ferrite (`https://0ldnjvqe9q4auks8.ferrite.cloud`) rather than Cloudflare development resources.
     - External client and simulation requests without a Ferrite account bearer are redirected (`302`) by the Ferrite preview edge gate (`login.ferrite.cloud/edge/start`), which consumes the single `Authorization` header the app reads; allowing the app's `/v1/*`, `/oauth/*`, and `/mcp` routes through the preview edge gate, supplying `WARDROBE_APP_CLIENT_ID` and `WARDROBE_APP_REDIRECT_URI` for iOS OAuth sign-in, and supplying a working `WARDROBE_AI_GATEWAY` key require platform/owner action.
   - **Physical iOS device signing & Apple entitlements (`ios/`):**
     - Configuring the Apple Developer team ID, OAuth client settings, and Sign in with Apple / APNs entitlements in `ios/project.yml` and running on a physical iPhone pointed at the deployed backend require the owner's Apple Developer account and device.
2. **Remaining engineering and acceptance tasks:**
   - **Commit the remaining working-tree files on `garderobe-rebuild`:** the `ios/` changes (`wi_7fca966a614d64a0`); the Cloudflare `deploy/` tree stays parked unless hosting returns to Cloudflare.
   - **Ferrite live acceptance (`deploy/ferrite/`, `wi_bcb612ab5981c947`):** once the preview edge gate allows app routes through, run `node deploy/ferrite/verify.mjs --deployed`, `node integrations/codex/scripts/verify-codex.mjs --app ferrite`, and the 5-seed MCP simulation (`node tests/simulation/bin/run.mjs --target https://0ldnjvqe9q4auks8.ferrite.cloud --token <mcp-oauth-token> --seed all`).
   - **Native iOS Xcode simulator milestone run (`wi_7fca966a614d64a0`):** trigger `.github/workflows/ios.yml` on `macos-15` after committing the `ios/` files, and verify `bash ios/Tools/check.sh` (all 9 gates).
   - **Final merge into `main`:** once the above gates are green on `garderobe-rebuild`, open, review, and merge the single pull request from `garderobe-rebuild` into `main`.
