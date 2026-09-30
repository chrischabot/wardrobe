# Daily service: recommendations, weather, calendar, morning workflow, trips

The daily-service workstream: `backend/src/{recommend,daily,weather,calendar,trips}` and migration `0002_daily_service.sql`. Composition, validation, repair and publication need **no model**. A model can only improve prose (`ProseWriter`) or add candidates (`CandidateProposer`), and the same validator checks everything either produces.

Import from `@garderobe/backend/recommend`, `/daily`, `/weather`, `/calendar` and `/trips`.

## Service interfaces (for the API/MCP layer)

```ts
import { RecommendationService } from '@garderobe/backend/recommend';
import { DailyService, createDailyService } from '@garderobe/backend/daily';
import { TripService } from '@garderobe/backend/trips';

const deps = { db: env.DB, principal, weather: new OpenMeteoProvider(), calendar /* CalendarSource | null */, clock };
const rec = new RecommendationService(deps);
```

| Need | Call | Returns |
| --- | --- | --- |
| Today / a day's board (`GET /v1/today`, `garderobe_today`) | `getDailyBoard(db, principal, date, purpose = 'day')` | `Board` with `document: BoardDocument` (contracts) |
| Compose + publish | `rec.composeAndPublish({ date, requestedCount?, window?, occasion?, wholeBoardOccasion?, include?, exclude?, briefText? })`: first applies any weekly laundry reset already due (idempotent, the same call the evening phase makes), so "prepare now" (`POST /v1/today/prepare`), trip-day boards and resume all see post-reset availability | `PublishOutcome { published, board, shortfall, attempts, reason }` |
| Preview (no write; `POST /v1/recommend`, `garderobe_recommend`) | `rec.compose(req)` (does not apply resets; it writes nothing) | `{ context, composed }`; `composed.reserves` holds up to two further valid outfits that repeat no shirt or trousers on the board, drawn from the whole valid set when the taste shortlist is used up; `composed.pins` says per `include` id whether it is in every option (`enforced`) or why not (`problem`), and `composed.shortfall` names each piece that cannot be included, with the reason |
| Mandatory context (also for the assistant) | `rec.context(req)` | `MandatoryContext` |
| Validate a proposed outfit (model/MCP/app) | `rec.validateProposal(req, { slots: [{ garmentId, role, alternativeGroup? }] })` | `OutfitValidation { valid, violations, checks, warnings }` |
| Swap one slot ("a correction is a swap, not a rebuild") | `rec.swap({ boardDate, optionId, role, replacedGarmentId?, replacementGarmentId? })` | `RevisionOutcome` (new revision, changed-item summary) |
| Swap list (`GET /v1/today/options/{id}/swaps`) | `rec.swapCandidates({ boardDate, optionId, role, replacedGarmentId?, limit? })` (reads only) | `{ candidates: { garmentId, name, reason }[] }`: validated as a swap, so never a navy fallback; never a shirt or trousers already used by another option; ranked by taste |
| Repair after a change | `daily.processEffects()` (call after every committed command, e.g. in `waitUntil`) or `rec.repairBoard(date, purpose, reason)` | `EffectProcessingResult` / `RevisionOutcome` |
| Scheduled phases | `daily.sweep()`, `daily.runPhase('evening' \| 'morning_refresh' \| 'final', date)`; Workflow `DailyServiceWorkflow` with `{ userId }` | `PhaseResult[]` |
| Pause / resume | `daily.pause({ startsOn?, resumeOn? })`, `daily.resume()` | pause id, suppressed dates / next board |
| Calendar projection | `daily.projector.projectDay(date)`, `projectPending(from)`, `suppress(date, 'owner_removed')`, `restore(date)` | `ProjectionResult` |
| Trips | `trips.createTrip`, `proposePacking(tripId, { seed? })`, `markPacked`, `markUnpacked`, `composeTripDay(tripId, date)` | trip records; boards with `purpose = trip:<id>`. A proposal packs at most ceil(days/2) trousers: shirts already proposed are excluded before each day is composed (so every combination with the unused shirts is searched, not a bounded board filtered afterwards); once the limit is reached every further day reuses a packed pair (re-composing with the pair pinned when needed); another pair is added only when none makes a valid outfit that day, and the notes say so |
| Repair/swap receipts | `rec.listRevisionReceipts(boardId)` | `runs` rows (`board_repair`, `swap`) |

Selections still go through the foundation `select_option` command. Its `calendar_projection` effect is applied by `daily.processEffects()`. Writes require `wardrobe:write`; a read-only grant can preview, validate and read.

Pause, packing and swaps are service functions, not domain commands, so they write `runs` receipts rather than command receipts.

## Morning schedule (Europe/London unless a trip or the settings say otherwise)

| Local time | Phase | Result |
| --- | --- | --- |
| 21:00 the evening before | `evening` | weekly resets (once per cycle), compose, validate, publish, project |
| 06:40 | `morning_refresh` | fresh forecast; repair invalidated options (a whole-board recomposition only if no board exists). A board composed without a forecast (weather `unavailable`/`missing` at the evening phase) is brought onto the real forecast once the provider answers: recomposed if nothing is selected or worn yet, otherwise republished around the selection with every option revalidated; on a day already being worn it is a weather-only revision (same options, same selection, wears untouched). The forecast weatherRecovery fetched is reused for that revision rather than fetched twice |
| 06:50 (deadline) | `final` | apply pending changes, final revision, verify Calendar; `deadlineMet` recorded |

Each owner, date and phase runs once (`runs` row `daily:<date>:<phase>`). A missed morning is caught up until 12:00 local. Past days are never composed. Pause is checked inside the publication batch itself.

## Injecting conditions (tests, demo, end-to-end simulation)

- **Weather**: `new FakeWeatherProvider({ scenario, byDate?, byLocation?, fail?, issuedAt?, missingFields?, clock })`. Scenarios in `WEATHER_SCENARIOS`: `mild`, `coldSnap`, `elevenToNineteen`, `jacketBand` (15 °C departure), `heavyRain`, `strongWind`, `heat` (31 °C), `warmDayCoolEvening`, `rainAfterFour`, or any `(date, hour) => conditions` function. `provider.set({...})` switches conditions, and the shared cache never serves the old scenario. `fail: true` simulates an outage, and a prior snapshot then becomes `stale`.
- **Calendar**: `new FakeCalendar(clock)` implements both `CalendarSource` and `ManagedEventStore`. It provides `addEvent({ title, start, end, selfResponse, status, allDay, location, description })`, `failListing`, `failNext(n, status)`, `loseNextResponse()`, `holdNextWrite()`, `ownerEdit`, `ownerDelete`, and counters `inserts` and `writes`.
- **Real adapters**: `OpenMeteoProvider` (keyless; live check: `npm run smoke:weather --workspace @garderobe/backend`) and `GoogleCalendarAdapter({ getAccessToken, contextCalendarIds?, fetcher? })`. The Google adapter is written against Calendar API v3 and exercised only with a fetch double; it has not been run against Google.

## How the owner profile is enforced

The parameters come from the owner's stored rules (`data/owner-profile-rules.json`, compiled by `compileProfilePolicy`). Every option stores `rulesChecked` (rule key, result, detail and passage section) in its validation evidence.

| Rule | Strength | Where |
| --- | --- | --- |
| `hard.socks_always` (merino default; bed socks indoor only; alpaca only at 12 °C or colder; no exception) | hard | validator + sock pool |
| `hard.sneakers_only_until_healed` (welted, boots, 990v6) | hard | restriction eligibility + validator + footwear pool |
| `hard.sneaker_and_welted_alternative` (active only once lifted; one footwear group) | hard | validator + composer pairing |
| `hard.thermal_peak_for_base` (shirt, knit, trousers against the wearing-interval peak; evening-only uses the evening interval) | hard | validator + pools |
| `hard.thermal_morning_for_outerwear` (jacket band vs departure; a departure below 14 °C needs a jacket — implementation reading) | hard | validator + composer |
| `hard.thermal_jacket_14_16_lightweight_oxford` (rounded departure 14–16 °C inclusive; relaxable only by a dated owner exception) | hard | validator + composer |
| `hard.variety_seven_days` (shirts and trousers; dated exception relaxes repeats, never cleanliness; trips permit deliberate reuse) | hard | validator + pools |
| `hard.never_fall_back_to_navy` (swaps, repairs and the Swap list; an explicit owner choice may be navy) | hard | swap/repair validator, `swapCandidates` |
| `hard.perceptible_names` (indigo jeans need light/mid/dark; no maker codes; boards render `garment.name`) | hard | validator + document |
| `colour.no_neutral_three_times` (each footwear alternative checked) | hard (per catalogue) | validator |
| `register.home_key_never_only` | hard, board level | selection + board checks |
| `board.distinct_shirts`, `board.distinct_trousers` (spec section 7: a board never repeats a shirt or trousers; fewer options are published instead; a piece the owner asked for with `include` is exempt; trip boards may repeat trousers) | hard, board level | selection (matching-guided, so a greedy choice cannot block a full distinct board), repair and swap |
| `board.register_spread` (profile sections 3 and 6: at most half the board in one register while others are possible, always at least two registers when the pool has them; otherwise the board check records why) | soft, board level | selection |
| Owner comfort directions (`record_comfort_feedback` with `standingInstruction`; style rule `comfort.*`, `machine.excludeGarmentIds` + `when.activity/setting`) | hard, only on a day whose situation matches: the request's brief, dated owner briefs, titles of calendar events that count (declined ones do not), a trip's occasion note | pools + validator; `ctx.comfort` |
| Comfort observations (`record_comfort_feedback` without a standing instruction, with an activity or setting) | soft: lower rank and a `comfort.observation` note on a matching day; never a ban | taste score + validator |
| `accessories.no_watches_or_jewellery`, `filter.*` tags | hard | validator + pools |
| `colour.foot_echoes_higher_up`, `register.avoid_clown` (no board ever has two loud pieces), `register.safe_never_leads`, `fabric.sings` / `fabric.repels`, `colour.palette`, `accessories.belt_line_optional_flourish` | soft | taste score, selection order, belt line |
| `board_format.daily_entry` | format | `BoardDocument` (day line → why → jacket, shirt/jumper, trousers, belt + optional scarf/tie, socks with shoes) |

Availability is a hard gate. Pieces that are dirty (no estimated clean unit), incoming, disposed, restricted, away (tailor, storage, suitcase), benched, indoor-only, or occasional without an explicit request are all excluded. Uncertainty alone never excludes a piece: options are ranked by joint availability, computed by exact dynamic programming over earlier board days using the foundation estimator's clean units and selection prior.

`include` pins pieces: every option contains each requested piece that can be worn today. A request never makes an ineligible piece eligible. A piece that cannot be worn (unavailable, restricted, not clean, wrong for the weather, a seven-day repeat, excluded, or ruled out by a comfort direction) is left out, and the shortfall names it with the reason. If a wearable piece combines into no valid outfit, the board is composed without it and says so.

Model seams: proposer output is schema-checked before use, and malformed candidates are discarded as rejected. Model prose goes through `checkProse`, which refuses any wording that drops the socks ("skip the socks", "bare ankles", "barefoot"), restricted footwear while sneakers-only stands, watches or jewellery, codes, invented percentages, and any garment outside the option, named in full or by its short name (the part before " — "). It also refuses search-only phrases, strictly: every registered maker code of every wardrobe garment (product code or maker-code alias, any length or form, including all-letter and two-character codes) matched as a whole token in any case, and every search-only alias of every garment (any alias that is not that garment's own display name or short name, however short, e.g. "Cashmere", "Harris Tweed") matched as a whole phrase in any case. Exceptions are narrower for codes than for aliases. A maker code is allowed only where it lies entirely inside the display name or short name of one of the outfit's pieces; no other wording exempts a code, so a code equal to a word of a piece's recorded fabric ("CASHMERE" registered while a piece records "cashmere") is still refused. A search-only alias is also allowed where it lies entirely inside the outfit's own wording for one of its pieces: its display name, its short name, or its recorded fabric (which the deterministic sentence quotes). Without it the deterministic copy itself would be refused on the owner's wardrobe ("PWVC Cashmere Cord Bark" contains the alias "Cashmere cord"; its fabric "6-wale cotton/cashmere cord" contains the scarf's alias "Cashmere"). The foreign-garment rule applies the same exception, so a fabric quoted from an outfit piece ("cotton-linen twill") is not read as another garment's short name. So the board text and the Calendar event built from it (title, description, and so the event's notification) use display names only. The deterministic fallback obeys the code rule too: a quoted record phrase (fabric, colour or noun) holding a registered code as a standalone word is dropped from the sentence, and an opening that would do so names the pieces by display name; the assembled sentence is checked as a whole (template words such as "The", "with", "and" count), and if it still holds a code it becomes the pieces' display names joined by punctuation. A final guard (`maskStandaloneCodes`, via `guardPublishedCopy` and the Calendar projector) then runs on every piece of finished copy: the rendered board text, day line, weather line, suitability note, shortfall, each option's sentence, line labels, line text and flourish, and the Calendar title and description. A registered code standing alone there, outside a piece's display or short name and outside the board link, is removed: a template word that is also a code becomes a neutral sign ("and" → "&", "with" → "+", "or" → "/", "the"/"a"/"an" dropped) and any other word a middle dot. The iOS app builds its own line labels (`BoardLayout.swift`), so its labels are outside this guard; `test/daily/calendar-copy.test.ts` checks every code and alias of the 144-garment wardrobe, scans the projected events, and confirms over 64 seeded boards that the deterministic copy is never refused. Board documents still carry `garments[].aliases` for app search. Refused prose is replaced by the deterministic sentence.
