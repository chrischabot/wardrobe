import SwiftUI
import GarderobeKit

/// The sign-in identity is verified but not linked to an account. Three separate routes: claim
/// with an invitation code (first setup), link with a code issued from the other sign-in, or
/// recover with the recovery code. Nothing else proves ownership.
struct IdentityNotLinkedScreen: View {
    @Environment(AppModel.self) private var app
    @State private var invitationCode = ""
    @State private var linkCode = ""

    var body: some View {
        let account = app.account
        if account.visibleKit != nil {
            // A kit was just issued (a claim or a recovery): it is shown before anything else.
            RecoveryOutcomeView()
        } else {
            NavigationStack {
                List {
                    Section {
                        Text("You are signed in, but this sign-in is not linked to a wardrobe yet.")
                        Text("An email address that matches, or knowing what is in the wardrobe, does not prove ownership. Use one of the three routes below.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if account.message != nil {
                        Section { SettingsMessageLine(message: account.message) }
                    }
                    Section {
                        codeField("Invitation code", text: $invitationCode)
                        Button(account.isWorking ? "Working..." : "Claim") {
                            Task { await account.claim(invitationCode: invitationCode) }
                        }
                        .disabled(account.isWorking || isBlank(invitationCode))
                    } header: {
                        Text("I have an invitation code")
                    } footer: {
                        Text("First setup. The code can be used once. Afterwards you are shown a recovery kit to store.")
                    }
                    Section {
                        codeField("Link code", text: $linkCode)
                        Button(account.isWorking ? "Working..." : "Link") {
                            Task { await account.completeIdentityLink(linkCode: linkCode) }
                        }
                        .disabled(account.isWorking || isBlank(linkCode))
                    } header: {
                        Text("I have a link code from my other sign-in")
                    } footer: {
                        Text("While signed in the other way, open Settings, Account and sign-in, and choose Link another sign-in to get a code.")
                    }
                    Section {
                        NavigationLink {
                            RecoveryFlowView()
                        } label: {
                            Label("Recover with my recovery code", systemImage: "lifepreserver")
                        }
                    } header: {
                        Text("I lost access to my old sign-in")
                    } footer: {
                        Text("Needs the recovery code from the kit you stored.")
                    }
                    Section {
                        Button("Sign out") {
                            Task { await account.signOut() }
                        }
                    } footer: {
                        Text("Sign out to try a different sign-in.")
                    }
                }
                .navigationTitle("Link this sign-in")
            }
        }
    }

    private func codeField(_ title: String, text: Binding<String>) -> some View {
        TextField(title, text: text)
            .font(.system(.body, design: .monospaced))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel(title)
    }

    private func isBlank(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
