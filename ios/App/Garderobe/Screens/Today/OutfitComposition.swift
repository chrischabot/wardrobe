import SwiftUI
import GarderobeKit

/// The garments of one outfit on a single white catalogue canvas, in the order the backend
/// gave them. The grid is deterministic: nothing is reordered, layered or chosen here.
/// VoiceOver reads it as one element whose label names the garments.
struct OutfitComposition: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let garments: [BoardGarmentLine]
    /// What VoiceOver reads: the garments by name (for an option, `OptionPresentation.accessibilityLabel`).
    let label: String
    /// The small form used in the comparison list: tighter spacing, same order.
    var compact = false

    var body: some View {
        VStack(spacing: spacing) {
            ForEach(rows.indices, id: \.self) { index in
                HStack(alignment: .top, spacing: spacing) {
                    ForEach(rows[index]) { line in
                        GarmentImageView(garmentId: line.garmentId, name: line.name, decorative: true)
                            .frame(maxWidth: .infinity)
                    }
                    // A short last row keeps the same cell width, so cells never change size.
                    ForEach(0..<(columns - rows[index].count), id: \.self) { _ in
                        Color.clear
                            .aspectRatio(3.0 / 4.0, contentMode: .fit)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .padding(spacing)
        .frame(maxWidth: .infinity)
        .catalogueCanvas(radius: Metrics.innerRadius(padding: compact ? Metrics.unit * 3 : Metrics.unit * 2))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityAddTraits(.isImage)
    }

    private var spacing: CGFloat { compact ? Metrics.unit : Metrics.unit * 2 }

    /// One garment fills the canvas; up to four sit two across; more sit three across. At
    /// accessibility text sizes there are never more than two across, so a tile without a
    /// photograph has room for its name.
    private var columns: Int {
        switch garments.count {
        case 0, 1: return 1
        case 2...4: return 2
        default: return typeSize.isAccessibilitySize ? 2 : 3
        }
    }

    /// The garments cut into rows of `columns`, keeping their order.
    private var rows: [[BoardGarmentLine]] {
        stride(from: 0, to: garments.count, by: columns).map { start in
            Array(garments[start..<min(start + columns, garments.count)])
        }
    }
}
