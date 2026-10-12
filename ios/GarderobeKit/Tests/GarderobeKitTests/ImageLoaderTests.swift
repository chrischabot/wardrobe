import Testing
import Foundation
@testable import GarderobeKit

/// Garment image state and caching: a confirmed absence invalidates old bytes and is trusted
/// only for a while, a failed read is unavailable rather than "no photo", what a tile shows at
/// once follows its exact reference, undecodable bytes are read again, and a media receipt
/// invalidates the garment's cached photograph. Every backend here is SYNTHETIC (scripted answers).
@MainActor
@Suite("Garment images: absence, failure, rendition-keyed cache and media changes")
struct ImageLoaderTests {
    private static let png = Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3])
    private static let newerPng = Data([0x89, 0x50, 0x4E, 0x47, 4, 5, 6])

    @Test("A confirmed absence removes the old bytes; it is trusted only for a while, then asked again")
    func absenceInvalidatesAndExpires() async {
        let router = Router()
        let answer = LockedBox<HTTPResponse>(HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.png))
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in answer.value }
        let time = ManualTimeSource(instant: Synthetic.now)
        let env = TestSupport.environment(transport: router.transport, time: time)
        let loader = GarmentImageLoader(environment: env)

        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(Self.png))
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: nil, width: 320) == Self.png)

        // The photograph is removed on the backend. A new loader (next launch) asks again and is told.
        answer.value = TestSupport.error("not_found", "No image.", status: 404)
        let next = GarmentImageLoader(environment: env)
        #expect(await next.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .noImage)
        #expect(next.cachedImage(garmentId: "gmt_test_shirt", image: nil, width: 320) == nil)      // the old bytes are gone
        #expect(await next.data(forGarment: "gmt_test_shirt", width: 320) == nil)

        // A new photograph is added. Within the trusted window the absence stands; after it, the new one is found.
        answer.value = HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.newerPng)
        time.advance(GarmentImageLoader.missingLifetime - 1)
        #expect(await next.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .noImage)
        time.advance(2)
        #expect(await next.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(Self.newerPng))
    }

    @Test("A failed read is 'unavailable', not 'no photo'; the last bytes read are kept when there are some")
    func failureIsUnavailable() async {
        let router = Router()
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in TestSupport.error("internal", "Server fault.", status: 500) }
        router.on("GET", "/v1/media/renditions/rnd_1") { _ in TestSupport.error("internal", "Server fault.", status: 500) }
        let store = InMemoryKeyValueStore()
        let env = TestSupport.environment(transport: router.transport, store: store)
        let loader = GarmentImageLoader(environment: env)
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .unavailable)
        let ref = GarmentImageRef(garmentId: "gmt_test_shirt", hasRealImage: true, isDemo: false, renditionId: "rnd_1")
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: ref, width: 320) == .unavailable)

        env.media.store(Self.png, for: "item:gmt_test_shirt:320")
        #expect(await GarmentImageLoader(environment: env).image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(Self.png))
    }

    @Test("What a tile shows at once follows its reference: the exact rendition, or nothing when there is no real image")
    func cachedPeekFollowsReference() {
        let env = TestSupport.environment(transport: Router().transport)
        env.media.store(Self.png, for: "item:gmt_test_shirt:320")
        env.media.store(Self.newerPng, for: "rendition:rnd_2:320")
        let loader = GarmentImageLoader(environment: env)
        let exact = GarmentImageRef(garmentId: "gmt_test_shirt", hasRealImage: true, isDemo: false, renditionId: "rnd_2")
        let none = GarmentImageRef(garmentId: "gmt_test_shirt", hasRealImage: false, isDemo: false, missingImageNote: "No photo yet")
        let uncached = GarmentImageRef(garmentId: "gmt_test_shirt", hasRealImage: true, isDemo: false, renditionId: "rnd_3")
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: nil, width: 320) == Self.png)
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: exact, width: 320) == Self.newerPng)
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: none, width: 320) == nil)       // never the garment's old photo
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: uncached, width: 320) == nil)   // never another rendition
    }

    @Test("A reference that claims a real image but names no rendition reads the garment's current image; it is never 'no photo'")
    func incompleteReferenceReadsGarmentImage() async {
        let router = Router()
        let answer = LockedBox<HTTPResponse>(HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.png))
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in answer.value }
        let env = TestSupport.environment(transport: router.transport)
        let loader = GarmentImageLoader(environment: env)
        let incomplete = GarmentImageRef(garmentId: "gmt_test_shirt", hasRealImage: true, isDemo: false)
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: incomplete, width: 320) == .image(Self.png))
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: incomplete, width: 320) == Self.png)

        // When that read fails it is unavailable (retryable), not a statement that no photograph exists.
        answer.value = TestSupport.error("internal", "Server fault.", status: 500)
        let next = GarmentImageLoader(environment: TestSupport.environment(transport: router.transport))
        #expect(await next.image(garmentId: "gmt_test_shirt", image: incomplete, width: 320) == .unavailable)
    }

    @Test("Bytes a tile cannot decode are dropped, so trying again reads the image from the backend")
    func undecodableBytesAreReadAgain() async {
        let broken = Data([0, 1, 2])
        let router = Router()
        let answer = LockedBox<HTTPResponse>(HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: broken))
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in answer.value }
        router.on("GET", "/v1/media/renditions/rnd_1") { _ in answer.value }
        let loader = GarmentImageLoader(environment: TestSupport.environment(transport: router.transport))
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(broken))
        loader.discardUndecodable(garmentId: "gmt_test_shirt", image: nil, width: 320)
        answer.value = HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.png)
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(Self.png))   // read again, not the bad bytes

        let ref = GarmentImageRef(garmentId: "gmt_test_shirt", hasRealImage: true, isDemo: false, renditionId: "rnd_1")
        answer.value = HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: broken)
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: ref, width: 320) == .image(broken))
        loader.discardUndecodable(garmentId: "gmt_test_shirt", image: ref, width: 320)
        answer.value = HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.png)
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: ref, width: 320) == .image(Self.png))
    }

    @Test("A media receipt drops the garment's cached photograph and its checked mark, and a read on its way is not kept")
    func mediaChangeInvalidatesGarmentImage() async throws {
        let router = Router()
        let answer = LockedBox<HTTPResponse>(HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.png))
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in answer.value }
        let env = TestSupport.environment(transport: router.transport)
        let loader = GarmentImageLoader(environment: env)
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(Self.png))

        // A new primary photograph is chosen. The receipt names the garment.
        let receipt = try GarderobeJSON.decode(CommandReceipt.self, from: GarderobeJSON.encode(
            TestSupport.receipt(commandId: "cmd_test_primary", type: "media.set_primary_asset", summary: "Test: new photo", affected: [("garment", "gmt_test_shirt", 3)])))
        let changed = try #require(GarmentImageLoader.imageChange(in: receipt))
        #expect(changed == ["gmt_test_shirt"])
        answer.value = HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.newerPng)
        let before = loader.revision(forGarment: "gmt_test_shirt")
        loader.garmentImagesChanged(changed)
        #expect(loader.revision(forGarment: "gmt_test_shirt") == before + 1)                       // tiles showing it read again
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: nil, width: 320) == nil)         // the old bytes are gone
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(Self.newerPng))

        // Commands that do not change what a garment shows leave its images alone.
        let other = try GarderobeJSON.decode(CommandReceipt.self, from: GarderobeJSON.encode(
            TestSupport.receipt(commandId: "cmd_test_wear", type: "wear.record", summary: "Test: worn", affected: [("garment", "gmt_test_shirt", 4)])))
        #expect(GarmentImageLoader.imageChange(in: other) == nil)
    }

    @Test("A read that began before the garment's images changed does not put the old photograph back")
    func lateReadAfterMediaChangeIsDropped() async throws {
        let router = Router()
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.png) }
        let held = HeldRequestTransport(inner: router.transport) { $0.path == "/v1/items/gmt_test_shirt/image" }
        let env = TestSupport.environment(transport: held)
        let loader = GarmentImageLoader(environment: env)
        let read = Task { await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) }
        await held.arrived()
        loader.garmentImagesChanged(["gmt_test_shirt"])
        held.release()
        _ = await read.value
        #expect(env.media.data(for: "item:gmt_test_shirt:320") == nil)
    }
    @Test("A media change and a confirmed absence cover every width held for the garment, not only the standard ones")
    func everyWidthIsInvalidated() async throws {
        let router = Router()
        let answer = LockedBox<HTTPResponse>(HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.png))
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in answer.value }
        let env = TestSupport.environment(transport: router.transport)
        let loader = GarmentImageLoader(environment: env)
        // 500 is not a served thumbnail width; 320 is.
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 500) == .image(Self.png))
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(Self.png))
        loader.garmentImagesChanged(["gmt_test_shirt"])
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: nil, width: 500) == nil)

        // Both widths are read and checked again; then the photograph is deleted and one width learns it.
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 500) == .image(Self.png))
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .image(Self.png))
        answer.value = TestSupport.error("not_found", "No image.", status: 404)
        loader.garmentImagesChanged([])                                  // a general re-check, bytes kept until then
        let shownRevision = loader.revision(forGarment: "gmt_test_shirt")
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 320) == .noImage)
        #expect(loader.revision(forGarment: "gmt_test_shirt") == shownRevision + 1)   // a tile showing another width reads again
        #expect(loader.cachedImage(garmentId: "gmt_test_shirt", image: nil, width: 500) == nil)   // the other width is not evidence either
        let before = router.transport.requests("GET", "/v1/items/gmt_test_shirt/image").count
        #expect(await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 500) == .noImage)
        #expect(router.transport.requests("GET", "/v1/items/gmt_test_shirt/image").count == before)
    }

    @Test("A read at a non-standard width that began before a media change is not stored")
    func lateReadAtOtherWidthIsDropped() async throws {
        let router = Router()
        router.on("GET", "/v1/items/gmt_test_shirt/image") { _ in HTTPResponse(status: 200, headers: ["Content-Type": "image/png"], body: Self.png) }
        let held = HeldRequestTransport(inner: router.transport) { $0.path == "/v1/items/gmt_test_shirt/image" }
        let env = TestSupport.environment(transport: held)
        let loader = GarmentImageLoader(environment: env)
        let read = Task { await loader.image(garmentId: "gmt_test_shirt", image: nil, width: 500) }
        await held.arrived()
        loader.garmentImagesChanged(["gmt_test_shirt"])
        held.release()
        _ = await read.value
        #expect(env.media.data(for: "item:gmt_test_shirt:500") == nil)
    }
}

/// A value shared with a scripted backend's handlers.
final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Value
    init(_ value: Value) { _value = value }
    var value: Value {
        get { lock.withLock { _value } }
        set { lock.withLock { _value = newValue } }
    }
}

/// A SYNTHETIC backend that holds the answer to the first request matching `match` until the
/// test lets it go. The scripted transport records the request only when it is answered.
final class HeldRequestTransport: HTTPTransport, @unchecked Sendable {
    private let inner: ScriptedTransport
    private let match: @Sendable (HTTPRequest) -> Bool
    private let lock = NSLock()
    private var held = false
    private var hasArrived = false
    private var arrivalWaiter: CheckedContinuation<Void, Never>?
    private var released = false
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    init(inner: ScriptedTransport, match: @escaping @Sendable (HTTPRequest) -> Bool) { self.inner = inner; self.match = match }

    func arrived() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let already = lock.withLock { () -> Bool in
                if hasArrived { return true }
                arrivalWaiter = continuation
                return false
            }
            if already { continuation.resume() }
        }
    }

    func release() {
        let waiter = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            released = true
            defer { releaseWaiter = nil }
            return releaseWaiter
        }
        waiter?.resume()
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let hold = lock.withLock { () -> Bool in
            guard !held, match(request) else { return false }
            held = true
            return true
        }
        if hold {
            let arrival = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                hasArrived = true
                defer { arrivalWaiter = nil }
                return arrivalWaiter
            }
            arrival?.resume()
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let go = lock.withLock { () -> Bool in
                    if released { return true }
                    releaseWaiter = continuation
                    return false
                }
                if go { continuation.resume() }
            }
        }
        return try await inner.send(request)
    }

    func stream(_ request: HTTPRequest) -> AsyncThrowingStream<Data, Error> { inner.stream(request) }
}
