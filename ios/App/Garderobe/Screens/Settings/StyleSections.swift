import SwiftUI
import GarderobeKit

/// Active amendments to the profile: later statements that apply on top of the document.
struct StyleAmendmentsSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let amendments = app.settings.activeAmendments
        Section {
            if amendments.isEmpty {
                Text("No amendments are active.").foregroundStyle(.secondary)
            }
            ForEach(amendments) { amendment in
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(amendment.text)
                    Text("\(kindName(amendment.kind)) \u{00B7} added \(SettingsInstant(app: app).relative(amendment.createdAt)) \u{00B7} written against profile version \(amendment.basedOnVersion)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Amendments")
        } footer: {
            Text("An amendment takes precedence over the profile text where it is newer.")
        }
    }

    private func kindName(_ kind: StyleAmendment.Kind) -> String {
        switch kind {
        case .restriction: return "Restriction"
        case .measurement: return "Measurement"
        case .size: return "Size"
        case .physicalState: return "Physical state"
        case .taste: return "Taste"
        case .other, .unknown: return "Other"
        }
    }
}

/// Standing directions: retire one, or add one. Both are commands with a receipt.
struct StyleDirectionsSection: View {
    @Environment(AppModel.self) private var app
    @State private var newDirection = ""

    var body: some View {
        let settings = app.settings
        Section {
            if settings.activeDirections.isEmpty {
                Text("No standing directions.").foregroundStyle(.secondary)
            }
            ForEach(settings.activeDirections) { direction in
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(direction.text)
                    Text("Added \(SettingsInstant(app: app).relative(direction.createdAt))")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button("Retire") {
                        Task { await settings.retireDirection(direction.directionId) }
                    }
                    .buttonStyle(.borderless)
                    .touchTarget()
                    .disabled(settings.isWorking)
                    .accessibilityLabel("Retire: \(direction.text)")
                }
            }
        } header: {
            Text("Standing directions")
        }
        Section {
            TextField("A direction that always applies", text: $newDirection, axis: .vertical)
                .accessibilityLabel("New standing direction")
            Button("Add direction") {
                Task {
                    // The field is cleared only once the text is recorded or safely waiting on the phone.
                    switch await settings.addDirection(newDirection) {
                    case .confirmed?, .queued?: newDirection = ""
                    default: break
                    }
                }
            }
            .disabled(settings.isWorking || newDirection.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } header: {
            Text("Add a direction")
        }
    }
}
