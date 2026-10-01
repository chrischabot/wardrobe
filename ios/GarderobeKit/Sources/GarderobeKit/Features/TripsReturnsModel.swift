import Foundation
import Observation

/// Trips and packing. A proposal is what the backend suggests packing; Packed is the owner's
/// statement of what physically went into the bag. The two are kept and shown separately, and
/// the trip page with its list and combinations is cached for use without a connection.
@MainActor
@Observable
public final class TripsModel {
    /// The form for a new trip. An ordinary sentence ("Three days in Paris, one dinner,
    /// carry-on only") goes to Conversation instead; this form is the direct route.
    public struct TripDraft: Sendable, Equatable {
        public var name = ""
        public var departsOn: LocalDate
        public var returnsOn: LocalDate
        public var destinationLabel = ""
        public var destinationTimezone: String
        public var occasions: [(label: String, localDate: LocalDate, evening: Bool)] = []
        public var luggageLabel = ""
        public var luggageMaxPieces: Int?
        public var laundryDates: [LocalDate] = []

        public static func == (a: TripDraft, b: TripDraft) -> Bool {
            a.name == b.name && a.departsOn == b.departsOn && a.returnsOn == b.returnsOn && a.destinationLabel == b.destinationLabel
                && a.destinationTimezone == b.destinationTimezone && a.luggageLabel == b.luggageLabel && a.luggageMaxPieces == b.luggageMaxPieces
                && a.laundryDates == b.laundryDates && a.occasions.map { "\($0.label)|\($0.localDate)|\($0.evening)" } == b.occasions.map { "\($0.label)|\($0.localDate)|\($0.evening)" }
        }

        /// Why the draft cannot be sent yet, or nil when it can.
        public var problem: String? {
            if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Give the trip a name." }
            if destinationLabel.trimmingCharacters(in: .whitespaces).isEmpty { return "Add where you are going." }
            if TimeZone(identifier: destinationTimezone) == nil { return "Choose the destination's timezone." }
            if returnsOn < departsOn { return "The return date is before the departure date." }
            return nil
        }
    }

    public let environment: AppEnvironment
    public let trips: Resource<TripList>
    public private(set) var lastOutcome: SubmissionOutcome?
    public private(set) var isWorking = false
    /// The outcome of the last packing-proposal request, when it did not produce a proposal.
    public private(set) var proposalNote: String?

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        trips = environment.resource("trips") { try await api.trips() }
    }

    public func open() async {
        trips.loadCached()
        await trips.refresh()
    }

    public var activeTrips: [Trip] { (trips.value?.trips ?? []).filter { $0.status != .cancelled }.sorted { $0.departsOn < $1.departsOn } }
    public func trip(_ id: String) -> Trip? { trips.value?.trips.first { $0.tripId == id } }

    public func newDraft() -> TripDraft {
        TripDraft(departsOn: Dates.adding(days: 7, to: environment.today), returnsOn: Dates.adding(days: 10, to: environment.today), destinationTimezone: environment.timeZone.identifier)
    }

    public func datesLine(_ trip: Trip) -> String {
        "\(Phrases.dayMonth(trip.departsOn)) to \(Phrases.dayMonth(trip.returnsOn)) · \(Phrases.list(trip.destinations.map(\.label)))"
    }

    /// What is physically in the bag, from the stock ledger: never inferred from the proposal.
    public func packedLine(_ trip: Trip) -> String {
        let clean = trip.packed.reduce(0) { $0 + $1.clean }, worn = trip.packed.reduce(0) { $0 + $1.worn }
        if clean + worn == 0 { return trip.proposal == nil ? "Nothing packed yet." : "Nothing packed yet. The list below is a proposal." }
        return worn == 0 ? "\(Phrases.count(clean, "item")) packed." : "\(Phrases.count(clean + worn, "item")) packed, \(worn) worn on the trip."
    }

    /// Proposed items with how many of each are actually packed.
    public func packingRows(_ trip: Trip) -> [(item: PackingItem, packed: Int)] {
        (trip.proposal?.items ?? []).map { item in
            let packed = trip.packed.first { $0.garmentId == item.garmentId }.map { $0.clean + $0.worn } ?? 0
            return (item, packed)
        }
    }

    private func submit(_ draft: CommandDraft) async -> SubmissionOutcome {
        isWorking = true
        defer { isWorking = false }
        let outcome = await environment.center.submit(draft)
        lastOutcome = outcome
        if case .confirmed = outcome { await trips.refresh() }
        return outcome
    }

    @discardableResult
    public func create(_ draft: TripDraft) async -> SubmissionOutcome? {
        guard draft.problem == nil else { return nil }
        let payload = CommandTripCreate(
            name: draft.name.trimmingCharacters(in: .whitespaces),
            departsOn: draft.departsOn, returnsOn: draft.returnsOn,
            destinations: [TripDestination(label: draft.destinationLabel.trimmingCharacters(in: .whitespaces), timezone: draft.destinationTimezone, from: draft.departsOn, to: draft.returnsOn)],
            occasions: draft.occasions.isEmpty ? nil : draft.occasions.map { TripOccasionInput(localDate: $0.localDate, label: $0.label, segment: $0.evening ? .evening : .day) },
            luggage: draft.luggageLabel.isEmpty ? nil : .init(label: draft.luggageLabel, maxPieces: draft.luggageMaxPieces),
            laundry: draft.laundryDates.isEmpty ? nil : draft.laundryDates.map { .init(localDate: $0) },
            source: SourceRef(kind: .ownerStatement))
        return await submit(CommandDraft(payload, label: "Created trip: \(draft.name)"))
    }

    @discardableResult
    public func cancel(_ trip: Trip) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandTripCancel(tripId: trip.tripId), label: "Cancelled trip: \(trip.name)", expectedVersions: ["trip:\(trip.tripId)": trip.version]))
    }

    /// Asks the backend to compose a packing proposal for the trip (taste profile, destination
    /// weather, the trip's wearing days). Needs a connection; nothing is packed by this.
    public func proposePacking(_ trip: Trip) async {
        isWorking = true
        defer { isWorking = false }
        proposalNote = nil
        do {
            _ = try await environment.api.proposePacking(tripId: trip.tripId, clientRequestId: environment.ids.next("packing"))
            environment.center.noteRead(failure: nil)
            await trips.refresh()
        } catch let failure as APIFailure {
            proposalNote = failure.isTransport ? "Offline. A packing proposal needs a connection." : failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            proposalNote = "The proposal could not be requested."
        }
    }

    /// Packed: the owner states these quantities are in the bag. Establishes the trip location.
    @discardableResult
    public func packed(_ trip: Trip, items: [(garmentId: String, quantity: Int)]) async -> SubmissionOutcome? {
        let lines = items.filter { $0.quantity > 0 }
        guard !lines.isEmpty else { return nil }
        let payload = CommandStockPack(tripId: trip.tripId, items: lines.map { .init(garmentId: $0.garmentId, quantity: $0.quantity) })
        return await submit(CommandDraft(payload, label: "Packed \(Phrases.count(lines.reduce(0) { $0 + $1.quantity }, "item")) for \(trip.name)"))
    }

    /// Packs everything the proposal lists that is not packed yet.
    @discardableResult
    public func packedProposal(_ trip: Trip) async -> SubmissionOutcome? {
        await packed(trip, items: packingRows(trip).map { ($0.item.garmentId, max(0, $0.item.quantity - $0.packed)) })
    }

    /// Unpacked: the clothes are home again. This does not declare them clean; a wash report or
    /// the next care cycle does that.
    @discardableResult
    public func unpacked(_ trip: Trip) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandStockUnpack(tripId: trip.tripId), label: "Unpacked from \(trip.name)"))
    }

    /// Records a wear on the trip; the backend applies it to the packed subset.
    @discardableResult
    public func wore(_ trip: Trip, day: PackingDayPlan) async -> SubmissionOutcome {
        let ids = day.slots.map(\.garmentId)
        let timezone = trip.destinations.first { $0.from <= day.localDate && day.localDate <= $0.to }?.timezone ?? trip.destinations.first?.timezone
        let payload = CommandWearRecord(wearingDate: day.localDate, garmentIds: ids, timezone: timezone, segment: day.segment.rawValue, tripId: trip.tripId)
        return await submit(CommandDraft(payload, label: "Wore the \(Phrases.dayMonth(day.localDate)) outfit on \(trip.name)"))
    }

    public var freshnessLine: String {
        trips.freshness.statement(subject: "trips", now: environment.time.now(), timeZone: environment.timeZone)
    }
}

/// Return and exchange deadlines. A deadline is shown only when the backend established one
/// from sourced terms; otherwise it is shown as unresolved, never as a guessed countdown.
@MainActor
@Observable
public final class ReturnsModel {
    public let environment: AppEnvironment
    public let returns: Resource<ReturnList>
    public private(set) var lastOutcome: SubmissionOutcome?

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        returns = environment.resource("returns") { try await api.returns() }
    }

    public func open() async {
        returns.loadCached()
        await returns.refresh()
    }

    static let closedStates: Set<String> = ["refunded", "exchanged", "kept", "cancelled", "closed", "completed"]

    /// Open cases, the soonest established deadline first; unresolved deadlines after them.
    public var openCases: [ReturnCase] {
        (returns.value?.returns ?? []).filter { !ReturnsModel.closedStates.contains($0.state.rawValue) }.sorted { a, b in
            switch (a.deadline.localDate, b.deadline.localDate) {
            case let (x?, y?): return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return a.createdAt < b.createdAt
            }
        }
    }

    public func cases(forGarment garmentId: String) -> [ReturnCase] { (returns.value?.returns ?? []).filter { $0.garmentId == garmentId } }

    /// The deadline sentence. An unresolved deadline says so, with the backend's reason.
    public func deadlineLine(_ c: ReturnCase) -> String {
        guard c.deadline.status == .established, let date = c.deadline.localDate else {
            return "Deadline not established. " + (c.deadline.reason ?? "The return terms are still being checked.")
        }
        let what: String
        switch c.deadline.concerns {
        case .request: what = "Request the \(c.kind == .exchange ? "exchange" : "return") by"
        case .post: what = "Post it by"
        case .retailerReceipt: what = "It must reach the retailer by"
        default: what = "Deadline"
        }
        let days = Dates.days(from: environment.today, to: date) ?? 0
        let remaining: String
        switch days {
        case ..<0: remaining = "passed \(Phrases.count(-days, "day")) ago"
        case 0: remaining = "today"
        case 1: remaining = "tomorrow"
        default: remaining = "\(days) days left"
        }
        let zone = c.deadline.timezone.map { " (\($0))" } ?? ""
        return "\(what) \(Phrases.dayMonth(date))\(zone): \(remaining)."
    }

    /// Where the terms came from and when they were checked.
    public func termsLine(_ c: ReturnCase) -> String? {
        guard let terms = c.terms else { return nil }
        return "\(terms.windowDays)-day window from \(terms.triggerEvent.rawValue); source \(terms.sourceRef), checked \(Phrases.dayMonth(terms.checkedOn))."
    }

    public func refundLine(_ c: ReturnCase) -> String? {
        func money(_ minor: Int) -> String { String(format: "%.2f", Double(minor) / 100) + (c.refund.currency.map { " \($0)" } ?? "") }
        switch c.refund.state {
        case .none: return c.refund.expectedMinor.map { "Refund expected: \(money($0))." }
        case .partial: return "Refund received so far: \(money(c.refund.receivedMinor))" + (c.refund.expectedMinor.map { " of \(money($0))." } ?? ".")
        case .full: return "Refund received: \(money(c.refund.receivedMinor))."
        case .over: return "Refund received: \(money(c.refund.receivedMinor)), more than expected."
        case .unknown: return nil
        }
    }

    /// Drafting or requesting a return does not remove stock; only physical departure does.
    public func stockLine(_ c: ReturnCase) -> String {
        c.stockDeparted ? "The item has left your wardrobe." : "The item is still in your wardrobe until it physically leaves."
    }

    private func submit(_ draft: CommandDraft) async -> SubmissionOutcome {
        let outcome = await environment.center.submit(draft)
        lastOutcome = outcome
        if case .confirmed = outcome { await returns.refresh() }
        return outcome
    }

    /// Starts tracking a return or exchange for a garment. No deadline is invented: the backend
    /// establishes one only from sourced terms.
    @discardableResult
    public func open(kind: CommandReturnOpenCase.Kind, garmentId: String, garmentName: String, reason: String? = nil) async -> SubmissionOutcome {
        let payload = CommandReturnOpenCase(kind: kind, garmentId: garmentId, timezone: environment.timeZone.identifier, reason: reason)
        return await submit(CommandDraft(payload, label: "\(kind == .exchange ? "Exchange" : "Return") opened for \(garmentName)"))
    }

    /// Moves a case to the state the owner reports (requested, posted, kept...).
    @discardableResult
    public func update(_ c: ReturnCase, state: ReturnCaseState, shipmentRef: String? = nil) async -> SubmissionOutcome {
        let payload = CommandReturnUpdateCase(caseId: c.caseId, state: state, shipmentRef: shipmentRef.map { .value($0) })
        return await submit(CommandDraft(payload, label: "Return updated: \(state.rawValue.replacingOccurrences(of: "_", with: " "))", expectedVersions: ["return_case:\(c.caseId)": c.version]))
    }

    public var freshnessLine: String {
        returns.freshness.statement(subject: "returns", now: environment.time.now(), timeZone: environment.timeZone)
    }
}
