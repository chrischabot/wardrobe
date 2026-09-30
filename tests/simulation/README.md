# Garderobe end-to-end MCP simulation

A reproducible, seeded multi-week simulation of the owner's life with Garderobe, driven **only through the MCP server** (plus the scheduled daily phases), against the local Worker or the deployed `garderobe-dev` endpoint. It uses the owner's real profile and wardrobe: each run seeds a fresh simulation owner with `data/owner-profile.md`, its 41 rules, the May 2026 CSV and the owner-asserted additions, through the foundation importer. Unknown colours, makers, sizes and counts stay as the importer leaves them.

## What one run does

`src/scenario.ts` turns one integer seed into a plan of at least 28 days (default seed `20261005`, Monday 5 October to Sunday 1 November 2026, across the 25 October change from BST to GMT). Every seed contains every condition below. The seed decides the weather values, calendar events, which garments the circumstances touch, and which outfit the owner picks.

| Area | Simulated conditions |
| --- | --- |
| Weather (home, and Amsterdam on trip days) | mild, cool, cold snap, heavy rain, rain after 16:00, strong wind, the 14–16 °C jacket band, cold start with a warm afternoon, unseasonal warmth; a forecast revised overnight (the evening compose sees a different forecast from the morning); two provider outages |
| Calendar (Google Calendar stand-in) | office meetings, formal meetings, dinners, weekend outdoor plans, an all-day wedding, declined and cancelled events, a flight, a trip dinner, an event title carrying a prompt injection, and a calendar outage |
| Availability | a spill (mark in wash), service-laundry collection and return twice a week, a partial return with a missing shirt, a repair restriction set and lifted (with the owner's confirmation), trousers at the tailor and back, seasonal storage, a three-day trip (create, proposal, packed, trip-day boards from the suitcase, unpacked) |
| Circumstance | random outfit selection every day (with a random shoe when an option offers two), a forgotten wear log, shirt-swap previews, occasion previews, the owner saying his feet have healed (the sneakers-only restriction then lifts, and the sneaker-plus-welted pairing applies), a two-day pause and resume, a temporary "working from home" brief |
| Assistant (`garderobe_ask`, `garderobe_research`) | about 40 questions: pick from the board, build an outfit, rain plan, evening change, swap a shirt, trip outfit, a week's recall, deep questions (a purchase verdict, fit, provenance, keep or sell), an adversarial request to ignore the healing restriction and log it, the healing statement, and a research topic |

For each simulated day (London time): the evening before, the real `DailyService.runPhase('evening')` composes the board; at 06:40 and 06:50 the morning refresh and final validation run; at 07:00 the owner reads Today over MCP; then questions, the pick (`select_option`), the wear (`record_wear`), daytime and evening circumstances, and late questions. Every read is checked and assistant turns are audited at the end.

## Checks

- **Profile hard constraints** on every board and preview option, and on every *actionable* outfit card from the assistant. These are the journey suite's independent checkers (`tests/journeys/harness/profile.ts`: socks always, sneakers only while the healing restriction stands and then sneaker plus welted, shirts, knits and trousers against the peak, outerwear against the departure, the 14–16 °C lightweight-oxford rule, no shirt or trousers repeated within seven days, perceptible names, only eligible pieces).
- **Availability**: nothing offered that the simulated owner declared away (tailor, repair, storage, missing from the laundry, spilled on and not yet laundered, packed for the trip), and nothing the inventory itself lists as unavailable at that moment. Trip-day options must come from the suitcase.
- **Weather applied**: the board's departure and peak temperatures must match the simulated curve (±1.5 °C). An outage must be surfaced, not shown as fresh weather.
- **Pause**: no outfits on paused days.
- **Assistant turns** (read from D1 through the hook's audit route): the turn is dated on the simulated day, which proves the actor's clock followed the simulation. Actionable cards pass the checks above and reference only garments available when the question was asked. Rejected cards name the failed validator rule. Answers contain no maker codes or internal ids. The adversarial request logs nothing. On dev, every chat step ran on `gpt-6.1-sol` or `claude-opus-5-5`. The models, tokens and app-ledger cost of each turn are listed.

## Running it

From `garderobe/`:

```sh
# Local comparison run (fresh local state and owner, local Worker, simulation, shutdown). The assistant uses the product's deterministic fake model.
npx tsx tests/simulation/scripts/local-run.ts --seed 20261005

# Live run on garderobe-dev (dev only). Order matters: deploy first, because provisioning rewrites the
# service-token policy; setup-dev then re-adds the simulation token and seeds a fresh owner.
npm run deploy:dev
npx tsx tests/simulation/scripts/spend.ts                    # remaining budget under the $50 gateway rule
npx tsx tests/simulation/scripts/setup-dev.ts --budget-usd 25
npx tsx tests/simulation/src/run.ts --target dev --seed 20261005 --deployed-version <version id>
npx tsx tests/simulation/scripts/spend.ts --since <run start ISO>   # spend per model during the run
npx tsx tests/simulation/scripts/compare.ts --seed 20261005        # local vs dev, day by day

# Unit tests of the harness itself (header signing, scenario reproducibility and coverage)
npm test --workspace @garderobe/simulation-tests
```

Options for `run.ts`: `--seed N`, `--days N` (at least 28), `--limit-days N` (smoke run), `--max-asks N` (default 60), `--no-asks`, `--out <dir>` (default `tests/simulation/reports`). Reports are `reports/<target>-seed<seed>.{json,md}`; the JSON holds the whole plan and every record, and a partial report is written after every day.

## How the simulated world reaches the deployed Worker

The hook is `worker/sim-hook.ts`. It is wired into the dev deployment's entry (`deploy/src/dev-entry.ts`) and the local simulation entry (`worker/local-entry.ts`), never into the product entry `backend/src/index.ts`.

- Each harness request carries `x-garderobe-sim`: the simulated clock, weather curves and calendar events for a window around the current day, plus the simulation owner id, HMAC-SHA256-signed with the `DEV_SIM_SECRET` Worker secret (`src/sim-state.ts`). A bad signature, or any header outside ENVIRONMENT `dev`/`local`, is refused with 403. A request without the header runs with the product defaults (Open-Meteo, no calendar, the real clock).
- A valid header installs the state through the product's existing test seams: `installApiTestOverrides` (API, MCP tools, repair after commands) and `installTestDailyProviders` (the assistant's day context and outfit validation). Before an MCP call that can reach the assistant, the hook pushes the same state into the simulation owner's actor (`devSimulation`, added by the `withSimulation` mixin), whose clock then follows the simulated clock.
- `POST /__sim/phase` runs one scheduled daily phase for the simulation owner. `POST /__sim/audit` returns that owner's assistant turns (with outfit cards) and model runs. Both need a valid header and act only on the owner named in it.
- The fake weather provider is named after the scenario revision, so the shared D1 forecast cache never serves another scenario.
- Limits: the overrides are per isolate, so do not run other dev traffic (for example `dev:verify`) during a simulation. The managed outfit calendar is not projected (`calendarStore: null`).

Dev pieces the simulation adds (all dev-only):
- the `DEV_SIM_SECRET` Worker secret (value in `deploy/.state/dev-sim-secret.json`);
- the Access service token `garderobe-dev-automation-sim` in the reusable "Garderobe dev automation (service token)" policy (secret in `deploy/.state/access-service-token-sim.json`). `npm run deploy:dev` / `dev:provision` remove it from the policy again, so a plain deployment keeps its own two tokens;
- one "Chris (simulation …)" owner per run on the dev D1 with an app model budget of $25 (`--budget-usd`). The service token's identity moves to the newest owner and is audited on both. Receipts are immutable, so earlier simulation owners stay in the database, unlinked.

Without a signed header the dev Worker behaves exactly like the product, so `npm run dev:verify` still reflects the normal deployment.

## Stand-ins

| Part | Live on dev | Local comparison |
| --- | --- | --- |
| Worker, MCP server (2026-07-28), OAuth grant and consent, D1, Durable Object assistant, daily service, validator | real (deployed) | real (workerd via `wrangler dev --local`) |
| Cloudflare Access | real Access at the edge (service token) plus the Worker's own verification | locally generated RSA key standing in for the Access team key |
| Assistant model | real models through AI Gateway (Sol for routine turns, Opus 5.5 medium for deep turns; kimi for compaction) | the product's deterministic fake model (answers "Understood.", no tool calls, so no outfit cards) |
| Weather | simulated curves (FakeWeatherProvider) via the signed hook | the same |
| Google Calendar | simulated events (FakeCalendar) via the signed hook | the same |
| Clock | simulated via the hook (API, daily service, assistant actor) | the same |
| Gmail, Exa/Tavily, Browser Run, image providers | not exercised | not exercised |

## Results

See `reports/` and `FINDINGS.md`.
