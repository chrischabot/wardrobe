import Foundation
import Observation

/// Sign-in, the first claim of the account, the recovery kit, linking a second identity and
/// recovery after losing the login identity. Ownership is only ever proved by the sign-in
/// identity, an invitation or link code, or the recovery credential - never by an email match
/// or by anything the app knows about the wardrobe.
@MainActor
@Observable
public final class AccountModel {
    public enum State: Sendable, Equatable {
        case unknown
        case signedOut
        /// Signed in with a verified identity that is not linked to an account: claim, link or recover.
        case identityNotLinked
        case signedIn(MeResponse)
        /// Tokens exist but the backend could not be reached; the last known account is shown.
        case offline(MeResponse?)
        /// The labelled demo mode (bundled recorded data, read-only against the recording).
        case demo(MeResponse?)
    }

    public let environment: AppEnvironment
    private let session: OAuthSession?
    public private(set) var state: State = .unknown
    public private(set) var attempt: AuthorizationAttempt?
    public private(set) var message: String?
    public private(set) var isWorking = false

    /// A recovery kit that was just issued. It is shown exactly once and held only in memory:
    /// never cached, never written to disk by the app unless the owner saves the file himself.
    public private(set) var visibleKit: RecoveryKit?
    public private(set) var recoveryTransaction: RecoveryTransaction?
    public private(set) var recoveryResult: RecoveryCompleteResponse?
    public private(set) var linkTicket: IdentityLinkTicket?
    public private(set) var deletion: AccountDeleteResponse?

    public init(environment: AppEnvironment, session: OAuthSession?) {
        self.environment = environment
        self.session = session
    }

    public var me: MeResponse? {
        switch state {
        case .signedIn(let me): return me
        case .offline(let me), .demo(let me): return me
        default: return nil
        }
    }

    public var isUsable: Bool {
        switch state {
        case .signedIn, .offline, .demo: return true
        default: return false
        }
    }

    // MARK: Session

    /// Determines the session state at launch. Offline with stored tokens opens the app on its
    /// cache rather than a sign-in wall.
    public func restore() async {
        if environment.isDemo {
            state = .demo(try? await environment.api.me())
            return
        }
        guard let session, session.hasSession else { state = .signedOut; return }
        await loadMe()
    }

    private func loadMe() async {
        do {
            let me = try await environment.api.me()
            // The kit in a claim response is never cached; strip it before saving the account for offline use.
            var cacheable = me
            cacheable.issuedRecoveryKit = nil
            environment.cache.put("me", cacheable, checkedAt: environment.time.now())
            state = .signedIn(me)
            environment.center.sessionRestored()
            message = nil
        } catch let failure as APIFailure {
            switch failure {
            case .api(_, let error) where error.code == .identityNotLinked:
                state = .identityNotLinked
            case .api(_, let error) where error.code == .accountDisabled:
                state = .signedOut
                message = error.message
            case _ where failure.needsSignIn:
                state = .signedOut
                message = "Your session has ended. Sign in again."
            case _ where failure.isTransport:
                let cached: Cached<MeResponse>? = environment.cache.get("me")
                state = .offline(cached?.value)
            default:
                let cached: Cached<MeResponse>? = environment.cache.get("me")
                state = .offline(cached?.value)
                message = failure.ownerMessage
            }
        } catch {
            state = .signedOut
        }
    }

    /// Starts sign-in and returns the URL to open in `ASWebAuthenticationSession`.
    public func beginSignIn() async -> URL? {
        guard let session else { message = "Sign-in is not configured in this build."; return nil }
        do {
            let attempt = try await session.beginAuthorization()
            self.attempt = attempt
            message = nil
            return attempt.url
        } catch let failure as SignInFailure {
            message = failure.ownerMessage
        } catch {
            message = "Sign-in could not be started."
        }
        return nil
    }

    /// Finishes sign-in with the callback URL the browser session returned.
    public func completeSignIn(callback: URL) async {
        guard let session, let attempt else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            try await session.complete(attempt, callback: callback)
            self.attempt = nil
            await loadMe()
        } catch let failure as SignInFailure {
            message = failure.ownerMessage
        } catch {
            message = "Sign-in could not be completed."
        }
    }

    public func signInCancelled() { attempt = nil }

    /// Set by the app: work that needs the session and must happen before it is dropped (this
    /// phone's notification registration is removed).
    public var beforeSignOut: (@MainActor () async -> Void)?

    /// Signs out on this phone. Cached wardrobe data is removed; commands still waiting to be
    /// sent are kept so an observation made offline is not lost.
    public func signOut() async {
        await beforeSignOut?()
        await session?.signOut()
        environment.cache.removeAll()
        visibleKit = nil; recoveryResult = nil; recoveryTransaction = nil; linkTicket = nil
        state = .signedOut
    }

    /// Sign out everywhere: every session authenticated before now is refused.
    public func signOutEverywhere() async {
        await run { _ = try await self.environment.api.revokeSessions() }
        if message == nil { await signOut() }
    }

    private func run(_ work: @escaping () async throws -> Void) async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await work()
            message = nil
        } catch let failure as APIFailure {
            message = failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            message = "That could not be completed."
        }
    }

    // MARK: First claim, recovery kit, linked identities

    /// Claims the invited owner account with the one-time invitation code. The response carries
    /// the account's first recovery kit, shown once.
    public func claim(invitationCode: String) async {
        let code = invitationCode.trimmingCharacters(in: .whitespacesAndNewlines)
        await run {
            let me = try await self.environment.api.claim(invitationCode: code)
            self.visibleKit = me.issuedRecoveryKit
            self.state = .signedIn(me)
        }
    }

    /// Issues (or rotates) the recovery kit. The previous kit stops working.
    public func issueRecoveryKit() async {
        await run {
            let issued = try await self.environment.api.issueRecoveryKit()
            self.visibleKit = issued.kit
            await self.loadMe()
        }
    }

    /// The owner confirms the kit is stored; it is dropped from memory and cannot be shown again.
    public func acknowledgeKit() { visibleKit = nil; recoveryResult = nil }

    /// An authenticated owner starts linking a second identity in advance.
    public func startIdentityLink() async {
        await run { self.linkTicket = try await self.environment.api.startIdentityLink() }
    }

    /// Signed in with the new identity: bind it using the link code issued to the owner.
    public func completeIdentityLink(linkCode: String) async {
        let code = linkCode.trimmingCharacters(in: .whitespacesAndNewlines)
        await run {
            let me = try await self.environment.api.completeIdentityLink(linkCode: code)
            self.state = .signedIn(me)
        }
    }

    public func unlink(identityId: String) async {
        await run { self.state = .signedIn(try await self.environment.api.unlinkIdentity(identityId: identityId)) }
    }

    // MARK: Recovery after losing the login identity

    /// Opens an expiring recovery transaction for the identity now signed in.
    public func startRecovery() async {
        await run { self.recoveryTransaction = try await self.environment.api.startRecovery() }
    }

    /// Proves possession of the recovery credential. On success the new identity is bound,
    /// earlier sessions and connected assistants are revoked, and a replacement kit is shown once.
    public func completeRecovery(recoveryCode: String, unlinkPreviousIdentities: Bool) async {
        guard let transaction = recoveryTransaction else { message = "Start recovery first."; return }
        let code = recoveryCode.trimmingCharacters(in: .whitespacesAndNewlines)
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await environment.api.completeRecovery(RecoveryCompleteRequest(transactionId: transaction.transactionId, recoveryCode: code, unlinkPreviousIdentities: unlinkPreviousIdentities))
            recoveryResult = result
            visibleKit = result.replacementKit
            recoveryTransaction = nil
            message = nil
            await loadMe()
        } catch let failure as APIFailure {
            switch failure {
            case .api(_, let error) where error.code == .unrecoverable:
                // No override exists: say so plainly.
                message = "This account cannot be recovered through this route: neither a linked identity nor a valid recovery code is available. " + error.message
                recoveryTransaction = nil
            case .api(_, let error) where error.code == .expired:
                message = "The recovery attempt expired. Start again."
                recoveryTransaction = nil
            case .api(_, let error):
                message = error.message
                if let remaining = error.details["attemptsRemaining"]?.intValue { recoveryTransaction?.attemptsRemaining = remaining }
            default:
                message = failure.ownerMessage
            }
        } catch {
            message = "Recovery could not be completed."
        }
    }

    /// What recovery changed, in the backend's numbers.
    public var recoverySummary: [String] {
        guard let r = recoveryResult else { return [] }
        var lines = ["This sign-in is now linked to your wardrobe.", "Earlier sessions on other devices have been signed out."]
        lines.append(r.assistantGrantsRevoked == 0 ? "No connected assistants needed disconnecting." : "\(Phrases.count(r.assistantGrantsRevoked, "connected assistant")) disconnected; reconnect them from Settings.")
        if r.previousIdentitiesUnlinked > 0 { lines.append("\(Phrases.count(r.previousIdentitiesUnlinked, "previous sign-in")) unlinked.") }
        lines.append("Gmail, Calendar and other data connections are separate and were not changed.")
        lines.append("Your previous recovery code no longer works. Store the new one below.")
        return lines
    }

    // MARK: Account deletion (two explicit steps)

    public func requestDeletion() async {
        await run { self.deletion = try await self.environment.api.deleteAccount(confirmationToken: nil) }
    }

    public func confirmDeletion() async {
        guard let token = deletion?.confirmationToken else { return }
        await run { self.deletion = try await self.environment.api.deleteAccount(confirmationToken: token) }
        // A confirmed deletion erases everything on the backend; nothing of it stays on the phone.
        if deletion?.state == .erased || deletion?.state == .disabledPendingDeletion {
            erasedNotice = deletion?.consequence
            await session?.signOut()
            environment.cache.removeAll()
            deletion = nil; visibleKit = nil; recoveryResult = nil; recoveryTransaction = nil; linkTicket = nil
            state = .signedOut
        }
    }

    /// What the backend said the confirmed deletion did, shown once on the sign-in screen.
    public private(set) var erasedNotice: String?
    public func dismissErasedNotice() { erasedNotice = nil }

    public func cancelDeletion() { deletion = nil }
}

/// The recovery screen: the concrete state of the last board, the last confirmed Calendar
/// projection, pending work and connection issues, with the applicable action for each.
/// Diagnostics sit behind a separate disclosure.
@MainActor
@Observable
public final class RecoveryStatusModel {
    public let environment: AppEnvironment
    public let status: Resource<RecoveryStatus>

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        status = environment.resource("recovery.status") { try await api.recoveryStatus() }
    }

    public func open() async {
        status.loadCached()
        await status.refresh()
    }

    public var boardLine: String {
        guard let b = status.value?.lastBoard else { return "No board has been published yet." }
        let when = Dates.parseInstant(b.publishedAt).map { Phrases.relativeTime($0, now: environment.time.now(), timeZone: environment.timeZone) } ?? b.publishedAt
        return "Last board: \(Phrases.dayMonth(b.localDate)), revision \(b.revision), published \(when)."
    }

    public var calendarLine: String {
        guard let c = status.value?.lastCalendarProjection else { return "Calendar: nothing has been projected." }
        switch c.state {
        case "projected": return "Calendar: revision \(c.projectedRevision.map(String.init) ?? "?") is confirmed in the event."
        case "pending": return "Calendar: an update is waiting to be written."
        case "failed": return "Calendar: the last update failed. " + (c.action ?? "")
        case "not_connected": return "Calendar is not connected. " + (c.action ?? "")
        case "suppressed": return "Calendar: the board for that day is suppressed."
        default: return "Calendar: \(c.state)."
        }
    }

    /// Commands still on this phone plus work the backend has not finished.
    public var pendingLines: [String] {
        var lines: [String] = []
        let queued = environment.center.pending.count
        if queued > 0 { lines.append("\(Phrases.count(queued, "action")) on this phone waiting to be sent.") }
        let refused = environment.center.rejected.count
        if refused > 0 { lines.append("\(Phrases.count(refused, "action")) refused by the server; review them.") }
        if let p = status.value?.pending {
            if p.effects > 0 { lines.append("\(Phrases.count(p.effects, "update")) committed and not yet delivered (Calendar or notifications).") }
            if p.runsNeedingInput > 0 { lines.append("\(Phrases.count(p.runsNeedingInput, "question")) waiting for your answer in Conversation.") }
        }
        return lines.isEmpty ? ["Nothing is pending."] : lines
    }

    public var issues: [RecoveryStatus.ConnectionIssuesItem] { status.value?.connectionIssues ?? [] }

    public func retryPending() async {
        await environment.center.replay()
        await status.refresh()
    }

    public var diagnostics: [(key: String, value: String)] {
        (status.value?.diagnostics ?? [:]).sorted { $0.key < $1.key }.map { key, value in
            (key, value.stringValue ?? (try? String(decoding: GarderobeJSON.encode(value), as: UTF8.self)) ?? "")
        }
    }
}

/// Export my wardrobe: one private package with manifest and checksums. A partial package is
/// never reported as complete, and the downloaded bytes are checked against the job's hash.
@MainActor
@Observable
public final class ExportModel {
    public struct Download: Sendable, Equatable {
        public var fileName: String
        public var data: Data
        public var sha256: String
        /// True when the backend published a hash and the downloaded bytes match it.
        public var verified: Bool
    }

    public let environment: AppEnvironment
    public private(set) var job: ExportJob?
    public private(set) var download: Download?
    public private(set) var message: String?
    public private(set) var isWorking = false

    public init(environment: AppEnvironment) {
        self.environment = environment
        if let id: String = environment.restoration.load("export.request") { requestId = id }
    }

    /// The stable request ID: starting again after a lost response resumes the same job.
    private var requestId: String?

    public func start(passphrase: String?) async {
        let id = requestId ?? environment.ids.next("export")
        requestId = id
        environment.restoration.save("export.request", id)
        let pass = passphrase.flatMap { $0.isEmpty ? nil : $0 }
        await run { self.job = try await self.environment.api.startExport(ExportRequest(clientRequestId: id, passphrase: pass)) }
    }

    /// Reads the job's current state (the job runs on the backend and survives closing the app).
    public func refresh() async {
        guard let id = job?.exportId else {
            await run { self.job = try await self.environment.api.exports().exports.sorted { $0.requestedAt > $1.requestedAt }.first }
            return
        }
        await run { self.job = try await self.environment.api.export(id: id) }
    }

    public var isFinished: Bool {
        guard let state = job?.state else { return false }
        return [.completed, .completedIncomplete, .failed, .expired].contains(state)
    }

    public var canDownload: Bool { job.map { $0.state == .completed || $0.state == .completedIncomplete } ?? false }

    /// The status sentence. "Complete" is used only when every component is complete.
    public var statusLine: String {
        guard let job else { return "No export has been started." }
        switch job.state {
        case .queued: return "The export is queued."
        case .running: return "The export is being prepared. You can leave this screen; it continues on the server."
        case .completed where job.complete: return "The export is complete" + (job.encrypted ? " and encrypted with your passphrase." : ".")
        case .completed, .completedIncomplete:
            let missing = job.components.filter { $0.state != .complete }.map(\.name)
            return "The export finished but is incomplete: \(Phrases.list(missing)) could not be fully included."
        case .failed: return "The export failed. Start it again."
        case .expired: return "This export has expired. Start a new one."
        case .unknown: return "The export is in a state this version does not recognise."
        }
    }

    public func componentLine(_ c: ExportComponent) -> String {
        let state: String
        switch c.state {
        case .complete: state = "complete"
        case .incomplete: state = "incomplete"
        case .pending: state = "pending"
        case .unavailable: state = "not available"
        case .unknown: state = "unknown"
        }
        return "\(c.name): \(Phrases.count(c.records, "record")), \(state)" + (c.note.map { " (\($0))" } ?? "")
    }

    /// Requests a short-lived ticket and downloads the package, verifying its checksum.
    public func fetchPackage() async {
        guard let job, canDownload else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let ticket = try await environment.api.exportTicket(id: job.exportId)
            let data = try await environment.api.download(ticket: ticket)
            let hash = SHA256.hex(data)
            if let expected = job.sha256, expected != hash {
                download = nil
                message = "The downloaded package did not match its checksum and was discarded. Download it again."
                return
            }
            download = Download(fileName: ticket.fileName, data: data, sha256: hash, verified: job.sha256 != nil)
            environment.restoration.clear("export.request")
            requestId = nil
            message = nil
        } catch let failure as APIFailure {
            message = failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            message = "The package could not be downloaded."
        }
    }

    private func run(_ work: @escaping () async throws -> Void) async {
        isWorking = true
        defer { isWorking = false }
        do {
            try await work()
            message = nil
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            message = failure.ownerMessage
            environment.center.noteRead(failure: failure)
        } catch {
            message = "That could not be completed."
        }
    }
}
