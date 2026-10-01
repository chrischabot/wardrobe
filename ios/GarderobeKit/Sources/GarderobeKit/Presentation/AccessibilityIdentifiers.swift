import Foundation

/// Accessibility identifiers shared by the SwiftUI views and the UI tests. The UI test target
/// keeps a literal copy (it does not link this package); `Tools/check.sh` verifies the two
/// lists are identical.
public enum AXID {
    public static let tabToday = "tab.today"
    public static let tabWardrobe = "tab.wardrobe"
    public static let tabStudio = "tab.studio"
    public static let tabConversation = "tab.conversation"
    public static let captureButton = "action.capture"
    public static let accountButton = "action.account"
    public static let laundryButton = "action.laundry"
    public static let statusBanner = "banner.status"
    public static let demoLabel = "label.demo"
    public static let undoBanner = "banner.undo"
    public static let undoButton = "banner.undo.button"

    public static let todayDate = "today.date"
    public static let todayWeather = "today.weather"
    public static let todayFreshness = "today.freshness"
    public static let todayCarousel = "today.carousel"
    public static let todayComparisonToggle = "today.comparison.toggle"
    public static let todayComparisonList = "today.comparison.list"
    public static let todayDayRecord = "today.dayRecord"
    public static func option(_ id: String) -> String { "today.option.\(id)" }
    public static func optionChoose(_ id: String) -> String { "today.option.\(id).choose" }
    public static func optionSwap(_ id: String) -> String { "today.option.\(id).swap" }
    public static func optionAsk(_ id: String) -> String { "today.option.\(id).ask" }
    public static func optionWore(_ id: String) -> String { "today.option.\(id).wore" }
    public static func optionFootwear(_ id: String, _ garmentId: String) -> String { "today.option.\(id).footwear.\(garmentId)" }
    public static let todayPrevious = "today.previous"
    public static let todayNext = "today.next"

    public static let wardrobeSearch = "wardrobe.search"
    public static let wardrobeCounts = "wardrobe.counts"
    public static let wardrobeFilters = "wardrobe.filters"
    public static let wardrobeLayoutToggle = "wardrobe.layout.toggle"
    public static func wardrobeItem(_ id: String) -> String { "wardrobe.item.\(id)" }
    public static let wardrobeBulkEdit = "wardrobe.bulkEdit"
    public static let bulkEditSelectAll = "bulkEdit.selectAll"
    public static let bulkEditApply = "bulkEdit.apply"
    public static let bulkEditCheck = "bulkEdit.check"
    public static let itemStatus = "item.status"
    public static func itemAction(_ action: String) -> String { "item.action.\(action)" }
    public static let itemHistory = "item.history"
    public static let itemAsk = "item.ask"

    public static let laundryCollected = "laundry.collected"
    public static let laundryReturned = "laundry.returned"
    public static let laundryStillAway = "laundry.stillAway"
    public static let laundrySocksWashed = "laundry.socksWashed"
    public static let laundryConfirmReturn = "laundry.confirmReturn"

    public static let studioCanvas = "studio.canvas"
    public static let studioMode = "studio.mode"
    public static func studioSelector(_ role: String) -> String { "studio.selector.\(role)" }
    public static func studioPrevious(_ role: String) -> String { "studio.selector.\(role).previous" }
    public static func studioNext(_ role: String) -> String { "studio.selector.\(role).next" }
    public static func studioLock(_ role: String) -> String { "studio.selector.\(role).lock" }
    public static let studioFind = "studio.find"
    public static let studioSave = "studio.save"
    public static let studioPlan = "studio.plan"
    public static let studioWear = "studio.wear"
    public static let studioValidation = "studio.validation"

    public static let transcript = "conversation.transcript"
    public static let composerField = "conversation.composer.field"
    public static let composerSend = "conversation.composer.send"
    public static let composerStop = "conversation.composer.stop"
    public static let composerAttach = "conversation.composer.attach"
    public static let newMessages = "conversation.newMessages"
    public static let historySearch = "conversation.search"
    public static let returnToLatest = "conversation.returnToLatest"

    public static func captureIntent(_ intent: String) -> String { "capture.intent.\(intent)" }
    public static let captureSubmit = "capture.submit"

    public static let settingsMyStyle = "settings.myStyle"
    public static let styleSaveResult = "style.saveResult"
    public static let styleSavePreview = "style.savePreview"
    public static let styleSaveConfirm = "style.saveConfirm"
    public static func styleConflict(_ id: String) -> String { "style.conflict.\(id)" }
    public static let settingsPause = "settings.pause"
    public static let settingsResume = "settings.resume"
    public static let settingsConnections = "settings.connections"
    public static let settingsAssistants = "settings.assistants"
    public static let settingsProposals = "settings.proposals"
    public static func proposalConfirm(_ id: String) -> String { "proposal.\(id).confirm" }
    public static func proposalReject(_ id: String) -> String { "proposal.\(id).reject" }
    public static let settingsExport = "settings.export"
    public static let settingsRecovery = "settings.recovery"
    public static let settingsSignOut = "settings.signOut"
    public static let signInButton = "signin.button"
    public static let demoButton = "signin.demo"
}
