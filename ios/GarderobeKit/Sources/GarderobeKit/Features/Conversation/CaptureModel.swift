import Foundation
import Observation

/// The capture sheet's three intents.
public enum CaptureIntent: String, Sendable, CaseIterable, Identifiable {
    case addItem, identify, whatIWore
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .addItem: return "Add an item"
        case .identify: return "Identify this"
        case .whatIWore: return "What I wore"
        }
    }
    public var explanation: String {
        switch self {
        case .addItem: return "Photograph a garment you own to add it to your wardrobe."
        case .identify: return "Photograph something to find out what it is. Nothing is added or logged."
        case .whatIWore: return "Photograph what you are wearing to match it against your wardrobe."
        }
    }
    public var symbol: String {
        switch self {
        case .addItem: return "plus.rectangle.on.rectangle"
        case .identify: return "questionmark.viewfinder"
        case .whatIWore: return "figure.stand"
        }
    }
    var turnIntent: TurnIntent {
        switch self {
        case .addItem: return .addItem
        case .identify: return .identify
        case .whatIWore: return .whatIWore
        }
    }
    /// What a photograph taken for this purpose is, when the purpose itself says so: the owner
    /// who taps "What I wore" has said the photo shows them wearing it. "Identify this" says
    /// nothing about the photo, so the owner is asked and may leave it unsaid.
    var photoRole: PhotoRole? {
        switch self {
        case .addItem: return .itemPhoto
        case .identify: return nil
        case .whatIWore: return .selfie
        }
    }
    var uploadIntent: UploadIntent {
        switch self {
        case .addItem: return .garmentPhoto
        case .identify: return .attachment
        case .whatIWore: return .selfie
        }
    }
}

/// Capture: pick an intent, add a photo, optionally a note, then submit. Taking a photo
/// authorizes nothing: the photo is only uploaded. Submitting sends one conversation turn
/// with the chosen intent; whether anything is recorded is decided by the backend under its
/// command policy, and what it recorded comes back as receipts with undo. The phone never
/// matches a photo to a garment and never sends a wear command from this sheet.
@MainActor
@Observable
public final class CaptureModel {
    public let environment: AppEnvironment
    private let composer: ComposerModel
    public let uploads: UploadModel

    public var intent: CaptureIntent? { didSet { if intent != oldValue { identifyRole = nil } } }
    /// For "Identify this": what the owner says the photo is. Unset until they say.
    public var identifyRole: PhotoRole? {
        didSet { for item in uploads.items { uploads.setRole(roleForNewPhoto, for: item.id) } }
    }
    public var note = ""
    public private(set) var photoAccessDenied = false
    public private(set) var submittedTurnId: String?

    public init(environment: AppEnvironment, composer: ComposerModel) {
        self.environment = environment
        self.composer = composer
        uploads = UploadModel(environment: environment)
    }

    /// The role a photo added now carries: the purpose's own, or what the owner chose.
    private var roleForNewPhoto: PhotoRole? { intent?.photoRole ?? (intent == .identify ? identifyRole : nil) }
    /// True when the sheet should ask what the photo is (the purpose does not say).
    public var asksPhotoRole: Bool { intent == .identify }

    /// Adds a photo for the chosen intent. Uploads it; sends no turn and no command.
    public func addPhoto(data: Data, contentType: UploadContentType) async {
        guard let intent else { return }
        await uploads.add(data: data, contentType: contentType, intent: intent.uploadIntent, wearingDate: intent == .whatIWore ? environment.today : nil, role: roleForNewPhoto)
    }

    /// The platform reports that camera or photo access is denied.
    public func setPhotoAccess(denied: Bool) { photoAccessDenied = denied }

    /// Shown when access is denied: the sheet stays usable without a photo.
    public var accessMessage: String? {
        guard photoAccessDenied else { return nil }
        return "Garderobe cannot use the camera or your photos. You can still describe it in words below, or allow access in Settings."
    }

    public var blockedReason: String? {
        guard intent != nil else { return "Choose what this is for." }
        if uploads.items.contains(where: { if case .rejected = $0.state { return true }; return false }) { return "Remove the photo that was not accepted." }
        if uploads.items.contains(where: { if case .failed = $0.state { return true }; return false }) { return "A photo did not upload. Retry or remove it." }
        if uploads.hasUnfinished { return "The photo is still uploading." }
        if uploads.items.isEmpty && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Add a photo or describe it." }
        return nil
    }
    public var canSubmit: Bool { blockedReason == nil }

    /// Sends one conversation turn carrying the intent and the finalized photo. When the owner
    /// wrote nothing, the message text is the name of the intent they tapped.
    public func submit() async {
        guard canSubmit, let intent else { return }
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let turn = PendingTurn(clientTurnId: environment.ids.next("turn"), text: text.isEmpty ? intent.title : text, attachmentIds: uploads.readyAssetIds, imageRoles: uploads.readyImageRoles, attachedRefs: [],
                               intent: intent.turnIntent, sharedUrl: nil, createdAt: environment.time.now(), state: .waitingToSend, turnId: nil, runId: nil)
        submittedTurnId = turn.clientTurnId
        note = ""
        uploads.removeAll()
        await composer.submit(turn)
    }

    private var isMine: Bool { submittedTurnId != nil }

    /// What the backend recorded for this capture (each with undo through the receipt).
    public var receipts: [RunReceiptRef] { isMine ? composer.follower?.receipts ?? [] : [] }
    /// One compact question containing only the unresolved pieces, when the match was ambiguous.
    public var pendingInput: PendingInput? { isMine ? composer.pendingInput : nil }
    public var activity: String? { isMine ? composer.activity : nil }
    public var notice: String? { isMine ? composer.notice : nil }

    /// True while the turn is saved on the phone but not yet accepted (offline).
    public var isWaitingToSend: Bool { composer.pending.contains { $0.clientTurnId == submittedTurnId && $0.state == .waitingToSend } }

    public func answer(choiceId: String) async { await composer.answer(choiceId: choiceId) }
    public func answer(text: String) async { await composer.answer(text: text) }

    public func reset() {
        intent = nil; note = ""; submittedTurnId = nil; identifyRole = nil
        uploads.removeAll()
    }
}

/// A product link shared from Safari, waiting to be handed to Conversation.
public struct SharedLink: Codable, Sendable, Equatable, Identifiable {
    /// The `clientTurnId`, created when the link was shared, so a retry never duplicates the turn.
    public var id: String
    public var url: String
    public var pageTitle: String?
    public var note: String?
    public var createdAt: Date
}

public enum ShareInboxError: Error, Sendable, Equatable {
    case notAWebLink
    case storage
}

/// The hand-off from the Safari share extension, stored in the app-group container. Draining
/// it submits each link as the same turn a pasted URL produces from the composer.
public final class ShareInbox: Sendable {
    private let store: KeyValueStore
    private static let key = "share.inbox"
    public init(store: KeyValueStore) { self.store = store }

    public func all() -> [SharedLink] {
        guard let data = store.read(ShareInbox.key) else { return [] }
        return ((try? GarderobeJSON.decode([SharedLink].self, from: data)) ?? []).sorted { $0.createdAt < $1.createdAt }
    }

    private func save(_ links: [SharedLink]) throws {
        do { try store.write(ShareInbox.key, try GarderobeJSON.encode(links)) } catch { throw ShareInboxError.storage }
    }

    /// Accepts only http and https links.
    @discardableResult
    public func add(url: String, pageTitle: String?, note: String?, id: String, now: Date) throws -> SharedLink {
        guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(), scheme == "http" || scheme == "https", parsed.host?.isEmpty == false else {
            throw ShareInboxError.notAWebLink
        }
        var links = all()
        if let existing = links.first(where: { $0.id == id }) { return existing }
        let link = SharedLink(id: id, url: url, pageTitle: pageTitle, note: note, createdAt: now)
        links.append(link)
        try save(links)
        return link
    }

    public func remove(_ id: String) {
        try? save(all().filter { $0.id != id })
    }

    /// The turn a shared link becomes: a product investigation with the link as data.
    public static func request(for link: SharedLink) -> TurnRequest {
        let text = link.note?.trimmingCharacters(in: .whitespacesAndNewlines)
        return TurnRequest(clientTurnId: link.id, text: (text?.isEmpty == false ? text! : link.pageTitle ?? link.url), intent: .productInvestigation, sharedUrl: link.url)
    }

    /// Submits every waiting link. A link leaves the inbox only after the backend accepted its
    /// turn (or finally refused it); a transport failure leaves it for the next attempt.
    /// Returns the accepted turns.
    @discardableResult
    public func drain(using api: APIClient) async -> [TurnResponse] {
        var accepted: [TurnResponse] = []
        for link in all() {
            do {
                accepted.append(try await api.submitTurn(ShareInbox.request(for: link)))
                remove(link.id)
            } catch let failure as APIFailure {
                if failure.isRetryable || failure.needsSignIn { break }
                remove(link.id) // refused for good (for example an invalid link): retrying cannot help
            } catch {
                break
            }
        }
        return accepted
    }
}

/// The unobtrusive history search over dated conversations and judgments.
@MainActor
@Observable
public final class RecallModel {
    public let environment: AppEnvironment
    public var query = ""
    public var from: LocalDate?
    public var to: LocalDate?
    public private(set) var result: RecallResult?
    public private(set) var isSearching = false
    public private(set) var message: String?

    public init(environment: AppEnvironment) { self.environment = environment }

    public func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || from != nil || to != nil else { result = nil; return }
        isSearching = true
        defer { isSearching = false }
        do {
            result = try await environment.api.recall(RecallQuery(text: text.isEmpty ? nil : text, from: from, to: to))
            message = nil
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            message = failure.isTransport ? "Offline. History search needs a connection." : failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            message = "The search could not be run."
        }
    }

    public var hits: [RecallHit] { result?.hits ?? [] }

    /// What the search did and did not cover, stated plainly.
    public var coverageLine: String? {
        guard let r = result else { return nil }
        var parts: [String] = []
        if let range = r.resolvedRange { parts.append("Searched \(Phrases.dayMonth(range.from)) to \(Phrases.dayMonth(range.to)) (\(range.basis)).") }
        if let ambiguity = r.ambiguity { parts.append(ambiguity) }
        if !r.exhaustive { parts.append("These results may not be everything.") }
        if r.watermark.unindexedMessages > 0 {
            parts.append(r.indexGap?.searchedSourceDirectly == true
                ? "\(Phrases.count(r.watermark.unindexedMessages, "recent message")) not yet indexed were searched directly."
                : "\(Phrases.count(r.watermark.unindexedMessages, "recent message")) are not indexed yet and may be missing.")
        }
        if !r.caveat.isEmpty { parts.append(r.caveat) }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// `You, 14 July` / `Garderobe, 2 June` - who said it and when.
    public func attribution(_ hit: RecallHit) -> String {
        let who = hit.speaker == .owner ? "You" : "Garderobe"
        let when = Dates.parseInstant(hit.authoredAt).map { Phrases.dayMonth(Dates.localDate(of: $0, in: environment.timeZone)) + " " + String(Dates.localDate(of: $0, in: environment.timeZone).prefix(4)) } ?? hit.authoredAt
        return "\(who), \(when)"
    }

    /// The message to open in the transcript for a hit.
    public func open(_ hit: RecallHit) -> String { hit.messageId }
}
