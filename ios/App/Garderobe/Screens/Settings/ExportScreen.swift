import SwiftUI
import UniformTypeIdentifiers
import GarderobeKit

/// The downloaded export package as a file the owner saves or sends himself.
struct ExportPackageFile: Transferable {
    let fileName: String
    let data: Data

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .data) { file in
            file.data
        }
        .suggestedFileName { $0.fileName }
    }
}

/// Export my wardrobe: start the job, follow its state, download the package and hand it to
/// the share sheet. The status sentence is the model's, so an incomplete export is never
/// called complete.
struct ExportScreen: View {
    @Environment(AppModel.self) private var app
    @State private var passphrase = ""

    var body: some View {
        let export = app.export
        List {
            Section {
                Text("The export is one private package: a manifest, checksums, your records as documented JSON, and readable views you can open without Garderobe. Credentials and sign-in secrets are never included.")
            }
            Section {
                SecureField("Passphrase (optional)", text: $passphrase)
                Button(export.isWorking ? "Working..." : "Start export") {
                    Task {
                        await export.start(passphrase: passphrase)
                        passphrase = ""
                    }
                }
                .disabled(export.isWorking)
            } footer: {
                Text("With a passphrase the package is encrypted and can only be opened with it. Leave the field empty for a package that is not encrypted.")
            }
            Section {
                Text(export.statusLine)
                if let job = export.job {
                    ForEach(job.components, id: \.name) { component in
                        Text(export.componentLine(component))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Button("Refresh") {
                    Task { await export.refresh() }
                }
                .disabled(export.isWorking)
                SettingsMessageLine(message: export.message)
            } header: {
                Text("Status")
            }
            if export.canDownload {
                Section {
                    Button(export.isWorking ? "Downloading..." : "Download the package") {
                        Task { await export.fetchPackage() }
                    }
                    .disabled(export.isWorking)
                    if let download = export.download {
                        ShareLink(item: ExportPackageFile(fileName: download.fileName, data: download.data),
                                  preview: SharePreview(download.fileName)) {
                            Label("Save or share \(download.fileName)", systemImage: "square.and.arrow.up")
                        }
                        Label(download.verified ? "Checksum verified" : "No checksum was published for this package",
                              systemImage: download.verified ? "checkmark.seal" : "questionmark.circle")
                            .font(.footnote)
                    }
                } header: {
                    Text("Package")
                } footer: {
                    Text("The download link is short-lived, so the package is fetched when you ask for it. It is held in memory only: save or share it to keep it.")
                }
            }
        }
        .navigationTitle("Export my wardrobe")
        .navigationBarTitleDisplayMode(.inline)
        // Follows the job while it runs. The task restarts when a job appears and is cancelled
        // when the screen goes away; the job itself continues on the server.
        .task(id: export.job?.exportId) {
            await export.refresh()
            while !Task.isCancelled, export.job != nil, !export.isFinished, export.message == nil {
                try? await Task.sleep(for: .seconds(4))
                if Task.isCancelled { break }
                await export.refresh()
            }
        }
    }
}
