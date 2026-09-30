import Foundation
import Observation

/// The Laundry sheet: service laundry and hand wash shown separately, with Collected, Returned,
/// Some items still away and Socks washed. The return view starts from actual batch membership.
@MainActor
@Observable
public final class LaundryViewModel {
    public private(set) var state: LaundryState?
    public private(set) var isRefreshing = false
    public private(set) var lastError: APIError?
    /// "Some items still away" editor: garment ID → units still away, for the batch being returned.
    public private(set) var stillAway: [String: Int] = [:]
    public private(set) var editingBatchId: String?
    /// Hand-wash selection for Socks washed (default: everything in the hand-wash hamper).
    public var socksSelection: Set<String> = []

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let queue: CommandQueue
    @ObservationIgnored public var onChange: (@MainActor () async -> Void)?

    public init(env: AppEnvironment, queue: CommandQueue) {
        self.env = env; self.queue = queue
        state = env.store.load(LaundryState.self, StoreKey.laundry)
        socksSelection = Set(state?.handWash.hamper.map(\.garmentId) ?? [])
    }

    public func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let s = try await env.api.laundry()
            state = s
            env.store.save(s, StoreKey.laundry)
            socksSelection = Set(s.handWash.hamper.map(\.garmentId))
            lastError = nil
        } catch let e as APIError {
            lastError = e
        } catch {}
    }

    public var serviceHamper: [LaundryLine] { state?.service.hamper ?? [] }
    public var openBatches: [LaundryBatch] { state?.service.batches.filter(\.isOpen) ?? [] }
    public var handWashHamper: [LaundryLine] { state?.handWash.hamper ?? [] }
    /// Owner-reported exceptions still open (still away, missed return, delay…).
    public var openExceptions: [LaundryException] { state?.openExceptions ?? [] }
    public var canCollect: Bool { !serviceHamper.isEmpty }

    public func name(_ garmentId: String, in batch: LaundryBatch) -> String { batch.names[garmentId] ?? "An item" }

    // MARK: Some items still away

    public func beginException(for batch: LaundryBatch) {
        editingBatchId = batch.batchId
        stillAway = [:]
    }

    public func cancelException() { editingBatchId = nil; stillAway = [:] }

    /// Toggle or set how many units of one batch line did not come back (bounded by what went out).
    public func setStillAway(_ garmentId: String, quantity: Int) {
        guard let batch = openBatches.first(where: { $0.batchId == editingBatchId }), let line = batch.items.first(where: { $0.garmentId == garmentId }) else { return }
        let q = max(0, min(quantity, line.outstanding))
        stillAway[garmentId] = q == 0 ? nil : q
    }

    // MARK: Actions (each returns a receipt and updates availability)

    public func collected() async -> ActionResult {
        guard canCollect else { return .refused("Nothing is waiting in the service hamper") }
        return await run(.laundryCollected(occurredAt: env.now()), "Collected: " + serviceHamper.map(\.name).joined(separator: ", "))
    }

    public func returned(_ batch: LaundryBatch) async -> ActionResult {
        await run(.laundryReturned(batchId: batch.batchId, occurredAt: env.now()), "Laundry returned")
    }

    public func confirmSomeStillAway() async -> ActionResult {
        guard let batchId = editingBatchId, !stillAway.isEmpty else { return .refused("Mark what is still away") }
        let batch = openBatches.first { $0.batchId == batchId }
        let exceptions = stillAway.sorted { $0.key < $1.key }.map { key, q in
            DomainCommand.BatchException(garmentId: key, quantity: (batch?.items.first { $0.garmentId == key }?.quantity ?? 1) > 1 ? q : nil)
        }
        let names = stillAway.keys.compactMap { id in batch.map { name(id, in: $0) } }.sorted()
        let result = await run(.laundryPartialReturn(batchId: batchId, exceptions: exceptions, occurredAt: env.now()), "Returned, still away: " + names.joined(separator: ", "))
        if case .done = result { cancelException() }
        return result
    }

    public func socksWashed() async -> ActionResult {
        let all = Set(handWashHamper.map(\.garmentId))
        guard !socksSelection.isEmpty else { return .refused("No socks selected") }
        let ids = socksSelection == all ? nil : socksSelection.sorted()
        return await run(.socksWashed(garmentIds: ids, occurredAt: env.now()), "Socks washed")
    }

    private func run(_ command: DomainCommand, _ label: String) async -> ActionResult {
        let result = ActionResult(await queue.submit(command, label: label))
        if case .done = result {
            await refresh()
            await onChange?()
        }
        return result
    }
}
