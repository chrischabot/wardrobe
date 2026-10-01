import SwiftUI
import GarderobeKit

/// The optional reconciliation view: the owner states the counts for a category and the app
/// takes his word. Routine use never needs it.
struct ReconcileScreen: View {
    @Environment(AppModel.self) private var app
    let category: String
    @State private var expanded: String?

    init(category: String) { self.category = category }

    private var items: [InventoryItem] {
        (app.wardrobe.snapshot.value?.items ?? []).filter { $0.garment.category.rawValue == category && $0.garment.acquisition == .owned }
            .sorted { $0.garment.name < $1.garment.name }
    }

    var body: some View {
        List {
            Section {
                Text("Only if you want to. Tell Garderobe what is actually there and it will take your word; you never need to do this for the app to work.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                FreshnessLabel(text: app.wardrobe.freshnessLine, freshness: app.wardrobe.snapshot.freshness)
            }
            ForEach(items) { item in
                Section {
                    DisclosureGroup(isExpanded: Binding(get: { expanded == item.id }, set: { expanded = $0 ? item.id : nil })) {
                        ReconcileRow(item: item)
                    } label: {
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(item.garment.name)
                            Text(app.wardrobe.subtitle(for: item)).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .navigationTitle(Phrases.category(GarmentCategory(rawValue: category) ?? .other))
        .navigationBarTitleDisplayMode(.inline)
        .task { await app.wardrobe.open() }
    }
}

private struct ReconcileRow: View {
    @Environment(AppModel.self) private var app
    let item: InventoryItem
    @State private var model: ReconcileModel?

    var body: some View {
        Group {
            if let model { ReconcileControls(model: model) }
        }
        // A fresh model whenever the backend's quantities for this item change.
        .task(id: item) { model = ReconcileModel(environment: app.environment, item: item) }
    }
}

private struct ReconcileControls: View {
    let model: ReconcileModel

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Stepper("Clean at home: \(model.counts.clean)", value: $model.counts.clean, in: 0...99)
            Stepper("In the wash: \(model.counts.dirty)", value: $model.counts.dirty, in: 0...99)
            Stepper("In storage: \(model.counts.storage)", value: $model.counts.storage, in: 0...99)
            Stepper("Owned in total: \(model.counts.total)", value: $model.counts.total, in: 0...99)
            Button("Save these counts") { Task { await model.save() } }
                .secondaryAction()
                .disabled(!model.hasChanges)
            OutcomeLine(outcome: model.lastOutcome)
        }
    }
}
