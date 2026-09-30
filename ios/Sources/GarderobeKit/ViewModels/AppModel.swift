import Foundation
import Observation

public enum AppTab: String, Codable, Sendable, CaseIterable, Identifiable {
    case today, wardrobe, studio, conversation
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .today: "Today"
        case .wardrobe: "Wardrobe"
        case .studio: "Studio"
        case .conversation: "Conversation"
        }
    }
    public var systemImage: String {
        switch self {
        case .today: "sun.horizon"
        case .wardrobe: "cabinet"
        case .studio: "square.stack.3d.up"
        case .conversation: "bubble.left.and.text.bubble.right"
        }
    }
}

public enum AppSheet: Identifiable, Sendable, Hashable {
    case capture(CaptureIntent?)
    case laundry
    case settings
    case receipts
    /// Confirming an assistant's export, import or recovery-kit request, and its private result.
    case accountRequest
    public var id: String {
        switch self {
        case .capture(let i): "capture-" + (i?.rawValue ?? "choose")
        case .laundry: "laundry"
        case .settings: "settings"
        case .receipts: "receipts"
        case .accountRequest: "account-request"
        }
    }
}

/// What survives restoration: tab, navigation path (draft, Studio locks and the transcript anchor
/// are persisted by their own view models).
public struct RestorationState: Codable, Sendable, Hashable {
    public var tab: AppTab = .today
    public var wardrobePath: [String] = []
    public init() {}
}

@MainActor
@Observable
public final class AppModel {
    public let env: AppEnvironment
    public let queue: CommandQueue
    public let receipts: ReceiptCenter
    public let today: TodayViewModel
    public let wardrobe: WardrobeViewModel
    public let studio: StudioViewModel
    public let conversation: ConversationViewModel
    public let laundry: LaundryViewModel
    public let settings: SettingsViewModel
    public let myStyle: MyStyleViewModel
    public let accountRequest: AccountRequestViewModel
    /// True when running on the bundled demo fixtures (shown as a visible badge).
    public let isDemo: Bool

    public var selectedTab: AppTab = .today { didSet { saveRestoration() } }
    public var wardrobePath: [String] = [] { didSet { saveRestoration() } }
    public var sheet: AppSheet?

    public init(env: AppEnvironment, isDemo: Bool = false) {
        self.env = env
        self.isDemo = isDemo
        let queue = CommandQueue(env: env)
        let receipts = ReceiptCenter(env: env)
        let wardrobe = WardrobeViewModel(env: env)
        self.queue = queue
        self.receipts = receipts
        self.wardrobe = wardrobe
        self.today = TodayViewModel(env: env, queue: queue, garmentLookup: { wardrobe.garmentLookup() })
        self.studio = StudioViewModel(env: env, queue: queue, wardrobe: wardrobe)
        self.conversation = ConversationViewModel(env: env, receipts: receipts)
        self.laundry = LaundryViewModel(env: env, queue: queue)
        self.settings = SettingsViewModel(env: env, queue: queue)
        self.myStyle = MyStyleViewModel(env: env, queue: queue)
        self.accountRequest = AccountRequestViewModel(env: env, receipts: receipts)
        let restored = env.store.load(RestorationState.self, StoreKey.restoration) ?? RestorationState()
        selectedTab = restored.tab
        wardrobePath = restored.wardrobePath

        queue.onReceipt { [weak self] receipt, _ in
            guard let self else { return }
            self.receipts.record(receipt, announce: true)
            Task { await self.afterReceipt(receipt) }
        }
        laundry.onChange = { [weak self] in
            await self?.wardrobe.refresh()
            await self?.today.refresh()
        }
        conversation.onAccountOperation = { [weak self] op in
            guard let self else { return }
            self.accountRequest.present(op)
            self.sheet = .accountRequest
        }
        accountRequest.onCompleted = { [weak self] in await self?.settings.refreshAccount() }
    }

    /// A link the app was opened with: `garderobe://confirm/{runId}` or `<API origin>/confirm/{runId}` opens the
    /// confirmation sheet; anything else is ignored. Returns whether the link was handled.
    @discardableResult
    public func handle(url: URL) async -> Bool {
        guard AccountRequestViewModel.runId(from: url, apiBase: env.api.baseURL) != nil else { return false }
        sheet = .accountRequest
        return await accountRequest.open(url)
    }

    /// Demo app on the bundled fixtures (UI tests, previews, and running without a backend).
    public static func demo(store: any ClientStore = MemoryClientStore(), server: FixtureServer? = nil, now: @escaping @Sendable () -> Date = { Fixtures.demoNow }) throws -> (AppModel, FixtureServer) {
        let server = try server ?? FixtureServer(now: now)
        let env = AppEnvironment(api: APIClient(baseURL: URL(string: server.origin)!, transport: server), store: store, now: now)
        return (AppModel(env: env, isDemo: true), server)
    }

    /// Launch: everything cached is already on screen; refresh in the background.
    public func bootstrap() async {
        async let t: Void = today.refresh()
        async let w: Void = wardrobe.refresh()
        _ = await (t, w)
        await queue.setConnectivity(today.lastError != .offline)
        await queue.flush()
        async let c: Void = conversation.load()
        async let s: Void = settings.refresh()
        async let l: Void = laundry.refresh()
        async let m: Void = myStyle.load()
        _ = await (c, s, l, m)
    }

    /// Network path changes (NWPathMonitor on device).
    public func setOnline(_ online: Bool) async {
        await queue.setConnectivity(online)
        if online {
            await today.refresh()
            await conversation.resume()
        }
    }

    public func foreground() async {
        await queue.flush()
        await today.refresh()
        await conversation.resume()
    }

    private func afterReceipt(_ r: CommandReceipt) async {
        guard r.outcome.didCommit else { return }
        switch r.commandType {
        case "record_wear", "select_option", "undo", "amend_wear":
            await today.refresh()
        case "edit_style_profile":
            await myStyle.load()
        default:
            await wardrobe.refresh()
        }
    }

    /// Ask about this (from Today, Wardrobe or Studio): attach identity and open Conversation.
    public func askAbout(_ reference: ConversationReference, label: String) {
        conversation.attach(reference, label: label)
        selectedTab = .conversation
    }

    public func askAbout(optionId: String) {
        guard let ref = today.reference(for: optionId), let card = today.card(optionId) else { return }
        askAbout(ref, label: "Option \(card.position): " + card.composition.prefix(3).map(\.name).joined(separator: ", "))
    }

    public func askAbout(garmentId: String) {
        askAbout(.garment(garmentId: garmentId), label: wardrobe.item(garmentId)?.garment.name ?? "This item")
    }

    public func undo(_ receipt: CommandReceipt) async {
        await receipts.undo(receipt, queue: queue)
    }

    public func makeItemViewModel(_ garmentId: String) -> ItemDetailViewModel {
        ItemDetailViewModel(garmentId: garmentId, env: env, queue: queue, receipts: receipts, wardrobe: wardrobe)
    }

    public func makeCaptureViewModel(_ intent: CaptureIntent) -> CaptureViewModel {
        CaptureViewModel(intent: intent, env: env, conversation: conversation)
    }

    private func saveRestoration() {
        var s = RestorationState()
        s.tab = selectedTab
        s.wardrobePath = wardrobePath
        env.store.save(s, StoreKey.restoration)
    }
}
