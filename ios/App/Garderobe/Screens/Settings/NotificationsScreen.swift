import SwiftUI
import GarderobeKit

/// Notifications on this phone: on or off, and what the backend holds. The morning board,
/// reminders and return deadlines are sent by the backend; this screen only registers the phone.
struct NotificationsScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let model = app.notifications
        List {
            Section {
                Toggle("Notifications on this phone", isOn: Binding(
                    get: { model.isOn },
                    set: { on in
                        if on { PushRegistrar.turnOn(model) } else { Task { await model.turnOff() } }
                    }))
                    .disabled(model.isWorking || app.environment.isDemo)
                Text(model.statusLine)
                    .font(.footnote)
                    .foregroundStyle(Color.supporting)
                SettingsMessageLine(message: model.message)
                if model.hasStoppedRetrying {
                    Button("Try again") { Task { await model.retryNow() } }
                        .disabled(model.isWorking)
                }
                if app.environment.isDemo {
                    Text("Demo data: notifications cannot be turned on here.")
                        .font(.footnote)
                        .foregroundStyle(Color.supporting)
                }
            } footer: {
                Text("When they are on, your morning outfits, reminders you asked for and return deadlines can arrive as notifications. Delivery is best effort: the board in the app and the calendar event do not depend on it.")
            }
            if !model.otherDevices.isEmpty {
                Section("Other devices") {
                    ForEach(model.otherDevices, id: \.deviceId) { device in
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(model.statusWord(device))
                            Text("Last updated \(SettingsInstant(app: app).relative(device.updatedAt)).")
                                .font(.footnote)
                                .foregroundStyle(Color.supporting)
                        }
                    }
                }
            }
            Section {
                SettingsFreshnessLabel(freshness: model.devices.freshness, subject: "registration")
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.devices.refresh() }
        .task {
            await model.open()
            PushRegistrar.refresh(model, isDemo: app.environment.isDemo)
        }
    }
}
