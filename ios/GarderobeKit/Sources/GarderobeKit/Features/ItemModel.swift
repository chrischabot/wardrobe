import Foundation
import Observation

/// A one-tap command the item page offers, enabled only when the ledger's quantities make it
/// meaningful. The backend still validates every one.
public enum ItemAction: String, Sendable, CaseIterable, Identifiable {
    case inTheWash, washed, backFromTailor, arrived, putIntoStorage, takeOutOfStorage, sendToTailor
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .inTheWash: return "In the wash"
        case .washed: return "Washed"
        case .backFromTailor: return "Back from the tailor"
        case .arrived: return "Arrived"
        case .putIntoStorage: return "Put into storage"
        case .takeOutOfStorage: return "Take out of storage"
        case .sendToTailor: return "At the tailor"
        }
    }
    public var symbol: String {
        switch self {
        case .inTheWash: return "washer"
        case .washed: return "sparkles"
        case .backFromTailor: return "scissors"
        case .arrived: return "shippingbox"
        case .putIntoStorage: return "archivebox"
        case .takeOutOfStorage: return "tray.and.arrow.up"
        case .sendToTailor: return "scissors"
        }
    }
}

/// The item page: catalogue image, status, availability and its basis, facts, care, wear
/// history, known combinations, receipts, and the direct commands.
@MainActor
@Observable
public final class ItemModel {
    public let environment: AppEnvironment
    public let garmentId: String
    public let item: Resource<ItemResponse>
    public let feedback: Resource<FeedbackList>
    public private(set) var lastOutcome: SubmissionOutcome?
    public private(set) var isSubmitting = false
    /// Receipts for this garment fetched from the backend could not be loaded (history may be incomplete).
    public private(set) var historyFailure: APIFailure?

    public init(environment: AppEnvironment, garmentId: String) {
        self.environment = environment
        self.garmentId = garmentId
        let api = environment.api
        item = environment.resource("item.\(garmentId)") { try await api.item(id: garmentId) }
        feedback = environment.resource("item.\(garmentId).feedback") { try await api.feedback(garmentId: garmentId) }
    }

    public func open() async {
        item.loadCached()
        feedback.loadCached()
        await refresh()
    }

    public func refresh() async {
        await item.refresh()
        await feedback.refresh()
        do {
            let list = try await environment.api.receipts(entity: "garment:\(garmentId)", limit: 50)
            environment.center.merge(list.receipts)
            historyFailure = nil
        } catch let failure as APIFailure {
            historyFailure = failure
        } catch {}
    }

    public var detail: GarmentDetail? { item.value?.detail }
    public var garment: Garment? { detail?.garment }
    public var availability: GarmentAvailability? { item.value?.availability }

    /// The familiar one-line status ("At the tailor").
    public var statusLine: String {
        guard let garment else { return "" }
        return Phrases.status(of: availability, acquisition: garment.acquisition)
    }

    /// Where the units are, e.g. "5 clean at home · 2 in the wash". Aggregates only: the app
    /// never identifies an individual pair.
    public var quantityLine: String? {
        guard let detail else { return nil }
        let order: [Bucket] = [.clean, .dirty, .service, .storage, .tailor, .trip, .incoming]
        let parts: [String] = order.compactMap { bucket in
            let n = detail.quantity(in: bucket)
            guard n > 0 else { return nil }
            return detail.totalOwnedUnits > 1 || bucket == .incoming ? "\(n) \(Phrases.bucket(bucket).lowercased())" : Phrases.bucket(bucket)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The basis of the availability estimate, shown only in this detail view.
    public var availabilityBasis: [String] {
        guard let a = availability else { return [] }
        return a.basis.isEmpty ? a.reasons.map(Phrases.reason) : a.basis
    }

    public var wearLine: String? {
        guard let detail else { return nil }
        return Phrases.wearCount(detail.recordedWearCount, last: detail.lastRecordedWear, loggingSince: detail.garment.wearLoggingSince, today: environment.today)
    }

    /// Active restrictions with their reasons. An expected end is shown as a prediction only.
    public var restrictionLines: [String] {
        (detail?.restrictions ?? []).filter { $0.status == .active }.map { r in
            guard let end = r.expectedEnd, let date = Dates.parseInstant(end) else { return r.reason }
            return "\(r.reason) Expected until about \(Phrases.dayMonth(Dates.localDate(of: date, in: environment.timeZone))); stays in place until you say otherwise."
        }
    }

    /// Manufacturer terminology and identifying details, which belong on the item page.
    public var identityRows: [(label: String, value: String)] {
        guard let g = garment else { return [] }
        var rows: [(String, String)] = []
        func add(_ label: String, _ value: String?) { if let value, !value.isEmpty { rows.append((label, value)) } }
        add("Maker", g.maker); add("Product", g.product); add("Model", g.attributes.model); add("Fabric", g.fabric)
        add("Colour", g.colour); add("Pattern", g.pattern); add("Size", g.size); add("Condition", g.condition)
        add("Season", g.seasonNote); add("Fit", g.attributes.fitNote)
        return rows
    }

    public var careLine: String {
        switch garment?.careChannel {
        case .service: return "Goes to the laundry service"
        case .handwash: return "Washed by hand at home"
        case .some(.none): return "No laundry care"
        default: return ""
        }
    }

    /// Recorded facts (measurements, purchase source, alterations...) that are still current,
    /// each with where it came from.
    public func facts(matching prefixes: [String]) -> [GarmentFact] {
        (detail?.facts ?? []).filter { fact in fact.supersededBy == nil && prefixes.contains { fact.attribute.hasPrefix($0) } }
    }
    public var measurementFacts: [GarmentFact] { facts(matching: ["measurement", "measure", "size"]) }
    /// The item's current dated measurements (owner, tailor or maker), as the backend lists them.
    public var measurements: [Measurement] { (detail?.measurements ?? []).filter { $0.supersededBy == nil } }
    public var purchaseFacts: [GarmentFact] { facts(matching: ["purchase", "order", "price", "retailer", "source"]) }
    public var alterationFacts: [GarmentFact] { facts(matching: ["alteration", "tailor"]) }
    public var otherFacts: [GarmentFact] {
        let shown = Set((measurementFacts + purchaseFacts + alterationFacts).map(\.factId))
        return (detail?.facts ?? []).filter { $0.supersededBy == nil && !shown.contains($0.factId) }
    }

    public static func factValue(_ fact: GarmentFact) -> String {
        switch fact.value {
        case .string(let s): return s
        case .integer(let i): return String(i)
        case .number(let d): return String(d)
        case .bool(let b): return b ? "Yes" : "No"
        case .null: return "Not recorded"
        default: return (try? String(decoding: GarderobeJSON.encode(fact.value), as: UTF8.self)) ?? ""
        }
    }

    public var knownCombinations: [StudioCombination] { (item.value?.knownCombinations ?? []).filter { $0.status == .active } }

    /// The image reference, or the backend's note that there is none. Never an invented picture.
    public var image: GarmentImageRef? { item.value?.media?.image }
    public var photoRequest: String? { item.value?.media?.photoRequest }
    /// False when the media module could not be read: the ledger facts on the page are still authoritative.
    public var mediaAvailable: Bool { item.value?.mediaAvailable ?? true }

    /// Receipts that touched this garment, most recent first; each keeps its undo.
    public var history: [ReceiptRecord] { environment.center.receipts(for: "garment", id: garmentId) }

    /// The largest quantity an action can apply to, for the stepper on multi-unit entries.
    public func maximumQuantity(for action: ItemAction) -> Int {
        guard let detail else { return 0 }
        switch action {
        case .inTheWash, .putIntoStorage, .sendToTailor: return detail.quantity(in: .clean)
        case .washed: return detail.quantity(in: .dirty)
        case .backFromTailor: return detail.quantity(in: .tailor)
        case .arrived: return detail.quantity(in: .incoming)
        case .takeOutOfStorage: return detail.quantity(in: .storage)
        }
    }

    /// The direct commands worth showing for the garment's current quantities.
    public var availableActions: [ItemAction] {
        guard let garment else { return [] }
        return ItemAction.allCases.filter { action in
            if action == .inTheWash || action == .washed, garment.careChannel == CareChannel.none { return false }
            return maximumQuantity(for: action) > 0
        }
    }

    /// Performs a direct command. `quantity` matters only for entries with several identical units.
    @discardableResult
    public func perform(_ action: ItemAction, quantity: Int? = nil) async -> SubmissionOutcome? {
        guard let garment else { return nil }
        let name = garment.name
        let units = quantity.map { $0 > 1 ? " (\($0))" : "" } ?? ""
        let draft: CommandDraft
        switch action {
        case .inTheWash:
            draft = CommandDraft(CommandCareMarkDirty(items: [.init(garmentId: garmentId, quantity: quantity)]), label: "\(name)\(units): in the wash")
        case .washed:
            draft = CommandDraft(CommandCareWashed(items: [.init(garmentId: garmentId, quantity: quantity)]), label: "\(name)\(units): washed")
        case .backFromTailor:
            draft = CommandDraft(CommandGarmentMove(garmentId: garmentId, to: .clean, from: .tailor, quantity: quantity), label: "\(name): back from the tailor")
        case .arrived:
            draft = CommandDraft(CommandGarmentReceive(garmentId: garmentId, quantity: quantity), label: "\(name): arrived")
        case .putIntoStorage:
            draft = CommandDraft(CommandGarmentMove(garmentId: garmentId, to: .storage, quantity: quantity), label: "\(name)\(units): put into storage")
        case .takeOutOfStorage:
            draft = CommandDraft(CommandGarmentMove(garmentId: garmentId, to: .clean, from: .storage, quantity: quantity), label: "\(name)\(units): out of storage")
        case .sendToTailor:
            draft = CommandDraft(CommandGarmentMove(garmentId: garmentId, to: .tailor, quantity: quantity), label: "\(name): at the tailor")
        }
        return await submit(draft)
    }

    /// Records that this garment was worn (an owner observation), today unless a date is given.
    @discardableResult
    public func woreIt(on date: LocalDate? = nil) async -> SubmissionOutcome? {
        guard let garment else { return nil }
        let payload = CommandWearRecord(wearingDate: date ?? environment.today, garmentIds: [garmentId], timezone: environment.timeZone.identifier)
        return await submit(CommandDraft(payload, label: "Wore \(garment.name)"))
    }

    /// Optional comfort feedback, linked to this garment. Only what the owner said is sent;
    /// anything not known stays unknown, and no follow-up questions are generated.
    @discardableResult
    public func recordFeedback(text: String, kind: ComfortKind, wearingDate: LocalDate? = nil) async -> SubmissionOutcome? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let garment else { return nil }
        let payload = CommandFeedbackRecord(text: trimmed, kind: kind, garmentIds: [garmentId], wearingDate: wearingDate)
        return await submit(CommandDraft(payload, label: "Feedback on \(garment.name)"))
    }

    @discardableResult
    public func retractFeedback(_ feedbackId: String) async -> SubmissionOutcome? {
        await submit(CommandDraft(CommandFeedbackRetract(feedbackId: feedbackId), label: "Removed feedback"))
    }

    private func submit(_ draft: CommandDraft) async -> SubmissionOutcome {
        isSubmitting = true
        defer { isSubmitting = false }
        let outcome = await environment.center.submit(draft)
        lastOutcome = outcome
        if case .confirmed = outcome { await refresh() }
        return outcome
    }

    /// The identity "Ask about this" attaches to a message.
    public var askAboutReference: AttachedRef { AttachedRef(kind: .garment, id: garmentId) }

    public var freshnessLine: String {
        item.freshness.statement(subject: "item", now: environment.time.now(), timeZone: environment.timeZone)
    }
}

/// The optional reconciliation view: the owner states a count and the app takes his word.
/// Routine use never requires it.
@MainActor
@Observable
public final class ReconcileModel {
    public struct Counts: Sendable, Equatable {
        public var clean: Int
        public var dirty: Int
        public var storage: Int
        public var total: Int
    }

    public let environment: AppEnvironment
    public let item: InventoryItem
    public let original: Counts
    public var counts: Counts
    public private(set) var lastOutcome: SubmissionOutcome?

    public init(environment: AppEnvironment, item: InventoryItem) {
        self.environment = environment
        self.item = item
        original = Counts(clean: item.quantity(in: .clean), dirty: item.quantity(in: .dirty), storage: item.quantity(in: .storage), total: item.totalOwnedUnits)
        counts = original
    }

    public var hasChanges: Bool { counts != original }

    /// Sends only the counts the owner changed, as one aggregate correction.
    @discardableResult
    public func save(note: String? = nil) async -> SubmissionOutcome? {
        guard hasChanges else { return nil }
        let payload = CommandStockReconcile(garmentId: item.garment.garmentId, counts: .init(
            clean: counts.clean != original.clean ? counts.clean : nil,
            dirty: counts.dirty != original.dirty ? counts.dirty : nil,
            storage: counts.storage != original.storage ? counts.storage : nil,
            total: counts.total != original.total ? counts.total : nil), note: note)
        let outcome = await environment.center.submit(CommandDraft(payload, label: "Corrected the count of \(item.garment.name)"))
        lastOutcome = outcome
        return outcome
    }
}
