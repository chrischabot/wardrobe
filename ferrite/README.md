# Wardrobe on Ferrite

The port of the Wardrobe backend (the TypeScript Cloudflare Worker in
`apps/worker` and the domain in `packages/domain`) to a Ferrite constrained
application: one Rust crate whose only dependency is `ferrite-app`. The owner
asked for Wardrobe and its Codex plugin to be hosted fully on Ferrite; this
directory is that port, built flow by flow. The TypeScript backend stays the
behaviour reference until the port reaches parity.

**Status: first slice plus the MCP endpoint (milestone 1a).** The owner's
real inventory can be read, and one undoable command runs end to end: "it is
in the wash" (`care.mark_dirty`) with its receipt, and `command.undo` to take
it back, from the owner's app or a connected assistant, through Ferrite's
request queue and APE store. A connected assistant such as the Codex plugin
reaches the same commands through the MCP endpoint (`/mcp`), signing in with
the app's own OAuth. The board (`garderobe_today`, `board.select` and its
undo) is next (milestone 1b), then laundry collection and return. Nothing has
been deployed: see "Deploying".

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
| `GET /v1/wardrobe[?category=]` | the inventory: every imported garment with its balances (clean, dirty) and version. A subset of `listInventory`: no availability estimate, aliases, colours or wear counts yet |
| `POST /v1/commands` | the command envelope of `packages/contracts` (`type`, `payload`, `idempotencyKey`, `authorization`, `source.channel`, optional `occurredAt`, `expectedVersions`) |
| `GET /v1/commands[?limit=]`, `GET /v1/commands/{id}` | receipts, newest first; an undo already used is no longer offered |
| `GET /v1/connections`, `POST /v1/connections/{grantId}/disconnect` (owner only) | Settings › Connected assistants: the OAuth grants, and disconnecting one, effective on its next request |
| `POST /mcp` (OAuth) | the MCP server of `apps/worker/src/mcp`, see below |
| `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` | the MCP authorization server, see below |

Commands: `care.mark_dirty` and `command.undo`. Each applies at once and
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
channel must match the connection. Neither command ported so far is one
of the cases that wait for the owner (erasure, authorization towards another
party, model or connection reach, the profile document, read-only
connections, turns without owner words). A connected assistant, on the MCP
endpoint or with the assistant token, is refused a restriction lift
(`restriction.resolve`, `assistant.lift_restriction`) before anything is
looked up, and the undo of a command whose type is `restriction.add`
(`forbiddenForConnectedAssistant` in the assistant package). Restrictions
themselves are not ported yet, so the second rule has no record to apply to
until they are; it is covered by a unit test of the rule.

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

- `garderobe_inventory`: views `items` (paged, `limit` and `nextCursor`),
  `snapshot` (complete) and `receipts`. The response says whether it is the
  whole result (`complete`, `total`). The TypeScript server's other views
  answer `invalid_command` until the data behind them is ported.
- `garderobe_command`: the ported commands as the connected assistant
  (`assistant`, channel `mcp`, authorization `owner_statement`), returning
  `{receipt}`. Only a grant with `wardrobe.write` is offered it. A read-only
  grant that calls it gets HTTP 403 with the OAuth `insufficient_scope`
  challenge.

`garderobe_today`, `garderobe_recommend`, `garderobe_ask`,
`garderobe_research` and `garderobe_run` are not offered yet: the board comes
with milestone 1b, the others with the daily service and the conversation
actor.

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
  grant store. A new grant takes the first slot that is empty or holds a
  grant that can no longer produce tokens, by compare-and-swap on that slot
  record's exact bytes, so an exchange, refresh or disconnect that commits
  in between makes the overwrite fail and the next attempt re-reads the
  slots. An ID whose slot was reused is not found.

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
owner per deployment; no laundry service yet (collection, return, still-away
pieces and exceptions arrive with milestone 1), so the inventory has no
"at the laundry" balance; no wear records; no weekly reset; no effects or
outbox; `expectedVersions` is checked for `command.undo` only (observations
are rebased, as in the TypeScript service).

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
   inventory and command tools, and the restriction-lift refusals. (b) The
   board: `board.publish` (the owner's app, until the recommender is ported),
   `board.select` with its undo, `board.swap_slot`, and `garderobe_today`. (c)
   Batch laundry collection and return, with pickup events, still-away pieces
   and exceptions. Then the Codex plugin (`integrations/codex`) is pointed at
   this app.
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
