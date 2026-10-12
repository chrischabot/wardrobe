import Testing
import Foundation
@testable import GarderobeKit

/// Export my wardrobe: the request key, and a downloaded package that only ever belongs to its own
/// export. Starting or discovering another export, a failed download, or the export becoming
/// undownloadable never leaves an earlier package on offer.
/// Every backend here is SYNTHETIC (scripted answers), labelled as such.
@MainActor
@Suite("Export: request keys and a download bound to its own export")
struct ExportModelTests {
    private func exportJob(_ id: String, state: String) -> JSONValue {
        ["exportId": .string(id), "runId": "run_test_export", "state": .string(state), "complete": true, "encrypted": false, "formatVersion": "garderobe-export/1",
         "requestedAt": .string(Synthetic.now), "finishedAt": .null, "expiresAt": .null,
         "snapshot": ["takenAt": .string(Synthetic.now), "wardrobeRevision": 5, "styleRevision": 2, "lastCommandRecordedAt": .null], "components": [], "byteLength": .null, "sha256": .null]
    }

    /// A router whose export exp_test_1 is completed and whose package downloads.
    private func downloadableRouter() -> Router {
        let router = Router()
        router.on("POST", "/v1/exports") { _ in TestSupport.json(self.exportJob("exp_test_1", state: "completed")) }
        router.on("POST", "/v1/exports/exp_test_1/ticket") { _ in
            TestSupport.json(["url": "/v1/exports/exp_test_1/package", "fileName": "garderobe-export.zip", "expiresAt": .string(Synthetic.now)])
        }
        router.on("GET", "/v1/exports/exp_test_1/package") { _ in HTTPResponse(status: 200, headers: ["Content-Type": "application/zip"], body: Data([9, 9, 9])) }
        return router
    }

    // MARK: Request keys

    @Test("Starting again after a failed or expired export uses a new request key; a lost answer reuses it")
    func exportKeyRotates() async throws {
        let router = Router()
        let states = LockedBox<[String]>(["failed", "expired", "running"])
        router.on("POST", "/v1/exports") { request in
            let state = states.value.removeFirst()
            return TestSupport.json(self.exportJob("exp_\(TestSupport.body(request)["clientRequestId"]?.stringValue ?? "")", state: state))
        }
        let transport = router.transport
        let store = InMemoryKeyValueStore()
        let env = TestSupport.environment(transport: transport, store: store)
        let export = ExportModel(environment: env)
        await export.start(passphrase: nil)
        #expect(export.job?.state == .failed)
        router.offline.value = true
        await export.start(passphrase: nil)                                       // after a failure: a fresh key, whose answer is lost
        router.offline.value = false
        let freshKey: String? = env.restoration.load("export.request")
        let firstKey = transport.requests("POST", "/v1/exports").first.flatMap { TestSupport.body($0)["clientRequestId"]?.stringValue }
        #expect(freshKey != nil && freshKey != firstKey)

        // The kept key (lost answer, relaunch) now names an expired job: one fresh start follows by itself.
        let relaunched = ExportModel(environment: env)
        await relaunched.start(passphrase: nil)
        let all = transport.requests("POST", "/v1/exports").map { TestSupport.body($0)["clientRequestId"]?.stringValue }
        #expect(all.count >= 3 && all[all.count - 2] == freshKey && all[all.count - 1] != freshKey)
        #expect(relaunched.job?.state == .running)
    }

    @Test("Starting again after a completed export asks for a new export under a new request key")
    func exportKeyRotatesAfterCompletion() async throws {
        let router = Router()
        let states = LockedBox<[String]>(["completed", "running"])
        router.on("POST", "/v1/exports") { request in
            let state = states.value.removeFirst()
            return TestSupport.json(self.exportJob("exp_\(TestSupport.body(request)["clientRequestId"]?.stringValue ?? "")", state: state))
        }
        let transport = router.transport
        let export = ExportModel(environment: TestSupport.environment(transport: transport))
        await export.start(passphrase: nil)
        #expect(export.job?.state == .completed)
        await export.start(passphrase: nil)                                       // not downloaded, but finished: a new export
        let keys = transport.requests("POST", "/v1/exports").map { TestSupport.body($0)["clientRequestId"]?.stringValue }
        #expect(keys.count == 2 && keys[0] != keys[1])
        #expect(export.job?.state == .running)
    }

    @Test("A read of an earlier export that arrives after another export was started never replaces the newer job")
    func lateReadOfEarlierExportIsDropped() async throws {
        let router = Router()
        let count = LockedBox(0)
        router.on("POST", "/v1/exports") { _ in
            count.value += 1
            return TestSupport.json(self.exportJob("exp_test_\(count.value)", state: count.value == 1 ? "completed" : "running"))
        }
        router.json("GET", "/v1/exports/exp_test_1", exportJob("exp_test_1", state: "completed"))
        let transport = router.transport
        let held = HeldRequestTransport(inner: transport) { $0.method == "GET" && $0.path == "/v1/exports/exp_test_1" }
        let export = ExportModel(environment: TestSupport.environment(transport: held))
        await export.start(passphrase: nil)
        #expect(export.job?.exportId == "exp_test_1")
        let refresh = Task { await export.refresh() }
        await held.arrived()
        await export.start(passphrase: nil)                                       // a new export while the read is out
        #expect(export.job?.exportId == "exp_test_2")
        held.release()
        await refresh.value
        #expect(export.job?.exportId == "exp_test_2" && export.job?.state == .running)
    }

    // MARK: A download belongs to its export

    @Test("A start of the ended account that is still waiting never holds back the next account's refresh")
    func resetReleasesStartsInFlight() async throws {
        let router = Router()
        router.on("POST", "/v1/exports") { _ in TestSupport.json(self.exportJob("exp_test_old", state: "running")) }
        router.json("GET", "/v1/exports", ["exports": [exportJob("exp_test_new", state: "completed")]])
        router.json("GET", "/v1/exports/exp_test_new", exportJob("exp_test_new", state: "completed"))
        let transport = router.transport
        let held = HeldRequestTransport(inner: transport) { $0.method == "POST" && $0.path == "/v1/exports" }
        let export = ExportModel(environment: TestSupport.environment(transport: held))
        let start = Task { await export.start(passphrase: nil) }
        await held.arrived()
        export.reset()                                                            // the account ended while the start waited
        await export.refresh()
        #expect(transport.requests("GET", "/v1/exports").count == 1)              // not held back by the old start
        #expect(export.job?.exportId == "exp_test_new")
        held.release()
        await start.value
        #expect(export.job?.exportId == "exp_test_new")                           // the old account's answer is dropped
        await export.refresh()                                                    // and the count did not go below zero
        #expect(transport.requests("GET", "/v1/exports/exp_test_new").count == 1)
    }

    @Test("After a relaunch, refresh reads the export the backend acknowledged; a start that was never answered adopts no other export")
    func relaunchRefreshRecoversAcknowledgedJob() async throws {
        let router = Router()
        router.on("POST", "/v1/exports") { _ in TestSupport.json(self.exportJob("exp_test_1", state: "running")) }
        router.json("GET", "/v1/exports/exp_test_1", exportJob("exp_test_1", state: "completed"))
        router.json("GET", "/v1/exports", ["exports": [exportJob("exp_test_old", state: "completed")]])
        let transport = router.transport
        let env = TestSupport.environment(transport: transport)
        await ExportModel(environment: env).start(passphrase: nil)

        let relaunched = ExportModel(environment: env)                            // the app was closed while the export ran
        await relaunched.refresh()
        #expect(relaunched.job?.exportId == "exp_test_1" && relaunched.job?.state == .completed)
        #expect(relaunched.canDownload)

        // A start whose answer was lost: after a relaunch nothing else is adopted, and the retry uses its key.
        let lostRouter = Router()
        lostRouter.on("POST", "/v1/exports") { _ in TestSupport.json(self.exportJob("exp_test_new", state: "running")) }
        lostRouter.json("GET", "/v1/exports", ["exports": [exportJob("exp_test_old", state: "completed")]])
        let lostTransport = lostRouter.transport
        let lostEnv = TestSupport.environment(transport: lostTransport)
        lostRouter.offline.value = true
        await ExportModel(environment: lostEnv).start(passphrase: nil)
        lostRouter.offline.value = false
        let afterLost = ExportModel(environment: lostEnv)
        await afterLost.refresh()
        #expect(afterLost.job == nil)
        #expect(lostTransport.requests("GET", "/v1/exports").isEmpty)
        await afterLost.start(passphrase: nil)
        let keys = lostTransport.requests("POST", "/v1/exports").map { TestSupport.body($0)["clientRequestId"]?.stringValue }
        #expect(!keys.isEmpty && Set(keys).count == 1)                            // every attempt under the one key
        #expect(afterLost.job?.exportId == "exp_test_new")
    }

    @Test("A model made after a relaunch forgets the saved job on reset, and a lost start never adopts the earlier saved job")
    func relaunchedModelForgetsSavedJob() async throws {
        let router = Router()
        let next = LockedBox("exp_test_1")
        router.on("POST", "/v1/exports") { _ in TestSupport.json(self.exportJob(next.value, state: "completed")) }
        router.json("GET", "/v1/exports/exp_test_1", exportJob("exp_test_1", state: "completed"))
        let transport = router.transport
        let env = TestSupport.environment(transport: transport)
        await ExportModel(environment: env).start(passphrase: nil)
        let saved: String? = env.restoration.load("export.job")
        #expect(saved == "exp_test_1")

        // Reset on a relaunched model that never held the job forgets it where it is kept.
        let relaunched = ExportModel(environment: env)
        relaunched.reset()
        let afterReset: String? = env.restoration.load("export.job")
        #expect(afterReset == nil)
        await ExportModel(environment: env).refresh()
        #expect(transport.requests("GET", "/v1/exports/exp_test_1").isEmpty)

        // A finished export is saved again; a relaunched model starts a new one whose answer is lost.
        await ExportModel(environment: env).start(passphrase: nil)
        let finishedKey: String? = env.restoration.load("export.request")
        let again = ExportModel(environment: env)
        router.offline.value = true
        await again.start(passphrase: nil)
        router.offline.value = false
        let afterLostStart: String? = env.restoration.load("export.job")
        #expect(afterLostStart == nil)
        let lostKey: String? = env.restoration.load("export.request")
        #expect(lostKey != nil && lostKey != finishedKey)                         // a new export, not the finished one again
        await again.refresh()
        #expect(again.job == nil)                                                 // the earlier job is not adopted
        next.value = "exp_test_2"
        await again.start(passphrase: nil)
        let keys = transport.requests("POST", "/v1/exports").map { TestSupport.body($0)["clientRequestId"]?.stringValue }
        #expect(keys.last == lostKey)                                             // the lost start is retried under its own key
        #expect(again.job?.exportId == "exp_test_2")
        #expect(again.job?.exportId == "exp_test_2")
    }

    @Test("A download belongs to its export: starting another export drops it, and a reset forgets the job")
    func downloadIsBoundToItsExport() async throws {
        let router = downloadableRouter()
        let next = LockedBox("exp_test_1")
        router.on("POST", "/v1/exports") { _ in TestSupport.json(self.exportJob(next.value, state: "completed")) }
        let transport = router.transport
        let env = TestSupport.environment(transport: transport)
        let export = ExportModel(environment: env)
        await export.start(passphrase: nil)
        await export.fetchPackage()
        #expect(export.download?.exportId == "exp_test_1")

        next.value = "exp_test_2"
        await export.start(passphrase: nil)
        #expect(export.job?.exportId == "exp_test_2")
        #expect(export.download == nil)                                                  // never shown with another job
        let keptBefore: String? = env.restoration.load("export.request")
        #expect(keptBefore != nil)                                                       // exp_test_2 is not downloaded yet

        export.reset()
        #expect(export.job == nil && export.download == nil)
        let keptAfter: String? = env.restoration.load("export.request")
        #expect(keptAfter == nil)                                                        // forgotten where it is kept, too
        let after = ExportModel(environment: env)
        await after.start(passphrase: nil)
        let keys = transport.requests("POST", "/v1/exports").map { TestSupport.body($0)["clientRequestId"]?.stringValue }
        #expect(keys.count == 3 && keys[2] != keys[1])                                   // a model made afterwards never resumes the old key
    }

    @Test("A failed download drops the package held from an earlier download of the same export")
    func failedDownloadDropsPackage() async throws {
        let router = downloadableRouter()
        let export = ExportModel(environment: TestSupport.environment(transport: router.transport))
        await export.start(passphrase: nil)
        await export.fetchPackage()
        #expect(export.download?.exportId == "exp_test_1" && export.download?.data == Data([9, 9, 9]))

        router.on("POST", "/v1/exports/exp_test_1/ticket") { _ in HTTPResponse(status: 500) }
        await export.fetchPackage()
        #expect(export.download == nil)                                                  // no earlier package on offer after a failure
        #expect(export.message != nil)
    }

    @Test("An export read again as expired drops its downloaded package")
    func expiredExportDropsPackage() async throws {
        let router = downloadableRouter()
        router.json("GET", "/v1/exports/exp_test_1", exportJob("exp_test_1", state: "expired"))
        let export = ExportModel(environment: TestSupport.environment(transport: router.transport))
        await export.start(passphrase: nil)
        await export.fetchPackage()
        #expect(export.download != nil)

        await export.refresh()
        #expect(export.job?.state == .expired && !export.canDownload)
        #expect(export.download == nil)
    }

    @Test("Bytes that arrive after another export was started are not kept for the new export")
    func lateDownloadOfEarlierExportIsDropped() async throws {
        let router = downloadableRouter()
        let next = LockedBox("exp_test_1")
        router.on("POST", "/v1/exports") { _ in TestSupport.json(self.exportJob(next.value, state: "completed")) }
        let held = HeldRequestTransport(inner: router.transport) { $0.method == "GET" && $0.path == "/v1/exports/exp_test_1/package" }
        let export = ExportModel(environment: TestSupport.environment(transport: held))
        await export.start(passphrase: nil)
        let fetch = Task { await export.fetchPackage() }
        await held.arrived()
        next.value = "exp_test_2"
        await export.start(passphrase: nil)                                       // another export while the bytes are on their way
        held.release()
        await fetch.value
        #expect(export.job?.exportId == "exp_test_2")
        #expect(export.download == nil)
        #expect(!export.isWorking)
    }
}
