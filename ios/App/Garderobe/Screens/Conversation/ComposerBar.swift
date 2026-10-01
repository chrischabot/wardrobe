import SwiftUI
import PhotosUI
import GarderobeKit

/// The composer: a native multiline field (the system keyboard provides dictation), an
/// attachment control, attached identities, uploads, and one unambiguous send or stop state.
/// The draft lives in the model and survives closing the app.
struct ComposerBar: View {
    @Environment(AppModel.self) private var app
    @State private var picked: [PhotosPickerItem] = []

    var body: some View {
        @Bindable var composer = app.composer
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            status(composer)
            if composer.canRunAgain {
                Button("Try that again") { Task { await composer.runAgain() } }
                    .font(.footnote)
                    .touchTarget()
                    .accessibilityHint("Runs the answer that failed again. Anything already recorded is not repeated.")
            }
            if let input = composer.pendingInput {
                PendingInputView(input: input,
                                 choose: { await composer.answer(choiceId: $0) },
                                 reply: { await composer.answer(text: $0) })
            }
            chips(composer)
            AttachmentStrip(uploads: composer.uploads, picked: $picked) { data, contentType in
                await composer.uploads.add(data: data, contentType: contentType, intent: .attachment)
            }
            HStack(alignment: .bottom, spacing: Metrics.unit * 2) {
                PhotosPicker(selection: $picked, maxSelectionCount: 6, matching: .images, preferredItemEncoding: .current) {
                    Image(systemName: "paperclip")
                        .font(.title3)
                        .touchTarget()
                }
                .accessibilityLabel("Attach a photo")
                .accessibilityIdentifier(AXID.composerAttach)
                TextField("Message", text: $composer.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, Metrics.unit * 3)
                    .padding(.vertical, Metrics.unit * 2)
                    .frame(minHeight: Metrics.touch)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
                    .accessibilityIdentifier(AXID.composerField)
                if composer.isStreaming { stopButton(composer) } else { sendButton(composer) }
            }
            if composer.isStreaming, hasDraft(composer) { whileStreaming(composer) }
            if let reason = composer.blockedReason, !reason.isEmpty {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, Metrics.inset)
        .padding(.vertical, Metrics.unit * 2)
        .background(Color(.systemBackground))
        .overlay(alignment: .top) { Divider() }
    }

    private func hasDraft(_ composer: ComposerModel) -> Bool {
        !composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// What the assistant is visibly doing, and anything the composer has to say.
    @ViewBuilder
    private func status(_ composer: ComposerModel) -> some View {
        if let notice = composer.notice {
            Label(notice, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        if let activity = composer.activity {
            Text(activity)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// Identities attached by Ask about this, each removable.
    @ViewBuilder
    private func chips(_ composer: ComposerModel) -> some View {
        ForEach(Array(composer.attachedRefs.enumerated()), id: \.offset) { _, ref in
            let label = composer.label(for: ref)
            HStack(spacing: Metrics.unit * 2) {
                Label(label, systemImage: "link")
                    .font(.footnote)
                    .accessibilityLabel("Attached: \(label)")
                Button {
                    composer.detach(ref)
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.borderless)
                .touchTarget()
                .accessibilityLabel("Remove \(label)")
            }
            .padding(.leading, Metrics.unit * 3)
            .background(Color(.tertiarySystemFill), in: Capsule())
        }
    }

    private func sendButton(_ composer: ComposerModel) -> some View {
        Button {
            Task { await send(composer) }
        } label: {
            Image(systemName: "arrow.up.circle.fill")
                .font(.title)
                .touchTarget()
        }
        .disabled(!composer.canSend)
        .accessibilityLabel("Send")
        .accessibilityIdentifier(AXID.composerSend)
    }

    private func stopButton(_ composer: ComposerModel) -> some View {
        Button {
            Task { await composer.stop() }
        } label: {
            Image(systemName: "stop.circle.fill")
                .font(.title)
                .touchTarget()
        }
        .accessibilityLabel("Stop")
        .accessibilityHint("Stops the answer being written")
        .accessibilityIdentifier(AXID.composerStop)
    }

    /// With a draft ready while an answer is still arriving: interrupt it, or let the message wait.
    private func whileStreaming(_ composer: ComposerModel) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Metrics.unit * 2) { streamingChoices(composer) }
            VStack(alignment: .leading, spacing: Metrics.unit * 2) { streamingChoices(composer) }
        }
    }

    @ViewBuilder
    private func streamingChoices(_ composer: ComposerModel) -> some View {
        Button("Stop and send") { Task { await stopAndSend(composer) } }
            .primaryAction()
            .disabled(!composer.canSend)
        Button("Send") { Task { await send(composer) } }
            .secondaryAction()
            .disabled(!composer.canSend)
            .accessibilityHint("Waits until the current answer has finished")
            .accessibilityIdentifier(AXID.composerSend)
    }

    /// Sending from a recalled part of the history first returns to the latest messages, so the
    /// message is seen where it lands.
    private func send(_ composer: ComposerModel) async {
        if app.transcript.isViewingHistory { await app.transcript.returnToLatest() }
        await composer.send()
    }

    private func stopAndSend(_ composer: ComposerModel) async {
        if app.transcript.isViewingHistory { await app.transcript.returnToLatest() }
        await composer.stopAndSend()
    }
}
