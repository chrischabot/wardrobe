import Foundation
import Observation

/// A turn the owner sent that the backend has not accepted yet. Its `clientTurnId` is stable: a
/// retry after a dropped connection returns the existing turn rather than appending it again.
public struct PendingTurn: Codable, Sendable, Hashable, Identifiable {
    public var id: String { clientTurnId }
    public var clientTurnId: String
    public var text: String
    public var references: [AttachedReference]
    public var attachmentIds: [String]
    public var intent: TurnIntent
    public var explicitLog: Bool
    public var createdAt: Date
    public var state: State
    /// "Stop and send": the server stops the reply in progress before answering this turn.
    public var stopCurrent: Bool = false

    public init(clientTurnId: String, text: String, references: [AttachedReference], attachmentIds: [String], intent: TurnIntent, explicitLog: Bool, createdAt: Date, state: State, stopCurrent: Bool = false) {
        self.clientTurnId = clientTurnId; self.text = text; self.references = references; self.attachmentIds = attachmentIds; self.intent = intent
        self.explicitLog = explicitLog; self.createdAt = createdAt; self.state = state; self.stopCurrent = stopCurrent
    }

    enum CodingKeys: String, CodingKey { case clientTurnId, text, references, attachmentIds, intent, explicitLog, createdAt, state, stopCurrent }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clientTurnId = try c.decode(String.self, forKey: .clientTurnId)
        text = c.value(.text, default: "")
        references = c.value(.references, default: [])
        attachmentIds = c.value(.attachmentIds, default: [])
        intent = c.value(.intent, default: .chat)
        explicitLog = c.value(.explicitLog, default: false)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        state = c.value(.state, default: .waitingForConnection)
        stopCurrent = c.value(.stopCurrent, default: false)
    }

    public enum State: Codable, Sendable, Hashable {
        case waitingForConnection
        /// Queued behind the reply that is still arriving ("Waiting").
        case waitingForReply
        case sending
        case failed(String)
    }

    public var stateLabel: String {
        switch state {
        case .waitingForConnection: "Waiting for a connection"
        case .waitingForReply: "Waiting"
        case .sending: "Sending…"
        case .failed(let m): "Not sent: \(m)"
        }
    }
}

public struct AttachedReference: Codable, Sendable, Hashable, Identifiable {
    public var id: String {
        switch reference {
        case .garment(let g): "g:" + g
        case .option(_, let o, _): "o:" + o
        }
    }
    public var reference: ConversationReference
    /// What the chip shows ("Option 3: Lightweight oxford — pink, …").
    public var label: String
    public init(reference: ConversationReference, label: String) { self.reference = reference; self.label = label }
}

public struct NeedsInput: Sendable, Hashable {
    public struct Choice: Sendable, Hashable, Identifiable {
        public var id: String
        public var label: String
    }
    public var prompt: String
    public var choices: [Choice]
    /// The durable question (`PendingAction`) the answer resolves; nil for a question without one.
    public var pendingActionId: String? = nil
    public var runId: String? = nil
}

/// What one stream event means for the stream loop.
public enum StreamSignal: Sendable, Equatable {
    case `continue`
    case finished
    /// The run is waiting for the owner's answer (input_required); streaming stops until it is given.
    case paused
}

public enum TranscriptRow: Identifiable, Sendable, Hashable {
    case dateSeparator(LocalDate)
    case message(ConversationMessage)
    case pending(PendingTurn)
    /// "Recovery code removed from your message": shown after the reply to the turn it belongs to.
    case notice(messageId: String, TurnNotice)

    public var id: String {
        switch self {
        case .dateSeparator(let d): "date-" + d.rawValue
        case .message(let m): m.messageId
        case .pending(let p): "pending-" + p.clientTurnId
        case .notice(let id, _): "notice-" + id
        }
    }
}

/// One continuous conversation over the backend's SSE projection of Think (spec section 13).
@MainActor
@Observable
public final class ConversationViewModel {
    public private(set) var messages: [ConversationMessage] = []
    public private(set) var hasOlder = true
    public private(set) var isLoadingOlder = false
    public private(set) var pendingTurns: [PendingTurn] = [] { didSet { env.store.save(pendingTurns, StoreKey.pendingTurns) } }
    public private(set) var activeRunId: String?
    public private(set) var activity: String?
    public private(set) var needsInput: NeedsInput?
    public private(set) var ignoredEventTypes: [String] = []
    public private(set) var lastError: String?
    /// The draft survives app closure.
    public var draft: String = "" { didSet { if draft != oldValue { env.store.save(draft, StoreKey.conversationDraft) } } }
    public private(set) var attachments: [AttachedReference] = []
    /// Reading position (message ID) restored after relaunch or returning from an old message.
    public var readingAnchor: String? { didSet { env.store.save(readingAnchor, StoreKey.restoration + "-anchor") } }
    /// Receives a confirmed account operation's private result (AppModel shows it in the account sheet).
    @ObservationIgnored public var onAccountOperation: ((AccountOperationReceipt) -> Void)?
    /// Set by the view: when the reader has scrolled away, new output shows an affordance instead of jumping.
    public var isAtBottom = true { didSet { if isAtBottom { hasUnseenMessages = false } } }
    public private(set) var hasUnseenMessages = false
    /// Notices keyed by the owner's message id. They describe what was removed, never the secret itself.
    public private(set) var notices: [String: TurnNotice] = [:] { didSet { env.store.save(notices, StoreKey.restoration + "-notices") } }
    /// The run id each noticed turn was given in its `TurnResponse`, kept apart from the transcript so a later page
    /// that omits the run id cannot break matching the turn's server notice card by `run:<runId>`.
    public private(set) var noticeRunIds: [String: String] = [:] { didSet { env.store.save(noticeRunIds, StoreKey.restoration + "-notice-runs") } }

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let receiptCenter: ReceiptCenter
    @ObservationIgnored private var olderCursor: String?
    @ObservationIgnored private var cursors: [String: String] = [:]
    @ObservationIgnored private var seenEvents: [String: Set<String>] = [:]
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var isStreaming = false
    @ObservationIgnored public var maxReconnects = 4

    public init(env: AppEnvironment, receipts: ReceiptCenter) {
        self.env = env
        self.receiptCenter = receipts
        messages = env.store.load([ConversationMessage].self, StoreKey.conversation) ?? []
        pendingTurns = (env.store.load([PendingTurn].self, StoreKey.pendingTurns) ?? []).map {
            var t = $0
            if t.state == .sending { t.state = .waitingForConnection }
            return t
        }
        draft = env.store.load(String.self, StoreKey.conversationDraft) ?? ""
        readingAnchor = env.store.load(String.self, StoreKey.restoration + "-anchor")
        notices = env.store.load([String: TurnNotice].self, StoreKey.restoration + "-notices") ?? [:]
        noticeRunIds = env.store.load([String: String].self, StoreKey.restoration + "-notice-runs") ?? [:]
        cursors = env.store.load([String: String].self, StoreKey.runCursors) ?? [:]
    }

    // MARK: Transcript

    /// Date separators between days, in the owner's time zone; pending turns follow the transcript.
    public var rows: [TranscriptRow] {
        var out: [TranscriptRow] = []
        var last: LocalDate?
        let sorted = messages.sorted(by: { $0.createdAt < $1.createdAt })
        let placed = noticePlacement(in: sorted)
        for m in sorted {
            let d = LocalDate(date: m.createdAt, timeZone: env.timeZone)
            if d != last { out.append(.dateSeparator(d)); last = d }
            out.append(.message(m))
            for (id, n) in placed[m.messageId] ?? [] { out.append(.notice(messageId: id, n)) }
        }
        if !pendingTurns.isEmpty {
            let d = LocalDate(date: env.now(), timeZone: env.timeZone)
            if d != last { out.append(.dateSeparator(d)) }
            out += pendingTurns.map(TranscriptRow.pending)
        }
        return out
    }

    /// Where each local notice goes, keyed by the message it follows. A notice follows the reply of its own turn,
    /// found by run id, so interleaved turns (owner A, owner B, reply A, reply B) never put it beside another
    /// turn's reply. While that turn's reply is still streaming, the notice waits for it. A turn that ended
    /// without an identifiable reply (stopped, failed, or no run id known) shows its notice straight after the
    /// owner's own message, so it is never lost.
    func noticePlacement(in sorted: [ConversationMessage]) -> [String: [(String, TurnNotice)]] {
        var placed: [String: [(String, TurnNotice)]] = [:]
        for (i, m) in sorted.enumerated() where m.role == "user" {
            guard let n = notices[m.messageId] else { continue }
            let run = noticeRunIds[m.messageId] ?? m.runId
            if Self.serverShowsNotice(forTurn: m, runId: run, in: sorted) { continue }
            if let run, !run.isEmpty,
               // A same-run reply is the turn's reply whether it carries text, result cards or both; only a
               // settled card of its own (no run id) is not a reply.
               let reply = sorted[(i + 1)...].first(where: { $0.role == "assistant" && $0.runId == run }),
               !(run == activeRunId && reply.status == "streaming") {
                placed[reply.messageId, default: []].append((m.messageId, n))
            } else if let run, run == activeRunId {
                continue // its reply is still coming
            } else {
                placed[m.messageId, default: []].append((m.messageId, n))
            }
        }
        return placed
    }

    /// The references a settled result card can use in `jobRef` to name the owner's turn: identifiers the app
    /// itself holds for that turn (the owner's message id, and its run id from the message or the turn response).
    static func turnReferences(for userMessage: ConversationMessage, runId: String? = nil) -> Set<String> {
        var refs: Set<String> = ["message:" + userMessage.messageId]
        for run in [userMessage.runId, runId].compactMap({ $0 }) where !run.isEmpty { refs.insert("run:" + run) }
        return refs
    }

    /// The backend also settles the note as a `notice` result card after the reply. The local copy is hidden
    /// only when a notice card names this same turn. Titles are shared by every recovery-code removal, so a
    /// card for another turn must never hide this one: a pasted code is exposed, and each notice has to stay
    /// visible. The backend names the turn as `message:<owner message id>` (the `TurnResponse.messageId`). A card
    /// whose `jobRef` the app cannot resolve (older cards used the internal `turn:<turn id>`, which the contract
    /// does not expose) leaves the local notice in place.
    static func serverShowsNotice(forTurn userMessage: ConversationMessage, runId: String? = nil, in messages: [ConversationMessage]) -> Bool {
        let refs = turnReferences(for: userMessage, runId: runId)
        return messages.contains { m in
            m.parts.contains { if case .resultCard(let c) = $0 { c.kind == "notice" && refs.contains(c.jobRef) } else { false } }
        }
    }

    public func dateLabel(_ d: LocalDate) -> String {
        let today = LocalDate(date: env.now(), timeZone: env.timeZone)
        if d == today { return "Today" }
        if d == today.adding(days: -1) { return "Yesterday" }
        return DayLine.dateText(d, timeZone: env.timeZone) + (d.rawValue.prefix(4) == today.rawValue.prefix(4) ? "" : " " + d.rawValue.prefix(4))
    }

    public var isReplying: Bool { activeRunId != nil }

    public func load() async {
        do {
            let page = try await env.api.messages()
            merge(page.messages)
            olderCursor = page.before
            hasOlder = page.hasMore
            lastError = nil
            if let run = page.activeRunId, activeRunId == nil { follow(run) }
        } catch let e as APIError {
            lastError = e == .offline ? nil : e.userMessage
        } catch {}
        await deliverWaitingTurns()
    }

    /// Loads the previous page. Returns the message ID to keep anchored so the reading position holds.
    @discardableResult
    public func loadOlder() async -> String? {
        guard hasOlder, !isLoadingOlder else { return nil }
        let anchor = messages.min(by: { $0.createdAt < $1.createdAt })?.messageId
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let page = try await env.api.messages(before: olderCursor)
            merge(page.messages)
            olderCursor = page.before
            hasOlder = page.hasMore && page.before != nil
        } catch {
            return nil
        }
        return anchor
    }

    /// Stream updates merge into stable message IDs; nothing is duplicated.
    private func merge(_ incoming: [ConversationMessage]) {
        for m in incoming { upsert(m) }
        persist()
    }

    private func upsert(_ m: ConversationMessage) {
        var m = m
        if let i = messages.firstIndex(where: { $0.messageId == m.messageId }) {
            if m.runId == nil { m.runId = messages[i].runId } // a page without the run id keeps the one we know
            messages[i] = m
        } else if let c = m.clientTurnId, let i = messages.firstIndex(where: { $0.clientTurnId == c && $0.role == m.role }) {
            if m.runId == nil { m.runId = messages[i].runId }
            messages[i] = m // our optimistic user message settles to the canonical one
        } else {
            messages.append(m)
        }
    }

    private func persist() {
        let recent = messages.sorted { $0.createdAt < $1.createdAt }.suffix(300)
        env.store.save(Array(recent), StoreKey.conversation)
        env.store.save(cursors, StoreKey.runCursors)
    }

    // MARK: Recall

    public enum RecallState: Equatable, Sendable {
        case idle
        case searching
        /// Results from the whole transcript (POST /v1/recall/search).
        case results(RecallSearchResponse)
        /// The server could not be reached: only messages on this phone were searched, and it says so.
        case localOnly([ConversationMessage], note: String)
        case failed(String)
    }

    public private(set) var recall: RecallState = .idle

    /// Searches everything that was discussed, with dates and quotes, not just the loaded page.
    public func searchHistory(_ text: String, from: LocalDate? = nil, to: LocalDate? = nil) async {
        let q = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { recall = .idle; return }
        let query = String(q.prefix(RecallSearchRequest.maxQueryLength))
        recall = .searching
        do {
            let r = try await env.api.recallSearch(RecallSearchRequest(query: query, from: from, to: to, limit: 20))
            recall = .results(r)
        } catch APIError.offline {
            let local = messages.filter { $0.plainText.localizedCaseInsensitiveContains(query) }.sorted { $0.createdAt > $1.createdAt }
            recall = .localOnly(local, note: "Offline: only the messages on this phone were searched.")
        } catch let e as APIError {
            recall = .failed(e.userMessage)
        } catch {
            recall = .failed("Search is not available right now")
        }
    }

    public func clearRecall() { recall = .idle }

    /// A sentence when the search index had not caught up with the whole transcript.
    public func coverageNote(_ r: RecallSearchResponse) -> String? {
        guard let c = r.coverage, !c.exhaustive else { return nil }
        return c.supplementedFromSource > 0 ? "The newest messages were searched directly; the index is still catching up." : "The search index has not covered every message yet."
    }

    /// Opens a recalled message in the transcript: loads the page around it if it is not on the phone,
    /// and makes it the reading anchor. Returns the message ID to scroll to, or nil if it could not be loaded.
    @discardableResult
    public func open(recalled messageId: String) async -> String? {
        if !messages.contains(where: { $0.messageId == messageId }) {
            guard let page = try? await env.api.messages(around: messageId) else { return nil }
            merge(page.messages)
            guard messages.contains(where: { $0.messageId == messageId }) else { return nil }
        }
        readingAnchor = messageId
        return messageId
    }

    // MARK: Composer

    /// Ask about this: attaches the identity of an item or outfit to the next message.
    public func attach(_ reference: ConversationReference, label: String) {
        let a = AttachedReference(reference: reference, label: label)
        if !attachments.contains(where: { $0.id == a.id }) { attachments.append(a) }
    }

    public func removeAttachment(_ id: String) { attachments.removeAll { $0.id == id } }

    /// TurnRequest's text limit; longer drafts are kept but not sent.
    public static let maxLength = TurnRequest.maxTextLength
    public var draftTooLong: Bool { draft.count > Self.maxLength }
    /// The contract needs text (or a photo); an "Ask about this" chip alone is not a turn.
    public var canSend: Bool { !draftTooLong && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.count <= TurnRequest.maxReferences }

    /// Send the draft. While a reply is still arriving the turn waits ("Waiting"); use stopAndSend to interrupt.
    public func send() async {
        guard canSend else { return }
        needsInput = nil
        let turn = makeTurn(text: draft.trimmingCharacters(in: .whitespacesAndNewlines), references: attachments, attachmentIds: [], intent: .chat, explicitLog: false)
        draft = ""
        attachments = []
        await enqueue(turn)
    }

    /// Capture sends through the same stream with an explicit intent (at most 10 photos per turn).
    public func sendCapture(text: String, attachmentIds: [String], intent: TurnIntent, explicitLog: Bool) async {
        await enqueue(makeTurn(text: text, references: [], attachmentIds: Array(attachmentIds.prefix(TurnRequest.maxAttachments)), intent: intent, explicitLog: explicitLog))
    }

    private func makeTurn(text: String, references: [AttachedReference], attachmentIds: [String], intent: TurnIntent, explicitLog: Bool, stopCurrent: Bool = false) -> PendingTurn {
        PendingTurn(
            clientTurnId: "turn_" + env.uuid().lowercased().replacingOccurrences(of: "-", with: ""), text: text, references: references,
            attachmentIds: attachmentIds, intent: intent, explicitLog: explicitLog, createdAt: env.now(), state: .waitingForConnection, stopCurrent: stopCurrent
        )
    }

    private func enqueue(_ turn: PendingTurn) async {
        var t = turn
        t.state = isReplying ? .waitingForReply : .waitingForConnection
        pendingTurns.append(t)
        isAtBottom = true
        if !isReplying { await deliverWaitingTurns() }
    }

    /// "Stop and send": this turn goes first with `stopCurrent`, so the server stops the reply in
    /// progress (committed effects stay committed) and answers this instead.
    public func stopAndSend() async {
        guard canSend else { await stop(); return }
        needsInput = nil
        var t = makeTurn(text: draft.trimmingCharacters(in: .whitespacesAndNewlines), references: attachments, attachmentIds: [], intent: .chat, explicitLog: false, stopCurrent: activeRunId != nil)
        draft = ""
        attachments = []
        t.state = .waitingForConnection
        if let run = activeRunId {
            if let i = messages.firstIndex(where: { $0.role == "assistant" && ($0.messageId == "msg_\(run)" || $0.runId == run || $0.status == "streaming") }) { messages[i].status = "stopped" }
            streamTask?.cancel()
            streamTask = nil
            activeRunId = nil
            activity = nil
        }
        let firstWaiting = pendingTurns.firstIndex { $0.state == .waitingForConnection || $0.state == .waitingForReply } ?? pendingTurns.endIndex
        pendingTurns.insert(t, at: firstWaiting)
        isAtBottom = true
        await deliverWaitingTurns()
    }

    public func stop() async {
        guard let run = activeRunId else { return }
        do { try await env.api.cancelRun(run) } catch { lastError = "Couldn't reach Garderobe to stop the reply" }
        if let i = messages.firstIndex(where: { $0.messageId == "msg_\(run)" || ($0.status == "streaming") }) { messages[i].status = "stopped" }
    }

    public func retry(_ clientTurnId: String) async {
        if let i = pendingTurns.firstIndex(where: { $0.clientTurnId == clientTurnId }) { pendingTurns[i].state = .waitingForConnection }
        await deliverWaitingTurns()
    }

    public func discard(_ clientTurnId: String) {
        pendingTurns.removeAll { $0.clientTurnId == clientTurnId && $0.state != .sending }
    }

    /// Deliver waiting turns in order, one reply at a time.
    public func deliverWaitingTurns() async {
        while !isReplying, let i = pendingTurns.firstIndex(where: { $0.state == .waitingForConnection || $0.state == .waitingForReply }) {
            let turn = pendingTurns[i]
            pendingTurns[i].state = .sending
            let request = TurnRequest(
                clientTurnId: turn.clientTurnId, text: turn.text, attachmentIds: turn.attachmentIds,
                references: turn.references.map(\.reference), intent: turn.intent, explicitLog: turn.explicitLog, stopCurrent: turn.stopCurrent ? true : nil
            )
            do {
                let response = try await env.api.sendTurn(request)
                pendingTurns.removeAll { $0.clientTurnId == turn.clientTurnId }
                var parts: [MessagePart] = turn.text.isEmpty ? [] : [.text(turn.text)]
                parts += turn.references.map { .reference($0.reference) }
                parts += turn.attachmentIds.map { .attachment(uploadId: $0, contentType: "image/jpeg", thumbnailUrl: nil) }
                if let notice = response.notice {
                    // Garderobe removed a pasted secret before storing the message. The phone must not keep
                    // what the owner typed either: show the canonical (redacted) message, or the placeholder.
                    notices[response.messageId] = notice
                    noticeRunIds[response.messageId] = response.runId
                    parts = turn.text.isEmpty ? [] : [.text(notice.placeholder)]
                    parts += turn.references.map { .reference($0.reference) }
                    parts += turn.attachmentIds.map { .attachment(uploadId: $0, contentType: "image/jpeg", thumbnailUrl: nil) }
                }
                upsert(ConversationMessage(messageId: response.messageId, clientTurnId: turn.clientTurnId, role: "user", createdAt: turn.createdAt, parts: parts, runId: response.runId))
                if response.notice != nil, let page = try? await env.api.messages(around: response.messageId),
                   var canonical = page.messages.first(where: { $0.messageId == response.messageId }) {
                    // Keep the turn's run id: a notice card may name the turn by it (`run:<runId>`).
                    if canonical.runId?.isEmpty ?? true { canonical.runId = response.runId }
                    upsert(canonical)
                }
                persist()
                follow(response.runId)
                await streamTask?.value
            } catch let e as APIError {
                guard let j = pendingTurns.firstIndex(where: { $0.clientTurnId == turn.clientTurnId }) else { return }
                pendingTurns[j].state = e.isRetryable ? .waitingForConnection : .failed(e.userMessage)
                return
            } catch {
                if let j = pendingTurns.firstIndex(where: { $0.clientTurnId == turn.clientTurnId }) { pendingTurns[j].state = .waitingForConnection }
                return
            }
        }
    }

    // MARK: Streaming

    private func follow(_ runId: String) {
        activeRunId = runId
        streamTask = Task { [weak self] in await self?.stream(runId) }
    }

    /// Reconnects with the last event ID; after repeated failures, reconciles from the durable run.
    private func stream(_ runId: String) async {
        isStreaming = true
        defer { isStreaming = false }
        var attempts = 0
        var signal = StreamSignal.continue
        while signal == .continue && !Task.isCancelled {
            let events = await env.api.runEvents(runId, lastEventId: cursors[runId])
            do {
                for try await event in events {
                    if Task.isCancelled { return }
                    let s = handle(event, runId: runId)
                    cursors[runId] = event.eventId
                    if s != .continue { signal = s; break }
                }
            } catch APIError.offline {
                activity = nil
                lastError = nil
                break // resumes on reconnect via resume()
            } catch {
                // dropped connection: fall through to reconnect
            }
            if Task.isCancelled { return }
            persist()
            if signal != .continue { break }
            attempts += 1
            if attempts > maxReconnects {
                signal = await reconcile(runId)
                if signal == .continue { signal = .finished }
                break
            }
            do { try await env.sleep(.milliseconds(400 * attempts)) } catch { break }
        }
        if Task.isCancelled { return }
        if signal == .finished {
            activeRunId = nil
            activity = nil
            cursors.removeValue(forKey: runId)
            seenEvents.removeValue(forKey: runId)
            persist()
        } else if signal == .paused {
            activity = nil
            persist()
        }
    }

    /// True while a run waits for the owner's answer (input_required).
    public var isAwaitingAnswer: Bool { needsInput?.runId != nil && needsInput?.runId == activeRunId }

    /// After a connection change or app foreground: resume the active run and deliver waiting turns.
    public func resume() async {
        if let run = activeRunId, !isStreaming {
            if isAwaitingAnswer { _ = await reconcile(run) } else {
                follow(run)
                await streamTask?.value
            }
        }
        await deliverWaitingTurns()
    }

    /// Answers the pending question natively (POST /v1/runs/{id}/input); the run then continues.
    public func answer(_ choice: NeedsInput.Choice) async { await respond(choiceId: choice.id) }

    /// "Not now": declines the pending question. Nothing is executed and the paused reply ends.
    public func declineQuestion() async { await respond(choiceId: nil) }

    private func respond(choiceId: String?) async {
        guard let q = needsInput, let run = q.runId ?? activeRunId else { return }
        do {
            let result = try await env.api.answerRun(run, choiceId: choiceId)
            // `executed` also covers a replayed answer: the same receipt comes back, never a second command.
            if let r = result.receipt { receiptCenter.record(r, announce: true) }
            needsInput = nil
            switch result.status {
            case .expired: lastError = "That question expired; nothing was changed. Ask again if you still want it."
            case .declined: lastError = nil
            case .executed, .unknown: lastError = nil
            }
            // A confirmed export, import or recovery kit: hand its private result to the account sheet.
            // It is never added to the transcript or persisted with it.
            if result.status == .executed, let op = result.operation { onAccountOperation?(op) }
            if let status = result.run?.status, status.isTerminal, let m = result.run?.message {
                // The run already settled and carries its final message.
                upsert(m)
                activeRunId = nil
                persist()
                await deliverWaitingTurns()
                return
            }
            // Otherwise read the rest of the run from our cursor (a terminal run ends at run_finished).
            follow(run)
            await streamTask?.value
            await deliverWaitingTurns()
        } catch let e as APIError {
            if case .rejected(let code, _, _) = e, code == "invalid_choice" { lastError = "That choice is no longer offered" } else { lastError = e.userMessage }
        } catch {
            lastError = "Couldn't send your answer"
        }
    }

    /// Reads the durable run: settles its message and restores a pending question.
    @discardableResult
    private func reconcile(_ runId: String) async -> StreamSignal {
        guard let status = try? await env.api.run(runId) else { return .continue }
        if let m = status.message { upsert(m); persist() }
        for r in status.receipts ?? [] { receiptCenter.merge([r]) }
        if status.status == .inputRequired, let p = status.pendingAction, p.status == "pending" {
            needsInput = NeedsInput(prompt: p.prompt, choices: p.choices.map { .init(id: $0.id, label: $0.label) }, pendingActionId: p.pendingActionId, runId: runId)
            return .paused
        }
        return status.status.isTerminal ? .finished : .continue
    }

    /// The streamed reply of `runId`, created on first use. It carries the run id so a notice can find its turn's reply.
    private func assistantMessage(_ id: String, runId: String) -> Int {
        if let i = messages.firstIndex(where: { $0.messageId == id }) {
            if messages[i].runId == nil { messages[i].runId = runId }
            return i
        }
        messages.append(ConversationMessage(messageId: id, role: "assistant", createdAt: env.now(), status: "streaming", parts: [], runId: runId))
        return messages.count - 1
    }

    /// Applies one event and says what it means for the stream. Unknown types are ignored.
    @discardableResult
    func handle(_ event: RunEvent, runId: String) -> StreamSignal {
        // A snapshot replaces the message after an expired cursor. Its id is the latest sequence,
        // which may already have been seen, so it bypasses de-duplication and supersedes older ids.
        if event.type != "snapshot", !event.eventId.isEmpty {
            if seenEvents[runId, default: []].contains(event.eventId) { return .continue }
            seenEvents[runId, default: []].insert(event.eventId)
        }
        let d = event.data
        let messageId = d["messageId"]?.stringValue ?? "msg_\(runId)"
        var contentChanged = false
        switch event.type {
        case "run_started":
            _ = assistantMessage(messageId, runId: runId)
        case "activity":
            activity = d["text"]?.stringValue
        case "text_delta":
            let i = assistantMessage(messageId, runId: runId)
            let delta = d["delta"]?.stringValue ?? ""
            if let t = messages[i].parts.lastIndex(where: { $0.text != nil }), t == messages[i].parts.count - 1 {
                messages[i].parts[t] = .text((messages[i].parts[t].text ?? "") + delta)
            } else {
                messages[i].parts.append(.text(delta))
            }
            contentChanged = true
        case "outfit_board":
            if let card = try? d["card"]?.decode(OutfitCard.self) {
                let i = assistantMessage(messageId, runId: runId)
                messages[i].parts.append(.outfitCard(card))
                contentChanged = true
            }
        case "sources":
            if let sources = try? d["sources"]?.decode([SourceLink].self) {
                let i = assistantMessage(messageId, runId: runId)
                messages[i].parts.append(.sources(sources))
            }
        case "command_receipt":
            if let r = try? d["receipt"]?.decode(CommandReceipt.self) {
                receiptCenter.record(r, announce: true)
                let i = assistantMessage(messageId, runId: runId)
                messages[i].parts.append(.receipt(commandId: r.commandId, summary: r.summary))
                contentChanged = true
            }
        case "needs_input":
            let choices = d["choices"]?.arrayValue?.compactMap { c -> NeedsInput.Choice? in
                guard let id = c["id"]?.stringValue, let label = c["label"]?.stringValue else { return nil }
                return NeedsInput.Choice(id: id, label: label)
            } ?? []
            let pendingId = d["pendingActionId"]?.stringValue
            needsInput = NeedsInput(prompt: d["prompt"]?.stringValue ?? "", choices: choices, pendingActionId: pendingId, runId: pendingId == nil ? nil : runId)
            // A durable question pauses the run until it is answered (POST /v1/runs/{id}/input).
            if pendingId != nil { return .paused }
        case "snapshot":
            if let m = try? d["message"]?.decode(ConversationMessage.self) { upsert(m); contentChanged = true }
            if let n = Int(event.eventId) { seenEvents[runId, default: []].formUnion((0...n).map(String.init)) }
            let status = RunState(rawValue: d["status"]?.stringValue ?? "running")
            if status.isTerminal {
                activity = nil
                if contentChanged && !isAtBottom { hasUnseenMessages = true }
                return .finished
            }
            if status == .inputRequired { return .paused }
        case "run_finished":
            if let m = try? d["message"]?.decode(ConversationMessage.self) {
                upsert(m)
            } else if let i = messages.firstIndex(where: { $0.messageId == messageId }) {
                let status = d["status"]?.stringValue ?? "finished"
                messages[i].status = status == "finished" ? "complete" : status == "cancelled" ? "stopped" : "failed"
            }
            activity = nil
            if !isAtBottom { hasUnseenMessages = true }
            return .finished
        default:
            ignoredEventTypes.append(event.type)
        }
        if contentChanged && !isAtBottom { hasUnseenMessages = true }
        return .continue
    }
}

// MARK: Capture

public enum CaptureIntent: String, Codable, Sendable, CaseIterable, Identifiable {
    case addItem, identify, whatIWore
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .addItem: "Add an item"
        case .identify: "Identify this"
        case .whatIWore: "What I wore"
        }
    }
    public var systemImage: String {
        switch self {
        case .addItem: "plus.viewfinder"
        case .identify: "magnifyingglass"
        case .whatIWore: "person.crop.rectangle"
        }
    }
    public var turnIntent: TurnIntent {
        switch self {
        case .addItem: .addItem
        case .identify: .identify
        case .whatIWore: .whatIWore
        }
    }
    var uploadPurpose: String {
        switch self {
        case .addItem: "garment_photo"
        case .identify: "identify"
        case .whatIWore: "what_i_wore"
        }
    }
}

public enum PhotoAccess: String, Sendable { case unknown, granted, limited, denied }

@MainActor
@Observable
public final class CaptureViewModel {
    public struct Attachment: Identifiable, Sendable, Hashable {
        public enum State: Sendable, Hashable { case waiting, uploading, uploaded(String), failed(String) }
        public let id: String
        public let data: Data
        public let contentType: String
        public var state: State
    }

    public var intent: CaptureIntent
    public var note = ""
    public var photoAccess: PhotoAccess = .unknown
    public private(set) var attachments: [Attachment] = []
    public private(set) var submitted = false

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let conversation: ConversationViewModel

    public init(intent: CaptureIntent, env: AppEnvironment, conversation: ConversationViewModel) {
        self.intent = intent; self.env = env; self.conversation = conversation
    }

    /// A turn carries at most 10 photos, each at most 25 MB (UploadRequest / TurnRequest limits).
    @discardableResult
    public func add(_ data: Data, contentType: String = "image/jpeg") -> Bool {
        guard attachments.count < TurnRequest.maxAttachments, data.count <= UploadRequest.maxBytes else { return false }
        attachments.append(Attachment(id: env.uuid(), data: data, contentType: contentType, state: .waiting))
        return true
    }

    public var canAddMore: Bool { attachments.count < TurnRequest.maxAttachments }

    public func remove(_ id: String) { attachments.removeAll { $0.id == id } }

    /// Uploads keep their position and can be retried individually.
    public func upload(_ id: String) async {
        guard let i = attachments.firstIndex(where: { $0.id == id }) else { return }
        if case .uploaded = attachments[i].state { return }
        attachments[i].state = .uploading
        let a = attachments[i]
        do {
            let uploadId = try await env.api.upload(a.data, contentType: a.contentType, purpose: intent.uploadPurpose)
            if let j = attachments.firstIndex(where: { $0.id == id }) { attachments[j].state = .uploaded(uploadId) }
        } catch let e as APIError {
            if let j = attachments.firstIndex(where: { $0.id == id }) { attachments[j].state = .failed(e.userMessage) }
        } catch {
            if let j = attachments.firstIndex(where: { $0.id == id }) { attachments[j].state = .failed("Upload failed") }
        }
    }

    public func uploadAll() async {
        for a in attachments { await upload(a.id) }
    }

    public var uploadedIds: [String] { attachments.compactMap { if case .uploaded(let id) = $0.state { id } else { nil } } }
    public var allUploaded: Bool { attachments.allSatisfy { if case .uploaded = $0.state { true } else { false } } }

    /// Without photo access the owner can still describe the item in words.
    public var canSubmit: Bool { (allUploaded && !attachments.isEmpty) || !note.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Taking a photo never authorizes a mutation. `logIt` is the explicit "log this" request and
    /// only applies to What I wore; even then the backend commits only a confident match.
    public func submit(logIt: Bool = false) async {
        await uploadAll()
        guard canSubmit else { return }
        let text = note.isEmpty ? intent.title : note
        await conversation.sendCapture(text: text, attachmentIds: uploadedIds, intent: intent.turnIntent, explicitLog: intent == .whatIWore && logIt)
        submitted = true
    }
}
