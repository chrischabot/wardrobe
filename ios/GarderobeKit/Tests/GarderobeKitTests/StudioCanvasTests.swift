import Testing
import Foundation
@testable import GarderobeKit

/// Studio keeps each mode's canvas: an empty canvas shown while a mode's selectors are still
/// being read is never saved over what the owner left there. Backend: SYNTHETIC router.
@MainActor
@Suite("Studio: a mode's saved canvas survives switching while its selectors load")
struct StudioCanvasTests {
    private func studioRouter() -> Router {
        let router = Router()
        router.on("GET", "/v1/studio") { request in
            let explore = request.query.contains(URLQueryItem(name: "mode", value: "explore"))
            let tops = [Synthetic.selectorItem("gmt_test_shirt", name: "Test blue oxford shirt"), Synthetic.selectorItem("gmt_test_knit", name: "Test grey jumper")]
            return TestSupport.json(Synthetic.studio(mode: explore ? "explore" : "for_today",
                                                     selectors: [("top", true, tops), ("bottom", true, [Synthetic.selectorItem("gmt_test_chino", name: "Test stone chinos"), Synthetic.selectorItem("gmt_test_navy", name: "Test navy chinos")])],
                                                     opening: explore ? [("top", "gmt_test_shirt"), ("bottom", "gmt_test_navy")] : [("top", "gmt_test_shirt"), ("bottom", "gmt_test_chino")]))
        }
        // Suggests only pieces the selectors no longer offer.
        let gone: [JSONValue] = [["role": "top", "garmentId": "gmt_test_gone_top", "shoppingCandidate": .null, "locked": false],
                                 ["role": "bottom", "garmentId": "gmt_test_gone_bottom", "shoppingCandidate": .null, "locked": false]]
        router.json("POST", "/v1/studio/suggest", ["suggestions": [["slots": .array(gone), "reason": "Test reason", "validation": Synthetic.validation()]]])
        return router
    }

    @Test("A suggestion none of whose pieces is offered leaves an empty canvas that says it was not checked, and names what was not placed")
    func unplaceableSuggestionSaysSo() async throws {
        let studio = StudioModel(environment: TestSupport.environment(transport: studioRouter().transport), sleep: { _ in })
        await studio.open()
        await studio.findSomethingThatWorks()
        let suggestion = try #require(studio.suggestions.first)
        #expect(await studio.applyAndCheck(suggestion))
        #expect(studio.selection.isEmpty)
        guard case .unchecked(let line) = studio.validation else { Issue.record("expected an unchecked canvas"); return }
        #expect(line.contains("nothing to check"))
        #expect(studio.restoreNote?.contains("no longer offered") == true)
    }

    @Test("A suggestion kept from an earlier list is refused even after new suggestions were found")
    func retainedSuggestionIsRefused() async throws {
        let studio = StudioModel(environment: TestSupport.environment(transport: studioRouter().transport), sleep: { _ in })
        await studio.open()
        await studio.findSomethingThatWorks()
        let old = try #require(studio.suggestions.first)
        await studio.setMode(.explore)
        await studio.findSomethingThatWorks()
        // Only an entry of the list on screen is applied; anything else (here, one never offered
        // for this combination) is refused and the canvas is left as it was.
        let fresh = try #require(studio.suggestions.first)
        #expect(studio.apply(fresh))
        let before = studio.selection
        #expect(!studio.apply(StudioSuggestion(slots: [], reason: "Not offered", validation: old.validation)))
        #expect(studio.selection == before)
    }

    @Test("Switching through a mode whose selectors are not known yet leaves that mode's saved canvas as it was")
    func uncachedModeKeepsItsSavedCanvas() async throws {
        let router = studioRouter()
        let store = InMemoryKeyValueStore()
        let saved: JSONValue = ["mode": "explore", "slots": ["top": "gmt_test_knit"], "locked": []]
        let bytes = try GarderobeJSON.encode(saved)
        try store.write("restore.studio.selection.explore", bytes)
        let studio = StudioModel(environment: TestSupport.environment(transport: router.transport, store: store), sleep: { _ in })
        await studio.open()
        router.offline.value = true
        await studio.setMode(.explore)
        #expect(studio.selection.isEmpty)
        // A relaunch now reopens Explore, the mode the owner switched to, with its canvas kept.
        let relaunched = StudioModel(environment: TestSupport.environment(transport: router.transport, store: store), sleep: { _ in })
        #expect(relaunched.mode == .explore)
        #expect(store.read("restore.studio.selection.explore") == bytes)
        await studio.setMode(.forToday)
        #expect(store.read("restore.studio.selection.explore") == bytes)
    }

    @Test("Leaving the opening mode before its selectors arrive keeps its saved canvas for when the owner returns")
    func initialModeKeepsItsSavedCanvas() async throws {
        let router = studioRouter()
        let store = InMemoryKeyValueStore()
        // Saved only as the last state at the previous launch: Explore with the jumper on top.
        try store.write("restore.studio.state", GarderobeJSON.encode(["mode": "explore", "slots": ["top": "gmt_test_knit"], "locked": []] as JSONValue))
        let studio = StudioModel(environment: TestSupport.environment(transport: router.transport, store: store), sleep: { _ in })
        #expect(studio.mode == .explore)
        router.offline.value = true
        await studio.open()
        #expect(studio.selection.isEmpty)                        // nothing cached, nothing read yet
        await studio.setMode(.forToday)
        router.offline.value = false
        await studio.setMode(.explore)
        #expect(studio.selection[.top]?.garmentId == "gmt_test_knit")   // not the backend's opening shirt
    }

    @Test("When the account ends, Studio drops its picks and every mode's selectors read for that account")
    func resetDropsTheAccountsReads() async throws {
        let router = studioRouter()
        let studio = StudioModel(environment: TestSupport.environment(transport: router.transport), sleep: { _ in })
        await studio.open()
        await studio.setMode(.explore)
        #expect(!studio.selection.isEmpty && studio.studio.value != nil)
        studio.reset()
        #expect(studio.selection.isEmpty && studio.studio.value == nil && studio.restoreNote == nil)
        await studio.setMode(.forToday)
        router.offline.value = true
        await studio.setMode(.explore)
        #expect(studio.studio.value == nil && studio.selection.isEmpty)   // the earlier read is gone, not reused
    }
}
