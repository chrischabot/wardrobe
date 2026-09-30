import Foundation
import Observation

public enum StudioMode: String, Codable, Sendable, CaseIterable {
    /// Eligible owned items; the backend validates the finished combination.
    case today
    /// Also seasonal/stored pieces and clearly marked incoming items. Browsing never mutates plans or history.
    case explore
    public var title: String { self == .today ? "For today" : "Explore" }
}

public enum StudioRole: String, Codable, Sendable, CaseIterable, Identifiable {
    case outer, top, bottom, footwear, onePiece, midLayer, socks, belt, accessory
    public var id: String { rawValue }
    public var garmentRole: GarmentRole {
        switch self {
        case .outer: .outerLayer
        case .top: .baseTop
        case .bottom: .bottom
        case .footwear: .footwear
        case .onePiece: .onePiece
        case .midLayer: .midLayer
        case .socks: .socks
        case .belt: .belt
        case .accessory: .accessory
        }
    }
    public var label: String {
        switch self {
        case .outer: "Outer layer"
        case .top: "Top"
        case .bottom: "Bottom"
        case .footwear: "Footwear"
        case .onePiece: "One piece"
        case .midLayer: "Jumper"
        case .socks: "Socks"
        case .belt: "Belt"
        case .accessory: "Scarf or tie"
        }
    }
    /// Separate horizontal selectors for top, bottom, footwear and outer layer (spec section 3).
    public static let primary: [StudioRole] = [.outer, .top, .bottom, .footwear]
    /// Accessories expand when wanted.
    public static let secondary: [StudioRole] = [.midLayer, .socks, .belt, .accessory]
}

public struct StudioState: Codable, Sendable, Hashable {
    public var mode: StudioMode = .today
    public var selection: [StudioRole: String] = [:]
    /// Locked pieces stay fixed; "Find something that works with this" changes only unlocked slots.
    public var locks: Set<StudioRole> = []
    public var accessoriesExpanded = false
    /// Dress / one-piece layout replaces top and bottom.
    public var onePieceLayout = false
    public init() {}
}

@MainActor
@Observable
public final class StudioViewModel {
    public enum Validation: Equatable, Sendable {
        case idle
        case checking
        /// Valid for the mode. `validForDate == false` in Explore means it would not pass as a plan today.
        case valid(Date, validForDate: Bool?, warnings: [StudioIssue])
        case issues([StudioValidation.Issue])
        case unavailable(String)

        init(_ v: StudioValidation) {
            self = v.valid ? .valid(v.checkedAt, validForDate: v.validForDate, warnings: v.warnings) : .issues(v.issues)
        }

        public var isValid: Bool { if case .valid = self { true } else { false } }
    }

    public private(set) var state: StudioState { didSet { env.store.save(state, StoreKey.studio) } }
    /// The combination saved from this Studio session, so "Remove" can take it back.
    public private(set) var lastSavedCombinationId: String?
    public private(set) var validation: Validation = .idle
    public private(set) var suggestionNote: String?
    public private(set) var isSuggesting = false

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let queue: CommandQueue
    @ObservationIgnored private let wardrobe: WardrobeViewModel
    @ObservationIgnored private var validationToken = 0
    @ObservationIgnored private var validationTask: Task<Void, Never>?
    /// Wait this long after the last change before asking the backend (swipes never wait for it).
    @ObservationIgnored public var validationDelay: Duration = .milliseconds(350)

    public init(env: AppEnvironment, queue: CommandQueue, wardrobe: WardrobeViewModel) {
        self.env = env; self.queue = queue; self.wardrobe = wardrobe
        state = env.store.load(StudioState.self, StoreKey.studio) ?? StudioState()
    }

    public var visibleRoles: [StudioRole] {
        var roles = state.onePieceLayout ? [StudioRole.outer, .onePiece, .footwear] : StudioRole.primary
        if state.accessoriesExpanded { roles += StudioRole.secondary }
        return roles
    }

    /// Selector contents. Positioning cached items needs no network or inference.
    public func candidates(for role: StudioRole) -> [WardrobeItem] {
        let r = role.garmentRole
        return wardrobe.allItems.filter { i in
            let g = i.garment
            guard g.roles.contains(r) else { return false }
            switch state.mode {
            case .today: return g.acquisition == .owned && i.availability.available && g.planningPolicy != .excluded
            case .explore: return g.acquisition != .disposed
            }
        }
        .sorted { $0.garment.name < $1.garment.name }
    }

    public func selected(_ role: StudioRole) -> WardrobeItem? { state.selection[role].flatMap(wardrobe.item) }

    /// Marks explore-only pieces so they are never mistaken for today's options.
    public func badge(for item: WardrobeItem) -> String? {
        if item.garment.acquisition == .incoming { return "Incoming" }
        if item.garment.location == .storage { return "In storage" }
        if !item.availability.available { return item.availability.label }
        return nil
    }

    @discardableResult
    public func next(_ role: StudioRole) -> Bool { step(role, by: 1) }
    @discardableResult
    public func previous(_ role: StudioRole) -> Bool { step(role, by: -1) }

    private func step(_ role: StudioRole, by delta: Int) -> Bool {
        guard !state.locks.contains(role) else { return false }
        let list = candidates(for: role)
        guard !list.isEmpty else { return false }
        let current = state.selection[role].flatMap { id in list.firstIndex { $0.garment.garmentId == id } }
        let index = current.map { ($0 + delta + list.count) % list.count } ?? (delta > 0 ? 0 : list.count - 1)
        state.selection[role] = list[index].garment.garmentId
        suggestionNote = nil
        scheduleValidation()
        return true
    }

    @discardableResult
    public func select(_ role: StudioRole, garmentId: String?) -> Bool {
        guard !state.locks.contains(role) else { return false }
        state.selection[role] = garmentId
        scheduleValidation()
        return true
    }

    public func toggleLock(_ role: StudioRole) {
        if state.locks.contains(role) { state.locks.remove(role) } else if state.selection[role] != nil { state.locks.insert(role) }
    }

    public func setMode(_ mode: StudioMode) {
        state.mode = mode
        scheduleValidation()
    }

    public func setAccessoriesExpanded(_ expanded: Bool) { state.accessoriesExpanded = expanded }

    public func setOnePieceLayout(_ on: Bool) {
        state.onePieceLayout = on
        if on { state.selection[.top] = nil; state.selection[.bottom] = nil; state.locks.subtract([.top, .bottom]) } else { state.selection[.onePiece] = nil; state.locks.remove(.onePiece) }
        scheduleValidation()
    }

    /// Open Studio with a composed outfit (a board option), keeping any locked pieces.
    public func start(from card: BoardCard) {
        for piece in card.composition {
            let role: StudioRole? = switch piece.role {
            case .outerLayer: .outer
            case .baseTop: .top
            case .midLayer: .midLayer
            case .bottom: .bottom
            case .onePiece: .onePiece
            case .footwear: .footwear
            case .socks: .socks
            case .belt: .belt
            case .accessory: .accessory
            default: nil
            }
            if let role, !state.locks.contains(role), state.selection[role] == nil || role != .footwear || piece.garmentId == card.footwear.selectedGarmentId || !card.footwear.requiresChoice {
                state.selection[role] = piece.garmentId
            }
        }
        scheduleValidation()
    }

    public var slots: [StudioSlot] {
        visibleRoles.compactMap { role in state.selection[role].map { StudioSlot(garmentId: $0, role: role.garmentRole) } }
    }

    private var today: LocalDate { LocalDate(date: env.now(), timeZone: env.timeZone) }

    // MARK: Backend validation (authoritative; never blocks a swipe)

    public func scheduleValidation() {
        validationTask?.cancel()
        validationToken += 1
        let token = validationToken
        guard !slots.isEmpty else { validation = .idle; return }
        let delay = validationDelay
        let sleep = env.sleep
        validationTask = Task { [weak self] in
            do { try await sleep(delay) } catch { return }
            await self?.validate(token: token)
        }
    }

    public func validateNow() async {
        validationToken += 1
        await validate(token: validationToken)
    }

    private func validate(token: Int) async {
        guard token == validationToken else { return }
        validation = .checking
        let body = StudioValidateRequest(mode: state.mode.rawValue, date: today, slots: slots)
        do {
            let result = try await env.api.validateStudio(body)
            guard token == validationToken else { return } // a newer change superseded this check
            validation = Validation(result)
        } catch {
            guard token == validationToken else { return }
            validation = .unavailable("Not checked: needs a connection")
        }
    }

    /// "Find something that works with this": the backend fills only the unlocked roles.
    public func findSomethingThatWorks() async {
        let locked = state.locks.compactMap { r in state.selection[r].map { StudioValidateRequest.Slot(garmentId: $0, role: r.garmentRole) } }
        let unlocked = visibleRoles.filter { !state.locks.contains($0) }
        guard !unlocked.isEmpty else { suggestionNote = "Everything is locked."; return }
        isSuggesting = true
        defer { isSuggesting = false }
        do {
            let s = try await env.api.suggestStudio(StudioSuggestRequest(mode: state.mode.rawValue, date: today, locked: locked, roles: unlocked.map(\.garmentRole)))
            // found == false: nothing works with the locked pieces; nothing changes, locks included.
            guard s.found != false else {
                suggestionNote = s.explanation.isEmpty ? "Nothing works with the locked pieces." : s.explanation
                validation = Validation(s.validation)
                return
            }
            let lockedIds = Set(locked.map(\.garmentId))
            for role in unlocked {
                if let pick = s.slots.first(where: { $0.role == role.garmentRole && !lockedIds.contains($0.garmentId) }) { state.selection[role] = pick.garmentId }
            }
            suggestionNote = s.explanation
            validation = Validation(s.validation)
        } catch {
            suggestionNote = "Suggestions need a connection. You can still swap by hand."
        }
    }

    // MARK: Three distinct effects

    /// Save combination: keeps the look for later. No plan, no wear.
    public func saveCombination(name: String?) async -> ActionResult {
        guard !slots.isEmpty else { return .refused("Nothing selected") }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let result = ActionResult(await queue.submit(
            .saveCombination(name: trimmed, slots: slots, mode: state.mode.rawValue), label: "Saved combination" + (trimmed.map { ": \($0)" } ?? ""),
            context: .init(garmentIds: slots.map(\.garmentId))
        ))
        if case .done(let r) = result { lastSavedCombinationId = r.facts["combinationId"]?.stringValue }
        return result
    }

    /// Remove the combination just saved (kept as history; undoable from its receipt).
    public func removeLastSaved() async -> ActionResult {
        guard let id = lastSavedCombinationId else { return .refused("Nothing saved in this session") }
        let result = ActionResult(await queue.submit(.removeCombination(combinationId: id), label: "Removed saved combination"))
        if case .done = result { lastSavedCombinationId = nil }
        return result
    }

    /// Plan for a day: an intention for that date. No wear. The server validates it for that day
    /// (422 plan_invalid_for_day), so the refusal reason is shown as the server gives it.
    public func planForDay(_ date: LocalDate) async -> ActionResult {
        guard !slots.isEmpty else { return .refused("Nothing selected") }
        return ActionResult(await queue.submit(.planOutfit(date: date, slots: slots), label: "Planned for \(date.rawValue)", context: .init(boardDate: date, garmentIds: slots.map(\.garmentId))))
    }

    /// Wear this: records an actual wear today with these exact pieces.
    public func wearThis() async -> ActionResult {
        let s = slots
        guard !s.isEmpty else { return .refused("Nothing selected") }
        guard s.filter({ $0.role == .footwear }).count <= 1 else { return .refused("Choose one pair of shoes") }
        let names = s.compactMap { wardrobe.item($0.garmentId)?.garment.name }
        return ActionResult(await queue.submit(
            .recordWear(wearingDate: today, timezone: env.timeZone.identifier, occurredAt: env.now(), items: s.map { WearItem(garmentId: $0.garmentId, role: $0.role) }),
            label: "I wore: " + names.joined(separator: ", "), context: .init(boardDate: today, garmentIds: s.map(\.garmentId))
        ))
    }
}
