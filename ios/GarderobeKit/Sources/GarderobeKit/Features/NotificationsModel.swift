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
    }
    private var pending: Pending? {
        didSet { if let pending { environment.restoration.save("notifications.pending", pending) } else { environment.restoration.clear("notifications.pending") } }
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
        pending = environment.restoration.load("notifications.pending")
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
        pending = Pending(token: hex, apns: apns.rawValue, removal: false)
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
        pending = Pending(token: nil, apns: nil, removal: true)
        return await sendPending()
    }

    /// Sends a registration or removal that is still waiting. Called when the app synchronises.
    @discardableResult
    public func retryPending() async -> Bool {
        guard pending != nil else { return true }
        return await sendPending()
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
                _ = try await environment.api.registerDevice(DeviceRegistration(deviceId: deviceId, token: token, environment: apns))
            }
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
            } else if failure.isRetryable || failure.needsSignIn {
                // The backend did not decide it (a server fault, a rate limit, an expired sign-in):
                // it stays waiting and goes again when the app next synchronises.
                message = current.removal
                    ? "Not stopped yet: \(failure.ownerMessage) This will be tried again."
                    : "Not registered yet: \(failure.ownerMessage) This will be tried again."
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

    /// One sentence on where this phone stands, from what the backend and iOS report.
    public var statusLine: String {
        if let pending {
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

    public var freshnessLine: String {
        devices.freshness.statement(subject: "registration", now: environment.time.now(), timeZone: environment.timeZone)
    }
}
