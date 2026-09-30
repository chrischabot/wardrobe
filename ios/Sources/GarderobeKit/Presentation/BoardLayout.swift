import Foundation

/// How one outfit card reads, following the owner's profile, section 11 ("How advice should
/// arrive"): each outfit opens with a sentence on why it works, followed by jacket, shirt or jumper,
/// trousers, belt with its optional flourish, and socks with shoes. This is layout only; the
/// backend chose and validated the garments.
public struct BoardCard: Identifiable, Sendable, Hashable {
    public var id: String { optionId }
    public var optionId: String
    public var boardId: String
    public var boardRevision: Int
    public var position: Int
    public var count: Int
    public var whyItWorks: String
    /// Present only when uncertainty materially affects the choice (board document).
    public var qualification: String?
    public var lines: [BoardLine]
    public var footwear: FootwearChoice
    /// Garments in visual order for the composition (outer, top, bottom, footwear...).
    public var composition: [Piece]
    public var isChosen: Bool
    public var swappedRoles: Set<GarmentRole>
    public var hasMissingGarments: Bool

    /// The exact garments "I wore this" logs: swaps applied and exactly one footwear. Pieces whose
    /// display data is missing on this phone are still logged by their backend-validated IDs.
    public var wearItems: [WearItem]? {
        guard footwear.resolved else { return nil }
        return composition.map { WearItem(garmentId: $0.garmentId, role: $0.role) }
    }
}

public struct Piece: Sendable, Hashable, Identifiable {
    public var id: String { garmentId + "|" + role.rawValue }
    public var garmentId: String
    public var role: GarmentRole
    public var name: String
    public var category: Category
    public var colorFamily: String?
    public var media: GarmentMedia?
    public var missing: Bool
    public var isFlourish: Bool
}

public struct BoardLine: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable, CaseIterable {
        case jacket, top, jumper, trousers, onePiece, belt, socksAndShoes, other
    }
    public var id: String { kind.rawValue }
    public var kind: Kind
    /// Heading. The board document's `lines[].label` as the server published it; the app's own heading
    /// ("Jacket", "Shirt", "Socks and shoes"…) only when the server supplied none.
    public var label: String
    /// Glanceable text ("Lightweight oxford — gold").
    public var text: String
    /// Optional flourish on the belt line ("optional: Silk knit tie — rust"): often ignored, always welcome.
    public var flourish: String?
    public var pieces: [Piece]
}

public struct FootwearChoice: Sendable, Hashable {
    public var alternatives: [Piece]
    public var selectedGarmentId: String?
    public var requiresChoice: Bool { alternatives.count > 1 }
    /// True once exactly one shoe will be logged.
    public var resolved: Bool { !requiresChoice || selectedGarmentId != nil }
    public var selected: Piece? {
        if !requiresChoice { return alternatives.first }
        return alternatives.first { $0.garmentId == selectedGarmentId }
    }
}

public enum BoardLayout {
    static let flourishCategories: Set<Category> = [.scarf, .tie]
    static let jumperCategories: Set<Category> = [.knitwear, .sweatshirt]

    /// Builds the section-11 card for one option.
    /// - Parameters:
    ///   - garments: display data by garment ID (Today's embedded garments plus the wardrobe cache).
    ///   - footwearSelection: the owner's chosen shoe when the option offers alternatives.
    ///   - swaps: role-level replacements the owner made this morning (original garment ID → new).
    public static func card(
        for option: OutfitOption, count: Int, boardRevision: Int, garments: [String: Garment], footwearSelection: String?,
        swaps: [String: String] = [:], chosen: Bool = false, document: BoardDocument.Option? = nil
    ) -> BoardCard {
        var card = localCard(for: option, count: count, boardRevision: boardRevision, garments: garments, footwearSelection: footwearSelection, swaps: swaps, chosen: chosen)
        guard let document else { return card }
        // The daily service's document is authoritative for the words: its why-sentence and its
        // section-11 lines, including their headings, which the backend has already cleared of item codes.
        if !document.why.isEmpty { card.whyItWorks = document.why }
        card.qualification = document.qualification
        guard !document.lines.isEmpty else { return card }
        guard card.swappedRoles.isEmpty else {
            // After a morning swap the document's text no longer describes the outfit, so the local lines stay.
            // Their headings still come from the server wherever the swap left the kind of heading unchanged
            // (a shirt swapped for another shirt is still the server's "Shirt"); only a changed heading is local.
            let unswapped = localCard(for: option, count: count, boardRevision: boardRevision, garments: garments, footwearSelection: footwearSelection, swaps: [:], chosen: chosen)
            for i in card.lines.indices {
                let kind = card.lines[i].kind
                guard let server = document.lines.first(where: { lineKind($0.kind) == kind })?.label,
                      let before = unswapped.lines.first(where: { $0.kind == kind }), before.label == card.lines[i].label else { continue }
                card.lines[i].label = server
            }
            return card
        }
        var lines: [BoardLine] = document.lines.map { l in
            let kind = lineKind(l.kind)
            let flourish = l.flourish.map { f in f.text.lowercased().hasPrefix("optional") ? f.text : "optional: " + f.text }
            let pieces = card.composition.filter { l.garmentIds.contains($0.garmentId) || $0.garmentId == l.flourish?.garmentId }
            // The server's heading as given; the local heading only when the document left it out.
            let label = l.label ?? card.lines.first(where: { $0.kind == kind })?.label ?? fallbackLabel(kind)
            return BoardLine(kind: kind, label: label, text: l.text, flourish: flourish, pieces: pieces)
        }
        // Once a shoe is chosen, the socks-and-shoes line names only that shoe.
        if card.footwear.requiresChoice, card.footwear.resolved,
           let local = card.lines.first(where: { $0.kind == .socksAndShoes }), let i = lines.firstIndex(where: { $0.kind == .socksAndShoes }) {
            lines[i].text = local.text
            lines[i].pieces = local.pieces
        }
        card.lines = lines
        return card
    }

    static func lineKind(_ kind: String) -> BoardLine.Kind {
        switch kind {
        case "jacket": .jacket
        case "shirt": .top
        case "jumper": .jumper
        case "trousers": .trousers
        case "belt": .belt
        case "socks_and_shoes": .socksAndShoes
        default: .other
        }
    }

    /// Used only when neither the server nor the local layout has a heading for the line.
    static func fallbackLabel(_ kind: BoardLine.Kind) -> String {
        switch kind {
        case .jacket: "Jacket"
        case .top: "Shirt"
        case .jumper: "Jumper"
        case .trousers: "Trousers"
        case .onePiece: "One piece"
        case .belt: "Belt"
        case .socksAndShoes: "Socks and shoes"
        case .other: "Also"
        }
    }

    static func localCard(
        for option: OutfitOption, count: Int, boardRevision: Int, garments: [String: Garment], footwearSelection: String?,
        swaps: [String: String], chosen: Bool
    ) -> BoardCard {
        var swappedRoles = Set<GarmentRole>()
        let pieces: [Piece] = option.slots.map { slot in
            let id = swaps[slot.garmentId] ?? slot.garmentId
            if id != slot.garmentId { swappedRoles.insert(slot.role) }
            let g = garments[id]
            return Piece(
                garmentId: id, role: slot.role, name: g?.name ?? "Item not in this phone's wardrobe copy", category: g?.category ?? .accessory,
                colorFamily: g?.colorFamily, media: g?.media, missing: g == nil,
                isFlourish: slot.role == .accessory && (g.map { flourishCategories.contains($0.category) } ?? false)
            )
        }
        let footwearAll = pieces.filter { $0.role == .footwear }
        let selection = footwearAll.count > 1 ? footwearAll.first(where: { $0.garmentId == footwearSelection })?.garmentId : nil
        let footwear = FootwearChoice(alternatives: footwearAll, selectedGarmentId: selection)

        var lines: [BoardLine] = []
        let outer = pieces.filter { $0.role == .outerLayer }
        if !outer.isEmpty {
            let label = outer.count == 1 ? (outer[0].category == .coat ? "Coat" : outer[0].category == .blazer ? "Blazer" : "Jacket") : "Layers"
            lines.append(BoardLine(kind: .jacket, label: label, text: outer.map(\.name).joined(separator: " over "), flourish: nil, pieces: outer))
        }
        let tops = pieces.filter { $0.role == .baseTop || $0.role == .midLayer }
        if !tops.isEmpty {
            let base = tops.filter { $0.role == .baseTop }
            let mid = tops.filter { $0.role == .midLayer }
            let label: String
            let text: String
            if !base.isEmpty && !mid.isEmpty {
                label = "Shirt and jumper"
                text = base.map(\.name).joined(separator: ", ") + " under " + mid.map(\.name).joined(separator: ", ")
            } else if let only = tops.first, tops.count == 1 {
                label = jumperCategories.contains(only.category) ? "Jumper" : only.category == .tshirt ? "T-shirt" : only.category == .polo ? "Polo" : "Shirt"
                text = only.name
            } else {
                label = "Shirts"
                text = tops.map(\.name).joined(separator: ", ")
            }
            lines.append(BoardLine(kind: .top, label: label, text: text, flourish: nil, pieces: tops))
        }
        let onePiece = pieces.filter { $0.role == .onePiece }
        if !onePiece.isEmpty {
            lines.append(BoardLine(kind: .onePiece, label: "One piece", text: onePiece.map(\.name).joined(separator: ", "), flourish: nil, pieces: onePiece))
        }
        let bottoms = pieces.filter { $0.role == .bottom }
        if !bottoms.isEmpty {
            let label = bottoms.count == 1 ? (bottoms[0].category == .jeans ? "Jeans" : bottoms[0].category == .shorts ? "Shorts" : "Trousers") : "Trousers"
            lines.append(BoardLine(kind: .trousers, label: label, text: bottoms.map(\.name).joined(separator: ", "), flourish: nil, pieces: bottoms))
        }
        let belts = pieces.filter { $0.role == .belt }
        let accessories = pieces.filter { $0.role == .accessory }
        if !belts.isEmpty || !accessories.isEmpty {
            let flourish = accessories.isEmpty ? nil : "optional: " + accessories.map(\.name).joined(separator: " or ")
            lines.append(BoardLine(
                kind: .belt, label: belts.isEmpty ? "Flourish" : "Belt", text: belts.isEmpty ? (flourish ?? "") : belts.map(\.name).joined(separator: ", "),
                flourish: belts.isEmpty ? nil : flourish, pieces: belts + accessories
            ))
        }
        let socks = pieces.filter { $0.role == .socks }
        if !socks.isEmpty || !footwearAll.isEmpty {
            let shoeText: String
            if let s = footwear.selected { shoeText = s.name }
            else { shoeText = footwearAll.map(\.name).joined(separator: " or ") }
            let sockText = socks.map(\.name).joined(separator: ", ")
            let text = [sockText, shoeText].filter { !$0.isEmpty }.joined(separator: " with ")
            lines.append(BoardLine(kind: .socksAndShoes, label: socks.isEmpty ? "Shoes" : "Socks and shoes", text: text, flourish: nil, pieces: socks + (footwear.selected.map { [$0] } ?? footwearAll)))
        }
        let known: Set<GarmentRole> = [.outerLayer, .baseTop, .midLayer, .onePiece, .bottom, .belt, .accessory, .socks, .footwear]
        let others = pieces.filter { !known.contains($0.role) }
        if !others.isEmpty {
            lines.append(BoardLine(kind: .other, label: "Also", text: others.map(\.name).joined(separator: ", "), flourish: nil, pieces: others))
        }

        // Composition: what is actually worn, one shoe once chosen, flourishes last.
        let visualOrder: [GarmentRole] = [.outerLayer, .midLayer, .baseTop, .onePiece, .bottom, .belt, .socks, .footwear, .accessory]
        var composition: [Piece] = []
        for role in visualOrder {
            for p in pieces where p.role == role {
                if role == .footwear, footwear.requiresChoice, p.garmentId != footwear.selectedGarmentId, footwear.selectedGarmentId != nil { continue }
                composition.append(p)
            }
        }
        composition += others
        // While the shoe is unresolved the image shows both, but `wearItems` is nil so nothing logs both.

        return BoardCard(
            optionId: option.optionId, boardId: option.boardId, boardRevision: boardRevision, position: option.position, count: count,
            whyItWorks: option.explanation, qualification: nil, lines: lines, footwear: footwear, composition: composition, isChosen: chosen,
            swappedRoles: swappedRoles, hasMissingGarments: pieces.contains { $0.missing }
        )
    }
}

public enum DayLine {
    /// The day line that leads the board. Prefers the backend's line (profile section 11); otherwise
    /// composes a plain one from the date, the forecast and the brief, without inventing anything.
    public static func text(for today: TodayResponse, timeZone: TimeZone) -> String {
        if let line = today.dayLine, !line.isEmpty { return line }
        var parts = [dateText(today.date, timeZone: timeZone)]
        if let w = today.weather { parts.append(weatherText(w, timeZone: timeZone)) }
        if let occasion = today.board?.brief.occasion, !occasion.isEmpty { parts.append(occasion) }
        return parts.joined(separator: " · ")
    }

    public static func dateText(_ date: LocalDate, timeZone: TimeZone) -> String {
        var f = Date.FormatStyle.dateTime.weekday(.wide).day().month(.wide)
        f.timeZone = timeZone
        return date.date(in: timeZone).formatted(f.locale(Locale(identifier: "en_GB")))
    }

    /// Weather in words. Values the provider did not supply are said to be unknown, never guessed,
    /// and a forecast that is not fresh says so.
    public static func weatherText(_ w: TodayWeather, timeZone: TimeZone) -> String {
        var parts: [String] = []
        switch (w.morningTempC, w.peakTempC) {
        case let (m?, p?) where Int(m.rounded()) != Int(p.rounded()): parts.append("\(Int(m.rounded()))° at the door, \(Int(p.rounded()))° at the peak")
        case let (m?, _?): parts.append("\(Int(m.rounded()))° all day")
        case let (m?, nil): parts.append("\(Int(m.rounded()))° at the door, peak unknown")
        case let (nil, p?): parts.append("\(Int(p.rounded()))° at the peak, door temperature unknown")
        case (nil, nil): parts.append("temperature unknown")
        }
        if let p = w.precipitationProbability, p >= 0.3 {
            parts.append("\(Int((p * 100).rounded()))% chance of rain" + (w.rainStartsAt.map { " from \($0)" } ?? ""))
        } else if let start = w.rainStartsAt {
            parts.append("rain likely from \(start)")
        } else if !w.summary.isEmpty, w.precipitationProbability != nil {
            parts.append(w.summary.prefix(1).lowercased() + w.summary.dropFirst())
        } else if w.precipitationProbability == nil {
            parts.append("rain unknown")
        }
        if !w.isFresh { parts.append("forecast \(w.status)") }
        return parts.joined(separator: ", ")
    }

    /// Compact figures for the header row: every unknown value reads "unknown".
    public static func weatherFigures(_ w: TodayWeather) -> String {
        func deg(_ v: Double?) -> String { v.map { "\(Int($0.rounded()))°" } ?? "unknown" }
        var s = "\(deg(w.morningTempC)) → \(deg(w.peakTempC))"
        s += " · rain " + (w.precipitationProbability.map { "\(Int(($0 * 100).rounded()))%" } ?? "unknown")
        if let mm = w.rainAmountMm, mm > 0 { s += " (\(mm.formatted(.number.precision(.fractionLength(0...1)))) mm)" }
        s += " · wind " + (w.windKph.map { "\(Int($0.rounded())) km/h" } ?? "unknown")
        if let g = w.gustKph { s += ", gusts \(Int(g.rounded()))" }
        return s
    }
}
