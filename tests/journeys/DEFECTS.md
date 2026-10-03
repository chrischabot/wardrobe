# Product defects found by the journey suite

Found against `garderobe-rebuild` at `6f89bd39` on 2026-10-03, on the local Worker with stand-ins only
at external boundaries (see README.md). Each entry is a test that fails in the strict run
(`npm run test:strict -w @garderobe/journey-tests`) and is an expected failure in the default run.
"Owner" is the workstream whose code needs the change. Nothing here was fixed by this suite.

| ID | What the owner experiences | Required by | Owner |
| --- | --- | --- | --- |
| D03-1 | The Undo receipt of an "in the wash" report ends with a machine command name ("Undid care.mark_dirty") | §8 receipts are concise and factual; no internal codes | foundation (`packages/domain`, generic undo summary) |
| D03-2 | Returning a laundry bag whose only shirt was reported lost says "1 item clean" | §5 "A return completes only the contents of the returning batch, less named exceptions" | foundation (`laundryReturn`) |
| D03-3 | A shirt that is clean only by the weekly inference is described as an "observed" clean unit | §5 "Do not falsely record an observed pickup or return" | foundation (availability estimator) |
| D04-1 | Trousers reported as worn yesterday stay clean and offered today; the receipt says the item has "no owned units on record" | §5 "I wore it yesterday" is authoritative; recompute stock in event order | foundation (import receive time versus replay) |
| D04-2 | After a wear amendment took a shirt out of a collected bag, the bag's return still counts it | §8 "correction preserves that historical pickup and computes an explicit adjustment" | foundation (`laundryReturn`) |
| D05-1 | The Calendar event has no link to the day's board unless a base URL was set by hand | §9 "A normal HTTPS link opens the corresponding app view when installed and the web view otherwise" | daily-service / api-mcp-identity (`boardBaseUrl` is never set from the deployment's origin) |
| D05-2 | A wear's receipt, read again after the Calendar event was updated and verified, still says the update is pending | §8 "The receipt ... distinguishes any pending synchronization or projection" | foundation (stored receipt effect states) |
| D05-3 | His own note in the Calendar event is lost when he had also edited the outfit text | §9 "preserve unrelated event fields and content" | daily-service (`mergeDescription`) |
| D06-1 | On mild days no option carries a scarf or tie suggestion on the belt line | profile §9 "The belt line in any plan should carry an optional scarf or tie suggestion" | daily-service (composer) |
| D06-2 | Some outfits use one neutral three times (for example black chore coat, black belt, black socks). Intermittent: depends on the composer's seeded tie-breaking | profile §5 "never let a single neutral appear three times in one outfit" | daily-service (composer: belt and socks are not counted) |
| D06-3 | Naming clean pieces worn this week as pieces that must stay returns no outfit; the request cannot state the override | §7 "An explicit owner override can relax a repeat preference" | daily-service / api-mcp-identity (`allowRepeat` not reachable from `POST /v1/recommendations`) |
| D06-4 | Asking for three outfits around one named shirt returns one | §13 locked garments "must stay"; §7 within a board shirts differ "when the pool supports the requested count" | daily-service (composer treats a locked shirt as used after the first option) |
| D06-5 | An occasional piece asked for by name yields no outfit at all | §17 Availability: occasional pieces "behave correctly in ordinary and explicit requests" | daily-service |
| D06-6 | Swapping out a navy jacket offers another navy jacket | profile §8 rule 6 "Never fall back to navy when a piece is swapped out" | daily-service (swap replacement for the outer role) |
| D07-1 | The owner's confirmation request for an assistant's trip change shows identifiers and raw fields | Owner decision of 2026-10-01: confirm "a system-generated summary of the exact proposed mutation"; no internal codes | api-mcp-identity (`apps/worker/src/proposals/store.ts`). Same cause as D14-1 |
| D07-2 | Asking for outfits for a day away on a trip offers home stock; no route composes a destination board | §10 "Destination recommendations use that subset ... clothes left at home cannot appear" | api-mcp-identity (wiring) and daily-service |
| D07-3 | The reuse the packing proposal planned is withdrawn at the destination once day one was worn | §10 "an explicit packing request permits repeat-policy exceptions for that trip" | daily-service (validation and repair in trip scope) |
| D07-4 | Packed and Unpacked receipts name the trip by its internal identifier | no internal codes in owner-facing text | foundation (`stock.pack`, `stock.unpack` summaries) |
| D09-1 | The board already prepared for tomorrow keeps offering the shoes he just said hurt | §10 "Apply direct statements of discomfort immediately to the relevant recommendation context ... Pain cannot be outweighed by styling scores" | daily-service (repair does not react to comfort feedback) with assistant |
| D10-1 | After he resumes in the app no board is prepared, although the receipt says one is being prepared | §9 "On resume ... prepare the next useful board" | api-mcp-identity (owner resume not wired to the daily service's resume) and daily-service |
| D11-1 | The recovery screen still counts a run waiting for input after he answered it | §15 recovery screen shows the concrete state of pending work | api-mcp-identity (`apps/worker/src/runs.ts`) |
| D12-1 | For a day no board has been asked for yet, Studio says "the forecast is unavailable" and blocks a jacket over an oxford, although the forecast for that day can be fetched and is fresh | §3 Studio "For today uses today's validated eligibility"; §7 the forecast is mandatory context | visual-wardrobe / api-mcp-identity (Studio validation uses only an already recorded forecast) |
| D14-1 | The confirmation shown for an assistant's typed command gives identifiers or raw payload ("boardId: ...", "patch: {...}") | as D07-1 | api-mcp-identity (`apps/worker/src/proposals/store.ts`) |

## Reproductions

Each is the body of the test of the same ID; in short:

- **D03-1** `care.mark_dirty`, then `command.undo`; read the undo receipt's summary.
- **D03-2** Mark a shirt dirty, `laundry.collect`, `laundry.report_exception {kind: "lost", garmentId}`, `laundry.return`; read the return receipt and the batch.
- **D03-3** A wear recorded before a collection, `laundry.apply_weekly_reset`, then `GET /v1/items/{id}` availability basis.
- **D04-1** Provision the real owner; `wear.record` with yesterday's date for any trousers; `GET /v1/items/{id}` shows one clean unit.
- **D04-2** Wear two shirts, `laundry.collect`, `wear.amend` one of them out, `laundry.return`; the receipt counts two.
- **D05-1** Connect Google, create the outfit calendar, publish a board, run the scheduled handler; the event description holds no `/board/<date>` link.
- **D05-2** As D05-1 with a later wear that repairs the board; run the scheduled handler; `GET /v1/commands/{wear}` still reports `projection_pending`.
- **D05-3** Edit the event in Calendar: change an outfit heading and append a note; change the board; run the scheduled handler; the note is gone.
- **D06-1** Publish boards for days of 11/19, 15/15, 14/21, 16/22 and 17/23 °C; every `flourish` is null.
- **D06-2** Publish boards for the scripted week and count sheet colours per outfit; seen on the 2/6 °C and 5/24 °C days.
- **D06-3** Wear and wash a shirt and trousers today; `POST /v1/recommendations {mode: "preview", count: 1, lockedGarmentIds: [both]}` for a day this week returns no option.
- **D06-4** `POST /v1/recommendations {mode: "preview", count: 3, lockedGarmentIds: [pink oxford]}` returns one option.
- **D06-5** The same with the linen pocket square (sheet status "Occasional") returns none.
- **D06-6** On a jacketed option swap the outer to the navy raglan work coat by ID, then swap the outer again without an ID; the replacement is navy.
- **D12-1** With a reachable forecast for a day that has no board, `POST /v1/studio/validate {date, slots: jacket + Pima oxford + trousers + socks + sneakers}` returns "the forecast is unavailable" (blocking for the jacket rule); `GET /v1/weather?date=` for the same day is fresh.
- **D07-1, D14-1** From a write connection call `garderobe_command` with `trip.update`, `board.select` or `settings.update`; read `GET /v1/proposals` as the owner.
- **D07-2** Create a trip, propose, `stock.pack`; `POST /v1/recommendations {date: <trip day>, mode: "preview"}` offers home stock.
- **D07-3** Propose, pack, publish the day-two plan on the trip board, `wear.record` the day-one plan with `tripId`; the option is withdrawn.
- **D07-4** `stock.pack` and `stock.unpack`; read the receipt summaries.
- **D09-1** Publish tomorrow's board, `feedback.record` kind `pain` on its lead sneaker, read `GET /v1/today?date=<tomorrow>`.
- **D10-1** `service.pause`, run the scheduled handler with phases due, `service.resume`, run it again; no board for today or tomorrow.
- **D11-1** A turn where the model asks the owner a question; answer through `POST /v1/runs/{id}/input`; `GET /v1/recovery` still counts one run needing input.

## Observed, not asserted as defects

Behaviour the specification does not clearly forbid, recorded for the owning threads:

- A stored receipt keeps `undo.available: true` after it was undone (the second undo is refused).
- A refund recorded on a return case does not update the order line's refunded amount; the two are kept separately.
- The packing proposal exceeded a stated `maxPieces` (13 against 8) with only a note.
- A board on a paused day still reads `status: "ready"` and `validity: "current"`, with `paused` set alongside.
- `care.washed` without a count on a shirt reported lost brings it back as clean.
- A garment worn while it is in an open laundry batch is listed both in the batch and as awaiting service.
- The last page of the MCP `items` view has `nextCursor: null` but `complete: false`.
- Selector `reasons` in Studio are machine codes only; restricted shoes carry the marker `seasonal_or_stored` in Explore.
- `POST /v1/studio/validate` ignores `tripId`.
- A board repaired in a commit is delivered to Calendar by the next scheduled run but one when the repair also needs a background top-up.
- Export once answered `completed_incomplete` when requested immediately after scheduled work; the journey retries up to three times.
