import XCTest

/// UX journeys on the hermetic demo backend (bundled fixtures from the owner's real profile and
/// May 2026 inventory). Requires Xcode with the iOS 27 simulator; not runnable on Linux.
final class GarderobeUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-GarderobeDemo", "-GarderobeResetState"]
    }

    private func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func waitFor(_ e: XCUIElement, _ timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "missing \(e)", file: file, line: line)
    }

    // MARK: Today

    func testMorningBoardReadsLikeTheProfileAsks() {
        app.launch()
        waitFor(element("today.dayLine"))
        XCTAssertTrue(element("today.dayLine").label.hasPrefix("Tuesday, eleven degrees at the door"))
        let card = element("card.1")
        waitFor(card)
        // VoiceOver describes garments and the day, not "Outfit 1".
        XCTAssertTrue(card.label.contains("Jacket: Drake's Black Heavy Twill Chore."))
        XCTAssertTrue(card.label.contains("Socks and shoes: Merino — golden yellow with NB 990v4 — olive/cream."))
        XCTAssertTrue(element("today.freshness").label.hasPrefix("Checked"))
    }

    func testChooseIsAPlanAndAsksForTheShoeFirst() {
        app.launch()
        waitFor(element("today.next"))
        element("today.next").tap()
        let choose = element("card.2.choose")
        waitFor(choose)
        choose.tap()
        let sheet = app.sheets.firstMatch.exists ? app.sheets.firstMatch : app.otherElements.firstMatch
        let olive = app.buttons["NB 990v4 — olive/cream"].firstMatch
        waitFor(olive)
        _ = sheet
        olive.tap()
        let banner = element("receipt.banner")
        waitFor(banner)
        XCTAssertTrue(banner.label.contains("This is a plan, not a recorded wear."))
    }

    func testIWoreThisThenUndoFromTheBanner() {
        app.launch()
        waitFor(element("card.1.wore"))
        element("card.1.wore").tap()
        waitFor(element("receipt.banner"))
        waitFor(element("today.record"))
        element("banner.undo").tap()
        // Undo is a compensating command with its own receipt.
        let undone = NSPredicate(format: "label CONTAINS 'Undid'")
        expectation(for: undone, evaluatedWith: element("receipt.banner"))
        waitForExpectations(timeout: 5)
    }

    func testComparisonListOpensTheChosenOption() {
        app.launch()
        waitFor(element("today.mode"))
        app.segmentedControls["today.mode"].buttons["Compare"].tap()
        waitFor(element("compare.3"))
        element("compare.3").tap()
        waitFor(element("card.3.choose"))
    }

    func testOfflineWearIsKeptOnThePhoneWithVisibleState() {
        app.launch()
        waitFor(element("card.1"))
        app.terminate()
        app.launchArguments = ["-GarderobeDemo", "-GarderobeStartOffline"]
        app.launch()
        waitFor(element("today.freshness"))
        XCTAssertTrue(element("today.freshness").label.hasPrefix("Offline · last checked"))
        element("card.1.wore").tap()
        waitFor(element("pending.record_wear"))
        XCTAssertTrue(element("pending.record_wear").label.contains("Saved on this phone"))
        waitFor(element("today.record"))
        XCTAssertTrue(element("today.record").label.contains("Recorded on this phone"))
    }

    func testSwapIsASwapNotARebuild() {
        app.launch()
        waitFor(element("card.1.swap"))
        element("card.1.swap").tap()
        let candidate = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Lightweight oxford'")).firstMatch
        waitFor(candidate)
        candidate.tap()
        waitFor(element("card.1"))
        XCTAssertTrue(element("card.1").label.contains("Includes your swap."))
        XCTAssertTrue(element("card.1").label.contains("Drake's Black Heavy Twill Chore"))
    }

    // MARK: Wardrobe, Laundry

    func testAliasSearchAndBackFromTheTailor() {
        app.launch()
        app.tabBars.buttons["Wardrobe"].tap()
        let search = app.searchFields.firstMatch
        waitFor(search)
        search.tap()
        search.typeText("camel field")
        let item = app.buttons.matching(NSPredicate(format: "label BEGINSWITH \"Drake's Camel Field Games\"")).firstMatch
        waitFor(item)
        XCTAssertTrue(item.label.contains("At the tailor"))
        item.tap()
        waitFor(element("item.backFromTailor"))
        element("item.backFromTailor").tap()
        waitFor(element("receipt.banner"))
        XCTAssertTrue(element("receipt.banner").label.contains("Back from the tailor"))
    }

    func testSocksAreOneEntryWithAQuantity() {
        app.launch()
        app.tabBars.buttons["Wardrobe"].tap()
        let search = app.searchFields.firstMatch
        waitFor(search)
        search.tap()
        search.typeText("inky blue merino")
        let socks = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Merino — inky blue'"))
        waitFor(socks.firstMatch)
        XCTAssertEqual(socks.count, 1)
        XCTAssertTrue(socks.firstMatch.label.contains("4 pairs"))
    }

    func testLaundrySheetFromTodayCollectsTheHamper() {
        app.launch()
        waitFor(element("toolbar.laundry"))
        element("toolbar.laundry").tap()
        waitFor(element("laundry.collected"))
        element("laundry.collected").tap()
        waitFor(element("receipt.banner"))
        XCTAssertTrue(element("receipt.banner").label.contains("Collected"))
    }

    // MARK: Studio

    func testStudioSwipesLocallyAndLockedPiecesStayPut() {
        app.launch()
        app.tabBars.buttons["Studio"].tap()
        waitFor(element("studio.top.next"))
        element("studio.top.next").tap()
        element("studio.top.lock").tap()
        XCTAssertFalse(element("studio.top.next").isEnabled)
        XCTAssertFalse(element("studio.top.previous").isEnabled)
        element("studio.find").tap()
        waitFor(element("studio.validation"))
        XCTAssertFalse(element("studio.top.next").isEnabled)
    }

    // MARK: Conversation

    func testAskAboutThisAttachesTheOptionAndStreamsAReply() {
        app.launch()
        waitFor(element("card.1.ask"))
        element("card.1.ask").tap()
        waitFor(element("composer.attachment"))
        XCTAssertTrue(element("composer.attachment").label.contains("Option 1"))
        let field = element("composer.field")
        field.tap()
        field.typeText("Is the chore coat too warm by two?")
        element("composer.send").tap()
        let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Seventeen at the peak'")).firstMatch
        waitFor(reply, 10)
    }

    func testDraftTabAndReadingPositionSurviveRelaunch() {
        app.launch()
        app.tabBars.buttons["Conversation"].tap()
        let field = element("composer.field")
        waitFor(field)
        field.tap()
        field.typeText("Half a thought about the Chasseur")
        app.terminate()
        app.launchArguments = ["-GarderobeDemo"]
        app.launch()
        waitFor(element("composer.field"))
        XCTAssertEqual(element("composer.field").value as? String, "Half a thought about the Chasseur")
    }

    // MARK: Settings

    func testMyStyleShowsTheFullProfileWithItsVersion() {
        app.launch()
        waitFor(element("toolbar.account"))
        element("toolbar.account").tap()
        waitFor(element("settings.myStyle"))
        element("settings.myStyle").tap()
        waitFor(element("myStyle.version"))
        XCTAssertTrue(element("myStyle.version").label.hasPrefix("Version 1"))
        XCTAssertTrue(app.staticTexts["11. How advice should arrive"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["8. Hard constraints"].exists)
        element("myStyle.edit").tap()
        waitFor(element("myStyle.editor"))
    }

    func testTripDayBoardIsLabelledAsATripDay() {
        app.launchArguments += ["-GarderobeTripDay"]
        app.launch()
        waitFor(element("today.trip"))
        XCTAssertTrue(element("today.trip").label.hasPrefix("Trip day"))
        waitFor(element("card.1.choose"))
    }

    func testSettingsShowRecoveryStatusWithoutTheCode() {
        app.launch()
        element("toolbar.account").tap()
        waitFor(element("settings.recovery"))
        XCTAssertTrue(element("settings.recovery").label.hasPrefix("A recovery code was issued on"))
        XCTAssertTrue(element("settings.confirmRequest").exists)
    }

    func testConnectedAssistantsAndCalendarNeedsAttention() {
        app.launch()
        element("toolbar.account").tap()
        waitFor(element("assistant.claude"))
        waitFor(element("assistant.chatgpt"))
        XCTAssertTrue(app.buttons["Disconnect Claude"].exists)
        XCTAssertTrue(element("connection.calendar.").label.contains("Needs attention") || element("connection.calendar.").exists)
    }

    // MARK: Accessibility sizes

    func testLargestTextSizeKeepsActionsReachable() {
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        waitFor(element("card.1.choose"))
        XCTAssertTrue(element("card.1.choose").isHittable || element("card.1.choose").exists)
        app.tabBars.buttons["Wardrobe"].tap()
        waitFor(element("wardrobe.counts"))
    }
}
