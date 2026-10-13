import Foundation

/// A recording of real exchanges with the Garderobe backend (the Worker running on local D1
/// with the owner's real profile and inventory imported through the ordinary commands). It is
/// produced by `ios/Tools/fixtures` and replayed by `FixtureBackend`; nothing in it is written
/// by hand.
public struct Cassette: Codable, Sendable {
    public struct Exchange: Codable, Sendable, Equatable {
        public var status: Int
        public var body: JSONValue?
        /// Binary responses (images, export packages).
        public var bodyBase64: String?
        public var contentType: String?
        public init(status: Int, body: JSONValue? = nil, bodyBase64: String? = nil, contentType: String? = nil) {
            self.status = status; self.body = body; self.bodyBase64 = bodyBase64; self.contentType = contentType
        }
    }
    public struct Request: Codable, Sendable, Equatable {
        public var method: String
        public var path: String
        public var body: JSONValue?
    }
    /// One point in the recording: optionally the state-changing request that leads to it, and
    /// the reads that changed as a result.
    public struct Step: Codable, Sendable {
        public var id: String
        public var request: Request?
        public var response: Exchange?
        /// Keyed `GET /path?sorted=query`, or `STREAM /path` for server-sent event streams
        /// (body: array of `{id, event, data}`).
        public var reads: [String: Exchange]
        /// Read-only POST exchanges (validation, suggestion, search): matched by path and body.
        public var posts: [PostRead]?
    }
    public struct PostRead: Codable, Sendable {
        public var path: String
        public var body: JSONValue?
        public var response: Exchange
    }
    public struct Provenance: Codable, Sendable, Equatable {
        public var profileSha256: String
        public var inventorySha256: String
        public var contractVersion: String
        public var generator: String
        /// What produced the answers: `worker` (the real Worker on local D1) or a named partial source.
        public var backend: String
        public var notes: [String]
    }
    public var format: Int
    public var name: String
    public var provenance: Provenance
    /// The backend clock when the recording started; tests set their clock to it.
    public var clock: Instant
    public var timezone: String
    public var steps: [Step]

    public static func load(_ data: Data) throws -> Cassette { try GarderobeJSON.decode(Cassette.self, from: data) }

    /// Loads a cassette bundled with GarderobeKit (`Resources/Fixtures/<name>.json`).
    public static func bundled(_ name: String) throws -> Cassette {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: "Fixtures/\(name).json"])
        }
        return try load(try Data(contentsOf: url))
    }
}

/// Replays a `Cassette` as an `HTTPTransport`. It contains no domain logic: a state-changing
/// request is answered only if it is the next recorded one (compared field by field, apart
/// from client-generated identifiers and timestamps), and every answer is the real backend's.
/// Used by the journey tests and by the app's visibly labelled demo mode.
public final class FixtureBackend: HTTPTransport, @unchecked Sendable {
    public enum Mode: Sendable {
        /// Tests: an unexpected request is an error recorded in `unexpected`.
        case strict
        /// Demo mode: an unrecorded change is refused with a sentence the owner can read.
        case demo
    }

    private let cassette: Cassette
    private let mode: Mode
    private let lock = NSLock()
    private var position = 0
    private var served: [String: Cassette.Exchange] = [:] // idempotency key -> recorded answer
    private var _unexpected: [String] = []
    private var _log: [HTTPRequest] = []
    private var _offline = false

    public init(cassette: Cassette, mode: Mode = .strict) {
        self.cassette = cassette
        self.mode = mode
    }

    /// Simulates the network being unavailable: every exchange fails in transport.
    public var offline: Bool {
        get { lock.withLock { _offline } }
        set { lock.withLock { _offline = newValue } }
    }
    /// Requests the recording had no answer for (strict mode). A passing journey leaves this empty.
    public var unexpected: [String] { lock.withLock { _unexpected } }
    public var log: [HTTPRequest] { lock.withLock { _log } }
    /// The ID of the last recorded step reached.
    public var currentStep: String { lock.withLock { cassette.steps.isEmpty ? "" : cassette.steps[position].id } }
    public var isAtEnd: Bool { lock.withLock { position >= cassette.steps.count - 1 } }

    // MARK: Request normalization

    /// Fields the client generates fresh on every run; they are not part of what is compared.
    static let volatileKeys: Set<String> = ["idempotencyKey", "occurredAt", "clientSubmissionId", "clientRequestId", "clientTurnId", "clientUploadId"]

    static func normalize(_ value: JSONValue) -> JSONValue {
        switch value {
        case .object(let o):
            var out: [String: JSONValue] = [:]
            for (k, v) in o where !volatileKeys.contains(k) {
                let n = normalize(v)
                // An absent key, an explicit null, an empty array and an empty object are the
                // same request to the backend (server defaults), so they compare equal.
                switch n {
                case .null: continue
                case .array(let a) where a.isEmpty: continue
                case .object(let d) where d.isEmpty: continue
                default: out[k] = n
                }
            }
            return .object(out)
        case .array(let a): return .array(a.map(normalize))
        default: return value
        }
    }

    static func key(method: String, path: String, query: [URLQueryItem]) -> String {
        var parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        var items = query.map { "\($0.name)=\($0.value ?? "")" }
        if parts.count == 2 { items += parts[1].split(separator: "&").map { $0.removingPercentEncoding ?? String($0) } }
        parts = [parts.first ?? path]
        var key = "\(method) \(parts[0])"
        if !items.isEmpty { key += "?" + items.sorted().joined(separator: "&") }
        return key
    }

    private func read(_ key: String) -> Cassette.Exchange? {
        var i = position
        while i >= 0 {
            if let found = cassette.steps[i].reads[key] { return found }
            i -= 1
        }
        return nil
    }

    /// A recorded read-only POST with the same path and (normalized) body.
    private func postRead(path: String, body: JSONValue?) -> Cassette.Exchange? {
        let wanted = FixtureBackend.normalize(body ?? .null)
        var i = position
        while i >= 0 {
            if let found = cassette.steps[i].posts?.first(where: { $0.path == path && FixtureBackend.normalize($0.body ?? .null) == wanted }) { return found.response }
            i -= 1
        }
        return nil
    }

    private func response(_ exchange: Cassette.Exchange) -> HTTPResponse {
        if let b64 = exchange.bodyBase64, let data = Data(base64Encoded: b64) {
            return HTTPResponse(status: exchange.status, headers: ["Content-Type": exchange.contentType ?? "application/octet-stream"], body: data)
        }
        let body = exchange.body.flatMap { try? GarderobeJSON.encode($0) } ?? Data()
        return HTTPResponse(status: exchange.status, headers: ["Content-Type": "application/json", "X-Garderobe-Api": "v1", "X-Garderobe-Contract": cassette.provenance.contractVersion], body: body)
    }

    private func refusal(_ description: String) -> HTTPResponse {
        let message = mode == .demo
            ? "Demo data cannot be changed: this action is not part of the recording."
            : "fixture: no recorded answer for \(description) at step '\(cassette.steps.isEmpty ? "" : cassette.steps[position].id)'"
        let body: JSONValue = ["error": ["code": "precondition_failed", "message": .string(message), "details": [:]]]
        return HTTPResponse(status: 409, headers: ["Content-Type": "application/json"], body: (try? GarderobeJSON.encode(body)) ?? Data())
    }

    // MARK: Serving

    /// Answers one state-changing request if it is the next recorded step. Lock must be held.
    private func advance(method: String, path: String, body: JSONValue?) -> Cassette.Exchange? {
        if let key = body?["idempotencyKey"]?.stringValue, var again = served[key] {
            // The same command sent again: the stored receipt, marked as a replay (as the backend does).
            if case .object(var o)? = again.body, o["replayed"] != nil { o["replayed"] = .bool(true); again.body = .object(o) }
            return again
        }
        let next = position + 1
        guard next < cassette.steps.count else { return nil }
        // Steps without a request only carry data for the replaying test; they are passed over.
        var target = next
        while target < cassette.steps.count, cassette.steps[target].request == nil { target += 1 }
        guard target < cassette.steps.count, let recorded = cassette.steps[target].request, let answer = cassette.steps[target].response else { return nil }
        guard recorded.method == method, recorded.path == path,
              FixtureBackend.normalize(recorded.body ?? .null) == FixtureBackend.normalize(body ?? .null) else { return nil }
        position = target
        if let key = body?["idempotencyKey"]?.stringValue { served[key] = answer }
        return answer
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        try lock.withLock {
            if _offline { throw TransportFailure("offline (fixture)") }
            _log.append(request)
            guard !cassette.steps.isEmpty else { return refusal("\(request.method) \(request.path)") }
            let key = FixtureBackend.key(method: request.method, path: request.path, query: request.query)
            if request.method == "GET" {
                if let found = read(key) { return response(found) }
                if mode == .strict { _unexpected.append(key) }
                let body: JSONValue = ["error": ["code": "not_found", "message": .string(mode == .demo ? "This is not part of the demo data." : "fixture: no recorded read for \(key)"), "details": [:]]]
                return HTTPResponse(status: 404, headers: ["Content-Type": "application/json"], body: (try? GarderobeJSON.encode(body)) ?? Data())
            }
            let json = request.body.flatMap { try? GarderobeJSON.decode(JSONValue.self, from: $0) }
            let path = request.path.split(separator: "?").first.map(String.init) ?? request.path
            if request.path == "/v1/commands/batch", let commands = json?["commands"]?.arrayValue {
                var results: [JSONValue] = []
                var revision = 0
                for command in commands {
                    let idempotencyKey = command["idempotencyKey"] ?? .null
                    if let answer = advance(method: "POST", path: "/v1/commands", body: command), let body = answer.body {
                        if answer.status == 200 {
                            revision = max(revision, body["wardrobeRevision"]?.intValue ?? 0)
                            results.append(["status": "receipt", "idempotencyKey": idempotencyKey, "receipt": body])
                        } else {
                            results.append(["status": "error", "idempotencyKey": idempotencyKey, "error": body["error"] ?? .null, "retryable": false])
                        }
                    } else {
                        if mode == .strict { _unexpected.append("batch item " + String(decoding: (try? GarderobeJSON.encode(FixtureBackend.normalize(command))) ?? Data(), as: UTF8.self)) }
                        let refused = try? GarderobeJSON.decode(JSONValue.self, from: refusal("batch command").body)
                        results.append(["status": "error", "idempotencyKey": idempotencyKey, "error": refused?["error"] ?? .null, "retryable": false])
                    }
                }
                let body: JSONValue = ["results": .array(results), "wardrobeRevision": .integer(revision)]
                return HTTPResponse(status: 200, headers: ["Content-Type": "application/json"], body: (try? GarderobeJSON.encode(body)) ?? Data())
            }
            // The next recorded state change takes precedence over a recorded read-only POST.
            if let answer = advance(method: request.method, path: path, body: json) { return response(answer) }
            if let found = postRead(path: path, body: json) { return response(found) }
            let description = key + " " + String(decoding: (try? GarderobeJSON.encode(FixtureBackend.normalize(json ?? .null))) ?? Data(), as: UTF8.self)
            if mode == .strict { _unexpected.append(description) }
            return refusal(description)
        }
    }

    public func stream(_ request: HTTPRequest) -> AsyncThrowingStream<Data, Error> {
        let (events, isOffline): ([JSONValue]?, Bool) = lock.withLock {
            _log.append(request)
            return (read("STREAM \(request.path.split(separator: "?").first.map(String.init) ?? request.path)")?.body?.arrayValue, _offline)
        }
        let after = request.headers["Last-Event-ID"].flatMap(Int.init) ?? 0
        return AsyncThrowingStream { continuation in
            if isOffline { continuation.finish(throwing: TransportFailure("offline (fixture)")); return }
            guard let events else { continuation.finish(throwing: APIFailure.status(404)); return }
            for event in events {
                let id = event["id"]?.intValue ?? 0
                guard id > after else { continue }
                let data = (try? GarderobeJSON.encode(event["data"] ?? .null)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
                continuation.yield(Data("id: \(id)\nevent: \(event["event"]?.stringValue ?? "message")\ndata: \(data)\n\n".utf8))
            }
            continuation.finish()
        }
    }
}
