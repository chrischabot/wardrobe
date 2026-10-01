import Foundation
import Observation

/// How long ago an item was last recorded as worn; a presentation filter over the backend's
/// `lastRecordedWear`. "No wear logged" is never called "unworn".
public enum LastWearFilter: String, Codable, Sendable, CaseIterable, Identifiable {
    case any, lastWeek, lastMonth, overAMonth, noneLogged
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .any: return "Any time"
        case .lastWeek: return "Worn in the last 7 days"
        case .lastMonth: return "Worn in the last 30 days"
        case .overAMonth: return "Last worn over 30 days ago"
        case .noneLogged: return "No wear logged"
        }
    }
}

/// The filters the Wardrobe screen offers. Search, category, availability, colour and location
/// are answered by the backend (so aliases, maker names and codes resolve exactly as they do
/// for MCP); season and last recorded wear narrow the returned list on the phone.
public struct WardrobeFilters: Codable, Sendable, Equatable {
    public var search = ""
    public var category: Category?
    public var availability: AvailabilityStatus?
    public var colour: String?
    public var location: InventoryQuery.Location?
    public var season: String?
    public var lastWear: LastWearFilter = .any
    public var includeRetired = false
    public init() {}

    public var isEmpty: Bool { self == WardrobeFilters() }

    var query: InventoryQuery {
        let text = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return InventoryQuery(search: text.isEmpty ? nil : text, category: category?.rawValue,
                              availability: availability.flatMap { InventoryQuery.Availability(rawValue: $0.rawValue) },
                              colour: colour, location: location, includeDisposed: includeRetired ? true : nil)
    }

    /// Whether the backend query differs from the plain complete snapshot.
    var isServerFiltered: Bool {
        !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || category != nil || availability != nil || colour != nil || location != nil || includeRetired
    }
}

/// Wardrobe: the owner's garments by the names he recognises, with search, filters and counts.
@MainActor
@Observable
public final class WardrobeModel {
    public let environment: AppEnvironment
    /// The complete snapshot (cached): what Wardrobe opens with and what offline search uses.
    public let snapshot: Resource<InventoryPage>
    /// The backend's answer to the current filters, when any server-side filter is set.
    public let filtered: Resource<InventoryPage>

    public var filters: WardrobeFilters {
        didSet {
            guard filters != oldValue else { return }
            environment.restoration.save("wardrobe.filters", filters)
            retarget()
        }
    }
    /// List instead of grid; the view also switches to the list at accessibility text sizes.
    public var prefersList: Bool { didSet { environment.restoration.save("wardrobe.list", prefersList) } }

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        snapshot = environment.resource("wardrobe.all") { try await api.wardrobe(InventoryQuery()) }
        filtered = environment.resource("wardrobe.filtered", cached: false) { try await api.wardrobe(InventoryQuery()) }
        filters = environment.restoration.load("wardrobe.filters") ?? WardrobeFilters()
        prefersList = environment.restoration.load("wardrobe.list") ?? false
        retarget()
    }

    private func retarget() {
        let api = environment.api
        let query = filters.query
        filtered.retarget { try await api.wardrobe(query) }
    }

    public func open() async {
        snapshot.loadCached()
        await refresh()
    }

    public func refresh() async {
        await snapshot.refresh()
        if filters.isServerFiltered { await filtered.refresh() }
    }

    /// Runs the current search and filters against the backend.
    public func applyFilters() async {
        if filters.isServerFiltered { await filtered.refresh() }
    }

    /// True when the list on screen was filtered on the phone from the saved wardrobe because
    /// the backend could not be reached. The view says so.
    public var isSearchingSavedCopy: Bool {
        filters.isServerFiltered && (filtered.origin != .live || filtered.failure != nil)
    }

    /// The items to show.
    public var items: [InventoryItem] {
        let base: [InventoryItem]
        if !filters.isServerFiltered {
            base = snapshot.value?.items ?? []
        } else if filtered.origin == .live, filtered.failure == nil, let page = filtered.value {
            base = page.items
        } else {
            base = (snapshot.value?.items ?? []).filter(matchesSavedCopy)
        }
        return base.filter(matchesLocal)
    }

    /// Season and last-wear narrowing of what the backend returned.
    private func matchesLocal(_ item: InventoryItem) -> Bool {
        if let season = filters.season, item.garment.seasonNote != season { return false }
        let today = environment.today
        let age = item.lastRecordedWear.flatMap { Dates.days(from: $0, to: today) }
        switch filters.lastWear {
        case .any: return true
        case .lastWeek: return age.map { $0 <= 7 } ?? false
        case .lastMonth: return age.map { $0 <= 30 } ?? false
        case .overAMonth: return age.map { $0 > 30 } ?? false
        case .noneLogged: return item.lastRecordedWear == nil
        }
    }

    /// Offline stand-in for the backend filter, over the saved snapshot: plain text matching on
    /// names, aliases, maker and product text, and equality on the other fields.
    private func matchesSavedCopy(_ item: InventoryItem) -> Bool {
        let g = item.garment
        if !filters.includeRetired && g.acquisition == .disposed { return false }
        if let category = filters.category, g.category != category { return false }
        if let availability = filters.availability, item.availability?.status != availability { return false }
        if let colour = filters.colour, g.colour?.caseInsensitiveCompare(colour) != .orderedSame { return false }
        if let location = filters.location {
            let bucket: Bucket
            switch location {
            case .home: bucket = .clean
            case .storage: bucket = .storage
            case .tailor: bucket = .tailor
            case .trip: bucket = .trip
            case .service: bucket = .service
            case .unknown: return true
            }
            let here = item.quantity(in: bucket) + (location == .home ? item.quantity(in: .dirty) : 0)
            if here == 0 { return false }
        }
        let text = filters.search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if text.isEmpty { return true }
        let haystack = ([g.name, g.maker, g.product, g.colour, g.fabric, g.attributes.model] + item.aliases).compactMap { $0?.lowercased() }
        return text.split(separator: " ").allSatisfy { word in haystack.contains { $0.contains(word) } }
    }

    /// Owned, available, incoming and retired, as counted by the backend for the complete wardrobe.
    public var counts: InventoryPage.Counts? { snapshot.value?.counts }

    public var countsLine: String? {
        guard let c = counts else { return nil }
        var parts = ["\(c.owned) owned", "\(c.available) available"]
        if c.incoming > 0 { parts.append("\(c.incoming) on the way") }
        if c.retired > 0 { parts.append("\(c.retired) retired") }
        return parts.joined(separator: " · ")
    }

    /// True when the backend said the list is one page of more: the view says "showing N of M".
    public var isPartial: Bool {
        let page = filters.isServerFiltered ? filtered.value : snapshot.value
        return page.map { !$0.complete } ?? false
    }

    public var freshnessLine: String {
        snapshot.freshness.statement(subject: "wardrobe", now: environment.time.now(), timeZone: environment.timeZone)
    }

    // Filter menu contents come from the wardrobe itself.
    public var categories: [Category] {
        var seen = Set<Category>()
        return (snapshot.value?.items ?? []).map(\.garment.category).filter { seen.insert($0).inserted }.sorted { Phrases.category($0) < Phrases.category($1) }
    }
    public var colours: [String] { distinct(\.garment.colour) }
    public var seasons: [String] { distinct(\.garment.seasonNote) }

    private func distinct(_ keyPath: KeyPath<InventoryItem, String?>) -> [String] {
        Array(Set((snapshot.value?.items ?? []).compactMap { $0[keyPath: keyPath] }.filter { !$0.isEmpty })).sorted()
    }

    /// Items grouped by category for the grid's sections, in a stable order.
    public var sections: [(category: Category, items: [InventoryItem])] {
        let grouped = Dictionary(grouping: items, by: \.garment.category)
        return grouped.keys.sorted { Phrases.category($0) < Phrases.category($1) }.map { ($0, grouped[$0]!.sorted { $0.garment.name < $1.garment.name }) }
    }

    /// The tile's subtitle: status, and the quantity for entries with several identical units.
    public func subtitle(for item: InventoryItem) -> String {
        let status = Phrases.status(of: item.availability, acquisition: item.garment.acquisition)
        guard item.totalOwnedUnits > 1 else { return status }
        let clean = item.quantity(in: .clean)
        return "\(status) · \(clean) of \(item.totalOwnedUnits) clean"
    }

    public func accessibilityLabel(for item: InventoryItem) -> String {
        var parts = [item.garment.name, subtitle(for: item)]
        if let colour = item.garment.colour { parts.insert(colour, at: 1) }
        return parts.joined(separator: ", ")
    }
}

/// The temperature preview: what becomes wearable at a chosen temperature, including pieces in
/// seasonal storage. It is a simulation computed by the backend and changes nothing.
@MainActor
@Observable
public final class TemperaturePreviewModel {
    public let environment: AppEnvironment
    public let preview: Resource<TemperaturePreview>
    public var temperatureC: Double {
        didSet {
            guard temperatureC != oldValue else { return }
            let api = environment.api
            let t = temperatureC
            preview.retarget { try await api.temperaturePreview(temperatureC: t) }
        }
    }

    public init(environment: AppEnvironment, temperatureC: Double = 12) {
        self.environment = environment
        self.temperatureC = temperatureC
        let api = environment.api
        preview = environment.resource("wardrobe.temperature", cached: false) { try await api.temperaturePreview(temperatureC: temperatureC) }
    }

    public func load() async { await preview.refresh() }

    /// Always shown with the result so a simulation is never mistaken for availability.
    public var simulationLabel: String {
        preview.value?.label ?? "Simulation at \(Int(temperatureC.rounded())) °C. This does not change what is available."
    }
}
