import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Production transport over URLSession.
public final class URLSessionTransport: HTTPTransport, @unchecked Sendable {
    private let session: URLSession
    private let baseURL: URL

    public init(baseURL: URL, configuration: URLSessionConfiguration = .default) {
        configuration.timeoutIntervalForRequest = 20
        #if !canImport(FoundationNetworking)
        configuration.waitsForConnectivity = false
        #endif
        self.session = URLSession(configuration: configuration)
        self.baseURL = baseURL
    }

    func urlRequest(_ r: HTTPRequest) throws -> URLRequest {
        guard let url = r.url(relativeTo: baseURL) else { throw TransportError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = r.method
        req.httpBody = r.body
        for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
        return req
    }

    static func map(_ error: Error) -> Error {
        guard let e = error as? URLError else { return error }
        switch e.code {
        case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dataNotAllowed, .internationalRoamingOff:
            return TransportError.offline
        default:
            return TransportError.interrupted(e.localizedDescription)
        }
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let req = try urlRequest(request)
        do {
            let (data, response) = try await session.data(for: req)
            let http = response as? HTTPURLResponse
            var headers: [String: String] = [:]
            for (k, v) in http?.allHeaderFields ?? [:] { headers[String(describing: k)] = String(describing: v) }
            return HTTPResponse(status: http?.statusCode ?? 0, headers: headers, body: data)
        } catch {
            throw Self.map(error)
        }
    }

    public func lines(_ request: HTTPRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = try urlRequest(request)
                    req.timeoutInterval = 300
                    #if canImport(FoundationNetworking)
                    // swift-corelibs-foundation has no streaming bytes API: read the finite body.
                    let (data, _) = try await session.data(for: req)
                    for line in SSEParser.lines(String(decoding: data, as: UTF8.self)) { continuation.yield(line) }
                    #else
                    let (bytes, response) = try await session.bytes(for: req)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        continuation.finish(throwing: TransportError.interrupted("HTTP \(http.statusCode)"))
                        return
                    }
                    // `AsyncLineSequence` drops blank lines, which delimit SSE events; split manually.
                    var buffer = [UInt8]()
                    for try await byte in bytes {
                        if byte == 0x0A {
                            continuation.yield(String(decoding: buffer, as: UTF8.self))
                            buffer.removeAll(keepingCapacity: true)
                        } else {
                            buffer.append(byte)
                        }
                    }
                    if !buffer.isEmpty { continuation.yield(String(decoding: buffer, as: UTF8.self)) }
                    #endif
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.map(error))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
