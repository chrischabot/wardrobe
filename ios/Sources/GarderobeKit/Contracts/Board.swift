import Foundation

/// Contract `OutfitSlot`.
public struct OutfitSlot: Codable, Sendable, Hashable {
    public var garmentId: String
    public var role: GarmentRole
    /// Slots sharing an alternative group are mutually exclusive (e.g. two footwear options).
    public var alternativeGroup: String?

    public init(garmentId: String, role: GarmentRole, alternativeGroup: String? = nil) {
        self.garmentId = garmentId; self.role = role; self.alternativeGroup = alternativeGroup
    }
}

/// Contract `OutfitOption`. Durable identity is `optionId`; `position` is a convenience.
public struct OutfitOption: Codable, Sendable, Hashable, Identifiable {
    public var id: String { optionId }
    public var optionId: String
    public var boardId: String
    public var revision: Int
    public var position: Int
    public var slots: [OutfitSlot]
    public var explanation: String
    public var status: String
    public var validation: [String: JSONValue]

    public init(optionId: String, boardId: String, revision: Int, position: Int, slots: [OutfitSlot], explanation: String, status: String = "offerable", validation: [String: JSONValue] = [:]) {
        self.optionId = optionId; self.boardId = boardId; self.revision = revision; self.position = position
        self.slots = slots; self.explanation = explanation; self.status = status; self.validation = validation
    }

    enum CodingKeys: String, CodingKey { case optionId, boardId, revision, position, slots, explanation, status, validation }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        optionId = try c.decode(String.self, forKey: .optionId)
        boardId = try c.decode(String.self, forKey: .boardId)
        revision = c.value(.revision, default: 1)
        position = c.value(.position, default: 0)
        slots = try c.decode([OutfitSlot].self, forKey: .slots)
        explanation = c.value(.explanation, default: "")
        status = c.value(.status, default: "offerable")
        validation = c.value(.validation, default: [:])
    }

    public var isOfferable: Bool { status == "offerable" }
    public var footwearSlots: [OutfitSlot] { slots.filter { $0.role == .footwear } }
    /// True when the option offers more than one footwear alternative; a choice is then required.
    public var hasFootwearAlternatives: Bool {
        let f = footwearSlots
        return f.count > 1 && f.contains { $0.alternativeGroup != nil }
    }
}

public struct DayBrief: Codable, Sendable, Hashable {
    public var text: String?
    public var occasion: String?
    public var requestedCount: Int?
    public var wearingInterval: Interval?

    public struct Interval: Codable, Sendable, Hashable {
        public var start: String
        public var end: String
    }

    public init(text: String? = nil, occasion: String? = nil, requestedCount: Int? = nil, wearingInterval: Interval? = nil) {
        self.text = text; self.occasion = occasion; self.requestedCount = requestedCount; self.wearingInterval = wearingInterval
    }
}

/// Contract `Board`, with the optional `document` the daily service is adding (decoded tolerantly).
public struct Board: Codable, Sendable, Hashable {
    public var boardId: String
    public var boardDate: LocalDate
    public var timezone: String
    public var purpose: String
    public var currentRevision: Int
    public var brief: DayBrief
    public var status: String
    public var options: [OutfitOption]
    public var version: Int
    public var publishedAt: Date?
    /// Contract `BoardDocument` (daily service). Nil on boards written without it, or if it cannot be read.
    public var document: BoardDocument?

    public init(boardId: String, boardDate: LocalDate, timezone: String = "Europe/London", purpose: String = "day", currentRevision: Int, brief: DayBrief = DayBrief(), status: String = "published", options: [OutfitOption], version: Int = 1, publishedAt: Date? = nil, document: BoardDocument? = nil) {
        self.boardId = boardId; self.boardDate = boardDate; self.timezone = timezone; self.purpose = purpose; self.currentRevision = currentRevision
        self.brief = brief; self.status = status; self.options = options; self.version = version; self.publishedAt = publishedAt; self.document = document
    }

    enum CodingKeys: String, CodingKey { case boardId, boardDate, timezone, purpose, currentRevision, brief, status, options, version, publishedAt, document }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        boardId = try c.decode(String.self, forKey: .boardId)
        boardDate = try c.decode(LocalDate.self, forKey: .boardDate)
        timezone = c.value(.timezone, default: "Europe/London")
        purpose = c.value(.purpose, default: "day")
        currentRevision = c.value(.currentRevision, default: 1)
        brief = c.value(.brief, default: DayBrief())
        status = c.value(.status, default: "published")
        // One malformed option must not blank the whole board: decode options individually.
        let raw = c.value(.options, default: [JSONValue]())
        options = raw.compactMap { try? $0.decode(OutfitOption.self) }
        version = c.value(.version, default: 1)
        publishedAt = c.value(.publishedAt, default: nil)
        document = c.value(.document, default: nil)
    }
}

/// Contract `Selection`: an intention, never a wear.
public struct Selection: Codable, Sendable, Hashable {
    public var selectionId: String
    public var boardId: String
    public var optionId: String
    public var boardRevision: Int
    public var footwearGarmentId: String?
    public var selectedForDate: LocalDate
    public var status: String
    public var createdAt: Date
    public var version: Int
}

public struct SourceFreshness: Codable, Sendable, Hashable {
    public var source: String
    public var status: String
    public var observedAt: Date?
    public var revision: String?
}

/// Contract `TodayWeather` (nullable on Today; every figure may be null).
/// Contract `TodayWeather`: clothing weather for the day. Values the provider did not supply stay
/// nil and are shown as unknown, never guessed. `status` says whether the forecast is fresh.
public struct TodayWeather: Codable, Sendable, Hashable {
    public var locationLabel: String
    /// fresh | stale | missing | unavailable
    public var status: String
    public var observedAt: Date?
    /// Temperature at departure (answers the outerwear).
    public var morningTempC: Double?
    /// Peak of the wearing interval (answers shirts, trousers, socks).
    public var peakTempC: Double?
    /// Local HH:MM of the first likely rain, when any.
    public var rainStartsAt: String?
    /// Highest hourly precipitation probability, 0–1.
    public var precipitationProbability: Double?
    public var rainAmountMm: Double?
    public var windKph: Double?
    public var gustKph: Double?
    /// Brief native line, e.g. "12 °C leaving, 18 °C later; rain after 4".
    public var summary: String
    public var source: String

    public init(
        locationLabel: String, status: String = "fresh", observedAt: Date? = nil, morningTempC: Double?, peakTempC: Double?, rainStartsAt: String? = nil,
        precipitationProbability: Double? = nil, rainAmountMm: Double? = nil, windKph: Double? = nil, gustKph: Double? = nil, summary: String = "", source: String = ""
    ) {
        self.locationLabel = locationLabel; self.status = status; self.observedAt = observedAt; self.morningTempC = morningTempC; self.peakTempC = peakTempC
        self.rainStartsAt = rainStartsAt; self.precipitationProbability = precipitationProbability; self.rainAmountMm = rainAmountMm
        self.windKph = windKph; self.gustKph = gustKph; self.summary = summary; self.source = source
    }

    enum CodingKeys: String, CodingKey { case locationLabel, status, observedAt, morningTempC, peakTempC, rainStartsAt, precipitationProbability, rainAmountMm, windKph, gustKph, summary, source }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        locationLabel = c.value(.locationLabel, default: "")
        status = c.value(.status, default: "missing")
        observedAt = c.value(.observedAt, default: nil)
        morningTempC = c.value(.morningTempC, default: nil)
        peakTempC = c.value(.peakTempC, default: nil)
        rainStartsAt = c.value(.rainStartsAt, default: nil)
        precipitationProbability = c.value(.precipitationProbability, default: nil)
        rainAmountMm = c.value(.rainAmountMm, default: nil)
        windKph = c.value(.windKph, default: nil)
        gustKph = c.value(.gustKph, default: nil)
        summary = c.value(.summary, default: "")
        source = c.value(.source, default: "")
    }

    /// The contract's nullable fields are required keys: write explicit nulls.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(locationLabel, forKey: .locationLabel)
        try c.encode(status, forKey: .status)
        try c.encode(observedAt, forKey: .observedAt)
        try c.encode(morningTempC, forKey: .morningTempC)
        try c.encode(peakTempC, forKey: .peakTempC)
        try c.encode(rainStartsAt, forKey: .rainStartsAt)
        try c.encode(precipitationProbability, forKey: .precipitationProbability)
        try c.encode(rainAmountMm, forKey: .rainAmountMm)
        try c.encode(windKph, forKey: .windKph)
        try c.encode(gustKph, forKey: .gustKph)
        try c.encode(summary, forKey: .summary)
        try c.encode(source, forKey: .source)
    }

    /// A forecast that is not fresh must not read as current.
    public var isFresh: Bool { status == "fresh" }
    public var likelyRain: Bool { (precipitationProbability ?? 0) >= 0.3 || rainStartsAt != nil }
}

/// Contract `TodayResponse` (GET /v1/today), including the API's `dayLine`, `weather` and `garments`.
/// Contract `TodayTrip`: the packed trip covering Today's date.
public struct TodayTrip: Codable, Sendable, Hashable {
    public var tripId: String
    public var name: String
    public var timezone: String
    public var departsOn: LocalDate
    public var returnsOn: LocalDate
    public var destinations: [String]

    public init(tripId: String, name: String, timezone: String, departsOn: LocalDate, returnsOn: LocalDate, destinations: [String]) {
        self.tripId = tripId; self.name = name; self.timezone = timezone; self.departsOn = departsOn; self.returnsOn = returnsOn; self.destinations = destinations
    }

    /// Days away, counting both the departure and the return day; nil for impossible dates.
    public var length: Int? {
        let n = departsOn.days(until: returnsOn) + 1
        return n > 0 ? n : nil
    }

    /// 1 on the departure day; nil outside the trip.
    public func dayNumber(for date: LocalDate) -> Int? {
        guard date >= departsOn, date <= returnsOn else { return nil }
        return departsOn.days(until: date) + 1
    }
}

public struct TodayResponse: Codable, Sendable, Hashable {
    public var schemaVersion: String
    public var date: LocalDate
    public var timezone: String
    public var board: Board?
    public var selection: Selection?
    public var recordedWears: [DailyWear]
    public var sources: [SourceFreshness]
    public var shortfall: String?
    public var dayLine: String?
    public var weather: TodayWeather?
    public var garments: [Garment]
    /// 'day' (home) or 'trip:<tripId>' when the board is the trip-day board.
    public var purpose: String?
    /// The packed trip covering this date, when there is one.
    public var trip: TodayTrip?

    public init(schemaVersion: String = ContractsVersion.current, date: LocalDate, timezone: String = "Europe/London", board: Board?, selection: Selection? = nil, recordedWears: [DailyWear] = [], sources: [SourceFreshness] = [], shortfall: String? = nil, dayLine: String? = nil, weather: TodayWeather? = nil, garments: [Garment] = [], purpose: String? = nil, trip: TodayTrip? = nil) {
        self.schemaVersion = schemaVersion; self.date = date; self.timezone = timezone; self.board = board; self.selection = selection
        self.recordedWears = recordedWears; self.sources = sources; self.shortfall = shortfall; self.dayLine = dayLine; self.weather = weather; self.garments = garments
        self.purpose = purpose; self.trip = trip
    }

    enum CodingKeys: String, CodingKey { case schemaVersion, date, timezone, board, selection, recordedWears, sources, shortfall, dayLine, weather, garments, purpose, trip }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = c.value(.schemaVersion, default: ContractsVersion.current)
        date = try c.decode(LocalDate.self, forKey: .date)
        timezone = c.value(.timezone, default: "Europe/London")
        board = c.value(.board, default: nil)
        selection = c.value(.selection, default: nil)
        recordedWears = c.value(.recordedWears, default: [])
        sources = c.value(.sources, default: [])
        shortfall = c.value(.shortfall, default: nil)
        weather = c.value(.weather, default: nil)
        dayLine = c.value(.dayLine, default: nil)
        let raw = c.value(.garments, default: [JSONValue]())
        garments = raw.compactMap { try? $0.decode(Garment.self) }
        purpose = c.value(.purpose, default: nil)
        trip = c.value(.trip, default: nil)
        applyBoardDocument()
    }

    /// A trip-day board: Today's purpose, or the board's own, is `trip:<tripId>`.
    public var isTripDay: Bool {
        (purpose ?? board?.purpose ?? "day").hasPrefix("trip:")
    }

    /// "Trip day · Paris long weekend · day 2 of 4", or nil at home. Uses the trip summary when present
    /// and says only "Trip day" when the server sent the purpose without one.
    public var tripLine: String? {
        guard isTripDay else { return nil }
        guard let t = trip else { return "Trip day" }
        var parts = ["Trip day", t.name]
        if let d = t.dayNumber(for: date), let n = t.length { parts.append("day \(d) of \(n)") }
        return parts.joined(separator: " · ")
    }

    /// The API writes `dayLine`, `weather` and `garments` for every board; they are primary. The
    /// daily service's `BoardDocument` fills only what the response left out (older boards, caches).
    mutating func applyBoardDocument() {
        guard let doc = board?.document else { return }
        if (dayLine ?? "").isEmpty, !doc.dayLine.isEmpty { dayLine = doc.dayLine }
        if weather == nil, let w = doc.weather?.summary { weather = w }
        if shortfall == nil { shortfall = doc.shortfall }
        var known = Dictionary(garments.map { ($0.garmentId, $0) }, uniquingKeysWith: { a, _ in a })
        for option in doc.options {
            for g in option.garments where known[g.garmentId] == nil { known[g.garmentId] = g.asGarment }
        }
        garments = known.values.sorted { $0.garmentId < $1.garmentId }
    }

    /// The daily service's weather line ("12 °C leaving, 18 °C later; rain after 4"), when present.
    public var weatherLine: String? {
        if let s = weather?.summary, !s.isEmpty { return s }
        guard let line = board?.document?.weather?.line, !line.isEmpty else { return nil }
        return line
    }

    /// Calendar status from the board document (read, empty, unavailable, not_connected).
    public var calendarStatus: String? { board?.document?.calendar?.status }
}

/// Contract `SettingsResponse` (GET /v1/settings), with the API's additive fields.
public struct SettingsResponse: Codable, Sendable, Hashable {
    public var schemaVersion: String
    public var homeLocationLabel: String
    public var timezone: String
    public var deliveryTime: String
    public var dailyOptionCount: Int
    public var laundryRoutine: JSONValue
    public var version: Int
    /// Outfit calendar used for the morning projection; nil means no Calendar projection.
    public var calendarId: String?
    public var styleDocuments: [StyleDocumentSummary]
    /// Claude, ChatGPT and other consumer MCP grants, listed separately.
    public var connectedAssistants: [AssistantGrant]
    /// Health of Gmail, Calendar and owner-added connections (assistant grants excluded).
    public var connections: [Connection]
    public var models: Models?

    public struct Models: Codable, Sendable, Hashable {
        /// True when inference is the local deterministic stand-in, not AI Gateway.
        public var simulated: Bool
    }

    enum CodingKeys: String, CodingKey { case schemaVersion, homeLocationLabel, timezone, deliveryTime, dailyOptionCount, laundryRoutine, version, calendarId, styleDocuments, connectedAssistants, connections, models }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = c.value(.schemaVersion, default: ContractsVersion.current)
        homeLocationLabel = c.value(.homeLocationLabel, default: "")
        timezone = c.value(.timezone, default: "Europe/London")
        deliveryTime = c.value(.deliveryTime, default: "07:00")
        dailyOptionCount = c.value(.dailyOptionCount, default: 5)
        laundryRoutine = c.value(.laundryRoutine, default: JSONValue.null)
        version = c.value(.version, default: 1)
        calendarId = c.value(.calendarId, default: nil)
        styleDocuments = c.value(.styleDocuments, default: [])
        connectedAssistants = c.value(.connectedAssistants, default: [JSONValue]()).compactMap { try? $0.decode(AssistantGrant.self) }
        connections = c.value(.connections, default: [JSONValue]()).compactMap { try? $0.decode(Connection.self) }
        models = c.value(.models, default: nil)
    }
}

/// Contract `StyleDocument`.
public struct StyleDocument: Codable, Sendable, Hashable {
    public var documentId: String
    public var version: Int
    public var title: String
    public var body: String
    public var contentSha256: String
    public var byteLength: Int
    public var isDemo: Bool
    public var source: String
    public var authoredOn: LocalDate?
    public var importedAt: Date
    public var isCurrent: Bool
}

/// PROVISIONAL `GET /v1/style/current`.
/// Contract `StyleCurrentResponse` (GET /v1/style/current).
public struct StyleCurrentResponse: Codable, Sendable, Hashable {
    public var schemaVersion: String
    public var document: StyleDocument
    /// Every current document when the owner has more than one (the first is `document`).
    public var documents: [StyleDocument]
    public var rules: RuleCounts?

    public struct RuleCounts: Codable, Sendable, Hashable {
        public var active: Int
        public var hard: Int
        public var missingPassages: Int
    }

    enum CodingKeys: String, CodingKey { case schemaVersion, document, documents, rules }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = c.value(.schemaVersion, default: ContractsVersion.current)
        document = try c.decode(StyleDocument.self, forKey: .document)
        documents = c.value(.documents, default: [document])
        rules = c.value(.rules, default: nil)
    }
}

/// Contract `ApiError`.
public struct ApiError: Codable, Sendable, Hashable, Error {
    public var schemaVersion: String?
    public var error: Body

    public struct Body: Codable, Sendable, Hashable {
        public var code: String
        public var message: String
    }
}
