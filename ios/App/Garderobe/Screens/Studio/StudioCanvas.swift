import SwiftUI
import GarderobeKit

/// The composed outfit on one white canvas. With a backend composition manifest the layers
/// are placed where the manifest says; otherwise the pieces are stacked in role order. The
/// phone only positions images; it never decides what goes together.
struct StudioCanvas: View {
    @Environment(AppModel.self) private var app

    private var slotKey: String { app.studio.slots.map { "\($0.role.rawValue)=\($0.item.garmentId ?? $0.item.name)" }.joined(separator: "|") }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Group {
                if app.studio.slots.isEmpty {
                    Text("Choose a piece for each role below.")
                        .font(.subheadline)
                        .foregroundStyle(.black.opacity(0.6))
                        .frame(maxWidth: .infinity, minHeight: 240)
                } else if let composition = app.studio.composition {
                    GeometryReader { proxy in
                        let placed = CompositionLayout.frames(for: composition.manifest, in: Double(proxy.size.width), Double(proxy.size.height))
                        ZStack(alignment: .topLeading) {
                            ForEach(Array(placed.enumerated()), id: \.offset) { _, entry in
                                layerView(entry.layer)
                                    .frame(width: entry.frame.width, height: entry.frame.height)
                                    .offset(x: entry.frame.x, y: entry.frame.y)
                            }
                        }
                    }
                    .aspectRatio(CGFloat(composition.manifest.canvas.width) / CGFloat(max(1, composition.manifest.canvas.height)), contentMode: .fit)
                } else {
                    VStack(spacing: Metrics.unit * 2) {
                        ForEach(app.studio.slots, id: \.role) { slot in
                            pieceView(name: slot.item.name, garmentId: slot.item.garmentId, image: slot.item.image, marker: StudioModel.markerLabel(slot.item))
                                .frame(maxWidth: 220)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(Metrics.unit * 3)
                }
            }
            .catalogueCanvas(radius: Metrics.cardRadius)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(app.studio.accessibilityDescription)
            .accessibilityIdentifier(AXID.studioCanvas)

            ForEach(app.studio.composition?.labels ?? [], id: \.self) { label in
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
        }
        .task(id: slotKey) { await app.studio.loadComposition() }
    }

    @ViewBuilder private func layerView(_ layer: CompositionLayer) -> some View {
        let marker: String? = {
            switch layer.imageLabel {
            case .shoppingCandidate: return "Shopping candidate"
            case .illustration: return "Illustration"
            case .edited: return "Edited"
            case .demoPlaceholder: return "Demo placeholder"
            case .missing: return "No photo yet"
            default: return nil
            }
        }()
        pieceView(name: layer.name, garmentId: layer.garmentId, image: nil, marker: marker)
    }

    /// A real photo when the piece is an owned garment; a labelled name tile otherwise.
    @ViewBuilder private func pieceView(name: String, garmentId: String?, image: GarmentImageRef?, marker: String?) -> some View {
        VStack(spacing: Metrics.unit) {
            if let garmentId {
                GarmentImageView(garmentId: garmentId, name: name, image: image, decorative: true)
            } else {
                Text(name)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.black)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 80)
                    .overlay { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.black.opacity(0.3), style: StrokeStyle(lineWidth: 1, dash: [4, 3])) }
            }
            if let marker {
                Text(marker).font(.caption2.weight(.medium)).foregroundStyle(.black.opacity(0.7))
            }
        }
    }
}
