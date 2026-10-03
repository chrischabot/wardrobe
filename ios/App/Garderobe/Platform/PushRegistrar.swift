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

    /// Which of Apple's two services issued this build's tokens: development for a debug build
    /// run from Xcode, production for TestFlight and release builds.
    static var apnsEnvironment: DeviceRegistration.Environment {
        #if DEBUG
        return .development
        #else
        return .production
        #endif
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
        current = model
        model.turnOn()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in
                model.setPermission(granted ? .authorized : .denied)
                if granted { UIApplication.shared.registerForRemoteNotifications() }
            }
        }
    }
}
