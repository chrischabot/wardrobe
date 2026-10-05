# Coverage audit part B — experience, principal decisions, recommendations, evening-to-morning service
Audited at commit 8445a1e.

## Summary

This audit covers 147 checklist rows: 23 in section 1, 22 in section 2, 62 in section 7 and 40 in section 9. The verdicts are 124 verified, 22 weaker and 1 unsupported. Of the 124 verified rows, 48 are not fully implemented by their own status (45 partial, 2 open, 1 blocked) and are listed again under Gaps. The audit was done by reading files only; no test, build or script was run, so a verdict of verified means the cited code and test contain the behaviour, not that the test passes. The daily package (`packages/daily`) is the strongest area: its tests run the real command service and local D1 with the owner's imported data and use labelled fakes only for the weather HTTP service, the Google Calendar HTTP service and the composition model. The main weaknesses are (a) the `weather-for-outfits` skill and its two typed tools are defined but never supplied to any model or MCP surface, (b) several composite rows are marked implemented while one clause of the requirement has no code or no test (tentative-event weight, day brief over inferred occasion, protective bag or footwear, week-level rotation of silhouette and palette, forecast issue time, trip timezone override of the schedule, images on the web board), and (c) rows in sections 1 and 2 that cite the generic foundation evidence (`README.md`, `packages/contracts/`, `packages/domain/`, `import.test.ts`) for statements that the import test does not exercise. For rows owned by the assistant, API, media and iOS workstreams I confirmed that every cited file exists and read the test names, and for most of them I did not read the test bodies; that limit is stated in the Evidence cell where it applies.

## Row verdicts

### Section 1 — The experience being built

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S01-001 | implemented | weaker | `README.md` line 6 states that only data and requirements were migrated, and a search of all code for the old system's name found nothing outside `requirements/`. The cited test `packages/domain/test/import.test.ts` proves the data import only; no test or check demonstrates that no code, prompt or repair mechanism was reused. |
| S01-002 | partial | verified | `apps/worker/src/mcp/server.ts`, `apps/worker/src/routes/index.ts`, `packages/contracts/generated/` and `ios/` exist. The partial status and its limits (SwiftUI not run on a device) match. I could not check workflow run 36861072431. |
| S01-003 | implemented | weaker | `import.test.ts` line 134 shows research thresholds absent from the profile are stored as `pending_reconciliation`, which supports the second half. Nothing cited demonstrates the rule that the owner's request takes precedence where the source documents disagree. |
| S01-004 | implemented | verified | `import.test.ts` "accounts for every line of the CSV exactly once", "holds a row it cannot interpret instead of guessing" and "the committed import report is exactly what the importer produces"; `data/import/inventory-import-report.md` exists; `availability.test.ts` line 220 shows imported cleanliness is an estimate. |
| S01-005 | implemented | unsupported | The cited import code and test contain nothing about the September 15 amendments (a search for "amendment" and "September 15" in `packages/domain/src/import/` finds nothing). The amendments are implemented elsewhere (rows AM-020 onward), but this row's evidence does not address them. |
| S01-006 | implemented | verified | `packages/domain/test/wear.test.ts` "a late report of yesterday's wear does not undo today's known wash" (line 92) and "wearing an item the ledger had at the tailor records the wear" (line 117). Test names and the first test body read. |
| S01-007 | implemented | verified | `packages/domain/test/availability.test.ts` "a week without any confirmation leaves every piece offerable, and the weekly baseline clears the uncertainty" (line 96). Test body not read beyond the name. |
| S01-008 | implemented | verified | `wear.test.ts` lines 10 to 29 assert one counted wear per garment and date with two observations kept; "phone and MCP reports of the same wear merge" (line 40). |
| S01-009 | implemented | verified | `packages/daily/src/repair.ts` `boardRepairHook` (line 278) runs inside the commit; `packages/daily/test/repair.test.ts` line 171 asserts the selected Thursday option is repaired in the wear's own receipt. |
| S01-010 | partial | verified | `packages/daily/src/calendar/projector.ts` lines 142 to 200; `calendar.test.ts` line 132. The Calendar service is `FakeGoogleCalendar`, as the row says. |
| S01-011 | implemented | verified | `calendar.test.ts` line 31 asserts three of five options suit the event and two do not. |
| S01-012 | partial | verified | All cited files exist (`apps/worker/src/identity/service.ts`, `apps/worker/src/export/job.ts`, `apps/worker/src/routes/daily.ts`). Trips, pause and resume exist in `packages/daily` with tests (`trips.test.ts`, `service.test.ts` line 243). Worker test bodies not read. |
| S01-013 | implemented | verified | `service.test.ts` line 28 runs the 9 PM, 6:40, 6:50 and 7:00 phases and reads five options at 7 AM with `inferenceCalls: 0`. |
| S01-014 | partial | verified | Cited files exist (`packages/assistant/src/jobs/purchases.ts`, `connections/google.ts`, `research/commerce/fit.ts` and both tests). Bodies not read; the row itself states the mailbox is a labelled fake. |
| S01-015 | implemented | verified | `packages/assistant/test/conversation.test.ts` line 14 "gives the model the complete owner profile, the wardrobe and the restrictions on every turn, even when it calls no tools". The model is a fake; the context assembly under test is real. Body not read. |
| S01-016 | partial | verified | Cited files exist; the partial status (advice quality waits on a live model) matches the fake-model tests. |
| S01-017 | partial | verified | `packages/daily/src/document.ts`; `board.test.ts` line 51; `ios/GarderobeKit/Tests/GarderobeKitTests/OwnerMorningJourney.swift` line 84 exists. Swift test body not read. |
| S01-018 | partial | verified | `document.ts` renders names and a reason per option and contains no image element or image field, which matches the stated remaining work (garment images). |
| S01-019 | partial | verified | The row is accurate but understated: the slot swap it calls remaining exists as `board.swap_slot` and is tested in `board.test.ts` line 449 (one slot, one option, new revision). The Code and Tests cells cite only the domain wear evidence. |
| S01-020 | partial | verified | Cited Swift files exist; `OwnerMorningJourney.swift` line 50 and `OwnerJourneys.swift` line 129 (Studio journey suite) exist. Bodies not read; not run on a device, as the row says. |
| S01-021 | implemented | verified | `packages/media/test/composites.test.ts` line 120 "labels illustrations, demo placeholders, edits, shopping candidates and missing images, and never passes one off as exact"; `real-inventory.test.ts` line 134. Bodies not read. |
| S01-022 | implemented | verified | `packages/daily/src/context.ts` `assembleContext`; `board.test.ts` line 305 asserts the model request contains the full profile, every garment ID, weather and calendar, and that invalid candidates are rejected in code. |
| S01-023 | implemented | verified | `packages/domain/test/command-service.test.ts` "a status change can never create an item" (line 84), "a forced late-statement failure rolls back the whole batch" (line 139), "the assistant cannot claim an owner tap" (line 199). Bodies not read. |

### Section 2 — The principal decisions

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S02-001 | implemented | weaker | A fresh schema (`migrations/0001_foundation.sql`) and an import path exist, and `README.md` line 6 states the boundary. The cited `import.test.ts` proves import only; the fresh infrastructure definition (`apps/worker/wrangler.jsonc`) is not cited and nothing tests the boundary. |
| S02-002 | implemented | verified | The MCP server calls the same `readToday` and `runRecommendation` as the HTTP routes (`apps/worker/src/mcp/server.ts` lines 39, 150, 165), and the cron calls `runDueJobs` through the same daily port (`apps/worker/src/lanes/daily.ts` line 182). The cited assistant tests use a fake model; bodies not read. |
| S02-003 | partial | verified | Cited files exist; the row states that queue messages and the workflow step are stand-ins. Bodies not read. |
| S02-004 | partial | verified | `packages/domain/test/isolation-style-platform.test.ts` line 310 "effects commit with their command, are claimed once, and a projected newer revision supersedes a delayed older one". Body not read. |
| S02-005 | implemented | verified | `service.test.ts` line 28 (composed at 9 PM, no inference at 7 AM) and line 165 (the module header states no model is configured at all in this file). |
| S02-006 | partial | verified | Cited assistant files exist. The Calendar adapter is `packages/daily/src/calendar/google.ts`, tested against documented wire shapes (`calendar-google.test.ts`); no real Google grant was used, as stated. |
| S02-007 | partial | verified | Cited files exist (`apps/worker/src/mcp/server.ts`, `handler.ts`, `connections/outbound.ts`, `connections/service.ts`). Bodies not read. |
| S02-008 | partial | verified | Cited files exist; `packages/assistant/src/inference/composition.ts` routes board composition through `ModelService`. The live Gateway route is not exercised, as stated. |
| S02-009 | partial | verified | Cited files exist. Bodies not read. |
| S02-010 | partial | verified | Cited files and `migrations/0300_api_identity.sql` exist. Bodies not read. |
| S02-011 | open | verified | The row claims nothing. `apps/worker/wrangler.jsonc` exists, but no evidence of verifying managed or preview services was found. Not implemented. |
| S02-012 | implemented | verified | Hourly forecasts are preloaded by code before composition, refresh, swaps, packing and ad hoc context (`schedule.ts` lines 151 and 162, `service.ts` lines 169, 408 and 460, `trips.ts` line 232). The skill text itself is not supplied to any model; see S07-005. |
| S02-013 | partial | verified | Cited files exist; the row states the services are fakes. Bodies not read. |
| S02-014 | implemented | verified | `composites.test.ts` line 35 "gives the same manifest and hash for the same pieces in any order" and line 50. Bodies not read. |
| S02-015 | partial | verified | Cited Swift directories exist. I could not check the counts (97 tests, 17 of 18 UI tests) or the workflow run. |
| S02-016 | open | verified | The row claims nothing and no cost or CPU measurement was found. Not implemented. |
| S02-017 | implemented | verified | `packages/contracts/src/settings.ts` line 70 (default 5, schema 3 to 5); `board.test.ts` line 151 asks for 3, 4 and 6 and gets them. |
| S02-018 | implemented | verified | `board.test.ts` line 273: two eligible shirts give two outfits, a notice, and none of the dirty shirts. |
| S02-019 | implemented | verified | `validation.test.ts` lines 71, 81 and 105: welted shoes are refused while the restriction is active, and the sneaker and welted pairing is required only after the owner lifts it. |
| S02-020 | implemented | verified | `packages/assistant/test/photo.test.ts` line 71 "'what I wore' with a photo alone logs nothing and creates nothing" and line 131. Fake model; the gating under test is application code. Bodies not read. |
| S02-021 | implemented | verified | `render.test.ts` line 6 renders Calendar text and the web board from one `BoardDocument`; the app reads the same document through `/v1/today`. |
| S02-022 | implemented | weaker | `history.test.ts` tests pure claim assessment, and `journeys.test.ts` line 146 scripts a fake model that itself supplies the claims and their statuses. No test shows the assistant investigating dates and sources; the web research it needs is partial (S02-013). The status should be partial. |

### Section 7 — Reliable recommendations

In this table `daily/` means `packages/daily/`, and test file names without a path are in `packages/daily/test/`.

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S07-001 | implemented | verified | `daily/src/context.ts` `assembleContext` returns day, weather, calendar, estimated stock, style, wears, future selections, recently shown and comfort (lines 291 to 316). `board.test.ts` lines 345 to 353 assert the profile, every garment ID, the weather line and the calendar in the model request; it does not assert the fortnight's wear, coming selections or comfort notes. |
| S07-002 | implemented | verified | `context.ts` lines 281 to 289 give each source a revision or timestamp; `calendar.test.ts` line 76 (missing access is not an empty calendar); `service.test.ts` line 196 (stale is distinct from fresh); `board.test.ts` lines 81 to 86 read the stored rules and conditions of the revision. |
| S07-003 | implemented | verified | `daily/src/context-text.ts` lines 78 to 82 list every garment with status; `board.test.ts` lines 348 to 350 assert every inventory ID and an unavailable garment with its reason. |
| S07-004 | partial | verified | `daily/src/service.ts` `decisionContext` (line 444) and `freshness.test.ts` line 183. The note is out of date: the assistant now has an `outfit_question_context` tool (`packages/assistant/src/tools/read.ts` line 85, `apps/worker/test/assistant-work.test.ts` line 82), but the context is loaded only when the model calls that tool, not by the backend before the model reasons. Nothing covers the research context for a fashion-history question. |
| S07-005 | implemented | weaker | `daily/src/weather/skill.ts` defines `WEATHER_SKILL` and `WEATHER_TOOLS`, and `weather-service.test.ts` line 80 checks only the names and that two bad inputs are rejected. No code outside the daily package uses either constant: the instructions are never given to a model, and `weather.forecast` and `weather.compare_locations` are not registered as assistant or MCP tools. `weatherCompareLocations` is called only from `trips.test.ts` line 212. |
| S07-006 | implemented | verified | The forecast is fetched by code in `schedule.ts` lines 151, 162 and 196, `service.ts` lines 169, 308, 408 and 460 and `trips.ts` line 232. Tests: `service.test.ts` line 28, `freshness.test.ts` lines 98 and 183, `trips.test.ts` line 39. Conversational advice gets it only through the tool named under S07-004. |
| S07-007 | implemented | verified | `daily/src/weather/open-meteo.ts`; `weather-open-meteo.test.ts` line 60 normalizes a recorded London response; attribution is asserted present in `weather-service.test.ts` line 55. I did not run `verify:contracts`. |
| S07-008 | blocked | verified | `daily/src/weather/weatherkit.ts` and `weather-weatherkit.test.ts` (documentation-shaped fixture) exist; no Apple credentials exist. Not implemented against the real service. |
| S07-009 | implemented | verified | `packages/contracts/src/ext/daily.ts` lines 105 to 117 and 174 to 197 hold every listed field; `weather-open-meteo.test.ts` line 60 and `weather-assess.test.ts` line 75. |
| S07-010 | implemented | weaker | The snapshot has four windows: departure, daytime, evening return and evening (`ext/daily.ts` line 132; `weather-assess.test.ts` line 75). There is no window or field for time outdoors or for destination conditions. Missing provider fields are recorded (`weather-assess.test.ts` line 246). |
| S07-011 | implemented | verified | `weather-assess.test.ts` line 64 (apparent temperature is recorded and never used as a basis) and lines 89 to 113 (probability and amount kept apart, a null hour is never zero). |
| S07-012 | implemented | verified | `weather-assess.test.ts` lines 39 and 136; `weather-service.test.ts` line 68 and `board.test.ts` line 266 assert the evening interval `18:00-23:00 Europe/London` is recorded. |
| S07-013 | implemented | verified | `validation.test.ts` line 162 (inclusive 14 and 16 on the jacket interval) and line 178 (12 °C departure with a 15 or 17 °C peak does not trigger it). |
| S07-014 | implemented | weaker | `daily/src/compose.ts` `jacketWanted` (line 239) adds an outer layer for rain or gusts, and `board.test.ts` line 191 asserts socks and sneakers are kept. No code chooses a bag or footwear for rain or wind, and nothing explains a weather conflict or offers a compromise; the only notice is the shortage notice. |
| S07-015 | implemented | weaker | The only code is one sentence of the unused skill text (`skill.ts` line 20). `board.test.ts` line 211 checks that the deterministic composer's reason does not contain "waterproof". Model prose with no structured claim is accepted as written (`compose.ts` lines 377 to 381), so a model sentence about waterproofing would be published; no test covers that. |
| S07-016 | partial | verified | Cited domain files exist; the partial status says interpretation is the assistant's. Bodies not read. |
| S07-017 | implemented | verified | `daily/src/snapshots.ts` `resolveLocation` uses the home city or an explicit place; a calendar location is never passed to the weather service. `weather-service.test.ts` line 44 (city name alone; unknown place is unavailable). No test asserts that a calendar location is ignored. |
| S07-018 | implemented | verified | `snapshots.ts` line 98 `weatherCacheKey`; `weather-service.test.ts` lines 13 to 36 assert one provider call for two owners, a key of `open-meteo` plus coarse location plus date, no user ID in the row, and one private snapshot each. |
| S07-019 | implemented | verified | `schedule.ts` lines 179 to 200; `freshness.test.ts` lines 35 and 58; `repair.test.ts` line 240 (a hot forecast replaces unsuitable shirts before the morning). |
| S07-020 | implemented | verified | `service.test.ts` lines 165 and 196; `weather-assess.test.ts` line 205. |
| S07-021 | partial | verified | `TodayModel.swift` `loadWeatherDetail` (line 503) and `weatherSourceLine` (line 509) exist; the only Swift assertion found is on synthetic data (`TodayModelTests.swift` line 28), as the row says. |
| S07-022 | partial | weaker | The board revision stores `weather_snapshot_id`, but the projector stores and writes only the board ID and board revision (`projector.ts` line 88; it contains no reference to weather). The cited `calendar.test.ts` asserts nothing about a weather revision. The link exists only indirectly through the board revision. |
| S07-023 | implemented | verified | Cold start and warm afternoon `board.test.ts` line 216; heavy rain and strong wind line 191; timezones `trips.test.ts` line 209; stale forecast `service.test.ts` line 196; provider failure with no phone involved line 165. |
| S07-024 | implemented | weaker | `daily/src/calendar/influence.ts` lines 71 to 75; `calendar.test.ts` line 54. A tentative event gets weight `reduced`, but that value is used only to prefer a full-weight event as the primary one (`compose.ts` line 454). A lone tentative event shapes the same three of five as an accepted one, and the test asserts only that it "still counts". |
| S07-025 | implemented | weaker | Event text cannot change rules (`calendar.test.ts` line 65). The second half is missing: `compose.ts` reads the brief only for count, included pieces and `occasionOnly` (lines 415, 425, 582, 628), so an explicit day brief does not outrank the inferred occasion, and no test covers it. |
| S07-026 | implemented | verified | `calendar.test.ts` lines 31 and 43 (5 gives 3, 3 gives 2, 4 gives 3); `calendar-influence.test.ts` line 134. |
| S07-027 | implemented | verified | `compose.ts` line 664; `calendar.test.ts` line 36 asserts "Three options work for “Client meeting”." |
| S07-028 | implemented | verified | `calendar.test.ts` line 50: `occasionOnly: true` makes all five suit the event. |
| S07-029 | partial | verified | `board.test.ts` line 507 carries a brief through a rebuild; `TodayModel.swift` `setBrief` (line 360) exists. Not run on a device, as stated. |
| S07-030 | implemented | verified | `compose.ts` `eligibleFor` per role (lines 432 to 440) and the evening segment (`board.test.ts` line 259). |
| S07-031 | implemented | weaker | The request is real code (`compose.ts` line 472 asks for the displayed count plus reserves plus two; `packages/assistant/src/inference/composition.ts` line 30 requires IDs, roles, a principle and claims). Every test uses a fake: `FakeCompositionModel` in `board.test.ts` line 40 and a fake language model in the assistant tests. No real model has answered this request, so the status should be partial like S02-008. |
| S07-032 | implemented | verified | `validation.test.ts` lines 51, 71, 128, 162, 292, 315 and 351 cover socks, footwear, thermal, layering, repeats, ownership, roles and ledger state. |
| S07-033 | implemented | verified | `compose.ts` line 576 refuses the same shirt twice; `board.test.ts` lines 59 and 60 assert five distinct shirts and trousers. |
| S07-034 | implemented | verified | `compose.ts` lines 473 to 527 (two attempts, wall-clock budget, rejections sent back); `board.test.ts` line 355 (the second request carries four rejections) and line 358 (the deterministic composer fills the board). |
| S07-035 | implemented | verified | `board.test.ts` line 386 (a stale candidate is dropped at publication and a reserve takes its place) and line 51 (receipt with the Calendar effect in the same command). |
| S07-036 | implemented | verified | `board.test.ts` lines 313 to 332 reject an invented ID and a display name used as an ID; line 69 asserts names come from records. |
| S07-037 | implemented | verified | `compose.ts` `verifyExplanation` (line 368); `board.test.ts` lines 336 to 339 assert a false fabric claim is removed. Only structured claims are checked; free prose without claims is published as written. |
| S07-038 | implemented | verified | `validation.test.ts` lines 128, 139 and 150. |
| S07-039 | implemented | weaker | The combination rule exists and is tested with a synthetic owner rule (`validation.test.ts` line 254). Rain influences the layer, but no code or test uses walking, indoor time or the option to remove a layer (a search of `daily/src` finds none of these terms in logic). |
| S07-040 | partial | verified | `import.test.ts` line 135 (`pending_reconciliation`, origin `specification`); `isolation-style-platform.test.ts` line 127 (restrictions are not lifted by schedules or time). |
| S07-041 | implemented | verified | `validation.test.ts` line 280 (cotton-linen from 28 °C once activated) and line 238 (pure linen refused at 29.9 and allowed at 30). Unenforced for the real owner while pending, as the note says (line 203). |
| S07-042 | implemented | verified | `validation.test.ts` lines 240 and 241 (refused at 9.9, allowed at 10). |
| S07-043 | implemented | verified | `validation.test.ts` line 162; `review-regressions.test.ts` line 233. |
| S07-044 | implemented | verified | `validation.test.ts` lines 245 to 251 (unsettled basis is reported and not applied; settled basis allows 24 and refuses 24.1). |
| S07-045 | implemented | verified | `validation.test.ts` line 63 (bed sock kept out) and lines 242 and 243 (alpaca allowed at 12, refused at 12.1 once activated). |
| S07-046 | implemented | verified | `validation.test.ts` line 51; `board.test.ts` line 290 (no socks means no board). |
| S07-047 | implemented | verified | `validation.test.ts` lines 71, 81, 95 and 105; `review-regressions.test.ts` line 45. |
| S07-048 | implemented | weaker | The rule is stored (`packages/domain/src/import/profile.ts` line 259), but no test anywhere mentions it and the cited tests do not exercise consumption. The behaviour is shown by an uncited test (`wear.test.ts` line 25: one wear moves the trousers to dirty); the code that does it (`handlers/wear-care.ts`) is not cited either. |
| S07-049 | implemented | verified | `validation.test.ts` line 292 (seven days ago is a repeat, eight is not, an exception is scoped to the request). |
| S07-050 | partial | verified | `compose.ts` `pairScore` (line 131) and the navy rule (line 732); `board.test.ts` lines 133 and 468. Taste evaluation is outstanding, as stated. |
| S07-051 | partial | verified | `validation.test.ts` lines 203 and 247 show the unsettled basis is kept and boundary tests exist for activated rules. |
| S07-052 | partial | verified | Cited domain files exist; bodies not read. |
| S07-053 | partial | verified | The board side exists too: `board.test.ts` line 430 (a choice is an intention, not a wear) and line 96 (one exposure set, nothing marked dirty). The row cites only domain evidence. |
| S07-054 | implemented | verified | Seven days are a hard check (`validation.test.ts` line 292). Fourteen days are a soft ranking penalty only (`compose.ts` lines 119 and 127), with no dedicated test. |
| S07-055 | implemented | verified | `board.test.ts` lines 59 and 60; `compose.ts` line 621 relaxes distinct trousers only when the pool is too small. |
| S07-056 | implemented | weaker | `compose.ts` `rotation` (line 117) penalizes recently shown shirts, trousers and shoes, and `board.test.ts` line 119 asserts other shirts, trousers and sneakers over three days. Nothing models or rotates silhouette, palette, layers or characteristic combinations across the week, and nothing tests the sock-only case. |
| S07-057 | implemented | weaker | Repair after an availability change is real (`repair.ts` line 309 walks open boards in date order). No test covers a laundry delay invalidating a future selected outfit; `repair.test.ts` uses a spill, a tailor move, a restriction and a wear. `laundry.report_exception` appears in no daily test. |
| S07-058 | implemented | verified | `repair.test.ts` lines 32, 123 and 204 (the brief is unchanged); `board.test.ts` lines 370 and 477. |
| S07-059 | implemented | verified | `board.test.ts` lines 358 and 370. |
| S07-060 | implemented | verified | `board.test.ts` lines 273 and 290; `repair.test.ts` line 123; `review-regressions.test.ts` line 110. |
| S07-061 | implemented | verified | `journey-defects.test.ts` line 93; `validation.test.ts` line 292; README interpretation that a named unavailable piece is still refused. |
| S07-062 | implemented | verified | `repair.test.ts` lines 32, 102 and 123 (replacement where one exists, otherwise a smaller valid board with a notice, refilled when stock returns). |

### Section 9 — The evening-to-morning service

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S09-001 | implemented | weaker | The default is `Europe/London` (`packages/contracts/src/settings.ts` line 68), and `day_runs` and `boards` store the UTC instant, local date and timezone (`schedule.ts` line 71). The "explicit travel override" is only the owner's general timezone setting: `schedule.ts` contains no trip handling, so the scheduled phases never follow a trip's destination timezone. The test (`service.test.ts` line 136) only calls the pure `phaseSchedule` with `America/New_York`. |
| S09-002 | implemented | verified | `schedule.ts` `claim` (line 66) uses a unique owner, local date and phase row; `service.test.ts` line 97 (two racing workers give one run), line 124 (both clock changes) and line 139 (sweep across the autumn change runs each phase once). |
| S09-003 | implemented | verified | `service.test.ts` lines 34 to 41: at 9 PM the sweep composes five options and the projection is delivered. |
| S09-004 | implemented | verified | `repair.test.ts` lines 32 and 123 (repair in the same commit, reserves refreshed, gap refilled by `replenishBoards`). |
| S09-005 | implemented | verified | `schedule.ts` lines 160 to 171; `service.test.ts` line 53; `repair.test.ts` lines 240 and 286. |
| S09-006 | partial | verified | `schedule.ts` lines 173 to 208; `service.test.ts` line 56 asserts `boardReady`, `calendar: projected` and `calendarVerified`. Fake Calendar, as stated. |
| S09-007 | implemented | weaker | Presenting needs no inference (`service.test.ts` line 59; `board.test.ts` line 162). For the reminder, the cited tests assert only that one `notification.morning_board` effect row is queued (`service.test.ts` line 71); delivery is not exercised here, and row S09-031 states that no notification was requested from or delivered by Apple. |
| S09-008 | implemented | verified | `service.test.ts` line 75 (missed phases caught up in order), line 88 (not replayed after the window) and line 108 (a failed phase is retried, attempts 2). |
| S09-009 | partial | verified | `compose.ts` lines 478 to 502 (wall-clock model budget); `freshness.test.ts` line 222; `schedule.ts` `phaseLeaseMs`. Cross-job budget reservation is outstanding, as stated. |
| S09-010 | partial | weaker | The server side is real (`schedule.ts`), and a search of all Swift sources finds no timer or background task. The cited iOS check `ios/Tools/check-app-sources.py` contains no rule about timers or background tasks, so nothing enforces the claim on the app side. |
| S09-011 | implemented | weaker | The thresholds are configurable settings with defaults 60 and 30 (`ext/daily.ts` lines 585 and 586) and are enforced at 6:50 (`freshness.test.ts` lines 35 and 58). Interval coverage is checked (`weather-assess.test.ts` line 228). The forecast issue time is stored only (`assess.ts` line 287, `snapshots.ts` line 113) and is never compared with anything. |
| S09-012 | implemented | verified | `snapshots.ts` lines 162 to 170 and 250 to 258; `service.test.ts` lines 165, 196 and 219; `adapter-timeouts.test.ts` lines 72 to 102. |
| S09-013 | implemented | verified | `schedule.ts` `refreshBoard` (line 126); `repair.test.ts` line 265 asserts the chosen outfit keeps its shirt, trousers, socks and shoes and the board is not recomposed. |
| S09-014 | implemented | verified | `repair.test.ts` lines 171 to 222: the selection is kept, the worn shirt is replaced, the wear rows are intact and today's board becomes the day's record. |
| S09-015 | partial | verified | `calendar.test.ts` line 93 (one event, only the outfit calendar is written). The outfit calendar itself is created by `apps/worker/src/connections/service.ts` (line 742), which is not cited. |
| S09-016 | partial | verified | `calendar.test.ts` line 106 (transparent, 7:00 to 7:15, owner timezone); the presentation setting defaults to `timed` (`ext/daily.ts` line 596). The setup preview is outstanding, as stated. |
| S09-017 | partial | verified | `calendar.test.ts` line 122; `calendar-google.test.ts` line 346. |
| S09-018 | implemented | verified | `document.ts` `renderBoardCalendarText` (line 352); `render.test.ts` lines 15 to 28. |
| S09-019 | implemented | verified | `render.test.ts` line 6 renders Calendar text and web HTML from one document and asserts the line order. There is no separate fixture file; the structure is asserted inline, and the app surface is not rendered in this test. |
| S09-020 | implemented | verified | `render.test.ts` line 29 asserts no item, option or board codes, percentages or diagnostic words in the Calendar text. |
| S09-021 | partial | verified | `render.test.ts` lines 35 and 36 (same option ID as the anchor on the web board); `AppModel.swift` `open(url:)` (line 142) parses the same link. No Swift test calls `open(url:)`, and universal links were not run, as stated. |
| S09-022 | implemented | weaker | The Calendar text is useful without images (`render.test.ts`). The second half is not met: the web board HTML (`document.ts` lines 375 to 394) contains no image or composition at all, and no test asserts one. |
| S09-023 | partial | verified | `calendar-influence.test.ts` lines 142 to 169 (ID rules); `calendar.test.ts` lines 105 and 112 (board ID and revision as private properties). |
| S09-024 | partial | verified | `calendar.test.ts` line 132: one event, the description equals the newest board, the old shirt is gone, and option 1 appears once. |
| S09-025 | partial | verified | `calendar.test.ts` line 182 (lost response, one insert, one event) and line 192 (conditional update fails, the retry keeps the owner's note and colour). |
| S09-026 | partial | verified | `projector.ts` lines 108 to 132 and 142 to 200; `calendar.test.ts` line 151 (only revision 3 is written) and line 166 (a revision landing mid-write wins). |
| S09-027 | partial | verified | `calendar.test.ts` lines 97 to 119: pending before read-back, projected after, and the last call is `getEvent`. |
| S09-028 | partial | verified | `calendar.test.ts` line 215; `journey-defects.test.ts` line 24. |
| S09-029 | partial | verified | `calendar.test.ts` lines 228 and 256; `review-regressions.test.ts` line 292. |
| S09-030 | partial | verified | `calendar.test.ts` lines 108 and 113 (no attendees sent on any call); `calendar-google.test.ts` line 320. |
| S09-031 | partial | verified | `calendar.test.ts` line 109 (no Calendar reminder by default) and line 129 (its own reminder when set); `SettingsModel.swift` lines 117 and 123 exist. Swift tests not read. |
| S09-032 | partial | verified | `service.test.ts` line 56. |
| S09-033 | partial | verified | `calendar.test.ts` lines 280 and 298; `journey-defects.test.ts` line 45; `apps/worker/src/lanes/daily.ts` line 91 passes the origin as `boardBaseUrl`. |
| S09-034 | implemented | verified | `service.test.ts` lines 243 to 279: no publication or reminder during the pause, a wear still commits and an explicit request still gets three options. Receipt intake is not exercised. |
| S09-035 | implemented | verified | `service.test.ts` line 251 (no reason, optional resume date), line 269 (a queued publication is refused) and line 327 (a pause with no arguments). |
| S09-036 | partial | verified | `service.test.ts` line 255 (no live event after the pause). |
| S09-037 | implemented | verified | `packages/assistant/test/ledger-tools.test.ts` line 102 "return reminders stay on through a pause of recommendations and have their own switch". Body read in part through search results. |
| S09-038 | implemented | verified | `pause.ts` `resumeService` (line 136); `service.test.ts` lines 296 to 321 assert the weekly reset, one board for the resume day, and weather and calendar snapshot commands. |
| S09-039 | implemented | verified | `service.test.ts` lines 300, 318 and 321: one board, one reminder, and only the service's own command types after the resume. |
| S09-040 | implemented | weaker | The indefinite pause is tested (`service.test.ts` line 324). The first half is not: the only observation during a pause is a same-day wear (line 276); no test records an observation with an earlier occurrence date during or after a pause and checks how the resume board accounts for it. |

## Gaps

Line numbers after "L" are lines of `requirements/garderobe-replacement-design.md`.

### domain

- **S01-005 (preamble L13), unsupported.** The row cites the generic foundation evidence, and nothing in `packages/domain/src/import/` or `packages/domain/test/import.test.ts` concerns the September 15 decisions. The row should cite the amendment rows' evidence (AM-020 onward) or be marked as a governing statement with no code of its own.
- **S01-001 (preamble L5) and S02-001 (L35), weaker.** The replacement boundary rests on a sentence in `README.md` line 6 and on the absence of old code. The cited `import.test.ts` proves the import, not the boundary, and `apps/worker/wrangler.jsonc` (the fresh infrastructure definition) is not cited.
- **S01-003 (preamble L7), weaker.** Only the "research is evidence" half has evidence (`import.test.ts` line 134). Nothing shows how a disagreement between source documents is resolved in favour of the owner's request.
- **S07-048 (L435), weaker.** The single-wear care rule is stored at `packages/domain/src/import/profile.ts` line 259 and no test names it. The consumption is shown only by the uncited `packages/domain/test/wear.test.ts` line 25; the cited tests do not exercise it.
- **Partial by their own status:** S02-004 (L38), S07-016 (L397), S07-040 (L424), S07-051 and S07-052 (L439), S07-053 (L443). The foundation part exists; S07-053's board side also exists in `packages/daily` (`board.test.ts` lines 96 and 430) and is not cited.

### daily

- **S07-005 (L391), weaker.** `WEATHER_SKILL` and `WEATHER_TOOLS` (`packages/daily/src/weather/skill.ts`) are used by nothing outside the daily package. The instructions never reach a model, and neither typed tool is callable by the assistant or over MCP. The test checks names and two schema rejections only (`weather-service.test.ts` line 80).
- **S07-010 (L395), weaker.** The snapshot has no "time outdoors" or "destination conditions" window (`packages/contracts/src/ext/daily.ts` line 132 lists departure, daytime, evening return and evening).
- **S07-014 (L397), weaker.** Rain and wind add an outer layer only (`compose.ts` line 239). No bag or footwear choice, no explanation of a conflict and no offered compromise exist.
- **S07-015 (L397), weaker.** Nothing in code stops a model's prose from claiming waterproofing: prose with no structured claims is published as `model_verified` (`compose.ts` lines 377 to 381). The test covers only the deterministic composer (`board.test.ts` line 211).
- **S07-022 (L401), weaker.** The Calendar projection carries the board revision only (`projector.ts` line 88); no weather revision is stored on it or asserted.
- **S07-024 (L405), weaker.** "Tentative events carry less weight" is a tie-break only (`compose.ts` line 454); a lone tentative event shapes the same majority as an accepted one.
- **S07-025 (L405), weaker.** "The owner's explicit day brief takes precedence over an inferred occasion" has no code: the composer uses the brief only for count, included pieces and `occasionOnly`.
- **S07-039 (L422), weaker.** Walking, indoor time and the option to remove a layer do not influence anything.
- **S07-056 (L445), weaker.** Rotation is by garment and by shirt-and-trouser pair (`compose.ts` lines 117 to 141). Silhouette, palette, layers and characteristic combinations are not rotated across the week.
- **S07-057 (L447), weaker.** No test shows a laundry delay invalidating a future selected outfit and creating a repair before the day.
- **S09-001 (L518), weaker.** There is no travel override of the schedule: `schedule.ts` has no trip handling, so during a trip the phases run on the home timezone and prepare the home board; a trip day is answered from the suitcase only when asked (`service.ts` line 303).
- **S09-007 (L528), weaker.** The morning reminder is queued as an effect; its delivery is not shown by the cited tests.
- **S09-011 (L532), weaker.** The forecast issue time is stored and never checked.
- **S09-022 (L542) and S01-018 (L23), weaker and partial.** The private web board has no images or compositions (`document.ts` lines 375 to 394).
- **S09-040 (L556), weaker.** Reconciling offline observations made during a pause by occurrence date is not tested.
- **S07-031 (L414), weaker.** The request to the composition model has been answered only by fakes.
- **Smaller notes on verified rows.** S07-037 checks structured claims only. S07-054 treats the fourteen-day horizon as a ranking penalty with no test. S09-019 has no fixture file; the wording structure is asserted inline. S07-017 has no test that a calendar location is ignored. S01-019 and S07-004 have out-of-date notes (the swap exists; an assistant tool exists).
- **Partial because the Calendar service is a labelled fake (needs a real Google grant):** S01-010, S09-006, S09-015, S09-016, S09-017, S09-023 to S09-033 and S09-036. The projector behaviour itself (replacement, no duplicate, older revision cannot overwrite a newer one, read-back) is exercised in `calendar.test.ts` lines 132 to 213 against `FakeGoogleCalendar`.
- **Blocked:** S07-008 (L393), WeatherKit, for lack of Apple credentials.

### API/MCP

- **S07-005 (L391).** The MCP server exposes `garderobe_today` and `garderobe_recommend` (`apps/worker/src/mcp/server.ts` lines 146 and 161) and no weather tool; the HTTP API has `GET /v1/weather` (`apps/worker/src/routes/daily.ts` line 121) and nothing for comparing locations.
- **Partial by their own status:** S01-002 (L5), S01-012 (L15), S02-007 (L41), S02-010 (L44). I confirmed the cited files exist and did not read the tests.

### assistant

- **S07-004 (L387), partial.** The decision-scoped context for an ad hoc outfit question is loaded only if the model calls `outfit_question_context` (`packages/assistant/src/tools/read.ts` line 85). The requirement is that the backend loads it before the model reasons. The "research context without fetching laundry" half has no evidence.
- **S02-022 (L54), weaker.** The history-research journey is a scripted fake model that supplies its own claims (`packages/assistant/test/journeys.test.ts` line 146).
- **S07-005 (L391).** The assistant has no weather tool and is never given the skill instructions (a search of `packages/assistant/src` for "weather" finds only comments and test corpora).
- **Partial by their own status:** S01-014 (L19), S01-016 (L21), S02-003 (L37), S02-006 (L40), S02-008 (L42), S02-009 (L43), S02-013 (L47), S09-009 (L530, cross-job budget reservation).

### media/Studio

- **S01-018 (L23) and S09-022 (L542).** No garment image or outfit composition reaches the board document, the Calendar event or the web board. `packages/media/test/real-inventory.test.ts` line 55 states the real inventory has 127 garments and no image.

### iOS

- **S09-010 (L530), weaker.** The cited `ios/Tools/check-app-sources.py` has no rule about timers or background tasks.
- **S09-021 (L542), partial.** `AppModel.open(url:)` has no test, and universal links were not run.
- **S07-021 (L401), partial.** The weather line is covered by synthetic data only.
- **Partial by their own status (client logic tested with `swift test`, views not run on a device):** S01-002, S01-017, S01-020, S02-015, S07-029, S09-031, S09-033.

### deployment

- **Open:** S02-011 (L45, managed and preview services verified) and S02-016 (L50, free allowances with CPU and external charges measured). Nothing exists for either.
- **Blocked:** S07-008 (L393).
- **Real-service runs outstanding:** every row listed under daily as partial for the Calendar fake, plus S02-006 and S02-008.

### tests

The following behaviours have code or a status of implemented and no test that exercises them: a tentative event weighing less than an accepted one (S07-024); a day brief overriding an inferred occasion (S07-025); a laundry delay repairing a future selected outfit (S07-057); an offline observation made during a pause (S09-040); week-level rotation beyond garments (S07-056); a calendar location not moving the forecast (S07-017); the fourteen-day pattern check (S07-054); a waterproofing claim in model prose (S07-015); the trouser single-wear rule (S07-048); the weather tools being callable (S07-005); `AppModel.open(url:)` (S09-021); the absence of an app timer (S09-010). No test in this scope was run by this audit.

### evaluation

- **S07-050 (L437), partial.** The styling direction waits on human and judge taste evaluation.
- **S01-016 (L21), partial.** Whether advice follows the profile waits on the live evaluation.
- **S07-031 (L414) and S02-022 (L54).** Both depend on a live model that has not been called.

## Unmapped requirements

All entries refer to `requirements/garderobe-replacement-design.md` unless another file is named. Every table row of section 2, every numbered step and rule-table row of section 7 and every schedule-table row of section 9 has a checklist row. The statements below have no row whose Source cites their line, or are covered only by a row whose wording drops a material part. I searched the checklist's Source column for these lines within my scope and for rows AM-020 to AM-035; I did not read the checklist sections owned by the other audit parts, so a statement may be covered there under a different source line.

Statements with no covering row:

- **L9.** "Performance, model quality, and running costs remain matters for the acceptance tests specified here." No row cites preamble L9.
- **L15.** "The evaluation corpus is built from the supplied Claude export, the complete September 14 profile, and the September 15 corrections." The only row citing preamble L15 is S01-012, which keeps the feature list and the "historical evidence" clause and drops this sentence.
- **L15.** "Sections 19 and 20 remain dated setup and review records, not verification of this revision or authorization to perform their embedded operational instructions." S01-012 drops it. S01-003 covers the similar statement about the usage research only.
- **L27.** "Reliability comes from the application owning the evidence and the effects of every decision. API access makes model choice and effort explicit; it does not make a model incapable of skipping checks or inventing facts." Rows S01-022 and S01-023 start at the next sentence.
- **L393.** "Cloudflare hosts the adapter, cache and scheduling, rather than supplying meteorological data." No row. The code does this (the cache is the D1 table `weather_cache`).
- **L424.** "These are personal constraints, not universal fabric facts." No row. It bears on a second owner: the synthetic second owner in `validation.test.ts` line 211 gets none of these rules until they are activated, which is consistent with it.
- **`requirements/support/wardrobe-support/handoff/support/weather-for-outfits/SKILL.md` L28 and L34.** The specification at L391 says to include this skill specification. Its lines "Return a structured weather assessment linked to the snapshot ID and revision, with the relevant intervals, clothing implications, evidence and uncertainty" and "Run these tests for both scheduled service and interactive advice. The backend must fetch before model reasoning even when the model makes no weather tool call" have no row in my scope. The acceptance list there also names "absent location permission" and "missing fields", which S07-023 does not list.

Statements covered only by a row that drops a material part:

- **L38 (reason column).** "Each kind of state has one canonical owner and an explicit recovery boundary." S02-004 keeps the owners and drops the explicit recovery boundary.
- **L41 (reason column).** "Claude and ChatGPT reach the same assistant; that assistant can use additional remote MCP services." S02-007 names the protocol versions only.
- **L42 (reason column).** "One inference accounting path covers chat, compaction, vision, extraction, embeddings, and generation." S02-008 says "all inference" without the list, so nothing checks each kind.
- **L44 (reason column).** "Stable ownership across login changes, connections, jobs, and storage." S02-010 drops it.
- **L391.** "Its instructions explain how to interpret forecast fields for clothing; its tools obtain current data." S07-005 requires the skill to be "included" with typed tools and does not require the instructions to be supplied to a model or the tools to be callable, which is how the row could be marked implemented while neither is true.
- **L397.** "although other comfort checks still apply" (after the 12 °C departure and 17 °C peak example). S07-013 drops it.
- **L399.** "A calendar location is a candidate to resolve, not permission to assume a move or track the phone continuously." S07-017 keeps the first half only.
- **L399.** "a fresh fetch does not guarantee a newly issued forecast." S07-019 says "checks coverage and source age" and drops the distinction between fetch time and issue time; S09-011 mentions issue time, and that part is the one found unimplemented.
- **L416.** "A model can assess subjective quality." S07-033 keeps only the deterministic checks. No model evaluates the surviving set; the sentence is permissive, so this is a note rather than a defect.
- **L25.** "An imagined rendering can help explore a look." S01-021 keeps only the prohibition.
- **L455.** "Physical feasibility and truthful delivery take precedence over an impossible count." S07-062 drops it; S02-018 and S07-060 cover the substance.
- **`requirements/support/wardrobe-support/evals/sources/owner-amendments.md` L19.** "preserve unaffected pieces and the original brief, and replace what no longer works without another approval question." Rows S01-009 and S09-014 in my scope drop these clauses. They are covered by AM-021, whose cited test (`repair.test.ts` line 171) does assert the kept pieces, the kept brief and a committed receipt with no question.
- **`owner-amendments.md` L23.** "Three out of five options suitable for a relevant event is a useful default; keep other useful choices." Covered by AM-024 and S07-026. The amendment does not mention tentative events, so the gap on S07-024 comes from the specification (L405) alone.
