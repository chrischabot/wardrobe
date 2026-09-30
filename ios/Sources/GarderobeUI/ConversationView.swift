#if os(iOS)
import SwiftUI
import GarderobeKit

struct ConversationView: View {
    @Environment(AppModel.self) private var app
    @State private var scrollTarget: String?
    @State private var search = ""
    @FocusState private var composerFocused: Bool

    var body: some View {
        let c = app.conversation
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Spacing.m) {
                        if c.recall != .idle {
                            RecallResultsView { id in
                                Task {
                                    if let target = await c.open(recalled: id) {
                                        search = ""
                                        c.clearRecall()
                                        proxy.scrollTo(target, anchor: .center)
                                    }
                                }
                            }
                        } else {
                        if c.hasOlder {
                            Button {
                                Task {
                                    // Loading older messages preserves the reading anchor.
                                    if let anchor = await c.loadOlder() { proxy.scrollTo(anchor, anchor: .top) }
                                }
                            } label: { Text(c.isLoadingOlder ? "Loading…" : "Earlier messages").frame(maxWidth: .infinity).minimumTarget() }
                                .buttonStyle(.borderless)
                                .accessibilityIdentifier("conversation.older")
                        }
                        ForEach(filteredRows) { row in
                            switch row {
                            case .dateSeparator(let d):
                                Text(c.dateLabel(d)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity).padding(.vertical, Spacing.s).accessibilityAddTraits(.isHeader)
                            case .message(let m):
                                MessageView(message: m).id(m.messageId)
                                    .onAppear { c.readingAnchor = m.messageId }
                            case .pending(let p):
                                PendingTurnView(turn: p).id(row.id)
                            case .notice(_, let notice):
                                SecretRemovedNotice(notice: notice).id(row.id)
                            }
                        }
                        if let activity = c.activity {
                            Label(activity, systemImage: "ellipsis").font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("conversation.activity")
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .onAppear { c.isAtBottom = true }
                            .onDisappear { c.isAtBottom = false }
                        }
                    }
                    .padding(Spacing.l)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .overlay(alignment: .bottom) {
                    if c.hasUnseenMessages {
                        Button { proxy.scrollTo("bottom") } label: { Label("New message", systemImage: "arrow.down").padding(.horizontal, Spacing.m).minimumTarget() }
                            .controlSurface().padding(.bottom, Spacing.s).accessibilityIdentifier("conversation.newMessage")
                    }
                }
                .onAppear { if let anchor = c.readingAnchor { proxy.scrollTo(anchor, anchor: .center) } }
            }
            .safeAreaInset(edge: .bottom) { Composer(focused: $composerFocused) }
            .navigationTitle("Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, placement: .toolbar, prompt: "Search everything we discussed")
            .onSubmit(of: .search) { Task { await c.searchHistory(search) } }
            .onChange(of: search) { if search.isEmpty { c.clearRecall() } }
            .toolbar { AppToolbar(showsLaundry: false) }
            .task { await c.load() }
        }
    }

    private var filteredRows: [TranscriptRow] { app.conversation.rows }
}

/// Recall results: each quote with its date, who said it, and the neighbouring messages; later
/// reversals are shown so an old liking is not mistaken for a current one.
struct RecallResultsView: View {
    @Environment(AppModel.self) private var app
    let open: (String) -> Void

    var body: some View {
        let c = app.conversation
        VStack(alignment: .leading, spacing: Spacing.m) {
            switch c.recall {
            case .idle: EmptyView()
            case .searching: ProgressView("Searching the conversation…")
            case .failed(let why): Label(why, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            case .localOnly(let found, let note):
                Text(note).font(.caption).foregroundStyle(.secondary)
                if found.isEmpty { Text("Nothing on this phone matches.").foregroundStyle(.secondary) }
                ForEach(found, id: \.messageId) { m in
                    row(date: LocalDate(date: m.createdAt, timeZone: app.env.timeZone), speaker: m.role == "user" ? "You" : "Garderobe", quote: m.plainText, before: nil, after: nil, id: m.messageId)
                }
            case .results(let r):
                if let note = c.coverageNote(r) { Text(note).font(.caption).foregroundStyle(.secondary) }
                ForEach(r.notes, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                ForEach(r.hits) { hit in
                    row(date: hit.localDate, speaker: hit.speaker == "owner" ? "You" : "Garderobe", quote: hit.quote, before: hit.context.before, after: hit.context.after, id: hit.messageId)
                }
                if !r.laterReversals.isEmpty {
                    Text("Later changes of mind").font(.headline).accessibilityAddTraits(.isHeader)
                    ForEach(r.laterReversals, id: \.messageId) { rev in
                        Button { open(rev.messageId) } label: {
                            VStack(alignment: .leading, spacing: Spacing.xs) {
                                Text(verbatim: rev.subject).font(.subheadline.weight(.semibold))
                                Text(verbatim: "“\(rev.quote)”").font(.callout)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading).minimumTarget()
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .accessibilityIdentifier("conversation.recall")
    }

    private func row(date: LocalDate, speaker: String, quote: String, before: String?, after: String?, id: String) -> some View {
        Button { open(id) } label: {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text(verbatim: "\(app.conversation.dateLabel(date)) · \(speaker)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if let before { Text(verbatim: before).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                Text(verbatim: "“\(quote)”").font(.callout)
                if let after { Text(verbatim: after).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentSurface(cornerRadius: 14)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens this message in the conversation")
    }
}

struct MessageView: View {
    @Environment(AppModel.self) private var app
    let message: ConversationMessage
    var mine: Bool { message.role == "user" }

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: Spacing.s) {
            ForEach(Array(message.parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .text(let t): Text(verbatim: t).textSelection(.enabled)
                case .outfitCard(let card): InlineOutfitCard(card: card)
                case .sources(let s):
                    DisclosureGroup("Sources (\(s.count))") {
                        ForEach(s, id: \.url) { src in
                            if let url = URL(string: src.url) { Link(src.title, destination: url).font(.callout) } else { Text(verbatim: src.title) }
                        }
                    }
                case .receipt(let id, let summary):
                    if let r = app.receipts.receipt(id) { ReceiptRow(receipt: r).contentSurface(cornerRadius: 14) } else { Label(summary, systemImage: "checkmark.seal").font(.callout) }
                case .reference(let ref): Label(label(ref), systemImage: "paperclip").font(.caption).foregroundStyle(.secondary)
                case .attachment: Label("Photo", systemImage: "photo").font(.caption).foregroundStyle(.secondary)
                case .resultCard(let card):
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        Text(verbatim: card.title).font(.subheadline.weight(.semibold))
                        Text(verbatim: card.summary).font(.callout)
                    }
                    .contentSurface(cornerRadius: 14)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("conversation.resultCard")
                case .unknown: EmptyView()
                }
            }
            if message.status == "stopped" { Text("Stopped").font(.caption).foregroundStyle(.secondary) }
            if message.status == "failed" { Text("This reply did not finish.").font(.caption).foregroundStyle(.orange) }
            if message.sourceChannel != "app" { Text("via \(message.sourceChannel.uppercased())").font(.caption2).foregroundStyle(.secondary) }
        }
        .padding(Spacing.m)
        .background(mine ? Color.accentColor.opacity(0.12) : Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(mine ? "You" : "Garderobe")
    }

    private func label(_ ref: ConversationReference) -> String {
        switch ref {
        case .garment(let g): "About " + (app.wardrobe.item(g)?.garment.name ?? "an item")
        case .option: "About a board option"
        }
    }
}

/// Outfit cards appear as recommendations only after validation; others are marked, not actionable.
struct InlineOutfitCard: View {
    @Environment(AppModel.self) private var app
    let card: OutfitCard
    var body: some View {
        let names = card.garmentIds.map { id in app.today.garments[id]?.name ?? app.wardrobe.item(id)?.garment.name ?? "An item" }
        VStack(alignment: .leading, spacing: Spacing.s) {
            Text(verbatim: card.explanation).font(.callout)
            Text(verbatim: names.joined(separator: " · ")).font(.subheadline)
            if card.isActionable, let optionId = card.optionId, app.today.card(optionId) != nil {
                Button("Open on Today") { app.today.currentOptionId = optionId; app.today.mode = .carousel; app.selectedTab = .today }
                    .buttonStyle(.bordered).minimumTarget()
            } else if !card.validated {
                Text("Not checked against your wardrobe").font(.caption).foregroundStyle(.orange)
            }
        }
        .contentSurface(cornerRadius: 16)
        .accessibilityElement(children: .combine)
    }
}

/// "Recovery code removed from your message": what Garderobe removed before saving, never the secret itself.
struct SecretRemovedNotice: View {
    @Environment(AppModel.self) private var app
    let notice: TurnNotice
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Label(notice.title, systemImage: "lock.shield").font(.subheadline.weight(.semibold))
            Text(verbatim: notice.summary).font(.callout)
            if notice.removedRecoveryCode {
                Button { app.sheet = .settings } label: { Label("Create a new recovery code", systemImage: "key").minimumTarget() }
                    .buttonStyle(.bordered)
                    .accessibilityHint("Opens Settings, where a new code replaces the one you pasted")
                    .accessibilityIdentifier("conversation.newRecoveryCode")
            }
        }
        .contentSurface(cornerRadius: 14)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation.secretRemoved")
    }
}

struct PendingTurnView: View {
    @Environment(AppModel.self) private var app
    let turn: PendingTurn
    var body: some View {
        VStack(alignment: .trailing, spacing: Spacing.xs) {
            Text(verbatim: turn.text)
            ForEach(turn.references) { Label($0.label, systemImage: "paperclip").font(.caption) }
            HStack {
                Text(turn.stateLabel).font(.caption).foregroundStyle(.secondary)
                if case .failed = turn.state {
                    Button("Retry") { Task { await app.conversation.retry(turn.clientTurnId) } }.minimumTarget()
                    Button("Discard", role: .destructive) { app.conversation.discard(turn.clientTurnId) }.minimumTarget()
                }
            }
        }
        .padding(Spacing.m)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("conversation.pending")
    }
}

/// Native multiline field, attachment chips, clear send / stop state, keyboard-safe placement.
struct Composer: View {
    @Environment(AppModel.self) private var app
    var focused: FocusState<Bool>.Binding

    var body: some View {
        @Bindable var c = app.conversation
        VStack(spacing: Spacing.s) {
            if !c.attachments.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(c.attachments) { a in
                            HStack(spacing: Spacing.xs) {
                                Image(systemName: "paperclip")
                                Text(verbatim: a.label).lineLimit(1)
                                Button { c.removeAttachment(a.id) } label: { Image(systemName: "xmark.circle.fill") }
                                    .minimumTarget().accessibilityLabel("Remove \(a.label)")
                            }
                            .font(.caption)
                            .padding(.leading, Spacing.s)
                            .controlSurface()
                            .accessibilityIdentifier("composer.attachment")
                        }
                    }
                }
            }
            if let needs = c.needsInput {
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    Text(verbatim: needs.prompt).font(.callout)
                    if c.isAwaitingAnswer { Text("The reply is paused until you choose.").font(.caption).foregroundStyle(.secondary) }
                    ForEach(needs.choices) { choice in
                        Button(choice.label) {
                            // A durable question is answered natively (the same record an MCP retry resolves);
                            // a question without one is answered as an ordinary turn.
                            if needs.runId != nil { Task { await c.answer(choice) } } else { c.draft = choice.label; Task { await c.send() } }
                        }
                        .buttonStyle(.bordered).minimumTarget()
                        .accessibilityIdentifier("composer.choice.\(choice.id)")
                    }
                    if needs.runId != nil {
                        // Declining executes nothing and ends the paused reply.
                        Button("Not now") { Task { await c.declineQuestion() } }
                            .buttonStyle(.borderless).minimumTarget()
                            .accessibilityIdentifier("composer.decline")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let error = c.lastError { Text(verbatim: error).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("conversation.error") }
            HStack(alignment: .bottom, spacing: Spacing.s) {
                Button { app.sheet = .capture(nil) } label: { Image(systemName: "camera") }
                    .minimumTarget().accessibilityLabel("Add a photo")
                TextField("Message", text: $c.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused(focused)
                    .padding(.horizontal, Spacing.m).padding(.vertical, Spacing.s)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .accessibilityIdentifier("composer.field")
                if c.isReplying {
                    if c.canSend {
                        Button { Task { await c.send() } } label: { Image(systemName: "arrow.up") }
                            .buttonStyle(.bordered).minimumTarget()
                            .accessibilityLabel("Send after this reply").accessibilityIdentifier("composer.send")
                        Button("Stop and send") { Task { await c.stopAndSend() } }
                            .buttonStyle(.glassProminent).minimumTarget().accessibilityIdentifier("composer.stopAndSend")
                    } else {
                        Button { Task { await c.stop() } } label: { Image(systemName: "stop.fill") }
                            .minimumTarget().accessibilityLabel("Stop the reply").accessibilityIdentifier("composer.stop")
                    }
                } else {
                    Button { Task { await c.send() } } label: { Image(systemName: "arrow.up") }
                        .buttonStyle(.glassProminent).minimumTarget().disabled(!c.canSend)
                        .accessibilityLabel("Send").accessibilityIdentifier("composer.send")
                }
            }
            if c.draftTooLong { Text("Too long to send in one message.").font(.caption).foregroundStyle(.orange) }
            if c.isReplying && c.canSend { Text("Send now waits for the current reply; Stop and send interrupts it.").font(.caption2).foregroundStyle(.secondary) }
        }
        .padding(.horizontal, Spacing.l).padding(.vertical, Spacing.s)
        .background(.bar)
    }
}
#endif
