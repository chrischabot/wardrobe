# Garderobe journey suite: functionality and user experience

This suite runs end-to-end journeys through Garderobe's **HTTP API** (`/v1/*`, the private web board and the OAuth/consent pages) and its **MCP server** (`/mcp`, used by a real MCP SDK client). Each journey follows what the owner, Chris, actually does, and asserts two things: the **outcome** (what changed in the ledger, the board and the receipts) and the **experience** the spec promises (three to five named outfits with a short reason, receipts with verified summaries and Undo, no questionnaire, nothing shown as done before it is done).

Every journey runs on the owner's **real data**:

- the profile `data/owner-profile.md`, byte-exact, SHA-256 `e15639d8…cb198`;
- the May 2026 inventory CSV, imported through the foundation's section-16 importer (127 garments);
- the 17 owner-asserted additions of 2026-09-29, making 144 garments.

The seed is `harness/owner.ts`, which mirrors `demo/scripts/seed-local.ts`. Scenario state (wears, a laundry batch, the tailor, storage, an incoming pair, a donation) comes only from commands. It is either the labelled **TEST EVENT** week (`demo/src/test-events.ts`) or the owner's own actions inside the journey. No data file is modified.

## Running it

```sh
cd garderobe
npm install
npm run test:journeys                  # the whole suite, about 1 minute
# or: cd tests/journeys && npx vitest run journeys/09-profile.journey.test.ts
npm run typecheck --workspace @garderobe/journey-tests
```

The suite runs the real Worker (`backend/wrangler.jsonc` → `backend/src/index.ts`) in workerd through `@cloudflare/vitest-pool-workers`. It uses real local D1 with the production migrations, R2, KV, Durable Objects (the Think assistant actor) and queues. Each journey file gets fresh storage. Nothing remote is contacted.

## Stand-ins (what is not real in these runs)

| Stand-in | Replaces | Where |
| --- | --- | --- |
| `FakeWeatherProvider` scenarios (`mild`, `elevenToNineteen`, `jacketBand`, `coldSnap`, `heavyRain`, `heat`, `strongWind`, `rainAfterFour`, outage) | Open-Meteo | `harness/world.ts`, every journey |
| `FakeCalendar` | Google Calendar (the owner's events, and the managed outfit event store) | 09, 10, 16 |
| `FakeModelTransport` (deterministic; scripted tool calls) | AI Gateway models (no Gateway account locally) | 06, 07, 09 (conversation), plus the assistant for `garderobe_ask` |
| `FakeWeb` (fixture product page of a De Bonne Facture chore jacket) | Tavily Extract / Exa / Browser Run | 07 |
| `FakeGmail` | Gmail API | 12 |
| Locally signed Cloudflare Access assertions (a throwaway RSA key from `vitest.config.ts`) | Cloudflare Access with Google | every journey |
| A controllable clock (`installApiTestOverrides`) | wall-clock time (dates in October 2026) | every journey. The assistant actor keeps real time, so conversation journeys run on today's real date |

The following are the **real Worker code** in every run: routing, Access verification, OAuth 2.1 + PKCE (`@cloudflare/workers-oauth-provider`), the MCP server (2026-07-28 via SDK v2), the command service and D1 batches, composition, validation, repair, publication, the Think actor, runs and SSE, research parsing and size arithmetic, email parsing and reconciliation, trips, pause, export and recovery.

Composition is seeded per owner and garment identity, and both are fresh random ids in each run. So **every run samples different real outfits** from the owner's wardrobe. The profile checks therefore run against a new random board sample each time. The intermittent failures listed below are real outcomes of that sampling, not test noise.

## Structure

| Path | Contents |
| --- | --- |
| `vitest.config.ts`, `setup/` | Worker pool config (backend wrangler config, production migrations, local Access key) |
| `harness/owner.ts` | Seed of the owner's real profile, rules, CSV and additions; labelled TEST EVENTs; Access assertions |
| `harness/world.ts` | Clock, weather and calendar installed into the API |
| `harness/http.ts` | `App`: an authenticated app session (`today`, `prepare`, `command`/`commit`, `wardrobe`) |
| `harness/mcp.ts` | Phone-browser consent + PKCE grant for Claude/ChatGPT; real MCP SDK client |
| `harness/assistant.ts` | The fake model shared with the Think actor; scripted tool calls |
| `harness/profile.ts` | **Independent** checks of every section 8 hard constraint, computed from the garments' own records (not from the validator's evidence) |
| `harness/ux.ts` | The UX contract: `expectGlanceableBoard`, `expectDoneReceipt`, `expectNotDone`, the `INTERROGATION` phrase list |
| `journeys/01–19` | The journeys (below) |

| File | Journey |
| --- | --- |
| 01-first-use | Sign-in; profile byte-identical in Settings > My style and the MCP resource; the imported wardrobe; the first sample board; the restriction survives elapsed time |
| 02-morning | Fetch the board (app = MCP revision), Choose, choose again, Swap a shirt, I wore this, a shirt change, a cross-client duplicate, no restyling of the worn day; picking footwear once the fleet returns |
| 03-laundry-undo | Wear → hamper vs hand wash, In the wash, Collected, a wear after pickup, Some items still away, Returned, Socks washed, count correction; Undo as a compensating command, late Undo, double Undo, Undo after a pickup, receipts never deleted |
| 04-wardrobe-items | Search by owner names, PCF codes and maker; the ambiguous phrase; filters; item page; tailor, storage, arrived; the temperature preview as a simulation |
| 05-studio | Selectors, Explore, locks with Find something, validation issues, Save / Plan / Wear this |
| 06-conversation | A turn accepted → answered; mandatory context without tool calls; Ask about this; explicit log; asking ≠ logging; photo ≠ logging; progress and cancel; a resent turn |
| 07-research | Exact variant and time checked; stale stock; sizes from the profile; chart arithmetic in conversation; a discouraged purchase; a profile correction changes the next size answer |
| 08-connected-assistants | Claude and ChatGPT grants, a smaller grant, Settings listing, Disconnect (incl. refresh), reconnect, Gmail/Calendar disconnected |
| 09-profile | Eight varied days (weather × calendar) × every hard constraint; away/benched never offered; belt flourish; swaps and navy; jeans names; no codes in copy; lifting sneakers-only; a one-day exception; an unexceptionable rule; a profile edit reaching the next board and turn |
| 10-ux-under-strain | Board prepared overnight with no app and no model, projected once; a revision replaces the event; a week without wear reports; stale and missing weather; calendar outage; pending projection never shown as done |
| 11-reliability | Explicit requests (include), unavailable pieces, bed socks, invented ids; laundry racing composition; parallel edits (app vs MCP); selected future repair; the scarcity board |
| 12-email-intake | Receipt search, dedupe, dispatch ≠ arrival, refund, remake, prompt injection, repeat sync, arrival only by the owner |
| 13-trip-packing | Trip proposal, packed pieces off the home board, destination board from the suitcase, home reset doesn't wash the suitcase, unpacking ≠ washing |
| 14-returns | Sourced deadlines only, timezone/BST, reminders, draft/request/post, refunds, exchange |
| 15-comfort | One report, no questionnaire, no ban, scoped standing rule with Undo, its effect on a recommendation |
| 16-pause-resume | Pause removes outfit events, phases stay silent, observations keep working, resume prepares one board with no backlog |
| 17-export-import | Checksummed, credential-free export; tamper detection; clean import into an empty owner seen through its own Access identity |
| 18-account-recovery | Recovery kit, wrong code, new identity bound to the same owner, spent code, old MCP and native sessions dead |
| 19-consignment | A prepared listing resumed later; for-sale kept owned and off boards; sold ≠ gone |

"SURFACE GAP" comments in a test mark steps the spec expects on a surface that has no HTTP/MCP route yet. Those steps are driven through the backend service directly, or read from D1.

## Coverage: spec section 17 "What must be proved"

Status: ✅ covered and passing; ❌ covered, fails on a product defect (see the defects list); ◑ partly covered locally; 🔒 needs real accounts, providers or devices.

| Row | Test(s) | Status |
| --- | --- | --- |
| Morning independence | 10 “the scheduled phases compose, publish and project the board with no app request and no model” | ✅ |
| Omitted model reads | 06 “a model that makes no tool calls still receives the full profile, the wardrobe and the day” | ✅ (fake model) |
| Hallucinated items | 11 “an invented garment id can never become an actionable outfit or an inventory change”; 07 page-injection check; 05 plan refused | ✅ |
| Availability | 11 “a requested count never justifies unavailable garments”, “bed socks are indoor-only”; 09 “pieces away … benched never appear”; 04 tailor/storage/arrived; 19 for-sale | ❌ (explicit `include` ignored, D5) |
| Quantities | 03 laundry journey (identical socks, split batch, post-pickup wear, partial return, count correction, never negative) | ✅ |
| Wear correction | 02 “I wore this … only the worn shirt is counted”, “changing shirt … counts only the new shirt”, “a second report … merges” | ✅ |
| Concurrency | 11 “a shirt going into the wash while the board is being composed…”, “the app and a connected assistant editing the same settings…” | ✅ (deployed-D1 repeat is the deployment item's) |
| Repair | 11 “wearing a piece of tomorrow’s chosen outfit repairs only that piece…”, “with only two clean shirts left… no placeholders”; 10 “a later revision replaces…” | ✅ |
| Calendar | 10 one managed event, replaced not duplicated, pending never shown as projected; 16 pause removes events | ◑ out-of-order delivery is covered only by `backend/test/daily/calendar.test.ts`; real Google read-back 🔒 |
| Identity recovery | 08 Disconnect/reconnect Claude from the browser; Gmail/Calendar disconnected leave the assistant and Today; 18 native session | ◑ real Gmail/Calendar reconnection 🔒 |
| Shopping | 07 exact colour/size, chart arithmetic, stale stock | ◑ fixture page; “a real URL” 🔒 |
| Intake | 12 (all) | ✅ (FakeGmail) |
| Personal context | 09 “an edit in Settings > My style… the next board and the next turn use it”, “a one-day exception is dated and scoped…”; 07 “an explicit correction to the profile applies on the very next size request” | ✅ |
| Visual matching | 06 “a photo in ‘What I wore’ without an explicit log request never records anything”; 04 ambiguous phrase asks with distinguishing facts | ◑ selfie matching needs a vision model 🔒 |
| Image fidelity | — (`backend/test/visual` covers the pipeline with fakes) | 🔒 real image providers |
| Studio | 05 (all) | ✅ |
| External actions | 19 “days later the prepared listing is resumed exactly where it was left” | ◑ real submission and ambiguous-outcome reconciliation 🔒 |
| Device usability | — | 🔒 iPhone / Xcode (iOS item) |
| Cost and operations | 17 backup/restore as export → clean import | ◑ CPU, charges, budgets 🔒 deployment |
| Missing reports | 10 “a week without wear reports…” (3 tests; the week is prepared by the scheduled evening phase, which also applies the weekly laundry reset) | ✅ |
| Selected future repair | 11 “wearing a piece of tomorrow’s chosen outfit…”; 10 event updated on the next sweep | ✅ |
| Calendar influence | 09 client meeting (subset + suitability note), declined board meeting (no requirement), dinner | ✅ |
| Packing | 13 | ❌ D6, D7 |
| Returns | 14 | ❌ D8 |
| Comfort | 15 | ❌ D9 |
| Pause | 16 | ✅ |
| Lost identity | 18 | ✅ |
| Portability | 17 | ❌ D10, D11, D12 |

Platform and continuous-conversation rows exercised here: **profile edit after prompt caching** (09, ✅); **simultaneous iOS and MCP requests** (02 merge, 11 parallel edits, ◑); **MCP 0728** (every MCP call uses the SDK pinned to 2026-07-28; the protocol details are `backend/test/api/mcp.test.ts`). Eviction, compaction, recall after months, indexing interruption, forget/restore, the generic MCP connection, Google, Drive/Sheets, Browser Run, Gateway enforcement, free-plan viability, native interaction and real Claude/ChatGPT journeys are not in this suite. They need real providers, a deployment or a device, or they belong to other items.

## Coverage: the profile's section 8 hard constraints

| Constraint | Test(s) | Status |
| --- | --- | --- |
| 1 Socks always | `socksAlways` on every board in 01, 02, 09 (8 days + lifted fleet), 11, 13; 09 “a hard medical rule cannot be excepted”; 05 no-socks validation | ✅ |
| 2 Sneakers only until healed | `sneakersOnly` on every board; 01 “…elapsed time is not recovery” (3 months); 05 Studio selectors; 04 a welted arrival stays restricted | ✅ |
| 3 Sneaker + welted alternative once lifted | 02 “every outfit names both…”, “Choose needs the shoe first…”; 09 “the restriction holds until the owner’s statement…” | ✅ |
| 4 Thermal: peak for shirts/trousers | 09 11→19 °C day (peak 19, departure 11) and every day: recorded temperature ranges and season labels vs peak | ✅ |
| 4 Thermal: morning for outerwear | 09 recorded ranges vs departure; jacket required below 10 °C | ✅ |
| 4 Thermal: 14–16 °C → lightweight oxford under a jacket | 09 `jacketBand` day (departure 15 °C) | ✅ |
| 5 No shirt/trouser repeat within 7 days | 09 every day against the TEST EVENT week + daily wears (via MCP `history`); 09 one-day exception; 11 repair | ✅ |
| 5 (spec §7) shirts/trousers distinct within a board | 09 every day | ❌ intermittent (D13) |
| 6 Never fall back to navy | 09 the service’s own swap ✅; first swap candidate never navy ✅; 02 swap list for option 1 ✅ (sampled); 09 “the Swap list offers no navy pieces at all” | ❌ D14 |
| 7 Perceptible names; jeans light/mid/dark | `perceptibleNames` on every board; 09 jeans; 09 no codes in copy | ✅ |

Other profile use checked: byte-identical profile and hash (01); Settings > My style (01); the full profile reaches the model (06); size answers from the profile (07); a profile edit reaches the next board and turn (09, 07); a one-day exception leaves the profile untouched (09); section 11 board format on every board (`expectGlanceableBoard`); registers spread, with the home key never the only register (01, 09 — ❌ intermittent, D15); benched pieces never offered (09); the belt-line flourish (09); purchase verdicts citing the profile (07); a consignment is a size correction, not a verdict (19).

## Last recorded runs

**2026-09-29, after the deterministic journey 10 anchors:** Journey 10 alone passed 10 consecutive runs (9/9 each). Two full `npm run test:journeys` runs followed. The first had 18 of 19 files passing, **155 passed / 156** (51 s). Its one failure was in journey 13, “an ordinary request becomes a trip in Paris time…”: the four-day proposal used four different trousers where the test expects deliberate reuse (`bottoms.size < 4`). This suite did not change that test. It is intermittent: it then passed in 6 consecutive runs of journey 13 alone and in the next full run, which passed with **156 / 156** (51 s).

**Earlier, after the first journey 10 fix:** `npm run test:journeys` → 19 files passed, **156 passed / 156** (73 s). Journey 10 alone passed 10 consecutive runs (9/9 each). The tests that failed on product defects in the earlier runs below pass in this run. The product code changed in other work items in between; this suite did not change those tests. The seed-dependent profile checks (D13, D15) are sampled differently in every run, so one green run does not show they are fixed.

**Journey 10 investigation (“a missed wear report does not exclude the chosen pieces indefinitely”).** This was a test fault, not a product defect. The old test built the week's boards with “Prepare now”. At the time, that path composed without applying a due weekly laundry reset: `ensureLaundryResets` ran only in the scheduled evening phase, the Workflow and resume. So the “after the weekly reset” step never happened. (Another work item has since made “Prepare now” apply a due reset too, in `RecommendationService.composeAndPublish`, covered by `backend/test/daily/prepare-reset.test.ts`.) The test also required Monday's shirt to appear on one of the last two boards, which the promise does not guarantee.

- **Diagnostic, 14 runs with “Prepare now”:** Monday's shirt stayed at p(available) ≈ 0.21–0.23 all week. It was still offered on some boards, because uncertainty alone never excludes a piece. It was missing from the last two boards in 3 of 14 runs.
- **Diagnostic, 12 runs with the scheduled evening phase:** p returned to 0.93–1.00 (likely available) after the Sunday reset in every run where the shirt was not chosen again after Friday's cutoff. It was still absent from the last two boards in 1 run (`usr_ca1dc918…`, p = 0.93) purely by ranking.
- **The fixed test:** the week comes from the scheduled phase. It asserts that after the Sunday reset each anchor is likely available, eligible, offered in Studio For today and completes a valid outfit. It still fails if the reset does not clear the estimate.
- **How the anchors are chosen:** the first fix picked the first option every day and anchored on early shirts that happened not to be chosen again. A valid ranking could reuse every early shirt from Friday on and leave the test with no anchors. The anchors now do not depend on ranking:
  - **Which pieces qualify:** an anchor is a piece whose only role is base top and that is laundered after every wear (a shirt, T-shirt or polo).
  - **Monday to Thursday:** each morning chooses the first option whose base top qualifies, and that top becomes an anchor.
  - **Friday on:** each morning chooses the first option that contains no anchor.
  - **Why this cannot run out:** a board never repeats a base top (the hard rule `board.distinct_shirts`), and an anchor can only fill the base-top slot. So at most four of a full board's five options hold one of the at most four anchors, and one option always avoids them all. The test also checks that the owner's wardrobe has fewer than five base tops that do not qualify, so every full board offers a qualifying top and the anchor set cannot be empty. Either check failing would mean a product rule broke (a board repeating a top, or a shortfall), not a ranking accident.

## Earlier recorded runs (2026-09-29, `npm run test:journeys`, three consecutive runs)

| Run | Files | Tests | Duration |
| --- | --- | --- | --- |
| 1 | 9 failed, 10 passed (19) | 13 failed, 143 passed (156) | 62 s |
| 2 | 9 failed, 10 passed (19) | 14 failed, 142 passed (156) | 75 s |
| 3 | 9 failed, 10 passed (19) | 13 failed, 143 passed (156) | 53 s |

The same 13 tests fail in every run (D1–D3, D5–D12, D14). The 14th failure in run 2 is the sampled cold-snap board (D13/D15). No failure is caused by the harness.

## Product defects found

The numbers match the tables above. The failing tests stay failing on purpose: none was weakened to pass. Reproduction steps are in the named tests.

| # | Defect | Test | Kind |
| --- | --- | --- | --- |
| D1 | The Wardrobe (and `availability=available`) shows a shirt in the hamper as “Available”. `evaluateEligibility` ignores laundry and cleanliness | 03 “the Wardrobe shows a shirt in the hamper as not available now” | UX |
| D2 | The item page's receipts omit that item's wear receipts. `listReceiptsForEntity('garment')`, but `record_wear` affects `daily_wear` entities | 04 “an item page carries … receipts” | UX |
| D3 | The transcript drops the Ask-about-this reference. The model sees it, but the stored user message has only the text | 06 “Ask about this attaches the exact board option” | UX |
| D4 | A repair triggered by an app command reaches the Calendar only at the next scheduled sweep. The API's daily service has no calendar store, and the effect is marked done | 10 “a later revision replaces …” (passes with the sweep) | observation |
| D5 | `include` on `POST /v1/recommend` / `garderobe_recommend` is ignored, although it is documented as “Garment ids every option must contain”. An unsatisfiable include gets no shortfall | 11 “an explicit request for a piece…”, “a requested count never justifies…” | functional |
| D6 | A packed shirt shows as available at home (Wardrobe and item page) | 13 | functional |
| D7 | Trip-day boards are not served by `GET /v1/today` or `garderobe_today`, which read only purpose `day` | 13 | functional |
| D8 | A return deadline is counted from the predicted delivery date even after the real arrival is recorded | 14 | functional |
| D9 | A standing comfort instruction (“do not suggest these for long walks”) is stored but never applied by the recommender | 15 | functional / profile use |
| D10 | A clean import restores the old owner's connected-assistant grants as active | 17 | security / portability |
| D11 | The export includes native session tables (`app_sessions`, `native_auth_codes`) with token hashes | 17 | security / portability |
| D12 | The clean import fails (`UNIQUE constraint failed: app_sessions.refresh_hash`) for any owner who has signed in on the phone | 17 | portability |
| D13 | The same trousers sometimes appear in two options of one board. Seen on the cold-snap day in about 1 run in 4 | 09 day 2026-10-08 | profile rule (variety within board) |
| D14 | The Swap list offers navy pieces (“Cotton-linen twill — Canclini sunwashed”, never first) against rule 6 | 09 “the Swap list offers no navy pieces at all” | profile rule 6 |
| D15 | Some boards put all five options in one register (all `field_workwear` on the rain + meeting day, all `academic_blazer` on the cold snap). Seen in about 1 run in 4 | 09 days 2026-10-08, 2026-10-09 | profile use (registers) |
