import Foundation
import Observation

/// The Laundry sheet (reachable from Today and Wardrobe): service laundry and hand-wash shown
/// separately, with Collected, Returned, Some items still away and Socks washed. Every action is
/// a command with a receipt; the phone computes nothing about cleanliness.
@MainActor
@Observable
public final class LaundryModel {
    /// The return view's working state. It starts from the batch's actual membership with
    /// everything returned; the owner only marks the exceptions.
    public struct ReturnDraft: Sendable, Equatable {
        public struct Line: Sendable, Equatable, Identifiable {
            public var garmentId: String
            public var name: String
            /// Units of this garment that went out in the batch and are not yet back.
            public var outstanding: Int
            /// How many of them the owner says are still away (0...outstanding).
            public var stillAway: Int
            public var id: String { garmentId }
        }
        public var batchId: String
        public var lines: [Line]
        public var hasExceptions: Bool { lines.contains { $0.stillAway > 0 } }
    }

    public let environment: AppEnvironment
    public let state: Resource<LaundryStateResponse>
    public var returnDraft: ReturnDraft?
    public private(set) var lastOutcome: SubmissionOutcome?
    public private(set) var isSubmitting = false

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        state = environment.resource("laundry") { try await api.laundry() }
    }

    public func open() async {
        state.loadCached()
        await state.refresh()
    }

    // MARK: Reading

    public var awaitingService: [LaundryStateResponse.AwaitingServiceItem] { state.value?.awaitingService ?? [] }
    public var awaitingHandwash: [LaundryStateResponse.AwaitingHandwashItem] { state.value?.awaitingHandwash ?? [] }

    /// Batches that were collected and have not fully returned, oldest first.
    public var outstandingBatches: [LaundryStateResponse.BatchesItem] {
        (state.value?.batches ?? []).filter { $0.returnedAt == nil || $0.items.contains { $0.stillAway > 0 } }.sorted { $0.pickedUpAt < $1.pickedUpAt }
    }

    public var serviceSummary: String {
        let waiting = awaitingService.reduce(0) { $0 + $1.quantity }
        let away = outstandingBatches.reduce(0) { total, batch in total + batch.items.reduce(0) { $0 + LaundryModel.outstanding($1) } }
        var parts: [String] = []
        parts.append(waiting == 0 ? "Nothing waiting for collection" : "\(Phrases.count(waiting, "item")) waiting for collection")
        if away > 0 { parts.append("\(Phrases.count(away, "item")) away") }
        return parts.joined(separator: " · ")
    }

    public var handwashSummary: String {
        let waiting = awaitingHandwash.reduce(0) { $0 + $1.quantity }
        return waiting == 0 ? "Nothing waiting to be hand-washed" : "\(Phrases.count(waiting, "item")) waiting to be hand-washed"
    }

    public func batchTitle(_ batch: LaundryStateResponse.BatchesItem) -> String {
        let when = Dates.parseInstant(batch.pickedUpAt).map { Phrases.relativeDay(Dates.localDate(of: $0, in: environment.timeZone), today: environment.today) } ?? batch.pickedUpAt
        let count = batch.items.reduce(0) { $0 + $1.quantity }
        return "Collected \(when) · \(Phrases.count(count, "item"))"
    }

    static func outstanding(_ item: LaundryStateResponse.BatchesItem.ItemsItem) -> Int {
        max(0, item.quantity - item.returnedQuantity)
    }

    public var freshnessLine: String {
        state.freshness.statement(subject: "laundry", now: environment.time.now(), timeZone: environment.timeZone)
    }

    // MARK: Actions

    private func submit(_ draft: CommandDraft) async -> SubmissionOutcome {
        isSubmitting = true
        defer { isSubmitting = false }
        let outcome = await environment.center.submit(draft)
        lastOutcome = outcome
        if case .confirmed = outcome { await state.refresh() }
        return outcome
    }

    /// Collected: the service picked up what was waiting. The backend snapshots the batch membership.
    @discardableResult
    public func collected(excluding garmentIds: [String] = []) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandLaundryCollect(exclude: garmentIds.isEmpty ? nil : garmentIds), label: "Laundry collected"))
    }

    /// Opens the return view for a batch, pre-filled from its actual membership.
    public func beginReturn(batchId: String? = nil) {
        guard let batch = batchId.flatMap({ id in outstandingBatches.first { $0.batchId == id } }) ?? outstandingBatches.first else { returnDraft = nil; return }
        returnDraft = ReturnDraft(batchId: batch.batchId, lines: batch.items.compactMap { item in
            let outstanding = LaundryModel.outstanding(item)
            guard outstanding > 0 else { return nil }
            return ReturnDraft.Line(garmentId: item.garmentId, name: item.name, outstanding: outstanding, stillAway: 0)
        })
    }

    /// Sets how many units of a line are still away, clamped to what went out.
    public func setStillAway(garmentId: String, quantity: Int) {
        guard let i = returnDraft?.lines.firstIndex(where: { $0.garmentId == garmentId }) else { return }
        returnDraft!.lines[i].stillAway = min(max(0, quantity), returnDraft!.lines[i].outstanding)
    }

    /// Returned (optionally with "Some items still away"): completes only this batch's contents, less the exceptions.
    @discardableResult
    public func confirmReturn() async -> SubmissionOutcome? {
        guard let draft = returnDraft else { return nil }
        let away = draft.lines.filter { $0.stillAway > 0 }.map { CommandLaundryReturn.StillAwayItem(garmentId: $0.garmentId, quantity: $0.stillAway) }
        let label = away.isEmpty ? "Laundry returned" : "Laundry returned; \(Phrases.list(draft.lines.filter { $0.stillAway > 0 }.map(\.name))) still away"
        let outcome = await submit(CommandDraft(CommandLaundryReturn(batchId: draft.batchId, stillAway: away.isEmpty ? nil : away), label: label))
        if case .rejected = outcome {} else { returnDraft = nil }
        return outcome
    }

    /// Socks washed: clears every hand-wash item waiting, or the given quantities.
    @discardableResult
    public func handwashDone(items: [(garmentId: String, quantity: Int)]? = nil) async -> SubmissionOutcome {
        if let items, !items.isEmpty {
            return await submit(CommandDraft(CommandCareWashed(items: items.map { .init(garmentId: $0.garmentId, quantity: $0.quantity) }), label: "Hand-washed"))
        }
        return await submit(CommandDraft(CommandCareWashed(allOfChannel: .handwash), label: "Socks washed"))
    }

    /// The owner reports that this week's return is delayed or was missed. This overrides the
    /// routine weekly reset; it creates no task.
    @discardableResult
    public func reportCycleException(_ kind: CommandLaundryReportException.Kind, note: String? = nil) async -> SubmissionOutcome {
        let label = kind == .delayed ? "Laundry return delayed" : "Laundry return missed"
        return await submit(CommandDraft(CommandLaundryReportException(kind: kind, note: note), label: label))
    }

    /// An item-level exception outside a return ("this shirt is still away", "lost").
    @discardableResult
    public func reportItemException(_ kind: CommandLaundryReportException.Kind, garmentId: String, name: String, quantity: Int = 1) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandLaundryReportException(kind: kind, garmentId: garmentId, quantity: quantity), label: "\(name): \(kind == .lost ? "lost at the laundry" : "still away")"))
    }
}
