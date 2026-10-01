import SwiftUI
import GarderobeKit

/// Connections: Gmail and Calendar (Google) first, then search and other connections. Nothing
/// here asks for a secret or a token: connecting is finished in the system browser. A broken
/// connection is one line in its own section and never blocks the rest of the app.
struct ConnectionsScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let settings = app.settings
        let connections = settings.orderedConnections
        List {
            Section {
                SettingsFreshnessLabel(freshness: settings.connections.freshness, subject: "connections")
                SettingsMessageLine(message: settings.message)
                if let line = settings.disconnectLine {
                    Label(line, systemImage: "info.circle")
                        .font(.footnote)
                }
                Text("Gmail is used to find order receipts, and Calendar to read the day and write the outfit calendar. These are separate from your sign-in.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .onChange(of: scenePhase) { _, phase in
                        // Back from the browser: read the connection states again.
                        if phase == .active { Task { await settings.connections.refresh() } }
                    }
            }
            if !hasUsableGoogle(connections) {
                Section {
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
                } header: {
                    Text("Gmail and Calendar")
                } footer: {
                    Text("You approve access on Google's own page in the browser. No password or token is entered here.")
                }
            }
            ForEach(connections) { connection in
                ConnectionSection(connection: connection)
            }
            if settings.googleConnection != nil {
                Section {
                    NavigationLink {
                        OutfitCalendarScreen()
                    } label: {
                        Label("Outfit calendar and calendars read", systemImage: "calendar")
                    }
                }
            }
        }
        .navigationTitle("Connections")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await settings.connections.refresh() }
    }

    /// True when a Google connection exists that has not been disconnected; otherwise the
    /// screen offers "Connect Google".
    private func hasUsableGoogle(_ connections: [ApiConnection]) -> Bool {
        connections.contains { $0.kind == .googleWorkspace && $0.state != .disconnected }
    }
}

/// The outfit calendar and the calendars read for the day, reachable after first use.
struct OutfitCalendarScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        List {
            OutfitCalendarControls()
            Section {
                OutcomeLine(outcome: app.settings.lastOutcome)
                SettingsMessageLine(message: app.settings.message)
            }
        }
        .navigationTitle("Outfit calendar")
        .navigationBarTitleDisplayMode(.inline)
    }
}
