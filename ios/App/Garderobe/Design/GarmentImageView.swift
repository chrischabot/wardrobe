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
    @State private var phase: Phase = .loading
    /// The garment and image the state on screen belongs to; a change resets it at once.
    @State private var shownIdentity: String?
    /// Bumped by "Try again" to start a new read.
    @State private var attempt = 0

    private enum Phase: Equatable { case loading, shown, noImage, unavailable }

    var body: some View {
        ZStack {
            // The reserved space: the tile is never smaller than this, so loading moves nothing.
            Color.clear
                .aspectRatio(aspectRatio, contentMode: .fit)
                .overlay {
                    GeometryReader { proxy in
                        ZStack {
                            Color.clear // no spinner, no entrance animation
                            if let uiImage = shownImage {
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
            if isCurrent, uiImage == nil, phase == .noImage { missingTile }
            if isCurrent, uiImage == nil, phase == .unavailable { unavailableTile }
        }
        .catalogueCanvas()
        .accessibilityElement(children: .ignore)
        // A decorative tile hides only its picture: when the photograph failed, the failure and
        // its retry are announced like any other control, so VoiceOver can try again too.
        .accessibilityLabel(offersRetry ? (decorative ? "Photo could not be loaded" : accessibilityText) : (decorative ? "" : accessibilityText))
        .accessibilityHidden(decorative && !offersRetry)
        .accessibilityActions {
            if offersRetry { Button("Try again") { attempt += 1 } }
        }
    }

    private var offersRetry: Bool { isCurrent && phase == .unavailable && uiImage == nil }

    /// The state on screen belongs to the garment and image this tile is for now. When either
    /// changes, nothing of the previous one is drawn, not even for the frame before the new read starts.
    private var isCurrent: Bool { shownIdentity == identity }
    private var shownImage: UIImage? { isCurrent ? uiImage : nil }

    /// The photograph could not be read and none is on the phone: say so, and offer to try again.
    /// This is not "No photo yet", which is only for garments the backend says have none.
    @ViewBuilder private var unavailableTile: some View {
        VStack(spacing: Metrics.unit) {
            if missing != .symbol { Text("Photo could not be loaded").font(.caption) }
            Button { attempt += 1 } label: {
                if missing == .symbol { Image(systemName: "arrow.clockwise") } else { Text("Try again").font(.caption.weight(.semibold)) }
            }
            .buttonStyle(.borderless)
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(.black)
        .fixedSize(horizontal: false, vertical: true)
        .padding(Metrics.unit * 2)
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
        guard isCurrent else { return "\(name), photo loading" }
        if uiImage != nil {
            if let label = image?.displayLabel, label != .productPhoto, label != .yourPhoto { return "\(name), \(label.rawValue.lowercased())" }
            return "Photo of \(name)"
        }
        if phase == .unavailable { return "\(name), photo could not be loaded" }
        // "No photo yet" only when the backend said there is none; never while reading or after a failure.
        if phase == .noImage { return "\(name), no photo yet" }
        return "\(name), photo loading"
    }

    /// Which garment and which image this tile is for. A recorded change to the garment's images
    /// (a new photograph chosen, one deleted) is part of it, so the tile reads the image again.
    private var identity: String {
        "\(garmentId)|\(image?.renditionId ?? "")|\(image.map { $0.hasRealImage ? "real" : "none" } ?? "current")|\(app.images.revision(forGarment: garmentId))"
    }

    private func taskKey(width: CGFloat) -> String { "\(identity)|\(Int(width))|\(attempt)" }

    private func load(points: CGFloat) async {
        guard points > 0 else { return }
        let mine = identity
        // Another garment or image: nothing of the previous one stays on screen.
        if shownIdentity != mine { uiImage = nil; phase = .loading; shownIdentity = mine }
        let width = GarmentImageLoader.width(forPoints: Double(points), scale: Double(displayScale))
        if uiImage == nil, let cached = app.images.cachedImage(garmentId: garmentId, image: image, width: width) {
            if let decoded = UIImage(data: cached) { uiImage = decoded; phase = .shown }
            else { app.images.discardUndecodable(garmentId: garmentId, image: image, width: width) }
        }
        let outcome = await app.images.image(garmentId: garmentId, image: image, width: width)
        // A read for an image no longer shown (the tile was reused, or a newer read started)
        // never changes the tile: cancelling a task is only a request.
        guard !Task.isCancelled, mine == identity else { return }
        switch outcome {
        case .image(let data):
            // Bytes that cannot be decoded are a failed read, not an absence: the tile says the
            // photo could not be loaded and offers to try again, which reads it afresh.
            if let decoded = UIImage(data: data) { uiImage = decoded; phase = .shown }
            else {
                app.images.discardUndecodable(garmentId: garmentId, image: image, width: width)
                if uiImage == nil { phase = .unavailable }
            }
        case .noImage:
            // Only the backend's answer that no real image exists shows "No photo yet".
            uiImage = nil
            phase = .noImage
        case .unavailable:
            if uiImage == nil { phase = .unavailable }
        }
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
                    // The read can finish after the image changed (cancelling is only a request): a
                    // task that was replaced never puts its photograph on screen.
                    guard !Task.isCancelled, image.renditionId == self.image?.renditionId else { return }
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
