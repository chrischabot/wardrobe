# Garderobe adversarial tests

Attacks on the **real application**: the real Worker inside workerd (its HTTP API, MCP server, OAuth
provider and conversation actor) on a **real local D1** with every migration, local KV, R2 and the queue.
Assertions read actual application state and stored receipts, never a stand-in. Only the network
boundaries to external services are replaced, by the labelled test doubles the journey suite documents
(`tests/journeys/src/outbound.ts`: scripted weather, an in-memory Calendar, and the Worker package's
fixtures for Access assertions, the language model, Google OAuth and push).

## Running

From the repository root, after `npm install` (in the Fabric sandbox: `bash tools/sandbox-install.sh`):

| Command | What it does |
| --- | --- |
| `npm test -w @garderobe/adversarial-tests` | **The whole suite.** Known open defects are expected failures; anything else that fails is a regression. Exit code 0 means "no regression", not "no open defects". |
| `npm run test:strict -w @garderobe/adversarial-tests` | The acceptance view: every known open defect fails as an ordinary test. Its failures are exactly the open entries of the areas' `DEFECTS.md` files. |
| `npm run test:domain -w @garderobe/adversarial-tests` | One area (`harness`, `domain`, `api-mcp`, `assistant`, `daily-media`). |
| `npm run test:domain -w @garderobe/adversarial-tests -- -t "idempotency"` | Further arguments go to vitest unchanged. |
| `npm run typecheck -w @garderobe/adversarial-tests` | Typecheck of every area. |

The root `npm test` runs the default mode along with every other workspace.

## Layout and ownership

| Path | Owner | Contents |
| --- | --- | --- |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/`, `harness/`, this file | domain adversarial thread (shared files) | Manifest, configuration, runner, shared harness and its own smoke test |
| `domain/` | domain adversarial thread | Every domain command, the D1 ledger, the import boundary |
| `api-mcp/` | API and MCP adversarial thread | HTTP API, MCP server, identity, recovery, export |
| `assistant/` | assistant adversarial thread | Conversation authority, inference, memory, research |
| `daily-media/` | daily-service and visual-wardrobe adversarial threads | Recommendations, weather, Calendar, repair, trips; media, Studio |

**A thread adds files only below its own directory and never edits a shared file.** That is enough:

- Any `*.test.ts` below an area directory is picked up by the shared configuration.
- Import the harness by relative path: `import { provisionOwner, refusal, ledgerFingerprint } from "../harness/index.ts";`
- Area-local helpers live in the area (for example `api-mcp/support.ts`); files that do not end in
  `.test.ts` are never run as tests.
- The dependencies an area needs are already declared: `@garderobe/contracts`, `domain`, `daily`,
  `assistant`, `media`, `worker`, `@modelcontextprotocol/client`, `jose`, `fflate`, `zod`. If something
  else is needed, ask the owner of the shared files.
- **Own outbound doubles.** A directory below an area with its own `vitest.config.ts` (for example
  `daily-media/daily/vitest.config.ts`) is a separate vitest run with that directory as its root: the
  runner (`scripts/run.mjs`) runs it after the shared configuration, and the shared configuration leaves
  its files alone. Use `garderobeWorkerTestPlugin({ miniflare: { outboundService } })` there, and add
  `define: { __ADVERSARIAL_STRICT__: JSON.stringify(process.env.ADVERSARIAL_STRICT === "1") }` if the run
  uses `defect()`.
- Each area keeps its own `COVERAGE.md` (what is attacked, by which test) and `DEFECTS.md` (open defects
  with reproductions, and the fixed ones).

## The harness (`harness/index.ts`)

| Export | Use |
| --- | --- |
| everything of `@garderobe/worker/testing` | `provisionOwner({ real })`, `ApiClient`, `accessAssertion` (also forged: `untrusted`, wrong audience, expired), `connectMcp`, `toolResult`, `decideConsent`, `enableFakeModel`, `publishBoard`, `uploadImage`, `testPng`, `readSse`, `testApp`, `ownerDay`, `SELF`-backed `selfFetch` |
| `createLedgerHarness({ startAt, composed })` | The real command service on the same D1 with a clock the test moves: races, replay storms, date and timezone edges. `owner.exec(type, payload, opts)` returns the receipt; `createSyntheticOwner()`, `createRealOwner()` |
| `refusal(promise)` | The typed error (`code`, `message`, `details`) of a command the service must refuse; a crash or an acceptance fails the test |
| `committed(response)`, `refused(response)`, `exec(api, type, payload)` | The same for commands sent over HTTP |
| `ledgerFingerprint(userId)`, `ledgerDiff(before, after, { ignore })` | Row count and content digest of **every** owner-scoped table. An empty difference proves a refused command wrote nothing: no orphan receipt, no partial mutation, no queued effect |
| `defect(id, title, body, { intermittent })` | An open product defect kept as a test (expected failure by default, ordinary failure in the strict run) |
| weather and Calendar doubles: `newPlace`, `scriptWeather`, `weatherDown`, `liveAt`, `seedCalendar`, `calendarFaults`, `connectOutfitCalendar`, `eventsOn`, `calendarState`, `editCalendarEvent`, `realOwnerAt`, `runCron`, `mcpCommand`, `wholeWardrobe`, `settleRun` | Scripting the external world and running scheduled work, shared with the journey suite |
| `SYNTHETIC`, `REAL` | Title markers: every case says whether it uses constructed data or the owner's real import |

## Data

`provisionOwner({ real: true })` and `createRealOwner()` import the owner's real profile and inventory
(`requirements/`, byte-exact) through the real importer: personalization cases use those. Every other
owner is a labelled synthetic fixture; boundary cases use synthetic owners and say so. No test invents
an owned garment, a wear or a lifted restriction for the real owner outside its own throwaway copy of
the account in the local test database.

## Rules for a case

1. Attack through a real entry point (HTTP route, MCP tool, command service, importer, scheduled run).
2. Assert on stored state and receipts, not only on the status code: a refusal must also have written
   nothing (`ledgerDiff` is empty), and an acceptance must have written exactly what its receipt says.
3. A case that exposes a product defect becomes either a fix with an ordinary regression test, or a
   `defect(...)` listed as open in the area's `DEFECTS.md` with its reproduction and owning workstream.
4. Files run in parallel against one database: create your own owners, never assume an empty database.
