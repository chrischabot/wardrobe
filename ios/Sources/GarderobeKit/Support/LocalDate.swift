import Foundation

/// A local calendar date (YYYY-MM-DD): wearing dates and board dates are day keys, not instants.
public struct LocalDate: Codable, Hashable, Sendable, Comparable, CustomStringConvertible {
    public let rawValue: String

    public init?(_ raw: String) {
        let parts = raw.split(separator: "-")
        guard raw.count == 10, parts.count == 3, parts.allSatisfy({ $0.allSatisfy(\.isNumber) }) else { return nil }
        rawValue = raw
    }

    public init(date: Date, timeZone: TimeZone) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let c = cal.dateComponents([.year, .month, .day], from: date)
        rawValue = String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        let s = try c.decode(String.self)
        guard let d = LocalDate(s) else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a local date: \(s)") }
        self = d
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    public static func < (a: LocalDate, b: LocalDate) -> Bool { a.rawValue < b.rawValue }
    public var description: String { rawValue }

    public var components: DateComponents {
        let p = rawValue.split(separator: "-").compactMap { Int($0) }
        return DateComponents(year: p[0], month: p[1], day: p[2])
    }

    /// Noon on this date in the given time zone (safe anchor for formatting).
    public func date(in timeZone: TimeZone) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        var c = components
        c.hour = 12
        return cal.date(from: c) ?? Date(timeIntervalSince1970: 0)
    }

    public func adding(days: Int) -> LocalDate {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let d = cal.date(byAdding: .day, value: days, to: date(in: cal.timeZone))!
        return LocalDate(date: d, timeZone: cal.timeZone)
    }

    public func days(until other: LocalDate) -> Int {
        let utc = TimeZone(identifier: "UTC")!
        return Int((other.date(in: utc).timeIntervalSince(date(in: utc)) / 86_400).rounded())
    }
}
