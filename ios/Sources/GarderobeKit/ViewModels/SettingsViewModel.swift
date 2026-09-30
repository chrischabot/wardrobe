import Foundation
import Observation

/// Settings behind the account control: connections (Gmail and Calendar first), Connected
/// assistants (Claude, ChatGPT MCP grants from `SettingsResponse.connectedAssistants`) and delivery.
@MainActor
@Observable
public final class SettingsViewModel {
    public private(set) var settings: SettingsResponse?
    public private(set) var connections: [Connection] = []
    public private(set) var session: SessionResponse?
    public private(set) var lastError: APIError?
    public private(set) var busyConnectionId: String?
    public private(set) var lastDisconnect: DisconnectResponse?
    /// Recovery-code status (never the code) and recent account transfers. Kept in memory only.
    public private(set) var recovery: RecoveryStatus?
    public private(set) var transfers: AccountTransfers?
    public private(set) var accountError: String?
    /// A recovery code just created here: shown once, never stored; `forgetNewRecoveryCode()` clears it.
    public private(set) var newRecoveryCode: RecoveryKitResponse?
    public private(set) var isCreatingRecoveryCode = false
    /// Set when a code arrived after Settings closed: it was not kept, so the owner knows to create another.
    public private(set) var discardedRecoveryCodeNote: String?

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let queue: CommandQueue
    /// Bumped by each creation and by `forgetNewRecoveryCode()`: a late result for an older request is discarded.
    @ObservationIgnored private var recoveryRequest = 0

    public init(env: AppEnvironment, queue: CommandQueue) {
        self.env = env; self.queue = queue
        settings = env.store.load(SettingsResponse.self, StoreKey.settings)
        connections = env.store.load([Connection].self, StoreKey.connections) ?? []
    }

    public func refresh() async {
        do {
            async let s = env.api.settings()
            async let c = env.api.connections()
            let (settings, conns) = try await (s, c)
            self.settings = settings
            self.connections = conns.connections
            env.store.save(settings, StoreKey.settings)
            env.store.save(conns.connections, StoreKey.connections)
            lastError = nil
        } catch let e as APIError {
            lastError = e
        } catch {}
        session = try? await env.api.session()
        await refreshAccount()
    }

    /// GET /v1/auth/recovery-kit and GET /v1/account/transfers. A failure leaves the rest of Settings usable.
    public func refreshAccount() async {
        do {
            async let r = env.api.recoveryStatus()
            async let t = env.api.accountTransfers()
            let (status, list) = try await (r, t)
            recovery = status
            transfers = list
            accountError = nil
        } catch let e as APIError {
            accountError = e == .offline ? "Recovery status needs a connection" : e.userMessage
        } catch {
            accountError = "Recovery status is not available right now"
        }
    }

    /// POST /v1/auth/recovery-kit: replaces the current recovery code (for example after one was pasted into a chat).
    public func createRecoveryCode() async {
        recoveryRequest += 1
        let request = recoveryRequest
        isCreatingRecoveryCode = true
        discardedRecoveryCodeNote = nil
        defer { if request == recoveryRequest { isCreatingRecoveryCode = false } }
        do {
            let code = try await env.api.createRecoveryKit()
            guard request == recoveryRequest else {
                // Settings closed (or the code was dismissed) while this was in flight. The credential is never
                // kept in the long-lived model; the server has replaced the old code, so say so.
                isCreatingRecoveryCode = false
                discardedRecoveryCodeNote = "A new recovery code was created after Settings closed, so it wasn't kept on this phone. Create another one to see it."
                await refreshAccount()
                return
            }
            newRecoveryCode = code
            accountError = nil
            await refreshAccount()
        } catch let e as APIError {
            guard request == recoveryRequest else { isCreatingRecoveryCode = false; return }
            accountError = e == .offline ? "Creating a recovery code needs a connection" : e.userMessage
        } catch {
            guard request == recoveryRequest else { isCreatingRecoveryCode = false; return }
            accountError = "Couldn't create a recovery code"
        }
    }

    /// Clears the shown code and invalidates any creation still in flight, so a late result is not kept.
    public func forgetNewRecoveryCode() {
        recoveryRequest += 1
        newRecoveryCode = nil
    }

    private func day(_ d: Date) -> String {
        var f = Date.FormatStyle.dateTime.day().month(.wide).year()
        f.timeZone = env.timeZone
        return d.formatted(f.locale(Locale(identifier: "en_GB")))
    }

    /// "A recovery code was issued on 29 September 2026" or "No recovery code yet". Never the code.
    public var recoveryLine: String? {
        guard let r = recovery else { return nil }
        guard r.hasActiveKit else { return "No recovery code yet. Without one, a lost sign-in cannot be recovered." }
        return r.activeKitIssuedAt.map { "A recovery code was issued on \(day($0))" } ?? "A recovery code is set up"
    }

    /// Further recovery facts worth knowing: a code waiting to be collected, failed attempts, the last recovery.
    public var recoveryNotes: [String] {
        var out: [String] = discardedRecoveryCodeNote.map { [$0] } ?? []
        guard let r = recovery else { return out }
        if let p = r.pendingCollection, p.expiresAt > env.now() {
            out.append("A new code is waiting to be collected until \(AccountRequestViewModel.time(p.expiresAt, env.timeZone)).")
        }
        if r.failedAttemptsLast24h > 0 { out.append("\(r.failedAttemptsLast24h) failed recovery attempt\(r.failedAttemptsLast24h == 1 ? "" : "s") in the last 24 hours.") }
        if let d = r.lastRecoveredAt { out.append("Last recovered on \(day(d)).") }
        return out
    }

    public struct TransferRow: Identifiable, Sendable, Hashable {
        public var id: String
        public var title: String
        public var detail: String
        public var systemImage: String
    }

    /// Recent exports, staged imports and recovery links, newest first: kind, status, where it was asked from
    /// and when. Links, tokens and codes are never part of these rows.
    public var transferRows: [TransferRow] {
        (transfers?.transfers ?? []).sorted { $0.createdAt > $1.createdAt }.prefix(20).map { t in
            let title: String, image: String
            switch t.kind {
            case "export_download": (title, image) = ("Export", "square.and.arrow.up")
            case "import_package": (title, image) = ("Import package", "square.and.arrow.down")
            case "recovery_kit_link": (title, image) = ("Recovery code", "key")
            default: (title, image) = (t.kind.replacingOccurrences(of: "_", with: " ").capitalized, "arrow.left.arrow.right")
            }
            let status = Self.statusText(t.status, expired: t.completedAt == nil && t.expiresAt <= env.now())
            let from = Self.surfaceText(t.surface)
            let when = FreshnessText.checked(t.createdAt, now: env.now(), timeZone: env.timeZone)
            return TransferRow(id: t.transferId, title: title, detail: [status, from, when].filter { !$0.isEmpty }.joined(separator: " · "), systemImage: image)
        }
    }

    static func statusText(_ s: String, expired: Bool) -> String {
        if expired && (s == "ready" || s == "pending" || s == "staged") { return "Expired" }
        switch s {
        case "ready": return "Ready to download"
        case "downloaded": return "Downloaded"
        case "pending": return "Waiting to be collected"
        case "collected": return "Collected"
        case "staged": return "Staged"
        case "imported": return "Imported"
        case "expired": return "Expired"
        default: return s.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    static func surfaceText(_ s: String) -> String {
        switch s {
        case "mcp": "asked for by an assistant"
        case "app", "native_token": "from the app"
        case "web", "access": "from the web"
        default: s.isEmpty ? "" : "from \(s)"
        }
    }

    static let order = ["gmail", "calendar", "drive", "sheets", "search", "browser", "mcp"]

    /// Gmail and Calendar first; Drive, search and other connections follow. Assistant grants are separate.
    public var services: [Connection] {
        connections.filter { !$0.isAssistantGrant }.sorted { (Self.order.firstIndex(of: $0.kind) ?? 99, $0.displayName) < (Self.order.firstIndex(of: $1.kind) ?? 99, $1.displayName) }
    }

    /// Claude, ChatGPT and other consumer grants, active first; revoked ones stay listed as history.
    public var assistants: [AssistantGrant] {
        (settings?.connectedAssistants ?? []).sorted { ($0.isActive ? 0 : 1, $0.displayName) < ($1.isActive ? 0 : 1, $1.displayName) }
    }

    /// A missing permission names the affected capability; it never becomes an error screen.
    public func summary(_ c: Connection) -> String {
        let last = c.lastSuccessAt.map { "Last worked \(FreshnessText.checked($0, now: env.now(), timeZone: env.timeZone))" + (c.lastSuccessOperation.map { ": \($0)" } ?? "") }
        switch c.status {
        case "connected": return last ?? "Connected"
        case "needs_reauth", "missing_permission":
            let affected = c.unavailableCapabilities.map(\.name)
            let what = affected.isEmpty ? "Some features" : affected.joined(separator: " and ")
            return "\(what) paused until you reconnect." + (last.map { " \($0)." } ?? "")
        case "disconnected": return "Not connected"
        default: return c.lastError ?? "Not working right now"
        }
    }

    public func summary(_ g: AssistantGrant) -> String {
        guard g.isActive else { return "Disconnected" + (g.revokedAt.map { " \(FreshnessText.checked($0, now: env.now(), timeZone: env.timeZone))" } ?? "") }
        var s = g.canWrite ? "Can read and make changes" : "Read only"
        if let at = g.lastUsedAt { s += " · last used \(FreshnessText.checked(at, now: env.now(), timeZone: env.timeZone))" + (g.lastOperation.map { ": \($0)" } ?? "") }
        else { s += " · not used yet" }
        return s
    }

    /// Reconnect URLs may be relative to the API origin ("/v1/connections/{id}/connect").
    public func reconnectURL(_ c: Connection) -> URL? {
        guard let raw = c.reconnectUrl, let u = URL(string: raw) else { return nil }
        return u.scheme == nil ? URL(string: raw, relativeTo: env.api.baseURL)?.absoluteURL : u
    }

    /// Revoke access: stops future calls and cancels queued ones on the backend.
    public func disconnect(_ c: Connection) async { await disconnect(id: c.connectionId) }

    /// Revokes a consumer assistant's MCP grant at once (`mgr_…`); other assistants are untouched.
    public func disconnect(_ g: AssistantGrant) async { await disconnect(id: g.grantId) }

    private func disconnect(id: String) async {
        busyConnectionId = id
        defer { busyConnectionId = nil }
        do {
            lastDisconnect = try await env.api.disconnect(id)
            await refresh()
        } catch let e as APIError {
            lastError = e
        } catch {}
    }

    public var deliveryTime: String { settings?.deliveryTime ?? "07:00" }
    public var optionCount: Int { settings?.dailyOptionCount ?? 5 }
    public var calendarId: String? { settings?.calendarId }
    /// Inference is the local stand-in, not AI Gateway (shown so answers are not mistaken for real ones).
    public var modelsSimulated: Bool { settings?.models?.simulated ?? false }

    /// update_delivery_settings: board time (HH:MM), 3–5 outfits, the outfit calendar. Only changes are sent.
    public func updateDelivery(time: String?, optionCount: Int?, calendar: DomainCommand.CalendarChoice = .keep) async -> ActionResult {
        let count = optionCount.map { min(5, max(3, $0)) }
        let newTime = time == settings?.deliveryTime ? nil : time
        let newCount = count == settings?.dailyOptionCount ? nil : count
        guard newTime != nil || newCount != nil || calendar != .keep else { return .refused("Nothing changed") }
        let result = ActionResult(await queue.submit(.updateDeliverySettings(deliveryTime: newTime, dailyOptionCount: newCount, calendar: calendar), label: "Delivery settings"))
        if case .done = result { await refresh() }
        return result
    }
}

/// Settings > My style: the owner's full profile text with its version, editable verbatim.
@MainActor
@Observable
public final class MyStyleViewModel {
    public enum SaveState: Equatable, Sendable {
        case idle, saving
        case saved(version: Int)
        case queued
        case conflict(String)
        case failed(String)
    }

    public struct Section: Identifiable, Sendable, Hashable {
        public var id: String { title }
        public var title: String
        public var body: String
    }

    public private(set) var response: StyleCurrentResponse?
    public private(set) var isLoading = false
    public private(set) var lastError: APIError?
    public private(set) var isEditing = false
    public var draft: String = "" { didSet { if isEditing { env.store.save(draft, StoreKey.styleDraft) } } }
    public var amendment = ""
    public private(set) var saveState: SaveState = .idle

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let queue: CommandQueue

    public init(env: AppEnvironment, queue: CommandQueue) {
        self.env = env; self.queue = queue
        response = env.store.load(StyleCurrentResponse.self, StoreKey.styleDocument)
        if let saved = env.store.load(String.self, StoreKey.styleDraft), saved != response?.document.body {
            // An unsaved edit survives app closure.
            isEditing = true
            draft = saved
        }
    }

    public var document: StyleDocument? { response?.document }

    public func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let r = try await env.api.style()
            response = r
            env.store.save(r, StoreKey.styleDocument)
            lastError = nil
        } catch let e as APIError {
            lastError = e
        } catch {}
    }

    /// The shown text matches its recorded SHA-256 (the imported bytes, not a summary).
    public var isVerbatim: Bool? {
        guard let d = document else { return nil }
        return SHA256.hex(d.body) == d.contentSha256
    }

    public var versionLine: String? {
        guard let d = document else { return nil }
        var parts = ["Version \(d.version)"]
        if let a = d.authoredOn { parts.append("written " + DayLine.dateText(a, timeZone: env.timeZone).split(separator: " ").dropFirst().joined(separator: " ") + " " + a.rawValue.prefix(4)) }
        parts.append(d.source == "owner_edit" ? "edited in Garderobe" : "as you supplied it")
        parts.append("\(d.byteLength.formatted()) bytes")
        return parts.joined(separator: " · ")
    }

    public var ruleLine: String? {
        guard let r = response?.rules else { return nil }
        var s = "\(r.active) rules drawn from this text, \(r.hard) of them hard constraints"
        if r.missingPassages > 0 { s += " · \(r.missingPassages) need review after your edit" }
        return s
    }

    /// Numbered sections ("## 11. How advice should arrive") for the table of contents.
    public var sections: [Section] {
        guard let body = document?.body else { return [] }
        var out: [Section] = []
        var title = "Introduction"
        var lines: [Substring] = []
        for line in body.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("## ") {
                if !lines.joined().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(Section(title: title, body: lines.joined(separator: "\n"))) }
                title = String(line.dropFirst(3))
                lines = []
            } else {
                lines.append(line)
            }
        }
        out.append(Section(title: title, body: lines.joined(separator: "\n")))
        return out
    }

    public func beginEditing() {
        guard let d = document else { return }
        draft = d.body
        isEditing = true
        saveState = .idle
    }

    public func cancelEditing() {
        isEditing = false
        draft = ""
        amendment = ""
        env.store.save(Optional<String>.none, StoreKey.styleDraft)
    }

    public var hasUnsavedChanges: Bool { isEditing && draft != document?.body }

    /// Saves a new verbatim version against the version being edited; a concurrent edit conflicts
    /// and keeps the draft rather than overwriting either text.
    public func save() async {
        guard let d = document, hasUnsavedChanges, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        saveState = .saving
        let outcome = await queue.submit(.editStyleProfile(documentId: d.documentId, baseVersion: d.version, body: draft, amendment: amendment), label: "My style edited")
        switch outcome {
        case .receipt(let r) where r.outcome.didCommit:
            await load()
            saveState = .saved(version: document?.version ?? d.version + 1)
            cancelEditing()
        case .receipt(let r) where r.outcome == .conflict:
            saveState = .conflict("Your profile changed elsewhere (now a newer version). Your edit is kept here; review it and save again.")
            await load()
        case .receipt(let r):
            saveState = .failed(r.error?.message ?? "Not saved")
        case .queued:
            saveState = .queued
        case .failed(let p):
            saveState = .failed(p.stateLabel)
        }
    }
}
