import SwiftUI
import GarderobeKit

/// Wardrobe: the owner's garments by the names he recognises, with search, filters and counts.
struct WardrobeScreen: View {
    @Environment(AppModel.self) private var app
    @State private var showsFilters = false

    var body: some View {
        @Bindable var wardrobe = app.wardrobe
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.unit * 4) {
                header
                if wardrobe.items.isEmpty {
                    emptyState
                } else {
                    WardrobeGrid()
                }
            }
            .padding(Metrics.inset)
        }
        .accessibilityIdentifier(AXID.wardrobeSearch)
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Wardrobe")
        .searchable(text: $wardrobe.filters.search, prompt: "Names, makers, codes")
        .onSubmit(of: .search) { Task { await app.wardrobe.applyFilters() } }
        .refreshable { await app.wardrobe.refresh() }
        .task { await app.wardrobe.open() }
        .toolbar { toolbar }
        .sheet(isPresented: $showsFilters) { WardrobeFilterSheet() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            if let counts = app.wardrobe.countsLine {
                Text(counts)
                    .font(.subheadline)
                    .accessibilityIdentifier(AXID.wardrobeCounts)
            }
            FreshnessLabel(text: app.wardrobe.freshnessLine, freshness: app.wardrobe.snapshot.freshness)
            Button { app.sheet = .laundry } label: { Label("Laundry", systemImage: "washer") }
                .secondaryAction()
                .accessibilityIdentifier(AXID.laundryButton)
            if app.wardrobe.isSearchingSavedCopy {
                Label("Offline: searching the wardrobe saved on this phone.", systemImage: "wifi.slash")
                    .font(.footnote).foregroundStyle(Color.supporting)
            }
            if app.wardrobe.isPartial {
                Label("Showing part of the wardrobe.", systemImage: "ellipsis.circle")
                    .font(.footnote).foregroundStyle(Color.supporting)
            }
            if !app.wardrobe.filters.isEmpty {
                Button("Clear filters") {
                    app.wardrobe.filters = WardrobeFilters()
                }
                .font(.footnote)
                .touchTarget()
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if app.wardrobe.snapshot.value == nil {
            ContentUnavailableView("Wardrobe not loaded", systemImage: "hanger", description: Text(app.wardrobe.freshnessLine))
        } else {
            ContentUnavailableView("Nothing matches", systemImage: "magnifyingglass", description: Text("No item matches the search and filters."))
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .secondaryAction) {
            Button { showsFilters = true } label: { Label("Filters", systemImage: "line.3.horizontal.decrease.circle") }
                .accessibilityIdentifier(AXID.wardrobeFilters)
            Button { app.wardrobe.prefersList.toggle() } label: {
                Label(app.wardrobe.prefersList ? "Show as grid" : "Show as list", systemImage: app.wardrobe.prefersList ? "square.grid.2x2" : "list.bullet")
            }
            .accessibilityIdentifier(AXID.wardrobeLayoutToggle)
            Button { app.push(.temperaturePreview) } label: { Label("Temperature preview", systemImage: "thermometer.medium") }
            Menu {
                ForEach(app.wardrobe.categories, id: \.self) { category in
                    Button(Phrases.category(category)) { app.push(.reconcile(category: category.rawValue)) }
                }
            } label: {
                Label("Correct counts", systemImage: "checklist")
            }
            Button { app.push(.bulkEdit) } label: { Label("Edit several items", systemImage: "square.and.pencil") }
                .accessibilityIdentifier(AXID.wardrobeBulkEdit)
            Button { app.push(.trips) } label: { Label("Trips", systemImage: "suitcase") }
            Button { app.push(.returns) } label: { Label("Returns", systemImage: "arrow.uturn.left.circle") }
        }
    }
}
