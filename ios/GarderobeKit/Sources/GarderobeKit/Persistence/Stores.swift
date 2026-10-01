import Foundation

/// Durable key-value storage for the client cache. It is a cache and a queue, never the
/// source of truth: the backend's ledger is. Values are whole JSON documents written atomically.
public protocol KeyValueStore: Sendable {
    func read(_ key: String) -> Data?
    func write(_ key: String, _ data: Data) throws
    func remove(_ key: String)
    func keys(prefix: String) -> [String]
}

public final class InMemoryKeyValueStore: KeyValueStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    /// When set, every write fails: lets tests prove nothing is reported stored that was not.
    public var failWrites = false
    public init() {}
    public func read(_ key: String) -> Data? { lock.lock(); defer { lock.unlock() }; return values[key] }
    public func write(_ key: String, _ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        if failWrites { throw CocoaError(.fileWriteUnknown) }
        values[key] = data
    }
    public func remove(_ key: String) { lock.lock(); values[key] = nil; lock.unlock() }
    public func keys(prefix: String) -> [String] { lock.lock(); defer { lock.unlock() }; return values.keys.filter { $0.hasPrefix(prefix) }.sorted() }
}

/// One file per key under a directory. Keys are percent-encoded into file names, so any
/// identifier the backend issues is a safe key.
public final class FileKeyValueStore: KeyValueStore, @unchecked Sendable {
    private let directory: URL
    private let lock = NSLock()

    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private static let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")

    private func fileURL(_ key: String) -> URL {
        directory.appendingPathComponent((key.addingPercentEncoding(withAllowedCharacters: FileKeyValueStore.allowed) ?? key) + ".json")
    }

    public func read(_ key: String) -> Data? { lock.lock(); defer { lock.unlock() }; return try? Data(contentsOf: fileURL(key)) }
    public func write(_ key: String, _ data: Data) throws { lock.lock(); defer { lock.unlock() }; try data.write(to: fileURL(key), options: .atomic) }
    public func remove(_ key: String) { lock.lock(); defer { lock.unlock() }; try? FileManager.default.removeItem(at: fileURL(key)) }
    public func keys(prefix: String) -> [String] {
        lock.lock(); defer { lock.unlock() }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.compactMap { name -> String? in
            guard name.hasSuffix(".json") else { return nil }
            let key = String(name.dropLast(5)).removingPercentEncoding ?? String(name.dropLast(5))
            return key.hasPrefix(prefix) ? key : nil
        }.sorted()
    }
}

/// A cached read with the time the backend produced it. `checkedAt` is what the interface
/// shows ("Checked 07:02"); a cached value is never presented as a fresh read.
public struct Cached<Value: Codable & Sendable>: Codable, Sendable {
    public var value: Value
    /// When the backend last answered with this value (its `readAt`, or the time of the response).
    public var checkedAt: Date
    public init(value: Value, checkedAt: Date) { self.value = value; self.checkedAt = checkedAt }
}

/// Snapshot cache for board, inventory, item, laundry, style, settings, trips and transcript pages.
public final class SnapshotCache: Sendable {
    private let store: KeyValueStore
    public init(store: KeyValueStore) { self.store = store }

    public func get<T: Codable & Sendable>(_ key: String, as type: T.Type = T.self) -> Cached<T>? {
        guard let data = store.read("cache." + key) else { return nil }
        // A cache entry written by an older build that no longer decodes is simply a miss.
        return try? GarderobeJSON.decode(Cached<T>.self, from: data)
    }

    public func put<T: Codable & Sendable>(_ key: String, _ value: T, checkedAt: Date) {
        guard let data = try? GarderobeJSON.encode(Cached(value: value, checkedAt: checkedAt)) else { return }
        try? store.write("cache." + key, data)
    }

    public func remove(_ key: String) { store.remove("cache." + key) }

    public func removeAll() { for key in store.keys(prefix: "cache.") { store.remove(key) } }
}

/// Small pieces of interface state that must survive closing the app: the selected tab, the
/// navigation path, the composer draft, Studio locks and the transcript reading anchor.
public final class RestorationStore: Sendable {
    private let store: KeyValueStore
    public init(store: KeyValueStore) { self.store = store }

    public func load<T: Codable>(_ key: String, as type: T.Type = T.self) -> T? {
        guard let data = store.read("restore." + key) else { return nil }
        return try? GarderobeJSON.decode(T.self, from: data)
    }
    public func save<T: Codable>(_ key: String, _ value: T) {
        guard let data = try? GarderobeJSON.encode(value) else { return }
        try? store.write("restore." + key, data)
    }
    public func clear(_ key: String) { store.remove("restore." + key) }
}

/// Binary media cache (thumbnails and composition images), keyed by the backend's immutable
/// rendition or asset identity so a cached image can never show a different garment.
public final class MediaCache: Sendable {
    private let store: KeyValueStore
    public init(store: KeyValueStore) { self.store = store }
    public func data(for key: String) -> Data? { store.read("media." + key) }
    public func store(_ data: Data, for key: String) { try? store.write("media." + key, data) }
}
