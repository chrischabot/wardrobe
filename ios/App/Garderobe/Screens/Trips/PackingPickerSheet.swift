import SwiftUI
import GarderobeKit

/// Choose garments and quantities to record as packed for a trip. The list is the wardrobe
/// saved on this phone (clean items at home); the backend checks the command against its ledger.
struct PackingPickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let tripId: String
    @State private var model: PackingPickerModel?

    var body: some View {
        NavigationStack {
            Group {
                if let model { PackingPickerList(model: model) { dismiss() } } else { ProgressView() }
            }
            .navigationTitle("Pack other items")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task {
                if app.wardrobe.snapshot.value == nil { await app.wardrobe.open() }
                if model == nil {
                    model = PackingPickerModel(environment: app.environment, trips: app.trips, tripId: tripId, candidates: app.wardrobe.snapshot.value?.items ?? [])
                }
            }
        }
    }
}

private struct PackingPickerList: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: PackingPickerModel
    let done: () -> Void

    var body: some View {
        List {
            Section {
                FreshnessLabel(text: app.wardrobe.freshnessLine, freshness: app.wardrobe.snapshot.freshness)
                Button(app.trips.isWorking ? "Recording..." : model.summaryLine) {
                    Task {
                        let outcome = await model.pack()
                        switch outcome {
                        case .confirmed?, .queued?: done()
                        default: break
                        }
                    }
                }
                .disabled(model.selectedUnits == 0 || app.trips.isWorking)
                OutcomeLine(outcome: model.lastOutcome)
            }
            Section {
                if model.rows.isEmpty {
                    Text("Nothing matches.").foregroundStyle(Color.supporting)
                }
                ForEach(model.rows) { row in
                    Stepper(value: Binding(get: { row.quantity }, set: { model.setQuantity($0, for: row.id) }), in: 0...row.atHome) {
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(row.item.garment.name)
                            Text(detail(row)).font(.footnote).foregroundStyle(Color.supporting)
                        }
                    }
                    .accessibilityValue("\(row.quantity) to pack")
                }
            } header: {
                Text("Clean at home")
            }
        }
        .searchable(text: $model.search, prompt: "Names, makers, colours")
    }

    private func detail(_ row: PackingPickerModel.Row) -> String {
        var parts = ["\(row.atHome) clean at home"]
        if row.alreadyPacked > 0 { parts.append("\(row.alreadyPacked) already packed") }
        if row.quantity > 0 { parts.append("packing \(row.quantity)") }
        return parts.joined(separator: " · ")
    }
}
