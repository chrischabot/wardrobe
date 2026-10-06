# Coverage gaps: iOS client

Audited at `garderobe-rebuild` commit `8445a1e`, by reading code and tests; no Swift test, UI test or cited workflow run was executed or re-checked. "spec" is `requirements/garderobe-replacement-design.md`. Paths beginning `Screens/` are under `ios/App/Garderobe/`; `Tests/` is `ios/GarderobeKit/Tests/GarderobeKitTests/`. Per-row verdicts are in `../rows/E-ios-media.md` unless another part letter is given.

What holds: the app sends typed commands to `POST /v1/commands` with channel `ios`, an idempotency key and the time of the tap, and replays a byte-identical body after an offline period (`Tests/CommandCenterTests.swift:42-92`). Screens and models exist for trips and packing, returns and exchanges, optional feedback, pause and resume, recovery and export with Swift package tests (`Tests/OwnerJourneys.swift:113-121,188-224,361`; `Tests/BoundaryTests.swift:221-252`); no UI test opens any of them.

## Rows whose status overstates what exists

| Row | Source | What is missing or weaker | Evidence | Closes when |
| --- | --- | --- | --- | --- |
| S03-007 | spec L64 | Pull-to-refresh has no visible alternative control on Today, Wardrobe, Studio or the Laundry sheet. | `Screens/Today/TodayScreen.swift:27,100`; `Screens/Wardrobe/WardrobeScreen.swift:27`; `Screens/Studio/StudioScreen.swift:46`; `Screens/Laundry/LaundrySheet.swift:28` | Each has a visible refresh control. |
| S03-003 | spec L60 | Projects and research cannot be reached from a garment; no saved list of investigations; `projects(forGarment:)` is never called from `ios/App`. | | The item page links to its projects and research. |
| S03-025 | spec L78 | None of the six Wardrobe filters has a Swift test; the only filter use in tests is `filters.search`. | `Tests/OwnerJourneys.swift:28` | Each filter has a test. |
| S03-045 | spec L90 | The receipt card's external-effect wording is untested (every scripted receipt uses `externalEffectState: "none"`); no correction control beyond Undo. | `Tests/TestSupport.swift:60-64` | Tests cover pending and failed external effects. |
| S11-025 | spec L716 | Today's outfit image is a tile grid, not the composition manifest. | `Screens/Today/OutfitComposition.swift:45-57` | Today renders the manifest. |
| S11-028, S11-034 | spec L718, L726 | No screen shows a wear photograph beside the composition; no screen offers the selfie retention setting. | search of `ios/App` for "selfie" | Screens exist, or rows become partial. |
| S06-081 | spec L377 | No screen shows remembered conclusions. | (C) | A screen and route exist. |
| S09-010 | spec L530 | The cited `ios/Tools/check-app-sources.py` has no rule about timers or background tasks. | (B) | The check has the rule, or the row cites other evidence. |
| S04-017 | spec L188 | "Stop and send" has no test. | `ComposerModel.swift:250` (D) | A test covers it. |
| S12-021, S10-040, S14-060 | spec L753, L610, L969 | `routingLines` and `budgetLines` are referenced by no test. | `SettingsModel.swift:403-413` (C, F) | Tests cover both. |
| R55 | research L342 | No Swift test covers `TemperaturePreviewModel`. | (G) | A test exists. |
| S13-022 | spec L816 | Tolerance of unknown events is tested, but no test shows the app using the API schema version; its only use is a request header. | `ios/GarderobeKit/Sources/GarderobeKit/Networking/APIClient.swift:51`; `Tests/ConversationTests.swift:12-33` (D) | A Swift test asserts version-dependent behaviour, or the clause is dropped from the row. |
| S13-047 | spec L853 | The cited Swift test covers the proposals list; the Connected assistants list has no Swift test (no match for `activeGrants` or `grantLine` in the tests). | `Tests/ProposalTests.swift:11-48` (D) | A Swift test of the grants list and disconnect. |

## Honest partial or blocked rows that still need work

- **S03-082** (spec L128, blocked): no device run of any kind. `ios/README.md:171-182` states no device run, no VoiceOver session, no real sign-in, no Keychain use, no universal link, no request from Swift to a running backend, no signed or installed build. Also S16-005, S17-045, S17-065, S13-027, S14-062, S18-008, S18-016, S18-021, S20-010, S20-015, S20-018, R30, R56, KO-023, KO-036.
- **Views with no automated test of any kind:** S03-004 to S03-006, S03-010, S03-011, S03-028, S03-032, S03-063, S03-064, S03-069 to S03-071, S03-074, S03-076 to S03-078, S03-081, S03-083, S03-084.
- **Model logic tested, screen not inspected on a device:** S03-008, S03-009, S03-013, S03-014, S03-016, S03-024, S03-026, S03-027, S03-029 to S03-031, S03-033 to S03-036, S03-042, S03-046, S03-049, S03-050, S03-052, S03-053, S03-055, S03-057, S03-065 to S03-068, S03-073, S03-075, S03-079, S03-080, S03-085, S01-002, S01-017, S01-020, S02-015, S07-029, S09-031, S09-033, S05-029, S08-016, PR-064.
- **Specific missing pieces in those rows:** S03-027 no supporting photographs on the item page; S03-029 Back from the tailor and Arrived never performed in a test; S03-036 no quantity control for Socks washed; S03-055 dictation not exercised; S03-065 no drag interaction; S03-068 no product image on the research card; S03-073 navigation-path restoration untested; S03-010 a 24-point minimum frame at `Screens/Today/ComparisonList.swift:108`; `ios/README.md:234` says a day record can have garments removed but not replaced in place (S03-020).
- **Sign-in and connections:** S15-006, S15-007 (`ASWebAuthenticationSession`, universal-link callback, Keychain not run; tested against a stand-in transport, `Tests/BoundaryTests.swift:104-199`); S15-024 (no test drives `SettingsModel` connection functions); S15-034, S13-047 (`RecoveryStatusModel` at `AccountModel.swift:293` has no test); S09-021 (`AppModel.open(url:)` has no test).
- **Accessibility:** S03-008, S17-019, S19-004: the audit covers four tab destinations, excludes system-drawn findings and records an intermittent contrast failure as expected (`GarderobeUITests.swift:296-314`); no person has checked VoiceOver, Dynamic Type, Reduce Motion, Increase Contrast or Reduce Transparency.
- **Conventions:** S19-002 to S19-004: `ios/App/CONVENTIONS.md` names none of the three skills.
- **Build inputs:** the hosted runner has no iOS 27 SDK so the committed 27.0 target has never been built (`ios/README.md:131-133,212`); signing, team, associated domain, OAuth client, push key and app icon are still to be supplied (`ios/README.md:186-190`).

## Documentation and test claims to correct

- `ios/README.md:230-232` says Notifications, Requests to confirm, My style, Trips and Returns "are opened by other UI tests"; no test in `ios/App/GarderobeUITests/GarderobeUITests.swift` opens any of them (`:223-235` only checks that some Settings rows exist).
- The UI test file holds 20 test methods at this commit while `ios/README.md:145-147` reports 21 run.
- Cited simulator results are from workflow run 36861072431 at commit `be6f3494` (`ios/README.md:142`), not the audited commit.
- `ios/Tools/check-app-sources.py:73-74` checks for "streak" but not scores (S03-011).
- UI tests run in demo mode on one recording with no garment photographs (`ios/README.md:104-107,177-178`).
