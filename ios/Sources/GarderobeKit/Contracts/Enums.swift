import Foundation

// Vocabulary from packages/contracts/src/enums.ts. Open enums: unknown values keep their raw string.

public struct Category: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let shirt: Category = "shirt", tshirt: Category = "tshirt", polo: Category = "polo"
    public static let knitwear: Category = "knitwear", sweatshirt: Category = "sweatshirt"
    public static let trousers: Category = "trousers", jeans: Category = "jeans", shorts: Category = "shorts"
    public static let blazer: Category = "blazer", jacket: Category = "jacket", coat: Category = "coat", overshirt: Category = "overshirt"
    public static let shoes: Category = "shoes", sneakers: Category = "sneakers", boots: Category = "boots"
    public static let socks: Category = "socks", underwear: Category = "underwear", belt: Category = "belt"
    public static let scarf: Category = "scarf", hat: Category = "hat", gloves: Category = "gloves", bag: Category = "bag"
    public static let tie: Category = "tie", accessory: Category = "accessory", indoor: Category = "indoor"

    /// Plural label for filters and counts.
    public var displayName: String {
        switch rawValue {
        case "tshirt": "T-shirts"
        case "knitwear": "Knitwear"
        case "trousers": "Trousers"
        case "jeans": "Jeans"
        case "shorts": "Shorts"
        case "socks": "Socks"
        case "underwear": "Underwear"
        case "gloves": "Gloves"
        case "shoes": "Shoes"
        case "sneakers": "Sneakers"
        case "boots": "Boots"
        case "accessory": "Accessories"
        case "indoor": "Indoor"
        default: rawValue.prefix(1).uppercased() + rawValue.dropFirst() + "s"
        }
    }
}

public struct GarmentRole: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let baseTop: GarmentRole = "base_top", midLayer: GarmentRole = "mid_layer", outerLayer: GarmentRole = "outer_layer"
    public static let bottom: GarmentRole = "bottom", onePiece: GarmentRole = "one_piece", footwear: GarmentRole = "footwear"
    public static let socks: GarmentRole = "socks", belt: GarmentRole = "belt", accessory: GarmentRole = "accessory"
    public static let underwear: GarmentRole = "underwear", indoor: GarmentRole = "indoor"
}

public struct AcquisitionState: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let incoming: AcquisitionState = "incoming", owned: AcquisitionState = "owned", disposed: AcquisitionState = "disposed"
}

public struct PlanningPolicy: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let normal: PlanningPolicy = "normal", occasional: PlanningPolicy = "occasional", excluded: PlanningPolicy = "excluded"
}

public struct LocationKind: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let home: LocationKind = "home", storage: LocationKind = "storage", tailor: LocationKind = "tailor"
    public static let repair: LocationKind = "repair", trip: LocationKind = "trip", consignment: LocationKind = "consignment"
    public static let inTransit: LocationKind = "in_transit", unknown: LocationKind = "unknown"

    public var displayName: String {
        switch rawValue {
        case "home": "At home"
        case "storage": "In storage"
        case "tailor": "At the tailor"
        case "repair": "At repair"
        case "trip": "Packed for a trip"
        case "consignment": "On consignment"
        case "in_transit": "In transit"
        default: "Unknown location"
        }
    }
}

public struct LaundryPolicy: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let perWear: LaundryPolicy = "per_wear", singleWearDay: LaundryPolicy = "single_wear_day"
    public static let multiWear: LaundryPolicy = "multi_wear", never: LaundryPolicy = "never"
}

public struct StockTracking: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let unit: StockTracking = "unit", anonymousQuantity: StockTracking = "anonymous_quantity"
}

public struct SourceChannel: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let app: SourceChannel = "app", offlineReplay: SourceChannel = "offline_replay", mcp: SourceChannel = "mcp"
    public static let conversation: SourceChannel = "conversation", calendar: SourceChannel = "calendar", system: SourceChannel = "system"
}
