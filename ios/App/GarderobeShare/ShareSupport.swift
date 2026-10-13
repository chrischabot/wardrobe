import Foundation
import Security
import GarderobeKit

/// The share extension's deployment values, read from its own Info.plist (the extension is a
/// separate target and cannot see the app's `AppConfiguration`). Nothing is a constant in code.
struct ShareConfiguration {
    var apiBaseURL: URL?
    var oauthClientID: String?
    var appGroup: String?
    var keychainGroup: String?

    static func load(from bundle: Bundle = .main) -> ShareConfiguration {
        func string(_ key: String) -> String? {
            guard let value = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            // An unset build setting leaves an empty string or the unexpanded variable.
            return trimmed.isEmpty || trimmed.hasPrefix("$(") ? nil : trimmed
        }
        return ShareConfiguration(apiBaseURL: string("GarderobeAPIBaseURL").flatMap(URL.init(string:)),
                                  oauthClientID: string("GarderobeOAuthClientID"),
                                  appGroup: string("GarderobeAppGroup"),
                                  keychainGroup: string("GarderobeKeychainGroup"))
    }

    /// The inbox directory in the app-group container: exactly the directory the app reads
    /// (`AppConfiguration.storageDirectory("share")`). Nil when no group is configured, because
    /// the app could not read anything the extension stored elsewhere.
    var inboxDirectory: URL? {
        guard let appGroup, let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        return base.appendingPathComponent("Garderobe", isDirectory: true).appendingPathComponent("share", isDirectory: true)
    }

    /// The durable store behind the shared inbox, or nil when it cannot be opened.
    func inboxStore() -> KeyValueStore? {
        guard let inboxDirectory else { return nil }
        return try? FileKeyValueStore(directory: inboxDirectory)
    }

    /// The API client, or nil when this build has no API address or client ID. Without a client
    /// the link simply stays in the inbox and the app sends it.
    func apiClient() -> APIClient? {
        guard let apiBaseURL, let oauthClientID else { return nil }
        // The extension never starts a sign-in, so it has no redirect URL key. `OAuthSession`
        // still needs a value to be constructed: the API base URL stands in for it. The session
        // is used only to read the app's tokens and, when the access token has expired, to
        // refresh it; a refresh request does not send the redirect URL.
        let oauth = OAuthConfiguration(apiBaseURL: apiBaseURL, clientId: oauthClientID, redirectURL: apiBaseURL)
        let transport = URLSessionTransport(baseURL: apiBaseURL)
        let session = OAuthSession(configuration: oauth, transport: transport, store: SharedKeychainTokenStore(accessGroup: keychainGroup))
        return APIClient(transport: transport, tokens: session)
    }
}

/// The app's session in the shared Keychain access group: the same item the app's
/// `KeychainTokenStore` writes (service `garderobe.oauth`, account `session`). The extension
/// reads it. `save` and `clear` exist because a token refresh may rotate the refresh token, and
/// the app must then find the new one in the same item.
final class SharedKeychainTokenStore: TokenStore, @unchecked Sendable {
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

/// What became of a shared link, and the one sentence shown for it.
enum ShareOutcome: Equatable {
    /// The backend accepted the turn.
    case sent
    /// Stored in the shared inbox; the app sends it (offline, signed out, or not configured).
    case saved
    case notAWebLink
    /// The backend answered and finally refused at least one stored link; which one is not reported.
    case notAccepted
    /// The link could be neither sent nor stored where the app can find it.
    case notSaved

    var sentence: String {
        switch self {
        case .sent: return "Sent to Garderobe. The investigation continues in Conversation."
        case .saved: return "Saved. Garderobe will send it the next time you open the app."
        case .notAWebLink: return "This is not a web link."
        case .notAccepted: return "Garderobe did not accept every saved link. Open Conversation to check this one."
        case .notSaved: return "This link could not be saved on this phone. Paste it into Conversation instead."
        }
    }
}

/// Hands a shared link to Garderobe: stored in the inbox first, then sent if that is possible
/// now. This is the turn a pasted URL produces; the extension never sends a command.
enum ShareDelivery {
    static func deliver(url: String, pageTitle: String?, note: String, turnId: String, configuration: ShareConfiguration = .load()) async -> ShareOutcome {
        let durable = configuration.inboxStore()
        // Without the shared container the link is held only for this attempt.
        let inbox = ShareInbox(store: durable ?? InMemoryKeyValueStore())
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try inbox.add(url: url, pageTitle: pageTitle, note: trimmed.isEmpty ? nil : trimmed, id: turnId, now: Date())
        } catch ShareInboxError.notAWebLink {
            return .notAWebLink
        } catch {
            return .notSaved
        }
        let kept: ShareOutcome = durable == nil ? .notSaved : .saved
        guard let api = configuration.apiClient() else { return kept }
        let waiting = inbox.all().count
        let accepted = await inbox.drain(using: api)
        let remaining = inbox.all()
        if remaining.contains(where: { $0.id == turnId }) { return kept }
        // This link left the inbox. It was accepted for certain only if every link that left was.
        return accepted.count == waiting - remaining.count ? .sent : .notAccepted
    }
}
