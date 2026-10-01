import SwiftUI
import GarderobeKit

/// Step 1: what is already here. The wardrobe and the style profile were imported; nothing
/// needs filling in.
struct FirstUseWelcomeStep: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Section {
            Text(app.firstUse.importedLine(counts: app.wardrobe.counts))
            FreshnessLabel(text: app.wardrobe.freshnessLine, freshness: app.wardrobe.snapshot.freshness)
        } footer: {
            Text("The next steps connect Google, choose the outfit calendar, and confirm your location and morning time. Each one can be skipped and changed later in Settings.")
        }
    }
}

/// Step 2: connect Google, which is separate from the sign-in. The owner finishes in the system
/// browser; nothing secret is typed or copied on the phone. Skippable.
struct FirstUseConnectStep: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let settings = app.settings
        Section {
            Text("Google is a separate connection from your sign-in. It lets Garderobe read your calendar for the day, write the outfit calendar, and find order receipts in Gmail.")
            Label(app.firstUse.googleConnected ? "Google is connected." : "Google is not connected.",
                  systemImage: app.firstUse.googleConnected ? "checkmark.circle" : "circle.dashed")
                .onChange(of: scenePhase) { _, phase in
                    // Back from the browser: read the connection state again.
                    if phase == .active { Task { await settings.connections.refresh() } }
                }
            SettingsFreshnessLabel(freshness: settings.connections.freshness, subject: "connections")
        }
        Section {
            if !app.firstUse.googleConnected {
                Button(settings.isWorking ? "Opening..." : "Connect Google") {
                    Task {
                        await settings.connectGoogle()
                        if let url = settings.authorizationURL {
                            openURL(url)
                            settings.authorizationOpened()
                        }
                    }
                }
                .disabled(settings.isWorking)
                Button("Check the connection") {
                    Task { await settings.connections.refresh() }
                }
                .disabled(settings.connections.isRefreshing)
            }
            SettingsMessageLine(message: settings.message)
        } footer: {
            Text("You approve access on Google's page in the browser and come back here. You can skip this: Today works without Calendar.")
        }
    }
}

/// Step 4: confirm the home location, the morning time and the number of daily options.
struct FirstUseDeliveryStep: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        DeliveryControls()
        Section {
            OutcomeLine(outcome: app.settings.lastOutcome)
            SettingsMessageLine(message: app.settings.message)
            SettingsFreshnessLabel(freshness: app.settings.settings.freshness, subject: "settings")
        }
    }
}
