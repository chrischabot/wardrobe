import Foundation
import Security
import Network
import AuthenticationServices
import UIKit
import GarderobeKit

/// Deployment values read from Info.plist (supplied through `Config/*.xcconfig`). Nothing here
/// is a constant in code, and there is no client secret.
struct AppConfiguration {
    var apiBaseURL: URL?
    var oauthClientID: String?
    var oauthRedirectURL: URL?
    var appGroup: String?
    var keychainGroup: String?

    static func load(from bundle: Bundle = .main) -> AppConfiguration {
        func string(_ key: String) -> String? {
            guard let value = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            // An unset build setting leaves an empty string or the unexpanded variable.
            return trimmed.isEmpty || trimmed.hasPrefix("$(") ? nil : trimmed
        }
        return AppConfiguration(apiBaseURL: string("GarderobeAPIBaseURL").flatMap(URL.init(string:)),
                                oauthClientID: string("GarderobeOAuthClientID"),
                                oauthRedirectURL: string("GarderobeOAuthRedirectURL").flatMap(URL.init(string:)),
                                appGroup: string("GarderobeAppGroup"),
                                keychainGroup: string("GarderobeKeychainGroup"))
    }

    /// What is missing for signing in to the real backend, in words for the sign-in screen.
    var missing: [String] {
        var out: [String] = []
        if apiBaseURL == nil { out.append("the API address (GARDEROBE_API_BASE_URL)") }
        if oauthClientID == nil { out.append("the sign-in client ID (GARDEROBE_OAUTH_CLIENT_ID)") }
        if oauthRedirectURL == nil { out.append("the sign-in callback address (GARDEROBE_OAUTH_REDIRECT_URL)") }
        return out
    }

    var oauth: OAuthConfiguration? {
        guard let apiBaseURL, let oauthClientID, let oauthRedirectURL else { return nil }
        return OAuthConfiguration(apiBaseURL: apiBaseURL, clientId: oauthClientID, redirectURL: oauthRedirectURL)
    }

    /// The directory shared with the share extension (the app-group container), or the app's own
    /// Application Support directory when no group is configured.
    func storageDirectory(_ name: String) -> URL {
        let fm = FileManager.default
        let base = appGroup.flatMap { fm.containerURL(forSecurityApplicationGroupIdentifier: $0) }
            ?? fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fm.temporaryDirectory
        return base.appendingPathComponent("Garderobe", isDirectory: true).appendingPathComponent(name, isDirectory: true)
    }
}

/// Access and refresh tokens in the Keychain, and only there. Items are available after the
/// first unlock (so a foreground refresh works) and never leave this device.
final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service = "garderobe.oauth"
    private let account = "session"
    private let accessGroup: String?

    init(accessGroup: String?) { self.accessGroup = accessGroup }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    func load() -> StoredTokens? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(StoredTokens.self, from: data)
    }

    func save(_ tokens: StoredTokens) throws {
        let data = try JSONEncoder().encode(tokens)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = baseQuery()
            insert.merge(attributes) { _, new in new }
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}

/// Runs the sign-in page in `ASWebAuthenticationSession` and returns the callback URL. The
/// callback is the verified HTTPS universal link; a custom scheme is used only if the
/// configured redirect is not HTTPS (local development).
@MainActor
final class WebAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    enum Failure: Error { case cancelled, failed(String) }
    private var session: ASWebAuthenticationSession?

    func authenticate(url: URL, redirect: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let handler: (URL?, Error?) -> Void = { callback, error in
                if let callback { continuation.resume(returning: callback); return }
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { continuation.resume(throwing: Failure.cancelled); return }
                continuation.resume(throwing: Failure.failed(error?.localizedDescription ?? "Sign-in did not complete."))
            }
            let session: ASWebAuthenticationSession
            if redirect.scheme?.lowercased() == "https", let host = redirect.host {
                session = ASWebAuthenticationSession(url: url, callback: .https(host: host, path: redirect.path.isEmpty ? "/" : redirect.path), completionHandler: handler)
            } else {
                session = ASWebAuthenticationSession(url: url, callback: .customScheme(redirect.scheme ?? "garderobe"), completionHandler: handler)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false // keep the identity provider's own session
            self.session = session
            if !session.start() { continuation.resume(throwing: Failure.failed("The sign-in page could not be opened.")) }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
        }
    }
}

/// Reports when the network path becomes usable again, so queued commands are sent as soon as
/// a connection returns instead of waiting for the next launch.
final class NetworkMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "garderobe.network")
    private var wasSatisfied = true

    func start(onReconnect: @escaping @Sendable () -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let satisfied = path.status == .satisfied
            if satisfied && !self.wasSatisfied { onReconnect() }
            self.wasSatisfied = satisfied
        }
        monitor.start(queue: queue)
    }

    deinit { monitor.cancel() }
}

/// Builds the app's object graph for one of two modes: the owner's backend, or the visibly
/// labelled demo mode that replays the bundled recording.
@MainActor
enum AppBootstrap {
    static let demoArgument = "-GarderobeDemo"
    static let resetArgument = "-GarderobeResetState"

    static var launchedInDemo: Bool { ProcessInfo.processInfo.arguments.contains(demoArgument) || UserDefaults.standard.bool(forKey: "garderobe.demoMode") }

    static func make(configuration: AppConfiguration = .load(), demo: Bool? = nil) -> AppModel {
        if demo ?? launchedInDemo, let model = makeDemo() { return model }
        let directory = configuration.storageDirectory("store")
        if ProcessInfo.processInfo.arguments.contains(resetArgument) { try? FileManager.default.removeItem(at: directory) }
        let store: KeyValueStore = (try? FileKeyValueStore(directory: directory)) ?? InMemoryKeyValueStore()
        let inbox = ShareInbox(store: (try? FileKeyValueStore(directory: configuration.storageDirectory("share"))) ?? InMemoryKeyValueStore())

        guard let oauth = configuration.oauth else {
            // Not configured for a backend: the app opens on the sign-in screen, which says what
            // is missing and offers the demo. No request can be sent anywhere.
            let environment = AppEnvironment(transport: UnconfiguredTransport(), tokens: StaticAccessToken(nil), store: store)
            return AppModel(environment: environment, session: nil, shareInbox: inbox)
        }
        let transport = URLSessionTransport(baseURL: oauth.apiBaseURL)
        let session = OAuthSession(configuration: oauth, transport: transport, store: KeychainTokenStore(accessGroup: configuration.keychainGroup))
        let environment = AppEnvironment(transport: transport, tokens: session, store: store)
        return AppModel(environment: environment, session: session, shareInbox: inbox)
    }

    /// Demo mode: the bundled recording of a real backend run, held in memory only. Every screen
    /// shows the "Demo data" label and changes outside the recording are refused.
    static func makeDemo() -> AppModel? {
        guard let cassette = try? Cassette.bundled("owner-morning") else { return nil }
        let time = ManualTimeSource(instant: cassette.clock)
        let environment = AppEnvironment(transport: FixtureBackend(cassette: cassette, mode: .demo), tokens: StaticAccessToken("demo"), store: InMemoryKeyValueStore(),
                                         time: time, isDemo: true, timeZone: TimeZone(identifier: cassette.timezone) ?? .current)
        return AppModel(environment: environment, session: nil, shareInbox: nil)
    }
}

/// The transport used when no backend is configured: every exchange fails as "no connection".
struct UnconfiguredTransport: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw TransportFailure("no backend is configured in this build") }
    func stream(_ request: HTTPRequest) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish(throwing: TransportFailure("no backend is configured in this build")) }
    }
}
