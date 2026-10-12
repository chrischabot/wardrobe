# API and MCP adversarial tests

Owned by the adversarial test suite work item. See `../README.md` for the shared harness and the rules.

| Path | Contents |
| --- | --- |
| `worker/` | The adversarial suite against the real Worker: fourteen threat classes (isolation, authentication and grants, replay and races, time, prompt injection, hostile models, profile integrity, hostile imports and exports, recovery and confirmation, signed media, outbound policy, secrets, ledger invariants, a hostile connected assistant). It is a nested run with its own `vitest.config.ts`, because it puts its own outbound double (a scripted-response layer and a log of every request leaving the Worker) in front of the journey suite's doubles. Its README lists the threat classes, the stand-ins and the data rules; its `DEFECTS.md` lists every open defect it found. |

`npm test -w @garderobe/adversarial-tests` runs `worker/` after the shared configuration (`scripts/run.mjs`); `npm run test:api-mcp -w @garderobe/adversarial-tests` runs this area alone.
