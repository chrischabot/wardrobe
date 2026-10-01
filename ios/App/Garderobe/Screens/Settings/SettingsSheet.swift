import SwiftUI
import GarderobeKit

/// Settings, behind the account control: one list linking to each settings screen. Pause and
/// resume are stated inline because the state matters on every visit.
struct SettingsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let leaveDemo: () -> Void

    init(leaveDemo: @escaping () -> Void) {
        self.leaveDemo = leaveDemo
    }

    var body: some View {
        let settings = app.settings
        NavigationStack {
            List {
                if app.environment.isDemo {
                    Section {
                        Label("Demo data", systemImage: "theatermasks")
                            .font(.headline)
                        Text("You are looking at data recorded from a real run. Changes are not saved.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Button("Leave demo") { leaveDemo() }
                    }
                } else {
                    Section {
                        NavigationLink {
                            AccountScreen()
                        } label: {
                            VStack(alignment: .leading, spacing: Metrics.unit) {
                                Text(app.account.me?.displayName ?? "Account")
                                    .font(.headline)
                                Text("Account and sign-in")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("Style and delivery") {
                    link("My style", symbol: "text.book.closed", identifier: AXID.settingsMyStyle) { MyStyleScreen() }
                    link("Delivery and location", symbol: "clock") { DeliverySettingsScreen() }
                }
                Section("Recommendations") {
                    Text(settings.pauseLine)
                    if settings.service?.paused == true {
                        Button("Resume recommendations") {
                            Task { await settings.resume() }
                        }
                        .disabled(settings.isWorking)
                        .accessibilityIdentifier(AXID.settingsResume)
                        Text("Nothing is replayed and no questions are asked about the days you missed.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        link("Pause recommendations", symbol: "pause.circle", identifier: AXID.settingsPause) { PauseScreen() }
                    }
                    OutcomeLine(outcome: settings.lastOutcome)
                }
                Section("Connections") {
                    NavigationLink {
                        ProposalsScreen()
                    } label: {
                        LabeledContent {
                            if app.proposals.pendingCount > 0 { Text("\(app.proposals.pendingCount) waiting") }
                        } label: {
                            Label("Requests to confirm", systemImage: "checkmark.shield")
                        }
                    }
                    .accessibilityIdentifier(AXID.settingsProposals)
                    link("Connections", symbol: "link", identifier: AXID.settingsConnections) { ConnectionsScreen() }
                    link("Connected assistants", symbol: "person.badge.key", identifier: AXID.settingsAssistants) { AssistantsScreen() }
                    link("Models and budgets", symbol: "cpu") { InferenceScreen() }
                }
                Section("Wardrobe upkeep") {
                    link("Photos needed and image review", symbol: "photo.badge.plus") { MediaReviewScreen() }
                    link("Status and recovery", symbol: "stethoscope", identifier: AXID.settingsRecovery) { RecoveryStatusScreen() }
                    link("Export my wardrobe", symbol: "square.and.arrow.up.on.square", identifier: AXID.settingsExport) { ExportScreen() }
                }
                Section {
                    SettingsFreshnessLabel(freshness: settings.settings.freshness, subject: "settings")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            await settings.open()
            await app.proposals.open()
        }
    }

    private func link<Destination: View>(_ title: String, symbol: String, identifier: String? = nil,
                                         @ViewBuilder destination: () -> Destination) -> some View {
        NavigationLink {
            destination()
        } label: {
            Label(title, systemImage: symbol)
        }
        .accessibilityIdentifier(identifier ?? "settings.link.\(title)")
    }
}
