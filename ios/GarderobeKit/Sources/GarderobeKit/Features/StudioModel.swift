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
    /// The Studio read for the mode shown. Each mode has its own read and cache entry
    /// (`studio.for_today`, `studio.explore`), so one mode's selectors never stand for the other's.
    public private(set) var studio: Resource<StudioResponse>
    private var studioByMode: [StudioMode: Resource<StudioResponse>] = [:]

    /// The garment (or shopping candidate) shown in each role. Restored across launches.
    public private(set) var selection: [Role: StudioSelectorItem] = [:]
    /// Roles the owner locked: suggestions never change them and they keep their place.
    public private(set) var locked: Set<Role> = []
    public var accessoriesExpanded = false
    public private(set) var validation: ValidationState = .none
    public private(set) var suggestions: [StudioSuggestion] = []
    public private(set) var suggestionNote: String?
    public private(set) var composition: Composition?
    /// The backend-rendered picture of the current combination, when the owner asked for one.
    public private(set) var preview: PreviewState = .none
    /// The identifier of a picture request the backend has not answered yet, with the selection
    /// it was drawn for. Asking again for the same pieces after a lost answer repeats the same
    /// request instead of starting a second one.
    private var unansweredPreviewRequest: (generation: Int, id: String)?
    /// The manifest the backend said the picture asked for will be stored under.
    private var previewHash: String?
    private let sleep: @Sendable (TimeInterval) async -> Void

    /// A rendered preview is background work on the backend: asked for, then read when ready.
    public enum PreviewState: Sendable, Equatable {
        case none
        case requesting
        /// Asked for and not rendered yet.
        case queued
        /// The backend's rendered PNG.
        case rendered(Data)
        case failed(String)
    }
    public private(set) var lastOutcome: SubmissionOutcome?
    public private(set) var isSubmitting = false
    /// Sequence of validation requests: only the latest one's answer is shown.
    private var validationGeneration = 0
    /// Counts changes to the combination (pieces, mode, reset). Preview and layout answers are
    /// for one combination; asking for validation does not change it.
    private var selectionGeneration = 0

    private struct Saved: Codable { var mode: String; var slots: [String: String]; var locked: [String]; var cleared: [String]? = nil }

    /// Roles the owner emptied on purpose in this mode: a refresh or relaunch never refills them
    /// with the backend's opening outfit.
    private var cleared: Set<Role> = []
    /// Counts account endings: a read or submission answered after the account ended changes nothing.
    private var accountGeneration = 0
    /// True after a mode switch until that mode's selectors are known: the empty canvas shown
    /// meanwhile is not the owner's, and never overwrites the mode's saved one.
    private var selectionPending = false

    public init(environment: AppEnvironment, sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.environment = environment
        self.sleep = sleep
        let saved: Saved? = environment.restoration.load("studio.state")
        let initialMode = saved.flatMap { StudioMode(rawValue: $0.mode) } ?? .forToday
        mode = initialMode
        let api = environment.api
        let first = environment.resource("studio.\(initialMode.rawValue)") { try await api.studio(mode: initialMode) }
        studio = first
        studioByMode[initialMode] = first
        locked = Set((saved?.locked ?? []).compactMap(Role.init(rawValue:)))
        cleared = Set((saved?.cleared ?? []).compactMap(Role.init(rawValue:)))
        // The canvas is empty until the opening mode's selectors are known.
        selectionPending = true
    }

    /// The read for `mode`, made once and kept, with a cache entry named for the mode.
    private func resource(for mode: StudioMode) -> Resource<StudioResponse> {
        if let made = studioByMode[mode] { return made }
        let api = environment.api
        let made = environment.resource("studio.\(mode.rawValue)") { try await api.studio(mode: mode) }
        studioByMode[mode] = made
        return made
    }

    /// What the owner had on the canvas in a mode, kept per mode so switching back restores it.
    private func savedSelection(for mode: StudioMode) -> Saved? {
        if let perMode: Saved = environment.restoration.load("studio.selection.\(mode.rawValue)") { return perMode }
        let current: Saved? = environment.restoration.load("studio.state")
        return current?.mode == mode.rawValue ? current : nil
    }

    // MARK: Loading

    public func open() async {
        let mine = accountGeneration
        studio.loadCached()
        adoptSelectors()
        if await studio.refresh(), mine == accountGeneration { adoptSelectors() }
    }

    /// For today: only eligible owned items. Explore: seasonal pieces and marked shopping candidates too.
    public func setMode(_ newMode: StudioMode) async {
        guard newMode != mode else { return }
        // The mode being left keeps its own canvas; the new mode starts from its own saved one.
        persist()
        mode = newMode
        studio = resource(for: newMode)
        selection = [:]
        let destination = savedSelection(for: newMode)
        locked = Set((destination?.locked ?? []).compactMap(Role.init(rawValue:)))
        cleared = Set((destination?.cleared ?? []).compactMap(Role.init(rawValue:)))
        selectionPending = true
        // The other mode's verdict, layout, picture and suggestions never stand for this one.
        invalidateVerdict()
        validation = .none
        suggestions = []
        suggestionsGeneration = nil
        suggestionNote = nil
        studio.loadCached()
        adoptSelectors()   // saves the new mode's canvas once its selectors are known
        // Not known yet: the open mode is remembered now (its saved canvas untouched), so a
        // relaunch reopens this mode even if its read never arrives.
        if selectionPending { persist() }
        let mine = accountGeneration
        if await studio.refresh(), mode == newMode, mine == accountGeneration { adoptSelectors() }
    }

    /// Reconciles the on-screen selection with the selectors the backend returned: keeps the
    /// restored or current pick where it is still offered, otherwise uses the backend's opening outfit.
    private func adoptSelectors() {
        guard let value = studio.value else { return }
        selectionPending = false
        let saved = savedSelection(for: mode)
        var next: [Role: StudioSelectorItem] = [:]
        for selector in value.selectors {
            let currentKey = selection[selector.role].map(StudioModel.key) ?? saved?.slots[selector.role.rawValue]
            if let currentKey, let item = selector.items.first(where: { StudioModel.key($0) == currentKey }) {
                next[selector.role] = item
            } else if cleared.contains(selector.role) {
                continue   // emptied on purpose: stays empty
            } else if let opening = value.opening.first(where: { $0.role == selector.role }), let item = StudioModel.item(for: opening, in: selector.items) {
                next[selector.role] = item
            }
        }
        let changed = next.mapValues(StudioModel.key) != selection.mapValues(StudioModel.key)
        let wasEmpty = selection.isEmpty
        selection = next
        locked = locked.filter { next[$0] != nil }
        // A selection the backend's selectors changed is a new combination: nothing checked,
        // composed or drawn for the old one stays standing.
        if changed {
            invalidateVerdict()
            if wasEmpty { validation = .none }   // the first outfit on an empty canvas: nothing to retract
        }
        persist()
    }

    /// The selector item a slot names: the owned garment by its ID, or the shopping candidate by
    /// its candidate ID. Nil when the selector no longer offers it.
    static func item(for slot: StudioSlot, in items: [StudioSelectorItem]) -> StudioSelectorItem? {
        if let garmentId = slot.garmentId { return items.first { $0.garmentId == garmentId } }
        if let candidateId = slot.shoppingCandidate?.candidateId { return items.first { $0.garmentId == nil && $0.shoppingCandidate?.candidateId == candidateId } }
        return nil
    }

    /// The key a slot would have on the canvas, to compare with what is shown.
    static func key(_ slot: StudioSlot) -> String? {
        slot.garmentId ?? slot.shoppingCandidate.map { "candidate:\($0.candidateId)" }
    }

    private func persist() {
        if selectionPending && selection.isEmpty {
            // The mode's selectors are not known yet: only which mode is open is remembered;
            // its saved canvas stays as it was.
            let kept = savedSelection(for: mode) ?? Saved(mode: mode.rawValue, slots: [:], locked: locked.map(\.rawValue).sorted(), cleared: cleared.map(\.rawValue).sorted())
            environment.restoration.save("studio.state", kept)
            // Kept under the mode's own name too, so leaving the mode before its selectors
            // arrive never loses a canvas saved only as the last state.
            environment.restoration.save("studio.selection.\(mode.rawValue)", kept)
            return
        }
        var slots: [String: String] = [:]
        for (role, item) in selection { slots[role.rawValue] = StudioModel.key(item) }
        let state = Saved(mode: mode.rawValue, slots: slots, locked: locked.map(\.rawValue).sorted(), cleared: cleared.map(\.rawValue).sorted())
        environment.restoration.save("studio.state", state)
        environment.restoration.save("studio.selection.\(mode.rawValue)", state)
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
        suggestionGeneration += 1   // suggestions were found for the earlier locks
        persist()
    }

    /// Shows an item in a role. Purely local and immediate: no request is awaited, nothing is
    /// planned or logged, and a locked role does not move.
    public func select(_ item: StudioSelectorItem, for role: Role) {
        guard !locked.contains(role), items(for: role).contains(where: { StudioModel.key($0) == StudioModel.key(item) }) else { return }
        guard selection[role].map(StudioModel.key) != StudioModel.key(item) else { return }
        selection[role] = item
        cleared.remove(role)
        invalidateVerdict()
        persist()
    }

    public func clear(_ role: Role) {
        guard !locked.contains(role), selection[role] != nil else { return }
        selection[role] = nil
        cleared.insert(role)
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
        selectionGeneration += 1
        validationGeneration += 1
        suggestionGeneration += 1
        validation = selection.isEmpty ? .none : .unchecked("Not checked yet.")
        composition = nil
        preview = .none
        previewHash = nil
        unansweredPreviewRequest = nil
    }

    /// Counts changes to the combination, its locks and the mode: suggestions answer one of them.
    private var suggestionGeneration = 0
    /// The combination the suggestions on screen were found for.
    private var suggestionsGeneration: Int?

    /// The account ended: no pick, lock, verdict or suggestion of it is left.
    public func reset() {
        accountGeneration += 1
        selectionPending = false
        // Every read made for the account is dropped with its value; a refresh still in flight
        // publishes only into a read nothing shows any more.
        for (_, made) in studioByMode { made.clear() }
        studioByMode = [:]
        studio = resource(for: mode)
        restoreNote = nil
        isSubmitting = false
        selection = [:]
        locked = []
        cleared = []
        suggestions = []
        suggestionNote = nil
        suggestionsGeneration = nil
        lastOutcome = nil
        invalidateVerdict()
        validation = .none
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
        let selected = selectionGeneration
        validation = .checking
        do {
            let verdict = try await environment.api.validateStudio(StudioOutfitRequest(mode: mode, slots: slotInputs()))
            guard mine == validationGeneration, selected == selectionGeneration else { return }
            validation = .checked(verdict)
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            guard mine == validationGeneration, selected == selectionGeneration else { return }
            validation = .unchecked(failure.isTransport ? "Offline. This combination has not been checked." : failure.ownerMessage)
            environment.center.noteRead(failure: failure)
        } catch {
            guard mine == validationGeneration, selected == selectionGeneration else { return }
            validation = .unchecked("This combination has not been checked.")
        }
    }

    /// Find something that works with this: the backend fills the unlocked roles.
    public func findSomethingThatWorks(limit: Int = 5) async {
        suggestionNote = nil
        let asked = suggestionGeneration
        do {
            let response = try await environment.api.suggestStudio(StudioOutfitRequest(mode: mode, slots: slotInputs(), limit: limit))
            // The combination changed while the backend looked: its answer is for another outfit.
            guard asked == suggestionGeneration else { return }
            suggestions = response.suggestions
            suggestionsGeneration = asked
            if suggestions.isEmpty { suggestionNote = "Nothing else works with the locked pieces right now." }
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            guard asked == suggestionGeneration else { return }
            suggestions = []
            suggestionNote = failure.isTransport ? "Offline. Suggestions need a connection." : failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            guard asked == suggestionGeneration else { return }
            suggestions = []
        }
    }

    /// Applies a suggestion to the unlocked roles only. Locked roles keep their garment even if
    /// the suggestion names something else for them. The backend's verdict is shown as checked
    /// only when the canvas ends up exactly as suggested; otherwise the result is unchecked.
    /// A suggestion found for an earlier combination, lock or mode is refused: ask again.
    @discardableResult
    public func apply(_ suggestion: StudioSuggestion) -> Bool {
        // Only a suggestion on screen now, found for this combination, locks and mode, is applied.
        guard suggestionsGeneration == suggestionGeneration, suggestions.contains(suggestion) else {
            suggestions = []
            suggestionsGeneration = nil
            suggestionNote = "These suggestions were for an earlier combination. Ask again."
            return false
        }
        var next = selection.filter { locked.contains($0.key) }
        let missing = place(suggestion.slots, into: &next)
        selection = next
        invalidateVerdict()
        // The other suggestions answer the same locked pieces, so they stay applicable.
        suggestionsGeneration = suggestionGeneration
        var suggested: [Role: String] = [:]
        for slot in suggestion.slots { if let key = StudioModel.key(slot) { suggested[slot.role] = key } }
        if next.mapValues(StudioModel.key) == suggested { validation = .checked(suggestion.validation) }
        restoreNote = StudioModel.notPlacedLine(missing)
        persist()
        return true
    }

    /// Applies a suggestion, then has the backend check the canvas unless it is exactly what was
    /// suggested (whose verdict is then the suggestion's own). This is what "Show this on the
    /// canvas" does: a combination a locked role or a withdrawn piece changed is checked again.
    @discardableResult
    public func applyAndCheck(_ suggestion: StudioSuggestion) async -> Bool {
        guard apply(suggestion) else { return false }
        if case .checked = validation { return true }
        // Nothing of the suggestion could be placed: there is no combination to check, and the
        // canvas says so instead of showing no verdict at all.
        guard !selection.isEmpty else {
            validation = .unchecked("None of these pieces is offered here any more, so there is nothing to check.")
            return true
        }
        await validate()
        return true
    }

    /// Pieces of the last loaded suggestion or saved combination that are no longer offered and
    /// so are not on the canvas, said plainly; nil when everything was placed.
    public private(set) var restoreNote: String?

    /// Puts each slot's piece on the canvas for its unlocked role: an owned garment by its ID, a
    /// shopping candidate by its candidate ID. Unlocked roles the slots leave out become empty on
    /// purpose (a refresh does not refill them). Returns the slots that could not be placed.
    private func place(_ slots: [StudioSlot], into next: inout [Role: StudioSelectorItem]) -> [StudioSlot] {
        var missing: [StudioSlot] = []
        var named = Set<Role>()
        for slot in slots where !locked.contains(slot.role) {
            named.insert(slot.role)
            if let item = StudioModel.item(for: slot, in: items(for: slot.role)) {
                next[slot.role] = item
                cleared.remove(slot.role)
            } else {
                missing.append(slot)
            }
        }
        for selector in studio.value?.selectors ?? [] where !locked.contains(selector.role) && !named.contains(selector.role) {
            cleared.insert(selector.role)
        }
        for slot in missing { cleared.insert(slot.role) }
        return missing
    }

    static func notPlacedLine(_ missing: [StudioSlot]) -> String? {
        guard !missing.isEmpty else { return nil }
        let names = missing.map { slot -> String in
            if slot.shoppingCandidate != nil { return "the shopping candidate for \(Phrases.role(slot.role).lowercased())" }
            return "the \(Phrases.role(slot.role).lowercased())"
        }
        return "Not placed, because it is no longer offered here: \(Phrases.list(names))."
    }

    /// The backend's layout manifest for the current combination (positions of verified assets).
    public func loadComposition() async {
        guard !selection.isEmpty else { composition = nil; return }
        let mine = selectionGeneration
        if let result = try? await environment.api.composeStudio(StudioComposeRequest(slots: slotInputs())), mine == selectionGeneration { composition = result }
    }

    /// The pieces the backend placed without a photograph, by name, for the line under the
    /// canvas. Empty when every piece has one or no layout has been read.
    public var piecesWithoutPhoto: [String] {
        guard let composition else { return [] }
        let missing = Set(composition.missingImages)
        return composition.manifest.layers.filter { layer in layer.garmentId.map(missing.contains) ?? false }.map(\.name)
    }

    // MARK: Rendered preview (a background job on the backend)

    /// How often and how many times the preview is looked for after asking.
    static let previewChecks = 6
    static let previewInterval: TimeInterval = 2

    /// Asks the backend to render the current combination as one picture and waits a short
    /// while for it. Plans and logs nothing. If it is not ready in that time the state stays
    /// "queued" and `checkPreview` looks again; nothing is shown as ready before it is.
    public func requestPreview() async {
        guard !selection.isEmpty, preview != .requesting else { return }
        // Already asked for and still being made: look for it, never ask a second time.
        if preview == .queued { await checkPreview(); return }
        let mine = selectionGeneration
        let requestId: String
        if let kept = unansweredPreviewRequest, kept.generation == mine {
            requestId = kept.id
        } else {
            requestId = environment.ids.next("preview")
            unansweredPreviewRequest = (mine, requestId)
        }
        preview = .requesting
        do {
            let response = try await environment.api.requestStudioPreview(StudioPreviewRequest(clientRequestId: requestId, slots: slotInputs()))
            guard mine == selectionGeneration else { return }
            environment.center.noteRead(failure: nil)
            unansweredPreviewRequest = nil
            previewHash = response.manifestHash
            preview = .queued
            for attempt in 0..<StudioModel.previewChecks {
                if attempt > 0 { await sleep(StudioModel.previewInterval) }
                guard mine == selectionGeneration else { return }
                if await readPreview(manifestHash: response.manifestHash, generation: mine) { return }
            }
        } catch let failure as APIFailure {
            guard mine == selectionGeneration else { return }
            environment.center.noteRead(failure: failure)
            // A refusal is an answer: the next request is a new one. Without an answer (no
            // connection, a server fault) or with one this build could not read (the backend may
            // have started the picture), the identifier is kept, so a retry never starts a second job.
            if case .decoding = failure {} else if !failure.isRetryable { unansweredPreviewRequest = nil }
            preview = .failed(failure.isTransport ? "Offline. A picture needs a connection." : failure.ownerMessage)
        } catch {
            guard mine == selectionGeneration else { return }
            preview = .failed("The picture could not be asked for.")
        }
    }

    /// Looks once more for a preview that was still being rendered.
    public func checkPreview() async {
        guard preview == .queued, let hash = previewHash ?? composition?.manifestHash else { return }
        _ = await readPreview(manifestHash: hash, generation: selectionGeneration)
    }

    /// Reads the composition's preview state. Returns true when it is settled (rendered or failed).
    private func readPreview(manifestHash: String, generation: Int) async -> Bool {
        guard let current = try? await environment.api.composition(manifestHash: manifestHash), generation == selectionGeneration else { return false }
        composition = current
        switch current.preview.state {
        case .rendered:
            // A rendered preview is identified by its content hash, so cached bytes never go stale.
            let key = "preview:\(manifestHash):\(current.preview.sha256 ?? "")"
            if let cached = environment.media.data(for: key) { preview = .rendered(cached); return true }
            guard let data = try? await environment.api.compositionPreview(manifestHash: manifestHash), generation == selectionGeneration else { return false }
            environment.media.store(data, for: key)
            preview = .rendered(data)
            return true
        case .failed:
            preview = .failed(current.preview.failure.map { "The picture could not be made: \($0)" } ?? "The picture could not be made.")
            return true
        case .none, .queued, .unknown:
            preview = .queued
            return false
        }
    }

    /// One sentence for the preview's state, or nil when there is nothing to say.
    public var previewLine: String? {
        switch preview {
        case .none: return nil
        case .requesting: return "Asking for a picture..."
        case .queued: return "The picture is being made. It is not ready yet."
        case .rendered: return "Picture made by the backend from these pieces."
        case .failed(let message): return message
        }
    }

    // MARK: The three distinct effects

    private func submit(_ draft: CommandDraft) async -> SubmissionOutcome {
        // One change at a time: a second tap while one is being sent records nothing.
        guard !isSubmitting else { return .notSaved("The previous change is still being sent, so this tap recorded nothing.") }
        let mine = accountGeneration
        isSubmitting = true
        defer { if mine == accountGeneration { isSubmitting = false } }
        let outcome = await environment.center.submit(draft)
        // The account ended while this was sent: nothing of it is shown or refreshed here.
        guard mine == accountGeneration else { return outcome }
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
        let missing = place(combination.slots, into: &next)
        selection = next
        invalidateVerdict()
        restoreNote = StudioModel.notPlacedLine(missing)
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
