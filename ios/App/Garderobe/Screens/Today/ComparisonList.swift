import SwiftUI
import GarderobeKit

/// Every candidate in one compact list, for scanning instead of swiping. Each row names its
/// garments and offers the same Choose and I wore this actions as the card, as visible buttons.
struct ComparisonList: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize
    let options: [OptionPresentation]
    var highlightedId: String?

    var body: some View {
        VStack(spacing: Metrics.unit * 4) {
            ForEach(options) { option in
                row(option).id(option.id)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.todayComparisonList)
    }

    private func row(_ option: OptionPresentation) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Metrics.unit * 3) {
                    composition(option).frame(maxWidth: 160)
                    names(option)
                }
            } else {
                HStack(alignment: .top, spacing: Metrics.unit * 3) {
                    composition(option).frame(width: 112)
                    names(option)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Metrics.unit * 2) { actions(option) }
                VStack(alignment: .leading, spacing: Metrics.unit * 2) { actions(option) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface(padding: Metrics.unit * 3)
        .overlay {
            if option.id == highlightedId {
                RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.option(option.id))
    }

    private func composition(_ option: OptionPresentation) -> some View {
        OutfitComposition(garments: option.visibleGarments, label: option.accessibilityLabel, compact: true)
    }

    private func names(_ option: OptionPresentation) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            if option.id == highlightedId {
                Label("Opened from your link", systemImage: "link").font(.footnote).foregroundStyle(Color.supporting)
            }
            Text(option.option.name).font(.headline).accessibilityAddTraits(.isHeader)
            if option.isChosen {
                Label("Chosen for today", systemImage: "checkmark.circle.fill").font(.subheadline.weight(.semibold))
            }
            VStack(alignment: .leading, spacing: Metrics.unit) {
                ForEach(option.visibleGarments) { line in Text(line.name).font(.subheadline) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func actions(_ option: OptionPresentation) -> some View {
        if option.isChosen {
            Button("Clear choice") { Task { await app.today.clearChoice() } }
                .secondaryAction()
                .controlSize(.large)
                .disabled(app.today.isSubmitting)
        } else {
            Button {
                Task { await app.today.choose(optionId: option.id) }
            } label: {
                Label("Choose", systemImage: "checkmark")
            }
            .primaryAction()
            .controlSize(.large)
            .disabled(app.today.isSubmitting)
            .accessibilityLabel("Choose \(option.option.name)")
            .accessibilityHint("Records what you intend to wear. It does not record a wear.")
            .accessibilityIdentifier(AXID.optionChoose(option.id))
        }
        Button {
            Task { await app.today.woreThis(optionId: option.id) }
        } label: {
            Label("I wore this", systemImage: "tshirt")
        }
        .secondaryAction()
        .controlSize(.large)
        .disabled(app.today.isSubmitting)
        .accessibilityHint("Records \(Phrases.list(option.wearNames)) as worn today.")
        .accessibilityIdentifier(AXID.optionWore(option.id))
        Menu {
            Button {
                if let ref = app.today.askAboutReference(optionId: option.id) { app.askAbout(ref, label: option.option.name) }
            } label: {
                Label("Ask about this", systemImage: "bubble.left")
            }
            .accessibilityIdentifier(AXID.optionAsk(option.id))
        } label: {
            Label("More", systemImage: "ellipsis").labelStyle(.iconOnly).frame(minWidth: Metrics.unit * 6, minHeight: Metrics.unit * 6)
        }
        .secondaryAction()
        .controlSize(.large)
        .accessibilityLabel("More for \(option.option.name)")
    }
}
