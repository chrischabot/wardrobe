import Foundation
import Observation

/// Choosing garments and quantities to pack that are not on the proposal (or instead of it).
/// The owner states what went into the bag; `stock.pack` records it and the backend checks it
/// against the ledger. The quantity offered for a garment is the clean stock at home as the
/// backend last reported it: a convenience limit for the stepper, not a decision.
@MainActor
@Observable
public final class PackingPickerModel {
    public struct Row: Sendable, Equatable, Identifiable {
        public var item: InventoryItem
        /// Clean units at home, as the wardrobe read reported them.
        public var atHome: Int
        /// Units of this garment already packed for the trip.
        public var alreadyPacked: Int
        public var quantity: Int
        public var id: String { item.garment.garmentId }
    }

    public let environment: AppEnvironment
    public let trips: TripsModel
    public let tripId: String
    private let candidates: [InventoryItem]
    public var search = ""
    public private(set) var quantities: [String: Int] = [:]
    public private(set) var lastOutcome: SubmissionOutcome?

    public init(environment: AppEnvironment, trips: TripsModel, tripId: String, candidates: [InventoryItem]) {
        self.environment = environment
        self.trips = trips
        self.tripId = tripId
        // Only garments the owner has, with something clean at home to put in a bag.
        self.candidates = candidates.filter { $0.garment.acquisition == .owned && $0.quantity(in: .clean) > 0 }
            .sorted { ($0.garment.category.rawValue, $0.garment.name) < ($1.garment.category.rawValue, $1.garment.name) }
    }

    public var trip: Trip? { trips.trip(tripId) }

    /// The garments offered, narrowed by the search words (name, alias, maker, colour).
    public var rows: [Row] {
        let words = search.lowercased().split(separator: " ").map(String.init)
        let packed = trip?.packed ?? []
        return candidates.filter { item in
            guard !words.isEmpty else { return true }
            let g = item.garment
            let text = ([g.name, g.maker ?? "", g.product ?? "", g.colour ?? ""] + item.aliases).joined(separator: " ").lowercased()
            return words.allSatisfy(text.contains)
        }.map { item in
            let id = item.garment.garmentId
            return Row(item: item, atHome: item.quantity(in: .clean), alreadyPacked: packed.first { $0.garmentId == id }.map { $0.clean + $0.worn } ?? 0, quantity: quantities[id] ?? 0)
        }
    }

    /// Sets how many of a garment to pack, between none and what is clean at home.
    public func setQuantity(_ quantity: Int, for garmentId: String) {
        guard let item = candidates.first(where: { $0.garment.garmentId == garmentId }) else { return }
        let clamped = min(max(0, quantity), item.quantity(in: .clean))
        quantities[garmentId] = clamped == 0 ? nil : clamped
    }

    public var selectedUnits: Int { quantities.values.reduce(0, +) }

    /// `Pack 3 items` - what the button will record.
    public var summaryLine: String { selectedUnits == 0 ? "Choose what to pack" : "Pack \(Phrases.count(selectedUnits, "item"))" }

    /// Records the chosen quantities as packed for the trip, in one command.
    @discardableResult
    public func pack() async -> SubmissionOutcome? {
        guard let trip, selectedUnits > 0 else { return nil }
        let items = candidates.compactMap { item in quantities[item.garment.garmentId].map { (garmentId: item.garment.garmentId, quantity: $0) } }
        let outcome = await trips.packed(trip, items: items)
        lastOutcome = outcome
        switch outcome {
        case .confirmed?, .queued?: quantities = [:]
        default: break
        }
        return outcome
    }
}
