# Wardrobe on Ferrite

The port of the Wardrobe backend (the TypeScript Cloudflare Worker in
`apps/worker` and the domain in `packages/domain`) to a Ferrite constrained
application: one Rust crate whose only dependency is `ferrite-app`. The owner
asked for Wardrobe and its Codex plugin to be hosted fully on Ferrite; this
directory is that port, built flow by flow. The TypeScript backend stays the
behaviour reference until the port reaches parity.

**Status: the MCP endpoint, the board and service laundry (milestone 1c).** The owner's
real inventory can be read, and one undoable command runs end to end: "it is
in the wash" (`care.mark_dirty`) with its receipt, and `command.undo` to take
it back, from the owner's app or a connected assistant, through Ferrite's
request queue and APE store. A connected assistant such as the Codex plugin
reaches the same commands through the MCP endpoint (`/mcp`), signing in with
the app's own OAuth. The day's outfit board is ported (`board.publish`,
`board.select`, `board.swap_slot` with their undo, and `garderobe_today`),
and so is service laundry (`laundry.collect` and `laundry.return`, with
their undo). The daily recommender and the conversation tools are next.
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
| `GET /v1/commands[?limit=]`, `GET /v1/commands/{id}` | receipts, newest first; an undo already used is no longer offered |
| `GET /v1/connections`, `POST /v1/connections/{grantId}/disconnect` (owner only) | Settings › Connected assistants: the OAuth grants, and disconnecting one, effective on its next request |
| `POST /mcp` (OAuth) | the MCP server of `apps/worker/src/mcp`, see below |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | the MCP authorization server, see below |

Commands: `care.mark_dirty`, `board.publish`, `board.select`,
`board.swap_slot`, `laundry.collect`, `laundry.return` and `command.undo`. Each applies at once and
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

Not ported yet: the recommender itself (so the owner's app publishes the
board until it is), weather, Calendar, wear history, the owner's timezone
(`timezone` is null and the date is required), freshness (`unavailable`), and
scopes other than home. A board's validity is therefore reported as limited
or degraded, never as fully checked.

## Service laundry

As `handlers/wear-care.ts` does it. `laundry.collect` is the pickup: every
unit of a service-laundered garment that is in the hamper goes into a new
batch (less `exclude`, plus `include` with its count; a hand-washed or
never-laundered piece is refused), and the receipt counts what the replay
moved. `laundry.return` brings back the named batch, or the oldest one
still out: its pieces are clean, less the ones the owner names as still
away, which stay in the batch until a later return of it. A return with no
batch on record takes the owner's word (what was awaiting the service is
clean); the same return said again within five days of a returned pickup
changes nothing; a return dated before its pickup is refused. A wash report
of a piece the ledger has at the laundry pulls it back from there (the owner
has it), with a repair on the receipt. A pickup or return given an earlier
time is sized from the stock as it stood then, not as it stands now; one that
would change what another bag's pickup or return moved (take a piece that bag
is recorded with) is refused, so a batch's record always matches the stock.
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
that one first if its time was wrong). A batch ID is used once for the life of
the wardrobe: only the newest 60 batches are kept, but a dropped batch's ID
stays reserved through its stock events, which are never removed; IDs the app
makes start with `lb_`, which an owner-supplied ID may not use.
Both are routine owner observations, so a connected assistant runs them
directly, and `expectedVersions` is not checked for them (they are rebased).
`laundry_batch:<id>` versions are accepted for an undo.

Not ported: lost, delayed and missed-return exceptions
(`laundry.report_exception`), the weekly laundry reset, wear records (so
nothing is held back from a pickup as being worn today), and hand-wash
reports (`care.washed`). The ledger keeps at most 60 batches; the oldest
returned or withdrawn ones make room.

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
  `snapshot` (complete) and `receipts`. The response says whether it is the
  whole result (`complete`, `total`). The TypeScript server's other views
  answer `invalid_command` until the data behind them is ported.
- `garderobe_command`: the ported commands as the connected assistant
  (`assistant`, channel `mcp`, authorization `owner_statement`), returning
  `{receipt}`. Only a grant with `wardrobe.write` is offered it. A read-only
  grant that calls it gets HTTP 403 with the OAuth `insufficient_scope`
  challenge.

`garderobe_recommend`, `garderobe_ask`, `garderobe_research` and
`garderobe_run` are not offered yet: they come with the daily service and the
conversation actor.

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
  opaque, name their grant, and are stored only as SHA-256 hashes. Their
  entropy comes from `Ed25519SigningKey::generate_pkcs8()` (`src/random.rs`),
  because the SDK exports no random function.
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
(see "Service laundry"); no wear records; no effects or
outbox; `expectedVersions` is checked for every command except the owner's
observations (the wash report, the laundry pickup and the laundry return),
which are rebased, as in the TypeScript service.

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
| No randomness API; clock is `ctx.now_ms()` | IDs, tokens | Command IDs derive from the idempotency key and time (SHA-256 in `src/sha256.rs`). OAuth codes, tokens and client and grant IDs come from `Ed25519SigningKey::generate_pkcs8()` entropy (`src/random.rs`), as `packages/auth` does |
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
   still-away pieces (the other exceptions come with milestone 2). (d) Wear
   records: `wear.record` with per-garment daily deduplication and its undo,
   and the day's recorded wear in `garderobe_today` (`dayRecord`), so a
   connected assistant can see that choosing an outfit records no wear. (e)
   `garderobe_recommend`: the deterministic composer of `packages/daily`
   over the owner's real stock, publishing through `board.publish`. (f)
   `garderobe_run` (run status) and then `garderobe_ask` and
   `garderobe_research`, which wait on model and outside calls and so come
   with the queued runs of milestones 3 and 4. Then the Codex plugin
   (`integrations/codex`) is pointed at this app.
2. **Ledger.** The rest of the command service in `packages/domain`, one
   command at a time: garments (create, correct, aliases, merge, move,
   retire), wear records with per-garment daily deduplication, washes, the
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
(the deploy tooling generates both) and `WARDROBE_PUBLIC_ORIGIN` (the hosted
origin, known after the first deploy; deploy again once it is set).

`AGENTS.md` is the Ferrite CLI's brief for coding agents; `vendor/` is the
CLI's local SDK twin, which a deploy never submits (the platform compiles
against its own `ferrite-app`).
