import Testing
import Foundation
@testable import GarderobeKit

@MainActor
@Suite("Today: cached board first, honest freshness, choose is not wear, one shoe is logged")
struct TodayModelTests {
    private func setup(board: JSONValue = Synthetic.board(), dayRecord: [JSONValue] = [], freshness: [JSONValue] = []) -> (Router, ScriptedTransport, AppEnvironment, ManualTimeSource, InMemoryKeyValueStore) {
        let router = Router()
        router.json("GET", "/v1/today", Synthetic.todayResponse(board: board, dayRecord: dayRecord, freshness: freshness))
        router.on("POST", "/v1/commands") { request in
            let body = TestSupport.body(request)
            return TestSupport.json(TestSupport.receipt(commandId: "cmd_\(body["type"]?.stringValue ?? "")", type: body["type"]?.stringValue ?? "", summary: "Recorded"))
        }
        let transport = router.transport
        let time = ManualTimeSource(instant: Synthetic.now)
        let store = InMemoryKeyValueStore()
        return (router, transport, TestSupport.environment(transport: transport, store: store, time: time), time, store)
    }

    @Test("Today leads with the date and shows options whose VoiceOver label names the garments")
    func presentsOptions() async throws {
        let (_, _, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()

        #expect(model.dateLine == "Tuesday 15 September")
        #expect(model.board?.weatherLine == "12 °C leaving, 18 °C later; dry")
        #expect(model.options.count == 2)
        let label = try #require(model.options.first?.accessibilityLabel)
        #expect(label.contains("Test blue oxford shirt") && label.contains("Test stone chinos") && label.contains("Test grey sneakers"))
        #expect(!label.lowercased().contains("outfit 1"))
        #expect(model.freshnessLine == "Checked today at 07:30.")
    }

    @Test("On relaunch the cached board is shown before any request, labelled with when it was checked")
    func cachedFirst() async {
        let (router, transport, env, time, store) = setup()
        await TodayModel(environment: env).open()

        // Next morning, no network.
        time.advance(24 * 3600)
        router.offline.value = true
        let relaunched = TestSupport.environment(transport: transport, store: store, time: time)
        let model = TodayModel(environment: relaunched)
        let before = transport.requests.count
        model.today.loadCached()
        #expect(model.options.count == 2)             // on screen with no request made
        #expect(transport.requests.count == before)
        #expect(model.today.origin == .cache)

        await model.refresh()
        #expect(model.options.count == 2)             // the layout keeps its content when the refresh fails
        #expect(model.freshnessLine == "Offline. Board last checked yesterday at 07:30.")
        #expect(!model.today.freshness.isCurrent)
    }

    @Test("Choose sends board.select against the board revision: an intention, never a wear")
    func chooseIsIntention() async throws {
        let (_, transport, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()
        await model.choose(optionId: "opt_b")

        let command = try #require(transport.commands.first)
        #expect(command["type"]?.stringValue == "board.select")
        #expect(command["payload"]?["boardId"]?.stringValue == "brd_test")
        #expect(command["payload"]?["optionId"]?.stringValue == "opt_b")
        #expect(command["expectedVersions"]?["board:brd_test"]?.intValue == 3)
        #expect(!transport.commands.contains { $0["type"]?.stringValue == "wear.record" })
    }

    @Test("With two footwear alternatives, picking a shoe updates the visible outfit and I wore this logs exactly that one")
    func oneShoeIsLogged() async throws {
        let (_, transport, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()

        let before = try #require(model.options.first)
        #expect(before.footwearChoices.map(\.garmentId) == ["gmt_test_sneakers", "gmt_test_derbies"])
        #expect(before.selectedFootwearId == "gmt_test_sneakers")

        model.pickFootwear(optionId: "opt_a", garmentId: "gmt_test_derbies")
        let after = try #require(model.options.first)
        #expect(after.visibleGarments.filter { $0.role == .footwear }.map(\.garmentId) == ["gmt_test_derbies"])
        #expect(transport.commands.isEmpty) // picking a shoe sends nothing

        await model.woreThis(optionId: "opt_a")
        let wear = try #require(transport.commands.first)
        #expect(wear["type"]?.stringValue == "wear.record")
        #expect(wear["payload"]?["wearingDate"]?.stringValue == "2026-09-15")
        let ids = wear["payload"]?["garmentIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
        #expect(ids == ["gmt_test_shirt", "gmt_test_chinos", "gmt_test_belt", "gmt_test_socks", "gmt_test_derbies"])
        #expect(!ids.contains("gmt_test_sneakers"))
        #expect(wear["expectedVersions"] == nil) // an owner observation carries no version to conflict on
    }

    @Test("A shoe that is not one of the option's alternatives cannot be picked")
    func foreignShoeRejected() async {
        let (_, _, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()
        model.pickFootwear(optionId: "opt_a", garmentId: "gmt_test_knit")
        #expect(model.options.first?.selectedFootwearId == "gmt_test_sneakers")
    }

    @Test("The flourish is recorded only when the owner says he wore it")
    func flourishOnlyOnRequest() async throws {
        let (_, transport, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()
        #expect(model.options.first?.wearGarmentIds.contains("gmt_test_scarf") == false)
        model.setFlourishWorn(true, optionId: "opt_a")
        await model.woreThis(optionId: "opt_a")
        let ids = transport.commands.first?["payload"]?["garmentIds"]?.arrayValue?.compactMap(\.stringValue) ?? []
        #expect(ids.last == "gmt_test_scarf")
    }

    @Test("The footwear stored with a selection is what the chosen option shows")
    func selectionFootwearShown() async {
        let selection: JSONValue = ["optionId": "opt_a", "footwearGarmentId": "gmt_test_derbies", "selectedAt": .string(Synthetic.now)]
        let (_, _, env, _, _) = setup(board: Synthetic.board(selection: selection))
        let model = TodayModel(environment: env)
        await model.open()
        #expect(model.options.first?.isChosen == true)
        #expect(model.options.first?.selectedFootwearId == "gmt_test_derbies")
    }

    @Test("Offline, I wore this is kept on the phone, shown as waiting, and nothing is presented as recorded")
    func offlineWear() async {
        let (router, _, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()
        router.offline.value = true

        let outcome = await model.woreThis(optionId: "opt_b")
        #expect(outcome == .queued)
        #expect(model.queuedHere.map(\.envelope.type) == ["wear.record"])
        #expect(!model.hasDayRecord)
        #expect(env.center.receipts.isEmpty)

        router.offline.value = false
        await env.center.replay()
        #expect(model.queuedHere.isEmpty)
        #expect(env.center.receipts.count == 1)
    }

    @Test("Online, a swap goes through the swap route against the revision on screen and its receipt is kept like any other")
    func swapOneSlot() async throws {
        let (router, transport, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()
        router.on("POST", "/v1/boards/brd_test/swap") { _ in
            router.json("GET", "/v1/today", Synthetic.todayResponse(board: Synthetic.board(revision: 4)))
            return TestSupport.json(["board": Synthetic.board(revision: 4), "receipt": TestSupport.receipt(commandId: "cmd_swap", type: "board.swap_slot", summary: "Swapped", undoAvailable: false)])
        }
        let outcome = await model.swap(optionId: "opt_a", role: .top)
        #expect(outcome?.receipt?.commandId == "cmd_swap")
        let body = TestSupport.body(try #require(transport.requests("POST", "/v1/boards/brd_test/swap").first))
        #expect(body["optionId"]?.stringValue == "opt_a" && body["role"]?.stringValue == "top")
        #expect(body["expectedRevision"]?.intValue == 3)
        #expect(body["garmentId"] == nil)                                // the backend chooses the replacement
        #expect(body["clientRequestId"]?.stringValue?.isEmpty == false)
        #expect(transport.commands.isEmpty)                              // not sent a second time as a command
        #expect(env.center.receipts.first?.id == "cmd_swap")
        #expect(model.board?.revision == 4)
    }

    @Test("Offline, the same swap waits on the phone as a command; a refused swap is shown as refused and the current board is loaded")
    func swapOfflineAndRefused() async throws {
        let (router, transport, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()
        router.offline.value = true
        let queued = await model.swap(optionId: "opt_a", role: .top, to: "gmt_test_knit")
        #expect(queued == .queued)
        let waiting = try #require(env.center.pending.first)
        #expect(waiting.envelope.type == "board.swap_slot")
        #expect(waiting.envelope.payload["garmentId"]?.stringValue == "gmt_test_knit")
        #expect(waiting.envelope.expectedVersions?["board:brd_test"] == 3)

        let (router2, transport2, env2, _, _) = setup()
        let second = TodayModel(environment: env2)
        await second.open()
        router2.on("POST", "/v1/boards/brd_test/swap") { _ in TestSupport.error("conflict", "The board changed; showing the current one.", status: 409) }
        router2.json("GET", "/v1/today", Synthetic.todayResponse(board: Synthetic.board(revision: 5)))
        let refused = await second.swap(optionId: "opt_a", role: .top)
        guard case .rejected(let error)? = refused else { Issue.record("expected a refusal"); return }
        #expect(error.code == .conflict)
        #expect(second.board?.revision == 5)
        #expect(transport2.commands.isEmpty && env2.center.pending.isEmpty) // a refusal is not retried as a command
        _ = transport
    }

    @Test("A board that moved on refuses the edit with a conflict and Today reloads the current board")
    func conflictReloads() async {
        let (router, transport, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()
        router.on("POST", "/v1/commands") { _ in TestSupport.error("conflict", "The board changed; showing the current one.", status: 409) }
        router.json("GET", "/v1/today", Synthetic.todayResponse(board: Synthetic.board(revision: 4)))

        let outcome = await model.choose(optionId: "opt_a")
        guard case .rejected(let error)? = outcome else { Issue.record("expected a conflict"); return }
        #expect(error.code == .conflict)
        #expect(model.board?.revision == 4)
        #expect(transport.requests("GET", "/v1/today").count == 2)
    }

    @Test("Once a wear is recorded the day has a record")
    func dayRecord() async {
        let (_, _, env, _, _) = setup(board: Synthetic.board(validity: "worn"), dayRecord: [Synthetic.line("gmt_test_knit", "top", "Test grey jumper")])
        let model = TodayModel(environment: env)
        await model.open()
        #expect(model.hasDayRecord)
        #expect(model.dayRecord.map(\.name) == ["Test grey jumper"])
    }

    @Test("A disconnected calendar leaves Today available and offers a connection action")
    func calendarDisconnected() async {
        let note: JSONValue = ["source": "calendar", "state": "not_connected", "checkedAt": .null, "revision": .null, "detail": "Calendar is disconnected."]
        let (_, _, env, _, _) = setup(board: Synthetic.board(calendar: "not_connected", projection: "not_connected", action: "Reconnect Calendar in Settings."), freshness: [note])
        let model = TodayModel(environment: env)
        await model.open()
        #expect(model.options.count == 2)
        #expect(model.sourceNotes == ["Calendar is disconnected."])
        #expect(model.calendarAction == "Reconnect Calendar in Settings.")
    }

    @Test("A board with no complete outfit says so in the backend's words, and the owner can ask for outfits; a paused day offers no such request")
    func degradedBoardAndComposeNow() async throws {
        let notice = "No complete outfit is available for this day at the moment."
        let (router, transport, env, _, _) = setup(board: Synthetic.board(options: [], validity: "degraded", notice: notice))
        let model = TodayModel(environment: env, sleep: { _ in })
        await model.open()
        #expect(model.options.isEmpty)
        #expect(model.emptyStatement == notice)
        #expect(model.canAskForOutfits)

        router.on("POST", "/v1/recommendations") { _ in
            router.json("GET", "/v1/today", Synthetic.todayResponse(board: Synthetic.board(revision: 4)))
            return TestSupport.json(["state": "completed", "runId": .null, "localDate": .string(Synthetic.today), "options": .array(Synthetic.standardOptions), "board": Synthetic.board(revision: 4),
                                     "insufficient": false, "note": .null, "wardrobeRevision": 5, "readAt": .string(Synthetic.now)])
        }
        await model.askForOutfits()
        let sent = TestSupport.body(try #require(transport.requests("POST", "/v1/recommendations").first))
        #expect(sent["mode"]?.stringValue == "board")                    // publishes the day's board, unlike a preview
        #expect(model.composeState == .ready)
        #expect(model.options.count == 2 && model.emptyStatement == nil)
        #expect(!model.canAskForOutfits)

        let (pausedRouter, pausedTransport, pausedEnv, _, _) = setup()
        pausedRouter.json("GET", "/v1/today", Synthetic.todayResponse(status: "paused", paused: ["pauseId": "p", "from": "2026-09-14", "resumeOn": .null]))
        let paused = TodayModel(environment: pausedEnv)
        await paused.open()
        #expect(!paused.canAskForOutfits)
        await paused.askForOutfits()
        #expect(pausedTransport.requests("POST", "/v1/recommendations").isEmpty)
    }

    @Test("A paused service explains why there is no board")
    func pausedEmptyState() async {
        let router = Router()
        router.json("GET", "/v1/today", Synthetic.todayResponse(status: "paused", paused: ["pauseId": "p", "from": "2026-09-14", "resumeOn": "2026-09-20"]))
        let model = TodayModel(environment: TestSupport.environment(transport: router.transport))
        await model.open()
        #expect(model.options.isEmpty)
        #expect(model.emptyStatement == "Recommendations are paused until 20 September.")
    }

    @Test("Ask about this attaches the option identity with its board and revision")
    func askAboutIdentity() async throws {
        let (_, _, env, _, _) = setup()
        let model = TodayModel(environment: env)
        await model.open()
        let ref = try #require(model.askAboutReference(optionId: "opt_b"))
        #expect(ref.kind == .boardOption && ref.id == "opt_b" && ref.boardId == "brd_test" && ref.revision == 3)
        #expect(model.askAboutReference(optionId: "opt_missing") == nil)
    }
}
