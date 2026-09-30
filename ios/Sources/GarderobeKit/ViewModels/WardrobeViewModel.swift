import Foundation
import Observation

public struct WardrobeFilter: Codable, Sendable, Hashable {
    public enum Availability: String, Codable, Sendable, CaseIterable { case any, available, unavailable, waitingForWash, packed, incoming, retired }
    public enum LastWorn: String, Codable, Sendable, CaseIterable { case any, thisWeek, notThisMonth, noRecordedWear }

    public var category: Category?
    public var availability: Availability = .any
    public var colorFamily: String?
    public var season: String?
    public var location: LocationKind?
    public var lastWorn: LastWorn = .any

    public init() {}
    public var isActive: Bool { self != WardrobeFilter() }
}

extension WardrobeFilter.Availability {
    public var label: String {
        switch self {
        case .any: "Everything owned"
        case .available: "Available"
        case .unavailable: "Not available now"
        case .waitingForWash: "In the wash or worn"
        case .packed: "Packed for a trip"
        case .incoming: "Incoming"
        case .retired: "Retired"
        }
    }
}

extension WardrobeFilter.LastWorn {
    /// A zero wear count means unlogged, never unworn (owner profile, section 11).
    public var label: String {
        switch self {
        case .any: "Any time"
        case .thisWeek: "Recorded in the last 7 days"
        case .notThisMonth: "Not recorded in 30 days"
        case .noRecordedWear: "No recorded wear"
        }
    }
}

@MainActor
@Observable
public final class WardrobeViewModel {
    public enum Layout: Equatable, Sendable { case grid, list }

    public private(set) var page: WardrobePage?
    public private(set) var isRefreshing = false
    public private(set) var lastError: APIError?
    public var query = ""
    public var filter = WardrobeFilter()
    public var previewTemperature: Double = 15
    public private(set) var preview: TemperaturePreview?
    public private(set) var previewError: String?

    @ObservationIgnored private let env: AppEnvironment

    public init(env: AppEnvironment) {
        self.env = env
        page = env.store.load(WardrobePage.self, StoreKey.wardrobe)
    }

    /// The grid becomes a readable list at accessibility text sizes (spec section 3).
    public static func layout(isAccessibilitySize: Bool) -> Layout { isAccessibilitySize ? .list : .grid }

    public func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let p = try await env.api.completeWardrobe()
            page = p
            env.store.save(p, StoreKey.wardrobe)
            lastError = nil
        } catch let e as APIError {
            lastError = e
        } catch {
            lastError = .interrupted(String(describing: error))
        }
    }

    public var allItems: [WardrobeItem] { page?.items ?? [] }
    public var counts: WardrobeCounts { page?.counts ?? .zero }
    public var isComplete: Bool { page?.complete ?? false }

    public func item(_ id: String) -> WardrobeItem? { allItems.first { $0.garment.garmentId == id } }

    public func garmentLookup() -> [String: Garment] {
        Dictionary(allItems.map { ($0.garment.garmentId, $0.garment) }, uniquingKeysWith: { a, _ in a })
    }

    /// Filtered, alias-searched items. Retired pieces appear only when asked for.
    public var items: [WardrobeItem] {
        let today = LocalDate(date: env.now(), timeZone: env.timeZone)
        let filtered = allItems.filter { i in
            let g = i.garment
            switch filter.availability {
            case .any: if g.acquisition == .disposed { return false }
            case .available: if !i.availability.available { return false }
            case .unavailable: if i.availability.available || g.acquisition != .owned { return false }
            case .waitingForWash: if !i.availability.isWaitingForWash { return false }
            case .packed: if i.availability.state != .packedForTrip { return false }
            case .incoming: if g.acquisition != .incoming { return false }
            case .retired: if g.acquisition != .disposed { return false }
            }
            if let c = filter.category, g.category != c { return false }
            if let c = filter.colorFamily, g.colorFamily != c { return false }
            if let s = filter.season, Self.season(of: g) != s { return false }
            if let l = filter.location, g.location != l { return false }
            switch filter.lastWorn {
            case .any: break
            case .thisWeek: guard let d = i.lastRecordedWear, d.days(until: today) <= 7 else { return false }
            case .notThisMonth: if let d = i.lastRecordedWear, d.days(until: today) <= 30 { return false }
            case .noRecordedWear: if i.lastRecordedWear != nil { return false }
            }
            return true
        }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return q.isEmpty ? filtered.sorted { ($0.garment.category.rawValue, $0.garment.name) < ($1.garment.category.rawValue, $1.garment.name) } : GarmentSearch.rank(filtered, query: q)
    }

    /// Items grouped by category for the grid/list sections.
    public var sections: [(category: Category, items: [WardrobeItem])] {
        let groups = Dictionary(grouping: items, by: \.garment.category)
        let order: [Category] = [.jacket, .coat, .blazer, .overshirt, .knitwear, .sweatshirt, .shirt, .polo, .tshirt, .trousers, .jeans, .shorts, .belt, .scarf, .tie, .accessory, .socks, .sneakers, .shoes, .boots]
        let rank = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($1, $0) })
        return groups.keys.sorted { (rank[$0] ?? 99, $0.rawValue) < (rank[$1] ?? 99, $1.rawValue) }.map { ($0, groups[$0]!) }
    }

    /// Season is read from the imported season label (unknown stays unknown).
    public static func season(of g: Garment) -> String? {
        guard let label = g.seasonLabel?.lowercased() else { return nil }
        if label.contains("all") || label.contains("year") { return "All year" }
        if label.contains("winter") || label.contains("cold") { return "Cold" }
        if label.contains("warm") || label.contains("summer") { return "Warm" }
        if label.contains("cool") { return "Cool" }
        return "Mild"
    }

    public struct Facets: Sendable, Equatable {
        public var categories: [Category]
        public var colors: [String]
        public var seasons: [String]
        public var locations: [LocationKind]
    }

    public var facets: Facets {
        let owned = allItems.filter { $0.garment.acquisition != .disposed }
        return Facets(
            categories: Array(Set(owned.map(\.garment.category))).sorted { $0.rawValue < $1.rawValue },
            colors: Array(Set(owned.compactMap(\.garment.colorFamily))).sorted(),
            seasons: Array(Set(owned.compactMap { Self.season(of: $0.garment) })).sorted(),
            locations: Array(Set(owned.map(\.garment.location))).sorted { $0.rawValue < $1.rawValue }
        )
    }

    /// What becomes wearable at a chosen temperature, including seasonal storage. A simulation only.
    public func loadPreview() async {
        do {
            preview = try await env.api.temperaturePreview(previewTemperature)
            previewError = nil
        } catch {
            preview = nil
            previewError = "The preview needs a connection."
        }
    }
}

/// The item page: catalogue image, facts, status, history, receipts and direct commands.
@MainActor
@Observable
public final class ItemDetailViewModel {
    public enum DirectCommand: String, CaseIterable, Sendable, Identifiable {
        case inTheWash, backFromTailor, arrived, putIntoStorage, takeOutOfStorage
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .inTheWash: "In the wash"
            case .backFromTailor: "Back from the tailor"
            case .arrived: "Arrived"
            case .putIntoStorage: "Put into storage"
            case .takeOutOfStorage: "Take out of storage"
            }
        }
        public var systemImage: String {
            switch self {
            case .inTheWash: "washer"
            case .backFromTailor: "scissors"
            case .arrived: "shippingbox"
            case .putIntoStorage: "archivebox"
            case .takeOutOfStorage: "archivebox.fill"
            }
        }
    }

    public let garmentId: String
    public private(set) var detail: ItemDetail?
    public private(set) var isLoading = false
    public private(set) var lastError: APIError?

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let queue: CommandQueue
    @ObservationIgnored private let receiptCenter: ReceiptCenter
    @ObservationIgnored private let wardrobe: WardrobeViewModel

    public init(garmentId: String, env: AppEnvironment, queue: CommandQueue, receipts: ReceiptCenter, wardrobe: WardrobeViewModel) {
        self.garmentId = garmentId; self.env = env; self.queue = queue; self.receiptCenter = receipts; self.wardrobe = wardrobe
        detail = env.store.load(ItemDetail.self, StoreKey.itemPrefix + garmentId)
    }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let d = try await env.api.item(garmentId)
            detail = d
            env.store.save(d, StoreKey.itemPrefix + garmentId)
            lastError = nil
        } catch let e as APIError {
            lastError = e
        } catch {
            lastError = .interrupted(String(describing: error))
        }
    }

    public var item: WardrobeItem? { detail?.item ?? wardrobe.item(garmentId) }

    /// A sentence under the status for the new laundry and trip states, pointing to where they change.
    public var availabilityNote: String? {
        guard let a = item?.availability else { return nil }
        switch a.state {
        case .inTheWash: return "In the hamper. Collection and return are recorded in Laundry."
        case .atTheLaundry: return "Away with the laundry service. Record its return in Laundry."
        case .wornNotWashed: return "Worn since it was last washed; it comes back once it goes through the wash."
        case .packedForTrip: return "In the suitcase, so not at home. Unpacking returns it; unpacking is not washing."
        default: return nil
        }
    }

    /// Laundry states offer a shortcut to the Laundry sheet.
    public var offersLaundry: Bool { item?.availability.isWaitingForWash ?? false }

    public var directCommands: [DirectCommand] {
        guard let i = item else { return [] }
        let g = i.garment
        var out: [DirectCommand] = []
        let launderable = g.laundryPolicy == .perWear || g.laundryPolicy == .singleWearDay
        let state = i.availability.state
        // Already in the wash, at the laundry or in a suitcase: "In the wash" and storage would contradict the server.
        let awayOrWashing = state == .inTheWash || state == .atTheLaundry || state == .packedForTrip
        if g.acquisition == .owned && launderable && g.location == .home && !awayOrWashing && (i.stock.clean + i.stock.units("worn")) > 0 { out.append(.inTheWash) }
        if g.location == .tailor { out.append(.backFromTailor) }
        if g.acquisition == .incoming { out.append(.arrived) }
        if g.acquisition == .owned && g.location == .home && state != .packedForTrip && i.stock.clean > 0 { out.append(.putIntoStorage) }
        if g.location == .storage { out.append(.takeOutOfStorage) }
        return out
    }

    public func perform(_ command: DirectCommand) async -> ActionResult {
        guard let g = item?.garment, directCommands.contains(command) else { return .refused("Not possible for this item right now") }
        let c: DomainCommand = switch command {
        case .inTheWash: .markInWash(garmentId: g.garmentId, occurredAt: env.now())
        case .backFromTailor: .backFromTailor(garmentId: g.garmentId, occurredAt: env.now())
        case .arrived: .markArrived(garmentId: g.garmentId, occurredAt: env.now())
        case .putIntoStorage: .putIntoStorage(garmentId: g.garmentId, occurredAt: env.now())
        case .takeOutOfStorage: .takeOutOfStorage(garmentId: g.garmentId, occurredAt: env.now())
        }
        let result = ActionResult(await queue.submit(c, label: "\(command.title): \(g.name)", context: .init(garmentIds: [g.garmentId])))
        if case .done = result {
            await wardrobe.refresh()
            await load()
        }
        return result
    }

    /// Optional direct correction of a count ("I have twelve pairs", "five are clean").
    public func reconcile(clean: Int?, totalOwned: Int?) async -> ActionResult {
        guard let g = item?.garment, clean != nil || totalOwned != nil else { return .refused("Nothing to correct") }
        guard [clean, totalOwned].compactMap({ $0 }).allSatisfy({ (0...500).contains($0) }) else { return .refused("Counts run from 0 to 500") }
        if let clean, let totalOwned, clean > totalOwned { return .refused("More clean than owned") }
        let result = ActionResult(await queue.submit(.reconcileQuantity(garmentId: g.garmentId, clean: clean, totalOwned: totalOwned, occurredAt: env.now()), label: "Corrected count: \(g.name)", context: .init(garmentIds: [g.garmentId])))
        if case .done = result { await wardrobe.refresh(); await load() }
        return result
    }

    /// Receipts for this garment from the server page and this phone, newest first, de-duplicated.
    public var receipts: [CommandReceipt] {
        var seen = Set<String>()
        return (receiptCenter.receipts(forGarment: garmentId) + (detail?.receipts ?? []))
            .filter { seen.insert($0.commandId).inserted }
            .sorted { $0.recordedAt > $1.recordedAt }
    }

    public struct FactRow: Sendable, Hashable, Identifiable {
        public var id: String { label }
        public var label: String
        public var value: String
    }

    /// Manufacturer terminology belongs here, where it helps identify or research a piece.
    public struct KnownCombination: Sendable, Hashable, Identifiable {
        public var id: String { optionId }
        public var optionId: String
        public var boardDate: LocalDate
        public var position: Int
        public var why: String?
        /// The other pieces, by perceptible name.
        public var otherPieces: [String]
    }

    /// Item page "known combinations": published board options that include this item
    /// (`ItemDetail.combinations`, today's and later boards), newest board first.
    public var knownCombinations: [KnownCombination] {
        let names = wardrobe.garmentLookup()
        return (detail?.combinations ?? [])
            .sorted { ($0.boardDate, -$0.position) > ($1.boardDate, -$1.position) }
            .map { c in
                KnownCombination(
                    optionId: c.optionId, boardDate: c.boardDate, position: c.position, why: c.why,
                    otherPieces: c.garmentIds.filter { $0 != garmentId }.map { names[$0]?.name ?? "Unknown item" }
                )
            }
    }

    public var facts: [FactRow] {
        guard let i = item else { return [] }
        let g = i.garment
        var rows: [FactRow] = []
        func add(_ l: String, _ v: String?) { if let v, !v.isEmpty { rows.append(FactRow(label: l, value: v)) } }
        // Owner-asserted pieces (2026-09-29) were described only from the profile: say what is not known yet.
        let ownerAsserted = g.attributes["ownerAsserted"]?.boolValue == true
        func addOrUnknown(_ l: String, _ v: String?) { if let v, !v.isEmpty { rows.append(FactRow(label: l, value: v)) } else if ownerAsserted { rows.append(FactRow(label: l, value: "Unknown")) } }
        add("Status", i.availability.label + (i.availability.reasons.isEmpty ? "" : " — " + i.availability.reasons.joined(separator: "; ")))
        add("Where", g.location.displayName + (g.locationDetail.map { " (\($0))" } ?? ""))
        add("Quantity", QuantityText.text(for: i))
        addOrUnknown("Maker", g.maker)
        add("Maker's name", g.productName)
        add("Code", g.productCode)
        addOrUnknown("Colour", g.color)
        add("Pattern", g.pattern)
        add("Fabric", g.fabric)
        addOrUnknown("Size", g.sizeLabel)
        add("Season", g.seasonLabel)
        add("Care", Self.care(g))
        add("Fit note", g.attributes["fitNote"]?.stringValue)
        add("Notes", g.notes)
        if let since = g.wearLoggingSince {
            add("Wear history", "Recorded since \(since.rawValue). Earlier wears were not logged, so a low count means unlogged, not unworn.")
        }
        return rows
    }

    static func care(_ g: Garment) -> String? {
        switch g.careChannel {
        case "service": "Laundry service"
        case "hand_wash": "Hand wash"
        case "dry_clean": "Dry clean"
        case "none": nil
        default: g.careChannel
        }
    }
}
