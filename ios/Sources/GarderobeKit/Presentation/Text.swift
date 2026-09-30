import Foundation

/// Search over perceptible names, owner aliases, maker names and codes (spec section 3, Wardrobe).
/// "dark jeans", "the wide-stripe shirt" and "PCF4340" all find the right piece.
public enum GarmentSearch {
    static let stopWords: Set<String> = ["the", "a", "an", "my", "with", "and"]

    public static func normalize(_ s: String) -> String {
        let folded = s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_GB"))
        let mapped = folded.map { c -> Character in c.isLetter || c.isNumber ? c : " " }
        return String(mapped).split(separator: " ").joined(separator: " ")
    }

    static func tokens(_ s: String) -> [String] {
        normalize(s).split(separator: " ").map(String.init).filter { !stopWords.contains($0) }
    }

    /// Every query token must prefix-match some token of the item's searchable text
    /// ("wide stripe" matches "Lightweight oxford — light blue wide stripe").
    public static func matches(_ item: WardrobeItem, query: String) -> Bool {
        let q = tokens(query)
        guard !q.isEmpty else { return true }
        let g = item.garment
        let haystack = ([g.name, g.maker, g.productName, g.productCode, g.color, g.colorFamily, g.fabric] + item.aliases.map(\.phrase) + (g.aliases ?? []).map(Optional.some))
            .compactMap { $0 }
            .flatMap(tokens)
        let hyphenJoined = Set(haystack)
        return q.allSatisfy { token in hyphenJoined.contains(token) || haystack.contains { $0.hasPrefix(token) } || joinedMatch(token, haystack) }
    }

    /// "widestripe" or "wide-stripe" style queries against split tokens.
    static func joinedMatch(_ token: String, _ haystack: [String]) -> Bool {
        guard haystack.count > 1 else { return false }
        for i in 0..<(haystack.count - 1) where (haystack[i] + haystack[i + 1]).hasPrefix(token) && token.count > haystack[i].count { return true }
        return false
    }

    /// Rank: exact name/alias first, then a name or alias that starts with the phrase, then others.
    public static func rank(_ items: [WardrobeItem], query: String) -> [WardrobeItem] {
        let n = normalize(query)
        func score(_ i: WardrobeItem) -> Int {
            let phrases = [i.garment.name] + i.aliases.map(\.phrase)
            let normalized = phrases.map(normalize)
            if normalized.contains(n) { return 0 }
            if normalized.contains(where: { $0.hasPrefix(n) }) { return 1 }
            if normalized.contains(where: { $0.contains(" " + n) }) { return 2 }
            return 3
        }
        return items.filter { matches($0, query: query) }.sorted { (score($0), $0.garment.name) < (score($1), $1.garment.name) }
    }
}

public enum QuantityText {
    /// Identical socks are one entry with quantities; never "pair number seven" (spec section 3).
    public static func text(for item: WardrobeItem) -> String? {
        guard item.garment.isAnonymousQuantity || item.stock.totalOwned > 1 else { return nil }
        let noun = item.garment.category == .socks ? (item.stock.totalOwned == 1 ? "pair" : "pairs") : (item.stock.totalOwned == 1 ? "unit" : "units")
        var s = "\(item.stock.totalOwned) \(noun)"
        let clean = item.stock.clean
        if clean != item.stock.totalOwned { s += " · \(clean) clean" }
        return s
    }
}

public enum AccessibilityText {
    /// VoiceOver description of an outfit card: the garments and the day, not "Outfit 3".
    public static func card(_ card: BoardCard) -> String {
        var parts = ["Option \(card.position) of \(card.count)."]
        if card.isChosen { parts.append("Chosen.") }
        parts.append(card.whyItWorks)
        for line in card.lines {
            var s = "\(line.label): \(line.text)"
            if let f = line.flourish { s += ", \(f)" }
            parts.append(s + ".")
        }
        if card.footwear.requiresChoice && !card.footwear.resolved {
            parts.append("Shoes not chosen yet: " + card.footwear.alternatives.map(\.name).joined(separator: " or ") + ".")
        }
        if !card.swappedRoles.isEmpty { parts.append("Includes your swap.") }
        return parts.joined(separator: " ")
    }

    public static func item(_ item: WardrobeItem) -> String {
        var parts = [item.garment.name, item.availability.label]
        if let q = QuantityText.text(for: item) { parts.append(q) }
        if let last = item.lastRecordedWear { parts.append("last recorded wear \(last.rawValue)") }
        return parts.joined(separator: ", ")
    }

    public static func receipt(_ r: CommandReceipt) -> String {
        switch r.outcome {
        case .committed, .merged: return "Done. \(r.summary)"
        case .rejected: return "Not recorded. \(r.error?.message ?? r.summary)"
        case .conflict: return "Not saved because something changed. \(r.error?.message ?? "")"
        default: return r.summary
        }
    }
}

public enum FreshnessText {
    /// "Checked 06:52" style label; stale inventory is never described as freshly verified.
    public static func checked(_ date: Date, now: Date, timeZone: TimeZone) -> String {
        var f = Date.FormatStyle.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)
        f.timeZone = timeZone
        let cal: Calendar = { var c = Calendar(identifier: .gregorian); c.timeZone = timeZone; return c }()
        let time = date.formatted(f.locale(Locale(identifier: "en_GB")))
        if cal.isDate(date, inSameDayAs: now) { return time }
        var d = Date.FormatStyle.dateTime.weekday(.abbreviated).day().month(.abbreviated)
        d.timeZone = timeZone
        return date.formatted(d.locale(Locale(identifier: "en_GB"))) + " " + time
    }
}
