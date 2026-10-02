import SwiftUI
import GarderobeKit

/// Step 3 of capture: what happened to the submitted turn. Receipts are what the backend
/// recorded; a question appears only when a match was ambiguous. Nothing here is a guess by
/// the phone.
struct CaptureResultStep: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The sheet's own submit call is still in flight.
    let isSending: Bool
    let done: () -> Void
    let openConversation: () -> Void

    var body: some View {
        let capture = app.capture
        VStack(alignment: .leading, spacing: Metrics.inset) {
            if let intent = capture.intent {
                Label(intent.title, systemImage: intent.symbol)
                    .font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
            }
            if capture.isWaitingToSend {
                if isSending {
                    Label("Sending...", systemImage: "arrow.up.circle")
                        .font(.subheadline)
                } else {
                    Label("Saved on this phone; will be sent when you are back online", systemImage: "tray.and.arrow.up")
                        .font(.subheadline)
                }
            }
            if let activity = capture.activity {
                Label(activity, systemImage: "ellipsis")
                    .font(.subheadline)
                    .foregroundStyle(Color.supporting)
            }
            if !capture.receipts.isEmpty {
                VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                    SectionHeading(title: "Recorded")
                    ForEach(capture.receipts, id: \.commandId) { ref in
                        ReceiptRefCard(ref: ref)
                    }
                }
            }
            if let input = capture.pendingInput {
                PendingInputView(input: input,
                                 choose: { await capture.answer(choiceId: $0) },
                                 reply: { await capture.answer(text: $0) })
            }
            if let notice = capture.notice {
                Label(notice, systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(Color.supporting)
            }
            Text("The reply appears in Conversation.")
                .font(.footnote)
                .foregroundStyle(Color.supporting)
            Group {
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: Metrics.unit * 3) { buttons }
                } else {
                    HStack(spacing: Metrics.unit * 3) { buttons }
                }
            }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        Button(action: done) {
            Text("Done").frame(maxWidth: .infinity)
        }
        .primaryAction()
        .controlSize(.large)
        Button(action: openConversation) {
            Text("Open Conversation").frame(maxWidth: .infinity)
        }
        .secondaryAction()
        .controlSize(.large)
    }
}
