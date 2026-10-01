import Foundation

/// The one JSON configuration used for every request, cache file and queue entry. Keys are
/// emitted in sorted order so an encoded command is byte-stable: a command retried from the
/// offline queue is the same body, which is what the backend's idempotency check requires.
public enum GarderobeJSON {
    public static func encoder(pretty: Bool = false) -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = pretty ? [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        return e
    }
    public static func decoder() -> JSONDecoder { JSONDecoder() }

    public static func encode<T: Encodable>(_ value: T) throws -> Data { try encoder().encode(value) }
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T { try decoder().decode(type, from: data) }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral, ExpressibleByFloatLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .integer(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(elements, uniquingKeysWith: { _, b in b })) }
    public init(nilLiteral: ()) { self = .null }
}

extension JSONValue {
    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var intValue: Int? {
        switch self {
        case .integer(let i): return i
        case .number(let d) where d.rounded() == d: return Int(d)
        default: return nil
        }
    }
    public var doubleValue: Double? {
        switch self {
        case .integer(let i): return Double(i)
        case .number(let d): return d
        default: return nil
        }
    }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }
    public subscript(key: String) -> JSONValue? { objectValue?[key] }

    /// Decodes this value as a typed contract value.
    public func decoded<T: Decodable>(as type: T.Type) throws -> T {
        try GarderobeJSON.decode(type, from: try GarderobeJSON.encode(self))
    }

    /// Any encodable contract value as a `JSONValue`.
    public static func from<T: Encodable>(_ value: T) throws -> JSONValue {
        try GarderobeJSON.decode(JSONValue.self, from: try GarderobeJSON.encode(value))
    }
}

/// The source of "now". Injected everywhere so tests control time and nothing reads the wall
/// clock implicitly.
public protocol TimeSource: Sendable {
    func now() -> Date
}

public struct SystemTimeSource: TimeSource {
    public init() {}
    public func now() -> Date { Date() }
}

/// A manually advanced time source for tests and previews.
public final class ManualTimeSource: TimeSource, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    public init(_ start: Date) { current = start }
    public convenience init(instant: String) { self.init(Dates.parseInstant(instant) ?? Date(timeIntervalSince1970: 0)) }
    public func now() -> Date { lock.lock(); defer { lock.unlock() }; return current }
    public func set(_ date: Date) { lock.lock(); current = date; lock.unlock() }
    public func advance(_ seconds: TimeInterval) { lock.lock(); current = current.addingTimeInterval(seconds); lock.unlock() }
}

/// Conversions between `Date` and the contract's `Instant` (UTC ISO 8601 with `Z`) and
/// `LocalDate` (civil `YYYY-MM-DD`) strings. A `LocalDate` is never a point in time.
public enum Dates {
    static let utc = TimeZone(identifier: "UTC")!

    static func calendar(_ timeZone: TimeZone) -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return cal
    }

    /// `2026-09-15T06:50:00Z` (whole seconds, the form the contract's `Instant` accepts).
    public static func instant(_ date: Date) -> Instant {
        let c = calendar(utc).dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02dZ", c.year ?? 1970, c.month ?? 1, c.day ?? 1, c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
    }

    public static func parseInstant(_ s: Instant) -> Date? {
        let u = Array(s.utf8)
        guard u.count >= 20, u.last == 90, u[10] == 84 else { return nil }
        func n(_ from: Int, _ len: Int) -> Int? {
            var v = 0
            for i in from..<(from + len) { guard u[i] >= 48, u[i] <= 57 else { return nil }; v = v * 10 + Int(u[i] - 48) }
            return v
        }
        guard let y = n(0, 4), let mo = n(5, 2), let d = n(8, 2), let h = n(11, 2), let mi = n(14, 2), let sec = n(17, 2) else { return nil }
        var fraction = 0.0
        if u.count > 20 {
            guard u[19] == 46 else { return nil }
            let digits = u.count - 21
            guard digits >= 1, digits <= 3, let frac = n(20, digits) else { return nil }
            fraction = Double(frac) / pow(10, Double(digits))
        }
        guard let base = calendar(utc).date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi, second: sec)) else { return nil }
        return base.addingTimeInterval(fraction)
    }

    public static func isLocalDate(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard u.count == 10, u[4] == 45, u[7] == 45 else { return false }
        for (i, b) in u.enumerated() where i != 4 && i != 7 { if b < 48 || b > 57 { return false } }
        return true
    }

    /// The civil date of `date` in `timeZone`.
    public static func localDate(of date: Date, in timeZone: TimeZone) -> LocalDate {
        let c = calendar(timeZone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    /// Noon of a civil date in `timeZone`: a safe anchor for formatting and day arithmetic.
    public static func noon(of localDate: LocalDate, in timeZone: TimeZone) -> Date? {
        guard isLocalDate(localDate), let y = Int(localDate.prefix(4)), let m = Int(localDate.dropFirst(5).prefix(2)), let d = Int(localDate.suffix(2)) else { return nil }
        return calendar(timeZone).date(from: DateComponents(year: y, month: m, day: d, hour: 12))
    }

    public static func adding(days: Int, to localDate: LocalDate) -> LocalDate {
        guard let noon = noon(of: localDate, in: utc) else { return localDate }
        return Dates.localDate(of: noon.addingTimeInterval(Double(days) * 86_400), in: utc)
    }

    /// Whole days from `a` to `b` (positive when `b` is later).
    public static func days(from a: LocalDate, to b: LocalDate) -> Int? {
        guard let x = noon(of: a, in: utc), let y = noon(of: b, in: utc) else { return nil }
        return Int((y.timeIntervalSince(x) / 86_400).rounded())
    }
}

/// Creates the stable identifiers the client assigns before anything is sent: idempotency
/// keys, client submission IDs and client turn IDs. Injected so tests are deterministic.
public protocol IdentifierSource: Sendable {
    func next(_ prefix: String) -> String
}

public struct UUIDIdentifierSource: IdentifierSource {
    public init() {}
    public func next(_ prefix: String) -> String { "\(prefix)-\(UUID().uuidString.lowercased())" }
}

public final class SequentialIdentifierSource: IdentifierSource, @unchecked Sendable {
    private let lock = NSLock()
    private var counter = 0
    private let seed: String
    public init(seed: String = "test") { self.seed = seed }
    public func next(_ prefix: String) -> String {
        lock.lock(); defer { lock.unlock() }
        counter += 1
        return "\(prefix)-\(seed)-\(String(format: "%06d", counter))"
    }
}
