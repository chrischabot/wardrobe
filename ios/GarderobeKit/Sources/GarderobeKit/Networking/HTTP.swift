import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    /// Path relative to the API base URL (`/v1/today`) or an absolute URL (pre-signed upload).
    public var path: String
    public var query: [URLQueryItem]
    public var headers: [String: String]
    public var body: Data?

    public init(method: String, path: String, query: [URLQueryItem] = [], headers: [String: String] = [:], body: Data? = nil) {
        self.method = method; self.path = path; self.query = query; self.headers = headers; self.body = body
    }

    public func url(relativeTo base: URL) -> URL? {
        let absolute = path.hasPrefix("http://") || path.hasPrefix("https://")
        guard var components = absolute ? URLComponents(string: path) : URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        if !absolute {
            // A relative path may already carry a query (ticket and media URLs issued by the backend).
            let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
            let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
            components.path = basePath + String(parts[0])
            if parts.count == 2 { components.percentEncodedQuery = String(parts[1]) }
        }
        if !query.isEmpty { components.queryItems = (components.queryItems ?? []) + query }
        return components.url
    }
}

public struct HTTPResponse: Sendable, Equatable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status; self.headers = headers; self.body = body
    }
    public func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

/// The transport could not complete the exchange: nothing is known about what the backend did.
/// This is the only failure for which an offline command stays queued and is retried.
public struct TransportFailure: Error, Sendable, Equatable {
    public var reason: String
    public init(_ reason: String) { self.reason = reason }
}

/// The network boundary. The app uses `URLSessionTransport`; tests and the labelled demo mode
/// use the recorded fixture backend. Everything above this protocol is identical in both.
public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
    /// Opens a streaming response (server-sent events) and yields raw chunks as they arrive.
    func stream(_ request: HTTPRequest) -> AsyncThrowingStream<Data, Error>
}

public final class URLSessionTransport: HTTPTransport, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, configuration: URLSessionConfiguration = .ephemeral) {
        self.baseURL = baseURL
        // The app keeps its own explicit cache with check times; an HTTP cache underneath it
        // could present a stale response as a fresh read.
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        self.session = URLSession(configuration: configuration)
    }

    private func urlRequest(_ request: HTTPRequest) throws -> URLRequest {
        guard let url = request.url(relativeTo: baseURL) else { throw TransportFailure("invalid URL for \(request.path)") }
        var r = URLRequest(url: url)
        r.httpMethod = request.method
        for (k, v) in request.headers { r.setValue(v, forHTTPHeaderField: k) }
        r.httpBody = request.body
        return r
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let r = try urlRequest(request)
        return try await withCheckedThrowingContinuation { continuation in
            let task = session.dataTask(with: r) { data, response, error in
                if let error { continuation.resume(throwing: TransportFailure(error.localizedDescription)); return }
                guard let http = response as? HTTPURLResponse else { continuation.resume(throwing: TransportFailure("no HTTP response")); return }
                var headers: [String: String] = [:]
                for (k, v) in http.allHeaderFields { headers[String(describing: k)] = String(describing: v) }
                continuation.resume(returning: HTTPResponse(status: http.statusCode, headers: headers, body: data ?? Data()))
            }
            task.resume()
        }
    }

    public func stream(_ request: HTTPRequest) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let r: URLRequest
            do { r = try urlRequest(request) } catch { continuation.finish(throwing: error); return }
            let delegate = StreamDelegate(continuation: continuation)
            let streamSession = URLSession(configuration: session.configuration, delegate: delegate, delegateQueue: nil)
            let task = streamSession.dataTask(with: r)
            continuation.onTermination = { _ in task.cancel(); streamSession.invalidateAndCancel() }
            task.resume()
        }
    }

    private final class StreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        let continuation: AsyncThrowingStream<Data, Error>.Continuation
        init(continuation: AsyncThrowingStream<Data, Error>.Continuation) { self.continuation = continuation }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                continuation.finish(throwing: APIFailure.status(http.statusCode))
                completionHandler(.cancel)
                return
            }
            completionHandler(.allow)
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) { continuation.yield(data) }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            if let error { continuation.finish(throwing: TransportFailure(error.localizedDescription)) } else { continuation.finish() }
        }
    }
}

/// Why an API call did not return its value. The cases are the distinctions the interface
/// needs to be honest: "nothing reached the backend" is not "the backend refused".
public enum APIFailure: Error, Sendable, Equatable {
    /// No exchange completed. Reads fall back to the cache; commands stay queued.
    case transport(String)
    /// The backend answered with a contract error (`{ "error": { code, message, details } }`).
    case api(status: Int, error: ApiError)
    /// A non-2xx answer without a contract error body.
    case status(Int)
    /// The answer did not match the contract this build was compiled against.
    case decoding(String)
    /// There is no signed-in session (or it cannot be refreshed): sign in again.
    case signedOut

    public var isTransport: Bool { if case .transport = self { return true }; return false }

    public var apiCode: String? { if case .api(_, let e) = self { return e.code.rawValue }; return nil }

    /// The session must be re-established before anything else can work.
    public var needsSignIn: Bool {
        switch self {
        case .signedOut: return true
        case .api(let status, let e): return status == 401 || e.code == .unauthenticated || e.code == .sessionRevoked
        case .status(let s): return s == 401
        default: return false
        }
    }

    /// Whether sending the identical request again later can succeed.
    public var isRetryable: Bool {
        switch self {
        case .transport: return true
        case .api(let status, let e): return status >= 500 || e.code == .rateLimited || e.code == .internal
        case .status(let s): return s >= 500 || s == 429
        case .decoding, .signedOut: return false
        }
    }

    /// A sentence for the owner. Backend messages are factual and are shown as written.
    public var ownerMessage: String {
        switch self {
        case .transport: return "No connection. Nothing was sent."
        case .api(_, let e): return e.message
        case .status(let s): return "The server answered with status \(s)."
        case .decoding: return "The server's answer was not in the expected format. Update the app if this continues."
        case .signedOut: return "You are signed out. Sign in to continue."
        }
    }
}
