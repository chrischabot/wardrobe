import Testing
import Foundation
@testable import GarderobeKit

/// A scripted `HTTPTransport` for unit tests: each test states exactly what the backend
/// answers. Journey tests use the recorded fixture backend instead.
final class ScriptedTransport: HTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable (HTTPRequest) throws -> HTTPResponse
    private let lock = NSLock()
    private var handler: Handler
    private var _requests: [HTTPRequest] = []
    private var streams: [String: [Data]] = [:]

    init(_ handler: @escaping Handler = { _ in HTTPResponse(status: 404) }) { self.handler = handler }

    var requests: [HTTPRequest] { lock.withLock { _requests } }
    func setHandler(_ handler: @escaping Handler) { lock.withLock { self.handler = handler } }
    func setStream(path: String, chunks: [Data]) { lock.withLock { streams[path] = chunks } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let h: Handler = lock.withLock {
            _requests.append(request)
            return handler
        }
        return try h(request)
    }

    func stream(_ request: HTTPRequest) -> AsyncThrowingStream<Data, Error> {
        let chunks: [Data]? = lock.withLock {
            _requests.append(request)
            return streams[request.path]
        }
        return AsyncThrowingStream { continuation in
            guard let chunks else { continuation.finish(throwing: TransportFailure("no stream scripted for \(request.path)")); return }
            for chunk in chunks { continuation.yield(chunk) }
            continuation.finish()
        }
    }
}

enum TestSupport {
    static let startInstant = "2026-09-15T06:30:00Z"

    @MainActor
    static func environment(transport: HTTPTransport, store: KeyValueStore = InMemoryKeyValueStore(), time: ManualTimeSource = ManualTimeSource(instant: startInstant)) -> AppEnvironment {
        AppEnvironment(transport: transport, tokens: StaticAccessToken("test-token"), store: store, time: time,
                       ids: SequentialIdentifierSource(), timeZone: TimeZone(identifier: "Europe/London")!)
    }

    static func json(_ value: JSONValue, status: Int = 200) -> HTTPResponse {
        HTTPResponse(status: status, headers: ["Content-Type": "application/json"], body: (try? GarderobeJSON.encode(value)) ?? Data())
    }

    static func error(_ code: String, _ message: String, status: Int) -> HTTPResponse {
        json(.object(["error": .object(["code": .string(code), "message": .string(message), "details": .object([:])])]), status: status)
    }

    /// A receipt in the contract's shape, for tests that script the backend's answer.
    static func receipt(commandId: String, type: String, summary: String, undoAvailable: Bool = true, outcome: String = "committed",
                        affected: [(String, String, Int)] = [], wardrobeRevision: Int = 1, replayed: Bool = false, externalEffectState: String = "none") -> JSONValue {
        .object([
            "commandId": .string(commandId), "type": .string(type), "outcome": .string(outcome), "summary": .string(summary),
            "affected": .array(affected.map { .object(["kind": .string($0.0), "id": .string($0.1), "version": .integer($0.2)]) }),
            "externalEffectState": .string(externalEffectState), "effects": .array([]),
            "undo": .object(["available": .bool(undoAvailable), "reason": undoAvailable ? .null : .string("Not reversible.")]),
            "repairs": .array([]), "result": .object([:]), "occurredAt": .string("2026-09-15T06:30:00Z"), "recordedAt": .string("2026-09-15T06:30:01Z"),
            "wardrobeRevision": .integer(wardrobeRevision), "replayed": .bool(replayed), "actor": .string("owner"), "channel": .string("ios"),
            "contractVersion": .string("1.0.0"),
        ])
    }

    static func body(_ request: HTTPRequest) -> JSONValue {
        guard let data = request.body, let value = try? GarderobeJSON.decode(JSONValue.self, from: data) else { return .null }
        return value
    }
}
