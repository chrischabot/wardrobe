import Foundation
import Testing
@testable import GarderobeKit

/// Signed image delivery, the rendered Studio preview and notification registration, replayed
/// from a recording of the real Worker (see the cassette's provenance: the photo is a labelled
/// test image, the notification token a labelled fixture value, and a local run has no Images
/// service, so the photo never becomes the garment's display image). The boundary suites
/// below use SYNTHETIC data.
@MainActor
@Suite("Journey: a photo read through a signed address, a rendered Studio preview, this phone registered for notifications")
struct OwnerMediaJourney {
    private func hexData(_ hex: String) -> Data {
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            data.append(UInt8(hex[index..<next], radix: 16) ?? 0)
            index = next
        }
        return data
    }

    @Test("The full-size photo is read without the sign-in; the preview is shown only once rendered; registering and removing this phone are the backend's answers")
    func signedPreviewAndDevice() async throws {
        let j = try Journey("owner-media")
        let env = j.environment
        func recorded(_ prefix: String) throws -> Data {
            let exchange = try #require(j.cassette.steps.flatMap { $0.reads }.first { $0.key.hasPrefix(prefix) && $0.value.bodyBase64 != nil }?.value)
            return try #require(exchange.bodyBase64.flatMap { Data(base64Encoded: $0) })
        }

        // A garment photo: uploaded and finalized. Nothing else is sent.
        let photoNote = try #require(j.cassette.steps.first { $0.id == "photo-bytes" }?.response?.body)
        let garmentId = try #require(photoNote["garmentId"]?.stringValue)
        let photo = try #require(photoNote["fixturePngBase64"]?.stringValue.flatMap { Data(base64Encoded: $0) })
        let uploads = UploadModel(environment: env)
        await uploads.add(data: photo, contentType: .imagePng, intent: .garmentPhoto, garmentId: garmentId)
        let assetId = try #require(uploads.items.first?.assetId)

        // The item page lists the stored photo. The loader asks for a signed address and reads it.
        let item = try await env.api.item(id: garmentId)
        let rendition = try #require(item.media?.assets.first { $0.assetId == assetId }?.renditions.first)
        #expect(item.media?.image.hasRealImage == false)     // no Images service locally: stated, not papered over
        let loader = GarmentImageLoader(environment: env)
        #expect(await loader.inspectionData(for: try #require(item.media?.image)) == nil)   // nothing is invented for a garment without a display image
        let full = try #require(await loader.signedData(renditionId: rendition.renditionId))
        #expect(full == (try recorded("GET /v1/media/signed/")))
        let sign = try #require(j.backend.log.first { $0.path == "/v1/media/renditions/\(rendition.renditionId)/sign" })
        #expect(TestSupport.body(sign) == ["width": 1280, "ttlSeconds": 60])
        #expect(sign.headers["Authorization"] == "Bearer fixture")
        let read = try #require(j.backend.log.first { $0.path.hasPrefix("/v1/media/signed/") })
        #expect(read.headers["Authorization"] == nil)        // the address is the whole authority
        #expect(!j.backend.log.contains { $0.method == "GET" && $0.path == "/v1/media/renditions/\(rendition.renditionId)" })
        let requests = j.backend.log.count
        #expect(await loader.signedData(renditionId: rendition.renditionId) == full)
        #expect(j.backend.log.count == requests)             // immutable bytes: read once, then from the phone

        // Studio: the opening outfit, its layout, then a rendered picture asked for and read.
        let studio = StudioModel(environment: env, sleep: { _ in })
        await studio.open()
        await studio.loadComposition()
        let layout = try #require(studio.composition)
        #expect(studio.preview == .none && studio.previewLine == nil)
        let missing = Set(layout.missingImages)
        #expect(!missing.isEmpty)
        #expect(studio.piecesWithoutPhoto == layout.manifest.layers.filter { $0.garmentId.map(missing.contains) ?? false }.map(\.name))
        let commandsBefore = j.backend.log.filter { $0.path == "/v1/commands" }.count
        await studio.requestPreview()
        let state = try #require(j.cassette.steps.first { $0.id == "preview-state" }?.response?.body?["state"]?.stringValue)
        if state == "rendered" {
            #expect(studio.preview == .rendered(try recorded("GET /v1/studio/compositions/")))
            #expect(studio.previewLine == "Picture made by the backend from these pieces.")
        } else {
            // The recording caught the job before it finished: no picture is shown as ready.
            #expect(studio.preview != .none)
            if case .rendered = studio.preview { Issue.record("a preview the backend had not rendered was shown") }
        }
        #expect(j.backend.log.filter { $0.path == "/v1/commands" }.count == commandsBefore) // nothing planned or logged
        // A different piece makes the picture stale at once.
        studio.step(.top, by: 1)
        #expect(studio.preview == .none && studio.composition == nil)

        // Notifications: nothing is sent until the owner turns them on and Apple gives a token.
        let device = try #require(j.cassette.steps.first { $0.id == "device" }?.response?.body)
        let deviceId = try #require(device["deviceId"]?.stringValue)
        let token = hexData(try #require(device["tokenHex"]?.stringValue))
        env.restoration.save("notifications.deviceId", deviceId)       // this installation's identifier, as the recording used it
        let notifications = NotificationsModel(environment: env)
        await notifications.open()
        #expect(notifications.deviceId == deviceId)
        #expect(notifications.statusLine == "This phone is not registered for notifications.")
        let early = await notifications.register(token: token, apns: .development)
        #expect(!early && !j.backend.log.contains { $0.method == "POST" && $0.path == "/v1/devices" })
        notifications.turnOn()
        notifications.setPermission(.authorized)
        #expect(notifications.shouldRequestToken)
        let registered = await notifications.register(token: token, apns: .development)
        #expect(registered && notifications.isRegistered && !notifications.isWaitingToSend)
        let list = try #require(notifications.devices.value)
        #expect(notifications.statusLine == (list.deliveryConfigured ? "This phone is registered. Nothing has been sent to it yet."
                                                                    : "This phone is registered, but the backend is not set up to send notifications yet."))
        let stored = try #require(j.store.read("cache.devices").map { String(decoding: $0, as: UTF8.self) })
        #expect(!stored.contains(try #require(device["tokenHex"]?.stringValue)))   // the token is never returned, so never kept

        let removed = await notifications.turnOff()
        #expect(removed && notifications.thisDevice == nil && !notifications.wanted)
        #expect(notifications.statusLine == "This phone is not registered for notifications.")

        #expect(j.backend.isAtEnd)
        #expect(j.backend.unexpected.isEmpty, "requests the real backend never answered: \(j.backend.unexpected)")
    }
}

/// A device as the backend lists it (SYNTHETIC).
private func syntheticDevice(_ id: String, status: String = "active", reason: JSONValue = .null, lastDelivery: JSONValue = .null) -> JSONValue {
    ["deviceId": .string(id), "environment": "production", "status": .string(status), "disabledReason": reason, "updatedAt": .string(Synthetic.now), "lastDeliveryAt": lastDelivery]
}

/// Counts calls from a main-actor callback (the platform hook a test stands in for).
private final class CallCounter: @unchecked Sendable {
    var value = 0
}

@MainActor
@Suite("Notifications, the Studio preview, signed delivery and photo roles: boundaries")
struct MediaBoundaryTests {
    private func device(_ id: String, status: String = "active", reason: JSONValue = .null, lastDelivery: JSONValue = .null) -> JSONValue {
        syntheticDevice(id, status: status, reason: reason, lastDelivery: lastDelivery)
    }

    @Test("Offline, a registration waits and is sent once with the same identifier after a relaunch; a refusal is shown and not repeated")
    func registrationOfflineAndRefused() async throws {
        let router = Router()
        let transport = router.transport
        let store = InMemoryKeyValueStore()
        router.json("GET", "/v1/devices", ["deliveryConfigured": true, "devices": []])
        router.on("POST", "/v1/devices") { request in TestSupport.json(syntheticDevice(TestSupport.body(request)["deviceId"]?.stringValue ?? "")) }
        router.offline.value = true
        let first = NotificationsModel(environment: TestSupport.environment(transport: transport, store: store))
        first.turnOn()
        let sent = await first.register(token: Data([0xab, 0xcd] + Array(repeating: UInt8(1), count: 30)), apns: .production)
        #expect(!sent && first.isWaitingToSend && !first.isRegistered)
        #expect(first.message == "Offline. This phone will be registered when there is a connection.")
        #expect(first.statusLine == "Waiting to register this phone when there is a connection.")

        // A new launch on the same phone: same identifier, the waiting registration is sent once.
        router.offline.value = false
        let listed = LockedFlag(false)
        let installation = first.deviceId
        router.on("GET", "/v1/devices") { _ in TestSupport.json(["deliveryConfigured": true, "devices": listed.value ? [syntheticDevice(installation, lastDelivery: "2026-09-15T06:00:00Z")] : []]) }
        let second = NotificationsModel(environment: TestSupport.environment(transport: transport, store: store))
        #expect(second.deviceId == first.deviceId && second.wanted && second.isWaitingToSend)
        listed.value = true
        let retried = await second.retryPending()
        #expect(retried && !second.isWaitingToSend && second.isRegistered)
        let posts = transport.requests("POST", "/v1/devices")
        #expect(posts.count == 2)   // the attempt that failed in transport while offline, then the one that arrived
        #expect(TestSupport.body(posts[0]) == TestSupport.body(posts[1]))      // the same registration, not a second one
        #expect(TestSupport.body(posts[1]) == ["deviceId": .string(first.deviceId), "token": .string("abcd" + String(repeating: "01", count: 30)), "environment": "production"])
        #expect(second.statusLine.hasPrefix("This phone is registered. Last notification sent "))
        let again = await second.retryPending()
        #expect(again && transport.requests("POST", "/v1/devices").count == 2)   // nothing left to send

        // The backend refuses a token: the reason is shown and the request is not kept for another try.
        router.on("POST", "/v1/devices") { _ in TestSupport.error("invalid_command", "That is not a notification token.", status: 400) }
        let refused = await second.register(token: Data([1, 2, 3]), apns: .production)
        #expect(!refused && second.message == "That is not a notification token." && !second.isWaitingToSend)

        // iOS refuses permission: said plainly, and no token is asked for.
        second.setPermission(.denied)
        #expect(!second.shouldRequestToken)
        second.registrationFailed("no valid aps-environment entitlement")
        #expect(second.message == "This phone could not get a notification address from Apple: no valid aps-environment entitlement")
    }

    @Test("Turning notifications off while offline is kept and sent later; a registration the backend stopped says why")
    func removalOfflineAndDisabled() async throws {
        let router = Router()
        let transport = router.transport
        let time = ManualTimeSource(instant: TestSupport.startInstant)
        let env = TestSupport.environment(transport: transport, time: time)
        let model = NotificationsModel(environment: env)
        router.json("GET", "/v1/devices", ["deliveryConfigured": true, "devices": [device(model.deviceId, status: "disabled", reason: "Apple reports the app was removed from this phone."), device("device-other-0001")]])
        router.json("POST", "/v1/devices/\(model.deviceId)/remove", ["removed": true])
        await model.open()
        #expect(!model.isRegistered)
        #expect(model.statusLine == "Notifications to this phone have stopped: Apple reports the app was removed from this phone.")
        #expect(model.otherDevices.map(\.deviceId) == ["device-other-0001"])

        router.offline.value = true
        let off = await model.turnOff()
        #expect(!off && model.isWaitingToSend)
        #expect(model.statusLine == "Waiting to stop notifications to this phone when there is a connection.")
        #expect(transport.requests("POST", "/v1/devices/\(model.deviceId)/remove").isEmpty == false) // attempted once, failed in transport
        router.offline.value = false
        let sent = await model.retryPending()
        #expect(sent && !model.isWaitingToSend)

        // A server fault or an expired sign-in decides nothing, so the request to stop stays waiting
        // and is sent again, not before its wait is over; a phone the backend does not hold is done.
        let path = "/v1/devices/\(model.deviceId)/remove"
        router.on("POST", path) { _ in TestSupport.error("internal", "Something went wrong on the server", status: 500) }
        let faulted = await model.turnOff()
        #expect(!faulted && model.isWaitingToSend)
        #expect(model.message == "Not stopped yet: Something went wrong on the server. It will be tried again later.")
        #expect(model.statusLine == "Waiting to stop notifications to this phone. It will be tried again later.")
        let sentSoFar = transport.requests("POST", path).count
        let tooSoon = await model.retryPending()
        #expect(!tooSoon && transport.requests("POST", path).count == sentSoFar)   // the next synchronisation does not hammer a failing server
        time.advance(NotificationsModel.retryDelay(afterAttempts: 1))
        router.on("POST", path) { _ in TestSupport.error("unauthenticated", "Sign in again.", status: 401) }
        let expired = await model.retryPending()
        #expect(!expired && model.isWaitingToSend && !model.hasStoppedRetrying)
        #expect(model.message == "Sign in to finish stopping notifications to this phone.")
        router.json("POST", path, ["removed": true])
        let delivered = await model.retryPending()
        #expect(delivered && !model.isWaitingToSend)
        router.on("POST", path) { _ in TestSupport.error("not_found", "That phone is not registered.", status: 404) }
        let gone = await model.turnOff()
        #expect(gone && !model.isWaitingToSend && model.message == nil)   // nothing to stop is not an error
        // Turning on again cancels nothing that was already sent and clears no other device.
        model.turnOn()
        #expect(model.wanted && !model.isWaitingToSend)
        #expect(model.otherDevices.map { model.statusWord($0) } == ["Registered"])
    }

    @Test("A registration the backend leaves undecided waits longer each time, stops by itself after six tries, and goes again when the owner asks")
    func registrationBackoffAndCap() async throws {
        let router = Router()
        let transport = router.transport
        let time = ManualTimeSource(instant: TestSupport.startInstant)
        let listed = LockedFlag(false)
        router.on("POST", "/v1/devices") { _ in TestSupport.error("rate_limited", "Too many requests", status: 429) }
        let model = NotificationsModel(environment: TestSupport.environment(transport: transport, time: time))
        let installation = model.deviceId
        router.on("GET", "/v1/devices") { _ in TestSupport.json(["deliveryConfigured": true, "devices": listed.value ? [syntheticDevice(installation)] : []]) }
        func posts() -> [HTTPRequest] { transport.requests("POST", "/v1/devices") }
        model.turnOn()
        let token = Data(repeating: 7, count: 32)

        let first = await model.register(token: token, apns: .development)
        #expect(!first && model.isWaitingToSend && !model.isRegistered)
        #expect(model.message == "Not registered yet: Too many requests. It will be tried again later.")
        #expect(model.statusLine == "Waiting to register this phone. It will be tried again later.")
        // iOS hands the same token over again on the next launch: that is the same request, still waiting its turn.
        let relaunch = await model.register(token: token, apns: .development)
        #expect(!relaunch && posts().count == 1)

        router.on("POST", "/v1/devices") { _ in TestSupport.error("internal", "Something went wrong on the server.", status: 500) }
        for attempt in 2..<NotificationsModel.retryLimit {
            time.advance(NotificationsModel.retryDelay(afterAttempts: attempt - 1) - 1)
            let early = await model.retryPending()
            #expect(!early && posts().count == attempt - 1)          // not before the wait is over
            time.advance(1)
            let tried = await model.retryPending()
            #expect(!tried && posts().count == attempt && !model.hasStoppedRetrying)
        }
        #expect(NotificationsModel.retryDelay(afterAttempts: 1) == 60 && NotificationsModel.retryDelay(afterAttempts: 3) == 240 && NotificationsModel.retryDelay(afterAttempts: 20) == 3600)

        // The sixth answer that decides nothing is the last automatic try.
        time.advance(3600)
        let last = await model.retryPending()
        #expect(!last && posts().count == NotificationsModel.retryLimit && model.hasStoppedRetrying && model.isWaitingToSend)
        #expect(model.message == "Not registered: Something went wrong on the server. It was tried 6 times and will not be tried again by itself.")
        #expect(model.statusLine == "This phone has not been registered. Try again when you are ready.")
        time.advance(86_400)
        let later = await model.retryPending()
        #expect(!later && posts().count == NotificationsModel.retryLimit)
        #expect(Set(posts().map { String(decoding: $0.body ?? Data(), as: UTF8.self) }).count == 1)   // one registration, sent again; never a second one

        // The owner asks: it is sent at once and starts over.
        router.on("POST", "/v1/devices") { request in TestSupport.json(syntheticDevice(TestSupport.body(request)["deviceId"]?.stringValue ?? "")) }
        listed.value = true
        let asked = await model.retryNow()
        #expect(asked && model.isRegistered && !model.isWaitingToSend && !model.hasStoppedRetrying)
    }

    @Test("A phone that was never registered sends no removal; iOS is told to stop; after iOS refuses permission the switch is off")
    func neverRegisteredAndDenied() async throws {
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/devices", ["deliveryConfigured": true, "devices": [device("device-other-0001", status: "disabled"), device("device-other-0002", status: "paused")]])
        let model = NotificationsModel(environment: TestSupport.environment(transport: transport))
        let stops = CallCounter()
        model.stopReceiving = { stops.value += 1 }
        await model.open()
        #expect(model.otherDevices.map { model.statusWord($0) } == ["Stopped", "Not recognised by this version"])   // an unknown state is not called stopped

        // The owner turns the switch on and iOS refuses: the switch shows off, and the line says where to allow it.
        model.turnOn()
        #expect(model.isOn)
        model.setPermission(.denied)
        #expect(model.wanted && !model.isOn && !model.shouldRequestToken)
        #expect(model.statusLine == "Notifications are turned off for Garderobe in iPhone Settings.")
        // Allowed later in iPhone Settings: what the owner asked for stands.
        model.setPermission(.authorized)
        #expect(model.isOn && model.shouldRequestToken)

        // Turned off before any token was ever sent: nothing to remove, so nothing is sent and nothing waits.
        let off = await model.turnOff()
        #expect(off && !model.isOn && !model.isWaitingToSend && model.message == nil)
        #expect(stops.value == 1)                                              // iOS is told to stop delivering either way
        #expect(!transport.requests.contains { $0.method == "POST" })
    }

    @Test("Signing out removes this phone's registration while the session exists, tells iOS to stop, and leaves nothing waiting for the next person")
    func signOutRemovesRegistration() async throws {
        let router = Router()
        let transport = router.transport
        let store = InMemoryKeyValueStore()
        let app = AppModel(environment: TestSupport.environment(transport: transport, store: store), session: nil)
        let installation = app.notifications.deviceId
        let path = "/v1/devices/\(installation)/remove"
        router.json("GET", "/v1/devices", ["deliveryConfigured": true, "devices": [device(installation)]])
        router.on("POST", "/v1/devices") { request in TestSupport.json(syntheticDevice(TestSupport.body(request)["deviceId"]?.stringValue ?? "")) }
        router.json("POST", path, ["removed": true])
        let stops = CallCounter()
        app.notifications.stopReceiving = { stops.value += 1 }
        app.notifications.turnOn()
        let registered = await app.notifications.register(token: Data(repeating: 3, count: 32), apns: .production)
        #expect(registered && app.notifications.isRegistered)

        await app.account.signOut()
        #expect(transport.requests("POST", path).count == 1)
        #expect(transport.requests("POST", path).first?.headers["Authorization"] == "Bearer test-token")   // sent as the owner, before the session is dropped
        #expect(stops.value == 1 && !app.notifications.wanted && !app.notifications.isWaitingToSend)

        // Signing out with a request still waiting (the server was failing): it is asked once more and then dropped.
        let next = AppModel(environment: TestSupport.environment(transport: transport, store: store), session: nil)
        #expect(next.notifications.deviceId == installation && !next.notifications.isWaitingToSend)
        next.notifications.turnOn()
        _ = await next.notifications.register(token: Data(repeating: 3, count: 32), apns: .production)
        router.on("POST", path) { _ in TestSupport.error("internal", "Something went wrong on the server.", status: 500) }
        let off = await next.notifications.turnOff()
        #expect(!off && next.notifications.isWaitingToSend)
        await next.account.signOut()
        #expect(!next.notifications.isWaitingToSend)
        let afterwards = NotificationsModel(environment: TestSupport.environment(transport: transport, store: store))
        #expect(!afterwards.isWaitingToSend && !afterwards.wanted)
        let before = transport.requests("POST", path).count
        let nothing = await afterwards.retryPending()
        #expect(nothing && transport.requests("POST", path).count == before)   // nothing is sent under the next sign-in
    }

    @Test("The notification service is the one the build was signed for, not the one its build configuration suggests")
    func pushEnvironmentFromSigning() {
        func profile(_ aps: String?) -> Data {
            let entry = aps.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
            let list = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Name</key><string>SYNTHETIC profile</string><key>Entitlements</key><dict>\(entry)<key>get-task-allow</key><true/></dict></dict></plist>"
            return Data([0x30, 0x82, 0x1f, 0x00, 0xff]) + Data(list.utf8) + Data([0xa0, 0x82, 0x00, 0xfe])   // a signed container around the list
        }
        #expect(PushEnvironment.fromProvisioningProfile(profile("development")) == .development)
        #expect(PushEnvironment.fromProvisioningProfile(profile("production")) == .production)
        #expect(PushEnvironment.fromProvisioningProfile(profile(nil)) == nil)
        #expect(PushEnvironment.fromProvisioningProfile(profile("unknown")) == nil)
        #expect(PushEnvironment.fromProvisioningProfile(Data([1, 2, 3])) == nil)
        // A release build signed for development gets development tokens; a debug build signed for distribution gets production ones.
        #expect(PushEnvironment.resolve(profile: profile("development"), isSimulator: false, isDebugBuild: false) == .development)
        #expect(PushEnvironment.resolve(profile: profile("production"), isSimulator: false, isDebugBuild: true) == .production)
        // No profile: the App Store and TestFlight strip it; a simulator has none.
        #expect(PushEnvironment.resolve(profile: nil, isSimulator: false, isDebugBuild: false) == .production)
        #expect(PushEnvironment.resolve(profile: nil, isSimulator: true, isDebugBuild: false) == .development)
        #expect(PushEnvironment.resolve(profile: profile(nil), isSimulator: false, isDebugBuild: true) == .development)
    }

    /// The recorded composition of the owner's opening outfit, with its preview state replaced.
    private func composition(preview state: String, failure: JSONValue = .null) throws -> (hash: String, value: JSONValue) {
        let cassette = try Cassette.bundled("owner-media")
        let recorded = try #require(cassette.steps.flatMap { $0.posts ?? [] }.first { $0.path == "/v1/studio/compose" }?.response.body)
        guard case .object(var fields) = recorded else { throw CocoaError(.coderInvalidValue) }
        fields["preview"] = ["state": .string(state), "sha256": state == "rendered" ? "feed" : .null, "renderedAt": state == "rendered" ? .string(Synthetic.now) : .null, "failure": failure]
        return (try #require(fields["manifestHash"]?.stringValue), .object(fields))
    }

    @Test("A preview that is not rendered yet is never shown as ready; it is read when it exists; a failure and being offline are said")
    func previewStates() async throws {
        let queued = try composition(preview: "queued")
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/studio", Synthetic.studio(selectors: [("top", true, [Synthetic.selectorItem("gmt_test_shirt", name: "Test blue oxford shirt"), Synthetic.selectorItem("gmt_test_knit", name: "Test grey jumper")])],
                                                         opening: [("top", "gmt_test_shirt")]))
        router.json("POST", "/v1/studio/compose", try composition(preview: "none").value)
        router.on("POST", "/v1/studio/previews") { _ in
            TestSupport.json(["receipt": TestSupport.receipt(commandId: "cmd_preview", type: "media.request_composite", summary: "Preview requested", undoAvailable: false), "manifestHash": .string(queued.hash)])
        }
        router.json("GET", "/v1/studio/compositions/\(queued.hash)", queued.value)
        let env = TestSupport.environment(transport: transport)
        let studio = StudioModel(environment: env, sleep: { _ in })
        await studio.open()
        await studio.loadComposition()

        await studio.requestPreview()
        #expect(studio.preview == .queued)
        #expect(studio.previewLine == "The picture is being made. It is not ready yet.")
        #expect(transport.requests("GET", "/v1/studio/compositions/\(queued.hash)").count == StudioModel.previewChecks)   // a bounded wait
        // Asked again while it is being made: it is looked for once more, never requested a second time.
        await studio.requestPreview()
        #expect(transport.requests("POST", "/v1/studio/previews").count == 1)
        #expect(transport.requests("GET", "/v1/studio/compositions/\(queued.hash)").count == StudioModel.previewChecks + 1)
        #expect(transport.requests("GET", "/v1/studio/compositions/\(queued.hash)/preview").isEmpty)                      // not fetched before it exists
        #expect(TestSupport.body(try #require(transport.requests("POST", "/v1/studio/previews").first))["slots"] == [["role": "top", "garmentId": "gmt_test_shirt", "locked": false]])
        #expect(env.center.receipts.isEmpty && env.center.banner == nil)   // asking for a picture is not something to undo

        // Later it exists: Check again reads it.
        let png = Data([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
        router.json("GET", "/v1/studio/compositions/\(queued.hash)", try composition(preview: "rendered").value)
        router.on("GET", "/v1/studio/compositions/\(queued.hash)/preview") { _ in HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: png) }
        await studio.checkPreview()
        #expect(studio.preview == .rendered(png))

        // Another piece: the picture no longer describes what is on the canvas.
        studio.step(.top, by: 1)
        #expect(studio.preview == .none)

        // The backend could not make it.
        await studio.loadComposition()
        router.json("GET", "/v1/studio/compositions/\(queued.hash)", try composition(preview: "failed", failure: "a layer's image could not be read").value)
        await studio.requestPreview()
        #expect(studio.preview == .failed("The picture could not be made: a layer's image could not be read"))

        // Offline: said, and nothing is queued for later.
        router.offline.value = true
        await studio.requestPreview()
        #expect(studio.preview == .failed("Offline. A picture needs a connection."))
        #expect(env.center.pending.isEmpty)

        // Asking again for the same pieces after a request that got no answer repeats that request,
        // so one that did reach the backend is not made twice. A request the backend answered is done with.
        router.offline.value = false
        await studio.requestPreview()
        let ids = transport.requests("POST", "/v1/studio/previews").map { TestSupport.body($0)["clientRequestId"]?.stringValue }
        #expect(ids.count == 4 && !ids.contains(nil))
        #expect(ids[2] == ids[3])                         // offline, then the retry: one request
        #expect(ids[0] != ids[1] && ids[1] != ids[2])     // other pieces, and a new try after the backend's own failure: new requests
    }

    @Test("A picture asked for before any layout was read is still found when it exists")
    func previewFoundWithoutLayout() async throws {
        let rendered = try composition(preview: "rendered")
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/studio", Synthetic.studio(selectors: [("top", true, [Synthetic.selectorItem("gmt_test_shirt", name: "Test blue oxford shirt")])], opening: [("top", "gmt_test_shirt")]))
        router.on("POST", "/v1/studio/previews") { _ in
            TestSupport.json(["receipt": TestSupport.receipt(commandId: "cmd_preview", type: "media.request_composite", summary: "Preview requested", undoAvailable: false), "manifestHash": .string(rendered.hash)])
        }
        let studio = StudioModel(environment: TestSupport.environment(transport: transport), sleep: { _ in })
        await studio.open()
        // No layout was read, and every look for the picture fails for now.
        await studio.requestPreview()
        #expect(studio.preview == .queued && studio.composition == nil)
        let png = Data([0x89, 0x50, 0x4e, 0x47, 4, 5, 6])
        router.json("GET", "/v1/studio/compositions/\(rendered.hash)", rendered.value)
        router.on("GET", "/v1/studio/compositions/\(rendered.hash)/preview") { _ in HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: png) }
        await studio.checkPreview()
        #expect(studio.preview == .rendered(png))        // found by the address the backend gave when it was asked for
    }

    @Test("When a signed address cannot be issued the authenticated read is used; offline, nothing is shown as loaded")
    func signedFallback() async throws {
        let router = Router()
        let transport = router.transport
        let bytes = Data([9, 8, 7])
        router.on("POST", "/v1/media/renditions/rnd_test_1/sign") { _ in TestSupport.error("not_found", "No such image.", status: 404) }
        router.on("GET", "/v1/media/renditions/rnd_test_1") { _ in HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: bytes) }
        let loader = GarmentImageLoader(environment: TestSupport.environment(transport: transport))
        let ref = GarmentImageRef(garmentId: "gmt_test_shirt", hasRealImage: true, isDemo: false, renditionId: "rnd_test_1")
        #expect(await loader.inspectionData(for: ref) == bytes)
        #expect(transport.requests("GET", "/v1/media/renditions/rnd_test_1").first?.query.first?.value == "1280")

        // An address that has lapsed answers 404 like every other failure: the authenticated read is used.
        router.json("POST", "/v1/media/renditions/rnd_test_2/sign", ["url": "/v1/media/signed/tok", "renditionId": "rnd_test_2", "width": 1280, "expiresAt": .string(Synthetic.now)])
        router.on("GET", "/v1/media/signed/tok") { request in
            #expect(request.headers["Authorization"] == nil)
            return TestSupport.error("not_found", "Not found.", status: 404)
        }
        router.on("GET", "/v1/media/renditions/rnd_test_2") { _ in HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: bytes) }
        #expect(await loader.signedData(renditionId: "rnd_test_2") == bytes)

        router.offline.value = true
        #expect(await loader.signedData(renditionId: "rnd_test_3") == nil)
        #expect(await loader.inspectionData(for: GarmentImageRef(garmentId: "gmt_test_knit", hasRealImage: false, isDemo: false, missingImageNote: "No photo yet")) == nil)
    }

    @Test("A photo's role is sent only when the owner said it, only for photos actually attached, and a turn saved by an earlier version still sends")
    func photoRoles() async throws {
        let router = Router()
        router.on("POST", "/v1/uploads") { request in
            let id = TestSupport.body(request)["clientUploadId"]?.stringValue ?? ""
            return TestSupport.json(["uploadId": .string("upl_" + id), "method": "PUT", "url": .string("/v1/uploads/upl_\(id)/content"), "requiredHeaders": ["Content-Type": "image/png"],
                                     "maxBytes": 1_000_000, "expiresAt": .string(Synthetic.now), "replayed": false])
        }
        for n in 1...4 {
            let id = "upl_upload-test-00000\(n)"
            router.json("PUT", "/v1/uploads/\(id)/content", ["uploadId": .string(id), "receivedBytes": 2])
            router.on("POST", "/v1/uploads/\(id)/complete") { _ in
                let asset = try! Cassette.bundled("owner-media").steps.first { $0.id == "upload-complete" }!.response!.body!["asset"]!
                guard case .object(var fields) = asset else { return TestSupport.error("internal", "bad fixture", status: 500) }
                fields["assetId"] = .string("ast_test_\(n)")
                return TestSupport.json(["uploadId": .string(id), "state": "finalized", "asset": .object(fields), "rejectionReason": .null, "jobId": .null,
                                         "receipt": TestSupport.receipt(commandId: "c\(n)", type: "media.finalize_upload", summary: "Photo stored", undoAvailable: false)])
            }
        }
        router.offline.value = false
        let transport = router.transport
        let env = TestSupport.environment(transport: transport)
        let composer = ComposerModel(environment: env, transcript: TranscriptModel(environment: env), sleep: { _ in })
        let a = await composer.uploads.add(data: Data([1, 2]), contentType: .imagePng, intent: .attachment)
        let b = await composer.uploads.add(data: Data([1, 2]), contentType: .imagePng, intent: .attachment)
        #expect(composer.uploads.readyAssetIds == ["ast_test_1", "ast_test_2"])
        #expect(composer.uploads.readyImageRoles.isEmpty)                      // nothing is assumed about a photo
        composer.uploads.setRole(.receipt, for: a)
        composer.uploads.setRole(.shopPhoto, for: b)
        composer.uploads.setRole(nil, for: b)                                  // taken back
        composer.draft = "Is this the right order?"
        await composer.send()
        let sent = TestSupport.body(try #require(transport.requests("POST", "/v1/conversation/turns").first))
        #expect(sent["attachmentIds"] == ["ast_test_1", "ast_test_2"])
        #expect(sent["imageRoles"] == ["ast_test_1": "receipt"])

        // Identify this: the purpose says nothing about the photo, so the role is the owner's choice or absent.
        let capture = CaptureModel(environment: env, composer: composer)
        capture.intent = .identify
        #expect(capture.asksPhotoRole)
        await capture.addPhoto(data: Data([1, 2]), contentType: .imagePng)
        #expect(capture.uploads.readyImageRoles.isEmpty)
        capture.identifyRole = .shopPhoto
        #expect(capture.uploads.readyImageRoles == ["ast_test_4": .shopPhoto])
        capture.intent = .addItem
        #expect(capture.identifyRole == nil && !capture.asksPhotoRole)

        // A turn saved before roles existed decodes and sends without them; a role for a photo that is not attached is dropped.
        var current = PendingTurn(clientTurnId: "turn-legacy-000001", text: "Old", attachmentIds: ["ast_x"], attachedRefs: [], intent: .chat, sharedUrl: nil,
                                  createdAt: env.time.now(), state: .waitingToSend, turnId: nil, runId: nil)
        guard case .object(var saved) = try JSONValue.from(current) else { Issue.record("a pending turn is saved as an object"); return }
        saved["imageRoles"] = nil                                               // exactly what an earlier version wrote
        var turn = try JSONValue.object(saved).decoded(as: PendingTurn.self)
        #expect(turn.imageRoles == nil && turn.request.imageRoles == nil)
        turn.imageRoles = ["ast_x": .selfie, "ast_gone": .receipt]
        #expect(turn.request.imageRoles == ["ast_x": .selfie])
        current.imageRoles = ["ast_x": .unknown]
        #expect(try JSONValue.from(current).decoded(as: PendingTurn.self).imageRoles == ["ast_x": .unknown])
    }
}
