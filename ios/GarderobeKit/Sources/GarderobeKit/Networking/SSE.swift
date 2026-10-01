import Foundation

public struct ServerSentEvent: Sendable, Equatable {
    public var id: String?
    public var event: String
    public var data: String
    public init(id: String? = nil, event: String = "message", data: String) { self.id = id; self.event = event; self.data = data }
}

/// Incremental parser for `text/event-stream` (WHATWG HTML, section 9.2). Chunks may split a
/// line or a multi-byte character anywhere; the parser buffers bytes and only decodes whole lines.
public struct SSEParser: Sendable {
    private var buffer: [UInt8] = []
    private var lastWasCR = false
    private var eventType = ""
    private var dataLines: [String] = []
    private var hasData = false
    private var currentId: String?
    /// The last event ID seen; sent back as `Last-Event-ID` when reconnecting.
    public private(set) var lastEventId: String?
    /// Server-requested reconnection delay in milliseconds, when one was sent.
    public private(set) var retryMilliseconds: Int?

    public init() {}

    public mutating func feed(_ chunk: Data) -> [ServerSentEvent] {
        var events: [ServerSentEvent] = []
        for byte in chunk {
            if lastWasCR {
                lastWasCR = false
                if byte == 10 { continue } // CRLF: the CR already ended the line
            }
            if byte == 13 || byte == 10 {
                lastWasCR = byte == 13
                if let e = processLine() { events.append(e) }
                buffer.removeAll(keepingCapacity: true)
            } else {
                buffer.append(byte)
            }
        }
        return events
    }

    private mutating func processLine() -> ServerSentEvent? {
        if buffer.isEmpty { return dispatch() }
        let line = String(decoding: buffer, as: UTF8.self)
        if line.hasPrefix(":") { return nil } // comment / keep-alive
        let field: String
        var value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[..<colon])
            value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = line
            value = ""
        }
        switch field {
        case "event": eventType = value
        case "data": dataLines.append(value); hasData = true
        case "id": if !value.contains("\u{0}") { currentId = value }
        case "retry": if let ms = Int(value) { retryMilliseconds = ms }
        default: break // unknown fields are ignored
        }
        return nil
    }

    private mutating func dispatch() -> ServerSentEvent? {
        defer { eventType = ""; dataLines.removeAll(); hasData = false }
        if let currentId { lastEventId = currentId }
        guard hasData else { return nil }
        return ServerSentEvent(id: lastEventId, event: eventType.isEmpty ? "message" : eventType, data: dataLines.joined(separator: "\n"))
    }
}
