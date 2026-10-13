import Foundation
import GarderobeKit

// Prints, as one JSON document, the request bodies the app sends, produced by the app's own code
// paths: the feature models are loaded with real state from the recordings of the real Worker and
// then driven with the network off, so every command stays in the offline queue exactly as it
// would be sent, and every other request is captured at the transport.
// `ios/Tools/contract-check/validate.mjs` parses each one with the real zod schemas of
// @garderobe/contracts.
//
//   swift run garderobe-contract-dump > requests.json

/// Records what is sent and fails the exchange, so nothing depends on an answer.
final class CapturingTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [HTTPRequest] = []
    var requests: [HTTPRequest] { lock.withLock { _requests } }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { _requests.append(request) }
        throw TransportFailure("contract dump: nothing is sent")
    }
    func stream(_ request: HTTPRequest) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish(throwing: TransportFailure("contract dump")) }
    }
}

struct Sample: Encodable {
    var source: String
    var method: String
    var path: String
    var query: [String: String]
    var body: JSONValue?
}

func samples(from requests: [HTTPRequest]) -> [Sample] {
    requests.compactMap { request in
        let parts = request.path.split(separator: "?", maxSplits: 1).map(String.init)
        var query: [String: String] = [:]
        for item in request.query { query[item.name] = item.value ?? "" }
        let body = request.body.flatMap { try? GarderobeJSON.decode(JSONValue.self, from: $0) }
        if request.method != "GET" && body == nil { return nil } // binary uploads have no JSON schema
        return Sample(source: "request", method: request.method, path: parts[0], query: query, body: body)
    }
}

@MainActor
func collect() async throws -> [Sample] {
    let cassette = try Cassette.bundled("owner-morning")
    let studioCassette = try Cassette.bundled("owner-studio")
    let zone = TimeZone(identifier: cassette.timezone)!
    let capture = CapturingTransport()

    func recorded(_ cassette: Cassette, store: KeyValueStore) -> AppEnvironment {
        AppEnvironment(transport: FixtureBackend(cassette: cassette, mode: .demo), tokens: StaticAccessToken("dump"), store: store,
                       time: ManualTimeSource(instant: cassette.clock), ids: SequentialIdentifierSource(), timeZone: zone)
    }
    func offline(_ cassette: Cassette, store: KeyValueStore, seed: String) -> AppEnvironment {
        AppEnvironment(transport: capture, tokens: StaticAccessToken("dump"), store: store,
                       time: ManualTimeSource(instant: cassette.clock), ids: SequentialIdentifierSource(seed: seed), timeZone: zone)
    }

    // 1. Real state from the recordings, cached into stores the offline environments reuse.
    let store = InMemoryKeyValueStore()
    let seeded = recorded(cassette, store: store)
    await TodayModel(environment: seeded).open()
    await WardrobeModel(environment: seeded).open()
    let seededSettings = SettingsModel(environment: seeded)
    await seededSettings.refreshSettings()
    await seededSettings.style.refresh()
    let studioStore = InMemoryKeyValueStore()
    await StudioModel(environment: recorded(studioCassette, store: studioStore)).open()

    // 2. The same models with the network off.
    let env = offline(cassette, store: store, seed: "dump")
    let t = TodayModel(environment: env); t.today.loadCached()
    let w = WardrobeModel(environment: env); w.snapshot.loadCached()
    let s = SettingsModel(environment: env); s.settings.loadCached(); s.style.loadCached()
    guard let board = t.board, let items = w.snapshot.value?.items, let first = t.options.first else { throw CocoaError(.fileReadCorruptFile) }

    await t.choose(optionId: first.id)
    await t.swap(optionId: first.id, role: .top)
    await t.swap(optionId: first.id, role: .footwear, to: first.visibleGarments.first { $0.role == .footwear }?.garmentId)
    await t.woreThis(optionId: first.id)
    await t.wore(garments: [(items[0].id, items[0].garment.name)])
    await t.amend(remove: [items[0].id], add: [items[1].id], reason: "Changed after lunch")
    await t.setBrief("Something a little sharper today")
    await t.requestAnother(brief: "Dinner out", count: 2)
    _ = try? await env.api.recommend(RecommendRequest(clientRequestId: env.ids.next("compose"), date: env.today, mode: .board))
    _ = try? await env.api.swap(boardId: board.boardId, SwapSlotRequest(clientRequestId: env.ids.next("swap"), optionId: first.id, role: .top, garmentId: nil, expectedRevision: board.revision))
    await env.center.submit(CommandDraft(CommandStyleRetireBrief(briefId: "brf_example"), label: "Cleared today's brief"))

    func pick(_ predicate: (InventoryItem) -> Bool) -> InventoryItem { items.first(where: predicate) ?? items[0] }
    let shirt = pick { $0.garment.category == .shirt }
    let socks = pick { $0.garment.category == .socks && $0.totalOwnedUnits > 1 }
    for garment in [shirt, socks] {
        let model = ItemModel(environment: env, garmentId: garment.id)
        let detail = GarmentDetail(garment: garment.garment, aliases: [], facts: [], balances: garment.balances, totalOwnedUnits: garment.totalOwnedUnits, restrictions: [],
                                   recordedWearCount: 0, lastRecordedWear: nil, wearCountCaveat: "", recentWears: [], movements: [])
        model.item.accept(ItemResponse(detail: detail, availability: garment.availability, media: nil, mediaAvailable: true, knownCombinations: [], readAt: cassette.clock))
        for action in ItemAction.allCases { await model.perform(action, quantity: garment.totalOwnedUnits > 1 ? 2 : nil) }
        await model.woreIt()
        await model.recordFeedback(text: "Too warm on the train", kind: .tooWarm, wearingDate: env.today)
        await model.retractFeedback("cfb_example")
    }
    let reconcile = ReconcileModel(environment: env, item: socks)
    reconcile.counts.clean = max(0, reconcile.counts.clean - 1)
    reconcile.counts.total += 1
    await reconcile.save(note: "Counted the drawer")

    let laundry = LaundryModel(environment: env)
    await laundry.collected()
    await laundry.collected(excluding: [shirt.id])
    laundry.state.accept(LaundryStateResponse(awaitingService: [], awaitingHandwash: [], batches: [
        .init(batchId: "lb_example", status: "collected", pickedUpAt: cassette.clock, returnedAt: nil, returnBasis: nil,
              items: [.init(garmentId: shirt.id, name: shirt.garment.name, quantity: 1, returnedQuantity: 0, stillAway: 0)]),
    ], exceptions: [], cycles: [], readAt: cassette.clock))
    laundry.beginReturn()
    laundry.setStillAway(garmentId: shirt.id, quantity: 1)
    await laundry.confirmReturn()
    await laundry.handwashDone()
    await laundry.handwashDone(items: [(socks.id, 2)])
    await laundry.reportCycleException(.delayed, note: "Bank holiday")
    await laundry.reportItemException(.stillAway, garmentId: shirt.id, name: shirt.garment.name)

    let studio = StudioModel(environment: offline(studioCassette, store: studioStore, seed: "studio"))
    await studio.open()
    studio.toggleLock(.top)
    await studio.validate()
    await studio.findSomethingThatWorks()
    await studio.loadComposition()
    await studio.saveCombination(name: "Sunday")
    await studio.planForDay(Dates.adding(days: 1, to: env.today))
    await studio.wearThis()
    await studio.removeCombination("cmb_example")
    await studio.removeDayPlan("pln_example")

    let trips = TripsModel(environment: env)
    var draft = trips.newDraft()
    draft.name = "Paris"; draft.destinationLabel = "Paris"; draft.destinationTimezone = "Europe/Paris"; draft.luggageLabel = "Carry-on only"; draft.luggageMaxPieces = 1
    draft.occasions = [("Dinner", draft.departsOn, true)]
    draft.laundryDates = [draft.returnsOn]
    await trips.create(draft)
    let trip = Trip(tripId: "trp_example", version: 1, name: "Paris", departsOn: draft.departsOn, returnsOn: draft.returnsOn,
                    destinations: [TripDestination(label: "Paris", timezone: "Europe/Paris", from: draft.departsOn, to: draft.returnsOn)],
                    occasions: [], luggage: nil, laundry: [], status: .planned, packed: [], proposal: nil)
    await trips.proposePacking(trip)
    await trips.packed(trip, items: [(shirt.id, 1), (socks.id, 2)])
    let picker = PackingPickerModel(environment: env, trips: trips, tripId: trip.tripId, candidates: items)
    picker.setQuantity(1, for: shirt.id)
    await picker.pack()
    await ProjectsModel(environment: env).open()
    _ = try? await env.api.proposals(ProposalsQuery(state: .all))
    _ = try? await env.api.decideProposal(id: "prp_example", ProposalDecisionRequest(decision: .confirm))
    _ = try? await env.api.decideProposal(id: "prp_example", ProposalDecisionRequest(decision: .reject))
    await env.center.undo(RunReceiptRef(commandId: "cmd_older_example", type: "care.mark_dirty", outcome: "committed", summary: "Marked for the wash", undoAvailable: true))
    _ = try? await env.api.asset(id: "ast_example", width: 320)
    await trips.unpacked(trip)
    await trips.wore(trip, day: PackingDayPlan(localDate: draft.departsOn, segment: .evening, occasion: "Dinner", slots: [OutfitSlot(role: .top, garmentId: shirt.id)], reason: ""))
    await trips.cancel(trip)
    await ReturnsModel(environment: env).open(kind: .exchange, garmentId: shirt.id, garmentName: shirt.garment.name, reason: "Wrong size")

    await s.setMorningTime("07:15")
    await s.setOptionCount(4)
    await s.setHomeLocation(label: "London", latitude: 51.5, longitude: -0.12)
    await s.setTimezone("Europe/London")
    await s.setWeeklyLaundryReset(enabled: false)
    await s.setCalendarPresentation(allDay: true)
    await s.setCalendarReminder(minutesBefore: nil)
    await s.setReadCalendars(["primary"])
    await s.saveProfile(content: (s.style.value?.document.content ?? "") + "\n")
    let exampleFact = StyleFactConflict(conflictId: "sfc_example", documentId: "owner-profile", fromVersion: 1, toVersion: 2, fact: StyleFactRef(kind: .measurement, id: "msr_example"),
                                        label: "body chest: 44 in", reason: .passageChanged, previousPassages: [], missingQuotes: ["44 in"], candidateText: "45 in", status: .open, createdAt: cassette.clock)
    await s.resolve(exampleFact, .keep)
    await s.resolve(exampleFact, .replaceMeasurement(value: 45, unit: .in), quoteNewWording: true)
    var sizeFact = exampleFact; sizeFact.fact = StyleFactRef(kind: .sizeExperience, id: "sze_example")
    await s.resolve(sizeFact, .replaceSize(label: "L"))
    await s.resolve(sizeFact, .retire)
    let bulk = BulkEditModel(environment: env, candidates: items)
    bulk.toggle(shirt); bulk.toggle(socks)
    bulk.field = .colour; bulk.text = "Navy"
    await bulk.submit()
    bulk.clearsValue = true; bulk.field = .pattern
    await bulk.submit()
    bulk.field = .careChannel; bulk.careChannel = .handwash
    await bulk.submit()
    bulk.scope = .category; bulk.category = .socks
    await bulk.loadMatches()
    bulk.scope = .search; bulk.searchText = "oxford shirt"
    await bulk.loadMatches()
    await s.previewSave(content: (s.style.value?.document.content ?? "") + "\nA new line.")
    _ = try? await env.api.styleConflicts(StyleConflictsQuery(status: .all))
    _ = try? await env.api.resumeRun(id: "run_example")
    await s.addDirection("Stop making navy the default swap")
    await s.retireDirection("dir_example")
    await s.pause(resumeOn: draft.returnsOn)
    await s.pause(resumeOn: nil)
    await s.resume()
    await s.connectGoogle()
    await env.center.submit(CommandDraft(CommandCommandUndo(commandId: "cmd_example"), label: "Undo"))

    let composer = ComposerModel(environment: env, transcript: TranscriptModel(environment: env), sleep: { _ in })
    composer.attach(AttachedRef(kind: .boardOption, id: first.id, boardId: board.boardId, revision: board.revision), label: first.option.name)
    composer.attach(AttachedRef(kind: .garment, id: shirt.id), label: shirt.garment.name)
    composer.draft = "Does this work for a client lunch?"
    await composer.send()
    let captureModel = CaptureModel(environment: env, composer: composer)
    for intent in CaptureIntent.allCases {
        captureModel.intent = intent
        await captureModel.addPhoto(data: Data([0x89, 0x50, 0x4e, 0x47]), contentType: .imagePng)
        captureModel.uploads.removeAll()
        captureModel.note = "The blue one"
        await captureModel.submit()
    }
    let inbox = ShareInbox(store: InMemoryKeyValueStore())
    try inbox.add(url: "https://shop.example/products/chore-coat", pageTitle: "Chore coat", note: nil, id: "turn-share-000001", now: env.time.now())
    _ = await inbox.drain(using: env.api)
    let recall = RecallModel(environment: env)
    recall.query = "flannel shirt"; recall.from = "2025-07-01"; recall.to = "2025-07-31"
    await recall.search()
    await ExportModel(environment: env).start(passphrase: "correct horse battery staple")
    let account = AccountModel(environment: env, session: nil)
    await account.claim(invitationCode: "INVITE-0000-0000-0000")
    await account.completeIdentityLink(linkCode: "GRDL-0000-0000-0000-0000")
    await account.unlink(identityId: "idn_example")

    let api = env.api
    _ = try? await api.research(StartResearchRequest(clientRequestId: env.ids.next("research"), topic: "Is the 42 the right size in this jacket?", kind: .product, url: "https://shop.example/jacket"))
    _ = try? await api.completeRecovery(RecoveryCompleteRequest(transactionId: "rtx_example", recoveryCode: "GRD1-0000-0000-0000-0000", unlinkPreviousIdentities: true))
    _ = try? await api.deleteAccount(confirmationToken: nil)
    _ = try? await api.answerRun(id: "run_example", RunInputRequest(inputId: "inp_example", choiceId: "a"))
    _ = try? await api.setCapabilities(connectionId: "con_example", ConnectionCapabilitiesRequest(enabled: ["calendar.read"], expectedVersion: 1))
    _ = try? await api.ensureOutfitCalendar(connectionId: "con_example", OutfitCalendarRequest(clientRequestId: env.ids.next("calendar")))
    _ = try? await api.reconnect(connectionId: "con_example")
    _ = try? await api.wardrobe(InventoryQuery(search: "wide stripe", category: "shirt", availability: .available, colour: "Navy", location: .home, includeDisposed: true, limit: 50, forDate: env.today))
    _ = try? await api.temperaturePreview(temperatureC: 12)
    _ = try? await api.messages(before: "cursor", limit: 40)
    _ = try? await api.receipts(entity: "garment:\(shirt.id)", limit: 50)
    _ = try? await api.today(date: env.today)
    _ = try? await api.studio(mode: .explore, date: env.today)
    _ = try? await api.itemImage(garmentId: shirt.id, width: 320)
    _ = try? await api.weather(date: env.today)
    _ = try? await api.availability(date: env.today)
    _ = try? await api.resolve(phrase: "dark jeans")
    // Notifications, the rendered Studio preview, signed image delivery, and a photo turn with its role.
    // Nothing here is answered (the transport records and fails), so the identifiers are examples:
    // only the encoded request is checked against the schemas. The turn deliberately carries a role
    // for `ast_absent`, which is not attached: `PendingTurn.request` sends roles for attached
    // assets only (MediaTests checks that).
    _ = try? await api.devices()
    _ = try? await api.registerDevice(DeviceRegistration(deviceId: env.ids.next("device"), token: String(repeating: "ab", count: 32), environment: .production))
    _ = try? await api.removeDevice(id: "device-example-000001")
    _ = try? await api.requestStudioPreview(StudioPreviewRequest(clientRequestId: env.ids.next("preview"), slots: [StudioSlotInput(role: .top, garmentId: shirt.id, locked: false)]))
    _ = try? await api.composition(manifestHash: String(repeating: "a", count: 64))
    _ = try? await api.signRendition(id: "rnd_example", SignRenditionRequest(width: 1280, ttlSeconds: GarmentImageLoader.signedLifetime))
    _ = try? await api.submitTurn(PendingTurn(clientTurnId: env.ids.next("turn"), text: "What I wore", attachmentIds: ["ast_example"], imageRoles: ["ast_example": .selfie, "ast_absent": .receipt],
                                              attachedRefs: [], intent: .whatIWore, sharedUrl: nil, createdAt: env.time.now(), state: .waitingToSend, turnId: nil, runId: nil).request)

    // Commands still in the offline queues are the exact envelopes the app would send.
    var queued: [Sample] = []
    for (name, queueStore) in [("main", store as KeyValueStore), ("studio", studioStore as KeyValueStore)] {
        for entry in await CommandQueue(store: queueStore).all() {
            queued.append(Sample(source: "queued (\(name)): \(entry.label)", method: "POST", path: "/v1/commands", query: [:], body: try? JSONValue.from(entry.envelope)))
        }
    }
    return samples(from: capture.requests) + queued
}

let done = DispatchSemaphore(value: 0)
Task { @MainActor in
    do {
        let data = try GarderobeJSON.encoder(pretty: true).encode(try await collect())
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("contract dump failed: \(error)\n".utf8))
        exit(1)
    }
    done.signal()
}
while done.wait(timeout: .now()) == .timedOut { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
