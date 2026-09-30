import Foundation
import Observation

public struct TodaySnapshot: Codable, Sendable, Hashable {
    public var response: TodayResponse
    /// When this board was last confirmed by the backend.
    public var checkedAt: Date
}

/// Morning-local choices that persist across launches: comparison mode, shoe per option, swaps.
struct TodayPreferences: Codable, Sendable {
    var mode: TodayViewModel.Mode = .carousel
    var boardKey: String?
    var footwear: [String: String] = [:]
    var swaps: [String: [String: String]] = [:]
    var currentOptionId: String?
}

public enum ActionResult: Sendable, Equatable {
    case done(CommandReceipt)
    case queued(PendingCommand)
    /// The option offers two shoes: pick one first so the wear never logs both.
    case needsFootwear([Piece])
    case refused(String)

    init(_ outcome: SubmitOutcome) {
        switch outcome {
        case .receipt(let r): self = r.outcome.didCommit ? .done(r) : .refused(r.error?.message ?? r.summary)
        case .queued(let p): self = .queued(p)
        case .failed(let p): self = .refused(p.stateLabel)
        }
    }
}

/// A day's record once a wear exists: the chosen outfit becomes the day's record (spec section 3).
public struct DayRecord: Sendable, Hashable {
    public var names: [String]
    public var synced: Bool
    public var stateLabel: String?
}

@MainActor
@Observable
public final class TodayViewModel {
    public enum Mode: String, Codable, Sendable { case carousel, list }

    public enum Freshness: Equatable, Sendable {
        case none
        /// Confirmed by the backend during this session.
        case current(checkedAt: Date)
        /// Shown from the phone's cache; not re-verified yet (or could not be).
        case cached(checkedAt: Date, offline: Bool, failed: Bool)
    }

    public private(set) var snapshot: TodaySnapshot?
    public private(set) var isRefreshing = false
    public private(set) var lastError: APIError?
    public private(set) var verifiedThisSession = false
    public var mode: Mode = .carousel { didSet { savePrefs() } }
    public var currentOptionId: String? { didSet { savePrefs() } }
    public private(set) var footwear: [String: String] = [:]
    public private(set) var swaps: [String: [String: String]] = [:]

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let queue: CommandQueue
    @ObservationIgnored private let lookup: @MainActor () -> [String: Garment]

    public init(env: AppEnvironment, queue: CommandQueue, garmentLookup: @escaping @MainActor () -> [String: Garment] = { [:] }) {
        self.env = env
        self.queue = queue
        self.lookup = garmentLookup
        loadCached()
    }

    /// Cached board shown immediately, without waiting for the network (spec: cached Today < 1 s).
    public func loadCached() {
        snapshot = env.store.load(TodaySnapshot.self, StoreKey.today)
        let prefs = env.store.load(TodayPreferences.self, StoreKey.todayPreferences) ?? TodayPreferences()
        mode = prefs.mode
        if prefs.boardKey == boardKey {
            footwear = prefs.footwear
            swaps = prefs.swaps
            currentOptionId = prefs.currentOptionId
        }
    }

    private var boardKey: String? {
        guard let b = snapshot?.response.board else { return nil }
        return "\(b.boardId)@\(b.boardDate.rawValue)"
    }

    /// Refresh validity. Failure keeps the existing board and layout stable.
    public func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let response = try await env.api.today()
            let previousKey = boardKey
            snapshot = TodaySnapshot(response: response, checkedAt: env.now())
            env.store.save(snapshot, StoreKey.today)
            lastError = nil
            verifiedThisSession = true
            if let previousKey, previousKey != boardKey {
                // A different day's board: morning-local choices belonged to the old one. A new
                // revision of the same board keeps its ID, so shoes and swaps survive revalidation.
                footwear = [:]
                swaps = [:]
            }
            if let selection = response.selection, let shoe = selection.footwearGarmentId, footwear[selection.optionId] == nil {
                footwear[selection.optionId] = shoe
            }
            keepPositionStable()
            savePrefs()
        } catch let e as APIError {
            lastError = e
        } catch {
            lastError = .interrupted(String(describing: error))
        }
    }

    /// When a new revision arrives, stay on the same option (by ID) or the same position.
    private func keepPositionStable() {
        let options = offerable
        guard !options.isEmpty else { currentOptionId = nil; return }
        if let id = currentOptionId, options.contains(where: { $0.optionId == id }) { return }
        currentOptionId = options.first?.optionId
    }

    // MARK: Derived presentation

    public var response: TodayResponse? { snapshot?.response }
    var offerable: [OutfitOption] { (response?.board?.options ?? []).filter(\.isOfferable).sorted { $0.position < $1.position } }

    public var garments: [String: Garment] {
        var map = lookup()
        for g in response?.garments ?? [] { map[g.garmentId] = g }
        return map
    }

    public var cards: [BoardCard] {
        guard let board = response?.board else { return [] }
        let map = garments
        let options = offerable
        return options.map {
            BoardLayout.card(
                for: $0, count: options.count, boardRevision: board.currentRevision, garments: map, footwearSelection: footwear[$0.optionId],
                swaps: swaps[$0.optionId] ?? [:], chosen: response?.selection?.optionId == $0.optionId && response?.selection?.status == "active",
                document: board.document?.option($0.optionId)
            )
        }
    }

    public func card(_ optionId: String) -> BoardCard? { cards.first { $0.optionId == optionId } }

    public var dayLine: String? { response.map { DayLine.text(for: $0, timeZone: env.timeZone) } }
    public var weather: TodayWeather? { response?.weather }
    /// The board document's own weather line, when the daily service wrote one.
    public var weatherLine: String? { response?.weatherLine }
    /// "Trip day · <trip> · day n of m" on a trip-day board; nil at home.
    public var tripLine: String? { response?.tripLine }
    public var isTripDay: Bool { response?.isTripDay ?? false }
    public var shortfall: String? { response?.shortfall }

    /// A failed calendar connection leaves Today available; it only earns a quiet note.
    public var calendarNote: String? {
        if let status = response?.calendarStatus {
            return status == "read" || status == "empty" ? nil : "Calendar not checked: this board was made without it."
        }
        guard let c = response?.sources.first(where: { $0.source == "calendar" }), c.status != "fresh" else { return nil }
        return "Calendar not checked: this board was made without it."
    }

    public var freshness: Freshness {
        guard let s = snapshot else { return .none }
        if verifiedThisSession && lastError == nil { return .current(checkedAt: s.checkedAt) }
        return .cached(checkedAt: s.checkedAt, offline: lastError == .offline || queue.connectivity == .offline, failed: lastError != nil && lastError != .offline)
    }

    /// Never describes stale inventory as freshly verified.
    public var freshnessLabel: String {
        switch freshness {
        case .none: return isRefreshing ? "Loading today's board…" : "No board on this phone yet"
        case .current(let at): return "Checked \(FreshnessText.checked(at, now: env.now(), timeZone: env.timeZone))"
        case .cached(let at, let offline, let failed):
            let t = FreshnessText.checked(at, now: env.now(), timeZone: env.timeZone)
            if offline { return "Offline · last checked \(t)" }
            if failed { return "Couldn't refresh · last checked \(t)" }
            return isRefreshing ? "Last checked \(t) · refreshing…" : "Last checked \(t)"
        }
    }

    public var pendingForToday: [PendingCommand] {
        guard let date = response?.date else { return [] }
        return queue.pending(forDate: date)
    }

    /// Recorded wears for the day (server), or a wear recorded on this phone still waiting to sync.
    public var dayRecord: DayRecord? {
        guard let r = response else { return nil }
        let map = garments
        let recorded = r.recordedWears.filter { $0.wearingDate == r.date && $0.status == "active" }
        if !recorded.isEmpty { return DayRecord(names: recorded.map { map[$0.garmentId]?.name ?? "An item" }, synced: true, stateLabel: nil) }
        if let p = pendingForToday.last(where: { $0.envelope.command.type == "record_wear" && $0.awaitsDelivery }) {
            let ids = p.envelope.command["items"]?.arrayValue?.compactMap { $0["garmentId"]?.stringValue } ?? []
            return DayRecord(names: ids.map { map[$0]?.name ?? "An item" }, synced: false, stateLabel: p.stateLabel)
        }
        return nil
    }

    // MARK: Actions

    public func selectFootwear(optionId: String, garmentId: String) {
        guard let option = offerable.first(where: { $0.optionId == optionId }), option.footwearSlots.contains(where: { $0.garmentId == garmentId }) else { return }
        footwear[optionId] = garmentId
        savePrefs()
    }

    /// Choose records an intention, not a wear.
    public func choose(_ optionId: String) async -> ActionResult {
        guard let board = response?.board, let card = card(optionId) else { return .refused("That option is no longer on the board") }
        if card.footwear.requiresChoice && !card.footwear.resolved { return .needsFootwear(card.footwear.alternatives) }
        let shoe = card.footwear.requiresChoice ? card.footwear.selectedGarmentId : nil
        let names = card.composition.filter { $0.role != .accessory }.map(\.name)
        let outcome = await queue.submit(
            .selectOption(boardId: board.boardId, optionId: optionId, footwearGarmentId: shoe),
            label: "Chose: " + names.joined(separator: ", "),
            context: .init(boardDate: board.boardDate, optionId: optionId, garmentIds: card.composition.map(\.garmentId))
        )
        let result = ActionResult(outcome)
        if case .done = result { await refresh() }
        return result
    }

    /// I wore this: records the actual outfit, exactly one pair of shoes, including morning swaps.
    public func iWore(_ optionId: String) async -> ActionResult {
        guard let r = response, let card = card(optionId) else { return .refused("That option is no longer on the board") }
        guard let items = card.wearItems else { return .needsFootwear(card.footwear.alternatives) }
        // A second tap while the first is still on its way must not submit another observation.
        if let existing = pendingForToday.first(where: { $0.envelope.command.type == "record_wear" && $0.context.optionId == optionId && $0.awaitsDelivery }) {
            return .queued(existing)
        }
        let outcome = await queue.submit(
            .recordWear(wearingDate: r.date, timezone: r.timezone, occurredAt: env.now(), items: items, optionId: optionId),
            label: "I wore: " + card.composition.filter { !$0.missing }.map(\.name).joined(separator: ", "),
            context: .init(boardDate: r.date, optionId: optionId, garmentIds: items.map(\.garmentId))
        )
        let result = ActionResult(outcome)
        if case .done = result { await refresh() }
        return result
    }

    public enum SwapList: Sendable, Equatable {
        /// Validated by the backend for this option.
        case verified([SwapCandidates.Candidate])
        /// Offline: same-role pieces the phone last saw as available; the backend has not checked them.
        case unverified([SwapCandidates.Candidate])
    }

    /// Swapping a shirt changes the shirt; it is a swap, not a rebuild.
    public func swapCandidates(optionId: String, role: GarmentRole, cachedWardrobe: [WardrobeItem]) async -> SwapList {
        do {
            return .verified(try await env.api.swapCandidates(optionId: optionId, role: role).candidates)
        } catch {
            let inOption = Set(offerable.first { $0.optionId == optionId }?.slots.map(\.garmentId) ?? [])
            let local = cachedWardrobe
                .filter { $0.garment.roles.contains(role) && $0.availability.available && $0.garment.planningPolicy == .normal && !inOption.contains($0.garment.garmentId) }
                .map { SwapCandidates.Candidate(garmentId: $0.garment.garmentId, name: $0.garment.name, reason: "Last seen available; not checked") }
            return .unverified(local)
        }
    }

    public func applySwap(optionId: String, replacing original: String, with replacement: String) {
        var map = swaps[optionId] ?? [:]
        if original == replacement { map.removeValue(forKey: original) } else { map[original] = replacement }
        swaps[optionId] = map.isEmpty ? nil : map
        savePrefs()
    }

    public func revertSwaps(optionId: String) {
        swaps[optionId] = nil
        savePrefs()
    }

    /// Ask about this: attaches the option's identity (never a guess about which card was visible).
    public func reference(for optionId: String) -> ConversationReference? {
        guard let board = response?.board else { return nil }
        return .option(boardId: board.boardId, optionId: optionId, boardRevision: board.currentRevision)
    }

    private func savePrefs() {
        env.store.save(TodayPreferences(mode: mode, boardKey: boardKey, footwear: footwear, swaps: swaps, currentOptionId: currentOptionId), StoreKey.todayPreferences)
    }
}
