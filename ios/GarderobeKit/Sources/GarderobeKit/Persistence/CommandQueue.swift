import Foundation

/// A command the owner issued on this phone, from the moment of the tap until the backend's
/// verified receipt arrives. The envelope (including its idempotency key and `occurredAt`) is
/// fixed at creation and never rebuilt, so every retry is byte-for-byte the same request.
public struct QueuedCommand: Codable, Sendable, Equatable, Identifiable {
    public enum State: String, Codable, Sendable {
        /// Waiting to be sent, or sent without a known outcome. Will be retried in order.
        case queued
        /// The backend refused it and will refuse the identical request again.
        case rejected
    }
    public var envelope: CommandEnvelope
    /// What the owner did, in their words ("Wore the navy OCBD and dark jeans").
    public var label: String
    public var createdAt: Date
    public var state: State
    public var attempts: Int
    public var lastAttemptAt: Date?
    /// The refusal, when `state == .rejected`.
    public var rejection: ApiError?
    /// Position in the queue; replay order is ascending.
    public var sequence: Int

    public var id: String { envelope.idempotencyKey }
}

/// The ordered, persistent replay queue (specification sections 3 and 13). Commands are
/// written to disk before any network attempt and leave the queue only when a receipt for
/// their idempotency key has arrived or the owner dismisses a refusal.
public actor CommandQueue {
    private let store: KeyValueStore
    private let key = "queue.commands"
    private var entries: [QueuedCommand]
    private var nextSequence: Int

    public init(store: KeyValueStore) {
        self.store = store
        if let data = store.read("queue.commands"), let saved = try? GarderobeJSON.decode([QueuedCommand].self, from: data) {
            entries = saved.sorted { $0.sequence < $1.sequence }
        } else {
            entries = []
        }
        nextSequence = (entries.map(\.sequence).max() ?? 0) + 1
    }

    private func persist() throws {
        try store.write(key, try GarderobeJSON.encode(entries))
    }

    public func all() -> [QueuedCommand] { entries }
    public func pending() -> [QueuedCommand] { entries.filter { $0.state == .queued } }
    public func rejected() -> [QueuedCommand] { entries.filter { $0.state == .rejected } }

    /// Persists the command. Throws when it could not be written: the caller must then tell the
    /// owner it was not saved instead of showing it as queued.
    @discardableResult
    public func enqueue(_ envelope: CommandEnvelope, label: String, now: Date) throws -> QueuedCommand {
        if let existing = entries.first(where: { $0.id == envelope.idempotencyKey }) { return existing }
        let entry = QueuedCommand(envelope: envelope, label: label, createdAt: now, state: .queued, attempts: 0, lastAttemptAt: nil, rejection: nil, sequence: nextSequence)
        entries.append(entry)
        do { try persist() } catch { entries.removeLast(); throw error }
        nextSequence += 1
        return entry
    }

    public func recordAttempt(_ id: String, now: Date) {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[i].attempts += 1
        entries[i].lastAttemptAt = now
        try? persist()
    }

    /// A receipt arrived: the command is done and leaves the queue.
    public func complete(_ id: String) {
        entries.removeAll { $0.id == id }
        try? persist()
    }

    /// A final refusal arrived: the command stays visible as rejected and is not retried.
    public func reject(_ id: String, error: ApiError) {
        guard let i = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[i].state = .rejected
        entries[i].rejection = error
        try? persist()
    }

    /// The owner acknowledged a refusal.
    public func dismiss(_ id: String) {
        entries.removeAll { $0.id == id && $0.state == .rejected }
        try? persist()
    }
}
