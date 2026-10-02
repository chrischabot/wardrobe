import SwiftUI
import GarderobeKit

/// A verified receipt: what was recorded, what it means for Calendar, and Undo when the
/// backend says the action is reversible. Undo is a new compensating command; a receipt is
/// never deleted.
struct ReceiptCard: View {
    @Environment(AppModel.self) private var app
    let record: ReceiptRecord
    @State private var isUndoing = false
    @State private var undoOutcome: SubmissionOutcome?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Label {
                Text(record.receipt.summary).font(.subheadline)
            } icon: {
                Image(systemName: record.undoneBy == nil ? "checkmark.seal" : "arrow.uturn.backward.circle")
            }
            Text(detailLine)
                .font(.caption)
                .foregroundStyle(Color.supporting)
            ForEach(record.receipt.repairs, id: \.self) { repair in
                Text(repair).font(.caption).foregroundStyle(Color.supporting)
            }
            if let external = Phrases.externalEffect(record.receipt) {
                Text(external).font(.caption).foregroundStyle(Color.supporting)
            }
            if record.undoneBy != nil {
                Text("Undone.").font(.caption).foregroundStyle(Color.supporting)
            } else if record.receipt.undo.available {
                Button {
                    Task {
                        isUndoing = true
                        undoOutcome = await app.environment.center.undo(record)
                        isUndoing = false
                    }
                } label: {
                    Label("Undo", systemImage: "arrow.uturn.backward")
                }
                .secondaryAction()
                .disabled(isUndoing)
                .accessibilityHint(Phrases.undoLine(record.receipt))
            } else {
                Text(Phrases.undoLine(record.receipt)).font(.caption).foregroundStyle(Color.supporting)
            }
            OutcomeLine(outcome: undoOutcome)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface(padding: Metrics.unit * 3)
        .accessibilityElement(children: .contain)
    }

    private var detailLine: String {
        let now = app.environment.time.now()
        let zone = app.environment.timeZone
        let when = Dates.parseInstant(record.receipt.occurredAt).map { Phrases.relativeTime($0, now: now, timeZone: zone) } ?? record.receipt.occurredAt
        return "\(Phrases.receiptOutcome(record.receipt)) \(when)"
    }
}

/// The eight-second undo banner. It disappears on its own schedule; the receipt and its undo
/// remain in item history and the activity list.
struct UndoBannerView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let center = app.environment.center
        if let banner = center.banner {
            HStack(spacing: Metrics.unit * 3) {
                Text(banner.record.receipt.summary)
                    .font(.subheadline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Undo") { Task { await center.undo(banner.record) } }
                    .fontWeight(.semibold)
                    .touchTarget()
                    .accessibilityIdentifier(AXID.undoButton)
                Button { center.dismissBanner() } label: { Image(systemName: "xmark") }
                    .touchTarget()
                    .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, Metrics.inset)
            .padding(.vertical, Metrics.unit * 2)
            .background(bannerBackground, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).strokeBorder(Color(.separator), lineWidth: 0.5) }
            .padding(.horizontal, Metrics.inset)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AXID.undoBanner)
            .task(id: banner.record.id) {
                // Announce it, then let it lapse after its eight seconds.
                AccessibilityNotification.Announcement("\(banner.record.receipt.summary). Undo available.").post()
                let remaining = banner.expiresAt.timeIntervalSince(app.environment.time.now())
                if remaining > 0 { try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) }
                // The eight seconds are counted here, on the device's own clock.
                if !Task.isCancelled, center.banner?.record.id == banner.record.id { center.dismissBanner() }
            }
        }
    }

    private var bannerBackground: AnyShapeStyle {
        reduceTransparency ? AnyShapeStyle(Color(.secondarySystemBackground)) : AnyShapeStyle(.regularMaterial)
    }
}

/// The one-line status shown on every destination while the app is offline, signed out, in
/// demo mode, or holding unsent or refused actions. Tapping it opens the pending list.
struct StatusBannerView: View {
    @Environment(AppModel.self) private var app
    @State private var showsPending = false

    var body: some View {
        if let text = app.statusBanner {
            Button { showsPending = true } label: {
                Label(text, systemImage: app.environment.isDemo ? "theatermasks" : (app.environment.center.isOffline ? "wifi.slash" : "tray.and.arrow.up"))
                    .font(.footnote.weight(.medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Metrics.inset)
                    .padding(.vertical, Metrics.unit * 2)
                    .frame(minHeight: Metrics.touch)
            }
            .buttonStyle(.plain)
            .background(Color(.tertiarySystemFill))
            .accessibilityIdentifier(app.environment.isDemo ? AXID.demoLabel : AXID.statusBanner)
            .accessibilityHint("Shows actions waiting to be sent")
            .sheet(isPresented: $showsPending) { PendingActionsView() }
        }
    }
}

/// Actions saved on this phone that have not been confirmed, and actions the server refused.
struct PendingActionsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var isRetrying = false

    var body: some View {
        let center = app.environment.center
        NavigationStack {
            List {
                if app.environment.isDemo {
                    Section { Text("You are looking at demo data recorded from a real backend run. Changes are not saved.") }
                }
                Section("Waiting to be sent") {
                    if center.pending.isEmpty { Text("Nothing is waiting.").foregroundStyle(Color.supporting) }
                    ForEach(center.pending) { command in
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(command.label)
                            Text("Saved \(Phrases.relativeTime(command.createdAt, now: app.environment.time.now(), timeZone: app.environment.timeZone)). Not yet recorded on the server.")
                                .font(.caption).foregroundStyle(Color.supporting)
                        }
                    }
                    ForEach(app.composer.pending.filter { $0.state == .waitingToSend }) { turn in
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(turn.text)
                            Text("Message waiting to be sent.").font(.caption).foregroundStyle(Color.supporting)
                        }
                    }
                }
                if !center.rejected.isEmpty {
                    Section("Not recorded") {
                        ForEach(center.rejected) { command in
                            VStack(alignment: .leading, spacing: Metrics.unit) {
                                Text(command.label)
                                Text(command.rejection?.message ?? "The server refused this.").font(.caption).foregroundStyle(Color.supporting)
                                Button("Dismiss") { Task { await center.dismissRejected(command.id) } }
                                    .buttonStyle(.borderless)
                            }
                        }
                    }
                }
                Section {
                    Button {
                        Task { isRetrying = true; await app.becameActive(); isRetrying = false }
                    } label: {
                        Label(isRetrying ? "Sending..." : "Send now", systemImage: "arrow.clockwise")
                    }
                    .disabled(isRetrying || app.unsentCount == 0)
                }
            }
            .navigationTitle("Pending")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
