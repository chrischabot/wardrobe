import SwiftUI
import UIKit
import GarderobeKit

/// A garment's photograph on the neutral canvas, or - when the backend says no real image
/// exists - the garment's name on a labelled tile. The app never draws or substitutes a picture.
/// The aspect ratio is reserved before the image arrives so the layout does not move.
struct GarmentImageView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.displayScale) private var displayScale

    let garmentId: String
    let name: String
    /// When known (Studio selectors, item page), the exact rendition is used and cached immutably.
    var image: GarmentImageRef?
    var aspectRatio: CGFloat = 3.0 / 4.0
    /// Decorative when a sibling text already names the garment (avoids VoiceOver reading it twice).
    var decorative = false

    @State private var uiImage: UIImage?
    @State private var resolved = false

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                if let uiImage {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFit()
                        .padding(Metrics.unit * 2)
                } else if resolved {
                    missingTile
                } else {
                    Color.clear // reserved space while loading; no spinner, no entrance animation
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .task(id: taskKey(width: proxy.size.width)) { await load(points: proxy.size.width) }
        }
        .aspectRatio(aspectRatio, contentMode: .fit)
        .catalogueCanvas()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(decorative ? "" : accessibilityText)
        .accessibilityHidden(decorative)
    }

    /// No photograph exists: the garment's name where the tile has room for it, otherwise a
    /// neutral placeholder mark. Text is never squeezed or cut off; the name is always available
    /// to VoiceOver from the element's label or from the text beside the tile.
    private var missingTile: some View {
        ViewThatFits(in: .vertical) {
            VStack(spacing: Metrics.unit) {
                Text(name)
                    .font(.footnote.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text(image?.missingImageNote ?? "No photo yet")
                    .font(.caption)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(.black)
            .fixedSize(horizontal: false, vertical: true)
            .padding(Metrics.unit * 2)
            Text(image?.missingImageNote ?? "No photo yet")
                .font(.caption)
                .foregroundStyle(.black)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(Metrics.unit)
            Image(systemName: "photo")
                .font(.title3)
                .foregroundStyle(.black)
        }
        .accessibilityHidden(true)
    }

    private var accessibilityText: String {
        if uiImage != nil {
            if let label = image?.displayLabel, label != .productPhoto, label != .yourPhoto { return "\(name), \(label.rawValue.lowercased())" }
            return "Photo of \(name)"
        }
        return "\(name), no photo yet"
    }

    private func taskKey(width: CGFloat) -> String { "\(garmentId)|\(image?.renditionId ?? "")|\(Int(width))" }

    private func load(points: CGFloat) async {
        guard points > 0 else { return }
        let width = GarmentImageLoader.width(forPoints: Double(points), scale: Double(displayScale))
        if uiImage == nil, let cached = app.images.cached(forGarment: garmentId, width: width), let decoded = UIImage(data: cached) { uiImage = decoded }
        let data: Data?
        if let image, image.hasRealImage {
            data = await app.images.data(for: image, width: width)
        } else if let image, !image.hasRealImage {
            data = nil
        } else {
            data = await app.images.data(forGarment: garmentId, width: width)
        }
        if let data, let decoded = UIImage(data: data) { uiImage = decoded }
        resolved = true
    }
}

/// A full-screen inspection view of a garment image on the neutral canvas, with pinch to zoom
/// and a visible Close button.
struct GarmentInspectionView: View {
    @Environment(\.dismiss) private var dismiss
    let garmentId: String
    let name: String
    var image: GarmentImageRef?

    @State private var scale: CGFloat = 1
    @State private var steadyScale: CGFloat = 1

    var body: some View {
        NavigationStack {
            GarmentImageView(garmentId: garmentId, name: name, image: image)
                .scaleEffect(scale)
                .gesture(
                    MagnifyGesture()
                        .onChanged { value in scale = min(max(1, steadyScale * value.magnification), 5) }
                        .onEnded { _ in steadyScale = scale }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.white.ignoresSafeArea())
                .navigationTitle(name)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                    ToolbarItem(placement: .primaryAction) {
                        Button("Reset zoom") { scale = 1; steadyScale = 1 }.disabled(scale == 1)
                    }
                }
        }
    }
}
