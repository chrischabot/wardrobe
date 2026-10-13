# Open product defects: ledger (replay and races, time, invariants)

> **Status 2026-10-13:** L03-3, L04-1 to L04-6, L13-1 and L13-2 are fixed and re-verified. Their tests are now ordinary
> `[fixed <id>]` tests; see "Fixed and re-verified" in `../DEFECTS.md`. Their entries below are kept as the record of
> what was found. L03-2 and L03-4 are open.

Found by `test/03-replay-races.test.ts`, `test/04-time.test.ts` and `test/13-invariants.test.ts` against
garderobe-rebuild 5db4fd87 (clean checkout `adv-base-5db4fd8`). Each entry was registered in its test file with
`defect("<ID>", ...)` when found: while open, an expected failure in the ordinary run and an ordinary failing test under
`npm run test:strict`; fixed entries are now ordinary `[fixed <id>]` tests. The "Actual" lines are what the strict run printed on 2026-10-03.

(L03-1, parallel board selections replacing each other, was ruled intended by the daily workstream on
2026-10-03: a selection is the owner's current choice, not a revision of the board. Its test is now an ordinary
test of that rule.)

### L03-2: A burst of simultaneous owner reports is refused with HTTP 500 instead of being rebased and recorded
- Severity: low
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/03-replay-races.test.ts, "a burst of eighty simultaneous owner reports: many are refused with HTTP 500 instead of being rebased and recorded"
- Expected: an owner observation is rebased and retried internally and is never discarded because another client changed the record (section 5, "Owner observations and accounting repair": "Rebase stale expected versions internally and retry the accounting transaction; never discard an accepted observation because another client changed the record").
- Actual: 80 parallel `care.mark_dirty` reports (four garments with 20 clean units each, 80 distinct keys): 51 answered 500 `internal`, "the command could not be committed after repeated concurrent changes; nothing was written. It is safe to send it again with the same idempotency key", `details.lastConflict: "wardrobe revision unchanged since read"`. With 60 parallel reports 28 failed, with 120, 96 failed; 30 parallel reports all succeed. What the refusal promises holds (nothing written, the same key commits once when resent; asserted by the ordinary test "a burst of simultaneous reports loses nothing").
- Reproduction: create four synthetic garments with quantity 20; send 80 `POST /v1/commands` `care.mark_dirty {items: [{garmentId, quantity: 1}]}` at once.
- Where: adv-base-5db4fd8/packages/domain/src/commands/service.ts:78 (`maxAttempts` 12), :104-126 (retry loop, then `internal`), :334-341 (every stock command serialises on the owner's single wardrobe revision).

### L03-3: The same laundry return reported a second time launders the hamper: pieces worn after the pickup become clean
- Severity: medium
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/03-replay-races.test.ts, "the same laundry return reported a second time (another device, a new key) launders the hamper: pieces worn after the pickup become clean"
- Expected: "A shirt worn after pickup stays in the hamper. A return completes only the contents of the returning batch, less named exceptions" (section 5, "Quantity and laundry"). A second report of the same return (another device or the connected assistant, so another idempotency key) changes nothing.
- Actual: the first `laundry.return {}` returns the batch (1 item clean). The second `laundry.return {}` for the same instant answers 200 "Laundry returned: 1 item clean (no pickup had been recorded; your report stands)" and the piece that became dirty after the pickup, which was never in a bag, goes from `dirty: 1` to `clean: 1`. Over MCP the same second report runs directly (`laundry.return` is a routine action), observed in a probe: "Laundry returned: 56 items clean (no pickup had been recorded...)".
- Reproduction (synthetic owner): `care.mark_dirty` A at now-50h; `laundry.collect {}` at now-40h (batch holds A); `care.mark_dirty` C at now-30h; `laundry.return {}` at now-2h (A clean, C dirty); `laundry.return {}` again with a new key, same `occurredAt` (C becomes clean).
- Where: adv-base-5db4fd8/packages/domain/src/handlers/wear-care.ts:555-580 (no batch outstanding: every dirty service piece is washed, although a returned batch is on record and the piece became dirty after that batch's pickup).

### L03-4: A retransmitted `POST /v1/recommendations` (`mode: "board"`) with the same `clientRequestId` is refused with 409 `idempotency_key_reuse` once the first call has created the board
- Severity: medium
- Owning workstream: daily (packages/daily)
- Test: test/03-replay-races.test.ts, "a retransmitted POST /v1/recommendations (mode 'board') with the same clientRequestId is refused with 409 idempotency_key_reuse once the first call has created the board"
- Expected: Retransmitting the identical `POST /v1/recommendations` (`mode: "board"`, same `clientRequestId`, same `date`) returns the published board (200) and creates only one board revision.
- Actual: Once the first call has published the board for `date` (recorded under `recommend:<clientRequestId>:1` with `reason: "compose"` in its `requestFingerprint`), a retry or late concurrent retransmission of the exact same request sees `existing !== null` (`loadBoard` in `recommend` at `packages/daily/src/service.ts:459`), passes `reason: "rebuild"` into `prepareBoard` (`:471`), computes a different `requestFingerprint`, and fails in `sameRequest(prior, fingerprint)` (`:172`) with 409 `idempotency_key_reuse`: `"this request ID was already used for a different board request"`.
- Reproduction: `POST /v1/recommendations` `{ clientRequestId, mode: "board", date }` on a date without a board (200); send the identical `POST /v1/recommendations` `{ clientRequestId, mode: "board", date }` again (409 `idempotency_key_reuse`).
- Where: `packages/daily/src/service.ts:459-471` (`recommend` chooses `reason: existing ? "rebuild" : "compose"` before `prepareBoard` checks `answerIfClaimed()`; `rebuildDay` at `:488-501` does the same).

### L04-1: A wear whose occurredAt lies decades before its own wearing date is accepted and ordered there, so an older wash "cleans" today's wear
- Severity: low
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/04-time.test.ts, "a wear whose occurredAt lies decades before its own wearing date is accepted and ordered there, so an older wash 'cleans' today's wear"
- Expected: the stated wearing date is the durable day key and the ledger is recomputed in event order (section 5, "One counted wear per garment and wearing date" and "Owner observations and accounting repair"); a report whose time of occurrence contradicts its own wearing date by more than a day is refused (400) or takes effect on its wearing date. A unit worn today after yesterday's wash is awaiting care.
- Actual: `wear.record {wearingDate: <today>}` with `occurredAt: "1970-01-01T00:00:00Z"` answers 200 "Recorded for today", the counted wear for today exists, and the garment's only unit reads `clean: 1`: the wear was placed in 1970, before yesterday's dirty and wash reports. A `care.mark_dirty` with `occurredAt: "0001-01-01T00:00:00Z"` is accepted as well (seen in a probe, not asserted). (A connected assistant's report with such a time waits for the owner, so this is the app/web path.)
- Reproduction: synthetic one-unit shirt; `care.mark_dirty` at now-30h; `care.washed` at now-29h; `wear.record {wearingDate: today, garmentIds: [g]}` with `occurredAt: "1970-01-01T00:00:00Z"`; read `stock_balances`.
- Where: adv-base-5db4fd8/packages/domain/src/handlers/wear-care.ts:27-32 (`wearOccurredAt` uses an explicit `occurredAt` unchecked against `wearingDate`); adv-base-5db4fd8/packages/domain/src/commands/service.ts:263 (the only bound on `occurredAt` is "not more than five minutes ahead").

### L04-2: A laundry return dated before the batch's pickup closes the batch while its pieces stay recorded at the laundry
- Severity: medium
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/04-time.test.ts, "a laundry return dated before the batch's pickup closes the batch while its pieces stay recorded at the laundry"
- Expected: a return that is said to have happened before the pickup of the batch it names is refused, or returns the pieces; a batch on record as `returned` holds no stock (section 5: "A return completes only the contents of the returning batch"; section 8: "The command handler validates the complete change before writing it").
- Actual: 200 "Laundry returned: nothing came back clean", repair note "not counted as returned; a later report shows it was not in this bag when it came back". `laundry_batches.status = 'returned'` with `returned_at` (2026-10-02T18:54:02Z) earlier than `picked_up_at` (2026-10-03T16:54:02Z), `laundry_batch_items.returned_quantity = 0`, and `stock_balances` still has `service[<batch>]: 1`. No open batch is left to return, so the piece stays "at the laundry" until the owner reports that garment washed or the weekly baseline infers it.
- Reproduction: `care.mark_dirty` g at now-5h; `laundry.collect {include: [{garmentId: g, quantity: 1}]}` at now-2h; `laundry.return {batchId}` with `occurredAt` now-24h.
- Where: adv-base-5db4fd8/packages/domain/src/handlers/wear-care.ts:596-672 (the `return` event is journaled at the stated time, before the `pickup`, so the replay moves nothing; line 671 still sets the batch to `returned` because nothing was named still away).

### L04-3: A late-dated "laundry is back" with no batch out claims pieces came back clean that the ledger leaves in the hamper
- Severity: medium
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/04-time.test.ts, "a late-dated 'laundry is back' with no batch out claims pieces came back clean that the ledger leaves in the hamper"
- Expected: a receipt states what was written, read back from the ledger (section 8, "A command is a verified change": "commits, reads the resulting state, and confirms"; contract `CommandReceipt`: "what was actually written").
- Actual: 200 `committed`, summary "Laundry returned: 1 item clean (no pickup had been recorded; your report stands)", `result.returned: 1`, while the garment is still `dirty: 1` and `clean: 0`: the wash was journaled for now-3h, before the piece became dirty at now-1h, so the replay moved nothing. In a probe with 57 dirty pieces the receipt said "57 items clean" and one moved.
- Reproduction (owner with no batch out): `care.mark_dirty` g at now-1h; `laundry.return {}` with `occurredAt` now-3h; compare `result.returned` with `stock_balances`.
- Where: adv-base-5db4fd8/packages/domain/src/handlers/wear-care.ts:560-579 (`units` is summed from the quantities read before planning, not from what the replay moved; `laundry.collect` at :489-498 and the batch return at :628-637 count the movements).

### L04-4: Settings accept a bare UTC offset as the owner's timezone although only IANA zone names are valid
- Severity: low
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/04-time.test.ts, "settings accept a bare UTC offset (+05:00) as the owner's timezone although only IANA zone names are valid"
- Expected: `settings.timezone` is an IANA timezone name (contract `IanaTimezone`, "IANA timezone, e.g. Europe/London"; the refusal text is "not a known IANA timezone"); anything else is refused with 400 and the setting keeps its value.
- Actual: `settings.update {patch: {timezone: "+05:00"}}` answers 200 "Settings updated (version 2): timezone" and the owner's days are then counted at a fixed offset with no daylight-saving rule. `"Mars/Olympus_Mons"`, `"UTC+25"`, `""` and the other invalid names are refused (ordinary test). Not checked: what the Calendar projection and the weather request do with such a value.
- Reproduction: `POST /v1/commands` `settings.update {patch: {timezone: "+05:00"}}` (also `-11:00`, `+14:00`).
- Where: adv-base-5db4fd8/packages/contracts/src/primitives.ts:21-28 and :46 (`isRealTimezone` asks `Intl.DateTimeFormat`, which also accepts offset identifiers).

### L04-5: Settings accept clock times that do not exist (25:99) for the morning delivery and the laundry collection
- Severity: low
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/04-time.test.ts, "settings accept clock times that do not exist (25:99) for the morning delivery and the laundry collection"
- Expected: a local time is a real time of day, 00:00 to 23:59; anything else is refused with 400 (section 5: the laundry routine's times "are editable local-time settings"; section 9: the morning delivery time).
- Actual: `delivery.morningLocalTime: "25:99"` and `laundry.service.collectionLocalTime: "99:99"` both answer 200 and are stored and returned by `GET /v1/settings`. Not checked: when the scheduler then delivers the board or applies the cutoff.
- Reproduction: `settings.update {patch: {delivery: {morningLocalTime: "25:99"}}}`; `settings.update {patch: {laundry: {service: {collectionLocalTime: "99:99"}}}}`.
- Where: adv-base-5db4fd8/packages/contracts/src/settings.ts:6 (`LocalTime` is `/^\d{2}:\d{2}$/` with no range check).

### L04-6: wear.amend records a wear on a day that has not happened yet, and answers HTTP 500 for the year 9999
- Severity: medium
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/04-time.test.ts, "wear.amend records a wear on a day that has not happened yet (and answers HTTP 500 for the year 9999)"
- Expected: a wear cannot be recorded for a future date by any path (`wear.record` refuses it: "a wear cannot be recorded for a future date; choose an outfit instead"); section 5: an actual wear is an observation of something that happened. A date the service cannot handle is a 400, never a 500.
- Actual: `wear.amend {wearingDate: <tomorrow>, add: [g]}` answers 200 "Corrected <tomorrow>: added ...", `result.counted: [g]`; a counted wear for tomorrow exists and the unit moves from clean to awaiting care. `wear.amend {wearingDate: "9999-12-31", add: [g]}` answers 500 `internal` "an unexpected error occurred; nothing was confirmed" (nothing written).
- Reproduction: `POST /v1/commands` `wear.amend {wearingDate: <owner's day + 1>, add: [<garment>]}`; then with `wearingDate: "9999-12-31"`.
- Where: adv-base-5db4fd8/packages/domain/src/handlers/wear-care.ts:290-304 (`wearAmend` has no check against the owner's today; `wearRecord` has it at :149-152). The 500 was not traced; the likely cause is `addDays` in adv-base-5db4fd8/packages/domain/src/util.ts:101-104 producing an expanded-year string for the day after 9999-12-31.

### L13-1: stock.pack accepts a trip that does not exist, was cancelled, or belongs to another owner
- Severity: low
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/13-invariants.test.ts, "stock.pack accepts a trip that does not exist, was cancelled, or belongs to another owner: the units leave home for a place no screen lists"
- Expected: invariant "every unit recorded as packed is packed for one of this owner's planned trips"; a pack command naming anything else is refused and writes nothing (section 8: "Named targets or a frozen query result; no implicit creation", "The command handler validates the complete change before writing it"; section 10, "Trip and packing mode").
- Actual: all three are accepted (200, "Packed for the trip: ..."): `tripId: "trp_syn13_no_such_trip"`, a trip cancelled by `trip.cancel`, and the trip ID of another owner. The unit moves to `trip[<that id>]`, the item reads unavailable (`no_units_at_home`, `on_trip`), `GET /v1/trips` does not list such a trip and `GET /v1/trips/<id>` is 404. Isolation holds: the other owner's trip shows nothing packed. The MCP path already makes such a pack wait for the owner (`routineActionNeedsOwner`); the app and web path does not check.
- Reproduction (synthetic owner): `stock.pack {tripId: "trp_syn13_no_such_trip", items: [{garmentId: "shirt-moss", quantity: 1}]}`; `trip.create`, `trip.cancel`, then `stock.pack` for it; `stock.pack` with a trip ID created by another owner.
- Where: adv-base-5db4fd8/packages/domain/src/handlers/garments.ts:729-756 (`stockPack` never reads `trips`).

### L13-2: Saying "packed" again about a piece already worn in the suitcase turns the worn unit clean without a wash
- Severity: medium
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/13-invariants.test.ts, "saying 'packed' again about a piece already worn in the suitcase turns the worn unit clean without a wash"
- Expected: a packed piece worn on the trip stays worn until a wash report (section 10: "Unpacked returns quantities home without declaring them clean; a wash report does"; section 17, row "Packing"). Repeating the packing statement about a piece that is already in that suitcase changes nothing.
- Actual: after `stock.pack` (trip: 1 clean) and `wear.record` with `tripId` (trip: 0 clean, 1 worn), a second `stock.pack` of the same piece for the same trip answers 200 with the repair note "ledger had this item in 'trip'; packing establishes it is in the suitcase", and `GET /v1/trips/<id>` shows `{clean: 1, worn: 0}`. A connected assistant may send `stock.pack` for a planned trip directly, so a repeated packing check from it has this effect without the owner.
- Reproduction (synthetic owner, one-unit `trouser-olive`): `trip.create`; `stock.pack {tripId, items: [{garmentId, quantity: 1}]}`; `wear.record {wearingDate: today, garmentIds: [garmentId], tripId}`; the same `stock.pack` again (new key); `GET /v1/trips/<id>`.
- Where: adv-base-5db4fd8/packages/domain/src/stock/replay.ts:516-539 (`pack`: when no unit is at home, `pullOneFromElsewhere` at :204-212 takes one from the trips, including the very trip being packed, via `takeFromTrip` at :187-199, and it is added back as a clean packed unit). The random sequences of `13-invariants` pack each garment at most once, so this defect is asserted by its own test only; the suite's journal replay (`replayJournal`) leaves a piece that is already in the suitcase as it is.
