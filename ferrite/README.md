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
in the wash" (`care.mark_dirty`) and `command.undo` to take
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
its secret is set) are ported; see "The assistant".
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

# from the repository root: the embedded inventory still matches the importer
node --experimental-strip-types ferrite/scripts/build-seed.mjs --check
```

`ferrite dev` reads its secrets from `[secrets]` in `ferrite.local.toml`
(gitignored; create it from the comments in the scaffold's copy if missing):

```toml
[secrets]
WARDROBE_OWNER_TOKEN = "local-dev-owner-token"
WARDROBE_ASSISTANT_TOKEN = "local-dev-assistant-token"
WARDROBE_PUBLIC_ORIGIN = "http://127.0.0.1:8787"
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
| `GET /v1/wardrobe[?category=]` | the inventory: every imported garment with its balances (clean, dirty, at the laundry service) and version. A subset of `listInventory`: no availability estimate, aliases, colours or wear counts yet |
| `POST /v1/commands` | the command envelope of `packages/contracts` (`type`, `payload`, `idempotencyKey`, `authorization`, `source.channel`, optional `occurredAt`, `expectedVersions`) |
| `GET /v1/today?date=YYYY-MM-DD` | Today: the board published for that date (`TodayView`), or none. `date` is required, because the port has no timezone yet |
| `GET /v1/days/{date}` (owner only) | the day's recorded wear (`DailyRecord`, as `getDailyRecord`): counted garments and every report with its status. Choosing an outfit never changes it |
| `GET /v1/commands[?limit=]`, `GET /v1/commands/{id}` | receipts, newest first; an undo already used is no longer offered |
| `GET /v1/connections`, `POST /v1/connections/{grantId}/disconnect` (owner only) | Settings › Connected assistants: the OAuth grants, and disconnecting one, effective on its next request |
| `POST /mcp` (OAuth) | the MCP server of `apps/worker/src/mcp`, see below |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | the MCP authorization server, see below |

Commands: `care.mark_dirty`, `board.publish`, `board.select`,
`board.swap_slot`, `laundry.collect`, `laundry.return`, `wear.record` and `command.undo`. Each applies at once and
answers with the receipt of `CommandReceipt` (contract 1.1.0): summary built
from the ledger, affected entity versions, repairs, result, undo
availability, wardrobe revision, actor and channel. The same idempotency key
and body returns the stored receipt (`replayed: true`); the same key with
another body is `idempotency_key_reuse`. Errors use the API's codes and HTTP
statuses. Numbers in a command must be whole numbers from 0 to 2^53 - 1
(every number this slice takes is a count or a version), which keeps the
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
to 14 days ahead) in the home scope, as `packages/daily` boards do: each
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

Not ported yet: board-mode recommendations (the composer answers in preview
mode, see "Recommendations"; a board is published through `board.publish`),
weather, Calendar, the owner's timezone
(`timezone` is null and the date is required), freshness (`unavailable`), and
scopes other than home. A board's validity is therefore reported as limited
or degraded, never as fully checked.

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

Not ported: lost, delayed and missed-return exceptions
(`laundry.report_exception`), the weekly laundry reset, and hand-wash
reports (`care.washed`). A unit recorded as worn on the day of a pickup or a
no-pickup return, or later, is on the owner, not in the hamper, so it is not
collected or washed (as `collectableQuantities`), and neither is a further
unit recorded for those days; with no owner timezone
ported, that day is the UTC date of the report. The ledger keeps at most 60
batches; the oldest returned or withdrawn ones make room.

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
more than a day before the wearing date began, `tripId` (trips are not
ported), unknown garments and malformed payloads. Without `occurredAt`, a
wear on a date that is still today somewhere on Earth is ordered now, and a
past date's wear at noon UTC of that date.
The observation records the payload's `timezone`, or `not set`.

The day's record reads back as `dayRecord` in `/v1/today` and
`garderobe_today`, and in full (counted garments, report counts, segments and
every report with its status and channel) through `GET /v1/days/{date}` (the
owner) and `garderobe_inventory` view
`history` with a `date`; `from` and `to` (at most 366 days) list the counted
wears, optionally of one garment. A day without a record is unknown, not
unworn. Not ported: `wear.amend`, trips, the laundry exceptions a wear
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

- `garderobe_today`: the board for `{date}` (required), as `/v1/today`.
- `garderobe_inventory`: views `items` (paged, `limit` and `nextCursor`),
  `snapshot` (complete), `receipts` and `history` (recorded wear, see "Wear
  records"). The response says whether it is the
  whole result (`complete`, `total`). The TypeScript server's other views
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
used, as in `gateway.ts`); `model` is optional and may be `claude-opus-5-5`
(the default) or `claude-odango-eap` (the API model ID
`packages/assistant/src/inference/registry.ts` names). Without the secret,
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
never become a write; a change is a `garderobe_command`. No weather, Calendar,
purchase records, transcript or profile document are connected, and the
prompt says so. `pastedText` is quoted as third-party material and its
closing tag cannot be forged from inside. Research has no web search or page
reading: `url` is refused (`module_unavailable`), the model is told it has no
live prices, stock or reviews, a `history` or `purchases` answer cites the
wardrobe records it read, and a `product` or `general` answer cites nothing.
Research answers must be the agreed JSON (`verdict`, `summary`,
`comparison`); anything else, or an answer cut short, is refused and not
kept. An ask answer cut short is kept with a note saying so.

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
8000 characters is kept cut short with the same note as one the model cut
short.

`tests/assistant.rs` checks all of this with a labelled test double standing
in for the egress handle and the gateway; the live gateway has not been
called.

### Runs

A run is the durable record of a long operation, kept at `u/<runId>`
(`runs.ts`, the `api` provider). The runs written are recommendation runs,
conversation turns and research runs, and they finish inside their request,
so every run is completed. A stored record is returned only when it is
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

The inventory is `src/seed/owner-inventory.json`, written by
`scripts/build-seed.mjs`, which runs the TypeScript importer itself on
`requirements/wardrobe_inventory_clean.csv` (127 garments, 144 units, CSV
SHA-256 `ca9a5e06…`). Nothing about the import is re-implemented here.

Authentication on `/v1/` is two bearer tokens held as deploy secrets,
`WARDROBE_OWNER_TOKEN` (the owner) and `WARDROBE_ASSISTANT_TOKEN` (a
connected assistant without OAuth, kept for tooling). The MCP endpoint takes
only OAuth access tokens. The owner token stands in for the owner's sign-in
(the `/v1/` API and the consent page) until `packages/auth` is ported, and
is refused by name when it is not set. The routes are declared
`"public": true` in `ferrite.json`: the gateway lets the request through
with its `authorization` header forwarded, and the application itself
refuses anything without a valid token (Ferrite's managed route auth would
otherwise turn these tokens away before the app saw them). Field names in a
command must be printable ASCII and not only digits, so the request hash
sorts keys exactly as JavaScript does.

Differences from the TypeScript backend, to close in later milestones: one
owner per deployment; laundry exceptions and the weekly reset are not ported
(see "Service laundry"); wear amendments and trips are not ported (see "Wear
records"); no effects or
outbox; `expectedVersions` is checked for every command except the owner's
observations (the wash report, the laundry pickup and return, and the wear
report), which are rebased, as in the TypeScript service.

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
   command at a time: garments (create, correct, aliases, merge, move,
   retire), wear amendments, washes, the
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
it those two tools refuse by name and everything else works).

`AGENTS.md` is the Ferrite CLI's brief for coding agents; `vendor/` is the
CLI's local SDK twin, which a deploy never submits (the platform compiles
against its own `ferrite-app`).
