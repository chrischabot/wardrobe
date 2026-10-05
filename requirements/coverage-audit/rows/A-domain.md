# Coverage audit part A — domain (data model, commands, owner amendments, owner profile)
Audited at commit 8445a1e.

## Summary

The scope holds 229 checklist rows: 86 in section 5 (S05), 44 in section 8 (S08), 35 owner-amendment rows (AM) and 64 owner-profile rows (PR). Their checklist statuses are 160 `implemented`, 66 `partial` and 3 `open`. I judged 205 rows `verified`, 24 rows `weaker` and 0 rows `unsupported`. Of the 24 weaker rows, 19 are real shortfalls in code or in test evidence (S05-002, S05-005, S05-014, S05-020, S05-033, S05-036, S05-056, S05-057, S05-071, S08-003, S08-004, S08-007, S08-021, S08-022, S08-035, AM-018, AM-029, PR-030, PR-056) and 5 are checklist bookkeeping problems where the behaviour exists and is tested but the row cites the wrong files or a stale status (S05-008, S05-025, S05-081, S08-015, S08-033). A `verified` verdict on a `partial` or `open` row means the row describes its own limitation accurately; those 69 rows are still not fully implemented and are listed under Gaps. The domain ledger itself (receipts, idempotency, expected versions, undo as compensation, effects and outbox, weekly reset with exceptions, hand-wash, event-order repair, per-garment per-date wear counting, restrictions, per-owner isolation, verbatim profile import with the sneakers-only restriction) is implemented and tested against a real local D1 database in workerd, not a mock (`packages/domain/src/testing/index.ts:1-8`). The audit was done by reading files only; no test was run, so every statement about a test is about what the test file contains, not about whether it passes. The most consequential findings are that outfit ranking does not use joint availability (S05-057), that learned selection priors and the pending-intent reconciliation helper exist only as functions no product code calls (S05-056, S08-019), and that every assistant-behaviour row marked `implemented` rests on a scripted fake model (S08-003, S08-004, AM-029, PR-056).

## Row verdicts

Paths in the Evidence column are relative to `wardrobe-rebuild/packages/` unless they begin with `apps/`, `migrations/`, `tests/` or `ios/`, which are relative to `wardrobe-rebuild/`. A number after a colon is a line number. "Citation only" means the behaviour exists and is tested, but not by the files the row cites.

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S05-001 | implemented | verified | `migrations/0001_foundation.sql:181-302` keeps garments, aliases, facts, stock events, balances and restrictions as separate tables; `domain/test/availability.test.ts:13` asserts each kind of fact separately. |
| S05-002 | implemented | weaker | `domain/test/availability.test.ts:26` (order is not arrival), `:91-93` (a suggestion reserves nothing) and `:142` (Choose is not a wear) are real. The photograph clause is not addressed by the cited code or test: only `measurement.record` refuses a photograph source (`domain/src/handlers/style.ts:593`, tested in the uncited `domain/test/isolation-style-platform.test.ts:243`), and `style.ts:94` accepts a photograph as evidence for lifting an `owner_observation` restriction. |
| S05-003 | partial | verified | `domain/src/platform.ts:22-36` and `contracts/src/settings.ts:41-59` hold timezone, home location, delivery and versioned settings; `isolation-style-platform.test.ts:250` tests versioning and undo. Model profiles and budget are not typed settings, as the row says. |
| S05-004 | implemented | verified | Columns at `migrations/0001_foundation.sql:181-210`; explicit creation in `domain/src/handlers/garments.ts:33`. "Unknown stays unknown" is asserted in the uncited `domain/test/import.test.ts:65`. |
| S05-005 | implemented | weaker | Aliases, codes, sources, supersession and the ambiguity rule are real (`domain/src/queries.ts:342`, `isolation-style-platform.test.ts:268`). No confidence value exists: `garment_facts` (`migrations/0001_foundation.sql:229-242`) and `SourceRef` (`contracts/src/primitives.ts:96-112`) have no such field, and a search for "confidence" in `contracts/src` and `domain/src` finds nothing. |
| S05-006 | implemented | verified | Journal and balances at `migrations/0001_foundation.sql:252-280` with `CHECK (quantity >= 0)`; anonymous units in `domain/test/wear.test.ts:24,67`. Negative-quantity tests are in the uncited `domain/test/command-service.test.ts:172` and `domain/test/unit.test.ts:53`. |
| S05-007 | implemented | verified | Buckets `storage` and `tailor`, `restrictions.expected_end` and planning policy exist; `isolation-style-platform.test.ts:140-148` shows a passed expected end changes nothing. The tailor `expectedReturn` is written into the event payload only (`garments.ts:535`), is read by no query and is passed by no test. |
| S05-008 | open | weaker | The row is stale, not the code. Orders, order lines and order events exist (`migrations/0200_assistant_core.sql:174-221`, `assistant/src/commands/purchases.ts`) and duplicate imports are tested (`assistant/test/commands.test.ts:44`), yet the row has no citations and status `open`. Checklist bookkeeping only. |
| S05-009 | implemented | verified | `migrations/0001_foundation.sql:309-345`; `domain/test/wear.test.ts:10-68` asserts one counted wear, merged reports and kept provenance. |
| S05-010 | implemented | verified | `laundry_batches.return_basis` observed or inferred, `laundry_cycles`, `laundry_exceptions`; `domain/test/laundry.test.ts:100-123,203-213`. |
| S05-011 | implemented | verified | `domain/test/import.test.ts:115-127` checks the stored profile equals the supplied text and every profile rule quotes a passage that occurs at its recorded lines; versions and briefs in `isolation-style-platform.test.ts:178-237`. |
| S05-012 | implemented | verified | `daily/test/board.test.ts:51-100` asserts five complete valid options, an immutable revision and stored validation evidence; `daily/test/repair.test.ts:123` asserts an option is withdrawn rather than left as a placeholder. |
| S05-013 | partial | verified | Selection as intention: `daily/test/board.test.ts:430`. The stated gap (saved combinations and day plans) is out of date in one respect: tables `studio_combinations` and `studio_day_plans` exist in `migrations/0400_media_visual_wardrobe.sql:245-298`, but the row cites neither them nor a test. |
| S05-014 | implemented | weaker | Measurements with unit and convention and maker size experiences exist (`migrations/0001_foundation.sql:518-551`; `isolation-style-platform.test.ts:239`). Alterations are not represented in the cited code (a search for "alteration" in `domain/src` finds nothing). Imported body values are stored without a measuring date (`domain/src/import/apply.ts:76`). |
| S05-015 | implemented | verified | `media/test/pipeline.test.ts:50` ("each traceable to the original") and `media/test/portability.test.ts:65`. I read test names, not the test bodies. Thumbnails are not stored, as the row says. |
| S05-016 | implemented | verified | `assistant/test/commands.test.ts:279` ("a shopping candidate is never owned stock"); `assistant/test/journeys.test.ts:100`. |
| S05-017 | implemented | verified | `assistant/test/commands.test.ts:197` ("a drafted listing never means the item left"); real D1 state. |
| S05-018 | implemented | verified | `assistant/test/memory.test.ts:48-146` covers recall, rebuild from a watermark and forgetting on a real Durable Object and D1 with a labelled fake model. I read test names and selected lines only. |
| S05-019 | implemented | verified | `assistant/test/commands.test.ts:291` and `assistant/test/connections-maintenance.test.ts:73`; `apps/worker/test/connections.test.ts` exists but I did not read its body. |
| S05-020 | implemented | weaker | Checkpoints are written only on success with status `active` (`assistant/src/agent/assistant.ts:352`). Tests cover a successful compaction (`assistant/test/memory.test.ts:86`) and an overflow followed by a successful summary (`assistant/test/turn-control.test.ts:232-242`). I found no test in which the summarizer itself fails, which is the constraint the row states. |
| S05-021 | implemented | verified | `domain/src/commands/service.ts:100-127,413-492`; `domain/test/command-service.test.ts:31-66`; `domain/test/review-findings.test.ts:72,198`. |
| S05-022 | implemented | verified | `daily/test/trips.test.ts:39,87,116,156`; ledger primitives in `domain/test/laundry.test.ts:227`. |
| S05-023 | implemented | verified | `assistant/test/commands.test.ts:128` (unknown deadline stays unresolved), `:142` (sourced deadline), `:229` (one report not widened). |
| S05-024 | implemented | verified | Cited tests exist under the cited names: `apps/worker/test/identity.test.ts:10`, `apps/worker/test/export.test.ts:173`, `apps/worker/test/surfaces.test.ts:114`. |
| S05-025 | implemented | weaker | Citation only. The cited estimator and `availability.test.ts` do not address garment identity or lots. The behaviour is in `domain/src/import/inventory.ts:271-292` and is tested in `domain/test/import.test.ts:47-53` (interchangeable pairs merged as quantity, differing rows kept apart). |
| S05-026 | implemented | verified | `domain/test/availability.test.ts:30-33`; uncited `domain/test/import.test.ts:170-173` (13 benched pieces owned, bed sock conditional). |
| S05-027 | implemented | verified | `migrations/0001_foundation.sql:195-198` (separate acquisition, planning policy and condition columns); `availability.test.ts:23-33`. |
| S05-028 | implemented | verified | `availability.test.ts:27-28` (restricted reason); `domain/test/wear.test.ts:85-87` (a shoe and a belt get no laundry state). |
| S05-029 | partial | verified | Ledger side as cited. `ios/GarderobeKit/Sources/GarderobeKit/Presentation/Phrases.swift:106,113` holds "At the tailor"; I did not run the Swift tests or check the cited workflow run. |
| S05-030 | implemented | verified | `isolation-style-platform.test.ts:127-162`; `domain/test/review-regressions.test.ts:28-94`; `domain/test/journey-defects.test.ts:48` (an order is not stock before the arrival report). |
| S05-031 | implemented | verified | `garment_facts.source_json`, `scope`, `recorded_at`; `SourceRef.kind` includes `model_inference`; stock basis `inferred` is asserted in `domain/test/laundry.test.ts:122`. |
| S05-032 | implemented | verified | `garments.ts:192-228` supersedes and keeps the previous value; `isolation-style-platform.test.ts:285`; `domain/test/review-findings.test.ts:132`. |
| S05-033 | implemented | weaker | Only two authority rules exist: arrival needs the owner's report (`availability.test.ts:42`) and measurements refuse photograph and model sources (`style.ts:593`). `garment.correct` writes a fact from any source kind without an authority check (`garments.ts:283-287`); nothing in `domain/src` distinguishes a maker's page from a tailor's alteration (searches for `maker_specification`, `research_page` and "authority" find nothing). |
| S05-034 | implemented | verified | `isolation-style-platform.test.ts:280-285`: the owner's "rust" replaces "Olive" as the name and colour, and the old name still resolves. |
| S05-035 | implemented | verified | `assistant/test/research/web/evidence.test.ts:85-131`; `assistant/test/commands.test.ts:279`. |
| S05-036 | implemented | weaker | The caveat text is returned (`domain/src/queries.ts:303,330`; `isolation-style-platform.test.ts:286`). The boundary itself is not preserved: the importer writes `wearLoggingSince: null` for every garment (`domain/src/import/inventory.ts:355`), so no start of reliable logging is recorded anywhere. |
| S05-037 | implemented | verified | `domain/src/availability/estimator.ts` separates hard facts from estimates; `domain/test/availability.test.ts:13-45,219-237`. |
| S05-038 | implemented | verified | `availability.test.ts:91-93` and `:116-117`: an unreported board writes no wear, no movement and no command. |
| S05-039 | implemented | verified | `domain/src/stock/replay.ts:289-292` moves one unit to awaiting care at the end of the wearing day; `domain/test/wear.test.ts:25`; `domain/test/laundry.test.ts:16-18` shows a piece worn today is not collected today. The rule is not specific to trousers; it applies to every laundered garment. |
| S05-040 | implemented | verified | `wear.test.ts:10-29`: the evening report merges the trousers (observation count 2, one unit awaiting care). |
| S05-041 | implemented | verified | `replay.ts:277-287,312-315`; socks stay out of the service batch in `laundry.test.ts:16-19`; never-laundered roles in `wear.test.ts:85-87`. |
| S05-042 | implemented | verified | `laundry.test.ts:9-28`. |
| S05-043 | implemented | verified | `laundry.test.ts:23-33,45-54`; `domain/test/adversarial-defects.test.ts:159,203,214`. |
| S05-044 | implemented | verified | `laundry.test.ts:56-64`: `care.washed` with `allOfChannel: handwash` clears socks only and creates no batch. |
| S05-045 | implemented | verified | `wear.test.ts:24,54-68`; bucket list at `migrations/0001_foundation.sql:274`. |
| S05-046 | implemented | verified | `laundry.test.ts:71-85` ("five pairs are clean" stands, with undo). |
| S05-047 | partial | verified | Ledger reset as cited. The daily service already applies the elapsed reset before composing (`daily/test/service.test.ts:282-321`), so the stated remainder is at least partly done but not cited. |
| S05-048 | partial | verified | `laundry.test.ts:151-192`; `domain/test/journey-defects.test.ts:58-100`. Replacement of affected plans is the daily service, as the row says. |
| S05-049 | implemented | verified | Tailor at `laundry.test.ts:117`, trip at `:237`, healing restriction in the uncited `isolation-style-platform.test.ts:142-143`. Storage and disposed states are not asserted by any test I found; `replay.ts:447-482` touches only awaiting-care and service units. |
| S05-050 | implemented | verified | `estimator.ts:22,305` exports a model version; every snapshot carries it (`domain/src/queries.ts:204,221`); `daily/test/board.test.ts:83` asserts it is stored. |
| S05-051 | implemented | verified | `availability.test.ts:186-191`. |
| S05-052 | implemented | verified | `availability.test.ts:111-112,190` (0.85 divided by 3 per option; outcomes sum to the use probability). |
| S05-053 | implemented | verified | `availability.test.ts:66-94` (shared trousers at 0.6, not three wears). |
| S05-054 | implemented | verified | `availability.test.ts:86,193-211`. |
| S05-055 | implemented | verified | `availability.test.ts:126-152`. |
| S05-056 | implemented | weaker | Parameters are labelled hypotheses (`queries.ts:208`; `availability.test.ts:34`). The learning half is a pure function that no product code calls: `learnedBoardUsePrior` appears only at `estimator.ts:299` and in its own test (`availability.test.ts:213-216`); snapshots always use the stored setting. |
| S05-057 | implemented | weaker | Joint availability is computed and stored as evidence (`daily/src/compose.ts:403`, `daily/src/validate.ts:299-320`) but is not used to rank. Ranking adds per-garment `pAvailable` in `rotation` (`compose.ts:117-129`) to a pair score and sorts on that (`compose.ts:541-549`). The cited test asserts only that the stored value is positive (`daily/test/board.test.ts:92`). |
| S05-058 | implemented | verified | `daily/test/board.test.ts:119-133`: three days of boards use at least 14 shirts, 10 trousers and all three sneakers. |
| S05-059 | implemented | verified | `board.test.ts:137-148`: an estimated piece has no blocking violation and the copy carries no percentage. |
| S05-060 | implemented | verified | `availability.test.ts:13-45`; `isolation-style-platform.test.ts:140-158`. |
| S05-061 | implemented | verified | `board.test.ts:80-93` reads the stored model version, parameters and option evidence. The qualification sentence (`daily/src/document.ts:126-133`) is not positively asserted by the cited test. |
| S05-062 | implemented | verified | Defaults at `contracts/src/settings.ts:71-80`; editable in `isolation-style-platform.test.ts:255-262`. |
| S05-063 | implemented | verified | `laundry.test.ts:127-149`; primary key at `migrations/0001_foundation.sql:384`. |
| S05-064 | implemented | verified | `laundry.test.ts:100-123`; unlogged use in `availability.test.ts:119-123`. |
| S05-065 | implemented | verified | `laundry.test.ts:113-115`. |
| S05-066 | implemented | verified | `laundry.test.ts:125`; restriction survives a reset in `isolation-style-platform.test.ts:142-143`. |
| S05-067 | implemented | verified | No confirmation or task table exists in `migrations/`; `availability.test.ts:115-117`. |
| S05-068 | implemented | verified | `laundry.test.ts:89-112,136-149`. |
| S05-069 | implemented | verified | `laundry.test.ts:151-201`; `laundry_exceptions.occurred_at`, `cycle_key` and `garment_id` record time and scope. |
| S05-070 | implemented | verified | `wear.test.ts:31-38`; `wear_observations` stores `wearing_date`, `occurred_at`, `reported_at` and `timezone`. |
| S05-071 | implemented | weaker | The wearing date is whatever the caller states, so nothing relabels it, but no test covers a continuous overnight outfit or a timezone change (a search for "overnight" in `domain/` finds nothing). Daylight-saving day length is tested only in the uncited `domain/test/unit.test.ts:5-17`, as date arithmetic, not as a wear. |
| S05-072 | implemented | verified | Primary key at `migrations/0001_foundation.sql:342`; `wear.test.ts:10-29`. |
| S05-073 | implemented | verified | `wear.test.ts:17-25`. |
| S05-074 | implemented | verified | `wear.test.ts:40-68` (phone, MCP and web). Offline replay is tested in the uncited `apps/worker/test/commands.test.ts:198,228`. |
| S05-075 | implemented | verified | `wear.test.ts:143-171`; `review-findings.test.ts:184`. |
| S05-076 | partial | verified | `wear.test.ts:46-47`: the duplicate returns `merged` with no question. Conversation behaviour is the assistant's, as the row says. |
| S05-077 | implemented | verified | `wear.test.ts:70-78`; `review-findings.test.ts:58`. |
| S05-078 | implemented | verified | `wear.test.ts:22` and `:224-244`. |
| S05-079 | implemented | verified | `wear.test.ts:92-141`; `command-service.test.ts:112`; `journey-defects.test.ts:35`. |
| S05-080 | implemented | verified | `wear.test.ts:92-104`; pure replay ordering in `unit.test.ts:38`. |
| S05-081 | implemented | weaker | Citation only. The cited tests cover an identity correction (`wear.test.ts:143`). Colour correction is tested in `isolation-style-platform.test.ts:280-285` and quantity correction in `laundry.test.ts:71-85`, neither of which is cited. |
| S05-082 | implemented | verified | Observation, receipt and effects are one batch (`domain/src/commands/service.ts:413-492`); `command-service.test.ts:11-29`. |
| S05-083 | implemented | verified | `service.ts:351-353`; `command-service.test.ts:112-137`; `domain/test/expected-versions.test.ts:93-104`. |
| S05-084 | implemented | verified | `service.ts:170-197`; `journey-defects.test.ts:197,401`. |
| S05-085 | implemented | verified | `domain/test/expected-versions.test.ts:26-113` lists the seven rebased reports and the ten refused commands. |
| S05-086 | partial | verified | `isolation-style-platform.test.ts:268-278`. The single question is the assistant's, as the row says. |
| S08-001 | implemented | verified | Envelope fields at `contracts/src/commands.ts:420-446`; validation before any write at `domain/src/commands/service.ts:81-98`; `domain/test/command-service.test.ts:68-82`; `domain/test/expected-versions.test.ts:26`. |
| S08-002 | implemented | verified | `service.ts:100-101,248-254`; `command-service.test.ts:31-66`. |
| S08-003 | implemented | weaker | Commit, ledger-written receipt and read-back are real (`assistant/src/tools/runtime.ts:255-309`; `assistant/test/conversation.test.ts:34-56`). The tool call that resolves the target comes from a scripted fake model (`conversation.test.ts:36-39`), so resolution and concise confirmation by a live model are not shown; by the checklist's own rule the status should be `partial`, as the sibling profile rows are. |
| S08-004 | implemented | weaker | `assistant/test/journeys.test.ts:76-98` asserts one clarification with two choices and an unchanged inventory, but the test scripts the fake model to call `ask_owner` with choices the test itself built from `resolveAlias`. The backstop (creation from a conversation turn is only ever a proposal) is real (`assistant/test/confirmation.test.ts:26,114`). Live-model behaviour is unproven. |
| S08-005 | implemented | verified | Creation and receipt are separate commands (`domain/src/handlers/garments.ts:33,143`; `domain/test/availability.test.ts:26,42`). Repeated import is tested in the uncited `domain/test/import.test.ts:190-195` and `assistant/test/commands.test.ts:44`. |
| S08-006 | implemented | verified | Restrict and release in `isolation-style-platform.test.ts:127-162`; move in `domain/test/wear.test.ts:120`. A frozen query result is `garment.bulk_correct` with `expectedCount`, tested in the uncited `domain/test/bulk-correct.test.ts:9`; "no implicit creation" in the uncited `command-service.test.ts:84`. |
| S08-007 | implemented | weaker | Merge is tested (`wear.test.ts:143-171`: aliases, observations and wear keys kept). `garment.remove_fabricated` exists (`garments.ts:716-742`) but no test asserts what it does; it is called only to clean up fixtures, with a status check (`apps/worker/test/restrictions.test.ts:191`, `apps/worker/test/proposals.test.ts:203`, `tests/journeys/test/06-profile-constraints.test.ts:341`). |
| S08-008 | implemented | verified | `wear.test.ts:117-141` (a wear of a piece at the tailor or under restriction is recorded) and `:175-244` (undo and amend). |
| S08-009 | implemented | verified | `domain/test/laundry.test.ts:9-85`. |
| S08-010 | partial | verified | `daily/test/board.test.ts:430-523` (choose, swap, rebuild option). Save combination is the stated remainder. |
| S08-011 | implemented | verified | `isolation-style-platform.test.ts:214-237`: a one-day brief does not reach the next day or the profile. |
| S08-012 | partial | verified | Move and retire in `wear.test.ts:120` and `availability.test.ts:21`; listings and projects are the assistant's (`assistant/test/commands.test.ts:197`). |
| S08-013 | partial | verified | `daily/test/calendar.test.ts:93,314` against a labelled fake Google Calendar. Reminder events are the stated remainder. |
| S08-014 | implemented | verified | `command-service.test.ts:74-81`: one unknown target fails the whole command, the error names the resolved and the missing targets, and nothing is written. The clarifying question is the assistant's. |
| S08-015 | implemented | weaker | Citation only. The cited `command-service.test.ts` has no case of independent sub-operations. The behaviour is `POST /v1/commands/batch`, tested in `apps/worker/test/commands.test.ts:198-226` (three commands, results receipt, error, receipt; safe to resubmit). |
| S08-016 | partial | verified | Server side: `apps/worker/test/commands.test.ts:97`, `assistant/test/conversation.test.ts:58-69`. `clientTurnId` is asserted in `ios/GarderobeKit/Tests/GarderobeKitTests/ConversationTests.swift:204-217`; I did not run the Swift tests. |
| S08-017 | implemented | verified | `domain/src/platform.ts:126-152` stores parent, operation, targets, effect body, expected versions and the action ID before `execute` (`assistant/src/tools/runtime.ts:277-297`); `isolation-style-platform.test.ts:291-308`. The assistant passes no expected versions to the intent, and commands with a business key skip the intent (`runtime.ts:274-275`). |
| S08-018 | implemented | verified | Key is `action:<actionId>` (`platform.ts:139,151`); `isolation-style-platform.test.ts:297-303`. |
| S08-019 | partial | verified | The row's limitation holds, and is larger than it reads: `pendingActionIntents` (`platform.ts:155`) is called by nothing, so intents are reconciled only when the model proposes the same effect again (`runtime.ts:280-288`), not before the model continues, and external operation identities are not reconciled at all. The `abandoned` state is never written. |
| S08-020 | implemented | verified | `isolation-style-platform.test.ts:291-303`; with real tool-call IDs in `assistant/test/conversation.test.ts:89-97` and `assistant/test/journeys.test.ts:310-331`. |
| S08-021 | implemented | weaker | A different effect in the same turn is a different action (`isolation-style-platform.test.ts:305-306`). The second clause is not implemented: a changed proposal hashes to a new intent and commits at once (`platform.ts:128-152`); no code holds it until existing effects are reconciled, and no test covers the case. |
| S08-022 | implemented | weaker | No time-window logic exists (the unique keys at `migrations/0001_foundation.sql:97,131,154` are permanent) and import keys are derived from source hashes (`domain/src/import/apply.ts:37`). The cited test never advances the clock between registration and retry, so delayed recovery is not exercised; business-key evidence is in the uncited `import.test.ts:190-195` and `review-findings.test.ts:198`. |
| S08-023 | implemented | verified | `assistant/test/reservation-reconcile.test.ts:63,111`; `media/test/pipeline.test.ts:167`. I read test names only. |
| S08-024 | implemented | verified | Retry with the same key and re-registration of the same effect are both in `isolation-style-platform.test.ts:296-303`. That test has no tool-call IDs; the cases with real IDs are the uncited `conversation.test.ts:89` and `journeys.test.ts:310`, both with a scripted fake model generating the IDs. |
| S08-025 | implemented | verified | One batch at `service.ts:413-492`, including commit-hook fragments; `command-service.test.ts:95-110,139-170`. |
| S08-026 | implemented | verified | `service.ts:414-416` and `migrations/0001_foundation.sql:70-76`. There is one precondition insert per predicate rather than one statement for all, each ahead of every mutation. |
| S08-027 | implemented | verified | Preconditions precede all writes; uniqueness, foreign keys and `CHECK` constraints are in the schema; `command-service.test.ts:139-177`. No separate post-write assertion statements exist (a search for "postcondition" in `domain/src` finds nothing); the constraints are the only mechanism. |
| S08-028 | implemented | verified | `service.ts:493-513`; `command-service.test.ts:56-66,162`; `review-findings.test.ts:72`. |
| S08-029 | partial | verified | Local D1 in workerd only (`domain/src/testing/index.ts:1-8`); the deployed run is outstanding, as the row says. |
| S08-030 | implemented | verified | `daily/test/board.test.ts:386-419` (stale candidate cannot commit) and `:501` (stale version is a conflict). A phone-and-MCP edit of one outfit is not a named case in the cited test; the nearest is the uncited `daily/test/review-regressions.test.ts:183`. |
| S08-031 | implemented | verified | `platform.ts:187-243`; `isolation-style-platform.test.ts:310-353`. |
| S08-032 | partial | verified | `daily/test/service.test.ts:75-122`; `daily/test/calendar.test.ts:151-190`, against a labelled fake Google Calendar, as the row says. |
| S08-033 | implemented | weaker | Citation only. The cited `command-service.test.ts:19` asserts only the state `none`. `projection_pending` and `projected` are asserted in `isolation-style-platform.test.ts:330` and `domain/test/journey-defects.test.ts:197-232`; a write surviving a disconnected Calendar is in `daily/test/calendar.test.ts:298`. |
| S08-034 | partial | verified | `calendar.test.ts:93,280` (projected only after read-back), with the fake Calendar the row names. |
| S08-035 | implemented | weaker | `daily/test/repair.test.ts:32` (spill), `:102` (tailor move and new restriction), `:171,225` (wear). No test in the cited file covers a laundry delay or an arrival as the trigger (a search of `daily/test` for `laundry.report_exception` finds nothing; `garment.receive` appears only in `validation.test.ts:375`). |
| S08-036 | implemented | verified | `repair.test.ts:32-64,123-154`. |
| S08-037 | implemented | verified | `repair.test.ts:123` ("fewer valid outfits, never a placeholder ... refilled once stock returns"). |
| S08-038 | implemented | verified | `wear.test.ts:175-244`: observations are retracted, never deleted, and only by undo or amend. |
| S08-039 | partial | verified | `repair.test.ts:171` with the fake Calendar the row names. |
| S08-040 | implemented | verified | `repair.test.ts:32` ("records a changed-item receipt"). I read the test name, not its body. |
| S08-041 | implemented | verified | `wear.test.ts:117-141`; `journey-defects.test.ts:35`. |
| S08-042 | implemented | verified | `wear.test.ts:224-244`. There is no revision number on a day's record; history is kept as retracted observations and voided stock events. |
| S08-043 | implemented | verified | `wear.test.ts:229-241`: the pickup batch stays and the receipt says "not in the bag". |
| S08-044 | implemented | verified | `domain/src/handlers/undo.ts:14-63`; `wear.test.ts:175-222`. |
| AM-001 | partial | verified | Amendments are stored individually beside the full profile (`isolation-style-platform.test.ts:183-200`) and both are placed in every assistant turn (`assistant/src/context/mandatory.ts:111-118`). Interpretation by a live model is outstanding, as the row says. |
| AM-002 | partial | verified | No status or confirmation record exists (`domain/test/availability.test.ts:115-117`). Assistant behaviour is outstanding, as the row says. |
| AM-003 | implemented | verified | `availability.test.ts:66-124`. |
| AM-004 | implemented | verified | `contracts/src/settings.ts:71-80`; `domain/test/laundry.test.ts:6,100-112`; cutoff arithmetic in `domain/test/unit.test.ts:19-25`. |
| AM-005 | implemented | verified | `laundry.test.ts:113-115,151-192`. |
| AM-006 | implemented | verified | `laundry.test.ts:119-123,203-213` (basis `inferred`, batch status `inferred_returned`); `domain/test/journey-defects.test.ts:176`. |
| AM-007 | implemented | verified | `laundry.test.ts:107-117`: the reset only moves existing units; the property test in the uncited `unit.test.ts:53-87` bounds the total. |
| AM-008 | implemented | verified | Tailor at `laundry.test.ts:117`, suitcase at `:237`; healing restriction in the uncited `isolation-style-platform.test.ts:142-143`. |
| AM-009 | implemented | verified | `laundry.test.ts:100-112`. |
| AM-010 | implemented | verified | `laundry.test.ts:151-201`. |
| AM-011 | implemented | verified | `laundry.test.ts:136-149`: a piece worn on collection day is held for one cycle and cleared by the next. |
| AM-012 | implemented | verified | `domain/test/wear.test.ts:92-141` (wearing, washing, past wear, and possession of a piece the ledger had at the tailor). |
| AM-013 | implemented | verified | `wear.test.ts:92-104`. |
| AM-014 | implemented | verified | `domain/test/command-service.test.ts:112-137`; `domain/test/expected-versions.test.ts:93`. |
| AM-015 | implemented | verified | `wear.test.ts:10-68`. |
| AM-016 | implemented | verified | `wear.test.ts:17-25`. |
| AM-017 | implemented | verified | `wear.test.ts:40-52,143-171`. |
| AM-018 | implemented | weaker | A separate date gives a separate count (`wear.test.ts:31-38`). The overnight half has no test: nothing in `domain/test` records a wear that runs past midnight and checks its date (a search for "overnight" in `domain/` finds nothing). |
| AM-019 | implemented | verified | `wear.test.ts:70-78`. |
| AM-020 | implemented | verified | `daily/test/repair.test.ts:171` (cited name is a prefix of the real test name). I read the name, not the body. |
| AM-021 | implemented | verified | `daily/test/repair.test.ts:171,225`. |
| AM-022 | partial | verified | `daily/test/calendar.test.ts:132`, with the fake Calendar the row names. |
| AM-023 | partial | verified | `daily/test/calendar.test.ts:151`; ledger side in `isolation-style-platform.test.ts:339-344`. |
| AM-024 | implemented | verified | `daily/test/calendar.test.ts:31`; `daily/test/calendar-influence.test.ts:134`. |
| AM-025 | implemented | verified | `daily/test/calendar.test.ts:43`. |
| AM-026 | implemented | verified | `daily/test/calendar.test.ts:54`; `daily/test/calendar-influence.test.ts:47`. |
| AM-027 | open | verified | Nothing judges candidate output. `tests/journeys/evals/corpus-check.mjs:6-7` says it "runs no candidate and judges nothing". Not implemented. |
| AM-028 | open | verified | Same evidence as AM-027. Not implemented. |
| AM-029 | implemented | weaker | The welted-shoe half is enforced in the ledger and tested with a deliberately misbehaving fake model (`assistant/test/corpus-adversarial.test.ts:47,63`). The watch half has no assistant code or test at all: the word "watch" does not occur anywhere in `packages/assistant`. It rests on the profile text being in context and on the daily validator (`daily/test/validation.test.ts:338`), which the row does not cite. |
| AM-030 | implemented | verified | Every cited test exists under its name: `apps/worker/test/surfaces.test.ts:114,132,310`, `apps/worker/test/identity.test.ts:100`, `apps/worker/test/export.test.ts`. |
| AM-031 | partial | verified | `daily/test/service.test.ts:282-321` asserts that the only commands after resuming are the service's own. Conversation behaviour is outstanding, as the row says. |
| AM-032 | implemented | verified | `daily/test/trips.test.ts:39,156`; `apps/worker/test/surfaces.test.ts:132-154`; ledger in `laundry.test.ts:227-243`. |
| AM-033 | implemented | verified | `assistant/test/commands.test.ts:128-172`: no reminder without sourced terms and a real delivery date. |
| AM-034 | implemented | verified | `apps/worker/test/identity.test.ts:100,185`. I read test names only. |
| AM-035 | implemented | verified | `apps/worker/test/export.test.ts:137,173`. I read test names only. |
| PR-001 | partial | verified | Stored byte-identical with a verified hash (`domain/test/import.test.ts:10-22,115-117`), refused if altered (`:198-203`), and supplied whole to the model (`assistant/test/conversation.test.ts:19-21`). Interpretation is outstanding, as the row says. |
| PR-002 | partial | verified | `conversation.test.ts:14-32` asserts that the system prompt contains the complete profile text, the active restrictions and every garment ID. The model in that test is a labelled fake, so whether advice follows the profile is untested, exactly as the row says. |
| PR-003 | partial | verified | As PR-002. The rule `purchase.no_visible_branding` is stored with its passage (`domain/src/import/profile.ts:211-220`); nothing enforces it. |
| PR-004 | partial | verified | As PR-002. |
| PR-005 | partial | verified | As PR-002. |
| PR-006 | partial | verified | `daily/test/board.test.ts:305` (the composition model receives the full mandatory context; the model is a labelled fake). The deterministic composer has no notion of registers (`daily/src/compose.ts:117-142` scores colour families, season and rotation only), as the row says. |
| PR-007 | partial | verified | As PR-006. |
| PR-008 | partial | verified | As PR-006. |
| PR-009 | partial | verified | As PR-006. |
| PR-010 | partial | verified | As PR-006. |
| PR-011 | partial | verified | As PR-006. |
| PR-012 | partial | verified | `daily/test/board.test.ts:102-117`; `daily/test/review-regressions.test.ts:324`. Only watches and jewellery are excluded in code; the other filtered styles are prose given to the model, as the row says. |
| PR-013 | partial | verified | As PR-002. |
| PR-014 | partial | verified | As PR-002. |
| PR-015 | partial | verified | As PR-002. The rule `fabric.repels` is stored as a soft rule with its passage (`profile.ts:188-197`); no code gates purchase advice on it. |
| PR-016 | implemented | verified | `profile.ts:38-46` (`defaultFabricClass: merino`); `daily/test/profile-format.test.ts:19`. |
| PR-017 | partial | verified | As PR-002. `purchase.construction_gates` is stored (`profile.ts:198-210`) and not enforced by code. |
| PR-018 | partial | verified | As PR-017. |
| PR-019 | partial | verified | As PR-017. |
| PR-020 | partial | verified | As PR-017. |
| PR-021 | partial | verified | `daily/src/compose.ts:131-142` scores colour families; `daily/test/profile-format.test.ts:19`. Taste on real boards is unjudged, as the row says. |
| PR-022 | partial | verified | As PR-021. |
| PR-023 | partial | verified | As PR-021; warm against cool and one saturated voice are the only devices scored (`compose.ts:137-138`). |
| PR-024 | implemented | verified | `daily/src/validate.ts:291`; `daily/test/profile-format.test.ts:19,60,75,91`; `daily/test/journey-defects.test.ts:64`. |
| PR-025 | implemented | verified | `daily/test/profile-format.test.ts:19`. |
| PR-026 | partial | verified | As PR-006. |
| PR-027 | partial | verified | As PR-006; `compose.ts:139` penalises two saturated colours. |
| PR-028 | partial | verified | As PR-006; `compose.ts:135` penalises the same neutral twice; `tests/journeys/test/06-profile-constraints.test.ts:164`. |
| PR-029 | partial | verified | As PR-006. |
| PR-030 | implemented | weaker | The values are stored and tested (`domain/test/import.test.ts:137-138`: height 1.85 m "a little over", chest 44, waist 44, neck 17). They are not stored as dated measurements: the importer sets `measuredOn: null` (`domain/src/import/apply.ts:76`) and the assistant is shown them as "undated" (`assistant/src/context/mandatory.ts:131`). Only the source carries the profile date. |
| PR-031 | partial | verified | `profile.ts:280-284`, dated with the profile date (`apply.ts:87`) and each quoting its passage. The cited test asserts only the Drake's 46 entry (`import.test.ts:139`). Use in fit advice is outstanding, as the row says. |
| PR-032 | partial | verified | `profile.ts:284`. Not individually asserted by a test. |
| PR-033 | partial | verified | `profile.ts:285`. Not individually asserted by a test. |
| PR-034 | partial | verified | `profile.ts:286`. The sentence that anything lower than the Drake's Games rise slides is not in the stored note. Not individually asserted by a test. |
| PR-035 | partial | verified | `import.test.ts:137` (`shoe_size` 8.5). "UK 8 too small" is stored only as a rule parameter (`profile.ts:225`) that no code reads. |
| PR-036 | partial | verified | As PR-002. |
| PR-037 | implemented | verified | `daily/test/board.test.ts:191,305`; `daily/test/validation.test.ts:81`. |
| PR-038 | implemented | verified | `daily/test/validation.test.ts:51`; `daily/test/board.test.ts:290`; `daily/test/profile-format.test.ts:19`. |
| PR-039 | implemented | verified | Imported as an active restriction with no end date (`profile.ts:289-298`; `import.test.ts:159-168`: only the three 990v4 pairs are offerable). Enforced at `daily/src/validate.ts:124`; `daily/test/validation.test.ts:71-105`. Cannot be undone or edited away (`domain/test/review-regressions.test.ts:29`, `domain/test/style-facts.test.ts:209`, `domain/test/adversarial-defects.test.ts:67,100`). |
| PR-040 | implemented | verified | `daily/test/validation.test.ts:105`; `daily/test/review-regressions.test.ts:45`. |
| PR-041 | implemented | verified | `daily/test/validation.test.ts:128-150`; `daily/test/board.test.ts:216`. |
| PR-042 | implemented | verified | `daily/test/validation.test.ts:162-194`; `daily/test/review-regressions.test.ts:233`. |
| PR-043 | implemented | verified | Seven days is a blocking rule (`daily/src/validate.ts:177`; `validation.test.ts:292`). The fortnight is a one-point ranking penalty (`daily/src/compose.ts:119`), as the row's note says. |
| PR-044 | implemented | verified | `daily/test/board.test.ts:449,477`; `daily/test/journey-defects.test.ts:124`. |
| PR-045 | partial | verified | Names on boards come from garment records (`daily/test/render.test.ts:6-29`). Nothing checks that a name avoids a maker's wash name or that jeans are named light, mid or dark. |
| PR-046 | partial | verified | As PR-002. |
| PR-047 | partial | verified | As PR-002. |
| PR-048 | partial | verified | Accessories are imported as real inventory (`import.test.ts:58` asserts the pocket square). I did not check each named belt, tie and scarf against the inventory file. |
| PR-049 | implemented | verified | `daily/test/profile-format.test.ts:106`. The smart-occasion tie is untested, as the row's note says. |
| PR-050 | partial | verified | `daily/test/validation.test.ts:338-349`; `daily/test/review-regressions.test.ts:324`; rule at `profile.ts:168-177`. Refusal in conversation is outstanding, as the row says. |
| PR-051 | partial | verified | As PR-002. |
| PR-052 | partial | verified | As PR-002. |
| PR-053 | partial | verified | As PR-002; stored as a soft rule (`profile.ts:241-250`). |
| PR-054 | implemented | verified | `daily/test/board.test.ts:430,449`. |
| PR-055 | implemented | verified | `daily/test/service.test.ts:28`; fortnight of wears read at `daily/src/context.ts:184-202`. |
| PR-056 | implemented | weaker | The policy text and the complete wardrobe records are put in front of the model (`assistant/src/context/mandatory.ts:35`; `conversation.test.ts:26-30`). Whether a model then avoids stating an inventory fact from memory is not tested: the only model in the cited test is a scripted fake. The status should be `partial`, as for the other assistant-behaviour rows. |
| PR-057 | partial | verified | `domain/src/queries.ts:303,330`; `isolation-style-platform.test.ts:286`. |
| PR-058 | implemented | verified | `domain/test/wear.test.ts:92-141`; `domain/test/command-service.test.ts:112`. |
| PR-059 | partial | verified | As PR-002. |
| PR-060 | partial | verified | As PR-002. |
| PR-061 | partial | verified | `daily/test/board.test.ts:305,358`; the cited journey phrase is an assertion inside the test at `tests/journeys/test/01-today.test.ts:53` (lines 69-71: each reason is longer than 30 characters and ends a sentence), not a test of its own. |
| PR-062 | implemented | verified | `daily/test/render.test.ts:15` asserts the day line "Wednesday 16 September. 12 °C leaving, 19 °C later. Nothing fixed in the calendar."; five outfits at `daily/test/board.test.ts:57`. |
| PR-063 | implemented | verified | `daily/test/render.test.ts:17-26`: the reason comes first, then Jacket, Shirt, Trousers, Belt, Socks and shoes in order. |
| PR-064 | partial | verified | `ios/App/Garderobe/Screens/Today/OptionCard.swift` and `ios/App/Garderobe/Design/Theme.swift` exist. I could not check the cited simulator workflow run. The Calendar text has a blank line between options (`daily/test/render.test.ts:19`). |

## Gaps

Each entry gives the row, the source line, what is missing and the file evidence. Source abbreviations: "spec" is `requirements/garderobe-replacement-design.md`, "amendments" is `requirements/support/wardrobe-support/evals/sources/owner-amendments.md`, "profile" is `requirements/chris-wardrobe-profile.md`.

### domain

- **S05-005 (spec L237), marked implemented.** Facts carry no confidence. `garment_facts` has no such column (`migrations/0001_foundation.sql:229-242`) and `SourceRef` has no such field (`packages/contracts/src/primitives.ts:96-112`).
- **S05-033 (spec L270), marked implemented.** Authority does not depend on the fact. `garment.correct` accepts any source kind, including `model_inference`, and overwrites the attribute (`packages/domain/src/handlers/garments.ts:283-287`). The only authority rules in the ledger are that arrival is an owner report and that measurements refuse photograph and model sources (`packages/domain/src/handlers/style.ts:593`).
- **S05-036 (spec L272), marked implemented.** The start of reliable wear logging is not preserved by migration. The importer writes `wearLoggingSince: null` for every garment (`packages/domain/src/import/inventory.ts:355`); only a fixed caveat sentence is returned (`packages/domain/src/queries.ts:303`).
- **S05-056 (spec L286), marked implemented.** Selection priors are never learned. `learnedBoardUsePrior` (`packages/domain/src/availability/estimator.ts:299`) is called only by its own test; availability always uses the stored setting (`packages/domain/src/queries.ts:190,208`).
- **S05-071 (spec L296) and AM-018 (amendments L15), marked implemented.** No test records a continuous overnight outfit or a wear across a timezone change. The wearing date is supplied by the caller and stored as given (`packages/domain/src/handlers/wear-care.ts:155-170`), so the behaviour depends entirely on each client sending the starting date; that is untested in the domain, and I did not find it tested in the clients.
- **S05-014 (spec L246) and PR-030 (profile L90), marked implemented.** Alterations have no record in the ledger, and the imported body measurements are undated (`packages/domain/src/import/apply.ts:76`; shown as "undated" by `packages/assistant/src/context/mandatory.ts:131`).
- **S05-002 (spec L229), marked implemented.** "A photograph is not proof of an unseen detail" is enforced only for measurements. A photograph is accepted as evidence to lift a restriction whose required evidence is `owner_observation` (`packages/domain/src/handlers/style.ts:92-96`).
- **S08-021 (spec L485), marked implemented.** An ambiguous changed proposal is treated as a new action and committed at once (`packages/domain/src/platform.ts:128-152`); nothing reconciles the earlier effect first.
- **S08-019 (spec L485), marked partial.** `pendingActionIntents` (`packages/domain/src/platform.ts:155`) has no caller in any package. Recovery reconciles an intent only if the model happens to propose the same effect again (`packages/assistant/src/tools/runtime.ts:280-288`). External operation identities are not reconciled, and the `abandoned` intent state is never written.
- **S08-007 (spec L471), marked implemented.** `garment.remove_fabricated` (`packages/domain/src/handlers/garments.ts:716-742`) has no test of its effect on wears, aliases or stock.
- **S08-022 (spec L487), marked implemented.** No test retries an action after a long delay; the design has no expiry, but the claim is unexercised.
- **S05-007 (spec L239), verified with a reservation.** The tailor's expected return date is written into a stock event payload (`packages/domain/src/handlers/garments.ts:535`) and can never be read back.
- **PR-035 (profile L96), marked partial.** "UK 8 is too small" exists only as the parameter `tooSmall` (`packages/domain/src/import/profile.ts:225`), which no code reads.
- **PR-032, PR-033, PR-034 (profile L93-L95), marked partial.** The size experiences are imported (`packages/domain/src/import/profile.ts:284-286`) but no test asserts them individually, and "anything lower than the Drake's Games rise slides" is not in the stored note.
- **S05-003 (spec L235), marked partial.** Model profiles and budget are not typed, versioned settings; they sit in the untyped `extensions` map (`packages/contracts/src/settings.ts:58`).
- **Checklist bookkeeping.** S05-008 is `open` with no citations although orders and order lines are built and tested in the assistant package. S05-025, S05-081, S08-015 and S08-033 cite tests that do not exercise the row; the real evidence is named in the row verdicts. S05-013 and S08-010 say saved combinations are missing while `migrations/0400_media_visual_wardrobe.sql:245-298` defines them.

### daily

- **S05-057 (spec L288), marked implemented.** Outfits are not ranked by joint availability. The composer sorts shirt and trouser pairs on the sum of each garment's own availability, season fit, a colour pair score and a seeded tie-breaker (`packages/daily/src/compose.ts:117-129,541-549`). Joint availability is calculated afterwards and stored (`compose.ts:403`) and used only to decide whether to show a caution sentence (`packages/daily/src/document.ts:126-133`). This is the "independent per-item" ranking the specification rules out.
- **S08-035 (spec L506), marked implemented.** Board repair is tested for a wear, a spill, a move to the tailor and a new restriction (`packages/daily/test/repair.test.ts:32,102,171`). A laundry delay and an arrival, both named in the requirement, are not tested as triggers.
- **S05-061 (spec L288), verified with a reservation.** The "concise qualification" sentence is produced by `packages/daily/src/document.ts:126-133` but no cited test asserts its presence.
- **S08-030 (spec L498), verified with a reservation.** The case of a phone and an MCP client changing the same outfit is not a named test in the cited file.
- **PR-006 to PR-012, PR-021 to PR-023, PR-026 to PR-029, PR-061 (profile L40-L47, L65-L69, L77-L84, L138), marked partial.** The deterministic composer knows colour families, season and rotation only (`packages/daily/src/compose.ts:117-142`). Registers, the clown and drone failure modes beyond two colour penalties, and prose that teaches are left to a model that has only ever been a labelled fake in tests.
- **PR-043 (profile L110), marked implemented.** "Nothing repeats inside a fortnight" is a one-point ranking penalty (`packages/daily/src/compose.ts:119`), not a rule; the row says so.
- **PR-045 (profile L112), marked partial.** No check stops a manufacturer wash name from reaching a board, and nothing names jeans light, mid or dark.
- **PR-050 (profile L120), AM-031 (amendments L31), S05-047 and S05-048 (spec L282), S05-013 (spec L245), S08-010 (spec L474), marked partial.** Remaining parts are as each row states.

### API/MCP

- **S08-015 (spec L479).** The batch endpoint that gives separate receipts exists and is tested (`apps/worker/test/commands.test.ts:198-226`); only the checklist citation is wrong.
- **S08-016 (spec L483), marked partial.** I checked the server tests by name and did not run the iOS tests the row cites.

### assistant

- **S08-003 and S08-004 (spec L463), PR-056 (profile L136), AM-029 (amendments L27), all marked implemented.** Each is a statement about how the assistant behaves, and each cited test drives a scripted fake model (`packages/assistant/test/conversation.test.ts:8` declares "FAKE MODEL at the model boundary"). The ledger-side backstops are real, but under the checklist's own rule these four rows should be `partial` until a live model is evaluated. For AM-029 the watch half has no assistant code or test at all.
- **S05-020 (spec L252), marked implemented.** No test makes the summarizer fail, so "an unsuccessful compaction cannot erase messages or silently end a turn" is unexercised (`packages/assistant/test/memory.test.ts:86`, `packages/assistant/test/turn-control.test.ts:232-242` both end in a successful summary).
- **PR-002 to PR-005, PR-013 to PR-015, PR-017 to PR-020, PR-036, PR-046, PR-047, PR-051 to PR-053, PR-059, PR-060 (profile L10-L34, L53-L59, L98, L118, L126-L128, L138), marked partial.** The profile is injected whole (`packages/assistant/test/conversation.test.ts:19-21`). The construction gates, the branding rule and the fabric dislikes are stored as rules (`packages/domain/src/import/profile.ts:188-220`) that no code enforces on purchase advice.
- **AM-001, AM-002 (amendments L3, L7), PR-001 (profile L4), S05-076 and S05-086 (spec L298, L306), S08-012 (spec L476), marked partial.** Remaining parts are as each row states.

### media/Studio

- **S05-013 (spec L245) and S08-010 (spec L474), marked partial.** Saved combinations and day plans have tables in `migrations/0400_media_visual_wardrobe.sql:245-298`, and both rows say the gap is "closed by the visual-wardrobe thread", but neither row cites that code or a test for it. I did not audit `packages/media/test/studio.test.ts`; that belongs to another part.
- **S05-015 (spec L247), marked implemented.** Thumbnails are generated on demand and are not stored renditions with their own transformation history; the row states this.

### iOS

- **S05-029 (spec L264), S08-016 (spec L483), PR-064 (profile L140), marked partial.** The cited Swift sources and tests exist. None was run on a device, and I could not check the cited simulator workflow run from the files. Appearance ("whitespace between everything, built for the half-awake glance") has not been inspected by a person, as PR-064 says.

### deployment

- **S08-029 (spec L496), marked partial.** The concurrency, mixed-bulk and forced-late-failure tests run on local D1 in workerd (`packages/domain/test/command-service.test.ts:120-170`). The specification asks for the deployed D1 mechanism; that run has not happened.
- **S08-032, S08-034, S08-039 (spec L500-L510), AM-022, AM-023 (amendments L21), S08-013 (spec L477), marked partial.** Every Calendar projection test uses a labelled fake of the Google Calendar service. No run against a real Google grant exists.

### tests

- **Missing cases.** Overnight wear and timezone change (S05-071, AM-018); a failing summarizer (S05-020); `garment.remove_fabricated` (S08-007); delayed retry of an action (S08-022); a changed proposal after a committed one (S08-021); board repair triggered by a laundry delay or an arrival (S08-035); scheduled reset against units in storage or already disposed (S05-049); the per-entry size experiences other than Drake's 46 (PR-031 to PR-034).
- **Wrong citations.** S05-025, S05-081, S08-015, S08-033 (see the row verdicts for the tests that do cover them). S08-024 cites a domain test with no tool-call IDs; the tests that use real IDs are `packages/assistant/test/conversation.test.ts:89` and `packages/assistant/test/journeys.test.ts:310`.
- **Nothing in this audit was executed.** The sandbox shell was unavailable, so no verdict here says a test passes.

### evaluation

- **AM-027 and AM-028 (amendments L27), marked open.** No candidate output has been judged against the profile and the source-grounded likes, dislikes and corrections. `tests/journeys/evals/corpus-check.mjs:6-7` checks the corpus and packet isolation only and states that it "runs no candidate and judges nothing".
- **All 45 partial profile rows, AM-029 and PR-056.** Whether advice and boards follow the owner's taste, registers, voice and purchase gates depends on that evaluation with a live model. Until it runs, the only tested facts are that the complete profile reaches the model and that the hard constraints of profile section 8 are enforced by the validator.

## Unmapped requirements

Every sentence and table row of specification section 5 (lines 225-307) and section 8 (lines 457-513), of the owner amendments and of the owner profile maps to at least one row. I found no normative statement with no row at all. The following statements are covered only by a row whose wording drops part of them, or have no row because the checklist treats them as framing.

- **`requirements/garderobe-replacement-design.md` L492:** "a zero-row conditional update followed by unconditional inserts is not sufficient." S08-025 keeps "a version conflict rejects the entire batch" but drops this prohibition. The implementation does comply (preconditions are inserted before any write, `packages/domain/src/commands/service.ts:414-416`), so this is a wording gap only.
- **`requirements/garderobe-replacement-design.md` L276:** "Recording trousers still on the owner's body establishes current use." S05-039 keeps the consequence (unavailable to a later fresh outfit, no hamper claim) and drops "establishes current use". No row or test distinguishes "I am wearing it now" from a completed wear.
- **`requirements/garderobe-replacement-design.md` L268:** "Sources include an owner statement, a receipt, a maker's specification, a photograph, a body measurement, or a research page." S05-031 drops the list. All six kinds are in the contract (`packages/contracts/src/primitives.ts:97-108`), so this is a wording gap only.
- **`requirements/garderobe-replacement-design.md` L485:** "rather than a model inventing a new occurrence number." S08-021 drops this clause. It matters because S08-021 is one of the weaker rows: a model that changes any payload field gets a fresh action.
- **`requirements/garderobe-replacement-design.md` L231:** "These are a fresh logical schema; implementation can combine small tables where their lifecycle and constraints are identical." No row in section 5 cites this line. It is a permission rather than a requirement; the "fresh" part is covered in spirit by S01-001.
- **`requirements/chris-wardrobe-profile.md` L14:** "whether an object could survive a night on a small boat." PR-002 lists the Sea Scouts formation but not this purchase test, and PR-004 does not mention it. It reaches the model only because the profile is injected whole.
- **`requirements/chris-wardrobe-profile.md` L28:** "Every verdict in the record passes one or more of these gates." No row; PR-003 to PR-005 cover the three gates individually but nothing requires a verdict to name the gate it passed.
- **`requirements/chris-wardrobe-profile.md` L95:** "anything lower than the Drake's Games rise slides as he walks." PR-034 quotes it, but the stored size experience omits it (`packages/domain/src/import/profile.ts:286`), so the row's claim "stored ... with passages" does not hold for this clause.
- **`requirements/chris-wardrobe-profile.md` L2:** "Second edition, 14 September 2026, superseding the first draft of 30 August." No PR row cites this line. The edition is pinned by hash in `packages/domain/test/import.test.ts:12-13`; I did not check whether a row outside my scope cites it.
