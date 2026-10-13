# Wardrobe on Ferrite

The port of the Wardrobe backend (the TypeScript Cloudflare Worker in
`apps/worker` and the domain in `packages/domain`) to a Ferrite constrained
application: one Rust crate whose only dependency is `ferrite-app`. The owner
asked for Wardrobe and its Codex plugin to be hosted fully on Ferrite; this
directory is that port, built flow by flow. The TypeScript backend stays the
behaviour reference until the port reaches parity.

**Status: the MCP endpoint, the board, service laundry and wear records (milestone 1d).** The owner's
real inventory can be read, and the ported commands run end to end with
their receipts and, where the TypeScript service has one, their undo: "it is
in the wash" (`care.mark_dirty`), "I washed it" (`care.washed`) and `command.undo` to take
it back, from the owner's app or a connected assistant, through Ferrite's
request queue and APE store. A connected assistant such as the Codex plugin
reaches the same commands through the MCP endpoint (`/mcp`), signing in with
the app's own OAuth. The day's outfit board is ported (`board.publish`,
`board.select`, `board.swap_slot` with their undo, and `garderobe_today`),
and so are service laundry (`laundry.collect` and `laundry.return`, with
their undo) and wear records (`wear.record`, with its undo, and the day's
record). The daily recommender (`garderobe_recommend`), saved runs
(`garderobe_run`) and the assistant's tools (`garderobe_ask`,
`garderobe_research`, behind the AI Gateway adapter, refusing by name until
its secret is set) are ported; see "The assistant". The app's Today reads, its
sign-in (see "Signing in the owner's app") and Studio's reads (see "Studio")
are ported too.
Nothing has been deployed: see "Deploying".

## Running it

You need the Ferrite CLI 0.1.20 and Rust 1.89 (`rust-toolchain.toml`).
The released CLI installs with `curl -fsSL https://downloads.ferrite.cloud/install.sh | sh`;
while Ferrite is in preview that host needs a preview token
(`FERRITE_PREVIEW_TOKEN`, see the Ferrite docs). The same CLI builds from
source: `cargo build --release -p ferrite-cli` in `tools/ferrite-cli` of
`iGentAI/ferrite-labs`, then put `ferrite` on `PATH`. `ferrite --version`
must report SDK twin `sha256:c8d10a97…` (recorded in `ferrite-twin.json`).

```bash
cd ferrite
sh scripts/vendor-sdk.sh         # restores vendor/ (not committed) from the CLI
ferrite check                    # code gate, spec statics, cargo check
ferrite check --target upstream  # plus upstream Core's manifest keys and SDK surface
ferrite test                     # unit tests and the end-to-end harness tests
ferrite dev                      # http://127.0.0.1:8787

# from the repository root: the embedded inventory and profile still match the importer
node --experimental-strip-types ferrite/scripts/build-seed.mjs --check
# and the embedded command descriptions still match the Worker's command registry (Node 22.7+)
node --experimental-transform-types ferrite/scripts/build-command-types.mjs --check
```

`ferrite dev` reads its secrets from `[secrets]` in `ferrite.local.toml`
(gitignored; create it from the comments in the scaffold's copy if missing):

```toml
[secrets]
WARDROBE_OWNER_TOKEN = "local-dev-owner-token"
WARDROBE_ASSISTANT_TOKEN = "local-dev-assistant-token"
WARDROBE_PUBLIC_ORIGIN = "http://127.0.0.1:8787"
# optional: the owner's app sign-in (see "Signing in the owner's app")
# WARDROBE_APP_CLIENT_ID = "garderobe-ios"
# WARDROBE_APP_REDIRECT_URI = "https://app.example.test/oauth/callback"
```

```bash
curl -s -H 'Authorization: Bearer local-dev-owner-token' http://127.0.0.1:8787/v1/wardrobe
curl -s -H 'Authorization: Bearer local-dev-assistant-token' -H 'content-type: application/json' \
  http://127.0.0.1:8787/v1/commands \
  -d '{"type":"care.mark_dirty","payload":{"items":[{"garmentId":"gmt_ec41eb7ad2e2ab344b0e03c3"}]},"idempotencyKey":"example-0001","authorization":"owner_statement","source":{"channel":"mcp"}}'
```

## What the slice does

| Route | As in the TypeScript API |
|---|---|
| `GET /health` (public) | service status |
| `GET /v1/wardrobe[?category=]` | the inventory: every imported garment with its balances (clean, dirty, at the laundry service, packed for trips) and version. A subset of `listInventory`: no availability estimate, aliases, colours or wear counts yet |
| `POST /v1/commands` | the command envelope of `packages/contracts` (`type`, `payload`, `idempotencyKey`, `authorization`, `source.channel`, optional `occurredAt`, `expectedVersions`) |
| `GET /v1/today[?date=YYYY-MM-DD][&scope=home\|trip:<tripId>]` | `TodayResponse` as `readToday`: the board of the scope (the home board, or a trip's day board, see "Trip-day boards") for the day, or none, with the garments recorded worn that day. Without a date it is the owner's day now in his timezone (Europe/London, the default setting, with British Summer Time), whatever the scope. `status` is `ready` or `none`; the source freshness list gives the board and wardrobe revisions, style, and then weather as `unavailable` and Calendar as `not_connected`; `runId` is null (nothing composes in the background) and `wardrobeRevision` is the current revision. An evening scope (`home:evening`, `trip:<tripId>:evening`) is refused, since evening boards are not ported |
| `GET /v1/weather[?date=YYYY-MM-DD]` | `WeatherSnapshot`, for the owner's day now when no date is named: what the TypeScript service answers for an owner with no home city (no settings command is ported, so `homeLocation` is null). There is no forecast: `freshness` is `unavailable`, every window and condition value is null (never zero, dry or calm), the line is "Weather unavailable" and the limitation is "No home city is set, so no forecast was requested." The snapshot is answered and not recorded (`weather.record_snapshot` is not ported) |
| `GET /v1/days/{date}` (owner only) | the day's recorded wear (`DailyRecord`, as `getDailyRecord`): counted garments and every report with its status. Choosing an outfit never changes it |
| `GET /v1/commands[?limit=]`, `GET /v1/commands/{id}` | receipts, newest first; an undo already used is no longer offered |
| `GET /v1/assistants`, `POST /v1/assistants/{grantId}/disconnect` (owner only) | Settings › Connected assistants (`AssistantGrantList`, `AssistantGrant`, as `listGrants` and `disconnectGrant` in `mcp/grants.ts`): the OAuth grants of connected assistants, active ones first, then newest first, and disconnecting one, effective on its next request. An unknown grant, or one of the app's own sign-ins, is `not_found` |
| `GET /v1/connections`, `POST /v1/connections`, `/v1/connections/{id}/…` (owner only) | Outbound tool connections (Google Workspace, owner-added MCP services) cannot be registered on this server: the list is `{"connections": [], "readAt"}`, registering one answers 501 `module_unavailable` with `details.module: "connections"`, and every route naming a connection (capabilities, disconnect, reconnect, calendars, outfit calendar) is `not_found` |
| `GET /v1/devices`, `POST /v1/devices`, `POST /v1/devices/{deviceId}/remove` (owner only) | Notification devices (`DeviceList`, `Device`, `DeviceRemoved`, as `notifications/service.ts`): registering or refreshing a device's APNs token (a token registered under another device ID moves to this one), listing, and removing. Nothing is delivered, so `deliveryConfigured` is false and `lastDeliveryAt` null; the token is kept for a later dispatcher and never returned. At most 20 devices are kept |
| `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/{id}`, `POST /v1/exports/{id}/ticket` (owner only) | Portable export (`ExportRequest`, `ExportJob`, `ExportList`, `DownloadTicket`, as `export/job.ts`), see "Portable export" |
| `GET /v1/exports/{id}/download?ticket=` (the ticket alone) | The package (`application/zip`), for a ticket the owner was just given: each ticket works once, for 5 minutes, and is spent before a byte is sent; the sign-in is neither needed nor read |
| `POST /mcp` (OAuth) | the MCP server of `apps/worker/src/mcp`, see below |
| `GET /v1/meta` | `MetaResponse`: API and contract versions, mounted modules (media is reported as not mounted), server time, the MCP endpoint and its protocol versions. Without a valid `WARDROBE_PUBLIC_ORIGIN` it is refused by that secret's name |
| `GET /v1/command-types` | `CommandTypeList`, as `describeCommandTypes`: the nineteen command types this port executes, each with the class, required scope and payload JSON Schema the TypeScript registry gives it (`src/seed/command-types.json`, written by `scripts/build-command-types.mjs`), narrowed to this port: only the payload fields its handler accepts, with `additionalProperties: false` (so `board.publish` has no `requestFingerprint`), only the `owner_tap` and `owner_statement` authorizations (a publication by schedule is not ported), and `consequential` from the port's own connected-assistant rule, under which none of the nineteen waits for the owner. A field whose other values the port always refuses is published as the value it accepts: `board.publish` `scope` `"home"` or `trip:<tripId>` (no evening boards), `brief` the default day brief, `weatherSnapshotId` and `calendarSnapshotId` null only; `board.swap_slot` `weatherSnapshotId` is left out (no value is accepted); `return.open_case` `orderId` and `lineId` null only, `garmentId` a garment ID (never null) and `timezone` `Europe/London` or `UTC`. Size bounds (list and text lengths) are not restated; the command names them when it refuses |
| `POST /v1/commands/batch` | the phone's offline replay (`CommandBatchResponse`): 1 to 50 envelopes in order, each run as `POST /v1/commands` runs it, independent of the others, with `retryable` from the error code as `isRetryable` decides it. Once commands have run, a failed final read still answers their results |
| `POST /v1/recommendations` | `RecommendResponse`. `preview` (default): the recommender's validated options, nothing published. `board`: those options published through `board.publish` as the day's home board, or, for a day of a planned trip with something packed, as that trip's day board (`trip:<tripId>`, composed from the suitcase; see "Trip-day boards"), under the key `board-compose:{caller}:{clientRequestId}` (the caller is `owner` or `assistant`, so the two never meet on one publication), answered with the board. A retransmission answers from the saved run and the publication's receipt. `date` is required (no owner timezone); `lockedGarmentIds` and `occasionOnly: true` are refused as not ported |
| `POST /v1/boards/{id}/swap` | `SwapSlotResponse`: `board.swap_slot` under the key `board-swap:{caller}:{clientRequestId}`, `expectedRevision` sent as the board's expected version, answered with the receipt and the board as it now stands. No fresher forecast is fetched first (weather is not ported) |
| `GET /v1/laundry` | `LaundryStateResponse` as `getLaundryState`: the hamper by care channel (service, hand wash), sorted by name, and the newest 12 laundry bags not withdrawn, newest first. `returnBasis` is null; `exceptions` and `cycles` are empty (laundry exceptions and weekly cycles are not ported) |
| `GET /v1/feedback[?garmentId=]` | `FeedbackList` as `listComfortFeedback`: the comfort notes still active, newest first, or those naming one garment, see "Comfort feedback" |
| `GET /v1/trips`, `GET /v1/trips/{id}` | `TripList` and `Trip` as `listTrips` and `getTrip`: every trip by departure date then ID, each with its latest packing proposal (or null) and what is packed for it (`packed`), see "Trips" |
| `POST /v1/trips/{id}/packing-proposal` | `PackingProposal` as `proposePacking`: a proposal for a planned trip from the stock at home, recorded through `trip.record_packing_proposal` under the key `packing:{clientRequestId}`. Nothing is packed, see "Trips" |
| `GET /v1/returns` | `ReturnList` as `listReturnCases`: every return and exchange case, cancelled and finished ones included, the soonest established deadline first, then the newest; see "Returns" |
| `GET /v1/orders` | `OrderList`, always empty: orders come from purchase import (`purchase.import_order`), which is not ported |
| `GET /v1/studio[?mode=for_today\|explore][&date=]` | `StudioResponse`: Studio's selectors and opening outfit for the day (the owner's day now when none is named), see "Studio". `combinations` and `dayPlans` are always empty (the Studio commands are not ported) |
| `POST /v1/studio/validate` | `StudioValidation` for a `StudioOutfitRequest`: the daily validator's verdict on the outfit for the day, with Studio's shopping-candidate rule, see "Studio" |
| `POST /v1/studio/suggest` | `{suggestions: StudioSuggestion[]}` for a `StudioOutfitRequest`: up to `limit` (default 5) valid outfits composed around the locked slots, see "Studio" |
| `POST /v1/studio/compose` | `Composition`: the deterministic layout of the outfit's garments (`buildManifest`) and its hash, with every garment a labelled text tile (no media) and the preview `none` |
| `GET /v1/studio/compositions/{hash}[/preview]` | 404 `not_found`: a composition is kept only when a preview is requested, which this server does not do |
| `GET /v1/service` | `ServiceState`: never paused (pause and resume are not ported) |
| `GET /v1/me` | `MeResponse` for the one owner this port serves (`userId: "owner"`), with the caller's channel (`ios` for the owner token and the app's sign-in) and scopes (`read`, `write`, `admin` for the owner; `read`, `write` for the assistant token); no linked identities and no recovery kit (identity, linking and recovery are not ported) |
| `POST /v1/sessions/revoke` (owner only) | `SignOutEverywhereResponse`: sign out everywhere. Every sign-in of the owner's app ends now (its access and refresh tokens stop working); connected assistants and the owner token are untouched. `sessionsRevokedBefore` is the moment of the request |
| `POST /auth/claim`, `/auth/link/complete`, `/auth/recovery/start`, `/auth/recovery/complete`, `POST /v1/identities/link`, `/v1/identities/unlink`, `/v1/recovery-kit`, `/v1/account/delete` | 501 `module_unavailable` with `details.module: "identity"`: they need an identity provider (Cloudflare Access in the TypeScript Worker), which this port does not have. The `/auth/` ones answer before any sign-in; the `/v1/` ones after it. Nothing is written |
| `GET /v1/recovery` | `RecoveryStatus`: the last published home board for the owner's day (ID, date, revision, publication time) and its Calendar projection, `actions: ["open_today"]` when there is one, and diagnostics (`environment: "ferrite"`, the daily and assistant modules present and media absent, and why there is no board, or the board read's error in at most 200 characters). `pending` is always zero and `connectionIssues` always empty, see Known limits. Nothing is written |
| `GET /v1/wardrobe/temperature-preview?temperatureC=` | `TemperaturePreview` as `temperaturePreview`: for a temperature from -40 to 50 °C, each owned garment in a top, mid-layer, bottom, outerwear or socks role that its thermal range would exclude, the active hard fabric-class rules that exclude a fabric there, and the outerwear ceiling. It reads the real seed's thermal ranges and rules and writes nothing; a missing or unreadable temperature is `invalid_command` |
| `GET /v1/style[?date=]` | `StyleContext` as `getStyleContext`: the owner's profile verbatim (document `owner-profile` version 1, its SHA-256 and byte length), the profile's machine rules ordered by key with the passages they quote, his body measurements ordered by key, his size experiences by maker, the contract's precedence statement and `styleRevision` 0. Amendments, standing directions, day briefs and fact conflicts are always empty (no style command is ported). A malformed `date` is `invalid_command`. The owner and a connected assistant read it; nothing is written |
| `GET /v1/style/conflicts[?status=open\|resolved\|withdrawn\|all][&documentId=]` | `StyleConflictList`, always empty: a conflict is left by saving an edited profile, which is not ported. Any other status is `invalid_command` |
| `GET /v1/settings` | `SettingsResponse`: the specification's default settings (`DEFAULT_OWNER_SETTINGS`) at version 1, since no settings command is ported; `defaultOptionCount` is the count the recommender uses. `profile` and `inference` are null. Its timezone is what Today, the weather and `garderobe_today` default to; the other dated routes still take the day explicitly |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | the authorization server of the MCP endpoint and of the owner's app, see below |

Commands: `care.mark_dirty`, `care.washed`, `board.publish`, `board.select`,
`board.swap_slot`, `feedback.record`, `feedback.retract`, `laundry.collect`, `laundry.return`,
`trip.create`, `trip.update`, `trip.cancel`, `trip.record_packing_proposal`, `return.open_case`, `return.update_case`, `wear.record` and `command.undo`. Each applies at once and
answers with the receipt of `CommandReceipt` (contract 1.1.0): summary built
from the ledger, affected entity versions, repairs, result, undo
availability, wardrobe revision, actor and channel. The same idempotency key
and body returns the stored receipt (`replayed: true`); the same key with
another body is `idempotency_key_reuse`. Errors use the API's codes and HTTP
statuses. Numbers in a command must be whole numbers from 0 to 2^53 - 1
(every number this slice takes is a count or a version), except a trip
destination's `latitude` and `longitude`, which may be negative or
fractional and are hashed as JavaScript writes them (any number from
0.000001 to 10^21 in size, or 0), and a return's `refundExpectedMinor` and
`refundReceivedMinor`, which may be any whole number from -(2^53 - 1) to
2^53 - 1 (a correction may be negative); this keeps the
request hash equal to the TypeScript service's.

When the server cannot settle whether a request was written (a commit whose
response was lost, an idempotency marker that cannot be read), it answers
`internal` with `details.outcome: "unknown"` and never says nothing was
written; sending the request again with the same key returns its receipt if
it was written and applies it once if not. `tests/executor.rs` covers this
against a fault-injecting test store.

Every stored command record is read back through one validator
(`api::validate_record`). It requires every field the record and its receipt
are written with, each of its written type, and undo data that matches the
receipt. A replay succeeds only when the record passes; any other record is
an unknown outcome. Reading a corrupt record by ID or in the receipts list
answers `internal` (500), not `not_found` and not a partial receipt. An undo
whose original record is corrupt, or whose undo data names events this
command did not journal, is refused with `internal` and writes nothing.

The ledger follows `stock/replay.ts`: balances are the replay of journaled
events over the imported baseline, an undo voids its command's events and
replays, and every receipt counts what the replay moved.

The 2026-10-05 contract (changes apply at once with undo on every surface):
the owner's app (`owner_tap`, channel `ios`) and a connected assistant
(`owner_statement`, channel `mcp`) run the same commands and get the same
receipt and undo. An assistant cannot claim an owner tap, and the command's
channel must match the connection. No command ported so far is one
of the cases that wait for the owner (choosing from the board and swapping a
slot are routine, undoable changes on both surfaces) (erasure, authorization towards another
party, model or connection reach, the profile document, read-only
connections, turns without owner words). A connected assistant, on the MCP
endpoint or with the assistant token, is refused a restriction lift
(`restriction.resolve`, `assistant.lift_restriction`) before anything is
looked up, and the undo of a command whose type is `restriction.add`
(`forbiddenForConnectedAssistant` in the assistant package). Restrictions
themselves are not ported yet, so the second rule has no record to apply to
until they are; it is covered by a unit test of the rule.

## The board

`board.publish` publishes the day's outfit options for a local date (today up
to 14 days ahead) in the home scope, or in a trip's scope (see "Trip-day
boards"), as `packages/daily` boards do: each
option names its slots and garments, and every garment is validated against
the replayed ledger and the owner's rules (role, layering-only pieces,
availability, conditional pieces, the sneakers-only healing restriction from
the seed's rule parameters, accessories, required roles and duplicates;
unverified thermal and jacket bands are reported, and a jacket outside the
verified band is accepted only when named explicitly). At most 8 options and
3 reserves; a board keeps its last 16 revisions. `board.select` records the
chosen option without advancing the revision; `board.swap_slot` replaces one
slot's garment (the owner's choice, or a replacement found by colour family
and then fabric class) and writes a new revision with the changes described
in factual copy. `board.select` and `board.swap_slot` have an undo through
`command.undo`; as in the TypeScript service, a publication has none (publish
a new revision instead; earlier revisions stay in history). Choices unwind
only newest first, and an undone choice is itself a change of choice, so an
earlier one is chosen again rather than undone (also as in TypeScript).
`expectedVersions` accepts `board:<boardId>`. A publisher that read the day
sends `expectedBoardRevision` (0 for a day with no board): a board published
or changed meanwhile refuses the publication with `precondition_failed`
(`boardChanged: true`), and nothing is written. The day's board index lives
in the guarded ledger record, so two publishers racing for an empty day
cannot both succeed: the second one's commit fails its guard, re-plans, and
sees the first board.

Automatic repair is not ported, so a board is checked again against the
current stock whenever it is read: an option a later report made unwearable
(its shirt went in the wash, say) carries a `qualification` saying why and the
board reads as degraded, and `board.select` refuses it.

Recorded wear counts against the seven-day repeat horizon
(`variety.repeat_horizon`: shirts and trousers): a piece with a counted wear
in the seven days before the board's date is refused with
`repeat_within_horizon` ("… was worn on 2026-09-10, inside the 7-day repeat
horizon"), the rule named, whether the board is being published, read, chosen
from or swapped. Undoing the wear lifts it at once. No repeat exception
exists yet: the owner's named-piece override and `allowRepeat` belong to day
briefs, which are not ported (test
`trousers_worn_inside_the_seven_day_horizon_are_not_offered_and_a_choice_of_them_is_refused`).

Not ported yet: weather and Calendar (the board's `timezone` is the owner's
default, Europe/London), freshness (`unavailable`), and evening boards. A
board's validity is therefore reported as limited or degraded, never as fully
checked.

## Recommendations

`garderobe_recommend` answers validated outfit options for a named day
(`count` 1 to 8, default the profile's 5), as `recommend` in preview mode in
`packages/daily/src/service.ts`: the deterministic composer of
`packages/daily/src/compose.ts` ranks shirt and trouser pairs (rotation,
colour relation, a seeded tie-break), builds each outfit around a pair (a
jacket only over a lightweight oxford while the 14-16 °C band cannot be ruled
out, sneakers while the restriction holds, the sock that echoes a colour from
higher up, the belt, a tie on a shirt), never offers the same shirt twice, and
keeps only outfits the board's validator accepts. Nothing is published or
logged. The options are numbered `preview-1`, `preview-2`, …; the owner can
publish them as they stand.

A day of a planned trip that has something packed (`packedTripOn`: the trip
with the latest departure covering the day, then the lowest trip ID) is
composed from what is packed for that trip, never from home stock, and
`POST /v1/recommendations` in board mode publishes it as the trip's day board
(see "Trip-day boards"). A planned trip with nothing packed is answered from
home, as in TypeScript.

A request is a durable run, as `runRecommendation` in
`apps/worker/src/routes/daily.ts`. The run is keyed by the connection and its
`clientRequestId`, and its ID is derived from both (`run_<24 hex>`, stored
under `u/<runId>`). Repeating the request answers from the run, naming its
`runId`. A different request under the same ID is refused with
`idempotency_key_reuse`.

What differs from the TypeScript build, and why:

- no composition model is connected, so every option comes from the
  deterministic composer (the specification's tested fallback). A brief's
  words are not read, and the note says so;
- no forecast or Calendar: every piece has the same season fit, there is no
  scarf day, a jacket goes only over a lightweight oxford, and no option suits
  an event;
- the probabilistic availability estimator is not ported: a piece with a clean
  unit at home counts as available, and one without is not offered;
- comfort feedback, the coming week's selections and recently shown
  combinations do not rank pieces;
- the seeded tie-break names this app's single owner (`owner`) where
  TypeScript uses the user ID, so the same day ranks differently there
  (`seeded_unit` itself is the TypeScript hash, pinned by a test).

## Studio

As `packages/media/src/studio/reads.ts` does it, without media. Studio never
decides eligibility or rules itself: validation is the daily validator (the
board's `validateCandidate`).

- **Selectors** (`GET /v1/studio`). Ten roles, top, bottom, footwear and
  outer first and always shown. For today a selector holds only owned
  garments that are `available` or `estimated` and not excluded; Explore also
  holds the others, marked `seasonal_or_stored` (or `incoming`) with the
  reasons they cannot be worn. Availability follows the estimator's reasons on
  this port's stock: `restricted` (the sneakers-only restriction),
  `planning_excluded`, `no_units_at_home` with `observed_dirty`,
  `in_service_batch` or `laundry_exception`; `conditional` for occasional and
  indoor-only pieces; and `estimated` with `import_cleanliness_unverified` for
  a laundered garment no wash or return has been reported for since the
  import, as the estimator's import prior makes it. Garments are listed by
  category, name and ID, as `listInventory` lists them; `image` is null.
- **Opening outfit.** Studio's first suggestion for the day with nothing
  locked (see "Suggestions" below), so its top, bottom, footwear and socks,
  offered only when it validates for today; otherwise none.
- **Validation** (`POST /v1/studio/validate`). Every slot holds exactly one
  garment or one shopping candidate; a garment that is not the owner's is
  `not_found`, naming each one. The garments are checked by the daily
  validator for the day (repeat horizon included); in Explore its "not
  wearable today" findings (`EXPLORE_ADVISORY`: unavailable, restricted,
  repeat, temperature and the like) are advisories, while "not an outfit"
  findings such as missing socks stay blocking. Studio adds its own rule: a
  shopping candidate is not owned, so it blocks for today and is advisory in
  Explore; an outfit with no owned garment is `incomplete_outfit` for today.
  `validator` is `daily-service`, `wearableOn` the day for today and null in
  Explore. Without a forecast, temperature rules are reported as not checked.
- **Suggestions** (`POST /v1/studio/suggest`), as `suggestStudioOutfits` over
  the daily service's `suggestOutfits`. The request is the same as for
  validation, with `limit` 1 to 10 (default 5). The slots marked `locked` that
  hold a garment are kept, each in its role: the deterministic composer
  (`composeBoard` with `locked`) pairs a locked top or bottom with every
  candidate, so it may appear in every suggestion, and builds the rest of
  each outfit around the locked pieces, every one of which outside top,
  bottom and outer counts towards the neutral limit first. The locked
  garments are named explicitly to the composer. A suggestion always keeps
  only the open roles (the roles of the unlocked slots, plus top, bottom and
  footwear, less the locked roles), the locked roles and socks, even when
  every role is locked; suggestions that then coincide are one. A suggestion that dropped a
  locked piece or holds another piece in a locked role is discarded, and
  each is validated as `studio/validate` validates and offered only when
  valid. In Explore, "not wearable today" findings neither keep a piece out
  of the composition nor invalidate it. As in TypeScript, Studio's own
  validation names no piece explicitly, so for today an occasional or
  indoor-only locked piece gets no suggestion. `tests/studio_suggest.rs`
  covers these.
- **Composition** (`POST /v1/studio/compose`). The deterministic manifest of
  `compose/manifest.ts` (template, frames, category scale, layering order,
  caption) and its hash, the SHA-256 of the canonical manifest JSON. The
  `ferrite dev` probe compared the manifest and hash with the TypeScript
  `buildManifest` and `manifestHash` on four outfits and found them
  identical. There is no media, so every garment is a `missing` layer ("no
  photo yet") and a shopping candidate is a `shopping_candidate` layer.

Nothing here writes: the reads leave the store as it was (`tests/studio.rs`).

## Service laundry

As `handlers/wear-care.ts` does it. `laundry.collect` is the pickup: every
unit of a service-laundered garment that is in the hamper goes into a new
batch (less `exclude`, plus `include` with its count; a hand-washed or
never-laundered piece is refused), and the receipt counts what the replay
moved. `laundry.return` brings back the named batch, or the oldest one
still out: its pieces are clean, less the ones the owner names as still
away, which stay in the batch until a later return of it. A return with no
batch on record takes the owner's word (what was awaiting the service is
clean, less the pieces named as still away, which are recorded as at the
laundry in a new `lb_` bag that a later return brings back); the same return
said again within five days of a bag's pickup or of its return changes
nothing; a return dated before its pickup is refused. A wash report
of a piece the ledger has at the laundry pulls it back from there (the owner
has it), with a repair on the receipt. A pickup or return given an earlier
time is sized from the stock as it stood then, not as it stands now; one that
would change what another bag's pickup or return moved (take a piece that bag
is recorded with) is refused, so a batch's record always matches the stock.
The same holds for a wash report given an earlier time (one at the present
time always stands). An undo compares, for every other event, what it moved,
which bag any unit it took back came from, and its repairs.
The boards named in `expectedVersions` are not read for an observation, so an
unrelated board can never refuse a wash report.

Undo: a pickup is withdrawn while the bag is still out (the batch stays on
record, withdrawn); once it is back, the return is undone instead, exactly or
not at all: if voiding it would change what any other report (recorded or dated
after it) moved
or repaired (a wash report, a later return), the return stays. This holds for a
return with no pickup on record too, for withdrawing a pickup (refused if
another bag's record or a later report relies on it) and for undoing a wash
report (refused once, say, a pickup has collected the piece). Returns of one bag are recorded in time
order: a return dated before the bag's last recorded return is refused (undo
that one first if its time was wrong). A return is undone only while its bag
is at the version the return left it at, so a later return of the same bag,
even one that moved nothing, keeps it in place (a return recorded before the
version was kept still reads back, but is not undone); undoing a return with no pickup
on record withdraws the bag it opened for still-away pieces, and is refused
once that bag has been reported on. A batch ID is used once for the life of
the wardrobe: only the newest 60 batches are kept, but a dropped batch's ID
stays reserved through its stock events, which are never removed; IDs the app
makes start with `lb_`, which an owner-supplied ID may not use.
Both are routine owner observations, so a connected assistant runs them
directly, and `expectedVersions` is not checked for them (they are rebased).
`laundry_batch:<id>` versions are accepted for an undo. A bag whose holdings
another record changes moves to a new version too, and is listed among that
receipt's affected records. This happens when a wear, a further unit or a wash
report (`care.mark_dirty`) takes a unit the ledger had at the laundry back to
the owner, or when the undo of one of those puts the unit back.

### The owner's own wash (`care.washed`)

As `careWashed` in `handlers/wear-care.ts`, with the `wash` rules of
`stock/replay.ts`. `items: [{garmentId, quantity?}]` and/or `allOfChannel`
(`service`, `handwash` or `none`; "Socks washed" is `handwash`): every
garment of that channel with a unit in the hamper is washed, without a count.
- **With a count:** that many hamper units come back clean. Any the hamper
  lacks come back from the laundry, from a bag not named still away first,
  with a repair on the receipt.
- **Without a count:** every hamper unit comes back clean. A unit at the
  laundry comes back only when none of the garment is clean at home. When
  nothing of a named garment was in the hamper, the units the owner reported
  still away are back too (`releaseAway`). A channel wash never speaks for
  still-away units.
- **Refusals:** a never-laundered piece is refused (`precondition_failed`).
  Unknown garments, unknown fields, an unknown channel, a count outside 1 to
  999, or neither `items` nor `allOfChannel` are refused too. None of these
  writes anything.
- **Receipt:** it lists only the garments that moved (`result: {washed,
  units}`).
- **Deviation:** a report that moved nothing is a `noop` with nothing
  written. The TypeScript service commits it and lists the garments as
  washed.
- **Routine observation:** a connected assistant runs it directly, and
  `expectedVersions` is not checked for it.
- **Undo:** exact or refused, like a wash report. If voiding the report
  would change what any other report moved or repaired, it is refused; for
  example, while a later uncounted wash of the same garment stands. A bag
  it took a unit from moves to a new version, and the undo puts the unit
  back.
- **Not ported:** units reported lost and laundry exceptions (`leftAsLost`
  and `exceptionsSettled` in TypeScript), and washing on a trip.

Not ported: lost, delayed and missed-return exceptions
(`laundry.report_exception`) and the weekly laundry reset. A unit recorded as worn on the day of a pickup or a
no-pickup return, or later, is on the owner, not in the hamper, so it is not
collected or washed (as `collectableQuantities`), and neither is a further
unit recorded for those days; with no owner timezone
ported, that day is the UTC date of the report. The ledger keeps at most 60
batches; the oldest returned or withdrawn ones make room.

## Comfort feedback

`feedback.record` keeps one unsolicited comfort observation ("too warm on the
train", "these shoes hurt after an hour"), as `commands/feedback.ts` does: the
owner's words verbatim, its kind, the garments it names (each must exist; an
unknown one refuses the whole note and nothing is written), and only the
context actually known (wearing date, activity, layer, conditions, scope;
missing context stays null). It applies at once with a receipt and an undo,
from the app or relayed by a connected assistant (2026-10-05 contract). The
receipt names the kind and the garments, never the owner's words: "Noted: NB
990v4 — grey was painful (walking to the station). Applied to that context
only". A note already recorded under the `feedbackId` the payload names is a
noop, whatever the new payload says; nothing in it is looked up. A note with
no `feedbackId` gets `cfb_<command>`, or the next free `cfb_<command>_<n>`
when a caller already named a note that, so it never overwrites one.

Undo withdraws the note. `feedback.retract` withdraws one for good (it has no
undo; the owner records the observation again instead), and a second
withdrawal is a noop. `GET /v1/feedback` lists the notes still active, newest
first, or those naming one garment (`?garmentId=`). `tests/feedback.rs` covers
the owner's and an assistant's notes, the repeat, the undo, the withdrawal,
the bounds and a tampered record.

## Trips

As `packages/daily/src/trips.ts`. `trip.create` records a trip as planned
(name, dates, destinations with their timezones and optional coordinates,
occasions, luggage and its piece limit, laundry opportunities, and where it
came from) and applies at once with a receipt and an undo, from the app or
relayed by a connected assistant: "Trip “Lisbon” recorded: 2026-10-20 to
2026-10-23, Lisbon. Nothing is packed until you say so". Undo cancels the trip.
A trip with no `tripId` gets `trp_<command>`, or the next free
`trp_<command>_<n>`; a trip ID already used is refused. `trip.update` changes
the named fields of a planned trip and `trip.cancel` cancels it; neither has an
undo (the owner edits again, or creates the trip again), as in TypeScript, and
a second cancellation is a noop. Both check `expectedVersions` `trip:<id>`.
Occasions default to register `none` and segment `day`.

`POST /v1/trips/{id}/packing-proposal` plans the trip from the stock at home
and records the plan as the trip's next proposal revision. It is only a
proposal: what is packed is what the owner's `stock.pack` observations say
(see "Packing" below), so the proposal changes no garment. The planner composes each day, and each evening with an evening
occasion, with the port's recommender under the trip's repeat exception (no
repeat horizon). It proposes the option that keeps most of what is already in
the bag, keeps the trousers (for two days), jacket, shoes and belt when the
outfit still validates with them, keeps the day's trousers and socks for its
evening, and never plans a pair of socks on more days than there are clean
pairs at home (a day it cannot cover is planned without socks, and the notes
say so). One unit of each piece worn on the departure day is not counted
against the luggage limit. Over a limit, the optional neckwear and accessories
are left out and the shortfall is stated. Days left without an outfit, or
without socks, are each stated in one note (the first eight named, then how
many more).

A request already recorded under its `clientRequestId` answers with the
proposal it recorded, without planning again, even after the stock or the
trip changed or the trip was cancelled; the same ID sent for another trip is
`idempotency_key_reuse`. A new plan is recorded with the ledger revision and
the trip version it was planned from as `expectedVersions`, so a plan read
before another request's write is never recorded: it is planned again, at
most three times, then refused as a `conflict`. `tests/trips.rs` covers the
commands, the reads, the proposal, its replay, a concurrent write during
planning, a 31-day trip with an evening every day, days without socks, an
assistant's relay and the refusals.

### Trip-day boards

As `prepareTripDayBoard` and `assembleContext` with a trip scope in
`packages/daily`. `board.publish` with `scope: "trip:<tripId>"` publishes a
day board for a trip that is still planned (otherwise `not_found`, "no active
trip '<id>'") on a day from its departure to its return (otherwise
`invalid_command`, "that date is outside the trip"). The board is validated
against what is packed for that trip alone: a piece left at home is "not
packed for this trip", a unit already worn on the trip is "already worn on
this trip" (a never-laundered piece, such as the sneakers, stays wearable),
and no repeat horizon applies, since reuse on a trip is its own exception.
The one exception to "already worn" is the reuse the packing proposal
planned (`plannedReuse` in `trip-day.ts`): the proposal read is the newest
one recorded no later than the newest packing report for the trip (compared as
instants; one recorded after packing changes nothing), and a piece it plans in
a top, bottom, outer, footwear or belt slot on several days is wearable again
from the suitcase after a wear on the trip while the days it was worn before
the board's day are fewer than the days planned, up to the units the proposal
packs, unless the owner reported it dirty after packing. Only units the trip's
wears turned from clean to worn are reused: a unit packed while awaiting care
is never made wearable this way (another deliberate difference: TypeScript's
worn balance counts it too). The count is kept in ledger order and every unit
that leaves the suitcase is assumed to be a worn one, so it can only
under-count: a unit worn, unpacked, washed, packed again and worn again counts
once. A wear counts when
its stock event names the trip. Socks are never reused this way. A clean unit
still in the suitcase counts against the proposal's units, so a worn unit is
re-offered only while clean and re-offered units together stay within them (a
deliberate difference: TypeScript adds up to the proposal's units on top of
the clean ones, which can offer more units than the proposal allows). A piece
the proposal plans for one day only is never reused (another deliberate
difference: TypeScript keeps it in the reuse map, so after its one wear it is
offered again on that same day).
The owner's other rules hold as on the home board. Choosing and swapping work
as on the home board, and a swap draws only on the suitcase. `GET
/v1/today?scope=trip:<tripId>` reads the trip's board; the home board of the
same day is a separate board and is never touched. Recommendations for a day
of a packed trip compose from the suitcase (see "Recommendations").
`tests/trip_boards.rs` covers these.

## Returns

As `packages/assistant/src/commands/returns.ts`. `return.open_case` records a
return or exchange for a garment as `considering` and applies at once with a
receipt and an undo, from the app or relayed by a connected assistant: "Return
opened for “NB 990v4 — grey”. Deadline to post: 2026-10-31 (Europe/London). It
stays in your wardrobe until it physically leaves". Nothing leaves the
wardrobe: a piece leaves only when its departure is recorded (`garment.retire`,
not ported), so `stockDeparted` is always false. A case with no `caseId` gets
`ret_<command>`, or the next free `ret_<command>_<n>`; a case ID already used
is refused. Undo cancels the case, only while it is still as it was opened;
afterwards an update corrects it.

A deadline is established only from sourced terms (`terms.sourceRef`) and the
real trigger date, as `computeDeadline`: the end of the local day `windowDays`
after the trigger date, in the case's timezone (Europe/London, with British
Summer Time, or UTC). Anything else is unresolved, with the reason, never a
guessed countdown.

`return.update_case` changes the named fields (state, terms, trigger date,
next action, label, collection preference, shipment, the retailer's receipt
date, expected refund, currency, a note) and checks `expectedVersions`
`return_case:<id>`, as the iOS client sends it. A refund received adds to the
total so far, with its source in the case's notes; a correction may be
negative, but the total never goes below zero (`precondition_failed`). A refund
in full completes a return when no state is named. Undo puts the case back as
it was before that update, only while no later update has been made.
`tests/returns.rs` covers opening with and without terms, the listing, undo of
an opening and of an update, version conflicts, refunds and corrections, an
assistant's relay and the refusals.

## Wear records

As `wear.record` in `handlers/wear-care.ts`. "I wore it yesterday" applies at
once with a receipt and an undo, from the owner's app or a connected assistant
relaying what the owner said; only the garments named are recorded, never
what a board offered or the owner chose. A garment is counted once per
wearing date: a second report of the same garment and date (another device,
the assistant, a new idempotency key) is kept with its channel and merges,
with outcome `merged`, consuming no further unit. `additionalUnits` (a second
pair of socks) is a total for the garment and day, so the same report again
uses nothing further; its garments must also be in `garmentIds`, so the day's
record accounts for every unit a report uses. A counted wear moves one clean unit to the hamper; with
none clean but one in the hamper, the wear is recorded and the unit stays
(a repair); with none at home, a unit the ledger had at the laundry is pulled
back (the owner wore it). A further unit is a different unit from the day's
wear: it takes a clean unit, else one the ledger had at the laundry, and only
with neither does it stay a repair against the hamper. A laundry bag a wear (or
its undo) takes a unit from or puts one back into moves to a new version and is
listed in the receipt, so a report checked against the old version is stale.
A never-laundered pair moves nothing. Wearing
footwear the sneakers-only restriction excludes is recorded with a repair
that says the restriction is unchanged.

The undo withdraws each report the command made. The counted wear is one record
per garment and date, kept while any report of it stands: where the undone
report was the only one standing, the counted wear and the unit it consumed go
back too (whichever report's event consumed it); otherwise only the report is
retracted.

**The further-unit undo rule.** Withdrawing a report voids exactly that
report's own further-unit increment and nothing else. No surviving event is
consolidated, re-timed or recreated. If voiding it would leave a report still
standing whose total the remaining increments no longer cover, or would change
how any other record was classified (a later wear that consumed a unit, a wash
report, a pickup), the undo is refused with `conflict` and writes nothing: undo
the later record first. Each part of the rule has its own test in
`tests/wear.rs` (the `rule_…` tests). The same `conflict` refusal applies to the
wear itself: once a pickup has collected the worn shirt, the wear stays. An undo
of a wear record is not undone (record the wear again).

A laundry pickup, and a return with no pickup on record, leave the units on the
owner out of the bag: for each garment, the most units recorded worn on any one
day from the report's date on (the wear and its further units). Wears on
successive days may be the same unit, so days are not added together.

Refused, writing nothing: a future wearing date (later than the latest date
anywhere on Earth, since no owner timezone is ported), a stated `occurredAt`
more than a day before the wearing date began, a `tripId` that is not a
string of at most 128 characters, unknown garments and malformed payloads. A
`tripId` (null or empty: none) says the wear was on that trip: the units packed
for it are used first (see "Packing"); the trip is not looked up, as in
TypeScript, so a trip with nothing of that garment packed counts the wear at
home. Without `occurredAt`, a
wear on a date that is still today somewhere on Earth is ordered now, and a
past date's wear at noon UTC of that date.
The observation records the payload's `timezone`, or `not set`.

The day's record reads back as `dayRecord` in `/v1/today` and
`garderobe_today`, and in full (counted garments, report counts, segments and
every report with its status and channel) through `GET /v1/days/{date}` (the
owner) and `garderobe_inventory` view
`history` with a `date`; `from` and `to` (at most 366 days) list the counted
wears, optionally of one garment. A day without a record is unknown, not
unworn. Not ported: `wear.amend`, wear on a trip, the laundry exceptions a wear
settles, and the board option sets a wear resolves (the board keeps none
yet). Wear reports are kept for the life of the ledger, like stock events.

## The MCP endpoint and its OAuth

`POST /mcp` is Streamable HTTP in JSON response mode and stateless: no
session ID and no server stream, so every request carries its access token
(Ferrite's api routes have no affinity, and its stream routes get no headers).
A request whose `Origin` header names another origin than
`WARDROBE_PUBLIC_ORIGIN` is refused with 403 (DNS-rebinding defence); the
route forwards `origin` for this.
It speaks MCP 2025-11-25 and 2025-06-18. 2025-03-26 is not offered because
its transport allows JSON-RPC batches, which this endpoint refuses. The
TypeScript server's native 2026-07-28 revision is not offered, because its
details were not verified for this port; a client asking for an unoffered
revision is answered with 2025-11-25.

Tools, with the TypeScript server's names, arguments and results:

- `garderobe_today`: the board for `{date}`, as `/v1/today`; without a date, the owner's day now in Europe/London.
- `garderobe_inventory`: views `items` (paged, `limit` and `nextCursor`),
  `snapshot` (complete), `receipts` and `history` (recorded wear, see "Wear
  records"), and `laundry`, `style` (optional `date`), `command_types`,
  `trips`, `returns` and `orders`, whose data is exactly what `/v1/laundry`,
  `/v1/style`, `/v1/command-types`, `/v1/trips`, `/v1/returns` and
  `/v1/orders` serve, with the TypeScript server's summaries. The response
  says whether it is the whole result (`complete`, `total`). The TypeScript
  server's other views (`item`, `availability`, `resolve`, `selection`)
  answer `invalid_command` until the data behind them is ported.
- `garderobe_recommend`: validated outfit options for `{date, count?,
  brief?, clientRequestId}` (see "Recommendations"). It is a read, so a
  read-only grant is offered it.
- `garderobe_run`: a saved run by `{runId, action?}` (see "Runs"). Offered
  to a read-only grant too, as in the TypeScript server.
- `garderobe_command`: the ported commands as the connected assistant
  (`assistant`, channel `mcp`, authorization `owner_statement`), returning
  `{receipt}`. Only a grant with `wardrobe.write` is offered it. A read-only
  grant that calls it gets HTTP 403 with the OAuth `insufficient_scope`
  challenge.

Resources, as the TypeScript server registers them (`resources/list`,
`resources/read`; `resources/templates/list` is empty): `garderobe://guide`
(the server's guide), `garderobe://style/profile` (the owner's profile
document, byte for byte as `/v1/style` serves it) and `garderobe://commands`
(the command types as JSON, as `/v1/command-types`). Any other URI is MCP's
"Resource not found" error (-32002) with the URI. The `command_types` view's
summary says that a consequential type (a restriction lift) is refused from
the connection, where the TypeScript summary says it waits for the owner's
confirmation; under the owner's 2026-10-05 contract nothing waits here.

`garderobe_ask` and `garderobe_research` are offered to every grant (scope
`wardrobe.read`, open world, as the contract's tool table says); see "The
assistant".

### The assistant

`garderobe_ask` and `garderobe_research` make one model call each through
`src/inference.rs`, the only place a model is reached, over the app's
declared egress handle `inference` (destination prefix
`https://gateway.ai.cloudflare.com/v1/`). The route is Cloudflare AI
Gateway's Anthropic endpoint, as Cloudflare documents it (Anthropic provider
and Unified Billing pages, July 2026):
`POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic/v1/messages`
with `cf-aig-authorization: Bearer <gateway token>` and
`anthropic-version: 2023-06-01`, an Anthropic Messages body, and no provider
key (Unified Billing).

Configuration is one deploy secret, `WARDROBE_AI_GATEWAY`, a JSON object:
`{"accountId": "<32 hex>", "gatewayId": "garderobe-dev", "token": "<gateway token>", "model": "claude-opus-5-5"}`.
`gatewayId` must be `garderobe-dev` or `garderobe-prod` (`default` is never
used, as in `gateway.ts`); `model` is optional and, when given, must be
`claude-opus-5-5`, the only model the project allows for this inference (the
TypeScript registry's `claude-odango-eap` is refused). Without the secret,
with a value that does not parse, or without the egress handle, both tools
answer `module_unavailable` (HTTP 501 in the error table) naming what is
missing, before anything is read, sent or saved. There is no fallback
answer, and no development value exists yet.

Bounds:
- Deadline: the whole egress exchange is wrapped in
  `ferrite_app::rt::time::timeout` at 6 s (`MODEL_DEADLINE_MS`). Upstream
  Ferrite's SDK has no per-call egress budget (`ferrite check --target
  upstream` refuses `EgressDeadline`), and its egress gateway allows 10 s,
  more than the 8 s ingress deadline; the remaining 2 s cover the store reads
  and the one write. A call cut off may still have reached the model; nothing
  is saved, and the same client ID can be sent again.
- Concurrency: one instance runs four request loops (`REQUEST_LOOPS`), each
  polling the request queue with its own store and egress clients, so a
  request waiting on the model holds up only its own loop; health, OAuth,
  reads and commands keep being answered by the others. Every write is a
  guarded commit, so concurrent loops are as safe as concurrent instances.
  Five model calls at once would still queue the fifth request behind them.
- Reply size: the egress gateway refuses a body over 1 MiB, and the adapter
  refuses a delivered body over 1 MiB again before parsing. `max_tokens` (400
  for ask, 500 for research) keeps the answer to a few kilobytes, far under
  the ingress reply cap and the 64 KiB record size.

What the assistant does here: it answers from the owner's garments, their
balances and the profile rules the importer recorded; it changes nothing and
proposes nothing (`receipts` and `proposals` are empty), so model output can
never become a write; a change is a `garderobe_command`. **Known limit, not
yet ported:** the owner decision of 2026-10-05 says a change the owner asks
for in conversation (including words an assistant relays) applies at once
through the shared domain commands with a receipt and undo. This port's
`garderobe_ask` does not do that yet. Interpreting conversation into typed
commands, with the confirmation exceptions and the adversarial tests that
must guard it, is a later milestone. Until then a connected assistant applies
the owner's changes with `garderobe_command`, which already applies at once
with a receipt and undo. No weather, Calendar,
purchase records, transcript or profile document are connected, and the
prompt says so. `pastedText` is quoted as third-party material and its
closing tag cannot be forged from inside. Research has no web search or page
reading: `url` is refused (`module_unavailable`), the model is told it has no
live prices, stock or reviews, a `history` or `purchases` answer cites the
wardrobe records it read, and a `product` or `general` answer cites nothing.
Research answers must be the agreed JSON (`verdict`, `summary`,
`comparison`); anything else is refused and not kept. A turn the model did
not finish (stop reason `max_tokens`, `pause_turn`, `tool_use`, `refusal`, or
none) is refused for ask and research alike, and nothing is kept.

Each request is a durable run (`conversation_turn` or `research`) keyed by
the connection and the client's ID. Before the model is called, the run is
claimed with a guarded write: a `running` record with a 10 s lease
(`CLAIM_MS`, longer than the 6 s call and the store work around it). A
concurrent or repeated request with the same ID therefore never calls the
model a second time: while the lease holds it is answered `state: "running"`
(`answer` or `result` null; follow it with `garderobe_run`), and once the
answer is saved it is answered from the run. The same ID for different words
is `idempotency_key_reuse`, even while running. A call that definitely ended
without an answer (an egress refusal, an error status, an unusable reply)
releases the claim and saves no answer (`garderobe_run` shows the run
`failed`, error `interrupted`), so the same ID can be sent again at once.
When the outcome is uncertain (cut off at the 6 s deadline, a lost
connection, or an answer that could not be saved) the request may still be
running at the gateway, because dropping the local future does not stop it.
The claim is then kept until its 10 s lease ends: until then the same ID is
answered `running`, and only afterwards may it claim the run and call the
model again. So a second model call for a run never starts inside the first
call's lease. This is structural; the server does not try to detect when
the remote call stops, and a remote call that outlives the lease is not
prevented from overlapping a retry. A holder that died mid-call is treated
the same way. The lease is stamped from the app's own clock (`ctx.now_ms`)
when the claim is written, and the model call starts only if its 6 s local
deadline plus a 1 s margin ends before both the lease and the request's
reply deadline (`call_fits_lease`); otherwise the claim is released without
calling the model. That check bounds only how long this server waits. (Across
several instances this assumes their clocks agree to well under a second.)
`mode: "start"` is answered like `wait`. Research comparison rows must be
flat (string, number, boolean or null values), and an ask answer longer than
8000 characters is kept cut short with a note saying so.

`tests/assistant.rs` checks all of this with a labelled test double standing
in for the egress handle and the gateway; the live gateway has not been
called.

### Runs

A run is the durable record of a long operation, kept at `u/<runId>`
(`runs.ts`, the `api` provider). The runs written are recommendation runs,
conversation turns and research runs. A recommendation run is completed
inside its request. An assistant run is `running` while its claim's lease
holds, `completed` once its answer is saved, and `failed` (error
`interrupted`) after a released or expired claim. A stored record is returned only when it is
exactly the record its writer writes (the same fields, none missing and none
extra, each of its type, its two times and the result's read time one
instant, the result checked as its writer writes it); anything else is
refused (`internal`), never returned as a run. Run IDs are `run_`
and 24 lowercase hex digits; anything else is `not_found` without a store
read. Every run is the one owner's, so any of the owner's connections may
read it (the TypeScript build scopes runs to the user, not to a connection).

- `GET /v1/runs/{id}` and `garderobe_run` action `status`: the run as the
  contract's `Run`. The connection, request ID and request hash are never
  returned.
- `POST /v1/runs/{id}/cancel` and action `cancel`: the finished run is
  answered unchanged with nothing stopped, and nothing is written. No run
  here is ever unfinished, so there is nothing to stop; stopping comes with
  the first run that can be unfinished.
- Action `resume` is refused with `precondition_failed` ("this run cannot be
  resumed; start it again"): nothing on Ferrite runs in the background, so an
  interrupted request is sent again. Action `respond` needs `inputId` and is
  refused while no run waits for the owner, which none does yet. The event
  stream (`GET /v1/runs/{id}/events`) is not ported: an SSE reply would get
  no headers on Ferrite.

The authorization server follows the TypeScript Worker's Workers OAuth
provider and consent page:

- **Discovery.** A request without a token gets a 401 whose
  `WWW-Authenticate` names the protected-resource metadata. That metadata
  names this app as the authorization server.
- **Registration.** Dynamic client registration accepts public clients only.
  Redirect URIs must be https, or http on a loopback host. At most 200
  registrations are kept; registrations over an hour old are dropped to make
  room.
- **Consent.** The authorization code flow requires PKCE S256 and checks
  `resource` (RFC 8707). On the consent page the owner signs in with the owner
  token and allows or denies "Make changes" (`wardrobe.write`). A wrong token
  grants nothing and redirects nowhere. The page cannot be framed. The form
  carries its issue time under an owner-keyed MAC and is accepted for ten
  minutes; a grant's slot is reused only once it is no longer live and every
  form that could have created it has expired, so a late redelivery of a
  consent can never create a grant again (not even after a disconnect).
- **Tokens.** Access tokens live 15 minutes. Refresh tokens rotate: the token
  just replaced stays usable for a fixed two minutes from when it was
  replaced (retries never extend it), so a client whose answer was lost can
  retry, and a retry ends no successor issued before it (at most four unused
  successors; a fifth retry is refused without ending anything). The first use of any successor ends the replaced
  token at once: the client has the new lineage. A superseded refresh
  token presented again is a replay and ends the grant with every token it
  issued (the last 32 superseded tokens are remembered). Grant records
  written before these fields existed still load. Narrowing the scope
  on refresh is permanent for the grant. A grant ends after
  90 idle days. Tokens are
  opaque, name their grant, and are stored only as SHA-256 hashes. Codes and
  tokens are minted as described under "Queue redelivery" below; only a
  request without a correlation ID (or a deployment without the owner token)
  takes fresh entropy from `Ed25519SigningKey::generate_pkcs8()`
  (`src/random.rs`), because the SDK exports no random function.
- **Replayed codes.** A code is used once. Presenting it again, with or
  without the verifier, ends the grant and every token it issued; the client
  connects again.
- **Queue redelivery.** The request queue redelivers an envelope whose reply
  or acknowledgement was lost, with the same gateway correlation ID. Codes
  and tokens are the HMAC of that ID under a key derived from the owner
  token, so a redelivered consent, code exchange or refresh recomputes what
  the first delivery recorded and answers again without a second state
  change; a spent code or replaced token in any other request is a replay.
  The repeated answer reports the access token's remaining lifetime; once
  that token has expired the redelivery is refused (still changing nothing).
  Client registration is not deduplicated: a redelivery registers a second,
  unused client, which is pruned like any other.
- **Ending a grant.** Revocation (RFC 7009) and the owner's disconnect end a
  grant on its next request. A grant whose code expired unused, or whose
  refresh token sat idle for 90 days, is shown as expired and no longer
  counts. At most 100 grants that can still produce tokens are kept.
- **Bounded storage.** Registrations (at most 200; the oldest over an hour
  old make room, a faster flood is refused with 429) live in a fixed set of
  record slots named by the first four hex digits of their IDs, and a new
  registration takes over a slot its index no longer names, because the APE
  binding has no delete. Grants have no index: the 100 slot records are the
  grant store. Every write to a slot commits guarded on one grant-store
  version record (`o/grants/epoch`) and advances it. A new grant takes the
  first slot that is empty or holds a grant that can no longer produce
  tokens; an exchange, refresh, disconnect or another delivery of the same
  consent that commits in between makes the write fail, and the next
  attempt re-reads the slots (and finds that consent's grant if it was
  created). An ID whose slot was reused is not found.

The app needs its public origin (`WARDROBE_PUBLIC_ORIGIN`) for the metadata
and challenges, because the gateway forwards no `Host` header. Without it,
these routes answer 500 and name the secret. `tests/mcp.rs` covers the flow
end to end: discovery, registration, consent, the PKCE and replay rules,
refresh rotation and scope narrowing, token expiry, the tools, the
restriction-lift refusal, the read-only step-up, disconnect and revocation.
Most of those tests run over an in-memory store with a controlled clock.
One runs through the app's real request queue to show the reply headers.

Not covered yet: a Client ID Metadata Document is not fetched (Codex is
logged in with `--oauth-client-registration dcr`, as the plugin README
already says for the local Worker), and a new consent does not supersede an
earlier grant of the same client.

### Signing in the owner's app

The iOS client signs in as `OAuthSession` does: it discovers
`<api>/.well-known/oauth-authorization-server`, sends the owner to
`/oauth/authorize` with its public client ID, its redirect URL, PKCE S256, no
scope and `resource` set to the API origin, and exchanges the code at
`/oauth/token`. In the TypeScript Worker that server is Cloudflare Access;
here it is this app's own authorization server, with the app configured as one
fixed public client by two deploy secrets, `WARDROBE_APP_CLIENT_ID` (the
build's `GARDEROBE_OAUTH_CLIENT_ID`: 1 to 128 letters, digits, `-`, `.` or
`_`, not starting with `cli_`) and `WARDROBE_APP_REDIRECT_URI` (its
`GARDEROBE_OAUTH_REDIRECT_URL`: https, or http on a loopback host). Without
both, the app's client ID is an unregistered client.

- The consent page becomes "Sign in to Garderobe": the owner signs in with the
  owner token, with no "Make changes" choice. The app's grant carries the one
  scope `wardrobe.owner`; a request for any other scope, or for the MCP
  resource, is refused, and a registered (assistant) client may not ask for
  `wardrobe.owner` or the API origin.
- The app's tokens (`wat.…`) act as the owner on `/v1`, on the `ios` channel,
  as the owner token does. They do not reach `/mcp`, an assistant's OAuth
  token does not reach `/v1`, and the app's sign-ins are not listed under
  Settings › Connected assistants and cannot be disconnected there.
- Access and refresh tokens follow every rule above (lifetimes, rotation,
  replay, redelivery). A refresh keeps `wardrobe.owner`. When the configured
  client ID changes or is removed, its sign-ins stop working on `/v1` and at
  the token endpoint.
- At most ten of the app's sign-ins hold tokens at once; the eleventh ends
  the oldest in the same commit. Sign out everywhere
  (`POST /v1/sessions/revoke`) ends all of them.

`tests/identity.rs` covers the flow end to end over the in-memory store.

The inventory is `src/seed/owner-inventory.json`, written by
`scripts/build-seed.mjs`, which runs the TypeScript importer itself on
`requirements/wardrobe_inventory_clean.csv` (127 garments, 144 units, CSV
SHA-256 `ca9a5e06…`). Nothing about the import is re-implemented here.
The same script writes `src/seed/owner-style.json`: the owner's profile
(`requirements/chris-wardrobe-profile.md`, refused unless its SHA-256 is
`e15639d8…`) verbatim, with the 28 rules, 5 body measurements and 6 size
experiences the importer records from it, each passage located by the
importer's own `locatePassage`.
Likewise the command descriptions of `GET /v1/command-types` are
`src/seed/command-types.json`, written by `scripts/build-command-types.mjs`
from the Worker's own command registry.

Authentication on `/v1/` is two bearer tokens held as deploy secrets,
`WARDROBE_OWNER_TOKEN` (the owner) and `WARDROBE_ASSISTANT_TOKEN` (a
connected assistant without OAuth, kept for tooling), and the owner's app
sign-in above. The MCP endpoint takes
only OAuth access tokens. The owner token stands in for the owner's sign-in
(the `/v1/` API and the consent page) until `packages/auth` is ported, and
is refused by name when it is not set. The routes (`/v1/`, `/auth/`, `/mcp`,
`/oauth/` and `/.well-known/`) are declared
`"public": true` in `ferrite.json`: the gateway lets the request through
with its `authorization` header forwarded, and the application itself
refuses anything without a valid token (Ferrite's managed route auth would
otherwise turn these tokens away before the app saw them). Field names in a
command must be printable ASCII and not only digits, so the request hash
sorts keys exactly as JavaScript does.

Differences from the TypeScript backend, to close in later milestones: one
owner per deployment; laundry exceptions and the weekly reset are not ported
(see "Service laundry"); wear amendments are not ported (see "Wear
records"); no effects or
outbox; `expectedVersions` is checked for every command except the owner's
observations (the wash report, the laundry pickup and return, and the wear
report), which are rebased, as in the TypeScript service. Packing and
unpacking are observations too, but a stale version is refused (`conflict`),
as TypeScript's `staleVersions: "conflict"` does.

## Known limits

Recorded rather than fixed, under the owner's P0/P1 direction. Each is either minor or outside
the lines of the milestone it was found in.

- Portable export (`src/exports.rs`):
  - The package is built inside the request that asks for it (the owner's
    records are a few hundred kilobytes; the request deadline is 8 s), so a
    job is answered `completed` or `completed_incomplete`, never `queued` or
    `running`. It is a ZIP archive written without compression: `README.md`,
    `manifest.json` (components, files, what is never exported),
    `checksums.sha256`, `records/<component>.json` (inventory as imported
    with current versions, the ledger, boards, trips with their packing
    proposals, returns, comfort notes, command receipts, the profile with its
    rules and measurements, the account summary) and `views/` (inventory and
    wear history as CSV, the profile document byte for byte, a summary).
    The format is this server's own, `garderobe-export/ferrite-1`, not the
    D1 table dump of `garderobe-export/1`, and nothing imports it.
  - Never in a package: the owner and assistant tokens, sessions, OAuth
    clients, codes, grants and token hashes (assistants are listed by name,
    scopes and dates), device tokens (devices by ID, environment and date),
    tickets, idempotency markers, run records, and each command's request
    hash and internal undo data. The export test signs the app in and
    connects an assistant, then scans the downloaded bytes for the owner,
    assistant, app-session and assistant OAuth tokens, the device token, an
    unspent ticket, and every hash, PKCE challenge and request hash the
    server's stored records hold (OAuth codes and tokens, export tickets,
    commands and runs).
  - The hourly limit is checked again against the freshly read index in
    every guarded commit, so concurrent requests cannot pass it together; a
    ticket expires no later than its package.
  - No passphrase encryption: a request with a passphrase is refused with
    501 `module_unavailable` (`details.module: "export-encryption"`), never
    answered with an unencrypted package.
  - This server stores no photographs and no conversation, so those
    components are complete with no records and say why; `includeLocation`
    is recorded on the job (the owner only). Location stripping arrives with
    the media routes.
  - Receipts are the commands the exported records name, the newest 200
    (the ledger's recent list) and the undo links between them; once the
    recent list is full the component is reported incomplete, since an
    older command that left no trace in another record cannot be found.
  - A package is at most 3 MiB (a reply carries about 4 MiB) and is stored
    in 192 KiB parts; it can be downloaded for 24 hours, and its parts are
    emptied by the next export request after that. At most 12 exports an
    hour and 20 kept. The job's `runId` names no run in `GET /v1/runs/{id}`,
    and no audit record is written (TypeScript audits `export.requested` and
    `export.ticket`).

- Settings routes (devices, connected assistants, connections):
  - No push is delivered: the APNs dispatcher and the notification effects it
    sends are not ported. The device token is kept in the app's private
    storage as received (lower-cased hexadecimal), not sealed with a
    credential key as TypeScript seals it; it is never returned by any route.
    A device ID is limited to letters, digits, `-`, `.`, `_` and `~` (the
    contract allows any 8 to 128 characters; the app sends `device-<uuid>`),
    and at most 20 devices are kept (TypeScript sets no bound).
  - A connected assistant's grant whose code expired unused, or whose refresh
    token has been idle for 90 days, is listed as `revoked` with a null
    `revokedAt`: the contract has no expired state. `clientUri` and
    `clientDomain` are always null (clients register dynamically only), and
    `lastUsedAt` is the refresh token's last use. Disconnecting writes no audit
    record (TypeScript audits `assistant.disconnect`).
  - Outbound connections (Google Workspace, MCP tool services) are not ported,
    so connection capabilities, Calendar and Gmail order import have nothing
    to act on.

Milestone C, the Wardrobe tab in the contract shape (`GET /v1/wardrobe` as
`InventoryPage`, `GET /v1/items/{id}` as `ItemResponse`), is parked unlanded.
Its open findings:

- `availability` would be `null`, with availability filters refused, instead
  of the probabilistic availability estimate.
- The batch's initial ledger read aborts before the existing-receipt
  recovery path, so a retried batch whose first read fails is not recovered
  from its receipts.

What was tried: three exact-patch review rounds fixed cursor overflow, a
cursor sent without a limit, and decomposed accents in search; later reviews
raised the two findings above. The last prepared commit, 81ce6e91, is kept
unlanded, and `/v1/wardrobe` keeps the subset shape above.

Milestone 2, phrase resolution, the bulk-edit selection preview and the
probabilistic availability estimator (`GET /v1/wardrobe/resolve`,
`POST /v1/wardrobe/selection`, `GET /v1/availability` and the matching
`garderobe_inventory` views), is parked unlanded and removed from the tree.
Its open finding: the estimator counts outfits offered in the last 14 days
against a garment even when they predate a wash or clean return observed for
that garment. A single-unit piece offered yesterday and washed today can still
read as only 15% available. The TypeScript estimator behaves the same way:
its exposure cutoff comes only from the weekly service-laundry baseline or the
horizon (`packages/domain/src/queries.ts`, `cutoffDateByChannel`), never from
a per-garment wash.

What was tried: four exact-patch review rounds. They fixed option sets that
read a wear's current retraction state instead of its state when the board was
written, the missing aliases of merged "(pair 2)" sheet rows, incomplete
Unicode folding (now a generated NFKD table checked against `normalizePhrase`),
and README selector fields that do not exist. The fourth review raised the
finding above. The last prepared commit, 4e55facc, is kept unlanded, and its
full patch is in the project library as "Parked Ferrite milestone 2 patch:
resolve, selection, availability".

Found by the automatic reviews of the whole port, or recorded with a later
milestone, and outside the lines of the milestone in hand:

- **Board.**
  - `board.select` undo cannot unwind successive choices (undoing B, then A,
    conflicts on the selection version).
  - A swap revalidates only the changed option. The other options and the
    reserves are copied into the new revision as they were.
  - An automatic swap (no `garmentId`) of a `one_piece` slot does not avoid
    shirts and one-pieces already offered in other options, as publication
    does for `top` and `one_piece`.
  - A publication has no undo (as in the TypeScript service, which the
    reviewer counts as a gap under the 2026-10-05 contract).
  - Automatic future-outfit repair is not ported: a later change to the
    wardrobe does not revise published boards. Each read checks the board's
    options against the current stock and qualifies any that no longer hold.
- **Laundry.**
  - A return with no pickup that cleans everything leaves no return record
    to detect a repeat.
  - Undoing a return raises the bag's version, so after a later return is
    undone an earlier one can no longer be undone.
  - Missed-cycle returns, lost or delayed exceptions and the weekly reset are
    not ported.
  - A back-dated laundry report can change another bag's holdings without
    raising that bag's version.
  - A pickup's explicit `include` quantities are not held to the rule that a
    unit recorded worn on the pickup day stays with the owner.
- **Wear.**
  - A wear report does not settle laundry exceptions or resolve the day's
    board exposure sets (neither is ported).
  - Without an owner timezone, a wear date is checked against the earliest
    and latest timezones on Earth and ordered at noon UTC, not at the owner's
    civil day. (Today, the weather and `garderobe_today` now default to the
    owner's day in Europe/London; wear dates, board publication and
    recommendations do not use it yet, so `POST /v1/recommendations` still
    needs a date.)
- **Restrictions.** Only the import's restrictions exist, and no restriction
  command is ported, so the owner cannot yet end the healing restriction
  with a receipt (a connected assistant never can).
- **OAuth.**
  - Issuing a ninth access token within 15 minutes evicts the oldest one
    while it is still live.
  - Loopback redirect URIs must match the registered port exactly. RFC 8252
    allows any port.
- **Assistant.**
  - `garderobe_ask` and `garderobe_research` resolve the inference
    configuration before reading a saved run. A saved answer is therefore
    unreachable while the gateway secret is unset.
  - Applying owner changes from conversation (`garderobe_ask`) stays parked
    until the owner answers the assistant decision.
- **Recommendations route and offline replay.**
  - The publication and swap keys carry the caller
    (`board-compose:{caller}:{clientRequestId}`,
    `board-swap:{caller}:{clientRequestId}`), unlike the TypeScript daily
    service's `board-swap:{clientRequestId}`, so a key read back from the
    receipts names the caller as well.
  - If the final ledger read of `POST /v1/commands/batch` fails after its
    commands ran, `wardrobeRevision` is the highest revision the request saw
    (a lower bound of the current one), not a fresh read.
- **Daily reads.**
  - The owner's timezone is fixed at the default setting, Europe/London, with
    the British Summer Time rule written into the port (no timezone
    database); another timezone needs the settings command.
  - The weather snapshot is never a forecast (no home city, no provider
    egress) and is not recorded, so its `snapshotId` names nothing kept.
  - Pause is not ported, so Today is never `paused` or `preparing`; an
    evening scope is refused.
- **Identity and sign-in.**
  - There is no identity provider, so claiming, linking identities, recovery
    kits and recovery, and account deletion answer 501.
  - The recovery status (`GET /v1/recovery`) always reports no pending
    effects, no runs waiting for input and no connection issues: effects,
    owner-added connections and run input are not ported, so there is
    nothing to count.
  - Sign out everywhere does not end the owner token itself, which stands in
    for the owner's sign-in; rotate it with `ferrite secrets set
    WARDROBE_OWNER_TOKEN` and a deploy. Its `receiptId` names no stored
    record (the account audit is not ported).
  - The app's sign-ins share the 100 grant slots with connected assistants
    (at most ten of them at once).
  - The iOS build's local-development custom-scheme callback is refused as a
    redirect URI; the app is configured with its HTTPS universal-link
    callback, as a release build is.
- **Studio.**
  - Availability uses this port's binary stock and the import prior only: no
    unreported wear is inferred from board exposure sets (never
    `estimated_possibly_worn`), and there are no storage, tailor or trip
    buckets.
  - There is no media: every garment is a text tile, previews
    (`POST /v1/studio/previews`) are not ported and no composition is kept,
    so a composition read by its hash is always `not_found`.
  - The Studio commands (saving a combination, planning a day) are not
    ported, so the saved combinations and day plans are always empty.
    Suggestions are composed without a forecast (the TypeScript lane fetches
    one for the day) and never for a trip's suitcase (`tripId`, which the
    Studio route does not send either).
  - Suggestions differ from TypeScript in two deliberate ways. TypeScript
    keeps the whole composed outfit when no role is open (every role
    locked), so an unlocked outer, belt or neckwear the owner did not ask
    for stays and otherwise identical suggestions stay distinct; this port
    always trims. TypeScript reserves the neutral allowance only for locked
    footwear, belt, socks and mid layer; this port reserves it for every
    locked piece outside top, bottom and outer, so a locked tie or
    accessory counts too.
  - The opening outfit comes from this port's recommender, not the
    TypeScript composer.
  - Two slots in the same role are ordered as TypeScript's `localeCompare`
    orders them for IDs of printable ASCII (the root collation's primary
    order, then lower case before upper; it agreed with ICU 78.2 on 200,000
    random pairs, and the `ferrite dev` probe compared manifests with mixed-case
    and punctuated candidate IDs against the TypeScript composer). Ferrite apps
    have no collation tables, so in a shopping-candidate ID any other character
    sorts by code point after every printable-ASCII character (`localeCompare`
    would place, say, `é` beside `e`). The order is still total, so the order
    of slots with distinct same-role IDs never changes the result (two
    same-role candidates sharing one ID compare equal and keep the request's
    order, as JavaScript's stable sort keeps them), but such an ID can be laid
    out and hashed differently from the TypeScript composer.
  - A request carries at most 24 slots (the contract sets no maximum): the
    validator compares slots pairwise, and the bound keeps one request's work
    small. Ten roles with one garment each fit well inside it.
- **Recommender.**
  - Availability is binary (clean at home).
  - No weather, Calendar or brief is read.
  - The neckwear flourish is not counted in the neutral limit, so a tie can
    sink an otherwise valid candidate.
- **Comfort feedback.**
  - A painful note does not yet repair future outfits or steer the
    recommender (repair.ts is not ported), and notes are not indexed for
    search.
  - At most 100 notes are active at once (a further note is refused until
    one is withdrawn), a note names at most 50 garments, its `conditions` are
    at most 4096 bytes of JSON and a withdrawal's `reason` at most 2000
    characters; the contract sets none of these bounds. The ledger indexes the
    active notes, and a note is its own record, which keeps both within the
    store's record size.
  - A withdrawn note's record stays, marked `retracted`; forgetting
    (`conversation.forget_source`) is not ported.
- **Trips.**
  - Not ported on trip-day boards: evening trip boards, the destination's
    weather and the trip's occasions, the destination's timezone (a trip
    board's `timezone`, and Today's default day, are the owner's
    Europe/London), and a `tripId` on Studio and `studio/validate`.
  - A wash on the trip has nothing to port: TypeScript's replay reads a
    `tripId` on a wash event (`replay.ts`), but no command records one
    (`care.washed` takes only `items` and `allOfChannel`, and neither wash
    emitter sets a trip), so in both a piece worn on the trip stays worn in the
    suitcase until it is unpacked or the proposal's planned reuse allows it.
  - A packing or wear `tripId` is bounded at 128 characters; TypeScript sets no
    bound. A pack that names more units than exist anywhere packs what there
    is and says nothing of the rest, as TypeScript's replay does.
  - Two deliberate differences from TypeScript (review of milestone 3a): a
    unit packed for one trip after it was worn on another travels on as worn
    (TypeScript's replay adds it to the new suitcase as clean), and an
    unpacking that names garments with nothing (more) in the suitcase, as it
    stands at the unpacking's own time, leaves them out and names them in the
    receipt, so one that would bring nothing home is a `noop` with no stock
    event (TypeScript journals an unpack event for each named garment and
    commits). A wear on the trip of a piece in the suitcase records that it
    relied on the suitcase even when no count changes (a never-laundered
    piece, or one already worn there), so the packing it relied on is not
    undone under it. Tests: `tests/packing.rs`
    `a_unit_worn_on_one_trip_and_packed_for_another_travels_on_as_worn`,
    `an_unpacking_that_names_what_is_not_in_the_suitcase_moves_only_what_is`,
    `an_unpacking_dated_before_the_packing_finds_nothing_in_the_suitcase` and
    `a_never_laundered_piece_worn_on_the_trip_keeps_its_packing_from_being_undone`.
  - Packing takes a unit back from the laundry from an open batch before a
    held one (`pull_one_unheld_first`), as TypeScript's `pullOneFromElsewhere`;
    a wear with none at home still takes the oldest batch first, as before.
  - The planner is simpler than `proposePacking`: no destination forecast
    (every day says "Weather unavailable" and is proposed without one), no
    occasion register, no further reuse levels to fit a luggage limit
    (trousers on more days, a shirt worn twice), and no taste model. Its
    over-limit note is the port's own wording.
  - A destination's timezone is checked for the form of an IANA name only;
    there is no timezone database to look it up.
  - The port keeps at most 60 trips (cancelled ones included), a trip of at
    most 31 days and 48 KiB of JSON, and a proposal of at most 48 KiB; the
    contract sets none of these.
  - A recorded proposal must name garments the owner has (`not_found`
    otherwise); TypeScript does not check them.
  - Earlier proposal revisions are kept but only the latest is readable.
  - A coordinate smaller than 0.000001 in size (other than 0), or 10^21 or
    larger, is refused, since JavaScript writes those in exponent form.
- **Style.**
  - No style command is ported: saving an edited profile in My style
    (`POST /v1/style/preview-save` and `style.save_document`), amendments,
    standing directions, day briefs, and rule, measurement and size changes.
    The context is the import as it stands, so `styleRevision` stays 0 and
    there are never fact conflicts to decide.
  - Record IDs (`rul_`, `msr_`, `szx_`) are this port's own, derived from
    the importer's idempotency keys; the TypeScript service draws them at
    random. Every record's `createdAt`, the document's included, is the
    profile's date (2026-09-14T00:00:00Z), since this port has no import
    run time.
  - The MCP view `garderobe_inventory` `style` and the
    `garderobe://style/profile` resource serve this same context and
    document.
- **Temperature preview.**
  - `temperatureC` must be plain decimal text, optionally with an exponent
    (the iOS client sends `12.0`). TypeScript's `Number()` also accepts an
    empty value (as 0) and hexadecimal (`0x10` as 16), which the port
    refuses. A non-zero value smaller than 0.000001 in size (say `0.0000001`
    or `1e-7`) is refused too, since JavaScript writes it in exponent form
    and the preview's label writes the temperature as JavaScript does.
  - There is no storage bucket, so `inStorage` is always false.
  - The research temperature thresholds and the outerwear ceiling stay off,
    as the owner left them, so only garment thermal ranges and the
    profile's fabric rules exclude anything.
- **Returns.**
  - Orders are not ported (`purchase.import_order` and the order lines a
    case can name), so a case is opened for a garment only, `GET /v1/orders`
    is empty, and `return.link_exchange` (an exchange's incoming line) is not
    ported, so `exchangeIncoming` is always null.
  - A deadline is computed only in Europe/London or UTC (no timezone
    database); any other timezone is refused. The iOS client sends the
    device's timezone, so a phone set to another zone cannot open a case
    until it is in one of these.
  - Return reminders are effects, which this port does not have: a case's
    receipt lists none and none is sent.
  - Recording the physical departure (`garment.retire`) is not ported, so
    `stockDeparted` is always false.
  - The port keeps at most 100 cases (cancelled and finished ones included),
    50 notes a case and 24 KiB of JSON a case; free-text fields at most 500
    characters, the terms' text at most 2000, `windowDays` at most 3650 and a
    quantity at most 999; the contract sets none of these. A case ID may use
    only letters, digits, `-` and `_`, at most 64 (the contract allows any ID).

## Ferrite limits and what they mean for Wardrobe

From `docs/building-on-upstream-core.md` in `iGentAI/ferrite-labs`.

| Limit | Where it bites | How the port handles it |
|---|---|---|
| 8 s request deadline (api routes); a late reply is a `504` while the effect still happens | Conversation turns, recommendation runs, research and Calendar sync wait on models or outside services | Slice: a command is a few APE reads and one guarded write; receipt lists are capped at 200 reads (default 50). Later: anything that waits on a model or an outside call runs from a queue and the route answers with a run ID to poll or stream, which the TypeScript API already has as resumable runs. Idempotency keys make a request that timed out safe to send again |
| 256 KiB request body; chunked bodies refused | Offline replay `POST /v1/commands/batch` (4 MB in TypeScript), photo uploads, portable import | Slice: payload lists are capped at 200 items. Later: the app sends batches in parts under 256 KiB; photos and import packages upload in numbered parts into blob storage and are assembled server-side |
| Reply about 4 MiB (the reply envelope, not the body) | Portable export, media downloads | Later: export and media are served in parts from blob storage |
| One `set-cookie` per reply | Web sign-in that needs a session cookie and a CSRF cookie | Slice: bearer tokens, no cookies; the OAuth consent page needs none (the owner token in the form is the proof, so a cross-site form cannot forge it). Later: the `packages/auth` pattern, one cookie whose value changes phase, and the CSRF token in the body or a header |
| No `Host` header reaches the app (`host` is refused in `forward_headers`) | OAuth issuer, metadata URLs, `WWW-Authenticate` challenges | The public origin is the deploy secret `WARDROBE_PUBLIC_ORIGIN`; the OAuth and MCP routes refuse to answer without it |
| Stream routes get no headers; no session affinity | MCP Streamable HTTP's optional SSE stream and `Mcp-Session-Id` | The MCP endpoint is stateless with JSON responses: tools answer within one request, and `GET /mcp` is 405 |
| No response headers on egress, no redirects followed, 1 MiB egress body, 10 s per call | Google Calendar (ETags for versioned replacement, `Retry-After`), owner-added MCP services (`Mcp-Session-Id`), research providers | Later: Calendar versions are read from the event body (`etag` is also a body field in the Calendar API), retries use our own backoff, and only MCP services that work without a session header can be connected; that last one is a real reduction and is listed as an upstream ask. Redirect refusal and bounded responses are what the TypeScript adapters already enforce |
| No `OPTIONS`; CORS headers from the app dropped; stream routes GET-only without headers | Web client, assistant streaming | Later: the web client is served same-origin from the app; conversation streams authenticate with a short-lived ticket in the query string |
| No randomness API; clock is `ctx.now_ms()` | IDs, tokens | Command IDs derive from the idempotency key and time (SHA-256 in `src/sha256.rs`). OAuth codes and tokens are the HMAC of the request's correlation ID (so a redelivery mints the same ones); client and grant IDs, and secrets for a request without a correlation ID, come from `Ed25519SigningKey::generate_pkcs8()` entropy (`src/random.rs`), as `packages/auth` does |
| APE commits 1 to 64 keys and guards one key | The ledger | Slice: one guarded ledger record per owner, committed with the receipt and idempotency marker. Its event journal grows with use, so milestone 1 folds undo-expired events into the baseline and shards by garment |

## Milestones

Ordered so the hosted demo, the Codex plugin and the seeded simulation can
reach Ferrite as early as possible; each step stands on a finished one, is a
small change of its own, and passes `ferrite check`, `ferrite test` and
`ferrite dev` before the next starts.

1. **MCP for the Codex plugin.** (a) Done: the MCP endpoint, its OAuth, the
   inventory and command tools, and the restriction-lift refusals. (b) Done:
   the board: `board.publish` (the owner's app, until the recommender is ported),
   `board.select` with its undo, `board.swap_slot`, and `garderobe_today`. (c)
   Done: batch laundry collection and return, with pickup events and
   still-away pieces (the other exceptions come with milestone 2). (d) Done:
   wear records: `wear.record` with per-garment daily deduplication and its undo,
   the day's recorded wear in `garderobe_today` (`dayRecord`) and the
   `history` view, so a connected assistant can see that choosing an outfit
   records no wear. (e) Done:
   `garderobe_recommend`: the deterministic composer of `packages/daily`
   over the owner's real stock, in preview mode, as a durable run per request
   ID, with recorded wear held to the seven-day repeat horizon. (f) Done:
   `garderobe_run` (status of saved runs; cancel, resume and respond answer
   as the TypeScript server does for a finished run) and `GET
   /v1/days/{date}`, then `garderobe_ask` and `garderobe_research` behind an
   isolated AI Gateway adapter, which answer only when its secret is set.
   Next the Codex plugin
   (`integrations/codex`) is pointed at this app.
2. **Ledger.** The rest of the command service in `packages/domain`, one
   command at a time. Done: the owner's own wash (`care.washed`). Next:
   garments (create, correct, aliases, merge, move,
   retire), wear amendments, the
   weekly laundry reset, restrictions, owner settings, the availability
   estimator, and multi-owner storage with a compacted, sharded journal.
   Sign-in with `packages/auth`, account recovery, and portable export and
   import in parts.
3. **Queues and schedules.** Effects and outbox on Ferrite queues;
   cron work (daily sweep, backups, maintenance) as self-rescheduling delayed
   messages (`publish_at`), since Ferrite has no cron trigger; Calendar
   projection and weather through egress.
4. **Conversation actor.** The Durable Object conversation authority as APE
   state plus queue-driven turns, model calls through Ferrite's AI gateway
   egress (only the project's allowed model), streamed over SSE with a ticket.
5. **Media.** Private photos in blob storage, uploads in parts, HEIC cleaning
   and composites in Rust. Cloudflare Images, AI Search and the Cache API have
   no Ferrite equivalent; search over the wardrobe becomes an index the app
   keeps in its own store.
6. **Parity and acceptance.** The journey, adversarial and simulation suites
   pointed at this app, and the live deploy.

## Deploying

Not done. `ferrite deploy` needs a Ferrite account: a credential document
(endpoint, account ID and token) imported with
`ferrite login --credentials-file`, which only the owner can supply. Before the
first deploy, set the secrets with `ferrite secrets set <name>` (values on
stdin, never in source): `WARDROBE_OWNER_TOKEN`, `WARDROBE_ASSISTANT_TOKEN`
(the deploy tooling generates both), `WARDROBE_PUBLIC_ORIGIN` (the hosted
origin, known after the first deploy; deploy again once it is set) and, for
the assistant's tools, `WARDROBE_AI_GATEWAY` (see "The assistant"; without
it those two tools refuse by name and everything else works). For the iOS
app to sign in, also set `WARDROBE_APP_CLIENT_ID` and
`WARDROBE_APP_REDIRECT_URI` to the build's `GARDEROBE_OAUTH_CLIENT_ID` and
`GARDEROBE_OAUTH_REDIRECT_URL` (see "Signing in the owner's app").

`AGENTS.md` is the Ferrite CLI's brief for coding agents; `vendor/` is the
CLI's local SDK twin, which a deploy never submits (the platform compiles
against its own `ferrite-app`).
