import Foundation

/// A string enum that never fails to decode. Contract enums grow over time; an unknown raw value is
/// kept as-is so an older app keeps working against a newer backend (spec section 13).
public protocol OpenEnum: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible where RawValue == String {
    init(rawValue: String)
}

extension OpenEnum {
    public init(stringLiteral value: String) { self.init(rawValue: value) }
    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
    public var description: String { rawValue }
}

/// JSON coding shared by the API client and the on-device cache. Instants are ISO-8601 with an
/// explicit offset; fractional seconds are accepted and written.
public enum GarderobeJSON {
    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let s = try c.decode(String.self)
            guard let date = Instant.parse(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not an ISO-8601 instant: \(s)")
            }
            return date
        }
        return d
    }

    public static func encoder(pretty: Bool = false) -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(Instant.format(date))
        }
        e.outputFormatting = pretty ? [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
        return e
    }
}

public enum Instant {
    public static func parse(_ s: String) -> Date? {
        if let d = try? Date(s, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        if let d = try? Date(s, strategy: Date.ISO8601FormatStyle()) { return d }
        return nil
    }

    public static func format(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}

extension KeyedDecodingContainer {
    /// Decodes a value, falling back to a default when the key is missing or malformed.
    func value<T: Decodable>(_ key: Key, default fallback: @autoclosure () -> T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback()
    }
}
