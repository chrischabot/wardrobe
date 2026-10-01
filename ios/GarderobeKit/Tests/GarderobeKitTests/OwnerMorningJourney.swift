import Testing
import Foundation
@testable import GarderobeKit

/// Journey tests replay recordings of the REAL Worker (workerd, local D1, the owner's real
/// profile and inventory imported through the ordinary commands). The Swift client must send
/// the same state-changing requests the recording holds, field for field; any request the
/// backend never answered fails the journey through `backend.unexpected`.
///
/// Not real in these recordings (stated in each cassette's provenance): weather and Calendar
/// were unreachable locally, and assistant wording comes from the assistant workstream's
/// labelled fake model. Nothing here proves a deployed backend or a device.
@MainActor
struct Journey {
    let cassette: Cassette
    let backend: FixtureBackend
    let environment: AppEnvironment
    let time: ManualTimeSource
    let store: InMemoryKeyValueStore

    init(_ name: String, store: InMemoryKeyValueStore = InMemoryKeyValueStore()) throws {
        cassette = try Cassette.bundled(name)
        backend = FixtureBackend(cassette: cassette, mode: .strict)
        time = ManualTimeSource(instant: cassette.clock)
        self.store = store
        environment = AppEnvironment(transport: backend, tokens: StaticAccessToken("fixture"), store: store, time: time,
                                     ids: SequentialIdentifierSource(), timeZone: TimeZone(identifier: cassette.timezone)!)
    }

    /// A second launch of the app on the same phone storage and the same backend.
    func relaunch() -> AppEnvironment {
        AppEnvironment(transport: backend, tokens: StaticAccessToken("fixture"), store: store, time: time,
                       ids: SequentialIdentifierSource(seed: "relaunch"), timeZone: TimeZone(identifier: cassette.timezone)!)
    }
}

@MainActor
@Suite("Journey: the owner's morning on his real wardrobe")
struct OwnerMorningJourney {
    static let profileSha256 = "e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198"

    @Test("The recording was made from the owner's supplied profile and inventory")
    func provenance() throws {
        let cassette = try Cassette.bundled("owner-morning")
        #expect(cassette.provenance.profileSha256 == Self.profileSha256)
        #expect(cassette.provenance.backend.hasPrefix("worker"))
        #expect(cassette.provenance.contractVersion == GarderobeContract.version)
    }

    @Test("Wardrobe opens on the imported inventory: every item has the owner's name for it and none is synthetic")
    func wardrobeIsTheRealImport() async throws {
        let j = try Journey("owner-morning")
        let wardrobe = WardrobeModel(environment: j.environment)
        await wardrobe.open()

        let page = try #require(wardrobe.snapshot.value)
        #expect(page.complete)
        #expect(page.total == page.items.count)
        #expect(page.items.count > 100)
        #expect(page.items.allSatisfy { !$0.garment.isSynthetic && !$0.garment.name.isEmpty })
        #expect(wardrobe.countsLine?.contains("\(page.counts.owned) owned") == true)
        #expect(wardrobe.sections.count >= 5)
        // Identical socks are one entry with a quantity, not one entry per pair.
        let socks = page.items.filter { $0.garment.category == .socks }
        #expect(!socks.isEmpty)
        #expect(Set(socks.map(\.garment.name)).count == socks.count)
        #expect(socks.contains { $0.totalOwnedUnits > 1 })
        #expect(j.backend.unexpected.isEmpty)
    }

    @Test("My style shows the imported profile in full with its hash")
    func profileInFull() async throws {
        let j = try Journey("owner-morning")
        let settings = SettingsModel(environment: j.environment)
        await settings.open()
        let document = try #require(settings.style.value?.document)
        #expect(document.contentSha256 == Self.profileSha256)
        #expect(SHA256.hex(Data(document.content.utf8)) == Self.profileSha256) // the full text, byte for byte
        #expect(settings.settings.value?.profile?.contentSha256 == Self.profileSha256)
        #expect(settings.profileLine?.contains("sha256 e15639d891f9") == true)
        #expect(j.backend.unexpected.isEmpty)
    }

    @Test("Choose, wear the chosen outfit, undo it, set a brief and swap a top: each step is the backend's own receipt and state")
    func chooseWearUndoBriefSwap() async throws {
        let j = try Journey("owner-morning")
        let center = j.environment.center
        let today = TodayModel(environment: j.environment)
        await today.open()

        // The board from the real composer; weather and Calendar were unavailable and it says so.
        let board = try #require(today.board)
        #expect(today.options.count == board.options.count && today.options.count >= 3)
        #expect(board.validity == .limited)
        #expect(board.notice?.isEmpty == false)
        #expect(today.options.allSatisfy { $0.accessibilityLabel.contains($0.visibleGarments[0].name) })

        // Choose records an intention: the board has a selection and the day has no record.
        let second = today.options[1]
        let chosen = await today.choose(optionId: second.id)
        #expect(chosen?.receipt?.type == "board.select")
        #expect(today.board?.selection?.optionId == second.id)
        #expect(!today.hasDayRecord)

        // I wore this: the day's record is exactly the visible outfit, with one shoe.
        let worn = await today.woreThis(optionId: second.id)
        let wearReceipt = try #require(worn?.receipt)
        #expect(wearReceipt.outcome == .committed)
        #expect(Set(today.dayRecord.map(\.garmentId)) == Set(second.wearGarmentIds))
        #expect(today.dayRecord.filter { $0.role == .footwear }.count == 1)
        #expect(today.board?.validity == .worn)
        let banner = try #require(center.banner)
        #expect(banner.record.id == wearReceipt.commandId)

        // The worn top now has one recorded wear on its item page, with the receipt in its history.
        let top = try #require(second.visibleGarments.first)
        let item = ItemModel(environment: j.environment, garmentId: top.garmentId)
        await item.open()
        #expect(item.detail?.recordedWearCount == 1)
        #expect(item.history.contains { $0.id == wearReceipt.commandId })

        // Undo is a compensating command; the day's record is withdrawn and both receipts remain.
        let undo = await center.undo(banner.record)
        #expect(undo.receipt?.type == "command.undo")
        await today.refresh()
        #expect(!today.hasDayRecord)
        #expect(center.receipts.contains { $0.id == wearReceipt.commandId && $0.undoneBy == undo.receipt?.commandId })
        await item.refresh()
        #expect(item.detail?.recordedWearCount == 0)
        #expect(item.wearLine?.contains("Not a sign it is unworn") == true)

        // A one-day brief, then a swap of one slot: only that option's top changes.
        let brief = await today.setBrief("Something a little sharper today")
        #expect(brief?.receipt?.type == "style.set_brief")
        let before = try #require(today.options.first)
        let swapped = await today.swap(optionId: before.id, role: .top)
        #expect(swapped?.receipt?.type == "board.swap_slot")
        let after = try #require(today.options.first)
        #expect(after.id == before.id) // the option keeps its durable identity
        #expect(after.visibleGarments.first { $0.role == .top }?.garmentId != before.visibleGarments.first { $0.role == .top }?.garmentId)
        #expect(after.visibleGarments.filter { $0.role != .top } == before.visibleGarments.filter { $0.role != .top })
        #expect((today.board?.revision ?? 0) > board.revision) // a swap publishes a later revision; how many is the backend's business

        #expect(j.backend.isAtEnd)
        #expect(j.backend.unexpected.isEmpty, "requests the real backend never answered: \(j.backend.unexpected)")
    }

    @Test("Offline at the wardrobe: the wear waits on the phone across a relaunch and is recorded once when the connection returns")
    func offlineWearSurvivesRelaunch() async throws {
        let j = try Journey("owner-morning")
        let today = TodayModel(environment: j.environment)
        await today.open()
        let second = today.options[1]
        await today.choose(optionId: second.id)

        j.backend.offline = true
        let outcome = await today.woreThis(optionId: second.id)
        #expect(outcome == .queued)
        #expect(!today.hasDayRecord)                                   // nothing is shown as recorded
        #expect(today.freshnessLine.hasPrefix("Offline. Board last checked"))
        #expect(today.options.count >= 3)                              // the cached board stays usable

        // The app is closed and opened again, still offline: the board comes from the cache and the wear is still queued.
        j.time.advance(1800)
        let second_launch = j.relaunch()
        await second_launch.center.restore()
        let relaunched = TodayModel(environment: second_launch)
        await relaunched.open()
        #expect(relaunched.today.origin == .cache)
        #expect(relaunched.options.count >= 3)
        #expect(second_launch.center.pending.map(\.envelope.type) == ["wear.record"])

        // Back online: the queued command is sent once, with the time of the tap, and the day's record appears.
        j.backend.offline = false
        let results = await second_launch.center.replay()
        #expect(results.values.compactMap(\.receipt).map(\.type) == ["wear.record"])
        // Sending the same command again returns the stored receipt instead of recording twice.
        let commands = j.backend.log.filter { $0.path == "/v1/commands" }
        let resent = try await j.backend.send(try #require(commands.last))
        #expect(try GarderobeJSON.decode(CommandReceipt.self, from: resent.body).replayed)
        await relaunched.refresh()
        #expect(relaunched.hasDayRecord)
        #expect(relaunched.today.origin == .live)
        #expect(second_launch.center.pending.isEmpty)
        #expect(j.backend.unexpected.isEmpty, "\(j.backend.unexpected)")
    }

    @Test("In demo mode an action outside the recording is refused in plain words and nothing is shown as recorded")
    func demoRefusesUnrecordedChanges() async throws {
        let cassette = try Cassette.bundled("owner-morning")
        let environment = AppEnvironment(transport: FixtureBackend(cassette: cassette, mode: .demo), tokens: StaticAccessToken("demo"), store: InMemoryKeyValueStore(),
                                         time: ManualTimeSource(instant: cassette.clock), ids: SequentialIdentifierSource(), isDemo: true, timeZone: TimeZone(identifier: cassette.timezone)!)
        let laundry = LaundryModel(environment: environment)
        await laundry.open()
        let outcome = await laundry.collected()
        guard case .rejected(let error) = outcome else { Issue.record("expected a refusal, got \(outcome)"); return }
        #expect(error.message == "Demo data cannot be changed: this action is not part of the recording.")
        #expect(environment.center.receipts.isEmpty)
        #expect(environment.isDemo)
    }
}
