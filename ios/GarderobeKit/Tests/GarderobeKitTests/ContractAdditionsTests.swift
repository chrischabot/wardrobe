import Foundation
import Testing
@testable import GarderobeKit

/// Contract 1.1.0 surfaces: Save in My style with its fact diff and decisions, bulk edit, an
/// item's measurements, and running a resumable run again. All data here is SYNTHETIC.
private enum Facts {
    static let sha = String(repeating: "b", count: 64)

    static func passage(_ quote: String) -> JSONValue {
        ["documentSha256": .string(sha), "lineStart": 3, "lineEnd": 3, "quote": .string(quote)]
    }

    static func diffConflict(kind: String, id: String, label: String, before: String, now: String?) -> JSONValue {
        ["fact": ["kind": .string(kind), "id": .string(id)], "label": .string(label), "reason": "passage_changed",
         "previousPassages": [passage(before)], "missingQuotes": [.string(before)], "candidateText": now.map(JSONValue.string) ?? .null]
    }

    static func diff(conflicts: [JSONValue] = [], applied: [JSONValue] = [], anchored: Int = 3, unchanged: Int = 1) -> JSONValue {
        ["documentId": "owner-profile", "fromVersion": 1, "contentChanged": true, "anchoredFacts": .integer(anchored), "unchanged": .integer(unchanged),
         "reanchored": [], "applied": .array(applied), "conflicts": .array(conflicts), "addedText": [["lineStart": 3, "lineEnd": 3]]]
    }

    static func conflict(_ id: String, kind: String, factId: String, label: String, now: String? = "Test chest 45 in") -> JSONValue {
        ["conflictId": .string(id), "documentId": "owner-profile", "fromVersion": 1, "toVersion": 2, "fact": ["kind": .string(kind), "id": .string(factId)],
         "label": .string(label), "reason": "passage_changed", "previousPassages": [passage("Test chest 44 in")], "missingQuotes": ["Test chest 44 in"],
         "candidateText": now.map(JSONValue.string) ?? .null, "status": "open", "resolution": .null, "createdAt": .string(Synthetic.now), "resolvedAt": .null]
    }

    static func style(content: String = "Test profile text.\nTest chest 44 in", revision: Int = 2, conflicts: [JSONValue] = []) -> JSONValue {
        guard case .object(var context) = Synthetic.styleContext(content: content, revision: revision) else { return .null }
        context["factConflicts"] = .array(conflicts)
        return .object(context)
    }

    static func receipt(_ id: String, type: String, summary: String, result: JSONValue) -> JSONValue {
        guard case .object(var receipt) = TestSupport.receipt(commandId: id, type: type, summary: summary) else { return .null }
        receipt["result"] = result
        return .object(receipt)
    }
}

@MainActor
@Suite("Contract 1.1.0: My style facts, bulk edit, measurements, run again")
struct ContractAdditionsTests {
    @Test("Save in My style previews what the edit touches, sends only the owner's decisions, and shows the receipt's diff")
    func previewDecideSave() async throws {
        let edited = "Test profile text.\nTest chest 45 in"
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/style", Facts.style())
        router.json("POST", "/v1/style/preview-save", Facts.diff(conflicts: [
            Facts.diffConflict(kind: "measurement", id: "msr_test_chest", label: "body chest: 44 in", before: "Test chest 44 in", now: "Test chest 45 in"),
            Facts.diffConflict(kind: "rule", id: "test.rule", label: "Test rule", before: "Test chest 44 in", now: nil),
        ]))
        router.on("POST", "/v1/commands") { _ in
            router.json("GET", "/v1/style", Facts.style(content: edited, revision: 3, conflicts: [Facts.conflict("sfc_test_1", kind: "rule", factId: "test.rule", label: "Test rule", now: nil)]))
            let applied: JSONValue = ["fact": ["kind": "measurement", "id": "msr_test_chest"], "label": "body chest: 45 in", "action": "replace"]
            let left = Facts.diffConflict(kind: "rule", id: "test.rule", label: "Test rule", before: "Test chest 44 in", now: nil)
            return TestSupport.json(Facts.receipt("cmd_save", type: "style.save_document", summary: "Saved version 2", result: ["factDiff": Facts.diff(conflicts: [left], applied: [applied])]))
        }
        let settings = SettingsModel(environment: TestSupport.environment(transport: transport))
        await settings.style.refresh()

        let previewed = await settings.previewSave(content: edited)
        #expect(previewed)
        #expect(transport.commands.isEmpty)                              // the preview writes nothing
        let preview = try #require(settings.savePreview)
        #expect(preview.questions.map(\.id) == ["measurement:msr_test_chest", "rule:test.rule"])
        #expect(StyleFactPhrases.previewSummary(preview.diff).contains("2 facts"))

        // A measurement cannot be retired and a rule cannot be replaced from the phone: neither is recorded.
        settings.decide(preview.questions[0], StyleFactDecision(.retire))
        settings.decide(preview.questions[1], StyleFactDecision(.replaceSize(label: "L")))
        #expect(settings.saveDecisions.isEmpty)
        settings.decide(preview.questions[0], StyleFactDecision(.replaceMeasurement(value: 45, unit: .in), quoteNewWording: true))

        let outcome = await settings.confirmSave()
        #expect(outcome?.receipt?.commandId == "cmd_save")
        let envelope = try #require(transport.commands.first)
        #expect(envelope["type"]?.stringValue == "style.save_document")
        #expect(envelope["expectedVersions"]?["style"]?.intValue == 2)
        #expect(envelope["payload"]?["content"]?.stringValue == edited)
        let sent: JSONValue = [["fact": ["kind": "measurement", "id": "msr_test_chest"],
                                "resolution": ["action": "replace", "quote": "Test chest 45 in", "measurement": ["value": 45, "unit": "in"]]]]
        #expect(envelope["payload"]?["factResolutions"] == sent)        // the undecided rule is not resolved for him

        #expect(settings.savePreview == nil)
        let diff = try #require(settings.lastFactDiff)
        #expect(StyleFactPhrases.summary(diff) == "1 fact of 3 still matches the text, 1 decision applied and 1 fact needs your decision and stays in force until then.")
        #expect(settings.openQuestions.map(\.label) == ["Test rule"])
    }

    @Test("An open conflict is decided with its own command; decisions the backend does not accept for that kind are not sent")
    func resolveOpenConflict() async throws {
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/style", Facts.style(conflicts: [
            Facts.conflict("sfc_test_1", kind: "rule", factId: "test.rule", label: "Test rule"),
            Facts.conflict("sfc_test_2", kind: "size_experience", factId: "sze_test", label: "Test Maker: M"),
        ]))
        router.on("POST", "/v1/commands") { request in
            TestSupport.json(TestSupport.receipt(commandId: "cmd_r", type: TestSupport.body(request)["type"]?.stringValue ?? "", summary: "Decided"))
        }
        let settings = SettingsModel(environment: TestSupport.environment(transport: transport))
        await settings.style.refresh()
        let rule = try #require(settings.openFactConflicts.first)
        let size = try #require(settings.openFactConflicts.last)

        let refused = await settings.resolve(rule, .replaceSize(label: "L"))
        #expect(refused == nil)
        #expect(transport.commands.isEmpty)

        await settings.resolve(rule, .keep, quoteNewWording: true)
        await settings.resolve(size, .replaceSize(label: "L"))
        let payloads = transport.commands.map { $0["payload"] ?? .null }
        #expect(transport.commands.map { $0["type"]?.stringValue } == ["style.resolve_fact_conflict", "style.resolve_fact_conflict"])
        let keep: JSONValue = ["conflictId": "sfc_test_1", "resolution": ["action": "keep", "quote": "Test chest 45 in"]]
        let replace: JSONValue = ["conflictId": "sfc_test_2", "resolution": ["action": "replace", "sizeExperience": ["sizeLabel": "L"]]]
        #expect(payloads == [keep, replace])
    }

    @Test("When the preview cannot be read offline, saving still queues and nothing is decided on the owner's behalf")
    func offlineSaveQueues() async {
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/style", Facts.style())
        let env = TestSupport.environment(transport: transport)
        let settings = SettingsModel(environment: env)
        await settings.style.refresh()
        router.offline.value = true

        let previewed = await settings.previewSave(content: "Test profile text.")
        #expect(!previewed)
        #expect(settings.savePreview == nil)
        let outcome = await settings.saveProfile(content: "Test profile text.")
        #expect(outcome == .queued)
        #expect(env.center.pending.first?.envelope.payload["factResolutions"] == nil)
    }

    @Test("Bulk edit of ticked items is one command naming exactly those garments and how many the owner saw")
    func bulkEditTicked() async throws {
        let router = Router()
        let transport = router.transport
        router.on("POST", "/v1/commands") { _ in TestSupport.json(TestSupport.receipt(commandId: "cmd_b", type: "garment.bulk_correct", summary: "Corrected 2 garments")) }
        let items = try [Synthetic.inventoryItem("gmt_test_b", name: "Test shirt B"), Synthetic.inventoryItem("gmt_test_a", name: "Test shirt A"),
                         Synthetic.inventoryItem("gmt_test_gone", name: "Test shirt gone", acquisition: "disposed")].map { try $0.decoded(as: InventoryItem.self) }
        let model = BulkEditModel(environment: TestSupport.environment(transport: transport), candidates: items)
        #expect(model.candidates.count == 2)                             // a disposed garment is never offered
        #expect(!model.canSubmit)
        model.selectAll()
        model.field = .colour
        #expect(!model.canSubmit)                                        // no value yet
        model.text = "  Navy "
        #expect(model.summaryLine == "Set colour to \"Navy\" on 2 items")

        let outcome = await model.submit()
        #expect(outcome?.receipt?.commandId == "cmd_b")
        #expect(transport.commands.count == 1)
        let payload = try #require(transport.commands.first?["payload"])
        let expected: JSONValue = ["selector": ["garmentIds": ["gmt_test_a", "gmt_test_b"]], "changes": ["colour": "Navy"], "expectedCount": 2, "source": ["kind": "owner_statement"]]
        #expect(payload == expected)
        #expect(model.selection.isEmpty)

        // Clearing a value sends an explicit null, not an empty string.
        model.selectAll(); model.field = .pattern; model.clearsValue = true
        await model.submit()
        #expect(transport.commands.last?["payload"]?["changes"] == ["pattern": .null])
    }

    @Test("Bulk edit of a category reads the backend's matches first, sends their count, and re-reads them when the set changed")
    func bulkEditCategory() async throws {
        func selection(_ ids: [String]) -> JSONValue {
            ["garments": .array(ids.map { ["garmentId": .string($0), "version": 1, "name": .string("Test \($0)"), "category": "socks"] }), "count": .integer(ids.count), "wardrobeRevision": 5]
        }
        let router = Router()
        let transport = router.transport
        router.json("POST", "/v1/wardrobe/selection", selection(["gmt_test_s1", "gmt_test_s2"]))
        router.on("POST", "/v1/commands") { _ in
            router.json("POST", "/v1/wardrobe/selection", selection(["gmt_test_s1", "gmt_test_s2", "gmt_test_s3"]))
            return TestSupport.error("precondition_failed", "The selection has changed: 3 garments match now.", status: 412)
        }
        let model = BulkEditModel(environment: TestSupport.environment(transport: transport), candidates: [])
        model.scope = .category; model.category = .socks
        model.field = .careChannel; model.careChannel = .handwash
        #expect(!model.canSubmit)                                        // nothing is sent before the matches were read
        await model.loadMatches()
        #expect(TestSupport.body(try #require(transport.requests("POST", "/v1/wardrobe/selection").first)) == ["category": "socks"])
        #expect(model.summaryLine == "Set care to hand wash on 2 items")

        let outcome = await model.submit()
        guard case .rejected? = outcome else { Issue.record("expected the stale selection to be refused"); return }
        #expect(transport.commands.first?["payload"]?["expectedCount"]?.intValue == 2)
        #expect(model.matched?.count == 3)                               // the current matches are shown before trying again
        #expect(model.message == "The matching items changed. Check the list and apply again.")

        model.searchText = "wool"; model.scope = .search
        #expect(model.matched == nil)                                    // a different selector needs its own read
        #expect(model.selector == GarmentSelector(search: "wool"))
    }

    @Test("An item's measurements are shown as recorded, with qualifier, convention, date and source")
    func itemMeasurements() async throws {
        guard case .object(var response) = Synthetic.itemResponse("gmt_test_j", name: "Test jacket", category: "jacket"), case .object(var detail)? = response["detail"] else {
            Issue.record("synthetic item"); return
        }
        func measurement(_ id: String, key: String, value: JSONValue, superseded: JSONValue = .null) -> JSONValue {
            ["measurementId": .string(id), "subject": "garment", "garmentId": "gmt_test_j", "key": .string(key), "value": value, "unit": "in", "convention": "flat half-chest",
             "qualifier": "a little over", "measuredOn": "2026-08-02", "source": ["kind": "owner_statement"], "passage": .null, "supersededBy": superseded]
        }
        detail["measurements"] = [measurement("msr_test_1", key: "half_chest", value: 22), measurement("msr_test_0", key: "half_chest", value: 21.5, superseded: "msr_test_1")]
        response["detail"] = .object(detail)
        let router = Router()
        router.json("GET", "/v1/items/gmt_test_j", .object(response))
        let model = ItemModel(environment: TestSupport.environment(transport: router.transport), garmentId: "gmt_test_j")
        await model.item.refresh()
        #expect(model.measurements.map(\.measurementId) == ["msr_test_1"])   // the superseded value is history, not the current fact
        let row = StyleFactPhrases.measurement(try #require(model.measurements.first))
        #expect(row.label == "Half chest")
        #expect(row.value == "a little over 22 in")
        #expect(row.note == "Flat half-chest · measured 2 August · source: owner statement")

        // An older backend that sends no `measurements` key still decodes.
        let plain = try Synthetic.itemResponse("gmt_test_k", name: "Test shirt").decoded(as: ItemResponse.self)
        #expect(plain.detail.measurements == nil)
    }

    @Test("A failed run the backend marks resumable can be run again; one it does not mark cannot")
    func runAgain() async {
        func failed(resumable: Bool) -> JSONValue {
            guard case .object(var run) = Synthetic.run("run_1", state: "failed", lastEventId: 2) else { return .null }
            run["error"] = ["code": "budget_exhausted", "message": "Today's assistance budget is used up.", "resumable": .bool(resumable)]
            return .object(run)
        }
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/conversation/messages", Synthetic.page([Synthetic.message("msg_a", text: "Done.")]))
        transport.setStream(path: "/v1/runs/run_1/events", chunks: [Synthetic.sse([Synthetic.event(2, run: "run_1", type: "run_finished", data: ["state": "failed"])])])
        router.json("GET", "/v1/runs/run_1", failed(resumable: false))
        let env = TestSupport.environment(transport: transport)
        let follower = RunFollower(environment: env, runId: "run_1", transcript: TranscriptModel(environment: env), sleep: { _ in })
        await follower.follow()
        #expect(follower.phase == .failed("Today's assistance budget is used up."))
        #expect(!follower.canRunAgain)
        await follower.runAgain()
        #expect(transport.requests("POST", "/v1/runs/run_1/resume").isEmpty)

        router.json("GET", "/v1/runs/run_1", failed(resumable: true))
        _ = try? await follower.syncFromRun()
        #expect(follower.canRunAgain)
        router.on("POST", "/v1/runs/run_1/resume") { _ in
            transport.setStream(path: "/v1/runs/run_1/events", chunks: [Synthetic.sse([Synthetic.event(4, run: "run_1", type: "run_finished", data: ["state": "completed"])])])
            router.json("GET", "/v1/runs/run_1", Synthetic.run("run_1", reply: ("msg_a", "Done."), lastEventId: 4))
            return TestSupport.json(Synthetic.run("run_1", state: "running", lastEventId: 3))
        }
        await follower.runAgain()
        #expect(transport.requests("POST", "/v1/runs/run_1/resume").count == 1)
        #expect(follower.phase == .completed)
        #expect(!follower.canRunAgain)
        #expect(transport.requests("GET", "/v1/runs/run_1/events").last?.headers["Last-Event-ID"] == "3")
    }
}
