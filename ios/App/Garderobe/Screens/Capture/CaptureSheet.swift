import SwiftUI
import GarderobeKit

/// Capture: choose what the photo is for, add a photo or a note, submit, then see what came
/// of it. Taking or choosing a photo only uploads it; submitting sends one conversation turn
/// and the backend decides whether anything is recorded.
struct CaptureSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// True while this sheet's own submit call is in flight.
    @State private var isSubmitting = false

    var body: some View {
        let capture = app.capture
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.inset) {
                    if capture.submittedTurnId != nil {
                        CaptureResultStep(isSending: isSubmitting, done: done, openConversation: openConversation)
                    } else if capture.intent != nil {
                        CaptureComposeStep(submit: submit)
                    } else {
                        intents
                    }
                }
                .padding(Metrics.inset)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Capture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if capture.submittedTurnId == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            capture.reset()
                            dismiss()
                        }
                    }
                }
            }
        }
        // Swiping the sheet away after submitting is the same as Done: the next capture starts clean.
        .onDisappear { if capture.submittedTurnId != nil { capture.reset() } }
    }

    /// Step 1: the three intents.
    private var intents: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            SectionHeading(title: "What is this for?")
            ForEach(CaptureIntent.allCases) { intent in
                Button {
                    app.capture.intent = intent
                } label: {
                    HStack(alignment: .top, spacing: Metrics.unit * 3) {
                        Image(systemName: intent.symbol)
                            .font(.title2)
                            .frame(minWidth: 32)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(intent.title)
                                .font(.headline)
                            Text(intent.explanation)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
                    .contentSurface()
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(AXID.captureIntent(intent.rawValue))
            }
        }
    }

    private func submit() {
        guard !isSubmitting else { return }
        isSubmitting = true
        Task {
            await app.capture.submit()
            isSubmitting = false
        }
    }

    private func done() {
        app.capture.reset()
        dismiss()
    }

    private func openConversation() {
        app.capture.reset()
        app.sheet = nil
        app.selectedTab = .conversation
    }
}
