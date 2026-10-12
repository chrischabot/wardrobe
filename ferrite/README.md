# Wardrobe on Ferrite

The port of the Wardrobe backend (the TypeScript Cloudflare Worker in
`apps/worker` and the domain in `packages/domain`) to a Ferrite constrained
application: one Rust crate whose only dependency is `ferrite-app`. The owner
asked for Wardrobe and its Codex plugin to be hosted fully on Ferrite; this
directory is that port, built flow by flow. The TypeScript backend stays the
behaviour reference until the port reaches parity.

**Status: first slice.** The owner's real inventory can be read, and one
undoable command runs end to end: "it is in the wash" (`care.mark_dirty`)
with its receipt, and `command.undo` to take it back, from the owner's app or
a connected assistant, through Ferrite's request queue and APE store. Laundry
collection and return are the next flow (milestone 1). Nothing has been
deployed: see "Deploying".

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

`ferrite dev` reads the two bearer tokens from `[secrets]` in
`ferrite.local.toml` (gitignored; create it from the comments in the
scaffold's copy if missing):

```toml
[secrets]
WARDROBE_OWNER_TOKEN = "local-dev-owner-token"
WARDROBE_ASSISTANT_TOKEN = "local-dev-assistant-token"
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
connections, turns without owner words), and restrictions are not ported, so
the rule that an assistant never lifts a restriction or undoes the command
that recorded one has nothing to apply to yet; it arrives with them.

The inventory is `src/seed/owner-inventory.json`, written by
`scripts/build-seed.mjs`, which runs the TypeScript importer itself on
`requirements/wardrobe_inventory_clean.csv` (127 garments, 144 units, CSV
SHA-256 `ca9a5e06…`). Nothing about the import is re-implemented here.

Authentication is two bearer tokens held as deploy secrets,
`WARDROBE_OWNER_TOKEN` (the owner) and `WARDROBE_ASSISTANT_TOKEN` (a
connected assistant). It stands in for sign-in until milestone 1 and is
refused by name when the owner token is not set. Both routes are declared
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
| One `set-cookie` per reply | Web sign-in that needs a session cookie and a CSRF cookie | Slice: bearer tokens, no cookies. Later: the `packages/auth` pattern, one cookie whose value changes phase, and the CSRF token in the body or a header |
| No response headers on egress, no redirects followed, 1 MiB egress body, 10 s per call | Google Calendar (ETags for versioned replacement, `Retry-After`), owner-added MCP services (`Mcp-Session-Id`), research providers | Later: Calendar versions are read from the event body (`etag` is also a body field in the Calendar API), retries use our own backoff, and only MCP services that work without a session header can be connected; that last one is a real reduction and is listed as an upstream ask. Redirect refusal and bounded responses are what the TypeScript adapters already enforce |
| No `OPTIONS`; CORS headers from the app dropped; stream routes GET-only without headers | Web client, assistant streaming | Later: the web client is served same-origin from the app; conversation streams authenticate with a short-lived ticket in the query string |
| No randomness API; clock is `ctx.now_ms()` | IDs, tokens | Slice: IDs derive from the idempotency key and time (SHA-256 in `src/sha256.rs`). Later: secret tokens come from `Ed25519SigningKey::generate_pkcs8()` entropy as `packages/auth` does |
| APE commits 1 to 64 keys and guards one key | The ledger | Slice: one guarded ledger record per owner, committed with the receipt and idempotency marker. Its event journal grows with use, so milestone 1 folds undo-expired events into the baseline and shards by garment |

## Milestones

Ordered so the Codex plugin can talk to Ferrite early and each step stands on
a finished one. Each passes `ferrite check`, `ferrite test` and `ferrite dev`
before the next starts.

1. **Ledger.** The rest of the command service in `packages/domain`:
   the laundry flow (collection, return, still-away pieces, exceptions),
   garments (create, correct, aliases, merge, move, retire), wear records with
   per-garment daily deduplication, washes, the weekly laundry reset, laundry
   exceptions, restrictions, owner settings, the availability estimator,
   expected versions, and multi-owner storage with a compacted, sharded
   journal. Sign-in with `packages/auth`, account recovery, and portable export
   and import in parts.
2. **MCP for the Codex plugin.** The MCP server (`apps/worker/src/mcp`) on its
   own api route, its OAuth authorization for connected assistants, and the
   tools over the same commands. The Codex plugin (`integrations/codex`) is then
   pointed at this app.
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
first deploy, set both bearer tokens with `ferrite secrets set
WARDROBE_OWNER_TOKEN` and `ferrite secrets set WARDROBE_ASSISTANT_TOKEN`
(values on stdin, never in source).

`AGENTS.md` is the Ferrite CLI's brief for coding agents; `vendor/` is the
CLI's local SDK twin, which a deploy never submits (the platform compiles
against its own `ferrite-app`).
