import Foundation

/// The owner's decision for a structured fact whose profile passage changed. These are the
/// three decisions the backend accepts (`keep`, `replace`, `retire`); which apply to which
/// kind of fact is the backend's rule, mirrored here only so impossible buttons are not shown.
public enum StyleFactChoice: Sendable, Equatable {
    case keep
    case retire
    case replaceMeasurement(value: Double, unit: StyleFactResolution.MeasurementValue.Unit)
    case replaceSize(label: String)

    public enum Kind: String, Sendable, CaseIterable, Identifiable {
        case keep, replace, retire
        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .keep: return "Keep as it was"
            case .replace: return "Replace with a new value"
            case .retire: return "Retire"
            }
        }

        var pastTense: String {
            switch self {
            case .keep: return "Kept"
            case .replace: return "Replaced"
            case .retire: return "Retired"
            }
        }

        /// A measurement stays a dated fact (keep or replace). Replacing a rule needs its
        /// machine parameters, which are not typed on the phone: that goes through Conversation.
        public static func allowed(for kind: StyleFactRef.Kind) -> [Kind] {
            switch kind {
            case .measurement: return [.keep, .replace]
            case .sizeExperience: return [.keep, .replace, .retire]
            case .rule: return [.keep, .retire]
            case .unknown: return []
            }
        }
    }

    public var kind: Kind {
        switch self {
        case .keep: return .keep
        case .retire: return .retire
        case .replaceMeasurement, .replaceSize: return .replace
        }
    }

    func resolution(quote: String?) -> StyleFactResolution {
        switch self {
        case .keep: return StyleFactResolution(action: .keep, quote: quote)
        case .retire: return StyleFactResolution(action: .retire)
        case .replaceMeasurement(let value, let unit):
            return StyleFactResolution(action: .replace, quote: quote, measurement: .init(value: value, unit: unit))
        case .replaceSize(let label):
            return StyleFactResolution(action: .replace, quote: quote, sizeExperience: .init(sizeLabel: label))
        }
    }
}

/// One affected fact as My style shows it for a decision: either from the preview of a save
/// that has not happened yet, or an open conflict an earlier save left.
public struct StyleFactQuestion: Sendable, Equatable, Identifiable {
    public var fact: StyleFactRef
    public var label: String
    public var reasonLine: String
    public var previousQuotes: [String]
    /// The owner's new wording at that place, verbatim.
    public var newWording: String?
    /// Why the edit alone cannot settle it, where the backend says so.
    public var note: String?
    /// Set for a conflict that already exists on the backend.
    public var conflict: StyleFactConflict?

    public var id: String { "\(fact.kind.rawValue):\(fact.id)" }
    public var allowed: [StyleFactChoice.Kind] { StyleFactChoice.Kind.allowed(for: fact.kind) }

    public init(_ c: StyleFactConflict) {
        fact = c.fact; label = c.label; previousQuotes = c.previousPassages.map(\.quote); newWording = c.candidateText; note = nil; conflict = c
        reasonLine = StyleFactPhrases.reason(c.reason.rawValue)
    }

    public init(_ c: StyleFactDiff.ConflictsItem) {
        fact = c.fact; label = c.label; previousQuotes = c.previousPassages.map(\.quote); newWording = c.candidateText; note = c.note; conflict = nil
        reasonLine = StyleFactPhrases.reason(c.reason.rawValue)
    }
}

/// A decision the owner has made in the save preview, sent with the save.
public struct StyleFactDecision: Sendable, Equatable {
    public var choice: StyleFactChoice
    public var quoteNewWording: Bool
    public init(_ choice: StyleFactChoice, quoteNewWording: Bool = false) { self.choice = choice; self.quoteNewWording = quoteNewWording }
}

/// The edited text and what saving it would do, as the backend derived it (nothing written yet).
public struct StyleSavePreview: Sendable, Equatable {
    public var content: String
    public var diff: StyleFactDiff
    public var questions: [StyleFactQuestion] { diff.conflicts.map(StyleFactQuestion.init) }
}

/// Wording for the structured facts of My style and for an item's measurements.
public enum StyleFactPhrases {
    public static func reason(_ raw: String) -> String {
        switch raw {
        case "passage_removed": return "The passage this came from is no longer in the profile."
        case "passage_changed": return "The passage this came from was reworded."
        default: return "The passage this came from changed."
        }
    }

    /// One sentence for what saving would do, before anything is written.
    public static func previewSummary(_ diff: StyleFactDiff) -> String {
        guard diff.contentChanged else { return "The text is unchanged." }
        guard !diff.conflicts.isEmpty else { return "No rule, measurement or size experience is affected by this edit." }
        return "This edit touches the passage behind \(Phrases.count(diff.conflicts.count, "fact")). Decide now, or save and decide later; undecided facts stay in force."
    }

    public static func kind(_ kind: StyleFactRef.Kind) -> String {
        switch kind {
        case .rule: return "Rule"
        case .measurement: return "Measurement"
        case .sizeExperience: return "Size experience"
        case .unknown: return "Fact"
        }
    }

    public static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e9 ? String(Int(value)) : String(value)
    }

    public static func unit(_ unit: Measurement.Unit) -> String {
        switch unit {
        case .in: return "in"
        case .cm: return "cm"
        case .m: return "m"
        case .ukShoe: return "UK shoe size"
        case .other, .unknown: return ""
        }
    }

    /// `Half chest: a little over 22 in` with the convention, date and source on a second line.
    public static func measurement(_ m: Measurement) -> (label: String, value: String, note: String) {
        let label = m.key.replacingOccurrences(of: "_", with: " ").capitalizedFirst
        let value = [m.qualifier, number(m.value), unit(m.unit)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        var notes: [String] = []
        if let convention = m.convention, !convention.isEmpty { notes.append(convention) }
        if let date = m.measuredOn { notes.append("measured \(Phrases.dayMonth(date))") }
        notes.append("source: \(m.source.kind.rawValue.replacingOccurrences(of: "_", with: " "))")
        return (label, value, notes.joined(separator: " · ").capitalizedFirst)
    }

    /// One sentence for what a confirmed save did to the structured facts.
    public static func summary(_ diff: StyleFactDiff) -> String {
        guard diff.contentChanged else { return "The text is unchanged." }
        guard diff.anchoredFacts > 0 else { return "No rule, measurement or size experience quotes the profile, so none was affected." }
        var parts = ["\(Phrases.count(diff.unchanged, "fact")) of \(diff.anchoredFacts) still \(diff.unchanged == 1 ? "matches" : "match") the text"]
        if !diff.applied.isEmpty { parts.append("\(Phrases.count(diff.applied.count, "decision")) applied") }
        if !diff.conflicts.isEmpty { parts.append("\(Phrases.count(diff.conflicts.count, "fact")) \(diff.conflicts.count == 1 ? "needs" : "need") your decision and \(diff.conflicts.count == 1 ? "stays" : "stay") in force until then") }
        return Phrases.list(parts).capitalizedFirst + "."
    }
}
