# Owner data (byte-exact)

Personal owner data. These files are copies of the owner-supplied attachments and must stay byte-exact; never edit or reformat them.

| File | What it is | SHA-256 |
| --- | --- | --- |
| `owner-profile.md` | The owner's style profile, second edition, 14 September 2026 (14,960 bytes). Imported verbatim as the owner's style document. | `e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198` (matches the design spec, section 6) |
| `wardrobe-inventory-2026-05.csv` | The owner's inventory, "clean master, May 2026" (CRLF line endings, 130 data rows). Imported through the section 16 importer. | `ca9a5e06edbb2646ad91f102cb242a81b1776bd39e86e99300c0eb387254c946` |

Derived files (regenerate, do not hand-edit except the rule catalogue):

| File | What it is |
| --- | --- |
| `owner-profile-rules.json` | The 41 machine rules derived from the profile. Each cites a section heading and a verbatim quote (tests enforce that the quote appears in that section), states an interpretation and is typed hard or soft. Hand-maintained; validated by `StyleRuleCatalogue`. |
| `owner-inventory-reconciliation.md` / `.json` | Reconciliation report for the inventory import: row accounting, counts, status mapping, duplicates, missing data, the owner-asserted additions and migration issues with their status. Regenerate with `npm run reconcile --workspace @garderobe/backend`; a test fails when it is stale. |
| `owner-asserted-additions-2026-09-29.json` | The pieces the owner confirmed on 2026-09-29 ("All of them") that the May CSV lacks: 17 garments added through the explicit add-item command (not as CSV rows), each described only by verbatim profile passages, with unknown fields and details still needed. Hand-maintained; quotes are verified against the profile. |

The owner's wardrobe baseline contains no wear history and no laundry state, because the CSV has none. Scenario state for tests and simulation comes from `demo/src/test-events.ts`: commands labelled `TEST EVENT (fixture, not owner data)`.
