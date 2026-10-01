import SwiftUI
import GarderobeKit

/// Open returns and exchanges. A deadline is shown only when the backend established one from
/// sourced terms; otherwise the row says it is not established. Nothing here counts down a guess.
struct ReturnsScreen: View {
    @Environment(AppModel.self) private var app

    /// The states the owner can report from here, in the order they usually happen.
    private static let reportable: [ReturnCaseState] = [.requested, .labelReady, .posted, .retailerReceived, .refunded, .exchanged, .closed, .cancelled]

    var body: some View {
        let returns = app.returns
        List {
            Section {
                FreshnessLabel(text: returns.freshnessLine, freshness: returns.returns.freshness)
                OutcomeLine(outcome: returns.lastOutcome)
            }
            ForEach(returns.openCases) { item in
                caseSection(item)
            }
            // Only say there are none once the list has actually been read (live or from the cache).
            if returns.openCases.isEmpty, returns.returns.value != nil {
                Section {
                    Text("No open returns or exchanges.").foregroundStyle(.secondary)
                } footer: {
                    Text("A return or exchange can be started in Conversation.")
                }
            }
            Section {
                NavigationLink(value: AppRoute.projects) { Label("Consignment, tailoring and other projects", systemImage: "folder") }
            }
        }
        .navigationTitle("Returns and exchanges")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await returns.returns.refresh() }
        .task { await returns.open() }
    }

    private func caseSection(_ item: ReturnCase) -> some View {
        let returns = app.returns
        let established = item.deadline.status == .established
        return Section {
            // Text and symbol together: an unresolved deadline is never just a different colour.
            Label(returns.deadlineLine(item), systemImage: established ? "calendar" : "questionmark.circle")
                .font(.headline)
            if let terms = returns.termsLine(item) {
                Text(terms).font(.subheadline).foregroundStyle(.secondary)
            }
            if let next = item.nextAction { LabeledContent("Next", value: next) }
            LabeledContent("State", value: Self.name(item.state))
            Group {
                if let label = item.labelRef { LabeledContent("Label", value: label) }
                if let collection = item.collectionPreference { LabeledContent("Collection", value: collection) }
                if let shipment = item.shipmentRef { LabeledContent("Shipment", value: shipment) }
                if let received = item.retailerReceivedOn { LabeledContent("Reached the retailer", value: Phrases.dayMonth(received)) }
                if let refund = returns.refundLine(item) { Text(refund) }
            }
            Text(returns.stockLine(item)).font(.subheadline).foregroundStyle(.secondary)
            if let garmentId = item.garmentId {
                NavigationLink(value: AppRoute.item(garmentId: garmentId)) { Label("Open the item", systemImage: "hanger") }
            }
            Menu {
                ForEach(Self.reportable.filter { $0 != item.state }, id: \.self) { state in
                    Button(Self.name(state)) { Task { await returns.update(item, state: state) } }
                }
            } label: {
                Label("Update state", systemImage: "arrow.right.circle")
            }
            .accessibilityHint("Reports where this \(item.kind == .exchange ? "exchange" : "return") has got to.")
        } header: {
            Text(title(item))
        }
    }

    /// `Exchange of 2, order 1234`. The case carries no garment name, so the item is linked instead.
    private func title(_ item: ReturnCase) -> String {
        var text = item.kind == .exchange ? "Exchange" : "Return"
        if item.quantity > 1 { text += " of \(item.quantity)" }
        if let order = item.orderId { text += ", order \(order)" }
        return text
    }

    private static func name(_ state: ReturnCaseState) -> String {
        switch state {
        case .considering: return "Considering"
        case .requested: return "Requested"
        case .labelReady: return "Label ready"
        case .posted: return "Posted"
        case .retailerReceived: return "Received by the retailer"
        case .refunded: return "Refunded"
        case .exchanged: return "Exchanged"
        case .closed: return "Closed"
        case .cancelled: return "Cancelled"
        case .unknown: return "A state this version does not recognise"
        }
    }
}
