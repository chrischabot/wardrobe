import SwiftUI
import UIKit
import GarderobeKit

/// The image a review question is about, on the neutral canvas, so the owner decides on what
/// he sees. When the candidate has no stored image, or it cannot be read, the view says so
/// instead of showing the garment's current picture in its place.
struct CandidateImageView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.displayScale) private var displayScale
    let item: MediaReviewItem
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
                    Text(item.assetId == nil ? "This question has no image attached." : "The image could not be loaded.")
                        .font(.footnote)
                        .foregroundStyle(.black.opacity(0.6))
                        .multilineTextAlignment(.center)
                        .padding(Metrics.unit * 2)
                } else {
                    Color.clear
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .task(id: "\(item.candidateId)|\(Int(proxy.size.width))") { await load(points: proxy.size.width) }
        }
        .aspectRatio(3.0 / 4.0, contentMode: .fit)
        .frame(maxWidth: 240)
        .catalogueCanvas()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(uiImage != nil ? "The image found for \(item.garmentName)" : "No image is shown for \(item.garmentName)")
    }

    private func load(points: CGFloat) async {
        guard points > 0 else { return }
        let width = GarmentImageLoader.width(forPoints: Double(points), scale: Double(displayScale))
        if let data = await app.images.data(forCandidate: item, width: width), let decoded = UIImage(data: data) { uiImage = decoded }
        resolved = true
    }
}
