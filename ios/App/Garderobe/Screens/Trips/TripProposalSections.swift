import SwiftUI
import GarderobeKit

/// The sections of a trip page that show the backend's proposal: the proposed packing list
/// (with how much of it is packed so far), the day-by-day combinations, and the weather and
/// notes the proposal was made with. A proposal is a suggestion; nothing here is packed.
struct TripProposalSections: View {
    @Environment(AppModel.self) private var app
    let trip: Trip

    var body: some View {
        list
        if let proposal = trip.proposal {
            if !proposal.days.isEmpty { days(proposal) }
            if !proposal.weather.isEmpty || !proposal.notes.isEmpty { basis(proposal) }
        }
    }

    private var list: some View {
        let trips = app.trips
        let rows = trips.packingRows(trip)
        return Section {
            if rows.isEmpty {
                Text("No packing proposal yet.").foregroundStyle(Color.supporting)
            }
            ForEach(rows.indices, id: \.self) { index in
                let row = rows[index]
                LabeledContent(row.item.name, value: "Proposed \(row.item.quantity), packed \(row.packed)")
            }
            Button { Task { await trips.proposePacking(trip) } } label: {
                Label(trip.proposal == nil ? "Ask for a packing proposal" : "Ask for a new packing proposal", systemImage: "list.bullet.clipboard")
            }
            .disabled(trips.isWorking || trip.status == .cancelled)
            if let note = trips.proposalNote {
                Label(note, systemImage: "exclamationmark.triangle").font(.subheadline)
            }
        } header: {
            Text("Proposed packing list")
        } footer: {
            Text("A proposal is a suggestion and needs a connection to request. Nothing is packed until you say Packed.")
        }
    }

    private func days(_ proposal: PackingProposal) -> some View {
        Section {
            ForEach(proposal.days.indices, id: \.self) { index in
                let day = proposal.days[index]
                let names = garmentNames(day, in: proposal)
                VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                    Text(title(day)).font(.headline)
                    ForEach(names.indices, id: \.self) { position in Text(names[position]) }
                    Text(day.reason).font(.subheadline).foregroundStyle(Color.supporting)
                    Button { Task { await app.trips.wore(trip, day: day) } } label: {
                        Label("I wore this", systemImage: "tshirt").frame(minHeight: Metrics.touch)
                    }
                    .buttonStyle(.borderless)
                    .disabled(app.trips.isWorking)
                    .accessibilityHint("Records \(Phrases.list(names)) as worn on \(Phrases.dayMonth(day.localDate)).")
                }
                .padding(.vertical, Metrics.unit)
            }
        } header: {
            Text("Proposed combinations")
        }
    }

    /// The destination weather lines and notes the proposal was composed with.
    private func basis(_ proposal: PackingProposal) -> some View {
        Section {
            ForEach(proposal.weather.indices, id: \.self) { index in
                let weather = proposal.weather[index]
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text("\(weather.label), \(Phrases.dayMonth(weather.localDate))").font(.subheadline.weight(.semibold))
                    Text(weather.line)
                    if let stale = caveat(weather.freshness) {
                        Label(stale, systemImage: "clock").font(.footnote).foregroundStyle(Color.supporting)
                    }
                }
                .accessibilityElement(children: .combine)
            }
            ForEach(proposal.notes.indices, id: \.self) { index in
                Text(proposal.notes[index])
            }
        } header: {
            Text("Weather and notes")
        }
    }

    /// `Tuesday 15 September, evening: Dinner`.
    private func title(_ day: PackingDayPlan) -> String {
        var text = Phrases.weekdayDayMonth(day.localDate)
        if day.segment == .evening { text += ", evening" }
        if let occasion = day.occasion { text += ": \(occasion)" }
        return text
    }

    /// A day's garments by the names the proposal's own item list gives them.
    private func garmentNames(_ day: PackingDayPlan, in proposal: PackingProposal) -> [String] {
        day.slots.map { slot in
            proposal.items.first { $0.garmentId == slot.garmentId }?.name ?? Phrases.role(slot.role)
        }
    }

    private func caveat(_ freshness: WeatherFreshness) -> String? {
        switch freshness {
        case .stale: return "This forecast was out of date when the proposal was made."
        case .unavailable: return "No forecast was available when the proposal was made."
        case .fresh, .unknown: return nil
        }
    }
}
