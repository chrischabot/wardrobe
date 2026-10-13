import SwiftUI
import GarderobeKit

/// The item page: catalogue image, status, direct commands, availability and its basis,
/// identifying details, care, wear history, combinations, returns, feedback and receipts.
struct ItemScreen: View {
    @Environment(AppModel.self) private var app
    let garmentId: String
    @State private var model: ItemModel?
    @State private var inspecting = false

    init(garmentId: String) { self.garmentId = garmentId }

    var body: some View {
        ScrollView {
            if let model {
                content(model)
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(model?.garment?.name ?? "Item")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: garmentId) {
            let created = model ?? ItemModel(environment: app.environment, garmentId: garmentId)
            model = created
            await created.open()
            await app.returns.open()
        }
        .refreshable { await model?.refresh() }
    }

    @ViewBuilder private func content(_ model: ItemModel) -> some View {
        if let garment = model.garment {
            VStack(alignment: .leading, spacing: Metrics.unit * 5) {
                imageSection(model, garment: garment)
                VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                    Text(garment.name).font(.title2.weight(.semibold))
                    Text(model.statusLine).font(.headline).accessibilityIdentifier(AXID.itemStatus)
                    if let quantity = model.quantityLine { Text(quantity).font(.subheadline).foregroundStyle(Color.supporting) }
                    FreshnessLabel(text: model.freshnessLine, freshness: model.item.freshness)
                    OutcomeLine(outcome: model.lastOutcome)
                    Button {
                        app.askAbout(model.askAboutReference, label: garment.name)
                    } label: {
                        Label("Ask about this", systemImage: "bubble.left")
                    }
                    .secondaryAction()
                    .accessibilityIdentifier(AXID.itemAsk)
                }
                ItemActionsSection(model: model)
                ItemAvailabilitySection(model: model)
                ItemFactsSection(model: model)
                ItemFeedbackSection(model: model)
                ItemHistorySection(model: model)
            }
            .padding(Metrics.inset)
        } else {
            ContentUnavailableView("Item not loaded", systemImage: "hanger", description: Text(model.freshnessLine))
                .padding(Metrics.inset)
        }
    }

    private func imageSection(_ model: ItemModel, garment: Garment) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Button { inspecting = true } label: {
                GarmentImageView(garmentId: garment.garmentId, name: garment.name, image: model.image)
                    .frame(maxWidth: 360)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the photo full screen")
            .fullScreenCover(isPresented: $inspecting) {
                GarmentInspectionView(garmentId: garment.garmentId, name: garment.name, image: model.image)
            }
            if let label = model.image?.displayLabel, label != .productPhoto, label != .yourPhoto, label != .unknown {
                Text(label.rawValue).font(.caption).foregroundStyle(Color.supporting)
            }
            if let request = model.photoRequest {
                Label(request, systemImage: "camera").font(.footnote).foregroundStyle(Color.supporting)
            }
            if !model.mediaAvailable {
                Label("Photos could not be loaded. The details below are still current.", systemImage: "photo.badge.exclamationmark")
                    .font(.footnote).foregroundStyle(Color.supporting)
            }
        }
    }
}
