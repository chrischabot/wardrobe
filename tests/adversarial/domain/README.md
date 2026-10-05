# Domain adversarial tests

Owned by the domain adversarial thread: every command of the foundation command catalogue, the D1
ledger and the import boundary, attacked through the real command service and the real importer on the
real local D1. See `../README.md` for the harness and the rules of a case.

| File | What it attacks |
| --- | --- |
| `catalogue.test.ts` | Every command type, the same six ways (who is asking, malformed input, another owner's records, stale and forged versions, replay storm with forged owner fields, the truth of the undo offer) |
| `defect-regressions.test.ts` | One reproduction per defect this suite found and fixed (A-01 to A-11) |
| `wear-observations.test.ts` | Per-garment daily wear deduplication, time zone, daylight-saving and date edges, contradictory and out-of-order observations, an observation meeting an estimate |
| `storm.test.ts` | Commands racing for one garment, lot, batch or identifier; seeded random storms with the ledger's invariants checked after every command |
| `boundaries.test.ts` | Hostile text and identifiers, forged receipt text, very large fields, receipt immutability, the import boundary, and every indirect route to lifting the restriction of the owner's real import |
| `support.ts` | The labelled synthetic wardrobe, the second owner, forged owner fields, readers of ledger state and the invariant check (`ledgerProblems`) |

`COVERAGE.md` maps every command to its attack classes and test names; `DEFECTS.md` lists what the suite
found, what was fixed and what was left as it is.

Run this area alone with `npm run test:domain -w @garderobe/adversarial-tests`.

Data: every case marked `[synthetic]` uses constructed garments, profile text and inventory rows. The two
cases marked `[real owner data]` import the supplied profile and inventory, byte for byte, into a throwaway
account of the local test database; they only read it and send commands that must be refused. No test
adds a garment, a wear or a lifted restriction to the owner's data.
