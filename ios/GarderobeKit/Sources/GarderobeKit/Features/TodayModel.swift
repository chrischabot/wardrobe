import Foundation
import Observation

/// One board option as the screen shows it, with the footwear the owner has picked applied.
/// Everything here is selection and naming of what the backend composed; nothing is decided.
public struct OptionPresentation: Sendable, Equatable, Identifiable {
    public var option: BoardOption
    /// The garments shown (and recorded by "I wore this"): exactly one footwear line.
    public var visibleGarments: [BoardGarmentLine]
    /// Footwear the owner can pick between, including the option's default. Empty when there is no choice.
    public var footwearChoices: [BoardGarmentLine]
    public var selectedFootwearId: String?
    public var isChosen: Bool
    /// The optional scarf or tie flourish. It is recorded as worn only when the owner says so.
    public var flourishWorn: Bool = false
    public var id: String { option.optionId }

    /// What VoiceOver reads for the option: the garments by name and the reason, never "Outfit 3".
    public var accessibilityLabel: String {
        let names = Phrases.list(visibleGarments.map(\.name))
        var parts = ["\(option.name). \(names).", option.reason]
        if let q = option.qualification { parts.append(q) }
        if isChosen { parts.append("Chosen for today.") }
        return parts.joined(separator: " ")
    }

    /// The garment IDs "I wore this" records.
    public var wearGarmentIds: [String] {
        var seen = Set<String>()
        var ids = visibleGarments.map(\.garmentId)
        if flourishWorn, let flourish = option.flourish { ids.append(flourish.garmentId) }
        return ids.filter { seen.insert($0).inserted }
    }

    /// The names "I wore this" will record, for the confirmation line and the receipt label.
    public var wearNames: [String] {
        visibleGarments.map(\.name) + (flourishWorn ? [option.flourish?.name].compactMap { $0 } : [])
    }
}

/// Today: the cached board first, then its validity; choose, swap, record a wear.
@MainActor
@Observable
public final class TodayModel {
    public let environment: AppEnvironment
    public let today: Resource<TodayResponse>
    /// The hourly basis behind the weather line, loaded when the owner taps it.
    public let weather: Resource<WeatherSnapshot>

    /// The owner's footwear pick per option, before anything is chosen or recorded.
    public private(set) var footwearPicks: [String: String] = [:]
    /// Options whose flourish the owner says he is wearing too.
    public private(set) var flourishWorn: Set<String> = []
    /// Carousel or the compact comparison list. Restored across launches.
    public var showsComparison: Bool { didSet { environment.restoration.save("today.comparison", showsComparison) } }
    /// The last action's outcome, for the inline status line.
    public private(set) var lastOutcome: SubmissionOutcome?
    public private(set) var isSubmitting = false
    /// A run that is composing a board or another outfit, when the backend said one is in progress.
    public private(set) var runId: String?
    /// Options returned by an explicit "another outfit" request; shown separately, never merged into the board.
    public private(set) var extraOptions: [BoardOption] = []
    public private(set) var extraNote: String?

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        today = environment.resource("today") { try await api.today() }
        weather = environment.resource("today.weather") { try await api.weather() }
        showsComparison = environment.restoration.load("today.comparison") ?? false
    }

    // MARK: Reading

    /// Shows the cached board immediately, then checks it. Called when Today appears.
    public func open() async {
        today.loadCached()
        await refresh()
    }

    public func refresh() async {
        if await today.refresh(), let value = today.value {
            environment.adopt(timeZoneIdentifier: value.timezone)
            runId = value.runId
        }
    }

    public var board: BoardDocument? { today.value?.board }

    /// The garments recorded as worn today. Once this is non-empty the day has a record and
    /// the board is history: nothing restyles it in the background.
    public var dayRecord: [BoardGarmentLine] { today.value?.dayRecord ?? [] }
    public var hasDayRecord: Bool { !dayRecord.isEmpty }

    /// `Tuesday 15 September`.
    public var dateLine: String {
        Phrases.weekdayDayMonth(today.value?.localDate ?? environment.today)
    }

    public var options: [OptionPresentation] {
        guard let board else { return [] }
        return board.options.map { present($0, in: board) }
    }

    private func present(_ option: BoardOption, in board: BoardDocument) -> OptionPresentation {
        let isChosen = board.selection?.optionId == option.optionId
        let defaultFootwear = option.garments.first { $0.role == .footwear }
        var choices: [BoardGarmentLine] = []
        if !option.footwearAlternatives.isEmpty {
            if let defaultFootwear { choices.append(defaultFootwear) }
            for alt in option.footwearAlternatives where !choices.contains(where: { $0.garmentId == alt.garmentId }) { choices.append(alt) }
        }
        // Precedence: the owner's pick on this screen, then the footwear stored with the selection, then the option's default.
        let pickedId = footwearPicks[option.optionId] ?? (isChosen ? board.selection?.footwearGarmentId : nil)
        let picked = choices.first { $0.garmentId == pickedId } ?? defaultFootwear ?? choices.first
        var visible = option.garments.filter { $0.role != .footwear }
        if let picked {
            let index = option.garments.firstIndex { $0.role == .footwear }.map { min($0, visible.count) } ?? visible.count
            visible.insert(picked, at: index)
        }
        return OptionPresentation(option: option, visibleGarments: visible, footwearChoices: choices.count > 1 ? choices : [],
                                  selectedFootwearId: picked?.garmentId, isChosen: isChosen,
                                  flourishWorn: option.flourish != nil && flourishWorn.contains(option.optionId))
    }

    /// The owner says whether he is also wearing the option's flourish. Local until I wore this.
    public func setFlourishWorn(_ worn: Bool, optionId: String) {
        if worn { flourishWorn.insert(optionId) } else { flourishWorn.remove(optionId) }
    }

    /// The freshness sentence under the date. Offline it says when the board was checked.
    public var freshnessLine: String {
        today.freshness.statement(subject: "board", now: environment.time.now(), timeZone: environment.timeZone)
    }

    /// Per-source notes from the backend ("Calendar is disconnected"), excluding sources that are fine.
    public var sourceNotes: [String] {
        (today.value?.freshness ?? []).compactMap { f in
            guard f.state != .fresh else { return nil }
            if let detail = f.detail { return detail }
            switch (f.source, f.state) {
            case (.calendar, .notConnected): return "Calendar is not connected. Today still works."
            case (.weather, .stale): return "The weather forecast is out of date."
            case (.weather, .unavailable): return "The weather forecast is unavailable."
            default: return nil
            }
        }
    }

    /// The concise connection action when Calendar needs the owner; Today stays available regardless.
    public var calendarAction: String? { board?.calendarProjection.action }

    /// Why there is no board, in the backend's words where it gave them.
    public var emptyStatement: String? {
        guard let value = today.value, value.board == nil else { return nil }
        if let reason = value.emptyReason { return reason }
        switch value.status {
        case .paused:
            if let resume = value.paused?.resumeOn { return "Recommendations are paused until \(Phrases.dayMonth(resume))." }
            return "Recommendations are paused until you resume them."
        case .preparing: return "Today's board is being prepared."
        default: return "There is no board for today."
        }
    }

    /// Commands waiting on this phone that concern today (shown as "Waiting to send").
    public var queuedHere: [QueuedCommand] {
        environment.center.pending.filter { ["wear.record", "wear.amend", "board.select", "board.swap_slot"].contains($0.envelope.type) }
    }

    // MARK: Actions

    /// Picks one of an option's footwear alternatives. Local presentation only: nothing is sent
    /// until Choose or I wore this, and then exactly one shoe goes with it.
    public func pickFootwear(optionId: String, garmentId: String) {
        guard let option = board?.option(optionId) else { return }
        let allowed = option.garments.filter { $0.role == .footwear }.map(\.garmentId) + option.footwearAlternatives.map(\.garmentId)
        guard allowed.contains(garmentId) else { return }
        footwearPicks[optionId] = garmentId
    }

    private func run(_ draft: CommandDraft) async -> SubmissionOutcome {
        isSubmitting = true
        defer { isSubmitting = false }
        let outcome = await environment.center.submit(draft)
        lastOutcome = outcome
        if case .confirmed = outcome { await refresh() }
        if case .rejected(let error) = outcome, error.code == .conflict { await refresh() } // the board moved on: show the current one
        return outcome
    }

    /// Choose records an intention, not a wear.
    @discardableResult
    public func choose(optionId: String) async -> SubmissionOutcome? {
        guard let board, let option = options.first(where: { $0.id == optionId }) else { return nil }
        let payload = CommandBoardSelect(boardId: board.boardId, optionId: optionId, footwearGarmentId: option.footwearChoices.isEmpty ? nil : option.selectedFootwearId)
        return await run(CommandDraft(payload, label: "Chose \(option.option.name)", expectedVersions: [board.versionKey: board.revision],
                                      attachedRefs: ["board_option:\(optionId)"]))
    }

    @discardableResult
    public func clearChoice() async -> SubmissionOutcome? {
        guard let board, board.selection != nil else { return nil }
        return await run(CommandDraft(CommandBoardSelect(boardId: board.boardId, optionId: nil), label: "Cleared today's choice", expectedVersions: [board.versionKey: board.revision]))
    }

    /// Swap changes one slot. With a garment it is the owner's pick (validated by the backend);
    /// without one the backend chooses the replacement. The rest of the option is untouched.
    @discardableResult
    public func swap(optionId: String, role: Role, to garmentId: String? = nil) async -> SubmissionOutcome? {
        guard let board, let option = board.option(optionId) else { return nil }
        let payload = CommandBoardSwapSlot(boardId: board.boardId, optionId: optionId, role: role, garmentId: garmentId)
        let outcome = await run(CommandDraft(payload, label: "Swapped the \(Phrases.role(role).lowercased()) in \(option.name)", expectedVersions: [board.versionKey: board.revision],
                                             attachedRefs: ["board_option:\(optionId)"]))
        if role == .footwear, case .confirmed = outcome { footwearPicks[optionId] = nil }
        return outcome
    }

    /// I wore this: an authoritative owner observation of the visible outfit, with the one
    /// selected shoe. Works offline: the command waits on the phone and nothing is shown as recorded
    /// until the receipt arrives.
    @discardableResult
    public func woreThis(optionId: String) async -> SubmissionOutcome? {
        guard let value = today.value, let option = options.first(where: { $0.id == optionId }) else { return nil }
        let payload = CommandWearRecord(wearingDate: value.localDate, garmentIds: option.wearGarmentIds, timezone: value.timezone)
        return await run(CommandDraft(payload, label: "Wore \(Phrases.list(option.wearNames))", attachedRefs: ["board_option:\(optionId)"]))
    }

    /// Records garments worn that were not an option on the board (picked from the wardrobe).
    @discardableResult
    public func wore(garments: [(id: String, name: String)], on date: LocalDate? = nil) async -> SubmissionOutcome? {
        guard !garments.isEmpty else { return nil }
        let wearingDate = date ?? today.value?.localDate ?? environment.today
        let payload = CommandWearRecord(wearingDate: wearingDate, garmentIds: garments.map(\.id), timezone: environment.timeZone.identifier)
        return await run(CommandDraft(payload, label: "Wore \(Phrases.list(garments.map(\.name)))"))
    }

    /// An explicit amendment of the day's record: replaces only the facts it corrects.
    @discardableResult
    public func amend(remove: [String], add: [String], reason: String? = nil) async -> SubmissionOutcome? {
        guard !(remove.isEmpty && add.isEmpty) else { return nil }
        let date = today.value?.localDate ?? environment.today
        return await run(CommandDraft(CommandWearAmend(wearingDate: date, remove: remove.isEmpty ? nil : remove, add: add.isEmpty ? nil : add, reason: reason), label: "Corrected what you wore"))
    }

    /// Saves the editable day brief. It is a one-day brief and never rewrites standing rules.
    @discardableResult
    public func setBrief(_ text: String) async -> SubmissionOutcome? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let date = today.value?.localDate ?? environment.today
        let payload = CommandStyleSetBrief(localDate: date, text: trimmed, source: SourceRef(kind: .ownerStatement))
        return await run(CommandDraft(payload, label: "Set today's brief"))
    }

    /// An explicit request for another outfit (for example for dinner). The backend composes and
    /// validates; the result is shown beside the board and does not replace the day's record.
    public func requestAnother(brief: String?, count: Int? = nil) async {
        isSubmitting = true
        defer { isSubmitting = false }
        let request = RecommendRequest(clientRequestId: environment.ids.next("recommend"), date: today.value?.localDate, brief: brief, count: count, mode: .preview)
        do {
            let response = try await environment.api.recommend(request)
            extraOptions = response.options
            extraNote = response.note
            // `running` is not done: keep the run handle and say it is being prepared.
            runId = response.state == .running ? response.runId : nil
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            extraNote = failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            extraNote = "The request could not be sent."
        }
    }

    /// The identity "Ask about this" attaches to a message: the option within this board revision.
    public func askAboutReference(optionId: String) -> AttachedRef? {
        guard let board, board.option(optionId) != nil else { return nil }
        return AttachedRef(kind: .boardOption, id: optionId, boardId: board.boardId, revision: board.revision)
    }

    public func loadWeatherDetail() async {
        weather.loadCached()
        await weather.refresh()
    }

    /// `Open-Meteo, fetched today at 06:40` - the source and update time behind the weather line.
    public var weatherSourceLine: String? {
        guard let snapshot = weather.value else { return nil }
        let fetched = Dates.parseInstant(snapshot.fetchedAt).map { Phrases.relativeTime($0, now: environment.time.now(), timeZone: environment.timeZone) } ?? snapshot.fetchedAt
        return "\(snapshot.attribution), fetched \(fetched)"
    }
}
