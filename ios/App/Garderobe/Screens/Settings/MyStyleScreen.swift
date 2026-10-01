import SwiftUI
import GarderobeKit

/// My style: the imported profile in full (never shortened or summarised), editable as a new
/// version; then the amendments, standing directions and the order in which they apply.
struct MyStyleScreen: View {
    @Environment(AppModel.self) private var app
    @State private var draft = ""
    @State private var hasLoaded = false

    var body: some View {
        let settings = app.settings
        let stored = settings.style.value?.document.content
        List {
            Section {
                if let line = settings.profileLine {
                    Text(line)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                SettingsFreshnessLabel(freshness: settings.style.freshness, subject: "style profile")
            }
            Section {
                TextEditor(text: $draft)
                    .onChange(of: draft) { _, current in
                        // A preview describes one exact text; editing again withdraws it.
                        if let preview = settings.savePreview, preview.content != current { settings.cancelSavePreview() }
                    }
                    .font(.body)
                    .frame(minHeight: 420)
                    .disabled(stored == nil)
                    .accessibilityLabel("Style profile text")
                    .onChange(of: stored, initial: true) { previous, current in
                        // Adopt the stored text unless the owner has unsaved edits.
                        if !hasLoaded || draft == previous {
                            draft = current ?? ""
                            hasLoaded = current != nil
                        }
                    }
                Button(settings.isWorking ? "Checking..." : "Review and save") {
                    Task {
                        // The backend says what the edit touches before anything is saved. When it
                        // cannot be asked (offline), the save still goes ahead and queues.
                        let previewed = await settings.previewSave(content: draft)
                        if !previewed { await settings.saveProfile(content: draft) }
                    }
                }
                .disabled(settings.isWorking || !isChanged(from: stored) || settings.savePreview != nil)
                if isChanged(from: stored) {
                    Button("Discard my edits") { draft = stored ?? ""; settings.cancelSavePreview() }
                }
            } header: {
                Text(settings.style.value?.document.title ?? "Profile")
            } footer: {
                Text("This is the whole profile text. Saving keeps the earlier version and creates a new one.")
            }
            Section {
                OutcomeLine(outcome: settings.lastOutcome)
                SettingsMessageLine(message: settings.message)
            }
            StylePreviewAndResult()
            StyleAmendmentsSection()
            StyleDirectionsSection()
            if let precedence = settings.style.value?.precedence {
                Section("What takes precedence") {
                    Text(precedence)
                }
            }
        }
        .navigationTitle("My style")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func isChanged(from stored: String?) -> Bool {
        guard let stored else { return false }
        return draft != stored && !draft.isEmpty
    }
}

/// The review of a pending save, what the last save changed, and the facts still undecided.
private struct StylePreviewAndResult: View {
    var body: some View {
        StyleSavePreviewSection()
        StyleSaveResultSection()
        StyleFactConflictsSection()
    }
}
