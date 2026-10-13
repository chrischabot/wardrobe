# Simulation results: local simulation Worker

Run command: `node bin/local.mjs --seeds 1,2,3,4,5 --parallel 5 --out results/local`

5 seeds. Every seed ran to its last step. No invariant check failed.

Target: the product Worker inside the simulation Worker entry (`worker/entry.ts`) under `wrangler dev`, with local D1, KV, R2, queue and Durable Object, seeded with the owner's real profile and inventory by the product's importer.

Stand-ins, at external boundaries only, all labelled: the settable clock, the scripted Open-Meteo forecast, the in-memory Google Calendar and OAuth, and a locally signed sign-in in place of Cloudflare Access. No model is reachable locally, so `garderobe_ask` and `garderobe_research` return durable runs that end in a reported failure and every board comes from the deterministic composer. Nothing in this run touched a deployment.

## Seeds

| Seed | Simulated days | Season | Steps run / planned | Step errors | Checks passed | Checks failed | Not applicable | MCP tool calls | Commands | Plan digest | Outcome digest | Real time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2027-03-08 to 2027-04-04 (28) | spring (summer time begins on 28 March) | 351 / 351 | 0 | 12855 | 0 | 5 | 3013 | 128 | `2c92379c01f31770` | `54c3f67a270634a5` | 233 s |
| 2 | 2027-05-31 to 2027-06-27 (28) | early summer | 354 / 354 | 0 | 13113 | 0 | 4 | 3107 | 132 | `f6eb348a37466c48` | `d5e04f80776ae024` | 234 s |
| 3 | 2027-07-19 to 2027-08-15 (28) | high summer | 350 / 350 | 0 | 12776 | 0 | 3 | 3118 | 140 | `1a85788fff84d6b7` | `a77dd5d065174913` | 232 s |
| 4 | 2027-09-06 to 2027-10-03 (28) | autumn | 350 / 350 | 0 | 12939 | 0 | 3 | 3032 | 129 | `3580fda298760236` | `365c0326b3b8b0b9` | 230 s |
| 5 | 2027-10-11 to 2027-11-07 (28) | late autumn (summer time ends on 31 October) | 355 / 355 | 0 | 13139 | 0 | 3 | 3057 | 129 | `2a6dd87d008a37b6` | `c1bf3aa8f4b58e21` | 237 s |

## Tool coverage

Calls made through the MCP client, per tool and seed (answered + refused with a typed error).

| Tool | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 | Exercised |
| --- | --- | --- | --- | --- | --- | --- |
| `garderobe_ask` | 4 + 0 | 4 + 0 | 4 + 0 | 4 + 0 | 4 + 0 | yes, in every seed |
| `garderobe_command` | 236 + 11 | 244 + 11 | 256 + 11 | 238 + 11 | 238 + 10 | yes, in every seed |
| `garderobe_inventory` | 1913 + 3 | 1965 + 3 | 1983 + 3 | 1924 + 3 | 1932 + 3 | yes, in every seed |
| `garderobe_recommend` | 8 + 0 | 20 + 0 | 12 + 0 | 6 + 0 | 12 + 0 | yes, in every seed |
| `garderobe_research` | 2 + 0 | 2 + 0 | 2 + 0 | 2 + 0 | 2 + 0 | yes, in every seed |
| `garderobe_run` | 8 + 6 | 7 + 6 | 7 + 6 | 8 + 6 | 8 + 6 | yes, in every seed |
| `garderobe_today` | 822 + 0 | 845 + 0 | 834 + 0 | 830 + 0 | 842 + 0 | yes, in every seed |

`garderobe_inventory` views:

| View | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| `items` | 16 | 12 | 12 | 12 | 12 |
| `snapshot` | 978 | 1013 | 1011 | 985 | 994 |
| `item` | 4 | 8 | 6 | 4 | 9 |
| `availability` | 3 | 1 | 3 | 4 | 2 |
| `history` | 366 | 368 | 366 | 367 | 370 |
| `laundry` | 15 | 16 | 16 | 18 | 17 |
| `style` | 6 | 1 | 3 | 4 | 2 |
| `resolve` | 1 | 3 | 6 | 3 | 1 |
| `selection` | 6 | 4 | 2 | 3 | 3 |
| `receipts` | 502 | 518 | 540 | 506 | 503 |
| `command_types` | 2 | 5 | 4 | 6 | 1 |
| `trips` | 4 | 6 | 6 | 6 | 6 |
| `returns` | 7 | 6 | 6 | 4 | 10 |
| `orders` | 6 | 7 | 5 | 5 | 5 |

`garderobe_run` actions:

| Action | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| `cancel` | 1 | 1 | 1 | 1 | 1 |
| `respond` | 2 | 2 | 2 | 2 | 2 |
| `resume` | 2 | 2 | 2 | 2 | 2 |
| `status` | 9 | 8 | 8 | 9 | 9 |

`garderobe_command` types and the route each took (direct, confirmed by the owner in the app, rejected by the owner, refused; `owner app` marks the few commands only the signed-in owner can send):

| Command type | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| `board.select` | 27 direct | 30 direct | 33 direct | 31 direct | 25 direct |
| `board.swap_slot` | 2 direct | 3 direct | 3 direct | 3 direct | 4 direct |
| `care.mark_dirty` | 5 direct | 5 direct | 5 direct | 5 direct | 5 direct |
| `care.washed` | 3 direct | 4 direct | 3 direct | 4 direct | 2 direct |
| `command.undo` | 5 direct | 6 direct | 6 direct | 6 direct | 6 direct |
| `feedback.record` | 3 direct | 1 direct | 3 direct | 1 direct | 4 direct |
| `garment.create` | 2 direct | 2 direct | 2 direct | 2 direct | 2 direct |
| `garment.move` | 5 direct | 5 direct | 5 direct | 5 direct | 5 direct |
| `garment.receive` | 1 direct | 1 direct | 1 direct | 1 direct | 1 direct |
| `garment.retire` | 4 direct | 4 direct | 4 direct | 4 direct | 4 direct |
| `garment.set_planning_policy` | 4 direct | 4 direct | 4 direct | 4 direct | 4 direct |
| `laundry.collect` | 2 direct | 3 direct | 3 direct | 2 direct | 3 direct |
| `laundry.report_exception` | 1 direct | 1 direct | 1 direct | 1 direct | 2 direct |
| `laundry.return` | 2 direct | 3 direct | 3 direct | 2 direct | 3 direct |
| `purchase.import_order` | 2 direct | 2 direct | 1 direct | 2 direct | 1 direct |
| `purchase.mark_delivered` | 1 direct | 1 direct | 1 direct | 1 direct | 1 direct |
| `restriction.add` | 2 direct | 2 direct | 2 direct | 2 direct | 2 direct |
| `restriction.resolve` | 4 refused, 2 owner app | 4 refused, 2 owner app | 4 refused, 2 owner app | 4 refused, 2 owner app | 4 refused, 2 owner app |
| `return.link_exchange` | 1 direct | 1 direct | 0 | 1 direct | 0 |
| `return.open_case` | 1 direct | 1 direct | 1 direct | 1 direct | 1 direct |
| `return.update_case` | 3 direct | 3 direct | 3 direct | 3 direct | 3 direct |
| `service.pause` | 1 direct | 1 direct | 1 direct | 1 direct | 1 direct |
| `service.resume` | 0 | 0 | 1 direct | 0 | 1 direct |
| `settings.update` | 1 direct | 1 direct | 1 direct | 1 direct | 1 direct |
| `stock.pack` | 1 direct | 1 direct | 1 direct | 1 direct | 1 direct |
| `stock.reconcile` | 2 direct | 2 direct | 2 direct | 2 direct | 2 direct |
| `stock.unpack` | 1 direct | 1 direct | 1 direct | 1 direct | 1 direct |
| `style.set_brief` | 3 direct | 3 direct | 3 direct | 3 direct | 3 direct |
| `trip.create` | 1 direct | 1 direct | 1 direct | 1 direct | 1 direct |
| `wear.amend` | 1 direct | 1 direct | 2 direct | 2 direct | 2 direct |
| `wear.record` | 33 direct, 2 owner app | 31 direct, 2 owner app | 33 direct, 4 owner app | 28 direct, 2 owner app | 30 direct, 2 owner app |

| OAuth and the owner's part | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| Connections authorized through consent | 3 | 3 | 3 | 3 | 3 |
| Access tokens renewed with the refresh token | 346 | 361 | 364 | 360 | 355 |
| Requests made as the signed-in owner (consent, decisions, setup) | 16 | 16 | 18 | 16 | 16 |
| Test-door requests (clock, scheduled sweep, scripted conditions) | 883 | 889 | 879 | 879 | 890 |
| MCP resources read | 3 | 3 | 3 | 3 | 3 |

## Conditions in the timelines

Planned by the seed:

| Weather | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| scripted days | 28 | 28 | 28 | 28 | 28 |
| rainy days | 4 | 2 | 3 | 2 | 4 |
| seasonal drift c | 5 | 3 | 3 | -9 | -6 |
| sudden rain | 4 | 4 | 4 | 4 | 4 |
| heat days | 2 | 2 | 2 | 2 | 2 |
| cold snap days | 2 | 2 | 2 | 2 | 2 |
| forecast outages | 2 | 2 | 2 | 2 | 2 |

| Calendar | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| entries appearing | 12 | 12 | 12 | 12 | 12 |
| formal | 3 | 3 | 3 | 3 | 3 |
| workouts | 4 | 4 | 4 | 4 | 4 |
| travel | 2 | 2 | 2 | 2 | 2 |
| moved | 3 | 3 | 3 | 3 | 3 |
| cancelled | 2 | 2 | 2 | 2 | 2 |

| Availability | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| lost | 2 | 2 | 2 | 2 | 2 |
| at the cleaner | 2 | 2 | 2 | 2 | 2 |
| lent | 2 | 2 | 2 | 2 | 2 |
| damaged | 2 | 2 | 2 | 2 | 2 |
| owner observations contradicting estimates | 6 | 6 | 6 | 6 | 6 |
| laundry weeks | 4 | 4 | 4 | 4 | 4 |
| laundry exception weeks | 3 | 2 | 3 | 3 | 3 |
| repair probes | 4 | 4 | 4 | 4 | 4 |

| Circumstance | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| trip days | 3 | 3 | 3 | 3 | 3 |
| ill days | 2 | 2 | 2 | 2 | 2 |
| work from home days | 3 | 3 | 3 | 3 | 3 |
| paused days | 3 | 2 | 3 | 2 | 2 |
| return or exchange | exchange | exchange | return | exchange | return |
| days without a wear report | 6 | 5 | 3 | 5 | 5 |

Counted while running (what actually happened on the target):

| Condition | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| arrivals reported | 1 | 1 | 1 | 1 | 1 |
| attempts by the connected assistant to lift the profile's restriction (all must be refused) | 2 | 2 | 2 | 2 | 2 |
| calendar entries: entry cancelled (SIMULATED calendar) | 2 | 2 | 2 | 2 | 2 |
| calendar entries: entry moves to another day (SIMULATED calendar) | 3 | 3 | 3 | 3 | 3 |
| calendar entries: formal entry appears (SIMULATED calendar) | 3 | 3 | 3 | 3 | 3 |
| calendar entries: ordinary entry appears (SIMULATED calendar) | 3 | 3 | 3 | 3 | 3 |
| calendar entries: travel entry appears (SIMULATED calendar) | 2 | 2 | 2 | 2 | 2 |
| calendar entries: workout entry appears (SIMULATED calendar) | 4 | 4 | 4 | 4 | 4 |
| comfort notes: pain | 1 | 0 | 0 | 0 | 0 |
| comfort notes: positive | 2 | 0 | 0 | 0 | 2 |
| comfort notes: scratchy | 0 | 0 | 0 | 0 | 1 |
| comfort notes: too_cold | 0 | 0 | 2 | 1 | 0 |
| comfort notes: too_warm | 0 | 1 | 1 | 0 | 1 |
| day briefs set (working from home) | 3 | 3 | 3 | 3 | 3 |
| days with a scripted forecast (SIMULATED weather) | 28 | 28 | 28 | 28 | 28 |
| days with no wear report | 6 | 5 | 3 | 5 | 5 |
| exchanges opened (SYNTHETIC order) | 1 | 1 | 0 | 1 | 0 |
| exchanges settled | 1 | 1 | 0 | 1 | 0 |
| forecast changes: cold snap (SIMULATED weather) | 2 | 2 | 2 | 2 | 2 |
| forecast changes: heat (SIMULATED weather) | 2 | 2 | 2 | 2 | 2 |
| forecast changes: sudden rain (SIMULATED weather) | 4 | 4 | 4 | 4 | 4 |
| forecast outages: daytime (SIMULATED weather) | 1 | 1 | 1 | 1 | 1 |
| forecast outages: overnight (SIMULATED weather) | 1 | 1 | 1 | 1 | 1 |
| garderobe_ask (start): cancelled | 0 | 0 | 0 | 1 | 0 |
| garderobe_ask (start): cancelled (no_selectable_profile) | 1 | 1 | 1 | 0 | 1 |
| garderobe_ask (wait): failed (no_selectable_profile) | 1 | 1 | 1 | 1 | 1 |
| garderobe_research (history): failed (no_selectable_profile) | 1 | 1 | 1 | 1 | 1 |
| garderobe_research (product): failed (no_selectable_profile) | 1 | 1 | 1 | 1 | 1 |
| garments clean again by the weekly baseline alone (a week without laundry reports) | 0 | 0 | 6 | 0 | 4 |
| garments made unavailable: at the cleaner (SIMULATED event) | 2 | 2 | 2 | 2 | 2 |
| garments made unavailable: damaged (SIMULATED event) | 2 | 2 | 2 | 2 | 2 |
| garments made unavailable: lent (SIMULATED event) | 2 | 2 | 2 | 2 | 2 |
| garments made unavailable: lost (SIMULATED event) | 2 | 2 | 2 | 2 | 2 |
| garments restricted by the profile at the start | 4 | 4 | 4 | 4 | 4 |
| garments that came back: from the cleaner (SIMULATED event) | 2 | 2 | 2 | 2 | 2 |
| garments that came back: from the friend (SIMULATED event) | 2 | 2 | 2 | 2 | 2 |
| garments that came back: repaired (SIMULATED event) | 2 | 2 | 2 | 2 | 2 |
| hand-wash reports (socks washed) | 3 | 3 | 3 | 4 | 2 |
| isolation checks against the SYNTHETIC second owner | 3 | 3 | 3 | 3 | 3 |
| laundry exceptions: a piece lost by the service | 0 | 1 | 0 | 1 | 1 |
| laundry exceptions: one piece did not come back with the bag | 0 | 2 | 1 | 1 | 1 |
| laundry exceptions: the bag did not come back | 1 | 0 | 1 | 0 | 1 |
| laundry pickups | 2 | 3 | 3 | 2 | 3 |
| laundry returns | 1 | 3 | 2 | 2 | 2 |
| laundry: a missed bag returned days late | 1 | 0 | 1 | 0 | 1 |
| laundry: a piece that came back late | 0 | 1 | 0 | 0 | 0 |
| managed Calendar event writes (insert, replace, remove) | 38 | 37 | 31 | 36 | 42 |
| managed Calendar events replaced in place under a newer revision | 25 | 26 | 25 | 26 | 26 |
| morning boards with options marked as suiting a calendar entry | 5 | 5 | 6 | 4 | 4 |
| morning boards, calendar ok | 22 | 23 | 22 | 23 | 23 |
| morning boards, forecast fresh | 21 | 22 | 21 | 22 | 22 |
| morning boards, forecast unavailable | 1 | 1 | 1 | 1 | 1 |
| morning boards: current | 21 | 22 | 21 | 22 | 22 |
| morning boards: limited | 1 | 1 | 1 | 1 | 1 |
| morning decision: choose | 9 | 11 | 9 | 13 | 14 |
| morning decision: choose_then_change | 5 | 2 | 5 | 6 | 3 |
| morning decision: no_choice | 7 | 3 | 5 | 4 | 3 |
| morning decision: reject_and_ask_again | 1 | 7 | 3 | 0 | 3 |
| mornings away on the trip | 3 | 3 | 3 | 3 | 3 |
| mornings while the service was paused | 3 | 2 | 3 | 2 | 2 |
| most garments at once whose availability was an estimate | 79 | 79 | 79 | 79 | 79 |
| offers checked without a thermal check (forecast unavailable, stale or just changed) | 70 | 71 | 55 | 69 | 66 |
| orders logged (SYNTHETIC order) | 1 | 1 | 1 | 1 | 1 |
| outfits chosen the evening before | 7 | 12 | 12 | 6 | 5 |
| owner observations contradicting the ledger: a spill (was available) | 1 | 0 | 0 | 1 | 1 |
| owner observations contradicting the ledger: a spill (was estimated) | 1 | 2 | 2 | 1 | 1 |
| owner observations contradicting the ledger: all of it in the hamper (was available) | 1 | 2 | 1 | 1 | 1 |
| owner observations contradicting the ledger: all of it in the hamper (was estimated) | 1 | 0 | 1 | 1 | 1 |
| owner observations contradicting the ledger: counted clean (was estimated) | 1 | 1 | 2 | 1 | 2 |
| owner observations contradicting the ledger: counted clean (was unavailable) | 1 | 1 | 0 | 1 | 0 |
| packing proposals (from the destination's SIMULATED forecast) | 1 | 1 | 1 | 1 | 1 |
| parcels posted back (physical departure recorded separately) | 1 | 1 | 1 | 1 | 1 |
| pauses (until the owner resumes) (SIMULATED circumstance) | 0 | 0 | 1 | 0 | 1 |
| pauses (with a resume date) (SIMULATED circumstance) | 1 | 1 | 0 | 1 | 0 |
| repair probes: lost | 1 | 1 | 1 | 1 | 1 |
| repair probes: marked dirty | 1 | 1 | 1 | 1 | 1 |
| repair probes: sent to cleaner | 1 | 1 | 1 | 1 | 1 |
| repair probes: worn today late report | 1 | 1 | 1 | 1 | 1 |
| resumes by the owner | 0 | 0 | 1 | 0 | 1 |
| returns opened (SYNTHETIC order) | 0 | 0 | 1 | 0 | 1 |
| returns settled | 0 | 0 | 1 | 0 | 1 |
| route.direct | 120 | 124 | 130 | 121 | 121 |
| route.refused | 4 | 4 | 4 | 4 | 4 |
| scheduled sweeps run (the product's own scheduled handler) | 148 | 148 | 146 | 146 | 147 |
| suitcases packed | 1 | 1 | 1 | 1 | 1 |
| suitcases unpacked | 1 | 1 | 1 | 1 | 1 |
| swaps on tomorrow's board | 2 | 3 | 3 | 3 | 4 |
| swaps undone | 2 | 3 | 3 | 3 | 4 |
| trips planned (SIMULATED circumstance) | 1 | 1 | 1 | 1 | 1 |
| wear reports corrected (route: direct) | 1 | 1 | 2 | 2 | 2 |
| wear reports from the suitcase | 3 | 3 | 3 | 3 | 3 |
| wear reports made the next morning | 1 | 1 | 0 | 1 | 3 |
| wear reports made the same evening | 18 | 19 | 22 | 19 | 17 |
| wear reports repeated as a new report | 9 | 6 | 6 | 3 | 5 |
| wear reports repeated from the owner's app | 2 | 2 | 4 | 2 | 2 |
| wear reports undone | 2 | 2 | 2 | 2 | 1 |
| wear reports with a second pair of socks used | 1 | 2 | 1 | 1 | 1 |
| weekly laundry baselines the ledger has applied | 4 | 4 | 4 | 4 | 4 |
| worn: as chosen | 7 | 9 | 13 | 14 | 13 |
| worn: one piece differs | 7 | 5 | 4 | 2 | 1 |
| worn: something else | 5 | 6 | 5 | 4 | 6 |

## Invariant checks

Passed / failed / not applicable, per check and seed. Every check listed under "after every step" in the README ran after each step.

| Check | Seed 1 | Seed 2 | Seed 3 | Seed 4 | Seed 5 |
| --- | --- | --- | --- | --- | --- |
| `amend.replaces_only_what_it_corrects` | 1 / 0 / 1 | 1 / 0 / 1 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `ask.returns_a_durable_run` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `ask.same_turn_id_is_the_same_turn` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `availability.clean_by_inference_is_not_called_observed` | - | - | 1 / 0 / 0 | - | 1 / 0 / 0 |
| `availability.hard_exclusion_states_a_hard_reason` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `availability.parameters_are_stated_as_hypotheses` | 3 / 0 / 0 | 1 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 | 2 / 0 / 0 |
| `availability.probabilities_in_range` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `availability.uncertainty_alone_never_excludes` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `availability.what_came_back_is_available_again` | 6 / 0 / 0 | 6 / 0 / 0 | 6 / 0 / 0 | 6 / 0 / 0 | 6 / 0 / 0 |
| `availability.what_the_owner_made_unavailable_is_excluded_at_once` | 8 / 0 / 0 | 8 / 0 / 0 | 8 / 0 / 0 | 8 / 0 / 0 | 8 / 0 / 0 |
| `availability.what_the_owner_made_unavailable_stays_unavailable` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `board.limited_when_the_forecast_is_not_fresh` | 22 / 0 / 0 | 23 / 0 / 0 | 22 / 0 / 0 | 23 / 0 / 0 | 23 / 0 / 0 |
| `board.offers_at_least_one_option_or_says_why` | 22 / 0 / 0 | 23 / 0 / 0 | 22 / 0 / 0 | 23 / 0 / 0 | 23 / 0 / 0 |
| `board.options_are_distinct` | 405 / 0 / 0 | 419 / 0 / 0 | 399 / 0 / 0 | 413 / 0 / 0 | 419 / 0 / 0 |
| `board.prepared_for_the_morning` | 22 / 0 / 0 | 23 / 0 / 0 | 22 / 0 / 0 | 23 / 0 / 0 | 23 / 0 / 0 |
| `board.prepared_the_evening_before` | 22 / 0 / 0 | 23 / 0 / 0 | 21 / 0 / 0 | 23 / 0 / 0 | 22 / 0 / 0 |
| `board.revision_never_goes_back` | 514 / 0 / 0 | 547 / 0 / 0 | 521 / 0 / 0 | 534 / 0 / 0 | 541 / 0 / 0 |
| `board.selection_is_one_of_its_options` | 405 / 0 / 0 | 419 / 0 / 0 | 399 / 0 / 0 | 413 / 0 / 0 | 419 / 0 / 0 |
| `calendar.a_healthy_calendar_projection_does_not_fail` | 405 / 0 / 0 | 419 / 0 / 0 | 399 / 0 / 0 | 413 / 0 / 0 | 419 / 0 / 0 |
| `calendar.event_identity_is_stable` | 300 / 0 / 0 | 310 / 0 / 0 | 294 / 0 / 0 | 302 / 0 / 0 | 310 / 0 / 0 |
| `calendar.event_revision_not_ahead_of_board` | 300 / 0 / 0 | 310 / 0 / 0 | 294 / 0 / 0 | 302 / 0 / 0 | 310 / 0 / 0 |
| `calendar.no_outfit_entry_for_a_paused_day` | 34 / 0 / 0 | 26 / 0 / 0 | 35 / 0 / 0 | 28 / 0 / 0 | 24 / 0 / 0 |
| `calendar.no_outfit_entry_projected_for_a_paused_day` | 34 / 0 / 0 | 26 / 0 / 0 | 35 / 0 / 0 | 28 / 0 / 0 | 24 / 0 / 0 |
| `calendar.one_managed_event_per_day` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `calendar.outfits_reach_the_calendar` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `calendar.projected_revision_is_the_event_s` | 271 / 0 / 0 | 284 / 0 / 0 | 284 / 0 / 0 | 279 / 0 / 0 | 274 / 0 / 0 |
| `calendar.replacement_names_the_version_it_replaces` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `calendar.revision_never_goes_back` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `choice.accepted_on_the_published_board` | 27 / 0 / 0 | 30 / 0 / 0 | 33 / 0 / 0 | 31 / 0 / 0 | 25 / 0 / 0 |
| `choice.is_an_intention_not_a_wear` | 14 / 0 / 0 | 13 / 0 / 0 | 14 / 0 / 0 | 19 / 0 / 0 | 17 / 0 / 0 |
| `choice.is_shown_on_the_board` | 27 / 0 / 0 | 30 / 0 / 0 | 33 / 0 / 0 | 31 / 0 / 0 | 25 / 0 / 0 |
| `choice.runs_without_a_tap` | 27 / 0 / 0 | 30 / 0 / 0 | 33 / 0 / 0 | 31 / 0 / 0 | 25 / 0 / 0 |
| `circumstance.day_brief_recorded` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `command.accepted` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `contract.a_change_the_owner_asks_for_applies_at_once` | 120 / 0 / 0 | 124 / 0 / 0 | 130 / 0 / 0 | 121 / 0 / 0 | 121 / 0 / 0 |
| `contract.a_connected_assistant_cannot_lift_a_restriction` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `contract.a_wear_report_on_a_restricted_piece_is_on_the_record` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `contract.a_wear_report_on_a_restricted_piece_is_recorded_at_once` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `contract.receipt_states_whether_undo_is_available` | 120 / 0 / 0 | 124 / 0 / 0 | 130 / 0 / 0 | 121 / 0 / 0 | 121 / 0 / 0 |
| `contract.undo_takes_the_report_back` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `feedback.optional_note_recorded` | 3 / 0 / 0 | 1 / 0 / 0 | 3 / 0 / 0 | 1 / 0 / 0 | 4 / 0 / 0 |
| `import.every_garment_present` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `import.no_invented_wear_history` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `invariants.state_could_be_read_after_the_step` | 351 / 0 / 0 | 354 / 0 / 0 | 350 / 0 / 0 | 350 / 0 / 0 | 355 / 0 / 0 |
| `inventory.availability_view_matches_the_snapshot` | 3 / 0 / 0 | 1 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 | 2 / 0 / 0 |
| `inventory.command_types_mark_only_section_3_as_waiting` | 2 / 0 / 0 | 5 / 0 / 0 | 4 / 0 / 0 | 6 / 0 / 0 | 1 / 0 / 0 |
| `inventory.day_record_is_what_was_reported` | 3 / 0 / 0 | 2 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 | 3 / 0 / 0 |
| `inventory.item_matches_the_snapshot` | 1 / 0 / 0 | 5 / 0 / 0 | 3 / 0 / 0 | 1 / 0 / 0 | 6 / 0 / 0 |
| `inventory.pages_reach_everything_exactly_once` | 4 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `inventory.resolve_finds_a_garment_by_its_own_name` | 1 / 0 / 0 | 3 / 0 / 0 | 6 / 0 / 0 | 3 / 0 / 0 | 1 / 0 / 0 |
| `inventory.selection_counts_what_it_lists` | 6 / 0 / 0 | 4 / 0 / 0 | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `inventory.snapshot_is_complete` | 354 / 0 / 0 | 358 / 0 / 0 | 353 / 0 / 0 | 352 / 0 / 0 | 359 / 0 / 0 |
| `inventory.style_is_the_owner_s_profile` | 6 / 0 / 0 | 1 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 | 2 / 0 / 0 |
| `inventory.trips_show_the_simulated_trip` | - | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 2 / 0 / 0 |
| `inventory.view_describes_itself` | 42 / 0 / 0 | 42 / 0 / 0 | 42 / 0 / 0 | 42 / 0 / 0 | 42 / 0 / 0 |
| `isolation.first_owner_does_not_see_the_second_s` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `isolation.second_owner_cannot_read_a_garment_of_the_first` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `isolation.second_owner_cannot_read_a_run_of_the_first` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `isolation.second_owner_cannot_report_on_a_garment_of_the_first` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `isolation.second_owner_does_not_get_the_first_owner_s_board` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `isolation.second_owner_sees_no_receipt_of_the_first` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `isolation.second_owner_sees_only_its_own_garments` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `isolation.two_distinct_owners` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `laundry.a_late_piece_moves_exactly_one_unit_home` | - | 1 / 0 / 0 | - | - | - |
| `laundry.a_missed_bag_comes_back_when_the_owner_says_so` | 1 / 0 / 0 | - | 1 / 0 / 0 | - | 1 / 0 / 0 |
| `laundry.a_piece_still_away_is_not_offered` | - | 2 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `laundry.a_piece_that_came_back_late_is_available_again` | - | 1 / 0 / 0 | - | - | - |
| `laundry.a_return_with_a_missing_piece_applies_at_once` | - | 2 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `laundry.exception_recorded` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 2 / 0 / 0 |
| `laundry.hand_wash_brings_back_exactly_the_washed_units` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 | 2 / 0 / 0 |
| `laundry.hand_wash_returns_only_when_the_owner_says_washed` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 | 2 / 0 / 1 |
| `laundry.pickup_moves_exactly_the_waiting_units` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 2 / 0 / 0 | 3 / 0 / 0 |
| `laundry.pickup_runs_without_a_tap` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 2 / 0 / 0 | 3 / 0 / 0 |
| `laundry.pickup_takes_what_was_waiting` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 2 / 0 / 0 | 3 / 0 / 0 |
| `laundry.return_brings_back_the_bag_and_only_the_bag` | 1 / 0 / 0 | 3 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `laundry.return_moves_exactly_the_returned_units` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 2 / 0 / 0 | 3 / 0 / 0 |
| `laundry.return_runs_without_a_tap` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `laundry.the_weekly_baseline_does_not_bring_back_a_missed_bag` | 1 / 0 / 0 | - | 1 / 0 / 0 | - | 1 / 0 / 0 |
| `laundry.what_is_at_the_service_is_not_offered` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 2 / 0 / 0 | 3 / 0 / 0 |
| `mcp.read_only_connection_cannot_write` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `mcp.read_only_connection_is_not_offered_the_write_tool` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `mcp.read_only_write_is_denied_for_scope` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `mcp.resource_readable` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `mcp.resources_listed` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `mcp.write_connection_offers_all_seven_tools` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `observation.a_wash_report_runs_without_a_tap` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `observation.the_owner_s_count_is_what_the_ledger_then_says` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `observation.what_the_owner_says_is_dirty_is_dirty` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `owner_text.no_internal_codes` | 460 / 0 / 0 | 469 / 0 / 0 | 446 / 0 / 0 | 465 / 0 / 0 | 476 / 0 / 0 |
| `pause.nothing_prepared_until_the_owner_resumes` | - | - | 1 / 0 / 0 | - | 1 / 0 / 0 |
| `pause.nothing_published_for_a_paused_day` | 54 / 0 / 0 | 37 / 0 / 0 | 56 / 0 / 0 | 40 / 0 / 0 | 33 / 0 / 0 |
| `pause.recorded` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `pause.resume_recorded` | - | - | 1 / 0 / 0 | - | 1 / 0 / 0 |
| `pause.today_is_no_longer_paused_after_the_resume` | - | - | 1 / 0 / 0 | - | 1 / 0 / 0 |
| `pause.today_says_paused` | 30 / 0 / 0 | 22 / 0 / 0 | 31 / 0 / 0 | 23 / 0 / 0 | 20 / 0 / 0 |
| `purchase.an_order_is_not_an_arrival` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `purchase.arrival_is_the_owner_s_observation` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `receipt.an_accepted_command_returns_one` | 120 / 0 / 0 | 124 / 0 / 0 | 130 / 0 / 0 | 121 / 0 / 0 | 121 / 0 / 0 |
| `receipt.idempotent_repeat` | 116 / 0 / 0 | 120 / 0 / 0 | 126 / 0 / 0 | 117 / 0 / 0 | 117 / 0 / 0 |
| `receipt.key_reuse_refused` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `receipt.key_reuse_runs_nothing` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `receipt.names_who_acted` | 116 / 0 / 0 | 120 / 0 / 0 | 126 / 0 / 0 | 117 / 0 / 0 | 117 / 0 / 0 |
| `receipt.reads_back_as_returned` | 116 / 0 / 0 | 120 / 0 / 0 | 126 / 0 / 0 | 117 / 0 / 0 | 117 / 0 / 0 |
| `receipt.repeat_writes_nothing` | 116 / 0 / 0 | 120 / 0 / 0 | 126 / 0 / 0 | 117 / 0 / 0 | 117 / 0 / 0 |
| `receipt.revision_not_ahead_of_ledger` | 116 / 0 / 0 | 120 / 0 / 0 | 126 / 0 / 0 | 117 / 0 / 0 | 117 / 0 / 0 |
| `receipt.well_formed` | 116 / 0 / 0 | 120 / 0 / 0 | 126 / 0 / 0 | 117 / 0 / 0 | 117 / 0 / 0 |
| `recommend.answers` | 4 / 0 / 0 | 10 / 0 / 0 | 6 / 0 / 0 | 3 / 0 / 0 | 6 / 0 / 0 |
| `recommend.no_more_than_asked` | 4 / 0 / 0 | 10 / 0 / 0 | 6 / 0 / 0 | 3 / 0 / 0 | 6 / 0 / 0 |
| `recommend.publishes_nothing` | 4 / 0 / 0 | 10 / 0 / 0 | 6 / 0 / 0 | 3 / 0 / 0 | 6 / 0 / 0 |
| `recommend.same_request_same_answer` | 4 / 0 / 0 | 10 / 0 / 0 | 6 / 0 / 0 | 3 / 0 / 0 | 6 / 0 / 0 |
| `recommend.says_so_when_it_has_too_few` | 4 / 0 / 0 | 10 / 0 / 0 | 6 / 0 / 0 | 3 / 0 / 0 | 6 / 0 / 0 |
| `recommended.complete_outfit` | 344 / 0 / 0 | 349 / 0 / 0 | 320 / 0 / 0 | 348 / 0 / 0 | 359 / 0 / 0 |
| `recommended.garments_exist_under_their_names` | 344 / 0 / 0 | 349 / 0 / 0 | 320 / 0 / 0 | 348 / 0 / 0 | 359 / 0 / 0 |
| `recommended.not_hard_excluded` | 344 / 0 / 0 | 349 / 0 / 0 | 320 / 0 / 0 | 348 / 0 / 0 | 359 / 0 / 0 |
| `recommended.not_made_unavailable_by_owner` | 344 / 0 / 0 | 349 / 0 / 0 | 320 / 0 / 0 | 348 / 0 / 0 | 359 / 0 / 0 |
| `recommended.not_restricted` | 344 / 0 / 0 | 349 / 0 / 0 | 320 / 0 / 0 | 348 / 0 / 0 | 359 / 0 / 0 |
| `recommended.offered_role_is_the_garment_s_own` | 344 / 0 / 0 | 349 / 0 / 0 | 320 / 0 / 0 | 348 / 0 / 0 | 359 / 0 / 0 |
| `recommended.owned` | 344 / 0 / 0 | 349 / 0 / 0 | 320 / 0 / 0 | 348 / 0 / 0 | 359 / 0 / 0 |
| `recommended.profile_hard_constraints` | 344 / 0 / 0 | 349 / 0 / 0 | 320 / 0 / 0 | 348 / 0 / 0 | 359 / 0 / 0 |
| `recommended.trip_day_uses_packed_pieces_only` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `repair.changes_only_what_it_must` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `repair.keeps_the_chosen_outfit` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `repair.makes_a_new_board_revision` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `repair.planned_piece_made_unavailable_is_replaced` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `repair.replacement_is_wearable_in_the_removed_role` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `research.returns_a_durable_run` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `restriction.connected_assistant_cannot_lift` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `restriction.from_the_profile_is_never_lifted` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `restriction.profile_restriction_in_force_at_start` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `restriction.still_in_force_after_a_report_naming_the_piece` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `return.an_exchange_never_duplicates_ownership` | 1 / 0 / 0 | 1 / 0 / 0 | - | 1 / 0 / 0 | - |
| `return.bookkeeping_moves_no_stock` | 6 / 0 / 0 | 6 / 0 / 0 | 4 / 0 / 0 | 6 / 0 / 0 | 4 / 0 / 0 |
| `return.deadline_comes_from_sourced_terms_and_the_real_delivery` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `return.departure_changes_only_the_departed_piece` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `return.departure_is_shown_on_the_case` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `return.opening_a_return_removes_no_stock` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `return.refund_is_what_was_received` | - | - | 1 / 0 / 0 | - | 1 / 0 / 0 |
| `return.step_recorded` | 4 / 0 / 0 | 4 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 | 3 / 0 / 0 |
| `return.stock_leaves_only_on_physical_departure` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `run.a_failed_run_changes_nothing` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `run.a_failure_is_reported_as_a_failure` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `run.answer_to_a_question_nobody_asked_is_refused` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `run.cancel_answers_with_the_run` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `run.nothing_changes_without_a_receipt` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `run.readable_by_its_id` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `run.resume_answers_with_the_run_or_a_typed_refusal` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `run.settles_within_the_polling_budget` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `run.state_is_a_known_state` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 |
| `run.unknown_run_is_not_found` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 |
| `step.ran_to_its_end` | 351 / 0 / 0 | 354 / 0 / 0 | 350 / 0 / 0 | 350 / 0 / 0 | 355 / 0 / 0 |
| `swap.a_swap_and_its_undo_ran_this_run` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `swap.accepted` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.changes_the_slot` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.keeps_the_choice` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.makes_a_new_board_revision` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.receipt_names_the_new_revision` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.receipt_offers_an_undo` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.replacement_is_a_garment_of_that_role` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.runs_without_a_tap` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.undo_keeps_the_choice` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.undo_makes_the_next_revision` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.undo_receipt_names_the_board` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `swap.undo_restores_the_board` | 2 / 0 / 2 | 3 / 0 / 1 | 3 / 0 / 1 | 3 / 0 / 1 | 4 / 0 / 0 |
| `swap.undo_runs_without_a_tap` | 2 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 4 / 0 / 0 |
| `trip.a_trip_day_is_answered_from_the_suitcase` | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| `trip.packed_is_what_the_suitcase_holds` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.packing_runs_without_a_tap` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.planned_trip_is_listed` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.proposal_covers_every_day_of_the_trip` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.proposal_fits_the_luggage` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.proposal_offers_only_wearable_pieces` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.proposed_is_not_packed` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.unpacked_garments_are_still_in_the_wardrobe` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.unpacked_is_not_clean` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.unpacked_units_come_home_to_the_expected_bucket` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.unpacking_conserves_owned_units` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.unpacking_empties_the_suitcase` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.unpacking_moves_only_the_suitcase` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `trip.what_is_in_the_suitcase_is_not_offered_at_home` | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 | 1 / 0 / 0 |
| `undo.an_undone_report_is_no_longer_counted` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 1 / 0 / 1 |
| `undo.cannot_be_done_twice` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 1 / 0 / 0 |
| `undo.keeps_what_another_report_still_supports` | 0 / 0 / 2 | 0 / 0 / 2 | 0 / 0 / 2 | 0 / 0 / 2 | 0 / 0 / 1 |
| `undo.of_a_report_runs_without_a_tap` | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 2 / 0 / 0 | 1 / 0 / 0 |
| `wear.count_per_garment_matches_reported_days` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `wear.duplicate_report_is_not_a_new_wear` | 11 / 0 / 0 | 8 / 0 / 0 | 10 / 0 / 0 | 5 / 0 / 0 | 7 / 0 / 0 |
| `wear.every_report_is_counted` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `wear.nothing_invented` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `wear.one_counted_wear_per_garment_and_day` | 352 / 0 / 0 | 355 / 0 / 0 | 351 / 0 / 0 | 351 / 0 / 0 | 356 / 0 / 0 |
| `wear.report_accepted` | 19 / 0 / 0 | 20 / 0 / 0 | 22 / 0 / 0 | 20 / 0 / 0 | 20 / 0 / 0 |
| `wear.report_runs_without_a_tap` | 19 / 0 / 0 | 20 / 0 / 0 | 22 / 0 / 0 | 20 / 0 / 0 | 20 / 0 / 0 |

## Failed checks

None.

