import SwiftUI
import GarderobeKit

/// One option on the board: the composition, the name, why it works, the garments by name,
/// one primary action (Choose) and the secondary actions. Details expand in place.
struct OptionCard: View {
    @Environment(AppModel.self) private var app
    let option: OptionPresentation
    /// Set when a Calendar or web-board link pointed at this option.
    var isHighlighted = false
    @State private var showsDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 5) {
            OutfitComposition(garments: option.visibleGarments, label: option.accessibilityLabel)
            VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                if isHighlighted {
                    Label("Opened from your link", systemImage: "link").font(.footnote).foregroundStyle(Color.supporting)
                }
                Text(option.option.name).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Text(option.option.reason).font(.body)
            }
            VStack(alignment: .leading, spacing: Metrics.unit * 3) {
                ForEach(option.visibleGarments) { line in Text(line.name).font(.title3) }
            }
            if let qualification = option.option.qualification {
                Label(qualification, systemImage: "info.circle").font(.subheadline).foregroundStyle(Color.supporting)
            }
            if !option.footwearChoices.isEmpty { footwear }
            if let flourish = option.option.flourish { flourishControl(flourish) }
            chooseAction
            secondaryActions
            details
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
        .overlay {
            if isHighlighted {
                RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.option(option.id))
    }

    /// Picking a shoe changes the visible outfit, so the wear action records exactly one pair.
    private var footwear: some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            Text("Shoes").font(.subheadline).foregroundStyle(Color.supporting)
            ForEach(option.footwearChoices) { choice in
                let selected = choice.garmentId == option.selectedFootwearId
                Button {
                    app.today.pickFootwear(optionId: option.id, garmentId: choice.garmentId)
                } label: {
                    Label(choice.name, systemImage: selected ? "checkmark.circle.fill" : "circle")
                        .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier(AXID.optionFootwear(option.id, choice.garmentId))
            }
        }
    }

    /// The optional scarf or tie. It is recorded as worn only when the owner says so.
    private func flourishControl(_ flourish: BoardGarmentLine) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            Text("Optional: \(flourish.name)").font(.subheadline).foregroundStyle(Color.supporting)
            Toggle("Wearing the \(flourish.name) too", isOn: Binding(
                get: { option.flourishWorn },
                set: { app.today.setFlourishWorn($0, optionId: option.id) }))
                .frame(minHeight: Metrics.touch)
        }
    }

    @ViewBuilder private var chooseAction: some View {
        if option.isChosen {
            VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                Label("Chosen for today", systemImage: "checkmark.circle.fill")
                    .font(.headline)
                    .accessibilityIdentifier(AXID.optionChoose(option.id))
                Button("Clear choice") { Task { await app.today.clearChoice() } }
                    .secondaryAction()
                    .controlSize(.large)
                    .disabled(app.today.isSubmitting)
            }
        } else {
            Button {
                Task { await app.today.choose(optionId: option.id) }
            } label: {
                Label("Choose", systemImage: "checkmark").frame(maxWidth: .infinity)
            }
            .primaryAction()
            .controlSize(.large)
            .disabled(app.today.isSubmitting)
            .accessibilityHint("Records what you intend to wear. It does not record a wear.")
            .accessibilityIdentifier(AXID.optionChoose(option.id))
        }
    }

    private var secondaryActions: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Button {
                Task { await app.today.woreThis(optionId: option.id) }
            } label: {
                Label("I wore this", systemImage: "tshirt").frame(maxWidth: .infinity)
            }
            .secondaryAction()
            .controlSize(.large)
            .disabled(app.today.isSubmitting)
            .accessibilityHint("Records \(Phrases.list(option.wearNames)) as worn today.")
            .accessibilityIdentifier(AXID.optionWore(option.id))

            ViewThatFits(in: .horizontal) {
                HStack(spacing: Metrics.unit * 2) { swapMenu; askButton }
                VStack(alignment: .leading, spacing: Metrics.unit * 2) { swapMenu; askButton }
            }
        }
    }

    /// Swap names a slot; the backend picks the replacement and leaves the rest untouched.
    private var swapMenu: some View {
        Menu {
            ForEach(option.visibleGarments) { line in
                Button("\(Phrases.role(line.role)): \(line.name)") {
                    Task { await app.today.swap(optionId: option.id, role: line.role) }
                }
            }
        } label: {
            Label("Swap", systemImage: "arrow.triangle.2.circlepath")
        }
        .secondaryAction()
        .controlSize(.large)
        .disabled(app.today.isSubmitting)
        .accessibilityHint("Choose which piece to replace. The rest of the outfit stays.")
        .accessibilityIdentifier(AXID.optionSwap(option.id))
    }

    private var askButton: some View {
        Button {
            if let ref = app.today.askAboutReference(optionId: option.id) { app.askAbout(ref, label: option.option.name) }
        } label: {
            Label("Ask about this", systemImage: "bubble.left")
        }
        .secondaryAction()
        .controlSize(.large)
        .accessibilityHint("Opens Conversation with this outfit attached.")
        .accessibilityIdentifier(AXID.optionAsk(option.id))
    }

    private var details: some View {
        DisclosureGroup("Details", isExpanded: $showsDetails) {
            VStack(alignment: .leading, spacing: Metrics.unit * 3) {
                ForEach(option.visibleGarments) { line in
                    DetailRow(label: Phrases.role(line.role), value: [line.name, line.colour].compactMap { $0 }.joined(separator: ", "))
                }
                if let flourish = option.option.flourish {
                    DetailRow(label: "Optional", value: flourish.name)
                }
                Text("Option \(option.option.number) on this board.").font(.footnote).foregroundStyle(Color.supporting)
                if option.option.changedInRevision {
                    Text("Changed in the latest update to this board.").font(.footnote).foregroundStyle(Color.supporting)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, Metrics.unit * 2)
        }
        .frame(minHeight: Metrics.touch)
    }
}
