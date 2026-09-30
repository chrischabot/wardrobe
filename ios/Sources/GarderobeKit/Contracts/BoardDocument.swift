import Foundation

/// Contract `BoardDocument` (packages/contracts/src/board-document.ts, `board-document/1`): the
/// semantic outfit document of one board revision, written by the daily service. Today renders it
/// without extra lookups. Decoded tolerantly: every field has a safe default.
public struct BoardDocument: Codable, Sendable, Hashable {
    public var documentVersion: String
    public var boardDate: LocalDate?
    public var dayLine: String
    public var shapeOfDay: String?
    public var suitabilityNote: String?
    public var weather: BoardWeather?
    public var calendar: CalendarStatus?
    public var requestedCount: Int?
    public var options: [Option]
    public var shortfall: String?
    public var prose: String?
    public var text: String?

    public struct CalendarStatus: Codable, Sendable, Hashable {
        public var status: String
        public var fetchedAt: Date?
        public var occasion: String?
        public var relevantEventTitle: String?
        public var suitableCount: Int?
    }

    public struct Line: Codable, Sendable, Hashable {
        public var kind: String
        /// The heading as the backend published it (already cleared of item codes). Nil only when absent.
        public var label: String?
        public var text: String
        public var garmentIds: [String]
        public var flourish: Flourish?
        public struct Flourish: Codable, Sendable, Hashable {
            public var garmentId: String
            public var kind: String
            public var text: String
        }

        enum CodingKeys: String, CodingKey { case kind, label, text, garmentIds, flourish }
        public init(kind: String, label: String?, text: String, garmentIds: [String], flourish: Flourish? = nil) {
            self.kind = kind; self.label = label; self.text = text; self.garmentIds = garmentIds; self.flourish = flourish
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            kind = try c.decode(String.self, forKey: .kind)
            // A line without a label keeps its garments and text; the app supplies a heading.
            label = c.value(.label, default: String?.none).flatMap { $0.isEmpty ? nil : $0 }
            text = c.value(.text, default: "")
            garmentIds = c.value(.garmentIds, default: [])
            flourish = c.value(.flourish, default: nil)
        }
    }

    public struct GarmentDisplay: Codable, Sendable, Hashable {
        public var garmentId: String
        public var name: String
        public var role: GarmentRole
        public var category: String
        public var colour: String?
        public var colorFamily: String?
        public var aliases: [String]
        public var images: [Image]
        public var optional: Bool
        public var alternativeGroup: String?
        public struct Image: Codable, Sendable, Hashable {
            public var assetId: String
            public var kind: String
            public var role: String
            public var verified: Bool
        }

        enum CodingKeys: String, CodingKey { case garmentId, name, role, category, colour, colorFamily, aliases, images, optional, alternativeGroup }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            garmentId = try c.decode(String.self, forKey: .garmentId)
            name = try c.decode(String.self, forKey: .name)
            role = c.value(.role, default: .accessory)
            category = c.value(.category, default: "accessory")
            colour = c.value(.colour, default: nil)
            colorFamily = c.value(.colorFamily, default: nil)
            aliases = c.value(.aliases, default: [])
            images = c.value(.images, default: [])
            optional = c.value(.optional, default: false)
            alternativeGroup = c.value(.alternativeGroup, default: nil)
        }

        /// Display data as a Garment for layout (the board needs no wardrobe lookup). Image URLs come from
        /// Today's `garments[].media`, which take precedence; from the document only the verified flag carries over.
        public var asGarment: Garment {
            Garment(
                garmentId: garmentId, name: name, category: Category(rawValue: category), roles: [role], color: colour, colorFamily: colorFamily,
                media: images.isEmpty ? nil : GarmentMedia(verified: images.contains { $0.verified })
            )
        }
    }

    public struct Option: Codable, Sendable, Hashable {
        public var optionId: String
        public var position: Int
        public var status: String
        public var register: String?
        /// Opening sentence: why it works and what makes it interesting.
        public var why: String
        public var lines: [Line]
        public var garments: [GarmentDisplay]
        public var footwear: [Footwear]
        /// Present only when uncertainty materially affects the choice.
        public var qualification: String?
        public struct Footwear: Codable, Sendable, Hashable {
            public var garmentId: String
            public var kind: String
        }

        enum CodingKeys: String, CodingKey { case optionId, position, status, register, why, lines, garments, footwear, qualification }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            optionId = try c.decode(String.self, forKey: .optionId)
            position = c.value(.position, default: 0)
            status = c.value(.status, default: "offerable")
            register = c.value(.register, default: nil)
            why = c.value(.why, default: "")
            lines = c.value(.lines, default: [JSONValue]()).compactMap { try? $0.decode(Line.self) }
            garments = c.value(.garments, default: [JSONValue]()).compactMap { try? $0.decode(GarmentDisplay.self) }
            footwear = c.value(.footwear, default: [])
            qualification = c.value(.qualification, default: nil)
        }
    }

    enum CodingKeys: String, CodingKey { case documentVersion, boardDate, dayLine, shapeOfDay, suitabilityNote, weather, calendar, requestedCount, options, shortfall, prose, text }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        documentVersion = c.value(.documentVersion, default: "unknown")
        boardDate = c.value(.boardDate, default: nil)
        dayLine = c.value(.dayLine, default: "")
        shapeOfDay = c.value(.shapeOfDay, default: nil)
        suitabilityNote = c.value(.suitabilityNote, default: nil)
        weather = c.value(.weather, default: nil)
        calendar = c.value(.calendar, default: nil)
        requestedCount = c.value(.requestedCount, default: nil)
        options = c.value(.options, default: [JSONValue]()).compactMap { try? $0.decode(Option.self) }
        shortfall = c.value(.shortfall, default: nil)
        prose = c.value(.prose, default: nil)
        text = c.value(.text, default: nil)
    }

    public func option(_ optionId: String) -> Option? { options.first { $0.optionId == optionId } }
}

/// Contract `BoardWeather`: clothing-relevant weather for the wearing interval. Missing values stay nil.
public struct BoardWeather: Codable, Sendable, Hashable {
    public var provider: String?
    public var locationLabel: String
    public var status: String
    public var fetchedAt: Date?
    public var departureTime: String?
    /// Temperature at departure: the basis for outerwear.
    public var departureTempC: Double?
    /// Maximum across the wearing interval: the basis for shirts and trousers.
    public var peakTempC: Double?
    /// 0–100.
    public var rainProbabilityMax: Double?
    public var rainAmountMm: Double?
    public var rainStartsAt: String?
    public var windSpeedMaxKmh: Double?
    public var windGustMaxKmh: Double?
    public var conditions: [String]
    /// Brief native line, e.g. "12 °C leaving, 18 °C later; rain after 4".
    public var line: String

    enum CodingKeys: String, CodingKey { case provider, locationLabel, status, fetchedAt, departureTime, departureTempC, peakTempC, rainProbabilityMax, rainAmountMm, rainStartsAt, windSpeedMaxKmh, windGustMaxKmh, conditions, line }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = c.value(.provider, default: nil)
        locationLabel = c.value(.locationLabel, default: "")
        status = c.value(.status, default: "missing")
        fetchedAt = c.value(.fetchedAt, default: nil)
        departureTime = c.value(.departureTime, default: nil)
        departureTempC = c.value(.departureTempC, default: nil)
        peakTempC = c.value(.peakTempC, default: nil)
        rainProbabilityMax = c.value(.rainProbabilityMax, default: nil)
        rainAmountMm = c.value(.rainAmountMm, default: nil)
        rainStartsAt = c.value(.rainStartsAt, default: nil)
        windSpeedMaxKmh = c.value(.windSpeedMaxKmh, default: nil)
        windGustMaxKmh = c.value(.windGustMaxKmh, default: nil)
        conditions = c.value(.conditions, default: [])
        line = c.value(.line, default: "")
    }

    /// The display summary Today uses when the response carries no `weather`. Missing values stay nil.
    public var summary: TodayWeather? {
        guard peakTempC != nil || departureTempC != nil || !line.isEmpty else { return nil }
        return TodayWeather(
            locationLabel: locationLabel, status: status, observedAt: fetchedAt, morningTempC: departureTempC, peakTempC: peakTempC,
            rainStartsAt: rainStartsAt, precipitationProbability: rainProbabilityMax.map { $0 / 100 }, rainAmountMm: rainAmountMm,
            windKph: windSpeedMaxKmh, gustKph: windGustMaxKmh, summary: line, source: provider ?? ""
        )
    }
}
