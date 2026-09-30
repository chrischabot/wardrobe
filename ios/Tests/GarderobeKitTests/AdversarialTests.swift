import Foundation
import Synchronization
import Testing
@testable import GarderobeKit

/// A transport that answers every request with scripted responses (hostile or malformed servers).
final class StubTransport: HTTPTransport {
    private let handler: @Sendable (HTTPRequest) -> HTTPResponse
    private let streamLines: [String]
    init(streamLines: [String] = [], _ handler: @escaping @Sendable (HTTPRequest) -> HTTPResponse) { self.handler = handler; self.streamLines = streamLines }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { handler(request) }
    func lines(_ request: HTTPRequest) -> AsyncThrowingStream<String, Error> {
        let lines = streamLines
        return AsyncThrowingStream { c in for l in lines { c.yield(l) }; c.finish() }
    }
}

@MainActor
func stubEnv(store: MemoryClientStore = MemoryClientStore(), lines: [String] = [], _ handler: @escaping @Sendable (HTTPRequest) -> HTTPResponse) -> AppEnvironment {
    let ids = Counter()
    let now = Fixtures.demoNow
    return AppEnvironment(
        api: APIClient(baseURL: URL(string: "https://stub.invalid")!, transport: StubTransport(streamLines: lines, handler)), store: store,
        now: { now }, sleep: { _ in await Task.yield() }, uuid: { "00000000-0000-4000-8000-" + String(repeating: "0", count: 11) + String(ids.next() % 10) }
    )
}

func receiptJSON(outcome: String, key: String = "k") -> Data {
    Data("""
    {"schemaVersion":"2026-10-01","commandId":"cmd_hostile1","idempotencyKey":"\(key)","commandType":"record_wear","outcome":"\(outcome)",
     "replayed":false,"rebased":false,"affected":[],"summary":"Accepted for later","facts":{},"effects":{"state":"none","items":[]},
     "undo":{"available":false},"compensatesCommandId":null,"undoneByCommandId":null,"occurredAt":"2026-10-06T05:52:00Z",
     "recordedAt":"2026-10-06T05:52:00Z","error":null}
    """.utf8)
}

@Suite("Adversarial: hostile servers, malformed data, misuse")
@MainActor
struct AdversarialTests {
    @Test func anUnknownOutcomeIsNeverShownAsDone() async {
        let env = stubEnv { _ in HTTPResponse(status: 202, body: receiptJSON(outcome: "accepted")) }
        let q = CommandQueue(env: env)
        let result = ActionResult(await q.submit(.markInWash(garmentId: "g_x1"), label: "x"))
        guard case .refused = result else { Issue.record("an unknown outcome must not read as done: \(result)"); return }
        #expect(q.items.first?.state == .rejected("Unrecognised result \"accepted\"; check receipts"))
    }

    @Test func garbageInsteadOfTodayKeepsTheCachedBoard() async throws {
        let store = MemoryClientStore()
        store.save(TodaySnapshot(response: try Fixtures.today, checkedAt: Fixtures.demoNow), StoreKey.today)
        let env = stubEnv(store: store) { _ in HTTPResponse(status: 200, body: Data("<html>Cloudflare challenge</html>".utf8)) }
        let vm = TodayViewModel(env: env, queue: CommandQueue(env: env))
        await vm.refresh()
        #expect(vm.cards.count == 5)
        #expect(vm.freshnessLabel == "Couldn't refresh · last checked 06:52")
        guard case .decoding = vm.lastError else { Issue.record("expected decoding error"); return }
    }

    @Test func aCorruptedCacheIsIgnoredNotFatal() {
        let store = MemoryClientStore()
        for key in [StoreKey.today, StoreKey.pendingCommands, StoreKey.receipts, StoreKey.conversation, StoreKey.studio, StoreKey.wardrobe] {
            store.setData(Data("{not json".utf8), forKey: key)
        }
        let env = stubEnv(store: store) { _ in HTTPResponse(status: 503) }
        let q = CommandQueue(env: env)
        #expect(q.items.isEmpty)
        #expect(TodayViewModel(env: env, queue: q).cards.isEmpty)
        #expect(ReceiptCenter(env: env).receipts.isEmpty)
        #expect(ConversationViewModel(env: env, receipts: ReceiptCenter(env: env)).messages.isEmpty)
        #expect(StudioViewModel(env: env, queue: q, wardrobe: WardrobeViewModel(env: env)).state == StudioState())
    }

    @Test func scopeRefusalIsARejectionNotASignOut() async {
        let env = stubEnv { _ in HTTPResponse(status: 403, body: Data(#"{"schemaVersion":"2026-10-01","error":{"code":"insufficient_scope","message":"This connection is read-only"}}"#.utf8)) }
        let q = CommandQueue(env: env)
        _ = await q.submit(.markInWash(garmentId: "g_x1"), label: "x")
        #expect(q.items.first?.state == .rejected("This connection is read-only"))
    }

    @Test func malformedAndUnknownStreamDataNeverCrashesAndStillAdvances() async throws {
        let lines = [
            "id: 1", "event: text_delta", "data: {this is not json", "",
            "id: 2", "data: {\"eventId\":\"2\",\"runId\":\"run_s\",\"type\":\"quantum_update\",\"data\":{}}", "",
            "id: 3", "data: {\"eventId\":\"3\",\"runId\":\"run_s\",\"type\":\"text_delta\",\"data\":{\"messageId\":\"msg_s\",\"delta\":\"ok\"}}", "",
            "id: 4", "data: {\"eventId\":\"4\",\"runId\":\"run_s\",\"type\":\"run_finished\",\"data\":{\"messageId\":\"msg_s\",\"status\":\"finished\",\"message\":null}}", "",
        ]
        let env = stubEnv(lines: lines) { r in
            if r.path == "/v1/conversation/turns" { return HTTPResponse(status: 200, body: Data(#"{"clientTurnId":"t","messageId":"msg_u","runId":"run_s","status":"accepted"}"#.utf8)) }
            return HTTPResponse(status: 404)
        }
        let vm = ConversationViewModel(env: env, receipts: ReceiptCenter(env: env))
        vm.draft = "hi"
        await vm.send()
        #expect(vm.messages.first { $0.messageId == "msg_s" }?.plainText == "ok")
        #expect(vm.ignoredEventTypes.contains("quantum_update"))
        #expect(!vm.isReplying)
    }

    @Test func speculativeOutfitCardsAreNotActionable() {
        let unvalidated = OutfitCard(boardId: "brd_x", optionId: "opt_x", boardRevision: 1, garmentIds: ["g_invented"], explanation: "Trust me", validated: false)
        let unbound = OutfitCard(boardId: nil, optionId: nil, boardRevision: nil, garmentIds: ["g_a"], explanation: "Idea", validated: true)
        #expect(!unvalidated.isActionable)
        #expect(!unbound.isActionable)
    }

    @Test func aShoeFromAnotherOptionCannotBeSelected() async throws {
        let h = try Harness.make()
        let vm = TodayViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        let two = vm.cards[1].optionId
        let foreign = vm.cards[2].footwear.alternatives[0].garmentId
        vm.selectFootwear(optionId: two, garmentId: foreign)
        #expect(vm.footwear[two] == nil)
        guard case .needsFootwear = await vm.iWore(two) else { Issue.record("must still ask"); return }
    }

    @Test func withdrawnOptionsAreNeverOffered() async throws {
        let h = try Harness.make()
        var t = try Fixtures.today
        for i in t.board!.options.indices { t.board!.options[i].status = "withdrawn" }
        await h.server.replaceToday(t)
        let vm = TodayViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        #expect(vm.cards.isEmpty)
        #expect(await vm.iWore(t.board!.options[0].optionId) == .refused("That option is no longer on the board"))
    }

    @Test func aStaleOptionAfterRepublicationIsAConflictNotAWrongSelection() async throws {
        let h = try Harness.make()
        let vm = TodayViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.refresh()
        let chosen = vm.cards[0].optionId
        var t = try Fixtures.today
        t.board!.options[0].optionId = "opt_republished"
        await h.server.replaceToday(t) // backend republished while the phone showed the old revision
        guard case .refused(let why) = await vm.choose(chosen) else { Issue.record("expected refusal"); return }
        #expect(why.contains("board changed"))
    }

    @Test func overlongDraftsAreKeptButNotSent() throws {
        let h = try Harness.make()
        let vm = ConversationViewModel(env: h.env, receipts: ReceiptCenter(env: h.env))
        vm.draft = String(repeating: "a", count: ConversationViewModel.maxLength + 1)
        #expect(vm.draftTooLong)
        #expect(!vm.canSend)
    }

    @Test func impossibleCountCorrectionsAreRefusedLocally() async throws {
        let h = try Harness.make()
        let w = WardrobeViewModel(env: h.env)
        await w.refresh()
        let ivm = ItemDetailViewModel(garmentId: try Fixtures.wardrobe.id("Merino — inky blue"), env: h.env, queue: CommandQueue(env: h.env), receipts: ReceiptCenter(env: h.env), wardrobe: w)
        #expect(await ivm.reconcile(clean: -1, totalOwned: nil) == .refused("Counts run from 0 to 500"))
        #expect(await ivm.reconcile(clean: 9, totalOwned: 4) == .refused("More clean than owned"))
        #expect(await h.server.requests(matching: "/v1/commands").isEmpty)
    }

    @Test func anEmptyStyleProfileIsNeverSaved() async throws {
        let h = try Harness.make()
        let vm = MyStyleViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await vm.load()
        vm.beginEditing()
        vm.draft = "   \n"
        await vm.save()
        #expect(vm.saveState == .idle)
        #expect(await h.server.requests(matching: "/v1/commands").isEmpty)
    }

    @Test func duplicateMessagesFromPageAndStreamMergeOnce() async throws {
        let h = try Harness.make()
        let vm = ConversationViewModel(env: h.env, receipts: ReceiptCenter(env: h.env))
        vm.draft = "hello"
        await vm.send()
        await vm.load() // the page now also contains the settled reply and the user turn
        #expect(vm.messages.filter { $0.messageId == "msg_run_fixture1" }.count == 1)
        #expect(vm.messages.filter { $0.role == "user" && $0.plainText == "hello" }.count == 1)
    }

    @Test func theReceiptHistoryIsBounded() {
        let env = stubEnv { _ in HTTPResponse(status: 503) }
        let rc = ReceiptCenter(env: env)
        for i in 0..<320 {
            rc.record(CommandReceipt(commandId: "cmd_n\(i)", idempotencyKey: "k\(i)", commandType: "mark_in_wash", outcome: .committed, summary: "\(i)", occurredAt: Fixtures.demoNow, recordedAt: Fixtures.demoNow), announce: false)
        }
        #expect(rc.receipts.count == 300)
        #expect(rc.receipts.first?.commandId == "cmd_n319")
    }

    @Test func randomisedFootwearAndSwapSequencesAlwaysLogExactlyOneShoe() async throws {
        // Seeded pseudo-random journeys over the demo board (deterministic, repeatable).
        var rng = SplitMix(seed: 20261006)
        for round in 0..<40 {
            let h = try Harness.make()
            let vm = TodayViewModel(env: h.env, queue: CommandQueue(env: h.env))
            await vm.refresh()
            let card = vm.cards[Int(rng.next() % UInt64(vm.cards.count))]
            for _ in 0..<Int(rng.next() % 4) {
                let alts = card.footwear.alternatives
                vm.selectFootwear(optionId: card.optionId, garmentId: alts[Int(rng.next() % UInt64(alts.count))].garmentId)
            }
            let result = await vm.iWore(card.optionId)
            if case .needsFootwear = result {
                #expect(card.footwear.requiresChoice, "round \(round)")
                continue
            }
            let env = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: #require(await h.server.requests(matching: "/v1/commands").last?.body))
            #expect(env.command["items"]!.arrayValue!.filter { $0["role"]?.stringValue == "footwear" }.count == 1, "round \(round)")
            #expect(env.command["items"]!.arrayValue!.contains { $0["role"]?.stringValue == "socks" }, "socks always")
        }
    }
}

struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
