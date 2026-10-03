# Garderobe Worker: HTTP API, MCP server, identity, connections, export

This package is the one Worker that serves the iOS app, the private web board and consumer assistants. It contains no wardrobe logic: every route and tool calls the shared command service and the daily, assistant and visual-wardrobe packages through `src/lanes/`. The published contract is `packages/contracts/src/ext/api.ts` (`API_ROUTES`, request and response schemas, MCP tool contracts); `test/routes.test.ts` fails if the mounted routes and that manifest differ.

## Two trust domains

| Hostname | Authentication | What it serves |
| --- | --- | --- |
| App/API (`APP_ORIGIN`) | Cloudflare Access assertion (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie), verified by the Worker (signature, issuer, audience, expiry) and mapped by issuer and subject to an internal user | `/v1/*`, `/auth/*`, `/board`, the MCP consent page `/oauth/authorize`, and the provider callback `/connections/callback` (authenticated by its own one-time state, not by Access) |
| MCP (`MCP_ORIGIN`) | Garderobe grant issued by this Worker's OAuth authorization server (`@cloudflare/workers-oauth-provider`, KV `OAUTH_KV`), re-checked against D1 on every request | `/mcp`, `/.well-known/oauth-*`, `/oauth/token` (also revocation), `/oauth/register` |

Access-trust routes are refused on any other hostname. An Access assertion is not an MCP credential, and an MCP token is not accepted by the API. Email is never used to find or link an account.

## Routes (specification section 13 and 15)

- **Today and daily service**: `GET /v1/today`, `POST /v1/recommendations` (answers within the call, or with `state: "running"` and a run to follow when composing takes longer than the inline budget), `POST /v1/boards/{id}/swap`, `GET /v1/days/{date}`, `GET /v1/weather`, `GET /v1/service` (pause state), `GET /v1/trips`, `GET /v1/trips/{id}`, `POST /v1/trips/{id}/packing-proposal`, `GET /board`, `GET /board/{date}`. After the owner's `service.resume` (sent from the app, confirmed from a request, or made in conversation) the next useful board is prepared when that day has none: the day of the resume when it was made before midday in the owner's timezone, otherwise the day after (fixed by the moment of the resume, `resumeTargetDay`), after the weekly cleanliness baselines that elapsed during the pause (`followUpResumes` in `src/lanes/daily.ts`, run after the command and again by the scheduled sweep, for each owner's latest resume of the last three hours, until that day has a board; the day is claimed once per resume in `resume_followups`, migration 0305, so overlapping or later runs never prepare another day). A board that already exists for that day is kept. The Calendar event links to `APP_ORIGIN/board/<date>` unless the owner set another address.
- **Wardrobe**: `GET /v1/wardrobe` (explicit total, cursor, `complete`), `GET /v1/wardrobe/resolve`, `POST /v1/wardrobe/selection` (which garments a bulk correction would cover), `GET /v1/wardrobe/temperature-preview`, `GET /v1/availability`, `GET /v1/items/{id}`, `GET /v1/items/{id}/image`, `GET /v1/laundry`, `GET /v1/style` (`?date=` for that day's briefs with their IDs), `POST /v1/style/preview-save` (what a profile save would do to structured facts), `GET /v1/style/conflicts`, `GET /v1/settings`.
- **Studio**: `GET /v1/studio`, `POST /v1/studio/validate`, `POST /v1/studio/suggest`, `POST /v1/studio/compose`, `POST /v1/studio/previews`, `GET /v1/studio/compositions/{id}`, `GET /v1/studio/compositions/{id}/preview` (PNG only). Validation is always the daily service's validator with the owner's rules.
- **Commands**: `POST /v1/commands` (idempotency key, expected versions, verified receipt), `POST /v1/commands/batch` (offline replay), `GET /v1/commands`, `GET /v1/commands/{id}`, `GET /v1/command-types`. Laundry, wears, trips, returns, feedback, pause and resume are all commands on this route.
- **Conversation and runs**: `POST /v1/conversation/turns`, `GET /v1/conversation/messages`, `POST /v1/recall/search`, `POST /v1/research`, `GET /v1/orders`, `GET /v1/returns`, `GET /v1/projects`, `GET /v1/feedback`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events` (server-sent events, `Last-Event-ID` or `after`), `POST /v1/runs/{id}/cancel`, `POST /v1/runs/{id}/resume`, `POST /v1/runs/{id}/input`.
- **Proposals**: `GET /v1/proposals` (`?state=pending|all`), `POST /v1/proposals/{id}/decision` (`{ decision: "confirm" | "reject" }`). A change that waits for the owner: one the assistant was asked for but may not make itself (a read-only connection, or a change relayed by a connected assistant), or a sensitive typed command a connected assistant sent (`turnId` is then empty). `summary` is written by the service from the command, `payload` is exactly what would run. Confirming runs the proposed command once, as the owner's tap, with the versions the request was made against, and returns its receipt; a refused command (for example one that has gone stale, 409) leaves the proposal pending; a changed request is a different proposal; a proposal older than 14 days can only be rejected. These are app routes: a connected assistant cannot list or decide proposals and there is no MCP tool for them.
- **Capture and media**: `POST /v1/uploads`, `PUT /v1/uploads/{id}/content`, `POST /v1/uploads/{id}/complete`, `GET /v1/uploads/{id}`, `GET /v1/media/renditions/{id}`, `GET /v1/media/assets/{id}`, `POST /v1/media/renditions/{id}/sign` (a short-lived URL for one of the owner's own renditions), `GET /v1/media/signed/{token}` (authenticated by that token alone; every failure is the same 404), `GET /v1/media/photos-needed`, `GET /v1/media/review`. Every image response carries `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`.
- **Notifications**: `GET /v1/devices`, `POST /v1/devices`, `POST /v1/devices/{id}/remove` (the device token is stored encrypted and never returned).
- **Connections**: `GET /v1/connections`, `POST /v1/connections`, `POST /v1/connections/{id}/reconnect`, `POST /v1/connections/{id}/capabilities`, `POST /v1/connections/{id}/disconnect`, `GET /v1/connections/{id}/calendars`, `POST /v1/connections/{id}/outfit-calendar`, `GET /connections/callback`.
- **Identity and recovery**: `GET /v1/me`, `GET /v1/meta`, `POST /auth/claim`, `POST /v1/identities/link`, `POST /auth/link/complete`, `POST /v1/identities/unlink`, `POST /v1/recovery-kit`, `POST /auth/recovery/start`, `POST /auth/recovery/complete`, `POST /v1/sessions/revoke`, `GET /v1/recovery` (its count of runs waiting for the owner's answer is taken from the assistant's own record of its turns, not from the run registry's stored copy, so an answered, finished or cancelled question is not counted, a question nobody has read yet is, and no run is left out), `POST /v1/account/delete`, `GET /v1/assistants`, `POST /v1/assistants/{id}/disconnect`.
- **Export and import**: `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/{id}`, `POST /v1/exports/{id}/ticket`, `GET /v1/exports/{id}/download`, `POST /v1/imports`, `GET /v1/imports/{id}`.
- **Backups and restore**: `GET /v1/backups`, `POST /v1/backups`, `POST /v1/backups/{id}/ticket`, `GET /v1/backups/tombstones`, `POST /v1/restore/verify`.

Errors are `{ error: { code, message, details } }` with the codes in `ApiErrorCode`. A module whose bindings are absent answers `module_unavailable`; there are no placeholder routes.

## MCP server

Protocol `2026-07-28` (stateless, `@modelcontextprotocol/server` 2.0.0), with a separately tested `2025-11-25` compatibility path that is recorded per connection. Scopes: `wardrobe.read`, `wardrobe.write`. The owner and scopes always come from the grant; tool inputs are strict and accept no owner field.

| Tool | Purpose | Scope |
| --- | --- | --- |
| `garderobe_ask` | Send a request to the backend assistant; a read-only connection gets proposals, never changes | read |
| `garderobe_today` | The prepared board, at the same revision the app sees | read |
| `garderobe_recommend` | Validated outfit options for a brief, date and count | read |
| `garderobe_inventory` | Items, availability, history, the complete snapshot with explicit completeness, or the garments a bulk correction would cover | read |
| `garderobe_command` | One typed command with a verified receipt. Only wear and wash reports and research records run directly; every other type (marked `consequential` in `command_types`) is kept as a proposal for the owner and the tool answers `confirmation_required` (with the proposal's identifier and summary) until the owner has decided | write (not listed for read-only connections) |
| `garderobe_research` | Start an investigation and return sources, verdict and comparison | read |
| `garderobe_run` | Read a run, answer its question, cancel or resume it | read |

Resources: `garderobe://guide`, `garderobe://style/profile`, `garderobe://commands`. Correctness never depends on reading them.

What a connected assistant cannot do, enforced on the one command registry (`src/lanes/index.ts`), so it holds for every tool:

- **Lift a restriction.** `restriction.resolve` is refused on the MCP channel, and no assistant may undo the command that recorded a restriction. The owner lifts a restriction in the app or in their own Garderobe conversation.
- **Make a change without the owner, other than a report.** A typed `garderobe_command` follows an allow-list (`src/mcp/policy.ts`), not a list of sensitive types. Run directly: `wear.record` for garments no active restriction excludes, `care.mark_dirty`, `care.washed` when it names its garments, the research records `research.save_note`, `product.record`, `product.record_observation`, `product.record_fit_assessment`, `job.create` for a research job (kinds `product_investigation`, `historical_research`, `other`), and the undo of one of these. The list is the assistant workstream's own classification of what relayed words may record (`classifyChange(type, payload, "mcp")` in `packages/assistant/src/policy/classes.ts`), so the typed path and the conversation path cannot differ, except for the types in `TYPED_DIRECT_BY_OWNER_DECISION` in `policy.ts`, the one place to let a further type run from a typed command only. By the owner's decision of 2026-10-03 on routine, undoable actions it holds `board.select` (choosing an option on the published board), `laundry.collect` and `laundry.return` (a laundry pickup and the return of a bag; a recorded return can be undone since the foundation's a5e6c8fa), and `stock.pack` and `stock.unpack` for one of the owner's planned trips; each returns a receipt naming the connected assistant and can be undone by it (`test/mcp-routine-actions.test.ts`). A return that names pieces as still away records an exception and waits for the owner, as `laundry.report_exception` does. Packing for something that is not a planned trip of the owner's waits as well, and these actions follow the same seven-day window as reports. The same list is passed to the assistant workstream's ledger guard (`registerAssistant`, `typedDirect`). Refused outright (`forbidden`, `not_available_to_connected_assistant`): system-class commands, account-level commands and commands that take no owner statement. Every other type (corrections, names, locations, counts, adding or retiring a garment, the profile, rules, directions, measurements, adding a restriction, swapping a piece on the board and removing a board, trips, laundry returns and exceptions, settings, pausing, reminders, orders and returns, connections, model routing, forgetting, images, and the undo of any of them) is carried out only after the signed-in owner confirms it in the app. Such a request is stored (`submitted_proposals`, migration 0304) and answered with `confirmation_required` (`details`: `reason: owner_confirmation_required`, `state: pending`, `proposalId`, `summary`, `expiresAt`); the connection is never asked to confirm, because its answer would be its own. The owner decides it with `POST /v1/proposals/{proposalId}/decision`. Repeating the same call returns the receipt once the owner has confirmed, `forbidden` (`rejected_by_owner`) once rejected. The same idempotency key with a different request is refused. Connected assistants share one limit on what waits for the owner (`WAITING_LIMITS` in `src/proposals/store.ts`): at most 40 undecided, unexpired requests per connection and 80 for all of an owner's connections together (12 for one relayed turn), counted across typed commands, commands refused on a relayed turn and the requests the assistant recorded on turns a connection started through `garderobe_ask`. Beyond that a typed request and a new `garderobe_ask` turn get `rate_limited` and nothing more is put before the owner; a request the owner has decided or that has expired no longer counts, and what the owner asks for in the app is never limited. The owner's list of waiting requests is read by state and is not truncated; `state=all` adds the newest 200 decided or expired ones. The summary the owner reads is in words and is written by the same trusted code as the summary of a request made in conversation (the assistant workstream's `describeChange`, called from `describeSubmittedChange` in `src/proposals/store.ts`), from the exact payload that would run (the command schema's defaults filled in): the system's sentence for the change, records named from the ledger instead of identifiers (a piece by its name, a trip by its name and dates, a board by its day, an option by its position), every other field listed by name with its value in full; invisible and direction-changing characters are removed and anything that looks like a closing quotation mark is shown as an apostrophe. A command with no sentence of its own opens with this module's plain label for it ("Change a trip.") rather than its machine name, and the change an undo would reverse is named by its label too (a test holds every type that can wait for the owner to having a label). Nothing is shortened: a request with a value longer than 2,000 characters or a summary longer than 8,000 is refused with `invalid_command` (`too_long_to_show_in_full`) and not kept. An identifier that names no record of the owner's is shown and said to match nothing. A stored request that cannot be described in full (kept before these bounds, or one whose description fails) stays on the owner's list with a plain statement in place of its content and can be rejected but not confirmed (`not_shown_in_full`); it is never shown as raw fields. A turn proposal's identifier covers its command, payload, the summary shown and the versions it runs against, so a stored proposal that no longer matches what the owner read cannot be confirmed under the identifier the owner saw. A report (`wear.record`, `care.mark_dirty`, `care.washed`) is recorded at once only for today and the seven days before it in the owner's timezone, judged by the wearing date and by `occurredAt` when given; any other date waits for the owner. `CONSEQUENTIAL_COMMAND_TYPES` in the contracts is a floor that a test holds this policy to. Until 2026-10-02 sensitive commands ran after an MCP confirmation question answered by the client, and until 2026-10-03 a type outside that list (for example `garment.correct`, `garment.add_alias`, `garment.move`, `settings.update`, `service.pause`, `restriction.add`) ran directly; both paths are removed.
- **Change anything but a short list on relayed text.** When the backend assistant acts on a message that arrived through `garderobe_ask` or `garderobe_research`, the words are whatever the connected model sent and cannot be verified as the owner's. From such a turn the registry lets through only internal bookkeeping (system-class commands) and `RELAYED_TEXT_ALLOWED`: research records (`job.create`, `job.update`, `research.save_note`, `product.record`, `product.record_observation`, `product.record_fit_assessment`) and plain wear and wash reports (`wear.record`, `care.washed`, `care.mark_dirty`). A wear report naming a garment that an active restriction excludes is not let through. Everything else (corrections, adding a restriction, aliases, orders and arrivals, returns, reminders, briefs, settings, memory, undo, and every sensitive change) is stored as a proposal for the owner and refused with reason `relayed_text_not_owner_statement`.
- **Restore or erase.** Import, restore and account operations are app routes under Access, not tools.

MCP Tasks: the specification says "Use the Tasks extension where both peers support it; otherwise return a normal result containing the Garderobe run handle." The installed server SDK (`@modelcontextprotocol/server` 2.0.0) states that task methods are 2025-11-25 wire vocabulary with no SDK runtime, so this server cannot be a peer that supports it; long operations return run handles (`garderobe_run`).

## Running locally

From the repository root, install once with `bash tools/sandbox-install.sh` (or `npm install`). Then, in `apps/worker`:

```
npm run dev              # first run sets up: local keys, .dev.vars, D1 migrations, the real owner profile and inventory
npm run dev -- reset     # delete local state and set up again
npm run dev -- empty-owner   # (Worker stopped) create an empty owner and an invitation, as a restore target
npm run dev:token        # a local sign-in token (one hour); add -- --header or -- --claim
npm run smoke:mcp        # 21 checks against the running Worker; exit 1 on any failure
node scripts/restore-drill.mjs --local --target-invitation <code>   # backup, restore into the empty owner, verify
```

- App/API: `http://localhost:8787`. MCP: `http://127.0.0.1:8787/mcp`. The two hostnames are kept apart as in a deployment, so call the API on `localhost`.
- Local sign-in is a stand-in for Cloudflare Access: a token signed with a key generated on this machine, sent as `Cf-Access-Jwt-Assertion: <token>` or, in local mode only, `Authorization: Bearer <token>`. The Worker accepts that key only when `ENVIRONMENT` is `local` or `test`.
- No model is reachable locally (no AI binding): a conversation turn is accepted and returns a durable run that ends in a reported failure. Every other surface works.

### Driving the MCP server from a script

```js
import { connectLocalMcp, callTool } from "<repo>/apps/worker/scripts/lib/mcp-client.mjs";
const mcp = await connectLocalMcp({ write: true, clientName: "Simulation", onElicit: () => ({ action: "accept", content: { confirm: true } }) });
const today = await callTool(mcp.client, "garderobe_today", {});            // { ok, data, error, text }
const receipt = await callTool(mcp.client, "garderobe_command", { type, payload, idempotencyKey });
await mcp.close();
```

`connectLocalMcp` goes through the same steps as a consumer assistant: 401, discovery, dynamic registration, authorization code with PKCE, the owner's consent, token, then tool calls. `scripts/mcp-smoke.mjs` is a complete example; it writes only to a labelled synthetic garment.

### In tests

`@garderobe/worker/testing/vitest-config` exports `garderobeWorkerTestPlugin()` (D1, KV, two R2 buckets, queue, the conversation Durable Object, and a fixture for outbound requests). `@garderobe/worker/testing` exports `provisionOwner({ real })`, `ApiClient`, `connectMcp(owner, { write, era, onElicit })`, `toolResult`, `publishBoard`, `ownerDay`, `uploadImage`, `readSse`, `enableFakeModel` and others.

Days in tests: name "today", "tomorrow" or "yesterday" with `await ownerDay(owner, offset)`, which is the day in the owner's own timezone. The UTC date is a different day for part of every day for an owner who is not on UTC (the real owner is on Europe/London), and the Worker refuses, for example, to publish a board for a day that is already over for the owner. To run a suite at a chosen time of day, set `GARDEROBE_TEST_CLOCK=HH:MM` (UTC): every `Date` in the Workers runtime under test then reads as the next occurrence of that time (`src/testing/clock.ts`).

## Scheduled work (cron, every five minutes)

In this order: connection health, then the daily service's due phases and calendar projections; alongside them expiry sweeps, unfinished account erasures, backups, media maintenance, the assistant's maintenance and its background jobs; then notifications and reminder events.

- **Connection health** (`src/scheduled/assistant.ts`): each connected service is probed once before the evening composition and once before the morning delivery of a day. A rejected credential becomes one reconnect state on that connection; nothing else is affected.
- **Background jobs**: `assistant.run_job` effects are run by the assistant's own runner with the owner's Google grant (mailbox investigations, sheet-import previews). The spreadsheet grant is read-only.
- **Inference reservations**: the scheduled maintenance passes the assistant's reservation reconciler a lookup of the AI Gateway's logs (`gatewayUsageLookup` in `src/lanes/assistant.ts`) when `AI_GATEWAY_ACCOUNT_ID` and the secret `AI_GATEWAY_LOGS_TOKEN` (a Cloudflare API token limited to "AI Gateway Read") are set beside `AI_GATEWAY_ID`; without them no lookup is made. Tested against a fake logs endpoint only (`test/journey-defects.test.ts`); never run against the real one.
- **Notifications** (`src/notifications/service.ts`): APNs token-based provider API. Kinds: morning board, reminders, return reminders. Each is re-checked before it is sent, sent once per device with a collapse identifier, retried on an outage, and never recorded as delivered when no device is registered. Secrets: `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_TOPIC`. Without them nothing is claimed and the effects stay pending.
- **Reminder events**: a reminder set in conversation is written as one event on the owner's dedicated outfit calendar, read back before it is recorded as projected, updated in place when the reminder changes and deleted when it is removed. An owner with no outfit calendar gets no event and the effect is recorded as cancelled.
- **Backups** (`src/backup/service.ts`): one per active owner per day under `backups/<owner>/` in the export bucket, kept 35 days (the newest complete one is never expired), each with a restore manifest (snapshot times per store, components, a state digest with the conversation's projection watermarks). A journal of what the owner deleted since (forgotten sources and deleted images) is kept beside the backups and replayed on restore, so a restore never brings back what was deleted. `POST /v1/restore/verify` compares the restored owner with the manifest check by check. Sign-ins, credentials and assistant grants are not in a backup by design.

## Account deletion

A confirmed `POST /v1/account/delete` erases the owner's stored data: third-party grants are revoked, the conversation actor and its research task actors and the owner's search instance are erased, cached thumbnails and every media object are deleted, then export packages, backups and journals, and finally every row of every table that has a `user_id`, in one transaction. The assistant's and the visual wardrobe's steps run before the rows are deleted because they find their stores through those rows. What remains is one `account_erasures` row with a keyed hash and counts. An erasure that fails part-way stays pending and the scheduled sweep finishes it. Forgetting a single source (`conversation.forget_source`) is a different operation owned by the assistant workstream; this package does not describe it as complete erasure of every copy.

## Checks

```
npm run typecheck        # in apps/worker
npm test                 # in apps/worker: 20 files, 197 tests
GARDEROBE_TEST_CLOCK=23:30 npm test   # the same suite with the clock at the next 23:30 UTC (the owner's day and the UTC day differ)
npm test                 # in the repository root: typecheck and tests of every workspace
```

## Stand-ins used by the tests

- **Cloudflare Access**: assertions are signed with a key generated per test run and verified by the Worker's real verification code. Real Access with Google was not exercised.
- **Language model**: the assistant workstream's labelled fake model, and a labelled test double for the composition model in the scheduled sweep. No test here calls a real model.
- **Google OAuth, Calendar, Sheets, Gmail and Drive**: the labelled fixture `https://google.fixture.test` (`src/testing/vitest-config.ts`), including a synthetic spreadsheet and an in-memory event store.
- **Remote MCP tool service**: a labelled fixture at `https://mcp.tavily.com/mcp`; it is not Tavily. **OAuth MCP service**: the labelled fixture `https://oauth-tools.example.org`.
- **APNs**: the labelled fixture `https://apns.fixture.test`, which verifies the provider token's signature and headers; it is not Apple.
- **Browser Rendering**: a labelled fake binding inside one test; there is no such binding locally.
- **All other outbound requests** answer 503, so weather is reported as unavailable.
- **MCP client in tests** is the SDK client over in-process `fetch`; the smoke script and the restore drill use real HTTP against `wrangler dev`.

## Not verified here

Everything in this package is implemented; these parts have only been exercised against the stand-ins above and need the development deployment or a device:

- Real Cloudflare Access with Google and Managed OAuth for the native app; an Access bypass for `/connections/callback` and `/v1/media/signed/*` (both carry their own authentication).
- Consent, refresh, scope denial, revoke and reconnect with real Claude and ChatGPT clients; client metadata documents with a real client.
- A real Google grant over several days (Calendar, Sheets, Gmail), real Exa and Tavily endpoints and a real OAuth MCP service.
- APNs with the real team key and a real device.
- The Browser Rendering binding (`"browser": { "binding": "BROWSER" }`), AI Gateway for the composition model in the scheduled sweep and for mailbox investigations, and deletion of the AI Search instance on account erasure (none of these bindings exist locally).
- The restore drill on real resources (`scripts/restore-drill.mjs --base ...` with two Access identities and an empty target owner) and backup retention on real R2.
- Server-sent events on a physical iPhone.

For the deployment: apply every migration in `migrations/` in order; this package's are `0300` to `0304` (`0302` reminder calendar and health columns, `0303` proposal decisions, `0304` proposals submitted by a connected assistant). Cloudflare Access must not cover `/connections/callback` or `/v1/media/signed/*` (bypass policies): both carry their own authentication, and a signed image link is opened by Calendar and the share sheet without a session.

Limits to know about: a recommendation that continues as a run finishes inside the request's `waitUntil` lifetime; one that is lost is reported as failed after ten minutes, not resumed. Cached thumbnails are purged in the data centre that handles the erasure and lapse elsewhere within 24 hours; they are unreachable meanwhile.
