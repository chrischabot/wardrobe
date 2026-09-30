import Foundation
import Testing
@testable import GarderobeKit

/// Decoding against the contract fixtures (generated from the owner's real CSV and profile and
/// validated against packages/contracts by scripts/fixtures.ts).
@Suite("Contract decoding")
struct ContractDecodingTests {
    @Test func todayDecodesWithFiveOptionsInProfileOrder() throws {
        let today = try Fixtures.today
        #expect(today.date.rawValue == "2026-10-06")
        let board = try #require(today.board)
        #expect(board.options.count == 5)
        #expect(board.options.map(\.position) == [1, 2, 3, 4, 5])
        #expect(today.weather?.peakTempC == 17)
        #expect(today.weather?.morningTempC == 11)
        #expect(today.dayLine?.isEmpty == false)
        // Every garment on the board has display data embedded.
        let ids = Set(board.options.flatMap { $0.slots.map(\.garmentId) })
        #expect(ids.isSubset(of: Set(today.garments.map(\.garmentId))))
    }

    @Test func wardrobeDecodesAllOwnerGarmentsWithCounts() throws {
        let page = try Fixtures.wardrobe
        // 127 from the May 2026 CSV + 17 owner-asserted additions + one labelled TEST EVENT incoming item
        #expect(page.items.count == 145)
        #expect(page.complete)
        #expect(page.counts.incoming == 1)
        #expect(page.counts.retired == 1)
        #expect(page.counts.owned == 143) // 144 owned garments less the TEST EVENT donation
        let socks = page.items.filter { $0.garment.category == .socks }
        #expect(socks.allSatisfy { $0.garment.tracking == .anonymousQuantity })
        #expect(socks.reduce(0) { $0 + $1.stock.totalOwned } == 29)
    }

    @Test func turnResponsesDecodeWithAndWithoutANotice() throws {
        let plain = try Fixtures.decode(TurnResponse.self, "turn-response.json")
        #expect(plain.notice == nil && plain.status == "accepted")
        let notice = try #require(try Fixtures.decode(TurnResponse.self, "turn-response-notice.json").notice)
        #expect(notice.kind == "secret_removed")
        #expect(notice.removedRecoveryCode)
        #expect(notice.placeholder == "[recovery code removed]")
        #expect(notice.title == "Recovery code removed from your message")
    }

    @Test func itemDetailsDecodeForEveryGarment() throws {
        let details = try Fixtures.itemDetails
        #expect(details.count == 145)
        let moss = try #require(details.values.first { $0.item.garment.name == "Lightweight oxford — moss" })
        #expect(moss.wearHistory.map(\.wearingDate.rawValue) == ["2026-10-02"])
        #expect(moss.item.availability.label == "In the wash") // the backend's home-availability label
        #expect(moss.item.availability.state == .inTheWash)
    }

    @Test func theNewAvailabilityLabelsAreRecognisedAndUnknownOnesTolerated() throws {
        let page = try Fixtures.wardrobe
        let states = Dictionary(grouping: page.items, by: \.availability.state).mapValues(\.count)
        #expect(states[.inTheWash] == 2)
        #expect(states[.atTheLaundry] == 1)
        #expect(states[.wornNotWashed] == 4)
        #expect(page.items.filter(\.availability.isWaitingForWash).count == 7)
        #expect(AvailabilitySummary(label: "Packed for a trip", available: false, reasons: []).state == .packedForTrip)
        #expect(AvailabilitySummary(label: "Packed for a trip", available: false, reasons: []).systemImage == "suitcase")
        let future = AvailabilitySummary(label: "On loan to a friend", available: false, reasons: [])
        #expect(future.state == .other && !future.isWaitingForWash)
    }

    @Test func aTripDayBoardIsRecognisableAndAHomeBoardIsNot() throws {
        let trip = try Fixtures.todayTrip
        #expect(trip.isTripDay)
        #expect(trip.purpose?.hasPrefix("trip:trp_") == true)
        #expect(trip.board?.purpose == trip.purpose)
        let t = try #require(trip.trip)
        #expect(t.destinations == ["Paris"])
        #expect(t.timezone == "Europe/Paris")
        #expect(t.length == 4 && t.dayNumber(for: trip.date) == 2)
        #expect(t.dayNumber(for: LocalDate("2026-10-20")!) == nil)
        #expect(trip.tripLine == "Trip day · DEMO FIXTURE: Paris long weekend · day 2 of 4")
        #expect(trip.weather?.locationLabel == "Paris")
        let home = try Fixtures.today
        #expect(home.purpose == "day" && home.trip == nil)
        #expect(!home.isTripDay && home.tripLine == nil)
        // An older server that sends neither field is a home board; a purpose without a summary still says so.
        var raw = try #require(try JSONValue.encode(home).objectValue)
        raw["purpose"] = nil
        raw["trip"] = nil
        #expect(try JSONValue.object(raw).decode(TodayResponse.self).isTripDay == false)
        raw["purpose"] = .string("trip:trp_unknown")
        #expect(try JSONValue.object(raw).decode(TodayResponse.self).tripLine == "Trip day")
    }

    struct OwnerWardrobe: Decodable {
        var garments: Int
        var units: Int
        var additions: Int
        var restricted: [String]
        var additionsRestricted: [String]
        var additionGarmentIds: [String]
    }

    @Test func theOwnersCurrentWardrobeIncludesTheSeventeenAssertedPieces() throws {
        let owner = try Fixtures.decode(OwnerWardrobe.self, "owner-wardrobe.json")
        #expect(owner.garments == 144)
        #expect(owner.units == 161)
        #expect(owner.additions == 17)
        #expect(owner.additionsRestricted == ["NB 990v6", "Paraboot Norwegian split-toe"])
        let page = try Fixtures.wardrobe
        let byId = Dictionary(uniqueKeysWithValues: page.items.map { ($0.garment.garmentId, $0) })
        let added = owner.additionGarmentIds.compactMap { byId[$0] }
        #expect(added.count == 17)
        #expect(added.allSatisfy { $0.garment.attribute("ownerAsserted")?.boolValue == true && $0.stock.totalOwned == 1 && $0.garment.condition == "unknown" })
        // Restricted by the sneakers-only rule; everything else asserted is plannable.
        for name in ["NB 990v6", "Paraboot Norwegian split-toe"] {
            #expect(added.first { $0.garment.name == name }?.availability.label == "Sneakers only for now")
        }
        #expect(added.filter(\.availability.available).count == 15)
        // Unknowns stay unknown: nothing invented.
        let v6 = try #require(added.first { $0.garment.name == "NB 990v6" })
        #expect(v6.garment.color == nil && v6.garment.sizeLabel == nil && v6.garment.maker == "New Balance")
        let d43 = try #require(added.first { $0.garment.name == "D-43" })
        #expect(d43.garment.color == nil && d43.garment.maker == nil && d43.garment.fabric == nil)
        #expect(d43.garment.notes?.contains("Unknown: colour; fabric; maker; size") == true)
        #expect(added.first { $0.garment.name == "Jeans — dark" }?.garment.color == "Indigo, dark")
    }

    @Test func styleDocumentIsTheOwnersProfileByteForByte() throws {
        let style = try Fixtures.style
        #expect(style.document.contentSha256 == "e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198")
        #expect(SHA256.hex(style.document.body) == style.document.contentSha256)
        #expect(style.document.byteLength == 14960)
        #expect(style.document.body.contains("## 11. How advice should arrive"))
        #expect(style.rules?.active == 41)
    }

    @Test func unknownFieldsAndEnumValuesAreTolerated() throws {
        let json = """
        {"garmentId":"g_x1","name":"Mystery","category":"cape","roles":["outer_layer","hover_layer"],"careChannel":"ultrasonic",
         "laundryPolicy":"per_wear","tracking":"unit","acquisition":"leased","planningPolicy":"normal","condition":"good","location":"moon",
         "attributes":{"x":[1,2]},"version":3,"newField":{"deep":true}}
        """
        let g = try GarderobeJSON.decoder().decode(Garment.self, from: Data(json.utf8))
        #expect(g.category.rawValue == "cape")
        #expect(g.roles.contains("hover_layer"))
        #expect(g.acquisition.rawValue == "leased")
        #expect(g.location.rawValue == "moon")
    }

    @Test func oneMalformedOptionDoesNotBlankTheBoard() throws {
        var today = try JSONValue.encode(try Fixtures.today)
        guard case .object(var root) = today, case .object(var board)? = root["board"], case .array(var options)? = board["options"] else {
            Issue.record("unexpected shape"); return
        }
        options[1] = ["optionId": "opt_broken"] // missing slots and boardId
        board["options"] = .array(options)
        root["board"] = .object(board)
        today = .object(root)
        let decoded = try today.decode(TodayResponse.self)
        #expect(decoded.board?.options.count == 4)
    }

    @Test func boardDocumentFillsOnlyWhatTodayLeftOut() throws {
        var today = try JSONValue.encode(try Fixtures.today)
        guard case .object(var root) = today, case .object(var board)? = root["board"] else { return }
        board["document"] = [
            "dayLine": "From the board document.",
            "weather": ["peakTempC": 21, "departureTempC": 12, "summary": "Bright", "source": "met", "status": "stale"],
        ]
        root["board"] = .object(board)
        // The API writes dayLine and weather itself: they win over the document.
        var withTop = root
        today = .object(withTop)
        var decoded = try today.decode(TodayResponse.self)
        #expect(decoded.dayLine?.hasPrefix("Tuesday, eleven degrees") == true)
        #expect(decoded.weather?.peakTempC == 17)
        // A response without them (older board, older cache) falls back to the document.
        withTop["dayLine"] = nil
        withTop["weather"] = nil
        today = .object(withTop)
        decoded = try today.decode(TodayResponse.self)
        #expect(decoded.dayLine == "From the board document.")
        #expect(decoded.weather?.peakTempC == 21)
        #expect(decoded.weather?.morningTempC == 12)
        #expect(decoded.weather?.status == "stale")
        #expect(decoded.weather?.windKph == nil) // not in the document: unknown, not zero
    }

    @Test func todayCarriesTheShippedWeatherAndBoardGarments() throws {
        let t = try Fixtures.today
        let w = try #require(t.weather)
        #expect(w.status == "fresh")
        #expect(w.morningTempC == 11 && w.peakTempC == 17)
        #expect(w.gustKph == 26 && w.windKph == 14 && w.rainAmountMm == 0 && w.rainStartsAt == nil)
        #expect(w.precipitationProbability == 0.1)
        #expect(t.garments.allSatisfy { $0.aliases != nil && $0.media != nil })
        let oxford = try #require(t.garments.first { $0.name == "Lightweight oxford — gold" })
        #expect(oxford.aliases?.contains("PCF4627") == true)
        // BoardGarment.aliases and media are optional in the contract.
        let bare = try GarderobeJSON.decoder().decode(Garment.self, from: Data(#"{"garmentId":"g_bare1","name":"Bare","category":"shirt","roles":["base_top"]}"#.utf8))
        #expect(bare.aliases == nil && bare.media == nil)
    }

    @Test func receiptsDecodeIncludingRejection() throws {
        let rejected = try Fixtures.decode(CommandReceipt.self, "receipt-rejected.json")
        #expect(rejected.outcome == .rejected)
        #expect(rejected.error?.code == "validation_failed")
        let page = try Fixtures.decode(ReceiptsPage.self, "receipts.json")
        #expect(page.receipts.count == 5)
        #expect(page.receipts.allSatisfy { $0.summary.contains("TEST EVENT") })
    }

    @Test func conversationPartsIncludingUnknownTypes() throws {
        let page = try Fixtures.conversation
        #expect(page.messages.count == 4)
        let card = page.messages.last?.parts.compactMap { if case .outfitCard(let c) = $0 { c } else { nil } }.first
        #expect(card?.validated == true)
        let unknown = try GarderobeJSON.decoder().decode(MessagePart.self, from: Data(#"{"type":"hologram","x":1}"#.utf8))
        guard case .unknown(let type, _) = unknown else { Issue.record("expected unknown"); return }
        #expect(type == "hologram")
        // Unknown parts survive a round trip through the cache.
        let again = try GarderobeJSON.decoder().decode(MessagePart.self, from: GarderobeJSON.encoder().encode(unknown))
        #expect(again == unknown)
    }

    @Test func laundryAndConnectionsDecode() throws {
        let laundry = try Fixtures.laundry
        #expect(laundry.service.batches.first?.awayItems.count == 1)
        #expect(laundry.handWash.hamper.reduce(0) { $0 + $1.quantity } == 1)
        #expect(laundry.service.hamper.count == 2)
        let conns = try Fixtures.connections.connections
        #expect(conns.filter(\.isAssistantGrant).map(\.displayName) == ["Claude", "ChatGPT"])
        #expect(conns.first { $0.kind == "calendar" }?.unavailableCapabilities.first?.missingPermission == "calendar.events.readonly")
    }

    @Test func instantsParseWithAndWithoutFractionsAndOffsets() {
        #expect(Instant.parse("2026-10-06T05:52:00.000Z") != nil)
        #expect(Instant.parse("2026-10-06T05:52:00Z") != nil)
        #expect(Instant.parse("2026-10-06T06:52:00+01:00") == Instant.parse("2026-10-06T05:52:00Z"))
        #expect(Instant.parse("yesterday") == nil)
    }

    @Test func sha256KnownVectors() {
        #expect(SHA256.hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        #expect(SHA256.hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(SHA256.hex(String(repeating: "a", count: 1000)) == "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
    }
}
