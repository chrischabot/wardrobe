import Foundation

// API models mirroring the shipped contracts in packages/contracts/src/api.ts and visual.ts
// (CONTRACTS_VERSION 2026-10-01). Decoding stays tolerant: unknown fields are ignored, unknown enum
// values keep their raw string, and missing optional fields fall back to safe defaults.

// MARK: Conversation

/// Contract `ConversationReference`.
public enum ConversationReference: Codable, Sendable, Hashable {
    case garment(garmentId: String)
    case option(boardId: String, optionId: String, boardRevision: Int)

    enum CodingKeys: String, CodingKey { case kind, garmentId, boardId, optionId, boardRevision }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "garment": self = .garment(garmentId: try c.decode(String.self, forKey: .garmentId))
        case "option":
            self = .option(boardId: try c.decode(String.self, forKey: .boardId), optionId: try c.decode(String.self, forKey: .optionId), boardRevision: c.value(.boardRevision, default: 1))
        case let other: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "Unknown reference kind \(other)")
        }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .garment(let g):
            try c.encode("garment", forKey: .kind); try c.encode(g, forKey: .garmentId)
        case .option(let b, let o, let r):
            try c.encode("option", forKey: .kind); try c.encode(b, forKey: .boardId); try c.encode(o, forKey: .optionId); try c.encode(r, forKey: .boardRevision)
        }
    }
}

public struct TurnIntent: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let chat: TurnIntent = "chat", addItem: TurnIntent = "add_item", identify: TurnIntent = "identify", whatIWore: TurnIntent = "what_i_wore"
}

/// Contract `TurnRequest` (POST /v1/conversation/turns). A turn needs text or an attachment;
/// references alone are not a turn. `stopCurrent` is "Stop and send".
public struct TurnRequest: Codable, Sendable, Hashable {
    public static let maxAttachments = 10
    public static let maxReferences = 20
    public static let maxTextLength = 20_000

    public var clientTurnId: String
    public var text: String
    public var attachmentIds: [String]
    public var references: [ConversationReference]
    public var intent: TurnIntent
    public var explicitLog: Bool
    public var sourceChannel: String = "app"
    public var stopCurrent: Bool?

    public init(clientTurnId: String, text: String, attachmentIds: [String] = [], references: [ConversationReference] = [], intent: TurnIntent = .chat, explicitLog: Bool = false, stopCurrent: Bool? = nil) {
        self.clientTurnId = clientTurnId; self.text = text; self.attachmentIds = attachmentIds; self.references = references
        self.intent = intent; self.explicitLog = explicitLog; self.stopCurrent = stopCurrent
    }

    /// The contract's refinement: text or at least one attachment.
    public var isSendable: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachmentIds.isEmpty)
            && attachmentIds.count <= Self.maxAttachments && references.count <= Self.maxReferences && text.count <= Self.maxTextLength
    }
}

public struct TurnResponse: Codable, Sendable, Hashable {
    public var clientTurnId: String
    public var messageId: String
    public var runId: String
    /// accepted | existing | queued
    public var status: String
    /// Present when Garderobe removed a pasted secret (a recovery code, a token) before storing the message.
    public var notice: TurnNotice? = nil

    public init(clientTurnId: String, messageId: String, runId: String, status: String, notice: TurnNotice? = nil) {
        self.clientTurnId = clientTurnId; self.messageId = messageId; self.runId = runId; self.status = status; self.notice = notice
    }
    enum CodingKeys: String, CodingKey { case schemaVersion, clientTurnId, messageId, runId, status, notice }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clientTurnId = try c.decode(String.self, forKey: .clientTurnId)
        messageId = try c.decode(String.self, forKey: .messageId)
        runId = try c.decode(String.self, forKey: .runId)
        status = c.value(.status, default: "accepted")
        notice = c.value(.notice, default: nil)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(clientTurnId, forKey: .clientTurnId); try c.encode(messageId, forKey: .messageId)
        try c.encode(runId, forKey: .runId); try c.encode(status, forKey: .status)
        try c.encodeIfPresent(notice, forKey: .notice)
    }
}

/// Contract `TurnResponse.notice` (kind `secret_removed`): what was removed from the owner's message, never the secret.
public struct TurnNotice: Codable, Sendable, Hashable {
    public struct Redaction: Codable, Sendable, Hashable {
        public var kind: String
        public var count: Int
        public init(kind: String, count: Int) { self.kind = kind; self.count = count }
    }
    public var kind: String
    public var title: String
    public var summary: String
    public var redacted: [Redaction]

    public init(kind: String = "secret_removed", title: String, summary: String, redacted: [Redaction]) {
        self.kind = kind; self.title = title; self.summary = summary; self.redacted = redacted
    }

    /// A recovery code was among the removed items: the owner should create a new one.
    public var removedRecoveryCode: Bool { redacted.contains { $0.kind == "recovery_code" } }
    /// What the stored message shows in place of what was removed (the backend's placeholders).
    public var placeholder: String { removedRecoveryCode ? "[recovery code removed]" : "[secret removed]" }
}

public struct SourceLink: Codable, Sendable, Hashable {
    public var title: String
    public var url: String
    public var checkedAt: Date?
}

public struct OutfitCard: Codable, Sendable, Hashable {
    public var boardId: String?
    public var optionId: String?
    public var boardRevision: Int?
    public var garmentIds: [String]
    public var explanation: String
    /// Only validated cards are actionable; speculative text can never produce one (spec section 13).
    public var validated: Bool
    /// Choose / I wore this / Ask about this appear only on a validated card tied to a board option.
    public var isActionable: Bool { validated && boardId != nil && optionId != nil }
}

/// Contract message part `result_card`: a durable research or background-job result.
public struct ResultCard: Codable, Sendable, Hashable {
    public var kind: String
    public var title: String
    public var summary: String
    public var jobRef: String
}

public enum MessagePart: Codable, Sendable, Hashable {
    case text(String)
    case outfitCard(OutfitCard)
    case sources([SourceLink])
    case receipt(commandId: String, summary: String)
    case reference(ConversationReference)
    case attachment(uploadId: String, contentType: String, thumbnailUrl: String?)
    case resultCard(ResultCard)
    /// A part type this app version does not know. Kept so nothing is silently lost on re-encode.
    case unknown(type: String, raw: JSONValue)

    enum CodingKeys: String, CodingKey { case type, text, sources, commandId, summary, reference, uploadId, contentType, thumbnailUrl }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(JSONValue.self)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = c.value(.type, default: "unknown")
        switch type {
        case "text": self = .text(c.value(.text, default: ""))
        case "outfit_card":
            if let card = try? raw.decode(OutfitCard.self) { self = .outfitCard(card) } else { self = .unknown(type: type, raw: raw) }
        case "result_card":
            if let card = try? raw.decode(ResultCard.self) { self = .resultCard(card) } else { self = .unknown(type: type, raw: raw) }
        case "sources": self = .sources(c.value(.sources, default: []))
        case "receipt": self = .receipt(commandId: c.value(.commandId, default: ""), summary: c.value(.summary, default: ""))
        case "reference":
            if let r = try? c.decode(ConversationReference.self, forKey: .reference) { self = .reference(r) } else { self = .unknown(type: type, raw: raw) }
        case "attachment": self = .attachment(uploadId: c.value(.uploadId, default: ""), contentType: c.value(.contentType, default: ""), thumbnailUrl: c.value(.thumbnailUrl, default: nil))
        default: self = .unknown(type: type, raw: raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .outfitCard(let card):
            var o = try JSONValue.encode(card).objectValue ?? [:]
            o["type"] = "outfit_card"
            var s = encoder.singleValueContainer(); try s.encode(JSONValue.object(o))
            return
        case .resultCard(let card):
            var o = try JSONValue.encode(card).objectValue ?? [:]
            o["type"] = "result_card"
            var s = encoder.singleValueContainer(); try s.encode(JSONValue.object(o))
            return
        case .unknown(_, let raw):
            var s = encoder.singleValueContainer(); try s.encode(raw)
            return
        default: break
        }
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let t): try c.encode("text", forKey: .type); try c.encode(t, forKey: .text)
        case .sources(let s): try c.encode("sources", forKey: .type); try c.encode(s, forKey: .sources)
        case .receipt(let id, let summary): try c.encode("receipt", forKey: .type); try c.encode(id, forKey: .commandId); try c.encode(summary, forKey: .summary)
        case .reference(let r): try c.encode("reference", forKey: .type); try c.encode(r, forKey: .reference)
        case .attachment(let id, let ct, let thumb):
            try c.encode("attachment", forKey: .type); try c.encode(id, forKey: .uploadId); try c.encode(ct, forKey: .contentType); try c.encode(thumb, forKey: .thumbnailUrl)
        case .outfitCard, .resultCard, .unknown: break
        }
    }

    public var text: String? { if case .text(let t) = self { return t }; return nil }
}

public struct ConversationMessage: Codable, Sendable, Hashable, Identifiable {
    public var id: String { messageId }
    public var messageId: String
    public var clientTurnId: String?
    public var role: String
    public var createdAt: Date
    public var sourceChannel: String
    public var status: String
    public var parts: [MessagePart]
    public var runId: String?

    public init(messageId: String, clientTurnId: String? = nil, role: String, createdAt: Date, sourceChannel: String = "app", status: String = "complete", parts: [MessagePart], runId: String? = nil) {
        self.messageId = messageId; self.clientTurnId = clientTurnId; self.role = role; self.createdAt = createdAt
        self.sourceChannel = sourceChannel; self.status = status; self.parts = parts; self.runId = runId
    }

    enum CodingKeys: String, CodingKey { case messageId, clientTurnId, role, createdAt, sourceChannel, status, parts, runId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messageId = try c.decode(String.self, forKey: .messageId)
        clientTurnId = c.value(.clientTurnId, default: nil)
        role = c.value(.role, default: "assistant")
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        sourceChannel = c.value(.sourceChannel, default: "app")
        status = c.value(.status, default: "complete")
        parts = c.value(.parts, default: [JSONValue]()).compactMap { try? $0.decode(MessagePart.self) }
        runId = c.value(.runId, default: nil)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(messageId, forKey: .messageId)
        try c.encode(clientTurnId, forKey: .clientTurnId)
        try c.encode(role, forKey: .role)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(sourceChannel, forKey: .sourceChannel)
        try c.encode(status, forKey: .status)
        try c.encode(parts, forKey: .parts)
        try c.encodeIfPresent(runId, forKey: .runId)
    }

    public var plainText: String { parts.compactMap(\.text).joined() }
}

/// Contract `ConversationPage` (GET /v1/conversation/messages?before= | ?around=).
public struct ConversationPage: Codable, Sendable, Hashable {
    public var messages: [ConversationMessage]
    public var before: String?
    public var hasMore: Bool
    public var after: String?
    public var activeRunId: String?

    public init(messages: [ConversationMessage], before: String?, hasMore: Bool, after: String? = nil, activeRunId: String?) {
        self.messages = messages; self.before = before; self.hasMore = hasMore; self.after = after; self.activeRunId = activeRunId
    }
}

/// Contract `RecallSearchRequest` (POST /v1/recall/search): source-grounded, dated recall.
public struct RecallSearchRequest: Codable, Sendable, Hashable {
    public static let maxQueryLength = 500
    public var query: String
    public var from: LocalDate?
    public var to: LocalDate?
    public var category: String?
    public var limit: Int?
    public init(query: String, from: LocalDate? = nil, to: LocalDate? = nil, category: String? = nil, limit: Int? = nil) {
        self.query = query; self.from = from; self.to = to; self.category = category; self.limit = limit
    }
    /// Omit absent keys: the contract is a strict object with optional (not nullable) fields.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(query, forKey: .query)
        try c.encodeIfPresent(from, forKey: .from)
        try c.encodeIfPresent(to, forKey: .to)
        try c.encodeIfPresent(category, forKey: .category)
        try c.encodeIfPresent(limit, forKey: .limit)
    }
}

/// Contract `RecallSearchResponse`: quotes with their date and context, later reversals, and how much
/// of the transcript the index covered.
public struct RecallSearchResponse: Codable, Sendable, Hashable {
    public struct Judgment: Codable, Sendable, Hashable { public var kind: String; public var speaker: String; public var subject: String; public var quote: String }
    public struct Context: Codable, Sendable, Hashable {
        public var before: String?; public var after: String?
        public init(before: String?, after: String?) { self.before = before; self.after = after }
        enum CodingKeys: String, CodingKey { case before, after }
        /// Both keys are required and nullable in the contract: write explicit nulls.
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(before, forKey: .before)
            try c.encode(after, forKey: .after)
        }
    }
    public struct Hit: Codable, Sendable, Hashable, Identifiable {
        public var id: String { messageId }
        public var messageId: String
        public var authoredAt: Date
        public var localDate: LocalDate
        public var speaker: String
        public var quote: String
        public var judgments: [Judgment]
        public var context: Context
        public var link: String
        public var score: Double
        enum CodingKeys: String, CodingKey { case messageId, authoredAt, localDate, speaker, quote, judgments, context, link, score }
        public init(messageId: String, authoredAt: Date, localDate: LocalDate, speaker: String, quote: String, judgments: [Judgment] = [], context: Context = .init(before: nil, after: nil), link: String, score: Double) {
            self.messageId = messageId; self.authoredAt = authoredAt; self.localDate = localDate; self.speaker = speaker; self.quote = quote
            self.judgments = judgments; self.context = context; self.link = link; self.score = score
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            messageId = try c.decode(String.self, forKey: .messageId)
            authoredAt = try c.decode(Date.self, forKey: .authoredAt)
            localDate = try c.decode(LocalDate.self, forKey: .localDate)
            speaker = c.value(.speaker, default: "unknown")
            quote = c.value(.quote, default: "")
            judgments = c.value(.judgments, default: [])
            context = c.value(.context, default: Context(before: nil, after: nil))
            link = c.value(.link, default: "")
            score = c.value(.score, default: 0)
        }
    }
    public struct Reversal: Codable, Sendable, Hashable { public var kind: String; public var subject: String; public var quote: String; public var authoredAt: String; public var messageId: String }
    public struct Coverage: Codable, Sendable, Hashable {
        public var sourceSeq: Double; public var indexedSeq: Double; public var exhaustive: Bool; public var supplementedFromSource: Double; public var index: String
    }
    public struct Range: Codable, Sendable, Hashable { public var from: String; public var to: String }

    public var query: String
    public var range: Range?
    public var hits: [Hit]
    public var laterReversals: [Reversal]
    public var coverage: Coverage?
    public var notes: [String]

    enum CodingKeys: String, CodingKey { case schemaVersion, query, range, hits, laterReversals, coverage, notes }
    public init(query: String, range: Range? = nil, hits: [Hit], laterReversals: [Reversal] = [], coverage: Coverage?, notes: [String] = []) {
        self.query = query; self.range = range; self.hits = hits; self.laterReversals = laterReversals; self.coverage = coverage; self.notes = notes
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = c.value(.query, default: "")
        range = c.value(.range, default: nil)
        // One malformed hit must not hide the others.
        hits = c.value(.hits, default: [JSONValue]()).compactMap { try? $0.decode(Hit.self) }
        laterReversals = c.value(.laterReversals, default: [])
        coverage = c.value(.coverage, default: nil)
        notes = c.value(.notes, default: [])
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(query, forKey: .query)
        try c.encode(range, forKey: .range)
        try c.encode(hits, forKey: .hits)
        try c.encode(laterReversals, forKey: .laterReversals)
        try c.encode(coverage, forKey: .coverage)
        try c.encode(notes, forKey: .notes)
    }
}

/// Contract `RunState`.
public struct RunState: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let queued: RunState = "queued", running: RunState = "running", inputRequired: RunState = "input_required"
    public static let finished: RunState = "finished", cancelled: RunState = "cancelled", failed: RunState = "failed"
    public var isTerminal: Bool { self == .finished || self == .cancelled || self == .failed }
}

/// Contract `PendingAction`: one durable question, answered natively or by an MCP retry.
public struct PendingAction: Codable, Sendable, Hashable {
    public struct Choice: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var label: String
    }
    public var pendingActionId: String
    public var prompt: String
    public var choices: [Choice]
    public var status: String
    public var expiresAt: Date?
    public var commandType: String?
    public var idempotencyKey: String?
}

/// Contract `RunStatus` (GET /v1/runs/{id}).
public struct RunStatus: Codable, Sendable, Hashable {
    public var runId: String
    public var kind: String?
    public var status: RunState
    public var lastEventId: String?
    public var messageId: String?
    public var message: ConversationMessage?
    public var receipts: [CommandReceipt]?
    public var pendingAction: PendingAction?

    public init(runId: String, kind: String? = nil, status: RunState, lastEventId: String? = nil, messageId: String? = nil, message: ConversationMessage? = nil, receipts: [CommandReceipt]? = nil, pendingAction: PendingAction? = nil) {
        self.runId = runId; self.kind = kind; self.status = status; self.lastEventId = lastEventId; self.messageId = messageId
        self.message = message; self.receipts = receipts; self.pendingAction = pendingAction
    }

    enum CodingKeys: String, CodingKey { case schemaVersion, runId, kind, status, lastEventId, messageId, message, receipts, pendingAction }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runId = try c.decode(String.self, forKey: .runId)
        kind = c.value(.kind, default: nil)
        status = try c.decode(RunState.self, forKey: .status)
        lastEventId = c.value(.lastEventId, default: nil)
        messageId = c.value(.messageId, default: nil)
        message = c.value(.message, default: nil)
        receipts = c.value(.receipts, default: nil)
        pendingAction = c.value(.pendingAction, default: nil)
    }
    /// Nullable contract fields are required keys: write explicit nulls; optional ones only when present.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(runId, forKey: .runId)
        try c.encodeIfPresent(kind, forKey: .kind)
        try c.encode(status, forKey: .status)
        try c.encode(lastEventId, forKey: .lastEventId)
        try c.encode(messageId, forKey: .messageId)
        try c.encode(message, forKey: .message)
        try c.encodeIfPresent(receipts, forKey: .receipts)
        try c.encodeIfPresent(pendingAction, forKey: .pendingAction)
    }
}

/// Contract `RunInputRequest` (POST /v1/runs/{id}/input). A nil choice declines the question.
public struct RunInputRequest: Codable, Sendable, Hashable {
    public var choiceId: String?
    public init(choiceId: String?) { self.choiceId = choiceId }
    enum CodingKeys: String, CodingKey { case choiceId }
    /// Declining is sent as an explicit `null`, which the contract accepts (nullable, optional).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(choiceId, forKey: .choiceId)
    }
}

/// Contract `RunInputResponse`: `executed` (also when an answered question is replayed, with the
/// original receipt), `declined` or `expired`. `run` is a `RunStatus`.
public struct RunInputResponse: Codable, Sendable, Hashable {
    public enum Status: String, Codable, Sendable { case executed, declined, expired, unknown }
    public var status: Status
    public var receipt: CommandReceipt?
    /// A confirmed export, import or recovery-kit request: its result with the owner's private link.
    /// Held in memory for the owner to use; never written to the transcript or the client store.
    public var operation: AccountOperationReceipt?
    public var run: RunStatus?

    public init(status: Status, receipt: CommandReceipt?, operation: AccountOperationReceipt? = nil, run: RunStatus?) { self.status = status; self.receipt = receipt; self.operation = operation; self.run = run }
    enum CodingKeys: String, CodingKey { case schemaVersion, status, receipt, operation, run }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = Status(rawValue: c.value(.status, default: "unknown")) ?? .unknown
        receipt = c.value(.receipt, default: nil)
        operation = c.value(.operation, default: nil)
        run = c.value(.run, default: nil)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(status == .unknown ? "expired" : status.rawValue, forKey: .status)
        try c.encode(receipt, forKey: .receipt)
        try c.encodeIfPresent(operation, forKey: .operation)
        try c.encode(run, forKey: .run)
    }
}

/// Contract `CancelRunResponse`.
public struct CancelRunResponse: Codable, Sendable, Hashable {
    public var runId: String
    public var status: RunState
    public var stopped: [String]
}

/// Contract `RunEvent` (the `data:` line of the SSE stream). `type` is open: unknown types are ignored.
public struct RunEvent: Codable, Sendable, Hashable {
    public var eventId: String
    public var runId: String
    public var type: String
    public var at: Date?
    public var data: JSONValue
}

// MARK: Uploads

/// Contract `UploadRequest`.
public struct UploadRequest: Codable, Sendable, Hashable {
    public static let maxBytes = 25_000_000
    public var purpose: String
    public var contentType: String
    public var byteLength: Int
    /// For garment_photo: the garment being photographed.
    public var garmentId: String?
    public init(purpose: String, contentType: String, byteLength: Int, garmentId: String? = nil) {
        self.purpose = purpose; self.contentType = contentType; self.byteLength = byteLength; self.garmentId = garmentId
    }
}

public struct UploadAuthorization: Codable, Sendable, Hashable {
    public var uploadId: String
    public var uploadUrl: String
    public var method: String
    public var headers: [String: String]
    public var expiresAt: Date?
}

public struct UploadCompleteResponse: Codable, Sendable, Hashable {
    public var uploadId: String
    public var status: String
    public var reason: String?
    public var assetId: String?
}

// MARK: Session and native sign-in

/// Contract `NativeTokenResponse` (POST /v1/auth/native/token, RFC 6749 shape).
public struct NativeTokenResponse: Codable, Sendable, Hashable {
    public var access_token: String
    public var token_type: String
    public var expires_in: Int
    public var refresh_token: String
    public var scope: String
}

/// Contract `SessionResponse` (GET /v1/auth/session).
public struct SessionResponse: Codable, Sendable, Hashable {
    public var displayName: String
    public var authenticatedBy: String
    public var scopes: [String]
    public var expiresAt: Date?
    public var canWrite: Bool { scopes.contains("wardrobe:write") }
}

// MARK: Settings, connections, connected assistants

/// Contract `AssistantGrant`: a consumer assistant's MCP grant (Claude, ChatGPT, other).
public struct AssistantGrant: Codable, Sendable, Hashable, Identifiable {
    public var id: String { grantId }
    public var grantId: String
    public var client: String
    public var clientId: String
    public var clientName: String
    public var redirectHost: String
    public var scopes: [String]
    public var canWrite: Bool
    public var status: String
    public var createdAt: Date?
    public var lastUsedAt: Date?
    public var lastOperation: String?
    public var revokedAt: Date?

    public var isActive: Bool { status == "active" }
    /// Claude and ChatGPT are named as themselves; anything else by its registered client name.
    public var displayName: String {
        switch client {
        case "claude": "Claude"
        case "chatgpt": "ChatGPT"
        default: clientName
        }
    }
}

public struct Connection: Codable, Sendable, Hashable, Identifiable {
    public var id: String { connectionId }
    public var connectionId: String
    public var kind: String
    public var displayName: String
    public var status: String
    public var capabilities: [Capability]
    public var lastSuccessAt: Date?
    public var lastSuccessOperation: String?
    public var lastError: String?
    /// May be relative to the API origin (e.g. "/v1/connections/{id}/connect").
    public var reconnectUrl: String?
    public var client: String?
    public var scopes: [String]
    public var endpoint: String?
    public var protocolVersion: String?

    public struct Capability: Codable, Sendable, Hashable {
        public var name: String
        public var available: Bool
        public var missingPermission: String?
    }

    enum CodingKeys: String, CodingKey { case connectionId, kind, displayName, status, capabilities, lastSuccessAt, lastSuccessOperation, lastError, reconnectUrl, client, scopes, endpoint, protocolVersion }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connectionId = try c.decode(String.self, forKey: .connectionId)
        kind = c.value(.kind, default: "mcp")
        displayName = c.value(.displayName, default: connectionId)
        status = c.value(.status, default: "error")
        capabilities = c.value(.capabilities, default: [])
        lastSuccessAt = c.value(.lastSuccessAt, default: nil)
        lastSuccessOperation = c.value(.lastSuccessOperation, default: nil)
        lastError = c.value(.lastError, default: nil)
        reconnectUrl = c.value(.reconnectUrl, default: nil)
        client = c.value(.client, default: nil)
        scopes = c.value(.scopes, default: [])
        endpoint = c.value(.endpoint, default: nil)
        protocolVersion = c.value(.protocolVersion, default: nil)
    }

    public var isAssistantGrant: Bool { kind == "assistant_grant" }
    public var isHealthy: Bool { status == "connected" }
    /// Capabilities that are unavailable, named with the missing permission (spec section 3).
    public var unavailableCapabilities: [Capability] { capabilities.filter { !$0.available } }
}

public struct ConnectionsResponse: Codable, Sendable, Hashable {
    public var connections: [Connection]
}

/// Contract `DisconnectResponse`.
public struct DisconnectResponse: Codable, Sendable, Hashable {
    public var connectionId: String
    public var status: String
    public var cancelledCalls: Int
    /// revoked | failed | not_supported | not_applicable
    public var remoteRevocation: String
}

/// Contract `StyleDocumentSummary` (SettingsResponse.styleDocuments).
public struct StyleDocumentSummary: Codable, Sendable, Hashable {
    public var documentId: String
    public var title: String
    public var version: Int
    public var contentSha256: String
    public var byteLength: Int
    public var authoredOn: LocalDate?
}

// MARK: Laundry

public struct LaundryLine: Codable, Sendable, Hashable, Identifiable {
    public var id: String { garmentId }
    public var garmentId: String
    public var name: String
    public var quantity: Int
    public var tracking: StockTracking
}

public struct LaundryBatch: Codable, Sendable, Hashable, Identifiable {
    public var id: String { batchId }
    public var batchId: String
    public var status: String
    public var collectedAt: Date
    public var returnedAt: Date?
    public var items: [Item]
    public var version: Int
    public var names: [String: String]

    public struct Item: Codable, Sendable, Hashable {
        public var garmentId: String
        public var lotId: String
        public var quantity: Int
        public var returnedQuantity: Int
        public var status: String
        /// Units of this line still away (not yet returned).
        public var outstanding: Int { max(0, quantity - returnedQuantity) }
    }

    enum CodingKeys: String, CodingKey { case batchId, status, collectedAt, returnedAt, items, version, names }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        batchId = try c.decode(String.self, forKey: .batchId)
        status = c.value(.status, default: "collected")
        collectedAt = try c.decode(Date.self, forKey: .collectedAt)
        returnedAt = c.value(.returnedAt, default: nil)
        items = c.value(.items, default: [])
        version = c.value(.version, default: 1)
        names = c.value(.names, default: [:])
    }

    public var isOpen: Bool { status == "collected" || status == "partially_returned" }
    public var awayItems: [Item] { items.filter { $0.outstanding > 0 } }
}

/// An owner-reported laundry exception still open (still away, missed return, dirty, delay).
public struct LaundryException: Codable, Sendable, Hashable, Identifiable {
    public var id: String { exceptionId }
    public var exceptionId: String
    public var garmentId: String
    public var name: String
    public var kind: String
    public var quantity: Int
    public var batchId: String?
    public var occurredAt: Date?

    public var label: String {
        switch kind {
        case "still_away": "Still away"
        case "missed_return": "Missed the return"
        case "dirty": "Needs washing"
        case "delay": "Delayed"
        default: kind.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

/// Contract `LaundryState` (GET /v1/laundry).
public struct LaundryState: Codable, Sendable, Hashable {
    public var asOf: Date
    public var service: Service
    public var handWash: HandWash
    public var openExceptions: [LaundryException]

    public struct Service: Codable, Sendable, Hashable {
        public var hamper: [LaundryLine]
        public var batches: [LaundryBatch]
        public var nextCollectionAt: Date?
    }

    public struct HandWash: Codable, Sendable, Hashable {
        public var hamper: [LaundryLine]
    }

    enum CodingKeys: String, CodingKey { case asOf, service, handWash, openExceptions }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        asOf = try c.decode(Date.self, forKey: .asOf)
        service = try c.decode(Service.self, forKey: .service)
        handWash = try c.decode(HandWash.self, forKey: .handWash)
        openExceptions = c.value(.openExceptions, default: [])
    }
}

// MARK: Temperature preview, Studio, swaps, receipts

/// Contract `TemperaturePreview`: a simulation; it changes nothing.
public struct TemperaturePreview: Codable, Sendable, Hashable {
    public var simulation: Bool
    public var temperatureC: Double
    /// peak | departure: which temperature the pieces were judged against.
    public var basis: String?
    public var items: [Item]
    public var note: String

    public struct Item: Codable, Sendable, Hashable, Identifiable {
        public var id: String { garmentId }
        public var garmentId: String
        public var name: String
        public var role: GarmentRole
        public var wearable: Bool
        public var inStorage: Bool
        public var note: String?
    }
}

/// Contract `StudioSlot`.
public struct StudioSlot: Codable, Sendable, Hashable {
    public var garmentId: String
    public var role: GarmentRole
    /// Footwear alternatives share one group.
    public var alternativeGroup: String?
    public init(garmentId: String, role: GarmentRole, alternativeGroup: String? = nil) {
        self.garmentId = garmentId; self.role = role; self.alternativeGroup = alternativeGroup
    }
}

public struct StudioValidateRequest: Codable, Sendable, Hashable {
    public typealias Slot = StudioSlot
    public var mode: String
    public var date: LocalDate
    public var slots: [StudioSlot]
}

/// Contract `StudioIssue`.
public struct StudioIssue: Codable, Sendable, Hashable {
    public var code: String
    public var message: String
    public var garmentId: String?
    public var strength: String?
    /// Explore mode: a day-bound issue (weather, cleanliness, repeats) that does not block exploring.
    public var dayBound: Bool?
    public init(code: String, message: String, garmentId: String?, strength: String? = nil, dayBound: Bool? = nil) {
        self.code = code; self.message = message; self.garmentId = garmentId; self.strength = strength; self.dayBound = dayBound
    }
}

/// Contract `StudioValidation`.
public struct StudioValidation: Codable, Sendable, Hashable {
    public typealias Issue = StudioIssue
    public var mode: String?
    public var valid: Bool
    /// Passes the full daily-service validation for the date (what Plan for a day requires).
    public var validForDate: Bool?
    public var issues: [StudioIssue]
    public var warnings: [StudioIssue]
    public var checkedAt: Date

    public init(mode: String? = nil, valid: Bool, validForDate: Bool? = nil, issues: [StudioIssue], warnings: [StudioIssue] = [], checkedAt: Date) {
        self.mode = mode; self.valid = valid; self.validForDate = validForDate; self.issues = issues; self.warnings = warnings; self.checkedAt = checkedAt
    }

    enum CodingKeys: String, CodingKey { case mode, valid, validForDate, issues, warnings, checkedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = c.value(.mode, default: nil)
        valid = try c.decode(Bool.self, forKey: .valid)
        validForDate = c.value(.validForDate, default: nil)
        issues = c.value(.issues, default: [])
        warnings = c.value(.warnings, default: [])
        checkedAt = try c.decode(Date.self, forKey: .checkedAt)
    }
}

public struct StudioSuggestRequest: Codable, Sendable, Hashable {
    public var mode: String
    public var date: LocalDate
    public var locked: [StudioSlot]
    public var roles: [GarmentRole]
}

/// Contract `StudioSuggestion`. `found == false` means nothing works with the locked pieces.
public struct StudioSuggestion: Codable, Sendable, Hashable {
    public var slots: [StudioSlot]
    public var explanation: String
    public var validation: StudioValidation
    public var found: Bool?
    public var changedRoles: [GarmentRole]?
}

/// Contract `SwapCandidates` (GET /v1/today/options/{optionId}/swaps?role=): validated alternatives, best first.
public struct SwapCandidates: Codable, Sendable, Hashable {
    public var optionId: String
    public var role: GarmentRole
    public var candidates: [Candidate]
    public var validatedAt: Date?
    public struct Candidate: Codable, Sendable, Hashable, Identifiable {
        public var id: String { garmentId }
        public var garmentId: String
        public var name: String
        public var reason: String
    }
    public init(optionId: String, role: GarmentRole, candidates: [Candidate], validatedAt: Date?) {
        self.optionId = optionId; self.role = role; self.candidates = candidates; self.validatedAt = validatedAt
    }
    enum CodingKeys: String, CodingKey { case schemaVersion, optionId, role, candidates, validatedAt }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        optionId = try c.decode(String.self, forKey: .optionId)
        role = try c.decode(GarmentRole.self, forKey: .role)
        // One malformed candidate must not hide the others.
        candidates = c.value(.candidates, default: [JSONValue]()).compactMap { try? $0.decode(Candidate.self) }
        validatedAt = c.value(.validatedAt, default: nil)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ContractsVersion.current, forKey: .schemaVersion)
        try c.encode(optionId, forKey: .optionId)
        try c.encode(role, forKey: .role)
        try c.encode(candidates, forKey: .candidates)
        try c.encode(validatedAt, forKey: .validatedAt)
    }
}

/// Contract `UploadReceiveResponse` (the signed PUT): the bytes are stored, not yet evidence.
public struct UploadReceiveResponse: Codable, Sendable, Hashable {
    public var uploadId: String
    public var receivedBytes: Int
    public init(uploadId: String, receivedBytes: Int) { self.uploadId = uploadId; self.receivedBytes = receivedBytes }
}

/// Contract `ReceiptsPage` (GET /v1/receipts?cursor=&limit=).
public struct ReceiptsPage: Codable, Sendable, Hashable {
    public var receipts: [CommandReceipt]
    public var nextCursor: String?
}
