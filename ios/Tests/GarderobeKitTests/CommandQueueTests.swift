import Foundation
import Testing
@testable import GarderobeKit

@Suite("Offline command queue")
@MainActor
struct CommandQueueTests {
    func wear(_ h: Harness) throws -> DomainCommand {
        let t = try Fixtures.today
        let o = t.board!.options[0]
        return .recordWear(wearingDate: t.date, timezone: t.timezone, occurredAt: Fixtures.demoNow, items: o.slots.map { WearItem(garmentId: $0.garmentId, role: $0.role) }, optionId: o.optionId)
    }

    @Test func keysAreStableUniqueAndMatchTheContractPattern() async throws {
        let h = try Harness.make()
        await h.server.setOffline(true)
        let q = CommandQueue(env: h.env)
        await q.setConnectivity(false)
        _ = await q.submit(try wear(h), label: "a")
        _ = await q.submit(.markInWash(garmentId: try Fixtures.wardrobe.id(Names.goldOxford)), label: "b")
        let keys = q.items.map(\.id)
        #expect(Set(keys).count == 2)
        for k in keys {
            #expect(k.count >= 8 && k.count <= 200)
            #expect(k.allSatisfy { $0.isLetter || $0.isNumber || ":._-".contains($0) })
        }
        #expect(keys[0].hasPrefix("app:record_wear:"))
    }

    @Test func lostResponseIsRetriedWithTheSameKeyAndNeverDoubleRecords() async throws {
        let h = try Harness.make()
        let q = CommandQueue(env: h.env)
        await h.server.inject(.dropResponseAfterApplying, forPathPrefix: "/v1/commands")
        let outcome = await q.submit(try wear(h), label: "I wore")
        // The retry ran (immediate sleep) and got the stored receipt back.
        await eventually("delivery") { q.items.isEmpty }
        let bodies = await h.server.requests(matching: "/v1/commands").map(\.body)
        #expect(bodies.count == 2)
        #expect(bodies[0] == bodies[1])
        #expect(await h.server.issuedReceipts.count == 1)
        #expect(await h.server.today.recordedWears.count == 7)
        if case .receipt = outcome { Issue.record("first attempt had no response") }
    }

    @Test func pendingCommandsSurviveRelaunchAndDeliverInOrder() async throws {
        let h = try Harness.make()
        await h.server.setOffline(true)
        let q = CommandQueue(env: h.env)
        await q.setConnectivity(false)
        let gold = try Fixtures.wardrobe.id(Names.goldOxford)
        _ = await q.submit(try wear(h), label: "first")
        _ = await q.submit(.putIntoStorage(garmentId: gold), label: "second")
        #expect(q.items.map(\.state) == [.queued, .queued])

        let relaunched = try h.relaunched()
        let q2 = CommandQueue(env: relaunched.env)
        #expect(q2.items.map(\.label) == ["first", "second"])
        await h.server.setOffline(false)
        await q2.setConnectivity(true)
        #expect(q2.items.isEmpty)
        let types = try await h.server.requests(matching: "/v1/commands").compactMap { try $0.body.map { try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: $0).command.type } }
        #expect(types.suffix(2) == ["record_wear", "put_into_storage"])
    }

    @Test func aSendInterruptedByTheAppClosingIsRetried() throws {
        let h = try Harness.make()
        var p = PendingCommand(envelope: CommandEnvelope(idempotencyKey: "app:record_wear:x1234567", source: .app, command: .undo(targetCommandId: "cmd_x")), label: "x", createdAt: Fixtures.demoNow, state: .sending, attempts: 1, lastAttemptAt: nil, context: .init())
        h.store.save([p], StoreKey.pendingCommands)
        let q = CommandQueue(env: h.env)
        p.state = .queued
        #expect(q.items == [p])
    }

    @Test func rejectionIsVisibleAndDoesNotBlockLaterCommands() async throws {
        let h = try Harness.make()
        let q = CommandQueue(env: h.env)
        let t = try Fixtures.today
        let twoShoe = t.board!.options[1]
        let bad = await q.submit(.selectOption(boardId: t.board!.boardId, optionId: twoShoe.optionId, footwearGarmentId: nil), label: "bad")
        guard case .receipt(let r) = bad else { Issue.record("expected receipt"); return }
        #expect(r.outcome == .rejected)
        #expect(q.items.first?.state == .rejected("This option offers two footwear alternatives; choose one so the outfit never logs both"))
        let good = await q.submit(.markInWash(garmentId: try Fixtures.wardrobe.id(Names.goldOxford)), label: "good")
        #expect(good.receipt?.outcome == .committed)
        q.dismiss(q.items[0].id)
        #expect(q.items.isEmpty)
    }

    @Test func shippedStudioAndDeliveryCommandsCommitAndEmptyUpdatesAreRefusedVisibly() async throws {
        let h = try Harness.make()
        let q = CommandQueue(env: h.env)
        let ok = await q.submit(.updateDeliverySettings(deliveryTime: "06:45"), label: "Delivery")
        #expect(ok.receipt?.outcome == .committed)
        #expect(await h.server.settings.deliveryTime == "06:45")
        // The contract refuses an update that changes nothing; the refusal stays visible, nothing is lost silently.
        let empty = await q.submit(.updateDeliverySettings(), label: "Delivery")
        #expect(empty.receipt?.outcome == .rejected)
        #expect(q.items.first?.state == .rejected("Provide at least one setting to change"))
    }

    @Test func signedOutKeepsTheCommandForLater() async throws {
        let h = try Harness.make()
        let q = CommandQueue(env: h.env)
        await h.server.inject(.serverError(401), forPathPrefix: "/v1/commands")
        _ = await q.submit(try wear(h), label: "I wore")
        #expect(q.items.first?.state == .needsSignIn)
        await q.retryNow(q.items[0].id)
        #expect(q.items.isEmpty)
    }

    @Test func serverErrorsRetryWithBackoff() async throws {
        let h = try Harness.make(manualSleep: true)
        let q = CommandQueue(env: h.env)
        await h.server.inject(.serverError(503), forPathPrefix: "/v1/commands")
        _ = await q.submit(try wear(h), label: "I wore")
        #expect(q.items.first?.state == .retrying("Garderobe is having trouble; it will retry"))
        await eventually("backoff scheduled") { await h.clock.pending == 1 }
        #expect(await h.clock.requested == [.seconds(2)])
        await h.clock.advance()
        await eventually("retried") { q.items.isEmpty }
    }
}

@Suite("Receipts and undo")
@MainActor
struct ReceiptTests {
    func setUp(manual: Bool = true) throws -> (Harness, CommandQueue, ReceiptCenter) {
        let h = try Harness.make(manualSleep: manual)
        let q = CommandQueue(env: h.env)
        let rc = ReceiptCenter(env: h.env)
        q.onReceipt { r, _ in rc.record(r) }
        return (h, q, rc)
    }

    func wearReceipt(_ q: CommandQueue) async throws -> CommandReceipt {
        let t = try Fixtures.today
        let o = t.board!.options[0]
        let outcome = await q.submit(.recordWear(wearingDate: t.date, timezone: t.timezone, occurredAt: Fixtures.demoNow, items: o.slots.map { WearItem(garmentId: $0.garmentId, role: $0.role) }), label: "I wore")
        return try #require(outcome.receipt)
    }

    @Test func bannerLastsEightSeconds() async throws {
        let (h, q, rc) = try setUp()
        let r = try await wearReceipt(q)
        #expect(rc.banner?.receipt.commandId == r.commandId)
        await eventually("timer") { await h.clock.pending == 1 }
        #expect(await h.clock.requested.last == .seconds(8))
        await h.clock.advance()
        await eventually("banner gone") { rc.banner == nil }
    }

    @Test func holdingTheBannerPausesItsTimer() async throws {
        let (h, q, rc) = try setUp()
        _ = try await wearReceipt(q)
        await eventually("timer") { await h.clock.pending == 1 }
        rc.holdBanner(true)
        await h.clock.advance()
        for _ in 0..<50 { await Task.yield() }
        #expect(rc.banner != nil)
        rc.holdBanner(false)
        await eventually("restarted") { await h.clock.pending == 1 }
        await h.clock.advance()
        await eventually("banner gone") { rc.banner == nil }
    }

    @Test func undoOutlivesTheBannerAndIsACompensatingCommand() async throws {
        let (h, q, rc) = try setUp()
        let r = try await wearReceipt(q)
        await eventually("timer") { await h.clock.pending == 1 }
        await h.clock.advance()
        await eventually("banner gone") { rc.banner == nil }
        #expect(rc.undoState(for: r) == .available)
        let outcome = await rc.undo(r, queue: q)
        let undo = try #require(outcome?.receipt)
        #expect(undo.commandType == "undo")
        #expect(undo.compensatesCommandId == r.commandId)
        #expect(rc.receipt(r.commandId)?.undoneByCommandId == undo.commandId)
        #expect(rc.undoState(for: rc.receipt(r.commandId)!) == .alreadyUndone)
        // Both receipts remain: undo never deletes history.
        #expect(rc.receipts.map(\.commandId).contains(r.commandId))
        #expect(await h.server.today.recordedWears.isEmpty)
        #expect(await rc.undo(rc.receipt(r.commandId)!, queue: q) == nil)
    }

    @Test func undoQueuedOfflineShowsPending() async throws {
        let (h, q, rc) = try setUp()
        let r = try await wearReceipt(q)
        await h.server.setOffline(true)
        await q.setConnectivity(false)
        guard case .queued = await rc.undo(r, queue: q) else { Issue.record("expected queued"); return }
        #expect(rc.undoState(for: r) == .pending)
        await h.server.setOffline(false)
        await q.setConnectivity(true)
        #expect(rc.undoState(for: rc.receipt(r.commandId)!) == .alreadyUndone)
    }

    @Test func externalEffectStateIsExplained() async throws {
        let (_, q, rc) = try setUp()
        let t = try Fixtures.today
        let r = try #require(await q.submit(.selectOption(boardId: t.board!.boardId, optionId: t.board!.options[0].optionId, footwearGarmentId: nil), label: "Chose").receipt)
        #expect(rc.externalEffectNote(for: r) == "Calendar update pending. Undo replaces it.")
        #expect(rc.externalEffectNote(for: try await wearReceipt(q)) == nil)
    }

    @Test func rejectedReceiptsOfferNoUndo() async throws {
        let (_, q, rc) = try setUp()
        let t = try Fixtures.today
        let r = try #require(await q.submit(.selectOption(boardId: t.board!.boardId, optionId: t.board!.options[1].optionId, footwearGarmentId: nil), label: "x").receipt)
        #expect(rc.undoState(for: r) == .notApplicable)
        #expect(AccessibilityText.receipt(r).hasPrefix("Not recorded."))
    }

    @Test func receiptsPersistAndAreFoundPerGarment() async throws {
        let (h, q, _) = try setUp()
        let r = try await wearReceipt(q)
        let rc2 = ReceiptCenter(env: try h.relaunched().env)
        #expect(rc2.receipt(r.commandId) != nil)
        let gold = try Fixtures.wardrobe.id(Names.goldOxford)
        #expect(rc2.receipts(forGarment: gold).map(\.commandId) == [r.commandId])
    }

    @Test func serverReceiptsMergeWithoutAnnouncing() throws {
        let (_, _, rc) = try setUp()
        rc.merge(try Fixtures.decode(ReceiptsPage.self, "receipts.json").receipts)
        #expect(rc.receipts.count == 5)
        #expect(rc.banner == nil)
    }
}
