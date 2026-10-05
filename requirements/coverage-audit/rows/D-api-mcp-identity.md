# Coverage audit part D — backend responsibilities, API and MCP contracts, identity and recovery
Audited at commit 8445a1e.

## Summary

This part covers 168 checklist rows: 50 in section 4 (S04), 69 in section 13 (S13) and 49 in section 15 (S15). The verdicts are 144 verified, 24 weaker and 0 unsupported. Of the 168 rows, 121 carry the status implemented, 35 partial, 8 blocked and 4 open, so 47 rows are not fully implemented by their own statement; those rows are verified where their stated limitation is accurate and are still listed as gaps. Twenty of the 24 weaker rows carry the status implemented and four carry partial. All 16 `/v1/...` endpoints of specification lines 795-810 are registered in `apps/worker/src/routes` and each has at least one test through the real Worker; all seven MCP tools of lines 833-839 are registered in `apps/worker/src/mcp/server.ts` and each is called by at least one test. The largest findings are that no Cloudflare Workflow exists anywhere in the build, that the event stream never emits `outfit_board` or `product_comparison`, that `garderobe_ask` returns no cited evidence or structured objects, that the outbound MCP client is a hand-written JSON-RPC client that does not send the 2026-07-28 routing headers, and that several OAuth validations (inbound PKCE, audience, the revocation endpoint, the one-time consent transaction) have no negative test. This audit was done by reading files only; no test was run, so a verdict of verified means the cited code and test exist and the test body asserts the behaviour, not that the test passes. Every stand-in the tests use (test-signed Access assertions, the fake model, the fake AI Search index, the labelled Google and MCP fixtures) is named in the affected rows.

## Row verdicts

Paths are relative to `wardrobe-rebuild/`. "Named test seen" means the test title exists in the cited file and I read its title but not every line of its body.

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S04-001 | implemented | verified | `packages/assistant/package.json:17` pins `@cloudflare/think` 0.19.0 and `packages/assistant/src/agent/assistant.ts:18` extends Think; `conversation.test.ts` "keeps the original transcript, the turn record and its receipts across eviction of the actor" exists. The model is the labelled fake. |
| S04-002 | partial | verified | The stated limitation is accurate: no Workflow class or binding exists (`apps/worker/wrangler.jsonc:16-31` has none; the only mention is a comment at `packages/assistant/src/jobs/runner.ts:140`). The row remains a gap. |
| S04-003 | implemented | verified | A search for "arcwell" finds it only in requirement manifests, not in code. The cited test `packages/domain/test/import.test.ts` does not address this requirement. |
| S04-004 | partial | verified | `apps/worker/src/index.ts:53` sends every request through the OAuth provider to the router or the MCP handler; `surfaces.test.ts` "serves the same board revision to MCP as to the app" compares board and option IDs. Access is a test-signed assertion, as the row says. |
| S04-005 | implemented | verified | Named tests seen in `packages/daily/test/board.test.ts` and `weather-service.test.ts`; I did not read `packages/daily/src/context.ts`. |
| S04-006 | implemented | weaker | `packages/assistant/test/search-projection.test.ts:31` and `memory.test.ts` run against a "FAKE AI Search index"; the row is about checks against the per-user AI Search instance, so the status should be partial, as it is on S12-030 for the same component. |
| S04-007 | partial | verified | Only one queue exists (`MEDIA_QUEUE`, `wrangler.jsonc:22-25`) and `apps/worker/src/index.ts:80-83` consumes media only; index projection runs from the cron sweep. The limitation is as stated. |
| S04-008 | implemented | verified | `apps/worker/src/routes/core.ts:154-158` and `mcp/server.ts:309` both call `app.service.execute`; `mcp.test.ts` "executes a typed command through the same command service" asserts the API reads the same stored receipt. |
| S04-009 | partial | verified | `apps/worker/src/index.ts:57-78` runs the due phases from a cron handler; no Workflow is started. The limitation is as stated and the row is a gap. |
| S04-010 | partial | verified | `packages/assistant/src/connections/mcp.ts:1-17` is the build's own JSON-RPC client; no import of the Agents MCP client exists in `packages/assistant/src`. The deviation is stated in the row. |
| S04-011 | partial | verified | `adapters-jobs.test.ts:114` runs Browser Run "over a FAKE binding"; Code Mode and Sandbox are absent, as the row says. |
| S04-012 | implemented | verified | `packages/assistant/src/client.ts:66` addresses the actor by `principal.userId`; named tests seen. |
| S04-013 | implemented | verified | `turn-control.test.ts:217` asserts one transcript holding both `ios` and `mcp` channels. |
| S04-014 | implemented | verified | `turn-control.test.ts:70-90` asserts a separate run identity, separate model contexts and one result card. |
| S04-015 | implemented | verified | `turn-control.test.ts` "a slow investigation does not hold up the conversation, and only one result card enters the continuous transcript". Morning delivery during a crawl is not exercised there. |
| S04-016 | implemented | verified | `conversation.test.ts` "returns the same turn for a retransmitted submission and rejects the same ID with a different body". |
| S04-017 | implemented | weaker | Stop and queued turns are tested in the backend, but "Stop and send" exists only as `ios/GarderobeKit/Sources/GarderobeKit/Features/Conversation/ComposerModel.swift:250` and no test in `ios/GarderobeKit/Tests` references `stopAndSend`; the Waiting state of the composer is not asserted in a cited test. |
| S04-018 | partial | verified | The limitation is as stated; the cited test is the foundation test of effects and outbox. |
| S04-019 | implemented | verified | `turn-control.test.ts` "simultaneous iOS and MCP messages get stable separate turns, run one after the other". |
| S04-020 | implemented | verified | Research runs in a task actor (`turn-control.test.ts:37`). No Workflow exists, so only the "bounded task actors" branch is implemented. |
| S04-021 | implemented | verified | `packages/assistant/test/commands.test.ts` "a background job reports coverage honestly, delivers its result once" and `connections-maintenance.test.ts:143-153`. |
| S04-022 | implemented | verified | `connections-maintenance.test.ts:150-152` asserts delivery without inference and exactly one card. I found no test that delivers a card while another response is streaming. |
| S04-023 | partial | verified | `CommandCenterTests.swift:12` exists; the SwiftUI surface was not run on a device, as the row says. |
| S04-024 | implemented | verified | `turn-control.test.ts` "Stop on a running turn keeps what was already committed, reports it, and dispatches nothing further". |
| S04-025 | implemented | verified | The four proofs map to named tests in `conversation.test.ts`, `turn-control.test.ts` and `journeys.test.ts:280`. |
| S04-026 | implemented | verified | `packages/domain/test/command-service.test.ts` "simultaneous conflicting commands both land through internal rebase; quantities stay exact". |
| S04-027 | implemented | verified | Named tests seen in `conversation.test.ts` and `inference.test.ts`; the model is the labelled fake. |
| S04-028 | implemented | verified | `memory.test.ts` "compacts the working context through the model service while keeping every original message and the complete profile". |
| S04-029 | implemented | verified | `command-service.test.ts` "returns a verified receipt that matches the stored ledger state". |
| S04-030 | partial | verified | The limitation (stand-in queue messages and workflow step) is as stated; `adapters-jobs.test.ts:374`. |
| S04-031 | partial | verified | The deviation from the Agents MCP client is as stated. |
| S04-032 | implemented | verified | `turn-control.test.ts:78-83` asserts the conversation has no workspace tools and the task has file tools without a shell. |
| S04-033 | partial | verified | `adapters-jobs.test.ts:114` uses a fake binding, as stated. |
| S04-034 | blocked | verified | No use of `@cloudflare/sandbox` exists in the code. Not implemented. |
| S04-035 | implemented | verified | `assistant.ts:227` sets `sendReasoning = false` and `assistant.ts:317` overrides `configureSession`. No test asserts the reasoning flag; `conversation.test.ts:14` asserts the mandatory context. |
| S04-036 | implemented | weaker | `surfaces.test.ts:216` asserts the stream contains no "reasoning", but the fake model never produces a reasoning part (`packages/assistant/src/testing/fake-model.ts` has no reasoning output), so the assertion cannot fail. |
| S04-037 | partial | verified | `packages/assistant/package.json:16-25` pins exact versions; no release record exists and the Tests cell is empty, as stated. |
| S04-038 | partial | verified | The limitation is as stated. |
| S04-039 | implemented | verified | `command-service.test.ts` "same idempotency key and body returns the previous receipt without a second effect"; `journeys.test.ts:310` covers recovery reading the existing receipt. |
| S04-040 | partial | verified | The limitation is as stated. |
| S04-041 | implemented | verified | `apps/worker/test/commands.test.ts` executes commands over HTTP with no model enabled. |
| S04-042 | implemented | verified | Named tests seen; I did not read `packages/assistant/src/tools/runtime.ts`. |
| S04-043 | implemented | verified | `command-service.test.ts` "a status change can never create an item". The restriction and calendar clauses are asserted in `isolation-style-platform.test.ts:127` and `:330`, which the row does not cite. |
| S04-044 | implemented | verified | `packages/daily/test/board.test.ts:305` "still hands the model the full mandatory context". |
| S04-045 | implemented | verified | The code is TypeScript Workers throughout; the cited test does not address the requirement. |
| S04-046 | blocked | verified | `@cloudflare/codemode` appears only in `package-lock.json` as a transitive dependency. Not implemented. |
| S04-047 | blocked | verified | Nothing exists. Not implemented. |
| S04-048 | blocked | verified | Nothing exists. Not implemented. |
| S04-049 | open | verified | No Code or Tests cited. Not evidenced. |
| S04-050 | open | verified | No Code or Tests cited. Not evidenced. |
| S13-001 | implemented | verified | Routes answer with `json(...)` of contract objects (`apps/worker/src/routes/core.ts:164-267`); `routes.test.ts:8` checks the mounted routes equal the published manifest. The web board and consent page are HTML built by code, not by a model. |
| S13-002 | implemented | verified | `routes/daily.ts:109`; `surfaces.test.ts:57` asserts board revision and the freshness entries. Wardrobe freshness is always reported "fresh" by construction (`routes/daily.ts:31`). |
| S13-003 | implemented | verified | `routes/core.ts:184`; `commands.test.ts:32` and `:45` assert total, completeness and a cursor walk that sees every garment once. |
| S13-004 | implemented | verified | `routes/core.ts:196`; `commands.test.ts:64` asserts detail, availability and media state. The test does not assert dates on the evidence. |
| S13-005 | implemented | verified | `routes/core.ts:225`; `commands.test.ts:97` and `:125` assert the receipt, replay and key reuse; a stale expected version is refused in `surfaces.test.ts:92`. |
| S13-006 | implemented | verified | `routes/conversation.ts:66`; the cited test covers turn ID and text; attachment IDs and attached references are exercised in `assistant-work.test.ts:60` and `:70`, which the row does not cite. |
| S13-007 | implemented | verified | `routes/conversation.ts:71`; `assistant-work.test.ts:112` covers surrounding messages and channel. I found no Worker test that pages with `before` or `after`. |
| S13-008 | implemented | weaker | `surfaces.test.ts:288-292` only asserts that `hits` is an array and that a watermark and caveat exist; no hit, date bound, entity query or evidence link is asserted through the endpoint. Deeper recall tests exist in `packages/assistant/test/memory.test.ts` but are not cited. |
| S13-009 | implemented | verified | `runs.ts:188`; `surfaces.test.ts:175-183` polls the run after the fact and `export.test.ts:78` reads an export run. |
| S13-010 | implemented | verified | `runs.ts:286-325`; `surfaces.test.ts:199-214` asserts ordered IDs and resumption after `Last-Event-ID`. Every Worker test reads with `follow=false`; the live following loop is not exercised. |
| S13-011 | implemented | verified | `runs.test.ts:163` asserts cancelled state, the committed receipts and that the late model answer is not delivered. The model is the labelled fake. |
| S13-012 | implemented | verified | `routes/media.ts:40`; `surfaces.test.ts:326`. |
| S13-013 | implemented | verified | `routes/media.ts:65`; `surfaces.test.ts:350` asserts disguised bytes are refused and an unfinalized upload yields no asset. |
| S13-014 | implemented | verified | `routes/connections.ts:18`; `connections.test.ts:73` asserts the secret is absent from responses and the database. |
| S13-015 | implemented | verified | `connections.test.ts:36` and `:195`; the remote services are labelled fixtures, as the row says. |
| S13-016 | implemented | verified | `connections/service.ts:644-674`; `connections.test.ts:372` asserts revocation outcome and `:175-178` that the next call is refused. "Clears sessions" has no direct assertion. |
| S13-017 | implemented | weaker | `routes/core.ts:82-100` returns `inference`, but swallows a failure to `null` (`core.ts:91-98`), and no test in the repository asserts the effective model profile or budget in the settings response (search for `settings.inference` in tests finds nothing); `commands.test.ts:77` asserts only profile hash, timezone and API version. |
| S13-018 | implemented | verified | `commands.test.ts:97-110` asserts command ID, outcome, summary and affected entities; `runs.test.ts:46-48` asserts a running recommendation returns no options. External-effect state is asserted only in `packages/domain/test/isolation-style-platform.test.ts:330`. |
| S13-019 | implemented | weaker | `outfit_board` and `product_comparison` exist only in the contract (`packages/contracts/src/ext/api.ts:715,739-740`) and the iOS parser; the assistant's event enum lacks them (`packages/contracts/src/ext/assistant.ts:129`) and no source file emits them. The cited test sees `run_started`, `text_delta` and `run_finished` only. |
| S13-020 | implemented | verified | `runs.test.ts:140` asserts a snapshot for an expired cursor, exact replay for a recent cursor and a bounded event count. The run in that test is an API-owned run fed synthetic events. |
| S13-021 | partial | weaker | The row says the API forwards validated board events, but no board event exists (see S13-019); the cited test `surfaces.test.ts:230` checks a receipt event and does not exercise streamed prose about an uncommitted change. |
| S13-022 | implemented | verified | `ConversationTests.swift:12` and `SupportTests.swift:73` exist. |
| S13-023 | implemented | verified | `BoundaryTests.swift:327` and `TodayModelTests.swift:36` exist. |
| S13-024 | implemented | verified | `CommandCenterTests.swift:94,125,146` and `OwnerMorningJourney.swift:181` exist; not run on a device, as the row says. |
| S13-025 | implemented | verified | `lanes/assistant.ts:55-111` projects turn records and events without copying them; `surfaces.test.ts:199-214`. |
| S13-026 | partial | verified | `surfaces.test.ts:186-190` asserts a retransmitted turn is replayed and a reused ID is refused; `ConversationTests.swift:69,190` exist. |
| S13-027 | blocked | verified | Nothing was run on a physical iPhone. Not implemented as evidence. |
| S13-028 | implemented | weaker | `McpAskOutput` (`packages/contracts/src/ext/api.ts:1064-1073`) and `askOutput` (`mcp/server.ts:108-110`) return run ID, state, answer text, receipts, proposals and pending input; cited evidence (sources) and structured objects (boards, comparisons) are not returned. |
| S13-029 | implemented | verified | `surfaces.test.ts:69-75` compares board ID, revision and option IDs between MCP and the API. |
| S13-030 | implemented | weaker | The row itself says a long recommendation runs only for the `waitUntil` lifetime and a lost run is failed, not resumed (`routes/daily.ts:88-99`, `runs.test.ts:90`). That is not the durable run of the requirement, so the status should be partial. |
| S13-031 | implemented | verified | `mcp.test.ts:56-68`; availability, history and item views are exercised in `tests/journeys/test/14-mcp-assistant.test.ts:188-244`, not in the cited test. |
| S13-032 | implemented | verified | `mcp.test.ts:79-101` asserts the receipt equals the one the API serves and that a retry is replayed. |
| S13-033 | implemented | verified | `runs.test.ts:250-281` asserts sources and comparison read from records. The model is the fake, as stated, and the verdict is `null` in every test I found. |
| S13-034 | implemented | verified | `runs.test.ts:205-246` covers status, respond and cancel, and that another owner's connection is refused. |
| S13-035 | implemented | verified | `mcp/handler.ts:99` builds the principal from the grant; `mcp.test.ts:120` asserts a `userId` argument is rejected. |
| S13-036 | implemented | verified | `surfaces.test.ts:254-286` and `mcp.test.ts:130-144`. A write-enabled connection does not act under the same policy as the app: most typed commands wait for the owner (`mcp/server.ts:285-308`), which is stricter than the row's wording. |
| S13-037 | implemented | verified | `mcp.test.ts:40-54` asserts annotations of two tools and an output schema on every tool. |
| S13-038 | implemented | weaker | The server uses `@modelcontextprotocol/server` 2.0.0 directly (`mcp/handler.ts:5`); `apps/worker/package.json` has no `agents` dependency, so it is not "through the Cloudflare Agents release". The client half is the hand-written `McpHttpClient` (`packages/assistant/src/connections/mcp.ts:118-135`), not SDK v2, and it sends no `Mcp-Method` or `Mcp-Name` header. |
| S13-039 | implemented | verified | `mcp.test.ts:284-290`. |
| S13-040 | implemented | verified | The scheduled handler (`index.ts:57-78`) has no MCP dependency. |
| S13-041 | implemented | verified | `mcp/handler.ts:126-140` uses `@cloudflare/workers-oauth-provider` 1.2.1; token props carry only user and grant IDs (`mcp/consent.ts:15-18,139`). No test asserts the absence of a Google token. |
| S13-042 | partial | weaker | The note says revocation is tested, but the only check of the OAuth revocation endpoint is that the metadata names one (`mcp.test.ts:33`); no test posts a revocation request. Revocation is tested only as the owner's Disconnect. Client metadata documents are untested, as stated. |
| S13-043 | implemented | verified | `mcp.test.ts:322-341` and `auth.test.ts:74-80`. |
| S13-044 | implemented | verified | `mcp.test.ts:304-320` asserts the client name and host on the page and that a denial records no grant. |
| S13-045 | implemented | weaker | Only the redirect URI has a negative test (`mcp.test.ts:337-340`). I found no inbound test with a wrong PKCE verifier, a wrong resource or audience, or a wrong issuer; `code_verifier` appears in tests only for outbound connections. |
| S13-046 | implemented | verified | `mcp/handler.ts:14-15,133-135`; `mcp.test.ts:343-352` asserts rotation and `expires_in` 900. The 90-day limit is configured, not tested. |
| S13-047 | partial | verified | `mcp.test.ts:294-302`; `ProposalTests.swift:11` exists. Phone-browser reconnection was not exercised, as stated. |
| S13-048 | implemented | verified | `mcp/grants.ts:146-159`; `mcp.test.ts:373-382` revokes only the D1 row and expects 401. |
| S13-049 | blocked | verified | Nothing was run against a deployed server or real clients. Not implemented as evidence. |
| S13-050 | implemented | verified | The SDK client is pinned to 2026-07-28 (`src/testing/index.ts:331`) and `mcp.test.ts:281` asserts the grant recorded that protocol. |
| S13-051 | partial | verified | No tool returns `input_required`; the row says so. The MRTR requirement is not implemented. `api.ts:120` and `api.ts:671` still describe an MCP `input_required` record. |
| S13-052 | implemented | weaker | `mcp.test.ts:250-265` asserts only that some error is returned for mismatched headers; it has no matching-headers control and no error code, so it would pass for any failure. |
| S13-053 | implemented | verified | `mcp/server.ts:130` sets private cache hints and `connections.test.ts:216-219` tests a forged issuer. The cache hints are not asserted by a test. |
| S13-054 | partial | verified | All five cited tests exist and assert the replacement path; no MRTR round exists, as stated. |
| S13-055 | implemented | weaker | The cited test "asks first, and executes exactly once when the owner confirms" does not exist in `apps/worker/test/mcp.test.ts` (no match for "asks first" in the test directory). The shared pending record is shown by the uncited `runs.test.ts:205-216`. |
| S13-056 | implemented | verified | `mcp.test.ts:267-282` asserts the recorded protocol per grant. The adapter is the SDK's stateless legacy mode (`mcp/handler.ts:33`). |
| S13-057 | partial | weaker | The note covers the server only. The Garderobe client has no 2026-07-28 test: the fixture records only the `Mcp-Protocol-Version` header (`src/testing/vitest-config.ts:86`) and the client sends no routing headers or `_meta` envelope (`packages/assistant/src/connections/mcp.ts:133-134`). |
| S13-058 | partial | verified | The deviation from the Agents MCP client is as stated. |
| S13-059 | implemented | verified | Only HTTPS endpoints are accepted (`connections.test.ts:36-62`); no stdio transport exists. No test names stdio. |
| S13-060 | implemented | weaker | The connection tables (`migrations/0200_assistant_core.sql:491-512`, `0202:10`, `0300_api_identity.sql:199-221`) hold endpoint, issuer, credential reference, protocol, tools, namespace, digest and health, but no transport, data-classification or budget field; a search for "dataClass" or "classifications" in `packages/` finds nothing. |
| S13-061 | implemented | weaker | Refresh uses a version check (`connections/service.ts:807-815`), but `connections.test.ts:391-400` makes two sequential calls; no test runs two refreshes at once. |
| S13-062 | implemented | verified | `connections.test.ts:112-120` and `:256-261`. |
| S13-063 | implemented | weaker | Limits exist in code (`packages/assistant/src/connections/mcp.ts:33-34,119-122,143`), but I found no assertion on the response-size limit or the timeout in the two cited test files. |
| S13-064 | implemented | weaker | Namespacing is tested (`test/research/web/connectors.test.ts:118`), but I found no test in which a connected server offers a tool named `record_wear` or a built-in tool name. |
| S13-065 | implemented | verified | `assistant.ts:232` sets `includeMcpTools = false`. The cited test asserts the tool list contains `record_wear` and not `bash`; it does not connect an MCP server. |
| S13-066 | implemented | verified | `adapters-jobs.test.ts:221` "describes a connection's tools on demand without enabling anything". |
| S13-067 | implemented | verified | `connectors.test.ts:97` and `connections.test.ts:145` assert the provider-side research tool stays disabled. |
| S13-068 | implemented | verified | `connections.test.ts:36-62` and `packages/assistant/test/research/web/url.test.ts`. |
| S13-069 | implemented | verified | `connections.test.ts:64-69` and `:73-101`. |
| S15-001 | partial | verified | `migrations/0001_foundation.sql:21-38` defines `users` and `auth_identities` with primary key (issuer, subject); `apps/worker/scripts/seed-local.ts:41` creates the user before the import. |
| S15-002 | implemented | verified | `auth/session.ts:49-56` looks identities up by issuer and subject only; `auth.test.ts:59-64`. |
| S15-003 | implemented | verified | `packages/domain/test/isolation-style-platform.test.ts:27` uses two synthetic owners with colliding garment IDs; admission is by invitation only (`routes/identity.ts:24`). |
| S15-004 | partial | verified | `auth/access.ts:56-92` verifies signature, issuer, audience and expiry; `auth.test.ts:21-48`. Access is a test signing key, as stated. |
| S15-005 | implemented | verified | `identity.test.ts:30-52` covers wrong, reused and expired invitations; `:64-75` covers the link ticket. |
| S15-006 | partial | verified | `BoundaryTests.swift:104-191` exists; `ios/App/Garderobe/Platform/Platform.swift:97-116` holds the `ASWebAuthenticationSession` code, which was not run. |
| S15-007 | blocked | verified | Keychain storage and the real refresh period were not exercised. Not implemented as evidence. |
| S15-008 | partial | verified | `auth.test.ts:90-103`; `wrangler.jsonc:15` sets `workers_dev` false for the local configuration only. |
| S15-009 | implemented | verified | `auth.test.ts:82-86` asserts an Access assertion is refused as an MCP credential; consent is an `owner` route (`mcp/consent.ts:105`). |
| S15-010 | partial | verified | `routes.test.ts:8-13` compares mounted and published routes but excludes the provider-owned routes from the comparison (`routes.test.ts:9-10`); `router.ts:64-66` refuses Access routes on another hostname. |
| S15-011 | implemented | verified | `connections.test.ts:315-328` sends another owner's valid Access headers with an expired state and is refused. |
| S15-012 | implemented | weaker | The transaction exists (`mcp/consent.ts:110,135-136`), but no test replays a consent handle or tampers with the form. The granted scopes are read from the form (`consent.ts:134`), and the page offers the write box even when it was "not requested" (`consent.ts:74`), so the grant is not bound to the capabilities the client requested. |
| S15-013 | implemented | weaker | Discovery, refresh, SSE and callback each have a test, but the revocation endpoint on the MCP hostname is never called by a test (see S13-042); revocation is tested only through the app's Disconnect. |
| S15-014 | implemented | verified | Every table I sampled carries `user_id` (for example `0300_api_identity.sql:265-273`, `0200_assistant_core.sql:241-254`). No test enumerates the schema; the cited test is behavioural. |
| S15-015 | implemented | verified | For example `0300_api_identity.sql:272` has a compound foreign key (user_id, export_id). Sampled, not exhaustively checked. |
| S15-016 | implemented | verified | `isolation-style-platform.test.ts:82` and `apps/worker/test/commands.test.ts:155-178`. |
| S15-017 | implemented | verified | `packages/daily/test/service.test.ts:153` "a disabled account runs nothing". |
| S15-018 | implemented | verified | `search-projection.test.ts:94` exists. The actor name is the user ID alone (`packages/assistant/src/client.ts:66`); the environment is separated by the binding, not the name. |
| S15-019 | partial | verified | The limitation is as stated. |
| S15-020 | implemented | verified | `connections-maintenance.test.ts:128` "...rechecks the owner's account". |
| S15-021 | implemented | verified | `identity.test.ts:79-85` and `erasure.test.ts:83,143`. AI Search deletion is not exercised, as stated. |
| S15-022 | partial | verified | `connections.test.ts:384-386`; no test disables an account and runs the sweep in this workstream, as stated. |
| S15-023 | partial | verified | `connections.test.ts:268-290` asserts state, PKCE, offline access and scopes against the labelled Google fixture. |
| S15-024 | partial | verified | The cited check is a contract validator; no test in `ios/GarderobeKit/Tests` calls `connectGoogle`, `reconnect`, `disconnect` or `setCapability`. |
| S15-025 | blocked | verified | Tested only against the fake Google API, as stated. Not evidenced against Google. |
| S15-026 | open | verified | No Code or Tests cited. Not evidenced. |
| S15-027 | open | verified | No Code or Tests cited. Not evidenced. |
| S15-028 | partial | verified | `connections.test.ts:86-92` and `export.test.ts:173-186`. |
| S15-029 | implemented | weaker | The first clause has a test (`adapters-jobs.test.ts:273`), but the model registry records only a `provider` per profile (`packages/assistant/src/inference/registry.ts:15`); a search for "dataClass" or "classifications" in `packages/` finds no record of which providers may receive which data class. |
| S15-030 | implemented | verified | Named tests seen (`connectors.test.ts:143,152`; `corpus-adversarial.test.ts`); the model is the fake. |
| S15-031 | implemented | verified | `packages/assistant/test/research/web/url.test.ts:22-78`. |
| S15-032 | implemented | verified | `adapters-jobs.test.ts:175`; the Worker schedule is tested in `apps/worker/test/assistant-work.test.ts:252`, which the row does not cite. Probes are fakes. |
| S15-033 | implemented | verified | `connections.test.ts:181-186` and `:402-410`. |
| S15-034 | partial | weaker | `routes/identity.ts:78-84` reports today's board and whatever projection state it has, not the last confirmed projection, and nothing when today has no board. The cited `surfaces.test.ts:426-432` asserts neither field, no test anywhere asserts `lastCalendarProjection`, and no iOS test references `RecoveryStatusModel`. |
| S15-035 | implemented | verified | `identity.test.ts:10-28` asserts the kit, the storage instruction and that only a PBKDF2 verifier is stored. |
| S15-036 | implemented | verified | `identity.test.ts:100-171` asserts binding, the spent credential, revoked sessions and grants and the replacement kit. |
| S15-037 | implemented | verified | `identity.test.ts:64-77` and `auth.test.ts:59-64`. |
| S15-038 | implemented | verified | `identity.test.ts:54-60,185-207` (rate limit, expiry, attempts) and `:153-162` (connection untouched, audit receipts). |
| S15-039 | implemented | verified | `tests/journeys/test/13-account-recovery-export.test.ts:46-242`. "A different Google account" is a different test-signed identity, as that file says. |
| S15-040 | implemented | verified | `export.test.ts:94-116` recomputes every checksum. |
| S15-041 | implemented | weaker | The cited tests assert inventory, aliases, wears, movements, receipts, profile, directions, boards, conversation, feedback and media. They do not put a trip, order, lifecycle project, research note, saved combination, profile amendment or wear amendment into the owner and assert it in the package. |
| S15-042 | implemented | verified | `export.test.ts:160-171`. |
| S15-043 | implemented | verified | `export.test.ts:173-186` searches every file for ten secrets and eight table names. |
| S15-044 | implemented | verified | `export.test.ts:231-257`. |
| S15-045 | partial | verified | `export.test.ts:261-283` and `backup.test.ts:154-197`. I found no code that applies "current source permissions" during export. |
| S15-046 | implemented | verified | `export.test.ts:292` and `tests/journeys/test/13-account-recovery-export.test.ts:475-566`. |
| S15-047 | implemented | verified | `backup.test.ts:68-115` and `:215-226`. Local R2 and D1, as stated; a backup is an application package, not a D1 export. |
| S15-048 | partial | verified | `backup.test.ts:154-197`. Sign-in identities are not restored, as stated. The recall checks at `backup.test.ts:188-189` post a field `query` that `RecallQuery` does not define (`packages/contracts/src/ext/assistant.ts:163-172`), so the search text is empty. |
| S15-049 | implemented | verified | `export.test.ts:301` and `backup.test.ts:159,191-194`. |

## Gaps

Each entry gives the row, the source line in `requirements/garderobe-replacement-design.md`, what is missing or weaker than claimed, and the evidence. I found no gap owned by media/Studio or by evaluation in the rows of this part.

### domain

- S04-007, S04-018, S04-023, S04-038, S04-040 (§4 L160-162, L188, L190, L212). These rows are partial by their own statement: the ledger primitives (effects, outbox, action intents) exist and are tested in `packages/domain/test/isolation-style-platform.test.ts:290-340`, and the consuming behaviour is left to other workstreams.
- S15-014 and S15-015 (§15 L989). The rows are accurate on the tables I sampled, but no test enumerates the schema to prove that every personal table carries `user_id` and uses owner-qualified keys; a search of `packages/domain/test` for `sqlite_master` or `PRAGMA` finds nothing.

### daily

- S04-009 (§4 L166-169). The due-job sweep does not start Workflows. `apps/worker/src/index.ts:57-78` runs every phase inside the cron handler and `ctx.waitUntil`.
- S13-030 (§13 L835). A recommendation that outlasts its request continues only inside `exec.waitUntil` (`apps/worker/src/routes/daily.ts:88-99`); if that work is lost the run is marked failed by a sweep (`apps/worker/test/runs.test.ts:90-99`). The run record is durable but the work is not, and the row keeps the status implemented.

### API/MCP

- S13-019 and S13-021 (§13 L814, L816). The run event stream never carries `outfit_board` or `product_comparison`. They are defined in `packages/contracts/src/ext/api.ts:715,739-740` and parsed by the iOS client, but the assistant's event type list is `run_started, activity, text_delta, sources, command_receipt, needs_input, run_finished` (`packages/contracts/src/ext/assistant.ts:129`) and `apps/worker/src/lanes/assistant.ts:81-111` adapts only those. No test receives either event from the Worker.
- S13-028 (§13 L833). `garderobe_ask` returns no cited evidence and no structured objects: `apps/worker/src/mcp/server.ts:108-110` drops the run's `result.research`, `options` and `board`, and `McpAskOutput` (`api.ts:1064-1073`) has no field for them.
- S13-038 and S13-057 (§13 L843, L864). The outbound Garderobe MCP client is not SDK v2 and does not implement the 2026-07-28 wire contract: `packages/assistant/src/connections/mcp.ts:133-134` sends a plain JSON-RPC body with only an `mcp-protocol-version` header, without `Mcp-Method`, `Mcp-Name` or the `_meta` envelope, and the only "0728" check on it is a fixture that logs that header (`apps/worker/src/testing/vitest-config.ts:86`). The server uses `@modelcontextprotocol/server` 2.0.0 directly rather than through a Cloudflare Agents release (`apps/worker/package.json:21-33` has no `agents` dependency). Release evidence with client versions is not recorded.
- S13-051, S13-054, S13-055 (§13 L858, L862). MRTR is not implemented: no tool returns `resultType: "input_required"` and no retry carries `inputResponses`. The replacement is the owner-confirmation flow (`apps/worker/src/mcp/server.ts:285-308`, `apps/worker/src/proposals/`), which is well tested (`mcp.test.ts:160-246`, `proposals.test.ts`, `mcp-command-classes.test.ts`). The Tasks extension is not used. One test cited by S13-055 does not exist. The contract text at `api.ts:120` and `api.ts:671` still describes an MCP `input_required` record.
- S13-036 (§13 L841). The specification says write-enabled clients execute authorized intents under the same policy as the app. The code lets a write-enabled connection run only an allow-list directly and holds every other type for the owner's confirmation in the app. The rule cited for this ("the owner's sensitive-change decision", dated 2026-10-02 and 2026-10-03 in `api.ts:1169` and in the S13-051 row) is not in `requirements/support/wardrobe-support/evals/sources/owner-amendments.md`, which holds only the September 15 decisions. The comment at `api.ts:1169-1171` lists a narrower allow-list than the server guide at `mcp/server.ts:65-70`.
- S13-042 and S15-013 (§13 L849, §15 L985). The OAuth revocation endpoint is never exercised: the only assertion is that the metadata names one (`mcp.test.ts:33`). Client ID Metadata Documents are enabled (`mcp/handler.ts:139`) and untested.
- S13-045 (§13 L851). Inbound PKCE, audience or resource, and issuer validation have no negative test; only an unregistered redirect URI is refused in a test (`mcp.test.ts:337-340`).
- S15-012 (§15 L985). The one-time consent transaction is not tested for replay or tampering, and the granted scopes come from the submitted form (`mcp/consent.ts:134`) while the page shows a write checkbox even when write was not requested (`mcp/consent.ts:74`). An owner can therefore grant more than the client asked for, and the stored transaction does not bind the capabilities.
- S13-052 (§13 L860). The routing-header test asserts only that an error is returned (`mcp.test.ts:262-264`).
- S13-017 (§13 L810). No test asserts the effective model profile or budget in `GET /v1/settings`, and `routes/core.ts:91-98` turns a failure to read them into `null` without telling the caller.
- S13-008 (§13 L801). The endpoint test for recall search asserts shape only (`surfaces.test.ts:288-292`).
- S15-034 (§15 L1010). The recovery state reports today's board and its projection in whatever state (`routes/identity.ts:78-84`), not the last board and the last confirmed Calendar projection. "Pending commands" is a count of pending effects and waiting runs. No test asserts `lastCalendarProjection`.
- S15-041 and S15-045 (§15 L1020, L1022). The export tests do not prove that trips, orders, lifecycle projects, research with source references, saved combinations, profile amendments or wear amendments reach the package; the lanes that should carry them are named at `apps/worker/src/export/job.ts:142-149`. I found no code that applies current source permissions during export.
- S15-048 (§15 L1024). A restore does not recover sign-in identities, by the row's own statement. The drill has run only against local D1 and R2.
- S13-060 (§13 L870). The connection record has no transport, data-classification or budget field.
- S04-004, S13-047, S15-004, S15-008, S15-010, S15-023, S15-028 (§4 L146-150, §13 L853, §15 L979-985, L996, L1004). These rows are partial by their own statement: Cloudflare Access is represented by test-signed assertions (`apps/worker/test/auth.test.ts:5-9`), Google by a labelled fixture, and no real Claude or ChatGPT client or phone browser was used.
- Observation on idempotency keys and receipts. `POST /v1/commands`, the batch route, turns, research, recommendations, uploads, exports, backups, Studio previews, connection registration and all MCP tools that start work take a client request ID. `POST /v1/connections/{id}/reconnect`, `/capabilities`, `/disconnect`, `POST /v1/devices`, the identity routes and `POST /v1/proposals/{id}/decision` take none and rely on the natural idempotence of the operation (`routes/connections.ts:28-39`, `routes/identity.ts:40-66`, `routes/proposals.ts:16-22`). `POST /v1/recommendations` in mode `board` publishes a board and its response carries no receipt (`api.ts:438-449`). The specification requires the key and receipt on `POST /v1/commands` only, so this is recorded as an observation.

### assistant

- S04-002, S04-020, S04-030 (§4 L140, L190, L204). No Workflow exists. Long jobs run in task actors, the cron sweep and stand-in drivers (`packages/assistant/src/jobs/runner.ts:140` is a comment describing the Workflow that would be written).
- S04-006 (§4 L156-158). Recall against AI Search is tested only with a fake index; the status should be partial.
- S04-010, S04-031, S13-058 (§4 L170-173, L205, §13 L868). Outbound connections do not build on the Agents MCP client; the rows record this as an accepted deviation. No live Exa, Tavily, Google or owner-added service was contacted.
- S04-011, S04-033 (§4 L174-181, L207). Browser Run is tested against a fake binding only.
- S04-034, S04-046, S04-047, S04-048 (§4 L208, L218, L220). Code Mode and Sandbox are not implemented (blocked).
- S04-036 (§4 L210). No test would detect raw reasoning reaching a client, because the fake model produces none.
- S04-037 (§4 L210). Versions are pinned; no release record exists.
- S13-061 (§13 L870). Serialized refresh and atomic rotation are not tested under concurrency.
- S13-063 (§13 L872). Response-size and timeout limits of the outbound client have no assertion in the cited tests.
- S13-064 (§13 L872). No test offers a colliding tool name such as `record_wear` from a connected server.
- S15-029 (§15 L1004). Model profiles do not record which providers may receive which data class.
- S15-025 (§15 L998). Google scopes and allowlists are tested only against a fake Google API (blocked).

### iOS

- S04-017 (§4 L188). "Stop and send" has no test; the function is `ComposerModel.swift:250`.
- S13-027 (§13 L824). The adapter was not tested on a physical iPhone (blocked).
- S15-006 and S15-007 (§15 L981). `ASWebAuthenticationSession`, the universal-link callback and Keychain storage were not run; the public-client flow is tested against a stand-in transport in `BoundaryTests.swift:104-191`.
- S15-024 (§15 L996). No test drives the connection functions of `SettingsModel`; no provider connection was made from the app.
- S15-034 and S13-047 (§15 L1010, §13 L853). The recovery screen and the Connected assistants screen compile but were not run on a device, and `RecoveryStatusModel` (`AccountModel.swift:293`) has no test.
- S04-023 (§4 L190). The receipt surface was not run on a device.

### deployment

- S04-049 and S04-050 (§4 L222). Open; nothing is cited.
- S15-026 and S15-027 (§15 L1000, L1002). Open; the Google Cloud project, the verification outcome and the seven-day refresh check are not done.
- S13-049 (§13 L853). Real client consent, refresh, scope denial, revoke and reconnect against the deployed server are not done (blocked).
- S15-008 and S15-010 (§15 L981, L985). Disabling alternate public routes and the Access policies on the two hostnames are deployment configuration; `apps/worker/wrangler.jsonc` is the local configuration only (its own header says so at lines 4-7).
- S15-047 and S15-048 (§15 L1024). Retention on the real bucket and the restore drill on real resources have not run.
- S04-002 and S04-009. No Workflow or index Queue binding is declared in `apps/worker/wrangler.jsonc:16-31`.

### tests

- S13-055. The cited test "asks first, and executes exactly once when the owner confirms" does not exist.
- S15-048. `apps/worker/test/backup.test.ts:188-189` sends `{ query: ... }` to `/v1/recall/search`; the schema field is `text`, so both assertions run on an empty search text.
- S04-003 and S04-045. The cited test `packages/domain/test/import.test.ts` does not address either requirement.
- S13-010. Every Worker test of the event stream uses `follow=false`; a stream that stays open while a run progresses is not tested in the Worker.
- S13-033. No test produces a non-null research verdict through the MCP tool.
- S13-004, S13-007, S13-018, S04-035. The cited tests omit one clause each: dated evidence, cursor paging with `before` or `after`, external-effect state, and the reasoning flag.

## Unmapped requirements

The source file is `requirements/garderobe-replacement-design.md` unless another file is named. I walked lines 136-224, 787-878 and 973-1025 sentence by sentence. Every endpoint (L795-810), every MCP tool (L833-839) and every responsibility-table row (L201-208) has a row. The statements below have no row, or only a row whose wording drops a material part.

- L812, "Mutation responses distinguish success from proposed work." No row cites this sentence; S13-018 starts at the next sentence. The behaviour exists (a held change is answered `confirmation_required` with a proposal, `apps/worker/src/mcp/server.ts:307`), but nothing in the checklist requires or tracks it.
- L829, "The MCP server exposes a compact set of complete operations rather than requiring external models to sequence dozens of low-level tools correctly." No row. The server registers exactly seven tools and `apps/worker/test/mcp.test.ts:40-45` asserts the list, so it is met without being tracked.
- L849, "use its OAuth validation with SDK v2 authentication context" and "The provider documents `global_fetch_strictly_public` for client metadata fetching." Neither S13-041 nor S13-042 carries these. The flag is set in `apps/worker/wrangler.jsonc:14`, which is the local configuration; no row makes the deployment configuration keep it, and no test fetches a client metadata document.
- L159 and L176, the diagram edges "AISEARCH --> GATEWAY" and "WF --> GATEWAY". No section 4 row cites L159, and S04-011 cites L174-181 without stating that Workflows call models through the Gateway. The AI Search edge is covered in substance by S06-069 (blocked).
- L822, "Use Think's supported protocol and persisted message IDs behind a small native transport adapter." S13-025 covers the SSE choice and drops the persisted message IDs.
- L824, "Token chunks can be replayed or replaced by a settled message". S13-026 keeps only the clause about commands and receipts. An iOS test for it exists (`ConversationTests.swift:40`) but no row records it.
- L845, "the native app renders those outputs directly." S13-040 drops this clause.
- L983, "the MCP provider supplies per-client capabilities, immediate grant revocation and the required protocol discovery". S15-009 drops this clause; S13-042, S13-044 and S13-048 cover it in substance from section 13 lines.
- L996, "Google OAuth is owned by the backend and shared only between the approved Google adapters". S15-024 keeps only "a token from one connection is never forwarded to an unrelated MCP server". The restriction to approved adapters is implemented in `apps/worker/src/connections/service.ts:775-818` and tested in `connections.test.ts:347-351`, but is not tracked.
- L998, "Gmail search terms are not an OAuth security boundary." S15-025 drops this sentence.
- L1000, "do not select Internal unless the account actually belongs to an eligible Workspace organization" and "The owner completes any unverified-app acknowledgment in Google's own flow." S15-026 (open) drops both.
- L1004, "Prefer automatically authenticated Worker AI bindings" and "Unified Billing model routes do not receive provider BYOK credentials." S15-028 drops both. The second is covered by S12-005 and S12-006, which cite section 12 lines.
- `requirements/support/wardrobe-support/evals/sources/owner-amendments.md` L31, "Recovery proves identity through the configured credential flow. Export includes original history and media while excluding credentials." These are mapped: rows AM-034 and AM-035 (`CHECKLIST.md:1188-1189`) cite `identity.test.ts` and `export.test.ts`, which I read and which assert both (see S15-036, S15-041 and S15-043). Those two rows are outside the three sections of this part.
- Behaviour with no requirement row: the owner-confirmation flow for connected assistants (proposals, `GET /v1/proposals`, `POST /v1/proposals/{id}/decision`, the direct allow-list). It changes what specification L841 says about write-enabled clients, it is the subject of four test files, and it appears in the checklist only inside the Code cells of S13-051 and S13-054. I found no row whose Requirement cell states it and no source text for it in the specification or in the owner amendments file. My search was by phrase in `CHECKLIST.md`, so a differently worded row could exist.

