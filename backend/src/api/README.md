# HTTP API, MCP server, OAuth and web board

This is the API/MCP workstream: `backend/src/{api,mcp,auth,web}`, the Worker entry point `backend/src/index.ts` and migration `0011_api_mcp.sql`. Every surface calls the same services: `CommandService`, the daily service's board read model and validator, the Think assistant, recall and research. The native app, the private web board, Claude and ChatGPT therefore share one backend truth.

## Installed packages and protocol

| Package | Version | Use |
| --- | --- | --- |
| `@modelcontextprotocol/server` | 2.2.0 (with `@modelcontextprotocol/core` 2.2.0) | MCP server: `McpServer` plus `createMcpHandler` (per-request, web-standard) |
| `@cloudflare/workers-oauth-provider` | 1.2.1 | Inbound OAuth 2.1 authorization server and protected-resource validation (`OAUTH_KV`) |
| `@modelcontextprotocol/client` (npm alias `@modelcontextprotocol/client-v2-2`) | 2.2.0 | Test and smoke client only (dev dependency). The assistant's outbound connector still pins 2.0.0 |

**Negotiated protocol revision: `2026-07-28`.** The SDK 2.2.0 serves the modern per-request envelope and validates the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers against the JSON body. A mismatch is rejected before dispatch (`name-header-mismatch`). The SDK's stateless legacy leg (`legacy: 'stateless'`) is the **2025-11-25 compatibility adapter**. The revision used is recorded per grant in `mcp_grants.last_protocol`. Note that the core package's `LATEST_PROTOCOL_VERSION` constant still reads `2025-11-25`, which is the legacy era's latest. The modern era is `2026-07-28`, and that is what the SDK client negotiates in the tests and in the local session.

## Routing and trust boundaries (`src/index.ts`)

Every request enters the `OAuthProvider`:

- **MCP resource:** `${MCP_ORIGIN}/mcp`. The provider validates the bearer token (audience, expiry) and then calls `mcpApiHandler`. The handler checks the **D1 grant** (status, version, `grants_valid_after`, user status) on every call, so a revoked grant stops at once even if a KV token record remains.
- **Provider-owned endpoints:** `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/oauth/token` (code exchange, rotating refresh, revocation) and `/oauth/register` (dynamic registration, kept for consumer compatibility). CIMD client IDs are enabled, which needs the `global_fetch_strictly_public` flag.
- **Everything else** goes to `handleApp` (`api/router.ts`): the `/v1` API, `/board`, the consent page `/authorize` and `/health`.

The app and web board need a **Cloudflare Access** assertion (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie) or a native bearer token, on a hostname listed in `APP_HOSTNAMES`. The Worker verifies RS256 against the team JWKS, plus issuer, audience, expiry and not-before. It maps `(issuer, subject)` to the internal user. An unknown subject gets 403 `unknown_identity`, a disabled user 403, and an unprotected hostname (for example `*.workers.dev`) 403 `host_not_protected`. Email is never used. MCP tokens are not accepted by `/v1`, and Access assertions are not accepted by `/mcp`.

**Access service tokens (automated test identity).** Access issues a service-token request an assertion with `type: "app"`, an empty `sub` and the token's Client ID in `common_name`. The Worker accepts only that exact, well-formed shape and maps it to the subject `service-token:<Client ID>`, a form no user sign-in produces. Like any subject, it reaches an owner only through an explicit `auth_identities` row, so an unlinked service token gets `unknown_identity`. On the dev deployment the link is made and removed by `npm run dev:seed -- link owner|b` / `-- unlink owner|b` (`deploy/scripts/seed.ts`), and each step is written to `account_audit` (`identity_linked` / `identity_unlinked`, surface `deploy`). Tests: `test/api/access-service-token.test.ts`.

## HTTP API (`/v1`, contracts `2026-10-01`)

| Method and path | Returns (contract) | Notes |
| --- | --- | --- |
| `GET /v1/auth/session` | `SessionResponse` | |
| `GET /v1/auth/native/authorize` | 302 to `redirect_uri?code&state&iss` | Access-protected. Public client `garderobe-ios`: PKCE **S256** only, `resource=<APP_ORIGIN>/v1`, registered redirect URIs only (`NATIVE_REDIRECT_URIS`) |
| `POST /v1/auth/native/token` | `NativeTokenResponse` | `authorization_code` or `refresh_token`. No client secret; a secret is refused. 15-minute opaque access token. The refresh token rotates, and replaying a rotated one revokes the session |
| `POST /v1/auth/native/revoke` | 200 | Sign-out |
| `GET /v1/today[?date=]` | `TodayResponse` | Board, selection, recorded wears, `sources`, `shortfall`, plus `dayLine`, `weather` (`TodayWeather`) and `garments` (`BoardGarment`: Garment + `aliases` + `media`) for every garment on the board. Reading never composes |
| `POST /v1/today/prepare` | `{ published, reason, revision, shortfall }` | Owner's explicit "prepare now" (compose, validate, publish) |
| `GET /v1/today/options/{optionId}/swaps?role=` | `SwapCandidates` | Validated alternatives; read only |
| `POST /v1/recommend` | `RecommendResult` | Same as `garderobe_recommend`; preview only |
| `GET /v1/wardrobe` | `WardrobePage` | `q` (names, aliases, maker names and codes such as PCF…), `category`, `availability=available\|unavailable\|incoming\|retired\|any`, `colorFamily`, `season`, `location`, `lastWornBefore`, `cursor`, `limit ≤ 500`. Explicit `total`, `complete`, `nextCursor` and `counts`. Every item carries `media` |
| `GET /v1/wardrobe/temperature-preview?temperatureC=` | `TemperaturePreview` | `simulation: true`; writes nothing |
| `GET /v1/items/{garmentId}` | `ItemDetail` | Plus `combinations` (today's and tomorrow's published options) and `item.media`. Another owner's id returns 404 |
| `GET /v1/laundry` | `LaundryState` | Service hamper, open batches with names, next routine collection, hand-wash hamper, open exceptions |
| `POST /v1/commands` | `CommandReceipt` | Any `DomainCommand` in a `CommandEnvelope`. 201 committed or merged, 200 replayed, 409 conflict or key reused, 422 rejected, 403 scope. `source` must be `app`/`offline_replay` on this surface. `plan_outfit` is first validated for its day (`studio.validate`) and returns 422 `plan_invalid_for_day` |
| `GET /v1/commands/{commandId}` | `CommandReceipt` | |
| `GET /v1/receipts?cursor=&limit=` | `ReceiptsPage` | Newest first |
| `POST /v1/conversation/turns` | `TurnResponse` (202 accepted, 200 existing) | `TurnRequest`. A repeated `clientTurnId` returns the original turn, and the same id with a different body returns 409. `attachmentIds` must be finalized uploads. `what_i_wore` without `explicitLog` is read-only. `stopCurrent` means "Stop and send" |
| `GET /v1/conversation/messages?before=&limit=` or `?around=` | `ConversationPage` | Canonical Think transcript with `sourceChannel`, `clientTurnId`, `runId` and parts |
| `POST /v1/recall/search` | `RecallSearchResponse` | Date bounds, category, quotes with context, reversals, `coverage` watermark |
| `GET /v1/runs/{runId}` | `RunStatus` | Status, message, receipts, `pendingAction` |
| `GET /v1/runs/{runId}/events` | SSE (`text/event-stream`) | `id:` is the per-run sequence, `event:` the type, `data:` a full `RunEvent`. `Last-Event-ID` (or `?cursor=`) replays after it. An expired or unknown cursor gets a `snapshot` event first. Retention is 200 events per run. The stream follows the run for up to 25 s; `?follow=0` replays and closes |
| `POST /v1/runs/{runId}/cancel` | `CancelRunResponse` | Committed effects stay committed and are listed |
| `POST /v1/runs/{runId}/input` | `{ status, receipt, run }` | Native answer to a pending question; the same record an MCP retry resolves |
| `POST /v1/uploads`, `PUT /v1/uploads/{id}?t=`, `POST /v1/uploads/{id}/complete` | `UploadAuthorization`, `{ uploadId, receivedBytes }`, `UploadCompleteResponse` | Visual-wardrobe `MediaService`. The PUT is authorized by its signed token; Content-Length ≤ 25 MB is enforced before buffering |
| `GET /v1/media/{assetId}[?t=]` | image | Signed URL, or session without `t` |
| `POST /v1/studio/{choices,validate,suggest}` | `StudioChoices`, `StudioValidation`, `StudioSuggestion` | Visual-wardrobe `StudioService`; reads |
| `GET /v1/settings` | `SettingsResponse` | Plus `calendarId`, `styleDocuments`, `connectedAssistants` (`AssistantGrant[]`, Claude and ChatGPT separate), `connections` (health), `models`, `budget` |
| `GET /v1/style/current` | `StyleCurrentResponse` | Verbatim profile, version, SHA-256, rule counts. Edit with `edit_style_profile` + `baseVersion` |
| `GET /v1/connections` | `ConnectionsResponse` | Gmail and Calendar first (disconnected until the Google connection flow exists), owner-added MCP servers, and consumer assistant grants (`kind: 'assistant_grant'`, `client`) |
| `POST /v1/connections` | `Connection` (201) | `RegisterConnectionRequest`: HTTPS only, no private, loopback or metadata hosts, no credential in the URL. The secret is a Worker-secret name (`credentialSecretName`) |
| `POST /v1/connections/{id}/disconnect` | `DisconnectResponse` | `mgr_…` revokes a consumer MCP grant (D1 first, then the provider's KV grant); other ids disconnect an outbound connection |
| `GET /board[?date=]` | HTML | Private web board rendered from `Board.document` (`BoardDocument`). Access only, no script, `X-Frame-Options: DENY` |

Errors use `ApiError` (`{ schemaVersion, error: { code, message, details? } }`).

### Trips, pause, intake, returns, lifecycle, combinations, recovery, portability

These are service operations, not domain commands, but they run under the same policy. The owner comes from the authenticated principal, owner fields in a body are refused, and writes need `wardrobe:write`. Writes also accept an `Idempotency-Key` header: a repeat with the same body returns the stored result (`replayed: true`), and a different body with the same key is refused with 409. After every write that changes availability, the daily service's repair runs before the response (see *Repair timing*).

| Method and path | Returns (contract) | Notes |
| --- | --- | --- |
| `GET /v1/trips`, `GET /v1/trips/{tripId}` | `TripsResponse`, `TripDetail` | Items carry perceptible names and proposed, packed and unpacked quantities |
| `POST /v1/trips` | `TripDetail` (201; 200 when replayed) | `CreateTripRequest`. Nothing is packed |
| `POST /v1/trips/{tripId}/proposal` | `PackingProposalResponse` | A proposal only |
| `POST /v1/trips/{tripId}/packed` | `TripDetail` with `summary` | `PackingRequest` (`items?`, `occurredAt?`). Without items it packs the proposal. The owner's statement: packed units leave the home pool |
| `POST /v1/trips/{tripId}/unpacked` | `TripDetail` with `summary` | Unpacking is not washing |
| `POST /v1/commands` with `pause_service` / `resume_service` | `CommandReceipt` with Undo | `pause_service { startsOn?, resumeOn?, reason? }` suppresses the paused days' outfit events. `resume_service` ends the pause and prepares only the next useful board. Undo of either reverses it. A second open pause is a conflict |
| `GET /v1/service/pause` | `ServicePauseState` | |
| `GET /v1/orders` | `OrdersResponse` | Orders, lines (an arrival estimate is a prediction; `arrivedQty` is the owner's report) and sourced return deadlines |
| `GET /v1/returns[?status=all]` | `ReturnDeadlinesResponse` | Open deadlines, soonest first. Recording terms is `record_return_terms` |
| `POST /v1/intake/email/sync` | `EmailSyncResponse` | `EmailSyncRequest { query?, maxPages? }`: bounded Gmail receipt search through `EmailIntakeService`. 409 `gmail_not_connected` until Gmail is connected (tests install `FakeGmail` with `installTestGmail`) |
| `GET /v1/comfort[?garmentId=]` | `ComfortFeedbackResponse` | Reports are `record_comfort_feedback` commands |
| `GET /v1/projects`, `GET /v1/projects/{projectId}` | `LifecycleProjectsResponse`, `LifecycleProject` | Tailoring, sale, consignment, return, storage and repair. Changes are `open_lifecycle_project` / `advance_lifecycle_project` |
| `GET /v1/studio/combinations[?kind=saved\|plan&from=&to=&includeInactive=1]` | `SavedCombinationsResponse` | Save, plan and remove are commands |
| `POST /v1/auth/recovery-kit` | `RecoveryKitResponse` (201) | A one-time recovery code, shown once. It replaces any earlier code |
| `GET /v1/auth/recovery-kit` | `RecoveryStatus` | Whether a code is set up and when it was issued, the last recovery, failed attempts in 24 h and any pending collection. Never the code or its id |
| `GET\|POST /v1/auth/recovery-kit/collect/{transferId}?t=` | page / `RecoveryKitResponse` (201) | Collects a code an assistant asked for (see below). Signed-in owner only (Access or the app session), same-origin POST, one time, 15 minutes. `Accept: text/html` gets the pages |
| `POST /v1/auth/recover` | `RecoverResponse` | The dedicated recovery route. It needs a verified Access identity that is not yet linked to an owner, plus `RecoverRequest { credential }`. It binds the identity, revokes every earlier session and assistant grant (`sessions_valid_after`), and returns a replacement kit. 401 on a wrong or spent code, 429 when rate-limited |
| `POST /v1/export` | `garderobe-export/1` package | Checksummed and credential-free, including the Think transcript. When the transcript can't be read, the manifest says the export is incomplete |
| `GET /v1/export/downloads/{transferId}?t=` | the package as an attachment | The signed link from `export_data`. Needs the link and the owner's own sign-in (Access or the app session); an assistant token, another owner or a changed token is refused; 410 after 15 minutes. Each download is audited |
| `POST /v1/import` | `ImportResponse` | Verified package into an empty owner only: 409 for an owner with records, 422 for a tampered package. Imported grants and sessions follow the export/import services' rules. One import per owner: the empty-owner check and a claim row (`import_claims`, migration 0015) are a single conditional INSERT, so of two imports arriving together (HTTP or confirmed MCP `import_data`) exactly one runs and the other gets 409 `import_in_progress` or `invalid_state` before writing anything. Every write batch of the import is fenced on the claim (migration 0016): the same D1 batch fails as a whole unless this importer still holds its claim, and it refreshes the claim's heartbeat and write count. A claim can be taken over only if its importer has written nothing and been silent for 10 minutes; the importer it was taken from then writes nothing and gets 409 `import_superseded`. A package that fails verification releases the claim; a failed import that wrote anything keeps it (`failed`), so no other import is laid on top of partial rows |
| `POST /v1/import/packages`, `GET /v1/import/packages/{packageId}` | `StagedImportPackage` (201) | Stage a package (up to 50 MB) for an import the owner confirms later, from the app or an assistant. `verifyExport` runs first: a tampered or credential-bearing package is refused before it is stored. Kept privately in R2 for 24 hours |
| `GET /v1/account/transfers` | `AccountTransfers` | Exports, staged packages and recovery links with the audit trail (`account_audit`) |
| `GET\|POST /confirm/{runId}` | page | Access-protected confirmation page for a request an assistant made (the same pending record as `POST /v1/runs/{id}/input`). Same-origin POST |

**Today during a trip.** `GET /v1/today`, `garderobe_today` and the web board serve the trip-day board (`purpose: trip:<id>`) whenever a packed trip covers the date. `TodayResponse` adds `purpose` and `trip`. `POST /v1/today/prepare` prepares the trip-day board on those dates.

**Availability.** `GET /v1/wardrobe`, `GET /v1/items/{id}` and `garderobe_inventory` apply the composer's gates on top of hard eligibility, using the daily service's home context (`RecommendationService.context`, built without weather or calendar calls):
- units packed for a trip are not at home (label "Packed for a trip");
- a per-wear or single-day garment with no estimated clean unit is "In the wash", "At the laundry" or "Worn, not washed yet";
- a home laundry reset never washes a unit that was in a suitcase.

The item page's `estimate` is the same home estimate. Its `receipts` list every receipt that affected the garment: the garment itself, its counted wears (`daily_wear`), its stock lots and the wear observations naming it.

**Repair timing.** After a committed, non-replayed command from the app, the web or MCP, the daily service's `processEffects` runs with the same weather, calendar source, managed outfit calendar and `calendarId` as the scheduled workflow. It repairs the board and re-projects the Calendar event before the response, bounded at 5 s, after which it continues in `waitUntil`. The same happens after trip packing, email sync, and for runs whose assistant committed commands. The scheduled sweep remains the backstop.

**Deliberately not exposed.**
- **Locked-out account recovery is not available over MCP.** Signing in with a recovery code stays on `POST /v1/auth/recover` (spec section 15, "a recovery flow on the dedicated authentication route"). An assistant can only ask for a new code for an owner who is already signed in (below).
- **The scheduled phases** (`DailyService.sweep`, `runPhase`) stay scheduled work (section 9: the morning service must not depend on an app or chat request). The owner's explicit "prepare now" is `POST /v1/today/prepare`.

### Export, import and recovery from an assistant (owner request, 2026-09-29)

This deliberately departs from spec sections 15 and 16, which kept export, import and recovery app-only: the owner asked to reach them from Claude and ChatGPT. They go through the existing `garderobe_command` tool as three operations; there is no eighth tool. The safeguards (`src/api/portability.ts`, `src/mcp/pending.ts`):

| Operation | Scope and gate | What the assistant gets | Where the private material goes |
| --- | --- | --- | --- |
| `export_data {}` | `wardrobe:write`, then the owner's confirmation. A read grant gets a proposal | `ExportDownloadResult`: export id, table counts, completeness, checksum, `expiresAt` and `downloadUrl` | The package is written to private R2 (`private/exports/<owner>/<transfer>.json`). The link is an HMAC token bound to the owner, the transfer and a 15-minute expiry, and it also needs the owner's Garderobe sign-in, so the assistant or anyone reading the transcript cannot open it. Same `exportOwnerData` and no-credentials guarantee as `POST /v1/export` |
| `import_data { packageId }` | `wardrobe:write`, then the owner's confirmation naming the export | `McpImportResult`: tables, `importedAssistantGrants { count, status: revoked }`, `sessionsRecreated: 0`, `callingGrant` | The package never passes through the chat: the owner stages the file in Garderobe (`POST /v1/import/packages`, verified on arrival), and the assistant names it by `packageId` (`garderobe_inventory view=transfers`). The unchanged `importExport` runs: `verifyExport`, empty owner only, grants in the package arrive revoked, pending confirmations cancelled, no sessions or sign-in codes. **The calling grant stays active** with the scopes the owner gave it (it is the target owner's own current connection and the import changes neither the owner id nor the security instants). The package is deleted after import and cannot be imported twice |
| `issue_recovery_kit {}` | `wardrobe:write`, then the owner's confirmation | `RecoveryKitLink`: `collectUrl`, `expiresAt`, `codeIncluded: false` | Nothing is issued yet. The code is created only when the signed-in owner opens the one-time link in Garderobe and presses the button (same-origin POST); it appears on that page (or in the app's JSON) and nowhere else. Collecting it replaces the old code. `garderobe_inventory view=recovery` gives the status without the code |

Confirmation:
- **2026-07-28:** the `input_required` question (elicitation form) from the same pending-action flow as `dispose_item`, answered by the client's form; or natively in Garderobe (`POST /v1/runs/{id}/input` or `/confirm/{runId}`). The request state is also bound to the connection that asked, so another grant of the same owner cannot answer it.
- **2025-11-25 adapter:** the stateless adapter cannot carry a question to the client, so the tool returns `status: awaiting_owner` with `confirmation { prompt, confirmUrl, expiresAt }` and does nothing. The owner confirms on `/confirm/{runId}` (Access) or in the app; the same call with the same idempotency key then returns the result.
- `garderobe_run action=respond` refuses these operations (`owner_confirmation_required`): an assistant cannot answer for the owner.
- **File-supplied text in the import question (ADV-18):** the question the owner answers (the client form, the `awaiting_owner` prompt and `/confirm`) shows only a validated export id (`exp_` + 32 hex), the date of a valid `exportedAt`, and the file's owner name only when it is a plain single-line name of at most 40 characters and 5 words, marked “the file names its owner “…””. Anything else from the file is left out (`safeExportId`, `safeExportDate`, `safeFileName` in `portability.ts`).
- Questions expire after 10 minutes; declined and expired requests do nothing. A repeated call or retry with the same key returns the original result (`replayed: true`) with the same link; the same key with a different request is refused.

Audit: every step is written to `account_audit` with surface and grant (`link_issued`, `downloaded`, `staged`, `refused_at_staging`, `imported`, `refused`, `collected`). Run events, run results, pending actions and the audit trail carry the operation type and outcome only: never the package, a link token or a code. Tables: migration `0013_account_transfers.sql`.

## MCP tools (`src/mcp/server.ts`, schemas in `src/mcp/schemas.ts`)

The owner and scopes come only from the grant. No input schema has an owner field, and forged owner fields in a command are refused.

| Tool | Annotations (write grant / read grant) | Input → output |
| --- | --- | --- |
| `garderobe_today` | read-only, idempotent | `{ date? }` → `TodayResponse` (the same revision as `GET /v1/today`) |
| `garderobe_inventory` | read-only, idempotent | `{ view: items\|item\|history\|snapshot\|resolve\|trips\|trip\|orders\|returns\|projects\|combinations\|comfort\|pause\|recovery\|transfers, q?, category?, availability?, garmentId?, tripId?, phrase?, from?, to?, cursor?, limit? }` → `{ complete, total, nextCursor, counts, items, item, wears, resolution, records?, asOf, sources }` |
| `garderobe_recommend` | read-only, open-world (weather fetch) | `{ date?, count?, brief?, occasion?, include?, exclude? }` → validated preview options + `BoardDocument`; the prepared board is unchanged |
| `garderobe_command` | destructive, idempotent / read-only | `{ idempotencyKey, command?: DomainCommand, operation?: create_trip\|propose_packing\|mark_packed\|mark_unpacked\|sync_email\|export_data\|import_data\|issue_recovery_kit, expectedVersions? }` (exactly one of `command` and `operation`) → `{ status: executed\|proposal\|declined\|expired\|awaiting_owner, receipt, proposal, runId, operation?, confirmation? }`. A read grant gets a proposal and nothing changes. Operations share the HTTP routes' idempotency record |
| `garderobe_ask` | destructive, open-world / read-only | `{ text, clientTurnId?, conversation?, waitSeconds? }` → `{ status, runId, clientTurnId, conversation, answer, receipts, blocked, notice? }`. Same Think conversation (channel `mcp`, with the grant's scopes). `notice` (also on the HTTP `TurnResponse`, and kept when a turn is resent) says a pasted recovery code or token was removed before storage (ADV-17), and its title leads the text content |
| `garderobe_research` | open-world | `{ kind: product\|size\|verdict\|topic, url?, size?, colour?, maker?, category?, description?, question?, waitSeconds? }` → `{ kind, status, result, runId, next? }`. A topic waits up to `waitSeconds` (default 25) and returns `status: answered` with `result.answer`. Past that it returns `status: running` with `next = { tool: garderobe_run, arguments: { runId, action: status }, instruction }`, and the same instruction in the text (both protocol revisions; the server has no MCP task support to hand this to) |
| `garderobe_run` | idempotent | `{ runId, action: status\|respond\|cancel, choice? }` → `RunStatus`. When the run has finished, the text content carries the answer; while it runs, the text repeats the call to make |

Resource: `garderobe://style/current` (the verbatim profile).

**input_required (MRTR).** `dispose_item`, `lift_restriction`, `edit_style_profile`, `undo`, `reconcile_quantity` and `advance_lifecycle_project` ask for confirmation first. `select_option` asks which shoe when the option has two. The first call stores a `pending_actions` row with the full envelope (idempotency key, expected versions) and a hash of the arguments. It returns `resultType: input_required` with an elicitation and an HMAC-signed `requestState` bound to the owner, the record and the argument hash (`MCP_STATE_SECRET`). The retry executes the stored envelope exactly once. A replayed retry returns the original receipt (`replayed: true`). An altered request, another owner's state or an expired record (10 minutes) executes nothing. A native answer (`POST /v1/runs/{id}/input`) resolves the same record.

## Inbound OAuth (Claude, ChatGPT)

`/authorize` on the MCP origin is Garderobe's consent page, protected by Access (add an Access path rule for it on the MCP hostname). It shows the client name and CIMD domain, the redirect host (with a loopback warning) and the two capabilities, Read your wardrobe (`wardrobe:read`, required) and Make changes (`wardrobe:write`). The owner may approve less than requested. Approval is bound to the signed-in owner with an HMAC-signed binding plus the provider's browser-bound consent handle, and it records a D1 `mcp_grants` row (client kind classified from the redirect or CIMD host: `claude.ai`/`claude.com`/`anthropic.com` → claude, `chatgpt.com`/`openai.com` → chatgpt). A reconnect of the same client and redirect replaces the earlier grant.

Tokens: access 15 minutes, refresh rotating with a 90-day idle lifetime. Refresh re-checks the D1 grant and never widens scope. Disconnect bumps the grant version and revokes the provider grant.

## Running locally against the owner's data

```sh
cd garderobe
npm install
npm run seed:demo                                            # owner profile, rules, May 2026 CSV, owner-asserted additions
npm run dev:auth --workspace @garderobe/backend -- setup      # local Access key -> backend/.dev.vars; links the seeded owner
npm run dev:local --workspace @garderobe/backend             # wrangler dev --local on http://localhost:8787
# in another shell:
npm run dev:auth --workspace @garderobe/backend -- prepare    # compose + publish today's board now
npm run dev:auth --workspace @garderobe/backend -- mcp-grant claude write   # real consent + PKCE; token saved to backend/.wrangler/dev-mcp-grant.json
npm run mcp:smoke --workspace @garderobe/backend             # MCP SDK client: negotiates 2026-07-28, lists and calls all seven tools
npm run mcp:smoke --workspace @garderobe/backend -- --legacy # the 2025-11-25 adapter
npm run dev:auth --workspace @garderobe/backend -- assertion  # an Access assertion for curl: -H "cf-access-jwt-assertion: $A"
npm run dev:auth --workspace @garderobe/backend -- native     # native PKCE flow -> app bearer token
```

Any MCP client can connect to `http://localhost:8787/mcp` with the printed bearer token, or run its own OAuth flow: discovery at `/.well-known/oauth-protected-resource/mcp`, with the consent page needing the local Access assertion. Use `dev:local` rather than `dev`: plain `wrangler dev` tries to log in to Cloudflare for the remote AI binding. Locally the assistant uses the deterministic fake model (no `AI_GATEWAY_ACCOUNT_ID`), so `garderobe_ask` answers are placeholders. Weather is live Open-Meteo unless `WEATHER_PROVIDER=fake:<scenario>` (local only).

**Local Access stand-in.** The local development machine has no Cloudflare Access application. `dev:auth setup` generates an RSA key, puts its public JWKS in `.dev.vars` (`ACCESS_JWKS_JSON`) and signs assertions with the configured issuer and audience. The Worker verifies them through exactly the same code path as real Access assertions. Deployed environments leave `ACCESS_JWKS_JSON` unset and fetch `<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`.

## Deployment configuration (dev environment item)

Vars: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (the app and board application AUD tags), `APP_HOSTNAMES`, `APP_ORIGIN`, `MCP_ORIGIN` (HTTPS), `NATIVE_REDIRECT_URIS`. Secrets: `MCP_STATE_SECRET` (≥ 32 chars; required outside `ENVIRONMENT=local`), `MEDIA_URL_SIGNING_KEY`. Access applications: the app/API hostname (all paths) and `/authorize` on the MCP hostname. Leave `/mcp`, `/.well-known/*` and `/oauth/*` on the MCP hostname outside Access; the OAuth provider protects them. In production, Access Managed OAuth replaces `/v1/auth/native/*` for the iOS client; this module is the Worker-side implementation of the same public-client contract. The dev environment that applies all of this is in `deploy/` (`deploy/README.md`).

## Tests

`backend/test/api/*.test.ts` run in workerd on local D1 and go through `exports.default.fetch` (the real Worker entry, OAuth provider included):

- `auth.test.ts`: Access verification, spoofing, unknown and disabled subjects, native PKCE, refresh rotation and replay, sign-out.
- `http-api.test.ts`: every endpoint on the owner's data, contracts parsed.
- `conversation.test.ts`: turns, transcript, recall, SSE replay and snapshot, cancel, isolation.
- `mcp.test.ts`: the real `@modelcontextprotocol/client` 2.2.0 over HTTP, real OAuth grants, all tools, MRTR replay, altered, declined and expired questions, the legacy adapter, header validation, revocation.
- `surface.test.ts`: laundry and packed availability, item receipts, trips and the trip-day board on Today and MCP, immediate board and Calendar repair, pause/resume with Undo, recovery and refused refresh, export/import, the read routes, email sync, and the four iOS shapes (`SwapCandidates`, `RunInputRequest`/`RunInputResponse`, `UploadReceiveResponse`, `PrepareBoardResponse`).
- `mcp-account.test.ts`: export, import and recovery through `garderobe_command` on both 2026-07-28 and the 2025-11-25 adapter (14 tests each): read-only proposals, the confirmation question or page, declined, unanswered, expired and assistant-answered confirmations, replay and key reuse, another owner's or connection's request state, the signed download link (no auth, assistant token, other owner, tampered, expired), staging refusal of tampered and resealed credential-bearing packages, import into an empty owner (revoked package grants, no sessions, calling grant active, no second import), refusal into an occupied owner, recovery status without the code, one-time collection (assistant token, other owner, cross-site, reuse, expiry), and a scan of runs, events, pending actions and audit for the package, link tokens and codes.

Test-only stand-ins: a locally generated RSA key stands in for the Access team key; `FakeWeatherProvider` stands in for Open-Meteo and no calendar is connected (`installApiTestOverrides`); the deterministic fake model stands in for AI Gateway inference.
