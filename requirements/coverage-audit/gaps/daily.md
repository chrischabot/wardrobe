# Coverage gaps: daily service (recommendations, weather, calendar, repair, trips, pause)

Audited at `garderobe-rebuild` commit `8445a1e`, by reading code and tests; nothing was executed. "spec" is `requirements/garderobe-replacement-design.md`. Per-row verdicts are in `../rows/`; the part letter after each entry says which file.

What holds: automatic repair of a selected future option after a wear without an approval question (`packages/daily/test/repair.test.ts:171`), versioned Calendar replacement with no duplicate and no older projection overwriting a newer one (`calendar.test.ts:132-213`, against the labelled `FakeGoogleCalendar`), the due-job sweep and daylight-saving handling (`service.test.ts:97-151`), pause and resume with no status questions (`service.test.ts:243-340`).

## Rows whose status overstates what exists

| Row | Source | What is missing or weaker | Evidence | Closes when |
| --- | --- | --- | --- | --- |
| S05-057 | spec L288 | Outfits are not ranked by joint availability; the composer sums each garment's own availability, which is the per-item ranking the specification rules out. Joint availability is computed afterwards and used only for a caution sentence. | `packages/daily/src/compose.ts:117-129,403,541-549`; `document.ts:126-133` (A) | Ranking uses joint availability and a test shows two individually likely but jointly unlikely pieces ranked below a jointly likely pair. |
| S07-005 | spec L391 | The `weather-for-outfits` skill and the typed tools `weather.forecast` and `weather.compare_locations` are used by nothing outside the daily package; the instructions never reach a model and the assistant has no weather tool. | `packages/daily/src/weather/skill.ts`; `weather-service.test.ts:80`; search of `packages/assistant/src` for "weather" (B) | The assistant registers both tools and receives the skill text, with a test that calls them in a turn; an MCP or API path for comparing locations exists. |
| S07-025 | spec L405 | "The owner's explicit day brief takes precedence over an inferred occasion" has no code. | `compose.ts:415,425,582,628` (B) | The composer applies the brief over the calendar-inferred occasion, with a test of a conflicting pair. |
| S07-024 | spec L405 | A tentative event's lower weight is only a tie-break; alone it shapes the same three of five as an accepted event. | `compose.ts:454` (B) | A test shows fewer options shaped by a tentative event than by an accepted one. |
| S07-014 | spec L397 | Rain and wind add an outer layer only; no bag or footwear choice, no conflict explanation or compromise. | `compose.ts:239` (B) | Footwear and bag respond to rain and wind and a conflict produces an explanation, with tests. |
| S07-015 | spec L397 | Model prose with no structured claims is published as `model_verified`, so a waterproofing claim would pass. | `compose.ts:377-381`; `board.test.ts:211` covers only the deterministic composer (B) | Unstructured prose is checked or stripped, and a test feeds a waterproofing claim in prose. |
| S07-010 | spec L395 | The snapshot has no "time outdoors" or "destination conditions" window. | `packages/contracts/src/ext/daily.ts:132` (B) | The windows exist in the snapshot. |
| S07-022 | spec L401 | The Calendar projection carries the board revision only, not the weather revision. | `projector.ts:88` (B) | The weather revision is stored on the projection and asserted. |
| S07-039 | spec L422 | Walking, indoor time and the option to remove a layer influence nothing. | (B) | The composer reads them, with a test. |
| S07-056 | spec L445 | Week-level rotation covers garments and shirt-and-trouser pairs only, not silhouette, palette, layers or characteristic combinations. | `compose.ts:117-141` (B) | Rotation considers those dimensions, with a week-long test. |
| S07-057, S08-035 | spec L447, L506 | No test shows a laundry delay or an arrival triggering repair of a future selected outfit. | `repair.test.ts:32,102,171` cover wear, spill, tailor move, restriction (A, B) | Tests add laundry-delay and arrival triggers. |
| S09-001 | spec L518 | No travel override of the schedule: phases run on the home timezone during a trip. | `packages/daily/src/schedule.ts`; `service.ts:303` (B) | The schedule uses the trip timezone and a test runs phases during a trip. |
| S09-011 | spec L532 | The forecast issue time is stored and never checked. | `assess.ts:287` (B) | A stale issue time changes the assessment, with a test. |
| S09-007 | spec L528 | The morning reminder is only shown queued, not delivered. | (B) | A test follows the effect to the notification sender. |
| S09-022, S01-018 | spec L542, L23 | The private web board has no images or compositions. | `document.ts:375-394` (B) | The board document carries image references and a test renders them. |
| S09-040 | spec L556 | Offline observations made during a pause, reconciled by occurrence date, are not tested. | (B) | A test adds one on resume. |
| S07-031 | spec L414 | The request to the composition model has been answered only by fakes; marked implemented. | `board.test.ts:40` (B) | A live model run through the Gateway is recorded, or the row becomes partial. |
| S03-039 | spec L88 | "Distribute likely laundry demand" has no code or test. | `compose.ts:118` uses availability for ranking only (E) | The composer spreads laundry demand across care channels, with a test. |
| S03-020 | spec L72 | The row cites only "an explicit request can create another outfit"; the amendment half is tested elsewhere and uncited. | `packages/domain/test/wear.test.ts:232` (E) | The row cites the wear amendment test. |
| S06-014 | spec L320 | "No mandatory loud piece" holds by absence only: `compose.ts` has no rule requiring one, and no test in `board.test.ts` asserts a quiet board is accepted. | search of `compose.ts` and `board.test.ts` for loud, quiet, mandatory (C) | A test accepts an all-quiet board. |
| S20-013 | spec L1241 | No calendar setup preview and no import of presentation preferences; only the timed or all-day setting. | `packages/contracts/src/ext/daily.ts:596`; `calendar.test.ts:122` (G) | A preview and the preferences exist, or the note stops calling the daily part complete. |
| S10-079 | spec L671 | Return reminders are notification effects only; no calendar effect, so "deduplicated across app and calendar" has only the app half. | `packages/assistant/src/commands/returns.ts:37-44` (C) | A calendar effect exists with a dedup test. |
| S17-067 | spec L1153 | No code computes the rolling morning success percentage or counts bad recommendations, manual repairs and failed corrections. | search of `packages/daily/src` (F) | The measure is computed from ledger records. |
| S13-030, S04-009 | spec L835, L166-169 | A long recommendation is not durable work: it lives in `waitUntil` and a lost run is marked failed; the sweep starts no Workflow. | `apps/worker/src/routes/daily.ts:88-99`; `apps/worker/src/index.ts:57-78`; `apps/worker/test/runs.test.ts:90-99` (D) | Long runs execute in a Workflow or resumable job, or the rows become partial. |

## Honest partial, open or blocked rows that still need work

- **Calendar against a real Google grant:** S01-010, S09-006, S09-015 to S09-017, S09-023 to S09-033, S09-036, S08-032, S08-034, S08-039, AM-022, AM-023, S17-002, S17-010, S17-022. Every projection test uses a labelled fake; `tests/journeys/README.md:132-134` notes the double cannot fail a read.
- **S07-008** (spec L393): WeatherKit blocked for lack of Apple credentials.
- **S07-004** (spec L387): decision context for an ad hoc outfit question loads only if the model calls `outfit_question_context` (`packages/assistant/src/tools/read.ts:85`); the requirement is that the backend loads it before the model reasons.
- **Profile taste rows left to a model** (PR-006 to PR-012, PR-021 to PR-023, PR-026 to PR-029, PR-061): the deterministic composer knows colour families, season and rotation only.
- **PR-043** (profile L110): "nothing repeats inside a fortnight" is a one-point ranking penalty (`compose.ts:119`). **PR-045**: nothing stops a manufacturer wash name reaching a board. **R11, R20**: the five research thresholds are stored as `pending_reconciliation` and not applied, awaiting the owner. **R22, R40**: boldness, anti-rut and academic blazer have no board-level check.
- **S14-029** (spec L918): no deadline check that a morning board exists. **S17-054**: weather scenarios appear in scheduled tests only, not conversational ones. **S17-008**: laundry racing composition tested at package level only.
- **EV-013**: no `shortage_reason` mapped to the evaluation schema.

## Checklist bookkeeping to correct

- **S01-019, S07-004**: notes out of date (the board slot swap exists, `board.test.ts:449`; an assistant context tool exists).
- **S18-014, S21-008, S21-011**: say reminders, returns, comfort, recovery and export are still to come; all exist.
- **S07-053**: the board side exists in `packages/daily` (`board.test.ts:96,430`) and is not cited.
