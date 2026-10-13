import Foundation
import Observation

/// What iOS says about this app's permission to show notifications. The platform layer reports
/// it; this package never asks for it.
public enum NotificationPermission: String, Codable, Sendable, Equatable {
    case notDetermined, denied, authorized
}

/// Notifications on this phone: whether it is registered with the backend, and the owner's
/// switch for it. The phone only hands the backend the address Apple gave it; what is sent, and
/// when, is the backend's decision (morning board, reminders, return deadlines), and delivery is
/// best effort. Nothing here asks for permission by itself: the owner turns notifications on.
@MainActor
@Observable
public final class NotificationsModel {
    public let environment: AppEnvironment
    public let devices: Resource<DeviceList>
    /// A stable identifier for this installation, created once. It is not the token.
    public let deviceId: String
    public private(set) var permission: NotificationPermission = .notDetermined
    /// The owner asked for notifications on this phone. Kept across launches so the token is
    /// refreshed when the app opens, and cleared when the owner turns them off.
    public private(set) var wanted: Bool { didSet { environment.restoration.save("notifications.wanted", wanted) } }
    public private(set) var isWorking = false
    /// What went wrong with the last attempt, in a sentence the owner can read.
    public private(set) var message: String?

    /// A registration or removal the backend has not confirmed yet (for example offline). It is
    /// sent again when the app next synchronises; it is never reported as done before that.
    private struct Pending: Codable, Equatable {
        var token: String?
        var apns: String?
        var removal: Bool
        /// How many times the backend answered without deciding it (a server fault, a rate limit).
        /// Absent in a request saved by an earlier version of the app.
        var attempts: Int?
        /// It is not sent again automatically before this moment.
        var notBefore: Date?
        /// The account that was signed in when the request was made (`MeResponse.userId`). It is
        /// only ever sent while that same account is signed in. Absent in a request saved by an
        /// earlier version of the app, or made before the account was known.
        var account: String?

        func sameRequest(as other: Pending) -> Bool { token == other.token && apns == other.apns && removal == other.removal && account == other.account }
    }
    private var pending: Pending? {
        didSet { if let pending { environment.restoration.save("notifications.pending", pending) } else { environment.restoration.clear("notifications.pending") } }
    }
    /// A registration has left this phone at some point and no removal has been confirmed since,
    /// so the backend may hold this installation even when the list on screen does not show it.
    private var mayBeRegistered: Bool {
        didSet {
            environment.restoration.save("notifications.sent", mayBeRegistered)
            if !mayBeRegistered { registeredAccount = nil }
        }
    }
    /// The account the last registration that left this phone was made for. A removal belongs
    /// to that account: only it can ask the backend to forget its registration.
    private var registeredAccount: String? {
        didSet { if let registeredAccount { environment.restoration.save("notifications.sentAccount", registeredAccount) } else { environment.restoration.clear("notifications.sentAccount") } }
    }
    /// The request being sent now, so signing out can wait for it instead of racing it.
    private var inFlight: Task<Bool, Never>?
    /// Counts sign-outs: an answer that arrives for a request sent before one changes nothing.
    private var epoch = 0

    /// Set by the platform layer: tells iOS to stop delivering notifications to this app. It is
    /// called when the owner turns notifications off and when they sign out, whatever the
    /// backend answers.
    public var stopReceiving: (@MainActor () -> Void)?

    /// Set by the app: the account signed in now (`MeResponse.userId`), or nil while none is
    /// verified (signed out, still loading, offline). A waiting request made by one account is
    /// never sent under another: it waits while no account is known and is dropped when a
    /// different one signs in. Unset, requests are not tied to an account.
    public var currentAccount: (@MainActor () -> String?)?

    /// The longest wait a backend's `Retry-After` is followed for.
    public static let longestRetryAfter: TimeInterval = 86_400

    /// Who may send a waiting request now.
    private enum Sender { case thisAccount, unknownYet, otherAccount }
    private func sender(for request: Pending) -> Sender {
        guard let currentAccount else { return .thisAccount }
        guard let now = currentAccount() else { return .unknownYet }
        // Made before any account was known (or by an earlier version): whose it was cannot be
        // shown, so it is not sent as whoever is signed in now.
        guard let owner = request.account else { return .otherAccount }
        return now == owner ? .thisAccount : .otherAccount
    }

    /// A token iOS handed over while no account was verified yet (at launch, before the account
    /// has loaded). Held in memory only, never in place of a waiting request, and registered once
    /// an account is verified, as the next launch would. Cleared by turning off and signing out.
    private var deferredToken: (hex: String, apns: DeviceRegistration.Environment)?

    /// Whether a waiting request may be sent now. One that belongs to another account is
    /// dropped: a registration must not be made, nor a removal asked for, as someone else.
    private func mayBeSentNow(_ request: Pending) -> Bool {
        switch sender(for: request) {
        case .thisAccount: return true
        case .unknownYet: return false
        case .otherAccount:
            pending = nil
            message = nil
            return false
        }
    }

    /// The wait before the next automatic try after an answer that decided nothing: the backoff,
    /// or longer when the backend said how long to wait (`Retry-After`), up to a day.
    static func wait(afterAttempts attempts: Int, failure: APIFailure) -> TimeInterval {
        max(retryDelay(afterAttempts: attempts), min(failure.retryAfter ?? 0, longestRetryAfter))
    }

    /// After this many answers that decided nothing, a waiting request is no longer sent
    /// automatically; the owner can send it again from the screen.
    public static let retryLimit = 6
    /// The wait before the next automatic try: one minute, doubling, at most an hour.
    static func retryDelay(afterAttempts attempts: Int) -> TimeInterval {
        min(60 * pow(2, Double(max(attempts, 1) - 1)), 3600)
    }

    public init(environment: AppEnvironment) {
        self.environment = environment
        if let saved: String = environment.restoration.load("notifications.deviceId") {
            deviceId = saved
        } else {
            let created = environment.ids.next("device")
            environment.restoration.save("notifications.deviceId", created)
            deviceId = created
        }
        wanted = environment.restoration.load("notifications.wanted") ?? false
        let waiting: Pending? = environment.restoration.load("notifications.pending")
        pending = waiting
        // An installation from before this was kept has no record of it. The owner's switch is
        // not evidence (it can be on with permission refused and no token ever sent); a request
        // that was waiting is: a registration may have reached the backend, and a removal was
        // only ever made for a phone that had registered. Anything else is settled by the
        // backend's own list (`thisDevice`).
        mayBeRegistered = environment.restoration.load("notifications.sent") ?? (waiting != nil)
        registeredAccount = environment.restoration.load("notifications.sentAccount")
        let api = environment.api
        devices = environment.resource("devices") { try await api.devices() }
    }

    /// Shows the saved answer at once, then checks it.
    public func open() async {
        devices.loadCached()
        await devices.refresh()
    }

    /// This installation's registration as the backend holds it, if any.
    public var thisDevice: Device? { devices.value?.devices.first { $0.deviceId == deviceId } }
    public var isRegistered: Bool { thisDevice?.status == .active }
    public var isWaitingToSend: Bool { pending != nil }
    /// What the switch shows: the owner asked for notifications and iOS has not refused them.
    /// After a refusal the switch is off and the status line says where to allow them.
    public var isOn: Bool { wanted && permission != .denied }
    /// A waiting request the backend left undecided `retryLimit` times: it is kept, and sent
    /// again only when the owner asks (`retryNow`).
    public var hasStoppedRetrying: Bool { (pending?.attempts ?? 0) >= NotificationsModel.retryLimit }

    /// The platform reports the current permission (on launch and after the owner answers).
    public func setPermission(_ value: NotificationPermission) { permission = value }

    /// The owner turned notifications on. The platform layer then asks iOS for permission and
    /// for a token; `register` is called when the token arrives.
    public func turnOn() {
        wanted = true
        message = nil
        if pending?.removal == true { pending = nil }
    }

    /// Whether the platform layer should ask Apple for a token now: the owner wants
    /// notifications and iOS has not refused them.
    public var shouldRequestToken: Bool { wanted && permission != .denied }

    /// Apple gave this installation a token: hand it to the backend. Returns true when the
    /// backend confirmed it. Offline, the token is kept and sent on the next synchronisation.
    @discardableResult
    public func register(token: Data, apns: DeviceRegistration.Environment) async -> Bool {
        guard wanted else { return false }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        return await register(hex: hex, apns: apns)
    }

    private func register(hex: String, apns: DeviceRegistration.Environment) async -> Bool {
        guard wanted else { return false }
        // No verified account yet: the token waits in memory for one, and a request already
        // waiting for an account keeps its owner and its place in the retry schedule.
        if let currentAccount, currentAccount() == nil {
            deferredToken = (hex, apns)
            return false
        }
        deferredToken = nil
        let request = Pending(token: hex, apns: apns.rawValue, removal: false, account: currentAccount?())
        // A registration replacing one that waits for the same account (iOS handed over a new
        // token or service) takes over its place in the retry schedule instead of starting over.
        if let waiting = pending, !waiting.removal, waiting.account == request.account {
            var replacement = request
            replacement.attempts = waiting.attempts
            replacement.notBefore = waiting.notBefore
            pending = replacement
            return await retryPending()
        }
        pending = request
        return await sendPending()
    }

    /// Apple did not give a token (no network, no push entitlement, a simulator without one).
    public func registrationFailed(_ reason: String) {
        message = "This phone could not get a notification address from Apple: \(reason)"
    }

    /// The owner turned notifications off for this phone. The backend is told to stop; offline,
    /// that request is kept and sent later, and the screen says so.
    @discardableResult
    public func turnOff() async -> Bool {
        wanted = false
        deferredToken = nil
        stopReceiving?()
        // What the backend last listed counts as evidence even when this screen was never opened.
        if devices.value == nil { devices.loadCached() }
        // Nothing ever left this phone and the backend lists no registration for it: there is
        // nothing to remove, so nothing is sent.
        guard mayBeRegistered || thisDevice != nil else {
            pending = nil
            message = nil
            return true
        }
        // The removal belongs to the account the registration was made for (or, when that is not
        // recorded, the one signed in). It goes now only when that account is signed in; while no
        // account is verified it waits, and one that belongs to another account is not asked for.
        let removal = Pending(token: nil, apns: nil, removal: true, account: registeredAccount ?? currentAccount?())
        pending = removal
        guard mayBeSentNow(removal) else { return pending == nil }
        return await sendPending()
    }

    /// Sends a registration or removal that is still waiting. Called when the app synchronises.
    /// A request the backend left undecided waits out its delay first, and one that reached
    /// `retryLimit` is not sent from here at all. A request made by another account is dropped
    /// unsent (and true is returned, as nothing waits any more); while no account is known it waits.
    @discardableResult
    public func retryPending() async -> Bool {
        // A token that arrived before the account was known is registered now that it is.
        if let deferred = deferredToken, wanted, let currentAccount, currentAccount() != nil {
            return await register(hex: deferred.hex, apns: deferred.apns)
        }
        guard let current = pending else { return true }
        guard mayBeSentNow(current) else { return pending == nil }
        if hasStoppedRetrying { return false }
        if let wait = current.notBefore, environment.time.now() < wait { return false }
        return await sendPending()
    }

    /// The owner asked for a waiting request to be sent now: it starts over.
    @discardableResult
    public func retryNow() async -> Bool {
        guard var current = pending else { return true }
        guard mayBeSentNow(current) else { return pending == nil }
        current.attempts = nil
        current.notBefore = nil
        pending = current
        return await sendPending()
    }

    /// The owner is signing out on this phone. iOS is told to stop delivering, and the backend is
    /// asked to forget this installation while the session still exists. When that request gets
    /// no decision (offline, a server fault, an expired session) it is kept for the account that
    /// is signing out and sent when that account signs in again; it is never sent as anyone else,
    /// and without a known account nothing is kept.
    public func signingOut() async {
        // No new request starts from here (`register` needs `wanted`), and iOS stops delivering.
        wanted = false
        deferredToken = nil
        stopReceiving?()
        let leaving = currentAccount?()
        // A registration on its way is let through first: removing before it lands would leave
        // this phone registered after the sign-out. Its answer no longer changes anything here.
        epoch += 1
        if let running = inFlight { _ = await running.value }
        if devices.value == nil { devices.loadCached() }
        let registered = mayBeRegistered || thisDevice != nil
        let owner = registeredAccount ?? leaving
        pending = nil
        message = nil
        guard registered, !environment.isDemo else { return }
        // The same gate as every other request: only the account the registration belongs to asks
        // the backend to forget it. Another account's registration is not asked for as this one;
        // with no account verified, it is kept for its account and sent when that account signs in.
        let removal = Pending(token: nil, apns: nil, removal: true, account: owner)
        switch sender(for: removal) {
        case .otherAccount: return
        case .unknownYet:
            if owner != nil { pending = removal }
            return
        case .thisAccount: break
        }
        do {
            _ = try await environment.api.removeDevice(id: deviceId)
            mayBeRegistered = false
        } catch let failure as APIFailure {
            if NotificationsModel.isNotFound(failure) { mayBeRegistered = false; return }
            // A refusal is an answer; only an undecided request is kept, and only for its account.
            guard let owner, failure.isRetryable || failure.needsSignIn else { return }
            var kept = Pending(token: nil, apns: nil, removal: true, account: owner)
            if failure.isRetryable && !failure.isTransport {
                kept.attempts = 1
                kept.notBefore = environment.time.now().addingTimeInterval(NotificationsModel.wait(afterAttempts: 1, failure: failure))
            }
            pending = kept
        } catch {
            return
        }
    }

    /// Sends the waiting request, one at a time. The send is a task of its own so that signing
    /// out can wait for it to finish.
    private func sendPending() async -> Bool {
        guard pending != nil, !isWorking else { return false }
        isWorking = true
        let sentIn = epoch
        let task = Task { @MainActor [self] in await deliver(sentIn: sentIn) }
        inFlight = task
        let result = await task.value
        inFlight = nil
        isWorking = false
        return result
    }

    private func deliver(sentIn: Int) async -> Bool {
        guard let current = pending else { return false }
        message = nil
        do {
            if current.removal {
                _ = try await environment.api.removeDevice(id: deviceId)
            } else if let token = current.token, let apns = current.apns.flatMap(DeviceRegistration.Environment.init(rawValue:)) {
                // From here the backend may hold this installation, whatever comes back.
                mayBeRegistered = true
                registeredAccount = current.account
                _ = try await environment.api.registerDevice(DeviceRegistration(deviceId: deviceId, token: token, environment: apns))
            }
            mayBeRegistered = !current.removal
            // The owner signed out while this was on its way: the sign-out removes what this
            // registered, and nothing else of the answer is kept.
            guard sentIn == epoch else { return !current.removal }
            if pending == current { pending = nil }
            environment.center.noteRead(failure: nil)
            await devices.refresh()
            return true
        } catch let failure as APIFailure {
            guard sentIn == epoch else { return false }
            environment.center.noteRead(failure: failure)
            if failure.isTransport {
                message = current.removal
                    ? "Offline. Notifications to this phone will be stopped when there is a connection."
                    : "Offline. This phone will be registered when there is a connection."
            } else if failure.needsSignIn {
                // Nothing was decided and nothing will be until the owner signs in: it stays waiting.
                message = current.removal ? "Sign in to finish stopping notifications to this phone."
                                          : "Sign in to finish registering this phone."
            } else if failure.isRetryable {
                // The backend did not decide it (a server fault, a rate limit): it stays waiting
                // and goes again later, each time after a longer wait, up to `retryLimit` times.
                let attempts = (current.attempts ?? 0) + 1
                var kept = current
                kept.attempts = attempts
                let reason = NotificationsModel.sentence(failure.ownerMessage)
                if attempts >= NotificationsModel.retryLimit {
                    kept.notBefore = nil
                    message = (current.removal ? "Not stopped: " : "Not registered: ") + reason
                        + " It was tried \(attempts) times and will not be tried again by itself."
                } else {
                    kept.notBefore = environment.time.now().addingTimeInterval(NotificationsModel.wait(afterAttempts: attempts, failure: failure))
                    message = (current.removal ? "Not stopped yet: " : "Not registered yet: ") + reason + " It will be tried again later."
                }
                if pending == current {
                    pending = kept
                } else if var replacement = pending, !replacement.removal, !current.removal, replacement.account == current.account {
                    // iOS handed over a new token while this was on its way: the registration that
                    // replaced it inherits this answer's attempt count and wait.
                    replacement.attempts = kept.attempts
                    replacement.notBefore = kept.notBefore
                    pending = replacement
                }
            } else if current.removal, NotificationsModel.isNotFound(failure) {
                // The backend holds no registration for this phone: that is what was asked for.
                mayBeRegistered = false
                if pending == current { pending = nil }
                await devices.refresh()
                return true
            } else {
                // The backend refused it: keeping it would only repeat the refusal.
                if pending == current { pending = nil }
                message = failure.ownerMessage
            }
            return false
        } catch {
            guard sentIn == epoch else { return false }
            message = "The request could not be sent."
            return false
        }
    }

    /// The backend's message as a sentence, so what follows it reads as the next one.
    static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last else { return "The server did not say why." }
        return ".!?".contains(last) ? trimmed : trimmed + "."
    }

    static func isNotFound(_ failure: APIFailure) -> Bool {
        switch failure {
        case .api(let status, let error): return status == 404 || error.code == .notFound
        case .status(let status): return status == 404
        default: return false
        }
    }

    /// One sentence on where this phone stands, from what the backend and iOS report.
    public var statusLine: String {
        if let pending {
            if sender(for: pending) == .unknownYet {
                return pending.removal ? "Notifications to this phone will be stopped on the server once you are signed in."
                                       : "This phone will be registered once you are signed in."
            }
            if hasStoppedRetrying {
                return pending.removal ? "Notifications to this phone have not been stopped on the server. Try again when you are ready."
                                       : "This phone has not been registered. Try again when you are ready."
            }
            if (pending.attempts ?? 0) > 0 {
                return pending.removal ? "Waiting to stop notifications to this phone. It will be tried again later."
                                       : "Waiting to register this phone. It will be tried again later."
            }
            return pending.removal ? "Waiting to stop notifications to this phone when there is a connection."
                                   : "Waiting to register this phone when there is a connection."
        }
        if permission == .denied { return "Notifications are turned off for Garderobe in iPhone Settings." }
        guard let list = devices.value else { return "Whether this phone is registered has not been checked yet." }
        guard let device = thisDevice else { return "This phone is not registered for notifications." }
        switch device.status {
        case .active:
            guard list.deliveryConfigured else { return "This phone is registered, but the backend is not set up to send notifications yet." }
            if let last = device.lastDeliveryAt.flatMap(Dates.parseInstant) {
                return "This phone is registered. Last notification sent \(Phrases.relativeTime(last, now: environment.time.now(), timeZone: environment.timeZone))."
            }
            return "This phone is registered. Nothing has been sent to it yet."
        case .disabled:
            if let reason = device.disabledReason, !reason.isEmpty { return "Notifications to this phone have stopped: \(reason)" }
            return "Notifications to this phone have stopped."
        case .unknown:
            return "This phone's registration is in a state this version does not recognise."
        }
    }

    /// Other installations registered for the same owner (an old phone, an iPad).
    public var otherDevices: [Device] { (devices.value?.devices ?? []).filter { $0.deviceId != deviceId } }

    /// One word for another device's registration, as the backend reports it.
    public func statusWord(_ device: Device) -> String {
        switch device.status {
        case .active: return "Registered"
        case .disabled: return "Stopped"
        case .unknown: return "Not recognised by this version"
        }
    }

    public var freshnessLine: String {
        devices.freshness.statement(subject: "registration", now: environment.time.now(), timeZone: environment.timeZone)
    }
}
