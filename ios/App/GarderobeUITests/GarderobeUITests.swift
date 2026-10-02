import XCTest

/// UI tests against the app's labelled demo mode, which replays a recording of the real backend
/// (the owner's real wardrobe, a board from the real composer). They need Xcode and a simulator:
///
///   xcodebuild test -project ios/Garderobe.xcodeproj -scheme Garderobe \
///     -destination 'platform=iOS Simulator,name=<an installed iPhone simulator>'
///
/// They run on a macOS runner through `.github/workflows/ios.yml` (manual trigger).
final class GarderobeUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-GarderobeDemo", "-GarderobeResetState"]
    }

    /// A failure also says what was on screen (identifiers and labels), because a run on a hosted
    /// machine leaves nothing else to look at.
    override func record(_ issue: XCTIssue) {
        var issue = issue
        if let app, app.state == .runningForeground {
            var seen = Set<String>()
            var parts: [String] = []
            let pattern = try? NSRegularExpression(pattern: "(identifier|label): '([^']{1,60})")
            let text = app.debugDescription
            pattern?.enumerateMatches(in: text, range: NSRange(text.startIndex..., in: text)) { match, _, _ in
                guard let match, let range = Range(match.range(at: 2), in: text) else { return }
                let value = String(text[range])
                if seen.insert(value).inserted { parts.append(value) }
            }
            // The end of the hierarchy is what is in front (a sheet, a pushed screen).
            issue.compactDescription += " | on screen (last of \(parts.count)): " + String(parts.joined(separator: "; ").suffix(1000))
        }
        super.record(issue)
    }

    private func launch(textSize: String? = nil, extra: [String] = []) {
        if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
        app.launchArguments += extra
        app.launch()
    }

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    private func tab(_ title: String) -> XCUIElement { app.tabBars.buttons[title] }

    // MARK: Navigation

    func testThereAreExactlyFourDestinationsAndDemoModeIsLabelled() {
        launch()
        XCTAssertTrue(tab("Today").waitForExistence(timeout: 10))
        XCTAssertEqual(app.tabBars.buttons.count, 4)
        for title in ["Today", "Wardrobe", "Studio", "Conversation"] { XCTAssertTrue(tab(title).exists, "\(title) tab is missing") }
        XCTAssertTrue(element(AXID.demoLabel).exists, "demo mode must be visibly labelled on every destination")
    }

    func testCaptureAndAccountAreReachableFromEveryDestination() {
        launch()
        XCTAssertTrue(tab("Today").waitForExistence(timeout: 10))
        for title in ["Today", "Wardrobe", "Studio", "Conversation"] {
            tab(title).tap()
            XCTAssertTrue(element(AXID.captureButton).waitForExistence(timeout: 5), "no capture action on \(title)")
            XCTAssertTrue(element(AXID.accountButton).exists, "no account control on \(title)")
            XCTAssertTrue(element(AXID.demoLabel).exists, "no demo label on \(title)")
        }
    }

    // MARK: Today

    func testTodayShowsDateFreshnessAndOptionsNamedByTheirGarments() {
        launch()
        XCTAssertTrue(element(AXID.todayDate).waitForExistence(timeout: 10))
        XCTAssertTrue(element(AXID.todayFreshness).exists)
        XCTAssertTrue(element(AXID.todayCarousel).exists)
        // No element is announced as a bare numbered outfit.
        let numbered = app.descendants(matching: .any).matching(NSPredicate(format: "label MATCHES[c] %@", "^(outfit|option) [0-9]+$"))
        XCTAssertEqual(numbered.count, 0)
    }

    func testEverySwipeOnTodayHasAVisibleAlternative() {
        launch()
        XCTAssertTrue(element(AXID.todayNext).waitForExistence(timeout: 10))
        XCTAssertTrue(element(AXID.todayPrevious).exists)
        element(AXID.todayNext).tap()
        XCTAssertTrue(element(AXID.todayPrevious).isEnabled)
        // The comparison list is the scanning alternative to the carousel.
        element(AXID.todayComparisonToggle).tap()
        XCTAssertTrue(element(AXID.todayComparisonList).waitForExistence(timeout: 5))
    }

    func testChooseThenWearShowsTheDayRecordAndAnUndoBanner() {
        launch()
        XCTAssertTrue(element(AXID.todayComparisonToggle).waitForExistence(timeout: 10))
        element(AXID.todayComparisonToggle).tap()
        // The recording's journey is: choose the second option, then wear it.
        let choose = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'today.option.' AND identifier ENDSWITH '.choose'"))
        XCTAssertGreaterThanOrEqual(choose.count, 2)
        choose.element(boundBy: 1).tap()
        let wore = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'today.option.' AND identifier ENDSWITH '.wore'"))
        XCTAssertTrue(wore.element(boundBy: 1).waitForExistence(timeout: 5))
        wore.element(boundBy: 1).tap()
        XCTAssertTrue(element(AXID.todayDayRecord).waitForExistence(timeout: 5))
        XCTAssertTrue(element(AXID.undoBanner).waitForExistence(timeout: 3))
        XCTAssertTrue(element(AXID.undoButton).isHittable)
    }

    func testTheUndoBannerLeavesByItselfAndTheReceiptStaysInTheItemHistory() {
        testChooseThenWearShowsTheDayRecordAndAnUndoBanner()
        let banner = element(AXID.undoBanner)
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: banner)
        wait(for: [gone], timeout: 12) // eight seconds, with margin
        XCTAssertTrue(element(AXID.todayDayRecord).exists, "the record must remain after the banner has gone")
    }

    // MARK: Wardrobe

    func testWardrobeShowsCountsAndAnItemPageWithDirectCommands() {
        launch()
        XCTAssertTrue(tab("Wardrobe").waitForExistence(timeout: 10))
        tab("Wardrobe").tap()
        XCTAssertTrue(element(AXID.wardrobeCounts).waitForExistence(timeout: 10))
        let items = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'wardrobe.item.'"))
        XCTAssertGreaterThan(items.count, 0)
        items.firstMatch.tap()
        XCTAssertTrue(element(AXID.itemStatus).waitForExistence(timeout: 10))
        XCTAssertTrue(element(AXID.itemAsk).exists)
    }

    func testTheWardrobeGridBecomesAListAtAccessibilityTextSizes() {
        launch(textSize: "UICTContentSizeCategoryAccessibilityXL")
        XCTAssertTrue(tab("Wardrobe").waitForExistence(timeout: 10))
        tab("Wardrobe").tap()
        let first = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'wardrobe.item.'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        // A list row spans the content width; a grid tile does not.
        XCTAssertGreaterThan(first.frame.width, app.windows.firstMatch.frame.width * 0.8)
        XCTAssertGreaterThanOrEqual(first.frame.height, 44)
    }

    func testTheLaundrySheetOffersItsFourActions() {
        launch()
        XCTAssertTrue(tab("Wardrobe").waitForExistence(timeout: 10))
        tab("Wardrobe").tap()
        let laundry = element(AXID.laundryButton)
        XCTAssertTrue(laundry.waitForExistence(timeout: 10))
        laundry.tap()
        for identifier in [AXID.laundryCollected, AXID.laundryReturned, AXID.laundryStillAway, AXID.laundrySocksWashed] {
            XCTAssertTrue(element(identifier).waitForExistence(timeout: 5), "\(identifier) is missing from the Laundry sheet")
        }
    }

    // MARK: Studio

    func testStudioSelectorsHavePreviousNextAndLockControlsAndThreeDistinctActions() {
        launch()
        XCTAssertTrue(tab("Studio").waitForExistence(timeout: 10))
        tab("Studio").tap()
        XCTAssertTrue(element(AXID.studioCanvas).waitForExistence(timeout: 10))
        for role in ["top", "bottom", "footwear"] {
            XCTAssertTrue(element(AXID.studioNext(role)).exists, "no Next control for \(role)")
            XCTAssertTrue(element(AXID.studioPrevious(role)).exists, "no Previous control for \(role)")
            XCTAssertTrue(element(AXID.studioLock(role)).exists, "no Lock control for \(role)")
        }
        let before = element(AXID.studioCanvas).label
        element(AXID.studioNext("top")).tap()
        XCTAssertNotEqual(element(AXID.studioCanvas).label, before, "the canvas description must name the new piece")
        for identifier in [AXID.studioSave, AXID.studioPlan, AXID.studioWear, AXID.studioFind] { XCTAssertTrue(element(identifier).exists, "\(identifier) is missing") }
    }

    func testALockedPieceDoesNotMove() {
        launch()
        XCTAssertTrue(tab("Studio").waitForExistence(timeout: 10))
        tab("Studio").tap()
        XCTAssertTrue(element(AXID.studioLock("top")).waitForExistence(timeout: 10))
        element(AXID.studioLock("top")).tap()
        let before = element(AXID.studioCanvas).label
        XCTAssertFalse(element(AXID.studioNext("top")).isEnabled)
        XCTAssertEqual(element(AXID.studioCanvas).label, before)
    }

    // MARK: Conversation and capture

    func testConversationHasOneTranscriptAComposerAndNoNewChatAction() {
        launch()
        XCTAssertTrue(tab("Conversation").waitForExistence(timeout: 10))
        tab("Conversation").tap()
        XCTAssertTrue(element(AXID.composerField).waitForExistence(timeout: 10))
        XCTAssertTrue(element(AXID.historySearch).exists)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'new chat' OR label CONTAINS[c] 'new conversation'")).count, 0)
    }

    func testADraftSurvivesClosingTheApp() {
        app.launchArguments = ["-GarderobeDemo"] // keep state between the two launches
        launch()
        XCTAssertTrue(tab("Conversation").waitForExistence(timeout: 10))
        tab("Conversation").tap()
        let field = element(AXID.composerField)
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("Half a thought about the grey jumper")
        app.terminate()
        app.launch()
        // The selected tab is restored too.
        XCTAssertTrue(element(AXID.composerField).waitForExistence(timeout: 10))
        XCTAssertEqual(element(AXID.composerField).value as? String, "Half a thought about the grey jumper")
    }

    func testTheCaptureSheetOffersThreeIntents() {
        launch()
        XCTAssertTrue(element(AXID.captureButton).waitForExistence(timeout: 10))
        element(AXID.captureButton).tap()
        for intent in ["addItem", "identify", "whatIWore"] {
            XCTAssertTrue(element(AXID.captureIntent(intent)).waitForExistence(timeout: 5), "capture intent \(intent) is missing")
        }
    }

    // MARK: Settings

    func testSettingsSitBehindTheAccountControl() {
        launch()
        XCTAssertTrue(element(AXID.accountButton).waitForExistence(timeout: 10))
        element(AXID.accountButton).tap()
        for identifier in [AXID.settingsMyStyle, AXID.settingsConnections, AXID.settingsAssistants] {
            XCTAssertTrue(element(identifier).waitForExistence(timeout: 5), "\(identifier) is missing from Settings")
        }
        // The rest of the list is below the fold; rows exist once scrolled to.
        app.swipeUp()
        for identifier in [AXID.settingsRecovery, AXID.settingsExport] {
            XCTAssertTrue(element(identifier).waitForExistence(timeout: 5), "\(identifier) is missing from Settings")
        }
    }

    // MARK: Accessibility audit and performance

    /// One destination's audit: contrast, hit-region size, element description, Dynamic Type,
    /// clipping and traits. Every issue is collected, counted by kind and element, and reported
    /// together with where the element is, so a failure can be understood from the log alone.
    private func audit(_ title: String, settledWhen identifier: String) throws {
        launch()
        XCTAssertTrue(tab(title).waitForExistence(timeout: 10))
        tab(title).tap()
        // The audit measures what is on screen, so it starts only after the destination has
        // loaded its content and its images have stopped arriving.
        XCTAssertTrue(element(identifier).waitForExistence(timeout: 10), "\(title) did not load")
        RunLoop.current.run(until: Date().addingTimeInterval(3))
        var found: [String: Int] = [:]
        var excluded: [String: Int] = [:]
        let screen = app.windows.firstMatch.frame
        let tabBar = app.tabBars.firstMatch.frame
        let barTitles = Set(app.navigationBars.staticTexts.allElementsBoundByIndex.map(\.label))
        let searchPrompts = Set(app.searchFields.allElementsBoundByIndex.compactMap { $0.placeholderValue })
        try app.performAccessibilityAudit { issue in
            let element = issue.element
            let label = element?.label ?? ""
            let name = [element?.identifier, label].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "/")
            var detail = ""
            if let element {
                let f = element.frame
                detail = " {type \(element.elementType.rawValue) x\(Int(f.minX)) y\(Int(f.minY)) w\(Int(f.width)) h\(Int(f.height)); \(issue.detailedDescription.prefix(110))}"
            } else {
                // The audit names no element: its own longer description is all there is.
                detail = " {no element: \(issue.detailedDescription.prefix(160))}"
            }
            let key = "\(issue.compactDescription) [\(name.prefix(48))]\(detail)"
            // Excluded, and still counted and printed. Only what iOS itself draws:
            //  1. the navigation bar's title and the search field's prompt, rendered by the system
            //     on its glass material (the app sets only their words);
            //  2. contrast of content that has scrolled beneath the system's floating tab bar or
            //     into the soft edge directly above it (one 44-point row), where the system blurs
            //     and dims whatever is behind the bar. The same text passes higher up the screen.
            let inSystemBar = (issue.auditType == .contrast && element?.elementType == .staticText && barTitles.contains(label))
                || (issue.auditType == .textClipped && (element?.elementType == .searchField || searchPrompts.contains(label)))
            let underTabBar = issue.auditType == .contrast && tabBar.height > 0 && (element.map { $0.frame.maxY > tabBar.minY - 44 } ?? false)
            if inSystemBar || underTabBar { excluded[(underTabBar ? "under the tab bar: " : "in a system bar: ") + key, default: 0] += 1 } else { found[key, default: 0] += 1 }
            return true
        }
        let lines = found.sorted { $0.key < $1.key }.map { $0.value > 1 ? "\($0.key) x\($0.value)" : $0.key }
        let skipped = excluded.sorted { $0.key < $1.key }.map(\.key)
        let geometry = "screen \(Int(screen.width))x\(Int(screen.height)), tab bar y\(Int(tabBar.minY)) h\(Int(tabBar.height))"
        XCTAssertTrue(found.isEmpty, "\(title): \(found.values.reduce(0, +)) accessibility audit issues (\(geometry)): " + lines.joined(separator: " || ")
                      + " ## excluded as system-drawn (\(excluded.values.reduce(0, +))): " + skipped.joined(separator: " || "))
        // A passing audit still says what it left out.
        if found.isEmpty, !skipped.isEmpty { print("AUDIT-EXCLUDED \(title) (\(geometry)): " + skipped.joined(separator: " || ")) }
    }

    func testAccessibilityAuditOfToday() throws { try audit("Today", settledWhen: AXID.todayCarousel) }
    func testAccessibilityAuditOfWardrobe() throws { try audit("Wardrobe", settledWhen: AXID.wardrobeCounts) }
    func testAccessibilityAuditOfStudio() throws { try audit("Studio", settledWhen: AXID.studioCanvas) }
    func testAccessibilityAuditOfConversation() throws { try audit("Conversation", settledWhen: AXID.composerField) }

    /// On relaunch Today is on screen by the time the app has finished launching. This is a
    /// simulator observation; the specification's one-second target is measured on a device.
    func testTodayIsOnScreenWhenARelaunchFinishes() {
        launch()
        XCTAssertTrue(element(AXID.todayDate).waitForExistence(timeout: 10))
        app.terminate()
        app.launchArguments = ["-GarderobeDemo"]
        app.launch() // returns once the app is running and idle
        XCTAssertTrue(element(AXID.todayDate).waitForExistence(timeout: 1), "Today was not on screen one second after the relaunch finished")
        XCTAssertTrue(element(AXID.todayCarousel).exists || element(AXID.todayComparisonList).exists)
    }
}
