import Foundation
import Testing
@testable import GarderobeKit

/// The flows that were listed as gaps and are now closed: another outfit followed to its end,
/// clearing a day brief, packing chosen quantities, projects offline, Undo on an old transcript
/// receipt, and the candidate image in the review. All data here is SYNTHETIC.
private enum Gap {
    static let extraOption = Synthetic.option("opt_x", number: 1, name: "Test dinner outfit", garments: [
        Synthetic.line("gmt_test_knit", "top", "Test grey jumper"), Synthetic.line("gmt_test_jeans", "bottom", "Test dark jeans"),
        Synthetic.line("gmt_test_sneakers", "footwear", "Test grey sneakers"),
    ], alternatives: [Synthetic.line("gmt_test_derbies", "footwear", "Test brown derbies")])

    static func recommend(state: String, runId: String?, options: [JSONValue]) -> JSONValue {
        ["state": .string(state), "runId": runId.map(JSONValue.string) ?? .null, "localDate": .string(Synthetic.today), "options": .array(options), "board": .null,
         "insufficient": false, "note": .null, "wardrobeRevision": 5, "readAt": .string(Synthetic.now)]
    }

    static func run(_ id: String, state: String, options: [JSONValue] = [], lastEventId: Int, error: JSONValue = .null) -> JSONValue {
        guard case .object(var run) = Synthetic.run(id, state: state, lastEventId: lastEventId) else { return .null }
        run["kind"] = "recommendation"
        if !options.isEmpty { run["result"] = ["reply": .null, "options": .array(options), "board": .null, "research": .null, "exportId": .null, "importId": .null] }
        run["error"] = error
        return .object(run)
    }

    static func style(briefs: [JSONValue]) -> JSONValue {
        guard case .object(var context) = Synthetic.styleContext() else { return .null }
        context["briefs"] = .array(briefs)
        return .object(context)
    }

    static func brief(_ id: String, date: String = Synthetic.today, status: String = "active") -> JSONValue {
        ["briefId": .string(id), "localDate": .string(date), "text": "Test dinner at eight", "status": .string(status), "source": ["kind": "owner_statement"], "createdAt": .string(Synthetic.now)]
    }

    static func trip(packed: [JSONValue] = []) -> JSONValue {
        ["tripId": "trp_test", "version": 1, "name": "Test trip", "departsOn": "2026-09-20", "returnsOn": "2026-09-23",
         "destinations": [["label": "Test city", "timezone": "Europe/Paris", "from": "2026-09-20", "to": "2026-09-23"]], "occasions": [], "luggage": .null, "laundry": [],
         "status": "planned", "packed": .array(packed), "proposal": .null]
    }

    static func project(_ id: String, title: String, state: String, updatedAt: String, garmentId: String? = nil) -> JSONValue {
        let items: [JSONValue] = garmentId.map { [["garmentId": .string($0), "quantity": 2, "state": "with_consignor", "proceedsMinor": .null, "currency": .null]] } ?? []
        return ["projectId": .string(id), "version": 1, "kind": "consignment", "state": .string(state), "title": .string(title), "destination": "Test consignor", "nextAction": "Test: confirm the price",
                "details": [:], "items": .array(items), "authorizations": [], "events": [], "createdAt": .string(Synthetic.now), "updatedAt": .string(updatedAt)]
    }

    static func ref(_ id: String, undoAvailable: Bool = true, type: String = "care.mark_dirty") -> RunReceiptRef {
        RunReceiptRef(commandId: id, type: type, outcome: "committed", summary: "Test shirt marked for the wash", undoAvailable: undoAvailable)
    }
}

@MainActor
@Suite("Closed gaps: another outfit, clearing a brief, packing, projects offline, old receipts, review image")
struct ClosedGapTests {
    @Test("Another outfit is followed to completion: being prepared is not shown as ready, and the finished outfit logs one shoe")
    func anotherOutfitFollowed() async throws {
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/today", Synthetic.todayResponse(board: Synthetic.board()))
        router.json("POST", "/v1/recommendations", Gap.recommend(state: "running", runId: "run_x", options: []))
        transport.setStream(path: "/v1/runs/run_x/events", chunks: [Synthetic.sse([
            Synthetic.event(1, run: "run_x", type: "run_started", data: ["kind": "recommendation"]),
            Synthetic.event(2, run: "run_x", type: "run_finished", data: ["state": "completed"]),
        ])])
        router.json("GET", "/v1/runs/run_x", Gap.run("run_x", state: "completed", options: [Gap.extraOption], lastEventId: 2))
        router.on("POST", "/v1/commands") { request in
            TestSupport.json(TestSupport.receipt(commandId: "cmd_w", type: TestSupport.body(request)["type"]?.stringValue ?? "", summary: "Recorded"))
        }
        let model = TodayModel(environment: TestSupport.environment(transport: transport), sleep: { _ in })
        await model.open()

        await model.requestAnother(brief: "Dinner out")
        let sent = TestSupport.body(try #require(transport.requests("POST", "/v1/recommendations").first))
        #expect(sent["brief"]?.stringValue == "Dinner out" && sent["mode"]?.stringValue == "preview")
        #expect(model.anotherState == .ready)
        #expect(model.anotherRunId == nil)
        #expect(model.extraPresentations.map(\.id) == ["opt_x"])
        #expect(model.options.count == 2)                                // the board itself is untouched

        // The same one-shoe handling as a board option.
        let extra = try #require(model.extraPresentations.first)
        #expect(extra.footwearChoices.count == 2 && extra.selectedFootwearId == "gmt_test_sneakers")
        model.pickFootwear(optionId: "opt_x", garmentId: "gmt_test_derbies")
        await model.woreExtra(optionId: "opt_x")
        let ids = transport.commands.first?["payload"]?["garmentIds"]?.arrayValue?.compactMap(\.stringValue)
        #expect(ids == ["gmt_test_knit", "gmt_test_jeans", "gmt_test_derbies"])
        #expect(transport.commands.first?["type"]?.stringValue == "wear.record")
    }

    @Test("A lost stream leaves the request as still being prepared, survives a relaunch and is picked up again; a failure is said plainly")
    func anotherOutfitResumedAndFailed() async {
        let router = Router()
        let transport = router.transport
        let store = InMemoryKeyValueStore()
        router.json("GET", "/v1/today", Synthetic.todayResponse(board: Synthetic.board()))
        router.json("POST", "/v1/recommendations", Gap.recommend(state: "running", runId: "run_x", options: []))
        router.json("GET", "/v1/runs/run_x", Gap.run("run_x", state: "running", lastEventId: 1))
        let model = TodayModel(environment: TestSupport.environment(transport: transport, store: store), sleep: { _ in })
        await model.requestAnother(brief: nil)                           // no stream is available: every reconnect fails
        #expect(model.anotherState == .connectionLost)
        #expect(model.extraPresentations.isEmpty)
        #expect(model.anotherRunId == "run_x")

        // Relaunch: the unfinished request is remembered, not presented as done.
        let relaunched = TodayModel(environment: TestSupport.environment(transport: transport, store: store), sleep: { _ in })
        #expect(relaunched.anotherRunId == "run_x" && relaunched.anotherState == .connectionLost)
        transport.setStream(path: "/v1/runs/run_x/events", chunks: [Synthetic.sse([Synthetic.event(2, run: "run_x", type: "run_finished", data: ["state": "failed"])])])
        router.json("GET", "/v1/runs/run_x", Gap.run("run_x", state: "failed", lastEventId: 2, error: ["code": "budget_exhausted", "message": "Today's assistance budget is used up.", "resumable": false]))
        await relaunched.resumeAnother()
        #expect(relaunched.anotherState == .failed("Today's assistance budget is used up."))
        #expect(relaunched.anotherRunId == nil)

        // An immediate answer needs no run at all.
        router.json("POST", "/v1/recommendations", Gap.recommend(state: "completed", runId: nil, options: [Gap.extraOption]))
        await relaunched.requestAnother(brief: nil)
        #expect(relaunched.anotherState == .ready && relaunched.extraPresentations.count == 1)
        relaunched.dismissAnother()
        #expect(relaunched.anotherState == .idle && relaunched.extraPresentations.isEmpty)
    }

    @Test("Clearing the day's brief retires exactly today's active brief; with none, nothing is sent")
    func clearBrief() async throws {
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/today", Synthetic.todayResponse(board: Synthetic.board()))
        router.json("GET", "/v1/style", Gap.style(briefs: [Gap.brief("brf_old", date: "2026-09-14"), Gap.brief("brf_retired", status: "retired"), Gap.brief("brf_today")]))
        router.on("POST", "/v1/commands") { request in
            router.json("GET", "/v1/style", Gap.style(briefs: [Gap.brief("brf_today", status: "retired")]))
            return TestSupport.json(TestSupport.receipt(commandId: "cmd_c", type: TestSupport.body(request)["type"]?.stringValue ?? "", summary: "Brief retired"))
        }
        let model = TodayModel(environment: TestSupport.environment(transport: transport))
        await model.open()

        let outcome = await model.clearBrief()
        #expect(outcome?.receipt?.commandId == "cmd_c")
        let envelope = try #require(transport.commands.first)
        #expect(envelope["type"]?.stringValue == "style.retire_brief")
        #expect(envelope["payload"] == ["briefId": "brf_today"])
        #expect(model.briefText == nil)

        let again = await model.clearBrief()
        #expect(again == nil)
        #expect(transport.commands.count == 1)
        #expect(model.briefNote == "There is no brief for 15 September.")
    }

    @Test("When the style context does not list the day's briefs, the brief set on this phone is cleared by its receipt's ID; one set elsewhere is not guessed at")
    func clearBriefFromReceipt() async throws {
        let router = Router()
        let transport = router.transport
        let briefed: JSONValue = { guard case .object(var b) = Synthetic.board(), case .object(var brief)? = b["brief"] else { return .null }; brief["text"] = "Test dinner at eight"; b["brief"] = .object(brief); return .object(b) }()
        router.json("GET", "/v1/today", Synthetic.todayResponse(board: briefed))
        router.json("GET", "/v1/style", Gap.style(briefs: []))
        router.on("POST", "/v1/commands") { request in
            let type = TestSupport.body(request)["type"]?.stringValue ?? ""
            guard case .object(var receipt) = TestSupport.receipt(commandId: "cmd_\(type)", type: type, summary: "Recorded") else { return TestSupport.json(.null) }
            if type == "style.set_brief" { receipt["result"] = ["briefId": "brf_mine", "localDate": .string(Synthetic.today)] }
            return TestSupport.json(.object(receipt))
        }
        let elsewhere = TodayModel(environment: TestSupport.environment(transport: transport))
        await elsewhere.open()
        let refused = await elsewhere.clearBrief()                       // set by MCP or another device: no ID is known here
        #expect(refused == nil)
        #expect(transport.commands.isEmpty)
        #expect(elsewhere.briefNote?.hasPrefix("This brief was not set on this phone") == true)

        let model = TodayModel(environment: TestSupport.environment(transport: transport))
        await model.open()
        await model.setBrief("Test dinner at eight")
        let outcome = await model.clearBrief()
        #expect(outcome?.receipt?.type == "style.retire_brief")
        #expect(transport.commands.last?["payload"] == ["briefId": "brf_mine"])
        #expect(model.briefText == nil)                                  // cleared, even though the board was composed with it
        let again = await model.clearBrief()
        #expect(again == nil)
        #expect(transport.commands.count == 2)
    }

    @Test("Packing other items: only clean owned garments are offered, a quantity cannot exceed what is clean, and one command records the choice")
    func packingPicker() async throws {
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/trips", ["trips": [Gap.trip()]])
        router.on("POST", "/v1/commands") { _ in
            router.json("GET", "/v1/trips", ["trips": [Gap.trip(packed: [["garmentId": "gmt_test_socks", "name": "Test navy socks", "clean": 3, "worn": 0]])]])
            return TestSupport.json(TestSupport.receipt(commandId: "cmd_p", type: "stock.pack", summary: "Packed 4 items"))
        }
        let env = TestSupport.environment(transport: transport)
        let trips = TripsModel(environment: env)
        await trips.open()
        let items = try [
            Synthetic.inventoryItem("gmt_test_socks", name: "Test navy socks", category: "socks", roles: ["socks"], balances: [("clean", 5), ("dirty", 2)]),
            Synthetic.inventoryItem("gmt_test_shirt", name: "Test blue oxford shirt", aliases: ["the blue one"]),
            Synthetic.inventoryItem("gmt_test_dirty", name: "Test dirty shirt", balances: [("dirty", 1)]),
            Synthetic.inventoryItem("gmt_test_incoming", name: "Test ordered shirt", acquisition: "incoming", balances: [("incoming", 1)]),
        ].map { try $0.decoded(as: InventoryItem.self) }
        let picker = PackingPickerModel(environment: env, trips: trips, tripId: "trp_test", candidates: items)
        #expect(picker.rows.map(\.id) == ["gmt_test_shirt", "gmt_test_socks"])    // nothing dirty or not yet owned
        picker.search = "blue one"
        #expect(picker.rows.map(\.id) == ["gmt_test_shirt"])                     // the owner's own name finds it
        picker.search = ""

        let nothing = await picker.pack()
        #expect(nothing == nil)
        picker.setQuantity(9, for: "gmt_test_socks")
        #expect(picker.rows.first { $0.id == "gmt_test_socks" }?.quantity == 5)   // capped at what is clean at home
        picker.setQuantity(3, for: "gmt_test_socks")
        picker.setQuantity(1, for: "gmt_test_shirt")
        picker.setQuantity(1, for: "gmt_test_dirty")                              // not offered, so not accepted
        #expect(picker.summaryLine == "Pack 4 items")

        let outcome = await picker.pack()
        #expect(outcome?.receipt?.commandId == "cmd_p")
        #expect(transport.commands.count == 1)
        let expected: JSONValue = ["tripId": "trp_test", "items": [["garmentId": "gmt_test_shirt", "quantity": 1], ["garmentId": "gmt_test_socks", "quantity": 3]]]
        #expect(transport.commands.first?["payload"] == expected)
        #expect(picker.selectedUnits == 0)
        #expect(picker.rows.first { $0.id == "gmt_test_socks" }?.alreadyPacked == 3)
    }

    @Test("Projects are kept on the phone: offline the saved list is shown with when it was checked, open ones first")
    func projectsOffline() async {
        let router = Router()
        let store = InMemoryKeyValueStore()
        router.json("GET", "/v1/projects", ["projects": [
            Gap.project("prj_done", title: "Test sold coat", state: "completed", updatedAt: "2026-09-14T10:00:00Z"),
            Gap.project("prj_open", title: "Test consign two jackets", state: "awaiting_owner", updatedAt: "2026-09-10T10:00:00Z", garmentId: "gmt_test_jacket"),
        ]])
        let online = ProjectsModel(environment: TestSupport.environment(transport: router.transport, store: store))
        await online.open()
        #expect(online.all.map(\.projectId) == ["prj_open", "prj_done"])
        #expect(online.summaryLine(online.all[0]) == "Consignment · Waiting for you · 2 items")
        #expect(online.projects(forGarment: "gmt_test_jacket").map(\.projectId) == ["prj_open"])

        router.offline.value = true
        let offline = ProjectsModel(environment: TestSupport.environment(transport: router.transport, store: store))
        await offline.open()
        #expect(offline.all.map(\.projectId) == ["prj_open", "prj_done"])
        #expect(offline.unavailableLine == nil)
        #expect(offline.freshnessLine.hasPrefix("Offline."))
        #expect(offline.freshnessLine.contains("last checked"))

        // Never saved and unreachable: it says so rather than showing an empty list as the truth.
        let never = ProjectsModel(environment: TestSupport.environment(transport: router.transport))
        await never.open()
        #expect(!never.isEmpty)
        #expect(never.unavailableLine == "Offline. Projects have not been saved on this phone yet.")
    }

    @Test("A receipt on an old transcript message can be undone by its command ID, once, and stays undone after a relaunch")
    func undoOldTranscriptReceipt() async throws {
        let router = Router()
        let transport = router.transport
        let store = InMemoryKeyValueStore()
        router.on("POST", "/v1/commands") { _ in TestSupport.json(TestSupport.receipt(commandId: "cmd_undo", type: "command.undo", summary: "Undone", undoAvailable: false)) }
        let env = TestSupport.environment(transport: transport, store: store)
        let center = env.center
        let ref = Gap.ref("cmd_old")
        #expect(center.receipts.isEmpty)                                 // the full receipt is not on this phone
        #expect(center.undoState(for: ref) == .available)
        #expect(center.undoState(for: Gap.ref("cmd_fixed", undoAvailable: false)) == .unavailable)
        #expect(center.undoState(for: Gap.ref("cmd_u", type: "command.undo")) == .unavailable)

        let outcome = await center.undo(ref)
        #expect(outcome?.receipt?.commandId == "cmd_undo")
        let envelope = try #require(transport.commands.first)
        #expect(envelope["type"]?.stringValue == "command.undo")
        #expect(envelope["payload"] == ["commandId": "cmd_old"])
        #expect(center.undoState(for: ref) == .undone)
        #expect(center.banner == nil)                                    // an undo offers no undo of itself
        let second = await center.undo(ref)
        #expect(second == nil)
        #expect(transport.commands.count == 1)

        let relaunched = TestSupport.environment(transport: transport, store: store)
        #expect(relaunched.center.undoState(for: ref) == .undone)
    }

    @Test("Offline, an undo from an old receipt waits on the phone and cannot be queued twice")
    func undoOldReceiptOffline() async {
        let router = Router()
        router.offline.value = true
        let env = TestSupport.environment(transport: router.transport)
        let ref = Gap.ref("cmd_old")
        let outcome = await env.center.undo(ref)
        #expect(outcome == .queued)
        #expect(env.center.undoState(for: ref) == .waiting)              // waiting, not undone
        let again = await env.center.undo(ref)
        #expect(again == nil)
        #expect(env.center.pending.count == 1)
    }

    @Test("Image review loads the candidate's own image, caches it, and shows nothing in its place when there is none")
    func candidateImage() async throws {
        func item(_ id: String, asset: JSONValue) -> JSONValue {
            ["candidateId": .string(id), "garmentId": "gmt_test_shirt", "garmentName": "Test blue oxford shirt", "assetId": asset, "pageUrl": .null,
             "question": "Is this your shirt?", "evidence": [:], "createdAt": .string(Synthetic.now)]
        }
        let router = Router()
        let transport = router.transport
        router.on("GET", "/v1/media/assets/ast_test") { _ in HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Data([1, 2, 3, 4])) }
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in HTTPResponse(status: 200, body: Data([9])) }
        let env = TestSupport.environment(transport: transport)
        let loader = GarmentImageLoader(environment: env)
        let withAsset = try item("mrc_1", asset: "ast_test").decoded(as: MediaReviewItem.self)
        let without = try item("mrc_2", asset: .null).decoded(as: MediaReviewItem.self)
        let gone = try item("mrc_3", asset: "ast_gone").decoded(as: MediaReviewItem.self)

        let first = await loader.data(forCandidate: withAsset, width: 320)
        #expect(first == Data([1, 2, 3, 4]))
        #expect(transport.requests.last?.query.contains(URLQueryItem(name: "width", value: "320")) == true)
        let second = await loader.data(forCandidate: withAsset, width: 320)
        #expect(second == Data([1, 2, 3, 4]))
        #expect(transport.requests("GET", "/v1/media/assets/ast_test").count == 1)   // the bytes do not change: cached

        let none = await loader.data(forCandidate: without, width: 320)
        #expect(none == nil)
        let missing = await loader.data(forCandidate: gone, width: 320)
        #expect(missing == nil)
        #expect(transport.requests("GET", "/v1/items/gmt_test_shirt/image").isEmpty)  // the garment's current picture never stands in
    }
}
