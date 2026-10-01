# Garderobe Worker: HTTP API, MCP server, identity, connections, export

This package is the one Worker that serves the iOS app, the private web board and consumer assistants. It contains no wardrobe logic: every route and tool calls the shared command service and the daily, assistant and visual-wardrobe packages through `src/lanes/`. The published contract is `packages/contracts/src/ext/api.ts` (`API_ROUTES`, request and response schemas, MCP tool contracts); `test/routes.test.ts` fails if the mounted routes and that manifest differ.

## Two trust domains

| Hostname | Authentication | What it serves |
| --- | --- | --- |
| App/API (`APP_ORIGIN`) | Cloudflare Access assertion (`Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie), verified by the Worker (signature, issuer, audience, expiry) and mapped by issuer and subject to an internal user | `/v1/*`, `/auth/*`, `/board`, the MCP consent page `/oauth/authorize`, and the provider callback `/connections/callback` (authenticated by its own one-time state, not by Access) |
| MCP (`MCP_ORIGIN`) | Garderobe grant issued by this Worker's OAuth authorization server (`@cloudflare/workers-oauth-provider`, KV `OAUTH_KV`), re-checked against D1 on every request | `/mcp`, `/.well-known/oauth-*`, `/oauth/token` (also revocation), `/oauth/register` |

Access-trust routes are refused on any other hostname. An Access assertion is not an MCP credential, and an MCP token is not accepted by the API. Email is never used to find or link an account.

## Routes (specification section 13 and 15)

- **Today and daily service**: `GET /v1/today`, `POST /v1/recommendations`, `GET /v1/days/{date}`, `GET /v1/weather`, `GET /v1/service` (pause state), `GET /v1/trips`, `GET /v1/trips/{id}`, `POST /v1/trips/{id}/packing-proposal`, `GET /board`, `GET /board/{date}`.
- **Wardrobe**: `GET /v1/wardrobe` (explicit total, cursor, `complete`), `GET /v1/wardrobe/resolve`, `GET /v1/wardrobe/temperature-preview`, `GET /v1/availability`, `GET /v1/items/{id}`, `GET /v1/items/{id}/image`, `GET /v1/laundry`, `GET /v1/style`, `GET /v1/settings`.
- **Studio**: `GET /v1/studio`, `POST /v1/studio/validate`, `POST /v1/studio/suggest`, `POST /v1/studio/compose`.
- **Commands**: `POST /v1/commands` (idempotency key, expected versions, verified receipt), `POST /v1/commands/batch` (offline replay), `GET /v1/commands`, `GET /v1/commands/{id}`, `GET /v1/command-types`. Laundry, wears, trips, returns, feedback, pause and resume are all commands on this route.
- **Conversation and runs**: `POST /v1/conversation/turns`, `GET /v1/conversation/messages`, `POST /v1/recall/search`, `POST /v1/research`, `GET /v1/orders`, `GET /v1/returns`, `GET /v1/projects`, `GET /v1/feedback`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events` (server-sent events, `Last-Event-ID` or `after`), `POST /v1/runs/{id}/cancel`, `POST /v1/runs/{id}/resume`, `POST /v1/runs/{id}/input`.
- **Capture and media**: `POST /v1/uploads`, `PUT /v1/uploads/{id}/content`, `POST /v1/uploads/{id}/complete`, `GET /v1/uploads/{id}`, `GET /v1/media/renditions/{id}`, `GET /v1/media/assets/{id}`, `GET /v1/media/photos-needed`, `GET /v1/media/review`.
- **Connections**: `GET /v1/connections`, `POST /v1/connections`, `POST /v1/connections/{id}/reconnect`, `POST /v1/connections/{id}/capabilities`, `POST /v1/connections/{id}/disconnect`, `GET /v1/connections/{id}/calendars`, `POST /v1/connections/{id}/outfit-calendar`, `GET /connections/callback`.
- **Identity and recovery**: `GET /v1/me`, `GET /v1/meta`, `POST /auth/claim`, `POST /v1/identities/link`, `POST /auth/link/complete`, `POST /v1/identities/unlink`, `POST /v1/recovery-kit`, `POST /auth/recovery/start`, `POST /auth/recovery/complete`, `POST /v1/sessions/revoke`, `GET /v1/recovery`, `POST /v1/account/delete`, `GET /v1/assistants`, `POST /v1/assistants/{id}/disconnect`.
- **Export and import**: `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/{id}`, `POST /v1/exports/{id}/ticket`, `GET /v1/exports/{id}/download`, `POST /v1/imports`, `GET /v1/imports/{id}`.

Errors are `{ error: { code, message, details } }` with the codes in `ApiErrorCode`. A module whose bindings are absent answers `module_unavailable`; there are no placeholder routes.

## MCP server

Protocol `2026-07-28` (stateless, `@modelcontextprotocol/server` 2.0.0), with a separately tested `2025-11-25` compatibility path that is recorded per connection. Scopes: `wardrobe.read`, `wardrobe.write`. The owner and scopes always come from the grant; tool inputs are strict and accept no owner field.

| Tool | Purpose | Scope |
| --- | --- | --- |
| `garderobe_ask` | Send a request to the backend assistant; a read-only connection gets proposals, never changes | read |
| `garderobe_today` | The prepared board, at the same revision the app sees | read |
| `garderobe_recommend` | Validated outfit options for a brief, date and count | read |
| `garderobe_inventory` | Items, availability, history or the complete snapshot with explicit completeness | read |
| `garderobe_command` | One typed command with a verified receipt; consequential commands ask for confirmation first (`input_required`) | write (not listed for read-only connections) |
| `garderobe_research` | Start an investigation and return sources, verdict and comparison | read |
| `garderobe_run` | Read a run, answer its question, cancel or resume it | read |

Resources: `garderobe://guide`, `garderobe://style/profile`, `garderobe://commands`. Correctness never depends on reading them.

## Running locally

From the repository root, install once with `bash tools/sandbox-install.sh` (or `npm install`). Then, in `apps/worker`:

```
npm run dev              # first run sets up: local keys, .dev.vars, D1 migrations, the real owner profile and inventory
npm run dev -- reset     # delete local state and set up again
npm run dev:token        # a local sign-in token (one hour); add -- --header or -- --claim
npm run smoke:mcp        # 19 checks against the running Worker; exit 1 on any failure
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

`@garderobe/worker/testing/vitest-config` exports `garderobeWorkerTestPlugin()` (D1, KV, two R2 buckets, queue, the conversation Durable Object, and a fixture for outbound requests). `@garderobe/worker/testing` exports `provisionOwner({ real })`, `ApiClient`, `connectMcp(owner, { write, era, onElicit })`, `toolResult`, `publishBoard`, `uploadImage`, `readSse`, `enableFakeModel` and others.

## Checks

```
npm run typecheck        # in apps/worker
npm test                 # in apps/worker: 8 files, 106 tests
npm test                 # in the repository root: typecheck and tests of every workspace
```

## Stand-ins used by the tests

- **Cloudflare Access**: assertions are signed with a key generated per test run and verified by the Worker's real verification code. Real Access with Google was not exercised.
- **Language model**: the assistant workstream's labelled fake model. No test here calls a real model.
- **Google OAuth and Calendar**: the labelled fixture `https://google.fixture.test` (`src/testing/vitest-config.ts`).
- **Remote MCP tool service**: a labelled fixture at `https://mcp.tavily.com/mcp`; it is not Tavily.
- **All other outbound requests** answer 503, so weather is reported as unavailable.
- **MCP client in tests** is the SDK client over in-process `fetch`; the smoke script uses real HTTP against `wrangler dev`.

## Not done or not verified here

- Scheduled backups, a restore manifest and a restore drill (checklist S15-047, S15-048). The portable export and import are a separate feature and are done.
- Account deletion disables the account and its grants; erasing stored data is an operator step that is not implemented.
- `garderobe_recommend` never returns a running run: the daily service completes within the call.
- The MCP Tasks extension is not used; long operations return run handles.
- Scheduled board preparation uses the deterministic composer; the AI Gateway composition model is used only for requests made for one owner.
- Delivery of the morning notification to a device (APNs) is not wired.
- Browser rendering for page retrieval is not wired; that method reports itself unavailable.
- Needs the development deployment or a device: real Cloudflare Access with Google and Managed OAuth for the native app, consent, refresh, revoke and reconnect with real Claude and ChatGPT clients, client metadata documents with a real client, a real Google grant over several days, real Exa and Tavily endpoints, and server-sent events on a physical iPhone.
