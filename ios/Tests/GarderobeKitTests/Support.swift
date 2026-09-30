import Foundation
import Synchronization
import Testing
@testable import GarderobeKit

/// A sleeper that suspends until the test advances it (controls the 8 s banner, retries, reconnects).
actor ManualClock {
    private var waiters: [CheckedContinuation<Void, Error>] = []
    private(set) var requested: [Duration] = []

    func sleep(_ d: Duration) async throws {
        requested.append(d)
        try await withCheckedThrowingContinuation { waiters.append($0) }
    }

    func advance() {
        let w = waiters
        waiters = []
        for c in w { c.resume() }
    }

    var pending: Int { waiters.count }
}

final class Counter: Sendable {
    private let value = Mutex(0)
    func next() -> Int { value.withLock { $0 += 1; return $0 } }
}

@MainActor
struct Harness {
    let server: FixtureServer
    let store: MemoryClientStore
    let env: AppEnvironment
    let clock: ManualClock

    /// `manualSleep: false` makes every sleep return immediately (retries, validation debounce).
    static func make(manualSleep: Bool = false, store: MemoryClientStore = MemoryClientStore(), server: FixtureServer? = nil, now: Date = Fixtures.demoNow) throws -> Harness {
        let server = try server ?? FixtureServer(now: { now })
        let clock = ManualClock()
        let ids = Counter()
        let sleep: @Sendable (Duration) async throws -> Void
        if manualSleep { sleep = { d in try await clock.sleep(d) } } else { sleep = { _ in await Task.yield() } }
        let uuid: @Sendable () -> String = {
            let n = ids.next()
            return "00000000-0000-4000-8000-" + String(repeating: "0", count: max(0, 12 - String(n).count)) + String(n)
        }
        let nowFn: @Sendable () -> Date = { now }
        let api = APIClient(baseURL: URL(string: "https://test.garderobe.invalid")!, transport: server)
        let env = AppEnvironment(api: api, store: store, now: nowFn, sleep: sleep, uuid: uuid)
        return Harness(server: server, store: store, env: env, clock: clock)
    }

    /// A fresh environment over the same store and server, as after an app relaunch.
    func relaunched() throws -> Harness { try Harness.make(store: store, server: server) }
}

/// Yields until the condition holds (bounded), for work started in unstructured tasks.
@MainActor
func eventually(_ label: String = "condition", _ condition: @MainActor () async -> Bool) async {
    for _ in 0..<2000 {
        if await condition() { return }
        await Task.yield()
    }
    Issue.record("Timed out waiting for \(label)")
}

enum Names {
    static let goldOxford = "Lightweight oxford — gold"
    static let slateOxford = "Lightweight oxford — slate"
    static let greySneaker = "NB 990v4 — grey"
    static let oliveSneaker = "NB 990v4 — olive/cream"
}

extension WardrobePage {
    func id(_ name: String) -> String { items.first { $0.garment.name == name }!.garment.garmentId }
}

/// Holds matching requests until the test releases them (a response that arrives late).
actor RequestGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    var waiting: Int { waiters.count }
    func pass() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        isOpen = true
        let w = waiters
        waiters = []
        for c in w { c.resume() }
    }
}

/// Forwards to the fixture server, holding requests with the given method and path prefix at the gate.
struct GatedTransport: HTTPTransport {
    let inner: FixtureServer
    let gate: RequestGate
    let method: String
    let pathPrefix: String
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        if request.method == method && request.path.hasPrefix(pathPrefix) { await gate.pass() }
        return try await inner.send(request)
    }
    func lines(_ request: HTTPRequest) -> AsyncThrowingStream<String, Error> { inner.lines(request) }
}

/// Writes Swift-encoded payloads for the cross-language contract check
/// (`npx tsx ios/scripts/fixtures.ts check <dir>`). Set GARDEROBE_CONTRACT_OUT to choose the directory.
enum ContractExport {
    static var directory: URL {
        let env = ProcessInfo.processInfo.environment["GARDEROBE_CONTRACT_OUT"]
        let url = URL(fileURLWithPath: env ?? (NSTemporaryDirectory() + "garderobe-contract-out"))
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func write(_ name: String, _ value: some Encodable) throws {
        let data = try GarderobeJSON.encoder(pretty: true).encode(value)
        try data.write(to: directory.appendingPathComponent(name + ".json"))
    }
}
