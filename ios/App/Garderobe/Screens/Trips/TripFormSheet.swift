import SwiftUI
import GarderobeKit

/// The direct form for a new trip. Validation is the draft's own (`problem`); the form only
/// edits the draft and sends it. Dates are civil dates in the owner's timezone.
struct TripFormSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TripsModel.TripDraft
    @State private var attempted = false

    /// - Parameter draft: a fresh draft from `TripsModel.newDraft()`.
    init(draft: TripsModel.TripDraft) { _draft = State(initialValue: draft) }

    private var zone: TimeZone { app.environment.timeZone }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $draft.name)
                    DatePicker("Departure", selection: date({ draft.departsOn }, { draft.departsOn = $0 }), displayedComponents: .date)
                    DatePicker("Return", selection: date({ draft.returnsOn }, { draft.returnsOn = $0 }), displayedComponents: .date)
                } header: {
                    Text("Trip")
                } footer: {
                    Text("You can also say this in Conversation in an ordinary sentence, for example \"Three days in Paris, one dinner, carry-on only.\"")
                }
                Section("Destination") {
                    TextField("Where", text: $draft.destinationLabel)
                    Picker("Timezone", selection: $draft.destinationTimezone) {
                        ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { identifier in
                            Text(identifier.replacingOccurrences(of: "_", with: " ")).tag(identifier)
                        }
                    }
                    .pickerStyle(.navigationLink)
                }
                Section {
                    TextField("For example: carry-on only", text: $draft.luggageLabel)
                    Stepper(value: Binding(get: { draft.luggageMaxPieces ?? 0 }, set: { draft.luggageMaxPieces = $0 == 0 ? nil : $0 }), in: 0...12) {
                        Text(piecesLine)
                    }
                } header: {
                    Text("Luggage")
                } footer: {
                    Text("Optional. A piece limit is sent together with the luggage description.")
                }
                occasions
                laundry
                Section {
                    if let problem = draft.problem {
                        Label(problem, systemImage: "exclamationmark.circle").font(.subheadline)
                    }
                    if attempted { OutcomeLine(outcome: app.trips.lastOutcome) }
                }
            }
            .environment(\.timeZone, zone) // the pickers show the same civil dates the draft stores
            .navigationTitle("New trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(draft.problem != nil || app.trips.isWorking)
                }
            }
        }
    }

    private var piecesLine: String {
        if let pieces = draft.luggageMaxPieces { return "At most \(Phrases.count(pieces, "piece"))" }
        return "No limit on pieces"
    }

    private var occasions: some View {
        Section {
            ForEach(Array(draft.occasions.indices), id: \.self) { index in
                TextField("What, for example dinner", text: Binding(
                    get: { draft.occasions.indices.contains(index) ? draft.occasions[index].label : "" },
                    set: { if draft.occasions.indices.contains(index) { draft.occasions[index].label = $0 } }))
                DatePicker("Date", selection: date(
                    { draft.occasions.indices.contains(index) ? draft.occasions[index].localDate : draft.departsOn },
                    { if draft.occasions.indices.contains(index) { draft.occasions[index].localDate = $0 } }), displayedComponents: .date)
                Toggle("In the evening", isOn: Binding(
                    get: { draft.occasions.indices.contains(index) && draft.occasions[index].evening },
                    set: { if draft.occasions.indices.contains(index) { draft.occasions[index].evening = $0 } }))
                Button(role: .destructive) {
                    if draft.occasions.indices.contains(index) { draft.occasions.remove(at: index) }
                } label: {
                    Label("Remove this occasion", systemImage: "minus.circle")
                }
            }
            Button {
                draft.occasions.append((label: "", localDate: draft.departsOn, evening: false))
            } label: {
                Label("Add an occasion", systemImage: "plus")
            }
        } header: {
            Text("Occasions")
        } footer: {
            Text("Optional. Anything that needs a particular outfit.")
        }
    }

    private var laundry: some View {
        Section {
            ForEach(Array(draft.laundryDates.indices), id: \.self) { index in
                DatePicker("Laundry possible on", selection: date(
                    { draft.laundryDates.indices.contains(index) ? draft.laundryDates[index] : draft.departsOn },
                    { if draft.laundryDates.indices.contains(index) { draft.laundryDates[index] = $0 } }), displayedComponents: .date)
                Button(role: .destructive) {
                    if draft.laundryDates.indices.contains(index) { draft.laundryDates.remove(at: index) }
                } label: {
                    Label("Remove this date", systemImage: "minus.circle")
                }
            }
            Button { draft.laundryDates.append(draft.departsOn) } label: { Label("Add a laundry date", systemImage: "plus") }
        } header: {
            Text("Laundry on the trip")
        } footer: {
            Text("Optional. Days on which washing is possible where you are staying.")
        }
    }

    /// A `Date` binding for a picker over a civil date in the draft, anchored at noon.
    private func date(_ get: @escaping () -> LocalDate, _ set: @escaping (LocalDate) -> Void) -> Binding<Date> {
        Binding(get: { Dates.noon(of: get(), in: zone) ?? app.environment.time.now() },
                set: { set(Dates.localDate(of: $0, in: zone)) })
    }

    private func create() async {
        let outcome = await app.trips.create(draft)
        attempted = true
        switch outcome {
        case .confirmed?, .queued?: dismiss() // the Trips screen shows the outcome line
        default: break
        }
    }
}
