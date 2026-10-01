import Foundation

/// Supplies the bearer token for API calls. The app's implementation is the OAuth session
/// (`OAuthSession`); demo mode and tests use `StaticAccessToken`.
public protocol AccessTokenProviding: Sendable {
    /// Returns a usable access token, refreshing it when `forceRefresh` is set or it has expired.
    /// Returns `nil` when there is no session.
    func accessToken(forceRefresh: Bool) async throws -> String?
}

public struct StaticAccessToken: AccessTokenProviding {
    private let token: String?
    public init(_ token: String?) { self.token = token }
    public func accessToken(forceRefresh: Bool) async throws -> String? { token }
}

/// How the token is presented. Deployed, the API sits behind Cloudflare Access and takes an
/// OAuth bearer token; a local development Worker has no Access edge and takes the signed
/// assertion directly in the Access header.
public enum TokenPresentation: Sendable, Equatable {
    case bearer
    case header(String)

    func apply(_ token: String, to request: inout HTTPRequest) {
        switch self {
        case .bearer: request.headers["Authorization"] = "Bearer \(token)"
        case .header(let name): request.headers[name] = token
        }
    }
}

/// Typed client of the versioned HTTP API (`packages/contracts/src/ext/api.ts`, `API_ROUTES`).
/// Every method maps to exactly one route; request and response bodies are the generated
/// contract types. Failures are always `APIFailure`.
public final class APIClient: Sendable {
    public let transport: HTTPTransport
    private let tokens: AccessTokenProviding
    private let presentation: TokenPresentation

    public init(transport: HTTPTransport, tokens: AccessTokenProviding, presentation: TokenPresentation = .bearer) {
        self.transport = transport
        self.tokens = tokens
        self.presentation = presentation
    }

    // MARK: Core

    private func authorized(_ request: HTTPRequest, forceRefresh: Bool) async throws -> HTTPRequest {
        var r = request
        r.headers["Accept"] = r.headers["Accept"] ?? "application/json"
        r.headers["X-Garderobe-Client"] = "ios/\(GarderobeContract.version)"
        let token: String?
        do { token = try await tokens.accessToken(forceRefresh: forceRefresh) } catch let f as APIFailure { throw f } catch let t as TransportFailure { throw APIFailure.transport(t.reason) } catch { throw APIFailure.signedOut }
        guard let token else { throw APIFailure.signedOut }
        presentation.apply(token, to: &r)
        return r
    }

    /// Sends a request and returns the successful response, mapping every failure to `APIFailure`.
    /// A 401 is retried once with a refreshed token.
    public func perform(_ request: HTTPRequest) async throws -> HTTPResponse {
        var response = try await exchange(try await authorized(request, forceRefresh: false))
        if response.status == 401 {
            if let refreshed = try? await authorized(request, forceRefresh: true) { response = try await exchange(refreshed) }
        }
        guard (200..<300).contains(response.status) else { throw APIClient.failure(from: response) }
        return response
    }

    private func exchange(_ request: HTTPRequest) async throws -> HTTPResponse {
        do { return try await transport.send(request) } catch let t as TransportFailure { throw APIFailure.transport(t.reason) } catch let f as APIFailure { throw f } catch { throw APIFailure.transport(String(describing: error)) }
    }

    static func failure(from response: HTTPResponse) -> APIFailure {
        if let body = try? GarderobeJSON.decode(ApiErrorResponse.self, from: response.body) { return .api(status: response.status, error: body.error) }
        return .status(response.status)
    }

    private func decode<T: Decodable>(_ type: T.Type, _ response: HTTPResponse) throws -> T {
        do { return try GarderobeJSON.decode(type, from: response.body) } catch { throw APIFailure.decoding(String(describing: error)) }
    }

    public func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) async throws -> T {
        try decode(type, try await perform(HTTPRequest(method: "GET", path: path, query: query)))
    }

    public func post<B: Encodable, T: Decodable>(_ path: String, body: B, as type: T.Type = T.self) async throws -> T {
        let data: Data
        do { data = try GarderobeJSON.encode(body) } catch { throw APIFailure.decoding("request encoding: \(error)") }
        return try decode(type, try await perform(HTTPRequest(method: "POST", path: path, headers: ["Content-Type": "application/json"], body: data)))
    }

    public func post<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        try decode(type, try await perform(HTTPRequest(method: "POST", path: path, headers: ["Content-Type": "application/json"], body: Data("{}".utf8))))
    }

    private static func item(_ name: String, _ value: String?) -> [URLQueryItem] {
        guard let value, !value.isEmpty else { return [] }
        return [URLQueryItem(name: name, value: value)]
    }

    private static func segment(_ id: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
    }

    // MARK: Session and identity

    public func meta() async throws -> MetaResponse { try await get("/v1/meta") }
    public func me() async throws -> MeResponse { try await get("/v1/me") }
    public func claim(invitationCode: String) async throws -> MeResponse { try await post("/auth/claim", body: ClaimRequest(invitationCode: invitationCode)) }
    public func startIdentityLink() async throws -> IdentityLinkTicket { try await post("/v1/identities/link") }
    public func completeIdentityLink(linkCode: String) async throws -> MeResponse { try await post("/auth/link/complete", body: IdentityLinkCompleteRequest(linkCode: linkCode)) }
    public func unlinkIdentity(identityId: String) async throws -> MeResponse { try await post("/v1/identities/unlink", body: IdentityUnlinkRequest(identityId: identityId)) }
    public func issueRecoveryKit() async throws -> RecoveryKitIssued { try await post("/v1/recovery-kit") }
    public func startRecovery() async throws -> RecoveryTransaction { try await post("/auth/recovery/start") }
    public func completeRecovery(_ request: RecoveryCompleteRequest) async throws -> RecoveryCompleteResponse { try await post("/auth/recovery/complete", body: request) }
    public func recoveryStatus() async throws -> RecoveryStatus { try await get("/v1/recovery") }
    /// Sign out everywhere: sessions authenticated before now are refused.
    public func revokeSessions() async throws -> SessionsRevoked { try await post("/v1/sessions/revoke") }
    public func deleteAccount(confirmationToken: String?) async throws -> AccountDeleteResponse {
        try await post("/v1/account/delete", body: AccountDeleteRequest(confirmationToken: confirmationToken))
    }

    // MARK: Daily surfaces

    public func today(date: LocalDate? = nil, scope: String? = nil) async throws -> TodayResponse {
        try await get("/v1/today", query: APIClient.item("date", date) + APIClient.item("scope", scope))
    }
    public func recommend(_ request: RecommendRequest) async throws -> RecommendResponse { try await post("/v1/recommendations", body: request) }
    public func dailyRecord(date: LocalDate) async throws -> DailyRecord { try await get("/v1/days/\(APIClient.segment(date))") }
    public func serviceState() async throws -> ServiceState { try await get("/v1/service") }
    public func trips() async throws -> TripList { try await get("/v1/trips") }
    public func trip(id: String) async throws -> Trip { try await get("/v1/trips/\(APIClient.segment(id))") }
    public func returns() async throws -> ReturnList { try await get("/v1/returns") }
    public func orders() async throws -> OrderList { try await get("/v1/orders") }
    public func projects() async throws -> ProjectList { try await get("/v1/projects") }
    public func feedback(garmentId: String? = nil) async throws -> FeedbackList { try await get("/v1/feedback", query: APIClient.item("garmentId", garmentId)) }
    /// The weather snapshot behind the board's weather line: hourly basis, source and fetch time.
    public func weather(date: LocalDate? = nil) async throws -> WeatherSnapshot { try await get("/v1/weather", query: APIClient.item("date", date)) }
    /// Asks the backend to compose a packing proposal. The proposal is distinct from what is physically packed.
    public func proposePacking(tripId: String, clientRequestId: String) async throws -> PackingProposal {
        try await post("/v1/trips/\(APIClient.segment(tripId))/packing-proposal", body: ClientRequest(clientRequestId: clientRequestId))
    }

    // MARK: Wardrobe

    public func wardrobe(_ query: InventoryQuery = InventoryQuery()) async throws -> InventoryPage {
        try await get("/v1/wardrobe", query: APIClient.queryItems(query))
    }

    static func queryItems(_ q: InventoryQuery) -> [URLQueryItem] {
        var items: [URLQueryItem] = []
        items += item("search", q.search) + item("category", q.category) + item("acquisition", q.acquisition?.rawValue)
        items += item("availability", q.availability?.rawValue) + item("colour", q.colour) + item("location", q.location?.rawValue)
        if let include = q.includeDisposed { items += item("includeDisposed", include ? "true" : "false") }
        if let limit = q.limit { items += item("limit", String(limit)) }
        items += item("cursor", q.cursor) + item("forDate", q.forDate)
        return items
    }

    public func resolve(phrase: String) async throws -> AliasResolution { try await get("/v1/wardrobe/resolve", query: [URLQueryItem(name: "phrase", value: phrase)]) }
    public func availability(date: LocalDate? = nil) async throws -> AvailabilitySnapshot { try await get("/v1/availability", query: APIClient.item("date", date)) }
    public func item(id: String) async throws -> ItemResponse { try await get("/v1/items/\(APIClient.segment(id))") }
    public func laundry() async throws -> LaundryStateResponse { try await get("/v1/laundry") }
    public func style() async throws -> StyleContext { try await get("/v1/style") }

    /// What saving this profile text would do to the structured facts. Writes nothing.
    public func previewStyleSave(_ request: StylePreviewSaveRequest) async throws -> StyleFactDiff { try await post("/v1/style/preview-save", body: request) }

    public func styleConflicts(_ query: StyleConflictsQuery = StyleConflictsQuery()) async throws -> StyleConflictList {
        var items: [URLQueryItem] = []
        if let status = query.status { items.append(URLQueryItem(name: "status", value: status.rawValue)) }
        if let documentId = query.documentId { items.append(URLQueryItem(name: "documentId", value: documentId)) }
        return try await get("/v1/style/conflicts", query: items)
    }

    /// The garments a bulk edit with this selector would touch. Writes nothing.
    public func garmentSelection(_ selector: GarmentSelector) async throws -> GarmentSelection { try await post("/v1/wardrobe/selection", body: selector) }

    /// Simulation only: what becomes wearable at a temperature. Never changes availability.
    public func temperaturePreview(temperatureC: Double) async throws -> TemperaturePreview {
        try await get("/v1/wardrobe/temperature-preview", query: [URLQueryItem(name: "temperatureC", value: String(temperatureC))])
    }

    public func studio(mode: StudioMode, date: LocalDate? = nil) async throws -> StudioResponse {
        try await get("/v1/studio", query: [URLQueryItem(name: "mode", value: mode.rawValue)] + APIClient.item("date", date))
    }
    /// Authoritative validation of a composed combination. Reads only; nothing is planned or logged.
    public func validateStudio(_ request: StudioOutfitRequest) async throws -> StudioValidation { try await post("/v1/studio/validate", body: request) }
    /// "Find something that works with this": the backend fills the unlocked slots.
    public func suggestStudio(_ request: StudioOutfitRequest) async throws -> StudioSuggestResponse { try await post("/v1/studio/suggest", body: request) }
    public func composeStudio(_ request: StudioComposeRequest) async throws -> Composition { try await post("/v1/studio/compose", body: request) }

    // MARK: Commands

    public func execute(_ envelope: CommandEnvelope) async throws -> CommandReceipt { try await post("/v1/commands", body: envelope) }

    /// Offline replay: executed strictly in order, one result per command.
    public func executeBatch(_ envelopes: [CommandEnvelope]) async throws -> [CommandBatchResult] {
        let response: CommandBatchResponse = try await post("/v1/commands/batch", body: CommandBatchRequest(commands: envelopes))
        return try response.results.map { try CommandBatchResult($0) }
    }

    /// Receipts for an entity (`garment:gmt_x`, item history) or by idempotency key (reconciling a
    /// command whose response was lost). Newest first.
    public func receipts(entity: String? = nil, idempotencyKey: String? = nil, limit: Int? = nil) async throws -> ReceiptList {
        var query = APIClient.item("entity", entity) + APIClient.item("idempotencyKey", idempotencyKey)
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await get("/v1/commands", query: query)
    }
    public func receipt(commandId: String) async throws -> CommandReceipt { try await get("/v1/commands/\(APIClient.segment(commandId))") }
    public func commandTypes() async throws -> CommandTypeList { try await get("/v1/command-types") }

    // MARK: Conversation, recall, research, runs

    public func submitTurn(_ request: TurnRequest) async throws -> TurnResponse { try await post("/v1/conversation/turns", body: request) }

    public func messages(before: String? = nil, after: String? = nil, around: String? = nil, limit: Int? = nil) async throws -> MessagesPage {
        var query = APIClient.item("before", before) + APIClient.item("after", after) + APIClient.item("around", around)
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await get("/v1/conversation/messages", query: query)
    }
    public func recall(_ request: RecallQuery) async throws -> RecallResult { try await post("/v1/recall/search", body: request) }
    public func research(_ request: StartResearchRequest) async throws -> StartResearchResponse { try await post("/v1/research", body: request) }
    public func run(id: String) async throws -> Run { try await get("/v1/runs/\(APIClient.segment(id))") }
    public func cancelRun(id: String) async throws -> RunCancelResponse { try await post("/v1/runs/\(APIClient.segment(id))/cancel") }
    /// Runs again a run that failed with `error.resumable`; committed changes are not repeated.
    public func resumeRun(id: String) async throws -> Run { try await post("/v1/runs/\(APIClient.segment(id))/resume") }
    public func answerRun(id: String, _ request: RunInputRequest) async throws -> Run { try await post("/v1/runs/\(APIClient.segment(id))/input", body: request) }

    /// Server-sent run events. Reconnect by passing the last event ID seen; an expired cursor
    /// receives a `snapshot` event first, never a silent gap.
    public func runEvents(id: String, afterEventId: Int?) -> AsyncThrowingStream<RunEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = HTTPRequest(method: "GET", path: "/v1/runs/\(APIClient.segment(id))/events", headers: ["Accept": "text/event-stream"])
                    if let afterEventId { request.headers["Last-Event-ID"] = String(afterEventId) }
                    let authorized = try await self.authorized(request, forceRefresh: false)
                    var parser = SSEParser()
                    for try await chunk in self.transport.stream(authorized) {
                        for event in parser.feed(chunk) {
                            // Unknown or malformed events are skipped, not fatal (section 13).
                            guard let data = event.data.data(using: .utf8), let decoded = try? GarderobeJSON.decode(RunEvent.self, from: data) else { continue }
                            continuation.yield(decoded)
                        }
                    }
                    continuation.finish()
                } catch let t as TransportFailure {
                    continuation.finish(throwing: APIFailure.transport(t.reason))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Uploads and media

    public func authorizeUpload(_ request: UploadRequest) async throws -> UploadAuthorizationResponse { try await post("/v1/uploads", body: request) }
    public func uploadStatus(uploadId: String) async throws -> UploadStatus { try await get("/v1/uploads/\(APIClient.segment(uploadId))") }

    /// Sends the bytes to the target the authorization names, exactly as given: the URL carries its
    /// own short-lived token bound to this upload, so the API bearer token is not attached.
    public func uploadContent(_ authorization: UploadAuthorizationResponse, data: Data) async throws {
        let request = HTTPRequest(method: authorization.method, path: authorization.url, headers: authorization.requiredHeaders, body: data)
        let response = try await exchange(request)
        guard (200..<300).contains(response.status) else { throw APIClient.failure(from: response) }
    }
    public func completeUpload(uploadId: String) async throws -> UploadCompleteResponse {
        try await post("/v1/uploads/\(APIClient.segment(uploadId))/complete")
    }

    private func image(_ path: String, query: [URLQueryItem]) async throws -> Data {
        try await perform(HTTPRequest(method: "GET", path: path, query: query, headers: ["Accept": "image/*"])).body
    }
    private static func width(_ width: Int?) -> [URLQueryItem] { width.map { [URLQueryItem(name: "width", value: String($0))] } ?? [] }

    /// The garment's current display image. Fails with `not_found` when no real image exists;
    /// the backend never substitutes a placeholder and neither does the app.
    public func itemImage(garmentId: String, width: Int? = nil) async throws -> Data {
        try await image("/v1/items/\(APIClient.segment(garmentId))/image", query: APIClient.width(width))
    }
    /// Immutable rendition bytes; safe to cache by rendition ID and width.
    public func rendition(id: String, width: Int? = nil) async throws -> Data {
        try await image("/v1/media/renditions/\(APIClient.segment(id))", query: APIClient.width(width))
    }
    public func asset(id: String, variant: AssetImageQuery.Variant? = nil, width: Int? = nil) async throws -> Data {
        try await image("/v1/media/assets/\(APIClient.segment(id))", query: APIClient.item("variant", variant?.rawValue) + APIClient.width(width))
    }
    public func photosNeeded() async throws -> PhotosNeededList { try await get("/v1/media/photos-needed") }
    public func mediaReview() async throws -> MediaReview { try await get("/v1/media/review") }

    // MARK: Connections, settings, connected assistants

    public func connections() async throws -> ApiConnectionList { try await get("/v1/connections") }
    public func registerConnection(_ request: RegisterConnectionRequest) async throws -> RegisterConnectionResponse { try await post("/v1/connections", body: request) }
    public func reconnect(connectionId: String) async throws -> RegisterConnectionResponse {
        try await post("/v1/connections/\(APIClient.segment(connectionId))/reconnect", body: ReconnectRequest(returnTo: .app))
    }
    public func setCapabilities(connectionId: String, _ request: ConnectionCapabilitiesRequest) async throws -> ApiConnection {
        try await post("/v1/connections/\(APIClient.segment(connectionId))/capabilities", body: request)
    }
    public func disconnect(connectionId: String) async throws -> DisconnectResponse { try await post("/v1/connections/\(APIClient.segment(connectionId))/disconnect") }
    /// The owner's calendars, for choosing which are read for the day's context.
    public func calendars(connectionId: String) async throws -> ConnectionCalendarList { try await get("/v1/connections/\(APIClient.segment(connectionId))/calendars") }
    /// Creates (or finds) the dedicated outfit calendar the managed event is written to.
    public func ensureOutfitCalendar(connectionId: String, _ request: OutfitCalendarRequest) async throws -> OutfitCalendarResponse {
        try await post("/v1/connections/\(APIClient.segment(connectionId))/outfit-calendar", body: request)
    }
    public func settings() async throws -> SettingsResponse { try await get("/v1/settings") }
    public func assistants() async throws -> AssistantGrantList { try await get("/v1/assistants") }
    public func disconnectAssistant(grantId: String) async throws -> AssistantGrant { try await post("/v1/assistants/\(APIClient.segment(grantId))/disconnect") }

    // MARK: Portable export

    public func startExport(_ request: ExportRequest) async throws -> ExportJob { try await post("/v1/exports", body: request) }
    public func exports() async throws -> ExportList { try await get("/v1/exports") }
    public func export(id: String) async throws -> ExportJob { try await get("/v1/exports/\(APIClient.segment(id))") }
    public func exportTicket(id: String) async throws -> DownloadTicket { try await post("/v1/exports/\(APIClient.segment(id))/ticket") }
    /// Downloads the package with a single-use ticket URL (the ticket is the authorization).
    public func download(ticket: DownloadTicket) async throws -> Data {
        try await perform(HTTPRequest(method: "GET", path: ticket.url, headers: ["Accept": "application/octet-stream"])).body
    }
}

/// One result of `POST /v1/commands/batch`. The contract is a discriminated union on `status`;
/// an unknown status is kept as `.unknown` and treated as "not yet confirmed".
public enum CommandBatchResult: Sendable, Equatable {
    case receipt(idempotencyKey: String, receipt: CommandReceipt)
    case error(idempotencyKey: String, error: ApiError, retryable: Bool)
    case unknown(JSONValue)

    public init(_ value: JSONValue) throws {
        switch value["status"]?.stringValue {
        case "receipt":
            guard let key = value["idempotencyKey"]?.stringValue, let receipt = value["receipt"] else { throw APIFailure.decoding("batch receipt item") }
            do { self = .receipt(idempotencyKey: key, receipt: try receipt.decoded(as: CommandReceipt.self)) } catch { throw APIFailure.decoding("batch receipt: \(error)") }
        case "error":
            guard let key = value["idempotencyKey"]?.stringValue, let error = value["error"] else { throw APIFailure.decoding("batch error item") }
            do { self = .error(idempotencyKey: key, error: try error.decoded(as: ApiError.self), retryable: value["retryable"]?.boolValue ?? false) } catch { throw APIFailure.decoding("batch error: \(error)") }
        default:
            self = .unknown(value)
        }
    }
}
