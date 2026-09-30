import Foundation
import Testing
@testable import GarderobeKit

/// Confirming an assistant's export, import or recovery-kit request in the app, and using the private
/// result, against the fixture server's imitation of backend/src/api/portability.ts and mcp/pending.ts.
@Suite("Account requests")
@MainActor
struct AccountRequestTests {
    static let origin = "https://test.garderobe.invalid"

    func make(_ h: Harness) -> AccountRequestViewModel {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("garderobe-export-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return AccountRequestViewModel(env: h.env, receipts: ReceiptCenter(env: h.env), exportDirectory: dir)
    }

    func confirmURL(_ runId: String) -> URL { URL(string: "\(Self.origin)/confirm/\(runId)")! }

    /// Everything the app persisted, as text: no private link, token or code may appear in it.
    func persisted(_ h: Harness) -> String {
        h.store.keys.compactMap { h.store.data(forKey: $0) }.map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n")
    }

    func token(in link: String?) throws -> String {
        try #require(link.flatMap { URLComponents(string: $0)?.queryItems?.first { $0.name == "t" }?.value })
    }

    @Test func confirmingAnExportShowsAPrivateLinkThatOpensWithTheOwnersSession() async throws {
        let h = try Harness.make()
        let runId = await h.server.requestAccountOperation("export_data")
        let vm = make(h)
        #expect(await vm.open(confirmURL(runId)))
        guard case .question(let q) = vm.state else { Issue.record("expected the question, got \(vm.state)"); return }
        #expect(q.prompt.hasPrefix("Confirm: export"))
        await vm.answer(try #require(q.choices.first { $0.id == "confirm" }))
        guard case .export(let e) = vm.outcome else { Issue.record("expected an export, got \(vm.state)"); return }
        let body = try #require(await h.server.requests(matching: "/v1/runs/\(runId)/input").last?.body)
        #expect(try GarderobeJSON.decoder().decode(RunInputRequest.self, from: body).choiceId == "confirm")
        #expect(e.downloadUrl?.hasPrefix("\(Self.origin)/v1/export/downloads/") == true)
        let secret = try token(in: e.downloadUrl)
        #expect(AccountRequestViewModel.title(.export(e)) == "Your export is ready")
        #expect(vm.lines(.export(e)).allSatisfy { !$0.contains(secret) && !$0.contains("http") })
        // Opening the link: the owner's own request to the same origin, saved as a temporary file for sharing.
        let file = try #require(await vm.saveExport())
        #expect(String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("garderobe-export/1"))
        #expect(file.lastPathComponent.hasPrefix("garderobe-export-") && file.pathExtension == "json")
        #expect(await h.server.exportDownloads == 1)
        vm.discardExport()
        #expect(!FileManager.default.fileExists(atPath: file.path))
        #expect(vm.exportFile == nil)
        // Nothing private reached the client store.
        #expect(!persisted(h).contains(secret))
    }

    @Test func confirmingARecoveryKitLetsTheOwnerCollectTheCodeOnceAndNeverStoresIt() async throws {
        let h = try Harness.make()
        let runId = await h.server.requestAccountOperation("issue_recovery_kit")
        let vm = make(h)
        await vm.open(URL(string: "garderobe://confirm/\(runId)")!)
        guard case .question(let q) = vm.state else { Issue.record("expected the question"); return }
        await vm.answer(q.choices[0])
        guard case .recoveryKit(let k) = vm.outcome else { Issue.record("expected a recovery link, got \(vm.state)"); return }
        #expect(!k.codeIncluded)
        #expect(k.collectUrl?.hasPrefix("\(Self.origin)/v1/auth/recovery-kit/collect/") == true)
        let secret = try token(in: k.collectUrl)
        await vm.collectRecoveryCode()
        let code = try #require(vm.recoveryCode)
        #expect(code.credential == (await h.server.issuedRecoveryCodes.last))
        // The link works once.
        await vm.collectRecoveryCode()
        #expect(vm.linkError == "This recovery code was already collected; the link works once")
        #expect(await h.server.issuedRecoveryCodes.count == 1)
        let text = persisted(h)
        #expect(!text.contains(code.credential) && !text.contains(secret))
        vm.forgetRecoveryCode()
        #expect(vm.recoveryCode == nil)
        // Settings: the status says a code exists and when, never the code; the transfer is listed.
        let settings = SettingsViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await settings.refreshAccount()
        #expect(settings.recovery?.hasActiveKit == true)
        #expect(settings.recoveryLine?.hasPrefix("A recovery code was issued on") == true)
        #expect(settings.recoveryLine?.contains(code.credential) == false)
        let row = try #require(settings.transferRows.first)
        #expect(row.title == "Recovery code")
        #expect(row.detail.hasPrefix("Collected · asked for by an assistant"))
    }

    @Test func confirmingAnImportShowsWhatItDidToRecordsAndConnections() async throws {
        let h = try Harness.make()
        let vm = make(h)
        await vm.load(runId: await h.server.requestAccountOperation("import_data"))
        guard case .question(let q) = vm.state else { Issue.record("expected the question"); return }
        await vm.answer(q.choices[0])
        guard case .imported(let i) = vm.outcome else { Issue.record("expected an import, got \(vm.state)"); return }
        #expect(i.sessionsRecreated == 0 && i.callingGrant.status == "active")
        let lines = vm.lines(.imported(i))
        #expect(lines.contains("2 connected assistants were imported revoked; connect them again if you want them."))
        #expect(lines.contains("No sign-in sessions were recreated."))
        #expect(vm.exportFile == nil)
        // An import into a Garderobe that already has records is refused and nothing is imported.
        await h.server.setImportTargetEmpty(false)
        let refused = make(h)
        await refused.load(runId: await h.server.requestAccountOperation("import_data"))
        guard case .question(let q2) = refused.state else { Issue.record("expected the question"); return }
        await refused.answer(q2.choices[0])
        #expect(refused.state == .failed("Not done: This Garderobe already has records; an import needs an empty one"))
    }

    @Test func declinedAndExpiredRequestsDoNothing() async throws {
        let clock = NativeAuthTests.TestClock()
        let h = try Harness.make(server: FixtureServer(now: { clock.now() }))
        let declined = make(h)
        let first = await h.server.requestAccountOperation("export_data")
        await declined.load(runId: first)
        await declined.decline()
        #expect(declined.state == .declined)
        #expect(declined.outcome == nil)
        #expect(try await h.env.api.run(first).status == .cancelled)
        // A late confirmation of a declined request is not executed.
        #expect(try await h.env.api.answerRun(first, choiceId: "confirm").operation == nil)
        let expired = make(h)
        await expired.load(runId: await h.server.requestAccountOperation("issue_recovery_kit"))
        guard case .question(let q) = expired.state else { Issue.record("expected the question"); return }
        clock.advance(11 * 60) // questions expire after 10 minutes
        await expired.answer(q.choices[0])
        #expect(expired.state == .expired)
        #expect(await h.server.issuedRecoveryCodes.isEmpty)
        // A request already answered elsewhere is not offered again.
        let again = make(h)
        await again.load(runId: first)
        #expect(again.state == .notWaiting("This request is no longer waiting for you."))
    }

    @Test func aRepeatedConfirmationReplaysTheSameLink() async throws {
        let h = try Harness.make()
        let runId = await h.server.requestAccountOperation("export_data")
        let first = try await h.env.api.answerRun(runId, choiceId: "confirm")
        let second = try await h.env.api.answerRun(runId, choiceId: "confirm")
        #expect(first.operation?.replayed == false)
        #expect(second.operation?.replayed == true)
        guard case .export(let a) = first.operation?.outcome, case .export(let b) = second.operation?.outcome else { Issue.record("expected exports"); return }
        #expect(a.downloadUrl == b.downloadUrl && a.transferId == b.transferId)
        try ContractExport.write("run-input-response-export", first)
        try ContractExport.write("run-input-response-export-replayed", second)
        try ContractExport.write("export-download-fixture", a)
    }

    @Test func linksAreOnlyAcceptedFromThisGarderobeAndExpireOnThePhoneToo() async throws {
        let h = try Harness.make()
        let base = h.env.api.baseURL
        #expect(AccountRequestViewModel.runId(from: URL(string: "\(Self.origin)/confirm/run_mcp7")!, apiBase: base) == "run_mcp7")
        #expect(AccountRequestViewModel.runId(from: URL(string: "garderobe://confirm/run_mcp7")!, apiBase: base) == "run_mcp7")
        #expect(AccountRequestViewModel.runId(from: URL(string: "https://evil.example/confirm/run_mcp7")!, apiBase: base) == nil)
        #expect(AccountRequestViewModel.runId(from: URL(string: "http://test.garderobe.invalid/confirm/run_mcp7")!, apiBase: base) == nil)
        #expect(AccountRequestViewModel.runId(from: URL(string: "\(Self.origin)/confirm/run_mcp7/extra")!, apiBase: base) == nil)
        #expect(AccountRequestViewModel.runId(from: URL(string: "\(Self.origin)/confirm/%2e%2e")!, apiBase: base) == nil)
        #expect(AccountRequestViewModel.runId(from: URL(string: "garderobe://settings/run_mcp7")!, apiBase: base) == nil)
        let vm = make(h)
        #expect(await vm.open(URL(string: "https://evil.example/confirm/run_mcp7")!) == false)
        // A download link for another host is never requested with the owner's session.
        let before = await h.server.requests(matching: "/v1/export").count
        await #expect(throws: APIError.rejected(code: "untrusted_link", message: "That link is not a Garderobe link for this account", status: 400)) {
            _ = try await h.env.api.downloadExport("https://evil.example/v1/export/downloads/xfr_1?t=abc")
        }
        await #expect(throws: APIError.self) { _ = try await h.env.api.collectRecoveryCode("\(Self.origin)/v1/export/downloads/xfr_1?t=abc") }
        await #expect(throws: APIError.self) { _ = try await h.env.api.downloadExport("\(Self.origin)/v1/export/downloads/xfr_1") } // no token
        #expect(await h.server.requests(matching: "/v1/export").count == before)
        // A tampered token is refused by the server.
        let runId = await h.server.requestAccountOperation("export_data")
        let result = try await h.env.api.answerRun(runId, choiceId: "confirm")
        guard case .export(let e) = result.operation?.outcome, let link = e.downloadUrl else { Issue.record("expected an export"); return }
        let tampered = link.replacingOccurrences(of: try token(in: link), with: "forged")
        await #expect(throws: APIError.self) { _ = try await h.env.api.downloadExport(tampered) }
        #expect(await h.server.exportDownloads == 0)
    }

    @Test func anExpiredLinkIsNotOpened() async throws {
        let clock = NativeAuthTests.TestClock()
        let h = try Harness.make(server: FixtureServer(now: { clock.now() }))
        let vm = make(h)
        await vm.load(runId: await h.server.requestAccountOperation("export_data"))
        guard case .question(let q) = vm.state else { Issue.record("expected the question"); return }
        await vm.answer(q.choices[0])
        #expect(!vm.isLinkExpired)
        clock.advance(16 * 60)
        // The harness environment's clock is fixed, so ask the server directly after expiry as well.
        guard case .export(let e) = vm.outcome, let link = e.downloadUrl else { Issue.record("expected an export"); return }
        await #expect(throws: APIError.rejected(code: "link_expired", message: "This export link has expired; request a new export", status: 410)) {
            _ = try await h.env.api.downloadExport(link)
        }
        await vm.saveExport()
        #expect(vm.linkError == "This export link has expired; request a new export")
        #expect(vm.exportFile == nil)
    }

    @Test func confirmingInsideConversationHandsTheResultToTheAccountSheetNotTheTranscript() async throws {
        let h = try Harness.make()
        let app = AppModel(env: h.env)
        let conv = app.conversation
        conv.draft = "[export] Could you get me an export?"
        await conv.send()
        let q = try #require(conv.needsInput)
        #expect(q.prompt.hasPrefix("Confirm: export"))
        await conv.answer(try #require(q.choices.first { $0.id == "confirm" }))
        #expect(app.sheet == .accountRequest)
        guard case .export(let e) = app.accountRequest.outcome else { Issue.record("expected the export in the account sheet, got \(app.accountRequest.state)"); return }
        let secret = try token(in: e.downloadUrl)
        #expect(conv.messages.allSatisfy { !$0.plainText.contains(secret) && !$0.plainText.contains("/v1/export/downloads/") })
        #expect(!persisted(h).contains(secret))
        #expect(!conv.isReplying)
    }

    @Test func anOpenedConfirmationLinkShowsTheQuestion() async throws {
        let h = try Harness.make()
        let app = AppModel(env: h.env)
        let runId = await h.server.requestAccountOperation("issue_recovery_kit")
        #expect(await app.handle(url: URL(string: "garderobe://confirm/\(runId)")!))
        #expect(app.sheet == .accountRequest)
        guard case .question = app.accountRequest.state else { Issue.record("expected the question"); return }
        #expect(await app.handle(url: URL(string: "garderobe://settings")!) == false)
    }

    @Test func aNewRecoveryCodeCanBeCreatedInSettingsAndIsShownOnce() async throws {
        let h = try Harness.make()
        let settings = SettingsViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await settings.createRecoveryCode()
        let code = try #require(settings.newRecoveryCode)
        #expect(code.credential == (await h.server.issuedRecoveryCodes.last))
        #expect(settings.recovery?.activeKitIssuedAt == Fixtures.demoNow)
        let stored = h.store.keys.compactMap { h.store.data(forKey: $0) }.map { String(decoding: $0, as: UTF8.self) }.joined()
        #expect(!stored.contains(code.credential))
        settings.forgetNewRecoveryCode()
        #expect(settings.newRecoveryCode == nil)
        try ContractExport.write("recovery-kit-response-created", code)
    }

    @Test func aCodeThatArrivesAfterSettingsClosedIsNotKept() async throws {
        let server = try FixtureServer(now: { Fixtures.demoNow })
        let gate = RequestGate()
        let transport = GatedTransport(inner: server, gate: gate, method: "POST", pathPrefix: "/v1/auth/recovery-kit")
        let env = AppEnvironment(api: APIClient(baseURL: URL(string: "https://test.garderobe.invalid")!, transport: transport), store: MemoryClientStore(),
                                 now: { Fixtures.demoNow }, sleep: { _ in await Task.yield() })
        let settings = SettingsViewModel(env: env, queue: CommandQueue(env: env))
        let creating = Task { await settings.createRecoveryCode() }
        await eventually("the creation is in flight") { await gate.waiting == 1 }
        #expect(settings.isCreatingRecoveryCode)
        settings.forgetNewRecoveryCode() // Settings is dismissed before the code arrives
        await gate.release()
        await creating.value
        let issued = try #require(await server.issuedRecoveryCodes.last)
        // The late credential is not kept in the long-lived model, and reopening Settings says what happened.
        #expect(settings.newRecoveryCode == nil)
        #expect(!settings.isCreatingRecoveryCode)
        #expect(settings.recoveryNotes.first == "A new recovery code was created after Settings closed, so it wasn't kept on this phone. Create another one to see it.")
        #expect(!settings.recoveryNotes.joined().contains(issued))
        // Creating again shows the new code as usual and clears the note.
        await settings.createRecoveryCode()
        #expect(settings.newRecoveryCode?.credential == (await server.issuedRecoveryCodes.last))
        #expect(settings.discardedRecoveryCodeNote == nil)
    }

    @Test func settingsShowRecoveryStatusAndRecentTransfersWithoutSecrets() async throws {
        let h = try Harness.make()
        let settings = SettingsViewModel(env: h.env, queue: CommandQueue(env: h.env))
        await settings.refresh()
        #expect(settings.recoveryLine == "A recovery code was issued on 14 September 2026")
        #expect(settings.recoveryNotes.isEmpty)
        let row = try #require(settings.transferRows.first)
        #expect(row.title == "Export")
        #expect(row.detail.hasPrefix("Downloaded · from the app · "))
        // A pending collection is announced; failed attempts are counted.
        _ = try await h.env.api.answerRun(await h.server.requestAccountOperation("issue_recovery_kit"), choiceId: "confirm")
        await settings.refreshAccount()
        #expect(settings.recoveryNotes.first?.hasPrefix("A new code is waiting to be collected until") == true)
        #expect(settings.transferRows.first?.detail.hasPrefix("Waiting to be collected · asked for by an assistant") == true)
        try ContractExport.write("recovery-status-fixture", try await h.env.api.recoveryStatus())
        try ContractExport.write("account-transfers-fixture", try await h.env.api.accountTransfers())
        // Offline: the rest of Settings keeps working and the section says why it is empty.
        await h.server.setOffline(true)
        await settings.refreshAccount()
        #expect(settings.accountError == "Recovery status needs a connection")
    }

    @Test func operationResultsAndRecoveryCodesEncodeToTheirContracts() async throws {
        let h = try Harness.make()
        let recovery = try await h.env.api.answerRun(await h.server.requestAccountOperation("issue_recovery_kit"), choiceId: "confirm")
        guard case .recoveryKit(let k) = recovery.operation?.outcome else { Issue.record("expected a recovery link"); return }
        try ContractExport.write("recovery-kit-link-fixture", k)
        try ContractExport.write("run-input-response-recovery", recovery)
        try ContractExport.write("recovery-kit-response-fixture", try await h.env.api.collectRecoveryCode(try #require(k.collectUrl)))
        let imported = try await h.env.api.answerRun(await h.server.requestAccountOperation("import_data"), choiceId: "confirm")
        guard case .imported(let i) = imported.operation?.outcome else { Issue.record("expected an import"); return }
        try ContractExport.write("mcp-import-fixture", i)
        try ContractExport.write("run-input-response-import", imported)
        try ContractExport.write("staged-import-example", StagedImportPackage(packageId: "imp_example1", exportId: "exp_source01", exportedAt: "2026-09-30T18:10:00.000Z", sourceDisplayName: nil, tables: [TableCount(name: "garments", rows: 144)], status: "staged", expiresAt: Fixtures.demoNow))
        // Tolerance: an operation this app version does not know is kept by name, and a staged package decodes.
        let unknown = AccountOperationReceipt(operation: "future_thing", idempotencyKey: nil, replayed: false, result: [:])
        #expect(unknown.outcome == .unknown("future_thing"))
    }
}
