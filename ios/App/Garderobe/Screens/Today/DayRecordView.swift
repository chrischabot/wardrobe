import SwiftUI
import GarderobeKit

/// The day once a wear is recorded: what was worn, by name. It is a record, not a suggestion,
/// so nothing restyles it. An explicit correction or an explicit request for another outfit
/// are the only ways it changes or gains company.
struct DayRecordView: View {
    @Environment(AppModel.self) private var app
    @State private var showsCorrection = false
    @State private var anotherBrief = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 8) {
            record
            another
        }
        .sheet(isPresented: $showsCorrection) { DayRecordCorrectionSheet() }
    }

    private var record: some View {
        let worn = app.today.dayRecord
        return VStack(alignment: .leading, spacing: Metrics.unit * 5) {
            SectionHeading(title: "What you wore today")
            OutfitComposition(garments: worn, label: "What you wore today: \(Phrases.list(worn.map(\.name)))")
            VStack(alignment: .leading, spacing: Metrics.unit * 3) {
                ForEach(worn) { line in Text(line.name).font(.title3) }
            }
            Text("This is today's record. It will not be restyled.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button { showsCorrection = true } label: { Label("Correct this", systemImage: "pencil") }
                .secondaryAction()
                .controlSize(.large)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.todayDayRecord)
    }

    private var another: some View {
        let today = app.today
        let brief = anotherBrief.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(alignment: .leading, spacing: Metrics.unit * 4) {
            SectionHeading(title: "Another outfit for later")
            Text("Ask for one more outfit, for dinner for example. Today's record stays as it is.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField("What is it for? (optional)", text: $anotherBrief, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .frame(minHeight: Metrics.touch)
            Button {
                Task { await today.requestAnother(brief: brief.isEmpty ? nil : brief) }
            } label: {
                Label("Ask for another outfit", systemImage: "plus")
            }
            .secondaryAction()
            .controlSize(.large)
            .disabled(today.isSubmitting)
            if today.runId != nil {
                Label("Your request is being prepared.", systemImage: "hourglass").font(.subheadline)
            }
            if let note = today.extraNote {
                Text(note).font(.subheadline)
            }
            ForEach(today.extraOptions) { option in extra(option) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// An outfit returned by the explicit request. Shown beside the record, never merged into it.
    private func extra(_ option: BoardOption) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 4) {
            OutfitComposition(garments: option.garments, label: "\(option.name). \(Phrases.list(option.garments.map(\.name))). \(option.reason)")
            Text(option.name).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
            Text(option.reason)
            VStack(alignment: .leading, spacing: Metrics.unit * 3) {
                ForEach(option.garments) { line in Text(line.name).font(.body) }
            }
            if let qualification = option.qualification {
                Label(qualification, systemImage: "info.circle").font(.subheadline).foregroundStyle(.secondary)
            }
            Button {
                Task { await app.today.wore(garments: option.garments.map { (id: $0.garmentId, name: $0.name) }) }
            } label: {
                Label("I wore this", systemImage: "tshirt").frame(maxWidth: .infinity)
            }
            .secondaryAction()
            .controlSize(.large)
            .disabled(app.today.isSubmitting)
            .accessibilityHint("Records \(Phrases.list(option.garments.map(\.name))) as worn today, in addition to today's record.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
        .accessibilityElement(children: .contain)
    }
}

/// Correct this: remove garments that were recorded but not worn. An amendment replaces only
/// the facts it corrects; the original receipt stays in history.
struct DayRecordCorrectionSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var removing: Set<String> = []
    @State private var reason = ""
    @State private var outcome: SubmissionOutcome?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(app.today.dayRecord) { line in
                        Toggle(line.name, isOn: Binding(
                            get: { removing.contains(line.garmentId) },
                            set: { on in if on { removing.insert(line.garmentId) } else { removing.remove(line.garmentId) } }))
                            .accessibilityLabel("Remove \(line.name)")
                    }
                } header: {
                    Text("Remove from today's record")
                } footer: {
                    Text("Switch on anything that was recorded but not worn. To add a garment you did wear, say so in Conversation.")
                }
                Section {
                    TextField("Reason (optional)", text: $reason, axis: .vertical)
                }
                if outcome != nil {
                    Section { OutcomeLine(outcome: outcome) }
                }
            }
            .navigationTitle("Correct today")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Remove") { Task { await submit() } }
                        .disabled(removing.isEmpty || app.today.isSubmitting)
                }
            }
        }
    }

    private func submit() async {
        let ids = app.today.dayRecord.map(\.garmentId).filter { removing.contains($0) }
        let note = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        outcome = await app.today.amend(remove: ids, add: [], reason: note.isEmpty ? nil : note)
        switch outcome {
        case .confirmed?, .queued?: dismiss() // Today shows the outcome line and the undo banner
        default: break
        }
    }
}
