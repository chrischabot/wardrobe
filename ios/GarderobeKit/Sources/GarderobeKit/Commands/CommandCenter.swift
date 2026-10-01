import Foundation
import Observation

/// A domain command before it is given its identity. Built from a generated `Command*`
/// payload type, so the app can only express commands the shared contract defines.
public struct CommandDraft: Sendable, Equatable {
    public var type: String
    public var payload: [String: JSONValue]
    /// Optimistic versions for plan edits (`board:<id>`, `settings`, `style`). Owner observations send none.
    public var expectedVersions: [String: Int]
    /// What the owner did, in plain words; shown while the command is queued.
    public var label: String
    /// Attached item/outfit identities.
    public var attachedRefs: [String]

    public init<P: GarderobeCommandPayload>(_ payload: P, label: String, expectedVersions: [String: Int] = [:], attachedRefs: [String] = []) {
        self.type = P.commandType
        // Generated payload types always encode to a JSON object.
        self.payload = (try? JSONValue.encode(payload)) ?? [:]
        self.expectedVersions = expectedVersions
        self.label = label
        self.attachedRefs = attachedRefs
    }
}

/// What happened to a submitted command, stated exactly.
public enum SubmissionOutcome: Sendable, Equatable {
    /// The backend committed (or merged) it and returned this verified receipt.
    case confirmed(CommandReceipt)
    /// Saved on this phone and not yet confirmed. It will be sent, in order, when a connection returns.
    case queued
    /// The backend refused it; nothing changed.
    case rejected(ApiError)
    /// It could not even be saved on this phone. Nothing was recorded anywhere.
    case notSaved(String)

    public var receipt: CommandReceipt? { if case .confirmed(let r) = self { return r }; return nil }
}

/// A receipt as the interface keeps it: the verified backend receipt plus the owner-facing label.
public struct ReceiptRecord: Codable, Sendable, Equatable, Identifiable {
    public var receipt: CommandReceipt
    public var label: String
    public var receivedAt: Date
    /// The command ID of the compensating command, once this one was undone.
    public var undoneBy: String?
    public var id: String { receipt.commandId }
}

/// The short-lived undo banner. It lasts eight seconds; the receipt (and its undo) stays
/// available in item history and the activity list after the banner has gone.
public struct UndoBanner: Sendable, Equatable {
    public static let duration: TimeInterval = 8
    public var record: ReceiptRecord
    public var expiresAt: Date
}

/// The single path by which the app changes anything: it gives a command its stable identity,
/// persists it, sends it in order, and publishes the verified receipt. There is no other write path.
@MainActor
@Observable
public final class CommandCenter {
    public enum Connection: Sendable, Equatable {
        case unknown
        case online
        /// The last exchange failed in transport at this time.
        case offline(since: Date)
    }

    public private(set) var pending: [QueuedCommand] = []
    public private(set) var rejected: [QueuedCommand] = []
    /// Most recent first. Persisted so receipts survive closing the app.
    public private(set) var receipts: [ReceiptRecord] = []
    public private(set) var banner: UndoBanner?
    public private(set) var connection: Connection = .unknown
    /// Set when a command was refused because the session ended; the app then asks for sign-in.
    public private(set) var needsSignIn = false
    /// The highest wardrobe revision any receipt has reported.
    public private(set) var wardrobeRevision: Int = 0

    private let api: APIClient
    private let queue: CommandQueue
    private let store: RestorationStore
    private let time: TimeSource
    private let ids: IdentifierSource
    private var replaying = false
    private var observers: [(CommandReceipt) -> Void] = []
    private static let receiptLimit = 200
    /// Commands undone from this phone whose full receipt is not held here (older transcript
    /// cards): undone command ID to the undo's command ID.
    public private(set) var undoneElsewhere: [String: String] = [:]

    public init(api: APIClient, queue: CommandQueue, store: RestorationStore, time: TimeSource, ids: IdentifierSource) {
        self.api = api; self.queue = queue; self.store = store; self.time = time; self.ids = ids
        receipts = store.load("receipts", as: [ReceiptRecord].self) ?? []
        undoneElsewhere = store.load("receipts.undone", as: [String: String].self) ?? [:]
        wardrobeRevision = receipts.map(\.receipt.wardrobeRevision).max() ?? 0
    }

    /// Loads the persisted queue into the observable state (call once at launch).
    public func restore() async { await refreshQueueState() }

    /// Registers a callback invoked for every verified receipt (features refresh their reads).
    public func onReceipt(_ observer: @escaping (CommandReceipt) -> Void) { observers.append(observer) }

    private func refreshQueueState() async {
        pending = await queue.pending()
        rejected = await queue.rejected()
    }

    // MARK: Submitting

    /// Gives the draft its identity and submits it. The idempotency key and `occurredAt` are
    /// fixed here, before anything is sent, and never change across retries.
    @discardableResult
    public func submit(_ draft: CommandDraft) async -> SubmissionOutcome {
        let key = ids.next("ios")
        let envelope = CommandEnvelope(
            type: draft.type,
            payload: draft.payload,
            idempotencyKey: key,
            expectedVersions: draft.expectedVersions.isEmpty ? nil : draft.expectedVersions,
            occurredAt: Dates.instant(time.now()),
            authorization: .ownerTap,
            source: CommandSourceInput(channel: .ios, clientSubmissionId: key, attachedRefs: draft.attachedRefs.isEmpty ? nil : draft.attachedRefs)
        )
        do {
            try await queue.enqueue(envelope, label: draft.label, now: time.now())
        } catch {
            return .notSaved("This could not be saved on the phone, so nothing was recorded. Free some storage and try again.")
        }
        await refreshQueueState()
        let results = await replay()
        return results[key] ?? .queued
    }

    /// Sends every queued command, oldest first. Stops at the first transport failure or
    /// retryable error so order is preserved; a final refusal is recorded and the next command proceeds.
    @discardableResult
    public func replay() async -> [String: SubmissionOutcome] {
        guard !replaying else { return [:] }
        replaying = true
        defer { replaying = false }
        var outcomes: [String: SubmissionOutcome] = [:]

        while true {
            let batch = Array(await queue.pending().prefix(50))
            guard !batch.isEmpty else { break }
            let now = time.now()
            for entry in batch { await queue.recordAttempt(entry.id, now: now) }

            var stop = false
            do {
                if batch.count == 1 {
                    let receipt = try await api.execute(batch[0].envelope)
                    await settle(batch[0], receipt: receipt)
                    outcomes[batch[0].id] = .confirmed(receipt)
                } else {
                    let results = try await api.executeBatch(batch.map(\.envelope))
                    let byKey = Dictionary(batch.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                    for result in results {
                        switch result {
                        case .receipt(let key, let receipt):
                            guard let entry = byKey[key] else { continue }
                            await settle(entry, receipt: receipt)
                            outcomes[key] = .confirmed(receipt)
                        case .error(let key, let error, let retryable):
                            if retryable { stop = true; continue }
                            await queue.reject(key, error: error)
                            outcomes[key] = .rejected(error)
                        case .unknown:
                            stop = true
                        }
                    }
                    // A result missing for a command means its outcome is unknown: keep it queued.
                    if results.count < batch.count { stop = true }
                }
                connection = .online
            } catch let failure as APIFailure {
                switch failure {
                case .api(_, let error) where !failure.isRetryable && !failure.needsSignIn:
                    // Only reachable for the single-command path: a final refusal of that command.
                    await queue.reject(batch[0].id, error: error)
                    outcomes[batch[0].id] = .rejected(error)
                    connection = .online
                default:
                    if failure.isTransport { connection = .offline(since: now) }
                    if failure.needsSignIn { needsSignIn = true }
                    stop = true
                }
            } catch {
                stop = true
            }
            await refreshQueueState()
            if stop { break }
        }
        await refreshQueueState()
        return outcomes
    }

    private func settle(_ entry: QueuedCommand, receipt: CommandReceipt) async {
        await queue.complete(entry.id)
        let record = ReceiptRecord(receipt: receipt, label: entry.label, receivedAt: time.now(), undoneBy: nil)
        receipts.removeAll { $0.id == record.id }
        receipts.insert(record, at: 0)
        if receipts.count > CommandCenter.receiptLimit { receipts.removeLast(receipts.count - CommandCenter.receiptLimit) }
        if entry.envelope.type == CommandCommandUndo.commandType, let undone = entry.envelope.payload["commandId"]?.stringValue {
            if let i = receipts.firstIndex(where: { $0.id == undone }) {
                receipts[i].undoneBy = receipt.commandId
                receipts[i].receipt.undo = CommandReceipt.Undo(available: false, reason: "Already undone.")
            } else {
                undoneElsewhere[undone] = receipt.commandId
                store.save("receipts.undone", undoneElsewhere)
            }
        }
        store.save("receipts", receipts)
        wardrobeRevision = max(wardrobeRevision, receipt.wardrobeRevision)
        needsSignIn = false
        // The banner offers Undo only for a reversible action that actually changed something.
        if receipt.undo.available && entry.envelope.type != CommandCommandUndo.commandType {
            banner = UndoBanner(record: record, expiresAt: time.now().addingTimeInterval(UndoBanner.duration))
        } else if banner?.record.id == entry.envelope.payload["commandId"]?.stringValue {
            banner = nil
        }
        for observer in observers { observer(receipt) }
    }

    // MARK: Undo and receipts

    /// Records a verified receipt that a dedicated route returned (a swap, a calendar setup),
    /// exactly as if the command had been confirmed through the queue: it joins the history,
    /// raises the undo banner when reversible, and refreshes the reads.
    public func adopt(_ receipt: CommandReceipt, label: String) {
        let record = ReceiptRecord(receipt: receipt, label: label, receivedAt: time.now(), undoneBy: nil)
        receipts.removeAll { $0.id == record.id }
        receipts.insert(record, at: 0)
        if receipts.count > CommandCenter.receiptLimit { receipts.removeLast(receipts.count - CommandCenter.receiptLimit) }
        store.save("receipts", receipts)
        wardrobeRevision = max(wardrobeRevision, receipt.wardrobeRevision)
        if receipt.undo.available { banner = UndoBanner(record: record, expiresAt: time.now().addingTimeInterval(UndoBanner.duration)) }
        for observer in observers { observer(receipt) }
    }

    /// Undo is a compensating command that the backend rechecks; the receipt is never deleted.
    @discardableResult
    public func undo(_ record: ReceiptRecord) async -> SubmissionOutcome {
        if banner?.record.id == record.id { banner = nil }
        return await submit(CommandDraft(CommandCommandUndo(commandId: record.receipt.commandId), label: "Undo: \(record.label)"))
    }

    /// What Undo can do for a receipt a run reported in the transcript.
    public enum ReferenceUndoState: Sendable, Equatable {
        /// The backend reported the command as reversible and nothing here says otherwise.
        case available
        /// An undo for it is saved on this phone and has not been confirmed yet.
        case waiting
        case undone
        /// The backend reported it as not reversible.
        case unavailable
    }

    private func undoIsQueued(for commandId: String) -> Bool {
        pending.contains { $0.envelope.type == CommandCommandUndo.commandType && $0.envelope.payload["commandId"]?.stringValue == commandId }
    }

    public func undoState(for ref: RunReceiptRef) -> ReferenceUndoState {
        if undoIsQueued(for: ref.commandId) { return .waiting }
        if let record = receipts.first(where: { $0.id == ref.commandId }) {
            if record.undoneBy != nil { return .undone }
            return record.receipt.undo.available ? .available : .unavailable
        }
        if undoneElsewhere[ref.commandId] != nil { return .undone }
        return ref.undoAvailable && ref.type != CommandCommandUndo.commandType ? .available : .unavailable
    }

    /// Undo for a receipt shown in an older transcript message, by its command ID. The same
    /// compensating command as the banner's; the backend rechecks whether it still applies.
    /// Asking twice sends one undo.
    @discardableResult
    public func undo(_ ref: RunReceiptRef) async -> SubmissionOutcome? {
        guard undoState(for: ref) == .available else { return nil }
        if banner?.record.id == ref.commandId { banner = nil }
        return await submit(CommandDraft(CommandCommandUndo(commandId: ref.commandId), label: "Undo: \(ref.summary)"))
    }

    /// Hides the banner once its eight seconds have passed. The receipt itself is kept.
    public func expireBanner() {
        if let banner, time.now() >= banner.expiresAt { self.banner = nil }
    }

    public func dismissBanner() { banner = nil }

    /// The owner acknowledged a refused command.
    public func dismissRejected(_ id: String) async {
        await queue.dismiss(id)
        await refreshQueueState()
    }

    /// Receipts that touched an entity (`garment:gmt_x`), most recent first - the item's history.
    public func receipts(for kind: String, id: String) -> [ReceiptRecord] {
        receipts.filter { $0.receipt.affected.contains { $0.kind == kind && $0.id == id } }
    }

    /// Merges receipts read from the backend (item history, conversation) into the local list.
    public func merge(_ fetched: [CommandReceipt]) {
        var changed = false
        for receipt in fetched where !receipts.contains(where: { $0.id == receipt.commandId }) {
            receipts.append(ReceiptRecord(receipt: receipt, label: receipt.summary, receivedAt: Dates.parseInstant(receipt.recordedAt) ?? time.now(), undoneBy: nil))
            changed = true
        }
        guard changed else { return }
        receipts.sort { $0.receipt.recordedAt > $1.receipt.recordedAt }
        store.save("receipts", receipts)
    }

    /// Features report the result of their reads so the connection state reflects every exchange.
    public func noteRead(failure: APIFailure?) {
        if let failure {
            if failure.isTransport { if case .offline = connection {} else { connection = .offline(since: time.now()) } }
            if failure.needsSignIn { needsSignIn = true }
        } else {
            connection = .online
        }
    }

    public func sessionRestored() { needsSignIn = false }

    public var isOffline: Bool { if case .offline = connection { return true }; return false }
}
