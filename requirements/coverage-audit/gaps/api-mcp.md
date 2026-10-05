# Coverage gaps: API, MCP, identity, recovery and export

Audited at `garderobe-rebuild` commit `8445a1e`, by reading code and tests; nothing was executed. "spec" is `requirements/garderobe-replacement-design.md`. Per-row verdicts are in `../rows/`; the part letter after each entry says which file.

What holds: all 16 `/v1/...` endpoints (spec L795-810) and all seven MCP tools (L833-839) are registered and each has at least one test. The owner and scopes come from the authenticated connection. The owner-confirmation flow that replaced MRTR is well tested (`apps/worker/test/mcp.test.ts:160-246`, `proposals.test.ts`, `mcp-command-classes.test.ts`); whether that replacement is authorized is an owner question recorded in `../../COVERAGE.md`.

## Rows whose status overstates what exists

| Row | Source | What is missing or weaker | Evidence | Closes when |
| --- | --- | --- | --- | --- |
| S13-019, S13-021 | spec L814, L816 | The run event stream never carries `outfit_board` or `product_comparison`; they exist only in the contract and the iOS parser. | `packages/contracts/src/ext/api.ts:715,739-740`; `packages/contracts/src/ext/assistant.ts:129`; `apps/worker/src/lanes/assistant.ts:81-111` (D) | The Worker emits both events and a test receives them. |
| S13-028 | spec L833 | `garderobe_ask` returns no cited evidence and no structured objects; the run's research, options and board are dropped. | `apps/worker/src/mcp/server.ts:108-110`; `api.ts:1064-1073` (D) | `McpAskOutput` carries them and a test asserts a cited answer. |
| S13-038, S13-057 | spec L843, L864 | The outbound MCP client is not SDK v2 and does not send `Mcp-Method`, `Mcp-Name` or the `_meta` envelope; the server does not run through a Cloudflare Agents release; no release evidence with client versions. | `packages/assistant/src/connections/mcp.ts:133-134`; `apps/worker/package.json:21-33` (D) | The client uses the SDK or implements the 2026-07-28 headers with a test, or the rows become partial with the deviation recorded. |
| S13-051, S13-054, S13-055 | spec L858, L862 | MRTR (`input_required`, `inputResponses`) is not implemented; the owner-confirmation flow replaces it. One test cited by S13-055 ("asks first, and executes exactly once...") does not exist. Contract comments at `api.ts:120,671` still describe an `input_required` record. | `apps/worker/src/mcp/server.ts:285-308` (D) | The owner decision is recorded and rows reworded, or MRTR is implemented; the stale citation and comments are corrected. |
| S13-036 | spec L841 | Write-enabled connections do not act under the app's policy: an allow-list runs directly and everything else waits for the owner in the app. The comment at `api.ts:1169-1171` lists a narrower allow-list than `mcp/server.ts:65-70`. | `apps/worker/src/mcp/server.ts:285-308` (D) | See the owner question in `../../COVERAGE.md`. |
| S13-042, S15-013 | spec L849, L985 | The OAuth revocation endpoint is never called by a test; client metadata documents are enabled and untested. | `apps/worker/test/mcp.test.ts:33`; `mcp/handler.ts:139` (D) | A test revokes a grant and shows the token refused; a test fetches a client metadata document. |
| S13-045 | spec L851 | No negative test of inbound PKCE, audience or resource, or issuer; only an unregistered redirect URI is refused. | `mcp.test.ts:337-340` (D) | Negative tests for each. |
| S15-012 | spec L985 | Granted scopes come from the submitted consent form and a write checkbox is shown even when write was not requested, so an owner can grant more than the client asked for; no replay or tamper test of the one-time handle. | `apps/worker/src/mcp/consent.ts:74,134` (D) | The stored transaction binds the capabilities and tests cover replay and tampering. |
| S13-030 | spec L835 | See daily: a long recommendation is not a durable run. | `apps/worker/src/routes/daily.ts:88-99` (D) | See `daily.md`. |
| S15-034 | spec L1010 | The recovery state reports today's board, not the last board and last confirmed Calendar projection; no test asserts `lastCalendarProjection`. | `apps/worker/src/routes/identity.ts:78-84` (D) | The route reads the last confirmed projection, with a test. |
| S15-041, S15-045 | spec L1020, L1022 | Export tests do not assert trips, orders, lifecycle projects, research with sources, saved combinations, profile amendments or wear amendments; no code applies current source permissions during export. | `apps/worker/test/export.test.ts:118-158`; `apps/worker/src/export/job.ts:142-149` (D) | Tests assert each record type in the package. |
| S13-060, S15-029 | spec L870, L1004 | No transport, data-classification or budget field on connections; model profiles record only a provider. | `packages/assistant/src/inference/registry.ts:15` (D) | The fields exist and gate what data a provider may receive. |
| S13-017 | spec L810 | No test asserts the model profile or budget in `GET /v1/settings`; a read failure becomes `null` silently. | `apps/worker/src/routes/core.ts:91-98` (D) | A test asserts both fields. |
| S13-052, S13-008 | spec L860, L801 | The routing-header test asserts only that an error is returned; the recall search endpoint test asserts shape only. | `mcp.test.ts:262-264`; `surfaces.test.ts:288-292` (D) | Tests assert the specific error and a real hit. |
| S18-005, R16 | spec L1167; research L293 | Marked implemented with open defect D14-2: the last page of the item list tells a connected assistant that more pages follow. | `apps/worker/src/mcp/server.ts:205`; `tests/journeys/DEFECTS.md:14` (G) | The defect is fixed and the expected-failure test passes normally. |
| S19-007 | spec L1201 | The outbound fallback to protocol `2025-11-25` has no test in which a peer refuses `2026-07-28`. | `apps/worker/src/connections/outbound.ts:44-55` (F) | A fixture peer refuses the newer version and the fallback is asserted. |
| S11-010 | spec L694 | The image backfill estimate is exposed by no route or media port. | `apps/worker/src/routes/media.ts:40-134`; `apps/worker/src/lanes/media.ts:52-123` (E) | A route returns the estimate and the app shows it. |
| S06-081 | spec L377 | No route lists remembered conclusions for the owner. | `listMemoryConclusions` unreferenced in `apps/worker/src` (C) | A route and screen exist. |
| S06-060 | spec L360 | No command or route calls `provisionSearchInstance`. | `packages/assistant/src/commands/reminders.ts:72-90` (C) | Provisioning is reachable from an administrative path. |
| S14-027, S17-069 (open) | spec L916, L1155 | Logs are free text without run or action identifiers; four call sites log a full error stack unredacted; no test asserts what reaches a log. | `apps/worker/src/router.ts:78`; `export/job.ts:417`; `export/import.ts:229`; `mcp/server.ts:100` (F) | Structured redacted logging with a test that personal content cannot reach a log line. |

## Honest partial, open or blocked rows that still need work

- **Real identity providers and clients:** S04-004, S13-047, S13-049, S15-004, S15-008, S15-010, S15-023, S15-028, S14-022, S17-038, S17-050, S18-019, S20-006, S21-009, R58. Cloudflare Access is a test-signed assertion (`apps/worker/test/auth.test.ts:5-9`), Google a labelled fixture; no real Claude or ChatGPT client or phone browser was used.
- **S04-007, S04-018, S04-023, S04-038, S04-040**: ledger primitives exist; consuming behaviour is in other workstreams.
- **S15-048** (spec L1024): a restore does not recover sign-in identities; the drill ran only on local D1 and R2.
- **S14-024**: the credential wrapping key is an ordinary Worker secret (`apps/worker/src/env.ts:54`). **S14-045**: no KV measurement or restore test of grant storage. **S17-037**: no multi-round retry or task-handle test. **S16-002**: no phase 1 exit criterion needing a real service has evidence.
- **S03-057** (spec L103): a shared link is sent as `product_investigation`, a pasted link as `chat`; no test shows both reach the same investigation flow.

## Test defects found while reading

- `apps/worker/test/backup.test.ts:188-189` posts `{ query: ... }` to `/v1/recall/search`, but the schema field is `text` (`packages/contracts/src/ext/assistant.ts:163-172`), so both recall assertions in the restore test run on an empty search.
- `POST /v1/recommendations` in mode `board` publishes a board and returns no receipt (`api.ts:438-449`); recorded as an observation.
- Every Worker test of the event stream uses `follow=false` (S13-010); no test offers a colliding tool name from a connected server (S13-064); token refresh is never tested under concurrency (S13-061).
