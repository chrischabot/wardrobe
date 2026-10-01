import SwiftUI
import GarderobeKit

/// Today's brief: one optional sentence about the day. There is no planning interview; the
/// field can stay empty and Today works the same.
struct DayBriefSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var loaded = false
    @State private var outcome: SubmissionOutcome?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("For example: dinner at eight, nothing too formal", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                        .accessibilityLabel("Today's brief")
                } header: {
                    Text("Anything particular about today?")
                } footer: {
                    Text("Optional. A brief applies to \(app.today.dateLine) only and never changes your standing style.")
                }
                if app.today.briefText != nil {
                    Section {
                        Button("Clear today's brief", role: .destructive) { Task { await clear() } }
                            .disabled(app.today.isSubmitting)
                        if let note = app.today.briefNote {
                            Text(note).font(.footnote).foregroundStyle(.secondary)
                        }
                    } footer: {
                        Text("Removes the brief for today. Your standing style is not changed.")
                    }
                }
                if outcome != nil {
                    Section { OutcomeLine(outcome: outcome) }
                }
            }
            .navigationTitle("Today's brief")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || app.today.isSubmitting)
                }
            }
            .onAppear {
                // Start from the brief the board was composed with; later edits are the owner's own.
                guard !loaded else { return }
                loaded = true
                text = app.today.briefText ?? ""
            }
            .task { await app.today.style.refresh() }
        }
    }

    private func clear() async {
        outcome = await app.today.clearBrief()
        switch outcome {
        case .confirmed?, .queued?: dismiss()
        default: break
        }
    }

    private func save() async {
        outcome = await app.today.setBrief(text)
        switch outcome {
        case .confirmed?, .queued?: dismiss() // Today shows the outcome line
        default: break
        }
    }
}
