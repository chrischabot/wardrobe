import SwiftUI
import UIKit
import UserNotifications
import GarderobeKit

/// The app's link to Apple's notification service. It only carries what iOS reports
/// (permission, the device token, a registration failure) to `NotificationsModel`; what is
/// registered with the backend, and what the owner is told, is the model's business.
@MainActor
final class PushRegistrar: NSObject, UIApplicationDelegate {
    /// The model of the app that is on screen now (the app model changes when demo mode starts or ends).
    static weak var current: NotificationsModel?

    /// Which of Apple's two services issues this build's tokens: what the build was signed for
    /// (the provisioning profile's `aps-environment`), and only without a profile the kind of
    /// build (an App Store or TestFlight build carries none and is production).
    static let apnsEnvironment: DeviceRegistration.Environment = {
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        #if targetEnvironment(simulator)
        let simulator = true
        #else
        let simulator = false
        #endif
        #if DEBUG
        let debug = true
        #else
        let debug = false
        #endif
        return PushEnvironment.resolve(profile: profile, isSimulator: simulator, isDebugBuild: debug)
    }()

    /// Makes this the model iOS reports to, and gives it the one thing only the platform can
    /// do for it: telling iOS to stop delivering to this app.
    private static func attach(_ model: NotificationsModel) {
        current = model
        model.stopReceiving = { UIApplication.shared.unregisterForRemoteNotifications() }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let model = PushRegistrar.current else { return }
        Task { await model.register(token: deviceToken, apns: PushRegistrar.apnsEnvironment) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistrar.current?.registrationFailed(error.localizedDescription)
    }

    nonisolated private static func permission(_ status: UNAuthorizationStatus) -> NotificationPermission {
        switch status {
        case .authorized, .provisional, .ephemeral: return .authorized
        case .denied: return .denied
        default: return .notDetermined
        }
    }

    /// On launch and when the app returns: read the permission, and when the owner has turned
    /// notifications on and iOS allows them, ask Apple for the current token so the backend's
    /// copy is refreshed. Never shows a permission prompt, and does nothing in demo mode.
    static func refresh(_ model: NotificationsModel, isDemo: Bool) {
        current = model
        guard !isDemo else { return }
        attach(model)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let value = PushRegistrar.permission(settings.authorizationStatus)
            Task { @MainActor in
                model.setPermission(value)
                if value == .authorized, model.shouldRequestToken { UIApplication.shared.registerForRemoteNotifications() }
            }
        }
    }

    /// The owner turned notifications on: ask iOS for permission (the system prompt appears
    /// only the first time), then for a token.
    static func turnOn(_ model: NotificationsModel) {
        attach(model)
        model.turnOn()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in
                model.setPermission(granted ? .authorized : .denied)
                if granted { UIApplication.shared.registerForRemoteNotifications() }
            }
        }
    }
}
