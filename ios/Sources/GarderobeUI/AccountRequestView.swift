#if os(iOS)
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import GarderobeKit

/// Confirming an assistant's export, import or recovery-kit request, and using its private result.
/// The link, the downloaded export and a collected code exist only while this sheet is open.
struct AccountRequestView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var pasted = ""
    @State private var copied = false

    var body: some View {
        let m = app.accountRequest
        NavigationStack {
            List {
                switch m.state {
                case .idle:
                    Section {
                        TextField("Paste the confirmation link", text: $pasted)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .accessibilityIdentifier("account.link")
                        Button("Open") { if let url = URL(string: pasted.trimmingCharacters(in: .whitespacesAndNewlines)) { Task { await m.open(url) } } }
                            .disabled(pasted.isEmpty).minimumTarget()
                    } footer: { Text("When Claude or ChatGPT asks for an export, an import or a new recovery code, it gives you a Garderobe link to confirm. Nothing happens until you do.") }
                case .loading:
                    ProgressView("Loading the request…")
                case .question(let q):
                    Section {
                        Text(verbatim: q.prompt).font(.body)
                        ForEach(q.choices.filter { $0.id != "decline" }) { choice in
                            Button { Task { await m.answer(choice) } } label: { Text(choice.label).frame(maxWidth: .infinity).minimumTarget() }
                                .buttonStyle(.glassProminent).disabled(m.isBusy)
                                .accessibilityIdentifier("account.confirm")
                        }
                        Button("No, don't do this", role: .cancel) { Task { await m.decline() } }
                            .minimumTarget().disabled(m.isBusy).accessibilityIdentifier("account.decline")
                    } footer: { Text("Asked for by a connected assistant. It expires after 10 minutes.") }
                case .done(let outcome, let replayed):
                    result(outcome, replayed: replayed)
                case .declined:
                    Label("Declined. Nothing was done.", systemImage: "xmark.circle")
                case .expired:
                    Label("This request expired. Nothing was done; ask the assistant again if you still want it.", systemImage: "clock.badge.xmark")
                case .notWaiting(let why):
                    Label(why, systemImage: "checkmark.circle")
                case .failed(let why):
                    Label(why, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                }
            }
            .navigationTitle("Assistant request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        // Private material does not outlive the sheet.
        .onDisappear { m.discardExport(); m.forgetRecoveryCode() }
    }

    @ViewBuilder private func result(_ outcome: AccountOperationOutcome, replayed: Bool) -> some View {
        let m = app.accountRequest
        Section {
            Text(AccountRequestViewModel.title(outcome)).font(.headline).accessibilityAddTraits(.isHeader)
            ForEach(m.lines(outcome), id: \.self) { Text(verbatim: $0).font(.callout) }
            if replayed { Text("Already confirmed earlier; this is the same result.").font(.caption).foregroundStyle(.secondary) }
        }
        switch outcome {
        case .export:
            Section {
                if let file = m.exportFile {
                    ShareLink(item: file) { Label("Save or share the export", systemImage: "square.and.arrow.up").minimumTarget() }
                        .accessibilityIdentifier("account.shareExport")
                } else {
                    Button { Task { await m.saveExport() } } label: { Label("Download export", systemImage: "arrow.down.circle").minimumTarget() }
                        .disabled(m.isBusy || m.isLinkExpired).accessibilityIdentifier("account.downloadExport")
                }
            } footer: { Text("The link opens only when you are signed in to Garderobe. The file is kept on this phone only until you close this sheet.") }
        case .recoveryKit:
            Section {
                if let code = m.recoveryCode {
                    Text(verbatim: code.credential).font(.title3.monospaced()).textSelection(.enabled).privacySensitive()
                        .accessibilityLabel("Recovery code").accessibilityIdentifier("account.recoveryCode")
                    Text(verbatim: code.instructions).font(.caption).foregroundStyle(.secondary)
                    Button(copied ? "Copied for two minutes" : "Copy") {
                        UIPasteboard.general.setItems([[UTType.plainText.identifier: code.credential]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                        copied = true
                    }.minimumTarget()
                    Button("I've saved it") { m.forgetRecoveryCode(); copied = false }.minimumTarget()
                } else {
                    Button { Task { await m.collectRecoveryCode() } } label: { Label("Collect the new recovery code", systemImage: "key").minimumTarget() }
                        .disabled(m.isBusy || m.isLinkExpired).accessibilityIdentifier("account.collectCode")
                }
            } footer: { Text("The code is shown once and replaces your current one. Garderobe does not keep it on this phone.") }
        case .imported, .unknown:
            EmptyView()
        }
        if let error = m.linkError { Text(verbatim: error).font(.callout).foregroundStyle(.orange).accessibilityIdentifier("account.linkError") }
    }
}
#endif
