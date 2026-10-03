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
    /// What the tile says when no photograph exists.
    var missing: MissingTile = .nameAndNote

    /// What a tile without a photograph shows. Text in a tile is ordinary text: it wraps and the
    /// tile grows taller with the text size, so nothing is squeezed, cut off or swapped out.
    enum MissingTile {
        /// The garment's name and the backend's note ("No photo yet").
        case nameAndNote
        /// The note only, where the name is written directly beside or below the tile.
        case note
        /// A neutral mark only, for tiles too small for words (a 64-point list thumbnail, a
        /// positioned layer). The caller writes the name and the note as text next to it.
        case symbol
    }

    @State private var uiImage: UIImage?
    @State private var resolved = false

    var body: some View {
        ZStack {
            // The reserved space: the tile is never smaller than this, so loading moves nothing.
            Color.clear
                .aspectRatio(aspectRatio, contentMode: .fit)
                .overlay {
                    GeometryReader { proxy in
                        ZStack {
                            Color.clear // no spinner, no entrance animation
                            if let uiImage {
                                Image(uiImage: uiImage)
                                    .resizable()
                                    .scaledToFit()
                                    .padding(Metrics.unit * 2)
                            }
                        }
                        .frame(width: proxy.size.width, height: proxy.size.height)
                        .task(id: taskKey(width: proxy.size.width)) { await load(points: proxy.size.width) }
                    }
                }
            if uiImage == nil, resolved { missingTile }
        }
        .catalogueCanvas()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(decorative ? "" : accessibilityText)
        .accessibilityHidden(decorative)
    }

    private var missingNote: String { image?.missingImageNote ?? "No photo yet" }

    /// No photograph exists. The name is always available to VoiceOver from the element's
    /// label or from the text beside the tile.
    @ViewBuilder private var missingTile: some View {
        switch missing {
        case .nameAndNote:
            VStack(spacing: Metrics.unit) {
                Text(name).font(.footnote.weight(.semibold))
                Text(missingNote).font(.caption)
            }
            .multilineTextAlignment(.center)
            .foregroundStyle(.black)
            .fixedSize(horizontal: false, vertical: true)
            .padding(Metrics.unit * 2)
            .accessibilityHidden(true)
        case .note:
            Text(missingNote)
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(.black)
                .fixedSize(horizontal: false, vertical: true)
                .padding(Metrics.unit * 2)
                .accessibilityHidden(true)
        case .symbol:
            Image(systemName: "photo")
                .font(.title3)
                .foregroundStyle(.black)
                .accessibilityHidden(true)
        }
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
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let garmentId: String
    let name: String
    var image: GarmentImageRef?

    @State private var scale: CGFloat = 1
    @State private var steadyScale: CGFloat = 1
    /// The full-size rendition, read through a short-lived signed address.
    @State private var fullSize: UIImage?

    var body: some View {
        NavigationStack {
            Group {
                if let fullSize {
                    Image(uiImage: fullSize)
                        .resizable()
                        .scaledToFit()
                        .accessibilityLabel("Photo of \(name)")
                } else {
                    // Shown at once from what is already on the phone, and when there is no photo.
                    GarmentImageView(garmentId: garmentId, name: name, image: image)
                }
            }
                .task(id: image?.renditionId) {
                    fullSize = nil   // never the previous photograph under a new name
                    guard let image, let data = await app.images.inspectionData(for: image), let decoded = UIImage(data: data) else { return }
                    fullSize = decoded
                }
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
