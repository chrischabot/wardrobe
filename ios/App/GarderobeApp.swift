import SwiftUI
import GarderobeKit
import GarderobeUI

/// Garderobe for iOS 27.
///
/// Launch arguments (used by the UI tests; harmless otherwise):
///   -GarderobeDemo          run on the bundled demo fixtures (also the default when no API URL is configured)
///   -GarderobeResetState    clear the on-device cache first
///   -GarderobeStartOffline  demo backend starts unreachable (offline journeys)
///   -GarderobeTripDay       demo backend serves the DEMO trip-day board (a packed trip covers the date)
@main
struct GarderobeApp: App {
    @State private var model: AppModel
    private let account: AccountActions?
    private let monitor = NetworkMonitor()
    private let followsNetwork: Bool

    init() {
        let args = ProcessInfo.processInfo.arguments
        let store = FileClientStore.standard()
        if args.contains("-GarderobeResetState") { store.removeAll() }
        let configured = (Bundle.main.object(forInfoDictionaryKey: "GarderobeAPIBaseURL") as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }

        if let base = configured, !args.contains("-GarderobeDemo") {
            // Native sign-in: secretless PKCE client `garderobe-ios`; tokens refresh (rotating) on expiry or 401.
            let keychain = KeychainTokenStore()
            let transport = URLSessionTransport(baseURL: base)
            let auth = NativeAuthSession(config: NativeAuthConfig(baseURL: base), storage: keychain, transport: transport)
            let api = APIClient(baseURL: base, transport: transport, tokens: auth)
            _model = State(initialValue: AppModel(env: AppEnvironment(api: api, store: store)))
            let signIn = SignInCoordinator(auth: auth)
            account = AccountActions(
                serverLabel: base.host() ?? base.absoluteString,
                isSignedIn: { keychain.load() != nil },
                signIn: { await signIn.signIn() },
                signOut: { await signIn.signOut() }
            )
            followsNetwork = true
        } else {
            // Demo: the owner's real profile and May 2026 inventory as bundled fixtures, clearly badged.
            let server = try! FixtureServer(startOffline: args.contains("-GarderobeStartOffline"), tripDay: args.contains("-GarderobeTripDay"), origin: "https://demo.garderobe.invalid")
            _model = State(initialValue: try! AppModel.demo(store: store, server: server).0)
            account = nil
            followsNetwork = false
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(account: account)
                .environment(model)
                .tint(Color("AccentColor"))
                .task {
                    await model.bootstrap()
                    if followsNetwork {
                        let m = model
                        monitor.start { online in Task { await m.setOnline(online) } }
                    }
                }
        }
    }
}
