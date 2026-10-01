import Testing
import Foundation
@testable import GarderobeKit

@MainActor
@Suite("Conversation: stable message IDs, reconnection, anchors, drafts and pending turns")
struct ConversationTests {
    private func accepted(_ run: String, replayed: Bool = false) -> JSONValue {
        ["turnId": .string(run), "runId": .string(run), "state": "queued", "replayed": .bool(replayed)]
    }

    @Test("Unknown part types and unknown event types are tolerated")
    func unknownTypesTolerated() async {
        #expect(MessagePart(["type": "hologram", "x": 1]) == .unknown(type: "hologram"))
        #expect(MessagePart(["type": "sources", "sources": "not-an-array"]).isUnknown) // malformed: skipped, not fatal
        #expect(MessagePart(["type": "text", "text": "hello"]) == .text("hello"))

        let router = Router()
        let transport = router.transport
        transport.setStream(path: "/v1/runs/run_1/events", chunks: [Synthetic.sse([
            Synthetic.event(1, run: "run_1", type: "run_started", data: ["kind": "conversation_turn"]),
            Synthetic.event(2, run: "run_1", type: "future_event_kind", data: ["anything": true]),
            Synthetic.event(3, run: "run_1", type: "activity", data: ["text": "Checking the maker's size chart"]),
            Synthetic.event(4, run: "run_1", type: "run_finished", data: ["state": "completed"]),
        ])])
        router.json("GET", "/v1/runs/run_1", Synthetic.run("run_1", reply: ("msg_a", "Done."), lastEventId: 4))
        router.json("GET", "/v1/conversation/messages", Synthetic.page([Synthetic.message("msg_a", text: "Done.")]))
        let env = TestSupport.environment(transport: transport)
        let follower = RunFollower(environment: env, runId: "run_1", transcript: TranscriptModel(environment: env), sleep: { _ in })
        await follower.follow()
        #expect(follower.phase == .completed)
        #expect(follower.activity == nil) // visible work is cleared once the run has finished
        #expect(follower.lastEventId == 4)

        let live = RunFollower(environment: env, runId: "run_2", transcript: nil, sleep: { _ in })
        live.apply(try! Synthetic.event(1, run: "run_2", type: "activity", data: ["text": "Checking the maker's size chart"]).decoded(as: RunEvent.self))
        #expect(live.activity == "Checking the maker's size chart")
    }

    @Test("Deltas merge into one message, replayed events are not applied twice, and the settled message replaces them")
    func deltasMergeAndSettle() async {
        let router = Router()
        let transport = router.transport
        let events = [
            Synthetic.event(1, run: "run_1", type: "run_started", data: ["kind": "conversation_turn"]),
            Synthetic.event(2, run: "run_1", type: "text_delta", data: ["messageId": "msg_a", "delta": "The grey "]),
            Synthetic.event(3, run: "run_1", type: "text_delta", data: ["messageId": "msg_a", "delta": "jumper."]),
            Synthetic.event(3, run: "run_1", type: "text_delta", data: ["messageId": "msg_a", "delta": "jumper."]), // replayed
        ]
        let env = TestSupport.environment(transport: transport)
        let transcript = TranscriptModel(environment: env)
        let follower = RunFollower(environment: env, runId: "run_1", transcript: transcript, sleep: { _ in })
        for raw in events { follower.apply(try! raw.decoded(as: RunEvent.self)) }
        #expect(follower.streamedText == "The grey jumper.")

        // `replace` carries the complete text so far: it replaces, never appends.
        follower.apply(try! Synthetic.event(4, run: "run_1", type: "text_delta", data: ["messageId": "msg_a", "delta": "The grey jumper works.", "replace": true]).decoded(as: RunEvent.self))
        #expect(follower.streamedText == "The grey jumper works.")
        #expect(transcript.entries.map(\.id) == ["msg_a"])
        #expect(transcript.entries.first?.delivery == .streaming)

        // The canonical transcript then holds the same message ID: still exactly one entry.
        router.json("GET", "/v1/conversation/messages", Synthetic.page([Synthetic.message("msg_a", text: "The grey jumper works.")]))
        await transcript.refreshLatest()
        #expect(transcript.entries.map(\.id) == ["msg_a"])
        #expect(transcript.entries.first?.delivery == .settled)
    }

    @Test("A dropped stream reconnects with the last event ID; an expired cursor's snapshot replaces what was streamed")
    func reconnectAndSnapshot() async throws {
        let router = Router()
        let transport = router.transport
        // First connection: two events, then the stream ends without a finish.
        transport.setStream(path: "/v1/runs/run_1/events", chunks: [Synthetic.sse([
            Synthetic.event(1, run: "run_1", type: "run_started", data: ["kind": "conversation_turn"]),
            Synthetic.event(2, run: "run_1", type: "text_delta", data: ["messageId": "msg_a", "delta": "Half an ans"]),
        ])])
        let polls = LockedFlag(false)
        router.on("GET", "/v1/runs/run_1") { _ in
            if !polls.value {
                polls.value = true
                // After the first drop the run is still going; the next connection gets a snapshot.
                transport.setStream(path: "/v1/runs/run_1/events", chunks: [Synthetic.sse([
                    Synthetic.event(9, run: "run_1", type: "snapshot", data: ["reason": "cursor_expired", "run": Synthetic.run("run_1", state: "running", reply: ("msg_a", "The whole answer so far."), lastEventId: 9)]),
                    Synthetic.event(10, run: "run_1", type: "run_finished", data: ["state": "completed"]),
                ])])
                return TestSupport.json(Synthetic.run("run_1", state: "running", lastEventId: 2))
            }
            return TestSupport.json(Synthetic.run("run_1", reply: ("msg_a", "The whole answer."), lastEventId: 10))
        }
        router.json("GET", "/v1/conversation/messages", Synthetic.page([Synthetic.message("msg_a", text: "The whole answer.")]))
        let env = TestSupport.environment(transport: transport)
        let transcript = TranscriptModel(environment: env)
        let follower = RunFollower(environment: env, runId: "run_1", transcript: transcript, sleep: { _ in })
        await follower.follow()

        let streams = transport.requests("GET", "/v1/runs/run_1/events")
        #expect(streams.count == 2)
        #expect(streams[0].headers["Last-Event-ID"] == nil)
        #expect(streams[1].headers["Last-Event-ID"] == "2")
        #expect(follower.reconnects == 1)
        #expect(follower.phase == .completed)
        #expect(transcript.entries.map(\.text) == ["The whole answer."]) // not "Half an ans" + snapshot text
    }

    @Test("When the stream cannot be re-established the run is reported as still running on the server, never as done")
    func connectionLostIsNotDone() async {
        let router = Router()
        router.offline.value = true
        let env = TestSupport.environment(transport: router.transport)
        let follower = RunFollower(environment: env, runId: "run_1", transcript: nil, sleep: { _ in })
        await follower.follow()
        #expect(follower.phase == .connectionLost)
        #expect(!follower.phase.isTerminal)
    }

    @Test("Loading older messages keeps the reading anchor; new output while scrolled away raises the new-message count without moving it")
    func anchorsAndNewMessages() async {
        let router = Router()
        router.on("GET", "/v1/conversation/messages") { request in
            if request.query.contains(where: { $0.name == "before" && $0.value == "cur_1" }) {
                return TestSupport.json(Synthetic.page([Synthetic.message("msg_1", text: "older", at: "2026-07-14T09:00:00Z")]))
            }
            return TestSupport.json(Synthetic.page([Synthetic.message("msg_2", text: "a", at: "2026-09-14T09:00:00Z"), Synthetic.message("msg_3", text: "b")], nextBefore: "cur_1"))
        }
        let env = TestSupport.environment(transport: router.transport)
        let transcript = TranscriptModel(environment: env)
        await transcript.loadLatest()
        #expect(transcript.hasOlder)
        // Date separators: one per local date.
        #expect(transcript.rows.map(\.id) == ["date:2026-09-14", "msg_2", "date:2026-09-15", "msg_3"])

        transcript.setReader(atBottom: false, anchor: "msg_2")
        await transcript.loadOlder()
        #expect(transcript.entries.map(\.id) == ["msg_1", "msg_2", "msg_3"])
        #expect(transcript.readingAnchor == "msg_2")
        #expect(!transcript.hasOlder)

        transcript.applyStream(messageId: "msg_4", text: "new output")
        #expect(transcript.hasNewBelow && transcript.unseenCount == 1)
        #expect(transcript.readingAnchor == "msg_2")
        transcript.setReader(atBottom: true, anchor: "msg_4")
        #expect(!transcript.hasNewBelow)

        // The anchor survives a relaunch.
        #expect(TranscriptModel(environment: env).readingAnchor == "msg_4")
    }

    @Test("Jumping to a recalled message and returning restores the draft and the reading position")
    func jumpAndReturn() async {
        let router = Router()
        router.on("GET", "/v1/conversation/messages") { request in
            if request.query.contains(where: { $0.name == "around" }) {
                return TestSupport.json(Synthetic.page([Synthetic.message("msg_july", text: "what we said in July", at: "2025-07-10T10:00:00Z")]))
            }
            return TestSupport.json(Synthetic.page([Synthetic.message("msg_now", text: "today")]))
        }
        let env = TestSupport.environment(transport: router.transport)
        let transcript = TranscriptModel(environment: env)
        let composer = ComposerModel(environment: env, transcript: transcript, sleep: { _ in })
        await transcript.loadLatest()
        transcript.setReader(atBottom: true, anchor: "msg_now")
        composer.draft = "an unfinished thought"

        await transcript.jump(toMessage: "msg_july")
        #expect(transcript.isViewingHistory)
        #expect(transcript.entries.map(\.id) == ["msg_july"])
        await transcript.returnToLatest()
        #expect(!transcript.isViewingHistory)
        #expect(transcript.entries.map(\.id) == ["msg_now"])
        #expect(transcript.readingAnchor == "msg_now" && transcript.isAtBottom)
        #expect(composer.draft == "an unfinished thought")
    }

    @Test("A draft and its attached identities survive closing the app")
    func draftSurvives() {
        let store = InMemoryKeyValueStore()
        let router = Router()
        let env = TestSupport.environment(transport: router.transport, store: store)
        let composer = ComposerModel(environment: env, transcript: TranscriptModel(environment: env))
        composer.draft = "Half a thought"
        composer.attach(AttachedRef(kind: .boardOption, id: "opt_a", boardId: "brd_test", revision: 3), label: "Test oxford and chinos")

        let again = TestSupport.environment(transport: router.transport, store: store)
        let reopened = ComposerModel(environment: again, transcript: TranscriptModel(environment: again))
        #expect(reopened.draft == "Half a thought")
        #expect(reopened.attachedRefs == [AttachedRef(kind: .boardOption, id: "opt_a", boardId: "brd_test", revision: 3)])
    }

    @Test("A turn whose response was lost is re-sent with the same client turn ID, also after a relaunch")
    func lostResponseSameTurnId() async throws {
        let store = InMemoryKeyValueStore()
        let router = Router()
        router.offline.value = true
        let transport = router.transport
        let env = TestSupport.environment(transport: transport, store: store)
        let composer = ComposerModel(environment: env, transcript: TranscriptModel(environment: env), sleep: { _ in })
        composer.draft = "Is the chore coat enough for ten degrees?"
        await composer.send()
        #expect(composer.draft.isEmpty)
        #expect(composer.pending.map(\.state) == [.waitingToSend])
        #expect(composer.transcript.entries.first?.delivery == .waitingToSend)
        let firstTurn = try #require(transport.requests("POST", "/v1/conversation/turns").first)
        let firstId = try #require(TestSupport.body(firstTurn)["clientTurnId"]?.stringValue)

        // Relaunch, back online.
        router.offline.value = false
        router.json("POST", "/v1/conversation/turns", accepted("run_1", replayed: true))
        transport.setStream(path: "/v1/runs/run_1/events", chunks: [Synthetic.sse([Synthetic.event(1, run: "run_1", type: "run_finished", data: ["state": "completed"])])])
        router.json("GET", "/v1/runs/run_1", Synthetic.run("run_1", reply: ("msg_r", "It wants a layer.")))
        router.json("GET", "/v1/conversation/messages", Synthetic.page([Synthetic.message("msg_o", role: "user", text: "Is the chore coat enough for ten degrees?", turnId: "run_1"), Synthetic.message("msg_r", text: "It wants a layer.", turnId: "run_1")]))
        let again = TestSupport.environment(transport: transport, store: store)
        let reopened = ComposerModel(environment: again, transcript: TranscriptModel(environment: again), sleep: { _ in })
        #expect(reopened.pending.count == 1)
        await reopened.retryPending()

        let sent = transport.requests("POST", "/v1/conversation/turns").map { TestSupport.body($0)["clientTurnId"]?.stringValue }
        #expect(sent.count == 2 && sent.allSatisfy { $0 == firstId })
        #expect(reopened.pending.isEmpty)
        #expect(reopened.transcript.entries.map(\.id) == ["msg_o", "msg_r"]) // the local copy is replaced, not duplicated
    }

    @Test("A final refusal returns the text to the composer instead of losing it")
    func refusalKeepsText() async {
        let router = Router()
        router.on("POST", "/v1/conversation/turns") { _ in TestSupport.error("invalid_command", "The message is too long.", status: 400) }
        let env = TestSupport.environment(transport: router.transport)
        let composer = ComposerModel(environment: env, transcript: TranscriptModel(environment: env), sleep: { _ in })
        composer.draft = "something"
        await composer.send()
        #expect(composer.draft == "something")
        #expect(composer.pending.isEmpty)
        #expect(composer.notice == "The message is too long.")
        #expect(composer.transcript.entries.isEmpty)
    }

    @Test("A question the run is waiting on is answered through the run's input route")
    func needsInputAnswered() async throws {
        let router = Router()
        let transport = router.transport
        let input: JSONValue = ["inputId": "inp_1", "question": "Which shoes?", "choices": [["id": "a", "label": "Test grey sneakers", "detail": .null], ["id": "b", "label": "Test brown derbies", "detail": .null]], "expiresAt": .null, "actionId": "act_1"]
        router.json("POST", "/v1/conversation/turns", accepted("run_1"))
        transport.setStream(path: "/v1/runs/run_1/events", chunks: [Synthetic.sse([Synthetic.event(1, run: "run_1", type: "needs_input", data: ["input": input])])])
        router.json("GET", "/v1/runs/run_1", Synthetic.run("run_1", state: "needs_input", pendingInput: input, lastEventId: 1))
        router.json("GET", "/v1/conversation/messages", Synthetic.page([]))
        router.on("POST", "/v1/runs/run_1/input") { request in
            #expect(TestSupport.body(request) == ["inputId": "inp_1", "choiceId": "b"])
            transport.setStream(path: "/v1/runs/run_1/events", chunks: [Synthetic.sse([Synthetic.event(2, run: "run_1", type: "run_finished", data: ["state": "completed"])])])
            return TestSupport.json(Synthetic.run("run_1", state: "running", lastEventId: 1))
        }
        let env = TestSupport.environment(transport: transport)
        let composer = ComposerModel(environment: env, transcript: TranscriptModel(environment: env), sleep: { _ in })
        composer.draft = "I wore the oxford today"
        await composer.send()
        let question = try #require(composer.pendingInput)
        #expect(question.choices.map(\.label) == ["Test grey sneakers", "Test brown derbies"]) // only the unresolved piece
        #expect(composer.pending.count == 1) // not done while a question is open

        router.json("GET", "/v1/runs/run_1", Synthetic.run("run_1", reply: ("msg_r", "Logged."), lastEventId: 2))
        await composer.answer(choiceId: "b")
        #expect(composer.follower?.phase == .completed)
        #expect(composer.pending.isEmpty)
    }
}

@MainActor
@Suite("Uploads, capture and the share inbox")
struct CaptureTests {
    private func uploadRouter(maxBytes: Int = 1_000_000, complete: JSONValue? = nil) -> Router {
        let router = Router()
        router.on("POST", "/v1/uploads") { request in
            let id = TestSupport.body(request)["clientUploadId"]?.stringValue ?? ""
            return TestSupport.json(["uploadId": .string("upl_" + id), "method": "PUT", "url": .string("/v1/uploads/upl_\(id)/content?token=t"), "requiredHeaders": ["Content-Type": "image/png"],
                                     "maxBytes": .integer(maxBytes), "expiresAt": .string(Synthetic.now), "replayed": false])
        }
        return router
    }

    @Test("A photo larger than the authorized size is refused before any bytes are sent")
    func oversizeRefused() async {
        let router = uploadRouter(maxBytes: 3)
        let transport = router.transport
        let uploads = UploadModel(environment: TestSupport.environment(transport: transport))
        await uploads.add(data: Data([1, 2, 3, 4]), contentType: .imagePng, intent: .attachment)
        guard case .failed(let message, let retryable)? = uploads.items.first?.state else { Issue.record("expected a failure"); return }
        #expect(message.contains("larger than") && !retryable)
        #expect(!transport.requests.contains { $0.method == "PUT" })
        #expect(uploads.readyAssetIds.isEmpty)
    }

    @Test("An interrupted upload keeps its place and retries with the same client upload ID; sending is blocked meanwhile")
    func retryReusesUploadId() async throws {
        let router = uploadRouter()
        let fail = LockedFlag(true)
        router.on("PUT", "/v1/uploads/upl_upload-test-000001/content") { request in
            if fail.value { throw TransportFailure("dropped") }
            #expect(request.headers["Authorization"] == nil) // the upload address carries its own token
            return TestSupport.json(["uploadId": "upl_upload-test-000001", "receivedBytes": 2])
        }
        router.on("POST", "/v1/uploads/upl_upload-test-000001/complete") { _ in
            TestSupport.json(["uploadId": "upl_upload-test-000001", "state": "rejected", "asset": .null, "rejectionReason": "The file is not an image.", "jobId": .null,
                              "receipt": TestSupport.receipt(commandId: "c", type: "media.finalize_upload", summary: "Rejected", undoAvailable: false)])
        }
        let transport = router.transport
        let env = TestSupport.environment(transport: transport)
        let composer = ComposerModel(environment: env, transcript: TranscriptModel(environment: env), sleep: { _ in })
        composer.draft = "with a photo"
        await composer.uploads.add(data: Data([1, 2]), contentType: .imagePng, intent: .attachment)
        #expect(composer.uploads.items.first?.canRetry == true)
        #expect(composer.blockedReason == "A photo did not upload. Retry or remove it.")
        #expect(!composer.canSend)

        fail.value = false
        await composer.uploads.retry(composer.uploads.items[0].id)
        let ids = transport.requests("POST", "/v1/uploads").map { TestSupport.body($0)["clientUploadId"]?.stringValue }
        #expect(ids == ["upload-test-000001", "upload-test-000001"])
        // The backend examined the file and refused it: its reason is shown and the asset cannot be attached.
        #expect(composer.uploads.items.first?.state == .rejected("The file is not an image."))
        #expect(composer.uploads.readyAssetIds.isEmpty)
        #expect(composer.blockedReason == "Remove the photo that was not accepted.")
    }

    @Test("Denied photo access leaves a usable path: the owner can describe it in words")
    func deniedAccessStillUsable() async throws {
        let router = Router()
        router.on("POST", "/v1/conversation/turns") { _ in throw TransportFailure("offline") }
        let transport = router.transport
        let env = TestSupport.environment(transport: transport)
        let capture = CaptureModel(environment: env, composer: ComposerModel(environment: env, transcript: TranscriptModel(environment: env), sleep: { _ in }))
        #expect(capture.blockedReason == "Choose what this is for.")
        capture.intent = .whatIWore
        capture.setPhotoAccess(denied: true)
        #expect(capture.accessMessage?.contains("describe it in words") == true)
        #expect(!capture.canSubmit)
        capture.note = "The grey jumper and dark jeans"
        #expect(capture.canSubmit)
        await capture.submit()
        let turnRequest = try #require(transport.requests("POST", "/v1/conversation/turns").first)
        let body = TestSupport.body(turnRequest)
        #expect(body["intent"]?.stringValue == "what_i_wore")
        #expect(body["text"]?.stringValue == "The grey jumper and dark jeans")
        #expect(capture.isWaitingToSend)                                   // offline: saved, not lost
        #expect(transport.requests("POST", "/v1/commands").isEmpty)        // the sheet never sends a wear command
    }

    @Test("A shared link becomes a product-investigation turn with its stored ID, stays in the inbox while offline, and only web links are accepted")
    func shareInbox() async throws {
        let inbox = ShareInbox(store: InMemoryKeyValueStore())
        #expect(throws: ShareInboxError.notAWebLink) { try inbox.add(url: "javascript:alert(1)", pageTitle: nil, note: nil, id: "turn-share-1", now: Date()) }
        #expect(throws: ShareInboxError.notAWebLink) { try inbox.add(url: "file:///etc/passwd", pageTitle: nil, note: nil, id: "turn-share-2", now: Date()) }
        try inbox.add(url: "https://shop.example/chore-coat", pageTitle: "Chore coat", note: nil, id: "turn-share-000003", now: Date())
        try inbox.add(url: "https://shop.example/chore-coat", pageTitle: "Chore coat", note: nil, id: "turn-share-000003", now: Date()) // the same share twice
        #expect(inbox.all().count == 1)

        let router = Router()
        router.offline.value = true
        let transport = router.transport
        let env = TestSupport.environment(transport: transport)
        let none = await inbox.drain(using: env.api)
        #expect(none.isEmpty && inbox.all().count == 1)

        router.offline.value = false
        router.json("POST", "/v1/conversation/turns", ["turnId": "run_s", "runId": "run_s", "state": "queued", "replayed": false])
        let sentTurns = await inbox.drain(using: env.api)
        #expect(sentTurns.map(\.runId) == ["run_s"])
        #expect(inbox.all().isEmpty)
        let lastTurn = try #require(transport.requests("POST", "/v1/conversation/turns").last)
        let body = TestSupport.body(lastTurn)
        #expect(body["clientTurnId"]?.stringValue == "turn-share-000003")
        #expect(body["intent"]?.stringValue == "product_investigation")
        #expect(body["sharedUrl"]?.stringValue == "https://shop.example/chore-coat")
    }

    @Test("A saved comparison with an old check is shown as stale, not removed")
    func staleComparison() throws {
        let now = try #require(Dates.parseInstant("2026-09-15T06:30:00Z"))
        guard case .productComparison(let comparison) = MessagePart(["type": "product_comparison", "title": "Chore coats", "verdict": "Keep the one you have",
                                                                     "rows": [["maker": "Test Maker", "price": 240]], "checkedAt": "2026-09-12T10:00:00Z"]) else { Issue.record("not parsed"); return }
        #expect(comparison.isStale(now: now))
        #expect(comparison.checkedLine(now: now, timeZone: TimeZone(identifier: "Europe/London")!) == "Checked 12 September at 11:00. May be out of date.")
        #expect(comparison.columns == ["maker", "price"])
        #expect(ProductComparison.cell(comparison.rows[0]["price"]) == "240")
    }
}
