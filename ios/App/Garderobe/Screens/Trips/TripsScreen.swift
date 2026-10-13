import SwiftUI
import GarderobeKit

/// Trips: the planned trips, cached for use without a connection, and a direct form for a new one.
struct TripsScreen: View {
    @Environment(AppModel.self) private var app
    @State private var showsForm = false

    var body: some View {
        let trips = app.trips
        List {
            Section {
                FreshnessLabel(text: trips.freshnessLine, freshness: trips.trips.freshness)
                OutcomeLine(outcome: trips.lastOutcome)
            }
            Section {
                ForEach(trips.activeTrips) { trip in
                    NavigationLink(value: AppRoute.trip(tripId: trip.tripId)) {
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(trip.name).font(.headline)
                            Text(trips.datesLine(trip)).font(.subheadline)
                            Text(trips.packedLine(trip)).font(.subheadline).foregroundStyle(Color.supporting)
                        }
                        .padding(.vertical, Metrics.unit)
                    }
                    .accessibilityElement(children: .combine)
                }
                // Only say there are none once the list has actually been read (live or from the cache).
                if trips.activeTrips.isEmpty, trips.trips.value != nil {
                    Text("No trips planned.").foregroundStyle(Color.supporting)
                }
            } header: {
                Text("Trips")
            }
            Section {
                Button { showsForm = true } label: { Label("New trip", systemImage: "plus") }
            } footer: {
                Text("You can also describe a trip in Conversation in an ordinary sentence, for example \"Three days in Paris, one dinner, carry-on only.\"")
            }
        }
        .navigationTitle("Trips")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showsForm = true } label: { Label("New trip", systemImage: "plus") }
            }
        }
        .refreshable { await trips.trips.refresh() }
        .task { await trips.open() }
        .sheet(isPresented: $showsForm) { TripFormSheet(draft: trips.newDraft()) }
    }
}
