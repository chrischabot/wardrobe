import Foundation

/// Contract `Garment` (packages/contracts/src/garment.ts) plus the display `media` the API attaches
/// (optional `BoardGarment.media` on Today, `WardrobeItem.media` in the wardrobe).
public struct Garment: Codable, Sendable, Hashable, Identifiable {
    public var id: String { garmentId }
    public var garmentId: String
    public var name: String
    public var category: Category
    public var roles: [GarmentRole]
    public var maker: String?
    public var productName: String?
    public var productCode: String?
    public var fabric: String?
    public var color: String?
    public var colorFamily: String?
    public var pattern: String?
    public var sizeLabel: String?
    public var careChannel: String
    public var laundryPolicy: LaundryPolicy
    public var tracking: StockTracking
    public var acquisition: AcquisitionState
    public var disposalReason: String?
    public var planningPolicy: PlanningPolicy
    public var condition: String
    public var location: LocationKind
    public var locationDetail: String?
    public var attributes: [String: JSONValue]
    public var notes: String?
    public var wearLoggingSince: LocalDate?
    public var version: Int
    public var createdAt: Date?
    public var updatedAt: Date?
    /// Display media: `BoardGarment.media` on Today, `WardrobeItem.media` in the wardrobe (copied here).
    public var media: GarmentMedia?
    /// Contract `BoardGarment.aliases` (Today garments only): owner aliases and maker names.
    public var aliases: [String]?

    public init(
        garmentId: String, name: String, category: Category, roles: [GarmentRole], maker: String? = nil, productName: String? = nil,
        productCode: String? = nil, fabric: String? = nil, color: String? = nil, colorFamily: String? = nil, pattern: String? = nil,
        sizeLabel: String? = nil, careChannel: String = "service", laundryPolicy: LaundryPolicy = .perWear, tracking: StockTracking = .unit,
        acquisition: AcquisitionState = .owned, disposalReason: String? = nil, planningPolicy: PlanningPolicy = .normal, condition: String = "good",
        location: LocationKind = .home, locationDetail: String? = nil, attributes: [String: JSONValue] = [:], notes: String? = nil,
        wearLoggingSince: LocalDate? = nil, version: Int = 1, createdAt: Date? = nil, updatedAt: Date? = nil, media: GarmentMedia? = nil
    ) {
        self.garmentId = garmentId; self.name = name; self.category = category; self.roles = roles; self.maker = maker
        self.productName = productName; self.productCode = productCode; self.fabric = fabric; self.color = color
        self.colorFamily = colorFamily; self.pattern = pattern; self.sizeLabel = sizeLabel; self.careChannel = careChannel
        self.laundryPolicy = laundryPolicy; self.tracking = tracking; self.acquisition = acquisition; self.disposalReason = disposalReason
        self.planningPolicy = planningPolicy; self.condition = condition; self.location = location; self.locationDetail = locationDetail
        self.attributes = attributes; self.notes = notes; self.wearLoggingSince = wearLoggingSince; self.version = version
        self.createdAt = createdAt; self.updatedAt = updatedAt; self.media = media
    }

    enum CodingKeys: String, CodingKey {
        case garmentId, name, category, roles, maker, productName, productCode, fabric, color, colorFamily, pattern, sizeLabel
        case careChannel, laundryPolicy, tracking, acquisition, disposalReason, planningPolicy, condition, location, locationDetail
        case attributes, notes, wearLoggingSince, version, createdAt, updatedAt, media, aliases
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        garmentId = try c.decode(String.self, forKey: .garmentId)
        name = try c.decode(String.self, forKey: .name)
        category = c.value(.category, default: "accessory")
        roles = c.value(.roles, default: [])
        maker = c.value(.maker, default: nil)
        productName = c.value(.productName, default: nil)
        productCode = c.value(.productCode, default: nil)
        fabric = c.value(.fabric, default: nil)
        color = c.value(.color, default: nil)
        colorFamily = c.value(.colorFamily, default: nil)
        pattern = c.value(.pattern, default: nil)
        sizeLabel = c.value(.sizeLabel, default: nil)
        careChannel = c.value(.careChannel, default: "none")
        laundryPolicy = c.value(.laundryPolicy, default: .never)
        tracking = c.value(.tracking, default: .unit)
        acquisition = c.value(.acquisition, default: .owned)
        disposalReason = c.value(.disposalReason, default: nil)
        planningPolicy = c.value(.planningPolicy, default: .normal)
        condition = c.value(.condition, default: "unknown")
        location = c.value(.location, default: .unknown)
        locationDetail = c.value(.locationDetail, default: nil)
        attributes = c.value(.attributes, default: [:])
        notes = c.value(.notes, default: nil)
        wearLoggingSince = c.value(.wearLoggingSince, default: nil)
        version = c.value(.version, default: 1)
        createdAt = c.value(.createdAt, default: nil)
        updatedAt = c.value(.updatedAt, default: nil)
        media = c.value(.media, default: nil)
        aliases = c.value(.aliases, default: nil)
    }

    public func attribute(_ key: String) -> JSONValue? { attributes[key] }
    public var isAnonymousQuantity: Bool { tracking == .anonymousQuantity }
    public var minTempC: Double? { attributes["minTempC"]?.doubleValue }
    public var maxTempC: Double? { attributes["maxTempC"]?.doubleValue }
    public var seasonLabel: String? { attributes["seasonLabel"]?.stringValue }
}

/// Contract `GarmentMedia` (packages/contracts/src/visual.ts). URLs are short-lived and owner-scoped.
public struct GarmentMedia: Codable, Sendable, Hashable {
    public var thumbnailUrl: URL?
    public var catalogueImageUrl: URL?
    public var aspectRatio: Double?
    public var photos: [Photo]
    /// True when the catalogue asset is a verified photograph (or faithful rendition) of this exact garment.
    public var verified: Bool
    public var catalogueAssetId: String?
    public var assetClass: String?
    /// "Illustration", "Edited", "Demo placeholder", or nil for an exact photograph. Always shown.
    public var label: String?
    /// The garment is in Photos needed (the bounded search could not resolve it).
    public var photosNeeded: Bool
    public var urlsExpireAt: Date?

    public struct Photo: Codable, Sendable, Hashable {
        public var url: URL
        public var caption: String?
    }

    public init(thumbnailUrl: URL? = nil, catalogueImageUrl: URL? = nil, aspectRatio: Double? = nil, photos: [Photo] = [], verified: Bool = false, catalogueAssetId: String? = nil, assetClass: String? = nil, label: String? = nil, photosNeeded: Bool = false, urlsExpireAt: Date? = nil) {
        self.thumbnailUrl = thumbnailUrl; self.catalogueImageUrl = catalogueImageUrl; self.aspectRatio = aspectRatio; self.photos = photos; self.verified = verified
        self.catalogueAssetId = catalogueAssetId; self.assetClass = assetClass; self.label = label; self.photosNeeded = photosNeeded; self.urlsExpireAt = urlsExpireAt
    }

    enum CodingKeys: String, CodingKey { case thumbnailUrl, catalogueImageUrl, aspectRatio, photos, verified, catalogueAssetId, assetClass, label, photosNeeded, urlsExpireAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        thumbnailUrl = c.value(.thumbnailUrl, default: nil)
        catalogueImageUrl = c.value(.catalogueImageUrl, default: nil)
        aspectRatio = c.value(.aspectRatio, default: nil)
        photos = c.value(.photos, default: [])
        verified = c.value(.verified, default: false)
        catalogueAssetId = c.value(.catalogueAssetId, default: nil)
        assetClass = c.value(.assetClass, default: nil)
        label = c.value(.label, default: nil)
        photosNeeded = c.value(.photosNeeded, default: false)
        urlsExpireAt = c.value(.urlsExpireAt, default: nil)
    }

    /// Signed URLs expire; an expired set must be refetched rather than shown as broken images.
    public func urlsExpired(at now: Date) -> Bool { urlsExpireAt.map { $0 <= now } ?? false }

    /// Resolves relative media URLs (e.g. "/v1/media/{id}?t=…") against the API origin.
    public func resolved(against base: URL) -> GarmentMedia {
        func fix(_ u: URL?) -> URL? {
            guard let u else { return nil }
            return u.scheme == nil ? URL(string: u.absoluteString, relativeTo: base)?.absoluteURL : u
        }
        var m = self
        m.thumbnailUrl = fix(thumbnailUrl)
        m.catalogueImageUrl = fix(catalogueImageUrl)
        m.photos = photos.map { Photo(url: fix($0.url) ?? $0.url, caption: $0.caption) }
        return m
    }
}

public struct GarmentAlias: Codable, Sendable, Hashable {
    public var aliasId: String
    public var garmentId: String
    public var phrase: String
    public var kind: String
    public var source: String?
}

public struct StockBalance: Codable, Sendable, Hashable {
    public var garmentId: String
    public var buckets: [String: Int]
    public var totalOwned: Int
    public var version: Int

    public func units(_ bucket: String) -> Int { buckets[bucket] ?? 0 }
    public var clean: Int { units("clean") }
}

public struct AvailabilitySummary: Codable, Sendable, Hashable {
    public var label: String
    public var available: Bool
    public var reasons: [String]

    /// What the server's label means for the app. Labels are shown verbatim; this only drives icons,
    /// filters and which direct commands make sense. Unknown labels are `.other`, never an error.
    public enum State: String, Sendable, Hashable, CaseIterable {
        case available, inTheWash, atTheLaundry, wornNotWashed, noCleanUnit, packedForTrip, atTailor, inStorage, incoming, retired, other
    }

    public var state: State {
        switch label {
        case "In the wash": .inTheWash
        case "At the laundry": .atTheLaundry
        case "Worn, not washed yet": .wornNotWashed
        case "No clean unit": .noCleanUnit
        case "Packed for a trip": .packedForTrip
        case "At the tailor": .atTailor
        case "In storage": .inStorage
        case "Incoming": .incoming
        case "Retired", "Donated", "Gone": .retired
        default: available ? .available : .other
        }
    }

    /// Waiting on the wash in some form: in the hamper, away at the laundry, or worn and not yet washed.
    public var isWaitingForWash: Bool { [.inTheWash, .atTheLaundry, .wornNotWashed, .noCleanUnit].contains(state) }

    public var systemImage: String {
        switch state {
        case .available: "checkmark.circle"
        case .inTheWash: "washer"
        case .atTheLaundry: "bubbles.and.sparkles"
        case .wornNotWashed, .noCleanUnit: "tshirt"
        case .packedForTrip: "suitcase"
        case .atTailor: "scissors"
        case .inStorage: "archivebox"
        case .incoming: "shippingbox"
        case .retired: "xmark.circle"
        case .other: "minus.circle"
        }
    }
}

/// Contract `WardrobeItem`.
public struct WardrobeItem: Codable, Sendable, Hashable, Identifiable {
    public var id: String { garment.garmentId }
    public var garment: Garment
    public var aliases: [GarmentAlias]
    public var stock: StockBalance
    public var availability: AvailabilitySummary
    public var lastRecordedWear: LocalDate?
    public var recordedWearCount: Int
    /// Contract `WardrobeItem.media` (item level). Copied onto `garment.media` so every view reads one place.
    public var media: GarmentMedia?

    enum CodingKeys: String, CodingKey { case garment, aliases, stock, availability, lastRecordedWear, recordedWearCount, media }
    public init(garment: Garment, aliases: [GarmentAlias] = [], stock: StockBalance, availability: AvailabilitySummary, lastRecordedWear: LocalDate? = nil, recordedWearCount: Int = 0, media: GarmentMedia? = nil) {
        self.garment = garment; self.aliases = aliases; self.stock = stock; self.availability = availability
        self.lastRecordedWear = lastRecordedWear; self.recordedWearCount = recordedWearCount; self.media = media
        if self.garment.media == nil { self.garment.media = media }
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        garment = try c.decode(Garment.self, forKey: .garment)
        aliases = c.value(.aliases, default: [])
        stock = c.value(.stock, default: StockBalance(garmentId: garment.garmentId, buckets: [:], totalOwned: 0, version: 1))
        availability = c.value(.availability, default: AvailabilitySummary(label: "Unknown", available: false, reasons: []))
        lastRecordedWear = c.value(.lastRecordedWear, default: nil)
        recordedWearCount = c.value(.recordedWearCount, default: 0)
        media = c.value(.media, default: nil)
        if garment.media == nil { garment.media = media }
    }
}

public struct WardrobeCounts: Codable, Sendable, Hashable {
    public var owned: Int
    public var available: Int
    public var incoming: Int
    public var retired: Int
    public static let zero = WardrobeCounts(owned: 0, available: 0, incoming: 0, retired: 0)
}

/// Contract `WardrobePage` (GET /v1/wardrobe).
public struct WardrobePage: Codable, Sendable, Hashable {
    public var schemaVersion: String
    public var items: [WardrobeItem]
    public var total: Int
    public var complete: Bool
    public var nextCursor: String?
    public var counts: WardrobeCounts
    public var asOf: Date
}

public struct DailyWear: Codable, Sendable, Hashable {
    public var garmentId: String
    public var wearingDate: LocalDate
    public var timezone: String
    public var firstOccurredAt: Date
    public var observationCount: Int
    public var sources: [SourceChannel]
    public var segments: [String]
    public var status: String
    public var revision: Int
}

public struct Restriction: Codable, Sendable, Hashable {
    public var restrictionId: String
    public var kind: String
    public var scope: JSONValue
    public var reason: String
    public var startsAt: Date
    public var expectedEnd: LocalDate?
    public var requiredEvidence: String
    public var liftedAt: Date?
    public var liftEvidence: String?
    public var version: Int
}

public struct AvailabilityEstimate: Codable, Sendable, Hashable {
    public var estimatorVersion: String
    public var garmentId: String
    public var asOf: Date
    public var targetDate: LocalDate
    public var eligible: Bool
    public var exclusionReasons: [String]
    public var estimatedCleanUnits: Double
    public var expectedInferredWears: Double
    public var probabilityAvailable: Double
    public var likelyAvailable: Bool
    public var basis: [Basis]

    public struct Basis: Codable, Sendable, Hashable {
        public var kind: String
        public var detail: String
    }
}

/// Contract `ItemCombination`: a board option the item appears in (item page "known combinations").
public struct ItemCombination: Codable, Sendable, Hashable, Identifiable {
    public var id: String { optionId }
    public var boardId: String
    public var boardDate: LocalDate
    public var boardRevision: Int
    public var optionId: String
    public var position: Int
    public var why: String?
    public var garmentIds: [String]
}

/// Contract `ItemDetail` (GET /v1/items/{id}).
public struct ItemDetail: Codable, Sendable, Hashable {
    public var schemaVersion: String
    public var item: WardrobeItem
    public var restrictions: [Restriction]
    public var wearHistory: [DailyWear]
    public var estimate: AvailabilityEstimate?
    public var receipts: [CommandReceipt]
    /// Options on today's and later published boards that include this item.
    public var combinations: [ItemCombination]

    enum CodingKeys: String, CodingKey { case schemaVersion, item, restrictions, wearHistory, estimate, receipts, combinations }
    public init(schemaVersion: String = ContractsVersion.current, item: WardrobeItem, restrictions: [Restriction] = [], wearHistory: [DailyWear] = [], estimate: AvailabilityEstimate? = nil, receipts: [CommandReceipt] = [], combinations: [ItemCombination] = []) {
        self.schemaVersion = schemaVersion; self.item = item; self.restrictions = restrictions; self.wearHistory = wearHistory; self.estimate = estimate; self.receipts = receipts; self.combinations = combinations
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = c.value(.schemaVersion, default: ContractsVersion.current)
        item = try c.decode(WardrobeItem.self, forKey: .item)
        restrictions = c.value(.restrictions, default: [])
        wearHistory = c.value(.wearHistory, default: [])
        estimate = c.value(.estimate, default: nil)
        receipts = c.value(.receipts, default: [])
        combinations = c.value(.combinations, default: [])
    }
}

public enum ContractsVersion {
    /// CONTRACTS_VERSION in packages/contracts/src/version.ts that this client was built against.
    public static let current = "2026-10-01"
    public static let apiVersion = "v1"
}
