import Foundation

public struct CommandOutcome: OpenEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let committed: CommandOutcome = "committed", merged: CommandOutcome = "merged"
    public static let rejected: CommandOutcome = "rejected", conflict: CommandOutcome = "conflict"
    public var didCommit: Bool { self == .committed || self == .merged }
}

public struct AffectedEntity: Codable, Sendable, Hashable {
    public var entityType: String
    public var entityId: String
    public var version: Int
    public var change: String?
}

public struct CommandEffect: Codable, Sendable, Hashable {
    public var effectId: String
    public var kind: String
    public var external: Bool
    public var status: String
    public var operationKey: String
}

/// Contract `CommandReceipt`: the verified result of a command. Receipts are never deleted.
public struct CommandReceipt: Codable, Sendable, Hashable, Identifiable {
    public var id: String { commandId }
    public var schemaVersion: String
    public var commandId: String
    public var idempotencyKey: String
    public var commandType: String
    public var outcome: CommandOutcome
    public var replayed: Bool
    public var rebased: Bool
    public var affected: [AffectedEntity]
    public var summary: String
    public var facts: [String: JSONValue]
    public var effects: Effects
    public var undo: Undo
    public var compensatesCommandId: String?
    public var undoneByCommandId: String?
    public var occurredAt: Date
    public var recordedAt: Date
    public var error: ReceiptError?

    public struct Effects: Codable, Sendable, Hashable {
        public var state: String
        public var items: [CommandEffect]
        public init(state: String = "none", items: [CommandEffect] = []) { self.state = state; self.items = items }
    }

    public struct Undo: Codable, Sendable, Hashable {
        public var available: Bool
        public var reason: String?
        public init(available: Bool, reason: String? = nil) { self.available = available; self.reason = reason }
    }

    public struct ReceiptError: Codable, Sendable, Hashable {
        public var code: String
        public var message: String
    }

    public init(
        schemaVersion: String = ContractsVersion.current, commandId: String, idempotencyKey: String, commandType: String, outcome: CommandOutcome,
        replayed: Bool = false, rebased: Bool = false, affected: [AffectedEntity] = [], summary: String, facts: [String: JSONValue] = [:],
        effects: Effects = Effects(), undo: Undo = Undo(available: false), compensatesCommandId: String? = nil, undoneByCommandId: String? = nil,
        occurredAt: Date, recordedAt: Date, error: ReceiptError? = nil
    ) {
        self.schemaVersion = schemaVersion; self.commandId = commandId; self.idempotencyKey = idempotencyKey; self.commandType = commandType
        self.outcome = outcome; self.replayed = replayed; self.rebased = rebased; self.affected = affected; self.summary = summary
        self.facts = facts; self.effects = effects; self.undo = undo; self.compensatesCommandId = compensatesCommandId
        self.undoneByCommandId = undoneByCommandId; self.occurredAt = occurredAt; self.recordedAt = recordedAt; self.error = error
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, commandId, idempotencyKey, commandType, outcome, replayed, rebased, affected, summary, facts, effects, undo
        case compensatesCommandId, undoneByCommandId, occurredAt, recordedAt, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = c.value(.schemaVersion, default: ContractsVersion.current)
        commandId = try c.decode(String.self, forKey: .commandId)
        idempotencyKey = c.value(.idempotencyKey, default: "")
        commandType = c.value(.commandType, default: "unknown")
        outcome = try c.decode(CommandOutcome.self, forKey: .outcome)
        replayed = c.value(.replayed, default: false)
        rebased = c.value(.rebased, default: false)
        affected = c.value(.affected, default: [])
        summary = c.value(.summary, default: "")
        facts = c.value(.facts, default: [:])
        effects = c.value(.effects, default: Effects())
        undo = c.value(.undo, default: Undo(available: false))
        compensatesCommandId = c.value(.compensatesCommandId, default: nil)
        undoneByCommandId = c.value(.undoneByCommandId, default: nil)
        occurredAt = try c.decode(Date.self, forKey: .occurredAt)
        recordedAt = c.value(.recordedAt, default: occurredAt)
        error = c.value(.error, default: nil)
    }

    /// The contract's nullable fields are required keys: write explicit nulls, never omit them.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(schemaVersion, forKey: .schemaVersion)
        try c.encode(commandId, forKey: .commandId)
        try c.encode(idempotencyKey, forKey: .idempotencyKey)
        try c.encode(commandType, forKey: .commandType)
        try c.encode(outcome, forKey: .outcome)
        try c.encode(replayed, forKey: .replayed)
        try c.encode(rebased, forKey: .rebased)
        try c.encode(affected, forKey: .affected)
        try c.encode(summary, forKey: .summary)
        try c.encode(facts, forKey: .facts)
        try c.encode(effects, forKey: .effects)
        try c.encode(undo, forKey: .undo)
        try c.encode(compensatesCommandId, forKey: .compensatesCommandId)
        try c.encode(undoneByCommandId, forKey: .undoneByCommandId)
        try c.encode(occurredAt, forKey: .occurredAt)
        try c.encode(recordedAt, forKey: .recordedAt)
        try c.encode(error, forKey: .error)
    }

    /// Garments this receipt touched, derived from affected entity IDs ("g_…" or "g_…|date").
    public var garmentIds: Set<String> {
        var ids = Set<String>()
        for a in affected {
            let head = a.entityId.split(separator: "|").first.map(String.init) ?? a.entityId
            if head.hasPrefix("g_") { ids.insert(head) }
        }
        for key in ["garmentId"] { if let g = facts[key]?.stringValue { ids.insert(g) } }
        for key in ["counted", "garmentIds"] { facts[key]?.arrayValue?.compactMap(\.stringValue).forEach { ids.insert($0) } }
        return ids
    }

    public var hasExternalEffect: Bool { effects.items.contains { $0.external } }
}
