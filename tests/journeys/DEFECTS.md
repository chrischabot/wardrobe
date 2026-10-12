# Product defects found by the journey suite

Found on the local Worker with stand-ins only at external boundaries (see README.md). Each open entry
is a `defect(...)` test that fails in the strict run (`npm run test:strict -w @garderobe/journey-tests`).
In the default run it passes only when it fails with its recorded signature (`src/defect.ts`): a defect
that starts to pass, or fails in another way, turns the default run red. "Owner" is the workstream
whose code needs the change. Nothing here was fixed by this suite.

Last re-checked on 2026-10-12 against the shared tree of `garderobe-rebuild` at `32bbeccf`, which also
held other workers' unlanded changes (among them the API and MCP thread's change implementing the
2026-10-05 contract for connected assistants).

## Open

| ID | What the owner experiences | Required by | Owner |
| --- | --- | --- | --- |
| D08-1 | After the return case records the full refund (GBP 120.00 of GBP 120.00), the order line it refunds still shows nothing refunded | §17 L1098: returns with "partial refunds, and exchanges retain correct stock and monetary states"; §6 L240 keeps refunds on orders and order lines | assistant (`packages/assistant/src/commands/returns.ts`) |
| D14-2 | The text a connected assistant reads beside the last page of the item list says more pages follow and to pass a cursor, although there is none | §13 and research rows R14 to R16: "Pagination is explicit; complete snapshots and counts cannot be silently truncated" | api-mcp-identity (`apps/worker/src/mcp/server.ts`). Passes on the shared tree with that thread's unlanded change; it is converted once the fix lands |
| D14-3 | A correction in the owner's words relayed through `garderobe_ask` by a write connection is kept as a request for him to confirm instead of applying with a receipt and Undo | Owner decision of 2026-10-05 (contract "Changes apply at once with undo on every surface", sections 1 and 5: relayed words run under the same policy as the app; `proposals[]` only for section 3, read-only connections and wordless turns) | assistant (`classifyChange` and the turn's change classification in `packages/assistant`; the API thread's relayed-turn guard refuses rather than proposes, so the proposal comes from the assistant) |

## Under watch

| ID | What the owner experiences | Required by | Owner |
| --- | --- | --- | --- |
| D06-2 | Some outfits used one neutral three times (for example black chore coat, black belt, black socks). It depended on the composer's seeded tie-breaking. Since `cadc3aeb` the belt and socks are counted and the test passed in every strict run made here, but the composer applies the limit as a preference, not as a refusal, so a run cannot prove it for every seed. The test stays marked intermittent: skipped in the default run, an ordinary test in the strict run | profile §5 "never let a single neutral appear three times in one outfit" | daily-service (composer) |

## Reproductions

Each is the body of the test of the same ID; in short:

- **D06-2** Publish boards for the scripted week and count sheet colours per outfit; it was seen on the 2/6 °C and 5/24 °C days.
- **D08-1** Open a return on a delivered order line with a GBP 120.00 refund expected; record GBP 50.00 and then GBP 70.00 on the case; read the order line's `refundedMinor`.
- **D14-2** From a read connection call `garderobe_inventory {view: "items", limit: 40}` and follow `nextCursor` to the page where it is null; read that page's text content.
- **D14-3** From a write connection call `garderobe_ask` with "The <shirt> has a loose button now" while the model calls `correct_garment` for that shirt; read the turn's `receipts` and `proposals`.

## Fixed, and now ordinary tests

Each was re-run here on a clean copy of the branch after its fix (`5db4fd87`, `2124ae89` or `e94af8fb`) through the same journey that found it, and its
`defect(...)` is now an `it(...)` with the same assertions.

| ID | What was wrong | Fixed by | Journey that now passes |
| --- | --- | --- | --- |
| D03-1 | The Undo receipt of an "in the wash" report ended with a machine command name | foundation, `a5e6c8fa` | 03 |
| D03-2 | Returning a laundry bag whose only shirt was reported lost said "1 item clean" | foundation, `a5e6c8fa` | 03 |
| D03-3 | A shirt clean only by the weekly inference was described as an "observed" clean unit | foundation, `a5e6c8fa` | 03 |
| D04-1 | Trousers reported as worn yesterday stayed clean and offered today | foundation, `a5e6c8fa` | 04 |
| D04-2 | After a wear amendment took a shirt out of a collected bag, the bag's return still counted it | foundation, `a5e6c8fa` | 04 |
| D05-1 | The Calendar event had no link to the day's board | daily-service, `cadc3aeb`; api-mcp-identity, `5db4fd87` | 05 |
| D05-2 | A wear's receipt, read again after the Calendar event was updated, still said the update was pending | foundation, `a5e6c8fa` | 05 |
| D05-3 | His own note in the Calendar event was lost when he had also edited the outfit text | daily-service, `cadc3aeb` | 05 |
| D06-1 | On mild days no option carried a scarf or tie suggestion | daily-service, `cadc3aeb` | 06 |
| D06-3 | Naming clean pieces worn this week as pieces that must stay returned no outfit | daily-service, `cadc3aeb` | 06 |
| D06-4 | Asking for three outfits around one named shirt returned one | daily-service, `cadc3aeb` | 06 |
| D06-5 | An occasional piece asked for by name yielded no outfit | daily-service, `cadc3aeb` | 06 |
| D06-6 | Swapping out a navy jacket offered another navy jacket | daily-service, `cadc3aeb` | 06 |
| D07-1 | The confirmation request for an assistant's trip change showed identifiers and raw fields | api-mcp-identity, `5db4fd87` | 07 (see below) |
| D07-2 | Asking for outfits for a day away on a trip offered home stock | daily-service, `cadc3aeb` | 07 |
| D07-3 | The reuse a packing proposal planned was withdrawn at the destination | daily-service, `cadc3aeb` (planned reuse became a wear budget in `32bbeccf`; still passes) | 07 |
| D07-4 | Packed and Unpacked receipts named the trip by its internal identifier | foundation, `a5e6c8fa` | 07 |
| D07-5 | A trip with a six-piece bag got a packing proposal of seven (then eight) pieces, counting the outfit worn on the travel day against the bag and saying it did not fit. Judged by the coordinator's decision: only packed pieces count; a set that cannot fit is the smallest set, states the shortfall and adds no tie or accessory | daily-service, `cfc37543` and `a047fe0f`. Converted with the stricter checks the daily thread proposed, as far as they apply to a set that fits: packed pieces within the limit, one of each piece but socks, no shortfall note, and a note naming the packed count (the set fits, so the over-limit rule against a tie or accessory does not apply; it keeps the dinner's tie) | 07 |
| D09-1 | The board already prepared for tomorrow kept offering the shoes he had just said hurt | daily-service, `cadc3aeb` | 09 |
| D10-1 | After he resumed in the app no board was prepared | api-mcp-identity, `5db4fd87` | 10 |
| D11-1 | The recovery screen still counted a run waiting for input after he answered it | api-mcp-identity, `5db4fd87` | 11 |
| D11-2 | The request to confirm a new garment showed a role code and a message identifier | assistant, `486b1311` and `a6795a3d` | 11 |
| D12-1 | For a day no board had been asked for yet, Studio said "the forecast is unavailable" and blocked a jacket over an oxford, although the forecast could be fetched | visual-wardrobe, `e94af8fb` | 12 |
| D14-1 | The confirmation for an assistant's typed command gave identifiers or raw payload | api-mcp-identity, `5db4fd87` | 14 (see below) |

## Changed by the owner decision of 2026-10-05

The owner decided on 2026-10-05 that a change he asks for applies at once with a receipt and is taken
back with Undo, on every surface (library contract "Changes apply at once with undo on every surface").
These steps asserted the earlier confirm-first design and were rewritten to the contract, not to make
them pass:

- **07** The connected assistant's `trip.update` now applies at once with a receipt on the `mcp`
  channel. Its receipt says Undo is not available ("edit the trip again instead"), which the contract
  allows for a command with no automatic undo; the journey asserts that an undo is refused in those words
  and writes nothing, and that the owner's own edit in the app corrects it. The D07-1 step (a
  confirmation in plain words) has no confirmation left to read; plain wording is asserted on the receipt.
- **08** `return.update_case` from the assistant applies at once. A requested return now has a working
  Undo, which puts the case back exactly as it was; the journey undoes it and requests the return again.
- **11** "I gave the scarf away" applies at once with a receipt; Undo brings the scarf back once. The
  confirm, reject and stale-request steps now use a turn that is only a photograph, which the contract
  still keeps as a request for the owner.
- **14** `settings.update` from the assistant applies at once and the owner undoes it in the app; only
  `connection.register` (contract section 3) waits for him, and the D14-1 step reads that confirmation.
  The relayed correction is now defect D14-3. A read-only connection still only proposes.
- **05, Calendar edit of the managed text.** The daily service now keeps the owner's rewritten managed
  line below a fresh managed block instead of dropping it (`f7c98220`). Coordinator decision of
  2026-10-12: keep that behaviour, since §9 allows replacement but does not require it and ambiguous
  owner text must never be deleted. The step now asserts that the managed block is the current board and
  that his line survives below it.
- **05, 09** The assistant's board choice and comfort remark are asserted as direct, with no fallback.

`mcpCommand` (`src/world.ts`) now requires the route and fails on any other answer.

Earlier changes for the same reason: **03, partial return** (a recorded laundry return can be undone,
owner decision of 2026-10-03) and **09, pain report** (its receipt carries the repair of the published
board, the D09-1 fix). The step in 06 that puts a shirt in the wash and a jacket at the tailor undoes both
afterwards, so a later step does not find the shirt in the wash.

## Recorded, not asserted as defects

Behaviour noted for the owning threads that contradicts no quoted passage of the specification, each
with the reason it is not a defect test:

- "Log this: I am wearing the grey trainers today" is not read as a report without a tap (the plain "I am wearing ..." and "Log that I am wearing ..." are); it becomes a request the owner confirms. Owner decision of 2026-10-03: a wear is recorded only when it matches what he actually reported, so the cautious reading is permitted (contract section 8, point 3 leaves widening it to the capture work). Journey 11 asserts the one-tap path.
- A board on a paused day still reads `status: "ready"` and `validity: "current"`, with `paused` set alongside. §9 requires that nothing is published or reminded while paused, which journey 10 asserts; the status fields of a board that already existed are not specified.
- A garment worn while it is in an open laundry batch is listed both in the batch and as awaiting service. Its later return no longer counts it (foundation, `a5e6c8fa`); the double listing is the two facts he reported.
- Selector `reasons` in Studio are codes, and a restricted shoe in Explore carries the marker `seasonal_or_stored` with the reason `restricted`. Both are fields of the client contract (`packages/contracts/src/ext/media.ts`): the marker has four values and none for a restricted piece, and `reasons` is the list the app turns into words. §3 L97 does not say how a restricted piece is marked. Journey 12 asserts that the restricted shoes are unavailable, carry the reason `restricted` and are not offered for today.
- `POST /v1/studio/validate` ignores `tripId`. §3 (Studio, L95 and L97) describes For today and Explore modes only and names no trip mode.
- A board repaired in a commit is delivered to Calendar by the next scheduled run but one when the repair also needs a background top-up. §9 requires the projection to follow and never to be claimed early, which journey 05 asserts.
- The repair line in a pain report's receipt names the board by its date and "revision 2". Receipts are not outfit copy (§9 L540 keeps codes out of the Calendar's outfit copy, which journey 05 asserts).

The export journey (13) no longer retries. It first waits until nothing has been recorded for the owner
for two seconds (scheduled work started by the journey's own setup, such as the calendar projection and
the evening preparation of tomorrow's board, recorded commands during the export in one strict run here
on 2026-10-12, and the export then honestly said every component was incomplete). It then requests one
export, which must be complete in every component; every package check uses that one package. A shirt reported lost no longer returns as clean
(foundation, `a5e6c8fa`), and a photo with no words is no longer recorded as the owner's statement
(assistant, `a6795a3d`); those are the owning threads' reports.
