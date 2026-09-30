import Foundation
import Synchronization
import Testing
@testable import GarderobeKit

/// Native sign-in against the backend's secretless public client (PKCE S256, exact redirect, state,
/// issuer, rotating refresh tokens). The browser step is the fixture server's `authorize(_:)`, which
/// stands in for Cloudflare Access plus `GET /v1/auth/native/authorize`.
@Suite("Native sign-in")
struct NativeAuthTests {
    static let base = URL(string: "https://test.garderobe.invalid")!
    let config = NativeAuthConfig(baseURL: Self.base)

    final class TestClock: Sendable {
        private let value = Mutex(Fixtures.demoNow)
        func now() -> Date { value.withLock { $0 } }
        func advance(_ s: TimeInterval) { value.withLock { $0 = $0.addingTimeInterval(s) } }
    }

    func signedIn(_ server: FixtureServer, clock: TestClock = TestClock()) async throws -> (NativeAuthSession, MemoryTokenStorage) {
        let storage = MemoryTokenStorage()
        let session = NativeAuthSession(config: config, storage: storage, transport: server, now: { clock.now() })
        let request = NativeAuthorization.begin(config)
        let callback = try #require(await server.authorize(request.authorizeURL))
        try await session.complete(callback: callback, request: request)
        return (session, storage)
    }

    @Test func theAuthorizeURLIsThePublicPKCERequest() throws {
        let request = NativeAuthorization.begin(config)
        let c = try #require(URLComponents(url: request.authorizeURL, resolvingAgainstBaseURL: false))
        #expect(c.host == "test.garderobe.invalid")
        #expect(c.path == "/v1/auth/native/authorize")
        let q = Dictionary((c.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        #expect(q["response_type"] == "code")
        #expect(q["client_id"] == "garderobe-ios")
        #expect(q["redirect_uri"] == "garderobe://auth/callback")
        #expect(q["code_challenge_method"] == "S256")
        #expect(q["code_challenge"] == PKCE.challenge(for: request.codeVerifier))
        #expect(q["state"] == request.state)
        #expect(q["resource"] == "https://test.garderobe.invalid/v1")
        #expect(q["client_secret"] == nil)
        // RFC 7636: 43-128 unreserved characters; a fresh verifier and state every time.
        #expect((43...128).contains(request.codeVerifier.count))
        #expect(request.codeVerifier.allSatisfy { $0.isLetter || $0.isNumber || "-._~".contains($0) })
        let again = NativeAuthorization.begin(config)
        #expect(again.state != request.state && again.codeVerifier != request.codeVerifier)
    }

    @Test func pkceMatchesTheRFC7636Example() {
        // RFC 7636 appendix B.
        #expect(PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func signInExchangesTheCodeWithoutASecretAndAuthorisesRequests() async throws {
        let server = try FixtureServer()
        await server.setRequireAuth(true)
        let (session, storage) = try await signedIn(server)
        let stored = try #require(storage.load())
        #expect(stored.accessToken.hasPrefix("at_") && stored.refreshToken.hasPrefix("rt_"))
        let exchange = try #require(await server.requests(matching: "/v1/auth/native/token").last)
        #expect(exchange.method == "POST")
        #expect(exchange.headers["Content-Type"] == "application/x-www-form-urlencoded")
        #expect(exchange.headers["Authorization"] == nil)
        let form = FormEncoding.decode(String(decoding: exchange.body ?? Data(), as: UTF8.self))
        #expect(form["grant_type"] == "authorization_code")
        #expect(form["client_id"] == "garderobe-ios")
        #expect(form["redirect_uri"] == "garderobe://auth/callback")
        #expect(form["resource"] == "https://test.garderobe.invalid/v1")
        #expect(form["code_verifier"] != nil && form["client_secret"] == nil)

        let api = APIClient(baseURL: Self.base, transport: server, tokens: session)
        #expect(try await api.session().displayName == "Chris")
        let unauthenticated = APIClient(baseURL: Self.base, transport: server)
        await #expect(throws: APIError.unauthorized) { try await unauthenticated.session() }
    }

    @Test func aForgedOrMisroutedCallbackIsRefusedBeforeAnyExchange() async throws {
        let server = try FixtureServer()
        let request = NativeAuthorization.begin(config)
        let good = try #require(await server.authorize(request.authorizeURL))
        func tamper(_ edit: (inout URLComponents) -> Void) -> URL {
            var c = URLComponents(url: good, resolvingAgainstBaseURL: false)!
            edit(&c)
            return c.url!
        }
        func replace(_ name: String, _ value: String?) -> (inout URLComponents) -> Void {
            { c in c.queryItems = (c.queryItems ?? []).filter { $0.name != name } + (value.map { [URLQueryItem(name: name, value: $0)] } ?? []) }
        }
        #expect(throws: NativeAuthError.stateMismatch) { try NativeAuthorization.code(from: tamper(replace("state", "someone-elses")), for: request, config: config) }
        #expect(throws: NativeAuthError.stateMismatch) { try NativeAuthorization.code(from: tamper(replace("state", nil)), for: request, config: config) }
        #expect(throws: NativeAuthError.issuerMismatch("https://evil.example")) { try NativeAuthorization.code(from: tamper(replace("iss", "https://evil.example")), for: request, config: config) }
        #expect(throws: NativeAuthError.wrongRedirect) { try NativeAuthorization.code(from: tamper { $0.host = "evil" }, for: request, config: config) }
        #expect(throws: NativeAuthError.wrongRedirect) { try NativeAuthorization.code(from: tamper { $0.scheme = "https" }, for: request, config: config) }
        #expect(throws: NativeAuthError.missingCode) { try NativeAuthorization.code(from: tamper(replace("code", nil)), for: request, config: config) }
        #expect(throws: NativeAuthError.denied("The owner declined")) {
            try NativeAuthorization.code(from: tamper { c in
                c.queryItems = (c.queryItems ?? []).filter { $0.name != "code" } + [URLQueryItem(name: "error", value: "access_denied"), URLQueryItem(name: "error_description", value: "The owner declined")]
            }, for: request, config: config)
        }
        #expect(try NativeAuthorization.code(from: good, for: request, config: config).hasPrefix("code_"))
        #expect(await server.requests(matching: "/v1/auth/native/token").isEmpty)
    }

    @Test func aCodeFromAnotherAuthorizationFailsPKCE() async throws {
        let server = try FixtureServer()
        let storage = MemoryTokenStorage()
        let session = NativeAuthSession(config: config, storage: storage, transport: server)
        let mine = NativeAuthorization.begin(config)
        let theirs = NativeAuthorization.begin(config)
        let theirCallback = try #require(await server.authorize(theirs.authorizeURL))
        let code = try NativeAuthorization.code(from: theirCallback, for: theirs, config: config)
        // An intercepted code is useless without the verifier that made its challenge.
        await #expect(throws: NativeAuthError.tokenEndpoint(code: "invalid_grant", description: "PKCE verification failed")) {
            try await session.complete(code: code, request: mine)
        }
        #expect(storage.load() == nil)
    }

    @Test func anExpiredAccessTokenIsRefreshedOnceAndTheRequestRetried() async throws {
        let server = try FixtureServer()
        await server.setRequireAuth(true)
        let (session, storage) = try await signedIn(server)
        let firstRefresh = try #require(storage.load()?.refreshToken)
        await server.expireAccessTokens() // the 15 minutes ran out server-side
        let api = APIClient(baseURL: Self.base, transport: server, tokens: session)
        #expect(try await api.session().displayName == "Chris")
        let refreshes = await server.requests(matching: "/v1/auth/native/token").map { FormEncoding.decode(String(decoding: $0.body ?? Data(), as: UTF8.self)) }.filter { $0["grant_type"] == "refresh_token" }
        #expect(refreshes.count == 1)
        #expect(refreshes.first?["refresh_token"] == firstRefresh)
        // The rotated refresh token replaced the used one before anything else happened.
        #expect(storage.load()?.refreshToken != firstRefresh)
        #expect(await server.revokedSessions.isEmpty)
    }

    @Test func concurrentRequestsNeverReplayARotatedRefreshToken() async throws {
        let server = try FixtureServer()
        await server.setRequireAuth(true)
        let (session, _) = try await signedIn(server)
        await server.expireAccessTokens()
        let api = APIClient(baseURL: Self.base, transport: server, tokens: session)
        async let a = api.session()
        async let b = api.settings()
        async let c = api.session()
        let (ra, rb, rc) = try await (a, b, c)
        #expect(ra.displayName == "Chris" && rc.displayName == "Chris" && rb.deliveryTime == "07:00")
        // A replayed refresh token would have revoked the whole session.
        #expect(await server.revokedSessions.isEmpty)
    }

    @Test func aTokenCloseToExpiryIsRefreshedBeforeUse() async throws {
        let server = try FixtureServer()
        await server.setRequireAuth(true)
        let clock = TestClock()
        let (session, storage) = try await signedIn(server, clock: clock)
        let before = try #require(storage.load())
        clock.advance(890) // 10 s left of the 900 s lifetime
        let token = await session.token()
        #expect(token != nil && token != before.accessToken)
        #expect(storage.load()?.refreshToken != before.refreshToken)
    }

    @Test func aReplayedRefreshTokenEndsTheSessionAndAsksForSignIn() async throws {
        let server = try FixtureServer()
        await server.setRequireAuth(true)
        let (session, storage) = try await signedIn(server)
        let stolen = try #require(storage.load())
        await server.expireAccessTokens()
        #expect(await session.refreshAfterUnauthorized()) // rotates; `stolen.refreshToken` is now spent
        // Someone replays the spent token: the server revokes the session.
        let other = NativeAuthSession(config: config, storage: MemoryTokenStorage(stolen), transport: server)
        #expect(await other.refreshAfterUnauthorized() == false)
        #expect(await server.revokedSessions.count == 1)
        // Our copy is revoked too: the next refresh fails and the phone forgets the session.
        await server.expireAccessTokens()
        #expect(await session.refreshAfterUnauthorized() == false)
        #expect(storage.load() == nil)
        #expect(await session.isSignedIn == false)
    }

    @Test func offlineRefreshKeepsTheSession() async throws {
        let server = try FixtureServer()
        await server.setRequireAuth(true)
        let (session, storage) = try await signedIn(server)
        await server.expireAccessTokens()
        await server.setOffline(true)
        #expect(await session.refreshAfterUnauthorized() == false)
        #expect(storage.load() != nil) // not signed out just because the train went into a tunnel
    }

    @Test func signingOutRevokesAtTheServerAndForgetsLocally() async throws {
        let server = try FixtureServer()
        await server.setRequireAuth(true)
        let (session, storage) = try await signedIn(server)
        let refresh = try #require(storage.load()?.refreshToken)
        await session.signOut()
        #expect(storage.load() == nil)
        let revoke = try #require(await server.requests(matching: "/v1/auth/native/revoke").last)
        #expect(FormEncoding.decode(String(decoding: revoke.body ?? Data(), as: UTF8.self))["token"] == refresh)
        #expect(revoke.headers["Authorization"] == nil)
        #expect(await server.revokedSessions.count == 1)
        let api = APIClient(baseURL: Self.base, transport: server, tokens: session)
        await #expect(throws: APIError.unauthorized) { try await api.session() }
        #expect(await server.requests(matching: "/v1/auth/native/token").count == 1) // no refresh attempt after sign-out
    }
}
