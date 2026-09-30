# Garderobe dev deployment: evidence (2026-09-29)

The dev environment is live on the owner's Cloudflare account, seeded with the owner's real profile and wardrobe, authenticated, probed and measured. This document holds no secrets and no garment details beyond counts. The raw evidence files are in `garderobe/deploy/evidence/`.

**Final deployed version:** `d2b7f450-80c5-4d98-9c76-cb2c3b2ed06f`, built from the shared tree with ADV-17 and ADV-18 in, and every migration applied (0001–0004, 0010–0013, 0020). Nothing went to production and there was no `garderobe-prod` traffic.

## Endpoints

| URL | Serves | Protection |
| --- | --- | --- |
| https://garderobe-dev.chabot.dev | `/v1` API, `/board`, `/confirm/*`, `/health` | Access app "Garderobe dev (app and web board)", all paths |
| https://garderobe-dev-mcp.chabot.dev/mcp | MCP | Workers OAuth provider (outside Access) |
| https://garderobe-dev-mcp.chabot.dev/authorize | OAuth consent | Access app "Garderobe dev (MCP consent /authorize)" |
| …/.well-known/*, …/oauth/* | discovery, token, registration | outside Access |

Both hostnames are new Worker custom domains on chabot.dev. No existing DNS record, route, Worker, Access policy or zone was modified. `workers.dev` is off (verified 404).

## Resources created (all named dev)

- Worker `garderobe-dev`, with Durable Object class `GarderobeAssistant` (SQLite, Think).
- D1 `garderobe-dev` (weur).
- Private R2 `garderobe-dev-media` (no public access).
- KV `garderobe-dev-oauth` (OAUTH_KV) and `garderobe-dev-cache`.
- Queues `garderobe-media-dev` and `garderobe-index-dev`.
- Workflow `garderobe-daily-service-dev`.
- AI Search instance `garderobe-dev-recall` (builtin, hybrid, routed through `garderobe-dev`).
- Access: two self-hosted applications; the reusable policy "Garderobe dev automation (service token)"; service tokens `garderobe-dev-automation` and `garderobe-dev-automation-owner-b`. The existing "owner only" policy is attached to the applications and was not modified.
- The existing `garderobe-dev` AI Gateway is used as it was: not recreated, settings unchanged.

**Secrets** are bound with `wrangler deploy --secrets-file` and never printed: `MCP_STATE_SECRET` and `MEDIA_URL_SIGNING_KEY` (64 random characters each, generated once), `AI_GATEWAY_TOKEN` (the AI inference token, not the deployment token), `AI_GATEWAY_ACCOUNT_ID` and `DEV_PROBE_SUBJECTS`. The deployment/management token is used only by Wrangler on the operator's machine.

## Redeploy and tear down

Run these from `garderobe/`:

- `npm run deploy:dev` is the one command: provision (idempotent), migrate, bind secrets and deploy.
- `npm run dev:seed` seeds, and `npm run dev:seed -- link owner|b` / `unlink owner|b` manages the explicit identity links.
- `npm run dev:probe -- …`, `npm run dev:verify` and `npm run dev:measure` run the probes, the verification and the usage measurement.
- `npm run teardown:dev -- --yes` removes every dev resource and keeps the gateway and the "owner only" policy.

Details are in `garderobe/deploy/README.md`.

## Seed and reconciliation

The seed ran through the foundation importer on the remote D1 and R2:

- The owner profile is byte-exact; its SHA-256 matches the spec (e15639d8…cb198).
- 41 rules.
- 127 CSV garments (130 rows, 3 merged) plus 17 owner-asserted additions, for 161 units.
- 49 migration issues, 39 of them open.
- The labelled TEST EVENT week of 2026-09-21: 11 events, which add one incoming garment, for 145 garments in total.
- Synthetic test owner B with 10 garments.
- 154 labelled DEMO placeholder images in private R2.

The reconciliation report is identical to `data/owner-inventory-reconciliation.json` apart from timestamps. The counts on dev D1 match that report, and the per-category garment and unit signature, issue keys, rule count and profile hash match the local import exactly. A re-seed is idempotent: 0 created and every item reported as already present.

## Authentication

- **Access at the edge and in the Worker.** A request with no credentials goes to Access login (302). A forged `Cf-Access-Jwt-Assertion` never reaches the API (302). A forged assertion sent alongside a valid service token cannot change who the caller is. The MCP hostname refuses app routes with `host_not_protected`.
- **Automated test identity.** Access service tokens plus a service-token policy. Access issues these assertions with an empty `sub`, which the Worker used to reject. A narrow product change maps them to `service-token:<Client ID>`. That subject reaches an owner only through an explicit `auth_identities` link, created with `dev:seed -- link` and audited in `account_audit`. It was verified live that an unlinked token gets `unknown_identity` and that relinking restores access. Revoking is `dev:seed -- unlink`, or deleting the token in Access.
- **The owner's own browser sign-in** is not linked yet: that needs the owner to sign in once.
- **MCP OAuth end to end**, against the deployed server: registration, Access-protected consent, PKCE S256 and token exchange.
  - A Claude grant with read and write, and a ChatGPT grant where the owner approved less than was requested (read only).
  - Test owner B has its own grant.
  - Refresh tokens rotate, and replaying a used one gets 400 `invalid_grant`.
  - An MCP token is refused by `/v1` (401 `invalid_token`), and an Access token is refused by `/mcp` (401).
  - Disconnecting a grant in Garderobe stops its MCP calls immediately.

## Probes (from inside the deployed Worker)

| Probe | Result |
| --- | --- |
| Model inference through `garderobe-dev` via the AI binding | **Entitled:** `anthropic/claude-fable-5-1` (binding `gateway().run` compat and the product compat route); `@cf/meta/llama-3.1-8b-instruct-fast`; `@cf/moonshotai/kimi-k2.7-code`; `@cf/baai/bge-m3` and `@cf/qwen/qwen3-embedding-0.6b` (1024-dimension embeddings). **Not entitled:** `deepseek/deepseek-flash` (also `deepseek-chat` and `deepseek-v4-flash`), 401 "Authentication Fails (governor)" on both routes. The gateway has no provider configuration for DeepSeek to fix, so this is a Unified Billing entitlement matter. Claude was unavailable from the first failure I observed at 14:22 until 14:38 UTC (503 "API key validation is temporarily unavailable", plus a 404 "model: claude-fable-5-1" at 14:36); it succeeded from 14:38, failed with `fatal` again from 14:47 to 14:50, then succeeded again. |
| Product model service (`MODEL_PROBES` recorded, no silent fallback) | `chat.fable-5-1` passed and serves chat and compaction. `chat.deepseek-flash` failed, with the reason shown. `compaction.workers-ai` failed: the model answers in `choices` form and the product transport reads only `response` (defect). `embeddings.workers-ai`: the model works directly, but the product binding transport sends chat input to it and fails (defect). |
| Think / Durable Object persistence across an actor restart | A turn was written on version 3eaaf4e2 and read after redeploying to 5baab1a3: 6 of 6 messages were present, including a real Claude reply (36,488 input and 865 output tokens). Replaying the same `clientTurnId` returned `existing` with the same run. |
| D1 transactions and idempotency (on a synthetic probe owner) | 6 of 7 checks pass: same-key replay and key reuse; 3 concurrent retransmissions commit once; a forced late failure rolls back everything; an all-or-nothing bulk wear; racing edits end as committed plus `stale_version`; receipts cannot be deleted or rewritten. **1 difference from local:** 20 concurrent identical wear reports gave 7 `committed` and 13 `merged` receipts (locally 1 and 19). The ledger itself is still correct: 1 counted wear, 20 observations, stock buckets right. |
| R2 signed asset read | The signed URL returns 200 `image/svg+xml`. A tampered token gets 404. Without a token, the owner's session gets 200 and another owner gets 404. Without Access the request is sent to login. A valid signed URL also works from another owner's session: the signed link is itself the capability, with a 5-minute private cache. |
| Queue delivery | A real composite media job was enqueued and consumed; it succeeded on the first attempt, 10–14 s from enqueue to done. |
| Workflow: evening composition | Instances completed in 13–24 s, with the evening phase `complete, published` for 2026-09-30 and 2026-10-01 (7 options each). A second run for the same evening is deduplicated (no phases). |
| AI Search | The instance was created and bound. A synthetic document was uploaded, indexed (1 chunk) and found by hybrid query (marker found, score 1). The first attempt ended in "unable_to_connect_to_ai_search" or a 30 s config timeout while the new instance settled. |

## Re-run against the deployment

`npm run dev:verify` passed 27 of 27 checks on version 5baab1a3. On the final version d2b7f450, the 25 checks other than the MCP smoke also pass.

- **Auth:** 9 checks.
- **OAuth:** 6 checks.
- **Isolation:** owner B gets 404 on the owner's item, sees only its own 10 garments, cannot resolve the owner's garment over MCP, and a forged owner field is refused.
- **Idempotency:** on the app surface, a replay returns 200 `replayed`, key reuse returns 409 and Undo works; over MCP, a retry returns the original receipt; a read-only grant gets a proposal and changes nothing.
- **Profile:** the profile's SHA-256 matches the spec, and the section 8 hard constraints (the journey suite's `harness/profile.ts`) show 0 violations on the deployed boards for 2026-09-29 and 2026-09-30.
- **Web board:** HTML with no script, `X-Frame-Options: DENY`, and a CSP.
- **MCP SDK client over HTTPS** (`backend/scripts/mcp-smoke.ts`): all seven tools, on negotiated 2026-07-28 and on the 2025-11-25 adapter. `garderobe_ask` was answered by Claude in both.

The journey and adversarial suites run in-process in workerd and cannot target a URL, so their relevant cases were re-implemented against HTTPS in `deploy/scripts/verify.ts`, reusing the journey harness's profile checker. Locally, `npm test` passed 497 of 497. The adversarial suite passed 217 of 218; the failure is an intermittent concurrent-import race (below) and passed on 3 isolated reruns.

## Measured usage (13:40–14:58 UTC, platform records)

- **Worker:** 514 invocations, 0 errors. Workers Observability CPU per request type, p50 / p95 / max in ms:
  - MCP POST: 50 / 225 / 699
  - `/v1/wardrobe`: 70 / 148 / 163
  - `/v1/today`: 22 / 28 / 37
  - `/v1/today/prepare`: 279
  - `/v1/commands`: 11 / 25 / 28
  - OAuth token: 3 / 10 / 13
  - authorize: 3–7 (p50)
  - web board: 21 / 21 / 25
  - queue consumer: 27 / 28
  - DO RPC: 13 / 45 / 93
  - DO alarm: max 371
  - D1 probe: about 230
- **Durable Objects:** 67 requests, 22.0 GB-s duration, 3.86 s CPU, 9,229 rows read, 685 rows written, 12 errors (the failed Claude turns).
- **D1:** 7,583 read queries, 4,685 write queries, 221,533 rows read, 12,011 rows written (seed included).
- **R2:** 163 PutObject and 13 GetObject; 155 objects, 188 KB.
- **Queues:** 2 each of write, read and delete.
- **AI Gateway `garderobe-dev`:** 65 requests, **$1.72** of the **$5** 30-day rule. Of that, $1.7179 is Claude (26 requests, 14 of them errors, 164,952 input and 1,367 output tokens) and $0.0004 is Workers AI. One assistant turn carries about 37k input tokens of mandatory context, roughly $0.11 per turn. That figure includes one 54k-token prompt-size diagnostic sent directly from the sandbox (about $0.16).

## Product defects found (for routing)

1. `models/transport-gateway.ts` binding route: it reads only `out.response`, so Workers AI models that answer in OpenAI `choices` form (kimi-k2.7-code) return empty text. It also sends chat `messages` to embedding models, so the `embeddings.workers-ai` profile fails even though bge-m3 works.
2. The model transport records only the error class (`fatal`/`transport`) and discards the provider's error message, so failed assistant runs cannot be diagnosed from D1 or run events.
3. Concurrent identical wear reports on real D1: several callers get `committed` receipts where local runs give exactly one (ADV-08 semantics). The ledger stays correct.
4. Intermittent race (local adversarial suite): two different staged packages confirmed at the same time were both imported into one owner (288 garments against a maximum of 144).
5. Cost: about 37k input tokens per assistant turn (the full profile plus the wardrobe index every turn) means roughly $0.11 per Claude turn.

## Not live

Google (Gmail, Calendar), Exa, Tavily, Browser Run and image providers have no credentials and stay unconnected. Real Claude and ChatGPT consumer connections were not made; test clients stand in for them with those redirect URIs. The owner's own Access sign-in is not linked yet.
