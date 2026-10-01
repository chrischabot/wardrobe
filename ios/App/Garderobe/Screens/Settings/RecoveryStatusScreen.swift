import SwiftUI
import GarderobeKit

/// Status and recovery: the concrete state of the last board, the last confirmed Calendar
/// projection, pending work and connection issues, each with the action that applies.
/// Diagnostics sit behind their own disclosure.
struct RecoveryStatusScreen: View {
    @Environment(AppModel.self) private var app
    @State private var showsDiagnostics = false
    @State private var isRetrying = false

    var body: some View {
        let recovery = app.recovery
        List {
            Section {
                SettingsFreshnessLabel(freshness: recovery.status.freshness, subject: "status")
                Text(recovery.boardLine)
                Text(recovery.calendarLine)
                Button {
                    app.sheet = nil
                    app.selectedTab = .today
                } label: {
                    Label("Open today's board", systemImage: AppTab.today.symbol)
                }
            } header: {
                Text("Board and Calendar")
            }
            Section {
                ForEach(recovery.pendingLines, id: \.self) { line in
                    Text(line)
                }
                if offersRetry {
                    retryButton
                }
            } header: {
                Text("Pending")
            }
            Section {
                if recovery.issues.isEmpty {
                    Text(recovery.status.value == nil ? "Connection issues have not been checked yet." : "No connection issues.")
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(recovery.issues.enumerated()), id: \.offset) { _, issue in
                    RecoveryIssueRow(issue: issue, retry: { await retry() })
                }
                SettingsMessageLine(message: app.settings.message)
            } header: {
                Text("Connection issues")
            } footer: {
                Text("A connection issue affects only what it names. The wardrobe, Today and recording what you wore keep working.")
            }
            Section {
                DisclosureGroup("Diagnostics", isExpanded: $showsDiagnostics) {
                    if recovery.diagnostics.isEmpty {
                        Text("No diagnostic details were reported.").foregroundStyle(.secondary)
                    }
                    ForEach(recovery.diagnostics, id: \.key) { entry in
                        DetailRow(label: entry.key, value: entry.value)
                            .font(.footnote)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .navigationTitle("Status and recovery")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await recovery.status.refresh() }
        .task { await recovery.open() }
    }

    /// Retry is offered when the backend lists it as applicable or actions wait on this phone.
    private var offersRetry: Bool {
        app.recovery.status.value?.actions.contains(.retry) == true || !app.environment.center.pending.isEmpty
    }

    private var retryButton: some View {
        Button {
            Task { await retry() }
        } label: {
            Label(isRetrying ? "Retrying..." : "Retry", systemImage: "arrow.clockwise")
        }
        .disabled(isRetrying)
    }

    private func retry() async {
        isRetrying = true
        await app.recovery.retryPending()
        isRetrying = false
    }
}
