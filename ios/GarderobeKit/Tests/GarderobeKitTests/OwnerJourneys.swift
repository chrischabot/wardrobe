import Testing
import Foundation
@testable import GarderobeKit

@MainActor
@Suite("Journey: care, laundry, counts, storage, feedback and a return on the real wardrobe")
struct OwnerCareJourney {
    @Test("In the wash, Collected, Returned with one item still away, Socks washed, a count correction, storage, feedback and a return")
    func careAndLaundry() async throws {
        let j = try Journey("owner-care")
        let env = j.environment
        let wardrobe = WardrobeModel(environment: env)
        let laundry = LaundryModel(environment: env)
        let returns = ReturnsModel(environment: env)
        await wardrobe.open()
        await laundry.open()
        await returns.open()

        // The same picks the recording made, from the wardrobe's own order.
        let items = try #require(wardrobe.snapshot.value?.items)
        let shirts = Array(items.filter { $0.garment.category == .shirt && $0.garment.careChannel == .service && $0.availability?.hardExcluded == false }.prefix(2))
        let socks = try #require(items.first { $0.garment.category == .socks && $0.garment.careChannel == .handwash && $0.totalOwnedUnits >= 3 })
        let coat = try #require(items.first { $0.garment.category == .outerwear && $0.availability?.hardExcluded == false })
        let shoes = try #require(items.first { $0.garment.category == .footwear && $0.availability?.hardExcluded == false })
        try #require(shirts.count == 2)

        // Search by the owner's name for a shirt is answered by the backend.
        wardrobe.filters.search = shirts[0].aliases.first ?? shirts[0].garment.name
        await wardrobe.applyFilters()
        #expect(!wardrobe.isSearchingSavedCopy)
        #expect(wardrobe.items.map(\.id) == [shirts[0].id])
        wardrobe.filters = WardrobeFilters()

        // In the wash: a direct command; the item is no longer offerable and waits for collection.
        let shirtA = ItemModel(environment: env, garmentId: shirts[0].id)
        await shirtA.open()
        #expect(shirtA.availableActions.contains(.inTheWash))
        #expect(!shirtA.availableActions.contains(.backFromTailor))
        let washed = await shirtA.perform(.inTheWash)
        #expect(washed?.receipt?.summary.contains(shirts[0].garment.name) == true)
        #expect(shirtA.statusLine == "In the wash")
        #expect(shirtA.availability?.hardExcluded == true)
        #expect(shirtA.history.first?.id == washed?.receipt?.commandId) // the receipt is in the item's history
        let shirtB = ItemModel(environment: env, garmentId: shirts[1].id)
        await shirtB.open()
        await shirtB.perform(.inTheWash)
        await laundry.state.refresh()
        #expect(Set(laundry.awaitingService.map(\.garmentId)) == Set(shirts.map(\.id)))
        #expect(laundry.awaitingHandwash.isEmpty)

        // Collected: the batch is exactly what was waiting.
        let collected = await laundry.collected()
        #expect(collected.receipt?.type == "laundry.collect")
        #expect(laundry.awaitingService.isEmpty)
        let batch = try #require(laundry.outstandingBatches.first)
        #expect(Set(batch.items.map(\.garmentId)) == Set(shirts.map(\.id)))

        // Returned, one item still away: the return view starts from the batch membership.
        laundry.beginReturn()
        let draft = try #require(laundry.returnDraft)
        #expect(draft.lines.map(\.garmentId) == batch.items.map(\.garmentId))
        #expect(!draft.hasExceptions)
        laundry.setStillAway(garmentId: shirts[1].id, quantity: 5) // clamped to what went out
        #expect(laundry.returnDraft?.lines.first { $0.garmentId == shirts[1].id }?.stillAway == 1)
        let returned = await laundry.confirmReturn()
        #expect(returned?.receipt?.summary.contains("still away") == true)
        #expect(returned?.receipt?.undo.available == false)
        #expect(env.center.banner?.record.id != returned?.receipt?.commandId) // no undo banner for an irreversible receipt
        await shirtA.refresh()
        await shirtB.refresh()
        #expect(shirtA.availability?.hardExcluded == false)
        #expect(shirtB.statusLine == "Still away at the laundry")
        #expect(laundry.state.value?.exceptions.count == 1)

        // Socks: one entry with a quantity. Two pairs to the wash, then Socks washed clears the hand-wash pool.
        let sockModel = ItemModel(environment: env, garmentId: socks.id)
        await sockModel.open()
        #expect(sockModel.maximumQuantity(for: .inTheWash) == socks.quantity(in: .clean))
        await sockModel.perform(.inTheWash, quantity: 2)
        #expect(sockModel.quantityLine?.contains("2 in the wash") == true)
        await laundry.state.refresh()
        #expect(laundry.awaitingHandwash.map(\.quantity) == [2])
        #expect(laundry.awaitingService.isEmpty) // hand-wash and service are separate
        let socksWashed = await laundry.handwashDone()
        #expect(socksWashed.receipt?.type == "care.washed")
        #expect(laundry.awaitingHandwash.isEmpty)
        await sockModel.refresh()

        // An optional count correction: the owner's word is taken.
        await wardrobe.refresh()
        let currentSocks = try #require(wardrobe.snapshot.value?.items.first { $0.id == socks.id })
        let reconcile = ReconcileModel(environment: env, item: currentSocks)
        #expect(!reconcile.hasChanges)
        reconcile.counts.clean -= 1
        let corrected = await reconcile.save()
        #expect(corrected?.receipt?.type == "stock.reconcile")
        await sockModel.refresh()
        #expect(sockModel.detail?.quantity(in: .clean) == currentSocks.quantity(in: .clean) - 1)

        // Put into storage and take out again.
        let coatModel = ItemModel(environment: env, garmentId: coat.id)
        await coatModel.open()
        await coatModel.perform(.putIntoStorage)
        #expect(coatModel.statusLine == "In storage")
        #expect(coatModel.availableActions.contains(.takeOutOfStorage))
        await coatModel.perform(.takeOutOfStorage)
        #expect(coatModel.availability?.hardExcluded == false)

        // Optional comfort feedback from the item, then a return: no deadline is invented.
        let shoeModel = ItemModel(environment: env, garmentId: shoes.id)
        await shoeModel.open()
        let feedback = await shoeModel.recordFeedback(text: "These rub after an hour", kind: .pain)
        #expect(feedback?.receipt?.type == "feedback.record")
        #expect(shoeModel.feedback.value?.feedback.map(\.text) == ["These rub after an hour"])
        let opened = await returns.open(kind: .return, garmentId: shoes.id, garmentName: shoes.garment.name)
        #expect(opened.receipt?.type == "return.open_case")
        let returnCase = try #require(returns.openCases.first)
        #expect(returns.deadlineLine(returnCase).hasPrefix("Deadline not established."))
        #expect(returns.stockLine(returnCase) == "The item is still in your wardrobe until it physically leaves.")
        #expect(returns.cases(forGarment: shoes.id).count == 1)

        #expect(j.backend.isAtEnd)
        #expect(j.backend.unexpected.isEmpty, "requests the real backend never answered: \(j.backend.unexpected)")
    }
}

@MainActor
@Suite("Journey: Studio, a trip, pause and resume, settings and style on the real wardrobe")
struct OwnerStudioJourney {
    @Test("Browsing sends no command; validate and suggest are reads; Save, Plan and Wear are three different commands")
    func studioTripPauseSettings() async throws {
        let j = try Journey("owner-studio")
        let env = j.environment
        let commandCount = { j.backend.log.filter { $0.path == "/v1/commands" }.count }

        let studio = StudioModel(environment: env)
        await studio.open()
        #expect(studio.slots.count >= 3)
        #expect(studio.visibleSelectors.allSatisfy { $0.primary })
        #expect(studio.slots.allSatisfy { $0.item.marker == .owned && $0.item.eligibleToday }) // For today offers eligible owned items only

        // Browsing: stepping a selector is local and immediate, and marks the old verdict as stale.
        await studio.validate()
        guard case .checked = studio.validation else { Issue.record("expected a verdict, got \(studio.validation)"); return }
        let requestsBefore = j.backend.log.count
        let topBefore = try #require(studio.slots.first { $0.role == .top }?.item.garmentId)
        studio.step(.top, by: 1)
        #expect(studio.slots.first { $0.role == .top }?.item.garmentId != topBefore)
        #expect(studio.validation == .unchecked("Not checked yet."))
        studio.step(.top, by: -1)
        #expect(studio.slots.first { $0.role == .top }?.item.garmentId == topBefore)
        #expect(j.backend.log.count == requestsBefore) // no request, no command, nothing planned or logged
        await studio.loadComposition()
        #expect(studio.composition?.manifest.layers.isEmpty == false)

        // Lock the top and ask the backend for something that works with it.
        studio.toggleLock(.top)
        await studio.findSomethingThatWorks()
        let suggestion = try #require(studio.suggestions.first)
        studio.apply(suggestion)
        #expect(studio.slots.first { $0.role == .top }?.item.garmentId == topBefore) // the locked piece stays
        #expect(studio.isLocked(.top))
        await studio.loadComposition()
        #expect(commandCount() == 0)

        // Three actions, three different commands.
        let saved = await studio.saveCombination(name: "Fixture combination")
        #expect(saved?.receipt?.type == "studio.save_combination")
        #expect(studio.combinations.map(\.name) == ["Fixture combination"])
        let planned = await studio.planForDay(Dates.adding(days: 1, to: env.today))
        #expect(planned?.receipt?.type == "studio.plan_for_day")
        #expect(studio.dayPlans.count == 1)

        // Locks and the canvas survive a relaunch.
        let restored = StudioModel(environment: j.relaunch())
        await restored.open()
        #expect(restored.isLocked(.top))
        #expect(restored.slots.map(\.item.garmentId) == studio.slots.map(\.item.garmentId))

        #expect(studio.canWearThis)
        let worn = await studio.wearThis()
        #expect(worn?.receipt?.type == "wear.record")
        let today = TodayModel(environment: env)
        await today.refresh()
        #expect(Set(today.dayRecord.map(\.garmentId)) == Set(studio.slots.compactMap(\.item.garmentId)))

        // A trip: proposed and packed are kept apart; unpacking is its own statement.
        let trips = TripsModel(environment: env)
        await trips.open()
        var draft = trips.newDraft()
        #expect(draft.problem != nil)
        draft.name = "Paris"; draft.destinationLabel = "Paris"; draft.destinationTimezone = "Europe/Paris"; draft.luggageLabel = "Carry-on only"
        #expect(draft.problem == nil)
        let created = await trips.create(draft)
        #expect(created?.receipt?.type == "trip.create")
        var trip = try #require(trips.activeTrips.first)
        #expect(trip.proposal == nil && trips.packedLine(trip) == "Nothing packed yet.")
        await trips.proposePacking(trip)
        trip = try #require(trips.trip(trip.tripId))
        #expect(trip.proposal?.items.isEmpty == false)
        #expect(trips.packedLine(trip) == "Nothing packed yet. The list below is a proposal.") // a proposal packs nothing
        let packed = await trips.packedProposal(trip)
        #expect(packed?.receipt?.type == "stock.pack")
        trip = try #require(trips.trip(trip.tripId))
        #expect(trips.packingRows(trip).allSatisfy { $0.packed == $0.item.quantity })
        let unpacked = await trips.unpacked(trip)
        #expect(unpacked.receipt?.type == "stock.unpack")
        let afterUnpack = try #require(trips.trip(trip.tripId))
        #expect(afterUnpack.packed.reduce(0) { $0 + $1.clean + $1.worn } == 0)

        // Pause with a resume date, then resume: Today explains itself in between.
        let settings = SettingsModel(environment: env)
        await settings.refreshSettings()
        #expect(settings.pauseLine == "Recommendations are on.")
        let paused = await settings.pause(resumeOn: draft.returnsOn)
        #expect(paused.receipt?.type == "service.pause")
        #expect(settings.pauseLine.hasPrefix("Paused. Resumes on "))
        #expect(settings.pauseLine.hasSuffix("Return deadline reminders stay on."))
        await today.refresh()
        let resumed = await settings.resume()
        #expect(resumed.receipt?.type == "service.resume")
        #expect(settings.service?.paused == false)
        await today.refresh()

        // A versioned settings change and a standing direction.
        let four = await settings.setOptionCount(4)
        #expect(four?.receipt?.type == "settings.update")
        #expect(settings.owner?.delivery.defaultOptionCount == 4)
        let tooMany = await settings.setOptionCount(6)
        #expect(tooMany == nil) // only three, four or five
        let direction = await settings.addDirection("Stop making navy the default swap")
        #expect(direction?.receipt?.type == "style.add_direction")
        #expect(settings.activeDirections.map(\.text) == ["Stop making navy the default swap"])

        #expect(j.backend.isAtEnd)
        #expect(j.backend.unexpected.isEmpty, "requests the real backend never answered: \(j.backend.unexpected)")
    }
}

@MainActor
@Suite("Journey: the continuous conversation against the real Worker's turns, runs and event stream")
struct OwnerConversationJourney {
    @Test("A turn is accepted once, followed through its event stream and settles into the canonical transcript; Ask about this attaches the item")
    func turnsAndAttachedIdentity() async throws {
        let j = try Journey("owner-conversation")
        let env = j.environment
        let wardrobe = WardrobeModel(environment: env)
        await wardrobe.open()
        let transcript = TranscriptModel(environment: env)
        await transcript.loadLatest()
        #expect(transcript.rows.isEmpty)
        let composer = ComposerModel(environment: env, transcript: transcript, sleep: { _ in })
        #expect(!composer.canSend)

        composer.draft = "What goes with the chore coat when it is mild?"
        await composer.send()
        #expect(composer.draft.isEmpty)
        #expect(composer.pending.isEmpty)
        #expect(composer.follower?.phase == .completed)
        let afterFirst = transcript.entries
        #expect(afterFirst.map(\.role) == [.user, .assistant])                  // one of each: nothing duplicated by the stream
        #expect(afterFirst.allSatisfy { $0.delivery == .settled })
        #expect(afterFirst[1].text == composer.follower?.result?.reply?.text)
        #expect(afterFirst[1].id == composer.follower?.result?.reply?.messageId) // settled under the canonical message ID
        #expect(transcript.rows.first == .date(env.today))                      // a date separator leads the day

        // Ask about this: the garment's identity travels with the message.
        let coat = try #require(wardrobe.snapshot.value?.items.first { $0.garment.category == .outerwear })
        composer.attach(AttachedRef(kind: .garment, id: coat.id), label: coat.garment.name)
        #expect(composer.label(for: composer.attachedRefs[0]) == coat.garment.name)
        composer.draft = "Is this one warm enough for ten degrees?"
        await composer.send()
        #expect(composer.attachedRefs.isEmpty)
        #expect(transcript.entries.map(\.role) == [.user, .assistant, .user, .assistant])
        let turn = try #require(j.backend.log.last { $0.path == "/v1/conversation/turns" })
        let turnBody = try #require(turn.body)
        let sent = try GarderobeJSON.decode(JSONValue.self, from: turnBody)
        #expect(sent["attachedRefs"] == [["kind": "garment", "id": .string(coat.id)]])

        // Capture, What I wore: the photo is uploaded and finalized, and nothing else is sent until Submit.
        let capture = CaptureModel(environment: env, composer: composer)
        capture.intent = .whatIWore
        let encodedPhoto = try #require(j.cassette.steps.first { $0.id == "capture-bytes" }?.response?.body?["fixturePngBase64"]?.stringValue)
        let photo = try #require(Data(base64Encoded: encodedPhoto))
        let turnsBefore = j.backend.log.filter { $0.path == "/v1/conversation/turns" }.count
        await capture.addPhoto(data: photo, contentType: .imagePng)
        #expect(capture.uploads.items.first?.assetId != nil)
        #expect(j.backend.log.filter { $0.path == "/v1/conversation/turns" }.count == turnsBefore) // a photo alone sends no turn
        #expect(capture.canSubmit)
        await capture.submit()
        let captureBody = try #require(j.backend.log.last { $0.path == "/v1/conversation/turns" }?.body)
        let captureTurn = try GarderobeJSON.decode(JSONValue.self, from: captureBody)
        #expect(captureTurn["intent"]?.stringValue == "what_i_wore")
        #expect(captureTurn["attachmentIds"]?.arrayValue?.count == 1)
        #expect(composer.follower?.phase == .completed)
        #expect(j.backend.log.allSatisfy { $0.path != "/v1/commands" })              // capture never sends a wear command itself
        #expect(transcript.entries.count == 6)

        // A new launch opens the same transcript from the cache, with no new-chat step.
        j.backend.offline = true
        let reopened = TranscriptModel(environment: j.relaunch())
        await reopened.loadLatest()
        #expect(reopened.entries.count == 6)
        #expect(reopened.isOffline)
        j.backend.offline = false

        #expect(j.backend.isAtEnd)
        #expect(j.backend.unexpected.isEmpty, "requests the real backend never answered: \(j.backend.unexpected)")
    }
}

@MainActor
@Suite("Journey: recovery kit, link code, export and recovery from a new sign-in")
struct OwnerAccountJourney {
    @Test("A rotated kit is shown once; the export downloads and matches its checksum; the recovery code binds a new sign-in and is replaced")
    func kitExportRecovery() async throws {
        let j = try Journey("owner-account")
        let env = j.environment
        let account = AccountModel(environment: env, session: nil)

        await account.issueRecoveryKit()
        let kit = try #require(account.visibleKit)
        #expect(kit.recoveryCode.count > 16)
        #expect(account.me?.recoveryKit.present == true)
        // The kit is held in memory only: nothing the app persisted contains the code.
        let persisted = j.store.keys(prefix: "").compactMap { j.store.read($0) }.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(!persisted.contains(kit.recoveryCode))
        account.acknowledgeKit()
        #expect(account.visibleKit == nil)

        await account.startIdentityLink()
        #expect(account.linkTicket?.linkCode.isEmpty == false)

        // Export: complete only when every component is; the bytes are checked against the job's hash.
        let export = ExportModel(environment: env)
        #expect(export.statusLine == "No export has been started.")
        await export.start(passphrase: nil)
        await export.refresh()
        let job = try #require(export.job)
        #expect(job.complete == job.components.allSatisfy { $0.state == .complete })
        #expect(export.statusLine == "The export is complete.")
        #expect(export.canDownload)
        await export.fetchPackage()
        let download = try #require(export.download)
        #expect(download.verified)
        #expect(download.sha256 == job.sha256)
        #expect(download.data.count == job.byteLength)
        #expect(download.data.prefix(2) == Data("PK".utf8)) // a zip package

        // The owner arrives with a new sign-in and proves possession of the recovery code.
        await account.startRecovery()
        #expect(account.recoveryTransaction?.attemptsRemaining == 5)
        await account.completeRecovery(recoveryCode: kit.recoveryCode, unlinkPreviousIdentities: false)
        let result = try #require(account.recoveryResult)
        #expect(result.identityLinked)
        #expect(result.connectionsUnchanged)
        let replacement = try #require(account.visibleKit)
        #expect(replacement.recoveryCode != kit.recoveryCode) // the used code is replaced
        #expect(account.recoverySummary.contains("Your previous recovery code no longer works. Store the new one below."))
        #expect(account.me?.userId == result.userId)          // the same wardrobe, not a new account
        #expect(account.me?.identities.count == 2)

        #expect(j.backend.isAtEnd)
        #expect(j.backend.unexpected.isEmpty, "requests the real backend never answered: \(j.backend.unexpected)")
    }
}
