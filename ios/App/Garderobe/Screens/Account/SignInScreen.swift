import SwiftUI
import GarderobeKit

/// Signed out: one sentence on what signing in does, the sign-in action, and a clearly
/// secondary way to look at recorded demo data.
struct SignInScreen: View {
    @Environment(AppModel.self) private var app
    @State private var authenticator = WebAuthenticator()
    @State private var failureText: String?
    @State private var isSigningIn = false
    private let configuration = AppConfiguration.load()
    let startDemo: () -> Void

    init(startDemo: @escaping () -> Void) {
        self.startDemo = startDemo
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.unit * 6) {
                VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                    Text("Garderobe")
                        .font(.largeTitle.weight(.semibold))
                        .accessibilityAddTraits(.isHeader)
                    Text("Signing in opens your wardrobe, today's board and your conversation on this phone, and sends what you record here to your account.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                signInBlock
                demoBlock
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Metrics.inset)
        }
        .background(Color(.systemGroupedBackground))
    }

    private var signInBlock: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            if !configuration.missing.isEmpty {
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Label("This build is not configured for a backend yet:", systemImage: "wrench.and.screwdriver")
                        .font(.subheadline.weight(.medium))
                    ForEach(configuration.missing, id: \.self) { item in
                        Text("\u{2022} \(item)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            Button {
                Task { await signIn() }
            } label: {
                Text(isSigningIn || app.account.isWorking ? "Signing in..." : "Sign in")
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: Metrics.touch - Metrics.unit * 3)
            }
            .primaryAction()
            .controlSize(.large)
            .disabled(!configuration.missing.isEmpty || isSigningIn || app.account.isWorking)
            .accessibilityIdentifier(AXID.signInButton)

            if let notice = app.account.erasedNotice {
                Label(notice, systemImage: "trash")
                    .font(.footnote)
                    .accessibilityElement(children: .combine)
            }
            SettingsMessageLine(message: app.account.message)
            SettingsMessageLine(message: failureText)
            if app.unsentCount > 0 {
                Label("\(Phrases.count(app.unsentCount, "action")) saved on this phone will be sent after you sign in.", systemImage: "tray.and.arrow.up")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
    }

    private var demoBlock: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Button("Explore with demo data") { startDemo() }
                .secondaryAction()
                .touchTarget()
                .accessibilityIdentifier(AXID.demoButton)
            Text("The demo shows data recorded from a real run. Nothing you do in it is saved.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Opens the sign-in page in the system's web authentication session and hands the callback
    /// to the account model. Cancelling is not an error and shows nothing.
    private func signIn() async {
        guard let redirect = AppConfiguration.load().oauth?.redirectURL else { return }
        failureText = nil
        isSigningIn = true
        defer { isSigningIn = false }
        if let url = await app.account.beginSignIn() {
            do {
                let callback = try await authenticator.authenticate(url: url, redirect: redirect)
                await app.account.completeSignIn(callback: callback)
            } catch WebAuthenticator.Failure.cancelled {
                app.account.signInCancelled()
            } catch WebAuthenticator.Failure.failed(let text) {
                app.account.signInCancelled()
                failureText = text
            } catch {
                app.account.signInCancelled()
                failureText = "Sign-in did not complete."
            }
        }
    }
}
