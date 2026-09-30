import Foundation
import Testing
@testable import GarderobeKit

/// The board reads the way the owner's profile, section 11, asks.
@Suite("Board layout (profile section 11)")
@MainActor
struct BoardLayoutTests {
    let today: TodayResponse
    let garments: [String: Garment]

    init() throws {
        today = try Fixtures.today
        garments = Dictionary(uniqueKeysWithValues: today.garments.map { ($0.garmentId, $0) })
    }

    func card(_ position: Int, shoe: String? = nil, swaps: [String: String] = [:]) -> BoardCard {
        let o = today.board!.options.first { $0.position == position }!
        return BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: garments, footwearSelection: shoe, swaps: swaps)
    }

    @Test func everyOptionOpensWithWhyThenJacketShirtTrousersBeltSocksWithShoes() {
        for p in 1...5 {
            let c = card(p)
            #expect(c.whyItWorks == today.board!.options[p - 1].explanation)
            #expect(c.lines.map(\.kind) == [.jacket, .top, .trousers, .belt, .socksAndShoes], "option \(p)")
        }
    }

    @Test func beltLineCarriesTheOptionalFlourish() {
        let belt = card(1).lines.first { $0.kind == .belt }!
        #expect(belt.text == "Anderson's belt — brown")
        #expect(belt.flourish == "optional: Silk knit tie — rust")
    }

    @Test func linesUsePerceptibleNamesAndCategoryLabels() {
        let c = card(3)
        #expect(c.lines[0].label == "Blazer")
        #expect(c.lines[0].text == "Drake's Navy Herringbone Games Mk.I")
        #expect(c.lines[1].label == "Shirt")
        #expect(c.lines[4].label == "Socks and shoes")
        #expect(c.lines[4].text == "Merino — fire red with NB 990v4 — navy")
    }

    @Test func twoShoeOptionNeverLogsBoth() {
        let unresolved = card(2)
        #expect(unresolved.footwear.requiresChoice)
        #expect(unresolved.wearItems == nil)
        #expect(unresolved.lines.last!.text.hasSuffix("\(Names.greySneaker) or \(Names.oliveSneaker)"))

        let olive = unresolved.footwear.alternatives.first { $0.name == Names.oliveSneaker }!.garmentId
        let resolved = card(2, shoe: olive)
        let items = try! #require(resolved.wearItems)
        #expect(items.filter { $0.role == .footwear }.map(\.garmentId) == [olive])
        #expect(resolved.composition.filter { $0.role == .footwear }.count == 1)
        #expect(resolved.lines.last!.text == "Merino — deep earth brown with \(Names.oliveSneaker)")
    }

    @Test func aShoeFromAnotherOptionIsNotAValidSelection() {
        let foreign = today.board!.options[2].footwearSlots[0].garmentId // option 3's navy sneaker
        #expect(card(2, shoe: foreign).footwear.resolved == false)
    }

    @Test func singleShoeOptionsNeedNoChoice() {
        let c = card(1)
        #expect(!c.footwear.requiresChoice)
        #expect(c.wearItems?.count == 7)
    }

    @Test func swapChangesOnlyThatShirt() throws {
        let wardrobe = try Fixtures.wardrobe
        let gold = wardrobe.id(Names.goldOxford)
        let laurel = wardrobe.id("Lightweight oxford — laurel")
        var map = garments
        map[laurel] = wardrobe.items.first { $0.garment.garmentId == laurel }!.garment
        let o = today.board!.options[0]
        let c = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: map, footwearSelection: nil, swaps: [gold: laurel])
        #expect(c.lines[1].text == "Lightweight oxford — laurel")
        #expect(c.swappedRoles == [.baseTop])
        #expect(c.wearItems!.map(\.garmentId).contains(laurel))
        #expect(!c.wearItems!.map(\.garmentId).contains(gold))
        // Everything else is unchanged.
        let before = card(1)
        #expect(c.lines.filter { $0.kind != .top }.map(\.text) == before.lines.filter { $0.kind != .top }.map(\.text))
    }

    @Test func pieceMissingFromTheLocalCacheIsStillLoggedByItsID() {
        var o = today.board!.options[0]
        o.slots.append(OutfitSlot(garmentId: "g_unknownlocal", role: .accessory))
        let c = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: garments, footwearSelection: nil)
        #expect(c.hasMissingGarments)
        #expect(c.wearItems!.contains { $0.garmentId == "g_unknownlocal" })
    }

    @Test func onePieceAndJumperLayoutsAreSupported() {
        let dress = Garment(garmentId: "g_dress", name: "Linen shirt dress", category: "dress", roles: [.onePiece])
        let jumper = Garment(garmentId: "g_jumper", name: "Shetland crew — moss", category: .knitwear, roles: [.midLayer])
        let shirt = Garment(garmentId: "g_shirt", name: "Oxford — white", category: .shirt, roles: [.baseTop])
        let o = OutfitOption(optionId: "opt_x", boardId: "brd_x", revision: 1, position: 1, slots: [
            OutfitSlot(garmentId: "g_shirt", role: .baseTop), OutfitSlot(garmentId: "g_jumper", role: .midLayer), OutfitSlot(garmentId: "g_dress", role: .onePiece),
        ], explanation: "Test.")
        let c = BoardLayout.card(for: o, count: 1, boardRevision: 1, garments: ["g_dress": dress, "g_jumper": jumper, "g_shirt": shirt], footwearSelection: nil)
        #expect(c.lines.map(\.kind) == [.top, .onePiece])
        #expect(c.lines[0].label == "Shirt and jumper")
        #expect(c.lines[0].text == "Oxford — white under Shetland crew — moss")
    }

    @Test func voiceOverDescribesGarmentsAndTheChoiceNotANumber() {
        let text = AccessibilityText.card(card(2))
        #expect(text.hasPrefix("Option 2 of 5."))
        #expect(text.contains("Jacket: ISTO Linen Work Jacket — clay."))
        #expect(text.contains("Shoes not chosen yet: \(Names.greySneaker) or \(Names.oliveSneaker)."))
        #expect(text.contains("optional: Drake's scarf — green Summer Moghul"))
    }

    @Test func dayLinePrefersTheBackendsLine() {
        #expect(DayLine.text(for: today, timeZone: TimeZone(identifier: "Europe/London")!) == today.dayLine)
    }

    @Test func dayLineFallbackUsesDateWeatherAndOccasionWithoutInventing() {
        var t = today
        t.board?.document = nil // a board written without the daily service's document
        t.dayLine = nil
        t.weather = TodayWeather(locationLabel: "London", morningTempC: 11, peakTempC: 17, precipitationProbability: 0.1, windKph: 14, summary: "Dry, light westerly")
        let line = DayLine.text(for: t, timeZone: TimeZone(identifier: "Europe/London")!)
        #expect(line == "Tuesday 6 October · 11° at the door, 17° at the peak, dry, light westerly · Office, then dinner in Borough")
        t.weather = nil
        t.board?.brief.occasion = nil
        #expect(DayLine.text(for: t, timeZone: TimeZone(identifier: "Europe/London")!) == "Tuesday 6 October")
    }

    @Test func theBoardDocumentsWordsAreUsedAndStayTrueToSwapsAndShoes() throws {
        let doc = try #require(today.board?.document)
        #expect(doc.documentVersion == "board-document/1")
        #expect(today.weatherLine == "11 °C leaving, 17 °C by 2; dry, light westerly")
        #expect(today.calendarStatus == "unavailable")
        let o = today.board!.options[1]
        let docOption = try #require(doc.option(o.optionId))
        let c = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: garments, footwearSelection: nil, document: docOption)
        #expect(c.whyItWorks == docOption.why)
        #expect(c.lines.map(\.text) == docOption.lines.map(\.text))
        #expect(c.lines.first { $0.kind == .belt }?.flourish == "optional: Drake's scarf — green Summer Moghul")
        // After choosing a shoe, the line names only that shoe.
        let olive = o.footwearSlots.first { garments[$0.garmentId]?.name == Names.oliveSneaker }!.garmentId
        let chosen = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: garments, footwearSelection: olive, document: docOption)
        #expect(chosen.lines.last?.text == "Merino — deep earth brown with \(Names.oliveSneaker)")
        // After a swap, the document's lines no longer describe the outfit; the local layout is used.
        let slate = o.slots.first { $0.role == .baseTop }!.garmentId
        let wardrobe = try Fixtures.wardrobe
        let pink = wardrobe.id("Lightweight oxford — pink")
        var map = garments
        map[pink] = wardrobe.items.first { $0.garment.garmentId == pink }!.garment
        let swapped = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: map, footwearSelection: nil, swaps: [slate: pink], document: docOption)
        #expect(swapped.lines[1].text == "Lightweight oxford — pink")
        #expect(swapped.whyItWorks == docOption.why)
    }

    @Test func serverLabelsAreRenderedAsGivenEvenWhenTheBackendRewroteThem() throws {
        let o = today.board!.options[1]
        var doc = try #require(today.board?.document?.option(o.optionId))
        // The backend cleared a clashing item code from the heading ("Socks and shoes" -> "Socks & shoes").
        let socks = try #require(doc.lines.firstIndex { $0.kind == "socks_and_shoes" })
        doc.lines[socks].label = "Socks & shoes"
        let top = try #require(doc.lines.firstIndex { $0.kind == "shirt" })
        doc.lines[top].label = "Shirt · top"
        let c = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: garments, footwearSelection: nil, document: doc)
        #expect(c.lines.map(\.label) == doc.lines.map { $0.label! })
        #expect(c.lines.first { $0.kind == .socksAndShoes }?.label == "Socks & shoes")
        #expect(AccessibilityText.card(c).contains("Socks & shoes: ")) // VoiceOver reads the server's heading too
        // Choosing a shoe changes that line's text, not the server's heading.
        let olive = o.footwearSlots.first { garments[$0.garmentId]?.name == Names.oliveSneaker }!.garmentId
        let chosen = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: garments, footwearSelection: olive, document: doc)
        #expect(chosen.lines.first { $0.kind == .socksAndShoes }?.label == "Socks & shoes")
        // After a shirt-for-shirt swap the text is local, but unchanged headings are still the server's.
        let slate = o.slots.first { $0.role == .baseTop }!.garmentId
        let wardrobe = try Fixtures.wardrobe
        let pink = wardrobe.id("Lightweight oxford — pink")
        var map = garments
        map[pink] = wardrobe.items.first { $0.garment.garmentId == pink }!.garment
        let swapped = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: map, footwearSelection: nil, swaps: [slate: pink], document: doc)
        #expect(swapped.lines.first { $0.kind == .top }?.text == "Lightweight oxford — pink")
        #expect(swapped.lines.first { $0.kind == .top }?.label == "Shirt · top")
        #expect(swapped.lines.first { $0.kind == .socksAndShoes }?.label == "Socks & shoes")
    }

    @Test func aLineWithoutALabelKeepsItsWordsAndGetsTheAppsHeading() throws {
        let o = today.board!.options[1]
        var json = try JSONValue.encode(try #require(today.board?.document?.option(o.optionId)))
        guard case .object(var root) = json, case .array(var lines) = root["lines"] else { Issue.record("unexpected document shape"); return }
        let socks = try #require(lines.firstIndex { $0["kind"]?.stringValue == "socks_and_shoes" })
        guard case .object(var line) = lines[socks] else { return }
        line.removeValue(forKey: "label")
        lines[socks] = .object(line)
        root["lines"] = .array(lines)
        json = .object(root)
        let doc = try json.decode(BoardDocument.Option.self)
        #expect(doc.lines.count == lines.count) // the line is kept, not dropped
        #expect(doc.lines[socks].label == nil)
        let c = BoardLayout.card(for: o, count: 5, boardRevision: 2, garments: garments, footwearSelection: nil, document: doc)
        #expect(c.lines.first { $0.kind == .socksAndShoes }?.label == "Socks and shoes")
        #expect(c.lines.first { $0.kind == .socksAndShoes }?.text == doc.lines[socks].text)
    }

    @Test func rainIsNamedWhenLikely() {
        let w = TodayWeather(locationLabel: "London", morningTempC: 9, peakTempC: 9, rainStartsAt: "16:00", precipitationProbability: 0.7, summary: "Showers")
        #expect(DayLine.weatherText(w, timeZone: TimeZone(identifier: "Europe/London")!) == "9° all day, 70% chance of rain from 16:00")
    }

    @Test func missingWeatherValuesAreSaidToBeUnknownNeverGuessed() {
        let tz = TimeZone(identifier: "Europe/London")!
        let none = TodayWeather(locationLabel: "London", status: "missing", morningTempC: nil, peakTempC: nil)
        #expect(DayLine.weatherText(none, timeZone: tz) == "temperature unknown, rain unknown, forecast missing")
        #expect(DayLine.weatherFigures(none) == "unknown → unknown · rain unknown · wind unknown")
        let partial = TodayWeather(locationLabel: "London", status: "stale", morningTempC: nil, peakTempC: 18, precipitationProbability: 0.1, rainAmountMm: 0.4, windKph: 22, gustKph: 41, summary: "Dry")
        #expect(DayLine.weatherText(partial, timeZone: tz) == "18° at the peak, door temperature unknown, dry, forecast stale")
        #expect(DayLine.weatherFigures(partial) == "unknown → 18° · rain 10% (0.4 mm) · wind 22 km/h, gusts 41")
    }

    @Test func todaysOwnWeatherAndDayLineWinOverTheBoardDocument() throws {
        var json = try JSONValue.encode(today)
        guard case .object(var root) = json else { return }
        root["dayLine"] = "From the API."
        root["weather"] = ["locationLabel": "London", "status": "fresh", "observedAt": .null, "morningTempC": 8, "peakTempC": .null, "rainStartsAt": .null,
                           "precipitationProbability": .null, "rainAmountMm": .null, "windKph": .null, "gustKph": .null, "summary": "8 °C leaving", "source": "open-meteo"]
        json = .object(root)
        let t = try json.decode(TodayResponse.self)
        #expect(t.dayLine == "From the API.")
        #expect(t.weather?.morningTempC == 8)
        #expect(t.weather?.peakTempC == nil) // unknown stays unknown; not filled from the document
        #expect(t.weatherLine == "8 °C leaving")
    }
}
