import SwiftUI
import GarderobeKit

/// The Conversation destination: one continuous transcript with the composer pinned above the
/// keyboard. There is no new-chat action and no list of sessions.
struct ConversationScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var showsRecall = false

    var body: some View {
        TranscriptView()
            .safeAreaInset(edge: .top, spacing: 0) { header }
            .safeAreaInset(edge: .bottom, spacing: 0) { ComposerBar() }
            .navigationTitle(AppTab.conversation.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // One item here besides Capture: more would squeeze the title until it is cut off.
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { app.push(.projects) } label: { Label("Projects", systemImage: "folder") }
                        Button { app.push(.returns) } label: { Label("Returns", systemImage: "arrow.uturn.left") }
                        Button { app.push(.trips) } label: { Label("Trips", systemImage: "suitcase") }
                    } label: {
                        Label("Projects and research", systemImage: "ellipsis.circle")
                    }
                }
            }
            .sheet(isPresented: $showsRecall) { RecallSheet() }
            .task {
                await app.transcript.loadLatest()
                await app.composer.retryPending()
            }
    }

    /// Pinned above the transcript: Search history, the history bar, when the conversation was
    /// last checked, and a failure to load other messages.
    @ViewBuilder
    private var header: some View {
        let transcript = app.transcript
        Group {
            VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                Button { showsRecall = true } label: { Label("Search history", systemImage: "magnifyingglass") }
                    .buttonStyle(.borderless)
                    .touchTarget()
                    .accessibilityIdentifier(AXID.historySearch)
                if transcript.isViewingHistory { historyBar }
                if !transcript.freshnessLine.isEmpty {
                    Label(transcript.freshnessLine, systemImage: transcript.isOffline ? "wifi.slash" : "clock")
                        .font(.footnote)
                        .foregroundStyle(Color.supporting)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("freshness")
                }
                if let failure = transcript.olderFailure {
                    Label("Those messages could not be loaded. \(failure.ownerMessage)", systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(Color.supporting)
                        .accessibilityElement(children: .combine)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Metrics.inset)
            .padding(.vertical, Metrics.unit * 2)
            .background(Color(.systemBackground))
        }
    }

    /// Shown while reading around a recalled message. The draft in the composer is untouched.
    private var historyBar: some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Metrics.unit * 2) { historyLabel; backToLatest }
            } else {
                HStack(spacing: Metrics.unit * 3) { historyLabel; Spacer(minLength: 0); backToLatest }
            }
        }
    }

    private var historyLabel: some View {
        Label(app.transcript.hasNewBelow ? "Viewing earlier messages. New messages have arrived." : "Viewing earlier messages",
              systemImage: "clock.arrow.circlepath")
            .font(.subheadline)
    }

    private var backToLatest: some View {
        Button("Back to latest") { Task { await app.transcript.returnToLatest() } }
            .secondaryAction()
            .accessibilityIdentifier(AXID.returnToLatest)
    }
}
