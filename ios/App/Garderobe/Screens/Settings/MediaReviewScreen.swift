import SwiftUI
import GarderobeKit

/// Photos needed (garments research could not find a picture for) and images to review (a
/// found picture with one open question). Neither blocks a recommendation.
struct MediaReviewScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let settings = app.settings
        List {
            Section {
                SettingsFreshnessLabel(freshness: settings.photosNeededList.freshness, subject: "photos needed")
                if settings.photosNeeded.isEmpty && settings.photosNeededList.value != nil {
                    Text("No photos are needed.").foregroundStyle(.secondary)
                }
                ForEach(settings.photosNeeded, id: \.garmentId) { item in
                    VStack(alignment: .leading, spacing: Metrics.unit) {
                        Text(item.name)
                        Text(item.request)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
                Button {
                    // The sheet binding swaps Settings for the Capture sheet.
                    app.sheet = .capture
                } label: {
                    Label("Take or choose a photo", systemImage: "camera")
                }
            } header: {
                Text("Photos needed")
            } footer: {
                Text("A missing photo never blocks a recommendation. Only garments that research could not find a picture for are listed here.")
            }
            Section {
                SettingsFreshnessLabel(freshness: settings.review.freshness, subject: "images to review")
                if settings.reviewItems.isEmpty && settings.review.value != nil {
                    Text("No images are waiting for a decision.").foregroundStyle(.secondary)
                }
                ForEach(settings.reviewItems, id: \.candidateId) { item in
                    reviewRow(item)
                }
                OutcomeLine(outcome: settings.lastOutcome)
                SettingsMessageLine(message: settings.message)
            } header: {
                Text("Images to review")
            } footer: {
                Text("Each image has one open question. Accept uses the image for the garment; Reject discards it.")
            }
        }
        .navigationTitle("Photos and image review")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await settings.photosNeededList.refresh()
            await settings.review.refresh()
        }
    }

    private func reviewRow(_ item: MediaReviewItem) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Text(item.garmentName)
                .font(.headline)
            Text(item.question)
            if let page = item.pageUrl, let url = URL(string: page) {
                Link(destination: url) {
                    Label("Open the page it came from", systemImage: "safari")
                }
                .font(.footnote)
                .touchTarget()
            }
            HStack(spacing: Metrics.unit * 3) {
                Button("Accept") {
                    Task { await app.settings.decide(item, adopt: true) }
                }
                .accessibilityLabel("Accept the image for \(item.garmentName)")
                Button("Reject", role: .destructive) {
                    Task { await app.settings.decide(item, adopt: false) }
                }
                .accessibilityLabel("Reject the image for \(item.garmentName)")
            }
            .buttonStyle(.bordered)
            .frame(minHeight: Metrics.touch)
            .disabled(app.settings.isWorking)
        }
    }
}
