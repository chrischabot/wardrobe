import Foundation
import Observation

/// Everything a feature model needs, assembled once. The live app, the labelled demo mode
/// and the tests differ only in the `HTTPTransport`, token provider and stores passed in here.
@MainActor
@Observable
public final class AppEnvironment {
    public let api: APIClient
    public let center: CommandCenter
    public let cache: SnapshotCache
    public let restoration: RestorationStore
    public let media: MediaCache
    public let time: TimeSource
    public let ids: IdentifierSource
    /// True when the app is showing the bundled recorded data instead of the owner's backend.
    /// Every screen shows a "Demo data" label while this is set.
    public let isDemo: Bool
    /// The owner's timezone from settings: the day boundary for "today" and every local date.
    public var timeZone: TimeZone

    public init(transport: HTTPTransport, tokens: AccessTokenProviding, store: KeyValueStore, time: TimeSource = SystemTimeSource(),
                ids: IdentifierSource = UUIDIdentifierSource(), isDemo: Bool = false, timeZone: TimeZone = .current, presentation: TokenPresentation = .bearer) {
        let api = APIClient(transport: transport, tokens: tokens, presentation: presentation)
        let restoration = RestorationStore(store: store)
        self.api = api
        self.cache = SnapshotCache(store: store)
        self.restoration = restoration
        self.media = MediaCache(store: store)
        self.time = time
        self.ids = ids
        self.isDemo = isDemo
        self.center = CommandCenter(api: api, queue: CommandQueue(store: store), store: restoration, time: time, ids: ids)
        if let saved: String = restoration.load("timezone"), let zone = TimeZone(identifier: saved) { self.timeZone = zone } else { self.timeZone = timeZone }
    }

    /// Today's civil date in the owner's timezone.
    public var today: LocalDate { Dates.localDate(of: time.now(), in: timeZone) }

    /// Adopts the timezone the backend's settings name and remembers it for the next launch.
    public func adopt(timeZoneIdentifier: String) {
        guard let zone = TimeZone(identifier: timeZoneIdentifier), zone != timeZone else { return }
        timeZone = zone
        restoration.save("timezone", timeZoneIdentifier)
    }

    /// A cached resource wired to this environment's cache, connection state and clock.
    public func resource<T: Codable & Sendable & Equatable>(_ key: String, cached: Bool = true, fetch: @escaping () async throws -> T) -> Resource<T> {
        Resource(key: key, cache: cached ? cache : nil, center: center, time: time, fetch: fetch)
    }
}
