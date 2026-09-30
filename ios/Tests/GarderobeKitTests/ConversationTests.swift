import Foundation
import Testing
@testable import GarderobeKit

@Suite("Conversation")
@MainActor
struct ConversationTests {
    func make(manual: Bool = false, h: Harness? = nil) throws -> (Harness, ConversationViewModel, ReceiptCenter) {
        let h = try h ?? Harness.make(manualSleep: manual)
        let rc = ReceiptCenter(env: h.env)
        return (h, ConversationViewModel(env: h.env, receipts: rc), rc)
    }

    func lastTurn(_ h: Harness) async throws -> TurnRequest {
        try GarderobeJSON.decoder().decode(TurnRequest.self, from: #require(await h.server.requests(matching: "/v1/conversation/turns").last?.body))
    }

    @Test func oneContinuousTranscriptWithDateSeparators() async throws {
        let (_, vm, _) = try make()
        await vm.load()
        let dates = vm.rows.compactMap { if case .dateSeparator(let d) = $0 { d.rawValue } else { nil } }
        #expect(dates == ["2026-07-14", "2026-10-05"])
        #expect(vm.dateLabel(LocalDate("2026-10-05")!) == "Yesterday")
        #expect(vm.dateLabel(LocalDate("2026-07-14")!) == "Tuesday 14 July")
        #expect(vm.dateLabel(LocalDate("2025-07-14")!) == "Monday 14 July 2025")
    }

    @Test func streamedReplyMergesIntoOneStableMessage() async throws {
        let (h, vm, _) = try make()
        await vm.load()
        vm.draft = "What for dinner in Borough?"
        await vm.send()
        #expect(vm.draft.isEmpty)
        #expect(vm.pendingTurns.isEmpty)
        #expect(!vm.isReplying)
        let turn = try await lastTurn(h)
        let reply = try #require(vm.messages.first { $0.messageId == "msg_run_fixture1" })
        #expect(reply.plainText == "Seventeen at the peak, so a lightweight oxford with the jacket for the walk home.")
        #expect(reply.status == "complete")
        #expect(reply.parts.contains { if case .outfitCard(let c) = $0 { c.isActionable } else { false } })
        #expect(reply.parts.contains { if case .sources = $0 { true } else { false } })
        #expect(vm.messages.filter { $0.clientTurnId == turn.clientTurnId }.count == 1)
        #expect(vm.ignoredEventTypes == ["tool_progress_v9"]) // unknown event type tolerated
        #expect(vm.activity == nil)
    }

    @Test func droppedStreamReconnectsWithTheLastEventIDAndDuplicatesNothing() async throws {
        let (h, vm, _) = try make()
        await h.server.dropNextStream(after: 3)
        vm.draft = "Hello"
        await vm.send()
        let streams = await h.server.requests(matching: "/v1/runs/run_fixture1/events")
        #expect(streams.count == 2)
        #expect(streams[0].headers["Last-Event-ID"] == nil)
        #expect(streams[1].headers["Last-Event-ID"] == "3")
        let reply = try #require(vm.messages.first { $0.messageId == "msg_run_fixture1" })
        #expect(reply.plainText == "Seventeen at the peak, so a lightweight oxford with the jacket for the walk home.")
    }

    @Test func replayedEventsAreIgnored() throws {
        let (_, vm, _) = try make()
        let ev = RunEvent(eventId: "7", runId: "run_x", type: "text_delta", at: nil, data: ["messageId": "msg_x", "delta": "once"])
        vm.handle(ev, runId: "run_x")
        vm.handle(ev, runId: "run_x")
        #expect(vm.messages.first { $0.messageId == "msg_x" }?.plainText == "once")
    }

    @Test func offlineTurnWaitsWithItsStableIDAndIsDeliveredOnReconnect() async throws {
        let (h, vm, _) = try make()
        await h.server.setOffline(true)
        vm.draft = "Does the clay jacket work with cords?"
        await vm.send()
        let pending = try #require(vm.pendingTurns.first)
        #expect(pending.stateLabel == "Waiting for a connection")
        #expect(vm.rows.last == .pending(pending))
        // Relaunch while offline: the turn is still there.
        let (_, again, _) = try make(h: try h.relaunched())
        #expect(again.pendingTurns.map(\.clientTurnId) == [pending.clientTurnId])
        await h.server.setOffline(false)
        await again.resume()
        #expect(again.pendingTurns.isEmpty)
        #expect(try await lastTurn(h).clientTurnId == pending.clientTurnId)
    }

    @Test func aRepeatedTurnIDReturnsTheExistingTurn() async throws {
        let h = try Harness.make()
        let req = TurnRequest(clientTurnId: "turn_same0001", text: "Hi")
        let first = try await h.env.api.sendTurn(req)
        let second = try await h.env.api.sendTurn(req)
        #expect(first.runId == second.runId)
        #expect(second.status == "existing")
        #expect(await h.server.messages.filter { $0.clientTurnId == "turn_same0001" }.count == 1)
    }

    @Test func aTurnSentWhileReplyingWaitsThenStopAndSendInterrupts() async throws {
        let (h, vm, _) = try make(manual: true)
        await h.server.dropNextStream(after: 2) // the reply stalls mid-way (reconnect sleeps on the manual clock)
        vm.draft = "First question"
        let first = Task { await vm.send() }
        await eventually("stalled reply") { await h.clock.pending == 1 }
        #expect(vm.isReplying)
        vm.draft = "Actually, a second thought"
        await vm.send()
        #expect(vm.pendingTurns.map(\.stateLabel) == ["Waiting"])
        vm.draft = "Stop and ask this instead"
        await vm.stopAndSend()
        await h.clock.advance() // the stalled stream wakes, sees it was cancelled, and leaves the new run alone
        await first.value
        #expect(await h.server.cancelledRuns == ["run_fixture1"])
        #expect(vm.pendingTurns.isEmpty)
        let turns = try await h.server.requests(matching: "/v1/conversation/turns").map { try GarderobeJSON.decoder().decode(TurnRequest.self, from: $0.body!) }
        // Stop and send goes first, flagged stopCurrent; the earlier waiting turn follows.
        #expect(turns.map(\.text) == ["First question", "Stop and ask this instead", "Actually, a second thought"])
        #expect(turns.map(\.stopCurrent) == [nil, true, nil])
        #expect(await h.server.requests(matching: "/v1/runs/run_fixture1/cancel").isEmpty) // no separate cancel call
        #expect(vm.messages.first { $0.messageId == "msg_run_fixture1" }?.status == "stopped")
        #expect(!vm.isReplying)
    }

    @Test func aQuestionPausesTheRunAndIsAnsweredNatively() async throws {
        let (h, vm, rc) = try make()
        vm.draft = "[ask] Log the grey ones?"
        await vm.send()
        let q = try #require(vm.needsInput)
        #expect(q.prompt == "Which shoes did you mean?")
        #expect(q.pendingActionId != nil)
        #expect(vm.isReplying && vm.isAwaitingAnswer)
        // Relaunch while waiting: the durable run restores the question (input_required + pendingAction).
        let (_, again, _) = try make(h: try h.relaunched())
        _ = again
        let status = try await h.env.api.run("run_fixture1")
        #expect(status.status == .inputRequired)
        #expect(status.pendingAction?.choices.map(\.id) == ["grey", "olive"])
        await vm.answer(q.choices[1])
        #expect(vm.needsInput == nil)
        #expect(!vm.isReplying)
        #expect(rc.receipts.first?.summary == "Chosen: NB 990v4 — olive/cream. This is a plan, not a recorded wear.")
        #expect(vm.messages.first { $0.messageId == "msg_run_fixture1" }?.plainText == "Noted: NB 990v4 — olive/cream.")
        let body = try #require(await h.server.requests(matching: "/v1/runs/run_fixture1/input").last?.body)
        #expect(try GarderobeJSON.decoder().decode([String: String].self, from: body) == ["choiceId": "olive"])
        // Answering twice executes nothing more.
        let replay = try await h.env.api.answerRun("run_fixture1", choiceId: "olive")
        #expect(replay.status == .executed && replay.receipt?.commandId == rc.receipts.first?.commandId) // the original receipt, replayed
    }

    @Test func notNowDeclinesTheQuestionAndExecutesNothing() async throws {
        let (h, vm, rc) = try make()
        vm.draft = "[ask] Log the grey ones?"
        await vm.send()
        #expect(vm.isAwaitingAnswer)
        await vm.declineQuestion()
        #expect(vm.needsInput == nil)
        #expect(!vm.isReplying)
        #expect(vm.lastError == nil)
        #expect(rc.receipts.isEmpty) // nothing was executed
        let body = try #require(await h.server.requests(matching: "/v1/runs/run_fixture1/input").last?.body)
        #expect(try GarderobeJSON.decoder().decode(RunInputRequest.self, from: body).choiceId == nil)
        #expect(String(decoding: body, as: UTF8.self).contains("\"choiceId\":null"))
        #expect(try await h.env.api.run("run_fixture1").status == .cancelled)
        // A late answer to a declined question is refused as declined, not executed.
        #expect(try await h.env.api.answerRun("run_fixture1", choiceId: "olive").status == .declined)
    }

    @Test func anExpiredQuestionSaysSoAndChangesNothing() async throws {
        let clock = NativeAuthTests.TestClock()
        let h = try Harness.make(server: FixtureServer(now: { clock.now() }))
        let (_, vm, rc) = try make(h: h)
        vm.draft = "[ask] Log the grey ones?"
        await vm.send()
        let q = try #require(vm.needsInput)
        clock.advance(11 * 60) // the pending action lives 10 minutes
        await vm.answer(q.choices[1])
        #expect(vm.needsInput == nil)
        #expect(vm.lastError?.hasPrefix("That question expired") == true)
        #expect(rc.receipts.isEmpty)
        #expect(!vm.isReplying)
    }

    @Test func anExpiredCursorGetsASnapshotThatReplacesTheMessage() async throws {
        let (h, vm, _) = try make()
        await h.server.dropNextStream(after: 3)
        await h.server.setCursorsExpired(true)
        vm.draft = "Hello"
        await vm.send()
        let streams = await h.server.requests(matching: "/v1/runs/run_fixture1/events")
        #expect(streams.count == 2)
        #expect(streams[1].headers["Last-Event-ID"] == "3")
        let reply = try #require(vm.messages.first { $0.messageId == "msg_run_fixture1" })
        // Replaced by the snapshot, not appended to: no duplicated text.
        #expect(reply.plainText == "Seventeen at the peak, so a lightweight oxford with the jacket for the walk home.")
        #expect(reply.status == "complete")
        #expect(!vm.isReplying)
    }

    @Test func draftSurvivesRelaunch() throws {
        let (h, vm, _) = try make()
        vm.draft = "Half a thought about the Chasseur"
        let (_, again, _) = try make(h: try h.relaunched())
        #expect(again.draft == "Half a thought about the Chasseur")
    }

    @Test func loadingOlderKeepsTheReadingAnchor() async throws {
        let (_, vm, _) = try make()
        await vm.load()
        let anchor = await vm.loadOlder()
        #expect(anchor == "msg_july1")
        #expect(vm.messages.contains { $0.messageId == "msg_june1" })
        #expect(!vm.hasOlder)
        #expect(await vm.loadOlder() == nil)
        let dates = vm.rows.compactMap { if case .dateSeparator(let d) = $0 { d.rawValue } else { nil } }
        #expect(dates.first == "2026-06-02")
    }

    @Test func recallFindsWhatWasDiscussedMonthsAgoAndOpensItInPlace() async throws {
        let (h, vm, _) = try make()
        await vm.load()
        #expect(!vm.messages.contains { $0.messageId == "msg_june1" }) // June is not on the phone yet
        await vm.searchHistory("  City blazer  ")
        guard case .results(let r) = vm.recall else { Issue.record("expected results, got \(vm.recall)"); return }
        let hit = try #require(r.hits.first)
        #expect(hit.messageId == "msg_june1")
        #expect(hit.localDate.rawValue == "2026-06-02")
        #expect(hit.speaker == "owner")
        #expect(hit.context.after?.hasPrefix("No. Cotton-linen") == true)
        #expect(vm.coverageNote(r) == nil)
        let sent = try GarderobeJSON.decoder().decode(RecallSearchRequest.self, from: #require(await h.server.requests(matching: "/v1/recall/search").last?.body))
        #expect(sent.query == "City blazer")
        // Opening the hit loads the page around it and anchors the transcript there.
        #expect(await vm.open(recalled: hit.messageId) == "msg_june1")
        #expect(vm.messages.contains { $0.messageId == "msg_june1" })
        #expect(vm.readingAnchor == "msg_june1")
        #expect(await h.server.requests(matching: "/v1/conversation/messages").last?.query["around"] == "msg_june1")
        #expect(await vm.open(recalled: "msg_does_not_exist") == nil)
        #expect(vm.readingAnchor == "msg_june1")
    }

    @Test func offlineRecallSearchesOnlyThePhoneAndSaysSo() async throws {
        let (h, vm, _) = try make()
        await vm.load()
        await h.server.setOffline(true)
        await vm.searchHistory("rust suede")
        guard case .localOnly(let found, let note) = vm.recall else { Issue.record("expected local results"); return }
        #expect(found.map(\.messageId) == ["msg_july1"])
        #expect(note.hasPrefix("Offline"))
        await vm.searchHistory("City blazer") // discussed in June, which is not on the phone
        guard case .localOnly(let none, _) = vm.recall else { Issue.record("expected local results"); return }
        #expect(none.isEmpty)
        let before = await h.server.requests(matching: "/v1/recall/search").count
        await vm.searchHistory("   ")
        #expect(vm.recall == .idle)
        #expect(await h.server.requests(matching: "/v1/recall/search").count == before) // a blank query sends nothing
    }

    @Test func aPastedRecoveryCodeIsRemovedAndTheNoticeFollowsTheReply() async throws {
        let (h, vm, _) = try make()
        let secret = "GRDB.rcv_abc123.SeCrEtPaRt0987654321"
        vm.draft = "Keep this safe for me: \(secret) thanks"
        await vm.send()
        let (messageId, sentNotice) = try #require(vm.notices.first)
        #expect(sentNotice.removedRecoveryCode)
        let runId = try #require(await h.server.requests(matching: "/v1/runs/").first.map { $0.path.split(separator: "/")[2] }).description
        // The turn's run id is kept for matching its server card, independent of the transcript copy.
        #expect(vm.noticeRunIds[messageId] == runId)
        #expect(vm.messages.first { $0.messageId == messageId }?.runId == runId)
        let mine = try #require(vm.messages.first { $0.role == "user" && $0.messageId == messageId })
        // The stored message is the canonical, redacted one; the secret is nowhere on the phone.
        #expect(mine.plainText == "Keep this safe for me: [recovery code removed] thanks")
        let stored = h.store.keys.compactMap { h.store.data(forKey: $0) }.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(!stored.contains("SeCrEtPaRt0987654321"))
        #expect(!vm.messages.contains { $0.plainText.contains("SeCrEtPaRt") })
        // The notice comes after the reply to that turn and suggests a new code.
        let rows = vm.rows
        let userIndex = try #require(rows.firstIndex { $0.id == messageId })
        let replyIndex = try #require(rows.firstIndex { $0.id == "msg_\(runId)" })
        let noticeIndex = try #require(rows.firstIndex { if case .notice = $0 { true } else { false } })
        #expect(userIndex < replyIndex && replyIndex < noticeIndex)
        guard case .notice(let id, let notice) = rows[noticeIndex] else { return }
        #expect(id == messageId)
        #expect(notice.title == "Recovery code removed from your message")
        #expect(notice.summary.contains("create a new one"))
        #expect(notice.redacted == [.init(kind: "recovery_code", count: 1)])
        // The backend's settled card names this turn as `message:<owner message id>`, so after a reload the note
        // is shown once, as that card, and the local copy is dropped.
        await vm.load()
        let cards = vm.messages.flatMap { $0.parts.compactMap { if case .resultCard(let c) = $0, c.kind == "notice" { c } else { nil } } }
        #expect(cards.map(\.jobRef) == ["message:\(messageId)"])
        let localNotices: [String] = vm.rows.compactMap { if case .notice(let id, _) = $0 { id } else { nil } }
        #expect(localNotices.isEmpty)
    }

    func seededNotices(serverCardJobRef: String, userMessagesCarryRunIds: Bool = true, storedRunIds: [String: String] = [:]) throws -> ConversationViewModel {
        let h = try Harness.make()
        let t0 = h.env.now().addingTimeInterval(-3600)
        let notice = TurnNotice(title: "Recovery code removed from your message", summary: "Treat that code as exposed and create a new one in Settings.", redacted: [.init(kind: "recovery_code", count: 1)])
        let messages = [
            ConversationMessage(messageId: "msg_first", clientTurnId: "turn_first01", role: "user", createdAt: t0, parts: [.text("code [recovery code removed]")], runId: userMessagesCarryRunIds ? "run_first" : nil),
            ConversationMessage(messageId: "msg_first_reply", role: "assistant", createdAt: t0.addingTimeInterval(10), parts: [.text("Noted.")], runId: "run_first"),
            ConversationMessage(messageId: "msg_second", clientTurnId: "turn_second1", role: "user", createdAt: t0.addingTimeInterval(60), parts: [.text("again [recovery code removed]")], runId: userMessagesCarryRunIds ? "run_second" : nil),
            ConversationMessage(messageId: "msg_second_reply", role: "assistant", createdAt: t0.addingTimeInterval(70), parts: [.text("Noted again.")], runId: "run_second"),
            // Only the later turn has a settled server card, with the same title as the earlier notice.
            ConversationMessage(messageId: "delivery_redaction:second", role: "assistant", createdAt: t0.addingTimeInterval(71), sourceChannel: "system",
                                parts: [.resultCard(ResultCard(kind: "notice", title: notice.title, summary: notice.summary, jobRef: serverCardJobRef))]),
        ]
        h.env.store.save(messages, StoreKey.conversation)
        h.env.store.save(["msg_first": notice, "msg_second": notice], StoreKey.restoration + "-notices")
        h.env.store.save(storedRunIds, StoreKey.restoration + "-notice-runs")
        return ConversationViewModel(env: h.env, receipts: ReceiptCenter(env: h.env))
    }

    func noticeRows(_ vm: ConversationViewModel) -> [String] {
        vm.rows.compactMap { if case .notice(let id, _) = $0 { id } else { nil } }
    }

    /// Row ids in order, without date separators.
    func transcriptIds(_ vm: ConversationViewModel) -> [String] {
        vm.rows.compactMap { row -> String? in
            if case .dateSeparator = row { return nil }
            return row.id
        }
    }

    func seeded(_ messages: [ConversationMessage], notices ids: [String], runIds: [String: String] = [:]) throws -> ConversationViewModel {
        let h = try Harness.make()
        let notice = TurnNotice(title: "Recovery code removed from your message", summary: "Treat that code as exposed and create a new one in Settings.", redacted: [.init(kind: "recovery_code", count: 1)])
        h.env.store.save(messages, StoreKey.conversation)
        h.env.store.save(Dictionary(uniqueKeysWithValues: ids.map { ($0, notice) }), StoreKey.restoration + "-notices")
        h.env.store.save(runIds, StoreKey.restoration + "-notice-runs")
        return ConversationViewModel(env: h.env, receipts: ReceiptCenter(env: h.env))
    }

    @Test func interleavedTurnsEachShowTheirNoticeAfterTheirOwnReply() throws {
        // Owner A, owner B (queued behind A), reply A, reply B: each notice follows its own turn's reply.
        let t0 = Fixtures.demoNow.addingTimeInterval(-3600)
        let messages = [
            ConversationMessage(messageId: "msg_a", clientTurnId: "turn_aaaaaaaa", role: "user", createdAt: t0, parts: [.text("a [recovery code removed]")], runId: "run_a"),
            ConversationMessage(messageId: "msg_b", clientTurnId: "turn_bbbbbbbb", role: "user", createdAt: t0.addingTimeInterval(5), parts: [.text("b [recovery code removed]")]),
            ConversationMessage(messageId: "msg_a_reply", role: "assistant", createdAt: t0.addingTimeInterval(10), parts: [.text("Reply to A.")], runId: "run_a"),
            ConversationMessage(messageId: "msg_b_reply", role: "assistant", createdAt: t0.addingTimeInterval(20), parts: [.text("Reply to B.")], runId: "run_b"),
        ]
        // B's run id is known only from its turn response (the transcript copy omits it).
        let vm = try seeded(messages, notices: ["msg_a", "msg_b"], runIds: ["msg_b": "run_b"])
        let ids = transcriptIds(vm)
        #expect(ids == ["msg_a", "msg_b", "msg_a_reply", "notice-msg_a", "msg_b_reply", "notice-msg_b"])
    }

    @Test func aReplyCarryingAResultCardIsStillThatTurnsReply() async throws {
        // Settled: the same-run reply has text and a result card. The notice follows it, not the owner's message.
        let t0 = Fixtures.demoNow.addingTimeInterval(-3600)
        let card = ResultCard(kind: "verdict", title: "Navy Mk.IV — keep", summary: "Reads games, not boardroom.", jobRef: "run_card")
        let settled = try seeded([
            ConversationMessage(messageId: "msg_owner", clientTurnId: "turn_owner001", role: "user", createdAt: t0, parts: [.text("[recovery code removed]")], runId: "run_card"),
            ConversationMessage(messageId: "msg_card_reply", role: "assistant", createdAt: t0.addingTimeInterval(10), parts: [.text("Here's my view."), .resultCard(card)], runId: "run_card"),
        ], notices: ["msg_owner"])
        #expect(transcriptIds(settled) == ["msg_owner", "msg_card_reply", "notice-msg_owner"])
        // A reply that is only a result card counts too.
        let cardOnly = try seeded([
            ConversationMessage(messageId: "msg_owner", clientTurnId: "turn_owner001", role: "user", createdAt: t0, parts: [.text("[recovery code removed]")], runId: "run_card"),
            ConversationMessage(messageId: "msg_card_reply", role: "assistant", createdAt: t0.addingTimeInterval(10), parts: [.resultCard(card)], runId: "run_card"),
        ], notices: ["msg_owner"])
        #expect(transcriptIds(cardOnly) == ["msg_owner", "msg_card_reply", "notice-msg_owner"])

        // Streaming: while that reply streams, the notice waits for it rather than sitting after the owner's message.
        let (h, vm, _) = try make(manual: true)
        await h.server.dropNextStream(after: 2)
        vm.draft = "Keep this: GRDB.rcv_abc123.SeCrEtPaRt0987654321"
        let sending = Task { await vm.send() }
        await eventually("stalled reply") { await h.clock.pending == 1 }
        let run = try #require(vm.activeRunId)
        let owner = try #require(vm.notices.keys.first)
        let streaming = ConversationMessage(messageId: "msg_\(run)", role: "assistant", createdAt: Fixtures.demoNow.addingTimeInterval(5), status: "streaming",
                                            parts: [.text("Looking at it"), .resultCard(card)], runId: run)
        vm.handle(RunEvent(eventId: "90", runId: run, type: "snapshot", at: nil, data: ["message": try JSONValue.encode(streaming), "status": "running"]), runId: run)
        #expect(!transcriptIds(vm).contains("notice-\(owner)"))
        var done = streaming
        done.status = "complete"
        vm.handle(RunEvent(eventId: "91", runId: run, type: "run_finished", at: nil, data: ["messageId": .string(done.messageId), "status": "finished", "message": try JSONValue.encode(done)]), runId: run)
        let ids = transcriptIds(vm)
        let reply = try #require(ids.firstIndex(of: done.messageId))
        #expect(ids.firstIndex(of: "notice-\(owner)") == reply + 1)
        // Let the stalled stream wind down (bounded; the assertions above are what this test is about).
        for _ in 0..<20 {
            await h.clock.advance()
            for _ in 0..<50 { await Task.yield() }
            if await h.clock.pending == 0 && !vm.isReplying { break }
        }
        sending.cancel()
    }

    @Test func aTurnWithoutAnIdentifiableReplyStillShowsItsNotice() throws {
        let t0 = Fixtures.demoNow.addingTimeInterval(-3600)
        let messages = [
            // Stopped before replying: its run has no reply.
            ConversationMessage(messageId: "msg_stopped", clientTurnId: "turn_stopped1", role: "user", createdAt: t0, parts: [.text("[recovery code removed]")], runId: "run_stopped"),
            // No run id known at all.
            ConversationMessage(messageId: "msg_unknown", clientTurnId: "turn_unknown1", role: "user", createdAt: t0.addingTimeInterval(5), parts: [.text("[recovery code removed]")]),
            ConversationMessage(messageId: "msg_other_reply", role: "assistant", createdAt: t0.addingTimeInterval(10), parts: [.text("Another turn's reply.")], runId: "run_other"),
        ]
        let ids = transcriptIds(try seeded(messages, notices: ["msg_stopped", "msg_unknown"]))
        // Each notice sits straight after its own message, never beside another turn's reply.
        #expect(ids == ["msg_stopped", "notice-msg_stopped", "msg_unknown", "notice-msg_unknown", "msg_other_reply"])
    }

    @Test func anotherTurnsServerNoticeNeverHidesAnEarlierRecoveryCodeNotice() throws {
        // The later card names the later turn by its message id: only that turn's local copy is hidden.
        let vm = try seededNotices(serverCardJobRef: "message:msg_second")
        #expect(noticeRows(vm) == ["msg_first"])
        let rows = vm.rows.map(\.id)
        let firstReply = try #require(rows.firstIndex(of: "msg_first_reply"))
        let firstNotice = try #require(rows.firstIndex(of: "notice-msg_first"))
        #expect(firstNotice == firstReply + 1) // after its own reply, before the next turn
        // Naming the later turn by its run id works the same way.
        #expect(noticeRows(try seededNotices(serverCardJobRef: "run:run_second")) == ["msg_first"])
        // Also when the transcript page omits the run id: the run id kept from the turn response still matches.
        #expect(noticeRows(try seededNotices(serverCardJobRef: "run:run_second", userMessagesCarryRunIds: false, storedRunIds: ["msg_second": "run_second"])) == ["msg_first"])
        #expect(noticeRows(try seededNotices(serverCardJobRef: "run:run_second", userMessagesCarryRunIds: false)) == ["msg_first", "msg_second"])
    }

    @Test func aServerNoticeTheAppCannotTieToATurnHidesNothing() throws {
        // Today's backend writes its internal turn id, which the contract does not expose: both notices stay.
        #expect(noticeRows(try seededNotices(serverCardJobRef: "turn:turn_9f2c41d0")) == ["msg_first", "msg_second"])
        // A card naming a different turn's id hides neither.
        #expect(noticeRows(try seededNotices(serverCardJobRef: "message:msg_elsewhere")) == ["msg_first", "msg_second"])
    }

    @Test func repeatedRecoveryCodeRemovalsEachKeepTheirNoticeAfterReload() async throws {
        let (_, vm, _) = try make()
        vm.draft = "first GRDB.rcv_abc123.SeCrEtPaRt0987654321"
        await vm.send()
        vm.draft = "second DEMO-ABCDEF0123456789"
        await vm.send()
        #expect(vm.notices.count == 2)
        await vm.load() // both settled server cards are now in the transcript
        let cards = vm.messages.filter { $0.parts.contains { if case .resultCard(let c) = $0 { c.kind == "notice" } else { false } } }
        #expect(cards.count == 2)
        let users = vm.messages.filter { $0.role == "user" && vm.notices[$0.messageId] != nil }.map(\.messageId)
        #expect(users.count == 2)
        // Each settled card names its own turn (`message:<id>`), so each note shows once, as its server card,
        // and neither turn's card stands in for the other's.
        let jobRefs: [String] = cards.flatMap { $0.parts.compactMap { if case .resultCard(let c) = $0, c.kind == "notice" { c.jobRef } else { nil } } }
        #expect(jobRefs.sorted() == users.map { "message:" + $0 }.sorted())
        #expect(noticeRows(vm).isEmpty)
    }

    @Test func withoutTheCanonicalMessageThePlaceholderIsShownNotTheSecret() async throws {
        let (h, vm, _) = try make()
        await h.server.inject(.offline, forPathPrefix: "/v1/conversation/messages")
        vm.draft = "my new code DEMO-ABCDEF0123456789"
        await vm.send()
        let mine = try #require(vm.messages.first { $0.role == "user" })
        #expect(mine.plainText == "[recovery code removed]")
        let stored = h.store.keys.compactMap { h.store.data(forKey: $0) }.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(!stored.contains("ABCDEF0123456789"))
        // The notice survives a relaunch (it names what was removed, never the secret).
        let (_, again, _) = try make(h: try h.relaunched())
        #expect(again.notices.values.first?.removedRecoveryCode == true)
    }

    @Test func otherSecretsSaySecretRemovedAndOrdinaryTextHasNoNotice() async throws {
        let (h, vm, _) = try make()
        vm.draft = "The token was Bearer abcdefghijklmnopqrstuvwxyz0123456789"
        await vm.send()
        let notice = try #require(vm.notices.values.first)
        #expect(!notice.removedRecoveryCode)
        #expect(notice.title == "Secret removed from your message")
        #expect(notice.placeholder == "[secret removed]")
        #expect(vm.messages.first { $0.role == "user" }?.plainText == "The token was <redacted>")
        // Garment names and maker codes are untouched, and no notice appears.
        let (h2, plain, _) = try make()
        plain.draft = "Is the PCF4340 oxford too close to the Reims?"
        await plain.send()
        #expect(plain.notices.isEmpty)
        #expect(plain.messages.first { $0.role == "user" }?.plainText == "Is the PCF4340 oxford too close to the Reims?")
        _ = (h, h2)
    }

    @Test func newOutputWhileScrolledAwayShowsAnAffordance() async throws {
        let (_, vm, _) = try make()
        vm.isAtBottom = false
        vm.handle(RunEvent(eventId: "1", runId: "run_y", type: "text_delta", at: nil, data: ["messageId": "msg_y", "delta": "New"]), runId: "run_y")
        #expect(vm.hasUnseenMessages)
        vm.isAtBottom = true
        #expect(!vm.hasUnseenMessages)
    }

    @Test func askAboutThisSendsTheIdentityNotAGuess() async throws {
        let (h, vm, _) = try make()
        let t = try Fixtures.today
        let ref = ConversationReference.option(boardId: t.board!.boardId, optionId: t.board!.options[2].optionId, boardRevision: 2)
        vm.attach(ref, label: "Option 3")
        vm.attach(ref, label: "Option 3") // no duplicate chip
        #expect(vm.attachments.count == 1)
        #expect(!vm.canSend) // a chip alone is not a turn: the contract needs text or a photo
        vm.draft = "Would this work with the Reims instead?"
        #expect(vm.canSend)
        await vm.send()
        #expect(try await lastTurn(h).references == [ref])
        #expect(vm.attachments.isEmpty)
    }

    @Test func receiptsFromTheAssistantReachTheReceiptCenter() throws {
        let (_, vm, rc) = try make()
        let receipt = try Fixtures.decode(ReceiptsPage.self, "receipts.json").receipts[0]
        vm.handle(RunEvent(eventId: "1", runId: "run_z", type: "command_receipt", at: nil, data: ["receipt": try JSONValue.encode(receipt)]), runId: "run_z")
        #expect(rc.receipts.first?.commandId == receipt.commandId)
        #expect(rc.banner != nil)
    }

    @Test func needsInputOffersOnlyTheUnresolvedChoice() throws {
        let (_, vm, _) = try make()
        vm.handle(RunEvent(eventId: "1", runId: "run_n", type: "needs_input", at: nil, data: [
            "prompt": "Which grey sneakers?", "choices": [["id": "a", "label": "NB 990v4 — grey"], ["id": "b", "label": "NB 993 — grey"]],
        ]), runId: "run_n")
        #expect(vm.needsInput?.choices.map(\.label) == ["NB 990v4 — grey", "NB 993 — grey"])
    }
}

@Suite("Capture")
@MainActor
struct CaptureTests {
    func make() throws -> (Harness, CaptureViewModel, ConversationViewModel) {
        let h = try Harness.make()
        let conv = ConversationViewModel(env: h.env, receipts: ReceiptCenter(env: h.env))
        return (h, CaptureViewModel(intent: .whatIWore, env: h.env, conversation: conv), conv)
    }

    @Test func threeIntents() {
        #expect(CaptureIntent.allCases.map(\.title) == ["Add an item", "Identify this", "What I wore"])
    }

    @Test func aPhotoAloneNeverAuthorizesLogging() async throws {
        let (h, vm, _) = try make()
        vm.add(Data([0xFF, 0xD8, 0xFF]))
        await vm.submit()
        let turn = try GarderobeJSON.decoder().decode(TurnRequest.self, from: #require(await h.server.requests(matching: "/v1/conversation/turns").last?.body))
        #expect(turn.intent == .whatIWore)
        #expect(turn.explicitLog == false)
        #expect(turn.attachmentIds == ["upl_fixture1"])
    }

    @Test func explicitLogThisIsSentOnlyForWhatIWore() async throws {
        let (h, vm, _) = try make()
        vm.add(Data([1, 2, 3]))
        await vm.submit(logIt: true)
        let turn = try GarderobeJSON.decoder().decode(TurnRequest.self, from: #require(await h.server.requests(matching: "/v1/conversation/turns").last?.body))
        #expect(turn.explicitLog)
        vm.intent = .identify
        await vm.submit(logIt: true)
        let second = try GarderobeJSON.decoder().decode(TurnRequest.self, from: #require(await h.server.requests(matching: "/v1/conversation/turns").last?.body))
        #expect(second.explicitLog == false)
    }

    @Test func aTruncatedUploadIsNeverFinalizedAndRetriesInPlace() async throws {
        let (h, vm, _) = try make()
        vm.add(Data(repeating: 7, count: 64))
        await h.server.truncateNextUpload()
        await vm.uploadAll()
        guard case .failed = vm.attachments[0].state else { Issue.record("a short write must fail, got \(vm.attachments[0].state)"); return }
        #expect(await h.server.requests(matching: "/v1/uploads/upl_").filter { $0.path.hasSuffix("/complete") }.isEmpty)
        await vm.upload(vm.attachments[0].id)
        #expect(vm.allUploaded)
    }

    @Test func failedUploadsRetryIndividuallyInPlace() async throws {
        let (h, vm, _) = try make()
        vm.add(Data([1])); vm.add(Data([2]))
        await h.server.inject(.offline, forPathPrefix: "/v1/uploads")
        await vm.uploadAll()
        #expect(vm.attachments[0].state == .failed("No connection"))
        guard case .uploaded = vm.attachments[1].state else { Issue.record("second should upload"); return }
        await vm.upload(vm.attachments[0].id)
        #expect(vm.allUploaded)
        #expect(vm.attachments.count == 2)
    }

    @Test func deniedPhotoAccessStillAllowsDescribingInWords() async throws {
        let (h, vm, _) = try make()
        vm.photoAccess = .denied
        #expect(!vm.canSubmit)
        vm.note = "Blue denim shirt, the 990v4 greys and walnut chinos"
        #expect(vm.canSubmit)
        await vm.submit()
        #expect(vm.submitted)
        #expect(await h.server.requests(matching: "/v1/uploads").isEmpty)
    }
}
