import SwiftUI
import GarderobeKit

/// Account deletion, separate from signing out and from unlinking a sign-in. Two explicit
/// steps: ask (the backend states the consequence), then confirm or keep the account.
struct AccountDeletionSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let account = app.account
        Section {
            if let deletion = account.deletion {
                Text(deletion.consequence)
                switch deletion.state {
                case .confirmationRequired:
                    if let expires = deletion.expiresAt {
                        Text("This confirmation expires \(SettingsInstant(app: app).relative(expires)).")
                            .font(.footnote)
                            .foregroundStyle(Color.supporting)
                    }
                    Button(account.isWorking ? "Working..." : "Delete my account", role: .destructive) {
                        Task { await account.confirmDeletion() }
                    }
                    .disabled(account.isWorking)
                    Button("Keep my account") { account.cancelDeletion() }
                        .disabled(account.isWorking)
                case .disabledPendingDeletion, .erased:
                    Label("Deletion is confirmed.", systemImage: "trash")
                case .unknown:
                    Button("Close") { account.cancelDeletion() }
                }
            } else {
                Button("Delete account...", role: .destructive) {
                    Task { await account.requestDeletion() }
                }
                .disabled(account.isWorking)
            }
        } header: {
            Text("Delete account")
        } footer: {
            Text("Nothing is deleted by the first step: you are shown what deletion removes and asked again. Export your wardrobe first if you want to keep a copy.")
        }
    }
}
