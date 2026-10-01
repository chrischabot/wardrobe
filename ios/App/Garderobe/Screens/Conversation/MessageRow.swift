import SwiftUI
import GarderobeKit

/// One message of the transcript: the owner's trailing, everything else leading, followed by
/// its cards. Text appears as it is; streamed text is never replayed character by character.
struct MessageRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: TranscriptEntry

    private var isOwner: Bool { entry.role == .user }

    var body: some View {
        VStack(alignment: isOwner ? .trailing : .leading, spacing: Metrics.unit * 2) {
            if entry.forgotten || !entry.text.isEmpty || delivery != nil {
                message
            }
            ForEach(Array(entry.cards.enumerated()), id: \.offset) { _, card in
                MessageCardView(part: card)
            }
        }
        .frame(maxWidth: .infinity, alignment: isOwner ? .trailing : .leading)
    }

    /// The text and its delivery state, read by VoiceOver as one element.
    private var message: some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            if entry.forgotten {
                Text("Message removed at your request.")
                    .italic()
                    .foregroundStyle(.secondary)
            } else if !entry.text.isEmpty {
                Text(entry.text)
                    .foregroundStyle(entry.role == .user || entry.role == .assistant ? Color.primary : Color.secondary)
                    .textSelection(.enabled)
            }
            if let delivery {
                Label(delivery.text, systemImage: delivery.symbol)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .font(.body)
        .padding(isOwner ? Metrics.unit * 3 : 0)
        .background {
            if isOwner {
                RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).fill(Color(.tertiarySystemFill))
            }
        }
        // The owner's messages keep a gutter on the leading side, except when large text needs the width.
        .padding(.leading, isOwner && !typeSize.isAccessibilitySize ? Metrics.inset * 2 : 0)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(entry.accessibilityLabel)
        .accessibilityValue(delivery?.text ?? "")
    }

    private var delivery: (text: String, symbol: String)? {
        switch entry.delivery {
        case .settled: return nil
        case .streaming: return ("Writing...", "ellipsis")
        case .waitingToSend: return ("Waiting to send", "tray.and.arrow.up")
        case .waitingForTurn: return ("Waiting", "clock")
        case .failed(let text): return (text, "exclamationmark.triangle")
        }
    }
}
