# Garderobe journey tests: functionality and user experience

End-to-end owner journeys through the **real Worker**: its HTTP API and its MCP server, running in
workerd on local D1, KV, R2, a queue and the conversation Durable Object, seeded by the **real importer**
with the owner's real profile (`requirements/chris-wardrobe-profile.md`) and real inventory
(`requirements/wardrobe_inventory_clean.csv`, 127 garments, 144 units). Assertions read application state
back through the same public surfaces and check the stored receipts; application state is never read
from a stand-in. (What a journey reads from a stand-in is only what the Worker sent to it: the events
and request log of the Calendar double, in 05, 10 and 13.)

## Running

From the repository root, after `npm install`:

| Command | What it does |
| --- | --- |
| `npm test -w @garderobe/journey-tests` | The suite. Known product defects are expected failures; anything else that fails is a regression. Exit code 0 means "no regression", **not** "no defects". |
| `npm run test:strict -w @garderobe/journey-tests` | The acceptance view: every known defect fails as an ordinary test. Its failures are exactly the open defects in [DEFECTS.md](DEFECTS.md). |
| `npm run typecheck -w @garderobe/journey-tests` | Typecheck of the suite. |
| `npm run evals:check -w @garderobe/journey-tests` | Checks the bundled 64-case evaluation corpus and its grader controls (see "Evaluation corpus" below). Needs `python3`; not part of `npm test`. |

The root `npm test` runs the default mode along with every other workspace. One file:
`npx vitest run test/05-repair-calendar.test.ts` in this directory. A whole-suite run at another time of
day: `GARDEROBE_TEST_CLOCK=23:30 npm test` (see the Worker README).

## Journeys

| File | Journey | Specification and profile |
| --- | --- | --- |
| `test/01-today.test.ts` | The morning: no board yet, preview, the published board, honest freshness, Choose (an intention), a stale edit, a one-piece swap, MCP reads the same revision, Wear, duplicate reports, undo, the web board, a forecast outage | §3 Today; §7; §8 commands; §9; profile §11 |
| `test/02-wardrobe.test.ts` | The real wardrobe as imported (every sheet line accounted for, no invented history), browsing, search and resolve, item detail and provenance, temperature preview, corrections with undo, count reconciliation, bulk edit, aliases, the tailor | §3 Wardrobe; §5; §6; §16; profile §7, §8.2, §8.7, §11 |
| `test/03-laundry.test.ts` | A laundry week: service and hand wash, pickup snapshots, split batches, post-pickup wears, partial return, still away, lost, Socks washed, the weekly reset (once per cycle, exceptions kept, nothing falsely observed), a week with no reports | §3 Laundry; §5 Quantity and laundry, Probability; §17 Quantities, Missing reports |
| `test/04-observations-wear.test.ts` | What he says he wore is recorded as said: unavailable garments, stale versions rebased, late reports in event order, one counted wear per garment and date across phone, web, offline replay and MCP, shirt changes, sock pairs, amendments, undo | §5 One counted wear, Owner observations; §8 Amendment; §17 Wear correction, Concurrency |
| `test/05-repair-calendar.test.ts` | Wearing a planned garment repairs the later, chosen outfit in place and replaces the contents of the existing Calendar event; lost responses, outages, his own notes, removal and restore, an externally deleted event, all-day presentation, Calendar disconnected; calendar influence | §8 Repair; §9 Calendar; §7 Calendar influence; §17 Repair, Selected future repair, Calendar, Calendar influence |
| `test/06-profile-constraints.test.ts` | Every hard constraint of the profile on real boards over a scripted week of different days, by an independent checker; swaps, owner picks, the seven-day repeat, shortages, availability in ordinary and explicit requests, and a labelled what-if of the restriction being lifted | profile §5, §8 (rules 1 to 7), §9, §11; §6; §7; §17 Availability, Repair |
| `test/07-trips-packing.test.ts` | "Three days in Paris, one dinner, carry-on only": proposal from destination weather, proposed is not packed, Packed, a destination board, home laundry does not wash a suitcase, Unpacked is not clean | §10 Trip and packing; §17 Packing |
| `test/08-returns-exchanges.test.ts` | An order, arrival as a separate fact, sourced deadlines and unresolved ones, reminders, label to refund, stock leaves only on physical departure, an exchange without duplicate ownership | §10 Return and exchange deadlines; §17 Returns |
| `test/09-comfort-feedback.test.ts` | Optional feedback stored verbatim with only the known context, no questions, pain changes later boards without a ban, retract and undo | §10 Optional comfort feedback; §17 Comfort |
| `test/10-pause-resume.test.ts` | The scheduled service composes with no phone and no assistant; while paused nothing is published or reminded, observations still commit, future events are removed, return deadlines stay active; resume without backlog | §9 Schedule, Pause and resume; §17 Morning independence, Pause |
| `test/11-conversation-capture.test.ts` | The continuous conversation: durable turns, a named wear recorded at once, a request that waits for the owner's confirmation (confirm, reject, stale), invented garments, photo capture, a question answered, cancel, transcript, recall, event stream, no status interrogation | §3 Conversation and capture; §5; §13; §17 Hallucinated items, Visual matching, Missing reports |
| `test/12-studio.test.ts` | Studio: selectors of real garments, honest markers, backend validation, locked pieces, stable compositions, previews as jobs, Save combination, Plan for a day and Wear this as three distinct effects | §3 Studio; §17 Studio |
| `test/13-account-recovery-export.test.ts` | Losing the sign-in and recovering the same wardrobe with the recovery kit; a complete export verified checksum by checksum and imported into an empty owner without replaying effects; deletion needs its confirmation | §15; §17 Lost identity, Identity recovery, Portability |
| `test/14-mcp-assistant.test.ts` | A connected assistant end to end over real MCP and OAuth: tools per permission, the same board as the app, every inventory view against the API, direct reports, changes that wait for the owner, no way to confirm or lift a restriction, research runs, the legacy protocol, disconnect | §13 MCP; §15 |

## What is real and what stands in

Real: the Worker entry, router, authentication, command service, ledger, daily service, assistant
runtime, media module, scheduled handler, OAuth provider and MCP server; local D1 with every migration,
KV, R2, queue and Durable Object; the owner's documents, imported by the product's importer.

Stand-ins exist only at external boundaries. Each is labelled where it is defined, and none of them
proves anything about the real service:

| Boundary | Stand-in | Where | Used by |
| --- | --- | --- | --- |
| Open-Meteo forecast and geocoding | Scripted forecast in Open-Meteo's wire shape, per fictional test place and date; the Worker's real adapter parses it. An unscripted place or date answers 503 | `src/outbound.ts` | all files |
| Google Calendar events API | In-memory calendar in Google's documented wire shape (caller-supplied IDs, 409, `If-Match` and 412, cancelled-on-delete) with scriptable outage, lost response and refusal; the Worker's real adapter and projector talk to it | `src/outbound.ts` | 05, 10, 13 |
| Google OAuth, calendar list and creation; remote MCP tool service; APNs | The Worker package's own labelled fixture | `apps/worker/src/testing/vitest-config.ts` | 05, 10, 13 |
| Cloudflare Access sign-in | Assertions signed with a key generated per run, verified by the Worker's real verification code | `apps/worker/src/testing` | all files |
| Language model (AI Gateway) | The assistant workstream's labelled FAKE MODEL, scripted per step | `@garderobe/assistant/testing` | 11, 14, and one scripted reply in 13 |
| Garment photographs | `testPng()` labelled test images | `apps/worker/src/testing` | 11, 13 |

Consequences, stated plainly: every board in this suite comes from the deterministic composer (what the
owner gets when no model is available); no model-written outfit or reply is judged here; nothing ran
against Cloudflare's hosted D1, R2, KV or Durable Objects, Google, Apple or a real model. Those belong
to the deployment acceptance and the evaluation corpus, not to this suite.

The helpers the journeys import from `@garderobe/worker/testing` are the Worker package's own test
support (owned by the API thread, not part of this suite). What each does, as read in
`apps/worker/src/testing`:

- `provisionOwner` is the one helper that does not go through a public route for everything: it creates
  the user row and an invitation directly in local D1, runs the product's importer on the supplied
  profile and sheet through the real command service (for `real: true`), and then claims the
  invitation through the real `/auth/claim` route with a test-signed sign-in.
- `owner.api` sends each request to the Worker's `fetch` entry with that sign-in.
- `publishBoard` is `POST /v1/recommendations` in board mode, nothing else.
- `connectMcp` goes through the real OAuth consent flow and returns the MCP SDK client.
- `ownerDay` reads the owner's timezone from local D1 to name the owner's local date.
- `enableFakeModel` records the model-route probes as a labelled test fixture, so a conversation turn
  can run at all; `worker-entry` is the production Worker (same fetch, scheduled and queue handlers)
  whose conversation actor uses the fake model instead of AI Gateway.

## Evaluation corpus

`evals/corpus-check.mjs` checks the supplied evaluation bundle
(`requirements/support/wardrobe-support/evals`) without changing a byte of it:

- 64 cases (40 adapted from history, 24 constructed), split 45 development and 19 held out, with no
  source conversation in both splits and calibration replies from development conversations only;
- the profile copy is the September 14 profile byte for byte, and the September 15 decisions are a
  separate document;
- every historical excerpt keeps its conversation, message, date, position and source-message hash;
- all 64 candidate packets, built by the bundle's own `evaluate.py`, carry the complete profile,
  amendments, fixture and request and none of the judge criteria, source feedback, historical answers
  or expected state; a judge packet cannot be built before a candidate exists;
- the bundle's structural grader catches labelled negative controls (missing socks, an invented
  garment, restricted footwear, a duplicated role), and its state check refuses a record with no
  application-adapter provenance and catches a stale Calendar revision;
- the eight bundled historical reviews are well-formed.

What this is not. It runs no candidate, calls no model and judges nothing, so it says nothing about how
this application performs on any case. The owner's private chat export is not in the bundle: 38 of the
42 historical excerpts are whole messages and are re-hashed from the bundle alone, the other four are
partial quotations that only the export could confirm, and the script reports the bundle's own full
validation as not run to completion for that reason. Not built yet: the application adapter that
records observed state for the 18 behavioural cases, candidate runs through a live model, and
independent judging.

## Independent checks

- `src/inventory.ts` reads the owner's sheet from its columns alone and shares no code with the importer.
- `src/profile-checker.ts` checks the profile's hard constraints from the profile text and the sheet
  alone: garment names an outfit shows, the forecast the journey scripted, the wears the journey
  reported. It imports nothing from the product, and its first test proves it catches each violation.
- `internalCodesIn` (`src/world.ts`) is the check behind "no internal codes in owner-facing text".

### Known limits of these checks

Stated so that nobody reads more into a green run than it shows (most were raised by the independent
review of 2026-10-03 and are not yet closed):

- The thermal rule is checked only for garments whose season in the sheet states a number ("To 22°C",
  "10-24°C", "Hot (30°C+)"). A worded season ("Cold", "Winter", "Warm-weather" and the like) has no
  number in the owner's documents, and the checker does not invent one; such garments get no thermal check.
- `internalCodesIn` finds identifiers, UUIDs, snake_case codes, maker fabric codes and field names. It
  does not find a dotted command name without an underscore ("board.select"), camelCase codes, or a
  phrase such as "revision 2".
- `sheetRowsFor` matches a shown name to the sheet by item and the first word of the colour. Lines that
  disagree are reported as ambiguous; a wrong name sharing that first word would still be accepted.
- `safeLeadViolations` knows the plain sheet colours White, Off-white, Blue and Light blue.
- The Calendar double cannot fail a read (journey 05 covers a disconnected calendar, not a failed
  read) and answers a write to a cancelled event more leniently than Google does (204, where Google
  answers 410).
- Journey 03's weekly-baseline steps take "the most recent Sunday" from the clock and are not pinned to
  a weekday; they have not been run on a Sunday.
- The Studio forecast step in 12 asserts that Studio no longer says the forecast is unavailable; it does
  not assert positively which forecast the verdict used, and it uses Explore mode for a later day.
- In 06, the seven-day repeat is asserted for the days inside the week; that the pieces return on the
  eighth day is not asserted.

## Data rules

Real owner stock replaces demo stock. A boundary case that needs something the owner does not own uses a
garment created through the ordinary commands with `isSynthetic: true` and a name starting `SYNTHETIC`.
Each owner in a test is a fresh copy provisioned for that file; nothing is written to any deployment.
The "feet have healed" steps in `06` are a labelled what-if on such a copy: the owner has not said so.
No test prints the owner's profile, settings, recovery codes or tokens.

A connected assistant's typed command is driven by the server's answer (`mcpCommand` in `src/world.ts`):
when the server asks for the owner's confirmation, the owner reads the request in `GET /v1/proposals`
and confirms it; the resulting state and receipt are asserted either way. No test hard-codes which
command types wait.

## Product defects

A defect test states what the specification or the profile requires and is never weakened. See
[DEFECTS.md](DEFECTS.md) for each one's reproduction and owning workstream, and `src/defect.ts` for how
the two run modes treat them. When a defect is fixed its test starts to pass, the default run reports
"expected to fail", and the fix is to turn `defect(...)` into `it(...)` and move the entry to the
"Fixed" table of DEFECTS.md with the revision that fixed it. Only the journey suite's owner converts a
test, after re-running the journey on the branch that holds the fix.
