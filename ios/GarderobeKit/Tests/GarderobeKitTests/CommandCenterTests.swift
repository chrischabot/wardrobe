import Testing
import Foundation
@testable import GarderobeKit

@MainActor
@Suite("Command center: identity, ordered replay, receipts and undo")
struct CommandCenterTests {
    private func wear(_ ids: [String], date: String = "2026-09-15") -> CommandDraft {
        CommandDraft(CommandWearRecord(wearingDate: date, garmentIds: ids), label: "Wore \(ids.joined(separator: ", "))")
    }

    @Test("A confirmed command returns the backend's receipt, leaves the queue and raises the undo banner for eight seconds")
    func confirmed() async throws {
        let transport = ScriptedTransport { request in
            #expect(request.path == "/v1/commands")
            #expect(request.headers["Authorization"] == "Bearer test-token")
            let body = TestSupport.body(request)
            return TestSupport.json(TestSupport.receipt(commandId: "cmd_1", type: body["type"]?.stringValue ?? "", summary: "Recorded wear", affected: [("garment", "gmt_a", 2)], wardrobeRevision: 7))
        }
        let time = ManualTimeSource(instant: TestSupport.startInstant)
        let env = TestSupport.environment(transport: transport, time: time)

        let outcome = await env.center.submit(wear(["gmt_a"]))

        #expect(outcome.receipt?.commandId == "cmd_1")
        #expect(env.center.pending.isEmpty)
        #expect(env.center.wardrobeRevision == 7)
        #expect(env.center.receipts(for: "garment", id: "gmt_a").map(\.id) == ["cmd_1"])
        let banner = try #require(env.center.banner)
        #expect(banner.expiresAt.timeIntervalSince(time.now()) == 8)

        time.advance(7.9)
        env.center.expireBanner()
        #expect(env.center.banner != nil)
        time.advance(0.2)
        env.center.expireBanner()
        #expect(env.center.banner == nil)
        // The receipt outlives the banner: undo is still reachable from history.
        #expect(env.center.receipts.first?.receipt.undo.available == true)
    }

    @Test("The envelope is an owner tap on the ios channel with a stable key and the time of the tap")
    func envelopeShape() async throws {
        let transport = ScriptedTransport { _ in TestSupport.json(TestSupport.receipt(commandId: "cmd_1", type: "wear.record", summary: "ok")) }
        let env = TestSupport.environment(transport: transport)
        await env.center.submit(wear(["gmt_a", "gmt_b"]))

        let body = TestSupport.body(try #require(transport.requests.first))
        #expect(body["type"]?.stringValue == "wear.record")
        #expect(body["authorization"]?.stringValue == "owner_tap")
        #expect(body["source"]?["channel"]?.stringValue == "ios")
        #expect(body["occurredAt"]?.stringValue == "2026-09-15T06:30:00Z")
        let key = try #require(body["idempotencyKey"]?.stringValue)
        #expect(key.count >= 8)
        #expect(body["source"]?["clientSubmissionId"]?.stringValue == key)
        #expect(body["payload"]?["garmentIds"] == .array(["gmt_a", "gmt_b"]))
        // No owner field is ever sent: the owner comes from the authenticated connection.
        #expect(body["userId"] == nil && body["payload"]?["userId"] == nil)
    }

    @Test("Offline, a wear stays queued on the phone and is later sent with the same key, body and occurrence time")
    func offlineThenReplay() async throws {
        let online = LockedFlag(false)
        let transport = ScriptedTransport { request in
            guard online.value else { throw TransportFailure("offline") }
            let body = TestSupport.body(request)
            return TestSupport.json(TestSupport.receipt(commandId: "cmd_late", type: body["type"]?.stringValue ?? "", summary: "Recorded wear"))
        }
        let store = InMemoryKeyValueStore()
        let time = ManualTimeSource(instant: TestSupport.startInstant)
        let env = TestSupport.environment(transport: transport, store: store, time: time)

        let outcome = await env.center.submit(wear(["gmt_a"]))
        #expect(outcome == .queued)
        #expect(env.center.pending.count == 1)
        #expect(env.center.isOffline)
        #expect(env.center.receipts.isEmpty) // nothing is shown as recorded
        let firstBody = try #require(transport.requests.first?.body)

        // The app is closed and reopened two hours later: the queue is read back from disk.
        time.advance(7200)
        let reopened = TestSupport.environment(transport: transport, store: store, time: time)
        await reopened.center.restore()
        #expect(reopened.center.pending.map(\.label) == ["Wore gmt_a"])

        online.value = true
        let results = await reopened.center.replay()
        #expect(results.values.compactMap(\.receipt).map(\.commandId) == ["cmd_late"])
        #expect(reopened.center.pending.isEmpty)
        // Byte-identical retry: same idempotency key, same occurredAt (the time of the tap, not of the send).
        #expect(transport.requests.last?.body == firstBody)
    }

    @Test("Several queued commands replay in their original order through the batch route")
    func orderedBatchReplay() async throws {
        let online = LockedFlag(false)
        let transport = ScriptedTransport { request in
            guard online.value else { throw TransportFailure("offline") }
            #expect(request.path == "/v1/commands/batch")
            let commands = TestSupport.body(request)["commands"]?.arrayValue ?? []
            let results: [JSONValue] = commands.enumerated().map { index, command in
                .object(["status": "receipt", "idempotencyKey": command["idempotencyKey"] ?? .null,
                         "receipt": TestSupport.receipt(commandId: "cmd_\(index)", type: command["type"]?.stringValue ?? "", summary: "ok")])
            }
            return TestSupport.json(.object(["results": .array(results), "wardrobeRevision": 9]))
        }
        let env = TestSupport.environment(transport: transport)
        await env.center.submit(wear(["gmt_a"], date: "2026-09-13"))
        await env.center.submit(CommandDraft(CommandCareMarkDirty(items: [.init(garmentId: "gmt_b")]), label: "In the wash"))
        await env.center.submit(wear(["gmt_c"], date: "2026-09-14"))
        #expect(env.center.pending.map(\.envelope.type) == ["wear.record", "care.mark_dirty", "wear.record"])

        online.value = true
        await env.center.replay()

        let sent = TestSupport.body(try #require(transport.requests.last))["commands"]?.arrayValue ?? []
        let types: [String] = sent.compactMap { $0["type"]?.stringValue }
        let dates: [String?] = sent.map { $0["payload"]?["wearingDate"]?.stringValue }
        #expect(types == ["wear.record", "care.mark_dirty", "wear.record"])
        #expect(dates == ["2026-09-13", nil, "2026-09-14"])
        #expect(env.center.pending.isEmpty)
        #expect(env.center.receipts.count == 3)
    }

    @Test("A final refusal is shown as rejected with the backend's reason and does not block later commands")
    func refusalDoesNotBlock() async throws {
        let transport = ScriptedTransport { request in
            let body = TestSupport.body(request)
            if body["type"]?.stringValue == "garment.receive" { return TestSupport.error("precondition_failed", "Nothing is on its way for this item.", status: 409) }
            return TestSupport.json(TestSupport.receipt(commandId: "cmd_ok", type: "wear.record", summary: "ok"))
        }
        let env = TestSupport.environment(transport: transport)

        let refused = await env.center.submit(CommandDraft(CommandGarmentReceive(garmentId: "gmt_a"), label: "Arrived"))
        guard case .rejected(let error) = refused else { Issue.record("expected a rejection, got \(refused)"); return }
        #expect(error.message == "Nothing is on its way for this item.")
        #expect(env.center.rejected.count == 1)
        #expect(env.center.receipts.isEmpty)

        let next = await env.center.submit(wear(["gmt_a"]))
        #expect(next.receipt?.commandId == "cmd_ok")
        await env.center.dismissRejected(env.center.rejected[0].id)
        #expect(env.center.rejected.isEmpty)
    }

    @Test("A server error keeps the command queued instead of reporting it rejected or recorded")
    func serverErrorStaysQueued() async {
        let transport = ScriptedTransport { _ in TestSupport.error("internal", "Temporary failure.", status: 500) }
        let env = TestSupport.environment(transport: transport)
        let outcome = await env.center.submit(wear(["gmt_a"]))
        #expect(outcome == .queued)
        #expect(env.center.pending.count == 1)
        #expect(env.center.rejected.isEmpty)
        #expect(!env.center.isOffline)
    }

    @Test("A revoked session keeps the observation queued and asks for sign-in")
    func signedOutKeepsObservation() async {
        let transport = ScriptedTransport { _ in TestSupport.error("session_revoked", "Sign in again.", status: 401) }
        let env = TestSupport.environment(transport: transport)
        let outcome = await env.center.submit(wear(["gmt_a"]))
        #expect(outcome == .queued)
        #expect(env.center.needsSignIn)
        #expect(env.center.pending.count == 1)
    }

    @Test("When the phone cannot persist the command, the owner is told it was not saved and nothing is sent")
    func notSaved() async {
        let transport = ScriptedTransport { _ in TestSupport.json(TestSupport.receipt(commandId: "x", type: "wear.record", summary: "ok")) }
        let store = InMemoryKeyValueStore()
        let env = TestSupport.environment(transport: transport, store: store)
        store.failWrites = true
        let outcome = await env.center.submit(wear(["gmt_a"]))
        guard case .notSaved = outcome else { Issue.record("expected notSaved, got \(outcome)"); return }
        #expect(transport.requests.isEmpty)
        #expect(env.center.pending.isEmpty)
    }

    @Test("Undo submits a compensating command.undo for the receipt's command and keeps the original receipt")
    func undoIsCompensation() async throws {
        let transport = ScriptedTransport { request in
            let body = TestSupport.body(request)
            if body["type"]?.stringValue == "command.undo" {
                #expect(body["payload"]?["commandId"]?.stringValue == "cmd_wear")
                return TestSupport.json(TestSupport.receipt(commandId: "cmd_undo", type: "command.undo", summary: "Undid the wear", undoAvailable: false))
            }
            return TestSupport.json(TestSupport.receipt(commandId: "cmd_wear", type: "wear.record", summary: "Recorded wear"))
        }
        let env = TestSupport.environment(transport: transport)
        await env.center.submit(wear(["gmt_a"]))
        let record = try #require(env.center.receipts.first)

        let outcome = await env.center.undo(record)

        #expect(outcome.receipt?.commandId == "cmd_undo")
        #expect(env.center.banner == nil)
        #expect(env.center.receipts.map(\.id) == ["cmd_undo", "cmd_wear"]) // nothing deleted
        let original = try #require(env.center.receipts.last)
        #expect(original.undoneBy == "cmd_undo")
        #expect(original.receipt.undo.available == false)
    }

    @Test("A receipt that cannot be undone raises no undo banner")
    func noBannerWhenNotUndoable() async {
        let transport = ScriptedTransport { _ in TestSupport.json(TestSupport.receipt(commandId: "c", type: "garment.retire", summary: "Sold", undoAvailable: false)) }
        let env = TestSupport.environment(transport: transport)
        await env.center.submit(CommandDraft(CommandGarmentRetire(garmentId: "gmt_a", disposition: .sold), label: "Sold"))
        #expect(env.center.banner == nil)
        #expect(env.center.receipts.count == 1)
    }
}

final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Bool
    init(_ value: Bool) { _value = value }
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); _value = newValue; lock.unlock() }
    }
}
