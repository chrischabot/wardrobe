# Garderobe dev deployment (`garderobe-dev`)

The development environment on the owner's Cloudflare account. It is not production: there is no
`garderobe-prod` traffic and no cutover. Everything here is named `dev` and is guarded by
`assertDevConfig` (`scripts/lib.ts`), which refuses any config whose Worker, gateway, routes or
resource names are not the dev ones.

## Endpoints

| Host | Serves | Protection |
| --- | --- | --- |
| `https://garderobe-dev.chabot.dev` | `/v1` API, `/board` web board, `/confirm/*`, `/health`, dev probes `/__dev/*` | Cloudflare Access application "Garderobe dev (app and web board)", all paths; the Worker verifies the Access JWT itself |
| `https://garderobe-dev-mcp.chabot.dev/mcp` | MCP (2026-07-28, plus the 2025-11-25 adapter) | Workers OAuth provider bearer tokens; outside Access |
| `https://garderobe-dev-mcp.chabot.dev/authorize` | OAuth consent page | Access application "Garderobe dev (MCP consent /authorize)" |
| `https://garderobe-dev-mcp.chabot.dev/.well-known/*`, `/oauth/*` | OAuth discovery, token, registration | outside Access (the provider protects them) |

`workers_dev` and preview URLs are off. The two hostnames are Worker custom domains, new subdomains
created only for this Worker; no existing DNS record was changed.

## Commands (run from `garderobe/`)

The Fabric project's Cloudflare variables must be set (see the credential guide in the project
library): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Wrangler/management; never bound to the
Worker), `CLOUDFLARE_AI_API_TOKEN` (bound as the Worker secret `AI_GATEWAY_TOKEN`),
`CLOUDFLARE_LOGS_API_TOKEN` (usage), `CLOUDFLARE_R2_API_TOKEN` (teardown only).

| Command | What it does |
| --- | --- |
| `npm run deploy:dev` | **The one command.** Provision (idempotent) -> apply every D1 migration to the remote dev DB -> bind secrets -> `wrangler deploy` -> smoke the two hostnames |
| `npm run dev:provision` | Only the account resources and Access pieces (found by name and reused) |
| `npm run dev:seed` | The owner's profile, rules, May 2026 CSV and owner-asserted additions, synthetic test owner B, DEMO placeholder images and the labelled TEST EVENT week, through the foundation importer on the remote D1/R2; then compares the reconciliation with the committed report and with the local import |
| `npm run dev:seed -- link owner` / `-- link b` | Explicitly link an Access service token to the owner / test owner B (audited). `-- unlink owner\|b` revokes it |
| `npm run dev:probe -- models` | Model entitlement from inside the Worker; writes `MODEL_PROBES` into `wrangler.dev.json` (redeploy to apply) |
| `npm run dev:probe -- d1\|queue\|workflow [--days N]\|ai-search\|r2\|product-models\|all` | Real-platform probes |
| `npm run dev:probe -- do-write`, redeploy, `-- do-read` | Think transcript persistence across an actor restart (the read refuses to run unless the Worker version changed) |
| `npm run dev:probe -- import-race [calls]` | Live import-race check (`deploy/scripts/import-race.ts`, default 5 calls, about two minutes each). Each call asks the dev-only probe `POST /__dev/probe/import-race` (`deploy/src/import-race-probe.ts`) for one round: two different staged packages confirmed at the same moment, then two direct imports, each into a fresh synthetic empty owner on the real D1. A round passes only when exactly one import lands. Writes `deploy/evidence/import-race`; exits non-zero on any failure. The synthetic probe owners stay in the dev database (imported receipts are immutable). Not part of `-- all` |
| `npm run dev:verify` | Auth, OAuth, isolation, idempotency, scopes, profile hard constraints, web board and the MCP SDK smoke (both eras) over HTTPS |
| `npm run dev:measure -- --since <ISO>` | Usage from Workers Observability and the GraphQL Analytics API |
| `npm run teardown:dev` / `-- --yes` | Dry run / delete every dev resource (keeps the pre-existing `garderobe-dev` gateway and the "owner only" Access policy) |

Evidence files are written to `deploy/evidence/` (ids, statuses, timings and counts only).
Secrets and grants live only in `deploy/.state/` (git-ignored, mode 600).

## Resources

`dev-resources.json` records ids (no secrets). Worker `garderobe-dev` (entry `src/dev-entry.ts`,
which hands every non-`/__dev/` request to the unchanged product entry `backend/src/index.ts`);
Durable Object class `GarderobeAssistant` (SQLite); D1 `garderobe-dev`; private R2
`garderobe-dev-media` (no public access, no r2.dev URL); KV `garderobe-dev-oauth` (OAUTH_KV) and
`garderobe-dev-cache` (CACHE_KV); Queues `garderobe-media-dev` (producer and consumer) and
`garderobe-index-dev` (producer); Workflow `garderobe-daily-service-dev`; AI Search instance
`garderobe-dev-recall` (builtin, hybrid, routed through `garderobe-dev`, bound as
`AI_SEARCH_PROBE` for the probe only); the existing AI Gateway `garderobe-dev` (not recreated;
its only change is the spend rule, below).

Secrets bound with `wrangler deploy --secrets-file` (a temporary 600 file deleted immediately):
`MCP_STATE_SECRET` and `MEDIA_URL_SIGNING_KEY` (64-character random values, generated once and
kept on later deploys), `AI_GATEWAY_TOKEN`, `AI_GATEWAY_ACCOUNT_ID`, `DEV_PROBE_SUBJECTS`.

## Models and spend (2026-09-29)

**Gateway spend rule.** The `garderobe-dev` gateway's cost rule is **$50 per 30-day sliding window**. It was $5, and the owner raised it through Fabric support so the MCP simulation can run with real assistant answers. Only `spend_limits.rules[0].limit` changed; nothing else on the gateway did. It was set with the Cloudflare API: `GET /accounts/{account}/ai-gateway/gateways/garderobe-dev`, change the limit, then `PUT` the same object back. Never set it above $50. `npm run dev:measure` shows the rule and the spend so far.

**The gateway rule does not count Sol.** The rule sums the gateway's own per-request cost, and Cloudflare applies spend limits only to models with known pricing. `gpt-6.1-sol` is not in the gateway's catalogue: all of its requests on garderobe-dev are logged at $0 in the analytics `cost` field (68 simulation requests, and three 13-token probes on 2026-09-29, one of them sent with `cf-aig-custom-cost: {"per_token_in":0.000002,"per_token_out":0.00001}`). Opus requests are priced and do count. The app therefore enforces the $50 itself: `MODEL_SPEND_CAP_USD` is `50` in `wrangler.dev.json`, a ceiling over a sliding 30 days across every owner and model, at the registry's list prices (Sol $2 / $10, Opus $4 / $20 per million tokens). It takes effect on the next deploy, and it does not cover requests made outside the app (these probes, `curl`).

**Chat models** (details in `backend/src/assistant/README.md`):
- Routine turns: GPT-6.1 Sol (`gpt-6.1-sol`, OpenAI Responses route, medium reasoning).
- Deep turns (shopping, sizing, provenance, research, keep/sell): Claude Opus 5.5 at medium effort (`claude-opus-5-5`, native Anthropic route).
- Compaction and extraction: kimi-k2.7-code on Workers AI.

`npm run dev:probe -- models` probes each profile through the product transport, with one tool offered because the assistant always offers tools, and writes `MODEL_PROBES`. Redeploy to apply it, then run `npm run dev:probe -- product-models`. That second probe serves each task through the model service and prints each run's `model_runs` id.

**The owner's app budget on dev.** Separately from the gateway rule, the app reserves and settles its own per-owner model budget (`backend/src/models/budget.ts`; the default is $5 a month). A long simulation would hit that first, with `budget_exhausted`. On dev only, the seeded owner (Chris) therefore has `owner_settings.budget_json = {"monthlyMicroUsd": 45000000}`, which is $45: under the $50 gateway rule, with room for the probes. The code default is unchanged, and so is test owner B. To set it again, for example after a re-seed, take the owner's user id from the `GET /__dev/whoami` probe route and run:

```
npx wrangler d1 execute DB --remote --config deploy/wrangler.dev.json --command "UPDATE owner_settings SET budget_json = json_set(COALESCE(NULLIF(budget_json,''),'{}'), '$.monthlyMicroUsd', 45000000) WHERE user_id = '<owner user id>'"
```

Typical cost per assistant step, measured on dev with the owner's full context:
- Sol: 21,311 input and 93 output tokens, $0.044.
- Opus 5.5 medium: 34,249 input and 131 output tokens, $0.14.

A turn that calls tools repeats the input for each step.

## Authentication

- Access team domain `raspy-fire-6cac.cloudflareaccess.com`. Both applications use the existing
  reusable "owner only" policy (the owner's email; attached, not modified) plus a new reusable
  "Garderobe dev automation (service token)" policy (decision `non_identity`) naming two service
  tokens: `garderobe-dev-automation` (linked to the owner) and `garderobe-dev-automation-owner-b`
  (linked to the synthetic test owner B, for isolation checks).
- A service token signs in to Garderobe only through its explicit `auth_identities` link (see
  `backend/src/api/README.md`, "Access service tokens"). `/__dev/*` probes additionally require the
  owner's automation token subject (`DEV_PROBE_SUBJECTS`).
- The owner's own Google/Access sign-in has not been linked to the dev owner yet: that needs the
  owner to sign in once (their Access `sub` is only known then). Until then the owner's browser
  gets `unknown_identity`, by design.
- MCP: the Workers OAuth provider flow (dynamic registration or CIMD, Access-protected consent,
  PKCE S256, 15-minute access tokens, rotating refresh). Cloudflare API tokens are never Garderobe
  credentials.

## End-to-end MCP simulation hook (dev only)

`src/dev-entry.ts` wraps every non-`/__dev/` request with the simulation hook `tests/simulation/worker/sim-hook.ts` (details in `tests/simulation/README.md`):
- Only a request carrying an `x-garderobe-sim` header HMAC-signed with the `DEV_SIM_SECRET` Worker secret runs with a simulated clock, weather and calendar. That includes `POST /__sim/phase` and `POST /__sim/audit`, which act only on the simulation owner named in the signed header.
- A request without the header reaches the product unchanged, so `npm run dev:verify` still reflects the normal deployment. Don't run it while a simulation is in progress.
- The assistant class adds the `devSimulation` RPC through the `withSimulation` mixin.
- `DEV_SIM_SECRET` is bound once by `tests/simulation/scripts/setup-dev.ts`, and later deploys keep it. Its value is in `deploy/.state/dev-sim-secret.json`.
- The same script creates the Access service token `garderobe-dev-automation-sim` and adds it to the service-token policy. It also seeds a fresh "Chris (simulation …)" owner with a $25 app model budget and moves the token's audited identity link to that owner.
- `npm run deploy:dev` (provisioning) rewrites the policy with its own two tokens, so run `setup-dev.ts` after a deploy.
- To remove it all: take the hook out of `dev-entry.ts`, run `npx wrangler secret delete DEV_SIM_SECRET --config deploy/wrangler.dev.json`, and delete the `garderobe-dev-automation-sim` service token in Zero Trust. `npm run dev:provision` already leaves it out of the policy.

## Not live on dev

Google (Gmail, Calendar), Exa, Tavily, Browser Run and image providers have no credentials and stay
unconnected. Weather is live Open-Meteo.
