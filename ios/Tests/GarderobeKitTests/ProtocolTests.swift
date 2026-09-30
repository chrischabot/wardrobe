import Foundation
import Testing
@testable import GarderobeKit

@Suite("SSE parser")
struct SSEParserTests {
    func parse(_ text: String) -> [SSEMessage] {
        var p = SSEParser()
        var out = p.feed(text: text)
        if let m = p.finish() { out.append(m) }
        return out
    }

    @Test func basicEventsWithIdsCommentsAndMultilineData() {
        let m = parse(": hello\nid: 1\nevent: activity\ndata: {\"a\":\ndata: 1}\n\nid: 2\ndata: x\n\n")
        #expect(m.count == 2)
        #expect(m[0] == SSEMessage(id: "1", event: "activity", data: "{\"a\":\n1}", retry: nil))
        #expect(m[1].event == "message")
        #expect(m[1].id == "2")
    }

    @Test func idPersistsAndCRLFIsHandled() {
        let m = parse("id: 5\r\ndata: a\r\n\r\ndata: b\r\n\r\n")
        #expect(m.map(\.id) == ["5", "5"])
        #expect(m.map(\.data) == ["a", "b"])
    }

    @Test func trailingEventWithoutBlankLineIsFlushed() {
        #expect(parse("id: 9\ndata: last").map(\.data) == ["last"])
    }

    @Test func retryAndFieldsWithoutValues() {
        let m = parse("retry: 3000\ndata\n\n")
        #expect(m.first?.retry == 3000)
        #expect(m.first?.data == "")
    }

    @Test func fixtureStreamDecodesToRunEvents() async throws {
        let server = try FixtureServer()
        let api = APIClient(baseURL: URL(string: "https://t.invalid")!, transport: server)
        let turn = try await api.sendTurn(TurnRequest(clientTurnId: "turn_ssetest01", text: "x"))
        var types: [String] = []
        for try await e in await api.runEvents(turn.runId, lastEventId: nil) { types.append(e.type) }
        #expect(types == ["run_started", "activity", "text_delta", "tool_progress_v9", "text_delta", "outfit_board", "sources", "run_finished"])
    }
}

/// Encodes every request the app sends and writes it for the cross-language check against the
/// real zod schemas (`npx tsx ios/scripts/fixtures.ts check $GARDEROBE_CONTRACT_OUT`).
@Suite("Contract export")
@MainActor
struct ContractExportTests {
    @Test func everyCommandTheAppIssuesEncodesToTheContract() throws {
        let t = try Fixtures.today
        let w = try Fixtures.wardrobe
        let gold = w.id(Names.goldOxford)
        let o = t.board!.options[1]
        let now = Fixtures.demoNow
        let commands: [String: DomainCommand] = [
            "record_wear": .recordWear(wearingDate: t.date, timezone: t.timezone, occurredAt: now, items: o.slots.filter { $0.role != .footwear }.map { WearItem(garmentId: $0.garmentId, role: $0.role) } + [WearItem(garmentId: o.footwearSlots[0].garmentId, role: .footwear)], optionId: o.optionId),
            "select_option": .selectOption(boardId: t.board!.boardId, optionId: o.optionId, footwearGarmentId: o.footwearSlots[1].garmentId),
            "select_option_single": .selectOption(boardId: t.board!.boardId, optionId: t.board!.options[0].optionId, footwearGarmentId: nil),
            "mark_in_wash": .markInWash(garmentId: gold, occurredAt: now),
            "mark_washed": .markWashed(garmentId: gold, quantity: 1),
            "socks_washed": .socksWashed(garmentIds: [w.id("Merino — inky blue")], occurredAt: now),
            "socks_washed_all": .socksWashed(),
            "laundry_collected": .laundryCollected(occurredAt: now),
            "laundry_returned": .laundryReturned(batchId: "lb_abc123", occurredAt: now),
            "laundry_partial_return": .laundryPartialReturn(batchId: "lb_abc123", exceptions: [.init(garmentId: gold), .init(garmentId: w.id("Merino — inky blue"), quantity: 2)], occurredAt: now),
            "back_from_tailor": .backFromTailor(garmentId: gold, occurredAt: now),
            "mark_arrived": .markArrived(garmentId: gold, occurredAt: now),
            "put_into_storage": .putIntoStorage(garmentId: gold, occurredAt: now),
            "take_out_of_storage": .takeOutOfStorage(garmentId: gold),
            "reconcile_quantity": .reconcileQuantity(garmentId: gold, clean: 2),
            "undo": .undo(targetCommandId: "cmd_abc123"),
            "edit_style_profile": .editStyleProfile(documentId: "sdoc_ownerprofile", baseVersion: 1, body: "# Profile", amendment: ""),
        ]
        for (name, command) in commands {
            let key = CommandEnvelope.makeKey(for: command.type, uuid: UUID().uuidString)
            let envelope = CommandEnvelope(idempotencyKey: key, source: .app, submittedAt: now, command: command)
            let json = try JSONValue.encode(envelope)
            // Never carries owner identity; omits absent optionals rather than sending null.
            for forbidden in ["userId", "ownerId", "owner", "user", "accountId", "tenantId"] { #expect(json["command"]?[forbidden] == nil && json[forbidden] == nil) }
            #expect(json["command"]?.objectValue?.values.contains(.null) == false, "\(name)")
            try ContractExport.write("envelope-\(name)", envelope)
        }
        let studio = o.slots.map { StudioSlot(garmentId: $0.garmentId, role: $0.role, alternativeGroup: $0.alternativeGroup) }
        let shipped: [String: DomainCommand] = [
            "save_combination": .saveCombination(name: "Tuesday", slots: studio, mode: "explore", favorite: true),
            "save_combination_unnamed": .saveCombination(name: "", slots: studio),
            "plan_outfit": .planOutfit(date: t.date, slots: studio, name: "Borough dinner"),
            "remove_combination": .removeCombination(combinationId: "cmb_abc123"),
            "update_delivery_settings": .updateDeliverySettings(deliveryTime: "06:45", dailyOptionCount: 4),
            "update_delivery_calendar": .updateDeliverySettings(calendar: .set("outfits@group.calendar.google.com")),
        ]
        for (name, command) in shipped {
            try ContractExport.write("envelope-\(name)", CommandEnvelope(idempotencyKey: CommandEnvelope.makeKey(for: command.type, uuid: UUID().uuidString), source: .offlineReplay, command: command))
        }
        // Clearing the calendar is the one explicit null the contract allows.
        let clear = DomainCommand.updateDeliverySettings(calendar: .clear)
        #expect(clear["calendarId"] == .null)
        try ContractExport.write("envelope-update_delivery_clear_calendar", CommandEnvelope(idempotencyKey: CommandEnvelope.makeKey(for: clear.type, uuid: UUID().uuidString), source: .app, command: clear))
        #expect(DomainCommand.selectOption(boardId: "brd_x", optionId: "opt_x", footwearGarmentId: nil)["footwearGarmentId"] == nil)
    }

    @Test func requestBodiesAndSynthesizedReceiptsEncodeToTheirContracts() async throws {
        let t = try Fixtures.today
        let slot = StudioValidateRequest.Slot(garmentId: t.board!.options[0].slots[0].garmentId, role: .outerLayer)
        try ContractExport.write("turn-chat", TurnRequest(clientTurnId: "turn_0123456789", text: "Hello", references: [.option(boardId: t.board!.boardId, optionId: t.board!.options[0].optionId, boardRevision: 2), .garment(garmentId: slot.garmentId)]))
        try ContractExport.write("turn-capture", TurnRequest(clientTurnId: "turn_0123456790", text: "What I wore", attachmentIds: ["upl_abc1"], intent: .whatIWore, explicitLog: true))
        try ContractExport.write("turn-stop-and-send", TurnRequest(clientTurnId: "turn_0123456791", text: "Stop; the Reims instead?", stopCurrent: true))
        try ContractExport.write("turn-photos-only", TurnRequest(clientTurnId: "turn_0123456792", text: "", attachmentIds: (1...10).map { "upl_photo\($0)" }, intent: .identify))
        try ContractExport.write("upload-photo", UploadRequest(purpose: "what_i_wore", contentType: "image/jpeg", byteLength: 123_456))
        try ContractExport.write("upload-garment", UploadRequest(purpose: "garment_photo", contentType: "image/heic", byteLength: 25_000_000, garmentId: slot.garmentId))
        try ContractExport.write("run-input-choice", RunInputRequest(choiceId: "olive"))
        try ContractExport.write("run-input-decline", RunInputRequest(choiceId: nil))
        var query = WardrobeQuery(q: "PCF4340", category: "shirt", availability: "any", colorFamily: "blue", season: "autumn", location: "home", lastWornBefore: LocalDate("2026-09-01"))
        query.cursor = "c40"
        try ContractExport.write("query-wardrobe-full", query.parameters.mapValues { JSONValue.string($0) }.merging(["limit": .number(500)]) { _, b in b })
        try ContractExport.write("query-wardrobe-default", WardrobeQuery().parameters.mapValues { JSONValue.string($0) }.merging(["limit": .number(Double(WardrobeQuery().limit))]) { _, b in b })
        try ContractExport.write("studio-validate-today", StudioValidateRequest(mode: "today", date: t.date, slots: [slot]))
        try ContractExport.write("studio-suggest-today", StudioSuggestRequest(mode: "explore", date: t.date, locked: [slot], roles: [.baseTop, .bottom]))
        try ContractExport.write("recall-dated", RecallSearchRequest(query: "City blazer", from: LocalDate("2026-06-01"), to: LocalDate("2026-06-30"), limit: 20))
        try ContractExport.write("recall-plain", RecallSearchRequest(query: "rust suede"))
        // The fixture server's receipts must match the real CommandReceipt schema too.
        let h = try Harness.make()
        let q = CommandQueue(env: h.env)
        let r1 = try #require(await q.submit(.selectOption(boardId: t.board!.boardId, optionId: t.board!.options[0].optionId, footwearGarmentId: nil), label: "x").receipt)
        let r2 = try #require(await q.submit(.selectOption(boardId: t.board!.boardId, optionId: t.board!.options[1].optionId, footwearGarmentId: nil), label: "x").receipt)
        let r3 = try #require(await q.submit(.undo(targetCommandId: r1.commandId), label: "x").receipt)
        try ContractExport.write("receipt-select", r1)
        try ContractExport.write("receipt-rejected", r2)
        try ContractExport.write("receipt-undo", r3)
        // The fixture server's recall response is checked against the real schema as well.
        try ContractExport.write("turn-response-plain", try await h.env.api.sendTurn(TurnRequest(clientTurnId: "turn_contract01", text: "Is the moss oxford clean?")))
        let withNotice = try await h.env.api.sendTurn(TurnRequest(clientTurnId: "turn_contract02", text: "code GRDB.rcv_abc123.SeCrEtPaRt0987654321"))
        #expect(withNotice.notice?.kind == "secret_removed")
        try ContractExport.write("turn-response-notice", withNotice)
        try ContractExport.write("recall-response-fixture", try await h.env.api.recallSearch(RecallSearchRequest(query: "blazer")))
        // So are its swap candidates, run-input answers and upload PUT response (packages/contracts surface.ts).
        let option = t.board!.options[0]
        try ContractExport.write("swap-candidates-fixture", try await h.env.api.swapCandidates(optionId: option.optionId, role: .baseTop))
        let conv = ConversationViewModel(env: h.env, receipts: ReceiptCenter(env: h.env))
        conv.draft = "[ask] Which shoes?"
        await conv.send()
        let runId = try #require(conv.needsInput?.runId)
        try ContractExport.write("run-input-response-executed", try await h.env.api.answerRun(runId, choiceId: "olive"))
        try ContractExport.write("run-input-response-replayed", try await h.env.api.answerRun(runId, choiceId: "olive"))
        let put = HTTPRequest(method: "PUT", path: "/v1/uploads/upl_contract1?t=tok", headers: ["Content-Type": "image/jpeg"], body: Data(repeating: 1, count: 10))
        let stored = try await h.server.send(put)
        try ContractExport.write("upload-receive-fixture", try GarderobeJSON.decoder().decode(UploadReceiveResponse.self, from: stored.body))
    }
}
