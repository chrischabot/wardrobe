import SwiftUI
import GarderobeKit

/// One connection as a list section: its name, its state in a sentence, any missing permission
/// (named by the capability it affects), its capabilities, and Reconnect / Disconnect. A broken
/// connection shows its own line here and blocks nothing else.
struct ConnectionSection: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let connection: ApiConnection
    @State private var confirmsDisconnect = false

    var body: some View {
        let settings = app.settings
        Section {
            Label(settings.stateLine(connection), systemImage: symbol)
            if let issue = connection.issue, connection.state != .error {
                // In the error state the model's sentence already carries the issue.
                SettingsMessageLine(message: issue.message)
            }
            ForEach(settings.missingPermissions(connection), id: \.self) { line in
                Label(line, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
            }
            if connection.state != .disconnected {
                ForEach(connection.capabilities, id: \.key) { capability in
                    Toggle(isOn: Binding(get: { capability.enabled },
                                         set: { enabled in Task { await settings.setCapability(connection, key: capability.key, enabled: enabled) } })) {
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(capability.label)
                            Text(capabilityNote(capability))
                                .font(.footnote)
                                .foregroundStyle(Color.supporting)
                        }
                    }
                    .disabled(settings.isWorking)
                }
            }
            Button("Reconnect") {
                Task {
                    await settings.reconnect(connection)
                    if let url = settings.authorizationURL {
                        openURL(url)
                        settings.authorizationOpened()
                    }
                }
            }
            .disabled(settings.isWorking)
            .accessibilityLabel("Reconnect \(connection.name)")
            if connection.state != .disconnected {
                Button("Disconnect", role: .destructive) { confirmsDisconnect = true }
                    .disabled(settings.isWorking)
                    .accessibilityLabel("Disconnect \(connection.name)")
                    .confirmationDialog("Disconnect \(connection.name)?", isPresented: $confirmsDisconnect, titleVisibility: .visible) {
                        Button("Disconnect", role: .destructive) {
                            Task { await settings.disconnect(connection) }
                        }
                        Button("Keep connected", role: .cancel) {}
                    } message: {
                        Text("Garderobe stops using this connection. Whether its stored credentials were removed and the provider confirmed the revocation is reported afterwards. The wardrobe, Today and Conversation keep working.")
                    }
            }
        } header: {
            Text(connection.name)
        }
    }

    /// A symbol beside the state sentence, so the state is not carried by colour.
    private var symbol: String {
        switch connection.state {
        case .connected: return "checkmark.circle"
        case .pendingAuthorization: return "hourglass"
        case .needsReconnect, .error: return "exclamationmark.triangle"
        case .disconnected: return "xmark.circle"
        case .unknown: return "questionmark.circle"
        }
    }

    private func capabilityNote(_ capability: ConnectionCapability) -> String {
        switch capability.effect {
        case .read: return "Reads only"
        case .write: return "Can write"
        case .unknown: return "Access"
        }
    }
}
