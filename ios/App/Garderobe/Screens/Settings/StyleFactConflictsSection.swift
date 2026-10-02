import SwiftUI
import GarderobeKit

/// What the last save did to the rules, measurements and size experiences that quote the
/// profile, exactly as the receipt reported it.
struct StyleSaveResultSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let diff = app.settings.lastFactDiff {
            Section("What the save changed") {
                Text(StyleFactPhrases.summary(diff))
                    .accessibilityIdentifier(AXID.styleSaveResult)
                ForEach(diff.applied, id: \.fact.id) { applied in
                    Label("\(applied.label): \(applied.action.rawValue)", systemImage: "checkmark.circle")
                        .font(.footnote)
                }
                if !diff.addedText.isEmpty {
                    Text("New or reworded text is kept as written. No rule or measurement is created from it; say it in Conversation if it should become one.")
                        .font(.footnote)
                        .foregroundStyle(Color.supporting)
                }
            }
        }
    }
}

/// The review before a save: what the backend says the edit touches, with the owner's
/// decision for each fact. Deciding is optional; an undecided fact stays in force.
struct StyleSavePreviewSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let settings = app.settings
        if let preview = settings.savePreview {
            Section {
                Text(StyleFactPhrases.previewSummary(preview.diff))
                    .accessibilityIdentifier(AXID.styleSavePreview)
                ForEach(preview.questions) { question in
                    StyleFactQuestionRow(question: question, decided: settings.saveDecisions[question.id]?.choice.kind) { choice, quote in
                        settings.decide(question, choice.map { StyleFactDecision($0, quoteNewWording: quote) })
                    }
                }
                Button(settings.isWorking ? "Saving..." : saveTitle(preview)) {
                    Task { await settings.confirmSave() }
                }
                .disabled(settings.isWorking)
                .accessibilityIdentifier(AXID.styleSaveConfirm)
                Button("Back to editing") { settings.cancelSavePreview() }
            } header: {
                Text("Before you save")
            }
        }
    }

    private func saveTitle(_ preview: StyleSavePreview) -> String {
        let undecided = preview.questions.count - app.settings.saveDecisions.count
        return undecided > 0 && !preview.questions.isEmpty ? "Save and decide \(undecided) later" : "Save as a new version"
    }
}

/// Facts whose passage an earlier edit removed or reworded. Each stays in force until the
/// owner decides; the app offers the decisions and never picks one.
struct StyleFactConflictsSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let questions = app.settings.openQuestions
        if !questions.isEmpty {
            Section {
                ForEach(questions) { question in
                    StyleFactQuestionRow(question: question, decided: nil) { choice, quote in
                        guard let choice, let conflict = question.conflict else { return }
                        Task { await app.settings.resolve(conflict, choice, quoteNewWording: quote) }
                    }
                }
            } header: {
                Text("Needs your decision (\(questions.count))")
            } footer: {
                Text("These still apply exactly as before. Decide each one when you like.")
            }
        }
    }
}

/// One affected fact with the decisions the backend accepts for its kind.
private struct StyleFactQuestionRow: View {
    @Environment(AppModel.self) private var app
    let question: StyleFactQuestion
    /// The decision already made in a save preview (nil for none, and for existing conflicts).
    let decided: StyleFactChoice.Kind?
    /// A choice, or nil to withdraw the decision made in the preview.
    let decide: (StyleFactChoice?, Bool) -> Void
    @State private var replacing = false
    @State private var value = ""
    @State private var unit: StyleFactResolution.MeasurementValue.Unit = .in
    @State private var quotesNewWording = false

    private var number: Double? { Double(value.replacingOccurrences(of: ",", with: ".")) }
    private var trimmedValue: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Text(question.label).font(.body.weight(.medium))
            Text("\(StyleFactPhrases.kind(question.fact.kind)). \(question.reasonLine)")
                .font(.footnote).foregroundStyle(Color.supporting)
            ForEach(question.previousQuotes, id: \.self) { quote in quoted("Before", quote) }
            if let now = question.newWording, !now.isEmpty { quoted("Now", now) }
            if let note = question.note, !note.isEmpty {
                Text(note).font(.footnote).foregroundStyle(Color.supporting)
            }
            if let decided {
                Label("Your decision: \(decided.title.lowercased())", systemImage: "checkmark.circle")
                    .font(.footnote)
                Button("Change this decision") { decide(nil, false) }.touchTarget()
            } else {
                choices
            }
        }
        .disabled(app.settings.isWorking)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.styleConflict(question.id))
    }

    @ViewBuilder private var choices: some View {
        if let now = question.newWording, !now.isEmpty {
            Toggle("The new wording states this", isOn: $quotesNewWording)
                .font(.footnote)
        }
        if question.allowed.contains(.keep) {
            Button(StyleFactChoice.Kind.keep.title) { decide(.keep, quotesNewWording) }.touchTarget()
        }
        if question.allowed.contains(.replace) {
            if replacing { replacement } else {
                Button(StyleFactChoice.Kind.replace.title) { replacing = true }.touchTarget()
            }
        }
        if question.allowed.contains(.retire) {
            Button(StyleFactChoice.Kind.retire.title, role: .destructive) { decide(.retire, false) }.touchTarget()
        }
        if question.fact.kind == .rule {
            Text("To change what this rule does, say so in Conversation.")
                .font(.footnote).foregroundStyle(Color.supporting)
        }
    }

    @ViewBuilder private var replacement: some View {
        if question.fact.kind == .measurement {
            TextField("New value", text: $value)
                .keyboardType(.decimalPad)
                .accessibilityLabel("New measurement value")
            Picker("Unit", selection: $unit) {
                Text("in").tag(StyleFactResolution.MeasurementValue.Unit.in)
                Text("cm").tag(StyleFactResolution.MeasurementValue.Unit.cm)
                Text("m").tag(StyleFactResolution.MeasurementValue.Unit.m)
                Text("UK shoe size").tag(StyleFactResolution.MeasurementValue.Unit.ukShoe)
            }
            Button("Record the new measurement") {
                if let number { decide(.replaceMeasurement(value: number, unit: unit), quotesNewWording) }
            }
            .disabled(number == nil)
            .touchTarget()
        } else {
            TextField("New size label", text: $value)
                .accessibilityLabel("New size label")
            Button("Record the new size") { decide(.replaceSize(label: trimmedValue), quotesNewWording) }
                .disabled(trimmedValue.isEmpty)
                .touchTarget()
        }
        Button("Cancel") { replacing = false; value = "" }.touchTarget()
    }

    private func quoted(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            Text(title).font(.caption).foregroundStyle(Color.supporting)
            Text(text).font(.footnote).textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}
