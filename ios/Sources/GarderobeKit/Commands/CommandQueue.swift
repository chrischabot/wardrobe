import Foundation
import Observation

/// A command kept on the phone until its receipt arrives (spec section 13: offline commands remain
/// visibly queued; failed transport preserves the observation and retries with the same key).
public struct PendingCommand: Codable, Sendable, Hashable, Identifiable {
    public var id: String { envelope.idempotencyKey }
    public var envelope: CommandEnvelope
    /// Human label, e.g. "I wore this: Lightweight oxford — gold, …".
    public var label: String
    public var createdAt: Date
    public var state: State
    public var attempts: Int
    public var lastAttemptAt: Date?
    public var context: Context

    public enum State: Codable, Sendable, Hashable {
        /// Waiting for a connection (never reached the server, or will be retried).
        case queued
        case sending
        /// The last attempt failed in transit or on the server; it will retry automatically.
        case retrying(String)
        case needsSignIn
        /// The server refused it; nothing changed. Shown until dismissed.
        case rejected(String)
        /// Stale expected versions; nothing changed.
        case conflict(String)
    }

    public struct Context: Codable, Sendable, Hashable {
        public var boardDate: LocalDate?
        public var optionId: String?
        public var garmentIds: [String]
        public init(boardDate: LocalDate? = nil, optionId: String? = nil, garmentIds: [String] = []) {
            self.boardDate = boardDate; self.optionId = optionId; self.garmentIds = garmentIds
        }
    }

    public var awaitsDelivery: Bool {
        switch state {
        case .queued, .sending, .retrying, .needsSignIn: true
        default: false
        }
    }

    /// Short visible state for the UI ("Queued", "Sending…").
    public var stateLabel: String {
        switch state {
        case .queued: "Saved on this phone · will send when online"
        case .sending: "Sending…"
        case .retrying: "Couldn't confirm yet · retrying"
        case .needsSignIn: "Saved on this phone · sign in to send"
        case .rejected(let m): "Not recorded: \(m)"
        case .conflict(let m): "Changed elsewhere: \(m)"
        }
    }
}

public enum SubmitOutcome: Sendable, Equatable {
    case receipt(CommandReceipt)
    /// Kept on the phone; it will be delivered later.
    case queued(PendingCommand)
    /// Refused before any receipt (a structured error without a receipt body).
    case failed(PendingCommand)

    public var receipt: CommandReceipt? { if case .receipt(let r) = self { return r }; return nil }
}

@MainActor
@Observable
public final class CommandQueue {
    public private(set) var items: [PendingCommand] = []
    public private(set) var connectivity: Connectivity = .unknown
    public private(set) var lastDeliveryAt: Date?

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private var listeners: [@MainActor (CommandReceipt, PendingCommand) -> Void] = []
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var flushAgain = false
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var delivered: [String: CommandReceipt] = [:]

    public init(env: AppEnvironment) {
        self.env = env
        var restored = env.store.load([PendingCommand].self, StoreKey.pendingCommands) ?? []
        // A command interrupted mid-send is retried with the same key; the backend replays its receipt.
        for i in restored.indices where restored[i].state == .sending { restored[i].state = .queued }
        items = restored
    }

    public func onReceipt(_ listener: @escaping @MainActor (CommandReceipt, PendingCommand) -> Void) {
        listeners.append(listener)
    }

    public var awaitingDelivery: [PendingCommand] { items.filter(\.awaitsDelivery) }

    public func pending(forDate date: LocalDate) -> [PendingCommand] { items.filter { $0.context.boardDate == date } }

    /// Enqueue and, when possible, deliver immediately. The idempotency key and the command body are
    /// fixed here and never change, so a retry after a lost response cannot double-record.
    @discardableResult
    public func submit(_ command: DomainCommand, label: String, context: PendingCommand.Context = .init()) async -> SubmitOutcome {
        let key = CommandEnvelope.makeKey(for: command.type, uuid: env.uuid())
        let envelope = CommandEnvelope(
            idempotencyKey: key,
            source: connectivity == .offline ? .offlineReplay : .app,
            submittedAt: env.now(),
            command: command
        )
        let pending = PendingCommand(envelope: envelope, label: label, createdAt: env.now(), state: .queued, attempts: 0, lastAttemptAt: nil, context: context)
        items.append(pending)
        persist()
        if connectivity != .offline { await flush() }
        let current = items.first(where: { $0.id == key })
        if let receipt = delivered.removeValue(forKey: key) { return .receipt(receipt) }
        guard let current else { return .queued(pending) }
        return current.awaitsDelivery ? .queued(current) : .failed(current)
    }

    public func setConnectivity(_ online: Bool) async {
        let was = connectivity
        connectivity = online ? .online : .offline
        if online && was != .online { await flush() }
    }

    /// Deliver waiting commands in order. Safe to call at any time (foreground, reconnect, sign-in).
    public func flush() async {
        if flushing { flushAgain = true; return }
        flushing = true
        defer { flushing = false }
        repeat {
            flushAgain = false
            await deliverAll()
        } while flushAgain
    }

    private func deliverAll() async {
        var index = 0
        while index < items.count {
            guard items[index].awaitsDelivery else { index += 1; continue }
            let key = items[index].id
            items[index].state = .sending
            items[index].attempts += 1
            items[index].lastAttemptAt = env.now()
            persist()
            let envelope = items[index].envelope
            do {
                let receipt = try await env.api.execute(envelope)
                connectivity = .online
                lastDeliveryAt = env.now()
                guard let i = items.firstIndex(where: { $0.id == key }) else { continue }
                let item = items[i]
                switch receipt.outcome {
                case .committed, .merged:
                    items.remove(at: i)
                    index = i
                case .conflict:
                    items[i].state = .conflict(receipt.error?.message ?? "Something changed; refresh and try again")
                    index = i + 1
                case .rejected:
                    items[i].state = .rejected(receipt.error?.message ?? "Refused")
                    index = i + 1
                default:
                    // An outcome this app does not know is never shown as done.
                    items[i].state = .rejected("Unrecognised result \"\(receipt.outcome.rawValue)\"; check receipts")
                    index = i + 1
                }
                delivered[key] = receipt
                persist()
                for l in listeners { l(receipt, item) }
            } catch let error as APIError {
                guard let i = items.firstIndex(where: { $0.id == key }) else { continue }
                switch error {
                case .offline:
                    items[i].state = .queued
                    connectivity = .offline
                    persist()
                    return // keep order: nothing later can be delivered either
                case .unauthorized:
                    items[i].state = .needsSignIn
                    persist()
                    return
                case .rejected(_, let message, _):
                    items[i].state = .rejected(message)
                    persist()
                    index = i + 1
                case .interrupted, .server, .decoding:
                    items[i].state = .retrying(error.userMessage)
                    persist()
                    scheduleRetry(attempts: items[i].attempts)
                    return
                }
            } catch {
                guard let i = items.firstIndex(where: { $0.id == key }) else { continue }
                items[i].state = .retrying("Unexpected error")
                persist()
                scheduleRetry(attempts: items[i].attempts)
                return
            }
        }
    }

    private func scheduleRetry(attempts: Int) {
        retryTask?.cancel()
        let seconds = min(60, 1 << min(attempts, 6))
        let sleep = env.sleep
        retryTask = Task { [weak self] in
            do { try await sleep(.seconds(seconds)) } catch { return }
            await self?.flush()
        }
    }

    public func dismiss(_ id: String) {
        items.removeAll { $0.id == id && !$0.awaitsDelivery }
        persist()
    }

    /// Retry a refused-for-auth or stuck item now (same key, same body).
    public func retryNow(_ id: String) async {
        if let i = items.firstIndex(where: { $0.id == id }), items[i].awaitsDelivery { items[i].state = .queued }
        await flush()
    }

    private func persist() { env.store.save(items, StoreKey.pendingCommands) }
}
