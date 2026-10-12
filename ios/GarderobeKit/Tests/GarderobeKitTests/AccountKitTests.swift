import Testing
import Foundation
@testable import GarderobeKit

/// The recovery kit is shown once and never becomes part of the account state or its cache,
/// whichever answer carried it (a claim, an account read).
/// Every backend here is SYNTHETIC (scripted answers), labelled as such.
@MainActor
@Suite("Recovery kit: shown once, never in the account state or cache")
struct AccountKitTests {
    @Test("The recovery kit from a claim is shown once and is never part of the account state")
    func kitNotInState() async throws {
        let router = Router()
        router.json("POST", "/auth/claim", Synthetic.me(kit: Synthetic.kit()))
        let store = InMemoryKeyValueStore()
        let env = TestSupport.environment(transport: router.transport, store: store)
        let account = AccountModel(environment: env, session: nil)
        await account.claim(invitationCode: "INVITE-TEST")
        #expect(account.visibleKit?.recoveryCode == "RECOVERY-CODE-TEST-0001-0002")
        guard case .signedIn(let me) = account.state else { Issue.record("not signed in"); return }
        #expect(me.issuedRecoveryKit == nil && account.me?.issuedRecoveryKit == nil)
        let cached: Cached<MeResponse>? = env.cache.get("me")
        #expect(cached != nil && cached?.value.issuedRecoveryKit == nil)
        account.acknowledgeKit()
        #expect(account.visibleKit == nil)
        let persisted = store.keys(prefix: "").compactMap { store.read($0) }.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(!persisted.contains("RECOVERY-CODE-TEST"))
    }

    @Test("An account read that carries a kit keeps it out of the account state and the cache")
    func kitFromAccountReadNotInState() async throws {
        let router = Router()
        router.json("GET", "/v1/me", Synthetic.me(kit: Synthetic.kit()))
        let transport = router.transport
        let store = InMemoryKeyValueStore()
        let env = TestSupport.environment(transport: transport, store: store)
        let session = OAuthSession(configuration: OAuthTests.configuration, transport: transport, store: InMemoryTokenStore(StoredTokens(accessToken: "t", refreshToken: nil, expiresAt: nil)))
        let account = AccountModel(environment: env, session: session)
        await account.restore()
        #expect(account.isUsable)
        #expect(account.me != nil && account.me?.issuedRecoveryKit == nil)
        guard case .signedIn(let me) = account.state else { Issue.record("not signed in"); return }
        #expect(me.issuedRecoveryKit == nil)
        let persisted = store.keys(prefix: "").compactMap { store.read($0) }.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(!persisted.contains("RECOVERY-CODE-TEST"))
    }
}
