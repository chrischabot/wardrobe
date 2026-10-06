# Evidence

Files here are written by the commands in `deploy/`. They hold identifiers, statuses, timings and counts; no credential, token, invitation code or personal text.

## What exists (2026-10-03)

The local runs below were made on commit 5db4fd875484 of `garderobe-rebuild`. The branch head at publication, 7069aa75ba8b, differs from it only in files under `ios/`.

| File | Written by | What it shows |
| --- | --- | --- |
| `preflight.json` | `node deploy/deploy.mjs --commit 5db4fd87…` | The deploy command stopped before any call: `CLOUDFLARE_API_TOKEN` is absent from the environment. Nothing was provisioned or deployed. |
| `access-probe.json` | `node deploy/probe-access.mjs --inference` | What the credentials that are present reach. The gateway credential reads Workers scripts, Access applications and AI Search, and is refused by D1, KV, Workflows (401, code 10000) and by R2, Queues, AI Gateway management and the Access organization (403, code 10000); the zone list is empty. The R2 key pair lists 16 buckets, none of this build's. Through the development gateway's REST endpoint with no provider key, `anthropic/claude-fable-5-1` answered (HTTP 200); `deepseek/deepseek-flash` and `openai/gpt-6-astra` were refused (HTTP 401). |
| `rehearsal-local.json` | `node deploy/rehearse.mjs` | **Local, not platform evidence.** The verification run against Miniflare simulators: 35 checks passed, 0 failed, 12 not run (the platform-only ones, each with its reason). |
| `reference-import.json` | `node deploy/rehearse.mjs` | The owner's profile and inventory imported by the real importer into a fresh local database: 127 garments, 144 units, 28 current rules, 5 measurements, 1 active restriction, no wear or laundry history, 169 import commands; a second seed replayed all 169 receipts and changed nothing. The deployed database must reconcile to these values. |
| `build-check.json` | `node deploy/rehearse.mjs` | The three deployment configurations build with `wrangler deploy --dry-run` (product Worker 11,483 KiB, 2,344 KiB gzipped). Nothing was uploaded. |

## What does not exist

`deploy.json`, `verify-dev.json` and `teardown-dry-run.json` are written only by runs against the account. None has run, so none of the following is verified on the platform: provisioning, migrations on deployed D1, bound secrets, the deployed API and MCP endpoints, Access, the seed and its reconciliation on deployed D1, isolation, idempotency, scopes and the MCP session over HTTPS, D1 batch limits for the 200-garment bulk correction, the deployed-D1 concurrency test (checklist row S08-029), R2 privacy, Queue retry and dead-lettering, Workflows, Durable Object persistence across a restart, AI Search, AI Gateway probes through the AI binding (so every conversation turn on a deployment would still end as resumable), the Images service, the runtime's outbound restrictions, the research providers from a Worker, Google Calendar and WeatherKit.

Model spend by this work: three answered calls of 22 tokens each on `anthropic/claude-fable-5-1` (two exploratory, one in `access-probe.json`) and six refused calls.
