import SwiftUI
import PhotosUI
import GarderobeKit

/// Step 2 of capture: a photo from the camera or the library, an optional note, and Submit.
/// Without camera access the step still works with a chosen photo or with words alone.
struct CaptureComposeStep: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize
    let submit: () -> Void

    @State private var picked: [PhotosPickerItem] = []
    @State private var showsCamera = false

    var body: some View {
        @Bindable var capture = app.capture
        VStack(alignment: .leading, spacing: Metrics.inset) {
            if let intent = capture.intent { heading(intent) }
            Group {
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: Metrics.unit * 3) { sources }
                } else {
                    HStack(spacing: Metrics.unit * 3) { sources }
                }
            }
            if let access = capture.accessMessage {
                Label(access, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            AttachmentStrip(uploads: capture.uploads, picked: $picked) { data, contentType in
                await app.capture.addPhoto(data: data, contentType: contentType)
            }
            TextField("Add a note (optional)", text: $capture.note, axis: .vertical)
                .lineLimit(2...6)
                .padding(Metrics.unit * 3)
                .frame(minHeight: Metrics.touch)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: Metrics.innerRadius(padding: Metrics.unit), style: .continuous))
            VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                if let reason = capture.blockedReason {
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Button(action: submit) {
                    Text("Submit").frame(maxWidth: .infinity)
                }
                .primaryAction()
                .controlSize(.large)
                .disabled(!capture.canSubmit)
                .accessibilityIdentifier(AXID.captureSubmit)
                Text("Sending the photo does not record anything by itself.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .fullScreenCover(isPresented: $showsCamera) {
            CameraPicker { photo in
                showsCamera = false
                if let photo { Task { await app.capture.addPhoto(data: photo.data, contentType: photo.contentType) } }
            }
            .ignoresSafeArea()
        }
    }

    private func heading(_ intent: CaptureIntent) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            Label(intent.title, systemImage: intent.symbol)
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Text(intent.explanation)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            // Photos are uploaded for the chosen purpose, so changing it starts again.
            Button("Choose something else") { app.capture.reset() }
                .buttonStyle(.borderless)
                .touchTarget()
                .accessibilityHint("Removes the photos and the note")
        }
    }

    @ViewBuilder
    private var sources: some View {
        Button {
            Task { showsCamera = await CameraPicker.prepare(for: app.capture) }
        } label: {
            Label("Take photo", systemImage: "camera").frame(maxWidth: .infinity)
        }
        .secondaryAction()
        .controlSize(.large)
        PhotosPicker(selection: $picked, maxSelectionCount: 1, matching: .images, preferredItemEncoding: .current) {
            Label("Choose photo", systemImage: "photo.on.rectangle").frame(maxWidth: .infinity)
        }
        .secondaryAction()
        .controlSize(.large)
    }
}
