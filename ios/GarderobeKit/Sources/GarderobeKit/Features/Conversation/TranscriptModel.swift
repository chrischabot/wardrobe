import Foundation
import Observation

/// The one continuous conversation. There are no sessions and no "new chat": the transcript
/// is paged from the canonical store, opens from cache with an honest check time, and keeps
/// the reader's place while older pages load or new output arrives.
@MainActor
@Observable
public final class TranscriptModel {
    /// A row of the transcript: a date separator or a message.
    public enum Row: Sendable, Equatable, Identifiable {
        case date(LocalDate)
        case message(TranscriptEntry)
        public var id: String {
            switch self {
            case .date(let d): return "date:\(d)"
            case .message(let m): return m.id
            }
        }
    }

    /// Messages kept in memory while the reader is at the latest end; older pages are dropped
    /// and fetched again through `loadOlder()` (older content is virtualized).
    public static let window = 240
    public static let pageSize = 40

    public let environment: AppEnvironment
    private let latest: Resource<MessagesPage>

    /// Loaded pages, oldest first, each with the cursor that loads the page before it.
    private var pages: [(messages: [TranscriptEntry], olderCursor: String?)] = []
    /// Local entries not yet in the canonical transcript (pending turns, streaming output).
    private var local: [TranscriptEntry] = []
    private var newerCursor: String?

    public private(set) var isLoadingOlder = false
    public private(set) var isViewingHistory = false
    /// The message the reader is at; persisted so the place survives closing the app.
    public private(set) var readingAnchor: String?
    public private(set) var isAtBottom = true
    /// Messages that arrived while the reader was scrolled away.
    public private(set) var unseenCount = 0
    public private(set) var olderFailure: APIFailure?
    private var returnPoint: (pages: [(messages: [TranscriptEntry], olderCursor: String?)], anchor: String?, atBottom: Bool)?

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        latest = environment.resource("conversation.latest") { try await api.messages(limit: TranscriptModel.pageSize) }
        readingAnchor = environment.restoration.load("conversation.anchor")
    }

    // MARK: Reading

    public var entries: [TranscriptEntry] { pages.flatMap(\.messages) + (isViewingHistory ? [] : local) }

    /// Messages with a date separator wherever the local date changes.
    public var rows: [Row] {
        var out: [Row] = []
        var last: LocalDate?
        for entry in entries {
            if let date = entry.localDate, date != last { out.append(.date(date)); last = date }
            out.append(.message(entry))
        }
        return out
    }

    public var hasOlder: Bool { pages.first?.olderCursor != nil }
    public var hasNewBelow: Bool { unseenCount > 0 }

    public var freshnessLine: String {
        latest.freshness.statement(subject: "conversation", now: environment.time.now(), timeZone: environment.timeZone)
    }
    public var isOffline: Bool { latest.freshness.isOffline }

    private func entries(from page: MessagesPage) -> [TranscriptEntry] {
        page.messages.map { TranscriptEntry($0, timeZone: environment.timeZone) }
    }

    /// Shows the cached latest page at once, then reads the current one.
    public func loadLatest() async {
        if pages.isEmpty {
            latest.loadCached()
            if let cached = latest.value { pages = [(entries(from: cached), cached.nextBefore)] }
        }
        await refreshLatest()
    }

    /// Re-reads the latest page and merges it by message ID.
    public func refreshLatest() async {
        guard await latest.refresh(), let page = latest.value, !isViewingHistory else { return }
        merge(latestPage: page)
    }

    private func merge(latestPage page: MessagesPage) {
        let fresh = entries(from: page)
        let known = Set(pages.flatMap(\.messages).map(\.id))
        let freshIds = Set(fresh.map(\.id))
        if pages.isEmpty || known.isDisjoint(with: freshIds) {
            // Nothing overlaps (first load, or a long gap): the latest page becomes the window.
            pages = [(fresh, page.nextBefore)]
        } else {
            // Replace entries that are in the fresh page, append the ones that are new.
            for i in pages.indices {
                pages[i].messages = pages[i].messages.map { old in fresh.first { $0.id == old.id } ?? old }
            }
            let added = fresh.filter { !known.contains($0.id) }
            pages[pages.count - 1].messages.append(contentsOf: added)
            noteArrivals(added.filter { $0.role != .user }.count)
        }
        newerCursor = page.nextAfter
        // Local entries the canonical transcript now contains are dropped (no duplicates).
        let turnIds = Set(fresh.compactMap(\.turnId))
        local.removeAll { entry in freshIds.contains(entry.id) || (entry.delivery != .streaming && entry.turnId.map(turnIds.contains) == true) }
        trimIfNeeded()
    }

    /// Loads the page before the oldest loaded message. The reading anchor is not changed, so
    /// the view keeps the reader where they were.
    public func loadOlder() async {
        guard !isLoadingOlder, let cursor = pages.first?.olderCursor else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            let page = try await environment.api.messages(before: cursor, limit: TranscriptModel.pageSize)
            let known = Set(pages.flatMap(\.messages).map(\.id))
            pages.insert((entries(from: page).filter { !known.contains($0.id) }, page.nextBefore), at: 0)
            olderFailure = nil
        } catch let failure as APIFailure {
            olderFailure = failure
            environment.center.noteRead(failure: failure)
        } catch {}
    }

    /// Opens the transcript around an older message (history search, recall). The current
    /// window and reading position are kept to return to.
    public func jump(toMessage messageId: String) async {
        do {
            let page = try await environment.api.messages(around: messageId, limit: TranscriptModel.pageSize)
            if !isViewingHistory { returnPoint = (pages, readingAnchor, isAtBottom) }
            pages = [(entries(from: page), page.nextBefore)]
            isViewingHistory = true
            isAtBottom = false
            readingAnchor = messageId
            olderFailure = nil
        } catch let failure as APIFailure {
            olderFailure = failure
        } catch {}
    }

    /// Returns from a recalled message to the latest messages and the position held before.
    public func returnToLatest() async {
        guard isViewingHistory else { return }
        isViewingHistory = false
        if let point = returnPoint {
            pages = point.pages
            readingAnchor = point.anchor
            isAtBottom = point.atBottom
        }
        returnPoint = nil
        environment.restoration.save("conversation.anchor", readingAnchor ?? "")
        await refreshLatest()
    }

    /// The view reports where the reader is.
    public func setReader(atBottom: Bool, anchor: String?) {
        isAtBottom = atBottom
        if let anchor, !isViewingHistory {
            readingAnchor = anchor
            environment.restoration.save("conversation.anchor", anchor)
        }
        if atBottom { unseenCount = 0; trimIfNeeded() }
    }

    public func markSeen() { unseenCount = 0 }

    private func noteArrivals(_ count: Int) {
        if count > 0, !isAtBottom || isViewingHistory { unseenCount += count }
    }

    /// Drops the oldest pages while the reader is at the latest end and the window is exceeded.
    private func trimIfNeeded() {
        guard isAtBottom, !isViewingHistory else { return }
        while pages.count > 1, pages.reduce(0, { $0 + $1.messages.count }) - pages[0].messages.count >= TranscriptModel.window { pages.removeFirst() }
    }

    // MARK: Local and streaming entries

    /// Adds or updates an entry that is not in the canonical transcript yet.
    public func upsertLocal(_ entry: TranscriptEntry) {
        if let i = local.firstIndex(where: { $0.id == entry.id }) {
            local[i] = entry
        } else {
            local.append(entry)
            if entry.role != .user { noteArrivals(1) }
        }
    }

    public func removeLocal(_ id: String) { local.removeAll { $0.id == id } }

    public func localEntry(_ id: String) -> TranscriptEntry? { local.first { $0.id == id } }

    /// Streamed text for an assistant message: one entry per message ID, updated in place.
    public func applyStream(messageId: String, text: String) {
        let now = environment.time.now()
        if var existing = local.first(where: { $0.id == messageId }) {
            existing.text = text
            upsertLocal(existing)
        } else if !pages.flatMap(\.messages).contains(where: { $0.id == messageId }) {
            upsertLocal(TranscriptEntry(id: messageId, role: .assistant, authoredAt: now, localDate: Dates.localDate(of: now, in: environment.timeZone), text: text, delivery: .streaming))
        }
    }

    /// Attaches a card (board, sources, receipt...) to a streaming message.
    public func appendCard(_ part: MessagePart, toMessage messageId: String) {
        let now = environment.time.now()
        var entry = local.first { $0.id == messageId } ?? TranscriptEntry(id: messageId, role: .assistant, authoredAt: now, localDate: Dates.localDate(of: now, in: environment.timeZone), text: "", delivery: .streaming)
        if !entry.parts.contains(part) { entry.parts.append(part) }
        upsertLocal(entry)
    }

    /// A streaming entry settled under its canonical message ID: the placeholder is renamed so
    /// the next transcript read replaces it instead of adding a second copy.
    public func settleStream(placeholderId: String, messageId: String, text: String) {
        guard var entry = local.first(where: { $0.id == placeholderId }) else { return }
        local.removeAll { $0.id == placeholderId || $0.id == messageId }
        entry.id = messageId
        entry.text = text
        entry.delivery = .settled
        if !pages.flatMap(\.messages).contains(where: { $0.id == messageId }) { local.append(entry) }
    }
}
