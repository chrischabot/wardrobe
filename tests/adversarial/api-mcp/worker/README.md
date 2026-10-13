# Garderobe adversarial suite against the real Worker (`api-mcp/worker/`)

Attacks on the **real Worker**: its HTTP API, its OAuth authorization server and its MCP server, running in
workerd on local D1, KV, R2, a queue and the conversation Durable Object. Every file's world holds two owners:
the **real owner fixture** (the supplied profile `requirements/chris-wardrobe-profile.md` and the real
inventory `requirements/wardrobe_inventory_clean.csv`, imported by the product's importer) and a **labelled
synthetic second owner** who plays the attacker or the victim of a collision. Assertions read the real D1
tables, the stored receipts and the same public surfaces a client uses; nothing mocks the ledger, the API or
the MCP server.

## Running

From the repository root, after `npm install` (in the Fabric sandbox: `bash tools/sandbox-install.sh`). This
directory is a nested run of the shared runner (`../../scripts/run.mjs`, see `../../README.md`): it has its own
`vitest.config.ts` because it installs its own outbound double.

| Command | What it does |
| --- | --- |
| `npm test -w @garderobe/adversarial-tests` | The whole adversarial workspace, this suite included. Open product defects are expected failures; anything else that fails is a regression. Exit code 0 means "no regression", **not** "no defects". |
| `npm run test:strict -w @garderobe/adversarial-tests` | The acceptance view: every open defect fails as an ordinary test. Its failures in this suite are the open entries of [DEFECTS.md](DEFECTS.md) plus any ordinary failure the default run also shows (the "new failures" and "contract-driven" sections of DEFECTS.md), so read it together with the default run. |
| `npm run test:api-mcp -w @garderobe/adversarial-tests` | This area alone (this suite and any `api-mcp/*.test.ts`). |
| `npm run typecheck -w @garderobe/adversarial-tests` | Typecheck of the workspace, this suite included. |

The root `npm test` runs the default mode with every other workspace. One file, from the repository root:
`cd tests/adversarial/api-mcp/worker && npx vitest run --root "$PWD" test/05-injection.test.ts` (without `--root`, `npx` starts vitest in the
workspace directory and picks up the shared configuration instead). Another time of day:
`GARDEROBE_TEST_CLOCK=23:30 npm test -w @garderobe/adversarial-tests` (see the Worker README).

## Threat classes

| File | Threat class | What is attacked |
| --- | --- | --- |
| `test/01-isolation.test.ts` | Cross-owner isolation and forged ownership fields | Reading and changing another owner's garments, receipts, boards, runs, assistants, devices and sign-ins by identifier over the API and MCP; owner fields forged in envelopes, payloads and tool inputs; claimed channels, actors and authorization bases; colliding garment identifiers; hostile identifiers on every identifier route; conversation and recall |
| `test/02-auth.test.ts` | Authentication, OAuth, scope and grant abuse | Forged, unsigned, algorithm-confused and mis-claimed sign-in assertions; every Access-trust route without a session, with a forged one, as an unlinked identity and on the MCP hostname; an assistant's token used as a sign-in; cross-site requests and consent forgery; PKCE, redirect and code replay; scope widening; narrowed, revoked and invented grants; disabled accounts; malformed protocol requests |
| `test/03-replay-races.test.ts` | Idempotency, replay, concurrency and races on the ledger | Same-key replays with the same and different bodies, across owners and across HTTP, batch, web and MCP; parallel submissions; races on the last clean unit; stale versions; parallel undo; batches; board and proposal races |
| `test/04-time.test.ts` | Time zones, DST, late and conflicting reports | Malformed, future and ancient instants and dates; local-day attribution in four zones and on both London DST nights; late reports against later washes and collections; conflicting reports; invalid settings; past-day boards; the connected assistant's seven-day window |
| `test/05-injection.test.ts` | Prompt injection through every channel | The owner's own message with pasted, quoted, hypothetical, negated and wishful text; attachments and image metadata; mailbox content; Calendar titles and descriptions; garment names and notes; an imported sheet; search results and fetched pages; text relayed by a connected assistant. Goals: lift the sneakers-only restriction, amend the profile, create or retire garments, exfiltrate data. The model is scripted to obey the injection; the application must stop the change |
| `test/06-hostile-model.test.ts` | A hostile or malformed model at every model seam | Invented and foreign garment identifiers, unknown tools, malformed, oversized and deeply nested arguments, tool-call floods, forged authority claims, false claims of success, misdescribed requests, unreported wear and wash, restricted footwear; the board composition seam; structured output; the photograph seam; research verdicts and model-chosen addresses |
| `test/07-profile-constraints.test.ts` | Profile integrity and hard-constraint evasion | Profile saves that reword facts; hostile content and forged provenance in rules, amendments, directions, briefs, restrictions and measurements; undo of the import; the preserved original document; restricted, unavailable and repeated garments through briefs, boards, swaps, selections, Studio, trips, relabelling and shortages |
| `test/08-imports-exports.test.ts` | Hostile imports and exports | Tampered, truncated, oversized and path-escaping packages; another owner's package; planted sessions, grants, credentials, confirmed proposals, resolved restrictions and command rows; formula cells; download tickets; secrets and other owners' data in packages; backups |
| `test/09-recovery-confirmation.test.ts` | Account recovery and confirmation abuse | Stolen, spent, guessed and simultaneous recovery codes; other people's recovery transactions; moving a signed-in owner; taking an account back after a theft; simultaneous claims and links; code confusion; unlink races; signing out everywhere; account deletion confirmations that are foreign, superseded, expired, guessed, replayed, cross-site or sent by an assistant |
| `test/10-signed-media.test.ts` | Signed media URL abuse and media isolation | Tampered, expired, replayed and cross-owner signed links; originals versus derived copies; response headers; path tricks on media routes; hostile uploads (non-images, script, polyglots, oversize, replays, cross-owner completion); uploads over MCP |
| `test/11-outbound-ssrf.test.ts` | Outbound request policy (SSRF) | Loopback, private, link-local, metadata and encoded addresses, other schemes, userinfo tricks, private DNS answers, hostile redirects, oversized responses and the app's own origins through purchase links, research, page retrieval, owner-added services and the Calendar link setting; credentials sent to the wrong host |
| `test/12-secrets.test.ts` | Secrets in logs, transcripts, recall and exports | Credentials planted in messages, attachments, connection settings, research results and notes, then searched for in the transcript, recall, run events, receipts, proposals, MCP results, exports, backups, error bodies, every text column of every table, the console and the model's context |
| `test/13-invariants.test.ts` | Property-based ledger invariants | Seeded random command sequences across the real owner and two synthetic owners with identical garment identifiers: no negative stock, balances equal an independent replay of the stock events, no cross-owner reference in any table, one counted wear per garment and local day, one receipt per commit and nothing written by a refusal, undo and redo return to the same state |
| `test/14-connected-assistant.test.ts`, `test/14b-connected-assistant-limits.test.ts` | A hostile connected assistant: command classes, proposals and confirmation | Payload shapes that would change a command's class; embedded and look-alike commands; forged authority; replays; every command type over MCP; read-only connections; listing, confirming or elevating proposals by any route; modified, expired, replayed, cross-owner and stale decisions; summaries versus the executed payload; the limit on waiting requests; disconnect |

Current counts are in the suite's last recorded run (the work item's report); `npx vitest run` prints them.

## What is real and what stands in

Real: the Worker entry, router, authentication and session code, the Workers OAuth provider, the MCP server,
the command service and ledger, the daily service, the assistant runtime, the media module, export, import and
backup, the scheduled handler; local D1 with every migration, KV, R2, queue and Durable Object; the owner's
documents, imported by the product's importer.

Stand-ins exist only at external boundaries. Each is labelled where it is defined and proves nothing about the
real service:

| Boundary | Stand-in | Where |
| --- | --- | --- |
| Cloudflare Access sign-in | Assertions signed with a key generated per run and verified by the Worker's real verification code; hand-built forged assertions in `02` | `apps/worker/src/testing`, `test/02-auth.test.ts` |
| Every outbound request of the Worker | A scripted-response layer (a test plants a page, redirect, DNS answer, mailbox message or tool service at an address) and a log of every request that left the Worker; unscripted hosts answer 503 | `src/outbound.ts` |
| Open-Meteo forecast, Google Calendar events | The journey suite's doubles, reused unchanged | `tests/journeys/src/outbound.ts` |
| Google OAuth, Sheets, Gmail and Drive; a remote MCP tool service; APNs | The Worker package's own labelled fixtures | `apps/worker/src/testing/vitest-config.ts` |
| Language model (AI Gateway) | The assistant workstream's labelled FAKE MODEL, scripted as a compromised or obedient model; a hostile composition-model object for the two board-seam tests in `06` | `@garderobe/assistant/testing`, `test/06-hostile-model.test.ts` |
| Images | `testPng()` and a JPEG built with the product's codec with an Exif GPS pointer | `apps/worker/src/testing`, `src/data-helpers.ts` |
| An MCP consumer | The TypeScript SDK client over in-process `fetch`, and raw JSON-RPC requests | `apps/worker/src/testing`, `test/02-auth.test.ts` |

Consequences, stated plainly: no test here calls a real model, so nothing is shown about how a real model
responds to an injection; only what the application does when a model obeys one. Nothing ran against Cloudflare's
hosted D1, R2, KV, Durable Objects or Access, against Google or Apple, or against a private network: an outbound
request "reaching a private address" means the Worker tried to send it and the double logged it. A few seams
cannot be reached through the Worker locally and are attacked one layer down or not at all; each test file says
so where it applies (board composition by a model, mailbox extraction by a model, browser rendering, image
resizing, the AI Search index).

## Data rules

Real owner stock is used as imported. Anything the owner does not own is created through the ordinary commands
with `isSynthetic: true` and a name starting `SYNTHETIC`, in an account provisioned for that test file. Owner
statements and profile edits made by a test are what-if inputs on a throwaway copy and are labelled as such;
none is the owner's. No test prints the owner's profile, recovery codes or tokens.

Under the owner's contract of 2026-10-05 ("changes apply at once with undo on every surface", library
contract), observations, bookkeeping and directions apply at once with a receipt and undo on every surface;
only section-3 changes (irreversible erasure, authorization towards another party, what a model or an outside
connection may reach, rewriting the profile document) wait for the owner, unbounded changes (>20 pieces or
without a bounded count) are refused with `change_exceeds_bound`, and restriction lifts or undos of recorded
restrictions by an assistant are refused. Owner and scope come from the connection only, and read-only grants
change nothing.

## Product defects

A defect test states what the specification, the profile or an owner decision requires and is never weakened.
[DEFECTS.md](DEFECTS.md) lists every open one with its severity and owning workstream; `defects/` holds the
reproduction for each. `defect(...)` in `src/harness.ts` registers them: an expected failure in the default
run, an ordinary failing test in the strict run.

## Known limits

- **M14-4 and M14-7 on the shared tree.** Both are fixed in the API/MCP workstream's held batch, which is not on
  `garderobe-rebuild`. At that workstream's request their tests stay `defect(...)` so the branch stays truthful. Until
  the batch lands, a run on the shared tree reports both as unexpected passes (two failures). Flip both to
  `[fixed ...]` when the batch's commit is on the branch.
- **The outbound log is shared** by every file of a run and keeps at most 100,000 requests. A read that would need a
  dropped entry throws instead of passing on a partial log. Tests filter the log by a host or marker of their own.
  Credentials a service legitimately receives are exempted only for that service's exact endpoint (Google's client
  secret in the body of a POST to its configured token URL).
- **Rate limits are cleared between phases** of a test that deliberately makes more requests than the route allows
  (account deletion: ten an hour). The rate limit itself is not what such a test checks.
- **The every-command sweep in `14`** excuses an `invalid_command` refusal only for payloads generated from a command's
  schema. A handcrafted realistic payload refused as invalid counts as an unexpected refusal.
- **Refused items in mixed batches and parallel bursts (`13`)** are shown to write nothing by the number of new
  command rows, the ledger's consistency checks and the owners' fingerprints. They are not compared row by row
  (garment metadata, versions, aliases), except for refused duplicate creations, whose garment row and aliases are
  compared. A refused item that changed garment metadata without adding a command row could pass there. The
  all-refused batches and bursts in the same file compare the whole fingerprint and would catch it.
- **The listed zip-bomb test (`08`)** cannot prove black-box that the import route refuses the archive from its central
  directory before inflating any member: the route returns the same refusal code and message either way, so a paired 1 MB
  control shows only that the size bound itself is what refuses the 300 MB archive.
- **Parked batch 6 (`07-profile-constraints.test.ts`).** Both owners' fingerprints are compared on previews and refused
  probes, and each invalid `board.publish` candidate is also tried on its own beside a valid outfit; the remaining review
  finding is in B8 ("garments that are not wearable"), where the second outfit is chosen by option identity rather than
  by a distinct top garment ID.
- **Further review findings that fall outside the lines a review pass changed** are listed here with their reason,
  rather than reworked in that pass.

## Layout

- `src/harness.ts`: the two-owner world, state readers (`sql`, `fingerprint`, `rowCounts`), the outbound double's controls, the seeded random generator, `defect`. Readers shared with the journey suite are re-exported from here and nowhere else.
- `src/outbound.ts`: the outbound double (Node side).
- `src/*-helpers.ts`: helpers of one area.
- `test/NN-*.test.ts`: one threat class per file.
