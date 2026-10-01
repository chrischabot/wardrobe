import Foundation
import Observation

/// Where the value on screen came from. The interface never blurs these: a cached value is
/// labelled with when it was checked, and only a value read in this session is called current.
public enum ReadOrigin: Sendable, Equatable {
    case none
    /// Read from the phone's cache; not confirmed with the backend in this session.
    case cache
    /// Returned by the backend in this session.
    case live
}

/// A cached read of one backend resource: shows the cached value at once, refreshes it, and
/// keeps an honest record of when the value was last confirmed and why a refresh failed.
@MainActor
@Observable
public final class Resource<Value: Codable & Sendable & Equatable> {
    public private(set) var value: Value?
    public private(set) var checkedAt: Date?
    public private(set) var origin: ReadOrigin = .none
    public private(set) var isRefreshing = false
    /// The most recent refresh failure; cleared by the next successful refresh.
    public private(set) var failure: APIFailure?

    private let key: String
    private let cache: SnapshotCache?
    private let center: CommandCenter?
    private let time: TimeSource
    private var fetch: () async throws -> Value
    private var generation = 0

    /// - Parameter cache: pass `nil` for reads that must never be served from disk.
    public init(key: String, cache: SnapshotCache?, center: CommandCenter?, time: TimeSource, fetch: @escaping () async throws -> Value) {
        self.key = key; self.cache = cache; self.center = center; self.time = time; self.fetch = fetch
    }

    /// Shows the cached value, if any, without touching the network. Synchronous on purpose:
    /// a cached board appears in the first frame, with no entrance animation to wait for.
    public func loadCached() {
        guard origin == .none, let cached: Cached<Value> = cache?.get(key) else { return }
        value = cached.value
        checkedAt = cached.checkedAt
        origin = .cache
    }

    /// Replaces the fetch (for example when a filter changes) and drops any in-flight result.
    public func retarget(_ fetch: @escaping () async throws -> Value) {
        self.fetch = fetch
        generation += 1
    }

    @discardableResult
    public func refresh() async -> Bool {
        generation += 1
        let mine = generation
        isRefreshing = true
        defer { if mine == generation { isRefreshing = false } }
        do {
            let fresh = try await fetch()
            guard mine == generation else { return false } // superseded by a newer request
            value = fresh
            checkedAt = time.now()
            origin = .live
            failure = nil
            cache?.put(key, fresh, checkedAt: time.now())
            center?.noteRead(failure: nil)
            return true
        } catch let f as APIFailure {
            guard mine == generation else { return false }
            failure = f
            center?.noteRead(failure: f)
            return false
        } catch {
            guard mine == generation else { return false }
            failure = .transport(String(describing: error))
            return false
        }
    }

    /// Replaces the value with one the backend just returned through another route.
    public func accept(_ fresh: Value) {
        generation += 1
        value = fresh
        checkedAt = time.now()
        origin = .live
        failure = nil
        cache?.put(key, fresh, checkedAt: time.now())
    }

    public func clear() {
        generation += 1
        value = nil; checkedAt = nil; origin = .none; failure = nil
        cache?.remove(key)
    }

    public var freshness: Freshness {
        // If any exchange since this value was read failed in transport (for example a command
        // that had to be queued), the value is no longer presented as current.
        let offline: APIFailure? = (center?.isOffline ?? false) ? .transport("offline") : nil
        return Freshness(origin: origin, checkedAt: checkedAt, isRefreshing: isRefreshing, failure: failure ?? offline)
    }
}

/// The freshness of what is on screen, and the sentence that states it.
public struct Freshness: Sendable, Equatable {
    public var origin: ReadOrigin
    public var checkedAt: Date?
    public var isRefreshing: Bool
    public var failure: APIFailure?

    /// True only when the value was confirmed by the backend in this session and no later refresh failed.
    public var isCurrent: Bool { origin == .live && failure == nil }
    public var isOffline: Bool { failure?.isTransport ?? false }

    /// One sentence for the owner. It never says "up to date" about a cached value.
    public func statement(subject: String, now: Date, timeZone: TimeZone) -> String {
        let when = checkedAt.map { Phrases.relativeTime($0, now: now, timeZone: timeZone) }
        switch (origin, failure) {
        case (.none, .some(let f)) where f.isTransport:
            return "Offline. \(subject.capitalizedFirst) has not been saved on this phone yet."
        case (.none, .some(let f)):
            return f.ownerMessage
        case (.none, nil):
            return isRefreshing ? "Loading \(subject)..." : ""
        case (_, .some(let f)) where f.isTransport:
            return "Offline. \(subject.capitalizedFirst) last checked \(when ?? "earlier")."
        case (_, .some(let f)) where f.needsSignIn:
            return "Signed out. \(subject.capitalizedFirst) last checked \(when ?? "earlier")."
        case (_, .some):
            return "Could not refresh. \(subject.capitalizedFirst) last checked \(when ?? "earlier")."
        case (.cache, nil):
            return isRefreshing ? "Saved \(subject) from \(when ?? "earlier"). Checking..." : "Saved \(subject) from \(when ?? "earlier"). Not checked yet."
        case (.live, nil):
            return "Checked \(when ?? "just now")."
        }
    }
}

extension String {
    var capitalizedFirst: String { isEmpty ? self : prefix(1).uppercased() + dropFirst() }
}
