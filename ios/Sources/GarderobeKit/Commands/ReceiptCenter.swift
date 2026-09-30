import Foundation
import Observation

/// Receipts, the short-lived Undo banner, and undo itself (spec section 3, "Laundry, wear
/// follow-through, and undo"). The banner lasts eight seconds; the receipt stays accessible and
/// undo does not expire with the banner. Undo is a compensating command, never a deletion.
@MainActor
@Observable
public final class ReceiptCenter {
    public struct Banner: Identifiable, Equatable, Sendable {
        public let id: String
        public let receipt: CommandReceipt
        public let shownAt: Date
    }

    public enum UndoState: Equatable, Sendable {
        case available
        case pending
        case alreadyUndone
        case notReversible(String)
        case notApplicable
    }

    public static let bannerDuration: Duration = .seconds(8)

    /// Newest first.
    public private(set) var receipts: [CommandReceipt] = []
    public private(set) var banner: Banner?

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private var bannerTask: Task<Void, Never>?
    @ObservationIgnored private var held = false
    @ObservationIgnored private var undoInFlight = Set<String>()
    @ObservationIgnored private let limit = 300

    public init(env: AppEnvironment) {
        self.env = env
        receipts = env.store.load([CommandReceipt].self, StoreKey.receipts) ?? []
    }

    /// Record a verified receipt. `announce` shows the banner (user-initiated actions).
    public func record(_ receipt: CommandReceipt, announce: Bool = true) {
        upsert(receipt)
        if let target = receipt.compensatesCommandId, receipt.outcome.didCommit, let i = receipts.firstIndex(where: { $0.commandId == target }) {
            receipts[i].undoneByCommandId = receipt.commandId
            undoInFlight.remove(target)
        }
        persist()
        if announce { show(receipt) }
    }

    /// Merge receipts fetched from the server (persistent receipt access); never announces.
    public func merge(_ incoming: [CommandReceipt]) {
        for r in incoming { upsert(r) }
        receipts.sort { $0.recordedAt > $1.recordedAt }
        persist()
    }

    private func upsert(_ r: CommandReceipt) {
        if let i = receipts.firstIndex(where: { $0.commandId == r.commandId }) {
            var merged = r
            if merged.undoneByCommandId == nil { merged.undoneByCommandId = receipts[i].undoneByCommandId }
            receipts[i] = merged
        } else {
            receipts.insert(r, at: 0)
            if receipts.count > limit { receipts.removeLast(receipts.count - limit) }
        }
    }

    private func show(_ receipt: CommandReceipt) {
        let b = Banner(id: env.uuid(), receipt: receipt, shownAt: env.now())
        banner = b
        startTimer(for: b.id)
    }

    private func startTimer(for id: String) {
        bannerTask?.cancel()
        guard !held else { return }
        let sleep = env.sleep
        bannerTask = Task { [weak self] in
            do { try await sleep(Self.bannerDuration) } catch { return }
            guard let self, self.banner?.id == id, !self.held else { return }
            self.banner = nil
        }
    }

    public func dismissBanner() {
        bannerTask?.cancel()
        banner = nil
    }

    /// Pause auto-dismiss while VoiceOver focus or a finger rests on the banner; resuming restarts the full duration.
    public func holdBanner(_ hold: Bool) {
        held = hold
        if hold { bannerTask?.cancel() } else if let b = banner { startTimer(for: b.id) }
    }

    public func receipt(_ commandId: String) -> CommandReceipt? { receipts.first { $0.commandId == commandId } }

    public func receipts(forGarment garmentId: String) -> [CommandReceipt] { receipts.filter { $0.garmentIds.contains(garmentId) } }

    public func undoState(for r: CommandReceipt) -> UndoState {
        guard r.outcome.didCommit, r.commandType != "undo" else { return .notApplicable }
        if r.undoneByCommandId != nil { return .alreadyUndone }
        if undoInFlight.contains(r.commandId) { return .pending }
        guard r.undo.available else { return .notReversible(r.undo.reason ?? "This change can't be undone from here") }
        return .available
    }

    /// What happens to an external effect (e.g. the Calendar event) if this receipt is undone.
    public func externalEffectNote(for r: CommandReceipt) -> String? {
        guard r.hasExternalEffect else { return nil }
        switch r.effects.state {
        case "projected": return "Calendar updated. Undo sends a correcting update."
        case "projection_pending": return "Calendar update pending. Undo replaces it."
        case "failed": return "The calendar update failed and will retry. Undo stops it."
        default: return nil
        }
    }

    /// Undo through a compensating command. The backend rechecks intervening changes.
    @discardableResult
    public func undo(_ r: CommandReceipt, queue: CommandQueue) async -> SubmitOutcome? {
        guard undoState(for: r) == .available else { return nil }
        undoInFlight.insert(r.commandId)
        let outcome = await queue.submit(.undo(targetCommandId: r.commandId), label: "Undo: \(r.summary)", context: .init(garmentIds: Array(r.garmentIds)))
        switch outcome {
        case .receipt(let receipt):
            if !receipt.outcome.didCommit { undoInFlight.remove(r.commandId) }
        case .failed:
            undoInFlight.remove(r.commandId)
        case .queued:
            break
        }
        return outcome
    }

    private func persist() { env.store.save(receipts, StoreKey.receipts) }
}
