import Foundation
import Observation

/// One correction applied to several garments at once, as a single command with one receipt
/// and one undo (`garment.bulk_correct`). The owner ticks the items, or names a category or a
/// search and reads the backend's matches first; the command carries the number he saw, so the
/// backend refuses it if the set has changed.
@MainActor
@Observable
public final class BulkEditModel {
    /// The descriptive attributes that can be corrected in bulk from the phone.
    public enum Field: String, Sendable, CaseIterable, Identifiable {
        case colour, fabric, maker, product, pattern, size, condition, careChannel
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .colour: return "Colour"
            case .fabric: return "Fabric"
            case .maker: return "Maker"
            case .product: return "Product"
            case .pattern: return "Pattern"
            case .size: return "Size"
            case .condition: return "Condition"
            case .careChannel: return "Care"
            }
        }
    }

    public static let careChannels: [CareChannel] = [.service, .handwash, .none]

    public static func careTitle(_ channel: CareChannel) -> String {
        switch channel {
        case .service: return "Laundry service"
        case .handwash: return "Hand wash"
        case .none: return "No laundering"
        case .unknown: return "Other"
        }
    }

    /// Which garments the correction covers.
    public enum Scope: String, Sendable, CaseIterable, Identifiable {
        /// Exactly the items the owner ticked.
        case ticked
        /// Everything in one category, as the backend currently records it.
        case category
        /// Everything matching search words (name, maker, product, colour, fabric or an alias).
        case search
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .ticked: return "Items I tick"
            case .category: return "A whole category"
            case .search: return "Everything matching a search"
            }
        }
    }

    public let environment: AppEnvironment
    /// The items offered for selection: what Wardrobe was showing when bulk edit opened.
    public let candidates: [InventoryItem]
    public private(set) var selection: Set<String> = []
    public var scope: Scope = .ticked { didSet { if scope != oldValue { matched = nil } } }
    public var category: Category = .shirt { didSet { if category != oldValue { matched = nil } } }
    public var searchText = "" { didSet { if searchText != oldValue { matched = nil } } }
    /// The backend's answer to "which garments does this category or search cover", read before
    /// the change is confirmed. Its count is sent with the command.
    public private(set) var matched: GarmentSelection?
    public private(set) var message: String?
    public var field: Field = .colour
    /// The new text for a text attribute.
    public var text = ""
    /// Clear the attribute instead of setting it (text attributes only).
    public var clearsValue = false
    public var careChannel: CareChannel = .service
    public private(set) var lastOutcome: SubmissionOutcome?
    public private(set) var isSubmitting = false

    public init(environment: AppEnvironment, candidates: [InventoryItem]) {
        self.environment = environment
        self.candidates = candidates.filter { $0.garment.acquisition != .disposed }
    }

    public func isSelected(_ item: InventoryItem) -> Bool { selection.contains(item.garment.garmentId) }

    public func toggle(_ item: InventoryItem) {
        let id = item.garment.garmentId
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
    }

    public func selectAll() { selection = Set(candidates.map(\.garment.garmentId)) }
    public func clearSelection() { selection = [] }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedSearch: String { searchText.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The selector for the chosen scope, or nil while it names nothing.
    public var selector: GarmentSelector? {
        switch scope {
        case .ticked: return selection.isEmpty ? nil : GarmentSelector(garmentIds: selection.sorted())
        case .category: return GarmentSelector(category: category)
        case .search: return trimmedSearch.isEmpty ? nil : GarmentSelector(search: trimmedSearch)
        }
    }

    /// How many garments the command will name: the ticked items, or the backend's match.
    public var targetCount: Int? { scope == .ticked ? (selection.isEmpty ? nil : selection.count) : matched?.count }

    /// Reads from the backend which garments the category or search covers. Writes nothing.
    public func loadMatches() async {
        guard scope != .ticked, let selector else { return }
        do {
            let result = try await environment.api.garmentSelection(selector)
            guard selector == self.selector else { return }
            matched = result
            message = result.count == 0 ? "Nothing matches." : nil
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            environment.center.noteRead(failure: failure)
            message = failure.isTransport ? "Offline: the matching items cannot be checked now. Tick the items instead." : failure.ownerMessage
        } catch {
            message = "The matching items could not be read."
        }
    }

    public var canSubmit: Bool {
        guard let count = targetCount, count > 0, !isSubmitting else { return false }
        return field == .careChannel || clearsValue || !trimmed.isEmpty
    }

    /// `Set colour to "navy" on 12 items` - what the button will do, in full, before it is pressed.
    public var summaryLine: String {
        let target = targetCount.map { Phrases.count($0, "item") } ?? "the items you choose"
        if field == .careChannel { return "Set care to \(BulkEditModel.careTitle(careChannel).lowercased()) on \(target)" }
        if clearsValue { return "Clear the \(field.title.lowercased()) of \(target)" }
        return "Set \(field.title.lowercased()) to \"\(trimmed)\" on \(target)"
    }

    private var changes: CommandGarmentBulkCorrect.Changes {
        let value: Nullable<String> = clearsValue ? .null : .value(trimmed)
        switch field {
        case .colour: return .init(colour: value)
        case .fabric: return .init(fabric: value)
        case .maker: return .init(maker: value)
        case .product: return .init(product: value)
        case .pattern: return .init(pattern: value)
        case .size: return .init(size: value)
        case .condition: return .init(condition: value)
        case .careChannel: return .init(careChannel: careChannel)
        }
    }

    /// Sends the one correction for the chosen garments, with the number the owner saw. The
    /// backend refuses it when the set has changed since; the matches are then read again.
    @discardableResult
    public func submit() async -> SubmissionOutcome? {
        guard canSubmit, let selector, let count = targetCount else { return nil }
        isSubmitting = true
        defer { isSubmitting = false }
        let payload = CommandGarmentBulkCorrect(selector: selector, changes: changes, expectedCount: count, source: SourceRef(kind: .ownerStatement))
        let outcome = await environment.center.submit(CommandDraft(payload, label: summaryLine))
        lastOutcome = outcome
        switch outcome {
        case .confirmed: selection = []; matched = nil
        case .rejected where scope != .ticked:
            matched = nil
            await loadMatches()
            message = "The matching items changed. Check the list and apply again."
        default: break
        }
        return outcome
    }
}
