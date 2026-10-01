import SwiftUI
import UIKit
import UniformTypeIdentifiers
import GarderobeKit

/// The recovery kit as a file the owner chooses to save or send himself. The bytes are built
/// only when the share sheet asks for them; the app never writes the code to disk on its own.
struct RecoveryKitFile: Transferable {
    let fileName: String
    let text: String

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .plainText) { file in
            Data(file.text.utf8)
        }
        .suggestedFileName { $0.fileName }
    }
}

/// A recovery kit that was just issued, shown exactly once. The code lives only in the account
/// model's memory; "Done" drops it, and it cannot be shown again. Nothing here logs or stores it.
struct RecoveryKitView: View {
    @Environment(AppModel.self) private var app
    @State private var stored = false
    @State private var copied = false

    var body: some View {
        if let kit = app.account.visibleKit {
            VStack(alignment: .leading, spacing: Metrics.unit * 4) {
                SectionHeading(title: "Your recovery kit")
                Label("This code is shown once and will not be shown again. Any previous recovery code no longer works.", systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                Text(kit.recoveryCode)
                    .font(.system(.title3, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Metrics.unit * 3)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: Metrics.innerRadius(padding: Metrics.inset), style: .continuous))
                    .accessibilityLabel("Recovery code")
                    .accessibilityValue(kit.recoveryCode)
                    .privacySensitive()
                Text(kit.storageInstruction)
                    .font(.body)
                Text("Issued \(SettingsInstant(app: app).relative(kit.issuedAt)).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                ShareLink(item: RecoveryKitFile(fileName: kit.downloadFileName, text: kit.downloadText),
                          preview: SharePreview(kit.downloadFileName)) {
                    Label("Save the kit as a file", systemImage: "square.and.arrow.down")
                }
                .secondaryAction()
                .touchTarget()

                Button {
                    copy(kit.recoveryCode)
                } label: {
                    Label(copied ? "Copied for two minutes" : "Copy the code", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .secondaryAction()
                .touchTarget()

                Toggle("I have stored this somewhere safe", isOn: $stored)
                    .frame(minHeight: Metrics.touch)
                Button {
                    app.account.acknowledgeKit()
                } label: {
                    Text("Done").frame(maxWidth: .infinity)
                }
                .primaryAction()
                .controlSize(.large)
                .disabled(!stored)
                .accessibilityHint(stored ? "Removes the code from this screen for good" : "Confirm that you have stored the kit first")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentSurface()
            .accessibilityElement(children: .contain)
        }
    }

    /// Copies the code to this device's clipboard only (not shared to other devices), and lets
    /// the system clear it after two minutes.
    private func copy(_ code: String) {
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: code]],
                                      options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
        copied = true
    }
}
