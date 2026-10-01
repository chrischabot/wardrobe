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
                Button(settings.isWorking ? "Saving..." : "Save as a new version") {
                    Task { await settings.saveProfile(content: draft) }
                }
                .disabled(settings.isWorking || !isChanged(from: stored))
                if isChanged(from: stored) {
                    Button("Discard my edits") { draft = stored ?? "" }
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
