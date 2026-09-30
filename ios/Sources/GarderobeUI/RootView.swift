#if os(iOS)
import SwiftUI
import GarderobeKit

/// Four destinations, a capture action from each, settings behind the account control.
public struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    private let account: AccountActions?

    public init(account: AccountActions? = nil) { self.account = account }

    public var body: some View {
        @Bindable var app = app
        TabView(selection: $app.selectedTab) {
            Tab(AppTab.today.title, systemImage: AppTab.today.systemImage, value: AppTab.today) { TodayView() }
            Tab(AppTab.wardrobe.title, systemImage: AppTab.wardrobe.systemImage, value: AppTab.wardrobe) { WardrobeView() }
            Tab(AppTab.studio.title, systemImage: AppTab.studio.systemImage, value: AppTab.studio) { StudioView() }
            Tab(AppTab.conversation.title, systemImage: AppTab.conversation.systemImage, value: AppTab.conversation) { ConversationView() }
        }
        .overlay(alignment: .bottom) {
            if let banner = app.receipts.banner {
                ReceiptBannerView(banner: banner).padding(.bottom, 64).id(banner.id)
            }
        }
        .sheet(item: $app.sheet) { sheet in
            switch sheet {
            case .capture(let intent): CaptureView(initial: intent)
            case .laundry: LaundryView()
            case .settings: SettingsView(account: account)
            case .receipts: NavigationStack { ReceiptsListView() }
            case .accountRequest: AccountRequestView()
            }
        }
        // garderobe://confirm/{runId}: confirm an assistant's export, import or recovery-kit request.
        .onOpenURL { url in Task { await app.handle(url: url) } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await app.foreground() } } }
    }
}

/// Shared toolbar: Laundry (Today and Wardrobe), Capture (every tab), account control (settings).
struct AppToolbar: ToolbarContent {
    @Environment(AppModel.self) private var app
    let showsLaundry: Bool
    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if showsLaundry {
                Button { app.sheet = .laundry } label: { Label("Laundry", systemImage: "washer") }
                    .accessibilityIdentifier("toolbar.laundry")
            }
            CaptureMenu()
            Button { app.sheet = .settings } label: { Label("Account and settings", systemImage: "person.crop.circle") }
                .accessibilityIdentifier("toolbar.account")
        }
    }
}

#Preview("Demo") {
    let (app, _) = try! AppModel.demo()
    return RootView().environment(app).task { await app.bootstrap() }
}
#endif
