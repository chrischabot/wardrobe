import SwiftUI
import GarderobeKit

@main
struct GarderobeApp: App {
    @UIApplicationDelegateAdaptor(PushRegistrar.self) private var pushRegistrar
    @State private var app: AppModel = AppBootstrap.make()
    @Environment(\.scenePhase) private var scenePhase
    private let network = NetworkMonitor()

    var body: some Scene {
        WindowGroup {
            RootView(switchToDemo: { if let demo = AppBootstrap.makeDemo() { app = demo } },
                     leaveDemo: { app = AppBootstrap.make(demo: false) })
                .environment(app)
                .task(id: ObjectIdentifier(app)) {
                    await app.launch()
                    PushRegistrar.refresh(app.notifications, isDemo: app.environment.isDemo)
                    let model = app
                    network.start { Task { @MainActor in await model.becameActive() } }
                }
                .onChange(of: scenePhase) { _, phase in
                    // No background timer composes anything: the app refreshes when it is opened.
                    if phase == .active {
                        Task { await app.becameActive() }
                        PushRegistrar.refresh(app.notifications, isDemo: app.environment.isDemo)
                    }
                }
                .onOpenURL { url in _ = app.open(url: url) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { _ = app.open(url: url) }
                }
        }
    }
}

/// The session gate and, once signed in, the four destinations.
struct RootView: View {
    @Environment(AppModel.self) private var app
    let switchToDemo: () -> Void
    let leaveDemo: () -> Void

    var body: some View {
        Group {
            switch app.account.state {
            case .unknown:
                // The cached board is already loaded; avoid flashing a sign-in screen while the session is checked.
                Color(.systemGroupedBackground).ignoresSafeArea()
            case .signedOut:
                SignInScreen(startDemo: switchToDemo)
            case .identityNotLinked:
                IdentityNotLinkedScreen()
            case .signedIn, .offline, .demo:
                if app.account.visibleKit != nil {
                    // A recovery kit that was just issued is shown before anything else: it is shown
                    // once, and after a recovery the previous code no longer works.
                    RecoveryOutcomeView()
                } else if app.firstUse.isComplete || app.environment.isDemo {
                    MainTabs(leaveDemo: leaveDemo)
                } else {
                    FirstUseFlow()
                }
            }
        }
        .tint(Color.accentColor) // one accent colour
    }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var app
    let leaveDemo: () -> Void

    var body: some View {
        @Bindable var app = app
        TabView(selection: $app.selectedTab) {
            Tab(AppTab.today.title, systemImage: AppTab.today.symbol, value: AppTab.today) {
                destination(.today) { TodayScreen() }
            }
            .accessibilityIdentifier(AXID.tabToday)
            Tab(AppTab.wardrobe.title, systemImage: AppTab.wardrobe.symbol, value: AppTab.wardrobe) {
                destination(.wardrobe) { WardrobeScreen() }
            }
            .accessibilityIdentifier(AXID.tabWardrobe)
            Tab(AppTab.studio.title, systemImage: AppTab.studio.symbol, value: AppTab.studio) {
                destination(.studio) { StudioScreen() }
            }
            .accessibilityIdentifier(AXID.tabStudio)
            Tab(AppTab.conversation.title, systemImage: AppTab.conversation.symbol, value: AppTab.conversation) {
                destination(.conversation) { ConversationScreen() }
            }
            .accessibilityIdentifier(AXID.tabConversation)
        }
        .sheet(item: $app.sheet) { sheet in
            switch sheet {
            case .capture: CaptureSheet()
            case .laundry: LaundrySheet()
            case .settings: SettingsSheet(leaveDemo: leaveDemo)
            }
        }
    }

    /// One destination: its own navigation stack (restored path), the status banner above the
    /// content, the undo banner above the tab bar, and the capture and account controls.
    private func destination<Content: View>(_ tab: AppTab, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack(path: Binding(get: { app.path(for: tab) }, set: { app.setPath($0, for: tab) })) {
            content()
                .modifier(BannerInsets())
                .navigationDestination(for: AppRoute.self) { route in
                    Group {
                        switch route {
                        case .item(let garmentId): ItemScreen(garmentId: garmentId)
                        case .trips: TripsScreen()
                        case .trip(let tripId): TripScreen(tripId: tripId)
                        case .returns: ReturnsScreen()
                        case .reconcile(let category): ReconcileScreen(category: category)
                        case .bulkEdit: BulkEditScreen()
                        case .temperaturePreview: TemperaturePreviewScreen()
                        case .projects: ProjectsScreen()
                        case .proposals: ProposalsScreen()
                        }
                    }
                    .modifier(BannerInsets())
                }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { app.sheet = .settings } label: { Label("Account and settings", systemImage: "person.crop.circle") }
                            .accessibilityIdentifier(AXID.accountButton)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { app.sheet = .capture } label: { Label("Capture", systemImage: "camera") }
                            .accessibilityIdentifier(AXID.captureButton)
                    }
                }
        }
    }
}

/// The status banner under the navigation bar and the undo banner above the tab bar, on every
/// screen of a destination. They sit inside the navigation stack so they never cover the bar's
/// own controls.
private struct BannerInsets: ViewModifier {
    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) { StatusBannerView() }
            .safeAreaInset(edge: .bottom, spacing: Metrics.unit * 2) { UndoBannerView() }
    }
}
