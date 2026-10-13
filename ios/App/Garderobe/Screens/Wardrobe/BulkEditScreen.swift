import SwiftUI
import GarderobeKit

/// Correct one attribute on several items at once. The owner ticks the items (from what
/// Wardrobe is showing, so search and filters narrow the list), states the change, and one
/// command applies it with one receipt and one undo.
struct BulkEditScreen: View {
    @Environment(AppModel.self) private var app
    @State private var model: BulkEditModel?

    var body: some View {
        Group {
            if let model { BulkEditForm(model: model) } else { ProgressView() }
        }
        .navigationTitle("Edit several items")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil { model = BulkEditModel(environment: app.environment, candidates: app.wardrobe.items) }
        }
    }
}

private struct BulkEditForm: View {
    @Environment(AppModel.self) private var app
    @Bindable var model: BulkEditModel

    var body: some View {
        List {
            Section {
                Picker("Attribute", selection: $model.field) {
                    ForEach(BulkEditModel.Field.allCases) { field in Text(field.title).tag(field) }
                }
                if model.field == .careChannel {
                    Picker("Care", selection: $model.careChannel) {
                        ForEach(BulkEditModel.careChannels, id: \.self) { channel in Text(BulkEditModel.careTitle(channel)).tag(channel) }
                    }
                } else {
                    Toggle("Clear the value", isOn: $model.clearsValue)
                    if !model.clearsValue {
                        TextField("New \(model.field.title.lowercased())", text: $model.text)
                            .accessibilityLabel("New \(model.field.title.lowercased())")
                    }
                }
            } header: {
                Text("The change")
            } footer: {
                Text("Counts, locations and what is clean are not changed here.")
            }
            Section {
                Picker("Apply to", selection: $model.scope) {
                    ForEach(BulkEditModel.Scope.allCases) { scope in Text(scope.title).tag(scope) }
                }
                switch model.scope {
                case .ticked:
                    EmptyView()
                case .category:
                    Picker("Category", selection: $model.category) {
                        ForEach(app.wardrobe.categories, id: \.self) { category in Text(Phrases.category(category)).tag(category) }
                    }
                case .search:
                    TextField("Search words", text: $model.searchText)
                        .accessibilityLabel("Search words")
                }
                if model.scope != .ticked {
                    Button("Show what this covers") { Task { await model.loadMatches() } }
                        .disabled(model.selector == nil)
                        .accessibilityIdentifier(AXID.bulkEditCheck)
                }
                if let message = model.message {
                    Text(message).font(.footnote).foregroundStyle(Color.supporting)
                }
            } header: {
                Text("Which items")
            }
            Section {
                Button(model.isSubmitting ? "Applying..." : model.summaryLine) {
                    Task { await model.submit() }
                }
                .disabled(!model.canSubmit)
                .accessibilityIdentifier(AXID.bulkEditApply)
                OutcomeLine(outcome: model.lastOutcome)
            }
            if model.scope == .ticked { tickList } else { matchList }
        }
    }

    /// What the backend says the category or search covers, read before the change is applied.
    @ViewBuilder private var matchList: some View {
        if let matched = model.matched {
            Section("\(Phrases.count(matched.count, "item")) covered") {
                ForEach(matched.garments, id: \.garmentId) { garment in
                    Text(garment.name)
                }
            }
        }
    }

    private var tickList: some View {
            Section {
                Button("Select all \(model.candidates.count) shown") { model.selectAll() }
                    .accessibilityIdentifier(AXID.bulkEditSelectAll)
                if !model.selection.isEmpty {
                    Button("Clear the selection") { model.clearSelection() }
                }
                ForEach(model.candidates) { item in
                    Button { model.toggle(item) } label: {
                        HStack(spacing: Metrics.unit * 3) {
                            Image(systemName: model.isSelected(item) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(model.isSelected(item) ? Color.accentColor : Color.secondary)
                            VStack(alignment: .leading, spacing: Metrics.unit) {
                                Text(item.garment.name).foregroundStyle(.primary)
                                Text(app.wardrobe.subtitle(for: item)).font(.footnote).foregroundStyle(Color.supporting)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(item.garment.name)
                    .accessibilityValue(model.isSelected(item) ? "Selected" : "Not selected")
                    .accessibilityAddTraits(.isButton)
                }
            } header: {
                Text("\(model.selection.count) of \(model.candidates.count) selected")
            } footer: {
                Text("This is the list Wardrobe was showing. Search or filter there first to narrow it.")
            }
    }
}
