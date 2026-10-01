import Testing
import Foundation
@testable import GarderobeKit

@Suite("API client: routes, errors and token handling")
struct APIClientTests {
    final class RotatingTokens: AccessTokenProviding, @unchecked Sendable {
        let lock = NSLock()
        var refreshes = 0
        func accessToken(forceRefresh: Bool) async throws -> String? {
            lock.withLock {
                if forceRefresh { refreshes += 1 }
                return refreshes == 0 ? "stale" : "fresh"
            }
        }
    }

    @Test("A 401 is retried once with a refreshed token; a second 401 surfaces as needing sign-in")
    func refreshOnce() async throws {
        let transport = ScriptedTransport { request in
            request.headers["Authorization"] == "Bearer fresh" ? TestSupport.json(Synthetic.me()) : TestSupport.error("unauthenticated", "sign in to continue", status: 401)
        }
        let tokens = RotatingTokens()
        let me = try await APIClient(transport: transport, tokens: tokens).me()
        #expect(me.userId == "usr_test")
        #expect(transport.requests.count == 2 && tokens.refreshes == 1)

        let always401 = ScriptedTransport { _ in TestSupport.error("session_revoked", "sign in again", status: 401) }
        await #expect(throws: APIFailure.self) { try await APIClient(transport: always401, tokens: RotatingTokens()).me() }
        do { _ = try await APIClient(transport: always401, tokens: RotatingTokens()).me() } catch let failure as APIFailure {
            #expect(failure.needsSignIn && !failure.isRetryable)
        }
        #expect(always401.requests.count == 4) // two calls, each retried exactly once
    }

    @Test("Without a session nothing is sent")
    func signedOutSendsNothing() async {
        let transport = ScriptedTransport()
        await #expect(throws: APIFailure.signedOut) { try await APIClient(transport: transport, tokens: StaticAccessToken(nil)).today() }
        #expect(transport.requests.isEmpty)
    }

    @Test("The local development Worker takes the assertion in the Access header instead of a bearer token")
    func headerPresentation() async throws {
        let transport = ScriptedTransport { _ in TestSupport.json(Synthetic.me()) }
        _ = try await APIClient(transport: transport, tokens: StaticAccessToken("assertion"), presentation: .header("Cf-Access-Jwt-Assertion")).me()
        #expect(transport.requests[0].headers["Cf-Access-Jwt-Assertion"] == "assertion")
        #expect(transport.requests[0].headers["Authorization"] == nil)
    }

    @Test("Errors keep the distinctions the interface needs: transport, contract error, bare status, undecodable answer")
    func failureMapping() async {
        func failure(_ handler: @escaping ScriptedTransport.Handler) async -> APIFailure? {
            do { _ = try await APIClient(transport: ScriptedTransport(handler), tokens: StaticAccessToken("t")).serviceState(); return nil } catch { return error as? APIFailure }
        }
        let offline = await failure { _ in throw TransportFailure("no route to host") }
        #expect(offline?.isTransport == true && offline?.isRetryable == true)
        let refused = await failure { _ in TestSupport.error("forbidden", "This session cannot read the service state.", status: 403) }
        #expect(refused?.ownerMessage == "This session cannot read the service state." && refused?.isRetryable == false)
        let limited = await failure { _ in TestSupport.error("rate_limited", "Slow down.", status: 429) }
        #expect(limited?.isRetryable == true)
        let bare = await failure { _ in HTTPResponse(status: 502, body: Data("<html>bad gateway</html>".utf8)) }
        #expect(bare == .status(502) && bare?.isRetryable == true)
        let garbled = await failure { _ in HTTPResponse(status: 200, body: Data("{\"paused\":\"maybe\"}".utf8)) }
        if case .decoding? = garbled {} else { Issue.record("expected a decoding failure, got \(String(describing: garbled))") }
        // A code this build does not know still decodes and is shown with the backend's message.
        let novel = await failure { _ in TestSupport.error("quota_exhausted_tomorrow", "A new kind of refusal.", status: 409) }
        #expect(novel?.ownerMessage == "A new kind of refusal.")
    }

    @Test("Paths, queries and identifiers are built as the route manifest names them")
    func urlBuilding() async throws {
        let transport = ScriptedTransport { _ in HTTPResponse(status: 404) }
        let api = APIClient(transport: transport, tokens: StaticAccessToken("t"))
        _ = try? await api.item(id: "gmt/odd id?")
        _ = try? await api.wardrobe(InventoryQuery(search: "wide stripe & co", includeDisposed: false, limit: 25))
        _ = try? await api.availability(date: "2026-09-15")
        _ = try? await api.messages(around: "msg_1", limit: 40)
        _ = try? await api.rendition(id: "rnd_1", width: 320)
        let requests = transport.requests
        #expect(requests[0].path == "/v1/items/gmt%2Fodd%20id%3F")
        #expect(requests[1].query == [URLQueryItem(name: "search", value: "wide stripe & co"), URLQueryItem(name: "includeDisposed", value: "false"), URLQueryItem(name: "limit", value: "25")])
        #expect(requests[2].query == [URLQueryItem(name: "date", value: "2026-09-15")])
        #expect(requests[3].query == [URLQueryItem(name: "around", value: "msg_1"), URLQueryItem(name: "limit", value: "40")])
        #expect(requests[4].path == "/v1/media/renditions/rnd_1" && requests[4].query == [URLQueryItem(name: "width", value: "320")])

        let base = URL(string: "https://api.example.test/base/")!
        #expect(requests[1].url(relativeTo: base)?.absoluteString == "https://api.example.test/base/v1/wardrobe?search=wide%20stripe%20%26%20co&includeDisposed=false&limit=25")
        // A ticket URL issued by the backend keeps its own query; an absolute upload URL is used as given.
        #expect(HTTPRequest(method: "GET", path: "/v1/exports/e/download?ticket=abc").url(relativeTo: base)?.absoluteString == "https://api.example.test/base/v1/exports/e/download?ticket=abc")
        #expect(HTTPRequest(method: "PUT", path: "https://uploads.example.test/u?sig=1").url(relativeTo: base)?.host == "uploads.example.test")
    }

    @Test("A batch answer is read item by item; an unknown status is kept as not confirmed")
    func batchResults() throws {
        let receipt = try CommandBatchResult(["status": "receipt", "idempotencyKey": "k1", "receipt": TestSupport.receipt(commandId: "c1", type: "wear.record", summary: "ok")])
        if case .receipt(let key, let r) = receipt { #expect(key == "k1" && r.commandId == "c1") } else { Issue.record("not a receipt") }
        let error = try CommandBatchResult(["status": "error", "idempotencyKey": "k2", "error": ["code": "not_found", "message": "No such garment.", "details": [:]], "retryable": false])
        if case .error(_, let e, let retryable) = error { #expect(e.message == "No such garment." && !retryable) } else { Issue.record("not an error") }
        if case .unknown = try CommandBatchResult(["status": "deferred", "idempotencyKey": "k3"]) {} else { Issue.record("unknown status was not tolerated") }
    }
}

@Suite("Sign-in: public client, PKCE S256, resource indicator, refresh")
struct OAuthTests {
    static let configuration = OAuthConfiguration(apiBaseURL: URL(string: "https://api.example.test")!, clientId: "ios-public-client", redirectURL: URL(string: "https://app.example.test/oauth/callback")!)
    static let metadata: JSONValue = ["issuer": "https://id.example.test", "authorization_endpoint": "https://id.example.test/authorize", "token_endpoint": "https://id.example.test/token",
                                      "code_challenge_methods_supported": ["S256"]]

    private func form(_ request: HTTPRequest) -> [String: String] {
        var out: [String: String] = [:]
        for pair in String(decoding: request.body ?? Data(), as: UTF8.self).split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            out[parts[0]] = (parts.count > 1 ? parts[1] : "").removingPercentEncoding
        }
        return out
    }

    @Test("The authorization request carries the S256 challenge, state and resource, and no secret; the code is exchanged with the verifier")
    func authorizationCodeFlow() async throws {
        let transport = ScriptedTransport { request in
            if request.path == "/.well-known/oauth-authorization-server" { return TestSupport.json(Self.metadata) }
            return TestSupport.json(["access_token": "at_1", "refresh_token": "rt_1", "expires_in": 300, "token_type": "Bearer"])
        }
        let store = InMemoryTokenStore()
        let time = ManualTimeSource(instant: Synthetic.now)
        let session = OAuthSession(configuration: Self.configuration, transport: transport, store: store, time: time)
        #expect(!session.hasSession)

        let attempt = try await session.beginAuthorization(randomBytes: Array(0..<32), state: "state-1")
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: attempt.url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(attempt.url.host == "id.example.test")
        #expect(query["response_type"] == "code" && query["client_id"] == "ios-public-client")
        #expect(query["code_challenge_method"] == "S256" && query["code_challenge"] == attempt.pkce.challenge)
        #expect(query["redirect_uri"] == "https://app.example.test/oauth/callback" && query["resource"] == "https://api.example.test" && query["state"] == "state-1")
        #expect(query["client_secret"] == nil)
        #expect(!attempt.url.absoluteString.contains(attempt.pkce.verifier)) // the verifier never leaves the phone before the exchange

        // A callback with the wrong state is discarded before anything is exchanged.
        await #expect(throws: SignInFailure.stateMismatch) { try await session.complete(attempt, callback: URL(string: "https://app.example.test/oauth/callback?code=c&state=other")!) }
        await #expect(throws: SignInFailure.denied("access_denied")) { try await session.complete(attempt, callback: URL(string: "https://app.example.test/oauth/callback?error=access_denied&state=state-1")!) }
        #expect(!transport.requests.contains { $0.method == "POST" })

        try await session.complete(attempt, callback: URL(string: "https://app.example.test/oauth/callback?code=code-1&state=state-1")!)
        let exchange = form(try #require(transport.requests.last))
        #expect(exchange["grant_type"] == "authorization_code" && exchange["code"] == "code-1" && exchange["code_verifier"] == attempt.pkce.verifier)
        #expect(exchange["resource"] == "https://api.example.test" && exchange["client_secret"] == nil)
        #expect(store.load()?.accessToken == "at_1")
        #expect(try await session.accessToken(forceRefresh: false) == "at_1")
    }

    @Test("An expired token is refreshed once for concurrent callers; a rotated refresh token is stored")
    func refreshRotation() async throws {
        let transport = ScriptedTransport { request in
            if request.path == "/.well-known/oauth-authorization-server" { return TestSupport.json(Self.metadata) }
            return TestSupport.json(["access_token": "at_2", "refresh_token": "rt_2", "expires_in": 300])
        }
        let time = ManualTimeSource(instant: Synthetic.now)
        let store = InMemoryTokenStore(StoredTokens(accessToken: "at_1", refreshToken: "rt_1", expiresAt: time.now().addingTimeInterval(10)))
        let session = OAuthSession(configuration: Self.configuration, transport: transport, store: store, time: time)
        async let a = session.accessToken(forceRefresh: false)
        async let b = session.accessToken(forceRefresh: false)
        let tokens = try await [a, b]
        #expect(tokens == ["at_2", "at_2"])
        #expect(store.load()?.refreshToken == "rt_2")
        let refreshes = transport.requests.filter { $0.method == "POST" }
        #expect(refreshes.count <= 2 && form(refreshes[0])["grant_type"] == "refresh_token" && form(refreshes[0])["refresh_token"] == "rt_1")
    }

    @Test("Offline during a refresh is not a sign-out; a refused refresh ends the session")
    func refreshFailures() async throws {
        let offline = LockedFlag(true)
        let transport = ScriptedTransport { request in
            if request.path == "/.well-known/oauth-authorization-server" { return TestSupport.json(Self.metadata) }
            if offline.value { throw TransportFailure("offline") }
            return TestSupport.json(["error": "invalid_grant", "error_description": "The refresh token was revoked."], status: 400)
        }
        let time = ManualTimeSource(instant: Synthetic.now)
        let store = InMemoryTokenStore(StoredTokens(accessToken: "at_1", refreshToken: "rt_1", expiresAt: time.now().addingTimeInterval(-60)))
        let session = OAuthSession(configuration: Self.configuration, transport: transport, store: store, time: time)

        await #expect(throws: TransportFailure.self) { try await session.accessToken(forceRefresh: false) }
        #expect(store.load() != nil) // still signed in: the queue keeps its commands and retries later

        offline.value = false
        let token = try await session.accessToken(forceRefresh: false)
        #expect(token == nil)
        #expect(store.load() == nil)
    }

    @Test("A server without PKCE S256 is refused")
    func requiresS256() async {
        let transport = ScriptedTransport { _ in TestSupport.json(["authorization_endpoint": "https://id.example.test/authorize", "token_endpoint": "https://id.example.test/token", "code_challenge_methods_supported": ["plain"]]) }
        let session = OAuthSession(configuration: Self.configuration, transport: transport, store: InMemoryTokenStore())
        do { _ = try await session.beginAuthorization(); Issue.record("expected a configuration failure") } catch let failure as SignInFailure {
            if case .configuration = failure {} else { Issue.record("unexpected failure \(failure)") }
        } catch { Issue.record("unexpected error \(error)") }
    }
}

@MainActor
@Suite("Account, settings, Studio and persistence boundaries")
struct AccountSettingsTests {
    @Test("A version conflict on settings shows the current values instead of overwriting them")
    func settingsConflict() async {
        let router = Router()
        router.json("GET", "/v1/settings", Synthetic.settingsResponse(version: 4))
        router.on("POST", "/v1/commands") { request in
            #expect(TestSupport.body(request)["expectedVersions"]?["settings"]?.intValue == 4)
            router.json("GET", "/v1/settings", Synthetic.settingsResponse(version: 5))
            return TestSupport.error("conflict", "Settings changed elsewhere.", status: 409)
        }
        let settings = SettingsModel(environment: TestSupport.environment(transport: router.transport))
        await settings.refreshSettings()
        let outcome = await settings.setMorningTime("06:45")
        guard case .rejected? = outcome else { Issue.record("expected a conflict"); return }
        #expect(settings.settings.value?.version == 5)
        #expect(settings.message?.contains("changed elsewhere") == true)
    }

    @Test("An export whose bytes do not match the published checksum is discarded, and an incomplete export is never called complete")
    func exportIntegrity() async {
        func job(state: String, complete: Bool, sha: String) -> JSONValue {
            ["exportId": "exp_1", "runId": "run_e", "state": .string(state), "complete": .bool(complete), "encrypted": false, "formatVersion": "garderobe-export/1", "requestedAt": .string(Synthetic.now),
             "finishedAt": .string(Synthetic.now), "expiresAt": .null, "snapshot": .null,
             "components": [["name": "inventory", "state": "complete", "records": 127, "note": .null], ["name": "media", "state": complete ? "complete" : "incomplete", "records": 0, "note": "Two originals could not be read."]],
             "byteLength": 3, "sha256": .string(sha)]
        }
        let router = Router()
        router.json("POST", "/v1/exports", job(state: "completed_incomplete", complete: false, sha: String(repeating: "0", count: 64)))
        router.json("POST", "/v1/exports/exp_1/ticket", ["url": "/v1/exports/exp_1/download?ticket=t", "expiresAt": .string(Synthetic.now), "fileName": "export.zip"])
        router.on("GET", "/v1/exports/exp_1/download") { _ in HTTPResponse(status: 200, body: Data([1, 2, 3])) }
        let export = ExportModel(environment: TestSupport.environment(transport: router.transport))
        await export.start(passphrase: nil)
        #expect(export.statusLine == "The export finished but is incomplete: media could not be fully included.")
        #expect(export.componentLine(export.job!.components[1]) == "media: 0 records, incomplete (Two originals could not be read.)")
        await export.fetchPackage()
        #expect(export.download == nil)
        #expect(export.message == "The downloaded package did not match its checksum and was discarded. Download it again.")
    }

    @Test("When neither a linked sign-in nor a valid recovery code exists, the app says recovery is not possible and offers no override")
    func unrecoverable() async {
        let router = Router()
        router.json("POST", "/auth/recovery/start", ["transactionId": "rtx_1", "expiresAt": .string(Synthetic.now), "attemptsRemaining": 1])
        router.on("POST", "/auth/recovery/complete") { _ in TestSupport.error("unrecoverable", "No recovery credential matches.", status: 403) }
        let account = AccountModel(environment: TestSupport.environment(transport: router.transport), session: nil)
        await account.startRecovery()
        await account.completeRecovery(recoveryCode: "WRONG-CODE-0000-0000", unlinkPreviousIdentities: false)
        #expect(account.recoveryResult == nil && account.visibleKit == nil && account.recoveryTransaction == nil)
        #expect(account.message?.hasPrefix("This account cannot be recovered through this route") == true)
    }

    @Test("A sign-in that is verified but not linked leads to claim or recovery, not to an empty wardrobe")
    func identityNotLinked() async {
        let router = Router()
        router.on("GET", "/v1/me") { _ in TestSupport.error("identity_not_linked", "This sign-in is not linked to an account.", status: 403) }
        router.json("POST", "/auth/claim", Synthetic.me(kit: Synthetic.kit()))
        let transport = router.transport
        let store = InMemoryKeyValueStore()
        let env = TestSupport.environment(transport: transport, store: store)
        let session = OAuthSession(configuration: OAuthTests.configuration, transport: transport, store: InMemoryTokenStore(StoredTokens(accessToken: "t", refreshToken: nil, expiresAt: nil)))
        let account = AccountModel(environment: env, session: session)
        await account.restore()
        #expect(account.state == .identityNotLinked && !account.isUsable)

        await account.claim(invitationCode: " INVITE-0000-0000-0000 ")
        #expect(account.isUsable)
        #expect(account.visibleKit?.recoveryCode == "RECOVERY-CODE-TEST-0001-0002") // shown once, right after the claim
        #expect(TestSupport.body(transport.requests("POST", "/auth/claim")[0])["invitationCode"]?.stringValue == "INVITE-0000-0000-0000")
        let persisted = store.keys(prefix: "").compactMap { store.read($0) }.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(!persisted.contains("RECOVERY-CODE-TEST"))
    }

    @Test("In Studio a shopping candidate can be shown but never worn, and a locked piece is not changed by a suggestion")
    func studioBoundaries() async {
        let candidate: JSONValue = ["candidateId": "cand_1", "label": "Test shop jacket", "sourceUrl": "https://shop.example/jacket"]
        let router = Router()
        router.json("GET", "/v1/studio", Synthetic.studio(mode: "explore", selectors: [
            ("top", true, [Synthetic.selectorItem("gmt_test_shirt", name: "Test blue oxford shirt"), Synthetic.selectorItem("gmt_test_knit", name: "Test grey jumper")]),
            ("outer", true, [Synthetic.selectorItem("gmt_test_coat", name: "Test coat", marker: "seasonal_or_stored", eligible: false),
                             Synthetic.selectorItem(nil, name: "Test shop jacket", marker: "shopping_candidate", eligible: false, candidate: candidate)]),
            ("neckwear", false, [Synthetic.selectorItem("gmt_test_scarf", name: "Test wool scarf")]),
        ], opening: [("top", "gmt_test_shirt")]))
        let transport = router.transport
        let studio = StudioModel(environment: TestSupport.environment(transport: transport))
        await studio.open()
        #expect(studio.visibleSelectors.map(\.role) == [.top, .outer]) // accessories expand on demand
        studio.accessoriesExpanded = true
        #expect(studio.visibleSelectors.count == 3)
        #expect(studio.canWearThis)

        let jacket = studio.items(for: .outer)[1]
        studio.select(jacket, for: .outer)
        #expect(StudioModel.markerLabel(jacket) == "Shopping candidate")
        #expect(StudioModel.markerLabel(studio.items(for: .outer)[0]) == "In storage")
        #expect(studio.containsShoppingCandidate && !studio.canWearThis)
        #expect(studio.accessibilityDescription.contains("shopping candidate, not owned"))
        let worn = await studio.wearThis()
        #expect(worn == nil && transport.commands.isEmpty) // a candidate is never recorded as worn

        studio.toggleLock(.top)
        studio.step(.top, by: 1)
        #expect(studio.slots.first { $0.role == .top }?.item.garmentId == "gmt_test_shirt")
        let suggestion = try! (["slots": [["role": "top", "garmentId": "gmt_test_knit", "shoppingCandidate": .null, "locked": false], ["role": "outer", "garmentId": "gmt_test_coat", "shoppingCandidate": .null, "locked": false]],
                                "reason": "A warmer layer.", "validation": Synthetic.validation()] as JSONValue).decoded(as: StudioSuggestion.self)
        studio.apply(suggestion)
        #expect(studio.slots.first { $0.role == .top }?.item.garmentId == "gmt_test_shirt")   // locked: unchanged
        #expect(studio.slots.first { $0.role == .outer }?.item.garmentId == "gmt_test_coat")  // unlocked: replaced
    }

    @Test("The composition layout scales the manifest to the view and keeps the back-to-front order")
    func compositionLayout() throws {
        func layer(_ role: String, x: Double, y: Double, w: Double, h: Double, scale: Double, z: Int) -> JSONValue {
            ["role": .string(role), "garmentId": "g", "shoppingCandidateId": .null, "name": "n", "assetId": .null, "renditionId": .null, "renditionVersion": .null, "renditionSha256": .null,
             "imageLabel": "exact", "x": .number(x), "y": .number(y), "width": .number(w), "height": .number(h), "scale": .number(scale), "z": .integer(z)]
        }
        let manifest = try (["templateVersion": "1", "template": "separates", "canvas": ["width": 1000, "height": 2000, "background": "#FFFFFF"],
                             "layers": [layer("outer", x: 100, y: 100, w: 800, h: 900, scale: 1, z: 2), layer("top", x: 200, y: 200, w: 600, h: 600, scale: 0.5, z: 1)], "caption": "c"] as JSONValue).decoded(as: CompositionManifest.self)
        let frames = CompositionLayout.frames(for: manifest, in: 300, 400) // limited by height: scale 0.2, centred horizontally
        #expect(frames.map(\.layer.role) == [.top, .outer])
        #expect(frames[1].frame == CompositionLayout.Frame(x: 70, y: 20, width: 160, height: 180))
        #expect(frames[0].frame == CompositionLayout.Frame(x: 120, y: 70, width: 60, height: 60)) // scaled about the centre of its slot
        #expect(CompositionLayout.frames(for: manifest, in: 0, 400).isEmpty)
    }

    @Test("The command queue survives on disk in order, and a cache entry from an older build is a miss, not a crash")
    func filePersistence() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("garderobe-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try FileKeyValueStore(directory: directory)
        let queue = CommandQueue(store: store)
        for (index, id) in ["gmt_a", "gmt_b", "gmt_c"].enumerated() {
            let envelope = CommandEnvelope(type: "wear.record", payload: ["garmentIds": [.string(id)]], idempotencyKey: "ios-key-\(index)", authorization: .ownerTap, source: CommandSourceInput(channel: .ios))
            try await queue.enqueue(envelope, label: id, now: Date())
        }
        await queue.complete("ios-key-1")
        let reopened = CommandQueue(store: try FileKeyValueStore(directory: directory))
        #expect(await reopened.pending().map(\.label) == ["gmt_a", "gmt_c"])
        #expect(store.keys(prefix: "queue.") == ["queue.commands"])

        try store.write("cache.today", Data("{\"value\":{\"shape\":\"from an older build\"},\"checkedAt\":0}".utf8))
        let cache = SnapshotCache(store: store)
        let stale: Cached<TodayResponse>? = cache.get("today")
        #expect(stale == nil)
    }
}
