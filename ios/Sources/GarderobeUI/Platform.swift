#if os(iOS)
import AuthenticationServices
import Foundation
import Network
import Security
import UIKit
import GarderobeKit

/// Reports network path changes to the app model (offline commands, Today freshness, reconnect).
@MainActor
public final class NetworkMonitor {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "garderobe.network")

    public init() {}

    public func start(_ onChange: @escaping @MainActor @Sendable (Bool) -> Void) {
        monitor.pathUpdateHandler = { path in
            let online = path.status == .satisfied
            Task { @MainActor in onChange(online) }
        }
        monitor.start(queue: queue)
    }

    deinit { monitor.cancel() }
}

/// The native session's tokens (access + rotating refresh token) kept in the Keychain, this device only.
/// Garderobe's own login; Cloudflare account tokens are never used here.
public final class KeychainTokenStore: TokenStorage, @unchecked Sendable {
    private let service = "garderobe.native-session"
    public init() {}

    public func load() -> StoredTokens? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? GarderobeJSON.decoder().decode(StoredTokens.self, from: data)
    }

    public func save(_ tokens: StoredTokens?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(base as CFDictionary)
        guard let tokens, let data = try? GarderobeJSON.encoder().encode(tokens) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// Sign-in with the backend's secretless native client: PKCE S256 authorize in
/// ASWebAuthenticationSession (Cloudflare Access signs the owner in with Google), a validated
/// `garderobe://auth/callback` (exact redirect, state, issuer), then the form-encoded code exchange.
@MainActor
public final class SignInCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let auth: NativeAuthSession
    private var webSession: ASWebAuthenticationSession?

    public init(auth: NativeAuthSession) { self.auth = auth }

    /// Returns nil on success, otherwise a sentence for the owner.
    public func signIn() async -> String? {
        let request = NativeAuthorization.begin(auth.config)
        let callback: URL
        do {
            callback = try await withCheckedThrowingContinuation { continuation in
                let s = ASWebAuthenticationSession(url: request.authorizeURL, callback: .customScheme(NativeAuthConfig.callbackScheme)) { url, error in
                    if let error {
                        let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                        continuation.resume(throwing: cancelled ? NativeAuthError.cancelled : NativeAuthError.offline)
                        return
                    }
                    guard let url else { continuation.resume(throwing: NativeAuthError.wrongRedirect); return }
                    continuation.resume(returning: url)
                }
                s.presentationContextProvider = self
                s.prefersEphemeralWebBrowserSession = false
                webSession = s
                s.start()
            }
        } catch let e as NativeAuthError {
            webSession = nil
            return e == .cancelled ? nil : e.userMessage
        } catch {
            webSession = nil
            return NativeAuthError.offline.userMessage
        }
        webSession = nil
        do {
            try await auth.complete(callback: callback, request: request)
            return nil
        } catch {
            return error.userMessage
        }
    }

    /// Revokes the refresh token at the server and forgets the session on this phone.
    public func signOut() async { await auth.signOut() }

    public nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}
#endif
