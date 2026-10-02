import SwiftUI
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import GarderobeKit

/// Reads a photo the owner picked. Nothing here looks at what the photo shows.
enum PickedPhoto {
    /// The upload type of the picked file, or nil when it is not one the backend accepts.
    /// The first declared type is the one the bytes are delivered in.
    static func contentType(of item: PhotosPickerItem) -> UploadContentType? {
        guard let type = item.supportedContentTypes.first else { return nil }
        if type.conforms(to: UTType.jpeg) { return .imageJpeg }
        if type.conforms(to: UTType.png) { return .imagePng }
        if type.conforms(to: UTType.heic) { return .imageHeic }
        if type.conforms(to: UTType.webP) { return .imageWebp }
        return nil
    }

    static func load(_ item: PhotosPickerItem) async -> (data: Data, contentType: UploadContentType)? {
        guard let contentType = contentType(of: item), let data = try? await item.loadTransferable(type: Data.self) else { return nil }
        return (data, contentType)
    }
}

/// The attachments being uploaded, in the order they were added. Each keeps its position while
/// it uploads and can be retried or removed on its own. Also loads newly picked photos and
/// hands them to `add`.
struct AttachmentStrip: View {
    let uploads: UploadModel
    @Binding var picked: [PhotosPickerItem]
    /// The composer lets the owner say what each photo is; the capture sheet asks once for all.
    var offersRole = false
    /// Starts the upload of one photo (the composer and the capture sheet use different intents).
    let add: (Data, UploadContentType) async -> Void

    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            ForEach(Array(uploads.items.enumerated()), id: \.element.id) { index, item in
                UploadRow(item: item, position: index + 1, uploads: uploads, offersRole: offersRole)
            }
            if let message {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Color.supporting)
            }
        }
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await load(items) }
        }
    }

    private func load(_ items: [PhotosPickerItem]) async {
        message = nil
        for item in items {
            guard PickedPhoto.contentType(of: item) != nil else {
                message = "This file type cannot be attached"
                continue
            }
            guard let photo = await PickedPhoto.load(item) else {
                message = "The photo could not be read from your library."
                continue
            }
            // Each upload runs on its own, so a slow one does not hold back the next.
            Task { await add(photo.data, photo.contentType) }
        }
    }
}

/// One attachment: thumbnail, status in words, Retry when the failure can be retried, Remove.
struct UploadRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let item: UploadItem
    let position: Int
    let uploads: UploadModel
    var offersRole = false

    @State private var thumbnail: UIImage?

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                    HStack(spacing: Metrics.unit * 3) { preview; status }
                    HStack(spacing: Metrics.unit * 3) { actions }
                }
            } else {
                HStack(spacing: Metrics.unit * 3) { preview; status; Spacer(minLength: 0); actions }
            }
        }
        .task(id: item.id) {
            thumbnail = await UIImage(data: item.data)?.byPreparingThumbnail(ofSize: CGSize(width: 160, height: 160))
        }
    }

    private var preview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Metrics.innerRadius(padding: Metrics.unit * 3), style: .continuous)
                .fill(Color(.tertiarySystemFill))
            if let thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: Metrics.innerRadius(padding: Metrics.unit * 3), style: .continuous))
        .accessibilityHidden(true) // the status text names the attachment
    }

    private var status: some View {
        Text("Photo \(position): \(item.statusLine)")
            .font(.footnote)
            .foregroundStyle(Color.supporting)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var actions: some View {
        if offersRole {
            // What the photo is, in the owner's words. Optional; nothing is guessed from the picture.
            Menu {
                Button("Not said") { uploads.setRole(nil, for: item.id) }
                ForEach(PhotoRole.choices, id: \.self) { role in
                    Button(role.title) { uploads.setRole(role, for: item.id) }
                }
            } label: {
                Text(item.role?.title ?? "What is it?")
            }
            .touchTarget()
            .accessibilityLabel("Photo \(position) is: \(item.role?.title ?? "not said")")
        }
        if item.canRetry {
            Button("Retry") { Task { await uploads.retry(item.id) } }
                .buttonStyle(.borderless)
                .touchTarget()
                .accessibilityLabel("Retry photo \(position)")
        }
        Button {
            uploads.remove(item.id)
        } label: {
            Image(systemName: "xmark.circle")
        }
        .buttonStyle(.borderless)
        .touchTarget()
        .accessibilityLabel("Remove photo \(position)")
    }
}
