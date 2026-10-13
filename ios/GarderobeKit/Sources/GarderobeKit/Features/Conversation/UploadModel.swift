import Foundation
import Observation

/// One attachment being uploaded. Its `clientUploadId` is created once and reused on every
/// retry, so a retry resumes the same upload instead of creating another.
public struct UploadItem: Sendable, Equatable, Identifiable {
    public enum State: Sendable, Equatable {
        case waiting, authorizing, uploading, finalizing
        /// Finalized by the backend: only now can the asset be attached to a turn.
        case ready(assetId: String)
        /// The backend examined the file and refused it, for the stated reason.
        case rejected(String)
        case failed(String, retryable: Bool)
    }
    public let clientUploadId: String
    public var data: Data
    public var contentType: UploadContentType
    public var intent: UploadIntent
    public var garmentId: String?
    public var wearingDate: LocalDate?
    /// What the owner said this photograph is, when they said. Sent with the turn; never guessed
    /// from the picture.
    public var role: PhotoRole?
    public var state: State
    public var id: String { clientUploadId }

    public var assetId: String? { if case .ready(let id) = state { return id }; return nil }
    public var isSettled: Bool {
        switch state {
        case .ready, .rejected: return true
        case .failed(_, let retryable): return !retryable
        default: return false
        }
    }
    public var canRetry: Bool { if case .failed(_, true) = state { return true }; return false }

    public var statusLine: String {
        switch state {
        case .waiting: return "Waiting to upload"
        case .authorizing, .uploading: return "Uploading"
        case .finalizing: return "Checking the photo"
        case .ready: return "Ready"
        case .rejected(let reason): return "Not accepted: \(reason)"
        case .failed(let message, let retryable): return retryable ? "\(message) Tap to retry." : message
        }
    }
}

/// What a photograph is, in the owner's words: the contract's image roles.
public typealias PhotoRole = TurnRequest.ImageRolesValue

extension TurnRequest.ImageRolesValue {
    /// The roles the owner can choose (the tolerance member for unknown values is not one).
    public static let choices: [PhotoRole] = [.selfie, .itemPhoto, .shopPhoto, .receipt, .other]
    public var title: String {
        switch self {
        case .selfie: return "Me wearing it"
        case .itemPhoto: return "Something I own"
        case .shopPhoto: return "Something in a shop"
        case .receipt: return "A receipt"
        case .other: return "Something else"
        case .unknown: return "Not said"
        }
    }
}

/// Attachments for the composer and the capture sheet. Items keep their position while they
/// upload and can be retried one at a time.
@MainActor
@Observable
public final class UploadModel {
    public let environment: AppEnvironment
    public private(set) var items: [UploadItem] = []

    public init(environment: AppEnvironment) { self.environment = environment }

    public var readyAssetIds: [String] { items.compactMap(\.assetId) }
    /// The role of each finalized photograph the owner gave one to, by asset ID.
    public var readyImageRoles: [String: PhotoRole] {
        var roles: [String: PhotoRole] = [:]
        for item in items { if let asset = item.assetId, let role = item.role, role != .unknown { roles[asset] = role } }
        return roles
    }
    /// The owner says (or takes back) what a photograph is. Nothing is sent by this.
    public func setRole(_ role: PhotoRole?, for id: String) {
        if let i = items.firstIndex(where: { $0.id == id }) { items[i].role = role == .unknown ? nil : role }
    }
    /// True while any attachment is neither ready nor removed.
    public var hasUnfinished: Bool { items.contains { $0.assetId == nil } }

    /// Adds a photo and starts uploading it. Adding a photo sends no turn and no command.
    @discardableResult
    public func add(data: Data, contentType: UploadContentType, intent: UploadIntent, garmentId: String? = nil, wearingDate: LocalDate? = nil, role: PhotoRole? = nil) async -> String {
        let item = UploadItem(clientUploadId: environment.ids.next("upload"), data: data, contentType: contentType, intent: intent, garmentId: garmentId, wearingDate: wearingDate, role: role, state: .waiting)
        items.append(item)
        await upload(item.id)
        return item.id
    }

    public func remove(_ id: String) { items.removeAll { $0.id == id } }
    public func removeAll() { items.removeAll() }

    public func retry(_ id: String) async {
        guard let item = items.first(where: { $0.id == id }), item.canRetry else { return }
        await upload(id)
    }

    private func set(_ id: String, _ state: UploadItem.State) {
        if let i = items.firstIndex(where: { $0.id == id }) { items[i].state = state }
    }

    private func upload(_ id: String) async {
        guard let item = items.first(where: { $0.id == id }) else { return }
        let api = environment.api
        do {
            set(id, .authorizing)
            let authorization = try await api.authorizeUpload(UploadRequest(clientUploadId: item.clientUploadId, intent: item.intent, contentType: item.contentType,
                                                                               byteLength: item.data.count, garmentId: item.garmentId, wearingDate: item.wearingDate))
            guard item.data.count <= authorization.maxBytes else {
                // Refused before any bytes are sent; the photo is never truncated to fit.
                set(id, .failed("This photo is larger than the \(authorization.maxBytes / 1_000_000) MB limit.", retryable: false))
                return
            }
            set(id, .uploading)
            try await api.uploadContent(authorization, data: item.data)
            set(id, .finalizing)
            let completed = try await api.completeUpload(uploadId: authorization.uploadId)
            if completed.state == .finalized, let asset = completed.asset {
                set(id, .ready(assetId: asset.assetId))
            } else {
                set(id, .rejected(completed.rejectionReason ?? "The photo could not be used."))
            }
            environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            environment.center.noteRead(failure: failure)
            set(id, .failed(failure.isTransport ? "Upload interrupted." : failure.ownerMessage, retryable: failure.isRetryable))
        } catch {
            set(id, .failed("Upload interrupted.", retryable: true))
        }
    }
}
