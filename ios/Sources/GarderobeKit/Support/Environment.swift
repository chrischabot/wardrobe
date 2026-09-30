import Foundation

/// Injected effects so view models are deterministic under test.
public struct AppEnvironment: Sendable {
    public var api: APIClient
    public var store: any ClientStore
    public var now: @Sendable () -> Date
    public var sleep: @Sendable (Duration) async throws -> Void
    public var uuid: @Sendable () -> String
    public var timeZone: TimeZone

    public init(
        api: APIClient, store: any ClientStore, now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        uuid: @escaping @Sendable () -> String = { UUID().uuidString }, timeZone: TimeZone = TimeZone(identifier: "Europe/London")!
    ) {
        self.api = api; self.store = store; self.now = now; self.sleep = sleep; self.uuid = uuid; self.timeZone = timeZone
    }
}

public enum Connectivity: String, Codable, Sendable {
    case unknown, online, offline
}
