import SwiftUI
import GarderobeKit

/// Connected assistants: each assistant app (Claude, ChatGPT...) that holds a grant, listed
/// separately with what it may do, when it was last used, and Disconnect.
struct AssistantsScreen: View {
    @Environment(AppModel.self) private var app
    @State private var pendingDisconnect: AssistantGrant?

    var body: some View {
        let settings = app.settings
        List {
            Section {
                SettingsFreshnessLabel(freshness: settings.assistants.freshness, subject: "connected assistants")
                SettingsMessageLine(message: settings.message)
                if settings.activeGrants.isEmpty && settings.assistants.value != nil {
                    Text("No assistants are connected.")
                }
            }
            ForEach(settings.activeGrants) { grant in
                Section {
                    VStack(alignment: .leading, spacing: Metrics.unit) {
                        if let domain = grant.clientDomain {
                            Text(domain)
                                .font(.subheadline)
                                .foregroundStyle(Color.supporting)
                        }
                        Text(settings.grantLine(grant))
                        Text("Connected \(SettingsInstant(app: app).relative(grant.grantedAt)).")
                            .font(.footnote)
                            .foregroundStyle(Color.supporting)
                    }
                    .accessibilityElement(children: .combine)
                    Button("Disconnect", role: .destructive) { pendingDisconnect = grant }
                        .disabled(settings.isWorking)
                        .accessibilityLabel("Disconnect \(grant.clientName)")
                } header: {
                    Text(grant.clientName)
                }
            }
            Section {
                Text("To connect an assistant, or to reconnect one, start from the assistant's own app. It opens a page in the browser where you approve what it may do; this works entirely on the phone.")
                    .font(.footnote)
                    .foregroundStyle(Color.supporting)
            }
        }
        .navigationTitle("Connected assistants")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await settings.assistants.refresh() }
        .confirmationDialog("Disconnect this assistant?",
                            isPresented: Binding(get: { pendingDisconnect != nil }, set: { if !$0 { pendingDisconnect = nil } }),
                            titleVisibility: .visible,
                            presenting: pendingDisconnect) { grant in
            Button("Disconnect \(grant.clientName)", role: .destructive) {
                Task { await settings.disconnect(grant) }
            }
            Button("Keep connected", role: .cancel) {}
        } message: { grant in
            Text("\(grant.clientName) loses access to your wardrobe at once. Other assistants and your own sign-in are not affected.")
        }
    }
}
