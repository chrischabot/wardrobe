import Foundation
import Observation

/// Follows one durable run through its server-sent events. The run lives on the backend:
/// closing the app or losing the stream never loses it, and "accepted" or "running" is never
/// presented as done.
@MainActor
@Observable
public final class RunFollower {
    public enum Phase: Sendable, Equatable {
        case idle
        case running
        /// The backend needs one answer from the owner before it can continue.
        case needsInput(PendingInput)
        case completed
        case failed(String)
        case cancelled
        /// The stream could not be re-established. The run continues on the server and can be resumed.
        case connectionLost

        public var isTerminal: Bool {
            switch self {
            case .completed, .failed, .cancelled: return true
            default: return false
            }
        }
    }

    public static let maxReconnects = 5
    /// Streamed text reaches the transcript at most this often (layout updates are throttled).
    public static let flushInterval: TimeInterval = 0.12

    public let environment: AppEnvironment
    public let runId: String
    private let transcript: TranscriptModel?
    private let sleep: @Sendable (TimeInterval) async -> Void

    public private(set) var phase: Phase = .idle
    /// Visible work, such as "Checking the maker's size chart". Never internal reasoning.
    public private(set) var activity: String?
    /// Receipts of commands the run committed; they stay committed if the run is cancelled.
    public private(set) var receipts: [RunReceiptRef] = []
    public private(set) var lastEventId = 0
    public private(set) var result: Run.Result?
    /// Options the run produced outside a message (recommendation runs).
    public private(set) var options: [BoardOption] = []
    public private(set) var stopped: [String] = []
    public private(set) var reconnects = 0

    private var text: [String: String] = [:]
    private var dirty: Set<String> = []
    private var lastFlush: Date?
    private var isFollowing = false

    public init(environment: AppEnvironment, runId: String, transcript: TranscriptModel?,
                sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.environment = environment; self.runId = runId; self.transcript = transcript; self.sleep = sleep
    }

    /// The transcript entry streamed text goes to before the canonical message ID is known.
    public var placeholderId: String { "stream:\(runId)" }
    public var isActive: Bool { phase == .running }
    public var streamedText: String { text.values.joined() }

    /// Follows the run until it finishes, needs input, or the connection is lost for good.
    public func follow() async {
        guard !isFollowing, !phase.isTerminal else { return }
        isFollowing = true
        defer { isFollowing = false }
        if phase == .idle || phase == .connectionLost { phase = .running }
        var attempts = 0

        loop: while !phase.isTerminal {
            do {
                for try await event in environment.api.runEvents(id: runId, afterEventId: lastEventId > 0 ? lastEventId : nil) {
                    attempts = 0
                    apply(event)
                    if phase.isTerminal { break }
                }
                flush(force: true)
                if phase.isTerminal { break loop }
                // The stream ended without a finish event: ask the durable run what happened.
                try await syncFromRun()
                if phase.isTerminal { break loop }
                if case .needsInput = phase { break loop }
            } catch let failure as APIFailure where failure.isRetryable {
                environment.center.noteRead(failure: failure)
            } catch let failure as APIFailure {
                flush(force: true)
                phase = failure.needsSignIn ? .connectionLost : .failed(failure.ownerMessage)
                break loop
            } catch {
                // Any other stream error is treated as a dropped connection.
            }
            flush(force: true)
            attempts += 1
            reconnects += 1
            if attempts > RunFollower.maxReconnects {
                if (try? await syncFromRun()) == nil || !phase.isTerminal { if case .needsInput = phase {} else if !phase.isTerminal { phase = .connectionLost } }
                break loop
            }
            await sleep(min(8, 0.5 * Double(1 << min(attempts, 4))))
        }
        if phase == .completed || phase == .cancelled { await finish() }
    }

    /// Applies one event. Replayed events (ID not greater than the last seen) and unknown
    /// event types are ignored.
    func apply(_ event: RunEvent) {
        guard event.runId == runId, event.eventId > lastEventId else { return }
        lastEventId = event.eventId
        let data = event.data
        switch RunEventType(rawValue: event.type) {
        case .runStarted:
            if !phase.isTerminal { phase = .running }
        case .activity:
            activity = data["text"]?.stringValue
        case .textDelta:
            // `delta` appends to the message, unless `replace` says it is the complete text so far.
            // (An earlier wire form, `text` with `final`, is still accepted.)
            let id = data["messageId"]?.stringValue ?? placeholderId
            let replaces = data["replace"]?.boolValue == true || data["final"]?.boolValue == true
            guard let piece = data["delta"]?.stringValue ?? data["text"]?.stringValue else { return }
            if replaces { text[id] = piece } else { text[id, default: ""] += piece }
            dirty.insert(id)
            flush(force: replaces)
        case .outfitBoard, .productComparison, .sources:
            flush(force: true)
            var raw = data
            raw["type"] = .string(event.type)
            let part = MessagePart(raw)
            if case .outfitBoard(_, _, let boardOptions) = part { options = boardOptions }
            if !part.isUnknown { transcript?.appendCard(part, toMessage: currentMessageId) }
        case .commandReceipt:
            guard let ref = data["receipt"].flatMap({ try? $0.decoded(as: RunReceiptRef.self) }) else { return }
            record(ref)
            transcript?.appendCard(.receipt(ref), toMessage: currentMessageId)
        case .needsInput:
            flush(force: true)
            if let input = data["input"].flatMap({ try? $0.decoded(as: PendingInput.self) }) { phase = .needsInput(input) }
        case .runFinished:
            flush(force: true)
            switch (data["state"] ?? data["status"])?.stringValue.flatMap(RunState.init(rawValue:)) {
            case .completed: phase = .completed
            case .cancelled: phase = .cancelled
            case .failed: phase = .failed("The assistant could not finish this.")
            case .needsInput: break // the durable run carries the question; it is read after the stream ends
            default: break // an unrecognised final state: the durable run is read instead
            }
        case .snapshot:
            // The cursor expired: the snapshot is the truth; streamed fragments are discarded.
            if let run = data["run"].flatMap({ try? $0.decoded(as: Run.self) }) {
                text.removeAll(); dirty.removeAll()
                apply(run)
            }
        case .unknown, .none:
            break
        }
    }

    private var currentMessageId: String { text.keys.first { $0 != placeholderId } ?? placeholderId }

    private func record(_ ref: RunReceiptRef) {
        guard !receipts.contains(where: { $0.commandId == ref.commandId }) else { return }
        receipts.append(ref)
        // Fetch the full verified receipt so it appears in item history with its undo.
        let api = environment.api, center = environment.center
        Task { if let receipt = try? await api.receipt(commandId: ref.commandId) { center.merge([receipt]) } }
    }

    private func flush(force: Bool) {
        guard !dirty.isEmpty else { return }
        let now = environment.time.now()
        if !force, let lastFlush, now.timeIntervalSince(lastFlush) < RunFollower.flushInterval { return }
        lastFlush = now
        for id in dirty { transcript?.applyStream(messageId: id, text: text[id] ?? "") }
        dirty.removeAll()
    }

    private func apply(_ run: Run) {
        activity = run.activity
        lastEventId = max(lastEventId, run.lastEventId)
        for ref in run.receipts { record(ref) }
        result = run.result
        if let reply = run.result?.reply {
            text = [reply.messageId: reply.text]
            transcript?.applyStream(messageId: reply.messageId, text: reply.text)
        }
        if let produced = run.result?.options, !produced.isEmpty { options = produced }
        switch run.state {
        case .queued, .running: if !phase.isTerminal { phase = .running }
        case .needsInput: if let input = run.pendingInput { phase = .needsInput(input) }
        case .completed: phase = .completed
        case .cancelled: phase = .cancelled
        case .failed: phase = .failed(run.error?.message ?? "The assistant could not finish this.")
        case .unknown: break
        }
    }

    /// Reads the durable run (works after app closure or a lost stream).
    @discardableResult
    public func syncFromRun() async throws -> Run {
        let run = try await environment.api.run(id: runId)
        apply(run)
        return run
    }

    /// Settles the streamed message from the durable result and re-reads the transcript.
    private func finish() async {
        if result == nil { _ = try? await syncFromRun() }
        if let reply = result?.reply {
            transcript?.settleStream(placeholderId: placeholderId, messageId: reply.messageId, text: reply.text)
            transcript?.settleStream(placeholderId: reply.messageId, messageId: reply.messageId, text: reply.text)
        }
        await transcript?.refreshLatest()
    }

    /// Resumes following after the connection was lost.
    public func resume() async {
        guard phase == .connectionLost else { return }
        phase = .running
        await follow()
    }

    /// Stop: cancels the remaining work. What was already committed stays committed, and the
    /// response says what was stopped.
    public func stop() async {
        guard !phase.isTerminal else { return }
        do {
            let response = try await environment.api.cancelRun(id: runId)
            flush(force: true)
            stopped = response.stopped
            apply(response.run)
            for ref in response.committed { record(ref) }
            if !phase.isTerminal { phase = .cancelled }
            await finish()
        } catch let failure as APIFailure {
            environment.center.noteRead(failure: failure)
        } catch {}
    }

    /// Answers a pending question with one of its choices or with text, then continues following.
    public func answer(choiceId: String? = nil, text answerText: String? = nil) async {
        guard case .needsInput(let input) = phase else { return }
        do {
            let run = try await environment.api.answerRun(id: runId, RunInputRequest(inputId: input.inputId, choiceId: choiceId, text: answerText))
            phase = .running
            apply(run)
            await follow()
        } catch let failure as APIFailure {
            environment.center.noteRead(failure: failure)
            if !failure.isTransport { phase = .failed(failure.ownerMessage) }
        } catch {}
    }
}
