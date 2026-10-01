import SwiftUI
import GarderobeKit

/// One connection issue on the recovery screen: the connection, what it affects, the backend's
/// message, and the single action that applies (Reconnect or Retry).
struct RecoveryIssueRow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let issue: RecoveryStatus.ConnectionIssuesItem
    let retry: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Label {
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(issue.name).font(.headline)
                    if let capability = issue.capability {
                        Text("Affects: \(capability)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Text(issue.message)
                }
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .accessibilityElement(children: .combine)
            switch issue.action {
            case .reconnect:
                if let connection = app.settings.orderedConnections.first(where: { $0.connectionId == issue.connectionId }) {
                    Button("Reconnect") {
                        Task {
                            await app.settings.reconnect(connection)
                            if let url = app.settings.authorizationURL {
                                openURL(url)
                                app.settings.authorizationOpened()
                            }
                        }
                    }
                    .buttonStyle(.bordered)
                    .frame(minHeight: Metrics.touch)
                    .disabled(app.settings.isWorking)
                    .accessibilityLabel("Reconnect \(issue.name)")
                } else {
                    Text("Reconnect it from Settings, Connections.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            case .retry:
                Button("Retry") {
                    Task { await retry() }
                }
                .buttonStyle(.bordered)
                .frame(minHeight: Metrics.touch)
                .accessibilityLabel("Retry \(issue.name)")
            case .none, .unknown:
                EmptyView()
            }
        }
    }
}
