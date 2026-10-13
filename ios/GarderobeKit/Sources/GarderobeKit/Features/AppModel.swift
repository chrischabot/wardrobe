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
        composer.settledCount = { [weak proposals] turnId, type, summary in proposals?.settledCount(turnId: turnId, type: type, summary: summary) ?? 0 }
        // Signing out removes this phone's notification registration while the session still exists.
        account.beforeSignOut = { [weak notifications] in await notifications?.signingOut() }
        // A waiting notification request is only ever sent as the account that made it.
        notifications.currentAccount = { [weak account] in
            if case .signedIn(let me)? = account?.state { return me.userId }
            return nil
        }

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
    /// A malformed date is not a board link. The linked day's board is loaded first and the option
    /// is marked only on it, never on another day's board.
    @discardableResult
    public func open(url: URL) -> Bool {
        guard let link = BoardLink(url: url) else { return false }
        let generation = beginLink()
        sheet = nil
        setPath([], for: .today)
        selectedTab = .today
        Task { @MainActor [weak self] in await self?.load(link, generation: generation) }
        return true
    }

    /// Loads the board a link names, then marks its option. Only the latest link (or return to
    /// today) counts: an earlier one that finishes later marks nothing.
    public func follow(_ link: BoardLink) async {
        await load(link, generation: beginLink())
    }

    /// Today's own board again, with no mark from a link for another day.
    public func returnToToday() async {
        _ = beginLink()
        await today.show(date: nil)
    }

    /// Starts a link open or return to today: earlier ones lose their claim to the mark at once.
    private func beginLink() -> Int {
        linkGeneration += 1
        highlightedOptionId = nil
        return linkGeneration
    }

    /// Marks the option only when this is still the latest link and a board for the linked day is
    /// on screen (just read, or cached when the read failed). A superseded link loads nothing; a
    /// first read that fails, a stale cached day or a day with no board marks nothing.
    private func load(_ link: BoardLink, generation: Int) async {
        guard generation == linkGeneration else { return }
        await today.show(date: link.date)
        guard generation == linkGeneration, today.viewedDate == today.viewTarget(for: link.date),
              let shown = today.today.value, shown.board != nil,
              shown.localDate == (link.date ?? environment.today) else { return }
        highlightedOptionId = link.optionId
    }

    /// Counts link opens and returns to today, so a slower earlier one cannot mark a later board.
    private var linkGeneration = 0

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
        if let garmentIds = GarmentImageLoader.imageChange(in: receipt) { images.garmentImagesChanged(garmentIds) }
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
    private var inFlight: [String: Task<Fetched, Never>] = [:]
    /// Keys the backend confirmed have no image, with when it said so. An entry expires after
    /// `missingLifetime`, so a photograph added later is found without relaunching.
    private var missing: [String: Date] = [:]
    private var refreshedThisSession: Set<String> = []
    /// Seconds a confirmed absence is trusted before the backend is asked again.
    public static let missingLifetime: TimeInterval = 600

    /// What a read of an image found.
    public enum Outcome: Sendable, Equatable {
        case image(Data)
        /// The backend says no real image exists: the garment's name is shown on a labelled tile.
        case noImage
        /// The image could not be read (offline, a server fault) and nothing is cached: the
        /// tile says so and offers to try again. Never presented as "No photo yet".
        case unavailable
    }

    private enum Fetched: Sendable { case data(Data), notFound, failed }

    public init(environment: AppEnvironment) { self.environment = environment }

    /// Counts resets: a read that started for an account that has since ended stores nothing.
    private var epoch = 0

    /// The account ended: forget what was learnt about its images (the bytes are removed with the media cache).
    public func reset() {
        epoch += 1
        inFlight = [:]
        missing = [:]
        refreshedThisSession = []
        changes = [:]
    }

    /// Counts media changes per cache key: a read that started before the garment's images
    /// changed stores nothing, so the old photograph cannot come back after the change.
    private var changes: [String: Int] = [:]

    /// Counts media changes per garment (and for all garments): tiles read again when it moves.
    private var revisions: [String: Int] = [:]
    private var allRevision = 0
    /// The garment's image revision on this phone; it changes whenever its images may have.
    public func revision(forGarment garmentId: String) -> Int { allRevision + (revisions[garmentId] ?? 0) }

    /// The backend recorded a change to these garments' images (a new primary photograph, an
    /// asset deleted, a review decided): what this phone holds for them is no longer evidence.
    /// Their bytes, their "checked this session" marks and any absence learnt are dropped, and
    /// a read on its way is not kept. With no garment named, every garment image is re-checked
    /// (bytes are kept to show until then, as they are offline).
    public func garmentImagesChanged(_ garmentIds: [String]) {
        if garmentIds.isEmpty { allRevision += 1 } else { for id in garmentIds { revisions[id, default: 0] += 1 } }
        if garmentIds.isEmpty {
            let reading = inFlight.keys.filter { $0.hasPrefix("item:") }
            for key in refreshedThisSession.union(reading) { changes[key, default: 0] += 1; inFlight[key] = nil }
            refreshedThisSession = []
            for key in missing.keys where key.hasPrefix("item:") { missing[key] = nil }
            return
        }
        for garmentId in garmentIds {
            for key in itemKeys(garmentId) {
                changes[key, default: 0] += 1
                inFlight[key] = nil
                missing[key] = nil
                refreshedThisSession.remove(key)
                environment.media.remove(key)
            }
        }
    }

    /// Every key this phone holds for a garment's current image, at any width: cached bytes,
    /// reads on their way, checked marks and learnt absences, and the served widths.
    private func itemKeys(_ garmentId: String) -> Set<String> {
        let prefix = "item:\(garmentId):"
        var keys = Set(GarmentImageLoader.thumbnailWidths.map { prefix + String($0) })
        keys.formUnion(environment.media.keys(prefix: prefix))
        keys.formUnion(inFlight.keys.filter { $0.hasPrefix(prefix) })
        keys.formUnion(refreshedThisSession.filter { $0.hasPrefix(prefix) })
        keys.formUnion(missing.keys.filter { $0.hasPrefix(prefix) })
        return keys
    }

    /// The garment an `item:` key belongs to.
    private static func garmentId(ofItemKey key: String) -> String? {
        guard key.hasPrefix("item:"), let end = key.lastIndex(of: ":"), end > key.index(key.startIndex, offsetBy: 4) else { return nil }
        return String(key[key.index(key.startIndex, offsetBy: 5)..<end])
    }

    /// Whether a receipt changed what garment images show, and for which garments.
    public static func imageChange(in receipt: CommandReceipt) -> [String]? {
        guard receipt.type.hasPrefix("media."), receipt.type != "media.authorize_upload",
              receipt.type != "media.request_discovery", receipt.type != "media.request_composite_preview" else { return nil }
        return receipt.affected.filter { $0.kind == "garment" }.map(\.id)
    }

    /// The smallest served width that covers `points` at `scale`.
    public static func width(forPoints points: Double, scale: Double) -> Int {
        let needed = points * scale
        return thumbnailWidths.first { Double($0) >= needed } ?? thumbnailWidths[thumbnailWidths.count - 1]
    }

    private func isMissing(_ key: String) -> Bool {
        guard let since = missing[key] else { return false }
        if environment.time.now().timeIntervalSince(since) < GarmentImageLoader.missingLifetime { return true }
        missing[key] = nil
        return false
    }

    /// The backend confirmed the image is gone: earlier bytes for it are no longer shown. For a
    /// garment's current image that holds at every width: no other resolution kept on this phone
    /// stays as evidence that the photograph exists, and a read at another width that began
    /// before the answer is not kept. The garment's revision moves too, so a tile already showing
    /// the photograph at another width reads again and shows that there is none.
    private func confirmAbsent(_ key: String) {
        let now = environment.time.now()
        var keys: Set<String> = [key]
        if let garmentId = GarmentImageLoader.garmentId(ofItemKey: key) {
            keys.formUnion(itemKeys(garmentId))
            revisions[garmentId, default: 0] += 1
        }
        for each in keys {
            if each != key { changes[each, default: 0] += 1; inFlight[each] = nil }
            missing[each] = now
            environment.media.remove(each)
            refreshedThisSession.remove(each)
        }
    }

    /// Bytes a tile could not decode are not a photograph: they are dropped, with the mark that
    /// the garment's image was checked this session, so trying again reads it from the backend.
    public func discardUndecodable(garmentId: String, image ref: GarmentImageRef?, width: Int) {
        if let ref, ref.renditionId != nil || !ref.hasRealImage {
            guard let renditionId = ref.renditionId else { return }
            environment.media.remove("rendition:\(renditionId):\(width)")
            return
        }
        let key = "item:\(garmentId):\(width)"
        environment.media.remove(key)
        refreshedThisSession.remove(key)
    }

    /// What a garment tile shows at once, before any read: the exact rendition's bytes when the
    /// reference names one, nothing when the reference says no real image exists, otherwise the
    /// garment's current image as last read (also when a reference claims a real image but names
    /// no rendition: that is an incomplete reference, not a confirmed absence).
    public func cachedImage(garmentId: String, image ref: GarmentImageRef?, width: Int) -> Data? {
        if let ref, ref.renditionId != nil || !ref.hasRealImage {
            guard ref.hasRealImage, let renditionId = ref.renditionId else { return nil }
            return environment.media.data(for: "rendition:\(renditionId):\(width)")
        }
        let key = "item:\(garmentId):\(width)"
        return isMissing(key) ? nil : environment.media.data(for: key)
    }

    /// Reads what a garment tile shows: the exact rendition when the reference names one, no
    /// image when it says none exists, otherwise the garment's current image. A reference that
    /// claims a real image without naming a rendition is incomplete, not the backend saying no
    /// photograph exists: the garment's current image is read, so a failure shows as unavailable.
    public func image(garmentId: String, image ref: GarmentImageRef?, width: Int) async -> Outcome {
        if let ref, ref.renditionId != nil || !ref.hasRealImage {
            guard ref.hasRealImage, let renditionId = ref.renditionId else { return .noImage }
            return await renditionOutcome(renditionId, width: width)
        }
        return await garmentOutcome(garmentId, width: width)
    }

    private func renditionOutcome(_ renditionId: String, width: Int) async -> Outcome {
        let key = "rendition:\(renditionId):\(width)"
        if let cached = environment.media.data(for: key) { return .image(cached) }
        let api = environment.api
        switch await load(key, { try await api.rendition(id: renditionId, width: width) }) {
        case .data(let data): return .image(data)
        case .notFound:
            // The reference says the garment has a real photograph: a missing rendition is a
            // broken reference, not "no photo yet". It is shown as unavailable, and trying again
            // reads it again.
            missing[key] = nil
            return .unavailable
        case .failed: return .unavailable
        }
    }

    private func garmentOutcome(_ garmentId: String, width: Int) async -> Outcome {
        let key = "item:\(garmentId):\(width)"
        if isMissing(key) { return .noImage }
        if let cached = environment.media.data(for: key), refreshedThisSession.contains(key) || environment.center.isOffline { return .image(cached) }
        let api = environment.api
        switch await load(key, { try await api.itemImage(garmentId: garmentId, width: width) }) {
        case .data(let data):
            refreshedThisSession.insert(key)
            return .image(data)
        case .notFound:
            return .noImage
        case .failed:
            // Not answered: the bytes last read are still the best evidence of the photograph.
            return environment.media.data(for: key).map(Outcome.image) ?? .unavailable
        }
    }

    /// Bytes for an image reference. A rendition is immutable, so its cached bytes never go stale.
    public func data(for ref: GarmentImageRef, width: Int) async -> Data? {
        guard ref.hasRealImage, let renditionId = ref.renditionId else { return nil }
        if case .image(let data) = await renditionOutcome(renditionId, width: width) { return data }
        return nil
    }

    /// The garment's current display image by garment ID (board cards). Cached bytes are shown
    /// at once and re-checked once per session, because a garment's chosen image can change.
    public func data(forGarment garmentId: String, width: Int) async -> Data? {
        if case .image(let data) = await garmentOutcome(garmentId, width: width) { return data }
        return nil
    }

    public func cached(forGarment garmentId: String, width: Int) -> Data? { cachedImage(garmentId: garmentId, image: nil, width: width) }

    /// The image a review question is about: the candidate asset itself, so the owner decides
    /// on what he sees. An asset's bytes do not change, so cached bytes are used as they are.
    /// Nil when the candidate has no stored asset or it cannot be read.
    public func data(forCandidate item: MediaReviewItem, width: Int) async -> Data? {
        guard let assetId = item.assetId else { return nil }
        let key = "asset:\(assetId):\(width)"
        if isMissing(key) { return nil }
        if let cached = environment.media.data(for: key) { return cached }
        let api = environment.api
        if case .data(let data) = await load(key, { try await api.asset(id: assetId, width: width) }) { return data }
        return nil
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
        let fetched = await load(key) {
            do {
                let signed = try await api.signRendition(id: renditionId, SignRenditionRequest(width: width, ttlSeconds: GarmentImageLoader.signedLifetime))
                return try await api.signedMedia(signed)
            } catch let failure as APIFailure where !failure.isTransport {
                return try await api.rendition(id: renditionId, width: width)
            }
        }
        if case .data(let data) = fetched { return data }
        return nil
    }
    /// Seconds a signed address is asked to live: long enough for one read.
    public static let signedLifetime = 60

    private func load(_ key: String, _ fetch: @escaping @Sendable () async throws -> Data) async -> Fetched {
        // Every caller, including one that joins a read already on its way, has the answer checked
        // against the account and the garment's media changes before it is used.
        let mine = epoch
        let changedAt = changes[key] ?? 0
        if let task = inFlight[key] {
            let result = await task.value
            guard mine == epoch, changedAt == (changes[key] ?? 0) else { return .failed }
            return result
        }
        let task = Task<Fetched, Never> { () -> Fetched in
            do {
                return .data(try await fetch())
            } catch let failure as APIFailure {
                if case .api(_, let error) = failure, error.code == .notFound { return .notFound }
                return .failed
            } catch {
                return .failed
            }
        }
        inFlight[key] = task
        let result = await task.value
        if inFlight[key] == task { inFlight[key] = nil }
        // Read for an account that has since ended, or before the garment's images changed:
        // nothing is kept and nothing is shown.
        guard mine == epoch, changedAt == (changes[key] ?? 0) else { return .failed }
        switch result {
        case .data(let data): environment.media.store(data, for: key)
        case .notFound: confirmAbsent(key)
        case .failed: break
        }
        return result
    }
}

/// A board link from the Calendar event or the web board: `/board` or `/board/{date}`, with an
/// optional `#optionId` or `?option=`.
public struct BoardLink: Sendable, Equatable {
    /// The day the link names; nil for the current board.
    public let date: LocalDate?
    public let optionId: String?

    public init?(url: URL) {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.first == "board", parts.count <= 2 else { return nil }
        if parts.count == 2 {
            // A calendar date that exists: 2026-02-30 is not one.
            let day = parts[1]
            guard Dates.isLocalDate(day), let noon = Dates.noon(of: day, in: Dates.utc), Dates.localDate(of: noon, in: Dates.utc) == day else { return nil }
            date = day
        } else {
            date = nil
        }
        let option = url.fragment ?? URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "option" }?.value
        optionId = option.flatMap { $0.isEmpty ? nil : $0 }
    }
}
