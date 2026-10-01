import SwiftUI
import GarderobeKit

/// The sign-ins linked to this account. The one in use is marked; any other can be unlinked.
struct AccountIdentitiesSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Section {
            ForEach(app.account.me?.identities ?? []) { identity in
                AccountIdentityRow(identity: identity)
            }
        } header: {
            Text("Linked sign-ins")
        } footer: {
            Text("Unlinking a sign-in does not delete the wardrobe or its connections. The email address is a label only; it never identifies the account.")
        }
    }
}

struct AccountIdentityRow: View {
    @Environment(AppModel.self) private var app
    let identity: LinkedIdentity
    @State private var confirmsUnlink = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            Text(identity.provider)
            if let email = identity.displayEmail {
                Text(email)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text("Linked \(SettingsInstant(app: app).relative(identity.linkedAt))")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if identity.current {
                Label("This sign-in", systemImage: "person.crop.circle.badge.checkmark")
                    .font(.footnote)
            } else {
                Button("Unlink", role: .destructive) { confirmsUnlink = true }
                    .buttonStyle(.borderless)
                    .touchTarget()
                    .disabled(app.account.isWorking)
                    .accessibilityLabel("Unlink \(identity.displayEmail ?? identity.provider)")
                    .confirmationDialog("Unlink this sign-in?", isPresented: $confirmsUnlink, titleVisibility: .visible) {
                        Button("Unlink", role: .destructive) {
                            Task { await app.account.unlink(identityId: identity.identityId) }
                        }
                        Button("Keep it linked", role: .cancel) {}
                    } message: {
                        Text("It can no longer open this wardrobe. The wardrobe and its connections are not deleted.")
                    }
            }
        }
    }
}

/// Linking a second sign-in in advance: a short-lived code issued here is entered after signing
/// in with the other identity. Email addresses are never matched automatically.
struct AccountLinkSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let account = app.account
        Section {
            Button(account.linkTicket == nil ? "Link another sign-in" : "Get a new link code") {
                Task { await account.startIdentityLink() }
            }
            .disabled(account.isWorking)
            if let ticket = account.linkTicket {
                Text(ticket.linkCode)
                    .font(.system(.title3, design: .monospaced))
                    .textSelection(.enabled)
                    .accessibilityLabel("Link code")
                    .accessibilityValue(ticket.linkCode)
                Text("This code expires \(SettingsInstant(app: app).relative(ticket.expiresAt)).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text("Sign in to Garderobe with the other identity, on another device or on this phone after signing out. Note the code first: it is not kept here once you sign out. The app will say that sign-in is not linked yet; choose \"I have a link code from my other sign-in\" and enter this code.")
                    .font(.footnote)
            }
        } header: {
            Text("Link another sign-in")
        } footer: {
            Text("A second linked sign-in lets you in if you lose the first.")
        }
    }
}
