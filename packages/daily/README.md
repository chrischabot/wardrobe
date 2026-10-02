# @garderobe/daily

The daily service of Garderobe (specification sections 7 and 9, plus trips and pause/resume):
mandatory context, outfit validation and composition, boards with immutable revisions, automatic
repair, the weather skill, Calendar reading and the managed outfit event, the scheduled phases, trip
packing and pause/resume. Every mutation goes through the shared command service.

## Commands (from `wardrobe/packages/daily`)

| Purpose | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Tests (workerd, real local D1, real owner data) | `npm test` |
| Check the live external contracts the adapters rely on | `npm run verify:contracts` |

`verify:contracts` needs network access and no credentials. It runs three checks:

- `scripts/verify-open-meteo.ts`: the live Open-Meteo forecast and geocoding endpoints through the real
  adapter, including the next daylight-saving change inside the forecast range (the adapter's claim
  that the hourly labels carry one fixed offset).
- `scripts/verify-google-calendar.ts`: every Google Calendar v3 method, parameter and field the
  Calendar adapter uses, against Google's published discovery document.
- `scripts/verify-unauthenticated.ts`: every Calendar operation of the real adapter sent to the real
  service with a value that is not a token (Google must answer 401 on each exact URL and verb, so
  nothing can be written), and one WeatherKit request signed with a throwaway key (Apple must answer
  401). This proves the endpoints, verbs and error contracts, and nothing behind authentication.

Every adapter abandons one request, body included, after `timeoutMs` (15 seconds by default) and
reports it as a retryable network failure, so a silent provider cannot hold a scheduled phase.

## What is real and what is a stand-in in the tests

- Real: the command service, D1 (local, in workerd), the foundation ledger, the owner's profile and
  inventory imported through the ordinary commands, validation, composition, repair, the projector,
  the scheduler.
- Labelled fakes, only at the adapter boundary: `FakeWeatherProvider` / `FakeGeocoder` (the weather
  HTTP service), `FakeGoogleCalendar` (the Google Calendar HTTP service), and in two tests a fake
  composition model (the AI Gateway). The real Open-Meteo adapter is tested against a recorded live
  response; the Google Calendar and WeatherKit adapters are tested against the documented wire shapes
  with a scripted `fetch`. Neither has been run against the real service with real credentials.

## Wiring

```ts
const registry = createFoundationRegistry();
registerDaily(registry); // commands, version resolvers, in-commit board repair hook
const deps: DailyDeps = {
  db, commands: new CommandService({ db, registry }), clock,
  weather: { provider: createOpenMeteoProvider({ fetch }), geocoder: createOpenMeteoGeocoder({ fetch }) },
  calendar: { reader, writer },   // createGoogleCalendar({ fetch, getAccessToken }) or null when not connected
  model: null,                    // a CompositionModel behind the AI Gateway; optional
  modelFor: (principal) => model, // preferred: a model budgeted to that owner (also used by the scheduled sweep)
  modelBudgetMs: 120_000,         // wall-clock budget for the model part of one board
  comfort: null,                  // reader for dated comfort observations; optional
};
await runDueJobs(deps);           // from the five-minute cron
```

Route a slot swap through `swapSlot(deps, principal, ...)` rather than sending `board.swap_slot` bare:
it consults the weather service first when the board's forecast is past its freshness threshold. The
bare command still uses the newest forecast recorded for the day and, failing that, states the age of
the forecast it checked against and flags the board for the sweep. For an ad hoc outfit question use
`decisionContext(deps, principal, { outfit, role })`.

Settings live under `OwnerSettings.extensions.daily` (`DailySettings` in `@garderobe/contracts/ext/daily`):
phase times, wearing intervals, freshness thresholds, the outfit calendar and its presentation.

## Interpretations recorded here

- A garment temperature note whose basis the inventory sheet did not state is assessed on the basis of
  the owner's active rule for that role (shirts, trousers and socks on the daytime peak, outerwear on
  the departure hour). Without such a rule it is not enforced and is reported as unsettled.
- The research rules that are absent from the profile (cotton-linen from 28 C, pure linen from 30 C,
  lightweight oxford from 10 C, no outerwear above 24 C, alpaca at 12 C or colder) stay
  `pending_reconciliation`: they are carried in validation evidence and are not enforced until the
  owner activates them. Activated rules of that shape are enforced at their boundary.
- With no forecast, a jacket is only composed over a lightweight oxford, because the 14 to 16 C rule
  cannot be ruled out; temperature checks are reported as unverified and the board says so. The
  validator refuses the combination too (`jacket_band_unverified`, blocking) unless the owner named
  the jacket himself, in which case it is a stated advisory. The rule covers every layer under the
  jacket: the base shirt and a shirt or knit worn as the mid layer.
- Watches and jewellery are recognised by the garment attribute `accessoryKind` (set at creation or
  import), not by name: `watch`, `ring`, `chain`, `bracelet`, `necklace`, `cufflinks` and similar are
  never part of an outfit. Names are only a backstop for records with no kind, and a generic
  `accessory` with no kind is never offered by the service (`accessory_unclassified`); the owner can
  still add it himself, as a stated advisory.
- When the owner reports the healing restriction over, the sneaker and welted format comes into
  force: every open board keeps its options, their IDs and his selection, and each option gains an
  eligible welted alternative in the same commit.
- A board whose options have all become invalid and cannot be replaced is published as an empty
  revision with a plain notice; it is never left showing invalid outfits. A board flagged for a
  recheck reads as `limited`, not `current`, until the sweep has checked it.
- A scheduled run never replaces a board the owner made, changed or chose from while it was
  composing: it states the board revision it composed over (`expectedBoardRevision`), and a chosen
  outfit that is still valid is kept; the board is rechecked in place instead.
- `board.restore` itself clears a delivery suppressed because the event was deleted in Calendar, so
  the restore holds whatever revision is delivered next.
- Freshness shown on a board is judged when it is read (pass `nowMs`): a forecast older than twelve
  hours or a calendar read older than a day no longer reads as fresh.
- A scheduled phase that fails five times stops; the fifth failure is reported once by the sweep
  (`detail.gaveUp`) and Today says the board could not be prepared. The phase lease is three model
  budgets plus a minute, at least five minutes.
- Season words in the sheet ("Cold", "Warm-weather", ...) and the colour relations used by the
  deterministic composer are soft ranking preferences. They never reject an outfit and are not a
  claim about taste.
- Shirts marked as a layering tier are not offered as the base shirt.
- A missed morning phase is caught up for three hours after the morning time; later it is not replayed.
- The 6:50 phase is the final check: a forecast older than `weatherMaxAgeMinutes` (60) or a calendar
  read older than `calendarMaxAgeMinutes` (30) is read again then and the board revalidated. An ad hoc
  request reuses a calendar read inside the threshold.
- Slots affected by weather for a swap: everything except the belt and accessories.
- An owner's layer-combination rule is a hard style rule `layering.<name>` with
  `{ basis, minC?, maxC?, pieces: { outer?, top?, mid_layer?, bottom? } }`; none exists in the profile
  beyond the 14 to 16 C jacket rule.
- Unpacking returns every packed unit as awaiting care (the ledger's rule), including unworn ones.
