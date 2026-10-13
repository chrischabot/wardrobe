# Coverage gaps: deployment, platform configuration, cost and operations

Audited at `garderobe-rebuild` commit `8445a1e`, by reading files; nothing was executed and no cloud resource was inspected. This commit predates the merge of the one-command development deployment (pull request #35), so the deployment thread should re-check each entry against its own `deploy/` files and deployed state. "spec" is `requirements/garderobe-replacement-design.md`. Per-row verdicts are in `../rows/F-deployment-acceptance.md` unless another part letter is given.

At the audited commit there is no `deploy/` directory and `apps/worker/wrangler.jsonc` is local only (`name: garderobe-local`; its header says so at lines 4-7). Almost every row here is honestly `open` or `blocked`; they are listed because the requirement is not met.

## Findings the deployment thread should weigh

| Row | Source | Finding | Evidence | Closes when |
| --- | --- | --- | --- | --- |
| S14-001, S14-002, S14-010 to S14-015, S14-017, S14-018, S14-025, S14-030, S19-013, S19-014, S19-018 | spec L883, L899-L919, L1207-L1217 | The configuration declares none of: Workflows, the `ai` binding, AI Search, Browser Run, Images, Secrets Store, Flagship, Analytics Engine, a dead-letter queue, an index queue, an `observability` block, routes for the two hostnames, separate development and production environments. | `apps/worker/wrangler.jsonc:16-31,44` | The deployed configuration declares each, or the row records why it is not used. |
| S04-002, S04-009, S14-008 | spec L140, L166-169, L889 | No Workflow class exists and the Worker's `queue` handler dispatches to media only, so the assistant's queue and Workflow drivers have nothing to bind to. | `apps/worker/src/index.ts:57-83`; `packages/assistant/src/jobs/runner.ts:140` (D) | A `WorkflowEntrypoint` and assistant queue consumer are bound. |
| S19-015 area | spec L1214 | `apps/worker/src/env.ts:27-33` adds an optional Cloudflare API token (`AI_GATEWAY_LOGS_TOKEN`) as a Worker secret, against "no account token is stored in the app". | | The token is removed, or the deviation is recorded and scoped. |
| S14-027, S17-069 | spec L916, L1155 | Logs are free text without run or action identifiers; four call sites log a full error stack unredacted. | `apps/worker/src/router.ts:78`; `export/job.ts:417`; `export/import.ts:229`; `mcp/server.ts:100` | Structured, redacted logs with a test. |
| S13-042 note | spec L849 | `global_fetch_strictly_public` is set only in the local configuration; no row makes the deployed configuration keep it. | `apps/worker/wrangler.jsonc:14` (D) | The deployed configuration sets it and a check asserts it. |
| S14-024 | spec L913 | The credential wrapping key is an ordinary Worker secret, not a Secrets Store binding. | `apps/worker/src/env.ts:54` | Secrets Store is bound, or the row records the deviation. |
| S15-008, S15-010 | spec L981, L985 | Disabling alternate public routes and the Access policies on the two hostnames are deployment configuration that does not exist. | (D) | Configured and probed. |

## Open or blocked groups with no evidence

- **Pinning and upgrade:** S14-009, S17-055 (no preview failure or upgrade and restore test); S04-037 (no release record).
- **Observability and operations:** S14-028, S14-029, S17-046, S17-068 (no redacted traces, analytics, alerts, probe record or fourteen-morning trial).
- **Cost and measurement:** S14-006, S14-043, S14-044, S14-046 to S14-052, S14-054 to S14-056, S14-058, S17-020, S17-044, S17-048, S02-016, S20-014, S20-021, S20-022 (nothing measured under Free plan limits; no charge reconciled).
- **Controls and flags:** S14-031 (DNS, TLS, WAF half), S14-032, S14-033, S14-035, S14-042.
- **Services recorded as not used:** S14-036 to S14-040 hold by absence with nothing recorded.
- **Cutover and rollback:** S16-019 to S16-022 (no snapshot trial on a test calendar, write freeze and delta import, calendar adoption or rollback procedure).
- **Real service paths:** S17-040, S15-026, S15-027, S20-007 (no real Google receipt, read-back, revoked token, verification outcome or seven-day unattended refresh); S13-049 (real client consent, refresh, scope denial, revoke and reconnect); S15-047, S15-048 (retention on the real bucket; restore drill on real resources); S08-029 (concurrency and forced-late-failure on deployed D1); S02-011 (managed and preview services verified); S04-049, S04-050.
- **Probes:** S12-004, S12-014, S12-022: no profile has been probed on a real Gateway.
- **Setup record:** S19-005, S19-008 to S19-012, S19-015 to S19-017 (no secret installed, no gateway settings declared or re-verified, no route probed with an exact model identifier); S18-022 (remaining setup inputs tracked nowhere).
- **Kickoff deliverables:** KO-031 to KO-034 (credential handling, the development deployment, untouched production, commit hygiene: open, no evidence); KO-035 (no source archive or consolidated test-results record); KO-030, KO-037 (no remaining-integration checklist or deployment instructions for Cloudflare beyond `apps/worker/README.md:138`).
- **Media on deployment:** the Images binding and every media provider are absent; the cache purge of S11-035 has not run on a deployment; S14-014 has no R2 lifecycle rule.
- **iOS distribution:** S14-062 (no TestFlight build or chosen route).
