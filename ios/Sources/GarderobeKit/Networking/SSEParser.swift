import Foundation

/// One dispatched server-sent event.
public struct SSEMessage: Sendable, Hashable {
    public var id: String?
    public var event: String
    public var data: String
    public var retry: Int?
}

/// Incremental parser for the text/event-stream format (WHATWG HTML §9.2). Feed it one line at a
/// time (without the trailing newline); it returns a message when a blank line dispatches one.
public struct SSEParser: Sendable {
    private var id: String?
    private var event: String?
    private var dataLines: [String] = []
    private var retry: Int?
    /// The last event ID seen, which persists across messages (used for Last-Event-ID).
    public private(set) var lastEventId: String?

    public init(lastEventId: String? = nil) { self.lastEventId = lastEventId }

    public mutating func feed(_ rawLine: String) -> SSEMessage? {
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
        if line.isEmpty { return dispatch() }
        if line.hasPrefix(":") { return nil } // comment / keep-alive
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "id": if !value.contains("\0") { id = String(value) }
        case "event": event = String(value)
        case "data": dataLines.append(String(value))
        case "retry": if let n = Int(value) { retry = n }
        default: break
        }
        return nil
    }

    /// Flushes a trailing event when the stream ends without a final blank line.
    public mutating func finish() -> SSEMessage? { dispatch() }

    /// Splits a complete body into lines on CR, LF or CRLF (scalar-level; see `feed(text:)`).
    public static func lines(_ text: String) -> [String] {
        var out: [String] = []
        var line = String.UnicodeScalarView()
        var previousCR = false
        for s in text.unicodeScalars {
            if s == "\n" && previousCR { previousCR = false; continue }
            previousCR = s == "\r"
            if s == "\n" || s == "\r" { out.append(String(line)); line = String.UnicodeScalarView() } else { line.append(s) }
        }
        out.append(String(line))
        return out
    }

    /// Feeds a chunk that may contain several lines ending in CR, LF or CRLF. Splits on Unicode
    /// scalars because Swift treats "\r\n" as a single Character.
    public mutating func feed(text: String) -> [SSEMessage] {
        var lines = Self.lines(text)
        if lines.last == "" { lines.removeLast() }
        return lines.compactMap { feed($0) }
    }

    private mutating func dispatch() -> SSEMessage? {
        defer { event = nil; dataLines = []; retry = nil; id = nil }
        if let id { lastEventId = id }
        guard !dataLines.isEmpty else { return nil }
        return SSEMessage(id: id ?? lastEventId, event: event ?? "message", data: dataLines.joined(separator: "\n"), retry: retry)
    }
}
