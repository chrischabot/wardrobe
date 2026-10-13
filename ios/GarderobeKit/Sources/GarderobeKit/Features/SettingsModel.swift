import Foundation
import Observation

/// Settings behind the account control: delivery and location, My style, pause and resume,
/// connections, connected assistants, inference profile and budgets, and the image review.
/// Every change is a versioned command or a dedicated account route; nothing is edited locally.
@MainActor
@Observable
public final class SettingsModel {
    public let environment: AppEnvironment
    public let settings: Resource<SettingsResponse>
    public let style: Resource<StyleContext>
    public let connections: Resource<ApiConnectionList>
    public let assistants: Resource<AssistantGrantList>
    public let review: Resource<MediaReview>
    public let photosNeededList: Resource<PhotosNeededList>
    /// The owner's Google calendars (loaded on demand for the calendar step).
    public private(set) var calendars: ConnectionCalendarList?

    public private(set) var lastOutcome: SubmissionOutcome?
    public private(set) var message: String?
    public private(set) var isWorking = false
    /// A provider authorization page to open in the system browser (connect / reconnect).
    public private(set) var authorizationURL: URL?
    public private(set) var lastDisconnect: DisconnectResponse?
    /// What the last confirmed Save in My style did to the structured facts, as the receipt reported it.
    public private(set) var lastFactDiff: StyleFactDiff?
    /// The backend's preview of the save the owner is reviewing, and the decisions made in it.
    public private(set) var savePreview: StyleSavePreview?
    public private(set) var saveDecisions: [String: StyleFactDecision] = [:]

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        settings = environment.resource("settings") { try await api.settings() }
        style = environment.resource("style") { try await api.style() }
        connections = environment.resource("connections") { try await api.connections() }
        assistants = environment.resource("assistants") { try await api.assistants() }
        review = environment.resource("media.review") { try await api.mediaReview() }
        photosNeededList = environment.resource("media.photosNeeded") { try await api.photosNeeded() }
    }

    public func open() async {
        for load in [settings.loadCached, style.loadCached, connections.loadCached, assistants.loadCached, review.loadCached, photosNeededList.loadCached] { load() }
        await refreshSettings()
        await style.refresh()
        await connections.refresh()
        await assistants.refresh()
        await review.refresh()
        await photosNeededList.refresh()
    }

    public func refreshSettings() async {
        if await settings.refresh(), let value = settings.value { environment.adopt(timeZoneIdentifier: value.settings.timezone) }
    }

    private func submit(_ draft: CommandDraft, then refresh: (() async -> Void)? = nil) async -> SubmissionOutcome {
        isWorking = true
        defer { isWorking = false }
        let outcome = await environment.center.submit(draft)
        lastOutcome = outcome
        switch outcome {
        case .confirmed: await refresh?()
        case .rejected(let error) where error.code == .conflict:
            // Someone else changed it first (another device, MCP): show the current value instead of overwriting.
            message = "This was changed elsewhere. The current values are shown; make your change again."
            await refresh?()
        default: break
        }
        return outcome
    }

    // MARK: Delivery, location, laundry rhythm

    public var owner: OwnerSettings? { settings.value?.settings }

    /// Sends a deep-partial settings patch against the version on screen.
    @discardableResult
    public func update(_ patch: [String: JSONValue], label: String) async -> SubmissionOutcome? {
        guard let version = settings.value?.version else { return nil }
        return await submit(CommandDraft(CommandSettingsUpdate(patch: patch), label: label, expectedVersions: ["settings": version])) { await self.refreshSettings() }
    }

    @discardableResult
    public func setMorningTime(_ hhmm: String) async -> SubmissionOutcome? {
        await update(["delivery": ["morningLocalTime": .string(hhmm)]], label: "Morning delivery at \(hhmm)")
    }

    /// Three, four or five daily options.
    @discardableResult
    public func setOptionCount(_ count: Int) async -> SubmissionOutcome? {
        guard (3...5).contains(count) else { return nil }
        return await update(["delivery": ["defaultOptionCount": .integer(count)]], label: "\(count) daily options")
    }

    @discardableResult
    public func setHomeLocation(label: String, latitude: Double?, longitude: Double?) async -> SubmissionOutcome? {
        var location: [String: JSONValue] = ["label": .string(label)]
        if let latitude, let longitude { location["latitude"] = .number(latitude); location["longitude"] = .number(longitude) }
        return await update(["homeLocation": .object(location)], label: "Home location: \(label)")
    }

    @discardableResult
    public func setTimezone(_ identifier: String) async -> SubmissionOutcome? {
        guard TimeZone(identifier: identifier) != nil else { return nil }
        return await update(["timezone": .string(identifier)], label: "Timezone: \(identifier)")
    }

    @discardableResult
    public func setWeeklyLaundryReset(enabled: Bool) async -> SubmissionOutcome? {
        await update(["laundry": ["service": ["weeklyResetEnabled": .bool(enabled)]]], label: enabled ? "Weekly laundry reset on" : "Weekly laundry reset off")
    }

    /// Calendar presentation is a visible preference: a timed 15-minute event at the morning
    /// time, or an all-day board (which has no 7 AM start) with a separate reminder.
    @discardableResult
    public func setCalendarPresentation(allDay: Bool) async -> SubmissionOutcome? {
        await update(["extensions": ["daily": ["calendar": ["presentation": .string(allDay ? "all_day" : "timed")]]]], label: allDay ? "Calendar: all-day board" : "Calendar: timed event")
    }

    /// The Calendar event's own reminder, separate from app notifications so mornings do not alert twice.
    @discardableResult
    public func setCalendarReminder(minutesBefore: Int?) async -> SubmissionOutcome? {
        await update(["extensions": ["daily": ["calendar": ["reminderMinutesBefore": minutesBefore.map(JSONValue.integer) ?? .null]]]], label: "Calendar reminder updated")
    }

    public var calendarPresentationIsAllDay: Bool {
        owner?.extensions["daily"]?["calendar"]?["presentation"]?.stringValue == "all_day"
    }

    // MARK: My style

    /// `Version 1 · 12,345 bytes · sha256 e15639d8...` - the imported profile's identity.
    public var profileLine: String? {
        guard let doc = style.value?.document else { return nil }
        return "Version \(doc.version) · \(doc.byteLength) bytes · sha256 \(doc.contentSha256.prefix(12))"
    }

    /// Saves an edited profile as a new version, against the style revision on screen. The
    /// backend derives what the edit does to rules, measurements and size experiences; the
    /// receipt's diff is kept in `lastFactDiff`. A fact the edit affects and the owner has not
    /// decided stays in force and is listed in `openFactConflicts`; nothing is decided here.
    @discardableResult
    public func saveProfile(content: String, resolutions: [CommandStyleSaveDocument.FactResolutionsItem] = []) async -> SubmissionOutcome? {
        guard let context = style.value, content != context.document.content, !content.isEmpty else { return nil }
        let payload = CommandStyleSaveDocument(documentId: context.document.documentId, content: content,
                                               factResolutions: resolutions.isEmpty ? nil : resolutions, source: SourceRef(kind: .ownerStatement))
        let outcome = await submit(CommandDraft(payload, label: "Saved My style", expectedVersions: ["style": context.styleRevision])) { await self.style.refresh() }
        if let receipt = outcome.receipt { lastFactDiff = try? receipt.result["factDiff"]?.decoded(as: StyleFactDiff.self) }
        if outcome.receipt != nil || outcome == .queued { cancelSavePreview() }
        return outcome
    }

    /// Asks the backend what saving this text would do to the structured facts, before saving.
    /// Nothing is written. Returns false when the preview could not be read (offline): the
    /// owner can still save, and any affected fact then waits for his decision.
    @discardableResult
    public func previewSave(content: String) async -> Bool {
        guard let context = style.value, content != context.document.content, !content.isEmpty else { return false }
        var diff: StyleFactDiff?
        await call { diff = try await self.environment.api.previewStyleSave(StylePreviewSaveRequest(content: content, documentId: context.document.documentId)) }
        guard let diff else { return false }
        savePreview = StyleSavePreview(content: content, diff: diff)
        saveDecisions = [:]
        return true
    }

    public func cancelSavePreview() { savePreview = nil; saveDecisions = [:] }

    /// Records (or, with nil, withdraws) the owner's decision for one fact of the preview.
    public func decide(_ question: StyleFactQuestion, _ decision: StyleFactDecision?) {
        guard savePreview?.questions.contains(where: { $0.id == question.id }) == true else { return }
        if let decision, question.allowed.contains(decision.choice.kind) { saveDecisions[question.id] = decision } else { saveDecisions[question.id] = nil }
    }

    /// Saves the previewed text together with the decisions made; undecided facts stay in force
    /// and become open conflicts.
    @discardableResult
    public func confirmSave() async -> SubmissionOutcome? {
        guard let preview = savePreview else { return nil }
        let resolutions = preview.questions.compactMap { q -> CommandStyleSaveDocument.FactResolutionsItem? in
            guard let d = saveDecisions[q.id] else { return nil }
            let quote = d.quoteNewWording ? q.newWording.flatMap { $0.isEmpty ? nil : $0 } : nil
            return .init(fact: q.fact, resolution: d.choice.resolution(quote: quote))
        }
        return await saveProfile(content: preview.content, resolutions: resolutions)
    }

    /// Structured facts whose quoted passage an earlier save removed or reworded and the owner
    /// has not decided yet. Each stays in force until he does.
    public var openFactConflicts: [StyleFactConflict] { (style.value?.factConflicts ?? []).filter { $0.status == .open } }

    public var openQuestions: [StyleFactQuestion] { openFactConflicts.map(StyleFactQuestion.init) }

    /// Records the owner's decision for one conflict. The values of a replacement are the
    /// owner's own entry; the app never reads a value out of the profile text.
    @discardableResult
    public func resolve(_ conflict: StyleFactConflict, _ choice: StyleFactChoice, quoteNewWording: Bool = false) async -> SubmissionOutcome? {
        guard StyleFactChoice.Kind.allowed(for: conflict.fact.kind).contains(choice.kind) else { return nil }
        let quote = quoteNewWording ? conflict.candidateText.flatMap { $0.isEmpty ? nil : $0 } : nil
        let payload = CommandStyleResolveFactConflict(conflictId: conflict.conflictId, resolution: choice.resolution(quote: quote))
        return await submit(CommandDraft(payload, label: "\(choice.kind.pastTense) \(conflict.label)")) { await self.style.refresh() }
    }

    @discardableResult
    public func addDirection(_ text: String) async -> SubmissionOutcome? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return await submit(CommandDraft(CommandStyleAddDirection(text: trimmed, source: SourceRef(kind: .ownerStatement)), label: "Added a standing direction")) { await self.style.refresh() }
    }

    @discardableResult
    public func retireDirection(_ directionId: String) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandStyleRetireDirection(directionId: directionId), label: "Retired a standing direction")) { await self.style.refresh() }
    }

    public var activeDirections: [StandingDirection] { (style.value?.directions ?? []).filter { $0.status == .active } }
    public var activeAmendments: [StyleAmendment] { (style.value?.amendments ?? []).filter { $0.status == .active } }

    // MARK: Pause and resume

    public var service: ServiceState? { settings.value?.service }

    public var pauseLine: String {
        guard let service, service.paused else { return "Recommendations are on." }
        var line = service.pause?.resumeOn.map { "Paused. Resumes on \(Phrases.dayMonth($0))." } ?? "Paused until you resume."
        line += service.returnDeadlinesActive ? " Return deadline reminders stay on." : ""
        return line
    }

    /// Pause recommendations. No reason is asked for; the resume date is optional. Conversation,
    /// recording what you wore and your data stay available.
    @discardableResult
    public func pause(resumeOn: LocalDate?) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandServicePause(resumeOn: resumeOn), label: resumeOn.map { "Paused until \(Phrases.dayMonth($0))" } ?? "Paused recommendations")) { await self.refreshSettings() }
    }

    /// Resume. Nothing is replayed: no backlog of boards, no questions about missed days.
    @discardableResult
    public func resume() async -> SubmissionOutcome {
        await submit(CommandDraft(CommandServiceResume(), label: "Resumed recommendations")) { await self.refreshSettings() }
    }

    // MARK: Connections

    private static let kindOrder: [ApiConnectionKind] = [.googleWorkspace, .exa, .tavily, .mcp]

    /// Gmail and Calendar (Google) first, then search and other connections.
    public var orderedConnections: [ApiConnection] {
        (connections.value?.connections ?? []).sorted { a, b in
            (SettingsModel.kindOrder.firstIndex(of: a.kind) ?? 9, a.name) < (SettingsModel.kindOrder.firstIndex(of: b.kind) ?? 9, b.name)
        }
    }

    public func stateLine(_ c: ApiConnection) -> String {
        let last = c.lastSuccessAt.flatMap(Dates.parseInstant).map { "Last worked \(Phrases.relativeTime($0, now: environment.time.now(), timeZone: environment.timeZone))." } ?? "Has not completed an operation yet."
        switch c.state {
        case .connected: return "Connected. \(last)"
        case .pendingAuthorization: return "Waiting for you to finish connecting."
        case .needsReconnect: return "Needs reconnecting. \(last)"
        case .error: return "\(c.issue?.message ?? "Not working.") \(last)"
        case .disconnected: return "Disconnected."
        case .unknown: return last
        }
    }

    /// A missing permission names the capability it affects; the rest of the app keeps working.
    public func missingPermissions(_ c: ApiConnection) -> [String] {
        c.capabilities.filter { $0.enabled && !$0.available }.map { "Missing permission: \($0.label). Reconnect to grant it." }
    }

    private func call(_ work: @escaping () async throws -> Void) async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await work()
            message = nil
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            message = failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            message = "That could not be completed."
        }
    }

    /// Starts connecting Google (Gmail and Calendar first). The owner finishes in the system
    /// browser; no secret is ever typed or copied on the phone.
    public func connectGoogle(capabilities: [String] = ["gmail.read_orders", "calendar.read", "calendar.write_outfit_calendar"]) async {
        await call {
            let request = RegisterConnectionRequest(clientRequestId: self.environment.ids.next("connect"), kind: .googleWorkspace, name: "Google", auth: ["type": "oauth"], capabilities: capabilities, returnTo: .app)
            let response = try await self.environment.api.registerConnection(request)
            self.authorizationURL = response.authorizationUrl.flatMap(URL.init(string:))
            await self.connections.refresh()
        }
    }

    public func reconnect(_ c: ApiConnection) async {
        await call {
            let response = try await self.environment.api.reconnect(connectionId: c.connectionId)
            self.authorizationURL = response.authorizationUrl.flatMap(URL.init(string:))
            await self.connections.refresh()
        }
    }

    public func authorizationOpened() { authorizationURL = nil }

    // MARK: Outfit calendar

    public var googleConnection: ApiConnection? { orderedConnections.first { $0.kind == .googleWorkspace && $0.state == .connected } }

    /// Loads the owner's calendars from the connected Google account.
    public func loadCalendars() async {
        guard let connection = googleConnection else { calendars = nil; message = "Connect Google first to choose calendars."; return }
        await call { self.calendars = try await self.environment.api.calendars(connectionId: connection.connectionId) }
    }

    /// Creates the dedicated outfit calendar (the backend only writes to a calendar it created,
    /// so an existing calendar is never chosen as the target) and records it in settings.
    public func createOutfitCalendar(name: String? = nil) async {
        guard let connection = googleConnection else { message = "Connect Google first."; return }
        await call {
            let response = try await self.environment.api.ensureOutfitCalendar(connectionId: connection.connectionId, OutfitCalendarRequest(clientRequestId: self.environment.ids.next("calendar"), name: name))
            if let receipt = response.receipt { self.environment.center.merge([receipt]) }
            self.calendars = try await self.environment.api.calendars(connectionId: connection.connectionId)
            await self.refreshSettings()
        }
    }

    /// Chooses which calendars are read for the day's context.
    @discardableResult
    public func setReadCalendars(_ calendarIds: [String]) async -> SubmissionOutcome? {
        let outcome = await update(["extensions": ["daily": ["calendar": ["readCalendarIds": .array(calendarIds.map(JSONValue.string))]]]], label: "Calendars read for the day updated")
        if case .confirmed? = outcome { await loadCalendars() }
        return outcome
    }

    public func disconnect(_ c: ApiConnection) async {
        await call {
            self.lastDisconnect = try await self.environment.api.disconnect(connectionId: c.connectionId)
            await self.connections.refresh()
        }
    }

    /// What disconnecting did, including whether the provider confirmed revocation.
    public var disconnectLine: String? {
        guard let d = lastDisconnect else { return nil }
        var parts = ["\(d.connection.name) is disconnected on Garderobe"]
        parts.append(d.credentialsRemoved ? "its stored credentials were removed" : "its stored credentials could not be removed")
        switch d.remoteRevocation {
        case .revoked: parts.append("and the provider confirmed the access was revoked.")
        case .failed: parts.append("but the provider did not confirm revocation; remove Garderobe in the provider's own settings as well.")
        case .unsupported: parts.append("and the provider offers no remote revocation; remove Garderobe in the provider's own settings if you want it gone there too.")
        case .notApplicable, .unknown: parts.append(".")
        }
        return parts.joined(separator: ", ").replacingOccurrences(of: ", .", with: ".")
    }

    public func setCapability(_ c: ApiConnection, key: String, enabled: Bool) async {
        var keys = Set(c.capabilities.filter(\.enabled).map(\.key))
        if enabled { keys.insert(key) } else { keys.remove(key) }
        await call {
            _ = try await self.environment.api.setCapabilities(connectionId: c.connectionId, ConnectionCapabilitiesRequest(enabled: keys.sorted(), expectedVersion: c.version))
            await self.connections.refresh()
        }
    }

    // MARK: Connected assistants (Claude, ChatGPT)

    public var activeGrants: [AssistantGrant] { (assistants.value?.grants ?? []).filter { $0.status == .active } }

    public func grantLine(_ g: AssistantGrant) -> String {
        let access = g.access == .readWrite ? "Can read and change your wardrobe" : "Can read your wardrobe"
        let used = g.lastUsedAt.flatMap(Dates.parseInstant).map { "last used \(Phrases.relativeTime($0, now: environment.time.now(), timeZone: environment.timeZone))" } ?? "not used yet"
        return "\(access); \(used)."
    }

    public func disconnect(_ g: AssistantGrant) async {
        await call {
            _ = try await self.environment.api.disconnectAssistant(grantId: g.grantId)
            await self.assistants.refresh()
        }
    }

    // MARK: Inference profile and budgets (backend configuration, visible here)

    public var inference: InferenceOverview? { settings.value?.inference }

    public static func budgetName(_ c: BudgetClass) -> String {
        switch c {
        case .dailyBoard: return "Morning board"
        case .interactive: return "Daily assistance"
        case .research: return "Research"
        case .imageBackfill: return "Image backfill"
        case .maintenance: return "Maintenance"
        case .search: return "Search services (not model inference)"
        case .unknown: return "Other"
        }
    }

    /// One line per budget: spent and reserved against today's limit. Search-service charges
    /// are a separate class from model inference.
    public var budgetLines: [(name: String, line: String)] {
        func usd(_ micro: Int) -> String { String(format: "$%.2f", Double(micro) / 1_000_000) }
        return (inference?.budgets ?? []).map { b in
            var line = "\(usd(b.settledMicroUsd)) spent of \(usd(b.dailyLimitMicroUsd)) today"
            if b.reservedMicroUsd > 0 { line += ", \(usd(b.reservedMicroUsd)) reserved" }
            if b.uncertainMicroUsd > 0 { line += ", \(usd(b.uncertainMicroUsd)) unconfirmed" }
            return (SettingsModel.budgetName(b.budgetClass), line)
        }
    }

    public var routingLines: [(task: String, line: String)] {
        guard let inference else { return [] }
        return inference.routing.map { r in
            let profile = inference.profiles.first { $0.profileId == r.profileId }
            let model = profile.map { "\($0.label) (\($0.provider)\($0.apiModelId.map { ", " + $0 } ?? ""))" } ?? "Not configured"
            let fallbacks = r.fallbacks.isEmpty ? "" : "; then \(Phrases.list(r.fallbacks))"
            return (r.task.rawValue.replacingOccurrences(of: "_", with: " ").capitalizedFirst, model + fallbacks)
        }
    }

    // MARK: Photos needed and image review

    /// Items research could not find an image for. Missing photographs never block recommendations.
    public var photosNeeded: [PhotosNeededItem] { photosNeededList.value?.items ?? [] }

    public var reviewItems: [MediaReviewItem] { review.value?.items ?? [] }

    /// The single decision an image candidate needs.
    @discardableResult
    public func decide(_ item: MediaReviewItem, adopt: Bool) async -> SubmissionOutcome {
        await submit(CommandDraft(CommandMediaDecideReview(candidateId: item.candidateId, decision: adopt ? .adopt : .reject), label: adopt ? "Accepted the image for \(item.garmentName)" : "Rejected the image for \(item.garmentName)")) { await self.review.refresh() }
    }
}
