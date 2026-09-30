import Foundation
import Testing
@testable import GarderobeKit

@Suite("Today")
@MainActor
struct TodayTests {
    func make(_ h: Harness) -> (TodayViewModel, CommandQueue, ReceiptCenter) {
        let queue = CommandQueue(env: h.env)
        let receipts = ReceiptCenter(env: h.env)
        queue.onReceipt { r, _ in receipts.record(r) }
        return (TodayViewModel(env: h.env, queue: queue), queue, receipts)
    }

    func olive(_ vm: TodayViewModel, _ optionId: String) -> String {
        vm.card(optionId)!.footwear.alternatives.first { $0.name == Names.oliveSneaker }!.garmentId
    }

    @Test func aTripDayBoardSaysSoAndStillWorksLikeAnyBoard() async throws {
        let h = try Harness.make()
        try await h.server.startTrip()
        let (vm, _, _) = make(h)
        await vm.refresh()
        #expect(vm.isTripDay)
        #expect(vm.tripLine == "Trip day · DEMO FIXTURE: Paris long weekend · day 2 of 4")
        #expect(vm.cards.count == 3)
        #expect(vm.weatherLine == "12 °C leaving, 15 °C by 3; showers from 4")
        // Choosing on a trip day is the same intention as at home.
        let first = try #require(vm.cards.first)
        guard case .done = await vm.choose(first.optionId) else { Issue.record("expected receipt"); return }
    }

    @Test func cachedBoardIsShownImmediatelyAndNotCalledFresh() throws {
        let h = try Harness.make()
        let checked = Fixtures.demoNow.addingTimeInterval(-3600 * 9) // last night, 21:52
        h.store.save(TodaySnapshot(response: try Fixtures.today, checkedAt: checked), StoreKey.today)
        let (vm, _, _) = make(h)
        // Before any network call:
        #expect(vm.cards.count == 5)
        #expect(vm.dayLine == (try Fixtures.today).dayLine)
        #expect(vm.freshnessLabel == "Last checked Mon 5 Oct 21:52")
        if case .current = vm.freshness { Issue.record("cached board must not read as current") }
    }

    @Test func refreshVerifiesAndStaysOnTheSameOption() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        #expect(vm.freshnessLabel == "Checked 06:52")
        let third = vm.cards[2].optionId
        vm.currentOptionId = third
        await vm.refresh()
        #expect(vm.currentOptionId == third)
    }

    @Test func offlineKeepsTheBoardAndSaysWhenItWasChecked() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        await h.server.setOffline(true)
        await vm.refresh()
        #expect(vm.cards.count == 5)
        #expect(vm.freshnessLabel == "Offline · last checked 06:52")
    }

    @Test func calendarFailureLeavesTodayAvailableWithAQuietNote() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        #expect(vm.calendarNote == "Calendar not checked: this board was made without it.")
        #expect(vm.cards.count == 5)
    }

    @Test func chooseIsAnIntentionNotAWear() async throws {
        let h = try Harness.make()
        let (vm, _, receipts) = make(h)
        await vm.refresh()
        let option = vm.cards[0].optionId
        guard case .done(let r) = await vm.choose(option) else { Issue.record("expected receipt"); return }
        #expect(r.commandType == "select_option")
        #expect(r.summary.hasSuffix("This is a plan, not a recorded wear."))
        #expect(vm.response?.recordedWears.isEmpty == true)
        #expect(vm.cards[0].isChosen)
        #expect(receipts.banner?.receipt.commandId == r.commandId)
    }

    @Test func chooseTwoShoeOptionAsksForTheShoeFirst() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        let option = vm.cards[1].optionId
        guard case .needsFootwear(let shoes) = await vm.choose(option) else { Issue.record("expected footwear prompt"); return }
        #expect(shoes.map(\.name) == [Names.greySneaker, Names.oliveSneaker])
        #expect(await h.server.requests(matching: "/v1/commands").isEmpty)
        vm.selectFootwear(optionId: option, garmentId: olive(vm, option))
        guard case .done = await vm.choose(option) else { Issue.record("expected receipt"); return }
        #expect(await h.server.today.selection?.footwearGarmentId == olive(vm, option))
    }

    @Test func iWoreThisLogsExactlyOneShoeAndBecomesTheDaysRecord() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        let option = vm.cards[1].optionId
        guard case .needsFootwear = await vm.iWore(option) else { Issue.record("must not log two shoes"); return }
        vm.selectFootwear(optionId: option, garmentId: olive(vm, option))
        guard case .done(let r) = await vm.iWore(option) else { Issue.record("expected receipt"); return }
        #expect(r.commandType == "record_wear")
        let body = try #require(await h.server.requests(matching: "/v1/commands").last?.body)
        let env = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: body)
        let items = env.command["items"]!.arrayValue!
        #expect(items.filter { $0["role"]?.stringValue == "footwear" }.count == 1)
        #expect(env.command["optionId"]?.stringValue == option)
        #expect(env.command["wearingDate"]?.stringValue == "2026-10-06")
        #expect(vm.dayRecord?.synced == true)
        #expect(vm.dayRecord?.names.contains(Names.oliveSneaker) == true)
        #expect(vm.dayRecord?.names.contains(Names.greySneaker) == false)
    }

    @Test func offlineWearIsKeptOnThePhoneThenSyncsWithTheTapTime() async throws {
        let h = try Harness.make()
        let (vm, queue, receipts) = make(h)
        await vm.refresh()
        await h.server.setOffline(true)
        await queue.setConnectivity(false)
        let option = vm.cards[0].optionId
        guard case .queued(let pending) = await vm.iWore(option) else { Issue.record("expected queued"); return }
        #expect(pending.envelope.source == .offlineReplay)
        #expect(pending.stateLabel == "Saved on this phone · will send when online")
        #expect(vm.dayRecord?.synced == false)
        #expect(vm.pendingForToday.count == 1)
        // A second tap while it waits does not create a second observation.
        guard case .queued(let again) = await vm.iWore(option) else { Issue.record("expected queued"); return }
        #expect(again.id == pending.id)
        #expect(queue.items.count == 1)

        await h.server.setOffline(false)
        await queue.setConnectivity(true)
        #expect(queue.items.isEmpty)
        let delivered = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").last?.body))
        #expect(delivered.idempotencyKey == pending.id)
        #expect(delivered.command["occurredAt"] == pending.envelope.command["occurredAt"])
        #expect(receipts.receipts.first?.commandType == "record_wear")
        await vm.refresh()
        #expect(vm.dayRecord?.synced == true)
    }

    @Test func swapUsesValidatedCandidatesAndLogsTheSwappedShirt() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        let wardrobe = try Fixtures.wardrobe.items
        let option = vm.cards[0]
        let gold = option.composition.first { $0.role == .baseTop }!.garmentId
        guard case .verified(let list) = await vm.swapCandidates(optionId: option.optionId, role: .baseTop, cachedWardrobe: wardrobe) else { Issue.record("expected verified"); return }
        let pick = try #require(list.first)
        vm.applySwap(optionId: option.optionId, replacing: gold, with: pick.garmentId)
        #expect(vm.card(option.optionId)!.swappedRoles == [.baseTop])
        guard case .done = await vm.iWore(option.optionId) else { Issue.record("expected receipt"); return }
        let env = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").last?.body))
        let ids = env.command["items"]!.arrayValue!.compactMap { $0["garmentId"]?.stringValue }
        #expect(ids.contains(pick.garmentId) && !ids.contains(gold))
    }

    @Test func offlineSwapOffersOnlyUnverifiedLocalCandidates() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        await h.server.setOffline(true)
        let wardrobe = try Fixtures.wardrobe.items
        guard case .unverified(let list) = await vm.swapCandidates(optionId: vm.cards[0].optionId, role: .baseTop, cachedWardrobe: wardrobe) else { Issue.record("expected unverified"); return }
        #expect(!list.isEmpty)
        #expect(list.allSatisfy { $0.reason == "Last seen available; not checked" })
        #expect(!list.contains { $0.name == "Lightweight oxford — moss" }) // in the hamper
    }

    @Test func footwearAndSwapsSurviveRelaunchForTheSameBoard() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        let option = vm.cards[1].optionId
        vm.selectFootwear(optionId: option, garmentId: olive(vm, option))
        vm.mode = .list
        let (again, _, _) = make(try h.relaunched())
        #expect(again.mode == .list)
        #expect(again.card(option)?.footwear.selectedGarmentId == olive(vm, option))
    }

    @Test func askAboutThisCarriesTheOptionIdentity() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        let c = vm.cards[2]
        #expect(vm.reference(for: c.optionId) == .option(boardId: c.boardId, optionId: c.optionId, boardRevision: 2))
    }

    @Test func shortfallAndMissingBoardAreShownPlainly() async throws {
        let h = try Harness.make()
        var t = try Fixtures.today
        let firstThree = Array(t.board!.options.prefix(3))
        t.board?.options = firstThree
        t.shortfall = "Only three outfits are possible while the laundry is out."
        await h.server.replaceToday(t)
        let (vm, _, _) = make(h)
        await vm.refresh()
        #expect(vm.cards.count == 3)
        #expect(vm.cards.allSatisfy { $0.count == 3 })
        #expect(vm.shortfall == t.shortfall)
        t.board = nil
        await h.server.replaceToday(t)
        await vm.refresh()
        #expect(vm.cards.isEmpty)
    }

    @Test func aNewBoardRevisionWithoutTheCurrentOptionFallsBackToTheFirst() async throws {
        let h = try Harness.make()
        let (vm, _, _) = make(h)
        await vm.refresh()
        vm.currentOptionId = vm.cards[4].optionId
        var t = try Fixtures.today
        t.board!.currentRevision = 3
        t.board!.options.removeLast()
        await h.server.replaceToday(t)
        await vm.refresh()
        #expect(vm.currentOptionId == vm.cards[0].optionId)
    }
}
