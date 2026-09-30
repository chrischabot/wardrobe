import Foundation

/// Contract `WearItem`.
public struct WearItem: Codable, Sendable, Hashable {
    public var garmentId: String
    public var role: GarmentRole?
    public var freshUnit: Bool?
    public init(garmentId: String, role: GarmentRole? = nil, freshUnit: Bool? = nil) {
        self.garmentId = garmentId; self.role = role; self.freshUnit = freshUnit
    }
}

/// One domain command (packages/contracts/src/commands.ts). Encoded as `{ "type": …, fields… }`.
/// Built only through the typed factories below so every field name and shape matches the strict
/// server schema; the Swift tests export each encoding and `scripts/fixtures.ts check` validates it
/// with the real zod `CommandEnvelope`.
public struct DomainCommand: Codable, Sendable, Hashable {
    public var type: String
    public var fields: [String: JSONValue]

    init(type: String, _ fields: [String: JSONValue?] = [:]) {
        self.type = type
        self.fields = fields.compactMapValues { $0 }
    }

    public init(from decoder: Decoder) throws {
        var object = try decoder.singleValueContainer().decode([String: JSONValue].self)
        guard let t = object.removeValue(forKey: "type")?.stringValue else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Command without type"))
        }
        type = t
        fields = object
    }

    public func encode(to encoder: Encoder) throws {
        var object = fields
        object["type"] = .string(type)
        var c = encoder.singleValueContainer()
        try c.encode(object)
    }

    public subscript(field: String) -> JSONValue? { fields[field] }

    // MARK: Factories (one per command the app issues)

    private static func instant(_ d: Date?) -> JSONValue? { d.map { .string(Instant.format($0)) } }
    private static func int(_ n: Int?) -> JSONValue? { n.map { .number(Double($0)) } }
    private static func str(_ s: String?) -> JSONValue? { s.map { .string($0) } }
    private static func items(_ items: [WearItem]) -> JSONValue { (try? JSONValue.encode(items)) ?? .array([]) }

    /// I wore this. `wearingDate` is the durable day key; `occurredAt` is when it happened (set when
    /// the owner tapped, not when the queue finally synchronizes).
    public static func recordWear(wearingDate: LocalDate, timezone: String, occurredAt: Date, items: [WearItem], optionId: String? = nil) -> DomainCommand {
        DomainCommand(type: "record_wear", [
            "wearingDate": .string(wearingDate.rawValue), "timezone": .string(timezone), "occurredAt": instant(occurredAt),
            "items": Self.items(items), "optionId": str(optionId),
        ])
    }

    public static func selectOption(boardId: String, optionId: String, footwearGarmentId: String?) -> DomainCommand {
        DomainCommand(type: "select_option", ["boardId": .string(boardId), "optionId": .string(optionId), "footwearGarmentId": str(footwearGarmentId)])
    }

    public static func markInWash(garmentId: String, quantity: Int? = nil, occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "mark_in_wash", ["garmentId": .string(garmentId), "quantity": int(quantity), "occurredAt": instant(occurredAt)])
    }

    public static func markWashed(garmentId: String, quantity: Int? = nil, occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "mark_washed", ["garmentId": .string(garmentId), "quantity": int(quantity), "occurredAt": instant(occurredAt)])
    }

    public static func socksWashed(garmentIds: [String]? = nil, occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "socks_washed", ["garmentIds": garmentIds.map { .array($0.map { .string($0) }) }, "occurredAt": instant(occurredAt)])
    }

    public static func laundryCollected(occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "laundry_collected", ["occurredAt": instant(occurredAt)])
    }

    public struct BatchException: Sendable, Hashable {
        public var garmentId: String
        public var quantity: Int?
        public init(garmentId: String, quantity: Int? = nil) { self.garmentId = garmentId; self.quantity = quantity }
        var json: JSONValue { .object(["garmentId": .string(garmentId)].merging(quantity.map { ["quantity": .number(Double($0))] } ?? [:]) { a, _ in a }) }
    }

    public static func laundryReturned(batchId: String?, exceptions: [BatchException] = [], occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "laundry_returned", [
            "batchId": str(batchId), "exceptions": exceptions.isEmpty ? nil : .array(exceptions.map(\.json)), "occurredAt": instant(occurredAt),
        ])
    }

    /// Some items still away: at least one exception is required by the contract.
    public static func laundryPartialReturn(batchId: String?, exceptions: [BatchException], occurredAt: Date? = nil) -> DomainCommand {
        precondition(!exceptions.isEmpty, "A partial return names at least one item still away")
        return DomainCommand(type: "laundry_partial_return", ["batchId": str(batchId), "exceptions": .array(exceptions.map(\.json)), "occurredAt": instant(occurredAt)])
    }

    public static func backFromTailor(garmentId: String, note: String? = nil, occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "back_from_tailor", ["garmentId": .string(garmentId), "note": str(note), "occurredAt": instant(occurredAt)])
    }

    public static func markArrived(garmentId: String, quantity: Int? = nil, occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "mark_arrived", ["garmentId": .string(garmentId), "quantity": int(quantity), "occurredAt": instant(occurredAt)])
    }

    public static func putIntoStorage(garmentId: String, quantity: Int? = nil, locationDetail: String? = nil, occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "put_into_storage", ["garmentId": .string(garmentId), "quantity": int(quantity), "locationDetail": str(locationDetail), "occurredAt": instant(occurredAt)])
    }

    public static func takeOutOfStorage(garmentId: String, quantity: Int? = nil, occurredAt: Date? = nil) -> DomainCommand {
        DomainCommand(type: "take_out_of_storage", ["garmentId": .string(garmentId), "quantity": int(quantity), "occurredAt": instant(occurredAt)])
    }

    /// Direct correction of an aggregate count ("five pairs are clean").
    public static func reconcileQuantity(garmentId: String, clean: Int? = nil, totalOwned: Int? = nil, occurredAt: Date? = nil) -> DomainCommand {
        precondition(clean != nil || totalOwned != nil, "Provide clean or totalOwned")
        return DomainCommand(type: "reconcile_quantity", ["garmentId": .string(garmentId), "clean": int(clean), "totalOwned": int(totalOwned), "occurredAt": instant(occurredAt)])
    }

    public static func undo(targetCommandId: String) -> DomainCommand {
        DomainCommand(type: "undo", ["targetCommandId": .string(targetCommandId)])
    }

    public static func editStyleProfile(documentId: String, baseVersion: Int, body: String, amendment: String? = nil) -> DomainCommand {
        DomainCommand(type: "edit_style_profile", [
            "documentId": .string(documentId), "baseVersion": .number(Double(baseVersion)), "body": .string(body),
            "amendment": amendment.flatMap { $0.isEmpty ? nil : .string($0) },
        ])
    }

    // MARK: Studio commands (contracts visual.ts) and delivery settings (commands.ts)

    private static func slotsJSON(_ slots: [StudioSlot]) -> JSONValue {
        .array(slots.map { s in
            var o: [String: JSONValue] = ["garmentId": .string(s.garmentId), "role": .string(s.role.rawValue)]
            if let g = s.alternativeGroup { o["alternativeGroup"] = .string(g) }
            return .object(o)
        })
    }

    /// Save combination: stores the combination. Not a plan, not a wear. `name` must be non-empty when given.
    public static func saveCombination(name: String?, slots: [StudioSlot], mode: String? = nil, favorite: Bool? = nil) -> DomainCommand {
        DomainCommand(type: "save_combination", [
            "name": name.flatMap { $0.isEmpty ? nil : .string($0) }, "slots": slotsJSON(slots), "mode": str(mode), "favorite": favorite.map { .bool($0) },
        ])
    }

    /// Plan for a day: one active plan per date; the server validates it for that day first.
    public static func planOutfit(date: LocalDate, slots: [StudioSlot], name: String? = nil) -> DomainCommand {
        DomainCommand(type: "plan_outfit", ["date": .string(date.rawValue), "slots": slotsJSON(slots), "name": name.flatMap { $0.isEmpty ? nil : .string($0) }])
    }

    /// Remove a saved combination or plan (kept as history with status removed; undoable).
    public static func removeCombination(combinationId: String) -> DomainCommand {
        DomainCommand(type: "remove_combination", ["combinationId": .string(combinationId)])
    }

    public enum CalendarChoice: Sendable, Hashable {
        case keep
        case set(String)
        /// No Calendar projection.
        case clear
    }

    /// At least one setting must change (the contract refuses an empty update).
    public static func updateDeliverySettings(deliveryTime: String? = nil, dailyOptionCount: Int? = nil, calendar: CalendarChoice = .keep, homeLocationLabel: String? = nil) -> DomainCommand {
        let cal: JSONValue? = switch calendar {
        case .keep: nil
        case .set(let id): .string(id)
        case .clear: .null
        }
        var c = DomainCommand(type: "update_delivery_settings", [
            "deliveryTime": str(deliveryTime), "dailyOptionCount": int(dailyOptionCount), "homeLocationLabel": str(homeLocationLabel),
        ])
        if let cal { c.fields["calendarId"] = cal }
        return c
    }
}

public struct ExpectedVersion: Codable, Sendable, Hashable {
    public var entityType: String
    public var entityId: String
    public var version: Int
    public init(entityType: String, entityId: String, version: Int) { self.entityType = entityType; self.entityId = entityId; self.version = version }
}

/// Contract `CommandEnvelope`: the body of POST /v1/commands. Never carries owner identity.
public struct CommandEnvelope: Codable, Sendable, Hashable {
    public var idempotencyKey: String
    public var source: SourceChannel
    public var expectedVersions: [ExpectedVersion]?
    public var submittedAt: Date?
    public var command: DomainCommand

    public init(idempotencyKey: String, source: SourceChannel, expectedVersions: [ExpectedVersion]? = nil, submittedAt: Date? = nil, command: DomainCommand) {
        self.idempotencyKey = idempotencyKey; self.source = source; self.expectedVersions = expectedVersions; self.submittedAt = submittedAt; self.command = command
    }

    /// A stable key per owner intent: `app:<command type>:<uuid>`. Matches the contract's pattern
    /// `^[A-Za-z0-9:._-]{8,200}$`, and never changes across retries or app restarts.
    public static func makeKey(for type: String, uuid: String) -> String {
        let safe = type.filter { $0.isLetter || $0.isNumber || $0 == "_" }
        return "app:\(safe):\(uuid.lowercased())"
    }
}
