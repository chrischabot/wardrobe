import SwiftUI
import GarderobeKit

/// Returns for this garment and the receipts that touched it. Undo stays available here after
/// the banner has gone.
struct ItemHistorySection: View {
    @Environment(AppModel.self) private var app
    let model: ItemModel

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 5) {
            returns
            history
        }
    }

    private var returns: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            SectionHeading(title: "Returns and exchanges")
            let cases = app.returns.cases(forGarment: model.garmentId)
            if cases.isEmpty {
                Text("None for this item.").font(.subheadline).foregroundStyle(Color.supporting)
            }
            ForEach(cases) { c in
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(c.kind == .exchange ? "Exchange" : "Return").font(.subheadline.weight(.medium))
                    Text(app.returns.deadlineLine(c)).font(.footnote)
                    Text(app.returns.stockLine(c)).font(.footnote).foregroundStyle(Color.supporting)
                }
            }
            if let garment = model.garment, garment.acquisition != .disposed {
                Menu {
                    Button("Start a return") { Task { await app.returns.open(kind: .return, garmentId: model.garmentId, garmentName: garment.name) } }
                    Button("Start an exchange") { Task { await app.returns.open(kind: .exchange, garmentId: model.garmentId, garmentName: garment.name) } }
                } label: {
                    Label("Track a return or exchange", systemImage: "arrow.uturn.left.circle")
                        .frame(minHeight: Metrics.touch)
                }
                Text("Starting a return does not remove the item. It leaves your wardrobe only when it physically goes.")
                    .font(.caption).foregroundStyle(Color.supporting)
                OutcomeLine(outcome: app.returns.lastOutcome)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            SectionHeading(title: "History")
            if model.historyFailure != nil {
                Label("Earlier history could not be loaded, so this list may be incomplete.", systemImage: "clock.badge.exclamationmark")
                    .font(.footnote).foregroundStyle(Color.supporting)
            }
            if model.history.isEmpty {
                Text("Nothing recorded for this item yet.").font(.subheadline).foregroundStyle(Color.supporting)
            }
            ForEach(model.history) { record in ReceiptCard(record: record) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(AXID.itemHistory)
    }
}
