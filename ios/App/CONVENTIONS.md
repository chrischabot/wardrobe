# Conventions for the SwiftUI layer (`ios/App`)

The SwiftUI code is presentation only. Every decision, every list of eligible garments, every
validation and every change comes from `GarderobeKit` feature models, which in turn only call the
backend. A view never filters by availability, never composes an outfit, never computes a
cleanliness state and never sends anything except through a model method.

## Where things are

| What | Where |
| --- | --- |
| Feature models (`@MainActor @Observable`) | `ios/GarderobeKit/Sources/GarderobeKit/Features/` |
| Wording derived from backend facts | `GarderobeKit/Presentation/Phrases.swift` |
| Accessibility identifiers (shared with UI tests) | `GarderobeKit/Presentation/AccessibilityIdentifiers.swift` (`AXID`) |
| Generated contract types (never edit) | `GarderobeKit/Contracts/GarderobeContracts.swift` |
| Root, tabs, routes, sheets | `App/Garderobe/GarderobeApp.swift` |
| Design system | `App/Garderobe/Design/` (`Theme.swift`, `GarmentImageView.swift`, `Receipts.swift`) |
| Screens | `App/Garderobe/Screens/<Area>/` |

## How a screen gets its model

`AppModel` is in the environment: `@Environment(AppModel.self) private var app`. Use the models it
owns (`app.today`, `app.wardrobe`, `app.studio`, `app.transcript`, `app.composer`, `app.capture`,
`app.laundry`, `app.trips`, `app.returns`, `app.settings`, `app.account`, `app.recovery`,
`app.export`, `app.recall`, `app.firstUse`, `app.images`, `app.environment`). A screen that needs a
per-item model (`ItemModel`, `ReconcileModel`, `TemperaturePreviewModel`) creates it in `@State`
from `app.environment`. Use `@Bindable var model = app.someModel` inside `body` when a binding to a
model property is needed. Call the model's `open()` in `.task { }`; it shows cached data
immediately and then refreshes.

Navigation: push with `app.push(.item(garmentId: id))` or `NavigationLink(value: AppRoute...)`.
Sheets over any destination: set `app.sheet = .laundry / .capture / .settings`. "Ask about this":
`app.askAbout(ref, label:)` (it attaches the identity and opens Conversation).

## Required on every screen

1. **Freshness.** Show the model's `freshnessLine` with `FreshnessLabel(text:freshness:)`. Never
   write "up to date" yourself. Cached data appears with no entrance animation and a refresh must
   not move the layout (reserve space; use `GarmentImageView`, which reserves its aspect ratio).
2. **Outcome of an action.** After a command, show `OutcomeLine(outcome: model.lastOutcome)`.
   Confirmed, saved-on-phone, refused and not-saved are four different sentences; do not replace
   them with a generic "Done". The undo banner and receipts are handled globally
   (`UndoBannerView`, `ReceiptCard`).
3. **Accessibility.**
   - Every image of a garment or outfit has a label naming the garments (models provide
     `accessibilityLabel` strings). Never "Outfit 3" or "Image".
   - Every swipe, drag or long-press has a visible button or menu equivalent.
   - Interactive areas are at least 44 by 44 points (`.touchTarget()`), at every text size.
   - Layout reflows at accessibility sizes: check `@Environment(\.dynamicTypeSize)` and switch
     `HStack` to `VStack` (or a grid to a list) when `typeSize.isAccessibilitySize`. No fixed
     heights on text containers; no `lineLimit(1)` on content text.
   - Honour `@Environment(\.accessibilityReduceMotion)`: no positional animation when set (use
     `Animation.settle(reduceMotion:)`, which returns nil). Honour reduce transparency and
     increased contrast through the design-system modifiers; do not add your own materials.
   - State is never conveyed by colour alone: pair it with text or a symbol.
   - Set `accessibilityIdentifier` from `AXID` on the elements listed there.
4. **Typography and spacing.** Semantic text styles only (`.title2`, `.headline`, `.body`,
   `.footnote`...), SF Symbols, `Metrics.unit` (4) multiples, `Metrics.inset` (16) content insets.
   One accent colour (the asset catalogue's `AccentColor`); do not introduce other brand colours.
5. **Motion.** None for frequent actions (typing, filtering, selecting a role, loading). A
   user-initiated swap may use `.animation(.settle(reduceMotion: reduceMotion), value: ...)`.
   Sheets and menus use the native transition. No staggered entrances, bouncing, typewriter
   playback, or haptics on streamed text.
6. **Surfaces.** Content sits on `contentSurface()` (opaque, subtle border, no shadow). Garment
   photographs sit on `catalogueCanvas()` (white in light and dark mode). Liquid Glass is for
   navigation and controls only: use standard SwiftUI controls (they adopt it) and
   `.primaryAction()` / `.secondaryAction()` for buttons. Do not call `glassEffect` on content.
7. **No streaks, scores, badges for "maintenance", or compulsory prompts.** Feedback is optional
   and never asked for. A zero wear count is "no wears logged", never "unworn".

## API level

The deployment target is iOS 27 (`Config/Base.xcconfig`) and the code must also build with the
iOS 26 SDK. Use only APIs that exist in iOS 26 or earlier: `NavigationStack`, `TabView` with `Tab`,
`@Observable` / `@Bindable` / `@Environment(Type.self)`, `.searchable`, `.sheet`, `.confirmationDialog`,
`Menu`, `PhotosPicker` (PhotosUI), `ContentUnavailableView`, `ScrollView` + `LazyVStack`,
`ScrollViewReader`, `.scrollTargetBehavior`, `.scrollPosition(id:)`, `ViewThatFits`, `Grid`,
`LabeledContent`, `ShareLink`, `.sensoryFeedback` (sparingly: only for a completed explicit action).
Liquid Glass button styles (`.glass`, `.glassProminent`) are used only inside the design-system
modifiers behind `#available(iOS 26.0, *)`. Do not use any API you are not certain exists; a
standard control is always acceptable.

## Checking

SwiftUI cannot be compiled on Linux. The only check available here is a syntax parse:

```
export PATH=/var/tmp/scratch/w-wi_7fca966a614d64a0/swift/usr/bin:$PATH
swiftc -frontend -parse <file.swift>
```

It catches syntax errors only, not type errors, so read the model's source for the exact names
and types of everything you call. `Tools/check.sh` runs the parse over every file in `App/`.
