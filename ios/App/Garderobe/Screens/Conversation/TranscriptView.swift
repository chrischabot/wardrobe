import SwiftUI
import GarderobeKit

/// The one continuous transcript. Rows are created lazily, so older content is virtualised.
/// Scroll bookkeeping lives in `TranscriptReader`.
struct TranscriptView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var reader = TranscriptReader()

    private static let bottomID = "transcript.bottom"

    private struct WindowKey: Equatable { var viewingHistory: Bool; var first: String?; var target: String? }
    private struct TailKey: Equatable { var id: String?; var length = 0; var cards = 0 }

    var body: some View {
        let transcript = app.transcript
        let rows = transcript.rows
        let firstID = rows.first?.id
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Metrics.unit * 3) {
                    earlier(proxy)
                    if rows.isEmpty { hint }
                    ForEach(rows) { row in
                        rowView(row)
                            .onAppear { appeared(row.id, isFirst: row.id == firstID, proxy: proxy) }
                            .onDisappear { reader.visible.remove(row.id); report() }
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomID)
                        .accessibilityHidden(true)
                        .onAppear { reader.bottomVisible = true; report() }
                        .onDisappear { reader.bottomVisible = false; report() }
                }
                .padding(.horizontal, Metrics.inset)
                .padding(.vertical, Metrics.unit * 3)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier(AXID.transcript)
            .overlay(alignment: .bottom) { newMessages(proxy) }
            .onAppear { place(proxy) }
            .onChange(of: rows.isEmpty) { _, _ in place(proxy) }
            .onChange(of: WindowKey(viewingHistory: transcript.isViewingHistory, first: firstID,
                                    target: transcript.isViewingHistory ? transcript.readingAnchor : nil)) { old, new in
                windowChanged(from: old, to: new, proxy: proxy)
            }
            .onChange(of: tailKey) { old, _ in
                // New output while the reader is at the latest end keeps the end in view. A reader
                // who has scrolled away is never moved; they get the New messages button instead.
                if old.id != nil, reader.placed, transcript.isAtBottom, !transcript.isViewingHistory { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
            .onChange(of: app.composer.pending.count) { old, new in
                // The owner sent something: show it.
                if new > old, !transcript.isViewingHistory { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
        }
    }

    private var tailKey: TailKey {
        guard let last = app.transcript.entries.last else { return TailKey() }
        return TailKey(id: last.id, length: last.text.count, cards: last.cards.count)
    }

    @ViewBuilder
    private func rowView(_ row: TranscriptModel.Row) -> some View {
        switch row {
        case .date(let date):
            Text(dateTitle(date))
                .font(.footnote)
                .foregroundStyle(Color.supporting)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, Metrics.unit)
                .accessibilityAddTraits(.isHeader)
        case .message(let entry):
            MessageRow(entry: entry)
        }
    }

    /// `Tuesday 15 September`, with the year when it is not this year.
    private func dateTitle(_ date: LocalDate) -> String {
        let year = String(date.prefix(4))
        let title = Phrases.weekdayDayMonth(date)
        return year == String(app.environment.today.prefix(4)) ? title : "\(title) \(year)"
    }

    private var hint: some View {
        Text("Write a message below, attach a photo, or paste a product link.")
            .font(.subheadline)
            .foregroundStyle(Color.supporting)
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
            .padding(.vertical, Metrics.inset * 2)
    }

    @ViewBuilder
    private func earlier(_ proxy: ScrollViewProxy) -> some View {
        let transcript = app.transcript
        if transcript.hasOlder {
            Button { Task { await loadEarlier(proxy) } } label: {
                Label(transcript.isLoadingOlder ? "Loading earlier messages..." : "Load earlier messages", systemImage: "arrow.up")
                    .font(.footnote)
            }
            .buttonStyle(.borderless)
            .touchTarget()
            .frame(maxWidth: .infinity, alignment: .center)
            .disabled(transcript.isLoadingOlder)
        }
    }

    @ViewBuilder
    private func newMessages(_ proxy: ScrollViewProxy) -> some View {
        if app.transcript.hasNewBelow, !app.transcript.isViewingHistory {
            Button {
                withAnimation(.settle(reduceMotion: reduceMotion)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                app.transcript.markSeen()
            } label: {
                Label("New messages", systemImage: "arrow.down")
            }
            .secondaryAction()
            .controlSize(.large)
            .padding(.bottom, Metrics.unit * 2)
            .accessibilityIdentifier(AXID.newMessages)
        }
    }

    // MARK: Position

    /// First appearance: the saved reading anchor when it is in the loaded window, else the latest end.
    private func place(_ proxy: ScrollViewProxy) {
        let transcript = app.transcript
        guard !reader.placed, !transcript.rows.isEmpty else { return }
        if let anchor = transcript.readingAnchor, transcript.rows.contains(where: { $0.id == anchor }) {
            proxy.scrollTo(anchor, anchor: .top)
        } else {
            proxy.scrollTo(Self.bottomID, anchor: .bottom)
        }
        reader.placed = true
        settle()
    }

    /// After the transcript was positioned, the top row does not load older messages by itself
    /// until the position has settled (it may be on screen for a moment before the scroll).
    private func settle() {
        reader.autoLoad = false
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            reader.autoLoad = true
            report()
        }
    }

    private func windowChanged(from old: WindowKey, to new: WindowKey, proxy: ScrollViewProxy) {
        // The first rows of all are placed by `place`, not here.
        guard reader.placed, old.first != nil else { return }
        let transcript = app.transcript
        reader.reported = nil
        if let keep = reader.keepTop {
            // An older page was inserted above: keep the reader on the message they were at.
            proxy.scrollTo(keep, anchor: .top)
        } else if new.viewingHistory || (old.viewingHistory && !transcript.isAtBottom) {
            // Opened around a recalled message, or back at the position held before it.
            if let anchor = transcript.readingAnchor { proxy.scrollTo(anchor, anchor: .top) }
            settle()
        } else if transcript.isAtBottom {
            proxy.scrollTo(Self.bottomID, anchor: .bottom)
            settle()
        }
    }

    private func appeared(_ id: String, isFirst: Bool, proxy: ScrollViewProxy) {
        reader.visible.insert(id)
        report()
        if isFirst, reader.autoLoad, app.transcript.hasOlder { Task { await loadEarlier(proxy) } }
    }

    /// The first message on screen, by its stable ID (date separators move when a page is added).
    private func firstVisibleMessage() -> String? {
        for row in app.transcript.rows {
            if case .message(let entry) = row, reader.visible.contains(entry.id) { return entry.id }
        }
        return nil
    }

    private func loadEarlier(_ proxy: ScrollViewProxy) async {
        let transcript = app.transcript
        guard transcript.hasOlder, !transcript.isLoadingOlder, reader.keepTop == nil else { return }
        guard let top = firstVisibleMessage() ?? transcript.entries.first?.id else { return }
        reader.keepTop = top
        await transcript.loadOlder()
        // The insertion is applied in `windowChanged`; hold the anchor until that has happened.
        try? await Task.sleep(nanoseconds: 300_000_000)
        reader.keepTop = nil
        report()
    }

    /// Tells the model where the reader is, once per burst of rows appearing and disappearing.
    private func report() {
        guard reader.placed, reader.keepTop == nil, !reader.reportScheduled else { return }
        reader.reportScheduled = true
        Task { @MainActor in
            reader.reportScheduled = false
            guard reader.keepTop == nil else { return }
            let transcript = app.transcript
            // The end of a recalled page is not the latest end of the conversation.
            let atBottom = reader.bottomVisible && !transcript.isViewingHistory
            let anchor = firstVisibleMessage()
            if let last = reader.reported, last.atBottom == atBottom, last.anchor == anchor { return }
            reader.reported = (atBottom, anchor)
            transcript.setReader(atBottom: atBottom, anchor: anchor)
        }
    }
}
