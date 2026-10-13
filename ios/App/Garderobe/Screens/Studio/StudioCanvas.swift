import SwiftUI
import UIKit
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
                Text(label).font(.caption).foregroundStyle(Color.supporting)
            }
            if !app.studio.piecesWithoutPhoto.isEmpty {
                // Written out as text so it grows with the text size; the canvas shows a neutral mark.
                Text("No photo yet: \(Phrases.list(app.studio.piecesWithoutPhoto)).")
                    .font(.footnote)
                    .foregroundStyle(Color.supporting)
            }
            preview
        }
        .task(id: slotKey) { await app.studio.loadComposition() }
    }

    /// The backend's rendered picture of this combination, asked for by the owner. It is made
    /// in the background; until it exists the screen says so and shows no picture.
    @ViewBuilder private var preview: some View {
        if !app.studio.slots.isEmpty {
            VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                if case .rendered(let data) = app.studio.preview, let image = UIImage(data: data) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity)
                        .catalogueCanvas(radius: Metrics.cardRadius)
                        .accessibilityLabel("Picture of this combination. \(app.studio.accessibilityDescription)")
                }
                if let line = app.studio.previewLine {
                    Text(line).font(.footnote).foregroundStyle(Color.supporting)
                }
                switch app.studio.preview {
                case .none, .failed:
                    Button { Task { await app.studio.requestPreview() } } label: { Label("Make a picture of this", systemImage: "photo.on.rectangle") }
                        .secondaryAction()
                        .accessibilityHint("Asks the backend to render these pieces as one picture. Nothing is planned or logged.")
                case .queued:
                    Button("Check again") { Task { await app.studio.checkPreview() } }
                        .secondaryAction()
                case .requesting, .rendered:
                    EmptyView()
                }
            }
        }
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
        // A positioned layer has a fixed frame, so a missing photograph is a neutral mark here
        // and is named in words under the canvas.
        pieceView(name: layer.name, garmentId: layer.garmentId, image: nil, marker: layer.imageLabel == .missing ? nil : marker, missing: .symbol)
    }

    /// A real photo when the piece is an owned garment; a labelled name tile otherwise.
    @ViewBuilder private func pieceView(name: String, garmentId: String?, image: GarmentImageRef?, marker: String?, missing: GarmentImageView.MissingTile = .nameAndNote) -> some View {
        VStack(spacing: Metrics.unit) {
            if let garmentId {
                GarmentImageView(garmentId: garmentId, name: name, image: image, decorative: true, missing: missing)
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
