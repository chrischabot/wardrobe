import Foundation
import Testing
@testable import GarderobeKit

/// The owner's review of what a connected assistant asked for. The journey replays a recording
/// of the real Worker (two requests relayed through a real MCP connection; see the cassette's
/// provenance). The boundary tests below it use SYNTHETIC data.
@MainActor
@Suite("Journey: requests from a connected assistant, confirmed or rejected by the owner")
struct OwnerProposalsJourney {
    @Test("Each request shows its source and exact effect; confirming returns the backend's receipt, rejecting changes nothing")
    func confirmAndReject() async throws {
        let j = try Journey("owner-proposals")
        let model = ProposalsModel(environment: j.environment)
        await model.open()
        #expect(model.pendingCount == 3)
        #expect(model.decided.isEmpty)

        let add = try #require(model.pending.first { $0.type == "garment.create" })
        let retire = try #require(model.pending.first { $0.type == "garment.retire" && !$0.turnId.isEmpty })
        // Sent as a typed command, so there is no conversation turn behind it; shown like the others.
        let stale = try #require(model.pending.first { $0.type == "garment.retire" && $0.turnId.isEmpty })
        #expect(stale.payload["garmentId"]?.stringValue != retire.payload["garmentId"]?.stringValue)
        #expect(model.sourceLine(add).hasPrefix("Asked through Connected assistant (fixture), "))
        #expect(model.stateLine(add) == "Waiting for your decision. Nothing has been changed.")
        // The exact command and its fields, as the backend holds them.
        let effect = model.effect(add)
        #expect(effect.first == ProposalsModel.EffectLine(label: "Command", value: "garment.create"))
        #expect(effect.contains(ProposalsModel.EffectLine(label: "Name", value: "Navy merino cardigan (FIXTURE, relayed request)")))
        #expect(effect.contains(ProposalsModel.EffectLine(label: "Category", value: "knitwear")))
        #expect(model.effect(retire).contains { $0.label == "Garment id" && $0.value == retire.payload["garmentId"]?.stringValue })

        // Confirm: the backend ran the command once, as the owner's own action, and says so in a receipt.
        let receipt = try #require(await model.confirm(add))
        #expect(receipt.type == "garment.create" && receipt.outcome == .committed)
        #expect(receipt.actor == .owner)
        #expect(model.confirmedReceipts[add.proposalId]?.commandId == receipt.commandId)
        #expect(j.environment.center.receipts.first?.id == receipt.commandId)       // it joins the receipt history
        #expect(Set(model.pending.map(\.proposalId)) == [retire.proposalId, stale.proposalId])
        let confirmed = try #require(model.decided.first { $0.proposalId == add.proposalId })
        #expect(confirmed.state == .confirmed && confirmed.commandId == receipt.commandId)
        #expect(!model.canConfirm(confirmed) && !model.canReject(confirmed))

        // Reject: no receipt, nothing changed.
        let receiptsBefore = j.environment.center.receipts.count
        let rejected = await model.reject(retire)
        #expect(rejected)
        #expect(j.environment.center.receipts.count == receiptsBefore)
        #expect(model.pendingCount == 1)
        #expect(model.decided.first { $0.proposalId == retire.proposalId }?.state == .rejected)
        #expect(model.stateLine(try #require(model.decided.first { $0.proposalId == retire.proposalId })) == "Rejected by you. Nothing was changed.")

        // The third request was made against a garment version that has since changed.
        #expect(model.pending.map(\.proposalId) == [stale.proposalId])
        #expect(model.sourceLine(stale).hasPrefix("Asked through Connected assistant (fixture), "))
        #expect(model.canConfirm(stale))
        let receiptsBeforeStale = j.environment.center.receipts.count
        let refused = await model.confirm(stale)
        #expect(refused == nil)                                          // the backend answered 409: nothing was applied
        #expect(j.environment.center.receipts.count == receiptsBeforeStale)
        #expect(model.message == "That request no longer applies: what it would change has changed since it was asked for. Nothing was changed.")
        #expect(model.pendingCount == 1 && model.isStale(stale))         // still open on the backend
        #expect(!model.canConfirm(stale) && model.canReject(stale))
        #expect(model.stateLine(stale) == "No longer applies: what it would change has changed since it was asked for. Nothing was changed. You can reject it.")
        // Confirm is not sent a second time, and a relaunch still knows the request is out of date.
        let decisionsSent = j.backend.log.filter { $0.path.hasSuffix("/decision") }.count
        let again = await model.confirm(stale)
        #expect(again == nil && j.backend.log.filter { $0.path.hasSuffix("/decision") }.count == decisionsSent)
        let relaunched = ProposalsModel(environment: j.relaunch())
        await relaunched.open()
        #expect(relaunched.isStale(try #require(relaunched.pending.first)))
        let dropped = await relaunched.reject(stale)
        #expect(dropped && relaunched.pendingCount == 0 && relaunched.staleIds.isEmpty)
        #expect(relaunched.decided.first { $0.proposalId == stale.proposalId }?.state == .rejected)

        #expect(j.backend.log.allSatisfy { $0.path != "/v1/commands" })              // the phone never sends the proposed command itself
        #expect(j.backend.isAtEnd)
        #expect(j.backend.unexpected.isEmpty, "requests the real backend never answered: \(j.backend.unexpected)")
    }
}

@MainActor
@Suite("Proposals: refusals, expiry and offline")
struct ProposalBoundaryTests {
    private func proposal(_ id: String, state: String = "pending", assistant: JSONValue = "Test assistant", payload: JSONValue = ["restrictionId": "rst_test", "lifted": true, "note": .null]) -> JSONValue {
        ["proposalId": .string(id), "turnId": "run_test", "type": "restriction.resolve", "summary": "Test: lift the sneakers restriction", "payload": payload,
         "proposedAt": "2026-09-15T06:00:00Z", "expiresAt": "2026-09-29T06:00:00Z", "source": ["channel": "mcp", "assistantName": assistant],
         "state": .string(state), "decidedAt": .null, "commandId": .null]
    }
    private func list(_ proposals: [JSONValue]) -> JSONValue {
        ["proposals": .array(proposals), "pending": .integer(proposals.count), "readAt": .string(Synthetic.now)]
    }

    @Test("A change the ledger refuses stays pending and the refusal is shown; no receipt is invented")
    func refusedConfirmStaysPending() async throws {
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/proposals", list([proposal("prp_test_1")]))
        router.on("POST", "/v1/proposals/prp_test_1/decision") { _ in TestSupport.error("precondition_failed", "That restriction is already resolved.", status: 412) }
        let env = TestSupport.environment(transport: transport)
        let model = ProposalsModel(environment: env)
        await model.open()
        let pending = try #require(model.pending.first)
        #expect(model.effect(pending).map(\.label) == ["Command", "Lifted", "Restriction id"])   // a null field is not shown as a value
        #expect(model.effect(pending).first { $0.label == "Lifted" }?.value == "Yes")

        let receipt = await model.confirm(pending)
        #expect(receipt == nil)
        #expect(model.message == "That restriction is already resolved.")
        #expect(model.pendingCount == 1)
        #expect(env.center.receipts.isEmpty && model.confirmedReceipts.isEmpty)
        #expect(TestSupport.body(try #require(transport.requests("POST", "/v1/proposals/prp_test_1/decision").first)) == ["decision": "confirm"])
    }

    @Test("Offline, a decision is not queued and nothing is sent later; an expired request can only be rejected")
    func offlineAndExpired() async throws {
        let router = Router()
        let transport = router.transport
        let store = InMemoryKeyValueStore()
        router.json("GET", "/v1/proposals", list([proposal("prp_test_1"), proposal("prp_test_old", state: "expired", assistant: .null)]))
        await ProposalsModel(environment: TestSupport.environment(transport: transport, store: store)).open()

        router.offline.value = true
        let env = TestSupport.environment(transport: transport, store: store)
        let model = ProposalsModel(environment: env)
        await model.open()
        #expect(model.pendingCount == 1)                                 // the saved list is shown
        #expect(model.freshnessLine.hasPrefix("Offline."))
        let receipt = await model.confirm(try #require(model.pending.first))
        #expect(receipt == nil)
        #expect(model.message == "Offline. A decision needs a connection; nothing was sent.")
        #expect(env.center.pending.isEmpty)                              // never queued for later

        let expired = try #require(model.decided.first)
        #expect(model.sourceLine(expired).hasPrefix("Asked through a connected assistant, "))
        #expect(!model.canConfirm(expired) && model.canReject(expired))
        let none = await model.confirm(expired)
        #expect(none == nil)
        #expect(transport.requests("POST", "/v1/proposals/prp_test_old/decision").isEmpty)
    }

    @Test("Only the backend's conflict answer marks a request as out of date; any other refusal is shown in its own words")
    func staleOnlyOnConflict() async throws {
        let router = Router()
        let transport = router.transport
        router.json("GET", "/v1/proposals", list([proposal("prp_test_1")]))
        let env = TestSupport.environment(transport: transport)
        let model = ProposalsModel(environment: env)
        await model.open()
        let pending = try #require(model.pending.first)

        // Decided on another device in the meantime: a refusal, not a stale request, whatever its status.
        router.on("POST", "/v1/proposals/prp_test_1/decision") { _ in TestSupport.error("precondition_failed", "this proposal was already rejected", status: 409) }
        let elsewhere = await model.confirm(pending)
        #expect(elsewhere == nil && model.message == "this proposal was already rejected")
        #expect(!model.isStale(pending) && model.staleIds.isEmpty && model.canConfirm(pending))

        // A 409 that is not the contract's answer says nothing about the request.
        router.on("POST", "/v1/proposals/prp_test_1/decision") { _ in HTTPResponse(status: 409) }
        let bare = await model.confirm(pending)
        #expect(bare == nil && model.message == "The server answered with status 409.")
        #expect(!model.isStale(pending))

        // The command service's conflict: what the request names has changed since it was made.
        router.on("POST", "/v1/proposals/prp_test_1/decision") { _ in TestSupport.error("conflict", "The garment has changed since this was asked for.", status: 409) }
        let stale = await model.confirm(pending)
        #expect(stale == nil && model.isStale(pending) && !model.canConfirm(pending) && model.canReject(pending))
        #expect(model.message == "That request no longer applies: what it would change has changed since it was asked for. Nothing was changed.")
        #expect(env.center.receipts.isEmpty)
    }
}
