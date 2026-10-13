import SwiftUI
import GarderobeKit

/// Identifying details (manufacturer terminology belongs here), care, wear, recorded facts
/// with their sources, and known combinations.
struct ItemFactsSection: View {
    @Environment(AppModel.self) private var app
    let model: ItemModel

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 5) {
            if !model.identityRows.isEmpty {
                group("Details") {
                    ForEach(model.identityRows, id: \.label) { row in DetailRow(label: row.label, value: row.value) }
                }
            }
            group("Care and wear") {
                if !model.careLine.isEmpty { Text(model.careLine) }
                if let wear = model.wearLine { Text(wear) }
                if let caveat = model.detail?.wearCountCaveat, !caveat.isEmpty {
                    Text(caveat).font(.footnote).foregroundStyle(Color.supporting)
                }
                if let wears = model.detail?.recentWears.filter({ $0.status == .active }), !wears.isEmpty {
                    Text("Recently worn: " + Phrases.list(wears.prefix(8).map { Phrases.dayMonth($0.wearingDate) }))
                        .font(.footnote).foregroundStyle(Color.supporting)
                }
            }
            if !model.measurements.isEmpty {
                group("Measurements") {
                    ForEach(model.measurements, id: \.measurementId) { measurement in
                        let row = StyleFactPhrases.measurement(measurement)
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            DetailRow(label: row.label, value: row.value)
                            Text(row.note).font(.caption).foregroundStyle(Color.supporting)
                        }
                    }
                }
            }
            facts(model.measurements.isEmpty ? "Measurements" : "Other recorded sizes", model.measurementFacts)
            facts("Purchase", model.purchaseFacts)
            facts("Alterations", model.alterationFacts)
            facts("Other recorded facts", model.otherFacts)
            if !model.knownCombinations.isEmpty {
                group("Known combinations") {
                    ForEach(model.knownCombinations) { combination in
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(combination.name ?? "Saved combination")
                            Text("\(Phrases.count(combination.slots.count, "piece"))" + (combination.validation.valid ? "" : " · not wearable as checked"))
                                .font(.footnote).foregroundStyle(Color.supporting)
                            Button("Open in Studio") {
                                app.studio.show(combination)
                                app.selectedTab = .studio
                            }
                            .touchTarget()
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private func facts(_ title: String, _ facts: [GarmentFact]) -> some View {
        if !facts.isEmpty {
            group(title) {
                ForEach(facts) { fact in
                    VStack(alignment: .leading, spacing: Metrics.unit) {
                        DetailRow(label: fact.attribute.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: ".", with: " "), value: ItemModel.factValue(fact))
                        Text("Source: \(fact.source.kind.rawValue.replacingOccurrences(of: "_", with: " "))")
                            .font(.caption).foregroundStyle(Color.supporting)
                    }
                }
            }
        }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            SectionHeading(title: title)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
    }
}

/// Optional comfort feedback. Offered, never prompted: no rating scale, no questionnaire.
struct ItemFeedbackSection: View {
    let model: ItemModel
    @State private var text = ""
    @State private var kind: ComfortKind = .otherDiscomfort

    static func name(_ kind: ComfortKind) -> String {
        switch kind {
        case .tooWarm: return "Too warm"
        case .tooCold: return "Too cold"
        case .scratchy: return "Scratchy"
        case .pain: return "Hurts"
        case .tight: return "Too tight"
        case .loose: return "Too loose"
        case .restrictive: return "Restrictive"
        case .otherDiscomfort: return "Other discomfort"
        case .positive: return "Comfortable"
        case .unknown: return "Other"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            SectionHeading(title: "Comfort notes")
            ForEach((model.feedback.value?.feedback ?? []).filter { $0.status == .active }) { entry in
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(entry.text)
                    Text([Self.name(entry.kind), entry.wearingDate.map(Phrases.dayMonth), entry.scope].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Color.supporting)
                    Button("Remove", role: .destructive) { Task { await model.retractFeedback(entry.feedbackId) } }
                        .font(.footnote)
                        .touchTarget()
                }
            }
            TextField("A note if you want, such as: too warm on the train", text: $text, axis: .vertical)
                .textFieldStyle(.roundedBorder)
            Picker("Kind", selection: $kind) {
                ForEach(ComfortKind.allCases.filter { $0 != .unknown }, id: \.self) { Text(Self.name($0)).tag($0) }
            }
            Button("Save note") {
                Task {
                    let outcome = await model.recordFeedback(text: text, kind: kind)
                    if case .confirmed? = outcome { text = "" }
                    if case .queued? = outcome { text = "" }
                }
            }
            .secondaryAction()
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSubmitting)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
    }
}
