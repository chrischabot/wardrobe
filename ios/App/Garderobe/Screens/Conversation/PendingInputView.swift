import SwiftUI
import GarderobeKit

/// The one question a run is waiting on: its choices as buttons, or a text answer when it
/// offers none. Used by the composer, the transcript card and the capture sheet; the caller
/// says which model method answers.
struct PendingInputView: View {
    let input: PendingInput
    let choose: (String) async -> Void
    let reply: (String) async -> Void

    @State private var text = ""
    @State private var isAnswering = false

    private var answer: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Label {
                Text(input.question).font(.subheadline.weight(.semibold))
            } icon: {
                Image(systemName: "questionmark.circle")
            }
            if input.choices.isEmpty {
                TextField("Your answer", text: $text, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .frame(minHeight: Metrics.touch)
                Button("Answer") {
                    let value = answer
                    run { await reply(value) }
                }
                .primaryAction()
                .disabled(answer.isEmpty || isAnswering)
            } else {
                ForEach(input.choices, id: \.id) { choice in
                    Button {
                        run { await choose(choice.id) }
                    } label: {
                        Text(choice.label)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, minHeight: Metrics.touch - Metrics.unit * 4, alignment: .leading)
                    }
                    .secondaryAction()
                    .disabled(isAnswering)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface(padding: Metrics.unit * 3)
        .accessibilityElement(children: .contain)
    }

    private func run(_ action: @escaping () async -> Void) {
        isAnswering = true
        Task {
            await action()
            isAnswering = false
        }
    }
}

/// A question stored in the transcript. It can be answered here only while the composer's
/// run is still waiting on this very question; otherwise it is shown as what was asked.
struct NeedsInputCard: View {
    @Environment(AppModel.self) private var app
    let input: PendingInput

    var body: some View {
        if app.composer.pendingInput?.inputId == input.inputId {
            PendingInputView(input: input,
                             choose: { await app.composer.answer(choiceId: $0) },
                             reply: { await app.composer.answer(text: $0) })
        } else {
            VStack(alignment: .leading, spacing: Metrics.unit) {
                Label {
                    Text(input.question).font(.subheadline.weight(.semibold))
                } icon: {
                    Image(systemName: "questionmark.circle")
                }
                ForEach(input.choices, id: \.id) { choice in
                    Text(choice.label)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentSurface(padding: Metrics.unit * 3)
            .accessibilityElement(children: .combine)
        }
    }
}
