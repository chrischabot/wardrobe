import Testing
import Foundation
@testable import GarderobeKit

@MainActor
@Suite("Board links: the linked day's board is loaded before its option is marked")
struct BoardLinkTests {
    private static let base = "https://garderobe.example.test"
    private static let otherDay = "2026-09-17"
    private static let emptyDay = "2026-09-18"

    private func link(_ path: String) -> BoardLink? { BoardLink(url: URL(string: Self.base + path)!) }

    @Test("A board link names an existing calendar date and an option, by fragment or by query")
    func parsing() {
        #expect(link("/board") == BoardLink(url: URL(string: Self.base + "/board")!))
        #expect(link("/board")?.date == nil && link("/board")?.optionId == nil)
        #expect(link("/board/2026-09-17")?.date == "2026-09-17")
        #expect(link("/board/2026-09-17#opt_b")?.optionId == "opt_b")
        #expect(link("/board/2026-09-17?option=opt_c")?.optionId == "opt_c")
        #expect(link("/board#")?.optionId == nil)                         // an empty fragment marks nothing
        #expect(link("/board/2026-02-30") == nil)                         // not a day that exists
        #expect(link("/board/2026-9-17") == nil)                          // not a local date
        #expect(link("/board/2026-09-17/extra") == nil)                   // more than a date
        #expect(link("/boards/2026-09-17") == nil)
        #expect(link("/") == nil)
    }

    private func setup(time: ManualTimeSource = ManualTimeSource(instant: Synthetic.now), store: InMemoryKeyValueStore = InMemoryKeyValueStore()) -> (ScriptedTransport, AppModel, Router) {
        let router = Router()
        router.on("GET", "/v1/today") { request in
            for day in [Self.otherDay, Self.emptyDay] where request.query.contains(URLQueryItem(name: "date", value: day)) {
                return TestSupport.json([
                    "localDate": .string(day), "timezone": "Europe/London", "board": day == Self.otherDay ? Synthetic.board() : .null, "dayRecord": [], "paused": .null,
                    "emptyReason": day == Self.otherDay ? .null : "No board has been composed for this day yet.", "readAt": .string(Synthetic.now), "status": "ready",
                    "freshness": [], "runId": .null, "wardrobeRevision": 5,
                ])
            }
            return TestSupport.json(Synthetic.todayResponse(board: Synthetic.board()))
        }
        let transport = router.transport
        let env = TestSupport.environment(transport: transport, store: store, time: time)
        return (transport, AppModel(environment: env, session: nil), router)
    }

    @Test("A dated link reads that day's board, marks its option only once it has loaded, and /board returns to today")
    func followsDatedLink() async throws {
        let (transport, app, _) = setup()
        await app.today.open()
        #expect(app.today.dateLine == "Tuesday 15 September" && app.today.viewedDate == nil)

        let dated = try #require(link("/board/\(Self.otherDay)#opt_b"))
        await app.follow(dated)
        let read = try #require(transport.requests.last { $0.method == "GET" && $0.path == "/v1/today" })
        #expect(read.query == [URLQueryItem(name: "date", value: Self.otherDay)])
        #expect(app.today.viewedDate == Self.otherDay)
        #expect(app.today.dateLine == "Thursday 17 September")
        #expect(app.today.today.value?.localDate == Self.otherDay)       // that day's own read, not today's board
        #expect(app.highlightedOptionId == "opt_b")

        await app.follow(try #require(link("/board")))
        let back = try #require(transport.requests.last { $0.method == "GET" && $0.path == "/v1/today" })
        #expect(back.query.isEmpty)
        #expect(app.today.viewedDate == nil)
        #expect(app.today.dateLine == "Tuesday 15 September" && app.today.options.count == 2)
        #expect(app.highlightedOptionId == nil)
    }

    @Test("A link naming today's date shows today's own board")
    func todayByDate() async throws {
        let (transport, app, _) = setup()
        await app.follow(try #require(link("/board/\(Synthetic.today)#opt_a")))
        #expect(app.today.viewedDate == nil && app.today.options.count == 2)
        #expect(!transport.requests("GET", "/v1/today").isEmpty && transport.requests("GET", "/v1/today").allSatisfy { $0.query.isEmpty })   // read without a date
        #expect(app.highlightedOptionId == "opt_a")
    }

    @Test("Opening a link switches to Today and clears the old mark at once; a malformed link changes nothing")
    func openSwitchesTab() throws {
        let (_, app, _) = setup()
        app.selectedTab = .wardrobe
        #expect(app.open(url: URL(string: Self.base + "/board/2026-02-30")!) == false)
        #expect(app.selectedTab == .wardrobe)
        #expect(app.open(url: URL(string: Self.base + "/board/\(Self.otherDay)#opt_b")!))
        #expect(app.selectedTab == .today && app.highlightedOptionId == nil)   // marked only after the day loads
    }

    private func heldSetup() -> (HeldDayTransport, AppModel) {
        let (scripted, _, _) = setup()
        let held = HeldDayTransport(inner: scripted, heldDate: Self.otherDay)
        let env = TestSupport.environment(transport: held, store: InMemoryKeyValueStore(), time: ManualTimeSource(instant: Synthetic.now))
        return (held, AppModel(environment: env, session: nil))
    }

    @Test("A slower earlier link never marks the board a later link opened")
    func laterLinkWins() async throws {
        let (held, app) = heldSetup()
        let slow = try #require(link("/board/\(Self.otherDay)#opt_b"))
        let first = Task { await app.follow(slow) }
        await held.arrived()
        await app.follow(try #require(link("/board#opt_a")))
        #expect(app.highlightedOptionId == "opt_a" && app.today.viewedDate == nil)
        held.release()
        await first.value
        #expect(app.highlightedOptionId == "opt_a")                      // the earlier link marked nothing
        #expect(app.today.viewedDate == nil && app.today.options.count == 2)
    }

    @Test("Going back to today while a link is loading leaves nothing marked")
    func backWhilePending() async throws {
        let (held, app) = heldSetup()
        let first = Task { await app.follow(try #require(link("/board/\(Self.otherDay)#opt_b"))) }
        await held.arrived()
        await app.returnToToday()
        held.release()
        try await first.value
        #expect(app.highlightedOptionId == nil && app.today.viewedDate == nil)
    }

    @Test("Back to today's board clears the linked day's mark")
    func backClearsMark() async throws {
        let (_, app, _) = setup()
        await app.follow(try #require(link("/board/\(Self.otherDay)#opt_b")))
        #expect(app.highlightedOptionId == "opt_b")
        await app.returnToToday()
        #expect(app.highlightedOptionId == nil && app.today.viewedDate == nil && app.today.options.count == 2)
    }

    @Test("A link whose day could not be read, with nothing cached for it, marks nothing")
    func failedLoadMarksNothing() async throws {
        let router = Router()
        router.offline.value = true
        let env = TestSupport.environment(transport: router.transport, store: InMemoryKeyValueStore(), time: ManualTimeSource(instant: Synthetic.now))
        let app = AppModel(environment: env, session: nil)
        await app.follow(try #require(link("/board/\(Self.otherDay)#opt_b")))
        #expect(app.today.viewedDate == Self.otherDay && app.today.today.value == nil)
        #expect(app.highlightedOptionId == nil)
        await app.follow(try #require(link("/board#opt_a")))
        #expect(app.highlightedOptionId == nil)
    }

    @Test("Opening a newer link takes the mark away from a link still loading, before its own task runs")
    func openSupersedesAtOnce() async throws {
        let (held, app) = heldSetup()
        let first = Task { await app.follow(try #require(link("/board/\(Self.otherDay)#opt_b"))) }
        await held.arrived()
        #expect(app.open(url: URL(string: Self.base + "/board#opt_a")!))
        held.release()
        try await first.value
        #expect(app.highlightedOptionId != "opt_b")                       // the superseded link never marks
    }

    @Test("A day with no board marks nothing")
    func emptyDayMarksNothing() async throws {
        let (_, app, _) = setup()
        await app.follow(try #require(link("/board/\(Self.emptyDay)#opt_b")))
        #expect(app.today.viewedDate == Self.emptyDay && app.today.board == nil)
        #expect(app.highlightedOptionId == nil)
    }

    @Test("Offline the next morning, a /board link does not mark yesterday's cached board")
    func staleCachedTodayMarksNothing() async throws {
        let time = ManualTimeSource(instant: Synthetic.now)
        let store = InMemoryKeyValueStore()
        let (_, first, router) = setup(time: time, store: store)
        await first.today.open()
        time.advance(24 * 3600)
        router.offline.value = true
        let (_, app, _) = setup(time: time, store: store)
        await app.follow(try #require(link("/board#opt_a")))
        #expect(app.today.today.value?.localDate == Synthetic.today)    // yesterday's board, still cached
        #expect(app.highlightedOptionId == nil)
    }
}

/// A SYNTHETIC backend that holds the read of one day's board until the test lets it go; every
/// other request is answered at once by the scripted router.
private final class HeldDayTransport: HTTPTransport, @unchecked Sendable {
    private let inner: ScriptedTransport
    private let heldDate: String
    private let lock = NSLock()
    private var hasArrived = false
    private var arrivalWaiter: CheckedContinuation<Void, Never>?
    private var released = false
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    init(inner: ScriptedTransport, heldDate: String) { self.inner = inner; self.heldDate = heldDate }

    func arrived() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let already = lock.withLock { () -> Bool in
                if hasArrived { return true }
                arrivalWaiter = continuation
                return false
            }
            if already { continuation.resume() }
        }
    }

    func release() {
        let waiter = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            released = true
            defer { releaseWaiter = nil }
            return releaseWaiter
        }
        waiter?.resume()
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        if request.query.contains(URLQueryItem(name: "date", value: heldDate)) {
            let arrival = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                hasArrived = true
                defer { arrivalWaiter = nil }
                return arrivalWaiter
            }
            arrival?.resume()
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let go = lock.withLock { () -> Bool in
                    if released { return true }
                    releaseWaiter = continuation
                    return false
                }
                if go { continuation.resume() }
            }
        }
        return try await inner.send(request)
    }

    func stream(_ request: HTTPRequest) -> AsyncThrowingStream<Data, Error> { inner.stream(request) }
}
