import Foundation

public enum APIError: Error, Sendable, Equatable {
    /// Never reached the server. Safe to retry with the same idempotency key.
    case offline
    /// May have reached the server. Retry with the same idempotency key; the backend replays the receipt.
    case interrupted(String)
    case unauthorized
    /// The server refused the request (4xx) with a structured error; retrying unchanged will not help.
    case rejected(code: String, message: String, status: Int)
    /// Server-side failure (5xx). Retry later.
    case server(status: Int)
    case decoding(String)

    public var isRetryable: Bool {
        switch self {
        case .offline, .interrupted, .server: true
        default: false
        }
    }

    public var userMessage: String {
        switch self {
        case .offline: "No connection"
        case .interrupted: "The connection dropped"
        case .unauthorized: "Sign in again to continue"
        case .rejected(_, let message, _): message
        case .server: "Garderobe is having trouble; it will retry"
        case .decoding: "The server sent something this version of the app cannot read"
        }
    }
}

/// Supplies the bearer token for app authentication (Cloudflare Access session). Returns nil when
/// signed out; the app then shows its cached content and a sign-in control.
public protocol TokenProvider: Sendable {
    func token() async -> String?
}

public struct StaticTokenProvider: TokenProvider {
    let value: String?
    public init(_ value: String?) { self.value = value }
    public func token() async -> String? { value }
}

/// Typed client for the Garderobe HTTP API (spec section 13). Stateless and Sendable.
public struct APIClient: Sendable {
    public let baseURL: URL
    public let transport: any HTTPTransport
    public let tokens: any TokenProvider

    public init(baseURL: URL, transport: any HTTPTransport, tokens: any TokenProvider = StaticTokenProvider(nil)) {
        self.baseURL = baseURL; self.transport = transport; self.tokens = tokens
    }

    // MARK: Core

    func request(_ method: String, _ path: String, query: [String: String] = [:], body: (some Encodable)? = Optional<Int>.none) async throws -> HTTPRequest {
        var headers = ["Accept": "application/json", "X-Garderobe-Contracts": ContractsVersion.current]
        if let token = await tokens.token() { headers["Authorization"] = "Bearer \(token)" }
        var data: Data?
        if let body {
            data = try GarderobeJSON.encoder().encode(body)
            headers["Content-Type"] = "application/json"
        }
        return HTTPRequest(method: method, path: path, query: query, headers: headers, body: data)
    }

    func perform(_ request: HTTPRequest) async throws -> HTTPResponse {
        let response = try await send(request)
        // A 15-minute access token may lapse mid-session: refresh once (rotating) and retry.
        if response.status == 401, request.headers["Authorization"] != nil, let refresher = tokens as? any RefreshingTokenProvider,
           await refresher.refreshAfterUnauthorized(), let token = await tokens.token() {
            var retry = request
            retry.headers["Authorization"] = "Bearer \(token)"
            return try await send(retry)
        }
        return response
    }

    private func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        do {
            return try await transport.send(request)
        } catch TransportError.offline {
            throw APIError.offline
        } catch TransportError.interrupted(let why) {
            throw APIError.interrupted(why)
        } catch let e as APIError {
            throw e
        } catch {
            throw APIError.interrupted(String(describing: error))
        }
    }

    func decode<T: Decodable>(_ type: T.Type, from response: HTTPResponse) throws -> T {
        switch response.status {
        case 200..<300:
            do { return try GarderobeJSON.decoder().decode(T.self, from: response.body) } catch { throw APIError.decoding(String(describing: error)) }
        case 401:
            throw APIError.unauthorized
        case 403 where (try? GarderobeJSON.decoder().decode(ApiError.self, from: response.body))?.error.code != "insufficient_scope":
            throw APIError.unauthorized
        case 400..<500:
            let e = try? GarderobeJSON.decoder().decode(ApiError.self, from: response.body)
            throw APIError.rejected(code: e?.error.code ?? "http_\(response.status)", message: e?.error.message ?? "The request was refused", status: response.status)
        default:
            throw APIError.server(status: response.status)
        }
    }

    func get<T: Decodable>(_ type: T.Type, _ path: String, query: [String: String] = [:]) async throws -> T {
        try decode(T.self, from: try await perform(try await request("GET", path, query: query)))
    }

    func post<T: Decodable>(_ type: T.Type, _ path: String, body: some Encodable) async throws -> T {
        try decode(T.self, from: try await perform(try await request("POST", path, body: body)))
    }

    // MARK: Endpoints (contract)

    public func today() async throws -> TodayResponse {
        var t = try await get(TodayResponse.self, "/v1/today")
        t.garments = t.garments.map { g in var g = g; g.media = g.media?.resolved(against: baseURL); return g }
        return t
    }

    /// GET /v1/auth/session: who the app is signed in as.
    public func session() async throws -> SessionResponse { try await get(SessionResponse.self, "/v1/auth/session") }

    public func wardrobePage(query: WardrobeQuery = WardrobeQuery(), cursor: String? = nil) async throws -> WardrobePage {
        var q = query
        q.cursor = cursor
        var page = try await get(WardrobePage.self, "/v1/wardrobe", query: q.parameters)
        page.items = page.items.map { i in var i = i; i.garment.media = i.garment.media?.resolved(against: baseURL); i.media = i.garment.media; return i }
        return page
    }

    /// Fetches every page so local alias search works over the complete inventory.
    public func completeWardrobe(query: WardrobeQuery = WardrobeQuery()) async throws -> WardrobePage {
        var page = try await wardrobePage(query: query)
        var guardCount = 0
        while !page.complete, let cursor = page.nextCursor, guardCount < 50 {
            let next = try await wardrobePage(query: query, cursor: cursor)
            page.items += next.items
            page.nextCursor = next.nextCursor
            page.complete = next.complete
            page.counts = next.counts
            guardCount += 1
        }
        return page
    }

    public func item(_ garmentId: String) async throws -> ItemDetail {
        var d = try await get(ItemDetail.self, "/v1/items/\(garmentId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? garmentId)")
        d.item.garment.media = d.item.garment.media?.resolved(against: baseURL)
        return d
    }

    public func settings() async throws -> SettingsResponse { try await get(SettingsResponse.self, "/v1/settings") }

    /// POST /v1/commands. A structured receipt is returned for committed, merged, rejected and
    /// conflict outcomes (whatever the HTTP status); other failures throw.
    public func execute(_ envelope: CommandEnvelope) async throws -> CommandReceipt {
        let response = try await perform(try await request("POST", "/v1/commands", body: envelope))
        if let receipt = try? GarderobeJSON.decoder().decode(CommandReceipt.self, from: response.body) { return receipt }
        return try decode(CommandReceipt.self, from: response)
    }

    public func connections() async throws -> ConnectionsResponse { try await get(ConnectionsResponse.self, "/v1/connections") }

    /// POST /v1/connections/{id}/disconnect. `mgr_…` ids revoke a consumer assistant's MCP grant.
    @discardableResult
    public func disconnect(_ connectionId: String) async throws -> DisconnectResponse {
        try await post(DisconnectResponse.self, "/v1/connections/\(connectionId)/disconnect", body: [String: String]())
    }

    public func sendTurn(_ turn: TurnRequest) async throws -> TurnResponse { try await post(TurnResponse.self, "/v1/conversation/turns", body: turn) }

    public func messages(before: String? = nil, around: String? = nil, limit: Int = 40) async throws -> ConversationPage {
        var q = ["limit": String(limit)]
        if let before { q["before"] = before }
        if let around { q["around"] = around }
        return try await get(ConversationPage.self, "/v1/conversation/messages", query: q)
    }

    public func run(_ runId: String) async throws -> RunStatus { try await get(RunStatus.self, "/v1/runs/\(runId)") }

    // MARK: Account: recovery status, transfers, and the owner's private links

    /// GET /v1/auth/recovery-kit: whether a recovery code exists and when it was issued; never the code.
    public func recoveryStatus() async throws -> RecoveryStatus { try await get(RecoveryStatus.self, "/v1/auth/recovery-kit") }

    /// GET /v1/account/transfers: exports, staged imports and recovery links with their audit trail.
    public func accountTransfers() async throws -> AccountTransfers { try await get(AccountTransfers.self, "/v1/account/transfers") }

    /// POST /v1/auth/recovery-kit: a new one-time recovery code, shown once. It replaces any earlier code.
    public func createRecoveryKit() async throws -> RecoveryKitResponse { try await post(RecoveryKitResponse.self, "/v1/auth/recovery-kit", body: [String: String]()) }

    /// A private link from a confirmed operation, accepted only on this API's origin and expected path, so the
    /// owner's session is never sent anywhere else. Returns the path and its query (the signed `t`).
    func ownerLink(_ link: String, pathPrefix: String) throws -> (path: String, query: [String: String]) {
        guard let url = URL(string: link), let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let base = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              c.scheme?.lowercased() == base.scheme?.lowercased(), c.host?.lowercased() == base.host?.lowercased(), c.port == base.port,
              c.path.hasPrefix(pathPrefix), c.path.count > pathPrefix.count, !c.path.contains(".."),
              let items = c.queryItems, items.contains(where: { $0.name == "t" && !($0.value ?? "").isEmpty })
        else { throw APIError.rejected(code: "untrusted_link", message: "That link is not a Garderobe link for this account", status: 400) }
        return (c.path, Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a }))
    }

    /// Opens an export download link with the owner's own session (GET /v1/export/downloads/{id}?t=).
    /// The package comes back as bytes for the owner to save; the app does not keep it.
    public func downloadExport(_ link: String) async throws -> (data: Data, filename: String) {
        let (path, query) = try ownerLink(link, pathPrefix: "/v1/export/downloads/")
        var req = try await request("GET", path, query: query)
        req.headers["Accept"] = "application/json"
        let response = try await perform(req)
        guard (200..<300).contains(response.status) else { _ = try decode(JSONValue.self, from: response); throw APIError.server(status: response.status) }
        let disposition = response.headers.first { $0.key.lowercased() == "content-disposition" }?.value ?? ""
        let name = disposition.split(separator: "\"").dropFirst().first.map(String.init) ?? "garderobe-export.json"
        let safe = name.filter { $0.isLetter || $0.isNumber || "-_.".contains($0) }
        return (response.body, safe.hasSuffix(".json") ? safe : "garderobe-export.json")
    }

    /// Collects a recovery code an assistant asked for (POST /v1/auth/recovery-kit/collect/{id}?t=). The link
    /// works once; the code is issued now, replaces the old one, and appears only in this response.
    public func collectRecoveryCode(_ link: String) async throws -> RecoveryKitResponse {
        let (path, query) = try ownerLink(link, pathPrefix: "/v1/auth/recovery-kit/collect/")
        let req = try await request("POST", path, query: query, body: [String: String]())
        return try decode(RecoveryKitResponse.self, from: try await perform(req))
    }

    /// POST /v1/recall/search: dated, quoted recall across the whole transcript (not just what is loaded).
    public func recallSearch(_ request: RecallSearchRequest) async throws -> RecallSearchResponse {
        try await post(RecallSearchResponse.self, "/v1/recall/search", body: request)
    }

    /// POST /v1/runs/{id}/input: the native answer to a pending question (same record an MCP retry resolves).
    public func answerRun(_ runId: String, choiceId: String?) async throws -> RunInputResponse {
        try await post(RunInputResponse.self, "/v1/runs/\(runId)/input", body: RunInputRequest(choiceId: choiceId))
    }

    @discardableResult
    public func cancelRun(_ runId: String) async throws -> CancelRunResponse? {
        let response = try await perform(try await request("POST", "/v1/runs/\(runId)/cancel"))
        if response.status == 409 { return nil }
        return try decode(CancelRunResponse.self, from: response)
    }

    /// GET /v1/runs/{id}/events as decoded run events, resuming after `lastEventId`.
    public func runEvents(_ runId: String, lastEventId: String?) async -> AsyncThrowingStream<RunEvent, Error> {
        var req: HTTPRequest
        do { req = try await request("GET", "/v1/runs/\(runId)/events") } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
        req.headers["Accept"] = "text/event-stream"
        if let lastEventId { req.headers["Last-Event-ID"] = lastEventId }
        let lines = transport.lines(req)
        return AsyncThrowingStream { continuation in
            let task = Task {
                var parser = SSEParser(lastEventId: lastEventId)
                func emit(_ message: SSEMessage) {
                    guard let data = message.data.data(using: .utf8) else { return }
                    if var event = try? GarderobeJSON.decoder().decode(RunEvent.self, from: data) {
                        if event.eventId.isEmpty, let id = message.id { event.eventId = id }
                        continuation.yield(event)
                    } else if let id = message.id {
                        // A data payload that is not a RunEvent: still advance the cursor, never crash.
                        continuation.yield(RunEvent(eventId: id, runId: runId, type: message.event, at: nil, data: (try? GarderobeJSON.decoder().decode(JSONValue.self, from: data)) ?? .null))
                    }
                }
                do {
                    for try await line in lines {
                        if let message = parser.feed(line) { emit(message) }
                    }
                    if let message = parser.finish() { emit(message) }
                    continuation.finish()
                } catch TransportError.offline {
                    continuation.finish(throwing: APIError.offline)
                } catch {
                    continuation.finish(throwing: APIError.interrupted(String(describing: error)))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Endpoints (shipped additions)

    public func style() async throws -> StyleCurrentResponse { try await get(StyleCurrentResponse.self, "/v1/style/current") }
    public func laundry() async throws -> LaundryState { try await get(LaundryState.self, "/v1/laundry") }
    public func receipts(cursor: String? = nil, limit: Int = 50) async throws -> ReceiptsPage {
        var q = ["limit": String(limit)]
        if let cursor { q["cursor"] = cursor }
        return try await get(ReceiptsPage.self, "/v1/receipts", query: q)
    }
    public func temperaturePreview(_ temperatureC: Double) async throws -> TemperaturePreview {
        try await get(TemperaturePreview.self, "/v1/wardrobe/temperature-preview", query: ["temperatureC": String(format: "%.0f", temperatureC)])
    }
    public func swapCandidates(optionId: String, role: GarmentRole) async throws -> SwapCandidates {
        try await get(SwapCandidates.self, "/v1/today/options/\(optionId)/swaps", query: ["role": role.rawValue])
    }
    public func validateStudio(_ body: StudioValidateRequest) async throws -> StudioValidation { try await post(StudioValidation.self, "/v1/studio/validate", body: body) }
    public func suggestStudio(_ body: StudioSuggestRequest) async throws -> StudioSuggestion { try await post(StudioSuggestion.self, "/v1/studio/suggest", body: body) }

    /// Authorize, upload and finalize one photograph. Unfinalized files never become evidence.
    public func upload(_ data: Data, contentType: String, purpose: String, garmentId: String? = nil) async throws -> String {
        guard data.count <= UploadRequest.maxBytes else { throw APIError.rejected(code: "too_large", message: "Photos can be up to 25 MB", status: 413) }
        let auth = try await post(UploadAuthorization.self, "/v1/uploads", body: UploadRequest(purpose: purpose, contentType: contentType, byteLength: data.count, garmentId: garmentId))
        // The signed upload URL carries its own token: no Authorization header is sent with it.
        var put = HTTPRequest(method: auth.method, path: auth.uploadUrl.hasPrefix("/") ? baseURL.absoluteString.trimmingSuffix("/") + auth.uploadUrl : auth.uploadUrl, headers: auth.headers, body: data)
        put.headers["Content-Type"] = contentType
        let response = try await perform(put)
        guard (200..<300).contains(response.status) else { throw APIError.server(status: response.status) }
        // UploadReceiveResponse: a short write is retried rather than finalized as a truncated photo.
        if let received = try? GarderobeJSON.decoder().decode(UploadReceiveResponse.self, from: response.body) {
            guard received.uploadId == auth.uploadId, received.receivedBytes == data.count else {
                throw APIError.interrupted("The photo did not arrive in full (\(received.receivedBytes) of \(data.count) bytes)")
            }
        }
        let done = try await post(UploadCompleteResponse.self, "/v1/uploads/\(auth.uploadId)/complete", body: [String: String]())
        guard done.status == "finalized" else { throw APIError.rejected(code: "upload_rejected", message: done.reason ?? "The photo could not be used", status: 422) }
        return done.uploadId
    }
}

/// Contract `WardrobeQueryParams` (GET /v1/wardrobe; every field optional).
public struct WardrobeQuery: Sendable, Hashable, Codable {
    public var q: String?
    public var category: String?
    /// available | unavailable | incoming | retired | any
    public var availability: String?
    public var colorFamily: String?
    /// spring | summer | autumn | winter
    public var season: String?
    /// home | storage | tailor | repair | trip | consignment | in_transit | unknown
    public var location: String?
    /// Items last worn before this date, or never recorded.
    public var lastWornBefore: LocalDate?
    public var cursor: String?
    /// 1…500 (the server's maximum page).
    public var limit: Int = 500

    public init(q: String? = nil, category: String? = nil, availability: String? = nil, colorFamily: String? = nil, season: String? = nil, location: String? = nil, lastWornBefore: LocalDate? = nil) {
        self.q = q; self.category = category; self.availability = availability; self.colorFamily = colorFamily
        self.season = season; self.location = location; self.lastWornBefore = lastWornBefore
    }

    public var parameters: [String: String] {
        var p = ["limit": String(min(500, max(1, limit)))]
        if let q, !q.isEmpty { p["q"] = String(q.prefix(200)) }
        if let category { p["category"] = category }
        if let availability { p["availability"] = availability }
        if let colorFamily { p["colorFamily"] = colorFamily }
        if let season { p["season"] = season }
        if let location { p["location"] = location }
        if let lastWornBefore { p["lastWornBefore"] = lastWornBefore.rawValue }
        if let cursor { p["cursor"] = cursor }
        return p
    }
}
