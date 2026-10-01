import SwiftUI
import GarderobeKit

/// The return view. It starts from what actually went out in the batch, with everything taken
/// as returned; the owner only marks exceptions, by quantity. The list is never rebuilt by
/// hand and identical items (sock pairs) are counted, never picked out.
struct LaundryReturnView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// Opened from "Some items still away": the lines lead and the confirmation follows.
    var focusOnExceptions = false
    @State private var attempted = false

    var body: some View {
        let laundry = app.laundry
        List {
            if let draft = laundry.returnDraft {
                if !focusOnExceptions { confirmation(draft) }
                Section {
                    ForEach(draft.lines) { line in row(line) }
                } header: {
                    Text(focusOnExceptions ? "What is still away?" : "What went out")
                } footer: {
                    Text("This is what the service collected in this batch. Everything counts as returned unless you set a number still away.")
                }
                if focusOnExceptions { confirmation(draft) }
            } else {
                Section {
                    Text("There is no collected batch waiting to be returned.").foregroundStyle(.secondary)
                    if attempted { OutcomeLine(outcome: laundry.lastOutcome) }
                }
            }
        }
        .navigationTitle(focusOnExceptions ? "Some items still away" : "Laundry returned")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ line: LaundryModel.ReturnDraft.Line) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Text(line.name)
            Text("\(line.outstanding) out")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Stepper(value: Binding(
                get: { line.stillAway },
                set: { app.laundry.setStillAway(garmentId: line.garmentId, quantity: $0) }), in: 0...line.outstanding) {
                Text(line.stillAway == 0 ? "None still away" : "\(line.stillAway) still away")
            }
            .accessibilityLabel("\(line.name), still away")
            .accessibilityValue("\(line.stillAway) of \(line.outstanding)")
        }
        .padding(.vertical, Metrics.unit)
    }

    private func confirmation(_ draft: LaundryModel.ReturnDraft) -> some View {
        Section {
            Button { Task { await confirm() } } label: {
                Label(draft.hasExceptions ? "Confirm, with items still away" : "Confirm: everything is back", systemImage: "checkmark")
            }
            .disabled(app.laundry.isSubmitting)
            .accessibilityIdentifier(AXID.laundryConfirmReturn)
            if attempted { OutcomeLine(outcome: app.laundry.lastOutcome) }
        } footer: {
            Text("Confirming returns only this batch's contents, less anything marked still away.")
        }
    }

    private func confirm() async {
        let outcome = await app.laundry.confirmReturn()
        attempted = true
        switch outcome {
        case .confirmed?, .queued?: dismiss() // the Laundry sheet shows the outcome line
        default: break
        }
    }
}
