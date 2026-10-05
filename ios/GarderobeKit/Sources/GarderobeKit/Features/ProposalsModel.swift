import Foundation
import Observation

/// Changes a connected assistant (Claude, ChatGPT) asked for but may not make on its own
/// authority. The owner sees each one with where it came from and exactly what it would do,
/// and confirms or rejects it. Confirming runs the proposed command once on the backend, as the
/// owner's tap, and returns its receipt; the phone decides nothing about the change itself.
@MainActor
@Observable
public final class ProposalsModel {
    /// One line of a proposal's exact effect: a field of the proposed command and its value.
    public struct EffectLine: Sendable, Equatable, Identifiable {
        public var label: String
        public var value: String
        public var id: String { label }
    }

    public let environment: AppEnvironment
    public let proposals: Resource<ProposalList>
    public private(set) var isWorking = false
    /// What the backend answered to the last decision, when it refused it.
    public private(set) var message: String?
    /// Receipts of proposals confirmed in this session, by proposal ID, for the receipt card.
    public private(set) var confirmedReceipts: [String: CommandReceipt] = [:]
    /// Proposals the backend refused to confirm because what they would change has changed since
    /// they were made (the answer was a conflict). They stay open on the backend until rejected;
    /// the phone remembers the refusal so Confirm is not offered again for the same request.
    public private(set) var staleIds: Set<String> { didSet { environment.restoration.save("proposals.stale", staleIds.sorted()) } }
    /// Requests the owner decided in this session: their identifiers, grouped by the turn that
    /// asked, the command and the backend's summary. A finished reply names its requests only
    /// by command and summary, so two requests of one turn can read the same; they are told
    /// apart by how many of them have been decided.
    private var settledIds: [String: Set<String>] = [:]

    static func settledKey(turnId: String, type: String, summary: String) -> String { "\(turnId)\u{0}\(type)\u{0}\(summary)" }

    /// How many requests a conversation turn left behind with this command and summary have
    /// been decided (confirmed, rejected or expired), from this session's decisions and the
    /// list as last read. Each request is counted once, by its identifier.
    public func settledCount(turnId: String, type: String, summary: String) -> Int {
        var ids = settledIds[ProposalsModel.settledKey(turnId: turnId, type: type, summary: summary)] ?? []
        for p in proposals.value?.proposals ?? [] where p.turnId == turnId && p.type == type && p.summary == summary && p.state != .pending {
            ids.insert(p.proposalId)
        }
        return ids.count
    }

    public init(environment: AppEnvironment) {
        self.environment = environment
        staleIds = Set(environment.restoration.load("proposals.stale", as: [String].self) ?? [])
        let api = environment.api
        proposals = environment.resource("proposals") { try await api.proposals(ProposalsQuery(state: .all)) }
    }

    /// Shows the saved list at once, then checks it.
    public func open() async {
        proposals.loadCached()
        if await proposals.refresh() { forgetSettledStale() }
    }

    /// A refusal is remembered only while its proposal is still waiting.
    private func forgetSettledStale() {
        let waiting = Set((proposals.value?.proposals ?? []).filter { $0.state == .pending }.map(\.proposalId))
        if !staleIds.isSubset(of: waiting) { staleIds = staleIds.intersection(waiting) }
    }

    /// True when the backend refused to confirm this request because it was made against an older version.
    public func isStale(_ p: Proposal) -> Bool { p.state == .pending && staleIds.contains(p.proposalId) }

    /// Waiting for the owner, oldest first.
    public var pending: [Proposal] { (proposals.value?.proposals ?? []).filter { $0.state == .pending }.sorted { $0.proposedAt < $1.proposedAt } }
    /// Already decided or expired, most recent first.
    public var decided: [Proposal] {
        (proposals.value?.proposals ?? []).filter { $0.state != .pending }.sorted { ($0.decidedAt ?? $0.expiresAt) > ($1.decidedAt ?? $1.expiresAt) }
    }
    public var pendingCount: Int { pending.count }

    /// `Asked through Claude` - where the request came from, in the backend's words.
    public func sourceLine(_ p: Proposal) -> String {
        let via: String
        if let name = p.source.assistantName, !name.isEmpty { via = name }
        else if p.source.channel == "mcp" { via = "a connected assistant" }
        else { via = p.source.channel.replacingOccurrences(of: "_", with: " ") }
        let when = Dates.parseInstant(p.proposedAt).map { Phrases.relativeTime($0, now: environment.time.now(), timeZone: environment.timeZone) } ?? p.proposedAt
        return "Asked through \(via), \(when)."
    }

    public func stateLine(_ p: Proposal) -> String {
        switch p.state {
        case .pending:
            return isStale(p) ? "No longer applies: what it would change has changed since it was asked for. Nothing was changed. You can reject it."
                              : "Waiting for your decision. Nothing has been changed."
        case .confirmed: return "Confirmed by you."
        case .rejected: return "Rejected by you. Nothing was changed."
        case .expired: return "Expired without a decision. Nothing was changed."
        case .unknown: return "In a state this version does not recognise."
        }
    }

    /// An expired proposal can only be rejected, and so can one the backend refused as out of
    /// date; the backend enforces both, this only hides the button.
    public func canConfirm(_ p: Proposal) -> Bool { p.state == .pending && !isStale(p) }
    public func canReject(_ p: Proposal) -> Bool { p.state == .pending || p.state == .expired }

    /// The proposed command, field by field, exactly as the backend holds it. Nothing is
    /// interpreted: nested values are shown as written.
    public func effect(_ p: Proposal) -> [EffectLine] {
        [EffectLine(label: "Command", value: p.type)] + p.payload.keys.sorted().compactMap { key in
            guard let value = p.payload[key], value != .null else { return nil }
            return EffectLine(label: ProposalsModel.label(key), value: ProposalsModel.text(value))
        }
    }

    static func label(_ key: String) -> String {
        var out = ""
        for ch in key { if ch.isUppercase { out += " " + ch.lowercased() } else if ch == "_" { out += " " } else { out.append(ch) } }
        return out.capitalizedFirst
    }

    static func text(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): return s
        case .bool(let b): return b ? "Yes" : "No"
        case .integer(let i): return String(i)
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int(n)) : String(n)
        case .null: return "None"
        case .array(let items): return items.isEmpty ? "None" : items.map(text).joined(separator: ", ")
        case .object(let fields): return fields.keys.sorted().map { "\(label($0)): \(text(fields[$0] ?? .null))" }.joined(separator: "; ")
        }
    }

    /// Confirm: the backend runs the proposed command once and returns its receipt. A command
    /// the ledger refuses leaves the proposal pending and the refusal is shown.
    @discardableResult
    public func confirm(_ p: Proposal) async -> CommandReceipt? {
        guard canConfirm(p) else { return nil }
        let response = await decide(p, .confirm)
        guard let receipt = response?.receipt else { return nil }
        confirmedReceipts[p.proposalId] = receipt
        environment.center.adopt(receipt, label: p.summary)
        return receipt
    }

    /// Reject: nothing is changed.
    @discardableResult
    public func reject(_ p: Proposal) async -> Bool {
        guard canReject(p) else { return false }
        return await decide(p, .reject) != nil
    }

    private func decide(_ p: Proposal, _ decision: ProposalDecisionRequest.Decision) async -> ProposalDecisionResponse? {
        guard !isWorking else { return nil }
        isWorking = true
        defer { isWorking = false }
        message = nil
        do {
            let response = try await environment.api.decideProposal(id: p.proposalId, ProposalDecisionRequest(decision: decision))
            environment.center.noteRead(failure: nil)
            staleIds.remove(p.proposalId)
            if !p.turnId.isEmpty { settledIds[ProposalsModel.settledKey(turnId: p.turnId, type: p.type, summary: p.summary), default: []].insert(p.proposalId) }
            await proposals.refresh()
            return response
        } catch let failure as APIFailure {
            environment.center.noteRead(failure: failure)
            // A decision is never queued: the owner decides on what the backend holds now.
            if decision == .confirm, ProposalsModel.isStaleRefusal(failure) {
                // The request was made against an older version: nothing was applied and it never will be.
                staleIds.insert(p.proposalId)
                message = "That request no longer applies: what it would change has changed since it was asked for. Nothing was changed."
            } else {
                message = failure.isTransport ? "Offline. A decision needs a connection; nothing was sent." : failure.ownerMessage
            }
            if !failure.isTransport, await proposals.refresh() { forgetSettledStale() }
            return nil
        } catch {
            message = "The decision could not be sent."
            return nil
        }
    }

    /// The backend's answer for a request that has gone stale: the contract's `conflict` code,
    /// which the command service gives when what the request names has changed since it was
    /// made. Any other refusal (already decided elsewhere, too old, a rule the change breaks)
    /// is shown in the backend's own words and does not mark the request as out of date.
    static func isStaleRefusal(_ failure: APIFailure) -> Bool {
        if case .api(_, let error) = failure { return error.code == .conflict }
        return false
    }

    public var freshnessLine: String {
        proposals.freshness.statement(subject: "requests", now: environment.time.now(), timeZone: environment.timeZone)
    }
}
