# Garderobe

A private wardrobe companion: Cloudflare backend, SwiftUI app for iOS 27 and an MCP interface to the same backend assistant. This directory is the fresh codebase built from `garderobe-replacement-design.md` (the spec). Nothing in it comes from a previous system; only the owner's data is imported.

This README covers the **foundation**: monorepo, shared contracts, D1 schema, domain command service, availability estimator, the owner's imported profile and wardrobe, and the test harness. Later workstreams (daily service, assistant, API/MCP, iOS, visual wardrobe, end-to-end simulation) build on the interfaces described here.

## Quick start

```sh
cd garderobe
npm install            # npm workspaces; .npmrc sets legacy-peer-deps (see "Toolchain")
npm test               # typecheck all packages + contract tests + backend tests on real local D1
npm run seed:demo      # apply migrations to local D1 and import the owner's real data (+ synthetic owner B)
npm run seed:demo -- -- --with-test-events   # also apply the labelled scenario test events
```

Everything runs locally. No Cloudflare, Google or third-party account is contacted: tests run in workerd through `@cloudflare/vitest-pool-workers` with remote bindings disabled, and the seed writes to wrangler's local state in `backend/.wrangler/`.

Other scripts: `npm run schemas` (regenerate JSON Schema), `npm run reconcile --workspace @garderobe/backend` (regenerate the import reconciliation report), `npm run dev --workspace @garderobe/backend` (`wrangler dev`).

## Layout and ownership

| Path | Contents | Owner |
| --- | --- | --- |
| `package.json`, `tsconfig.base.json`, `.npmrc` | Workspace root and shared compiler settings | Foundation |
| `packages/contracts/` | Versioned zod schemas → TypeScript types and JSON Schema (`json-schema/*.json`) for the iOS app and MCP tool definitions | Foundation (additive changes by others; breaking changes mint a new `CONTRACTS_VERSION`) |
| `backend/wrangler.jsonc` | Worker config: D1, R2, KV (incl. `OAUTH_KV`), Queues, Workflows, Durable Object (Think actor), AI binding, AI Gateway placeholders; no secrets | Foundation; small additive edits by others |
| `backend/src/index.ts` | Worker entry: `/health`, the `GarderobeAssistant` Durable Object (explicit 501 until the assistant workstream installs Think) and `DailyServiceWorkflow` (applies weekly laundry resets) | Foundation; routes added by API/MCP, DO body by assistant, workflow steps by daily service |
| `backend/migrations/0001_initial.sql` | Fresh D1 schema | Foundation. **Never edit**; add `0002_*.sql` and later |
| `backend/src/domain/` | Command service, accounting, estimator, style, boards primitive, queries | Foundation |
| `backend/src/import/` | Section 16 import boundary: CSV parser, owner inventory mapper, dataset importer, reconciliation | Foundation |
| `backend/test/` | Real-D1 tests (workerd) | Foundation; others add files |
| `data/` | Owner data kept byte-exact (profile, inventory CSV), rule catalogue, reconciliation report — see `data/README.md` | Foundation |
| `demo/` | Synthetic second owner for isolation tests, labelled test events, local seed script | Foundation |
| `backend/src/{recommend,daily,weather,calendar,trips}/`, `backend/migrations/0002_daily_service.sql` | Daily service: mandatory context, composition, validation, repair, publication, weather skill, Calendar projection, morning workflow, trips — interfaces in `backend/src/recommend/README.md` | Daily service |
| `backend/src/{media,visual,studio}/`, `backend/migrations/0020_visual_wardrobe.sql`, `packages/contracts/src/visual.ts`, `demo/assets/` | Visual wardrobe: private R2 media with signed owner-scoped URLs, upload finalization, discovery/normalization jobs with fidelity checks, Photos needed, deterministic outfit composites (`outfit-layout/1`), Studio backend and commands (`save_combination`, `plan_outfit`, `remove_combination`), DEMO placeholder images — interfaces in `backend/src/media/README.md` | Visual wardrobe |

## Toolchain (installed versions)

| Package | Version |
| --- | --- |
| wrangler | 4.143.0 |
| @cloudflare/workers-types | 5.20260929.1 |
| @cloudflare/vitest-pool-workers | 0.22.0 (bundles wrangler 4.124.0, miniflare 5.20260815.0-alpha) |
| vitest | 4.1.11 |
| zod | 4.6.5 |
| typescript | 7.0.2 |
| tsx | 4.23.15 |
| Node | 22.23 (engines: >= 22) |

Not installed by the foundation (not needed for this layer; they exist on npm): `@cloudflare/think` 0.19.0, `agents` 0.24.0, `@modelcontextprotocol/server` 2.2.0 (MCP SDK v2), `@cloudflare/workers-oauth-provider` 1.2.1. The assistant and API/MCP workstreams install and pin them.

`.npmrc` sets `legacy-peer-deps=true` because npm 10.9 crashes (`Cannot read properties of null (reading 'edgesOut')`) while resolving vitest's optional browser peers in this workspace. `compatibility_date` is `2026-08-01` so that the vitest pool's bundled workerd supports it.

## Principals and isolation

Every domain function takes a `Principal` (`{ userId, scopes, authenticatedBy }`) built by trusted authentication code (Access assertion, MCP OAuth grant, scheduler). All reads and writes are scoped by `principal.userId`; private tables use owner-qualified keys and compound foreign keys, so cross-user references fail in SQLite itself. Command bodies never carry ownership: any `userId`, `ownerId`, `owner`, `user`, `accountId` or `tenantId` field anywhere in a request is rejected with `forbidden_owner_field`. Another user's IDs return `not_found` (existence is not leaked). Mutations require the `wardrobe:write` scope; `readOnlyPrincipal()` gets `insufficient_scope`.

## Domain command service

```ts
import { CommandService, ownerPrincipal } from '@garderobe/backend/domain';
const receipt = await new CommandService(env.DB, principal).execute({
  idempotencyKey: 'app:7f3e…',         // 8-200 chars, stable per user intent
  source: 'app',                        // app | web | conversation | mcp | import | offline_replay | calendar | system
  expectedVersions: [{ entityType: 'restriction', entityId: 'rst_…', version: 1 }], // optional
  command: { type: 'record_wear', timezone: 'Europe/London', items: [{ garmentId: 'g_…' }] },
});
```

No model is involved. The service parses the envelope (strict zod), rejects forged owner fields, checks scope, hashes the request (`command` + `expectedVersions`), and returns the stored receipt for a repeated key and body (`replayed: true`). A reused key with a different body is rejected with `idempotency_key_reused`. The handler then plans the complete change and commits it in **one D1 batch**:

1. a precondition insert into `command_preconditions` (`CHECK (ok = 1)`) that evaluates every expected version, lot version, counted-wear revision and state predicate; a mismatch raises a real constraint error and D1 rolls back everything;
2. domain writes (observations, movements, balances, garments, batches, rules…);
3. the receipt, its affected-entity index and outbox effects (`command_effects`);
4. cleanup of the precondition row.

On a precondition race, **observation** commands (the owner's physical statements) re-plan against the new state and commit with `rebased: true`; **edit** commands with stale `expectedVersions` return `outcome: 'conflict'` and write nothing. Receipts are never deleted (a trigger aborts `DELETE`). Undo is a compensating command with its own receipt; it rechecks intervening changes and marks the original `undoneByCommandId`.

### Command catalogue

| Command | Class | Effect | Undo |
| --- | --- | --- | --- |
| `record_wear` | observation | Observation + counted wear per (user, garment, local wearing date); duplicate reports merge (`outcome: 'merged'`); stock consumed once per counted wear | retract observation |
| `amend_wear` | observation | New observation revision; old one superseded; counts and stock recomputed in event order | restore original |
| `mark_in_wash` ("In the wash") | observation | Unit(s) from worn/clean to the hamper; rejected for never-laundered roles | void movement |
| `mark_washed` ("I washed it") | observation | Hamper/worn → clean; clears dirty exceptions | void movement |
| `socks_washed` | observation | Hand-wash hamper → clean (never a service batch) | void movements |
| `laundry_collected` | observation | Snapshot of the service hamper at the pickup instant into a new batch | withdraw batch |
| `laundry_returned` / `laundry_partial_return` | observation | Completes only that batch, less named exceptions (kept away as `still_away`) | restore batch |
| `send_to_tailor` / `back_from_tailor` | observation | Location and units away/home; tailoring project opened/closed | restore garment |
| `mark_arrived` ("Arrived") | observation | Incoming → owned; units received; order lines updated | restore garment |
| `put_into_storage` / `take_out_of_storage` | observation | Units to/from storage; location follows when all units move | restore garment |
| `reconcile_quantity` | observation | Aggregate corrections: `clean` and/or `totalOwned`; never invents units | void movements |
| `dispose_item` | observation | Units retired; acquisition disposed with reason; history kept | restore garment |
| `add_item` | intake | Explicit creation only (`explicit: true`, owner channel) | remove as mistaken entry (only without wears) |
| `set_restriction` / `lift_restriction` | edit | Restriction lifecycle; lifting needs an owner statement from an owner channel (never scheduler, import, calendar or elapsed time) | lift / reinstate |
| `select_option` | edit | Intention for a board option (never a wear); one footwear required when alternatives exist; queues a Calendar projection | restore previous choice |
| `edit_style_profile` | edit | New verbatim document version (`baseVersion` required); rules whose quote vanished flagged `passage_status: 'missing'` | new version with the previous text |
| `set_temporary_brief` | edit | Dated brief or exception; the profile is untouched; rejected for rules with `exceptionPolicy` `none` or `restriction_lift_only` | retire brief |
| `undo` | compensation | Executes the stored compensation plan | — |

### Receipt shape (`CommandReceipt`, contracts `2026-10-01`)

```jsonc
{
  "schemaVersion": "2026-10-01",
  "commandId": "cmd_…", "idempotencyKey": "…", "commandType": "record_wear",
  "outcome": "committed" | "merged" | "rejected" | "conflict",
  "replayed": false, "rebased": false,
  "affected": [{ "entityType": "daily_wear", "entityId": "g_…|2026-10-06", "version": 1, "change": "created" }],
  "summary": "Recorded 2026-10-06: counted Lightweight oxford — blue.",   // trusted code, never a model
  "facts": { "observationId": "obs_…", "counted": […], "stockNotes": […], "warnings": […] },
  "effects": { "state": "none" | "projection_pending" | "projected" | "failed", "items": [{ "effectId": "eff_…", "kind": "board_revalidation", "external": false, "status": "pending", "operationKey": "revalidate:cmd_…" }] },
  "undo": { "available": true },
  "compensatesCommandId": null, "undoneByCommandId": null,
  "occurredAt": "…", "recordedAt": "…",
  "error": null | { "code": "not_found", "message": "…", "details": {} }
}
```

`rejected` and `conflict` receipts are returned but not stored (nothing changed). Every committed command that can affect availability queues an internal `board_revalidation` effect for the daily service; `select_option` queues an external `calendar_projection`.

## Wardrobe accounting (spec section 5)

- **Separate facts:** acquisition (`incoming | owned | disposed`), planning policy (`normal | occasional | excluded`), condition, location and restrictions are independent fields. Physical units sit in buckets `clean, worn, hamper, laundry, storage, away, retired`; SQLite `CHECK` constraints keep every bucket non-negative.
- **Journal and replay:** `stock_movements` stores the intent of each quantity change; balances are the event-ordered replay (`domain/stock/replay.ts`). A late report is inserted at its occurrence time, so yesterday's wear reported today does not undo today's known wash. Owner-observed wears draw from fallback buckets with an `accounting_repair` note rather than going negative; replay never creates units.
- **Counted wear:** `daily_wears` PRIMARY KEY `(user_id, garment_id, wearing_date)`; the local wearing date is the key (an overnight outfit keeps its starting date; DST needs no special case). One `wear` movement per garment and date (partial unique index). A shirt change counts only the new shirt. Anonymous units (socks) move per counted wear, plus explicit `freshUnit` movements that never add a counted wear.
- **Care:** `per_wear` garments go to the hamper, `single_wear_day` trousers go to `worn` (in use, not in a hamper), `multi_wear` and `never` garments never move; `never` implies `care_channel = 'none'` (schema `CHECK`). Pickup is a snapshot of the service hamper; returns complete only that batch; hand wash is separate.

## Availability estimator (`availability-estimator/1`)

`estimateGarment(input)` (pure) and `estimateAvailability(db, principal, { targetDate, asOf?, garmentIds?, includeOccasional? })`. Initial parameters are **hypotheses, not calibrated accuracy**; the selection prior may only be learned from observed choices:

| Parameter | Value | Meaning |
| --- | --- | --- |
| `boardUseProbability` | 0.70 | P(owner uses an unselected board at all) |
| `selectedBoardUseProbability` | 0.90 | P(board used once an option is selected) |
| `selectedOptionProbability` | 0.85 | share of the selection probability for the chosen option; the rest spreads evenly |
| `likelyAvailableThreshold` | 0.50 | cut-off for `likelyAvailable` |

Per board day: each of N offerable options has probability 1/N (or the selection split); footwear alternatives share their option's probability (1/k, or 1 and 0 once chosen); a garment in several options sums them; the total is multiplied by the board-use probability. Days with any recorded wear contribute no uncertainty (the observation replaces it). Estimated clean units are physical clean units plus dirty units cleared by the latest applied weekly reset of the garment's pool. Service pool: dirtied before Friday's 09:00 collection cutoff, or in a batch collected before Sunday's 00:00 baseline. Hand wash: before its own baseline. Owner exceptions after the cutoff (still away, missed return, dirty, delay) override the reset. P(available) = P(Poisson-binomial inferred wears < estimated clean units). Resets are recorded once per owner, pool and cycle by `ensureLaundryResets` (idempotent, catches up after missed runs). They never record a pickup, return or movement. Inferred wears never enter wear counts.

## Owner profile and rules

`data/owner-profile.md` is imported verbatim as the owner's style document (version 1, SHA-256 `e15639d8…cb198`, **identical to the spec's value**). `data/owner-profile-rules.json` holds 41 machine rules with `ruleKey`, `strength` (hard/soft), `category`, `interpretation`, `machine` parameters, `exceptionPolicy` and a verbatim `passage` (section + quote). All section 8 hard constraints are present: `hard.socks_always`, `hard.sneakers_only_until_healed` (implemented as the `profile-sneakers-only` healing restriction on shoes, boots, `construction: welted` and `model: 990v6`), `hard.sneaker_and_welted_alternative` (dormant while that restriction is active), `hard.thermal_peak_for_base`, `hard.thermal_morning_for_outerwear`, `hard.thermal_jacket_14_16_lightweight_oxford`, `hard.variety_seven_days`, `hard.never_fall_back_to_navy`, `hard.perceptible_names`. The foundation stores and exposes rules; enforcing them during composition belongs to the daily service, and in conversation to the assistant. `getStyleContext(db, principal, date)` returns the complete documents, active rules, dated briefs, amendments, restrictions, dormant rule keys and the precedence statement.

## Owner wardrobe import

`data/wardrobe-inventory-2026-05.csv` is mapped by `backend/src/import/owner-inventory.ts` and written by `importDataset`. Of 130 rows, 127 are imported and 3 are merged ("pair 2" rows folded into one garment with quantity 2); none are held. The result is 127 garments and 144 units, including 29 sock pairs. Statuses are decomposed into separate facts. There are 32 migration issues, among them profile-vs-CSV conflicts: the 990v6, 993, rugbies, Shetland knitwear and indigo jeans are absent from the CSV, an owned moleskin blazer conflicts with the profile, and the CSV notes its own mislabel of the waxed Chasseur. See `data/owner-inventory-reconciliation.md`. No wears, batches or arrivals are invented. Scenario state lives in `demo/src/test-events.ts`, applied through commands and labelled `TEST EVENT`.

## Public interfaces for other workstreams

Import from `@garderobe/backend/domain`, `@garderobe/backend/import` and `@garderobe/contracts`, never from internal files.

| Need | Call |
| --- | --- |
| Execute any mutation (API `POST /v1/commands`, MCP `garderobe_command`, assistant tools, offline replay) | `new CommandService(db, principal, { now? }).execute(envelope)` / `executeCommand(...)` |
| Read a receipt / an entity's receipts | `getReceipt(db, principal, commandId)`, `listReceiptsForEntity(db, principal, type, id)` |
| Build principals | `ownerPrincipal(userId, authenticatedBy, scopes?)`, `readOnlyPrincipal(userId)`, `systemPrincipal(userId)` (scheduler) |
| Users and login mapping | `createUser(db, input)`, `resolveIdentity(db, issuer, subject)` |
| Wardrobe and item pages (`GET /v1/wardrobe`, `/v1/items/{id}`) | `listWardrobe(db, principal, query)` → `WardrobePage`; `getItemDetail(db, principal, id)` → `ItemDetail` |
| Resolve an owner phrase | `resolveAlias(db, principal, phrase)` → resolved / ambiguous (with distinguishing facts) / not_found |
| Hard eligibility and estimates | `evaluateEligibility(garmentRow, restrictions, opts)`, `estimateAvailability(...)`, `estimateGarment(...)`, `optionAvailability(ids, estimates)` |
| Wear history | `listDailyWears(db, principal, { garmentId?, from?, to? })` |
| Laundry sheet and weekly resets | `getLaundryState(db, principal)`, `ensureLaundryResets(db, principal, at)`, `listLaundryResets`, `dueCycles` |
| Taste context | `getStyleContext(db, principal, date)`, `getStyleDocument`, `listStyleRules` |
| Boards (daily service writes; API/MCP reads) | `publishBoardRevision(db, principal, { boardDate, timezone, options, expectedRevision, ... })`, `getBoard`, `findBoardByDate`, `getActiveSelection` |
| Import | `importOwnerData(db, principal, sources)`, `importDataset(db, principal, dataset, opts)`, `buildInventoryReconciliation`, `renderReconciliationMarkdown` |
| Scenario fixtures and isolation owner | `@garderobe/demo`: `applyTestEvents(executor, { garment, weekStart })`, `syntheticOwnerB` |
| Contracts for Swift | `packages/contracts/json-schema/*.json` (draft 2020-12) |

## Tests

`npm test` runs `tsc` for all packages, the contract tests (Node) and the backend tests in workerd against real local D1 (migrations applied from `backend/migrations`, one fresh database per test file). Suites: `import` (profile byte-exactness, rules, restriction, row accounting, status mapping, quantities, facts, aliases, conflicts, idempotency, reconciliation freshness, held rows, CSV parser), `wear`, `socks`, `laundry`, `commands` (receipts, idempotency, forced late failure, all-or-nothing bulk, racing edits, explicit creation, lifecycle, select option, scopes), `isolation`, `estimator`, `style`, `test-events`, `smoke`.
