import SwiftUI
import GarderobeKit

/// Requests from connected assistants that need the owner's decision. Each shows where it came
/// from and the exact command it would run, before Confirm; after a confirmation, the receipt.
struct ProposalsScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let model = app.proposals
        List {
            Section {
                Text("A connected assistant cannot make these changes itself. Nothing happens until you confirm.")
                    .font(.subheadline)
                    .foregroundStyle(Color.supporting)
                SettingsFreshnessLabel(freshness: model.proposals.freshness, subject: "requests")
                SettingsMessageLine(message: model.message)
            }
            if model.pending.isEmpty, model.proposals.value != nil {
                Section { Text("Nothing is waiting for your decision.").foregroundStyle(Color.supporting) }
            }
            ForEach(model.pending, id: \.proposalId) { proposal in
                Section {
                    ProposalDetail(proposal: proposal)
                    if model.canConfirm(proposal) {
                        Button("Confirm") { Task { await model.confirm(proposal) } }
                            .disabled(model.isWorking)
                            .accessibilityHint("Makes this change now, as your own action.")
                            .accessibilityIdentifier(AXID.proposalConfirm(proposal.proposalId))
                    }
                    Button("Reject", role: .destructive) { Task { await model.reject(proposal) } }
                        .disabled(model.isWorking)
                        .accessibilityHint("Discards the request. Nothing is changed.")
                        .accessibilityIdentifier(AXID.proposalReject(proposal.proposalId))
                } header: {
                    Text(proposal.summary)
                }
            }
            if !model.decided.isEmpty {
                Section("Earlier requests") {
                    ForEach(model.decided, id: \.proposalId) { proposal in
                        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                            Text(proposal.summary)
                            Text(model.stateLine(proposal)).font(.footnote).foregroundStyle(Color.supporting)
                            Text(model.sourceLine(proposal)).font(.footnote).foregroundStyle(Color.supporting)
                            if let receipt = model.confirmedReceipts[proposal.proposalId],
                               let record = app.environment.center.receipts.first(where: { $0.id == receipt.commandId }) {
                                ReceiptCard(record: record)
                            }
                            if model.canReject(proposal) {
                                Button("Reject", role: .destructive) { Task { await model.reject(proposal) } }
                                    .disabled(model.isWorking)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Requests to confirm")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.proposals.refresh() }
        .task { await model.open() }
    }
}

/// Where the request came from and the exact command it would run.
private struct ProposalDetail: View {
    @Environment(AppModel.self) private var app
    let proposal: Proposal

    var body: some View {
        let model = app.proposals
        Text(model.sourceLine(proposal)).font(.footnote).foregroundStyle(Color.supporting)
        ForEach(model.effect(proposal)) { line in
            LabeledContent(line.label, value: line.value)
        }
        Text(model.stateLine(proposal)).font(.footnote).foregroundStyle(Color.supporting)
    }
}
