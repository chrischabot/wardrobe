import Foundation

/// Bundled demo fixtures (generated from the owner's real CSV and profile by `scripts/fixtures.ts`).
public enum Fixtures {
    public static var directory: URL? { Bundle.module.url(forResource: "Fixtures", withExtension: nil) }

    public static func data(_ name: String) -> Data? {
        guard let dir = directory else { return nil }
        return try? Data(contentsOf: dir.appendingPathComponent(name))
    }

    public static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        guard let data = data(name) else { throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: name]) }
        return try GarderobeJSON.decoder().decode(T.self, from: data)
    }

    public static var today: TodayResponse { get throws { try decode(TodayResponse.self, "today.json") } }
    /// DEMO trip-day Today (purpose `trip:<tripId>`, Thursday 15 October 2026 in Paris).
    public static var todayTrip: TodayResponse { get throws { try decode(TodayResponse.self, "today-trip.json") } }
    public static var wardrobe: WardrobePage { get throws { try decode(WardrobePage.self, "wardrobe.json") } }
    public static var itemDetails: [String: ItemDetail] { get throws { try decode([String: ItemDetail].self, "item-details.json") } }
    public static var style: StyleCurrentResponse { get throws { try decode(StyleCurrentResponse.self, "style-current.json") } }
    public static var laundry: LaundryState { get throws { try decode(LaundryState.self, "laundry.json") } }
    public static var connections: ConnectionsResponse { get throws { try decode(ConnectionsResponse.self, "connections.json") } }
    public static var settings: SettingsResponse { get throws { try decode(SettingsResponse.self, "settings.json") } }
    public static var conversation: ConversationPage { get throws { try decode(ConversationPage.self, "conversation.json") } }
    public static var conversationOlder: ConversationPage { get throws { try decode(ConversationPage.self, "conversation-older.json") } }
    public static var runEventsSSE: String { String(decoding: data("run-events.sse") ?? Data(), as: UTF8.self) }
    public static var recoveryStatus: RecoveryStatus { get throws { try decode(RecoveryStatus.self, "recovery-status.json") } }
    public static var accountTransfers: AccountTransfers { get throws { try decode(AccountTransfers.self, "account-transfers.json") } }
    /// The instant the demo board is "now" (06:52 on Tuesday 6 October 2026, London).
    public static let demoNow = Instant.parse("2026-10-06T05:52:00.000Z")!
}

/// A scripted fault for the next matching request.
public enum FixtureFault: Sendable, Equatable {
    case offline
    /// The server applies the command but the response is lost (tests idempotent retry).
    case dropResponseAfterApplying
    case interrupted
    case serverError(Int)
}

/// In-memory backend used by unit tests, SwiftUI previews and the hermetic UI tests. It serves the
/// fixtures and applies commands with the same receipt semantics as the backend (idempotency,
/// merge, undo as compensation). It is not a recommendation engine: it never composes a board.
public actor FixtureServer: HTTPTransport {
    public private(set) var today: TodayResponse
    public private(set) var wardrobe: WardrobePage
    public private(set) var details: [String: ItemDetail]
    public private(set) var style: StyleCurrentResponse
    public private(set) var laundry: LaundryState
    public private(set) var connections: ConnectionsResponse
    public private(set) var settings: SettingsResponse
    public private(set) var messages: [ConversationMessage]
    public private(set) var issuedReceipts: [CommandReceipt] = []
    public private(set) var requestLog: [HTTPRequest] = []
    public private(set) var cancelledRuns: Set<String> = []

    public var offline = false
    /// When true, every /v1 route except native sign-in and signed upload PUTs needs a valid bearer token.
    public var requireAuth = false
    /// When true, a stream resumed with Last-Event-ID gets a `snapshot` first (an expired cursor).
    public var cursorsExpired = false
    public private(set) var combinations: [String: JSONValue] = [:]
    private var faults: [(path: String, fault: FixtureFault)] = []
    private var idempotency: [String: (body: Data, receipt: CommandReceipt)] = [:]
    private var turns: [String: TurnResponse] = [:]
    private var runs: [String: [String]] = [:] // runId -> SSE event blocks
    private var pendingActions: [String: PendingAction] = [:] // runId -> question
    private var answeredReceipts: [String: CommandReceipt] = [:] // runId -> the receipt a replayed answer returns
    private var truncateUpload = false
    private var redactionNotices: [String: (notice: TurnNotice, messageId: String)] = [:] // runId -> notice settled after the reply, with the owner's message id
    /// The API origin the client uses: private links are issued on it, as `withDeliveryLinks` does.
    public nonisolated let origin: String
    private var recovery: RecoveryStatus
    private var accountTransfers: AccountTransfers
    private var answeredOperations: [String: AccountOperationReceipt] = [:] // runId -> confirmed operation
    private var exportLinks: [String: (token: String, expiresAt: Date, exportId: String)] = [:]
    private var recoveryLinks: [String: (token: String, expiresAt: Date, collected: Bool)] = [:]
    private var importTargetEmpty = true
    /// Test observation: successful export downloads and recovery-code collections.
    public private(set) var exportDownloads = 0
    public private(set) var issuedRecoveryCodes: [String] = []
    static let accountOperations: Set<String> = ["export_data", "import_data", "issue_recovery_kit"]
    private var dropStreamAfter: Int?
    private var counter = 0
    private let olderPage: ConversationPage
    private let sseTemplate: String
    private let clock: @Sendable () -> Date
    // Native sign-in (public PKCE client) state.
    private var authCodes: [String: (challenge: String, redirect: String, resource: String)] = [:]
    private var accessTokens: [String: String] = [:] // access token -> session
    private var refreshTokens: [String: String] = [:] // current refresh token -> session
    private var rotatedRefreshTokens: [String: String] = [:] // already-used refresh token -> session
    public private(set) var revokedSessions: Set<String> = []

    public init(now: @escaping @Sendable () -> Date = { Fixtures.demoNow }, startOffline: Bool = false, tripDay: Bool = false, origin: String = "https://test.garderobe.invalid") throws {
        self.origin = origin
        recovery = try Fixtures.recoveryStatus
        accountTransfers = try Fixtures.accountTransfers
        offline = startOffline
        var t = try Fixtures.today
        var w = try Fixtures.wardrobe
        var d = try Fixtures.itemDetails
        if tripDay { t = try Self.tripState(wardrobe: &w, details: &d) }
        today = t
        wardrobe = w
        details = d
        style = try Fixtures.style
        laundry = try Fixtures.laundry
        connections = try Fixtures.connections
        settings = try Fixtures.settings
        messages = try Fixtures.conversation.messages
        olderPage = try Fixtures.conversationOlder
        sseTemplate = Fixtures.runEventsSSE
        clock = now
    }

    // MARK: Test controls

    public func setOffline(_ value: Bool) { offline = value }
    public func setRequireAuth(_ value: Bool) { requireAuth = value }
    public func setCursorsExpired(_ value: Bool) { cursorsExpired = value }
    /// Simulates the 15-minute access-token lifetime running out.
    public func expireAccessTokens() { accessTokens = [:] }
    public func inject(_ fault: FixtureFault, forPathPrefix path: String) { faults.append((path, fault)) }
    /// The next event stream closes after `n` events without finishing (a dropped mobile connection).
    public func dropNextStream(after n: Int) { dropStreamAfter = n }
    public func replaceToday(_ t: TodayResponse) { today = t }
    /// The next signed upload PUT stores fewer bytes than were sent (a truncated mobile upload).
    public func truncateNextUpload() { truncateUpload = true }
    /// A packed trip covers the date: Today serves the DEMO trip-day board, and the suitcase's garments
    /// are "Packed for a trip" at home, as `GET /v1/wardrobe` and `GET /v1/items/{id}` report them.
    public func startTrip() throws { today = try Self.tripState(wardrobe: &wardrobe, details: &details) }

    private static func tripState(wardrobe: inout WardrobePage, details: inout [String: ItemDetail]) throws -> TodayResponse {
        let today = try Fixtures.todayTrip
        let packed = Set(today.board?.options.flatMap { $0.slots.map(\.garmentId) } ?? [])
        let away = AvailabilitySummary(label: "Packed for a trip", available: false, reasons: ["Packed for a trip (in the suitcase)"])
        for i in wardrobe.items.indices where packed.contains(wardrobe.items[i].garment.garmentId) {
            wardrobe.items[i].availability = away
            details[wardrobe.items[i].garment.garmentId]?.item.availability = away
        }
        return today
    }
    /// Makes every garment unavailable (Studio "nothing works" and plan-refusal journeys).
    public func markEverythingUnavailable() {
        for i in wardrobe.items.indices { wardrobe.items[i].availability = AvailabilitySummary(label: "Not clean", available: false, reasons: []) }
    }
    public func requests(matching prefix: String) -> [HTTPRequest] { requestLog.filter { Self.split($0.path).path.hasPrefix(prefix) } }

    /// Splits an absolute or relative request path into its path and query (signed URLs carry `?t=`).
    static func split(_ raw: String) -> (path: String, query: [String: String]) {
        let c = URLComponents(string: raw)
        let path = c?.path.isEmpty == false ? c!.path : (raw.split(separator: "?").first.map(String.init) ?? raw)
        let query = Dictionary((c?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        return (path, query)
    }

    // MARK: Native sign-in (the Access-protected browser step, simulated)

    /// What GET /v1/auth/native/authorize does after Access has signed the owner in: validates the
    /// public-client request and returns the redirect the browser would follow.
    public func authorize(_ url: URL) -> URL? {
        let q = Dictionary((URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        guard q["client_id"] == NativeAuthConfig.clientId, let redirect = q["redirect_uri"], redirect == NativeAuthConfig.redirectURI else { return nil }
        let resource = q["resource"] ?? ""
        let iss = resource.hasSuffix("/v1") ? String(resource.dropLast(3)) : resource
        var back = URLComponents(string: redirect)!
        func done(_ items: [String: String]) -> URL {
            back.queryItems = (items.merging(["iss": iss, "state": q["state"] ?? ""]) { a, _ in a }).sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            return back.url!
        }
        guard q["response_type"] == "code" else { return done(["error": "unsupported_response_type"]) }
        guard q["code_challenge_method"] == "S256" else { return done(["error": "invalid_request", "error_description": "PKCE S256 is required"]) }
        let challenge = q["code_challenge"] ?? ""
        guard challenge.count >= 43, challenge.count <= 128 else { return done(["error": "invalid_request", "error_description": "Invalid code_challenge"]) }
        guard resource.hasSuffix("/v1") else { return done(["error": "invalid_target"]) }
        counter += 1
        let code = "code_fixture\(counter)"
        authCodes[code] = (challenge, redirect, resource)
        return done(["code": code])
    }

    private func oauthError(_ status: Int, _ error: String, _ description: String) -> HTTPResponse {
        json(status, ["error": error, "error_description": description])
    }

    private func issueTokens(session: String, scope: String = NativeAuthConfig.scope) -> HTTPResponse {
        counter += 1
        let access = "at_fixture\(counter)", refresh = "rt_fixture\(counter)"
        accessTokens[access] = session
        refreshTokens[refresh] = session
        return json(200, NativeTokenResponse(access_token: access, token_type: "Bearer", expires_in: 900, refresh_token: refresh, scope: scope))
    }

    private func nativeToken(_ r: HTTPRequest) -> HTTPResponse {
        let form = FormEncoding.decode(String(decoding: r.body ?? Data(), as: UTF8.self))
        if form["client_secret"] != nil || r.headers["Authorization"] != nil { return oauthError(401, "invalid_client", "This is a public client: no client secret is accepted") }
        guard form["client_id"] == NativeAuthConfig.clientId else { return oauthError(401, "invalid_client", "Unknown client") }
        switch form["grant_type"] {
        case "authorization_code":
            guard let code = form["code"], let entry = authCodes.removeValue(forKey: code) else { return oauthError(400, "invalid_grant", "The authorization code is invalid, expired or already used") }
            guard entry.redirect == form["redirect_uri"] else { return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request") }
            if let res = form["resource"], res != entry.resource { return oauthError(400, "invalid_target", "resource does not match the authorization request") }
            guard PKCE.challenge(for: form["code_verifier"] ?? "") == entry.challenge else { return oauthError(400, "invalid_grant", "PKCE verification failed") }
            counter += 1
            return issueTokens(session: "ses_fixture\(counter)")
        case "refresh_token":
            let rt = form["refresh_token"] ?? ""
            if let session = rotatedRefreshTokens[rt] {
                revokedSessions.insert(session)
                refreshTokens = refreshTokens.filter { $0.value != session }
                accessTokens = accessTokens.filter { $0.value != session }
                return oauthError(400, "invalid_grant", "Refresh token was already used; the session has been revoked")
            }
            guard let session = refreshTokens.removeValue(forKey: rt) else { return oauthError(400, "invalid_grant", "The refresh token is invalid, expired or revoked") }
            rotatedRefreshTokens[rt] = session
            return issueTokens(session: session)
        default:
            return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token")
        }
    }

    private func nativeRevoke(_ r: HTTPRequest) -> HTTPResponse {
        let token = FormEncoding.decode(String(decoding: r.body ?? Data(), as: UTF8.self))["token"] ?? ""
        if let session = refreshTokens[token] ?? accessTokens[token] {
            revokedSessions.insert(session)
            refreshTokens = refreshTokens.filter { $0.value != session }
            accessTokens = accessTokens.filter { $0.value != session }
        }
        return HTTPResponse(status: 200)
    }

    private func authorized(_ r: HTTPRequest, path: String) -> Bool {
        guard requireAuth else { return true }
        if path.hasPrefix("/v1/auth/native/") || (r.method == "PUT" && path.hasPrefix("/v1/uploads/")) || path.hasPrefix("/v1/media/") { return true }
        guard let h = r.headers["Authorization"], h.hasPrefix("Bearer ") else { return false }
        return accessTokens[String(h.dropFirst(7))] != nil
    }

    // MARK: Transport

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requestLog.append(request)
        if offline { throw TransportError.offline }
        let fault = takeFault(for: Self.split(request.path).path)
        switch fault {
        case .offline: throw TransportError.offline
        case .interrupted: throw TransportError.interrupted("fixture: connection dropped")
        case .serverError(let code): return json(code, ["schemaVersion": .string(ContractsVersion.current), "error": ["code": "internal", "message": "Fixture failure"]] as JSONValue)
        case .dropResponseAfterApplying:
            _ = try route(request)
            throw TransportError.interrupted("fixture: response lost after the server applied it")
        case nil: return try route(request)
        }
    }

    public nonisolated func lines(_ request: HTTPRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let lines = try await self.streamLines(request)
                    for line in lines { continuation.yield(line) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func takeFault(for path: String) -> FixtureFault? {
        guard let i = faults.firstIndex(where: { path.hasPrefix($0.path) }) else { return nil }
        return faults.remove(at: i).fault
    }

    private func streamLines(_ request: HTTPRequest) throws -> [String] {
        requestLog.append(request)
        if offline { throw TransportError.offline }
        if !authorized(request, path: request.path) { throw TransportError.interrupted("HTTP 401") }
        let parts = request.path.split(separator: "/")
        guard parts.count == 4, parts[1] == "runs", parts[3] == "events" else { throw TransportError.invalidURL }
        let runId = String(parts[2])
        let blocks = runs[runId] ?? []
        let cursor = request.headers["Last-Event-ID"]
        let after = cursor.flatMap(Int.init) ?? 0
        if cursor != nil, cursorsExpired || after > blocks.count {
            // An expired or unknown cursor: a snapshot of the current state, then nothing older.
            let finished = blocks.contains { $0.contains("event: run_finished") } || cancelledRuns.contains(runId)
            if finished && !cancelledRuns.contains(runId) { settle(runId: runId) }
            return snapshotBlock(runId: runId, id: blocks.count, finished: finished).components(separatedBy: "\n")
        }
        var selected = Array(blocks.dropFirst(after))
        if cancelledRuns.contains(runId) {
            selected = [finishedBlock(runId: runId, id: blocks.count + 1, status: "cancelled")]
        }
        if let n = dropStreamAfter {
            dropStreamAfter = nil
            selected = Array(selected.prefix(n))
            return selected.joined().components(separatedBy: "\n") + [": connection lost"]
        }
        if !cancelledRuns.contains(runId), selected.contains(where: { $0.contains("event: run_finished") }) { settle(runId: runId) }
        return selected.joined().components(separatedBy: "\n")
    }

    // MARK: Routing

    private func json(_ status: Int, _ value: some Encodable) -> HTTPResponse {
        HTTPResponse(status: status, headers: ["Content-Type": "application/json"], body: (try? GarderobeJSON.encoder().encode(value)) ?? Data())
    }

    private func apiError(_ status: Int, _ code: String, _ message: String) -> HTTPResponse {
        json(status, ["schemaVersion": .string(ContractsVersion.current), "error": ["code": .string(code), "message": .string(message)]] as JSONValue)
    }

    private func notFound(_ path: String) -> HTTPResponse { apiError(404, "not_found", "No route for \(path)") }

    private func runStatus(_ id: String) -> RunStatus {
        let status: RunState
        if cancelledRuns.contains(id) { status = .cancelled }
        else if let p = pendingActions[id], p.status == "pending" { status = .inputRequired }
        else if runs[id] == nil { status = .failed }
        else if runs[id]!.contains(where: { $0.contains("event: run_finished") }) { status = .finished }
        else { status = .running }
        let pending = pendingActions[id].flatMap { $0.status == "pending" ? $0 : nil }
        return RunStatus(runId: id, kind: "conversation_turn", status: status, lastEventId: runs[id].map { String($0.count) }, messageId: "msg_\(id)", message: messages.last { $0.messageId == "msg_\(id)" }, receipts: [], pendingAction: pending)
    }

    private func route(_ r: HTTPRequest) throws -> HTTPResponse {
        let (path, urlQuery) = Self.split(r.path)
        let query = r.query.merging(urlQuery) { a, _ in a }
        let p = path.split(separator: "/").map(String.init) // ["v1", ...]
        guard p.first == "v1" else { return notFound(path) }
        guard authorized(r, path: path) else { return apiError(401, "unauthorized", "Sign in to continue") }
        let s = Array(p.dropFirst())
        // Private links from confirmed account operations (signed `t`, owner's own session, 15 minutes).
        if r.method == "GET", s.count == 3, s[0] == "export", s[1] == "downloads" { return exportDownload(s[2], token: query["t"]) }
        if r.method == "POST", s.count == 4, s[0] == "auth", s[1] == "recovery-kit", s[2] == "collect" { return collectRecovery(s[3], token: query["t"], request: r) }
        // Replace identifier segments with "*" so routes can be matched as strings.
        let key = r.method + " " + s.enumerated().map { i, seg in
            let isParam = (i == 1 && ["items", "connections", "runs", "uploads", "commands"].contains(s[0])) || (i == 2 && s.first == "today" && s.count > 1 && s[1] == "options")
            return isParam ? "*" : seg
        }.joined(separator: "/")
        switch key {
        case "POST auth/native/token": return nativeToken(r)
        case "POST auth/native/revoke": return nativeRevoke(r)
        case "GET auth/session":
            return json(200, ["schemaVersion": .string(ContractsVersion.current), "displayName": "Chris", "authenticatedBy": .string(requireAuth ? "native_token" : "access"), "scopes": ["wardrobe:read", "wardrobe:write"], "expiresAt": .null] as JSONValue)
        case "GET today": return json(200, today)
        case "GET today/options/*/swaps": return json(200, swaps(optionId: s[2], role: GarmentRole(rawValue: query["role"] ?? "base_top")))
        case "GET wardrobe": return json(200, wardrobe)
        case "GET wardrobe/temperature-preview": return json(200, temperaturePreview(Double(query["temperatureC"] ?? "15") ?? 15))
        case "GET items/*":
            guard let d = details[s[1]] else { return notFound(path) }
            return json(200, d)
        case "POST commands": return try command(r.body ?? Data())
        case "GET settings": return json(200, settings)
        case "GET auth/recovery-kit": return json(200, recovery)
        case "POST auth/recovery-kit":
            counter += 1
            let code = "DEMO-\(Self.linkToken().prefix(16).uppercased())"
            issuedRecoveryCodes.append(code)
            recovery = RecoveryStatus(hasActiveKit: true, activeKitIssuedAt: clock(), lastRecoveredAt: recovery.lastRecoveredAt, failedAttemptsLast24h: recovery.failedAttemptsLast24h, pendingCollection: recovery.pendingCollection)
            return json(201, RecoveryKitResponse(credential: code, credentialId: "rcv_fixture\(counter)", instructions: "DEMO FIXTURE: keep this code somewhere safe; it is shown once.", issuedAt: clock()))
        case "GET account/transfers": return json(200, accountTransfers)
        case "GET style/current": return json(200, style)
        case "GET laundry": return json(200, laundry)
        case "GET connections": return json(200, connections)
        case "POST connections/*/disconnect":
            let id = s[1]
            guard let i = connections.connections.firstIndex(where: { $0.connectionId == id }) else { return notFound(path) }
            let isGrant = connections.connections[i].isAssistantGrant
            if isGrant {
                connections.connections.remove(at: i)
                if let g = settings.connectedAssistants.firstIndex(where: { $0.grantId == id }) {
                    settings.connectedAssistants[g].status = "revoked"
                    settings.connectedAssistants[g].revokedAt = clock()
                }
            } else {
                connections.connections[i].status = "disconnected"
                connections.connections[i].reconnectUrl = "/v1/connections/\(id)/connect"
            }
            return json(200, ["schemaVersion": .string(ContractsVersion.current), "connectionId": .string(id), "status": "disconnected", "cancelledCalls": 0, "remoteRevocation": .string(isGrant ? "revoked" : "not_supported")] as JSONValue)
        case "GET receipts": return json(200, ["schemaVersion": .string(ContractsVersion.current), "receipts": try JSONValue.encode(Array(issuedReceipts.reversed())), "nextCursor": .null] as JSONValue)
        case "GET conversation/messages":
            if query["before"] != nil { return json(200, olderPage) }
            if let around = query["around"] {
                let all = (olderPage.messages + messages).sorted { $0.createdAt < $1.createdAt }
                guard all.contains(where: { $0.messageId == around }) else { return notFound("/v1/conversation/messages?around=\(around)") }
                return json(200, ConversationPage(messages: all, before: nil, hasMore: false, activeRunId: nil))
            }
            return json(200, ConversationPage(messages: messages, before: "cur_older0001", hasMore: true, activeRunId: nil))
        case "POST recall/search": return recall(r.body ?? Data())
        case "POST conversation/turns": return try turn(r.body ?? Data())
        case "GET runs/*": return json(200, runStatus(s[1]))
        case "POST runs/*/cancel":
            cancelledRuns.insert(s[1])
            pendingActions[s[1]]?.status = "cancelled"
            return json(200, ["schemaVersion": .string(ContractsVersion.current), "runId": .string(s[1]), "status": "cancelled", "committedEffects": [], "stopped": ["reply"]] as JSONValue)
        case "POST runs/*/input": return answer(runId: s[1], body: r.body ?? Data())
        case "POST studio/validate":
            let req = try GarderobeJSON.decoder().decode(StudioValidateRequest.self, from: r.body ?? Data())
            return json(200, validate(req.slots, mode: req.mode))
        case "POST studio/suggest":
            let req = try GarderobeJSON.decoder().decode(StudioSuggestRequest.self, from: r.body ?? Data())
            return json(200, suggest(req))
        case "POST uploads":
            let req = try GarderobeJSON.decoder().decode(UploadRequest.self, from: r.body ?? Data())
            guard req.byteLength <= UploadRequest.maxBytes else { return apiError(422, "validation_failed", "Uploads are limited to 25 MB") }
            counter += 1
            let id = "upl_fixture\(counter)"
            return json(200, UploadAuthorization(uploadId: id, uploadUrl: "/v1/uploads/\(id)?t=tok\(counter)", method: "PUT", headers: [:], expiresAt: clock().addingTimeInterval(600)))
        case "PUT uploads/*":
            guard query["t"] != nil, r.headers["Authorization"] == nil else { return apiError(401, "unauthorized", "The upload URL's token is required") }
            let size = r.body?.count ?? 0
            let stored = truncateUpload ? size / 2 : size
            truncateUpload = false
            return json(200, UploadReceiveResponse(uploadId: s[1], receivedBytes: stored))
        case "POST uploads/*/complete":
            return json(200, UploadCompleteResponse(uploadId: s[1], status: "finalized", reason: nil, assetId: "ast_\(s[1])"))
        default:
            return notFound(path)
        }
    }

    // MARK: Commands

    private func item(_ id: String) -> WardrobeItem? { wardrobe.items.first { $0.garment.garmentId == id } }
    private func name(_ id: String) -> String { item(id)?.garment.name ?? today.garments.first { $0.garmentId == id }?.name ?? id }

    private func command(_ body: Data) throws -> HTTPResponse {
        let envelope = try GarderobeJSON.decoder().decode(CommandEnvelope.self, from: body)
        let canonical = try GarderobeJSON.encoder().encode(envelope.command)
        if let stored = idempotency[envelope.idempotencyKey] {
            if stored.body == canonical {
                var replay = stored.receipt
                replay.replayed = true
                return json(200, replay)
            }
            return json(409, receipt(envelope, outcome: .rejected, summary: "Nothing changed.", error: ("idempotency_key_reused", "That key was used for a different request")))
        }
        let result = apply(envelope)
        if result.outcome.didCommit {
            idempotency[envelope.idempotencyKey] = (canonical, result)
            issuedReceipts.append(result)
        }
        // Shipped statuses: 201 committed or merged, 200 replayed, 409 conflict, 422 rejected.
        return json(result.outcome.didCommit ? 201 : (result.outcome == .conflict ? 409 : 422), result)
    }

    private func receipt(
        _ e: CommandEnvelope, outcome: CommandOutcome, summary: String, affected: [AffectedEntity] = [], facts: [String: JSONValue] = [:],
        undo: Bool = true, effects: CommandReceipt.Effects = .init(), compensates: String? = nil, error: (String, String)? = nil
    ) -> CommandReceipt {
        counter += 1
        let now = clock()
        return CommandReceipt(
            commandId: "cmd_fixture\(counter)", idempotencyKey: e.idempotencyKey, commandType: e.command.type, outcome: outcome, affected: affected,
            summary: summary, facts: facts, effects: effects, undo: .init(available: outcome.didCommit && undo, reason: outcome.didCommit && undo ? nil : "Nothing to undo"),
            compensatesCommandId: compensates, occurredAt: e.command["occurredAt"]?.stringValue.flatMap(Instant.parse) ?? now, recordedAt: now,
            error: error.map { .init(code: $0.0, message: $0.1) }
        )
    }

    private func reject(_ e: CommandEnvelope, _ code: String, _ message: String) -> CommandReceipt {
        receipt(e, outcome: .rejected, summary: "Nothing changed.", undo: false, error: (code, message))
    }

    private func ids(_ v: JSONValue?) -> [String] { v?.arrayValue?.compactMap { $0["garmentId"]?.stringValue ?? $0.stringValue } ?? [] }

    private func mutate(_ id: String, _ change: (inout WardrobeItem) -> Void) {
        guard let i = wardrobe.items.firstIndex(where: { $0.garment.garmentId == id }) else { return }
        change(&wardrobe.items[i])
        wardrobe.items[i].garment.version += 1
        wardrobe.items[i].stock.version += 1
        details[id]?.item = wardrobe.items[i]
        wardrobe.counts = WardrobeCounts(
            owned: wardrobe.items.filter { $0.garment.acquisition == .owned }.count, available: wardrobe.items.filter(\.availability.available).count,
            incoming: wardrobe.items.filter { $0.garment.acquisition == .incoming }.count, retired: wardrobe.items.filter { $0.garment.acquisition == .disposed }.count
        )
    }

    private func setAvailability(_ item: inout WardrobeItem, _ label: String, _ available: Bool) {
        item.availability = AvailabilitySummary(label: label, available: available, reasons: [])
    }

    private func apply(_ e: CommandEnvelope) -> CommandReceipt {
        let c = e.command
        let garmentId = c["garmentId"]?.stringValue
        if let garmentId, item(garmentId) == nil { return reject(e, "not_found", "No such garment") }
        let aff: (String) -> [AffectedEntity] = { [AffectedEntity(entityType: "garment", entityId: $0, version: (self.item($0)?.garment.version ?? 1) + 1, change: "updated")] }
        switch c.type {
        case "record_wear":
            let date = c["wearingDate"]?.stringValue.flatMap(LocalDate.init) ?? LocalDate(date: clock(), timeZone: TimeZone(identifier: "Europe/London")!)
            let garments = ids(c["items"])
            let footwear = garments.filter { g in item(g)?.garment.roles.contains(.footwear) ?? false }
            if footwear.count > 1 { return reject(e, "validation_failed", "A wear can include only one pair of shoes") }
            var merged = false
            for g in garments {
                if let i = today.recordedWears.firstIndex(where: { $0.garmentId == g && $0.wearingDate == date }) {
                    today.recordedWears[i].observationCount += 1
                    merged = true
                } else if date == today.date {
                    today.recordedWears.append(DailyWear(garmentId: g, wearingDate: date, timezone: today.timezone, firstOccurredAt: clock(), observationCount: 1, sources: [e.source], segments: [], status: "active", revision: 1))
                }
            }
            return receipt(
                e, outcome: merged ? .merged : .committed, summary: "Recorded \(date.rawValue): counted \(garments.map(name).joined(separator: ", ")).",
                affected: garments.map { AffectedEntity(entityType: "daily_wear", entityId: "\($0)|\(date.rawValue)", version: 1, change: "created") },
                facts: ["counted": .array(garments.map { .string($0) }), "wearingDate": .string(date.rawValue)],
                effects: .init(state: "none", items: [CommandEffect(effectId: "eff_fixture\(counter)", kind: "board_revalidation", external: false, status: "pending", operationKey: "revalidate")])
            )
        case "select_option":
            guard let board = today.board, board.boardId == c["boardId"]?.stringValue else { return reject(e, "not_found", "No such board") }
            guard let option = board.options.first(where: { $0.optionId == c["optionId"]?.stringValue }) else {
                return receipt(e, outcome: .conflict, summary: "Nothing changed.", undo: false, error: ("conflict", "That option is not part of the current board revision; the board changed since it was shown"))
            }
            let shoe = c["footwearGarmentId"]?.stringValue
            if option.hasFootwearAlternatives && shoe == nil {
                return reject(e, "validation_failed", "This option offers two footwear alternatives; choose one so the outfit never logs both")
            }
            if let shoe, !option.footwearSlots.contains(where: { $0.garmentId == shoe }) { return reject(e, "validation_failed", "The chosen footwear is not part of this option") }
            let previous = today.selection
            counter += 1
            today.selection = Selection(
                selectionId: "sel_fixture\(counter)", boardId: board.boardId, optionId: option.optionId, boardRevision: board.currentRevision,
                footwearGarmentId: shoe ?? option.footwearSlots.first?.garmentId, selectedForDate: board.boardDate, status: "active", createdAt: clock(), version: 1
            )
            let names = option.slots.filter { $0.role != .footwear || shoe == nil || $0.garmentId == shoe }.map { name($0.garmentId) }
            return receipt(
                e, outcome: .committed, summary: "Chosen for \(board.boardDate.rawValue): \(names.joined(separator: ", ")). This is a plan, not a recorded wear.",
                affected: [AffectedEntity(entityType: "selection", entityId: today.selection!.selectionId, version: 1, change: "created")],
                facts: ["selectionId": .string(today.selection!.selectionId), "previousSelectionId": previous.map { .string($0.selectionId) } ?? .null, "optionId": .string(option.optionId)],
                effects: .init(state: "projection_pending", items: [CommandEffect(effectId: "eff_fixture\(counter)", kind: "calendar_projection", external: true, status: "pending", operationKey: "calendar:\(board.boardId)")])
            )
        case "undo":
            guard let targetId = c["targetCommandId"]?.stringValue, let i = issuedReceipts.firstIndex(where: { $0.commandId == targetId }) else {
                return reject(e, "not_found", "No such receipt")
            }
            let target = issuedReceipts[i]
            if target.undoneByCommandId != nil { return reject(e, "invalid_state", "That change was already undone") }
            switch target.commandType {
            case "record_wear":
                let counted = Set(target.facts["counted"]?.arrayValue?.compactMap(\.stringValue) ?? [])
                today.recordedWears.removeAll { counted.contains($0.garmentId) }
            case "select_option":
                today.selection = nil
            case "save_combination", "plan_outfit":
                if let id = target.facts["combinationId"]?.stringValue { combinations[id] = nil }
            case "remove_combination":
                if let id = target.facts["combinationId"]?.stringValue, var combo = combinations[id]?.objectValue {
                    combo["status"] = "active"
                    combinations[id] = .object(combo)
                }
            default: break
            }
            let r = receipt(e, outcome: .committed, summary: "Undid: \(target.summary)", undo: false, compensates: targetId)
            issuedReceipts[i].undoneByCommandId = r.commandId
            return r
        case "mark_in_wash":
            let id = garmentId!
            mutate(id) { i in i.stock.buckets["clean"] = max(0, i.stock.clean - 1); i.stock.buckets["hamper", default: 0] += 1; if i.stock.clean == 0 { self.setAvailability(&i, "In the hamper", false) } }
            if !laundry.service.hamper.contains(where: { $0.garmentId == id }) {
                laundry.service.hamper.append(LaundryLine(garmentId: id, name: name(id), quantity: 1, tracking: item(id)?.garment.tracking ?? .unit))
            }
            return receipt(e, outcome: .committed, summary: "In the wash: \(name(id)).", affected: aff(id), facts: ["garmentId": .string(id)])
        case "back_from_tailor":
            let id = garmentId!
            guard item(id)?.garment.location == .tailor else { return reject(e, "invalid_state", "\(name(id)) is not at the tailor") }
            mutate(id) { i in i.garment.location = .home; i.garment.locationDetail = nil; i.stock.buckets["away"] = 0; i.stock.buckets["clean", default: 0] += 1; self.setAvailability(&i, "Available", true) }
            return receipt(e, outcome: .committed, summary: "Back from the tailor: \(name(id)).", affected: aff(id), facts: ["garmentId": .string(id)])
        case "mark_arrived":
            let id = garmentId!
            guard item(id)?.garment.acquisition == .incoming else { return reject(e, "invalid_state", "\(name(id)) is not incoming") }
            let q = c["quantity"]?.intValue ?? 1
            mutate(id) { i in i.garment.acquisition = .owned; i.stock.buckets["clean", default: 0] += q; i.stock.totalOwned += q; self.setAvailability(&i, "Available", true) }
            return receipt(e, outcome: .committed, summary: "Arrived: \(name(id)).", affected: aff(id), facts: ["garmentId": .string(id)])
        case "put_into_storage":
            let id = garmentId!
            mutate(id) { i in let n = i.stock.clean; i.garment.location = .storage; i.stock.buckets["clean"] = 0; i.stock.buckets["storage", default: 0] += n; self.setAvailability(&i, "In storage", false) }
            return receipt(e, outcome: .committed, summary: "Put into storage: \(name(id)).", affected: aff(id), facts: ["garmentId": .string(id)])
        case "take_out_of_storage":
            let id = garmentId!
            mutate(id) { i in let n = i.stock.units("storage"); i.garment.location = .home; i.stock.buckets["storage"] = 0; i.stock.buckets["clean", default: 0] += n; self.setAvailability(&i, "Available", true) }
            return receipt(e, outcome: .committed, summary: "Out of storage: \(name(id)).", affected: aff(id), facts: ["garmentId": .string(id)])
        case "reconcile_quantity":
            let id = garmentId!
            mutate(id) { i in
                if let t = c["totalOwned"]?.intValue { i.stock.totalOwned = t }
                if let clean = c["clean"]?.intValue { i.stock.buckets["clean"] = min(clean, i.stock.totalOwned) }
            }
            return receipt(e, outcome: .committed, summary: "Corrected the count for \(name(id)).", affected: aff(id), facts: ["garmentId": .string(id)])
        case "laundry_collected":
            guard !laundry.service.hamper.isEmpty else { return reject(e, "invalid_state", "The service hamper is empty") }
            counter += 1
            let batchJSON: JSONValue = [
                "batchId": .string("lb_fixture\(counter)"), "channel": "service", "status": "collected", "collectedAt": .string(Instant.format(clock())),
                "returnedAt": .null, "version": 1,
                "items": .array(laundry.service.hamper.map { ["garmentId": .string($0.garmentId), "lotId": .string("lot_\($0.garmentId)"), "quantity": .number(Double($0.quantity)), "returnedQuantity": 0, "status": "away"] }),
                "names": .object(Dictionary(laundry.service.hamper.map { ($0.garmentId, JSONValue.string($0.name)) }, uniquingKeysWith: { a, _ in a })),
            ]
            if let batch = try? batchJSON.decode(LaundryBatch.self) { laundry.service.batches.insert(batch, at: 0) }
            let names = laundry.service.hamper.map(\.name)
            laundry.service.hamper = []
            return receipt(e, outcome: .committed, summary: "Collected: \(names.joined(separator: ", ")).", facts: ["batchId": .string("lb_fixture\(counter)")])
        case "laundry_returned", "laundry_partial_return":
            let batchId = c["batchId"]?.stringValue
            guard let bi = laundry.service.batches.firstIndex(where: { batchId == nil ? $0.isOpen : $0.batchId == batchId }) else { return reject(e, "not_found", "No open batch") }
            var exceptions: [String: Int] = [:]
            for x in c["exceptions"]?.arrayValue ?? [] { if let g = x["garmentId"]?.stringValue { exceptions[g] = x["quantity"]?.intValue ?? 1 } }
            for i in laundry.service.batches[bi].items.indices {
                let line = laundry.service.batches[bi].items[i]
                let away = min(line.quantity, exceptions[line.garmentId] ?? 0)
                laundry.service.batches[bi].items[i].returnedQuantity = line.quantity - away
                laundry.service.batches[bi].items[i].status = away > 0 ? "away" : "returned"
            }
            let still = laundry.service.batches[bi].awayItems.count
            laundry.service.batches[bi].status = still > 0 ? "partially_returned" : "returned"
            let names = laundry.service.batches[bi].names
            let away = exceptions.keys.map { names[$0] ?? name($0) }
            return receipt(e, outcome: .committed, summary: still > 0 ? "Returned, except \(away.sorted().joined(separator: ", "))." : "The laundry came back.", facts: ["batchId": .string(laundry.service.batches[bi].batchId)])
        case "socks_washed":
            let only = c["garmentIds"]?.arrayValue?.compactMap(\.stringValue)
            let washed = laundry.handWash.hamper.filter { only?.contains($0.garmentId) ?? true }
            laundry.handWash.hamper.removeAll { only?.contains($0.garmentId) ?? true }
            return receipt(e, outcome: .committed, summary: washed.isEmpty ? "No socks were waiting." : "Socks washed: \(washed.map { "\($0.name) ×\($0.quantity)" }.joined(separator: ", ")).", facts: ["garmentIds": .array(washed.map { .string($0.garmentId) })])
        case "edit_style_profile":
            let base = c["baseVersion"]?.intValue ?? 0
            guard base == style.document.version else {
                return receipt(e, outcome: .conflict, summary: "Nothing changed.", undo: false, error: ("conflict", "The profile changed since version \(base); it is now version \(style.document.version)"))
            }
            let body = c["body"]?.stringValue ?? ""
            style.document.version += 1
            style.document.body = body
            style.document.contentSha256 = SHA256.hex(body)
            style.document.byteLength = body.utf8.count
            style.document.source = "owner_edit"
            return receipt(e, outcome: .committed, summary: "Saved My style as version \(style.document.version).", affected: [AffectedEntity(entityType: "style_document", entityId: style.document.documentId, version: style.document.version, change: "updated")])
        case "save_combination", "plan_outfit":
            let slots = c["slots"]?.arrayValue ?? []
            guard !slots.isEmpty, slots.count <= 12 else { return reject(e, "validation_failed", "A combination has 1 to 12 pieces") }
            let ids = slots.compactMap { $0["garmentId"]?.stringValue }
            if let missing = ids.first(where: { item($0) == nil }) { return reject(e, "not_found", "No such garment \(missing)") }
            let isPlan = c.type == "plan_outfit"
            if isPlan {
                // The server validates a plan for its day first (studio.validate, full verdict).
                let v = validate(slots.compactMap { try? $0.decode(StudioSlot.self) }, mode: "today")
                guard v.valid else { return reject(e, "plan_invalid_for_day", v.issues.map(\.message).joined(separator: "; ")) }
                for (k, v) in combinations where v["kind"]?.stringValue == "plan" && v["plannedForDate"] == c["date"] && v["status"]?.stringValue == "active" {
                    var o = v.objectValue ?? [:]; o["status"] = "superseded"; combinations[k] = .object(o)
                }
            }
            counter += 1
            let id = "cmb_fixture\(counter)"
            combinations[id] = ["combinationId": .string(id), "kind": .string(isPlan ? "plan" : "saved"), "name": c["name"] ?? .null, "slots": .array(slots), "plannedForDate": c["date"] ?? .null, "status": "active"]
            let names = ids.map(name).joined(separator: ", ")
            return receipt(
                e, outcome: .committed, summary: isPlan ? "Planned for \(c["date"]?.stringValue ?? ""): \(names). This is a plan, not a recorded wear." : "Saved combination: \(names). Nothing was planned or recorded.",
                facts: ["combinationId": .string(id)]
            )
        case "remove_combination":
            guard let id = c["combinationId"]?.stringValue, var combo = combinations[id]?.objectValue, combo["status"]?.stringValue == "active" else { return reject(e, "not_found", "No such saved combination") }
            combo["status"] = "removed"
            combinations[id] = .object(combo)
            return receipt(e, outcome: .committed, summary: "Removed the saved combination.", facts: ["combinationId": .string(id)])
        case "update_delivery_settings":
            let fields = ["deliveryTime", "dailyOptionCount", "calendarId", "homeLocationLabel"]
            guard fields.contains(where: { c.fields[$0] != nil }) else { return reject(e, "validation_failed", "Provide at least one setting to change") }
            if let t = c["deliveryTime"]?.stringValue { settings.deliveryTime = t }
            if let n = c["dailyOptionCount"]?.intValue { guard (3...5).contains(n) else { return reject(e, "validation_failed", "3 to 5 outfits") }; settings.dailyOptionCount = n }
            if let cal = c.fields["calendarId"] { settings.calendarId = cal.stringValue }
            if let l = c["homeLocationLabel"]?.stringValue { settings.homeLocationLabel = l }
            settings.version += 1
            return receipt(e, outcome: .committed, summary: "Delivery settings saved: board by \(settings.deliveryTime), \(settings.dailyOptionCount) outfits.", affected: [AffectedEntity(entityType: "owner_settings", entityId: "settings", version: settings.version, change: "updated")])
        default:
            return receipt(e, outcome: .committed, summary: "Done: \(c.type.replacingOccurrences(of: "_", with: " ")).", affected: garmentId.map(aff) ?? [])
        }
    }

    // MARK: Conversation

    private func turn(_ body: Data) throws -> HTTPResponse {
        let req = try GarderobeJSON.decoder().decode(TurnRequest.self, from: body)
        if var existing = turns[req.clientTurnId] {
            existing.status = "existing"
            return json(200, existing)
        }
        guard req.isSendable else { return apiError(422, "validation_failed", "A turn needs text or an attachment (at most 10)") }
        if req.stopCurrent == true {
            // "Stop and send": the reply in progress stops; committed effects stay committed.
            // A run is still in progress until its assistant message settles (the stream reached run_finished).
            for id in runs.keys where !messages.contains(where: { $0.messageId == "msg_\(id)" }) && !cancelledRuns.contains(id) {
                cancelledRuns.insert(id)
                pendingActions[id]?.status = "cancelled"
            }
        }
        counter += 1
        let runId = "run_fixture\(counter)"
        // Pasted secrets are removed before anything is stored (backend/src/assistant/secrets.ts).
        let (text, redacted) = Self.redactPastedSecrets(req.text)
        var parts: [MessagePart] = [.text(text)]
        parts += req.references.map { .reference($0) }
        parts += req.attachmentIds.map { .attachment(uploadId: $0, contentType: "image/jpeg", thumbnailUrl: nil) }
        messages.append(ConversationMessage(messageId: "msg_user_\(counter)", clientTurnId: req.clientTurnId, role: "user", createdAt: clock(), parts: parts))
        let notice = redacted.isEmpty ? nil : Self.redactionNotice(redacted)
        if let notice { redactionNotices[runId] = (notice, "msg_user_\(counter)") }
        let response = TurnResponse(clientTurnId: req.clientTurnId, messageId: "msg_user_\(counter)", runId: runId, status: "accepted", notice: notice)
        turns[req.clientTurnId] = response
        if let op = ["[export]": "export_data", "[import]": "import_data", "[recovery]": "issue_recovery_kit"].first(where: { req.text.contains($0.key) })?.value {
            // DEMO hook: an assistant's account request waiting for the owner's confirmation.
            makeAccountRequest(runId: runId, operation: op, clientTurnId: req.clientTurnId)
            return json(202, response)
        }
        if req.text.contains("[ask]") {
            // DEMO hook: a run that needs the owner's answer (native question / MCP input_required).
            let pending = PendingAction(
                pendingActionId: "pa_fixture\(counter)", prompt: "Which shoes did you mean?",
                choices: [.init(id: "grey", label: "NB 990v4 — grey"), .init(id: "olive", label: "NB 990v4 — olive/cream")],
                status: "pending", expiresAt: clock().addingTimeInterval(600), commandType: "select_option", idempotencyKey: "pending:\(counter)"
            )
            pendingActions[runId] = pending
            runs[runId] = [
                block(runId: runId, id: 1, type: "run_started", data: ["messageId": .string("msg_\(runId)"), "clientTurnId": .string(req.clientTurnId)]),
                block(runId: runId, id: 2, type: "needs_input", data: ["prompt": .string(pending.prompt), "choices": try JSONValue.encode(pending.choices), "pendingActionId": .string(pending.pendingActionId)]),
            ]
            return json(202, response)
        }
        runs[runId] = sseTemplate
            .replacingOccurrences(of: "run_demo0001", with: runId)
            .replacingOccurrences(of: "msg_run1", with: "msg_\(runId)")
            .replacingOccurrences(of: "turn_fixture01", with: req.clientTurnId)
            .components(separatedBy: "\n\n")
            .filter { $0.contains("data:") }
            .map { block in
                block.split(separator: "\n").filter { !$0.hasPrefix(":") }.joined(separator: "\n") + "\n\n"
            }
        return json(202, response)
    }

    /// POST /v1/recall/search over the whole fixture transcript (older page included): dated quotes with
    /// neighbouring context, newest first. A plain substring match stands in for the hybrid index.
    private func recall(_ body: Data) -> HTTPResponse {
        guard let req = try? GarderobeJSON.decoder().decode(RecallSearchRequest.self, from: body),
              !req.query.isEmpty, req.query.count <= RecallSearchRequest.maxQueryLength, (1...50).contains(req.limit ?? 10) else {
            return apiError(422, "validation_failed", "A recall query needs 1-500 characters and a limit of 1-50")
        }
        let tz = TimeZone(identifier: "Europe/London")!
        let all = (olderPage.messages + messages).sorted { $0.createdAt < $1.createdAt }
        var hits: [RecallSearchResponse.Hit] = []
        for (i, m) in all.enumerated() where m.plainText.localizedCaseInsensitiveContains(req.query) {
            let day = LocalDate(date: m.createdAt, timeZone: tz)
            if let from = req.from, day < from { continue }
            if let to = req.to, day > to { continue }
            hits.append(.init(
                messageId: m.messageId, authoredAt: m.createdAt, localDate: day, speaker: m.role == "user" ? "owner" : "assistant",
                quote: String(m.plainText.prefix(280)),
                context: .init(before: i > 0 ? String(all[i - 1].plainText.prefix(160)) : nil, after: i + 1 < all.count ? String(all[i + 1].plainText.prefix(160)) : nil),
                link: "garderobe://conversation/\(m.messageId)", score: 1
            ))
        }
        hits = Array(hits.reversed().prefix(req.limit ?? 10))
        let n = Double(all.count)
        return json(200, RecallSearchResponse(
            query: req.query, hits: hits,
            coverage: .init(sourceSeq: n, indexedSeq: n, exhaustive: true, supplementedFromSource: 0, index: "fixture"),
            notes: hits.isEmpty ? ["Nothing in the conversation matches."] : []
        ))
    }

    // MARK: Account operations requested by an assistant (backend/src/api/portability.ts, mcp/pending.ts)

    public func setImportTargetEmpty(_ value: Bool) { importTargetEmpty = value }

    /// What `garderobe_command { operation }` does before the owner confirms: a run waiting on a question.
    /// Returns the run id the assistant would show as `<origin>/confirm/{runId}`.
    @discardableResult
    public func requestAccountOperation(_ operation: String) -> String {
        counter += 1
        let runId = "run_mcp\(counter)"
        makeAccountRequest(runId: runId, operation: operation, clientTurnId: nil)
        return runId
    }

    private func makeAccountRequest(runId: String, operation: String, clientTurnId: String?) {
        let prompt = switch operation {
        case "export_data": "Confirm: export all your Garderobe records? You get a private link that opens only for you, for 15 minutes."
        case "import_data": "Confirm: import the staged export into this Garderobe? Connected assistants in it arrive revoked."
        default: "Confirm: prepare a new recovery code? It replaces your current code once you collect it."
        }
        let pending = PendingAction(
            pendingActionId: "pa_account\(counter)", prompt: prompt,
            choices: [.init(id: "confirm", label: "Yes, do it"), .init(id: "decline", label: "No")],
            status: "pending", expiresAt: clock().addingTimeInterval(600), commandType: operation, idempotencyKey: "mcp:\(operation):\(counter)"
        )
        pendingActions[runId] = pending
        var start: JSONValue = ["messageId": .string("msg_\(runId)")]
        if let clientTurnId, case .object(var o) = start { o["clientTurnId"] = .string(clientTurnId); start = .object(o) }
        runs[runId] = [
            block(runId: runId, id: 1, type: "run_started", data: start),
            block(runId: runId, id: 2, type: "needs_input", data: ["prompt": .string(prompt), "choices": (try? JSONValue.encode(pending.choices)) ?? .array([]), "pendingActionId": .string(pending.pendingActionId)]),
        ]
    }

    private static func linkToken() -> String { UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }

    private func record(_ kind: String, _ id: String, status: String, expiresAt: Date, completedAt: Date? = nil, summary: JSONValue) {
        accountTransfers.transfers.insert(.init(transferId: id, kind: kind, status: status, surface: "mcp", createdAt: clock(), expiresAt: expiresAt, completedAt: completedAt, summary: summary), at: 0)
    }

    private func audit(_ action: String, _ outcome: String, surface: String, detail: JSONValue) {
        counter += 1
        accountTransfers.audit.insert(.init(auditId: "aud_fixture\(counter)", action: action, surface: surface, outcome: outcome, detail: detail, createdAt: clock()), at: 0)
    }

    /// The confirmed operation's result, with the owner-bound link `withDeliveryLinks` adds.
    private func performAccountOperation(_ operation: String, key: String?) -> AccountOperationReceipt {
        counter += 1
        let expires = clock().addingTimeInterval(15 * 60)
        let tables = [TableCount(name: "garments", rows: wardrobe.items.count), TableCount(name: "daily_wears", rows: 9), TableCount(name: "command_receipts", rows: issuedReceipts.count + 12)]
        let result: JSONValue
        switch operation {
        case "export_data":
            let id = "xfr_export\(counter)", token = Self.linkToken()
            exportLinks[id] = (token, expires, "exp_fixture\(counter)")
            let r = ExportDownloadResult(
                exportId: "exp_fixture\(counter)", transferId: id, exportedAt: clock(), expiresAt: expires,
                downloadUrl: "\(origin)/v1/export/downloads/\(id)?t=\(token)", packageSha256: String(repeating: "ab", count: 32),
                complete: true, tables: tables, summary: "DEMO FIXTURE: your records, checksummed and credential-free."
            )
            record("export_download", id, status: "ready", expiresAt: expires, summary: ["exportId": .string(r.exportId)])
            audit("export", "link_issued", surface: "mcp", detail: ["transferId": .string(id)])
            result = (try? JSONValue.encode(r)) ?? .null
        case "import_data":
            let id = "imp_fixture\(counter)"
            let r = McpImportResult(
                packageId: id, exportId: "exp_source01", tables: tables,
                importedAssistantGrants: .init(count: 2, status: "revoked"),
                callingGrant: .init(grantId: nil, status: "active", note: "The assistant that asked keeps working with the access you gave it."),
                summary: "DEMO FIXTURE: the staged export was imported."
            )
            record("import_package", id, status: "imported", expiresAt: expires, completedAt: clock(), summary: ["exportId": "exp_source01"])
            audit("import", "imported", surface: "mcp", detail: ["packageId": .string(id)])
            result = (try? JSONValue.encode(r)) ?? .null
        default:
            let id = "xfr_recovery\(counter)", token = Self.linkToken()
            recoveryLinks[id] = (token, expires, false)
            recovery.pendingCollection = .init(transferId: id, expiresAt: expires)
            let r = RecoveryKitLink(transferId: id, expiresAt: expires, collectUrl: "\(origin)/v1/auth/recovery-kit/collect/\(id)?t=\(token)", summary: "Open the link in Garderobe to collect your new recovery code.")
            record("recovery_kit_link", id, status: "pending", expiresAt: expires, summary: [:])
            audit("recovery_kit", "link_issued", surface: "mcp", detail: ["transferId": .string(id)])
            result = (try? JSONValue.encode(r)) ?? .null
        }
        return AccountOperationReceipt(operation: operation, idempotencyKey: key, replayed: false, result: result)
    }

    private func setTransferStatus(_ id: String, _ status: String) {
        if let i = accountTransfers.transfers.firstIndex(where: { $0.transferId == id }) {
            accountTransfers.transfers[i].status = status
            accountTransfers.transfers[i].completedAt = clock()
        }
    }

    /// GET /v1/export/downloads/{id}?t=: the matching token, before expiry, for the signed-in owner.
    private func exportDownload(_ id: String, token: String?) -> HTTPResponse {
        guard let link = exportLinks[id], let token, token == link.token else { return apiError(403, "invalid_link", "This link is not valid for your account") }
        guard link.expiresAt > clock() else { return apiError(410, "link_expired", "This export link has expired; request a new export") }
        exportDownloads += 1
        setTransferStatus(id, "downloaded")
        audit("export", "downloaded", surface: "app", detail: ["transferId": .string(id)])
        let package: JSONValue = ["manifest": ["format": "garderobe-export/1", "exportId": .string(link.exportId), "label": "DEMO FIXTURE"], "files": [:]]
        return HTTPResponse(status: 200, headers: ["Content-Type": "application/json; charset=utf-8", "Content-Disposition": "attachment; filename=\"garderobe-export-\(link.exportId).json\"", "Cache-Control": "no-store"], body: (try? GarderobeJSON.encoder().encode(package)) ?? Data())
    }

    /// POST /v1/auth/recovery-kit/collect/{id}?t=: once, same-origin, before expiry; the code exists only in this response.
    private func collectRecovery(_ id: String, token: String?, request: HTTPRequest) -> HTTPResponse {
        if let origin = request.headers["Origin"], origin != self.origin { return apiError(403, "forbidden_origin", "Collect the recovery code from Garderobe itself") }
        guard let link = recoveryLinks[id], let token, token == link.token else { return apiError(403, "invalid_link", "This link is not valid for your account") }
        guard !link.collected else { return apiError(410, "already_collected", "This recovery code was already collected; the link works once") }
        guard link.expiresAt > clock() else { return apiError(410, "link_expired", "This recovery link has expired or was replaced by a newer one") }
        recoveryLinks[id]?.collected = true
        counter += 1
        let code = "DEMO-\(Self.linkToken().prefix(16).uppercased())"
        issuedRecoveryCodes.append(code)
        recovery = RecoveryStatus(hasActiveKit: true, activeKitIssuedAt: clock(), lastRecoveredAt: recovery.lastRecoveredAt, failedAttemptsLast24h: recovery.failedAttemptsLast24h, pendingCollection: nil)
        setTransferStatus(id, "collected")
        audit("recovery_kit", "collected", surface: "app", detail: ["transferId": .string(id)])
        return json(201, ["schemaVersion": .string(ContractsVersion.current), "credential": .string(code), "credentialId": .string("rcv_fixture\(counter)"), "instructions": "DEMO FIXTURE: keep this code somewhere safe; it is shown once.", "issuedAt": .string(Instant.format(clock()))] as JSONValue)
    }

    /// POST /v1/runs/{id}/input, as backend/src/mcp/pending.ts resolves it: a choice executes once (a
    /// repeat replays the same receipt as `executed`), a null choice declines and ends the run, and an
    /// expired question executes nothing.
    private func answer(runId: String, body: Data) -> HTTPResponse {
        guard var pending = pendingActions[runId] else { return notFound("/v1/runs/\(runId)/input") }
        guard let request = try? GarderobeJSON.decoder().decode(RunInputRequest.self, from: body) else { return apiError(422, "validation_failed", "Send { choiceId } or null to decline") }
        func reply(_ status: RunInputResponse.Status, _ r: CommandReceipt?) -> HTTPResponse {
            json(200, RunInputResponse(status: status, receipt: r, run: runStatus(runId)))
        }
        func end(_ status: String) {
            let n = runs[runId]?.count ?? 0
            runs[runId, default: []] += [block(runId: runId, id: n + 1, type: "run_finished", data: ["messageId": .string("msg_\(runId)"), "status": .string(status), "message": .null])]
        }
        switch pending.status {
        case "resolved":
            // A repeated answer replays the original result (and link), never a second operation.
            if var op = answeredOperations[runId] {
                op.replayed = true
                return json(200, RunInputResponse(status: .executed, receipt: nil, operation: op, run: runStatus(runId)))
            }
            return reply(.executed, answeredReceipts[runId])
        case "cancelled": return reply(.declined, nil)
        case "expired": return reply(.expired, nil)
        default: break
        }
        if let expires = pending.expiresAt, expires <= clock() {
            pending.status = "expired"
            pendingActions[runId] = pending
            cancelledRuns.insert(runId)
            end("cancelled")
            return reply(.expired, nil)
        }
        guard let choiceId = request.choiceId, choiceId != "decline" else {
            pending.status = "cancelled"
            pendingActions[runId] = pending
            cancelledRuns.insert(runId)
            end("cancelled")
            return reply(.declined, nil)
        }
        guard let choice = pending.choices.first(where: { $0.id == choiceId }) else { return apiError(422, "invalid_choice", "That is not one of the offered choices") }
        if let op = pending.commandType, Self.accountOperations.contains(op) {
            if op == "import_data" && !importTargetEmpty {
                // importExport refuses an owner that already has records (409); nothing is imported.
                pending.status = "cancelled"
                pendingActions[runId] = pending
                cancelledRuns.insert(runId)
                end("failed")
                return apiError(409, "owner_not_empty", "This Garderobe already has records; an import needs an empty one")
            }
            pending.status = "resolved"
            pendingActions[runId] = pending
            let receipt = performAccountOperation(op, key: pending.idempotencyKey)
            answeredOperations[runId] = receipt
            end("finished")
            return json(200, RunInputResponse(status: .executed, receipt: nil, operation: receipt, run: runStatus(runId)))
        }
        pending.status = "resolved"
        pendingActions[runId] = pending
        let envelope = CommandEnvelope(idempotencyKey: pending.idempotencyKey ?? "pending:\(runId)", source: .conversation, command: DomainCommand(type: pending.commandType ?? "select_option"))
        let r = receipt(envelope, outcome: .committed, summary: "Chosen: \(choice.label). This is a plan, not a recorded wear.")
        issuedReceipts.append(r)
        answeredReceipts[runId] = r
        let n = runs[runId]?.count ?? 0
        runs[runId, default: []] += [
            block(runId: runId, id: n + 1, type: "text_delta", data: ["messageId": .string("msg_\(runId)"), "delta": .string("Noted: \(choice.label).")]),
            block(runId: runId, id: n + 2, type: "command_receipt", data: ["receipt": (try? JSONValue.encode(r)) ?? .null]),
            block(runId: runId, id: n + 3, type: "run_finished", data: ["messageId": .string("msg_\(runId)"), "status": "finished", "message": .null]),
        ]
        return reply(.executed, r)
    }

    private func block(runId: String, id: Int, type: String, data: JSONValue) -> String {
        let ev: JSONValue = ["eventId": .string(String(id)), "runId": .string(runId), "type": .string(type), "at": .string(Instant.format(clock())), "data": data]
        return "id: \(id)\nevent: \(type)\ndata: \(String(decoding: (try? GarderobeJSON.encoder().encode(ev)) ?? Data(), as: UTF8.self))\n\n"
    }

    private func snapshotBlock(runId: String, id: Int, finished: Bool) -> String {
        let message = messages.last { $0.messageId == "msg_\(runId)" } ?? assembled(runId: runId)
        return block(runId: runId, id: id, type: "snapshot", data: ["message": (try? JSONValue.encode(message)) ?? .null, "status": .string(cancelledRuns.contains(runId) ? "cancelled" : finished ? "finished" : "running")])
    }

    private func finishedBlock(runId: String, id: Int, status: String) -> String {
        let ev: JSONValue = ["eventId": .string(String(id)), "runId": .string(runId), "type": "run_finished", "at": .string(Instant.format(clock())), "data": ["messageId": .string("msg_\(runId)"), "status": .string(status), "message": .null]]
        let data = String(decoding: (try? GarderobeJSON.encoder().encode(ev)) ?? Data(), as: UTF8.self)
        return "id: \(id)\nevent: run_finished\ndata: \(data)\n\n"
    }

    /// After a run finishes, the settled assistant message is part of the canonical transcript.
    private func settle(runId: String) {
        let id = "msg_\(runId)"
        guard !messages.contains(where: { $0.messageId == id }) else { return }
        messages.append(assembled(runId: runId))
        // The backend settles the same note as a `notice` result card after the reply. Like the backend
        // (backend/src/assistant/agent.ts), the card names its turn as `message:<owner message id>`.
        if let (n, userMessageId) = redactionNotices.removeValue(forKey: runId) {
            let turnId = "turn_" + String(runId.drop { $0 != "_" }.dropFirst())
            messages.append(ConversationMessage(messageId: "delivery_redaction:\(turnId)", role: "assistant", createdAt: clock().addingTimeInterval(1), parts: [.resultCard(ResultCard(kind: "notice", title: n.title, summary: n.summary, jobRef: "message:\(userMessageId)"))]))
        }
    }

    /// The fixture's version of `redactPastedSecrets`: recovery codes (`GRDB.rcv_….…` and the demo's own
    /// `DEMO-…` codes), bearer tokens and provider keys. Other text is left alone.
    static func redactPastedSecrets(_ text: String) -> (String, [TurnNotice.Redaction]) {
        let rules: [(kind: String, pattern: String, placeholder: String)] = [
            ("recovery_code", #"GRDB\.rcv_[A-Za-z0-9]+\.[A-Za-z0-9_-]{8,}"#, "[recovery code removed]"),
            ("recovery_code", #"\bDEMO-[A-Z0-9]{16}\b"#, "[recovery code removed]"),
            ("access_token", #"Bearer\s+[A-Za-z0-9._~+/=-]{20,}"#, "<redacted>"),
            ("api_key", #"\bsk-[A-Za-z0-9_-]{20,}"#, "<redacted>"),
        ]
        var out = text
        var counts: [String: Int] = [:]
        var order: [String] = []
        for rule in rules {
            guard let re = try? NSRegularExpression(pattern: rule.pattern) else { continue }
            let n = re.numberOfMatches(in: out, range: NSRange(out.startIndex..., in: out))
            guard n > 0 else { continue }
            out = re.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: NSRegularExpression.escapedTemplate(for: rule.placeholder))
            if counts[rule.kind] == nil { order.append(rule.kind) }
            counts[rule.kind, default: 0] += n
        }
        return (out, order.map { TurnNotice.Redaction(kind: $0, count: counts[$0]!) })
    }

    /// `redactionNotice` in backend/src/assistant/secrets.ts.
    static func redactionNotice(_ redacted: [TurnNotice.Redaction]) -> TurnNotice {
        let recovery = redacted.contains { $0.kind == "recovery_code" }
        return TurnNotice(
            title: recovery ? "Recovery code removed from your message" : "Secret removed from your message",
            summary: recovery
                ? "Garderobe removed a recovery code from your message before saving it; it was not stored, sent to the assistant or included in exports. If it is your current code, create a new one in Garderobe, since pasted codes should be treated as exposed."
                : "Garderobe removed something that looked like a password, token or key from your message before saving it; it was not stored, sent to the assistant or included in exports.",
            redacted: redacted
        )
    }

    private func assembled(runId: String) -> ConversationMessage {
        var text = ""
        var extra: [MessagePart] = []
        var finished = false
        for block in runs[runId] ?? [] {
            guard let line = block.split(separator: "\n").first(where: { $0.hasPrefix("data: ") }),
                  let ev = try? GarderobeJSON.decoder().decode(RunEvent.self, from: Data(line.dropFirst(6).utf8)) else { continue }
            if ev.type == "text_delta" { text += ev.data["delta"]?.stringValue ?? "" }
            if ev.type == "outfit_board", let card = try? ev.data["card"]?.decode(OutfitCard.self) { extra.append(.outfitCard(card)) }
            if ev.type == "run_finished" { finished = true }
        }
        return ConversationMessage(messageId: "msg_\(runId)", role: "assistant", createdAt: clock(), status: finished ? "complete" : "streaming", parts: [.text(text)] + extra, runId: runId)
    }

    // MARK: Studio, swaps, preview (demo behaviour, clearly not a recommender)

    private func validate(_ slots: [StudioSlot], mode: String) -> StudioValidation {
        var issues: [StudioIssue] = []
        var warnings: [StudioIssue] = []
        for s in slots {
            guard let i = item(s.garmentId) else { issues.append(.init(code: "unknown_item", message: "Not in the wardrobe", garmentId: s.garmentId, strength: "hard")); continue }
            if !i.garment.roles.contains(s.role) { issues.append(.init(code: "wrong_role", message: "\(i.garment.name) can't be worn as that", garmentId: s.garmentId, strength: "hard")) }
            if !i.availability.available {
                let issue = StudioIssue(code: "unavailable", message: "\(i.garment.name): \(i.availability.label)", garmentId: s.garmentId, strength: "hard", dayBound: true)
                if mode == "today" { issues.append(issue) } else { warnings.append(issue) }
            }
        }
        if !slots.contains(where: { $0.role == .socks }) && slots.contains(where: { $0.role == .footwear }) {
            issues.append(.init(code: "socks_always", message: "Socks always: add a pair", garmentId: nil, strength: "hard"))
        }
        let dayIssues = issues + warnings.filter { $0.dayBound == true }
        return StudioValidation(mode: mode, valid: issues.isEmpty, validForDate: dayIssues.isEmpty, issues: issues, warnings: warnings, checkedAt: clock())
    }

    private func suggest(_ req: StudioSuggestRequest) -> StudioSuggestion {
        let lockedIds = Set(req.locked.map(\.garmentId))
        var slots = req.locked
        var changed: [GarmentRole] = []
        for role in req.roles {
            if let pick = wardrobe.items.first(where: { $0.garment.roles.contains(role) && $0.availability.available && !lockedIds.contains($0.garment.garmentId) && $0.garment.planningPolicy == .normal }) {
                slots.append(.init(garmentId: pick.garment.garmentId, role: role))
                changed.append(role)
            }
        }
        return StudioSuggestion(slots: slots, explanation: "DEMO FIXTURE suggestion: the first available piece for each unlocked role.", validation: validate(slots, mode: req.mode), found: !changed.isEmpty, changedRoles: changed)
    }

    private func swaps(optionId: String, role: GarmentRole) -> SwapCandidates {
        let inOption = Set(today.board?.options.first { $0.optionId == optionId }?.slots.map(\.garmentId) ?? [])
        let candidates = wardrobe.items
            .filter { $0.garment.roles.contains(role) && $0.availability.available && $0.garment.planningPolicy == .normal && !inOption.contains($0.garment.garmentId) }
            .prefix(6)
            .map { SwapCandidates.Candidate(garmentId: $0.garment.garmentId, name: $0.garment.name, reason: "DEMO FIXTURE: available and not worn this week") }
        return SwapCandidates(optionId: optionId, role: role, candidates: Array(candidates), validatedAt: clock())
    }

    private func temperaturePreview(_ t: Double) -> TemperaturePreview {
        let roles: [GarmentRole] = [.outerLayer, .baseTop, .midLayer, .bottom]
        let items = wardrobe.items.compactMap { i -> TemperaturePreview.Item? in
            guard i.garment.acquisition == .owned, let role = roles.first(where: { i.garment.roles.contains($0) }) else { return nil }
            let lo = i.garment.minTempC ?? -40, hi = i.garment.maxTempC ?? 50
            guard t >= lo && t <= hi else { return nil }
            return .init(garmentId: i.garment.garmentId, name: i.garment.name, role: role, wearable: true, inStorage: i.garment.location == .storage, note: i.garment.seasonLabel)
        }
        return TemperaturePreview(simulation: true, temperatureC: t, basis: "peak", items: items, note: "Simulation: nothing's availability changes.")
    }
}
