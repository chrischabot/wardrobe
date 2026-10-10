# Garderobe simulation: the MCP server over four simulated weeks

A seeded simulator that drives the Garderobe Worker the way a connected assistant does, for weeks of
changing conditions, and checks invariants on application state and receipts after every step.

The simulator is an MCP client and nothing else towards the wardrobe: it registers, runs the
authorization-code flow with PKCE, gets the owner's consent, and calls the seven tools with its own
Garderobe token. The owner's own part, which a connected assistant cannot do by design, is done as the
signed-in owner on the app hostname: claiming the account, approving consent, confirming or rejecting a
request that waits for the owner, connecting the calendar, asking for a packing proposal, lifting a
restriction the simulation itself added.

## Running

From the repository root, after `npm install` (or `bash tools/sandbox-install.sh` in the Fabric sandbox):

| Command | What it does |
| --- | --- |
| `npm run sim:local -w @garderobe/simulation -- --seeds 1,2,3,4,5 --out results/local` | Five seeds, four weeks each, locally: one fresh database per seed, seeded with the owner's real profile and inventory, served by the simulation Worker under `wrangler dev`. Writes one result per seed and a summary into `tests/simulation/results/local/`. Exit code 0 only when every seed ran to its last step and no invariant check failed. |
| `npm run sim -w @garderobe/simulation -- --target <target.json> --seeds 1,2,3,4,5 --out <directory>` | The same simulator against any target described by a file (see "Targets"). |
| `npm test -w @garderobe/simulation` | The parts that need no Worker: the timeline is a pure function of the seed, every plan holds every kind of condition, and the independent checker catches each violation (negative controls). This is what the root `npm test` runs; the simulation itself takes minutes and a running Worker, so it is not part of `npm test`. |
| `npm run typecheck -w @garderobe/simulation` | Typecheck of the simulation Worker entry. |

Options of `sim:local`: `--weeks N` (at least 4), `--parallel N` (seeds at the same time, default 2),
`--until-day N` (stop early, for debugging), `--state <directory>` (local databases, keys and logs;
default: a directory in the system's temporary directory, never inside the repository), `--port N`.

## What a run is

`lib/timeline.mjs` turns a seed into a plan and nothing else decides anything: the same seed gives the
same plan byte for byte (`timeline.planDigest` in each result). A numeric seed also fixes the season:
seeds 0 to 5 start on six Mondays of 2027 spread over the year, two of them with a daylight-saving
change inside the four weeks. The simulated dates lie in the future on purpose: the local key-value
store refuses an expiry in the real past.

A plan holds, in advance:

- **Weather**: a forecast for every day with a seasonal drift, rain on some days, a two-day heat
  spike, a two-day cold snap, sudden rain announced on the morning itself (before or after the board
  was published), and two forecast outages (one over an evening composition and the next morning, one
  in daytime).
- **Calendar**: formal entries, workouts, ordinary entries and the trip's travel, each appearing on
  some earlier day; some move to another day, some are cancelled.
- **Circumstance**: a three-day trip with a packing proposal, a suitcase and an unpacking; two days
  of illness with no reports; days working from home; a pause of two or three days, ended by the
  owner or by its resume date; an order that arrives and is returned or exchanged.
- **Availability**: garments lost, at the cleaner, lent, damaged, and coming back; the owner's own
  observations that contradict the ledger ("all of it is in the hamper", a count, a spill); a weekly
  laundry with one exception per week kind (a piece still away, a piece lost by the service, a bag
  that did not come back, a week with no laundry reports at all); and repair probes: tomorrow's
  outfit is chosen in the evening and one of its pieces then becomes unavailable.
- **Every day**: which option is chosen, changed or rejected, whether other options are asked for,
  what is actually worn relative to the choice, whether the report is late, repeated or also sent
  from the app, and a comfort note now and then. Choices are stored as draws and resolved at run time
  against what the server actually offered, in a stable order.

`lib/schedule.mjs` lays these out as timed steps (about 350 per seed). For each step the runner sets
the target's clock, runs the step, and then checks every standing invariant.

## Invariants

Checked after every step (`lib/invariants.mjs`), on state read back through MCP:

- No offered garment, on today's board, tomorrow's board or in a recommendation, is unknown, not
  owned, hard-excluded, restricted, made unavailable by the simulated owner, or against a hard
  constraint of the profile. The profile check (`lib/profile-check.mjs`) is independent: it is written
  from `requirements/chris-wardrobe-profile.md` section 8 and the inventory sheet alone and imports
  nothing from the product. Its header says what it does not judge.
- Wears: every report is counted, nothing is in the history that the simulation did not report, there
  is one counted wear per garment and day, and each garment's wear count equals its reported days.
- Availability: probabilities are probabilities; a hard exclusion states a hard reason; uncertainty
  alone never excludes; what the owner made unavailable stays unavailable until it comes back.
- The restriction recorded from the profile is in force at the start and is never lifted.
- Calendar: one managed event per day, with the product's stable identifier, replaced under a
  version precondition, with a revision that never goes back and is never ahead of the board.
- Nothing is published for a paused day.

Checked where they apply (`lib/sim.mjs`, `lib/handlers-*.mjs`): every accepted command's receipt reads
back as returned, a repeat of the same call returns that receipt and writes nothing, the same key with
another request is refused; a change that is not a report waits for the owner and is not executed
before the decision; a planned piece that becomes unavailable is replaced on tomorrow's board by
itself, in a new revision, with the choice kept; an owner's count or "dirty" is what the ledger then
says; the weekly baseline keeps laundry exceptions and does not call inferred cleanliness observed; a
proposal is not a packed suitcase, a trip day is answered from the suitcase, unpacking makes nothing
clean; stock leaves only on physical departure and an exchange never duplicates ownership; a
connected assistant cannot lift a restriction; a run that failed says so and changes nothing; the
synthetic second owner sees and touches nothing of the first.

A failed check records the seed, the step, the target's time, a sentence, and the receipt it concerns.
Nothing is retried or softened.

## What is real and what stands in

Real: the product Worker (`apps/worker/src/index.ts`: router, authentication, OAuth provider, MCP
server, command service, ledger, daily service, scheduled handler, conversation actor), local D1 with
every migration, KV, R2, queue and Durable Object, and the owner's profile and inventory, imported by
the product's importer. The stock is the owner's real stock; no garment, wear or lifted restriction is
added to it by the seed. Everything the simulation adds lives only in that seed's simulation database.

Stand-ins, all labelled where they are defined, at external boundaries only:

| Boundary | Stand-in | Where |
| --- | --- | --- |
| Time | A settable clock: the simulation Worker replaces `Date` so the simulator can set "now" | `worker/clock.ts` |
| Open-Meteo forecast and geocoding | A scripted forecast in Open-Meteo's wire shape, parsed by the product's real adapter; an unscripted day or a place switched off answers 503 | `worker/conditions.ts` |
| Google OAuth, calendar list and creation, Calendar events | An in-memory calendar in Google's documented wire shape (caller-supplied identifiers and 409, `If-Match` and 412, cancelled-on-delete) | `worker/conditions.ts` |
| The five-minute cron | `POST /__sim/scheduled` runs the product's own `scheduled` handler once and waits for it | `worker/entry.ts` |
| Cloudflare Access sign-in | An assertion signed with a key generated for the run, verified by the Worker's real verification code | `lib/local-target.mjs`, `lib/target.mjs` |
| Language model | None. There is no model binding locally: `garderobe_ask` and `garderobe_research` return durable runs that end in a reported failure, and every board comes from the deterministic composer | |

The simulation Worker entry refuses to serve unless `ENVIRONMENT` is `local`, its doors need the run's
control token, and it awaits a request's background work before answering so that a step's effects are
complete when state is read. It is never part of the product Worker.

Synthetic and labelled as such: the weather, the calendar entries, the circumstances, the events that
make garments unavailable, the ordered shirt of the return or exchange (`SYNTHETIC ...`), and the
second owner with its two garments, which exists only for the isolation check.

## Targets

A target is a JSON description (`lib/target.mjs`):

```json
{
  "label": "local simulation Worker",
  "appOrigin": "http://localhost:8850",
  "mcpOrigin": "http://127.0.0.1:8850",
  "signIn": { "kind": "local-assertion", "issuer": "...", "audience": "...", "privateJwk": { } },
  "owners": {
    "primary": { "subject": "...", "email": "...", "invitationCode": "...", "importedGarments": 127 },
    "second": { "subject": "...", "email": "...", "invitationCode": "..." }
  },
  "doors": { "kind": "simulation-worker", "controlOrigin": "...", "controlToken": "...", "clock": true, "weather": true, "calendar": true, "scheduled": true }
}
```

`bin/local.mjs` writes one per seed. For a deployment behind Cloudflare Access the sign-in kind is
`headers-from-environment`: each owner names, per header, the environment variable that holds its
value, so no credential is in a file. No Cloudflare management credential is used anywhere.

A timeline of weeks can only elapse on a target whose clock the simulator sets. Running the same seeds
in real time against a deployment without that door is a separate mode that is **not built yet**; the
runner says so and stops rather than pretending.

## Layout

| Path | Purpose |
| --- | --- |
| `worker/entry.ts`, `clock.ts`, `conditions.ts`, `seed.ts` | The simulation Worker (product Worker plus the labelled doors) and the seed of one simulation database |
| `lib/timeline.mjs`, `lib/schedule.mjs`, `lib/rng.mjs`, `lib/dates.mjs` | Seed to plan to timed steps |
| `lib/target.mjs`, `lib/local-target.mjs` | The target: MCP sessions, the owner's app requests, the doors; a local target per seed |
| `lib/sim.mjs`, `lib/invariants.mjs`, `lib/profile-check.mjs` | Run state, command plumbing with receipt checks, standing invariants, the independent profile check |
| `lib/handlers-daily.mjs`, `lib/handlers-conditions.mjs`, `lib/handlers-circumstances.mjs` | What each step does |
| `lib/runner.mjs`, `lib/report.mjs`, `bin/local.mjs`, `bin/run.mjs` | Running seeds and writing results |
| `results/` | Committed results: one JSON per seed and a summary per target |
| `test/` | Tests that need no Worker |
