import Foundation

/// Owner-facing wording that is derived from backend facts. Nothing here decides anything:
/// these functions only name what the backend returned, so VoiceOver, the visible text and
/// the tests all read the same sentences.
public enum Phrases {
    static let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    static let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    /// `07:02` in the given timezone.
    public static func clock(_ date: Date, timeZone: TimeZone) -> String {
        let c = Dates.calendar(timeZone).dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// `today at 07:02`, `yesterday at 21:40`, `12 September at 08:15`.
    public static func relativeTime(_ date: Date, now: Date, timeZone: TimeZone) -> String {
        let day = Dates.localDate(of: date, in: timeZone)
        let today = Dates.localDate(of: now, in: timeZone)
        let time = clock(date, timeZone: timeZone)
        switch Dates.days(from: day, to: today) {
        case 0: return "today at \(time)"
        case 1: return "yesterday at \(time)"
        default: return "\(dayMonth(day)) at \(time)"
        }
    }

    /// `15 September`.
    public static func dayMonth(_ localDate: LocalDate) -> String {
        guard Dates.isLocalDate(localDate), let m = Int(localDate.dropFirst(5).prefix(2)), let d = Int(localDate.suffix(2)), (1...12).contains(m) else { return localDate }
        return "\(d) \(months[m - 1])"
    }

    /// `Tuesday 15 September`.
    public static func weekdayDayMonth(_ localDate: LocalDate) -> String {
        guard let noon = Dates.noon(of: localDate, in: Dates.utc) else { return localDate }
        let weekday = Dates.calendar(Dates.utc).component(.weekday, from: noon)
        return "\(weekdays[(weekday - 1) % 7]) \(dayMonth(localDate))"
    }

    /// `today`, `yesterday`, `3 days ago`, `in 2 days`, or the date when further away.
    public static func relativeDay(_ localDate: LocalDate, today: LocalDate) -> String {
        guard let delta = Dates.days(from: localDate, to: today) else { return localDate }
        switch delta {
        case 0: return "today"
        case 1: return "yesterday"
        case -1: return "tomorrow"
        case 2...13: return "\(delta) days ago"
        case -13 ... -2: return "in \(-delta) days"
        default: return dayMonth(localDate)
        }
    }

    /// `a, b and c`.
    public static func list(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        default: return items.dropLast().joined(separator: ", ") + " and " + items[items.count - 1]
        }
    }

    public static func count(_ n: Int, _ singular: String, _ plural: String? = nil) -> String {
        "\(n) \(n == 1 ? singular : (plural ?? singular + "s"))"
    }

    // MARK: Roles, buckets, availability

    public static func role(_ role: Role) -> String {
        switch role {
        case .top: return "Top"
        case .midLayer: return "Layer"
        case .bottom: return "Bottom"
        case .outer: return "Outer layer"
        case .footwear: return "Footwear"
        case .socks: return "Socks"
        case .belt: return "Belt"
        case .neckwear: return "Neckwear"
        case .accessory: return "Accessory"
        case .onePiece: return "One-piece"
        case .unknown: return "Other"
        }
    }

    public static func category(_ category: Category) -> String {
        switch category {
        case .pocketSquare: return "Pocket squares"
        case .onePiece: return "One-pieces"
        case .knitwear: return "Knitwear"
        case .outerwear: return "Outerwear"
        case .footwear: return "Footwear"
        case .socks: return "Socks"
        case .trousers: return "Trousers"
        case .unknown, .other: return "Other"
        default: return category.rawValue.capitalizedFirst + "s"
        }
    }

    public static func bucket(_ bucket: Bucket) -> String {
        switch bucket {
        case .incoming: return "On its way"
        case .clean: return "Clean at home"
        case .dirty: return "In the wash"
        case .service: return "At the laundry"
        case .storage: return "In storage"
        case .tailor: return "At the tailor"
        case .trip: return "Packed for a trip"
        case .gone: return "No longer owned"
        case .unknown: return "Elsewhere"
        }
    }

    /// The familiar one-line status of a garment ("At the tailor", "For sale"), from its
    /// availability reasons as the backend computed them.
    public static func status(of availability: GarmentAvailability?, acquisition: Acquisition) -> String {
        if acquisition == .incoming { return "On its way" }
        if acquisition == .disposed { return "No longer owned" }
        guard let a = availability else { return "Status not loaded" }
        // The most specific fact wins, whatever order the backend lists the reasons in.
        let specific: [(AvailabilityReason, String)] = [
            (.atTailor, "At the tailor"), (.inStorage, "In storage"), (.onTrip, "Packed for a trip"), (.laundryException, "Still away at the laundry"),
            (.inServiceBatch, "At the laundry"), (.observedDirty, "In the wash"), (.restricted, "Not for wearing right now"),
            (.planningExcluded, "Kept out of suggestions"), (.notOwnedYet, "On its way"), (.noUnitsAtHome, "None clean at home"),
        ]
        if let match = specific.first(where: { a.reasons.contains($0.0) }) { return match.1 }
        switch a.status {
        case .available: return "Available"
        case .estimated: return "Probably available"
        case .conditional: return "Available on request"
        case .unavailable: return "Not available"
        case .unknown: return "Status not recognised by this version"
        }
    }

    public static func reason(_ reason: AvailabilityReason) -> String {
        switch reason {
        case .notOwnedYet: return "Ordered; arrival not recorded"
        case .disposed: return "No longer owned"
        case .merged: return "Merged into another entry"
        case .noUnitsAtHome: return "Nothing clean at home"
        case .restricted: return "Under a restriction"
        case .inStorage: return "In storage"
        case .atTailor: return "At the tailor"
        case .onTrip: return "Packed for a trip"
        case .planningExcluded: return "Kept out of suggestions"
        case .planningOccasional: return "Suggested only on request"
        case .indoorOnly: return "Indoor only"
        case .observedDirty: return "Reported in the wash"
        case .inServiceBatch: return "Away with the laundry service"
        case .laundryException: return "Reported still away"
        case .estimatedPossiblyWorn: return "May have been worn since the last laundry reset (estimate)"
        case .importCleanlinessUnverified: return "Cleanliness not yet observed since import (estimate)"
        case .unknown: return "A reason this version does not recognise"
        }
    }

    /// The wear-count line. A zero count means unlogged, never unworn (owner profile, section 11).
    public static func wearCount(_ count: Int, last: LocalDate?, loggingSince: LocalDate?, today: LocalDate) -> String {
        if count == 0 {
            if let since = loggingSince { return "No wears logged since logging began on \(dayMonth(since)). Not a sign it is unworn." }
            return "No wears logged. Not a sign it is unworn."
        }
        let base = Phrases.count(count, "logged wear")
        if let last { return "\(base), last \(relativeDay(last, today: today))" }
        return base
    }

    // MARK: Receipts

    public static func receiptOutcome(_ receipt: CommandReceipt) -> String {
        switch receipt.outcome {
        case .committed: return receipt.replayed ? "Already recorded" : "Recorded"
        case .merged: return "Already recorded; merged"
        case .noop: return "Nothing to change"
        case .unknown: return "Recorded"
        }
    }

    /// What the receipt says about effects outside the app (Calendar), and whether undo reaches them.
    public static func externalEffect(_ receipt: CommandReceipt) -> String? {
        switch receipt.externalEffectState {
        case .none: return nil
        case .projectionPending: return "Calendar has not been updated yet."
        case .projected: return "Calendar has been updated."
        case .unknown: return nil
        }
    }

    public static func undoLine(_ receipt: CommandReceipt) -> String {
        if receipt.undo.available {
            return receipt.externalEffectState == .projected ? "Undo will also correct the Calendar event." : "Can be undone."
        }
        return receipt.undo.reason ?? "Cannot be undone."
    }
}
