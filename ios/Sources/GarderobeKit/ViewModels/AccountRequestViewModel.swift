import Foundation
import Observation

/// Confirming an export, import or recovery-kit request that Claude or ChatGPT made, and using its private
/// result. The assistant shows the owner `<origin>/confirm/{runId}`; the app accepts that link (or
/// `garderobe://confirm/{runId}`), loads the waiting question from `GET /v1/runs/{runId}`, and answers with
/// `POST /v1/runs/{runId}/input`. The same view model presents results confirmed inside Conversation.
///
/// Privacy: the download link, the collect link and a collected recovery code live only in this object's
/// memory. They are never added to the transcript, written to the client store or logged. A downloaded
/// export exists only as a temporary file for the share sheet and is deleted when the owner is done.
@MainActor
@Observable
public final class AccountRequestViewModel {
    public enum State: Equatable, Sendable {
        case idle
        case loading
        case question(NeedsInput)
        case done(AccountOperationOutcome, replayed: Bool)
        case declined
        case expired
        /// The run is not waiting for the owner (already answered elsewhere, or no such request).
        case notWaiting(String)
        case failed(String)
    }

    public private(set) var state: State = .idle
    public private(set) var isBusy = false
    /// A temporary file of the downloaded export, for the share sheet; deleted by `discardExport()`.
    public private(set) var exportFile: URL?
    /// The collected recovery code, shown once. Never stored; `forgetRecoveryCode()` clears it.
    public private(set) var recoveryCode: RecoveryKitResponse?
    public private(set) var linkError: String?
    /// Set after a confirmed result so Settings can refresh recovery status and transfers.
    public var onCompleted: (() async -> Void)?

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let receiptCenter: ReceiptCenter
    @ObservationIgnored private let exportDirectory: URL
    @ObservationIgnored private var runId: String?

    public init(env: AppEnvironment, receipts: ReceiptCenter, exportDirectory: URL = FileManager.default.temporaryDirectory) {
        self.env = env
        self.receiptCenter = receipts
        self.exportDirectory = exportDirectory
    }

    // MARK: Opening a confirmation link

    /// The run id in `https://<API origin>/confirm/{runId}` or `garderobe://confirm/{runId}`; nil for anything else
    /// (another host, another path, or an id that is not an opaque identifier).
    public static func runId(from url: URL, apiBase: URL) -> String? {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var parts: [String]
        if c.scheme == "garderobe" {
            guard c.host == "confirm" else { return nil }
            parts = c.path.split(separator: "/").map(String.init)
        } else {
            guard let base = URLComponents(url: apiBase, resolvingAgainstBaseURL: false),
                  c.scheme?.lowercased() == base.scheme?.lowercased(), c.host?.lowercased() == base.host?.lowercased(), c.port == base.port else { return nil }
            parts = c.path.split(separator: "/").map(String.init)
            guard parts.first == "confirm" else { return nil }
            parts.removeFirst()
        }
        guard parts.count == 1, let id = parts.first, id.count >= 4, id.count <= 80,
              id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) else { return nil }
        return id
    }

    /// Opens a link the owner tapped or pasted. Returns false when it is not a Garderobe confirmation link.
    @discardableResult
    public func open(_ url: URL) async -> Bool {
        guard let id = Self.runId(from: url, apiBase: env.api.baseURL) else {
            state = .failed("That is not a Garderobe confirmation link")
            return false
        }
        await load(runId: id)
        return true
    }

    /// Loads the question a run is waiting on.
    public func load(runId: String) async {
        reset()
        self.runId = runId
        state = .loading
        do {
            let status = try await env.api.run(runId)
            if status.status == .inputRequired, let p = status.pendingAction, p.status == "pending" {
                state = .question(NeedsInput(prompt: p.prompt, choices: p.choices.map { .init(id: $0.id, label: $0.label) }, pendingActionId: p.pendingActionId, runId: runId))
            } else {
                state = .notWaiting("This request is no longer waiting for you.")
            }
        } catch let e as APIError {
            if case .rejected(_, _, let code) = e, code == 404 { state = .notWaiting("There is no such request waiting for you.") } else { state = .failed(e.userMessage) }
        } catch {
            state = .failed("Couldn't load the request")
        }
    }

    // MARK: Answering

    public func answer(_ choice: NeedsInput.Choice) async { await respond(choice.id) }
    public func decline() async { await respond(nil) }

    private func respond(_ choiceId: String?) async {
        guard case .question(let q) = state, let run = q.runId ?? runId else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let result = try await env.api.answerRun(run, choiceId: choiceId)
            apply(result)
        } catch let e as APIError {
            // A confirmed request the service refuses, e.g. an import into a Garderobe that already has records.
            if case .rejected(_, let message, _) = e { state = .failed("Not done: \(message)") } else { state = .failed(e.userMessage) }
        } catch {
            state = .failed("Couldn't send your answer")
        }
    }

    /// Applies an answer's response (also used for answers given inside Conversation).
    public func apply(_ result: RunInputResponse) {
        if let r = result.receipt { receiptCenter.record(r, announce: true) }
        switch result.status {
        case .declined: state = .declined
        case .expired: state = .expired
        case .executed, .unknown:
            if let op = result.operation { present(op) } else { state = .notWaiting("Done.") }
        }
    }

    /// Shows a confirmed operation's private result.
    public func present(_ operation: AccountOperationReceipt) {
        discardExport()
        recoveryCode = nil
        linkError = nil
        state = .done(operation.outcome, replayed: operation.replayed)
        if let done = onCompleted { Task { await done() } }
    }

    public func reset() {
        discardExport()
        recoveryCode = nil
        linkError = nil
        runId = nil
        state = .idle
    }

    // MARK: Using the private result

    public var outcome: AccountOperationOutcome? {
        if case .done(let o, _) = state { return o }
        return nil
    }

    /// True once the result's link has passed its 15-minute expiry.
    public var isLinkExpired: Bool {
        switch outcome {
        case .export(let e): e.expiresAt <= env.now()
        case .recoveryKit(let k): k.expiresAt <= env.now()
        default: false
        }
    }

    /// Downloads the export with the owner's own session and writes it to a temporary file for the share sheet.
    @discardableResult
    public func saveExport() async -> URL? {
        guard case .export(let e) = outcome, let link = e.downloadUrl else { linkError = "This export has no download link"; return nil }
        guard !isLinkExpired else { linkError = "This link has expired. Ask for a new export."; return nil }
        isBusy = true
        defer { isBusy = false }
        do {
            let (data, name) = try await env.api.downloadExport(link)
            discardExport()
            let url = exportDirectory.appendingPathComponent(name)
            #if os(iOS)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: url, options: [.atomic])
            #endif
            exportFile = url
            linkError = nil
            return url
        } catch let e as APIError {
            linkError = Self.linkMessage(e, what: "export")
        } catch {
            linkError = "The export could not be saved on this phone"
        }
        return nil
    }

    /// Removes the temporary export file.
    public func discardExport() {
        if let f = exportFile { try? FileManager.default.removeItem(at: f) }
        exportFile = nil
    }

    /// Collects the new recovery code (one time). It replaces the previous code.
    public func collectRecoveryCode() async {
        guard case .recoveryKit(let k) = outcome, let link = k.collectUrl else { linkError = "This request has no collection link"; return }
        guard !isLinkExpired else { linkError = "This link has expired. Ask for a new recovery code."; return }
        isBusy = true
        defer { isBusy = false }
        do {
            recoveryCode = try await env.api.collectRecoveryCode(link)
            linkError = nil
            if let done = onCompleted { await done() }
        } catch let e as APIError {
            linkError = Self.linkMessage(e, what: "recovery code")
        } catch {
            linkError = "Couldn't collect the recovery code"
        }
    }

    public func forgetRecoveryCode() { recoveryCode = nil }

    static func linkMessage(_ e: APIError, what: String) -> String {
        switch e {
        case .rejected(let code, let message, let status):
            if code == "untrusted_link" { return message }
            if status == 410 { return message.isEmpty ? "This \(what) link has expired" : message }
            return message
        case .unauthorized: return "Sign in to Garderobe to open this \(what)"
        case .offline: return "Opening the \(what) needs a connection"
        default: return e.userMessage
        }
    }

    // MARK: Display

    public static func title(_ o: AccountOperationOutcome) -> String {
        switch o {
        case .export: "Your export is ready"
        case .imported: "Import complete"
        case .recoveryKit: "A new recovery code is ready to collect"
        case .unknown: "Done"
        }
    }

    /// Plain lines describing the result. Never contains a link, a token or a code.
    public func lines(_ o: AccountOperationOutcome) -> [String] {
        func rows(_ t: [TableCount]) -> String { "\(t.reduce(0) { $0 + $1.rows }) records in \(t.count) tables" }
        func until(_ d: Date) -> String { "The link works once you are signed in, until \(Self.time(d, env.timeZone))." }
        switch o {
        case .export(let e):
            var out = [e.summary, rows(e.tables)]
            if !e.complete { out.append("Incomplete: " + (e.incomplete.isEmpty ? "some records could not be read" : e.incomplete.joined(separator: ", "))) }
            out.append(until(e.expiresAt))
            return out.filter { !$0.isEmpty }
        case .imported(let i):
            var out = [i.summary, rows(i.tables)]
            let n = i.importedAssistantGrants.count
            out.append(n == 0 ? "No connected assistants were in the package." : "\(n) connected assistant\(n == 1 ? " was" : "s were") imported revoked; connect them again if you want them.")
            out.append("No sign-in sessions were recreated.")
            if !i.callingGrant.note.isEmpty { out.append(i.callingGrant.note) }
            return out.filter { !$0.isEmpty }
        case .recoveryKit(let k):
            return [k.summary, "Collecting it replaces your current recovery code.", until(k.expiresAt)].filter { !$0.isEmpty }
        case .unknown(let name):
            return ["\(name.replacingOccurrences(of: "_", with: " ").capitalized) was done."]
        }
    }

    static func time(_ d: Date, _ tz: TimeZone) -> String {
        var f = Date.FormatStyle.dateTime.hour().minute()
        f.timeZone = tz
        return d.formatted(f.locale(Locale(identifier: "en_GB")))
    }
}
