import SwiftUI
import UIKit
import AVFoundation
import GarderobeKit

/// A photo taken in the sheet, as the bytes to upload.
struct CapturedPhoto {
    let data: Data
    let contentType: UploadContentType
}

/// The system camera. Taking a photo only produces bytes for an upload: it records nothing.
struct CameraPicker: UIViewControllerRepresentable {
    /// Called once, with the photo or nil when the owner cancelled. The caller closes the camera.
    let onFinish: (CapturedPhoto?) -> Void

    /// Whether the camera may be shown. Asks for access the first time. When there is no camera
    /// or access is denied the model is told, and the caller must not present the camera.
    @MainActor
    static func prepare(for capture: CaptureModel) async -> Bool {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            capture.setPhotoAccess(denied: true)
            return false
        }
        let allowed: Bool
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: allowed = true
        case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
        default: allowed = false
        }
        capture.setPhotoAccess(denied: !allowed)
        return allowed
    }

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onFinish: (CapturedPhoto?) -> Void

        init(onFinish: @escaping (CapturedPhoto?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            let image = info[.originalImage] as? UIImage
            onFinish(image?.jpegData(compressionQuality: 0.9).map { CapturedPhoto(data: $0, contentType: .imageJpeg) })
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onFinish(nil)
        }
    }
}
