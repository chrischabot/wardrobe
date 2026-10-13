# Product defects found by the adversarial suite

Every open row is a test in this directory that asserts the behaviour the specification, the owner's profile, the
owner's contract of 2026-10-05 or a coordinator ruling requires, and that the application currently fails. No
assertion was weakened to pass. In the default run (`npm test`) each open entry is a visible expected failure
(`[OPEN DEFECT <id>]`); in the strict run (`npm run test:strict`) each fails as an ordinary test. The two marked
*strict only* do not fail on every run (a race, and a crash that disturbs the runner), so they are skipped in the
default run.

Found at `garderobe-rebuild` commit `5db4fd87` and later runs. **Current status is from the default run of
2026-10-13 on `garderobe-rebuild` tip `97ed5ffc`:**

- api-mcp/worker on `97ed5ffc`: 15 files, 425 tests: 404 passed, 19 expected failures, 2 skipped (strict only), 0 failed.
  The 19 expected failures plus the 2 strict-only skips are the 21 open entries below.
- M14-3, M14-4, M14-7 and M14-8 have candidate fixes in `.fabric-parked/api-batch-4b-proposals.patch`, and D11-3 has a
  candidate fix in `.fabric-parked/api-batch-2-3.patch`; until those parked patches land on `garderobe-rebuild`, their
  tests remain `defect(...)` expected failures.
- L03-4 is new on `97ed5ffc`: `recommend` (`mode: "board"`) and `rebuildDay` in `packages/daily/src/service.ts` choose
  `reason: existing ? "rebuild" : "compose"` before `prepareBoard` checks `answerIfClaimed()`, so a retransmitted
  `POST /v1/recommendations` (`mode: "board"`) with the same `clientRequestId` after the first call created the board
  computes a different `requestFingerprint` and is refused with 409 `idempotency_key_reuse`.
- daily-media on `97ed5ffc`: 5 files, 46 passed, 0 failed. Typecheck (`npm run typecheck -w @garderobe/adversarial-tests`): passed (exit 0).

Reproduction, expected and actual behaviour, and the product file and line are in the linked file for each area.
Severities are the suite's own judgement. When the owning workstream fixes an entry, the default run reports its test
as "expected to fail". The test's `defect(...)` then becomes `it("[fixed <id>] …")` with its body unchanged, and
the entry moves to "Fixed and re-verified".

**65 found: 21 open (2 high, 12 medium, 7 low; M14-3, M14-4, M14-7, M14-8 and D11-3 among them have candidate fixes in
`.fabric-parked/`), 41 fixed and re-verified, 2 resolved by the contract, 1 withdrawn
(M14-11: the harness reported the MCP SDK's input-schema refusal as `internal`; see [connected](defects/connected.md)).**
I06-2 and D12-2 are the same fault found from two sides.

## Open

| ID | Severity | Owning workstream | Defect | Details |
| --- | --- | --- | --- | --- |
| I06-4 | high | assistant | After one oversized tool-call argument, the run of the next message stays `running` for ever | [injection](defects/injection.md) |
| D10-3 | high | API/MCP | A connected assistant gets image bytes, a storage location or a link over MCP, or can be authorized to upload. The API thread ruled the test right | 10 "a connected assistant gets no image bytes…" |
| R09-3 | medium | API/MCP | Two sessions unlinking each other's sign-in at the same moment leave an account with no sign-in (unreachable without an active recovery kit); *strict only* | [access](defects/access.md) |
| L03-4 | medium | daily | A retransmitted `POST /v1/recommendations` (`mode: "board"`) with the same `clientRequestId` is refused with 409 `idempotency_key_reuse` once the first call has created the board (`reason` switches from `"compose"` to `"rebuild"` before `answerIfClaimed()`) | [ledger](defects/ledger.md) |
| I05-5 | medium | assistant | A search query carries the reason for the owner's footwear restriction to the search provider | [injection](defects/injection.md) |
| I06-2 | medium | assistant | A secret the model writes in its reply is served by the transcript route and sent back to the model | [injection](defects/injection.md) |
| I06-5 | medium | assistant | After one oversized tool-call argument the conversation is unusable from then on | [injection](defects/injection.md) |
| I06-7 | medium | assistant | A research run completes with a verdict and "checked" sources for pages that were never retrieved | [injection](defects/injection.md) |
| D12-2 | medium | assistant | A credential in the assistant's own reply is removed from the run result but stored and served in clear (same fault as I06-2) | [data](defects/data.md) |
| M14-2 | medium | API/MCP | A connected assistant undoes a wear the owner recorded by their own tap, with no owner action (coordinator ruling 2026-10-12) | [connected](defects/connected.md) |
| M14-3 | medium | API/MCP (parked `.fabric-parked/api-batch-4b-proposals.patch`) | A typed request (`garment.remove_fabricated`) that names no versions is confirmed although the owner changed the garment after it was made | [connected](defects/connected.md) |
| M14-8 | medium | API/MCP (parked `.fabric-parked/api-batch-4b-proposals.patch`) | A burst of concurrent requests on one connection leaves more than 40 undecided requests | [connected](defects/connected.md) |
| I05-9 | medium | assistant | A whole-category wash relayed through `garderobe_ask` is still kept for the owner, although the 2026-10-13 ruling refuses an unbounded change outright (the typed path already refuses it) | [injection](defects/injection.md) |
| M14-4 | low | API/MCP (parked `.fabric-parked/api-batch-4b-proposals.patch`) | A stored request whose payload was changed in the database is carried out under the identifier the owner saw | [connected](defects/connected.md) |
| M14-7 | low | API/MCP (parked `.fabric-parked/api-batch-4b-proposals.patch`) | One `garderobe_ask` turn leaves more requests for the owner than the connection has room for | [connected](defects/connected.md) |
| D08-2 | medium | API/MCP (after the assistant's held change) | An import that fails part-way says nothing was kept but leaves records and image files, and the account can no longer be imported into. A fix passed in the shared tree on 2026-10-13. It was taken back out because, by coordinator ruling, it lands only with the assistant's `discardImportedConversation` | [data](defects/data.md) |
| D11-3 | low | API/MCP (parked `.fabric-parked/api-batch-2-3.patch`) | OAuth metadata that names a `javascript:` sign-in address is answered with a server error (500 `internal`) instead of a refusal | [data](defects/data.md) |
| L03-2 | low | foundation | A burst of 80 simultaneous owner reports: many are refused with HTTP 500 instead of being rebased and recorded | [ledger](defects/ledger.md) |
| I06-6 | low | assistant | A tool-call argument nested 3,000 levels deep crashes the turn and leaves an unhandled rejection; *strict only* | [injection](defects/injection.md) |
| M14-6 | low | API/MCP | A second connection of the same client is given a further 40 waiting requests; the ruling is 40 per owner (vehicle now `media.delete_asset`) | [connected](defects/connected.md) |
| M14-10 | low | media; API/MCP for the published flag | A connected assistant's typed `media.decide_review` (a direction under the contract) is refused `forbidden` before the command reads it, although `/v1/command-types` publishes it as not consequential | [connected](defects/connected.md) |

## Fixed and re-verified

Each test below failed when its entry was found. In a default run its body then passed (reported "expected to fail"),
and it is now an ordinary `[fixed <id>] …` test with the body unchanged, passing in the 2026-10-13 run. Severities are
as found. "Tree" means the fix was verified on the shared project tree; whether it has reached `garderobe-rebuild` is
for the owning workstream to state. Entries with a commit were reported fixed by that commit.

| ID | Severity | Owning workstream | Fix |
| --- | --- | --- | --- |
| P07-1, P07-2 | high | foundation | `9fdbcbf3` (`correction_would_release_restriction` for every caller) |
| P07-3, P07-4, P07-5 | medium | foundation | `9fdbcbf3` |
| P07-6 | low | foundation | `9fdbcbf3` |
| P07-7, P07-8 | low | foundation | `2124ae89` |
| P07-9 | low | daily | `cb2767f4` |
| L03-3 | medium | foundation | `9fdbcbf3` |
| L04-1, L04-4, L04-5 | low | foundation | `9fdbcbf3` |
| L04-2, L04-3, L04-6 | medium | foundation | `9fdbcbf3` |
| L13-1 | low | daily | `cb2767f4` |
| L13-2 | medium | foundation | `9fdbcbf3` |
| I05-1, I06-3, I06-8 | high | assistant | `8445a1e9` |
| I05-2, I05-3, D08-4 | medium | assistant | `8445a1e9` |
| I06-1 | low | assistant | `8445a1e9` |
| I05-4 | low | assistant | tree (a mailbox job whose model cannot be reached settles) |
| I05-6 | medium | assistant | tree (a mailbox search from a turn waits for the owner) |
| I05-7 | high | assistant | `999d41c6` (doubt words make a sentence non-factual; `policy/intent.ts`) |
| I05-8 | medium | foundation / domain | `9fdbcbf3` (`receiptSummary()` in `packages/domain/src/commands/service.ts`) |
| D08-5 | high | assistant | `5d41122f` (a forged `importAuthorizedBy` authorizes nothing; logging orders needs an owner tap) |
| D12-1 | medium | assistant | `c3197877` |
| A02-1 | low | API/MCP | `5ada4cdb` (`mcp/consent.ts`) |
| R09-1 | medium | API/MCP | `5ada4cdb` (`auth/session.ts`) |
| R09-2 | low | API/MCP | `5ada4cdb` (`identity/service.ts`) |
| D08-1, D10-2 | low | API/MCP | `5ada4cdb` (`router.ts`) |
| D08-3 | low | API/MCP | `a8bff49a` (`export/package.ts`) |
| D10-1 | low | API/MCP, visual wardrobe | `00541280` / `a8bff49a` (GPS stripped from the shared rendition by default; `delivery.ts`; see the note below) |
| D11-1 | high | API/MCP | `5ada4cdb` (`connections/endpoints.ts` resolves before calling) |
| D11-2 | high | daily, API/MCP | `d3e7210a` (400 `https_required`) |
| M14-1 | high | API/MCP | `5ada4cdb` |

## Resolved by the owner's contract of 2026-10-05 (not defects now)

The contract ("changes apply at once with undo on every surface") changed what these tests asserted. Each is now a
passing `[contract]` test of the behaviour the contract requires:

- **M14-5**: the vehicle is a bulk correction; fields it clears are shown in the summary as cleared, and confirming clears exactly those.
- **M14-9**: mailbox and spreadsheet jobs from a connected assistant wait for the owner; other job kinds start as the assistant's receipted change.

## Rulings in force

- **The 2026-10-05 contract** (library "Contract: changes apply at once with undo on every surface"). Observations, bookkeeping and directions apply at once with a receipt and undo on every surface. Only section-3 changes (irreversible erasure, authorization towards another party, what a model or an outside connection may reach, rewriting the profile document) and changes to an unbounded set were to wait for the owner (now refused outright; see below). A restriction lift through an assistant is refused, and so is the undo of a restriction record. Tests 03, 04, 05, 06, 14 and 14b were rewritten to it.
- **M14-2** (coordinator, 2026-10-12): a connected assistant may directly undo only its own explicit report; undoing a record the owner made by their own tap waits for the owner. This is narrower than contract section 4 ("a change made on one surface can be undone from any other"); the ruling is the newer instruction and the test follows it.
- **M14-6** (coordinator): the 40-request waiting limit is per owner, across all of that owner's connections.
- **D10-1** (coordinator): a shared or exported image strips GPS by default. Note: the owner's own authenticated read of an original is now a lossless re-encode without Exif/GPS, but the stored R2 original still matches the recorded hash of the supplied bytes, so the original is **stored with its location**. Whether storing it so is acceptable under this ruling is open for the coordinator.
- **P07-1, P07-2** (coordinator): a classification correction never silently lifts a restriction.
- **Whole-category wash and other unbounded changes from an assistant** (coordinator ruling of 2026-10-13, `isUnboundedChange` in `packages/assistant/src/policy/classes.ts`): a change whose reach is not bounded by at most 20 named pieces (`allOfChannel`, a `garment.bulk_correct` without a numeric `expectedCount` of at most 20, any list longer than 20) is refused outright, `invalid_command` with `details.reason: "change_exceeds_bound"`. Nothing is written and nothing waits for the owner. The suite asserts this on the typed path (14); the relayed path still keeps it (open I05-9). It replaces the earlier agreement that such a change waits for the owner.

## Ruled intended

- **Export of `proposal_decisions`** (API/MCP, 2026-10-12): decisions are exported and restored; only the decision columns and the exporting owner's rows; a planted package's decisions are never imported.
- **A calendar projection waiting for an outfit calendar** (daily, 2026-10-12): rescheduled rather than cancelled.
- **L03-1** (daily, 2026-10-03): parallel board selections against one revision all succeed and the last stands.
- **Research retrieval of a name with a private DNS answer** is forwarded to the outside retrieval service by design (`extract.ts:131-135`); the Worker itself never contacts it, and the test asserts that.
- **An image search that cannot go further** (media, 2026-10-13): once every available source was tried, the garment goes to Photos needed. The media workstream says the retry of a failed server (429/5xx) was dropped only because its discovery rework has not landed yet; test 11 accepts either form until it does, and still asserts that nothing is fetched from a private address and nothing is stored.

## Former triage items (2026-10-12)

- N-1 became D08-5, N-2 became D10-3, N-3 became M14-9 and N-4 became I05-6.
- N-5, N-6 and N-7 were contract-driven: the tests were rewritten to the contract and pass.
- N-8 is intended (see the D10-1 note above).

## Observed, not filed (no test)

- An import whose image records are all set aside reports media imported in full, with no note (`apps/worker/src/export/import.ts:203`).
- A typed `style.save_document` sent without an expected version is kept as a request, but confirming it always fails with `expected_version_required` (`style.ts:222-224`).
- The ledger's `payload_json` keeps forged keys such as `authorization: "owner_tap"` verbatim. Nothing that reads them was found; the search was not exhaustive.
- A wear dated in a named zone where the day has begun is recorded even when it is still tomorrow at the owner's home (`primitives.ts:36` says this is designed).
- Open question for the coordinator: whether a typed `assistant.report_arrival` from a connection should apply. It is refused now, consistent with contract section 5 ("from the owner's own conversation turn"), but `/v1/command-types` publishes it as not consequential.

## Coverage gaps (not defects)

- **Compromised mailbox-extraction model.** The email channel is tested up to the fetch of a planted order email. The
  background job's extraction model has no test seam: without an AI binding, `apps/worker/src/scheduled/assistant.ts`
  makes every model call fail, and the FAKE MODEL serves only the conversation route. So no test shows that a
  compromised extraction model obeying the email is contained. The seam is `jobDeps` in that file (API/MCP workstream),
  which was asked on 2026-10-12 to pass the labelled FAKE MODEL in the test build.
