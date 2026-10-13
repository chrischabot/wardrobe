# Open defects: a connected assistant that over-reaches (test class 14)

Found by `test/14-connected-assistant.test.ts` and `test/14b-connected-assistant-limits.test.ts` against
garderobe-rebuild 5db4fd87 (`adv-base-5db4fd8/`), in the local in-process Worker. Each entry was
registered with `defect(...)` when it was found; while it is open the test asserts the correct behaviour and is an
expected failure, and it is reported as "expected to fail" once the defect is fixed. Current status is in
`../DEFECTS.md`. Line numbers refer to `adv-base-5db4fd8/`.

**Status after the rewrite to the 2026-10-05 contract (2026-10-13, `garderobe-rebuild` tip `97ed5ffc`):** M14-1 is fixed
and re-verified (`[fixed …]`, body unchanged). M14-5 and M14-9 are now `[contract]` tests of the behaviour the contract
requires and pass. M14-2 stays open under the coordinator's ruling of 2026-10-12. M14-3, M14-4, M14-6, M14-7 and M14-8
stay open, with their vehicles moved to the requests that still wait under the contract (section-3 types): M14-3 and
M14-4 use `garment.remove_fabricated`, M14-6 and M14-8 use `media.delete_asset`, and M14-7 uses eight relayed `forget`
calls (fixes for M14-3, M14-4, M14-7 and M14-8 are in the API/MCP workstream's parked patch
`.fabric-parked/api-batch-4b-proposals.patch`, not yet on `garderobe-rebuild`). M14-10 is open. The reproductions below
are kept as found; the tests hold the current vehicles.

### M14-1: a wash report that names one garment and also carries `allOfChannel` washes the whole hamper with no owner action
- Severity: high
- Owning workstream: API/MCP (apps/worker)
- Test: test/14-connected-assistant.test.ts, "a wash report that names one garment and also carries `allOfChannel` washes the whole hamper with no owner action"
- Expected: a connected assistant may directly record only a wash report for the garments it names; "everything in the hamper is washed" names none and waits for the owner (the rule stated in `apps/worker/src/mcp/policy.ts` lines 129-130 and in the owner's decision). A report carrying both `items` and `allOfChannel` must either wait for the owner or wash only the named garment.
- Actual: `garderobe_command` answered with a committed receipt (actor `assistant`, channel `mcp`) whose summary lists every garment that was in the hamper. Every dirty `service` garment of the owner was moved to clean: `stock_balances` held no dirty unit afterwards although only `shirt-gold` was named. No proposal was created.
- Reproduction: synthetic owner; in the app `care.mark_dirty` for `shirt-gold`, `shirt-slate`, `shirt-red-stripe`, `trouser-olive` (one unit each); then over MCP (write grant) `garderobe_command` `{ type: "care.washed", payload: { items: [{ garmentId: "shirt-gold" }], allOfChannel: "service" }, idempotencyKey }`; read `SELECT garment_id, quantity FROM stock_balances WHERE bucket = 'dirty' AND quantity > 0`.
- Where: `apps/worker/src/mcp/policy.ts:130` sends the type to the owner only when `items` is empty, and does not look at `allOfChannel`; `packages/domain/src/handlers/wear-care.ts:382-395` then washes every dirty garment of the channel before it handles `items`.

### M14-2: a connected assistant undoes a wear the owner recorded by their own tap in the app, with no owner action
- Severity: medium
- Owning workstream: API/MCP (apps/worker)
- Test: test/14-connected-assistant.test.ts, "a connected assistant undoes a wear the owner recorded by their own tap in the app, with no owner action"
- Expected: a connected assistant may directly perform only wear and wash reports, research records and the listed routine actions (each with its own undo); removing a wear the OWNER recorded is a correction of the day's record and waits for the owner, as `wear.amend` does and as the backend assistant's own `undo` tool does (`packages/assistant/src/tools/write.ts:402-404`, "Recorded as a request the owner confirms").
- Actual: `command.undo` of the owner's `wear.record` (stored with actor `owner`, `owner_tap`) ran at once: `ok` with a receipt, the `daily_wears` row for that garment and day is no longer `active`. No proposal was created.
- Reproduction: real-owner fixture; in the app `wear.record` `{ wearingDate: <three days ago>, garmentIds: [<labelled synthetic shirt>] }`; over MCP (write grant) `garderobe_command` `{ type: "command.undo", payload: { commandId: <that receipt's commandId> }, idempotencyKey }`; read `SELECT COUNT(*) FROM daily_wears WHERE wearing_date = ? AND garment_id = ? AND status = 'active'`.
- Where: `apps/worker/src/mcp/policy.ts:111-124` classes an undo by the TYPE of the command it undoes ("treated as the change it undoes") and does not consider who made that command.
- Ruling (coordinator): a defect. A connected assistant may directly undo only its own explicit report; undoing a record the owner made waits for the owner.
- Status 2026-10-13: still open on the shared tree. The test now also lets the owner decline the waiting undo and checks that the record stays. The connected assistant's undo of its own wear report, done once only and replayed under its key, is a separate passing `[contract]` test.

### M14-3: a typed request that names no versions is confirmed although the owner changed the garment after it was made
- Severity: medium
- Owning workstream: API/MCP (apps/worker)
- Test: test/14-connected-assistant.test.ts, "a typed request that names no versions is confirmed although the owner changed the garment after it was made"
- Expected: a stale proposal is rejected: when the garment changed after the request was made, confirming answers 409 `conflict`, nothing is written and the proposal stays pending.
- Actual: `POST /v1/proposals/{id}/decision` `{ decision: "confirm" }` answered 200 with a committed `garment.correct` receipt; the garment's name and colour were overwritten with the request's values, including the colour the owner had set after the request was made. A typed request is stale-checked only against versions the connection itself chose to send; when it sends none, nothing is checked.
- Reproduction: synthetic owner with a labelled synthetic shirt; over MCP `garderobe_command` `{ type: "garment.correct", payload: { garmentId, changes: { name: "...", colour: "..." }, source: { kind: "owner_statement" } }, idempotencyKey }` (no `expectedVersions`) -> `confirmation_required`; in the app `garment.correct` `{ garmentId, changes: { colour: "...set by the owner afterwards" } }`; then `POST /v1/proposals/{proposalId}/decision` `{ decision: "confirm" }`.
- Where: `apps/worker/src/mcp/server.ts:296` stores `args.expectedVersions ?? {}`; `apps/worker/src/proposals/service.ts:268-275` runs the command with exactly those. The conversation path records the versions itself (`packages/assistant/src/policy/describe.ts:378`, `expectedVersionsFor`); the typed path does not call it.

### M14-4: a stored request whose payload was changed after the owner was shown it is carried out under the identifier the owner saw
- Status: fixed in the shared tree by the API/MCP workstream (its test passed in run 14). The fix is in that workstream's held batch, not yet on `garderobe-rebuild`, so at its request the test stays `defect("M14-4", …)` until the batch lands; on the shared tree it reports an unexpected pass.
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/14-connected-assistant.test.ts, "a stored request whose payload was changed after the owner was shown it is carried out under the identifier the owner saw"
- Expected: the proposal identifier covers the exact command, so a request that was changed is a different proposal (`apps/worker/src/proposals/service.ts:23-24`); confirming the identifier the owner saw must not run a different payload.
- Actual: after the stored `payload_json` of a kept typed request was changed in the database, `POST /v1/proposals/{id}/decision` `{ decision: "confirm" }` with the ORIGINAL identifier answered 200 and recorded the changed alias ("SYNTHETIC alias swapped in after the owner looked"). The identifier of a kept request is computed once when it is stored and is not checked against the stored request when it is decided. (A relayed turn's proposal is protected: its identifier is recomputed from the stored text, and the equivalent change answers 404; see the passing test "ties a relayed turn's request to what the owner was shown".) Reaching this needs write access to the database, so it is a missing integrity check rather than a path open to a connected assistant.
- Reproduction: synthetic owner; over MCP `garderobe_command` `garment.add_alias` `{ garmentId, phrase: "SYNTHETIC alias the owner was shown" }` -> `confirmation_required`; `GET /v1/proposals` (the owner reads it); `UPDATE submitted_proposals SET payload_json = <same payload with another phrase> WHERE proposal_id = ?`; `POST /v1/proposals/{proposalId}/decision` `{ decision: "confirm" }`; read `garment_aliases`.
- Where: `apps/worker/src/proposals/service.ts:158-169` and `193-200` take `proposal_id` and `payload_json` from the row as they are; `request_hash` (`apps/worker/src/proposals/store.ts:122-123`) is never compared with the stored payload at decision time.

### M14-5: fields a correction clears (sent as null) are executed on confirmation but never shown in the summary
- Severity: high
- Owning workstream: assistant (packages/assistant)
- Test: test/14-connected-assistant.test.ts, "fields a correction clears (sent as null) are executed on confirmation but never shown in the summary"
- Expected: the summary the owner confirms shows the whole request: every executed field, nothing hidden.
- Actual: for `garment.correct` with `changes: { name: "SYNTHETIC harmless rename", colour: null, fabric: null, maker: null, size: null }` the summary reads only: `Change the record of "<garment>": name "SYNTHETIC harmless rename". Also written with it: source kind "owner statement".` Confirming it (200) set the garment's colour, fabric, maker and size to NULL. The same omission was observed for `settings.update` with `{ patch: { homeLocation: null, timezone: "Asia/Tokyo" } }`, summarised as the timezone only; by the code it applies to any payload value that is `null` or an empty string (not run for other types).
- Reproduction: synthetic owner with a labelled synthetic shirt that has a colour, fabric, maker and size; over MCP `garderobe_command` `{ type: "garment.correct", payload: { garmentId, changes: { name: "SYNTHETIC harmless rename", colour: null, fabric: null, maker: null, size: null }, source: { kind: "owner_statement" } }, idempotencyKey }`; `GET /v1/proposals` (read `summary`); `POST /v1/proposals/{proposalId}/decision` `{ decision: "confirm" }`; read the garment row.
- Where: `packages/assistant/src/policy/describe.ts:56-58` (`fields` drops values that are null or empty), `:62-63` (`leaves` treats null and "" as not being a field), `:261` (the `garment.correct` sentence).

### M14-6: a second connection of the same client is given a further 40 undecided requests
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/14-connected-assistant.test.ts, "a second connection of the same client is given a further 40 undecided requests"
- Expected: the cap of 40 undecided requests holds across a second connection of the same client (the code's own comment: "opening a second connection ... gives no further room", `apps/worker/src/proposals/store.ts:58-59`).
- Ruling (coordinator): the cap of 40 undecided requests is per owner, across all of the owner's connections.
- Actual: with 40 requests of the client waiting, the owner approved the same registered client (same `client_id`, same redirect address) a second time; the new connection's next request was kept (`confirmation_required`), and it can go on to 40 of its own. The total is bounded at 80 per owner (the passing test "never lets all of an owner's connections together leave more than 80"), which is what `apps/worker/README.md` documents; so the per-client cap of 40 is not held, the per-owner ceiling of 80 is.
- Reproduction: synthetic owner; connect an MCP client with write access; send 40 `reminder.set` requests (all `confirmation_required`), the 41st answers `rate_limited`; run the authorization flow again with the same `client_id` and redirect address and approve it; send one more `reminder.set` over the new connection.
- Where: `apps/worker/src/proposals/store.ts:108-111` (`hasRoomToWait` counts per grant; a new consent is a new grant, and `apps/worker/src/mcp/grants.ts:77-85` only marks the earlier grant superseded).

### M14-7: one garderobe_ask turn leaves more requests for the owner than the connection has room for (45 undecided with a limit of 40)
- Status: fixed in the shared tree by the API/MCP workstream (a new turn starts only when there is room for the 8 requests one turn can leave: `hasRoomFor` in apps/worker/src/proposals/store.ts). Its test passed in run 14. It is held with M14-4 and stays `defect("M14-7", …)` until the batch lands. The test now requires the turn to be refused (`rate_limited`) with 37 of 40 places taken, and the list to stay at 37.
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/14-connected-assistant.test.ts, "one garderobe_ask turn leaves more requests for the owner than the connection has room for (45 undecided with a limit of 40)"
- Expected: the cap of 40 undecided requests per connection holds together with `garderobe_ask` turns.
- Actual: a connection with 37 requests waiting sent one `garderobe_ask`; the backend assistant (FAKE MODEL, scripted to try eight `add_garment` changes on the relayed message) recorded eight proposals on the turn. `GET /v1/proposals` then listed 45 pending requests, all attributed to that one connection. (At or above 40 a new turn is refused with `rate_limited`; that part holds and has a passing test.)
- Reproduction: synthetic owner with the fake model enabled; over MCP send 37 `reminder.set` requests; script the fake model with eight `add_garment` tool calls; `garderobe_ask` `{ message, clientTurnId, mode: "wait" }`; `GET /v1/proposals`.
- Where: `apps/worker/src/mcp/server.ts:327` checks the room once, before the turn starts; what the turn then records in `assistant_turns.proposals_json` is not limited to the room that was left (the per-turn limit of 12 in `apps/worker/src/proposals/store.ts:61,132` applies only to commands refused on a relayed turn). The recording code in packages/assistant was not located.

### M14-8: a burst of concurrent requests on one connection leaves more than 40 undecided requests
- Severity: medium
- Owning workstream: API/MCP (apps/worker)
- Test: test/14b-connected-assistant-limits.test.ts, "a burst of concurrent requests on one connection leaves more than 40 undecided requests"
- Expected: one connection can have at most 40 undecided requests waiting for the owner, however the requests arrive.
- Actual: 60 `reminder.set` requests sent at once over one connection (distinct idempotency keys): 59 answered `confirmation_required` and `GET /v1/proposals` listed 59 pending requests for that connection. The count is read and the row inserted in separate steps, so concurrent requests all see room. By the same code the per-owner ceiling of 80 is open to the same race; that was not run.
- Reproduction: synthetic owner; connect an MCP client with write access; `Promise.all` of 60 `garderobe_command` calls `{ type: "reminder.set", payload: { kind: "other", title: "SYNTHETIC reminder <n>", dueAt }, idempotencyKey: <unique> }`; `GET /v1/proposals`.
- Where: `apps/worker/src/proposals/store.ts:130-139` (`waitingRequests` is read, then the row is inserted, with no transaction or constraint tying the two together).

### M14-10: a connected assistant's typed decision on a found image is refused outright
- Severity: low (functional; errs on the restrictive side, so nothing is written or exposed, but the published flag tells the connection the opposite)
- Owning workstream: media (packages/media); API/MCP for the published flag
- Test: test/14-connected-assistant.test.ts, "a connected assistant's typed decision on a found image (media.decide_review, a direction under the contract) is refused outright before the command looks at it, although the published command types say it simply runs". The command sweep accepts this refusal only in its present form.
- Expected: contract 2026-10-05 section 1 makes "Studio and image requests other than deleting an image" directions, applied at once in the same way for the app's conversation and a connected assistant's typed command. The connection's request reaches the command and gets the owner's answer: `not_found` for a review item that does not exist.
- Actual: `garderobe_command { type: "media.decide_review", payload: { candidateId: "SYNTHETIC-candidate-1", decision: "adopt" } }` from a write connection answers `forbidden` "only the owner can decide whether a found image shows their garment", with no `details.reason`. The owner's own `POST /v1/commands` with the same payload answers `not_found`. `/v1/command-types` lists the type with `consequential: false`.
- Reproduction: synthetic owner; an MCP client with write access sends the call above; compare with the owner's submit of the same payload.
- Where: `packages/media/src/commands/discovery.ts:251-252` refuses every actor other than the owner. Relayed turns and the app conversation probably behave the same (not run). A "reject" decision removes the asset (lines 263-269), which may belong with section 3, so the reproduction uses "adopt".

### M14-11 (withdrawn): a malformed garderobe_command envelope is answered with an internal error
- Status: **withdrawn, not a product defect.** The `internal` answers came from the test harness, not the product. `toolResult` in apps/worker/src/testing/index.ts reports the MCP SDK's own input-schema refusal ("Input validation error: Invalid arguments for tool garderobe_command…") as code `internal`. Once the suite told that refusal apart from a crash (`isCrash` in test 14), the 2026-10-13 run found no malformed envelope answered with a real crash. The test now runs as an ordinary test that no malformed envelope crashes.
- Original severity: low (nothing is written, but a crash is not a refusal and hides which input was wrong)
- Owning workstream: API/MCP (apps/worker MCP tool handler)
- Test: test/14-connected-assistant.test.ts, "a malformed garderobe_command envelope (for example a payload that is an array) is answered with a JSON-RPC internal error instead of a refusal". The companion test "refuses arrays, strings and nulls where an object is expected…" asserts that every other answer is a refusal and nothing changes.
- Expected: each malformed envelope is refused as invalid input (`invalid_command` or JSON-RPC -32602).
- Actual (2026-10-13 run): `{ type: "settings.update", payload: [{ patch: { timezone: "Asia/Tokyo" } }] }` is answered with JSON-RPC -32603 (internal). The owner's fingerprint is unchanged.
- Reproduction: an MCP client with write access calls `garderobe_command` with the arguments above.
