// A literal copy of GarderobeKit/Presentation/AccessibilityIdentifiers.swift for the UI test target,
// which does not link the package. Tools/check-app-sources.py fails if the two differ.
enum AXID {
    static let tabToday = "tab.today"
    static let tabWardrobe = "tab.wardrobe"
    static let tabStudio = "tab.studio"
    static let tabConversation = "tab.conversation"
    static let captureButton = "action.capture"
    static let accountButton = "action.account"
    static let laundryButton = "action.laundry"
    static let statusBanner = "banner.status"
    static let demoLabel = "label.demo"
    static let undoBanner = "banner.undo"
    static let undoButton = "banner.undo.button"
    static let todayDate = "today.date"
    static let todayWeather = "today.weather"
    static let todayFreshness = "today.freshness"
    static let todayCarousel = "today.carousel"
    static let todayComparisonToggle = "today.comparison.toggle"
    static let todayComparisonList = "today.comparison.list"
    static let todayDayRecord = "today.dayRecord"
    static func option(_ id: String) -> String { "today.option.\(id)" }
    static func optionChoose(_ id: String) -> String { "today.option.\(id).choose" }
    static func optionSwap(_ id: String) -> String { "today.option.\(id).swap" }
    static func optionAsk(_ id: String) -> String { "today.option.\(id).ask" }
    static func optionWore(_ id: String) -> String { "today.option.\(id).wore" }
    static func optionFootwear(_ id: String, _ garmentId: String) -> String { "today.option.\(id).footwear.\(garmentId)" }
    static let todayPrevious = "today.previous"
    static let todayNext = "today.next"
    static let wardrobeSearch = "wardrobe.search"
    static let wardrobeCounts = "wardrobe.counts"
    static let wardrobeFilters = "wardrobe.filters"
    static let wardrobeLayoutToggle = "wardrobe.layout.toggle"
    static func wardrobeItem(_ id: String) -> String { "wardrobe.item.\(id)" }
    static let wardrobeBulkEdit = "wardrobe.bulkEdit"
    static let bulkEditSelectAll = "bulkEdit.selectAll"
    static let bulkEditApply = "bulkEdit.apply"
    static let bulkEditCheck = "bulkEdit.check"
    static let itemStatus = "item.status"
    static func itemAction(_ action: String) -> String { "item.action.\(action)" }
    static let itemHistory = "item.history"
    static let itemAsk = "item.ask"
    static let laundryCollected = "laundry.collected"
    static let laundryReturned = "laundry.returned"
    static let laundryStillAway = "laundry.stillAway"
    static let laundrySocksWashed = "laundry.socksWashed"
    static let laundryConfirmReturn = "laundry.confirmReturn"
    static let studioCanvas = "studio.canvas"
    static let studioMode = "studio.mode"
    static func studioSelector(_ role: String) -> String { "studio.selector.\(role)" }
    static func studioPrevious(_ role: String) -> String { "studio.selector.\(role).previous" }
    static func studioNext(_ role: String) -> String { "studio.selector.\(role).next" }
    static func studioLock(_ role: String) -> String { "studio.selector.\(role).lock" }
    static let studioFind = "studio.find"
    static let studioSave = "studio.save"
    static let studioPlan = "studio.plan"
    static let studioWear = "studio.wear"
    static let studioValidation = "studio.validation"
    static let transcript = "conversation.transcript"
    static let composerField = "conversation.composer.field"
    static let composerSend = "conversation.composer.send"
    static let composerStop = "conversation.composer.stop"
    static let composerAttach = "conversation.composer.attach"
    static let newMessages = "conversation.newMessages"
    static let historySearch = "conversation.search"
    static let returnToLatest = "conversation.returnToLatest"
    static func captureIntent(_ intent: String) -> String { "capture.intent.\(intent)" }
    static let captureSubmit = "capture.submit"
    static let settingsMyStyle = "settings.myStyle"
    static let styleSaveResult = "style.saveResult"
    static let styleSavePreview = "style.savePreview"
    static let styleSaveConfirm = "style.saveConfirm"
    static func styleConflict(_ id: String) -> String { "style.conflict.\(id)" }
    static let settingsPause = "settings.pause"
    static let settingsResume = "settings.resume"
    static let settingsConnections = "settings.connections"
    static let settingsAssistants = "settings.assistants"
    static let settingsExport = "settings.export"
    static let settingsRecovery = "settings.recovery"
    static let settingsSignOut = "settings.signOut"
    static let signInButton = "signin.button"
    static let demoButton = "signin.demo"
}
