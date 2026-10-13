import Foundation

/// Deployment values for sign-in. They are configuration (Info.plist, from xcconfig), not
/// constants: the deployment supplies the API host, the public client ID and the callback URL.
public struct OAuthConfiguration: Sendable, Equatable {
    public var apiBaseURL: URL
    /// Public client: there is no client secret anywhere in the app.
    public var clientId: String
    /// Verified HTTPS universal-link callback.
    public var redirectURL: URL
    public var scopes: [String]

    public init(apiBaseURL: URL, clientId: String, redirectURL: URL, scopes: [String] = []) {
        self.apiBaseURL = apiBaseURL; self.clientId = clientId; self.redirectURL = redirectURL; self.scopes = scopes
    }

    /// The resource indicator (RFC 8707) sent with authorization and token requests.
    public var resource: String {
        let s = apiBaseURL.absoluteString
        return s.hasSuffix("/") ? String(s.dropLast()) : s
    }
}

/// Authorization server metadata (RFC 8414), read at runtime from
/// `<api base>/.well-known/oauth-authorization-server`.
public struct AuthorizationServerMetadata: Codable, Sendable, Equatable {
    public var issuer: String?
    public var authorizationEndpoint: String
    public var tokenEndpoint: String
    public var revocationEndpoint: String?
    public var codeChallengeMethodsSupported: [String]?

    enum CodingKeys: String, CodingKey {
        case issuer
        case authorizationEndpoint = "authorization_endpoint"
        case tokenEndpoint = "token_endpoint"
        case revocationEndpoint = "revocation_endpoint"
        case codeChallengeMethodsSupported = "code_challenge_methods_supported"
    }
}

/// Proof Key for Code Exchange (RFC 7636), method S256 only.
public struct PKCE: Sendable, Equatable {
    public let verifier: String
    public let challenge: String
    public static let method = "S256"

    /// - Parameter randomBytes: 32 or more bytes from a cryptographically secure source.
    public init(randomBytes: [UInt8]) {
        precondition(randomBytes.count >= 32, "PKCE needs at least 32 random bytes")
        verifier = Base64URL.encode(randomBytes)
        challenge = Base64URL.encode(SHA256.digest(Data(verifier.utf8)))
    }
}

/// Random bytes for PKCE verifiers and `state`. `SystemRandomNumberGenerator` is
/// cryptographically secure on Apple platforms and Linux.
public enum SecureRandom {
    public static func bytes(_ count: Int) -> [UInt8] {
        var generator = SystemRandomNumberGenerator()
        return (0..<count).map { _ in UInt8.random(in: 0...255, using: &generator) }
    }
}

/// One authorization attempt: the URL to open in `ASWebAuthenticationSession` and the secrets
/// that must match when the callback returns.
public struct AuthorizationAttempt: Sendable, Equatable {
    public let url: URL
    public let state: String
    public let pkce: PKCE
}

public enum SignInFailure: Error, Sendable, Equatable {
    case configuration(String)
    /// The callback's `state` did not match this attempt: the response is discarded.
    case stateMismatch
    /// The authorization server reported an error (`access_denied`, ...).
    case denied(String)
    case missingCode
    case server(String)
    case transport(String)

    public var ownerMessage: String {
        switch self {
        case .configuration(let m): return "Sign-in is not configured: \(m)"
        case .stateMismatch: return "The sign-in response did not match this attempt. Try again."
        case .denied(let m): return m == "access_denied" ? "Sign-in was cancelled." : "Sign-in was refused (\(m))."
        case .missingCode: return "The sign-in response was incomplete. Try again."
        case .server(let m): return "The sign-in server answered: \(m)"
        case .transport: return "No connection. Sign-in needs the network."
        }
    }
}

public struct StoredTokens: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date?
    public init(accessToken: String, refreshToken: String?, expiresAt: Date?) {
        self.accessToken = accessToken; self.refreshToken = refreshToken; self.expiresAt = expiresAt
    }
}

/// Where tokens live. The app's implementation is the Keychain (and nothing else); tests use
/// `InMemoryTokenStore`. Tokens are never written to the cache, the queue or logs.
public protocol TokenStore: Sendable {
    func load() -> StoredTokens?
    func save(_ tokens: StoredTokens) throws
    func clear()
}

public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: StoredTokens?
    public init(_ tokens: StoredTokens? = nil) { self.tokens = tokens }
    public func load() -> StoredTokens? { lock.withLock { tokens } }
    public func save(_ tokens: StoredTokens) throws { lock.withLock { self.tokens = tokens } }
    public func clear() { lock.withLock { tokens = nil } }
}

/// The native OAuth client: authorization code flow with PKCE S256 and a resource indicator,
/// as a public client. It also provides the bearer token for API calls, refreshing it when it
/// has expired; concurrent callers share one refresh.
public actor OAuthSession: AccessTokenProviding {
    private let configuration: OAuthConfiguration
    private let transport: HTTPTransport
    private let store: TokenStore
    private let time: TimeSource
    private var metadata: AuthorizationServerMetadata?
    private var refreshTask: Task<StoredTokens?, Error>?
    /// Refresh this long before the stated expiry so a request never leaves with a token about to lapse.
    static let expiryMargin: TimeInterval = 30

    public init(configuration: OAuthConfiguration, transport: HTTPTransport, store: TokenStore, time: TimeSource = SystemTimeSource()) {
        self.configuration = configuration; self.transport = transport; self.store = store; self.time = time
    }

    public nonisolated var hasSession: Bool { store.load() != nil }

    private func discover() async throws -> AuthorizationServerMetadata {
        if let metadata { return metadata }
        let response: HTTPResponse
        do { response = try await transport.send(HTTPRequest(method: "GET", path: "/.well-known/oauth-authorization-server", headers: ["Accept": "application/json"])) }
        catch let t as TransportFailure { throw SignInFailure.transport(t.reason) }
        guard response.status == 200, let decoded = try? JSONDecoder().decode(AuthorizationServerMetadata.self, from: response.body) else {
            throw SignInFailure.configuration("the authorization server metadata could not be read (status \(response.status)).")
        }
        if let methods = decoded.codeChallengeMethodsSupported, !methods.contains(PKCE.method) {
            throw SignInFailure.configuration("the authorization server does not offer PKCE S256.")
        }
        metadata = decoded
        return decoded
    }

    /// Builds the authorization URL for a new attempt.
    public func beginAuthorization(randomBytes: [UInt8] = SecureRandom.bytes(32), state: String = Base64URL.encode(SecureRandom.bytes(16))) async throws -> AuthorizationAttempt {
        let metadata = try await discover()
        guard var components = URLComponents(string: metadata.authorizationEndpoint) else { throw SignInFailure.configuration("the authorization endpoint is not a URL.") }
        let pkce = PKCE(randomBytes: randomBytes)
        var items = components.queryItems ?? []
        items += [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: configuration.clientId),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURL.absoluteString),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: PKCE.method),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "resource", value: configuration.resource),
        ]
        if !configuration.scopes.isEmpty { items.append(URLQueryItem(name: "scope", value: configuration.scopes.joined(separator: " "))) }
        components.queryItems = items
        guard let url = components.url else { throw SignInFailure.configuration("the authorization URL could not be built.") }
        return AuthorizationAttempt(url: url, state: state, pkce: pkce)
    }

    /// Completes sign-in from the callback URL: checks `state`, exchanges the code with the PKCE
    /// verifier and stores the tokens.
    public func complete(_ attempt: AuthorizationAttempt, callback: URL) async throws {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == attempt.state else { throw SignInFailure.stateMismatch }
        if let error = value("error") { throw SignInFailure.denied(error) }
        guard let code = value("code"), !code.isEmpty else { throw SignInFailure.missingCode }
        let tokens = try await token([
            "grant_type": "authorization_code", "code": code, "redirect_uri": configuration.redirectURL.absoluteString,
            "client_id": configuration.clientId, "code_verifier": attempt.pkce.verifier, "resource": configuration.resource,
        ], previousRefreshToken: nil)
        try store.save(tokens)
    }

    private struct TokenResponse: Decodable {
        var access_token: String
        var refresh_token: String?
        var expires_in: Double?
    }
    private struct TokenError: Decodable { var error: String; var error_description: String? }

    private func token(_ form: [String: String], previousRefreshToken: String?) async throws -> StoredTokens {
        let metadata = try await discover()
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let body = form.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&")
        let request = HTTPRequest(method: "POST", path: metadata.tokenEndpoint, headers: ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"], body: Data(body.utf8))
        let response: HTTPResponse
        do { response = try await transport.send(request) } catch let t as TransportFailure { throw SignInFailure.transport(t.reason) }
        guard response.status == 200, let decoded = try? JSONDecoder().decode(TokenResponse.self, from: response.body) else {
            let reason = (try? JSONDecoder().decode(TokenError.self, from: response.body)).map { $0.error_description ?? $0.error } ?? "status \(response.status)"
            throw SignInFailure.server(reason)
        }
        // Refresh tokens may rotate; when the server does not send a new one the previous one stays valid.
        return StoredTokens(accessToken: decoded.access_token, refreshToken: decoded.refresh_token ?? previousRefreshToken,
                            expiresAt: decoded.expires_in.map { time.now().addingTimeInterval($0) })
    }

    public func accessToken(forceRefresh: Bool) async throws -> String? {
        guard let tokens = store.load() else { return nil }
        let expired = tokens.expiresAt.map { $0.timeIntervalSince(time.now()) < OAuthSession.expiryMargin } ?? false
        guard forceRefresh || expired else { return tokens.accessToken }
        return try await refresh(tokens)?.accessToken
    }

    private func refresh(_ tokens: StoredTokens) async throws -> StoredTokens? {
        if let refreshTask { return try await refreshTask.value }
        guard let refreshToken = tokens.refreshToken else {
            store.clear() // nothing can renew this session: sign in again
            return nil
        }
        let task = Task<StoredTokens?, Error> { [configuration] in
            do {
                let fresh = try await self.token(["grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": configuration.clientId, "resource": configuration.resource],
                                                 previousRefreshToken: refreshToken)
                try self.store.save(fresh)
                return fresh
            } catch SignInFailure.server {
                // The server refused the refresh token (revoked or expired): the session is over.
                self.store.clear()
                return nil
            } catch SignInFailure.transport(let reason) {
                // Offline is not signed out: keep the tokens and report a transport failure.
                throw TransportFailure(reason)
            }
        }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    /// Forgets the session on this phone.
    public func signOut() {
        store.clear()
    }
}
