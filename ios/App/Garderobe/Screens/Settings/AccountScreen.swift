import SwiftUI
import GarderobeKit

/// Account and sign-in: the linked sign-ins, linking another one, the recovery kit, signing
/// out here or everywhere, and account deletion as its own two-step flow.
struct AccountScreen: View {
    @Environment(AppModel.self) private var app
    @State private var confirmsNewKit = false
    @State private var confirmsSignOutEverywhere = false

    var body: some View {
        let account = app.account
        List {
            if account.message != nil || account.me == nil {
                Section {
                    SettingsMessageLine(message: account.message)
                    if account.me == nil {
                        Text("Account details are not available right now.").foregroundStyle(.secondary)
                    }
                }
            }
            AccountIdentitiesSection()
            AccountLinkSection()
            Section {
                if let kit = account.me?.recoveryKit {
                    Label(kitLine(kit), systemImage: kit.present ? "checkmark.shield" : "exclamationmark.shield")
                }
                Button("Issue a new recovery kit") { confirmsNewKit = true }
                    .disabled(account.isWorking)
                    .confirmationDialog("Issue a new recovery kit?", isPresented: $confirmsNewKit, titleVisibility: .visible) {
                        Button("Issue a new kit", role: .destructive) {
                            Task { await account.issueRecoveryKit() }
                        }
                        Button("Keep the current kit", role: .cancel) {}
                    } message: {
                        Text("The recovery code you have now stops working as soon as the new one is issued. The new code is shown once.")
                    }
            } header: {
                Text("Recovery kit")
            } footer: {
                Text("The recovery code is the way back in if you lose every linked sign-in. Keep it somewhere that does not depend on this phone.")
            }
            Section {
                if app.unsentCount > 0 {
                    Label("\(Phrases.count(app.unsentCount, "unsent action")) will stay on this phone and be sent after you sign in again.", systemImage: "tray.and.arrow.up")
                        .font(.footnote)
                }
                Button("Sign out") {
                    Task {
                        await account.signOut()
                        app.sheet = nil
                    }
                }
                .accessibilityIdentifier(AXID.settingsSignOut)
                Button("Sign out everywhere", role: .destructive) { confirmsSignOutEverywhere = true }
                    .disabled(account.isWorking)
                    .confirmationDialog("Sign out everywhere?", isPresented: $confirmsSignOutEverywhere, titleVisibility: .visible) {
                        Button("Sign out everywhere", role: .destructive) {
                            Task {
                                await account.signOutEverywhere()
                                if account.state == .signedOut { app.sheet = nil }
                            }
                        }
                        Button("Stay signed in", role: .cancel) {}
                    } message: {
                        Text("Every device that is signed in now, including this phone, has to sign in again.")
                    }
            } header: {
                Text("Sign out")
            } footer: {
                Text("Signing out removes the saved copy of your wardrobe from this phone. Actions waiting to be sent are kept.")
            }
            AccountDeletionSection()
        }
        .navigationTitle("Account and sign-in")
        .navigationBarTitleDisplayMode(.inline)
        // A newly issued kit is shown once, and the sheet closes only when it is acknowledged.
        .sheet(isPresented: Binding(get: { account.visibleKit != nil }, set: { _ in })) {
            RecoveryOutcomeView()
                .interactiveDismissDisabled()
        }
    }

    private func kitLine(_ kit: MeResponse.RecoveryKitValue) -> String {
        guard kit.present else { return "No recovery kit has been issued." }
        guard let issued = kit.issuedAt else { return "A recovery kit exists." }
        return "A recovery kit exists. It was issued \(SettingsInstant(app: app).relative(issued))."
    }
}
