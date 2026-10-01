import Foundation
@testable import GarderobeKit

/// SYNTHETIC boundary-case data for unit tests, in the contract's JSON shape. Every garment
/// here is invented and labelled "Test ..." with a `gmt_test_` ID: none of it is the owner's
/// wardrobe. Tests that need the owner's real profile and inventory use the recorded cassettes.
enum Synthetic {
    static let now = "2026-09-15T06:30:00Z"
    static let today = "2026-09-15"

    static func garment(_ id: String, name: String, category: String = "shirt", roles: [String] = ["top"], care: String = "service", acquisition: String = "owned",
                        colour: String? = "blue", season: String? = nil, maker: String? = "Test Maker", product: String? = nil, version: Int = 1) -> JSONValue {
        [
            "userId": "usr_test", "garmentId": .string(id), "version": .integer(version), "name": .string(name), "category": .string(category),
            "roles": .array(roles.map(JSONValue.string)), "maker": maker.map(JSONValue.string) ?? .null, "product": product.map(JSONValue.string) ?? .null,
            "fabric": .null, "colour": colour.map(JSONValue.string) ?? .null, "pattern": .null, "size": .null, "careChannel": .string(care),
            "acquisition": .string(acquisition), "planningPolicy": "normal", "planningReason": .null, "condition": .null,
            "seasonNote": season.map(JSONValue.string) ?? .null, "thermal": .null, "attributes": [:], "isSynthetic": true, "mergedInto": .null,
            "wearLoggingSince": "2026-06-03", "createdAt": .string(now), "updatedAt": .string(now),
        ]
    }

    static func availability(_ id: String, status: String = "available", reasons: [String] = [], clean: Int = 1, basis: [String] = ["Observed clean at home"]) -> JSONValue {
        [
            "garmentId": .string(id), "status": .string(status), "hardExcluded": .bool(status == "unavailable"), "pAvailable": status == "unavailable" ? 0 : 0.9,
            "inferredWear": [], "reasons": .array(reasons.map(JSONValue.string)), "restrictionIds": [], "acquisition": "owned", "planningPolicy": "normal",
            "balances": [["bucket": "clean", "ref": "", "quantity": .integer(clean)]], "cleanObserved": .integer(clean), "basis": .array(basis.map(JSONValue.string)),
        ]
    }

    static func balances(_ pairs: [(String, Int)]) -> JSONValue {
        .array(pairs.map { ["bucket": .string($0.0), "ref": "", "quantity": .integer($0.1)] })
    }

    static func inventoryItem(_ id: String, name: String, category: String = "shirt", roles: [String] = ["top"], care: String = "service", acquisition: String = "owned",
                              status: String = "available", reasons: [String] = [], balances pairs: [(String, Int)] = [("clean", 1)], aliases: [String] = [],
                              colour: String? = "blue", season: String? = nil, wears: Int = 0, lastWear: String? = nil, maker: String? = "Test Maker") -> JSONValue {
        [
            "garment": garment(id, name: name, category: category, roles: roles, care: care, acquisition: acquisition, colour: colour, season: season, maker: maker),
            "aliases": .array(aliases.map(JSONValue.string)), "balances": balances(pairs), "totalOwnedUnits": .integer(pairs.filter { $0.0 != "incoming" && $0.0 != "gone" }.reduce(0) { $0 + $1.1 }),
            "availability": availability(id, status: status, reasons: reasons, clean: pairs.first { $0.0 == "clean" }?.1 ?? 0),
            "recordedWearCount": .integer(wears), "lastRecordedWear": lastWear.map(JSONValue.string) ?? .null,
        ]
    }

    static func inventoryPage(_ items: [JSONValue], complete: Bool = true, counts: (Int, Int, Int, Int)? = nil, revision: Int = 5) -> JSONValue {
        let c = counts ?? (items.count, items.count, 0, 0)
        return [
            "items": .array(items), "total": .integer(items.count), "complete": .bool(complete), "nextCursor": complete ? .null : "next",
            "counts": ["owned": .integer(c.0), "available": .integer(c.1), "incoming": .integer(c.2), "retired": .integer(c.3)],
            "wardrobeRevision": .integer(revision), "readAt": .string(now),
        ]
    }

    static func itemResponse(_ id: String, name: String, category: String = "shirt", care: String = "service", acquisition: String = "owned", balances pairs: [(String, Int)] = [("clean", 1)],
                             status: String = "available", reasons: [String] = [], wears: Int = 0, lastWear: String? = nil, restrictions: [JSONValue] = [], facts: [JSONValue] = []) -> JSONValue {
        [
            "detail": [
                "garment": garment(id, name: name, category: category, care: care, acquisition: acquisition, product: "Test product code X-1"),
                "aliases": [], "facts": .array(facts), "balances": balances(pairs),
                "totalOwnedUnits": .integer(pairs.filter { $0.0 != "incoming" && $0.0 != "gone" }.reduce(0) { $0 + $1.1 }),
                "restrictions": .array(restrictions), "recordedWearCount": .integer(wears), "lastRecordedWear": lastWear.map(JSONValue.string) ?? .null,
                "wearCountCaveat": "Wear counts start on 3 June 2026: zero means unlogged, never unworn.", "recentWears": [], "movements": [],
            ],
            "availability": availability(id, status: status, reasons: reasons, clean: pairs.first { $0.0 == "clean" }?.1 ?? 0),
            "media": .null, "mediaAvailable": true, "knownCombinations": [], "readAt": .string(now),
        ]
    }

    static func line(_ id: String, _ role: String, _ name: String) -> JSONValue {
        ["garmentId": .string(id), "role": .string(role), "name": .string(name), "colour": .null]
    }

    static func option(_ id: String, number: Int, name: String, garments: [JSONValue], alternatives: [JSONValue] = [], flourish: JSONValue = .null, qualification: String? = nil) -> JSONValue {
        [
            "optionId": .string(id), "number": .integer(number), "name": .string(name), "reason": "The textures balance and it suits a mild day.",
            "garments": .array(garments), "footwearAlternatives": .array(alternatives), "flourish": flourish, "suitsEventIds": [],
            "qualification": qualification.map(JSONValue.string) ?? .null, "changedInRevision": false,
        ]
    }

    static var standardOptions: [JSONValue] {
        [
            option("opt_a", number: 1, name: "Test oxford and chinos", garments: [
                line("gmt_test_shirt", "top", "Test blue oxford shirt"), line("gmt_test_chinos", "bottom", "Test stone chinos"),
                line("gmt_test_belt", "belt", "Test brown belt"), line("gmt_test_socks", "socks", "Test navy socks"), line("gmt_test_sneakers", "footwear", "Test grey sneakers"),
            ], alternatives: [line("gmt_test_derbies", "footwear", "Test brown derbies")], flourish: line("gmt_test_scarf", "neckwear", "Test wool scarf")),
            option("opt_b", number: 2, name: "Test knit and jeans", garments: [
                line("gmt_test_knit", "top", "Test grey jumper"), line("gmt_test_jeans", "bottom", "Test dark jeans"),
                line("gmt_test_socks", "socks", "Test navy socks"), line("gmt_test_sneakers", "footwear", "Test grey sneakers"),
            ]),
        ]
    }

    static func board(revision: Int = 3, options: [JSONValue]? = nil, selection: JSONValue = .null, validity: String = "current", calendar: String = "ok",
                      projection: String = "projected", action: String? = nil, notice: String? = nil) -> JSONValue {
        [
            "boardId": "brd_test", "scope": "home", "localDate": .string(today), "timezone": "Europe/London", "revision": .integer(revision), "publishedAt": "2026-09-14T20:05:00Z",
            "reason": "compose", "validity": .string(validity), "dayLine": "Tuesday: a mild, dry working day.", "weatherLine": "12 °C leaving, 18 °C later; dry",
            "suitabilityLine": .null, "notice": notice.map(JSONValue.string) ?? .null, "requestedCount": 5, "options": .array(options ?? standardOptions), "selection": selection,
            "changes": [], "brief": ["text": .null, "requestedCount": .null, "include": [], "exclude": [], "occasionOnly": false, "allowRepeat": false, "segment": "day"],
            "freshness": ["weather": "fresh", "weatherSnapshotId": "wx_1", "weatherFetchedAt": "2026-09-15T05:50:00Z", "calendar": .string(calendar), "calendarSnapshotId": .null,
                          "calendarReadAt": .null, "wardrobeRevision": 5, "styleRevision": 2],
            "calendarProjection": ["state": .string(projection), "projectedRevision": .integer(revision), "action": action.map(JSONValue.string) ?? .null],
        ]
    }

    static func todayResponse(board: JSONValue? = nil, dayRecord: [JSONValue] = [], status: String = "ready", freshness: [JSONValue] = [], paused: JSONValue = .null, emptyReason: String? = nil) -> JSONValue {
        [
            "localDate": .string(today), "timezone": "Europe/London", "board": board ?? .null, "dayRecord": .array(dayRecord), "paused": paused,
            "emptyReason": emptyReason.map(JSONValue.string) ?? .null, "readAt": .string(now), "status": .string(status), "freshness": .array(freshness),
            "runId": .null, "wardrobeRevision": 5,
        ]
    }

    static func laundry(service: [(String, String, Int)] = [], handwash: [(String, String, Int)] = [], batches: [JSONValue] = []) -> JSONValue {
        func lines(_ items: [(String, String, Int)]) -> JSONValue { .array(items.map { ["garmentId": .string($0.0), "name": .string($0.1), "quantity": .integer($0.2)] }) }
        return ["awaitingService": lines(service), "awaitingHandwash": lines(handwash), "batches": .array(batches), "exceptions": [], "cycles": [], "readAt": .string(now)]
    }

    static func batch(_ id: String, items: [(String, String, Int, Int)], returnedAt: String? = nil) -> JSONValue {
        [
            "batchId": .string(id), "status": returnedAt == nil ? "out" : "returned", "pickedUpAt": "2026-09-11T08:00:00Z", "returnedAt": returnedAt.map(JSONValue.string) ?? .null, "returnBasis": .null,
            "items": .array(items.map { ["garmentId": .string($0.0), "name": .string($0.1), "quantity": .integer($0.2), "returnedQuantity": .integer($0.3), "stillAway": 0] }),
        ]
    }

    static func selectorItem(_ id: String?, name: String, marker: String = "owned", eligible: Bool = true, candidate: JSONValue = .null) -> JSONValue {
        [
            "garmentId": id.map(JSONValue.string) ?? .null, "shoppingCandidate": candidate, "name": .string(name), "category": "shirt", "marker": .string(marker),
            "eligibleToday": .bool(eligible), "availabilityStatus": eligible ? "available" : .null, "reasons": [], "image": .null,
        ]
    }

    static func validation(valid: Bool = true, violations: [JSONValue] = []) -> JSONValue {
        ["valid": .bool(valid), "wearableOn": valid ? .string(today) : .null, "violations": .array(violations), "validator": "daily-service", "wardrobeRevision": 5, "checkedAt": .string(now)]
    }

    static func studio(mode: String = "for_today", selectors: [(String, Bool, [JSONValue])], opening: [(String, String)] = [], combinations: [JSONValue] = [], dayPlans: [JSONValue] = []) -> JSONValue {
        [
            "mode": .string(mode), "forDate": .string(today),
            "selectors": .array(selectors.map { ["role": .string($0.0), "primary": .bool($0.1), "items": .array($0.2)] }),
            "opening": .array(opening.map { ["role": .string($0.0), "garmentId": .string($0.1), "shoppingCandidate": .null, "locked": false] }),
            "wardrobeRevision": 5, "readAt": .string(now), "combinations": .array(combinations), "dayPlans": .array(dayPlans),
        ]
    }

    static func message(_ id: String, role: String = "assistant", text: String, at: String = now, parts: [JSONValue] = [], turnId: String? = nil) -> JSONValue {
        ["messageId": .string(id), "role": .string(role), "authoredAt": .string(at), "channel": "ios", "turnId": turnId.map(JSONValue.string) ?? .null, "text": .string(text),
         "parts": .array(parts), "forgotten": false]
    }

    static func page(_ messages: [JSONValue], nextBefore: String? = nil, nextAfter: String? = nil) -> JSONValue {
        ["messages": .array(messages), "nextBefore": nextBefore.map(JSONValue.string) ?? .null, "nextAfter": nextAfter.map(JSONValue.string) ?? .null, "total": .integer(messages.count)]
    }

    static func run(_ id: String, state: String = "completed", reply: (String, String)? = nil, receipts: [JSONValue] = [], pendingInput: JSONValue = .null, lastEventId: Int = 0, activity: String? = nil) -> JSONValue {
        [
            "runId": .string(id), "kind": "conversation_turn", "state": .string(state), "createdAt": .string(now), "updatedAt": .string(now), "activity": activity.map(JSONValue.string) ?? .null,
            "lastEventId": .integer(lastEventId), "pendingInput": pendingInput, "receipts": .array(receipts), "proposals": [],
            "result": reply.map { ["reply": ["messageId": .string($0.0), "text": .string($0.1)], "options": [], "board": .null, "research": .null, "exportId": .null, "importId": .null] } ?? .null,
            "error": .null,
        ]
    }

    static func event(_ id: Int, run: String, type: String, data: JSONValue) -> JSONValue {
        ["eventId": .integer(id), "runId": .string(run), "type": .string(type), "at": .string(now), "data": data]
    }

    /// Encodes run events as a `text/event-stream` body.
    static func sse(_ events: [JSONValue]) -> Data {
        var out = ""
        for event in events {
            let data = String(decoding: (try? GarderobeJSON.encode(event)) ?? Data(), as: UTF8.self)
            out += "id: \(event["eventId"]?.intValue ?? 0)\nevent: \(event["type"]?.stringValue ?? "message")\ndata: \(data)\n\n"
        }
        return Data(out.utf8)
    }

    static var ownerSettings: JSONValue {
        [
            "timezone": "Europe/London", "homeLocation": ["label": "London"], "delivery": ["morningLocalTime": "07:00", "defaultOptionCount": 5],
            "laundry": ["service": ["weeklyResetEnabled": true, "collectionWeekday": 5, "collectionLocalTime": "08:00", "returnWeekday": 6, "baselineWeekday": 7], "handwash": ["mode": "owner_reported"]],
            "variety": ["repeatHorizonDays": 7, "patternHorizonDays": 14], "estimator": ["pUseBoard": 0.85, "pFollowSelection": 0.9, "importCleanPrior": 0.8], "extensions": [:],
        ]
    }

    static func settingsResponse(version: Int = 4, paused: Bool = false, resumeOn: String? = nil) -> JSONValue {
        let pause: JSONValue = paused ? ["pauseId": "pse_1", "from": .string(today), "resumeOn": resumeOn.map(JSONValue.string) ?? .null, "status": "active", "createdAt": .string(now), "endedAt": .null] : .null
        return [
            "settings": ownerSettings, "version": .integer(version),
            "profile": ["documentId": "owner-profile", "title": "Test profile", "version": 1, "contentSha256": .string(String(repeating: "a", count: 64)), "byteLength": 120],
            "inference": .null, "service": ["paused": .bool(paused), "pause": pause, "returnDeadlinesActive": true],
            "apiVersion": "v1", "contractVersion": "1.0.0", "readAt": .string(now),
        ]
    }

    static func styleContext(content: String = "Test profile text.", revision: Int = 2) -> JSONValue {
        [
            "document": ["documentId": "owner-profile", "version": 1, "title": "Test profile", "content": .string(content), "contentSha256": .string(String(repeating: "a", count: 64)),
                         "byteLength": .integer(content.utf8.count), "status": "active", "createdAt": .string(now)],
            "amendments": [], "rules": [], "directions": [], "briefs": [], "measurements": [], "sizeExperiences": [], "precedence": "Physical reality first.", "styleRevision": .integer(revision),
        ]
    }

    static func me(identities: Int = 1, kit: JSONValue = .null) -> JSONValue {
        [
            "userId": "usr_test", "displayName": "Test owner", "scopes": ["read", "write", "admin"], "channel": "ios",
            "identities": .array((0..<identities).map { ["identityId": .string("idn_\($0)"), "provider": "Google via Cloudflare Access", "displayEmail": "owner@example.test", "linkedAt": .string(now), "current": .bool($0 == 0)] }),
            "recoveryKit": ["present": true, "issuedAt": .string(now)], "issuedRecoveryKit": kit,
        ]
    }

    static func kit(_ code: String = "RECOVERY-CODE-TEST-0001-0002") -> JSONValue {
        ["kitId": "kit_1", "recoveryCode": .string(code), "issuedAt": .string(now), "storageInstruction": "Store this offline.", "downloadFileName": "garderobe-recovery-kit.txt", "downloadText": .string("Recovery code: \(code)")]
    }
}

/// Routes scripted answers by `METHOD path`. Unscripted requests fail the exchange with 404.
final class Router: @unchecked Sendable {
    private let lock = NSLock()
    private var routes: [String: (HTTPRequest) throws -> HTTPResponse] = [:]
    var offline = LockedFlag(false)

    func on(_ method: String, _ path: String, _ handler: @escaping (HTTPRequest) throws -> HTTPResponse) { lock.withLock { routes["\(method) \(path)"] = handler } }
    func json(_ method: String, _ path: String, _ value: JSONValue, status: Int = 200) { on(method, path) { _ in TestSupport.json(value, status: status) } }

    var transport: ScriptedTransport {
        ScriptedTransport { [self] request in
            if offline.value { throw TransportFailure("offline") }
            let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
            guard let handler = lock.withLock({ routes["\(request.method) \(path)"] }) else { return TestSupport.error("not_found", "unscripted \(request.method) \(path)", status: 404) }
            return try handler(request)
        }
    }
}

extension ScriptedTransport {
    func requests(_ method: String, _ path: String) -> [HTTPRequest] { requests.filter { $0.method == method && $0.path == path } }
    /// The envelopes posted to `/v1/commands`, in order.
    var commands: [JSONValue] { requests("POST", "/v1/commands").map(TestSupport.body) }
}
