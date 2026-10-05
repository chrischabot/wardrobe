# Coverage audit part G — source coverage, peer review, September 15 additions, evaluation instructions, usage research, kickoff
Audited at commit 8445a1e.

## Summary

This part covers 195 checklist rows: specification section 18 (22 rows), section 20 (23), section 21 (14), the evaluation instructions (40), the usage research requirements R01 to R59 (59) and the kickoff instructions (37). By the rows' own status they are 80 implemented, 71 partial, 43 open and 1 blocked. My verdicts are 179 verified, 15 weaker and 1 unsupported. Of the 15 weaker rows, 10 are weaker in substance (S18-005, S20-013, S20-017, R01, R02, R16, R36, R37, R53, KO-015) and 5 only because the cited test does not exercise the behaviour while another, uncited test does (S18-002, S18-004, R03, R33, R50); the single unsupported row (S21-012) cites foundation files that contain nothing about comfort, although comfort feedback is implemented and tested in the assistant package.

A verdict of verified on an open or blocked row means that the row's "nothing here yet" is accurate, not that the requirement is met: 44 rows are open or blocked and are listed as gaps. The largest groups are the evaluation run itself (25 of 40 evaluation rows are open: no candidate run, no application adapter for the 18 behavioural cases, no judge, no taste scores exist at this commit), the adversarial suite (KO-004) and the seeded MCP simulation (KO-005), for which the directories `tests/adversarial/` and `tests/simulation/` do not exist at this commit, and the deployment rows.

Seven open rows and four partial rows understate what exists (S18-014, S21-008, S21-011, S21-013, S21-014, EV-005, EV-016, KO-007, KO-026, KO-027, R55): code and tests are present elsewhere in the repository but the row does not cite them. I marked these verified for what they cite and say in the Evidence cell what the row misses.

All six September 15 additions (trips and packing, return and exchange deadlines, comfort feedback, pause and resume, lost-login recovery, portable export) have real code and tests that drive the real Worker on local D1, KV, R2 and the Durable Object; none was exercised against Cloudflare Access, Google, APNs or a live model, and the rows that say so are accurate.

Method and limits: this audit read the files and ran nothing (the sandbox shell was unavailable), so no test count or pass result here is an observed run. Test names are quoted from the files with their line numbers. Where a cell cites a test by a paraphrase instead of its name I say so.

## Row verdicts

Abbreviations in the Evidence column: "journey NN" is `tests/journeys/test/NN-*.test.ts`; "corpus-check" is `tests/journeys/evals/corpus-check.mjs`; "trio" is the three foundation test files many rows cite together (`packages/domain/test/availability.test.ts`, `isolation-style-platform.test.ts`, `wear.test.ts`). "(citation)" after weaker means the behaviour exists and is tested elsewhere, but not by the cited test; "(substance)" means the implementation or its proof does less than the row says.

### Specification section 18

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S18-001 | partial | verified | `availability.test.ts:13` treats incoming stock as a hard exclusion; arrival as its own fact is `packages/domain/test/journey-defects.test.ts:48`. Orders live in the assistant package, as the row says. |
| S18-002 | partial | weaker (citation) | None of the trio's tests concerns photographs. The photo rule is tested in `packages/assistant/test/photo.test.ts:71` and `:131`, which this row does not cite (R06 does). Anonymous quantities are `packages/domain/test/laundry.test.ts:71`, also uncited here. |
| S18-003 | implemented | verified | `command-service.test.ts:68` rejects unknown command types and `:84` "a status change can never create an item". |
| S18-004 | partial | weaker (citation) | No trio test asserts that owner thermal preferences are kept apart from garment fabric bounds. The separation exists (`garments.thermal_json` in `handlers/garments.ts:56` versus style rules in `import/profile.ts:253-257`) and is exercised in `packages/daily/test/validation.test.ts:203` and `:211`, uncited here. The row's parenthesis is about perceptible names, not this requirement. |
| S18-005 | implemented | weaker (substance) | Structured paging is correct (`availability.test.ts:47`, `apps/worker/test/commands.test.ts:32` and `:45`, `mcp.test.ts:56`). But `apps/worker/src/mcp/server.ts:205` prints "(more pages: pass nextCursor)" on any page that is not the whole result, including the last page whose cursor is null. That is open defect D14-2 (`tests/journeys/DEFECTS.md:14`, test at journey 14 line 351), recorded against exactly "Pagination is explicit". Status should be partial until it is fixed. |
| S18-006 | implemented | verified | `packages/daily/test/repair.test.ts:123` (option withdrawn, never a placeholder) and `board.test.ts:273` (two shirts give two outfits, no padding). |
| S18-007 | partial | verified | `packages/daily/test/validation.test.ts:71`, `:105`; journey 06 lines 410 and 426 (the cell's test name is a paraphrase of these two). No human evaluation of taste exists, as the row says. |
| S18-008 | partial | verified | `packages/daily/test/render.test.ts:6` renders Calendar text and the web board from one document. The native card was not run on a device, as stated. |
| S18-009 | partial | verified | `wear.test.ts:117` and `:132` show actual wear is authoritative. The board-revision and no-connector parts are in other packages, as the row says (see R27, R30). |
| S18-010 | implemented | verified | `packages/domain/test/laundry.test.ts:100` and `:203` (a pickup with no reported return is inferred returned, labelled as inferred). |
| S18-011 | implemented | verified | `repair.test.ts:65` (the owner's own piece survives repair and republication), `board.test.ts:507`; the brief surviving a later repair is asserted in `packages/daily/test/profile-format.test.ts:151-156`, which this row does not cite. |
| S18-012 | implemented | verified | `board.test.ts:345-347` asserts the composition request's context contains the whole stored profile. The model is a labelled fake; the context assembly under test is real. |
| S18-013 | implemented | verified | `packages/assistant/test/ledger-tools.test.ts:141` (the analysis carries the caveat "unlogged, not unworn") and `research/commerce/fit.test.ts:52` (a missing measurement stays missing). |
| S18-014 | partial | verified | What it cites is accurate. The row is out of date: drop reminders as their own event type exist (`packages/assistant/src/commands/reminders.ts`) and `ledger-tools.test.ts:48-59` asserts the separate `calendar.project_reminder` effect (R47 cites it). |
| S18-015 | partial | verified | `availability.test.ts:21` retires by physical departure. "A drafted listing never means the item left" is `packages/assistant/test/commands.test.ts:197`, uncited here. |
| S18-016 | partial | verified | `packages/daily/test/calendar.test.ts:93` and `render.test.ts:6`; the native surface was not run on a device, as stated. |
| S18-017 | implemented | verified | `apps/worker/test/mcp.test.ts:79`, `surfaces.test.ts:426`. Recovery from an actual phone was not timed (R58 says so). |
| S18-018 | partial | verified | The row claims only what can be built without live services; `packages/assistant/src/index.ts` exists and the cited tests use labelled fakes. |
| S18-019 | implemented | verified | `apps/worker/test/auth.test.ts:107` and `commands.test.ts:244`; foundation isolation is `isolation-style-platform.test.ts:28`. Sign-in is a test-signed Access assertion checked by the Worker's real verification code; no real Access or Google login was exercised. |
| S18-020 | partial | verified | Same basis as S18-018; adapters are tested against fakes (`adapters-jobs.test.ts:126`, `:159`). |
| S18-021 | partial | verified | `ios/Config/Base.xcconfig:25` sets the deployment target 27.0; `apps/worker/test/surfaces.test.ts:326`, `:381` cover capture and Studio routes. |
| S18-022 | open | verified | Nothing tracks the setup inputs; there is no `deploy/` directory. Not implemented. |

### Specification section 20

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S20-001 | implemented | verified | `apps/worker/test/backup.test.ts:99`, `:128`, `:154` (restore into an empty owner with tombstones). Watermarks are asserted in `packages/assistant/test/ledger-tools.test.ts:371`, uncited. Local stores only, as stated. |
| S20-002 | implemented | verified | `packages/assistant/test/conversation.test.ts:14-31`: the full profile text is in the system context of a short sock question. |
| S20-003 | partial | verified | `isolation-style-platform.test.ts:178`; `packages/domain/test/style-facts.test.ts:82` (a reworded passage never changes a fact by itself). |
| S20-004 | implemented | verified | `isolation-style-platform.test.ts:291` (a resampled proposal resolves to the same action and one command); `migrations/0001_foundation.sql:116`. |
| S20-005 | implemented | verified | `migrations/0001_foundation.sql:70` (`command_preconditions`); `command-service.test.ts:95`, `:139`, `:172`. |
| S20-006 | partial | verified | `apps/worker/test/mcp.test.ts:23`, `:304`, `:322`, `:343`, `:373`. No test with the actual Claude or ChatGPT client and no phone consent exists, as the row says. |
| S20-007 | open | verified | Nothing exists. Not implemented. |
| S20-008 | implemented | verified | `packages/assistant/test/turn-control.test.ts:38`, `:97`, `:121`, `:163`, `:182`. Fake model at the model boundary; queueing and Stop are real. |
| S20-009 | implemented | verified | `conversation.test.ts:71`, `memory.test.ts:86`, `:146`, `journeys.test.ts:333`. |
| S20-010 | partial | verified | `ios/GarderobeKit/Tests/GarderobeKitTests/OwnerJourneys.swift:8`, `CommandCenterTests.swift:179`. Not run on a device, as stated. The row drops the finding's "provisional uncertainty" (specification line 1237). |
| S20-011 | implemented | verified | `packages/assistant/test/inference.test.ts:10`, `:30-32`, `:134`. The generated-answer restriction is tested in `research/web/extract.test.ts` and `connectors.test.ts`, which the row does not cite. |
| S20-012 | partial | verified | `packages/media/test/discovery.test.ts:265` and `:257`. No Browser Run provider was connected, as stated. |
| S20-013 | partial | weaker (substance) | The all-day presentation setting is tested (`packages/daily/test/calendar.test.ts:122`, `packages/contracts/src/ext/daily.ts:596`). I found no code or test for a setup preview of the calendar presentation or for importing presentation preferences (searched the repository for calendar preview symbols). The cell says the daily part is complete and lists only budgeting and protocol evidence as remaining. |
| S20-014 | open | verified | Nothing exists. Not implemented. |
| S20-015 | partial | verified | `RunFollower.swift` exists; the cell cites no test and says the phone transport gate was not run. |
| S20-016 | implemented | verified | `packages/daily/test/validation.test.ts:162`, `:178`, `:194`; `weather-assess.test.ts` (26 tests). |
| S20-017 | implemented | weaker (substance) | Suppression, overlay regeneration and retention reporting are tested (`memory.test.ts:146`, `ledger-tools.test.ts:228-243`). The stores handled are transcript, summaries, AI Search and the ledger (`packages/assistant/src/commands/memory.ts:86-94`). Nothing in `packages/assistant/src` handles Browser Run recordings (no match for "recordings"), and Workflow or Queue data is covered only as cancelled queued jobs (`memory.ts:134-138`). |
| S20-018 | partial | verified | `apps/worker/test/routes.test.ts:8`; `BoundaryTests.swift:119`, `:191`. The deployed Access application was not used, as stated. |
| S20-019 | implemented | verified | `packages/assistant/src/agent/assistant.ts:318` (`onCompaction`); `memory.test.ts:91-92` asserts a compaction reservation. The job-level AI Search reservation is asserted in `search-projection.test.ts:67-69`, which the row does not cite (it cites `inference.test.ts` for it). |
| S20-020 | blocked | verified | Only a fake AI Search index is used (`search-projection.test.ts:31`). Not provisioned. |
| S20-021 | open | verified | Nothing exists. Not implemented. |
| S20-022 | open | verified | Nothing exists. Not implemented. |
| S20-023 | open | verified | Nothing exists. Not implemented. |

### Specification section 21

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S21-001 | implemented | verified | `availability.test.ts:96` (a week without confirmation leaves every piece offerable) and `:126`. |
| S21-002 | implemented | verified | `wear.test.ts:10`, `:40`, `:54`. |
| S21-003 | implemented | verified | `wear.test.ts:92`, `:117`; `command-service.test.ts:112`. |
| S21-004 | implemented | verified | `packages/daily/test/repair.test.ts:171` (wearing a planned shirt replaces it in Thursday's selected option). |
| S21-005 | partial | verified | `packages/daily/test/calendar.test.ts:132`, `:151`, against the labelled fake Google Calendar, as stated. |
| S21-006 | implemented | verified | `calendar.test.ts:31` (three of five options shaped, two alternatives) and `:43`. |
| S21-007 | open | verified | No judge, judgment file or run directory exists anywhere in the repository. Not implemented. |
| S21-008 | partial | verified | Trips and pause are as cited (`packages/daily/test/trips.test.ts`, 6 tests; `service.test.ts:243-342`). The row is out of date about the other four: return deadlines (`packages/assistant/test/commands.test.ts:128`, `:142`), comfort (`commands.test.ts:229`), recovery (`apps/worker/test/identity.test.ts:100`) and export (`apps/worker/test/export.test.ts`, 15 tests) exist; KO-024 and the section 10 rows cite them. |
| S21-009 | implemented | verified | `apps/worker/test/identity.test.ts:10`, `:100`, `:185`, `:209`, through the real Worker routes; journey 13 lines 62-209. Sign-in assertions are test-signed. |
| S21-010 | implemented | verified | `packages/daily/test/service.test.ts:243`, `:282`, `:324`, `:342`. |
| S21-011 | partial | verified | Same as S21-008: the cited trip evidence is accurate and the "remaining" note is out of date (journey 08 has 15 return tests, journey 13 covers export). |
| S21-012 | partial | unsupported | The cited code (`handlers/garments.ts`, `queries.ts`, the garment tables) and the trio contain nothing about comfort. The requirement itself is implemented and tested elsewhere: `packages/assistant/src/commands/feedback.ts`, `packages/assistant/test/commands.test.ts:229`, `journeys.test.ts:224`, journey 09 (13 tests). The row needs those citations. |
| S21-013 | open | verified | Out of date in part: corpus-check lines 104-112 check the unchanged profile and the separate amendments (EV-004 cites it). The 492-conversation provenance is not checked by anything. |
| S21-014 | open | verified | Out of date in part: corpus-check line 160 requires `historical_images_available === false` for every case, and its report text (line 296) says it is not evidence that the application passes. Nothing else exists. |

### Evaluation instructions

Every implemented or partial row here cites `tests/journeys/evals/corpus-check.mjs`. That file is a standalone Node script with 13 named checks (`check(...)` at lines 88 to 287). It is run by `npm run evals:check -w @garderobe/journey-tests`, needs `python3`, and is not part of `npm test` (`tests/journeys/README.md:20`). It validates the bundled assets, the packet isolation and the grader's negative controls; it runs no candidate, calls no model and judges nothing (its own header, lines 5-7, and its report text, line 296). I read it and did not run it.

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| EV-001 | partial | verified | corpus-check lines 88-95 count 64 cases, 40 historical and 24 constructed. The row's limit ("no candidate has been run on any case and nothing is judged") is accurate. |
| EV-002 | open | verified | No Codex judging and no deterministic evaluation-case check against application state exist. Not implemented. |
| EV-003 | partial | verified | corpus-check lines 116-137: 42 excerpts keep their references, 38 are re-hashed, 4 need the absent export. |
| EV-004 | implemented | verified | corpus-check lines 104-112 compare the bundled profile's SHA-256 with the recorded hash and require the separate amendments file. |
| EV-005 | open | verified | Out of date in part: corpus-check lines 158-161 check that the fixture is labelled constructed and that no case claims images. No adapter applies a case's observations over fixture defaults. |
| EV-006 | open | verified | Nothing checks this; corpus-check line 155 says it cannot be re-derived without the export. Not implemented. |
| EV-007 | implemented | verified | corpus-check lines 97-102 (45 and 19) and 139-156 (no conversation in both splits; calibration from development conversations only). This is a check of the bundle; no run has used the split yet. |
| EV-008 | partial | verified | corpus-check lines 168-192 build all 64 candidate packets and search them for criteria, source feedback, historical answers and expected state; lines 194-199 are a planted-leak control; lines 201-214 refuse a judge packet without a candidate. No real candidate run exists, as stated. |
| EV-009 | open | verified | No candidate runner, no filesystem isolation and no exposure record exist. Not implemented. |
| EV-010 | partial | verified | corpus-check lines 163-166 (`list`) and 277-285 (`validate` stops on the absent export). |
| EV-011 | open | verified | No run directory or run record exists. Not implemented. |
| EV-012 | open | verified | Nothing maps a board to the candidate schema (`response`, `options`, `garment_ids`, `explanation`). Not implemented. |
| EV-013 | partial | verified | `packages/daily/test/board.test.ts:273`; no `shortage_reason` mapping exists, as stated. |
| EV-014 | partial | verified | Journey 11 lines 82, 112, 191 and 224 assert stored receipts and read-back state, not reply text (the cell's test name is a paraphrase). The model in that journey is the labelled fake. |
| EV-015 | partial | verified | corpus-check lines 216-248 run `check-candidate` on labelled controls only. |
| EV-016 | open | verified | Nothing is built, so nothing grades itself; corpus-check calls no model (lines 5-7). Listed as open because no run exists. |
| EV-017 | open | verified | No application adapter, no `observed` record and no `check-state` run on application output exist. Not implemented. |
| EV-018 | partial | verified | corpus-check lines 250-268 check the 18 cases and that state without adapter provenance is refused, with labelled controls. The adapter is not built, as stated. |
| EV-019 | open | verified | No taste scoring exists. Not implemented. |
| EV-020 | open | verified | No judgment exists. Not implemented. |
| EV-021 | open | verified | No measurement against the release targets exists. Not implemented. |
| EV-022 | open | verified | No repeated runs exist. Not implemented. |
| EV-023 | open | verified | No model comparison exists. Not implemented. |
| EV-024 | partial | verified | `board.test.ts:305-356` gives a labelled fake model the full profile text; no real board has been judged, as stated. |
| EV-025 | implemented | verified | corpus-check lines 270-274 check that the eight reviews are well-formed and label them calibration only; `tests/journeys/README.md:102-108` says the same. The test checks form; the "never reported as validation" part is a wording rule that these two texts follow. |
| EV-026 | partial | verified | Journey 05 (25 tests) collects receipts, board revisions and Calendar read-backs from the labelled Calendar double (`tests/journeys/src/outbound.ts`). Local only, as stated. |
| EV-027 | partial | verified | All eight cited journey files exist with the named journeys (03: 23 tests, 04: 15, 05: 25, 07: 19, 08: 15, 09: 13, 10: 14, 13: 23 `it` call sites). D14-2 is still open (`DEFECTS.md:14`). |
| EV-028 | open | verified | No rebuild script was run by anything in the repository; corpus-check line 287-292 proves the bundle is unchanged by its own run. No guard exists beyond that. |
| EV-029 | open | verified | No judge exists. Not implemented. |
| EV-030 | open | verified | No judge exists. Not implemented. |
| EV-031 | open | verified | No judge exists. Not implemented. |
| EV-032 | open | verified | No judge exists. Not implemented. |
| EV-033 | open | verified | No judge exists. Not implemented. |
| EV-034 | open | verified | No judge exists. The bundle's structural grader catches four of the listed violations on controls (corpus-check lines 234-243), which is EV-015, not a judgment. |
| EV-035 | open | verified | No judge exists. Not implemented. |
| EV-036 | open | verified | No judge exists. Not implemented. |
| EV-037 | open | verified | No judgment object has been produced; corpus-check line 271 validates only the eight bundled historical judgments. |
| EV-038 | open | verified | No pairwise work exists. Not implemented. |
| EV-039 | open | verified | No judgment is claimed anywhere I read; no candidate packets have been collected and marked pending either. |
| EV-040 | implemented | verified | corpus-check lines 276-285 and 297 report that the private export was not rechecked and how many excerpts were re-hashed. |

### Usage research requirements R01 to R59

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| R01 | implemented | weaker (substance) | The tool and command path is real and tested (`packages/assistant/test/journeys.test.ts:30`, `adapters-jobs.test.ts:412`, `photo.test.ts:115`). Three limits the row does not state: the reading of the email, photo or sentence into fields is scripted by the labelled fake model in every cited test; creation is a request the owner confirms, not one exchange (`journeys.test.ts:30` "once the owner confirms it"; `photo.test.ts:71`); and the `add_garment` tool has no field for a thermal range, price or order reference (`packages/assistant/src/tools/write.ts:88`). R10 and R13 are marked partial for the same live-model reason. |
| R02 | implemented | weaker (substance) | Incoming stock contributing nothing is tested (`availability.test.ts:13`, `packages/domain/test/journey-defects.test.ts:48`). The cited foundation code has no expected-arrival field (no match for an expected-arrival name in `packages/domain` or the migrations). The only such field is the free-text `arrivalEstimate` on assistant order lines (`packages/contracts/src/ext/assistant.ts:229`), uncited, tested only in the pure merge at `research/commerce/orders.test.ts:64`. |
| R03 | partial | weaker (citation) | No trio test stores or reads an order reference, fabric code or price. Storage is tested in `packages/assistant/test/commands.test.ts:44` and the board carrying no codes in `packages/daily/test/render.test.ts:6`; neither is cited here. |
| R04 | implemented | verified | `command-service.test.ts:11` "returns a verified receipt that matches the stored ledger state". |
| R05 | implemented | verified | `packages/domain/test/laundry.test.ts:71`; quantity-aware availability at `availability.test.ts:193` (uncited). |
| R06 | implemented | verified | `packages/assistant/test/photo.test.ts:71`, `:104`, `:131`. The refusal to log from a photo alone is deterministic policy; how well a real vision model matches a photo to rows is not exercised (fake model). |
| R07 | implemented | verified | `command-service.test.ts:31` (idempotency key), `:139` (a batch rolls back whole). |
| R08 | partial | verified | `isolation-style-platform.test.ts:268`. The single question is tested in `packages/assistant/test/journeys.test.ts:76`, uncited. |
| R09 | implemented | verified | `command-service.test.ts:84`. |
| R10 | partial | verified | Receipts come from the ledger (`conversation.test.ts:34`); model prose is unjudged, as stated. |
| R11 | partial | verified | `packages/daily/test/validation.test.ts:203` (research rules retained but not enforced until reconciled) and `:211`; the five thresholds are `pending_reconciliation` in `packages/domain/src/import/profile.ts:253-257`. |
| R12 | implemented | verified | `packages/domain/test/bulk-correct.test.ts:9`, `:49`, `:68`. |
| R13 | partial | verified | Same basis as R10. |
| R14 | implemented | verified | `wear.test.ts:143`; `packages/domain/test/review-findings.test.ts:159`. |
| R15 | implemented | verified | `availability.test.ts:13-31` (benched by planning policy with a reason, retired by an explicit command); `import.test.ts:169`. There is no delete command at all. |
| R16 | implemented | weaker (substance) | Same as S18-005: structured results are complete and explicit (`apps/worker/test/commands.test.ts:32`, `mcp.test.ts:56`), but open defect D14-2 (`apps/worker/src/mcp/server.ts:205`; `tests/journeys/DEFECTS.md:14`, which names rows R14 to R16) leaves the text beside the last MCP page saying more pages follow. |
| R17 | implemented | verified | `packages/daily/test/service.test.ts:28`; `board.test.ts:358`. |
| R18 | implemented | verified | `board.test.ts:102`, `:386`; `repair.test.ts:32`, `:102`. |
| R19 | implemented | verified | `repair.test.ts:32`, `:123`; `review-regressions.test.ts:148`. |
| R20 | implemented | verified | `validation.test.ts:51`, `:71`, `:128`, `:162`. The outerwear ceiling is not enforced until the owner activates it (`validation.test.ts:203`); the cell says so. |
| R21 | implemented | verified | `validation.test.ts:292`; `board.test.ts:51`, `:119`. |
| R22 | partial | verified | `board.test.ts:449` (never navy by default); `profile-format.test.ts:91`. Boldness, anti-rut and academic blazer have no board check, as stated. |
| R23 | partial | verified | `render.test.ts:6`. |
| R24 | implemented | verified | `render.test.ts:6` ("with perceptible names and no codes or diagnostics"). |
| R25 | partial | verified | `render.test.ts:6`; `board.test.ts:305` (the unsupported "cashmere" claim is stripped, lines 336-339). |
| R26 | implemented | verified | `render.test.ts:6`, `:43`; also `apps/worker/test/surfaces.test.ts:98` and journey 01 line 262. |
| R27 | partial | verified | `wear.record` takes garment IDs only (`packages/contracts/src/commands.ts:169-179`; no option or board field). No wear-by-option command exists; the client sends the chosen option's garment IDs (journey 01 lines 176-180). Wear by description is the assistant's `record_wear` tool. |
| R28 | implemented | verified | `wear.test.ts:224` (amendment), `:175` (undo keeps both receipts). |
| R29 | implemented | verified | `repair.test.ts:171`, `:32`. |
| R30 | partial | verified | `OwnerMorningJourney.swift:84`; server side, journey 01 uses `POST /v1/commands` with no conversation. Not run on a device, as stated. |
| R31 | implemented | verified | `laundry.test.ts:9`. |
| R32 | implemented | verified | `laundry.test.ts:56`. |
| R33 | implemented | weaker (citation) | The cited `laundry.test.ts` has no test of never-laundered roles. The behaviour is tested in `wear.test.ts:80` ("a never-laundered item gets no laundry state") and journey 03 line 83, which the row does not cite. |
| R34 | implemented | verified | `board.test.ts:449`, `:507`; `profile-format.test.ts:132-150`. |
| R35 | implemented | verified | `profile-format.test.ts:151-156`. |
| R36 | implemented | weaker (substance) | The cited test (`packages/assistant/test/ledger-tools.test.ts:93-100`) asserts only that a recording hook, which the file says "stands for any lane's commit hook" (line 41), saw `care.mark_dirty`. No board is read in that test. The conversation also has no tool to swap a slot, rebuild an option or choose one (the tool list in `packages/assistant/src/tools/write.ts:58-426` has none; a day brief is the only board-facing tool). I did not find a test in which a conversation turn changes a board and the board is read back. |
| R37 | implemented | weaker (substance) | The research names the attributes the theory needs as family, value, temperature, saturation, texture and pattern (research lines 82 and 209). The ledger holds colour, pattern and fabric (`packages/contracts/src/garment.ts:94-120`); there is no field for colour value, temperature, saturation or pattern scale anywhere in `packages/`. The cited test (`conversation.test.ts:14-31`) asserts the profile and every garment ID are in the context, not these attributes. |
| R38 | partial | verified | `board.test.ts:345-347`, with the labelled fake model, as stated. |
| R39 | partial | verified | `isolation-style-platform.test.ts:214`. Stating a direction in a sentence is tested in `packages/assistant/test/journeys.test.ts:244`, uncited. |
| R40 | partial | verified | `board.test.ts:449`, `profile-format.test.ts:91`. |
| R41 | implemented | verified | `ledger-tools.test.ts:182` (every garment row once, wear history by date). |
| R42 | partial | verified | `apps/worker/test/commands.test.ts:32`. Per-item and per-category wear analysis with last-worn is `ledger-tools.test.ts:141-157`, uncited here. |
| R43 | partial | verified | Colour filter at `packages/domain/src/queries.ts:266`. |
| R44 | implemented | verified | `isolation-style-platform.test.ts:239`; `packages/domain/test/style-facts.test.ts:23`. |
| R45 | implemented | verified | `bulk-correct.test.ts:89`. |
| R46 | implemented | verified | `ledger-tools.test.ts:159-179`. |
| R47 | implemented | verified | `ledger-tools.test.ts:48-91`: a drop reminder with its own notification and `calendar.project_reminder` effects, nothing on the outfit event. Delivery to a real Calendar was not exercised. |
| R48 | partial | verified | Accessories are categories and an `accessoryKind` (`garment.ts:70-74`); offered on the belt line (`profile-format.test.ts:106`). The research's "register tags" (line 108) do not exist. |
| R49 | partial | verified | `stock.reconcile` is per garment (`laundry.test.ts:71-77`); `ReconcileModel` exists in `ios/GarderobeKit/Sources/GarderobeKit/Features/ItemModel.swift`. |
| R50 | partial | weaker (citation) | Nothing in `packages/domain` mentions `for_sale` (the kind is declared in `packages/contracts/src/garment.ts:143`), so no cited test exercises it. The for-sale hold and listing project are tested in `packages/assistant/test/confirmation.test.ts:186` and `commands.test.ts:197`, uncited here. |
| R51 | partial | verified | Page retrieval against fakes (`adapters-jobs.test.ts:126`); form filling waits on Browser Run, as stated. |
| R52 | implemented | verified | `isolation-style-platform.test.ts:127-135` (reason and `expectedEnd`); `garment.move` to the tailor carries `expectedReturn` and a note (`commands.ts:123-130`), tested at `wear.test.ts:117`. |
| R53 | implemented | weaker (substance) | Location exists only as the stock bucket (home, storage, tailor, trip, service: `packages/contracts/src/inventory.ts:63`; `availability.test.ts:20`, `:31`). The research's location field ("hallway, closet, storage", line 125) cannot be recorded, and no cited test mentions a location. |
| R54 | partial | verified | `packages/daily/test/calendar-google.test.ts` (19 tests) and `calendar.test.ts:31`, against the labelled fake, as stated. |
| R55 | partial | verified | The cell cites only iOS code and no test; no Swift test covers `TemperaturePreviewModel`. The server side is tested (`packages/daily/test/validation.test.ts:405`, `apps/worker/test/surfaces.test.ts:156`, journey 02 line 189) but not cited. |
| R56 | partial | verified | The Swift journeys exist; appearance was not inspected by a person, as stated. |
| R57 | implemented | verified | `apps/worker/test/mcp.test.ts:79`, `surfaces.test.ts:230`. Changes other than routine reports wait for the owner's confirmation in the app (`mcp-command-classes.test.ts:58`). |
| R58 | partial | verified | `mcp.test.ts:343`; not timed from a phone, as stated. |
| R59 | implemented | verified | `service.test.ts:28`; `board.test.ts:162`, `:358`; journey 10 line 130. |

### Kickoff instructions

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| KO-001 | implemented | verified | `README.md:3-6` states it; `packages/domain/test/import.test.ts:108` imports only the profile and the sheet. That no old code was reused is a negative I did not test (I was told to ignore the sibling archive). |
| KO-002 | partial | verified | The cited backend, API, MCP and iOS sources exist; the limits in the cell (no device run) are accurate. |
| KO-003 | implemented | verified | Fourteen journey files exist under `tests/journeys/test/` with 262 `it` or `defect` call sites (one, journey 06 line 109, is inside a loop over the scripted days, so the run count is higher). They drive the real Worker through `SELF` and the production entry with a fake model (`tests/journeys/src/world.ts:6-9`, `vitest.config.ts:8`). I could not run the suite, so the cell's "265 tests" is not confirmed. `DEFECTS.md` lists 25 defect IDs (1 open, 1 under watch, 23 fixed), not the 24 the cell gives. Conversation journeys (11, 14) use the fake model; no interface-level test is in this suite. |
| KO-004 | open | verified | `tests/adversarial/` does not exist at this commit. See the Gaps section for the adversarial-flavoured tests that do exist inside the packages. Not implemented as a suite. |
| KO-005 | open | verified | `tests/simulation/` does not exist at this commit and nothing in the repository selects outfits at random from a seed. Not implemented. |
| KO-006 | implemented | verified | `import.test.ts:10`, `:108`; `tools/verify-documents.mjs`. "Every requirement is read" cannot be shown by a test; the Unmapped section below lists source statements without a row. |
| KO-007 | open | verified | Out of date: the checklist exists and `tools/check-checklist.mjs` checks its structure and cited paths (`package.json:25`). The row cites neither. |
| KO-008 | partial | verified | Cited sources exist; limits as stated (17 of 18 UI tests, no device). I did not see the workflow run. |
| KO-009 | partial | verified | `import.test.ts:108`; journey 02 line 116; journey 06 (27 call sites, independent checker in `tests/journeys/src/profile-checker.ts`). Model-composed boards are not judged, as stated. |
| KO-010 | implemented | verified | `import.test.ts:26`, `:93`, `:108`; journey 02 line 36. |
| KO-011 | implemented | verified | `import.test.ts:10`; `requirements/SHA256SUMS`. |
| KO-012 | implemented | verified | `import.test.ts:26`, `:75`, `:93`; `data/import/inventory-import-report.md`. |
| KO-013 | implemented | verified | `import.test.ts:108` ("invents nothing"); journey 02 lines 60 and 86. |
| KO-014 | partial | verified | Think, Durable Object and Gateway adapters are in `packages/assistant` (`src/agent/assistant.ts:4`, `:18`); nothing ran on the hosted services, consistent with partial. |
| KO-015 | implemented | weaker (substance) | Adapters are isolated and versions are pinned (`packages/assistant/package.json:17-24`). But the cited tests use fakes at exactly the service boundaries the row is about (`inference.test.ts:9` "FAKE MODELS at the model boundary only"; `search-projection.test.ts:31` "FAKE AI Search index"), and no live probe ran. S18-018, on the same subject, is marked partial; this row should be too. |
| KO-016 | partial | verified | `apps/worker/test/mcp.test.ts:79` (the MCP receipt is the one the API serves); the Swift contract check was not run by me. |
| KO-017 | implemented | verified | `availability.test.ts:66`, `:96`, `:126`, `:154`. |
| KO-018 | implemented | verified | `laundry.test.ts:100`, `:151`, `:180`, `:194`. |
| KO-019 | implemented | verified | `wear.test.ts:92`, `:106`, `:117`, `:132`. |
| KO-020 | implemented | verified | `wear.test.ts:10`, `:40`, `:54`. |
| KO-021 | implemented | verified | `repair.test.ts:171`, `:225`; `review-regressions.test.ts:157`. |
| KO-022 | partial | verified | `calendar.test.ts:132`, `:151`, against the labelled fake, as stated. |
| KO-023 | partial | verified | The Today, Wardrobe, Studio, Conversation and Capture screen directories exist under `ios/App/Garderobe/Screens/`. I counted 104 `@Test` or `func test` sites in `GarderobeKitTests`; the cell says 97 passed. Not run by me. |
| KO-024 | implemented | verified | `apps/worker/test/surfaces.test.ts:132` (packing), `:310` (comfort and a return), `:114` (pause); `identity.test.ts:100`; `export.test.ts:78-454`. All through the real Worker routes on local stores. |
| KO-025 | partial | verified | Journey 01 and 04 read state and receipts back through the API. The simulation half does not exist. |
| KO-026 | open | verified | Out of date in part: corpus-check's report text (line 296) and `tests/journeys/README.md:102` treat the corpus as calibration and not proof. The row cites neither. |
| KO-027 | open | verified | Out of date in part: the split and packet isolation are checked on the bundle (EV-007, EV-008). No candidate run and no independent taste judging exist. |
| KO-028 | partial | verified | Journey 02 line 36 (127 garments, 144 units); synthetic garments are created with `isSynthetic` and a SYNTHETIC name (`tests/journeys/README.md:144-147`). |
| KO-029 | partial | verified | `ios/README.md:128` "What ran on macOS" and `:169` "What has not run". |
| KO-030 | partial | verified | `ios/README.md:184` "Remaining checks on a Mac and a device". No equivalent Cloudflare checklist exists yet. |
| KO-031 | open | verified | Nothing is cited. No Cloudflare API token name appears outside `requirements/` (searched for `CLOUDFLARE_API_TOKEN` and `CF_API_TOKEN`). No test or document addresses the rule. |
| KO-032 | open | verified | No deployment record exists in the repository. Not implemented. |
| KO-033 | open | verified | Nothing exists. Not checkable from the repository. |
| KO-034 | open | verified | Nothing exists. Not checkable from the repository. |
| KO-035 | partial | verified | Only the iOS part is cited. I found no source archive and no consolidated test-results document; `requirements/COVERAGE.md` is being written now. |
| KO-036 | partial | verified | `ios/App/CONVENTIONS.md` and `ios/App/Garderobe/Design/Theme.swift` exist; not inspected by a person, as stated. |
| KO-037 | partial | verified | The Xcode project and generator exist. Wrangler configuration (`apps/worker/wrangler.jsonc`), 20 migrations and local run notes (`apps/worker/README.md`) also exist but are not cited; there are no deployment instructions beyond `apps/worker/README.md:138`. |

## Gaps

Each gap names the row, the source line, what is missing and where I looked. Rows that are open or blocked are included because they are not implemented, even where the row itself is accurate.

### domain

- **R02 (research line 279; specification line 1163): expected arrival is not a ledger fact.** No expected-arrival field exists in `packages/domain` or the migrations. The only place an arrival estimate is kept is the free-text `arrivalEstimate` on an assistant order line (`packages/contracts/src/ext/assistant.ts:229`, `:312`). The row is marked implemented and cites foundation files only.
- **R37 (research lines 322, 82 and 209): the attributes the style theory needs are only partly stored.** `Garment` has colour, pattern and fabric (`packages/contracts/src/garment.ts:94-120`). Colour value, colour temperature, saturation and pattern scale are not fields anywhere in `packages/`; the daily service derives only a colour family from the colour text (`packages/daily/src/model.ts:32`). The row is marked implemented.
- **R53 (research lines 340 and 125): location is only the stock bucket.** Home, storage, tailor, trip and service are representable (`packages/contracts/src/inventory.ts:63`); "hallway" or "closet" is not, and no cited test mentions a location. The row is marked implemented.
- **R27 (research line 308; specification line 1171): no wear by option number.** `wear.record` accepts garment IDs only (`packages/contracts/src/commands.ts:169-179`); the board revision and option are not part of a wear. The client translates the chosen option into garment IDs (journey 01 lines 176-180). The row is marked partial and says so.
- **R48 (research lines 333 and 108): no register tags on accessories.** The row is partial; its wording drops the research's "with register tags".
- **R49 (research line 336): reconciliation is per garment.** `stock.reconcile` takes one garment (`packages/domain/test/laundry.test.ts:75`); there is no command that lists a category and takes the owner's word for the whole shelf in one act. The row is partial.
- **Citations to correct on foundation rows.** S18-002 and S18-004 (specification lines 1164 and 1166), R03 (research line 280), R33 (line 314), R50 (line 337) and S21-012 (specification line 1267) cite the same three foundation test files, none of which exercises the behaviour of the row. The behaviour is tested in the files named in each row's Evidence cell. S21-012 is the extreme case: its cited code and tests contain nothing about comfort.

### daily

- **S20-013 (specification line 1241): no setup preview and no import of calendar presentation preferences.** Only the timed or all-day setting exists (`packages/contracts/src/ext/daily.ts:596`, `packages/daily/test/calendar.test.ts:122`). The cell says the daily part is complete.
- **R22 and R40 (research lines 301 and 325): boldness, anti-rut and academic blazer have no board-level check.** Only the navy rule and the neutral count are checked against a board (`packages/daily/test/board.test.ts:449`, `profile-format.test.ts:91`). Rows are partial and say so.
- **R11 and R20 (research lines 288 and 299): the five research thresholds are not enforced.** They are stored as `pending_reconciliation` (`packages/domain/src/import/profile.ts:253-257`) and `validation.test.ts:203` asserts they are not applied. This waits on the owner reconciling them; R20 is marked implemented with that limit in its note.
- **EV-013 (evaluation README line 68): no `shortage_reason`.** The board states a shortage in its notice (`board.test.ts:273`); nothing maps it to the evaluation schema.
- **S18-014, S21-008, S21-011 (specification lines 1176 and 1267): rows out of date.** They say reminders, returns, comfort, recovery and export are still to come; all exist and are cited by other rows.

### API/MCP

- **S18-005 and R16 (specification line 1167; research line 293): open defect D14-2.** `apps/worker/src/mcp/server.ts:205` tells a connected assistant that more pages follow on the last page of the item list. Both rows are marked implemented; `tests/journeys/DEFECTS.md:14` records the defect against these rows and the test at journey 14 line 351 is an expected failure in the default run.
- **S20-006 (specification line 1233): no test with the actual Claude or ChatGPT client and no consent from a phone.** `apps/worker/test/mcp.test.ts` uses the MCP SDK client through the real OAuth flow. Row partial.
- **R58 (research line 347): reconnection was not timed from a phone.** Row partial.
- **S18-019 and S21-009 (specification lines 1181 and 1267): sign-in is a test-signed assertion.** The Worker's verification code is real (`apps/worker/test/auth.test.ts:21-59`), and recovery binds a new sign-in to the same account (`identity.test.ts:100`), but no Cloudflare Access or Google login has been exercised. Both rows are marked implemented.

### assistant

- **R36 (research line 319): no proof that a change accepted in conversation lands in the board.** The cited test checks a recording stand-in hook (`packages/assistant/test/ledger-tools.test.ts:41-44`, `:93-100`), and the conversation has no swap, rebuild or choose tool (`packages/assistant/src/tools/write.ts:58-426`). Marked implemented.
- **R01 (research line 278): reading into fields is scripted, creation needs a confirmation, and the garment tool lacks fields.** See the row. Marked implemented.
- **S20-017 (specification line 1253): Browser Run recordings and Workflow or Queue data are not handled as retained stores.** `packages/assistant/src/commands/memory.ts:86-94` lists transcript, summaries, AI Search and the ledger. Marked implemented.
- **KO-015 (start-prompt line 17): service contracts are checked only against fakes.** `inference.test.ts:9`, `search-projection.test.ts:31`. Marked implemented.
- **R10, R13, R38, EV-024 (research lines 287, 290, 323; evaluation README line 99): no live model has produced a reply or a board.** Every conversation and composition test uses the labelled fake model. Rows are partial and say so.
- **R51 (research line 338): no form filling on the owner's behalf.** Waits on the Browser Run session binding. Row partial.
- **S20-020 (specification line 1256): AI Search instances are not provisioned.** Blocked.
- **S18-018, S18-020 (specification lines 1180 and 1182): live Gateway, AI Search, Google, Exa, Tavily and Browser Run remain untested.** Rows partial.

### media/Studio

- **S20-012 (specification line 1239): no Browser Run provider is connected and thumbnails ran only against the local Images binding.** The estimate itself is tested (`packages/media/test/discovery.test.ts:265`). Row partial. No other row in this part belongs to media.

### iOS

- **S18-008, S18-016, S18-021, S20-010, S20-015, S20-018, R30, R56, KO-023, KO-036: nothing ran on a device and no person inspected the interface.** The rows say so. The phone transport gate (S20-015, specification line 1243) cites no test at all.
- **R55 (research line 342): no Swift test covers `TemperaturePreviewModel`.** No match for it in `ios/GarderobeKit/Tests`. The server preview is tested but the row does not cite it.

### deployment

- **S18-022 (specification line 1186): the remaining setup inputs are not tracked anywhere.** Open.
- **S20-007, S20-014, S20-021, S20-022, S20-023 (specification lines 1234, 1241, 1257, 1258, 1260): Google unattended consent, CPU measurement, prepaid settlement, browser metering and the named real integration tests.** All open; there is no `deploy/` directory.
- **KO-031 to KO-034 (start-prompt line 21): credential handling, the development deployment, untouched production and commit hygiene.** All open with no evidence in the repository.
- **KO-035 (start-prompt line 21): no source archive and no consolidated test-results record.** Partial; only the iOS check is cited.
- **KO-030 and KO-037 (start-prompt line 19; START-HERE line 11): no remaining-integration checklist for Cloudflare and no deployment instructions.** The iOS list exists (`ios/README.md:184`); the Cloudflare side has one paragraph (`apps/worker/README.md:138`).

### tests

- **KO-003 (start-prompt lines 3 and 19): what exists.** `tests/journeys/test/` holds 14 files with 262 `it` or `defect` call sites (01: 15, 02: 18, 03: 23, 04: 15, 05: 25, 06: 27, 07: 19, 08: 15, 09: 13, 10: 14, 11: 20, 12: 17, 13: 23, 14: 18). They run through the real Worker and its real MCP server and OAuth provider in workerd on local D1, KV, R2, queue and Durable Object, with the owner's real profile and inventory. Stand-ins: scripted Open-Meteo, an in-memory Google Calendar, Google OAuth, APNs, test-signed Access assertions, and the fake model (`tests/journeys/README.md:51-66`). One defect is open (D14-2) and one is skipped in the default run (D06-2, `tests/journeys/src/defect.ts:28`), so a green default run does not mean no defects. The row's test and defect counts do not match what I counted (see the row).
- **KO-004 (start-prompt lines 3 and 19): there is no adversarial suite at this commit.** `tests/adversarial/` does not exist. What exists inside the packages: `packages/domain/test/adversarial-defects.test.ts` (11 tests, real command service and local D1; its header refers to `tests/adversarial/defects/ledger.md` and `profile.md`, which are not in this checkout); `packages/assistant/test/corpus-adversarial.test.ts` (5 tests, real conversation Durable Object and D1, a fake model scripted as compromised, corpora in `packages/assistant/src/testing/corpora.ts`); `apps/worker/test/assistant-confirmation.test.ts` (6 tests, two under "adversarial corpus through the real routes", through the real Worker). Single tests elsewhere touch the named attack classes: a forged owner (`apps/worker/test/mcp.test.ts:120`, `commands.test.ts:155`, `isolation-style-platform.test.ts:82`), races (`wear.test.ts:54`, `command-service.test.ts:56`), replay (`command-service.test.ts:31`, `:46`), negative stock (`command-service.test.ts:172`), invented garments (journey 11 line 300, `board.test.ts:305`). I did not read `packages/assistant/test/research/web/url.test.ts` (12 tests), which by its name may cover SSRF. None of this is organised or reported as the extensive suite the kickoff asks for, and none of it goes through the MCP server except the forged-owner and command-class tests in `apps/worker/test`.
- **KO-005 and KO-025 (start-prompt lines 3 and 19): there is no seeded MCP simulation at this commit.** `tests/simulation/` does not exist. Nothing selects outfits at random from a seed. What exists: `apps/worker/scripts/mcp-smoke.mjs` (118 lines; a hand-run script against a locally running Worker with the real data, fixed steps, no seed, no simulated weather, calendar or circumstance, not part of `npm test`); journey 14 (18 call sites through the real MCP server, fixed script); `seededUnit` in `packages/daily/src/model.ts:153`, which is deterministic tie-breaking inside the composer and not a simulation; and one pseudo-random property test of the pure stock replay (`packages/domain/test/unit.test.ts:53`). The journey suite's scripted forecast and calendar doubles (`tests/journeys/src/outbound.ts`, `world.ts:47-65`) are the only simulated conditions and are not driven by a seed.
- **D06-2 (not a row in this part): the three-neutrals limit is a preference in the composer, not a refusal.** `tests/journeys/DEFECTS.md:20`. It bears on KO-009.

### evaluation

What `tests/journeys/evals` implements is one file, `corpus-check.mjs`, described above the evaluation table. Against the evaluation rules:

- **Candidate and judge isolation (EV-008, EV-009; evaluation README lines 32-34; KO-027).** Checked only on packets built from the bundle (corpus-check lines 168-214). No candidate has been run, so nothing enforces that a held-out candidate has no access to the suite, and no exposure record exists. EV-009 open.
- **Development and holdout split (EV-007; README line 32).** Verified as a property of the bundle (lines 97-102, 139-156). No run has used it.
- **Independent taste judging (EV-002, EV-019 to EV-023, EV-029 to EV-039, S21-007; README lines 93-97; judge.md lines 3-63).** Nothing exists: no judge prompt wiring, no judgment file, no scores, no repeated or pairwise passes, no record of model families. All open.
- **Behavioural state assertions from actual application state (EV-017, EV-018, EV-005, EV-012; README lines 82-89).** The application adapter that records `observed` state with `provenance.source: "application_adapter"` is not built. corpus-check proves only that the bundle's checker refuses state without that provenance, using labelled controls (lines 250-268). The 18 behavioural cases have therefore not been checked against this application. The journey suite asserts real application state for similar behaviours, but it is not mapped to the 18 cases and does not produce `check-state` records.
- **Candidate runs and run records (EV-011, EV-012, EV-016, EV-022; README lines 45-80, 97).** None exist. All open.
- **The corpus as calibration and not proof (EV-025, KO-026, S21-014; README line 103; start-prompt line 19).** Honoured in wording: corpus-check line 296 and `tests/journeys/README.md:102-108`. KO-026 and S21-014 are open only because they do not cite this.
- **EV-006 (README line 11) and EV-028 (README lines 109-117).** Nothing checks that calibration candidates hold visible text only (it needs the absent export), and nothing guards the rebuild scripts beyond the run leaving the bundle unchanged (lines 287-292).
- **No evidence yet.** The 64-case run that another thread is doing now has left nothing in the repository at this commit; every statement above is about the files as they stand.

## Unmapped requirements

I walked each source in scope sentence by sentence against the rows whose Source cell cites that line. Every one of R1 to R59, every table row of specification sections 18 and 20, every sentence of section 21 and every instruction of the start prompt has a row. The statements below have no row, or have a row whose wording drops a material part. Several are descriptive rather than instructions to the build; I list them so that the decision to leave them out is visible.

### Usage research (`handoff/support/garderobe-usage-research.md`)

- **Lines 146-203, section 5 "The standing rules": no row cites any of them.** The text says "A system that does not encode every one of them will be corrected on the first morning it forgets one." The checklist maps only lines 278 to 348 (its note at `CHECKLIST.md:1375`); a search of the checklist finds no Source cell citing another research line. Many of these rules are restated in the specification and the profile, whose rows are in other parts of this audit and which I did not check line by line. Rules for which I found no counterpart in the code by search: line 157 "On hot days, mesh sneakers over closed leather"; line 158 "The full-length mac is too much for a dry long walk"; line 159 the waxed Chasseur being "light rain in moderate weather only" while felted wools are fine in rain (no rain-fitness field exists; `packages/daily/src/weather/skill.ts:20` carries only general rain guidance); line 164 the `no_10k_walks` tag on welted shoes (no walk-fitness field or tag exists in `packages/`); line 199 "Venting is not logging; do not ask which items were worn until asked to log" (S03-062 covers venting about a purchase, not this). Two I checked and did find: the fortnight check of line 170 (`patternHorizonDays: 14` in `packages/contracts/src/settings.ts:81`) and the exact shirt aliases of line 186 (the sheet's names and codes, `requirements/wardrobe_inventory_clean.csv:30` and `:35`).
- **Lines 205-221, section 6 "The ledger as it is actually used": no row.** The text says "This is what a rebuilt ledger must hold." Fields in line 209 with no counterpart found: colour value, colour temperature, saturation, pattern scale, rain fitness, walk fitness, expected arrival (see R02), location as hallway or closet (see R53), and for sale-bound items the retail price, condition text and photo references as fields (they are free-form project details in `packages/contracts/src/ext/assistant.ts:515`). Line 211's `breaking_in` status exists as an attribute (`garment.ts:88`); `secondary` maps to the occasional planning policy.
- **Lines 235-248, section 8 "The person's constraints, as design inputs": no row.** The text says these "are not preferences to accommodate; they are the conditions under which the system is used". Most are reflected in specification rows outside this part. Line 248 ("He does not want the stock line about professional help when he is low") and line 247 (no "narration of his own words back to him") have no row I could find by search and no test.
- **Line 138, use case G1: "a behavioural requirement on the conversation" (stay with what he said rather than reframing).** No R-number and no row.
- **Line 108, behind R48: accessories "with register tags, offered by the board as the optional line".** R48's wording keeps the optional line and drops the register tags; none exist.
- **Line 122, behind R52: "and notes on what was altered".** R52's wording drops it. S10-066 (specification section 10) covers "changed measurements".
- **Line 352, section 12: whether five options a day is right in winter is unsettled.** No row records it as an open question for the owner.

### Specification sections 18, 20 and 21

- **Line 1159: the table's references "do not claim that the replacement has already passed acceptance".** No row; it is a reading rule for section 18, consistent with the checklist's own rule.
- **Line 1222 and line 1248: the peer reviews and their "CLI result metadata" "are retained for inspection".** No row. The two review documents are in the bundle (`handoff/support/claude-fable-peer-review.md` and `claude-fable-peer-review-followup.md`); the two JSON metadata files the specification links (`claude-fable-review.json`, `claude-fable-review-followup.json`) are not in the bundle.
- **Line 1234, finding 7: "qualified the review's blanket verification claim using Google's documented exception".** S20-007 keeps the eligibility check and the seven-day refresh test and drops this qualification.
- **Line 1237, finding 10: "provisional uncertainty".** S20-010 lists the Laundry sheet, undo and the superseded follow-through, and drops provisional uncertainty in the native app.
- **Line 1257: "Recorded the real Unified Billing smoke test and configured beta spend rules".** S20-021 keeps the settlement tests and the refill state and drops the spend rules.
- **Line 1265: "all eight owner responses".** Section 21 has seven rows for this paragraph because the paragraph itself names seven; the eight responses are the amendment rows (AM), which are outside this part.

### Evaluation README (`evals/README.md`)

- **Line 9: "an old watch inquiry does not override the later absence of watches, and historical leather-shoe use does not clear an active restriction."** No evaluation row cites it. EV-032 says historical stock and measurements are not current facts, which is narrower. The product rules themselves are tested (`packages/daily/test/validation.test.ts:338`, journey 04 line 397).
- **Line 26: the package contains `sources/garderobe-replacement-design.revision-3.md`.** No row, and the file is not in `requirements/support/wardrobe-support/evals/sources/` (that directory holds five files; this is not one of them). corpus-check does not look for it.
- **Line 34: "Inspecting holdouts as the judge does not make them candidate input."** No row; EV-009 covers the rest of the paragraph.
- **Line 89: "Provenance fields describe where to inspect evidence; they are not proof by themselves."** EV-018 drops it. It matters once an adapter exists: a record with the right provenance string and no retained artifacts must not count.
- **Line 93: the judge can "request further evidence".** EV-019 drops it (EV-037's `insufficient_evidence` verdict is the nearest).
- **Line 95: "Feature/accounting cases can have inapplicable taste dimensions and are assessed through their behavioral contract."** EV-021 drops it.
- **Line 97: "A single pass from one judge does not establish reliability or agreement with the owner across all situations."** EV-023 keeps the repeated passes and drops this limit on what may be claimed.
- **Line 99: "three competing statement colors can fail. Formality tension can succeed without a tie, and a tie can work without business signaling."** EV-024 keeps brown, pink and the white tee and drops these three.
- **Line 109: the source scripts "do not call historical tools or external services".** EV-028 drops it.

### Judge instructions (`evals/judge.md`)

- **Line 15: "Source messages that say 'I love it' without recoverable image or outfit identity establish enthusiasm, not the exact unseen combination."** No row; EV-032 covers the neighbouring sentences.
- **Line 15: "In a retrospectively reviewed response, identify limitations separately rather than claiming to measure the historical model's complete context."** EV-036 covers historical-response reviews without this.
- **Line 28: "Scores are ordinal judgments, not measurements of an objective fashion quantity."** EV-033 drops it.
- **Line 32: "Judge the response with today's desired taste standard, without calling it a controlled model comparison."** EV-036 drops it.

### Kickoff (`wardrobe-start-prompt.md` and the START-HERE paragraphs the checklist says still apply)

- **Start prompt line 1: "Its historical attachment identifier is provenance; use the actual attached file in this new project."** No row. `requirements/COVERAGE.md` records that the supplied files are byte-identical to the attachments.
- **START-HERE line 9: do not "replace taste with exact golden strings".** No row. EV-030 is the judge's side of it (no canonical prose); nothing states it as a rule for the test suite. The journey suite follows it in practice: it checks constraints with an independent checker, not fixed outfit text (`tests/journeys/src/profile-checker.ts`).
- **START-HERE line 11: "No public publication or external messages."** No kickoff row, and the checklist note (`CHECKLIST.md:1309`, `:1419`) names only the deploy and credential restrictions as superseded. Either a row or an explicit "superseded" note is missing.
- **START-HERE line 11: "Use plain commits on the current branch, no new branches/worktrees."** KO-034 covers the current branch and owned changes, not the rest.
- **START-HERE line 13: "commit details" and "precise external setup needed next" in the final deliverables.** KO-035 lists the deliverables without these two.
