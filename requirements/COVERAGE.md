# Requirement coverage audit

This document records an independent audit of `requirements/CHECKLIST.md` against the revision 4 specification, the September 15 owner amendments, the owner profile, the evaluation instructions, the usage research and the kickoff instructions. It was produced by reading the cited code and tests, not by trusting the checklist's wording. The checklist rows themselves stay owned by each area's thread; this document says whether each row's claim holds, lists requirements with no row, and records the document and inventory checks. Final acceptance updates this document when rows are re-audited.

- Audited commit: `8445a1e9d1958da5bc9c307f2c60d727150bf2c9` on `garderobe-rebuild` (5 October 2026).
- Scope: all 1,244 checklist rows (692 marked implemented, 388 partial, 128 open, 36 blocked at that commit).
- Method: the row audit read the files with no test execution; verdicts say what the code and tests contain, not that the tests pass. Test results belong to the integration-health and area threads.
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
| B `rows/B-daily.md` | S01, S02, S07, S09 | 147 | 124 | 22 | 1 |
| C `rows/C-assistant.md` | S06, S10, S12 | 210 | 165 | 44 | 1 |
| D `rows/D-api-mcp-identity.md` | S04, S13, S15 | 168 | 141 | 27 | 0 |
| E `rows/E-ios-media.md` | S03, S11 | 123 | 109 | 14 | 0 |
| F `rows/F-deployment-acceptance.md` | S14, S16, S17, S19 | 172 | 157 | 15 | 0 |
| G `rows/G-coverage-evaluation-research-kickoff.md` | S18, S20, S21, EV, R, KO | 195 | 176 | 18 | 1 |
| **Total** | | **1,244** | **1,075** | **166** | **3** |

- The three unsupported rows are S01-005, S06-076 and S21-012. For S21-012 the behaviour (comfort feedback) exists and is tested; only the row's citations are wrong.
- Most of the 166 weaker rows are marked `implemented`. At least nineteen are citation-only: the behaviour exists and is tested, but not by the files the row cites (listed at the end of `coverage-audit/gaps/tests.md`).
- The twelve rows the second pass moved from verified to weaker are S05-018, AM-030, S06-010, S06-080, S10-062, S10-070, S13-022, S13-047, S15-031, S18-017, R43 and KO-024.
- The checklist itself marked 552 rows partial (388), open (128) or blocked (36) at this commit; nearly all of those are verified as honest descriptions of unfinished work. So of 1,244 rows, the number that are both marked `implemented` and verified is roughly 530.

The findings with the widest effect, each detailed in the gap file named:

1. Changes asked for in conversation or by a connected assistant wait for the owner's confirmation in the app, against the specification's "take effect immediately, with an undo" (see Owner questions below).
2. Outfits are ranked by each garment's own availability, not joint availability (S05-057, `gaps/daily.md`).
3. No Workflow exists; long work runs in the cron handler and `waitUntil` (S04-002, S04-009, S13-030, `gaps/deployment.md`).
4. Several assistant capabilities marked implemented are library code with no production caller: browser policy, claim assessment, model probes, Drive, inventory export (`gaps/assistant.md`).
5. The weather skill and its typed tools reach neither a model nor the assistant (S07-005, `gaps/daily.md`).
6. MRTR and the 2026-07-28 outbound MCP contract are not implemented; `garderobe_ask` returns no evidence or structured objects; two stream objects are never emitted (`gaps/api-mcp.md`).
7. The importer accepts only the profile and the inventory sheet, and the reconciliation report lacks most of the sections the specification lists (S16-009, S16-015, `gaps/domain.md`).
8. Every media test image is synthetic and the owner's 127 garments have no image; no media provider is wired in the Worker (`gaps/media-studio.md`).
9. No device run of the iOS client of any kind (S03-082, `gaps/ios.md`).
10. At the audited commit there was no adversarial suite, no seeded MCP simulation, no candidate run and no judge (`gaps/tests.md`, `gaps/evaluation.md`), and nothing deployed (`gaps/deployment.md`). Other threads were working on each of these.

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

When an area closes a gap it updates its own checklist row. Final acceptance then re-reads the row's code and test, changes the verdict in the part file under `coverage-audit/rows/`, removes or amends the entry in `coverage-audit/gaps/<area>.md`, and updates the totals and the audited commit above. Test results are not recorded here.
