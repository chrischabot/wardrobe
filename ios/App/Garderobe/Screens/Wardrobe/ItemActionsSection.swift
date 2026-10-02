import SwiftUI
import GarderobeKit

/// The direct one-tap commands for an item. For entries with several identical units the
/// owner sets a quantity; the app never asks which individual pair.
struct ItemActionsSection: View {
    @Environment(AppModel.self) private var app
    let model: ItemModel
    @State private var quantities: [String: Int] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            SectionHeading(title: "Actions")
            ForEach(model.availableActions) { action in
                actionRow(action)
            }
            if model.garment?.acquisition == .owned {
                Button { Task { await model.woreIt() } } label: {
                    Label("I wore this today", systemImage: "checkmark.circle")
                        .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
                }
                .secondaryAction()
                .disabled(model.isSubmitting)
                .accessibilityIdentifier(AXID.itemAction("woreToday"))
            }
            Button {
                if let garment = model.garment { app.askAbout(model.askAboutReference, label: garment.name) }
            } label: {
                Text("For anything else, such as a correction or a sale, say it in Conversation.")
                    .font(.footnote)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
    }

    @ViewBuilder private func actionRow(_ action: ItemAction) -> some View {
        let maximum = model.maximumQuantity(for: action)
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            if maximum > 1 {
                Stepper(value: quantity(for: action, maximum: maximum), in: 1...maximum) {
                    Text("\(action.title): \(quantities[action.rawValue] ?? 1) of \(maximum)")
                }
                .accessibilityValue("\(quantities[action.rawValue] ?? 1) of \(maximum)")
            }
            Button {
                Task { await model.perform(action, quantity: maximum > 1 ? (quantities[action.rawValue] ?? 1) : nil) }
            } label: {
                Label(action.title, systemImage: action.symbol)
                    .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
            }
            .secondaryAction()
            .disabled(model.isSubmitting)
            .accessibilityIdentifier(AXID.itemAction(action.rawValue))
        }
    }

    private func quantity(for action: ItemAction, maximum: Int) -> Binding<Int> {
        Binding(get: { min(quantities[action.rawValue] ?? 1, maximum) }, set: { quantities[action.rawValue] = $0 })
    }
}

/// Availability and, behind a disclosure, the basis of the estimate. Probabilities live here,
/// in the item detail, and not on Today.
struct ItemAvailabilitySection: View {
    let model: ItemModel

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            SectionHeading(title: "Availability")
            Text(model.statusLine)
            ForEach(model.restrictionLines, id: \.self) { line in
                Label(line, systemImage: "exclamationmark.circle").font(.subheadline)
            }
            if !model.availabilityBasis.isEmpty {
                DisclosureGroup("Why") {
                    VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                        ForEach(model.availabilityBasis, id: \.self) { line in
                            Text(line).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let availability = model.availability, availability.status == .estimated {
                            Text("Estimated chance that a clean one is at home: \(Int((availability.pAvailable * 100).rounded())) percent. This is an estimate, not an observation.")
                                .font(.footnote)
                                .foregroundStyle(Color.supporting)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.top, Metrics.unit * 2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
    }
}
