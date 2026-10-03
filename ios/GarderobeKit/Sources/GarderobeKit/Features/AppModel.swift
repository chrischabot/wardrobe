import Foundation
import Observation

/// The four destinations. There are exactly four; everything else is reached from within them.
public enum AppTab: String, Codable, Sendable, CaseIterable, Identifiable {
    case today, wardrobe, studio, conversation
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .today: return "Today"
        case .wardrobe: return "Wardrobe"
        case .studio: return "Studio"
        case .conversation: return "Conversation"
        }
    }
    public var symbol: String {
        switch self {
        case .today: return "sun.max"
        case .wardrobe: return "hanger"
        case .studio: return "square.on.square"
        case .conversation: return "bubble.left.and.text.bubble.right"
        }
    }
}

/// A pushed screen. Codable so each tab's navigation path survives closing the app.
public enum AppRoute: Codable, Sendable, Hashable {
    case item(garmentId: String)
    case trips
    case trip(tripId: String)
    case returns
    case reconcile(category: String)
    case bulkEdit
    case temperaturePreview
    case projects
    /// Requests waiting for the owner's confirmation.
    case proposals
}

/// Sheets presented over any destination.
public enum AppSheet: String, Sendable, Identifiable {
    case capture, laundry, settings
    public var id: String { rawValue }
}

/// The root model: session, the four destinations, restoration, and what happens when the
/// app launches or returns to the foreground. No timer or background task composes anything:
/// the server owns the schedule and the app refreshes when it is opened.
@MainActor
@Observable
public final class AppModel {
    public let environment: AppEnvironment
    public let account: AccountModel
    public let today: TodayModel
    public let wardrobe: WardrobeModel
    public let studio: StudioModel
    public let transcript: TranscriptModel
    public let composer: ComposerModel
    public let capture: CaptureModel
    public let laundry: LaundryModel
    public let trips: TripsModel
    public let returns: ReturnsModel
    public let projects: ProjectsModel
    public let proposals: ProposalsModel
    public let notifications: NotificationsModel
    public let settings: SettingsModel
    public let recovery: RecoveryStatusModel
    public let export: ExportModel
    public let recall: RecallModel
    public let firstUse: FirstUseModel
    public let images: GarmentImageLoader
    private let shareInbox: ShareInbox?

    public var selectedTab: AppTab { didSet { environment.restoration.save("app.tab", selectedTab) } }
    public var sheet: AppSheet?
    public private(set) var paths: [AppTab: [AppRoute]]
    /// The option a Calendar or web-board link pointed at; Today scrolls to it.
    public private(set) var highlightedOptionId: String?
    public private(set) var hasLaunched = false

    public init(environment: AppEnvironment, session: OAuthSession?, shareInbox: ShareInbox? = nil) {
        self.environment = environment
        self.shareInbox = shareInbox
        account = AccountModel(environment: environment, session: session)
        today = TodayModel(environment: environment)
        wardrobe = WardrobeModel(environment: environment)
        studio = StudioModel(environment: environment)
        let transcript = TranscriptModel(environment: environment)
        self.transcript = transcript
        let composer = ComposerModel(environment: environment, transcript: transcript)
        self.composer = composer
        capture = CaptureModel(environment: environment, composer: composer)
        laundry = LaundryModel(environment: environment)
        trips = TripsModel(environment: environment)
        returns = ReturnsModel(environment: environment)
        projects = ProjectsModel(environment: environment)
        proposals = ProposalsModel(environment: environment)
        notifications = NotificationsModel(environment: environment)
        let settings = SettingsModel(environment: environment)
        self.settings = settings
        recovery = RecoveryStatusModel(environment: environment)
        export = ExportModel(environment: environment)
        recall = RecallModel(environment: environment)
        firstUse = FirstUseModel(environment: environment, settings: settings)
        images = GarmentImageLoader(environment: environment)
        selectedTab = environment.restoration.load("app.tab") ?? .today
        paths = environment.restoration.load("app.paths", as: [String: [AppRoute]].self).map { saved in
            Dictionary(uniqueKeysWithValues: saved.compactMap { key, value in AppTab(rawValue: key).map { ($0, value) } })
        } ?? [:]

        // A request a reply left stops being shown as waiting once the owner has decided it.
        composer.isSettled = { [weak proposals] turnId, type, summary in proposals?.isSettled(turnId: turnId, type: type, summary: summary) ?? false }
        // Signing out removes this phone's notification registration while the session still exists.
        account.beforeSignOut = { [weak notifications] in await notifications?.signingOut() }

        // Every verified receipt refreshes the reads it may have changed.
        environment.center.onReceipt { [weak self] receipt in
            Task { @MainActor in await self?.receiptArrived(receipt) }
        }
    }

    // MARK: Navigation and restoration

    public func path(for tab: AppTab) -> [AppRoute] { paths[tab] ?? [] }

    public func setPath(_ path: [AppRoute], for tab: AppTab) {
        paths[tab] = path
        environment.restoration.save("app.paths", Dictionary(uniqueKeysWithValues: paths.map { ($0.key.rawValue, $0.value) }))
    }

    public func push(_ route: AppRoute, on tab: AppTab? = nil) {
        let tab = tab ?? selectedTab
        setPath(path(for: tab) + [route], for: tab)
        if tab != selectedTab { selectedTab = tab }
    }

    /// Ask about this: attaches the identity to the composer and opens Conversation.
    public func askAbout(_ ref: AttachedRef, label: String) {
        composer.attach(ref, label: label)
        sheet = nil
        selectedTab = .conversation
    }

    /// Opens a link from the Calendar event or the web board: `/board`, `/board/{date}` with an
    /// optional `#optionId` or `?option=`. The same stable option identity is used on every surface.
    @discardableResult
    public func open(url: URL) -> Bool {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.first == "board" else { return false }
        let option = url.fragment ?? URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "option" }?.value
        highlightedOptionId = option.flatMap { $0.isEmpty ? nil : $0 }
        sheet = nil
        setPath([], for: .today)
        selectedTab = .today
        return true
    }

    public func clearHighlight() { highlightedOptionId = nil }

    // MARK: Lifecycle

    /// Launch: restore the session and the queue, show cached Today, then synchronise.
    public func launch() async {
        guard !hasLaunched else { return }
        hasLaunched = true
        await environment.center.restore()
        today.today.loadCached() // the cached board is on screen before any network call
        await account.restore()
        guard account.isUsable else { return }
        await synchronise()
    }

    /// The app returned to the foreground or the network came back.
    public func becameActive() async {
        guard hasLaunched, account.isUsable else { return }
        await synchronise()
    }

    private func synchronise() async {
        await environment.center.replay()
        if let shareInbox, !shareInbox.all().isEmpty {
            let accepted = await shareInbox.drain(using: environment.api)
            if !accepted.isEmpty { await transcript.refreshLatest() }
        }
        await composer.retryPending()
        await notifications.retryPending()
        await today.refresh()
        await settings.refreshSettings()
        if environment.center.needsSignIn, case .signedIn = account.state { await account.restore() }
    }

    private func receiptArrived(_ receipt: CommandReceipt) async {
        await today.refresh()
        if wardrobe.snapshot.origin != .none { await wardrobe.refresh() }
        if laundry.state.origin != .none, receipt.type.hasPrefix("laundry.") || receipt.type.hasPrefix("care.") || receipt.type.hasPrefix("wear.") { await laundry.state.refresh() }
        if studio.studio.origin != .none, !receipt.type.hasPrefix("studio.") { await studio.studio.refresh() }
    }

    /// Commands and messages on this phone that the backend has not confirmed yet.
    public var unsentCount: Int { environment.center.pending.count + composer.pending.filter { $0.state == .waitingToSend }.count }

    /// The one-line banner shown on every destination while something needs saying.
    public var statusBanner: String? {
        if environment.isDemo { return "Demo data. Changes are not saved." }
        if environment.center.needsSignIn { return "Signed out. Sign in to send \(Phrases.count(unsentCount, "saved action"))." }
        if environment.center.isOffline {
            return unsentCount > 0 ? "Offline. \(Phrases.count(unsentCount, "action")) saved on this phone, not yet sent." : "Offline. Showing saved data."
        }
        if unsentCount > 0 { return "\(Phrases.count(unsentCount, "action")) waiting to be sent." }
        let refused = environment.center.rejected.count
        if refused > 0 { return "\(Phrases.count(refused, "action")) could not be recorded. Review." }
        return nil
    }
}

/// First use: begins with the imported wardrobe and style document, not a blank form.
@MainActor
@Observable
public final class FirstUseModel {
    public enum Step: String, Codable, Sendable, CaseIterable, Identifiable {
        case welcome, connectGoogle, calendar, delivery, sampleBoard
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .welcome: return "Your wardrobe is here"
            case .connectGoogle: return "Connect Google"
            case .calendar: return "Outfit calendar"
            case .delivery: return "Location and morning time"
            case .sampleBoard: return "A sample board"
            }
        }
    }

    public let environment: AppEnvironment
    public let settings: SettingsModel
    public private(set) var step: Step
    public private(set) var isComplete: Bool

    public init(environment: AppEnvironment, settings: SettingsModel) {
        self.environment = environment
        self.settings = settings
        step = environment.restoration.load("firstuse.step") ?? .welcome
        isComplete = environment.restoration.load("firstuse.complete") ?? false
    }

    /// Every step after sign-in can be skipped; none blocks the app or the recommendations.
    public func advance() {
        let all = Step.allCases
        if let i = all.firstIndex(of: step), i + 1 < all.count {
            step = all[i + 1]
            environment.restoration.save("firstuse.step", step)
        } else {
            finish()
        }
    }

    public func back() {
        let all = Step.allCases
        if let i = all.firstIndex(of: step), i > 0 {
            step = all[i - 1]
            environment.restoration.save("firstuse.step", step)
        }
    }

    public func finish() {
        isComplete = true
        environment.restoration.save("firstuse.complete", true)
    }

    /// `Imported: 212 owned, 187 available. Profile version 1 (sha256 e15639d8...).`
    public func importedLine(counts: InventoryPage.Counts?) -> String {
        var parts: [String] = []
        if let counts { parts.append("Your wardrobe is already imported: \(counts.owned) owned, \(counts.available) available.") }
        if let profile = settings.profileLine { parts.append("Your style profile is imported in full (\(profile)). You can read and edit it in Settings, My style.") }
        return parts.isEmpty ? "Your wardrobe and style profile are being loaded." : parts.joined(separator: " ")
    }

    public var googleConnected: Bool {
        (settings.connections.value?.connections ?? []).contains { $0.kind == .googleWorkspace && $0.state == .connected }
    }
}

/// Loads garment images. An image is fetched only when the backend says a real one exists;
/// otherwise the caller shows the garment's name on a labelled tile. Nothing is ever drawn
/// or substituted on the phone.
@MainActor
@Observable
public final class GarmentImageLoader {
    public static let thumbnailWidths = [160, 320, 640, 1280]
    public let environment: AppEnvironment
    private var inFlight: [String: Task<Data?, Never>] = [:]
    private var missing: Set<String> = []
    private var refreshedThisSession: Set<String> = []

    public init(environment: AppEnvironment) { self.environment = environment }

    /// The smallest served width that covers `points` at `scale`.
    public static func width(forPoints points: Double, scale: Double) -> Int {
        let needed = points * scale
        return thumbnailWidths.first { Double($0) >= needed } ?? thumbnailWidths[thumbnailWidths.count - 1]
    }

    /// Bytes for an image reference. A rendition is immutable, so its cached bytes never go stale.
    public func data(for ref: GarmentImageRef, width: Int) async -> Data? {
        guard ref.hasRealImage, let renditionId = ref.renditionId else { return nil }
        let key = "rendition:\(renditionId):\(width)"
        if let cached = environment.media.data(for: key) { return cached }
        let api = environment.api
        return await load(key) { try await api.rendition(id: renditionId, width: width) }
    }

    /// The garment's current display image by garment ID (board cards). Cached bytes are shown
    /// at once and re-checked once per session, because a garment's chosen image can change.
    public func data(forGarment garmentId: String, width: Int) async -> Data? {
        let key = "item:\(garmentId):\(width)"
        if missing.contains(key) { return nil }
        if let cached = environment.media.data(for: key), refreshedThisSession.contains(key) || environment.center.isOffline { return cached }
        let api = environment.api
        let fresh = await load(key) { try await api.itemImage(garmentId: garmentId, width: width) }
        if fresh != nil { refreshedThisSession.insert(key) }
        return fresh ?? environment.media.data(for: key)
    }

    public func cached(forGarment garmentId: String, width: Int) -> Data? { environment.media.data(for: "item:\(garmentId):\(width)") }

    /// The image a review question is about: the candidate asset itself, so the owner decides
    /// on what he sees. An asset's bytes do not change, so cached bytes are used as they are.
    /// Nil when the candidate has no stored asset or it cannot be read.
    public func data(forCandidate item: MediaReviewItem, width: Int) async -> Data? {
        guard let assetId = item.assetId else { return nil }
        let key = "asset:\(assetId):\(width)"
        if missing.contains(key) { return nil }
        if let cached = environment.media.data(for: key) { return cached }
        let api = environment.api
        return await load(key) { try await api.asset(id: assetId, width: width) }
    }

    /// A full-size image for close inspection, through signed delivery: the backend issues a
    /// short-lived address for this one rendition and the bytes are read from it without the
    /// sign-in. The address is never stored and never leaves the app. If it cannot be issued
    /// or has lapsed, the ordinary authenticated read is used instead.
    public func inspectionData(for ref: GarmentImageRef, width: Int = 1280) async -> Data? {
        guard ref.hasRealImage, let renditionId = ref.renditionId else { return nil }
        return await signedData(renditionId: renditionId, width: width)
    }

    /// One of the owner's renditions, read through a signed address (see `inspectionData`).
    public func signedData(renditionId: String, width: Int = 1280) async -> Data? {
        let key = "rendition:\(renditionId):\(width)"
        if let cached = environment.media.data(for: key) { return cached }
        let api = environment.api
        return await load(key) {
            do {
                let signed = try await api.signRendition(id: renditionId, SignRenditionRequest(width: width, ttlSeconds: GarmentImageLoader.signedLifetime))
                return try await api.signedMedia(signed)
            } catch let failure as APIFailure where !failure.isTransport {
                return try await api.rendition(id: renditionId, width: width)
            }
        }
    }
    /// Seconds a signed address is asked to live: long enough for one read.
    public static let signedLifetime = 60

    private func load(_ key: String, _ fetch: @escaping @Sendable () async throws -> Data) async -> Data? {
        if let task = inFlight[key] { return await task.value }
        let media = environment.media
        let task = Task<Data?, Never> { () -> Data? in
            do {
                let data = try await fetch()
                media.store(data, for: key)
                return data
            } catch let failure as APIFailure {
                if case .api(_, let error) = failure, error.code == .notFound { return Data() } // sentinel: no real image exists
                return nil
            } catch {
                return nil
            }
        }
        inFlight[key] = task
        let result = await task.value
        inFlight[key] = nil
        if let result, result.isEmpty { missing.insert(key); return nil }
        return result
    }
}
