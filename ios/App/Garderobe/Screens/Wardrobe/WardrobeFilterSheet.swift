import SwiftUI
import GarderobeKit

/// Filters for category, availability, colour, season, location and last recorded wear.
struct WardrobeFilterSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    private static let availabilityChoices: [(AvailabilityStatus, String)] = [
        (.available, "Available"), (.estimated, "Probably available"), (.conditional, "Available on request"), (.unavailable, "Not available"),
    ]
    private static let locationChoices: [(InventoryQuery.Location, String)] = [
        (.home, "At home"), (.storage, "In storage"), (.tailor, "At the tailor"), (.trip, "Packed for a trip"), (.service, "At the laundry"),
    ]

    var body: some View {
        @Bindable var wardrobe = app.wardrobe
        NavigationStack {
            Form {
                Section("Category") {
                    Picker("Category", selection: $wardrobe.filters.category) {
                        Text("Any").tag(GarmentCategory?.none)
                        ForEach(app.wardrobe.categories, id: \.self) { Text(Phrases.category($0)).tag(GarmentCategory?.some($0)) }
                    }
                }
                Section("Availability") {
                    Picker("Availability", selection: $wardrobe.filters.availability) {
                        Text("Any").tag(AvailabilityStatus?.none)
                        ForEach(Self.availabilityChoices, id: \.0) { Text($0.1).tag(AvailabilityStatus?.some($0.0)) }
                    }
                }
                Section("Colour") {
                    Picker("Colour", selection: $wardrobe.filters.colour) {
                        Text("Any").tag(String?.none)
                        ForEach(app.wardrobe.colours, id: \.self) { Text($0).tag(String?.some($0)) }
                    }
                }
                Section("Season") {
                    Picker("Season", selection: $wardrobe.filters.season) {
                        Text("Any").tag(String?.none)
                        ForEach(app.wardrobe.seasons, id: \.self) { Text($0).tag(String?.some($0)) }
                    }
                }
                Section("Location") {
                    Picker("Location", selection: $wardrobe.filters.location) {
                        Text("Anywhere").tag(InventoryQuery.Location?.none)
                        ForEach(Self.locationChoices, id: \.0) { Text($0.1).tag(InventoryQuery.Location?.some($0.0)) }
                    }
                }
                Section {
                    Picker("Last recorded wear", selection: $wardrobe.filters.lastWear) {
                        ForEach(LastWearFilter.allCases) { Text($0.title).tag($0) }
                    }
                } header: {
                    Text("Last recorded wear")
                } footer: {
                    Text("Wear logging started recently. No wear logged does not mean unworn.")
                }
                Section {
                    Toggle("Include retired items", isOn: $wardrobe.filters.includeRetired)
                }
                Section {
                    Button("Clear all filters", role: .destructive) { app.wardrobe.filters = WardrobeFilters() }
                        .disabled(app.wardrobe.filters.isEmpty)
                }
            }
            .navigationTitle("Filters")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        Task { await app.wardrobe.applyFilters() }
                        dismiss()
                    }
                }
            }
        }
    }
}
