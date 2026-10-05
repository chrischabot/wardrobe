import Foundation
import Observation

/// A message the owner sent that the canonical transcript does not contain yet. Its
/// `clientTurnId` is created before the first send and reused for every retry, so the backend
/// returns the same turn instead of appending a second one.
public struct PendingTurn: Codable, Sendable, Equatable, Identifiable {
    public enum State: String, Codable, Sendable {
        /// Saved on this phone; not yet accepted by the backend.
        case waitingToSend
        /// Held until the response now streaming finishes ("Waiting").
        case waitingForTurn
        /// Accepted: the run is in progress or finished.
        case accepted
    }
    public var clientTurnId: String
    public var text: String
    public var attachmentIds: [String]
    /// What each attached photograph is, by asset ID, where the owner said. Absent in turns
    /// saved by an earlier version of the app.
    public var imageRoles: [String: PhotoRole]?
    public var attachedRefs: [AttachedRef]
    public var intent: TurnIntent
    public var sharedUrl: String?
    public var createdAt: Date
    public var state: State
    public var turnId: String?
    public var runId: String?
    public var id: String { clientTurnId }

    public init(clientTurnId: String, text: String, attachmentIds: [String], imageRoles: [String: PhotoRole]? = nil, attachedRefs: [AttachedRef], intent: TurnIntent,
                sharedUrl: String?, createdAt: Date, state: State, turnId: String?, runId: String?) {
        self.clientTurnId = clientTurnId; self.text = text; self.attachmentIds = attachmentIds; self.imageRoles = imageRoles; self.attachedRefs = attachedRefs
        self.intent = intent; self.sharedUrl = sharedUrl; self.createdAt = createdAt; self.state = state; self.turnId = turnId; self.runId = runId
    }

    public var request: TurnRequest {
        // Only roles of photographs that are actually attached are sent.
        let roles = (imageRoles ?? [:]).filter { attachmentIds.contains($0.key) && $0.value != .unknown }
        return TurnRequest(clientTurnId: clientTurnId, text: text, attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds,
                           imageRoles: roles.isEmpty ? nil : roles,
                           attachedRefs: attachedRefs.isEmpty ? nil : attachedRefs, intent: intent, sharedUrl: sharedUrl)
    }
    var localEntryId: String { "local:\(clientTurnId)" }
}

/// The composer: a draft that survives closing the app, explicit attached identities,
/// attachments, and a clear send / stop state.
@MainActor
@Observable
public final class ComposerModel {
    public let environment: AppEnvironment
    public let transcript: TranscriptModel
    public let uploads: UploadModel
    private let sleep: (@Sendable (TimeInterval) async -> Void)?

    /// The text being written. Saved on every change.
    public var draft: String { didSet { if draft != oldValue { environment.restoration.save("conversation.draft", draft) } } }
    /// Identities attached by "Ask about this". Shown as chips; never inferred from what was on screen.
    public private(set) var attachedRefs: [AttachedRef] { didSet { environment.restoration.save("conversation.draftRefs", attachedRefs) } }
    public private(set) var refLabels: [String: String] = [:]
    public private(set) var pending: [PendingTurn] { didSet { environment.restoration.save("conversation.pendingTurns", pending) } }
    public private(set) var follower: RunFollower?
    public private(set) var notice: String?
    /// The backend's turn behind the reply now shown, which its requests to confirm are listed under.
    private var followedTurnId: String?
    /// Set by the app: how many of the requests a reply left with this command and summary the
    /// owner has since decided (by the turn that asked). Without it every request counts as waiting.
    public var settledCount: (@MainActor (_ turnId: String, _ type: String, _ summary: String) -> Int)?

    public init(environment: AppEnvironment, transcript: TranscriptModel, sleep: (@Sendable (TimeInterval) async -> Void)? = nil) {
        self.environment = environment
        self.transcript = transcript
        self.sleep = sleep
        uploads = UploadModel(environment: environment)
        draft = environment.restoration.load("conversation.draft") ?? ""
        attachedRefs = environment.restoration.load("conversation.draftRefs") ?? []
        pending = environment.restoration.load("conversation.pendingTurns") ?? []
        for turn in pending { showLocally(turn) }
    }

    // MARK: State

    public var isStreaming: Bool { follower?.isActive ?? false }
    public var pendingInput: PendingInput? { if case .needsInput(let input)? = follower?.phase { return input }; return nil }
    public var activity: String? { isStreaming ? follower?.activity : nil }
    /// What the last answer asked for and did not do: each waits for the owner in Requests to
    /// confirm. Shown so a reply is never mistaken for a change that was made, and no longer
    /// shown for a request the owner has since confirmed or rejected.
    public var awaitingConfirmation: [String] {
        guard let follower, follower.phase.isTerminal else { return [] }
        guard let turn = followedTurnId, let settledCount else { return follower.proposals.map(\.summary) }
        // Requests that read the same are only distinguishable by number: as many are dropped
        // as have been decided, so deciding one never hides another that still waits.
        var decided: [String: Int] = [:]
        return follower.proposals.filter { item in
            let key = ProposalsModel.settledKey(turnId: turn, type: item.type, summary: item.summary)
            let left = decided[key] ?? settledCount(turn, item.type, item.summary)
            decided[key] = max(left - 1, 0)
            return left <= 0
        }.map(\.summary)
    }
    /// One sentence for those requests, or nil when there are none.
    public var confirmationLine: String? {
        let waiting = awaitingConfirmation
        guard !waiting.isEmpty else { return nil }
        let lead = waiting.count == 1 ? "Not done yet. This waits for your confirmation" : "Not done yet. These wait for your confirmation"
        return "\(lead): \(waiting.joined(separator: "; "))."
    }

    /// Why Send is disabled, or nil when it is enabled.
    public var blockedReason: String? {
        if uploads.items.contains(where: { if case .rejected = $0.state { return true }; return false }) { return "Remove the photo that was not accepted." }
        if uploads.items.contains(where: { if case .failed = $0.state { return true }; return false }) { return "A photo did not upload. Retry or remove it." }
        if uploads.hasUnfinished { return "Photos are still uploading." }
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return uploads.items.isEmpty && attachedRefs.isEmpty ? "" : "Add a message." }
        return nil
    }
    public var canSend: Bool { blockedReason == nil }

    // MARK: Attached identities

    /// Ask about this: attaches an item or outfit identity to the next message.
    public func attach(_ ref: AttachedRef, label: String) {
        guard !attachedRefs.contains(ref) else { return }
        attachedRefs.append(ref)
        refLabels[ComposerModel.key(ref)] = label
    }
    public func detach(_ ref: AttachedRef) { attachedRefs.removeAll { $0 == ref } }
    public func label(for ref: AttachedRef) -> String { refLabels[ComposerModel.key(ref)] ?? ref.kind.rawValue.replacingOccurrences(of: "_", with: " ") }
    static func key(_ ref: AttachedRef) -> String { "\(ref.kind.rawValue):\(ref.id):\(ref.boardId ?? ""):\(ref.revision ?? 0)" }

    // MARK: Sending

    private func showLocally(_ turn: PendingTurn) {
        let delivery: TranscriptEntry.Delivery
        switch turn.state {
        case .waitingToSend: delivery = .waitingToSend
        case .waitingForTurn: delivery = .waitingForTurn
        case .accepted: delivery = .settled
        }
        transcript.upsertLocal(TranscriptEntry(id: turn.localEntryId, role: .user, authoredAt: turn.createdAt, localDate: Dates.localDate(of: turn.createdAt, in: environment.timeZone),
                                               text: turn.text, turnId: turn.turnId, delivery: delivery))
    }

    private func update(_ id: String, _ change: (inout PendingTurn) -> Void) {
        guard let i = pending.firstIndex(where: { $0.id == id }) else { return }
        change(&pending[i])
        showLocally(pending[i])
    }

    /// Sends the draft. The turn is given its stable ID and saved before anything is sent; the
    /// draft is cleared only once the turn is durably pending.
    public func send(intent: TurnIntent = .chat, sharedUrl: String? = nil) async {
        guard canSend else { return }
        let turn = PendingTurn(clientTurnId: environment.ids.next("turn"), text: draft.trimmingCharacters(in: .whitespacesAndNewlines), attachmentIds: uploads.readyAssetIds,
                               imageRoles: uploads.readyImageRoles, attachedRefs: attachedRefs, intent: intent, sharedUrl: sharedUrl, createdAt: environment.time.now(),
                               state: isStreaming ? .waitingForTurn : .waitingToSend, turnId: nil, runId: nil)
        pending.append(turn)
        showLocally(turn)
        draft = ""
        attachedRefs = []
        uploads.removeAll()
        notice = nil
        if turn.state == .waitingToSend { await transmit(turn.id) }
    }

    /// Submits a prepared turn (capture sheet, share inbox) through the same path.
    public func submit(_ turn: PendingTurn) async {
        guard !pending.contains(where: { $0.id == turn.id }) else { return }
        var turn = turn
        turn.state = isStreaming ? .waitingForTurn : .waitingToSend
        pending.append(turn)
        showLocally(turn)
        if turn.state == .waitingToSend { await transmit(turn.id) }
    }

    private func transmit(_ id: String) async {
        guard let turn = pending.first(where: { $0.id == id }) else { return }
        do {
            let response = try await environment.api.submitTurn(turn.request)
            environment.center.noteRead(failure: nil)
            update(id) { $0.state = .accepted; $0.turnId = response.turnId; $0.runId = response.runId }
            await followRun(response.runId, turn: id)
        } catch let failure as APIFailure {
            environment.center.noteRead(failure: failure)
            if failure.isRetryable || failure.needsSignIn {
                // Kept exactly as it is; retried later with the same clientTurnId.
                update(id) { $0.state = .waitingToSend }
                notice = failure.isTransport ? "Offline. Your message is saved and will be sent when you are back online." : "Your message is saved and will be sent again."
            } else {
                // A final refusal: the text goes back to the composer so nothing typed is lost.
                pending.removeAll { $0.id == id }
                transcript.removeLocal(turn.localEntryId)
                if draft.isEmpty { draft = turn.text }
                attachedRefs = turn.attachedRefs
                notice = failure.ownerMessage
            }
        } catch {
            update(id) { $0.state = .waitingToSend }
        }
    }

    private func followRun(_ runId: String, turn id: String) async {
        let run = sleep.map { RunFollower(environment: environment, runId: runId, transcript: transcript, sleep: $0) } ?? RunFollower(environment: environment, runId: runId, transcript: transcript)
        follower = run
        followedTurnId = pending.first(where: { $0.id == id })?.turnId
        await run.follow()
        switch run.phase {
        case .completed, .cancelled, .failed:
            // The canonical transcript now holds the owner's message; the local copy is dropped.
            if let turn = pending.first(where: { $0.id == id }) { transcript.removeLocal(turn.localEntryId) }
            pending.removeAll { $0.id == id }
            if case .failed(let message) = run.phase { notice = message }
            await sendNextWaiting()
        case .needsInput, .connectionLost, .running, .idle:
            break // stays accepted; resumed by `answer`, `resume()` or `retryPending()`
        }
    }

    private func sendNextWaiting() async {
        guard !isStreaming, let next = pending.first(where: { $0.state == .waitingForTurn }) else { return }
        update(next.id) { $0.state = .waitingToSend }
        await transmit(next.id)
    }

    /// Re-sends turns that were not accepted and re-attaches to runs that were still going
    /// (after reconnecting or relaunching). Uses each turn's original `clientTurnId`.
    public func retryPending() async {
        for turn in pending where turn.state == .accepted {
            guard let runId = turn.runId, follower?.runId != runId || follower?.phase == .connectionLost else { continue }
            if follower?.runId == runId { await follower?.resume() } else { await followRun(runId, turn: turn.id) }
            if let phase = follower?.phase, phase.isTerminal, follower?.runId == runId {
                transcript.removeLocal(turn.localEntryId)
                pending.removeAll { $0.id == turn.id }
            }
        }
        while !isStreaming, let turn = pending.first(where: { $0.state == .waitingToSend }) {
            await transmit(turn.id)
            if pending.first(where: { $0.id == turn.id })?.state == .waitingToSend { break } // still offline
        }
        await sendNextWaiting()
    }

    /// The last answer failed in a way the backend says can be run again.
    public var canRunAgain: Bool { follower?.canRunAgain ?? false }

    /// Runs the failed answer again (same run; what it already committed is not repeated).
    public func runAgain() async {
        guard let follower, follower.canRunAgain else { return }
        notice = nil
        await follower.runAgain()
        if case .failed(let message) = follower.phase { notice = message }
        if follower.phase.isTerminal { await sendNextWaiting() }
    }

    /// Stop: cancels the response in progress.
    public func stop() async {
        guard let follower else { return }
        let runId = follower.runId
        await follower.stop()
        if follower.phase.isTerminal, let turn = pending.first(where: { $0.runId == runId }) {
            transcript.removeLocal(turn.localEntryId)
            pending.removeAll { $0.id == turn.id }
        }
    }

    /// Stop and send: cancels the remaining inference first, then sends the waiting message.
    public func stopAndSend() async {
        await stop()
        if canSend { await send() } else { await sendNextWaiting() }
    }

    /// Answers the question a run is waiting on.
    public func answer(choiceId: String? = nil, text: String? = nil) async {
        guard let follower, let turn = pending.first(where: { $0.runId == follower.runId }) ?? nil else {
            await self.follower?.answer(choiceId: choiceId, text: text)
            return
        }
        await follower.answer(choiceId: choiceId, text: text)
        if follower.phase.isTerminal {
            transcript.removeLocal(turn.localEntryId)
            pending.removeAll { $0.id == turn.id }
            await sendNextWaiting()
        }
    }
}
