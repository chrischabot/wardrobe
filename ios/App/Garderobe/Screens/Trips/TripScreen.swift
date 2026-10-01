import SwiftUI
import GarderobeKit

/// One trip. "Packed" is what is physically in the bag, from the ledger; the proposal is a
/// suggestion and is shown separately (`TripProposalSections`). The page is cached, so it
/// reads the same without a connection, with the freshness line saying when it was checked.
struct TripScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let tripId: String
    @State private var confirmsCancel = false
    @State private var showsPicker = false

    init(tripId: String) { self.tripId = tripId }

    var body: some View {
        let trips = app.trips
        let trip = trips.trip(tripId)
        List {
            Section {
                FreshnessLabel(text: trips.freshnessLine, freshness: trips.trips.freshness)
                OutcomeLine(outcome: trips.lastOutcome)
            }
            if let trip {
                details(trip)
                packed(trip)
                TripProposalSections(trip: trip)
                if trip.status != .cancelled {
                    Section {
                        Button(role: .destructive) { confirmsCancel = true } label: { Label("Cancel trip", systemImage: "xmark.circle") }
                            .disabled(trips.isWorking)
                    }
                }
            } else if trips.trips.value != nil {
                Section { Text("This trip is not in your list of trips.").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(trip?.name ?? "Trip")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await trips.trips.refresh() }
        .task { await trips.open() }
        .confirmationDialog("Cancel this trip?", isPresented: $confirmsCancel, titleVisibility: .visible) {
            Button("Cancel trip", role: .destructive) {
                guard let trip else { return }
                Task {
                    let outcome = await trips.cancel(trip)
                    switch outcome {
                    case .confirmed, .queued: dismiss() // the Trips screen shows the outcome line
                    default: break
                    }
                }
            }
            Button("Keep trip", role: .cancel) {}
        } message: {
            Text("The trip will be cancelled and will leave your list of trips.")
        }
    }

    private func details(_ trip: Trip) -> some View {
        Section {
            Text(app.trips.datesLine(trip))
            if trip.status == .cancelled {
                Label("This trip is cancelled.", systemImage: "xmark.circle")
            }
            ForEach(trip.destinations.indices, id: \.self) { index in
                let destination = trip.destinations[index]
                LabeledContent(destination.label, value: "\(Phrases.dayMonth(destination.from)) to \(Phrases.dayMonth(destination.to)), \(destination.timezone.replacingOccurrences(of: "_", with: " "))")
            }
            ForEach(trip.occasions.indices, id: \.self) { index in
                let occasion = trip.occasions[index]
                LabeledContent(occasion.label, value: Phrases.dayMonth(occasion.localDate) + (occasion.segment == .evening ? ", evening" : ""))
            }
            if let luggage = trip.luggage {
                LabeledContent("Luggage", value: luggageLine(luggage))
            }
            ForEach(trip.laundry.indices, id: \.self) { index in
                let laundry = trip.laundry[index]
                LabeledContent("Laundry possible", value: laundryLine(laundry))
            }
        } header: {
            Text("Trip")
        }
    }

    /// Physically packed quantities. Never inferred from the proposal.
    private func packed(_ trip: Trip) -> some View {
        let trips = app.trips
        return Section {
            Text(trips.packedLine(trip)).font(.headline)
            ForEach(trip.packed.indices, id: \.self) { index in
                let item = trip.packed[index]
                LabeledContent(item.name, value: item.worn == 0 ? "\(item.clean) packed" : "\(item.clean) clean, \(item.worn) worn")
            }
            Button { Task { await trips.packedProposal(trip) } } label: { Label("Packed", systemImage: "suitcase") }
                .disabled(trips.isWorking || trip.proposal == nil)
                .accessibilityHint("Records everything on the proposed list that is not packed yet as in the bag.")
            Button { showsPicker = true } label: { Label("Pack other items", systemImage: "plus.circle") }
                .disabled(trips.isWorking)
                .accessibilityHint("Choose garments and how many of each went into the bag.")
                .sheet(isPresented: $showsPicker) { PackingPickerSheet(tripId: trip.tripId) }
            Button { Task { await trips.unpacked(trip) } } label: { Label("Unpacked", systemImage: "house") }
                .disabled(trips.isWorking)
                .accessibilityHint("Records the clothes as home again. It does not mark anything clean.")
        } header: {
            Text("Packed")
        } footer: {
            Text("What is physically in the bag. Packed records the proposed list as packed; Pack other items records what you choose. Unpacked brings the clothes home without marking anything clean; a wash report or the next care cycle does that.")
        }
    }

    private func luggageLine(_ luggage: Trip.Luggage) -> String {
        if let pieces = luggage.maxPieces { return "\(luggage.label), at most \(Phrases.count(pieces, "piece"))" }
        return luggage.label
    }

    private func laundryLine(_ laundry: Trip.LaundryItem) -> String {
        if let note = laundry.note { return "\(Phrases.dayMonth(laundry.localDate)), \(note)" }
        return Phrases.dayMonth(laundry.localDate)
    }
}
