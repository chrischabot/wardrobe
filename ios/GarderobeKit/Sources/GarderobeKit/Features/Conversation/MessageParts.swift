import Foundation

/// A typed, tolerant view of one stored transcript part or one run event's data. The
/// contract leaves parts open, so parsing never fails: anything this version does not
/// recognise becomes `.unknown` and the message still renders from its text.
public enum MessagePart: Sendable, Equatable {
    case text(String)
    /// Validated options only; the backend never sends a speculative card.
    case outfitBoard(boardId: String?, revision: Int?, options: [BoardOption])
    case productComparison(ProductComparison)
    case sources([SourceCitation])
    case receipt(RunReceiptRef)
    case needsInput(PendingInput)
    case attachment(assetId: String, label: String?)
    case unknown(type: String)

    public init(_ raw: [String: JSONValue]) {
        let type = raw["type"]?.stringValue ?? ""
        let value = JSONValue.object(raw)
        func decode<T: Decodable>(_ key: String, _ t: T.Type) -> T? { raw[key].flatMap { try? $0.decoded(as: t) } }
        switch type {
        case "text":
            self = raw["text"]?.stringValue.map(MessagePart.text) ?? .unknown(type: type)
        case "outfit_board":
            guard let options = decode("options", [BoardOption].self) else { self = .unknown(type: type); return }
            self = .outfitBoard(boardId: raw["boardId"]?.stringValue, revision: raw["revision"]?.intValue, options: options)
        case "product_comparison":
            guard let title = raw["title"]?.stringValue else { self = .unknown(type: type); return }
            let rows = (raw["rows"]?.arrayValue ?? []).compactMap(\.objectValue)
            self = .productComparison(ProductComparison(title: title, verdict: raw["verdict"]?.stringValue, rows: rows, checkedAt: raw["checkedAt"]?.stringValue))
        case "sources":
            self = decode("sources", [SourceCitation].self).map(MessagePart.sources) ?? .unknown(type: type)
        case "command_receipt":
            self = decode("receipt", RunReceiptRef.self).map(MessagePart.receipt) ?? .unknown(type: type)
        case "needs_input":
            self = decode("input", PendingInput.self).map(MessagePart.needsInput) ?? .unknown(type: type)
        case "attachment":
            let assetId = raw["assetId"]?.stringValue ?? value["asset"]?["assetId"]?.stringValue
            self = assetId.map { .attachment(assetId: $0, label: raw["label"]?.stringValue ?? value["asset"]?["displayLabel"]?.stringValue) } ?? .unknown(type: type)
        default:
            self = .unknown(type: type)
        }
    }

    public var isUnknown: Bool { if case .unknown = self { return true }; return false }
}

/// A saved product comparison: image, exact variant, source, checked time and verdict stay
/// together. When its check is old it is shown as stale; it is never deleted for being old.
public struct ProductComparison: Sendable, Equatable {
    /// After this long a stock or price check is presented as stale.
    public static let staleAfter: TimeInterval = 24 * 3600

    public var title: String
    public var verdict: String?
    public var rows: [[String: JSONValue]]
    public var checkedAt: Instant?

    public func isStale(now: Date) -> Bool {
        guard let checkedAt, let date = Dates.parseInstant(checkedAt) else { return true } // an unknown check time is not presented as current
        return now.timeIntervalSince(date) > ProductComparison.staleAfter
    }

    public func checkedLine(now: Date, timeZone: TimeZone) -> String {
        guard let checkedAt, let date = Dates.parseInstant(checkedAt) else { return "Check time unknown" }
        let when = Phrases.relativeTime(date, now: now, timeZone: timeZone)
        return isStale(now: now) ? "Checked \(when). May be out of date." : "Checked \(when)"
    }

    /// Column names in first-seen order, for the comparison table.
    public var columns: [String] {
        var seen: [String] = []
        for row in rows { for key in row.keys.sorted() where !seen.contains(key) { seen.append(key) } }
        return seen
    }

    public static func cell(_ value: JSONValue?) -> String {
        switch value {
        case .string(let s): return s
        case .integer(let i): return String(i)
        case .number(let d): return String(d)
        case .bool(let b): return b ? "Yes" : "No"
        case .none, .some(.null): return ""
        case .some(let other): return (try? String(decoding: GarderobeJSON.encode(other), as: UTF8.self)) ?? ""
        }
    }
}

/// One message as the transcript shows it.
public struct TranscriptEntry: Sendable, Equatable, Identifiable {
    public enum Delivery: Sendable, Equatable {
        /// In the canonical transcript.
        case settled
        /// Assistant output still arriving.
        case streaming
        /// The owner's message, saved on this phone and not yet accepted by the backend.
        case waitingToSend
        /// The owner's message, held until the current response finishes ("Waiting").
        case waitingForTurn
        case failed(String)
    }
    public var id: String
    public var role: TranscriptMessage.RoleValue
    public var authoredAt: Date?
    public var localDate: LocalDate?
    public var text: String
    public var parts: [MessagePart]
    public var channel: String?
    public var turnId: String?
    public var forgotten: Bool
    public var delivery: Delivery

    public init(_ message: TranscriptMessage, timeZone: TimeZone) {
        id = message.messageId
        role = message.role
        authoredAt = message.authoredAt.flatMap(Dates.parseInstant)
        localDate = authoredAt.map { Dates.localDate(of: $0, in: timeZone) }
        text = message.text
        parts = message.parts.map(MessagePart.init)
        channel = message.channel
        turnId = message.turnId
        forgotten = message.forgotten
        delivery = .settled
    }

    public init(id: String, role: TranscriptMessage.RoleValue, authoredAt: Date?, localDate: LocalDate?, text: String, parts: [MessagePart] = [], turnId: String? = nil, delivery: Delivery) {
        self.id = id; self.role = role; self.authoredAt = authoredAt; self.localDate = localDate; self.text = text; self.parts = parts
        self.channel = "ios"; self.turnId = turnId; self.forgotten = false; self.delivery = delivery
    }

    /// Cards to render after the text. A `text` part repeats `text` and is not rendered twice.
    public var cards: [MessagePart] { parts.filter { if case .text = $0 { return false }; return !$0.isUnknown } }

    public var accessibilityLabel: String {
        let who = role == .user ? "You" : (role == .assistant ? "Garderobe" : "Note")
        if forgotten { return "\(who): message removed at your request." }
        var label = "\(who): \(text)"
        for card in cards {
            switch card {
            case .outfitBoard(_, _, let options): label += " \(Phrases.count(options.count, "outfit")): " + options.map { "\($0.name), \(Phrases.list($0.garments.map(\.name)))" }.joined(separator: "; ") + "."
            case .receipt(let r): label += " Recorded: \(r.summary)"
            case .sources(let s): label += " \(Phrases.count(s.count, "source"))."
            case .productComparison(let c): label += " Comparison: \(c.title)."
            default: break
            }
        }
        return label
    }
}
