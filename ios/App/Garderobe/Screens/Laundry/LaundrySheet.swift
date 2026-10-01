import SwiftUI
import GarderobeKit

/// Laundry, from Today and Wardrobe. Service laundry and hand-wash are two separate sections.
/// Every button is a command with a receipt; the sheet computes nothing about cleanliness.
struct LaundrySheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var showsReturn = false
    @State private var focusOnExceptions = false

    var body: some View {
        let laundry = app.laundry
        NavigationStack {
            List {
                Section {
                    FreshnessLabel(text: laundry.freshnessLine, freshness: laundry.state.freshness)
                    OutcomeLine(outcome: laundry.lastOutcome)
                }
                waiting(laundry)
                away(laundry)
                handwash(laundry)
            }
            .navigationTitle("Laundry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(isPresented: $showsReturn) { LaundryReturnView(focusOnExceptions: focusOnExceptions) }
            .refreshable { await laundry.state.refresh() }
            .task { await laundry.open() }
        }
    }

    private func waiting(_ laundry: LaundryModel) -> some View {
        Section {
            Text(laundry.serviceSummary).font(.headline)
            ForEach(laundry.awaitingService) { item in
                LabeledContent(item.name, value: "\(item.quantity)")
            }
            Button { Task { await laundry.collected() } } label: { Label("Collected", systemImage: "arrow.up.forward") }
                .disabled(laundry.isSubmitting)
                .accessibilityHint("Records that the service picked up what was waiting.")
                .accessibilityIdentifier(AXID.laundryCollected)
        } header: {
            Text("Service laundry")
        }
    }

    /// Batches the service has collected and not fully returned, oldest first, as the backend lists them.
    @ViewBuilder private func away(_ laundry: LaundryModel) -> some View {
        let batches = laundry.outstandingBatches
        ForEach(batches) { batch in
            Section {
                ForEach(batch.items) { item in
                    LabeledContent(item.name, value: sent(item))
                }
                returnButtons(batchId: batch.batchId, isFirst: batch.batchId == batches.first?.batchId)
            } header: {
                Text("Service laundry: \(laundry.batchTitle(batch))")
            }
        }
        Section {
            if batches.isEmpty {
                Text("No collected batch is recorded as away.").foregroundStyle(.secondary)
                returnButtons(batchId: nil, isFirst: true)
            }
            Menu {
                Button("Return delayed") { Task { await laundry.reportCycleException(.delayed) } }
                Button("Return missed") { Task { await laundry.reportCycleException(.missedReturn) } }
            } label: {
                Label("This week's return is late", systemImage: "calendar.badge.exclamationmark")
            }
            .disabled(laundry.isSubmitting)
        } footer: {
            Text("A reported delay or missed return takes precedence over the usual weekly reset. It does not create a task.")
        }
    }

    /// Returned and Some items still away open the same return view, which starts from the batch's contents.
    @ViewBuilder private func returnButtons(batchId: String?, isFirst: Bool) -> some View {
        Button { openReturn(batchId, exceptions: false) } label: { Label("Returned", systemImage: "arrow.down.backward") }
            .disabled(batchId == nil || app.laundry.isSubmitting)
            .accessibilityHint("Shows what went out in this batch, ready to confirm.")
            .accessibilityIdentifier(isFirst ? AXID.laundryReturned : "\(AXID.laundryReturned).\(batchId ?? "")")
        Button { openReturn(batchId, exceptions: true) } label: { Label("Some items still away", systemImage: "clock.arrow.circlepath") }
            .disabled(batchId == nil || app.laundry.isSubmitting)
            .accessibilityHint("Shows what went out in this batch, so you can mark what did not come back.")
            .accessibilityIdentifier(isFirst ? AXID.laundryStillAway : "\(AXID.laundryStillAway).\(batchId ?? "")")
    }

    private func handwash(_ laundry: LaundryModel) -> some View {
        Section {
            Text(laundry.handwashSummary).font(.headline)
            ForEach(laundry.awaitingHandwash) { item in
                LabeledContent(item.name, value: "\(item.quantity)")
            }
            Button { Task { await laundry.handwashDone() } } label: { Label("Socks washed", systemImage: "drop") }
                .disabled(laundry.isSubmitting)
                .accessibilityHint("Records everything waiting to be hand-washed as washed.")
                .accessibilityIdentifier(AXID.laundrySocksWashed)
        } header: {
            Text("Hand-wash")
        }
    }

    /// The backend's own figures for a batch line, as reported.
    private func sent(_ item: LaundryStateResponse.BatchesItem.ItemsItem) -> String {
        var parts = ["\(item.quantity) sent"]
        if item.returnedQuantity > 0 { parts.append("\(item.returnedQuantity) back") }
        if item.stillAway > 0 { parts.append("\(item.stillAway) reported still away") }
        return parts.joined(separator: ", ")
    }

    private func openReturn(_ batchId: String?, exceptions: Bool) {
        guard let batchId else { return }
        app.laundry.beginReturn(batchId: batchId)
        focusOnExceptions = exceptions
        showsReturn = app.laundry.returnDraft != nil
    }
}
