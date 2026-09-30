import Foundation
import Synchronization

/// The on-device client cache (spec section 13: board snapshots, drafts, pending commands). It is
/// a cache, never a source of truth: synchronization refreshes canonical state from the backend.
///
/// Stored as one JSON file per key, written atomically. This is the "equivalent" of SwiftData the
/// acceptance criteria allow; it is chosen because it is testable on Linux and needs no schema
/// migration for a cache that can always be rebuilt from the server.
public protocol ClientStore: Sendable {
    func data(forKey key: String) -> Data?
    func setData(_ data: Data?, forKey key: String)
}

extension ClientStore {
    public func load<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        guard let data = data(forKey: key) else { return nil }
        return try? GarderobeJSON.decoder().decode(T.self, from: data)
    }

    public func save<T: Encodable>(_ value: T?, _ key: String) {
        guard let value else { return setData(nil, forKey: key) }
        setData(try? GarderobeJSON.encoder().encode(value), forKey: key)
    }
}

public enum StoreKey {
    public static let today = "today-snapshot"
    public static let wardrobe = "wardrobe-snapshot"
    public static let itemPrefix = "item-"
    public static let pendingCommands = "pending-commands"
    public static let receipts = "receipts"
    public static let conversation = "conversation-transcript"
    public static let conversationDraft = "conversation-draft"
    public static let pendingTurns = "conversation-pending-turns"
    public static let runCursors = "conversation-run-cursors"
    public static let restoration = "restoration"
    public static let studio = "studio-state"
    public static let styleDocument = "style-document"
    public static let styleDraft = "style-draft"
    public static let settings = "settings"
    public static let connections = "connections"
    public static let laundry = "laundry"
    public static let todayPreferences = "today-preferences"
}

public final class FileClientStore: ClientStore {
    private let directory: URL
    private let lock = Mutex(())

    public init(directory: URL) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// Application Support/Garderobe on device; excluded from backups is unnecessary (small, rebuildable).
    public static func standard() -> FileClientStore {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return FileClientStore(directory: base.appendingPathComponent("Garderobe", isDirectory: true))
    }

    private func url(_ key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }
        return directory.appendingPathComponent(String(safe) + ".json")
    }

    public func data(forKey key: String) -> Data? {
        lock.withLock { _ in try? Data(contentsOf: url(key)) }
    }

    public func setData(_ data: Data?, forKey key: String) {
        lock.withLock { _ in
            if let data { try? data.write(to: url(key), options: .atomic) } else { try? FileManager.default.removeItem(at: url(key)) }
        }
    }

    public func removeAll() {
        lock.withLock { _ in
            try? FileManager.default.removeItem(at: directory)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }
}

public final class MemoryClientStore: ClientStore {
    private let storage = Mutex([String: Data]())
    public init() {}
    public func data(forKey key: String) -> Data? { storage.withLock { $0[key] } }
    public func setData(_ data: Data?, forKey key: String) { storage.withLock { $0[key] = data } }
    public var keys: [String] { storage.withLock { Array($0.keys) } }
}
