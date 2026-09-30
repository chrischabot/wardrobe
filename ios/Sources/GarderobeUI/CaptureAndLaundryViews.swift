#if os(iOS)
import PhotosUI
import SwiftUI
import UIKit
import GarderobeKit

/// Capture sheet: Add an item, Identify this, What I wore. A photo never authorizes a mutation.
struct CaptureView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var model: CaptureViewModel?
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showCamera = false
    let initial: CaptureIntent?

    var body: some View {
        NavigationStack {
            Form {
                if let model {
                    @Bindable var m = model
                    Picker("What is this for?", selection: $m.intent) {
                        ForEach(CaptureIntent.allCases) { Label($0.title, systemImage: $0.systemImage).tag($0) }
                    }
                    .pickerStyle(.inline)
                    .accessibilityIdentifier("capture.intent")

                    Section("Photos") {
                        if m.photoAccess == .denied {
                            Text("Photo access is off. You can describe it in words below, or allow access in Settings.")
                            Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
                        } else {
                            PhotosPicker(selection: $pickerItems, maxSelectionCount: 4, matching: .images) { Label("Choose photos", systemImage: "photo.on.rectangle") }
                            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                                Button { showCamera = true } label: { Label("Take a photo", systemImage: "camera") }
                            }
                        }
                        ForEach(m.attachments) { a in
                            HStack {
                                if let image = UIImage(data: a.data) { Image(uiImage: image).resizable().scaledToFill().frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 8)) }
                                switch a.state {
                                case .waiting: Text("Ready")
                                case .uploading: ProgressView()
                                case .uploaded: Label("Uploaded", systemImage: "checkmark")
                                case .failed(let why):
                                    Text(why).foregroundStyle(.orange)
                                    Button("Retry") { Task { await m.upload(a.id) } }.minimumTarget()
                                }
                                Spacer()
                                Button(role: .destructive) { m.remove(a.id) } label: { Image(systemName: "trash") }.minimumTarget().accessibilityLabel("Remove photo")
                            }
                        }
                    }
                    Section("Note") {
                        TextField(m.intent == .whatIWore ? "e.g. the denim shirt, walnut chinos" : "Anything useful", text: $m.note, axis: .vertical)
                            .accessibilityIdentifier("capture.note")
                    }
                    Section {
                        if m.intent == .whatIWore {
                            Button("Log it if the match is clear") { Task { await m.submit(logIt: true); finish(m) } }.disabled(!m.canSubmit)
                                .accessibilityIdentifier("capture.log")
                            Button("Only compare with my wardrobe") { Task { await m.submit(logIt: false); finish(m) } }.disabled(!m.canSubmit)
                        } else {
                            Button(m.intent == .addItem ? "Start adding it" : "Identify") { Task { await m.submit(); finish(m) } }.disabled(!m.canSubmit)
                                .accessibilityIdentifier("capture.submit")
                        }
                    } footer: {
                        Text(m.intent == .whatIWore ? "Hidden socks or shoes stay unknown. If a piece is ambiguous you'll get one short choice." : "Nothing is added to your wardrobe until you confirm.")
                    }
                }
            }
            .navigationTitle("Capture")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .onAppear {
                if model == nil { model = app.makeCaptureViewModel(initial ?? .identify) }
                let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
                model?.photoAccess = status == .denied || status == .restricted ? .denied : status == .limited ? .limited : .granted
            }
            .onChange(of: pickerItems) { _, items in
                Task {
                    for item in items { if let data = try? await item.loadTransferable(type: Data.self) { model?.add(data) } }
                    pickerItems = []
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { data in if let data { model?.add(data) } }.ignoresSafeArea()
            }
        }
    }

    private func finish(_ m: CaptureViewModel) {
        guard m.submitted else { return }
        app.selectedTab = .conversation
        dismiss()
    }
}

/// Chooser shown by the capture toolbar button: the three intents.
struct CaptureMenu: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        Menu {
            ForEach(CaptureIntent.allCases) { intent in
                Button { app.sheet = .capture(intent) } label: { Label(intent.title, systemImage: intent.systemImage) }
            }
        } label: { Label("Capture", systemImage: "camera") }
            .accessibilityIdentifier("toolbar.capture")
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    let onFinish: (Data?) -> Void
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.delegate = context.coordinator
        return c
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (Data?) -> Void
        init(onFinish: @escaping (Data?) -> Void) { self.onFinish = onFinish }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onFinish((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.85))
            picker.dismiss(animated: true)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onFinish(nil); picker.dismiss(animated: true) }
    }
}

/// Laundry sheet: service laundry and hand wash separately.
struct LaundryView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?

    var body: some View {
        let l = app.laundry
        NavigationStack {
            List {
                Section("Service laundry") {
                    if l.serviceHamper.isEmpty { Text("The hamper is empty.").foregroundStyle(.secondary) }
                    ForEach(l.serviceHamper) { Text(verbatim: $0.name) }
                    Button("Collected") { run { await l.collected() } }.disabled(!l.canCollect).accessibilityIdentifier("laundry.collected")
                    if let next = l.state?.service.nextCollectionAt {
                        Text("Next collection \(next, format: .dateTime.weekday(.wide).hour().minute())")
                    }
                }
                ForEach(l.openBatches) { batch in
                    Section {
                        ForEach(batch.items, id: \.lotId) { line in
                            HStack {
                                Text(verbatim: l.name(line.garmentId, in: batch))
                                Spacer()
                                if l.editingBatchId == batch.batchId {
                                    if line.quantity > 1 {
                                        Stepper("\(l.stillAway[line.garmentId] ?? 0) away", value: Binding(get: { l.stillAway[line.garmentId] ?? 0 }, set: { l.setStillAway(line.garmentId, quantity: $0) }), in: 0...line.outstanding)
                                    } else {
                                        Toggle("Still away", isOn: Binding(get: { l.stillAway[line.garmentId] != nil }, set: { l.setStillAway(line.garmentId, quantity: $0 ? 1 : 0) }))
                                            .labelsHidden().accessibilityLabel("\(l.name(line.garmentId, in: batch)) still away")
                                    }
                                } else {
                                    Text(line.outstanding > 0 ? "Away" : "Back").foregroundStyle(.secondary)
                                }
                            }
                        }
                        if l.editingBatchId == batch.batchId {
                            Button("Confirm what's still away") { run { await l.confirmSomeStillAway() } }.disabled(l.stillAway.isEmpty)
                            Button("Cancel", role: .cancel) { l.cancelException() }
                        } else {
                            Button("Returned") { run { await l.returned(batch) } }.accessibilityIdentifier("laundry.returned")
                            Button("Some items still away") { l.beginException(for: batch) }.accessibilityIdentifier("laundry.someAway")
                        }
                    } header: {
                        Text("Collected \(batch.collectedAt, format: .dateTime.weekday(.wide).day().month())")
                    }
                }
                Section("Hand wash") {
                    if l.handWashHamper.isEmpty { Text("No socks waiting.").foregroundStyle(.secondary) }
                    ForEach(l.handWashHamper) { line in
                        Toggle(isOn: Binding(get: { l.socksSelection.contains(line.garmentId) }, set: { if $0 { l.socksSelection.insert(line.garmentId) } else { l.socksSelection.remove(line.garmentId) } })) {
                            Text(verbatim: "\(line.name) · \(line.quantity) \(line.quantity == 1 ? "pair" : "pairs")")
                        }
                    }
                    Button("Socks washed") { run { await l.socksWashed() } }.disabled(l.handWashHamper.isEmpty).accessibilityIdentifier("laundry.socks")
                }
                if !l.openExceptions.isEmpty {
                    Section("Still away") {
                        ForEach(l.openExceptions) { e in
                            VStack(alignment: .leading) {
                                Text(verbatim: e.quantity > 1 ? "\(e.name) ×\(e.quantity)" : e.name)
                                Text(verbatim: e.kind.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(.secondary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .accessibilityIdentifier("laundry.exceptions")
                }
                if let message { Text(message).foregroundStyle(.secondary) }
            }
            .navigationTitle("Laundry")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await l.refresh() }
            .task { await l.refresh() }
        }
    }

    private func run(_ action: @escaping () async -> ActionResult) {
        Task {
            switch await action() {
            case .refused(let why): message = why
            case .queued: message = "Saved on this phone; it will send when online."
            default: message = nil
            }
        }
    }
}
#endif
