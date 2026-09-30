import Foundation
import Testing
@testable import GarderobeKit

@Suite("Wardrobe and item page")
@MainActor
struct WardrobeTests {
    func loaded() async throws -> (Harness, WardrobeViewModel) {
        let h = try Harness.make()
        let vm = WardrobeViewModel(env: h.env)
        await vm.refresh()
        return (h, vm)
    }

    @Test func searchAcceptsAliasesMakerNamesAndCodes() async throws {
        let (_, vm) = try await loaded()
        vm.query = "PCF4340"
        #expect(vm.items.map(\.garment.name) == ["Lightweight oxford — light blue wide stripe"])
        vm.query = "Washed Light Blue Wide Stripe"
        #expect(vm.items.first?.garment.name == "Lightweight oxford — light blue wide stripe")
        vm.query = "the wide stripe"
        #expect(vm.items.contains { $0.garment.name == "Lightweight oxford — light blue wide stripe" })
        vm.query = "wide-stripe"
        #expect(vm.items.contains { $0.garment.name == "Cotton-linen oxford — blue wide stripe" })
        vm.query = "990v4"
        #expect(Set(vm.items.map(\.garment.name)) == [Names.greySneaker, "NB 990v4 — navy", Names.oliveSneaker])
        vm.query = "cafe reims"
        #expect(vm.items.map(\.garment.name) == ["Paraboot Reims — café/marron"])
        vm.query = "the 993s"
        #expect(vm.items.first?.garment.acquisition == .incoming)
    }

    @Test func countsDistinguishOwnedAvailableIncomingRetired() async throws {
        let (_, vm) = try await loaded()
        #expect(vm.counts.owned == 143)
        #expect(vm.counts.incoming == 1)
        #expect(vm.counts.retired == 1)
        #expect(vm.counts.available == vm.allItems.filter(\.availability.available).count)
        #expect(vm.isComplete)
    }

    @Test func filtersCoverAvailabilityCategoryColourSeasonLocationAndLastWear() async throws {
        let (_, vm) = try await loaded()
        #expect(!vm.items.contains { $0.garment.acquisition == .disposed }) // retired hidden by default
        vm.filter.availability = .retired
        #expect(vm.items.map(\.garment.name) == ["Drake's red polka-dot"])
        vm.filter.availability = .incoming
        #expect(vm.items.count == 1)
        vm.filter = WardrobeFilter()
        vm.filter.category = .socks
        #expect(vm.items.count == 15)
        vm.filter.colorFamily = "green"
        #expect(Set(vm.items.map(\.garment.name)) == ["Merino — deep forest green", "Merino — pine green"])
        vm.filter = WardrobeFilter()
        vm.filter.location = .tailor
        #expect(vm.items.map(\.garment.name) == ["Drake's Camel Field Games"])
        vm.filter = WardrobeFilter()
        vm.filter.lastWorn = .thisWeek
        #expect(vm.items.contains { $0.garment.name == "Lightweight oxford — moss" })
        #expect(!vm.items.contains { $0.garment.name == Names.goldOxford })
        vm.filter.lastWorn = .noRecordedWear
        #expect(vm.items.contains { $0.garment.name == Names.goldOxford })
        vm.filter = WardrobeFilter()
        vm.filter.season = "Cold"
        #expect(vm.items.contains { $0.garment.name == "DBF Grandfather Coat" })
        #expect(vm.facets.locations.contains(.storage))
    }

    @Test func noRecordedWearIsNeverCalledUnworn() {
        #expect(WardrobeFilter.LastWorn.noRecordedWear.label == "No recorded wear")
        #expect(!WardrobeFilter.LastWorn.allCases.map(\.label).joined().lowercased().contains("unworn"))
    }

    @Test func gridBecomesAListAtAccessibilitySizes() {
        #expect(WardrobeViewModel.layout(isAccessibilitySize: false) == .grid)
        #expect(WardrobeViewModel.layout(isAccessibilitySize: true) == .list)
    }

    @Test func socksAreOneEntryWithQuantitiesNeverPairNumbers() async throws {
        let (_, vm) = try await loaded()
        let inky = try #require(vm.allItems.first { $0.garment.name == "Merino — inky blue" })
        #expect(QuantityText.text(for: inky) == "4 pairs · 3 clean")
        let grey = try #require(vm.allItems.first { $0.garment.name == "Merino — correct grey" })
        #expect(QuantityText.text(for: grey) == "3 pairs")
        #expect(vm.allItems.filter { $0.garment.name.contains("Merino — inky blue") }.count == 1)
        #expect(QuantityText.text(for: vm.allItems.first { $0.garment.name == Names.goldOxford }!) == nil)
    }

    @Test func temperaturePreviewIsLabelledASimulation() async throws {
        let (_, vm) = try await loaded()
        vm.previewTemperature = 4
        await vm.loadPreview()
        let p = try #require(vm.preview)
        #expect(p.simulation)
        #expect(p.items.contains { $0.name == "DBF Grandfather Coat" && $0.inStorage })
        // It changes nothing.
        await vm.refresh()
        #expect(vm.allItems.first { $0.garment.name == "DBF Grandfather Coat" }?.availability.available == false)
    }

    func item(_ h: Harness, _ vm: WardrobeViewModel, _ name: String) async throws -> ItemDetailViewModel {
        let q = CommandQueue(env: h.env)
        let rc = ReceiptCenter(env: h.env)
        q.onReceipt { r, _ in rc.record(r) }
        let ivm = ItemDetailViewModel(garmentId: try #require(vm.allItems.first { $0.garment.name == name }).garment.garmentId, env: h.env, queue: q, receipts: rc, wardrobe: vm)
        await ivm.load()
        return ivm
    }

    @Test func laundryAndTripStatesDriveFiltersNotesAndCommands() async throws {
        let (h, vm) = try await loaded()
        vm.filter.availability = .waitingForWash
        #expect(Set(vm.items.map(\.availability.label)) == ["In the wash", "At the laundry", "Worn, not washed yet"])
        #expect(vm.items.count == 7)
        let moss = try await item(h, vm, "Lightweight oxford — moss")
        #expect(moss.offersLaundry)
        #expect(moss.availabilityNote?.hasPrefix("In the hamper") == true)
        // A packed trip: its garments are not at home.
        try await h.server.startTrip()
        await vm.refresh()
        vm.filter.availability = .packed
        let packed = vm.items
        #expect(!packed.isEmpty && packed.allSatisfy { $0.availability.label == "Packed for a trip" && !$0.availability.available })
        #expect(packed.contains { $0.garment.name == Names.goldOxford } == false) // the gold oxford stayed home
        let blue = try await item(h, vm, "Lightweight oxford — light blue")
        #expect(blue.item?.availability.state == .packedForTrip)
        #expect(blue.directCommands.isEmpty) // no "In the wash" or storage for a shirt in the suitcase
        #expect(blue.availabilityNote?.contains("suitcase") == true)
        #expect(!blue.offersLaundry)
        #expect(try await item(h, vm, Names.goldOxford).directCommands == [.inTheWash, .putIntoStorage])
    }

    @Test func directCommandsMatchEachItemsState() async throws {
        let (h, vm) = try await loaded()
        #expect(try await item(h, vm, "Drake's Camel Field Games").directCommands == [.backFromTailor])
        #expect(try await item(h, vm, "NB 993 — grey (TEST EVENT (fixture, not owner data))").directCommands == [.arrived])
        #expect(try await item(h, vm, "DBF Grandfather Coat").directCommands == [.takeOutOfStorage])
        #expect(try await item(h, vm, Names.goldOxford).directCommands == [.inTheWash, .putIntoStorage])
        #expect(try await item(h, vm, "Lightweight oxford — moss").directCommands == []) // already in the hamper
        #expect(try await item(h, vm, Names.greySneaker).directCommands == [.putIntoStorage]) // shoes never launder
    }

    @Test func backFromTailorReturnsAReceiptAndUpdatesAvailability() async throws {
        let (h, vm) = try await loaded()
        let ivm = try await item(h, vm, "Drake's Camel Field Games")
        guard case .done(let r) = await ivm.perform(.backFromTailor) else { Issue.record("expected receipt"); return }
        #expect(r.summary == "Back from the tailor: Drake's Camel Field Games.")
        #expect(ivm.item?.availability.available == true)
        #expect(ivm.directCommands.contains(.inTheWash) == false) // blazers are multi-wear
        #expect(ivm.receipts.first?.commandId == r.commandId)
        #expect(await ivm.perform(.backFromTailor) == .refused("Not possible for this item right now"))
    }

    @Test func ownerAssertedPiecesShowUnknownFactsHonestly() async throws {
        let (h, vm) = try await loaded()
        let ivm = try await item(h, vm, "D-43")
        let facts = Dictionary(uniqueKeysWithValues: ivm.facts.map { ($0.label, $0.value) })
        #expect(facts["Colour"] == "Unknown")
        #expect(facts["Maker"] == "Unknown")
        #expect(facts["Size"] == "Unknown")
        #expect(facts["Notes"]?.hasPrefix("Owner-asserted 2026-09-29") == true)
        vm.query = "990v6"
        #expect(vm.items.map(\.availability.label) == ["Sneakers only for now"])
        // A CSV piece with no stated colour is not labelled unknown by this rule.
        let gold = try await item(h, vm, Names.goldOxford)
        #expect(!gold.facts.contains { $0.value == "Unknown" })
    }

    @Test func itemPageShowsMakerTermsAndHonestWearHistory() async throws {
        let (h, vm) = try await loaded()
        let ivm = try await item(h, vm, "Lightweight oxford — light blue wide stripe")
        let facts = Dictionary(uniqueKeysWithValues: ivm.facts.map { ($0.label, $0.value) })
        #expect(facts["Maker's name"] != nil || facts["Code"] != nil)
        #expect(facts["Wear history"]?.contains("a low count means unlogged, not unworn") == true)
        #expect(ivm.detail?.wearHistory.count == 1)
    }

    @Test func countCorrectionIsAnAggregateNotAShelfCheck() async throws {
        let (h, vm) = try await loaded()
        let ivm = try await item(h, vm, "Merino — inky blue")
        guard case .done = await ivm.reconcile(clean: 2, totalOwned: nil) else { Issue.record("expected receipt"); return }
        let env = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").last?.body))
        #expect(env.command.type == "reconcile_quantity")
        #expect(env.command["clean"]?.intValue == 2)
        #expect(await ivm.reconcile(clean: nil, totalOwned: nil) == .refused("Nothing to correct"))
    }
}

@Suite("Studio")
@MainActor
struct StudioTests {
    func make(manual: Bool = true) async throws -> (Harness, StudioViewModel, WardrobeViewModel) {
        let h = try Harness.make(manualSleep: manual)
        let w = WardrobeViewModel(env: h.env)
        await w.refresh()
        return (h, StudioViewModel(env: h.env, queue: CommandQueue(env: h.env), wardrobe: w), w)
    }

    @Test func swipesAreLocalAndNeverWaitForTheNetwork() async throws {
        let (h, s, _) = try await make()
        let before = await h.server.requestLog.count
        for _ in 0..<10 { #expect(s.next(.top)) }
        s.previous(.bottom)
        s.next(.footwear)
        #expect(await h.server.requestLog.count == before) // validation is debounced, not per swipe
        #expect(s.selected(.top) != nil)
        #expect(await h.clock.requested.allSatisfy { $0 == .milliseconds(350) })
    }

    @Test func previousAndNextWrapAround() async throws {
        let (_, s, _) = try await make()
        let list = s.candidates(for: .footwear)
        s.next(.footwear)
        #expect(s.selected(.footwear)?.id == list.first?.id)
        s.previous(.footwear)
        #expect(s.selected(.footwear)?.id == list.last?.id)
    }

    @Test func forTodayExcludesStoredIncomingAndBenchedExploreMarksThem() async throws {
        let (_, s, _) = try await make()
        let today = s.candidates(for: .outer).map(\.garment.name)
        #expect(!today.contains("DBF Grandfather Coat"))
        #expect(!today.contains("PWVC Harris Tweed Marylebone"))
        #expect(!today.contains("Drake's Camel Field Games"))
        s.setMode(.explore)
        let explore = s.candidates(for: .outer)
        let coat = try #require(explore.first { $0.garment.name == "DBF Grandfather Coat" })
        #expect(s.badge(for: coat) == "In storage")
        let incoming = try #require(s.candidates(for: .footwear).first { $0.garment.acquisition == .incoming })
        #expect(s.badge(for: incoming) == "Incoming")
    }

    @Test func lockedPiecesStayPutEvenWhenAskedToFindSomething() async throws {
        let (h, s, _) = try await make(manual: false)
        s.next(.top)
        let top = s.state.selection[.top]
        s.toggleLock(.top)
        #expect(!s.next(.top))
        #expect(s.state.selection[.top] == top)
        await s.findSomethingThatWorks()
        #expect(s.state.selection[.top] == top)
        #expect(s.state.selection[.bottom] != nil && s.state.selection[.footwear] != nil && s.state.selection[.outer] != nil)
        let req = try GarderobeJSON.decoder().decode(StudioSuggestRequest.self, from: #require(await h.server.requests(matching: "/v1/studio/suggest").last?.body))
        #expect(req.locked.map(\.garmentId) == [top!])
        #expect(!req.roles.contains(.baseTop))
    }

    @Test func staleValidationResultsAreIgnored() async throws {
        let (h, s, _) = try await make()
        s.next(.top)
        await eventually("first debounce") { await h.clock.pending == 1 }
        s.next(.top) // supersedes the first check before it runs
        await eventually("second debounce") { await h.clock.pending == 2 }
        await h.clock.advance()
        await eventually("validated") { if case .valid = s.validation { true } else if case .issues = s.validation { true } else { false } }
        #expect(await h.server.requests(matching: "/v1/studio/validate").count == 1)
    }

    @Test func backendValidationFlagsUnavailableAndMissingSocks() async throws {
        let (_, s, w) = try await make()
        s.setMode(.explore)
        s.select(.outer, garmentId: w.allItems.first { $0.garment.name == "DBF Grandfather Coat" }!.id)
        s.select(.footwear, garmentId: w.allItems.first { $0.garment.name == Names.greySneaker }!.id)
        s.setMode(.today)
        await s.validateNow()
        guard case .issues(let issues) = s.validation else { Issue.record("expected issues"); return }
        #expect(Set(issues.map(\.code)) == ["unavailable", "socks_always"])
    }

    @Test func saveCombinationPlanForADayAndWearThisHaveDistinctEffects() async throws {
        let (h, s, _) = try await make(manual: false)
        for role in StudioRole.primary { s.next(role) }
        s.setAccessoriesExpanded(true)
        s.next(.socks)
        guard case .done(let saved) = await s.saveCombination(name: "Tuesday") else { Issue.record("save"); return }
        #expect(saved.summary.hasSuffix("Nothing was planned or recorded."))
        #expect(s.lastSavedCombinationId != nil)
        guard case .done(let planned) = await s.planForDay(LocalDate("2026-10-08")!) else { Issue.record("plan"); return }
        guard case .done(let worn) = await s.wearThis() else { Issue.record("wear"); return }
        #expect([saved.commandType, planned.commandType, worn.commandType] == ["save_combination", "plan_outfit", "record_wear"])
        // Only Wear this records a wear.
        #expect(await h.server.today.recordedWears.count == 5)
        // remove_combination takes the saved look back (kept as history on the server).
        guard case .done(let removed) = await s.removeLastSaved() else { Issue.record("remove"); return }
        #expect(removed.commandType == "remove_combination")
        #expect(await s.removeLastSaved() == .refused("Nothing saved in this session"))
        let env = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").first?.body))
        #expect(env.command["mode"]?.stringValue == "today")
    }

    @Test func aPlanInvalidForItsDayIsRefusedWithTheServersReason() async throws {
        let (_, s, w) = try await make(manual: false)
        s.setMode(.explore)
        s.select(.outer, garmentId: w.allItems.first { $0.garment.name == "DBF Grandfather Coat" }!.id)
        s.next(.top)
        s.next(.bottom)
        guard case .refused(let why) = await s.planForDay(LocalDate("2026-10-08")!) else { Issue.record("expected refusal"); return }
        #expect(why.contains("DBF Grandfather Coat: In storage"))
    }

    @Test func nothingFoundLeavesLockedAndUnlockedPiecesAlone() async throws {
        let (h, s, _) = try await make(manual: false)
        s.next(.top)
        s.toggleLock(.top)
        s.next(.bottom)
        let bottom = s.state.selection[.bottom]
        await h.server.markEverythingUnavailable()
        await s.findSomethingThatWorks()
        #expect(s.state.selection[.bottom] == bottom)
        #expect(s.suggestionNote?.isEmpty == false)
    }

    @Test func onePieceLayoutReplacesTopAndBottom() async throws {
        let (_, s, _) = try await make()
        s.next(.top); s.toggleLock(.top)
        s.setOnePieceLayout(true)
        #expect(s.visibleRoles == [.outer, .onePiece, .footwear])
        #expect(s.state.selection[.top] == nil && !s.state.locks.contains(.top))
    }

    @Test func locksAndSelectionSurviveRelaunch() async throws {
        let (h, s, w) = try await make()
        s.next(.outer); s.toggleLock(.outer); s.setMode(.explore)
        let again = StudioViewModel(env: try h.relaunched().env, queue: CommandQueue(env: h.env), wardrobe: w)
        #expect(again.state.locks == [.outer])
        #expect(again.state.mode == .explore)
        #expect(again.state.selection[.outer] == s.state.selection[.outer])
    }

    @Test func startsFromABoardOptionWithTheChosenShoe() async throws {
        let (_, s, _) = try await make()
        let t = try Fixtures.today
        let garments = Dictionary(uniqueKeysWithValues: t.garments.map { ($0.garmentId, $0) })
        let o = t.board!.options[1]
        let olive = o.footwearSlots.first { garments[$0.garmentId]?.name == Names.oliveSneaker }!.garmentId
        s.start(from: BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: garments, footwearSelection: olive))
        #expect(s.state.selection[.footwear] == olive)
        #expect(s.selected(.top)?.garment.name == Names.slateOxford)
    }
}

@Suite("Laundry sheet")
@MainActor
struct LaundryTests {
    func make() async throws -> (Harness, LaundryViewModel) {
        let h = try Harness.make()
        let vm = LaundryViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        return (h, vm)
    }

    @Test func serviceAndHandWashAreSeparate() async throws {
        let (_, vm) = try await make()
        #expect(vm.serviceHamper.map(\.name) == ["Lightweight oxford — moss", "Pima oxford — white"])
        #expect(vm.handWashHamper.map(\.name) == ["Merino — inky blue"])
        #expect(vm.openBatches.count == 1)
    }

    @Test func collectedSnapshotsTheHamper() async throws {
        let (_, vm) = try await make()
        guard case .done(let r) = await vm.collected() else { Issue.record("expected receipt"); return }
        #expect(r.summary == "Collected: Lightweight oxford — moss, Pima oxford — white.")
        #expect(vm.serviceHamper.isEmpty)
        #expect(vm.openBatches.count == 2)
        #expect(await vm.collected() == .refused("Nothing is waiting in the service hamper"))
    }

    @Test func someItemsStillAwayStartsFromBatchMembership() async throws {
        let (h, vm) = try await make()
        _ = await vm.collected()
        let batch = try #require(vm.openBatches.first { $0.status == "collected" })
        vm.beginException(for: batch)
        #expect(await vm.confirmSomeStillAway() == .refused("Mark what is still away"))
        vm.setStillAway("g_not_in_batch", quantity: 1) // not part of the batch: ignored
        let moss = batch.items.first { vm.name($0.garmentId, in: batch) == "Lightweight oxford — moss" }!.garmentId
        vm.setStillAway(moss, quantity: 5) // bounded by what went out
        #expect(vm.stillAway == [moss: 1])
        guard case .done(let r) = await vm.confirmSomeStillAway() else { Issue.record("expected receipt"); return }
        #expect(r.summary == "Returned, except Lightweight oxford — moss.")
        let env = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").last?.body))
        #expect(env.command.type == "laundry_partial_return")
        #expect(env.command["batchId"]?.stringValue == batch.batchId)
        #expect(vm.editingBatchId == nil)
    }

    @Test func socksWashedClearsTheHandWashHamperOnly() async throws {
        let (_, vm) = try await make()
        guard case .done(let r) = await vm.socksWashed() else { Issue.record("expected receipt"); return }
        #expect(r.summary == "Socks washed: Merino — inky blue ×1.")
        #expect(vm.handWashHamper.isEmpty)
        #expect(vm.serviceHamper.count == 2)
    }
}

@Suite("Settings and My style")
@MainActor
struct SettingsTests {
    @Test func gmailAndCalendarComeFirstAndAssistantsAreSeparate() async throws {
        let h = try Harness.make()
        let vm = SettingsViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        #expect(vm.services.map(\.kind).prefix(2) == ["gmail", "calendar"])
        #expect(vm.assistants.map(\.displayName) == ["ChatGPT", "Claude"])
        #expect(vm.deliveryTime == "07:00")
        #expect(vm.optionCount == 5)
    }

    @Test func missingPermissionNamesTheCapabilityNotAnErrorScreen() async throws {
        let h = try Harness.make()
        let vm = SettingsViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        let cal = try #require(vm.services.first { $0.kind == "calendar" })
        #expect(vm.summary(cal) == "Read the day ahead and Publish the morning outfit event paused until you reconnect. Last worked Sun 4 Oct 21:30: Read Monday's events.")
        #expect(vm.reconnectURL(cal) != nil)
    }

    @Test func disconnectingAnAssistantRevokesOnlyThatGrant() async throws {
        let h = try Harness.make()
        let vm = SettingsViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        let chatgpt = try #require(vm.assistants.first { $0.client == "chatgpt" })
        #expect(chatgpt.grantId.hasPrefix("mgr_"))
        #expect(vm.summary(chatgpt).hasPrefix("Read only · last used"))
        await vm.disconnect(chatgpt)
        #expect(vm.lastDisconnect?.remoteRevocation == "revoked")
        #expect(vm.assistants.first { $0.client == "chatgpt" }?.status == "revoked")
        #expect(vm.assistants.first { $0.client == "claude" }?.status == "active")
        #expect(vm.assistants.first?.client == "claude") // active grants first
        #expect(vm.services.first { $0.kind == "gmail" }?.status == "connected")
        let body = try #require(await h.server.requests(matching: "/v1/connections/\(chatgpt.grantId)/disconnect").last)
        #expect(body.method == "POST")
    }

    @Test func relativeReconnectURLsResolveAgainstTheAPIOrigin() async throws {
        let h = try Harness.make()
        let vm = SettingsViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        let cal = try #require(vm.services.first { $0.kind == "calendar" })
        #expect(vm.reconnectURL(cal)?.absoluteString.hasPrefix("https://test.garderobe.invalid/v1/connections/") == true)
        #expect(vm.session?.displayName == "Chris")
        #expect(vm.modelsSimulated)
        #expect(vm.settings?.styleDocuments.first?.version == 1)
    }

    func style() async throws -> (Harness, MyStyleViewModel) {
        let h = try Harness.make()
        let q = CommandQueue(env: h.env)
        let vm = MyStyleViewModel(env: h.env, queue: q)
        await vm.load()
        return (h, vm)
    }

    @Test func myStyleShowsTheOwnersFullProfileWithItsVersion() async throws {
        let (_, vm) = try await style()
        let d = try #require(vm.document)
        #expect(d.body.hasPrefix("# Chris — Taste, Formation, Preferences and Operating Rules"))
        #expect(d.body.contains("Socks always, wicking merino by default."))
        #expect(vm.isVerbatim == true)
        #expect(vm.versionLine == "Version 1 · written 14 September 2026 · as you supplied it · 14,960 bytes")
        #expect(vm.ruleLine == "41 rules drawn from this text, 30 of them hard constraints")
        let titles = vm.sections.map(\.title)
        #expect(titles.contains("11. How advice should arrive"))
        #expect(titles.contains("8. Hard constraints"))
        #expect(titles.count == 12)
        // Nothing is summarised away: sections reassemble every line of the document.
        #expect(vm.sections.map(\.body).joined().count > d.body.count - 1000)
    }

    @Test func editingSavesANewVerbatimVersionAgainstTheBaseVersion() async throws {
        let (h, vm) = try await style()
        vm.beginEditing()
        vm.draft += "\n\nAddendum: loafers now welcome with socks.\n"
        vm.amendment = "Loafers"
        await vm.save()
        #expect(vm.saveState == .saved(version: 2))
        #expect(vm.document?.version == 2)
        #expect(vm.document?.body.hasSuffix("Addendum: loafers now welcome with socks.\n") == true)
        #expect(vm.isVerbatim == true)
        let env = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").last?.body))
        #expect(env.command["baseVersion"]?.intValue == 1)
        #expect(env.command["amendment"]?.stringValue == "Loafers")
        #expect(!vm.isEditing)
    }

    @Test func aConcurrentEditConflictsAndKeepsTheDraft() async throws {
        let (h, vm) = try await style()
        vm.beginEditing()
        vm.draft += "\nMine."
        // Someone else saves version 2 first (e.g. a chat correction).
        let other = CommandQueue(env: h.env)
        _ = await other.submit(.editStyleProfile(documentId: vm.document!.documentId, baseVersion: 1, body: vm.document!.body + "\nTheirs."), label: "other")
        await vm.save()
        guard case .conflict = vm.saveState else { Issue.record("expected conflict"); return }
        #expect(vm.draft.hasSuffix("Mine."))
        #expect(vm.isEditing)
        #expect(vm.document?.version == 2)
    }

    @Test func anUnsavedEditSurvivesRelaunch() async throws {
        let (h, vm) = try await style()
        vm.beginEditing()
        vm.draft += "\nHalf-written thought"
        let again = MyStyleViewModel(env: try h.relaunched().env, queue: CommandQueue(env: h.env))
        #expect(again.isEditing)
        #expect(again.draft.hasSuffix("Half-written thought"))
        vm.cancelEditing()
        let third = MyStyleViewModel(env: try h.relaunched().env, queue: CommandQueue(env: h.env))
        #expect(!third.isEditing)
    }

    @Test func deliveryChangesSendOnlyWhatChangedAndClampTheCount() async throws {
        let h = try Harness.make()
        let vm = SettingsViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        guard case .done = await vm.updateDelivery(time: "06:45", optionCount: 9) else { Issue.record("expected receipt"); return }
        let env = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").last?.body))
        #expect(env.command.type == "update_delivery_settings")
        #expect(env.command["dailyOptionCount"] == nil)
        #expect(env.command["deliveryTime"]?.stringValue == "06:45")
        #expect(env.command["calendarId"] == nil)
        #expect(vm.deliveryTime == "06:45")
        #expect(await vm.updateDelivery(time: "06:45", optionCount: 5) == .refused("Nothing changed"))
        guard case .done = await vm.updateDelivery(time: nil, optionCount: nil, calendar: .set("outfits@group.calendar.google.com")) else { Issue.record("calendar"); return }
        #expect(vm.calendarId == "outfits@group.calendar.google.com")
        guard case .done = await vm.updateDelivery(time: nil, optionCount: nil, calendar: .clear) else { Issue.record("clear"); return }
        let cleared = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").last?.body))
        #expect(cleared.command["calendarId"] == .null)
        #expect(vm.calendarId == nil)
    }
}

@Suite("State restoration")
@MainActor
struct RestorationTests {
    @Test func tabPathDraftLocksAndAnchorSurvive() async throws {
        let store = MemoryClientStore()
        let (app, _) = try AppModel.demo(store: store)
        await app.bootstrap()
        app.selectedTab = .wardrobe
        app.wardrobePath = [app.wardrobe.allItems[3].id]
        app.conversation.draft = "Is the chore coat too heavy for 17°?"
        app.conversation.readingAnchor = "msg_july1"
        app.studio.next(.outer)
        app.studio.toggleLock(.outer)

        let (again, _) = try AppModel.demo(store: store)
        #expect(again.selectedTab == .wardrobe)
        #expect(again.wardrobePath == app.wardrobePath)
        #expect(again.conversation.draft == "Is the chore coat too heavy for 17°?")
        #expect(again.conversation.readingAnchor == "msg_july1")
        #expect(again.studio.state.locks == [.outer])
        // The cached board is there before any network call.
        #expect(again.today.cards.count == 5)
    }

    @Test func askAboutThisFromTodaySwitchesToConversationWithTheIdentity() async throws {
        let (app, _) = try AppModel.demo()
        await app.bootstrap()
        let card = app.today.cards[2]
        app.askAbout(optionId: card.optionId)
        #expect(app.selectedTab == .conversation)
        #expect(app.conversation.attachments.first?.reference == .option(boardId: card.boardId, optionId: card.optionId, boardRevision: 2))
        #expect(app.conversation.attachments.first?.label.hasPrefix("Option 3: ") == true)
    }
}
