import SwiftUI
import GarderobeKit

/// Recovery after losing the sign-in identity: start an expiring attempt, prove possession of
/// the recovery code, and receive a replacement kit. Every failure sentence is the account
/// model's; there is no support override to offer.
struct RecoveryFlowView: View {
    @Environment(AppModel.self) private var app
    @State private var code = ""
    @State private var unlinkPrevious = false

    var body: some View {
        let account = app.account
        Group {
            if account.recoveryResult != nil || account.visibleKit != nil {
                RecoveryOutcomeView()
            } else {
                List {
                    Section {
                        Text("Use this when you can no longer sign in the way you used to. You need the recovery code from the kit you stored when the account was set up.")
                        Text("An email address that matches, or knowing what is in the wardrobe, does not prove the account is yours. Only the recovery code does.")
                            .font(.footnote)
                            .foregroundStyle(Color.supporting)
                    }
                    if let transaction = account.recoveryTransaction {
                        attempt(transaction)
                    } else {
                        Section {
                            Button(account.isWorking ? "Starting..." : "Start recovery") {
                                Task { await account.startRecovery() }
                            }
                            .disabled(account.isWorking)
                        } footer: {
                            Text("Starting opens an attempt for the sign-in you are using now. It expires, and the number of tries is limited.")
                        }
                    }
                    if account.message != nil {
                        Section { SettingsMessageLine(message: account.message) }
                    }
                }
            }
        }
        .navigationTitle("Recover my account")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func attempt(_ transaction: RecoveryTransaction) -> some View {
        let account = app.account
        Section {
            TextField("Recovery code", text: $code, axis: .vertical)
                .font(.system(.body, design: .monospaced))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel("Recovery code")
            Text("\(Phrases.count(transaction.attemptsRemaining, "attempt")) remaining. This attempt expires \(SettingsInstant(app: app).relative(transaction.expiresAt)).")
                .font(.footnote)
                .foregroundStyle(Color.supporting)
        } header: {
            Text("Recovery code")
        }
        Section {
            Toggle("Also unlink my previous sign-ins", isOn: $unlinkPrevious)
        } footer: {
            Text("Turn this on when the old login is compromised or permanently lost. It can then no longer open this wardrobe.")
        }
        Section {
            Button(account.isWorking ? "Recovering..." : "Recover") {
                Task { await account.completeRecovery(recoveryCode: code, unlinkPreviousIdentities: unlinkPrevious) }
            }
            .disabled(account.isWorking || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } footer: {
            Text("On success this sign-in is linked to your wardrobe, other devices and connected assistants are signed out, and a new recovery kit is shown once.")
        }
    }
}
