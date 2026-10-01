import SwiftUI
import GarderobeKit

/// One card of a message. Text parts repeat the message text and unknown parts are tolerated,
/// so neither is drawn.
struct MessageCardView: View {
    let part: MessagePart

    var body: some View {
        switch part {
        case .outfitBoard(let boardId, let revision, let options):
            OutfitBoardCard(boardId: boardId, revision: revision, options: options)
        case .productComparison(let comparison):
            ProductComparisonCard(comparison: comparison)
        case .sources(let sources):
            SourcesCard(sources: sources)
        case .receipt(let ref):
            ReceiptRefCard(ref: ref)
        case .needsInput(let input):
            NeedsInputCard(input: input)
        case .attachment(_, let label):
            AttachmentCard(label: label)
        case .text, .unknown:
            EmptyView()
        }
    }
}

/// Validated outfit options the assistant recommended. Each can be attached to the next
/// message by its identity, so the backend never has to guess which card was meant.
struct OutfitBoardCard: View {
    @Environment(AppModel.self) private var app
    let boardId: String?
    let revision: Int?
    let options: [BoardOption]

    private let columns = [GridItem(.adaptive(minimum: 64, maximum: 96), spacing: Metrics.unit * 2)]

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            ForEach(options, id: \.optionId) { option in
                optionView(option)
            }
        }
    }

    private func optionView(_ option: BoardOption) -> some View {
        let names = Phrases.list(option.garments.map(\.name))
        return VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Text(option.name)
                .font(.headline)
            LazyVGrid(columns: columns, alignment: .leading, spacing: Metrics.unit * 2) {
                ForEach(option.garments, id: \.garmentId) { garment in
                    // Decorative: the garment names follow as text.
                    GarmentImageView(garmentId: garment.garmentId, name: garment.name, decorative: true)
                }
            }
            Text(names)
                .font(.subheadline)
            if !option.footwearAlternatives.isEmpty {
                Text("Other footwear: \(Phrases.list(option.footwearAlternatives.map(\.name)))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let flourish = option.flourish {
                Text("Optional: \(flourish.name)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Text(option.reason)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let qualification = option.qualification {
                Text(qualification)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button {
                app.composer.attach(AttachedRef(kind: .boardOption, id: option.optionId, boardId: boardId, revision: revision), label: option.name)
            } label: {
                Label("Ask about this", systemImage: "bubble.left")
            }
            .secondaryAction()
            .accessibilityHint("Attaches \(option.name) to your next message")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface(padding: Metrics.unit * 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Outfit \(option.name): \(names)")
    }
}

/// What a run recorded. When the full verified receipt is on this phone it is shown as the
/// receipt card, which carries Undo; otherwise the summary the run reported.
struct ReceiptRefCard: View {
    @Environment(AppModel.self) private var app
    let ref: RunReceiptRef

    var body: some View {
        if let record = app.environment.center.receipts.first(where: { $0.receipt.commandId == ref.commandId }) {
            ReceiptCard(record: record)
        } else {
            VStack(alignment: .leading, spacing: Metrics.unit) {
                Label {
                    Text(ref.summary).font(.subheadline)
                } icon: {
                    Image(systemName: "checkmark.seal")
                }
                Text("Outcome: \(ref.outcome.replacingOccurrences(of: "_", with: " "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentSurface(padding: Metrics.unit * 3)
            .accessibilityElement(children: .combine)
        }
    }
}

/// An attachment of a stored message, named but not fetched: the transcript never loads an
/// address it was merely handed.
struct AttachmentCard: View {
    let label: String?

    var body: some View {
        Label {
            Text(label ?? "Attached photo").font(.subheadline)
        } icon: {
            Image(systemName: "photo")
        }
        .frame(minHeight: Metrics.touch)
        .contentSurface(padding: Metrics.unit * 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Attachment: \(label ?? "photo")")
    }
}
