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

        func sameRequest(as other: Pending) -> Bool { token == other.token && apns == other.apns && removal == other.removal }
    }
    private var pending: Pending? {
        didSet { if let pending { environment.restoration.save("notifications.pending", pending) } else { environment.restoration.clear("notifications.pending") } }
    }
    /// A registration has left this phone at some point and no removal has been confirmed since,
    /// so the backend may hold this installation even when the list on screen does not show it.
    private var mayBeRegistered: Bool { didSet { environment.restoration.save("notifications.sent", mayBeRegistered) } }

    /// Set by the platform layer: tells iOS to stop delivering notifications to this app. It is
    /// called when the owner turns notifications off and when they sign out, whatever the
    /// backend answers.
    public var stopReceiving: (@MainActor () -> Void)?

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
        let savedWanted: Bool = environment.restoration.load("notifications.wanted") ?? false
        wanted = savedWanted
        pending = environment.restoration.load("notifications.pending")
        // An installation from before this was kept: if the owner had notifications on, it registered.
        mayBeRegistered = environment.restoration.load("notifications.sent") ?? savedWanted
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
        let request = Pending(token: hex, apns: apns.rawValue, removal: false)
        // The same registration already waiting keeps its place in the retry schedule: iOS hands
        // over the token on every launch, and that must not turn a backoff into a retry per launch.
        if let waiting = pending, waiting.sameRequest(as: request) { return await retryPending() }
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
        stopReceiving?()
        // Nothing ever left this phone and the backend lists no registration for it: there is
        // nothing to remove, so nothing is sent.
        guard mayBeRegistered || thisDevice != nil else {
            pending = nil
            message = nil
            return true
        }
        pending = Pending(token: nil, apns: nil, removal: true)
        return await sendPending()
    }

    /// Sends a registration or removal that is still waiting. Called when the app synchronises.
    /// A request the backend left undecided waits out its delay first, and one that reached
    /// `retryLimit` is not sent from here at all.
    @discardableResult
    public func retryPending() async -> Bool {
        guard let current = pending else { return true }
        if hasStoppedRetrying { return false }
        if let wait = current.notBefore, environment.time.now() < wait { return false }
        return await sendPending()
    }

    /// The owner asked for a waiting request to be sent now: it starts over.
    @discardableResult
    public func retryNow() async -> Bool {
        guard var current = pending else { return true }
        current.attempts = nil
        current.notBefore = nil
        pending = current
        return await sendPending()
    }

    /// The owner is signing out on this phone. iOS is told to stop delivering, the backend is
    /// asked once to forget this installation while the session still exists, and nothing stays
    /// waiting: a request kept past sign-out could only be sent as whoever signs in next.
    public func signingOut() async {
        let registered = mayBeRegistered || thisDevice != nil
        wanted = false
        stopReceiving?()
        pending = nil
        message = nil
        guard registered, !environment.isDemo else { return }
        if (try? await environment.api.removeDevice(id: deviceId)) != nil { mayBeRegistered = false }
    }

    private func sendPending() async -> Bool {
        guard let current = pending, !isWorking else { return false }
        isWorking = true
        defer { isWorking = false }
        message = nil
        do {
            if current.removal {
                _ = try await environment.api.removeDevice(id: deviceId)
            } else if let token = current.token, let apns = current.apns.flatMap(DeviceRegistration.Environment.init(rawValue:)) {
                // From here the backend may hold this installation, whatever comes back.
                mayBeRegistered = true
                _ = try await environment.api.registerDevice(DeviceRegistration(deviceId: deviceId, token: token, environment: apns))
            }
            mayBeRegistered = !current.removal
            if pending == current { pending = nil }
            environment.center.noteRead(failure: nil)
            await devices.refresh()
            return true
        } catch let failure as APIFailure {
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
                    kept.notBefore = environment.time.now().addingTimeInterval(NotificationsModel.retryDelay(afterAttempts: attempts))
                    message = (current.removal ? "Not stopped yet: " : "Not registered yet: ") + reason + " It will be tried again later."
                }
                if pending == current { pending = kept }
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
