# Product defects found by the journey suite

Found on the local Worker with stand-ins only at external boundaries (see README.md). Each open entry
is a test that fails in the strict run (`npm run test:strict -w @garderobe/journey-tests`) and is an
expected failure in the default run. "Owner" is the workstream whose code needs the change. Nothing
here was fixed by this suite.

Last re-checked against `garderobe-rebuild` at `e94af8fb` on 2026-10-03.

## Open

| ID | What the owner experiences | Required by | Owner |
| --- | --- | --- | --- |
| D14-2 | The text a connected assistant reads beside the last page of the item list still says more pages follow and to pass a cursor, although there is none | §13 and research rows R14 to R16: "Pagination is explicit; complete snapshots and counts cannot be silently truncated" | api-mcp-identity (`apps/worker/src/mcp/server.ts`, the `items` view) |

## Under watch (not reproduced at `e94af8fb`)

| ID | What the owner experiences | Required by | Owner |
| --- | --- | --- | --- |
| D06-2 | Some outfits used one neutral three times (for example black chore coat, black belt, black socks). It depended on the composer's seeded tie-breaking. Since `cadc3aeb` the belt and socks are counted and the test passed in every strict run made here (17 at `5db4fd87`, and again at `2124ae89` and `e94af8fb`), but the composer applies the limit as a preference, not as a refusal, so a run cannot prove it for every seed. The test stays marked intermittent: skipped in the default run, an ordinary test in the strict run | profile §5 "never let a single neutral appear three times in one outfit" | daily-service (composer) |

## Reproductions

Each is the body of the test of the same ID; in short:

- **D06-2** Publish boards for the scripted week and count sheet colours per outfit; it was seen on the 2/6 °C and 5/24 °C days.
- **D14-2** From a read connection call `garderobe_inventory {view: "items", limit: 40}` and follow `nextCursor` to the page where it is null; read that page's text content.

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
| D07-1 | The confirmation request for an assistant's trip change showed identifiers and raw fields | api-mcp-identity, `5db4fd87` | 07 |
| D07-2 | Asking for outfits for a day away on a trip offered home stock | daily-service, `cadc3aeb` | 07 |
| D07-3 | The reuse a packing proposal planned was withdrawn at the destination | daily-service, `cadc3aeb` | 07 |
| D07-4 | Packed and Unpacked receipts named the trip by its internal identifier | foundation, `a5e6c8fa` | 07 |
| D09-1 | The board already prepared for tomorrow kept offering the shoes he had just said hurt | daily-service, `cadc3aeb` | 09 |
| D10-1 | After he resumed in the app no board was prepared | api-mcp-identity, `5db4fd87` | 10 |
| D11-1 | The recovery screen still counted a run waiting for input after he answered it | api-mcp-identity, `5db4fd87` | 11 |
| D11-2 | The request to confirm a new garment showed a role code and a message identifier | assistant, `486b1311` and `a6795a3d` | 11 |
| D12-1 | For a day no board had been asked for yet, Studio said "the forecast is unavailable" and blocked a jacket over an oxford, although the forecast could be fetched | visual-wardrobe, `e94af8fb` | 12 |
| D14-1 | The confirmation for an assistant's typed command gave identifiers or raw payload | api-mcp-identity, `5db4fd87` | 14 |

Two ordinary tests changed with these fixes, because the product's behaviour changed by the owner's
decision or by a fix, not to make them pass:

- **03, partial return.** A recorded laundry return can now be undone (owner decision of 2026-10-03). The
  step used to assert that it could not; it now undoes the return, checks that the bag is back at the
  laundry with all its shirts, and reports the return again.
- **09, pain report.** The receipt of a pain report now carries the repair of the board already published
  and that board's Calendar effect (the D09-1 fix); the step used to assert both were empty.

The step in 06 that puts a shirt in the wash and a jacket at the tailor now undoes both afterwards. Before,
when the composer happened to lead with the pink oxford, the later step that asks for three outfits
around that shirt found it in the wash.

## Observed, not asserted as defects

Behaviour the specification does not forbid, recorded for the owning threads, each with the reason it
is not a defect test:

- "Log this: I am wearing the grey trainers today" is not read as a report without a tap (the plain "I am wearing ..." and "Log that I am wearing ..." are); it becomes a request the owner confirms. Safe, but one tap more than a plain report. Owner decision of 2026-10-03: a wear is recorded only when it matches what he actually reported, so the cautious reading is permitted.
- A refund recorded on a return case does not update the order line's refunded amount; the two are kept separately. §17 L1098 requires returns to "retain correct stock and monetary states", which journey 08 asserts on the case; it does not say where the order shows it.
- A packing proposal for a trip with a stated piece limit can exceed it (13 against 8 was seen) and says so in a note that names both numbers and how to close the gap. §10 L663 asks for luggage limits to be recorded and for "a compact set"; it does not make the limit a refusal, and whether eight pieces can dress three days and a dinner is a judgement. No journey asserts this note; the journey's own trip states no limit.
- A board on a paused day still reads `status: "ready"` and `validity: "current"`, with `paused` set alongside. §9 requires that nothing is published or reminded while paused, which journey 10 asserts; the status fields of a board that already existed are not specified.
- A garment worn while it is in an open laundry batch is listed both in the batch and as awaiting service. Its later return no longer counts it (foundation, `a5e6c8fa`); the double listing is the two facts he reported.
- Selector `reasons` in Studio are codes, and a restricted shoe in Explore carries the marker `seasonal_or_stored` with the reason `restricted`. Both are fields of the client contract (`packages/contracts/src/ext/media.ts`): the marker has four values (`owned`, `seasonal_or_stored`, `incoming`, `shopping_candidate`) and none for a restricted piece, and `reasons` is the list the app turns into words. §3 L97 says Explore "can include seasonal pieces and clearly marked shopping candidates" and does not say how a restricted piece is marked. Journey 12 asserts that the restricted shoes are unavailable, carry the reason `restricted` and are not offered for today; what the app shows for them is the iOS thread's.
- `POST /v1/studio/validate` ignores `tripId`. §3 L97 describes Studio's For today and Explore modes only.
- A board repaired in a commit is delivered to Calendar by the next scheduled run but one when the repair also needs a background top-up. §9 requires the projection to follow and never to be claimed early, which journey 05 asserts.
- An export requested immediately after scheduled work once answered `completed_incomplete`, naming the component and saying to export again. §15 and evaluation case B020 require exactly that honesty ("Report incomplete components honestly"); the journey follows the product's own instruction, at most three times, and then requires a complete package.
- The repair line in a pain report's receipt names the board by its date and "revision 2". Receipts are not outfit copy (§9 L540 keeps item codes, job traces, laundry diagnostics and status headings out of the Calendar's outfit copy, which journey 05 asserts); the journey asserts what the line says, not this wording.

Three earlier observations were changed by their owners and are no longer listed: a photo with no words
is no longer recorded as the owner's statement (assistant, `a6795a3d`); a receipt read after it was
undone says undo is unavailable, and `care.washed` without a count no longer brings back a shirt reported
lost (foundation, `a5e6c8fa`). These three are the owning threads' reports; this suite does not assert them.
