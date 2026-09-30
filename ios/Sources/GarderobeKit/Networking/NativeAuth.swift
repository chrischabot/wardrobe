import Foundation

/// Native app sign-in: the backend's secretless public OAuth client (PKCE S256 + resource indicator).
///
///   GET  /v1/auth/native/authorize?response_type=code&client_id=garderobe-ios&redirect_uri=garderobe://auth/callback
///        &code_challenge=…&code_challenge_method=S256&state=…&resource=<origin>/v1&scope=…
///        (opened in ASWebAuthenticationSession; Cloudflare Access signs the owner in with Google)
///        → garderobe://auth/callback?code=…&state=…&iss=<origin>
///   POST /v1/auth/native/token   grant_type=authorization_code | refresh_token  (form-encoded, no client secret)
///   POST /v1/auth/native/revoke  token=…
///
/// Access tokens live 15 minutes; refresh tokens rotate on every use and a replayed one revokes the
/// session, so refreshes are coalesced and the new refresh token is stored before anything else.
public struct NativeAuthConfig: Sendable, Hashable {
    public static let clientId = "garderobe-ios"
    public static let redirectURI = "garderobe://auth/callback"
    public static let callbackScheme = "garderobe"
    public static let scope = "wardrobe:read wardrobe:write"

    public var baseURL: URL
    public init(baseURL: URL) { self.baseURL = baseURL }

    /// The API origin (scheme://host[:port]) — what the callback's `iss` must equal.
    public var origin: String {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) ?? URLComponents()
        c.path = ""; c.query = nil; c.fragment = nil
        return (c.string ?? baseURL.absoluteString).trimmingSuffix("/")
    }

    /// RFC 8707 resource indicator: the Garderobe API.
    public var resource: String { origin + "/v1" }
}

/// One pending authorization: keep it until the callback arrives.
public struct NativeAuthRequest: Sendable, Hashable, Codable {
    public var state: String
    public var codeVerifier: String
    public var authorizeURL: URL
}

public enum NativeAuthError: Error, Sendable, Equatable {
    case cancelled
    case wrongRedirect
    case stateMismatch
    case issuerMismatch(String)
    case denied(String)
    case missingCode
    case tokenEndpoint(code: String, description: String)
    case offline
    case signedOut

    public var userMessage: String {
        switch self {
        case .cancelled: "Sign-in was cancelled"
        case .wrongRedirect, .stateMismatch, .issuerMismatch, .missingCode: "Sign-in could not be verified; try again"
        case .denied(let why): "Sign-in was refused: \(why)"
        case .tokenEndpoint(_, let d): "Sign-in failed: \(d)"
        case .offline: "Sign-in needs a connection"
        case .signedOut: "Signed out"
        }
    }
}

public enum PKCE {
    /// 32 random bytes → 43 base64url characters (RFC 7636 §4.1).
    public static func makeVerifier(random: () -> [UInt8] = { (0..<32).map { _ in UInt8.random(in: 0...255) } }) -> String {
        SHA256.base64URL(random())
    }

    public static func challenge(for verifier: String) -> String {
        SHA256.base64URL(SHA256.digest(Array(verifier.utf8)))
    }
}

public enum NativeAuthorization {
    public static func begin(_ config: NativeAuthConfig, random: () -> [UInt8] = { (0..<32).map { _ in UInt8.random(in: 0...255) } }) -> NativeAuthRequest {
        let verifier = PKCE.makeVerifier(random: random)
        let state = SHA256.base64URL(Array(random().prefix(16)))
        var c = URLComponents(url: config.baseURL.appendingPathComponent("v1/auth/native/authorize"), resolvingAgainstBaseURL: false)!
        c.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: NativeAuthConfig.clientId),
            URLQueryItem(name: "redirect_uri", value: NativeAuthConfig.redirectURI),
            URLQueryItem(name: "code_challenge", value: PKCE.challenge(for: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "resource", value: config.resource),
            URLQueryItem(name: "scope", value: NativeAuthConfig.scope),
        ]
        return NativeAuthRequest(state: state, codeVerifier: verifier, authorizeURL: c.url!)
    }

    /// Validates the redirect: exact redirect URI, matching state, issuer (RFC 9207), then the code.
    public static func code(from callback: URL, for request: NativeAuthRequest, config: NativeAuthConfig) throws(NativeAuthError) -> String {
        guard let c = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              c.scheme == NativeAuthConfig.callbackScheme, c.host == "auth", c.path == "/callback" else { throw .wrongRedirect }
        let q = Dictionary((c.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard q["state"] == request.state else { throw .stateMismatch }
        if let iss = q["iss"], iss.trimmingSuffix("/") != config.origin { throw .issuerMismatch(iss) }
        if let error = q["error"] { throw .denied(q["error_description"] ?? error) }
        guard let code = q["code"], !code.isEmpty else { throw .missingCode }
        return code
    }
}

public struct StoredTokens: Codable, Sendable, Hashable {
    public var accessToken: String
    public var refreshToken: String
    public var accessExpiresAt: Date
    public var scope: String
}

/// Where tokens live: the Keychain on device, memory in tests.
public protocol TokenStorage: Sendable {
    func load() -> StoredTokens?
    func save(_ tokens: StoredTokens?)
}

public final class MemoryTokenStorage: TokenStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: StoredTokens?
    public init(_ tokens: StoredTokens? = nil) { self.tokens = tokens }
    public func load() -> StoredTokens? { lock.lock(); defer { lock.unlock() }; return tokens }
    public func save(_ tokens: StoredTokens?) { lock.lock(); self.tokens = tokens; lock.unlock() }
}

/// A token provider that can refresh after the server answered 401.
public protocol RefreshingTokenProvider: TokenProvider {
    /// Returns true when a new access token is available.
    func refreshAfterUnauthorized() async -> Bool
}

/// Holds the app session: returns a valid access token, refreshing (once, coalesced) when needed.
public actor NativeAuthSession: RefreshingTokenProvider {
    public nonisolated let config: NativeAuthConfig
    private let storage: any TokenStorage
    private let transport: any HTTPTransport
    private let now: @Sendable () -> Date
    private var refreshing: Task<Bool, Never>?

    public init(config: NativeAuthConfig, storage: any TokenStorage, transport: any HTTPTransport, now: @escaping @Sendable () -> Date = { Date() }) {
        self.config = config; self.storage = storage; self.transport = transport; self.now = now
    }

    public var isSignedIn: Bool { storage.load() != nil }

    public func token() async -> String? {
        guard let t = storage.load() else { return nil }
        if t.accessExpiresAt.timeIntervalSince(now()) > 30 { return t.accessToken }
        return await refresh() ? storage.load()?.accessToken : nil
    }

    public func refreshAfterUnauthorized() async -> Bool {
        guard storage.load() != nil else { return false }
        return await refresh()
    }

    /// Exchanges the authorization code (after `NativeAuthorization.code(from:for:config:)`).
    public func complete(code: String, request: NativeAuthRequest) async throws(NativeAuthError) {
        let tokens = try await tokenRequest([
            "grant_type": "authorization_code", "code": code, "redirect_uri": NativeAuthConfig.redirectURI,
            "client_id": NativeAuthConfig.clientId, "code_verifier": request.codeVerifier, "resource": config.resource,
        ])
        storage.save(tokens)
    }

    /// Validates the callback URL and exchanges its code.
    public func complete(callback: URL, request: NativeAuthRequest) async throws(NativeAuthError) {
        let code = try NativeAuthorization.code(from: callback, for: request, config: config)
        try await complete(code: code, request: request)
    }

    /// Revokes the refresh token at the server (best effort) and forgets the session locally.
    public func signOut() async {
        let t = storage.load()
        storage.save(nil)
        refreshing?.cancel()
        refreshing = nil
        guard let t else { return }
        _ = try? await transport.send(Self.form("/v1/auth/native/revoke", ["token": t.refreshToken]))
    }

    private func refresh() async -> Bool {
        if let refreshing { return await refreshing.value }
        let task = Task { () -> Bool in
            guard let t = storage.load() else { return false }
            do {
                let next = try await tokenRequest(["grant_type": "refresh_token", "refresh_token": t.refreshToken, "client_id": NativeAuthConfig.clientId])
                storage.save(next)
                return true
            } catch NativeAuthError.offline {
                return false // keep the session; try again when online
            } catch {
                storage.save(nil) // invalid, expired, revoked or replayed: sign in again
                return false
            }
        }
        refreshing = task
        let ok = await task.value
        refreshing = nil
        return ok
    }

    private func tokenRequest(_ fields: [String: String]) async throws(NativeAuthError) -> StoredTokens {
        let response: HTTPResponse
        do {
            response = try await transport.send(Self.form("/v1/auth/native/token", fields))
        } catch TransportError.offline {
            throw .offline
        } catch {
            throw .offline
        }
        guard (200..<300).contains(response.status), let t = try? GarderobeJSON.decoder().decode(NativeTokenResponse.self, from: response.body), t.token_type.lowercased() == "bearer" else {
            let e = (try? JSONDecoder().decode([String: String].self, from: response.body)) ?? [:]
            throw .tokenEndpoint(code: e["error"] ?? "http_\(response.status)", description: e["error_description"] ?? "The server refused the sign-in")
        }
        return StoredTokens(accessToken: t.access_token, refreshToken: t.refresh_token, accessExpiresAt: now().addingTimeInterval(TimeInterval(t.expires_in)), scope: t.scope)
    }

    /// A form-encoded POST with no Authorization header (this is a public client; secrets are refused).
    static func form(_ path: String, _ fields: [String: String]) -> HTTPRequest {
        HTTPRequest(method: "POST", path: path, headers: ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"], body: Data(FormEncoding.encode(fields).utf8))
    }
}

public enum FormEncoding {
    static let unreserved: CharacterSet = {
        var s = CharacterSet.alphanumerics.intersection(CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
        s.insert(charactersIn: "-._~")
        return s
    }()

    public static func encode(_ fields: [String: String]) -> String {
        fields.sorted { $0.key < $1.key }
            .map { "\(escape($0.key))=\(escape($0.value))" }
            .joined(separator: "&")
    }

    public static func decode(_ body: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in body.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String($0) }
            if let k = kv.first { out[k] = kv.count > 1 ? kv[1] : "" }
        }
        return out
    }

    static func escape(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s }
}
