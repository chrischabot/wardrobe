import SwiftUI
import GarderobeKit

/// The wardrobe as a photograph grid, or as a readable list when the owner prefers it or the
/// text size makes image tiles cramped.
struct WardrobeGrid: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize

    private var usesList: Bool { app.wardrobe.prefersList || typeSize.isAccessibilitySize }
    private let columns = [GridItem(.adaptive(minimum: 148), spacing: Metrics.unit * 3, alignment: .top)]

    var body: some View {
        LazyVStack(alignment: .leading, spacing: Metrics.unit * 5) {
            ForEach(app.wardrobe.sections, id: \.category) { section in
                VStack(alignment: .leading, spacing: Metrics.unit * 3) {
                    SectionHeading(title: "\(Phrases.category(section.category)) (\(section.items.count))")
                    if usesList {
                        VStack(spacing: Metrics.unit * 2) {
                            ForEach(section.items) { item in WardrobeRow(item: item) }
                        }
                    } else {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: Metrics.unit * 3) {
                            ForEach(section.items) { item in WardrobeTile(item: item) }
                        }
                    }
                }
            }
        }
    }
}

private struct WardrobeTile: View {
    @Environment(AppModel.self) private var app
    let item: InventoryItem

    var body: some View {
        Button { app.push(.item(garmentId: item.garment.garmentId)) } label: {
            VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                GarmentImageView(garmentId: item.garment.garmentId, name: item.garment.name, decorative: true, missing: .note)
                Text(item.garment.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                Text(app.wardrobe.subtitle(for: item))
                    .font(.caption)
                    .foregroundStyle(Color.supporting)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentSurface(padding: Metrics.unit * 2)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(app.wardrobe.accessibilityLabel(for: item))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(AXID.wardrobeItem(item.garment.garmentId))
    }
}

private struct WardrobeRow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize
    let item: InventoryItem

    var body: some View {
        Button { app.push(.item(garmentId: item.garment.garmentId)) } label: {
            HStack(alignment: .center, spacing: Metrics.unit * 3) {
                if !typeSize.isAccessibilitySize {
                    GarmentImageView(garmentId: item.garment.garmentId, name: item.garment.name, decorative: true, missing: .symbol)
                        .frame(width: 64)
                }
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(item.garment.name).font(.body).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    Text(app.wardrobe.subtitle(for: item)).font(.footnote).foregroundStyle(Color.supporting).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.supporting)
            }
            .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
            .contentSurface(padding: Metrics.unit * 3)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(app.wardrobe.accessibilityLabel(for: item))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(AXID.wardrobeItem(item.garment.garmentId))
    }
}
