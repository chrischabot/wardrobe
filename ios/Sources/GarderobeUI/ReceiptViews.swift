#if os(iOS)
import SwiftUI
import GarderobeKit

/// The short-lived receipt banner (8 s, Undo). The receipt stays accessible afterwards.
struct ReceiptBannerView: View {
    @Environment(AppModel.self) private var app
    let banner: ReceiptCenter.Banner
    @AccessibilityFocusState private var focused: Bool

    var body: some View {
        let r = banner.receipt
        HStack(alignment: .firstTextBaseline, spacing: Spacing.m) {
            Image(systemName: r.outcome.didCommit ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(r.outcome.didCommit ? Color.accentColor : .orange)
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(verbatim: r.outcome.didCommit ? r.summary : (r.error?.message ?? r.summary)).font(.subheadline)
                if let note = app.receipts.externalEffectNote(for: r) { Text(note).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            if app.receipts.undoState(for: r) == .available {
                Button("Undo") { Task { await app.undo(r) } }
                    .buttonStyle(.borderless).fontWeight(.semibold).minimumTarget()
                    .accessibilityIdentifier("banner.undo")
            }
            Button { app.receipts.dismissBanner() } label: { Image(systemName: "xmark") }
                .buttonStyle(.borderless).minimumTarget()
                .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, Spacing.l).padding(.vertical, Spacing.s)
        .controlSurface(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.horizontal, Spacing.l)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(AccessibilityText.receipt(r))
        .accessibilityIdentifier("receipt.banner")
        .accessibilityFocused($focused)
        .onChange(of: focused) { _, isFocused in app.receipts.holdBanner(isFocused) }
        .onAppear { AccessibilityNotification.Announcement(AccessibilityText.receipt(r)).post() }
    }
}

/// A receipt card for history lists (item page, receipts list, conversation).
struct ReceiptRow: View {
    @Environment(AppModel.self) private var app
    let receipt: CommandReceipt

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(verbatim: receipt.outcome.didCommit ? receipt.summary : (receipt.error?.message ?? receipt.summary)).font(.subheadline)
            HStack {
                Text(receipt.recordedAt, format: .dateTime.day().month(.abbreviated).hour().minute()).font(.caption).foregroundStyle(.secondary)
                if receipt.replayed { Text("· confirmed again").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                switch app.receipts.undoState(for: receipt) {
                case .available:
                    Button("Undo") { Task { await app.undo(receipt) } }.buttonStyle(.bordered).minimumTarget()
                case .pending: Text("Undo queued").font(.caption).foregroundStyle(.secondary)
                case .alreadyUndone: Text("Undone").font(.caption).foregroundStyle(.secondary)
                case .notReversible(let why): Text(why).font(.caption).foregroundStyle(.secondary)
                case .notApplicable: EmptyView()
                }
            }
            if let note = app.receipts.externalEffectNote(for: receipt) { Text(note).font(.caption).foregroundStyle(.secondary) }
        }
        .accessibilityElement(children: .combine)
    }
}

struct ReceiptsListView: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        List {
            if app.receipts.receipts.isEmpty {
                ContentUnavailableView("No receipts yet", systemImage: "doc.text", description: Text("Every change you make is confirmed here."))
            }
            ForEach(app.receipts.receipts) { ReceiptRow(receipt: $0) }
        }
        .navigationTitle("Receipts")
        .task { if let page = try? await app.env.api.receipts() { app.receipts.merge(page.receipts) } }
    }
}

/// Commands kept on the phone until their receipt arrives, with visible state.
struct PendingCommandsView: View {
    @Environment(AppModel.self) private var app
    let items: [PendingCommand]
    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: Spacing.s) {
                ForEach(items) { p in
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: p.awaitsDelivery ? "clock.arrow.circlepath" : "exclamationmark.circle")
                        VStack(alignment: .leading) {
                            Text(verbatim: p.label).font(.subheadline).lineLimit(2)
                            Text(p.stateLabel).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if p.awaitsDelivery {
                            Button("Retry") { Task { await app.queue.retryNow(p.id) } }.buttonStyle(.borderless).minimumTarget()
                        } else {
                            Button("Dismiss") { app.queue.dismiss(p.id) }.buttonStyle(.borderless).minimumTarget()
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("pending.\(p.envelope.command.type)")
                }
            }
            .contentSurface(cornerRadius: 16)
        }
    }
}
#endif
