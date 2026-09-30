import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPRequest: Sendable, Hashable {
    public var method: String
    /// Path relative to the API base ("/v1/today") or an absolute URL (upload targets).
    public var path: String
    public var query: [String: String]
    public var headers: [String: String]
    public var body: Data?

    public init(method: String = "GET", path: String, query: [String: String] = [:], headers: [String: String] = [:], body: Data? = nil) {
        self.method = method; self.path = path; self.query = query; self.headers = headers; self.body = body
    }

    public func url(relativeTo base: URL) -> URL? {
        let absolute = path.hasPrefix("http://") || path.hasPrefix("https://") || path.hasPrefix("fixture://")
        guard var components = URLComponents(string: absolute ? path : base.absoluteString.trimmingSuffix("/") + path) else { return nil }
        if !query.isEmpty {
            components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        return components.url
    }
}

public struct HTTPResponse: Sendable, Hashable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) { self.status = status; self.headers = headers; self.body = body }
}

public enum TransportError: Error, Sendable, Equatable {
    /// No network path: the request never reached the server.
    case offline
    /// The request may or may not have reached the server (timeout, dropped connection).
    case interrupted(String)
    case invalidURL
}

/// The only way the app talks to the backend. `URLSessionTransport` is the real implementation;
/// `FixtureServer` serves the demo fixtures for tests, previews and UI tests.
public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
    /// Server-sent events: yields raw lines of the response body as they arrive.
    func lines(_ request: HTTPRequest) -> AsyncThrowingStream<String, Error>
}

extension String {
    func trimmingSuffix(_ s: String) -> String { hasSuffix(s) ? String(dropLast(s.count)) : self }
}
