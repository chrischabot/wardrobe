# Garderobe iOS app

Native SwiftUI app for iOS 27 (spec section 3). It is a client of the Garderobe HTTP API (`/v1/*`, spec section 13) and the shared contracts in `garderobe/packages/contracts`. It contains **no recommendation engine**: boards, validation, swap candidates and Studio suggestions come from the backend. The phone only lays out and positions cached garments.

## Build and test

```sh
# Everything that runs without Xcode (Linux or macOS): Swift 6.2+ on PATH, Node 22, `npm install` done in garderobe/
garderobe/ios/scripts/check.sh
```

`check.sh` runs six steps:

1. Typecheck the fixture generator (`tsc -p ios/tsconfig.json`).
2. Verify the fixtures are fresh against the owner's CSV, profile and contracts (`fixtures.ts verify`).
3. `swift build`.
4. `swift test`: unit, journey and adversarial tests against the in-memory fixture backend.
5. Validate every Swift-encoded command envelope, request body and receipt against the real zod schemas (`fixtures.ts check`).
6. `swiftc -parse` the SwiftUI, app and UI-test sources.

On a Mac with Xcode and the iOS 27 SDK:

```sh
cd garderobe/ios
open Garderobe.xcodeproj            # scheme "Garderobe"; Run launches demo mode (-GarderobeDemo)
xcodebuild test -project Garderobe.xcodeproj -scheme Garderobe -destination 'platform=iOS Simulator,name=iPhone 17'
```

The scheme's test action runs the `GarderobeKitTests` package tests and the `GarderobeUITests` XCUITest journeys. `Garderobe.xcodeproj` is generated from `project.yml` by XcodeGen 2.46.0 (`xcodegen generate --spec project.yml`); regenerate it after editing `project.yml`. Signing is left unset (`DEVELOPMENT_TEAM` empty) for the owner's own Apple developer account.

**Demo vs live.** With `GARDEROBE_API_BASE_URL` empty (the default build setting), or with the launch argument `-GarderobeDemo`, the app runs on the bundled fixtures and shows a **Demo data** badge. Set `GARDEROBE_API_BASE_URL` to the deployed Worker URL to use the real API. Sign-in then uses the backend's secretless native client (`garderobe-ios`): `ASWebAuthenticationSession` opens `GET /v1/auth/native/authorize` with a PKCE S256 challenge, `state` and `resource=<origin>/v1`. Cloudflare Access signs the owner in with Google. The app accepts the `garderobe://auth/callback` redirect only when the redirect, `state` and `iss` match, then exchanges the code (form-encoded, no secret) at `POST /v1/auth/native/token`. The 15-minute access token and the rotating refresh token live in the Keychain (this device only). Refreshes are coalesced, a 401 triggers one refresh and one retry, and Sign out revokes at `POST /v1/auth/native/revoke`. UI-test launch arguments: `-GarderobeResetState` clears the on-device cache, `-GarderobeStartOffline` makes the demo backend unreachable, and `-GarderobeTripDay` makes it serve the DEMO trip-day board (a packed trip covers the date). The app also opens `garderobe://confirm/{runId}` (and accepts a pasted `<API origin>/confirm/{runId}` link) to confirm an assistant's account request.

## Structure

| Path | Contents |
| --- | --- |
| `Package.swift` | Swift package (tools 6.2, platforms iOS 27 / macOS 27) with products `GarderobeKit` and `GarderobeUI` |
| `Sources/GarderobeKit/Contracts` | Swift models of the shipped `packages/contracts` shapes (tolerant decoding: open enums, defaulted optionals, per-option decoding); `ApiModels.swift` holds the `/v1` request and response shapes |
| `Sources/GarderobeKit/Networking` | `HTTPTransport`, `APIClient` (every endpoint the app uses, with one refresh and retry on 401), `NativeAuth` (PKCE sign-in, token refresh and revocation), `SSEParser`, `URLSessionTransport` |
| `Sources/GarderobeKit/Persistence` | `ClientStore`: a file-per-key JSON cache (board snapshot, wardrobe, drafts, pending commands and turns, receipts, restoration state) |
| `Sources/GarderobeKit/Commands` | `CommandQueue` (offline queue, stable idempotency keys, ordered delivery, retry with backoff) and `ReceiptCenter` (receipts, 8-second Undo banner, undo as a compensating command) |
| `Sources/GarderobeKit/Presentation` | `BoardLayout` (profile section 11 card), `DayLine`, `GarmentSearch` (aliases, maker names, codes), quantity, freshness and VoiceOver text |
| `Sources/GarderobeKit/ViewModels` | `AppModel`, `TodayViewModel`, `WardrobeViewModel`, `ItemDetailViewModel`, `StudioViewModel`, `ConversationViewModel`, `CaptureViewModel`, `LaundryViewModel`, `SettingsViewModel`, `MyStyleViewModel` |
| `Sources/GarderobeKit/Fixtures` | `FixtureServer`: an in-memory backend over the bundled fixtures, used by the tests, the previews, the UI tests and demo mode |
| `Sources/GarderobeKit/Resources/Fixtures` | Generated JSON/SSE fixtures (see below) |
| `Sources/GarderobeUI` | SwiftUI screens (`#if os(iOS)`; empty on other platforms) |
| `App/` | `@main` app, `Info.plist`, asset catalog (single accent colour) |
| `UITests/` | XCUITest journeys |
| `Tests/GarderobeKitTests` | Swift Testing suites |
| `scripts/fixtures.ts`, `scripts/check.sh` | Fixture generator/verifier/contract checker, and the one-shot check |
| `project.yml`, `Garderobe.xcodeproj` | XcodeGen spec and the generated project |

## Screens and flows

**Navigation.** A standard `TabView` has four destinations: **Today**, **Wardrobe**, **Studio** and **Conversation**. Every tab's toolbar has a Capture menu (**Add an item**, **Identify this**, **What I wore**) and the account control, which opens Settings. Today and Wardrobe also carry a **Laundry** button. Liquid Glass appears only on controls (`controlSurface`, `.glassProminent`, the system bars). Content surfaces are opaque with a subtle border, and garment images sit on a white canvas with a restrained outline, which stays white in dark mode. When transparency is reduced or contrast increased, the glass becomes an opaque, outlined surface. Reduce Motion removes positional effects. Interactive areas are at least 44 × 44 pt. Every swipe has a visible control: carousel previous/next, Studio previous/next, and adjustable VoiceOver actions on the Studio selectors.

**Today.**
- The cached board appears immediately (no entrance animation), then refreshes.
- On a trip day (Today's `purpose` is `trip:<tripId>`, served when a packed trip covers the date) a line such as "Trip day · Paris long weekend · day 2 of 4" leads the header, with a suitcase symbol. The board is composed from the suitcase and otherwise works like any board. Without a trip summary it still says "Trip day".
- The day line leads, then the weather, then an honest freshness line: "Checked 06:52", "Last checked …" or "Offline · last checked …". The weather shows door and peak temperature, rain chance with its start time and amount, and wind with gusts. Any value the forecast lacks reads "unknown" and is never guessed. A stale or missing forecast says so. The freshness line never says fresh when it isn't. A failed calendar connection is only a quiet note.
- There is a carousel with visible previous/next controls, and a **Compare** list for scanning.
- Each card follows the owner's profile, section 11: the why-it-works sentence first, then Jacket, Shirt (or Jumper), Trousers, Belt with its optional flourish (scarf or tie), and Socks with shoes, with generous whitespace.
- Line headings are the board document's `lines[].label` exactly as the server published it. The backend clears registered item codes from them, so "Socks & shoes" shows as given. After a morning swap the line text is the app's own, but a heading stays the server's wherever the swap left its kind unchanged. The app's own heading appears only when the server's line has none, the swap changed the kind of heading, or the board has no document; a line without a label is kept, not dropped.
- When an option has two shoes, you pick one in the card ("decide at the door"). The composition then shows only that shoe, and **Choose** or **I wore this** asks for the shoe first. A wear never logs both.
- **Choose** records an intention (select_option). **I wore this** records the actual outfit, including morning swaps (record_wear).
- **Swap** offers backend-validated candidates for one piece (`SwapCandidates`). Offline, it offers "last seen available; not checked" pieces.
- **Ask about this** attaches the option's identity (board, option, revision) and opens Conversation.
- Once a wear exists, it becomes "Today's record", or "Recorded on this phone" while it waits to sync.
- Offline commands show as "Saved on this phone · will send when online" with Retry. A second tap never submits a second observation.

**Wardrobe.**
- A category-sectioned grid becomes a readable list at accessibility text sizes.
- Search accepts perceptible names, owner aliases, maker names and codes ("PCF4340", "the wide stripe", "cafe reims").
- Filters cover availability (available, not available now, in the wash or worn, packed for a trip, incoming, retired), category, colour, season, location and last recorded wear ("No recorded wear", never "unworn").
- Availability labels come from the server and are shown verbatim with a matching symbol, including "In the wash", "At the laundry", "Worn, not washed yet" and "Packed for a trip". On the item page these states get a short explanation, and laundry states offer **Open Laundry**. **In the wash** is not offered for a piece already in the wash, at the laundry or in a suitcase, and **Put into storage** is not offered for a packed piece. An unknown future label is shown as it is and changes nothing else.
- The header counts owned, available, incoming and retired items, and flags a partial list.
- Socks are one entry with quantities ("4 pairs · 3 clean") and an optional aggregate count correction. No pair numbers anywhere.
- The temperature preview is labelled and worded as a simulation.
- The item page shows the catalogue image (full-screen inspection on white), status, location, quantity, maker terms, fabric, size, season, care, fit note, restrictions, known combinations (the published board options that include it, from `ItemDetail.combinations`), recorded wears and receipts with Undo, plus direct commands shown only when they apply: **In the wash**, **Back from the tailor**, **Arrived**, **Put into storage** and **Take out of storage**. It also has **Ask about this**.

**Studio.**
- A white canvas holds horizontal selectors for outer layer, top, bottom and footwear. Accessories (jumper, socks, belt, scarf or tie) expand on request, and a dress or one-piece layout replaces top and bottom.
- Each selector has visible previous/next buttons, a finger-following swipe that settles back if interrupted, and a lock. A locked piece cannot change, even when you ask for **Find something that works with this**, which asks the backend to fill only the unlocked roles.
- **For today** offers only owned, available, non-benched pieces. **Explore** adds stored and incoming pieces with badges.
- Swipes are local and synchronous. Backend validation runs 350 ms after the last change, and a newer change discards an older result.
- **Save combination**, **Plan for a day** and **Wear this** issue three distinct commands (`save_combination`, `plan_outfit`, `record_wear`): only Wear this records a wear, and it asks for confirmation. A plan is validated by the server for its day, and a refusal shows the server's reason. After a save, **Remove saved combination** (`remove_combination`) takes it back.
- In Explore, the validation line says when a combination works but "Would not pass as a plan for today", and shows day-bound warnings as "Today: …".

**Conversation.**
- One continuous transcript with date separators ("Today", "Yesterday", "Tuesday 14 July"), "Earlier messages" paging that keeps the reading anchor, and a new-message button when you have scrolled away.
- Messages can hold inline outfit cards (actionable only when validated and tied to a board option), result cards, expandable sources, receipts with Undo, and reference and attachment chips.
- **Search** uses `POST /v1/recall/search` across the whole transcript, not just what is loaded. Each result shows the date, who said it, the quote and its neighbouring messages. It also lists later changes of mind, and notes when the index has not covered everything. Tapping a result loads the page around it (`?around=`) and anchors the transcript there. Offline, the search covers only the messages on the phone and says so.
- The composer is a native multiline field with attachment chips from Ask about this. A chip alone is not a turn; it needs text or a photo (at most 10 attachments). Send while a reply is arriving queues the turn as "Waiting". **Stop and send** sends the new turn first with `stopCurrent: true`, so the server stops the reply (committed effects stay committed), and earlier waiting turns follow. The Stop control shows while replying.
- When the assistant asks a question with a durable pending action (`input_required`), the reply pauses. The choices are answered natively through `POST /v1/runs/{id}/input` (`RunInputRequest`), which resolves the same record an MCP retry would, and the question is restored from `GET /v1/runs/{id}` after relaunch. **Not now** declines (`choiceId: null`): nothing is executed and the reply ends. Answering again replays the original receipt rather than running a second command, and an expired question says so and changes nothing.
- The draft persists. Turns carry stable `clientTurnId`s and stay queued ("Waiting for a connection") until accepted, surviving relaunch.
- **Pasted secrets.** When Garderobe removes a recovery code or another secret from a message before storing it, `TurnResponse.notice` (`secret_removed`) says so. The phone then drops what the owner typed: it shows the canonical, redacted message (`?around=`), or just the placeholder (`[recovery code removed]` / `[secret removed]`) when that can't be fetched. After the reply, a notice ("Recovery code removed from your message") explains what happened. When it was a recovery code, the notice offers **Create a new recovery code**, which opens Settings. The notice names only what was removed, never the secret. The local notice is hidden only when a settled `notice` result card names the same turn in its `jobRef` (`message:<the owner's message id>` or `run:<its run id>`; the run id from the turn response is kept on the phone, so a transcript page without it still matches). A card for another turn never hides it, even though every recovery-code notice has the same title, so each removal keeps its own visible notice. The backend names the turn as `message:<the owner's message id>`, so after a reload the note is shown once, as the backend's card. Older cards that name the internal `turn:<turn id>` can't be tied to a turn, so the local notice stays beside them. Each local notice follows the reply of its own turn (matched by run id), so interleaved turns never put it beside another turn's reply; a turn that ended without an identifiable reply shows its notice straight after the owner's message. A message sent while offline sits in the pending queue on the phone until it is delivered; the server removes the secret on arrival.
- The SSE projection resumes with `Last-Event-ID`, ignores replayed and unknown events, replaces the message from a `snapshot` when the cursor has expired, and reconciles from `GET /v1/runs/{id}` after repeated drops.

**Capture.**
- Three intents, with photos from PhotosPicker or the camera. Each upload keeps its place and retries individually.
- If photo access is denied, the sheet offers "describe it in words" and a link to Settings.
- A photo never authorizes a mutation. What I wore offers "Log it if the match is clear" (`explicitLog: true`) and "Only compare with my wardrobe".

**Laundry sheet.** Service laundry and hand wash appear separately. **Collected** snapshots the hamper. **Returned** and **Some items still away** start from the batch's actual membership, with toggles or steppers bounded by what went out. **Socks washed** has a per-sock selection. Open exceptions reported by the server (`LaundryState.openExceptions`) appear under **Still away**. Every action returns a receipt and refreshes availability.

**Settings (account control).**
- **My style** shows the owner's full profile text, verbatim, with its version line ("Version 1 · written 14 September 2026 · as you supplied it · 14,960 bytes"). A SHA-256 check confirms the text matches its recorded hash. It also shows the rule count, a section index, and editing of the full text with an optional amendment note. Saving uses `edit_style_profile` with `baseVersion`; a concurrent edit conflicts and keeps the draft. An unsaved edit survives relaunch.
- **Connected assistants** lists the Claude and ChatGPT MCP grants (`SettingsResponse.connectedAssistants`, `AssistantGrant`). Each shows read-only or read-and-write, when it was last used, and the host its tokens go to. **Disconnect** revokes that grant only (`POST /v1/connections/{mgr_…}/disconnect`).
- **Connections** puts Gmail and Calendar first. A missing permission names the capability it pauses, with a Reconnect action (relative reconnect URLs resolve against the API origin). Owner-added MCP connections show their endpoint and protocol version.
- **Morning delivery** covers the time and 3–5 outfits, and can stop publishing to the calendar. `update_delivery_settings` sends only what changed, with an explicit `null` only to clear the calendar.
- **Receipts** gives persistent access to every receipt.
- **Account** shows the server and who is signed in, with Sign in with Google and Sign out (which revokes the session at the server).
- **Recovery and transfers** shows whether a recovery code exists and when it was issued (`GET /v1/auth/recovery-kit`, never the code), a code waiting to be collected, failed recovery attempts in the last 24 hours, and recent exports, staged imports and recovery links from `GET /v1/account/transfers` (kind, status, whether an assistant asked, when). It also has **Confirm an assistant's request** and **Create a new recovery code** (`POST /v1/auth/recovery-kit`, after a confirmation). The new code replaces the current one and is shown once: privacy-sensitive, not stored, and cleared by **I've saved it** or on leaving Settings.

**Assistant account requests.** Claude or ChatGPT can ask for an export, an import of a staged package, or a new recovery code; nothing happens until the owner confirms. The app confirms in two places. In Conversation, the paused question is answered through `POST /v1/runs/{id}/input`. For a request an assistant made elsewhere, the owner opens `garderobe://confirm/{runId}` or pastes the `<origin>/confirm/{runId}` link the assistant showed, and the app loads the question from `GET /v1/runs/{runId}`. Only links on the app's own API origin are accepted. `RunInputResponse.operation` carries the result, which the app shows in an account sheet:
- **Export** (`ExportDownloadResult`): table counts and completeness, then **Download export**. This opens the signed link with the owner's own session, but only on this API origin and the expected path. The file goes to a temporary location for the share sheet and is deleted when the sheet closes.
- **Import** (`McpImportResult`): records imported, connected assistants restored revoked, no sessions recreated, and the note that the assistant that asked keeps its access. A refusal (for example a Garderobe that already has records) says "Not done" with the server's reason.
- **Recovery code** (`RecoveryKitLink`): **Collect the new recovery code** posts to the one-time collect link and shows the code once. It is privacy-sensitive, copying puts it on the local pasteboard only and expires in two minutes, and **I've saved it** clears it.

Declined and expired requests say that nothing was done, and a repeated confirmation replays the same result. The link, the token, the file and the code are never added to the transcript, written to the client store or logged; the tests check the store for them.

**State restoration.** The tab, the Wardrobe navigation path, the conversation draft, Studio selections and locks, the transcript reading anchor, Today's mode, the shoe per option and morning swaps are all persisted.

## Fixtures (demo data)

`scripts/fixtures.ts generate` builds the fixtures from `garderobe/data`:

- **Wardrobe and items.** The owner's **real** current wardrobe: **144 garments, 161 units**. That is the May 2026 CSV mapped through the backend's own importer (`mapInventory`: 127 garments, 144 units) plus the **17 owner-asserted additions** of 2026-09-29 (`data/owner-asserted-additions-2026-09-29.json`). The additions are parsed and quote-checked by the backend's `parseOwnerAdditions` and built exactly as the seed's `add_item` commands build them: category defaults, one unit each, condition unknown, `ownerAsserted` attribute. Unknown colour, maker and size stay null, and the item page shows them as "Unknown". The NB 990v6 and the Paraboot Norwegian split-toe are restricted by the sneakers-only rule, along with the four CSV welted pieces. `owner-wardrobe.json` records these counts, and `fixtures.ts verify` fails if any addition is missing from `wardrobe.json`.
- **Scenario state.** Wears, the laundry batch, the tailor, storage, the incoming NB 993 and the donation mirror the labelled `demo/src/test-events.ts` (**TEST EVENT**). One extra Monday 5 October wear is a **DEMO** overlay, so both hampers hold something. Availability labels follow the backend's home-availability rules, so per-wear and single-day pieces without a clean unit read "In the wash" (2), "At the laundry" (1) or "Worn, not washed yet" (4).
- **Board.** Five options for Tuesday 6 October 2026 (11° → 17°, dry), written here to follow the profile: sneakers only, socks always, peak-temperature shirts, no navy fallback. The board carries a contract-valid `BoardDocument`, `purpose: "day"` and `trip: null`. It is a **DEMO** board, not the daily service's composition.
- **Trip-day board** (`today-trip.json`). A labelled **DEMO** Paris long weekend (14–17 October 2026) with three options from the suitcase for Thursday 15 October, `purpose: "trip:<tripId>"` and a `TodayTrip` summary. It is not owner data. In trip mode the fixture server serves it and marks the suitcase's garments "Packed for a trip" in the wardrobe, as the backend does.
- **Recovery status and transfers** (`recovery-status.json`, `account-transfers.json`). **DEMO**: a code issued on 14 September 2026 and one downloaded export. The fixture server imitates the backend's account operations: an assistant's request waiting for confirmation, owner-bound links on its own origin, one-time collection, 15-minute expiry, replay, and refusal of an import into a Garderobe with records.
- **Style document.** The owner's profile, byte-exact (SHA-256 `e15639d8…cb198`).
- **Conversation, connections and the SSE run.** DEMO content.

Every file is validated against the shipped zod schemas in `packages/contracts` (`TodayResponse`, `WardrobePage`, `ItemDetail`, `SettingsResponse`, `StyleCurrentResponse`, `ConnectionsResponse`, `LaundryState`, `ConversationPage`, `ReceiptsPage`, `RunEvent` and its payloads). `fixtures.ts verify` fails when they are stale.

## What was verified here, and what needs Xcode or a device

Verified in this workspace on Linux (Debian 13, Swift 6.4.0 from swift.org, Node 22):

- `GarderobeKit` builds, and all 186 Swift Testing tests in 17 suites pass. They cover contract decoding (including the trip-day board and the new availability labels), the section-11 board layout (including the server's line headings as given), Today journeys (including a trip day), the offline command queue, receipts and undo, Wardrobe and the item page (laundry and trip states), Studio, Laundry, Settings and My style, restoration, Conversation (answer, decline, expiry, replay, a pasted recovery code or secret removed with its notice after the reply, and repeated removals across turns each keeping their own notice, placed after their own reply even when turns interleave or the reply carries result cards), recall and SSE, Capture (including a truncated upload), native sign-in (PKCE, callback validation, refresh rotation and replay, revocation), assistant account requests (confirming an export, an import and a recovery kit; declined, expired, replayed and refused requests; foreign, tampered and expired links; nothing private in the transcript or store; Settings status and transfers), contract export, and an adversarial suite (hostile servers, malformed streams, corrupted cache, stale options, randomised shoe sequences).
- 60 Swift-encoded payloads validate against the zod contracts. They cover command envelopes, turn, upload, Studio, wardrobe-query, recall and run-input requests (including a decline), plus the fixture server's turn responses with and without `notice`, receipts, recall response, swap candidates, run-input responses (executed and replayed, with and without `operation`, with `run` checked as `RunStatus`), upload PUT response, and the six account-transfer shapes (`ExportDownloadResult`, `StagedImportPackage`, `McpImportResult`, `RecoveryKitLink`, `RecoveryStatus`, `AccountTransfers`) plus `RecoveryKitResponse`. The 18 fixtures are fresh (including `turn-response.json` and `turn-response-notice.json`).
- `Garderobe.xcodeproj` was generated by XcodeGen on Linux.

**Not verified here.** No Xcode, iOS SDK or simulator is available:

- The `GarderobeUI` SwiftUI screens, the app target and the XCUITests were only **syntax-parsed** (`swiftc -parse`). They were not type-checked, built or run. Expect some compile fixes on first build with the iOS 27 SDK.
- Everything the spec reserves for a device: Dynamic Type at every size, VoiceOver, dark mode, Reduce Motion, Reduce Transparency and Increase Contrast, interrupted Studio gestures, reconnect while reading old messages, backgrounding, network changes, and the camera and photo permission flows.
- Everything live: Google sign-in through Cloudflare Access in `ASWebAuthenticationSession`, the Keychain, and real `URLSession` SSE streaming against a deployed Worker. The sign-in, refresh and revocation logic ran here only against the in-memory fixture server, which imitates the backend's native OAuth endpoints; it has not run against the real Worker.
- On-device tests in the scheme's test action run on an iOS 27 simulator or an iPhone.

## API contracts: what moved to the shipped shapes, and what is still missing

The client is built against the shapes the backend ships (`backend/src/api/README.md`, `packages/contracts`, including `surface.ts`). The provisional copies are retired and `contracts-proposal/` is deleted. Decoding stays tolerant: unknown fields are ignored, unknown enum values keep their raw string, and missing optional fields degrade the UI rather than failing.

**Moved to shipped contracts in this revision**

| Area | Shipped shape the app now uses |
| --- | --- |
| Native sign-in | `GET /v1/auth/native/authorize`, `POST /v1/auth/native/token`, `POST /v1/auth/native/revoke`, `GET /v1/auth/session`. Replaces the proposed `/v1/auth/native/start` with `garderobe://auth?token=` |
| Today | Top-level `dayLine`, nullable `weather` (`status`, `observedAt`, `morningTempC`, `peakTempC`, `rainStartsAt`, `precipitationProbability`, `rainAmountMm`, `windKph`, `gustKph`, `summary`, `source`) and `garments` (with optional `aliases` and `media`) are primary. `Board.document` fills only what they leave out. There is no `peakAt`. Optional `purpose` and `trip` (`TodayTrip`) mark a trip-day board. Swap candidates are `SwapCandidates` |
| Wardrobe | `WardrobeQueryParams` (all filters, `limit` up to 500), `WardrobeItem.media`, `ItemDetail.combinations`, `TemperaturePreview.basis` |
| Style and settings | `StyleCurrentResponse.documents`, the extended `SettingsResponse` (`connectedAssistants: AssistantGrant[]`, `models.simulated`, `calendarId`), and connections with `endpoint` and `protocolVersion` |
| Laundry and receipts | `LaundryState.openExceptions`; `ReceiptsPage` with `limit` |
| Conversation and runs | `TurnRequest.stopCurrent` and the 10-attachment limit, `result_card` parts, `RunStatus` `input_required` with `pendingAction`, `RunInputRequest` and `RunInputResponse` (`executed`, `declined`, `expired`), the `snapshot` event payload, `?around=` paging, `POST /v1/recall/search` (`RecallSearchRequest` and `RecallSearchResponse`) |
| Uploads and media | `UploadRequest.garmentId` with the 25 MB limit, the signed `PUT` upload URL with its `UploadReceiveResponse` (a short write is refused and retried, never finalized), relative media URLs resolved against the API origin |
| Account | `RunInputResponse.operation` with `ExportDownloadResult`, `McpImportResult` and `RecoveryKitLink`; `RecoveryKitResponse` from the collect link; `RecoveryStatus`; `AccountTransfers`; `StagedImportPackage` (decoded; the app does not stage packages) |
| Commands | `save_combination`, `plan_outfit` and `remove_combination` with shipped `StudioSlot`s (`alternativeGroup`); `update_delivery_settings` (with `calendarId: null` to clear); Studio `validForDate` and `warnings` |

**Remaining contract gaps.** None for the endpoints the app calls: every request it sends and every response it reads has a schema in `packages/contracts`. `PrepareBoardRequest` and `PrepareBoardResponse` exist too, but the app does not call `POST /v1/today/prepare`; boards are composed the evening before.

**Other notes, not schema gaps.**
- `select_option` has no field for a morning swap, so swapped garments reach the server only through `record_wear`.
- No real image provider is configured (`backend/src/media/README.md`). Garments without images show a white tile with the category symbol and the garment's name until real photos exist.
- The app does not use some shipped endpoints yet: `POST /v1/studio/choices` (Studio builds its role choices from the cached wardrobe so swipes work offline), `GET /v1/commands/{commandId}` (an interrupted command is retried with the same idempotency key instead), `POST /v1/connections` (adding a remote MCP server from the phone) and `POST /v1/recommend`. Newer surface endpoints (trips and packing, service pause, orders and returns, comfort, lifecycle projects, saved combinations, and staging an import package or creating a recovery kit directly from the phone) are not used by the app yet; Today reads the trip summary from `TodayResponse.trip` only.

Contract details the Swift side relies on: `CommandReceipt` nullable fields (`compensatesCommandId`, `undoneByCommandId`, `error`) are required keys and are always written, and `POST /v1/commands` may return a structured receipt with any HTTP status, which the client prefers over the status. The accepted outcomes are `committed` and `merged`. Anything else, including a future `accepted`, is never shown as done.
