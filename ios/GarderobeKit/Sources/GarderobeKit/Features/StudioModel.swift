import Foundation
import Observation

/// Studio: a composed outfit on a white canvas with a selector per role. Swiping a selector is
/// local and immediate (cached items and images, no inference); what works together and what
/// is available is always the backend's answer. Browsing changes nothing: only Save
/// combination, Plan for a day and Wear this send commands, and each sends a different one.
@MainActor
@Observable
public final class StudioModel {
    /// What the validation area shows. A local swap makes the previous verdict stale at once,
    /// so an old "valid" is never left standing next to a new combination.
    public enum ValidationState: Sendable, Equatable {
        case none
        case checking
        case checked(StudioValidation)
        /// The combination changed since the last verdict and has not been checked (for example offline).
        case unchecked(String)
    }

    public let environment: AppEnvironment
    public private(set) var mode: StudioMode
    public let studio: Resource<StudioResponse>

    /// The garment (or shopping candidate) shown in each role. Restored across launches.
    public private(set) var selection: [Role: StudioSelectorItem] = [:]
    /// Roles the owner locked: suggestions never change them and they keep their place.
    public private(set) var locked: Set<Role> = []
    public var accessoriesExpanded = false
    public private(set) var validation: ValidationState = .none
    public private(set) var suggestions: [StudioSuggestion] = []
    public private(set) var suggestionNote: String?
    public private(set) var composition: Composition?
    public private(set) var lastOutcome: SubmissionOutcome?
    public private(set) var isSubmitting = false
    private var validationGeneration = 0

    private struct Saved: Codable { var mode: String; var slots: [String: String]; var locked: [String] }

    public init(environment: AppEnvironment) {
        self.environment = environment
        let saved: Saved? = environment.restoration.load("studio.state")
        let initialMode = saved.flatMap { StudioMode(rawValue: $0.mode) } ?? .forToday
        mode = initialMode
        let api = environment.api
        studio = environment.resource("studio.\(initialMode.rawValue)") { try await api.studio(mode: initialMode) }
        locked = Set((saved?.locked ?? []).compactMap(Role.init(rawValue:)))
    }

    // MARK: Loading

    public func open() async {
        studio.loadCached()
        adoptSelectors()
        if await studio.refresh() { adoptSelectors() }
    }

    /// For today: only eligible owned items. Explore: seasonal pieces and marked shopping candidates too.
    public func setMode(_ newMode: StudioMode) async {
        guard newMode != mode else { return }
        mode = newMode
        let api = environment.api
        studio.clear()
        studio.retarget { try await api.studio(mode: newMode) }
        validation = .none
        suggestions = []
        persist()
        if await studio.refresh() { adoptSelectors() }
    }

    /// Reconciles the on-screen selection with the selectors the backend returned: keeps the
    /// restored or current pick where it is still offered, otherwise uses the backend's opening outfit.
    private func adoptSelectors() {
        guard let value = studio.value else { return }
        let saved: Saved? = environment.restoration.load("studio.state")
        var next: [Role: StudioSelectorItem] = [:]
        for selector in value.selectors {
            let currentKey = selection[selector.role].map(StudioModel.key) ?? (saved?.mode == mode.rawValue ? saved?.slots[selector.role.rawValue] : nil)
            if let currentKey, let item = selector.items.first(where: { StudioModel.key($0) == currentKey }) {
                next[selector.role] = item
            } else if let opening = value.opening.first(where: { $0.role == selector.role }),
                      let item = selector.items.first(where: { $0.garmentId != nil && $0.garmentId == opening.garmentId }) {
                next[selector.role] = item
            }
        }
        selection = next
        locked = locked.filter { next[$0] != nil }
        persist()
    }

    private func persist() {
        var slots: [String: String] = [:]
        for (role, item) in selection { slots[role.rawValue] = StudioModel.key(item) }
        environment.restoration.save("studio.state", Saved(mode: mode.rawValue, slots: slots, locked: locked.map(\.rawValue).sorted()))
    }

    static func key(_ item: StudioSelectorItem) -> String { item.garmentId ?? "candidate:\(item.shoppingCandidate?.candidateId ?? item.name)" }

    // MARK: Selectors

    /// Top, bottom, footwear and outer are always shown; the rest appear when accessories are expanded.
    public var visibleSelectors: [StudioSelector] {
        (studio.value?.selectors ?? []).filter { $0.primary || accessoriesExpanded }
    }
    public var hasAccessorySelectors: Bool { (studio.value?.selectors ?? []).contains { !$0.primary } }

    public func items(for role: Role) -> [StudioSelectorItem] { studio.value?.selectors.first { $0.role == role }?.items ?? [] }

    public func isLocked(_ role: Role) -> Bool { locked.contains(role) }

    public func toggleLock(_ role: Role) {
        guard selection[role] != nil else { return }
        if locked.contains(role) { locked.remove(role) } else { locked.insert(role) }
        persist()
    }

    /// Shows an item in a role. Purely local and immediate: no request is awaited, nothing is
    /// planned or logged, and a locked role does not move.
    public func select(_ item: StudioSelectorItem, for role: Role) {
        guard !locked.contains(role), items(for: role).contains(where: { StudioModel.key($0) == StudioModel.key(item) }) else { return }
        guard selection[role].map(StudioModel.key) != StudioModel.key(item) else { return }
        selection[role] = item
        invalidateVerdict()
        persist()
    }

    public func clear(_ role: Role) {
        guard !locked.contains(role), selection[role] != nil else { return }
        selection[role] = nil
        invalidateVerdict()
        persist()
    }

    /// The visible previous/next controls beside every selector (the alternative to swiping).
    public func step(_ role: Role, by offset: Int) {
        let all = items(for: role)
        guard !all.isEmpty, !locked.contains(role) else { return }
        let current = selection[role].flatMap { item in all.firstIndex { StudioModel.key($0) == StudioModel.key(item) } }
        let next = current.map { ($0 + offset % all.count + all.count) % all.count } ?? (offset >= 0 ? 0 : all.count - 1)
        select(all[next], for: role)
    }

    private func invalidateVerdict() {
        validationGeneration += 1
        validation = selection.isEmpty ? .none : .unchecked("Not checked yet.")
        composition = nil
    }

    // MARK: The combination

    private static let roleOrder: [Role] = [.outer, .midLayer, .top, .onePiece, .bottom, .belt, .socks, .footwear, .neckwear, .accessory]

    /// The current combination in a stable role order.
    public var slots: [(role: Role, item: StudioSelectorItem)] {
        selection.sorted { a, b in
            (StudioModel.roleOrder.firstIndex(of: a.key) ?? 99, a.key.rawValue) < (StudioModel.roleOrder.firstIndex(of: b.key) ?? 99, b.key.rawValue)
        }.map { ($0.key, $0.value) }
    }

    func slotInputs() -> [StudioSlotInput] {
        slots.map { role, item in
            StudioSlotInput(role: role, garmentId: item.garmentId,
                            shoppingCandidate: item.shoppingCandidate.map { StudioShoppingCandidateInput(candidateId: $0.candidateId, label: $0.label, sourceUrl: $0.sourceUrl) },
                            locked: locked.contains(role))
        }
    }

    public var containsShoppingCandidate: Bool { selection.values.contains { $0.marker == .shoppingCandidate } }

    /// What VoiceOver reads for the canvas: every garment by name, with its marker where it matters.
    public var accessibilityDescription: String {
        guard !selection.isEmpty else { return "Empty canvas. Choose a piece for each role." }
        let names = slots.map { role, item -> String in
            var name = "\(Phrases.role(role)): \(item.name)"
            if item.marker == .shoppingCandidate { name += " (shopping candidate, not owned)" }
            if item.marker == .seasonalOrStored { name += " (in storage)" }
            if locked.contains(role) { name += ", locked" }
            return name
        }
        return names.joined(separator: ". ") + "."
    }

    /// The label a selector item carries so it is never mistaken for available owned stock.
    public static func markerLabel(_ item: StudioSelectorItem) -> String? {
        switch item.marker {
        case .owned: return item.eligibleToday ? nil : "Not available today"
        case .seasonalOrStored: return "In storage"
        case .incoming: return "On its way"
        case .shoppingCandidate: return "Shopping candidate"
        case .unknown: return nil
        }
    }

    // MARK: Backend checks (reads; nothing is mutated)

    /// Asks the backend whether the finished combination works. Never blocks a swipe: the result
    /// is dropped if the combination changed while it was in flight.
    public func validate() async {
        guard !selection.isEmpty else { validation = .none; return }
        validationGeneration += 1
        let mine = validationGeneration
        validation = .checking
        do {
            let verdict = try await environment.api.validateStudio(StudioOutfitRequest(mode: mode, slots: slotInputs()))
            guard mine == validationGeneration else { return }
            validation = .checked(verdict)
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            guard mine == validationGeneration else { return }
            validation = .unchecked(failure.isTransport ? "Offline. This combination has not been checked." : failure.ownerMessage)
            environment.center.noteRead(failure: failure)
        } catch {
            guard mine == validationGeneration else { return }
            validation = .unchecked("This combination has not been checked.")
        }
    }

    /// Find something that works with this: the backend fills the unlocked roles.
    public func findSomethingThatWorks(limit: Int = 5) async {
        suggestionNote = nil
        do {
            let response = try await environment.api.suggestStudio(StudioOutfitRequest(mode: mode, slots: slotInputs(), limit: limit))
            suggestions = response.suggestions
            if suggestions.isEmpty { suggestionNote = "Nothing else works with the locked pieces right now." }
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            suggestions = []
            suggestionNote = failure.isTransport ? "Offline. Suggestions need a connection." : failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            suggestions = []
        }
    }

    /// Applies a suggestion to the unlocked roles only. Locked roles keep their garment even if
    /// the suggestion names something else for them.
    public func apply(_ suggestion: StudioSuggestion) {
        var next = selection.filter { locked.contains($0.key) }
        for slot in suggestion.slots where !locked.contains(slot.role) {
            if let item = items(for: slot.role).first(where: { slot.garmentId != nil && $0.garmentId == slot.garmentId }) { next[slot.role] = item }
        }
        selection = next
        validationGeneration += 1
        validation = .checked(suggestion.validation)
        composition = nil
        persist()
    }

    /// The backend's layout manifest for the current combination (positions of verified assets).
    public func loadComposition() async {
        guard !selection.isEmpty else { composition = nil; return }
        let mine = validationGeneration
        if let result = try? await environment.api.composeStudio(StudioComposeRequest(slots: slotInputs())), mine == validationGeneration { composition = result }
    }

    // MARK: The three distinct effects

    private func submit(_ draft: CommandDraft) async -> SubmissionOutcome {
        isSubmitting = true
        defer { isSubmitting = false }
        let outcome = await environment.center.submit(draft)
        lastOutcome = outcome
        if case .confirmed = outcome { await studio.refresh() }
        return outcome
    }

    private var namesLine: String { Phrases.list(slots.map(\.item.name)) }

    /// Save combination: keeps the combination for later. No plan, no wear.
    @discardableResult
    public func saveCombination(name: String? = nil) async -> SubmissionOutcome? {
        guard !selection.isEmpty else { return nil }
        return await submit(CommandDraft(CommandStudioSaveCombination(name: name, slots: slotInputs(), mode: mode), label: "Saved combination: \(namesLine)"))
    }

    /// Plan for a day: an intention for that date. Not a wear.
    @discardableResult
    public func planForDay(_ date: LocalDate) async -> SubmissionOutcome? {
        guard !selection.isEmpty else { return nil }
        return await submit(CommandDraft(CommandStudioPlanForDay(localDate: date, slots: slotInputs()), label: "Planned for \(Phrases.dayMonth(date)): \(namesLine)"))
    }

    /// Whether Wear this can be offered: every piece must be an owned garment. A shopping
    /// candidate can never be recorded as worn.
    public var canWearThis: Bool { !selection.isEmpty && selection.values.allSatisfy { $0.garmentId != nil && $0.marker != .shoppingCandidate && $0.marker != .incoming } }

    /// Wear this: the owner's observation that he is wearing these garments today.
    @discardableResult
    public func wearThis() async -> SubmissionOutcome? {
        guard canWearThis else { return nil }
        let ids = slots.compactMap(\.item.garmentId)
        return await submit(CommandDraft(CommandWearRecord(wearingDate: environment.today, garmentIds: ids, timezone: environment.timeZone.identifier), label: "Wore \(namesLine)"))
    }

    @discardableResult
    public func removeCombination(_ combinationId: String) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandStudioRemoveCombination(combinationId: combinationId), label: "Removed a saved combination"))
    }

    @discardableResult
    public func removeDayPlan(_ planId: String) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandStudioRemoveDayPlan(planId: planId), label: "Removed a day plan"))
    }

    public var combinations: [StudioCombination] { (studio.value?.combinations ?? []).filter { $0.status == .active } }
    public var dayPlans: [StudioDayPlan] { (studio.value?.dayPlans ?? []).filter { $0.status == .planned } }

    /// Loads a saved combination onto the canvas (unlocked roles only).
    public func show(_ combination: StudioCombination) {
        var next = selection.filter { locked.contains($0.key) }
        for slot in combination.slots where !locked.contains(slot.role) {
            if let item = items(for: slot.role).first(where: { slot.garmentId != nil && $0.garmentId == slot.garmentId }) { next[slot.role] = item }
        }
        selection = next
        invalidateVerdict()
        persist()
    }

    public var freshnessLine: String {
        studio.freshness.statement(subject: "Studio", now: environment.time.now(), timeZone: environment.timeZone)
    }
}

/// Places a composition manifest's layers into a view of any size. Pure geometry on values
/// the backend chose; it is how the phone positions cached assets without inference.
public enum CompositionLayout {
    public struct Frame: Sendable, Equatable {
        public var x: Double, y: Double, width: Double, height: Double
    }

    /// Scales the manifest's canvas to fit `width` x `height`, centred, preserving aspect ratio,
    /// and returns the layers back-to-front.
    public static func frames(for manifest: CompositionManifest, in width: Double, _ height: Double) -> [(layer: CompositionLayer, frame: Frame)] {
        let cw = Double(manifest.canvas.width), ch = Double(manifest.canvas.height)
        guard cw > 0, ch > 0, width > 0, height > 0 else { return [] }
        let scale = min(width / cw, height / ch)
        let dx = (width - cw * scale) / 2, dy = (height - ch * scale) / 2
        return manifest.layers.sorted { ($0.z, $0.role.rawValue) < ($1.z, $1.role.rawValue) }.map { layer in
            let w = layer.width * layer.scale * scale, h = layer.height * layer.scale * scale
            // The layer's scale shrinks or grows it around the centre of its slot box.
            let x = dx + (layer.x + layer.width * (1 - layer.scale) / 2) * scale
            let y = dy + (layer.y + layer.height * (1 - layer.scale) / 2) * scale
            return (layer, Frame(x: x, y: y, width: w, height: h))
        }
    }
}
