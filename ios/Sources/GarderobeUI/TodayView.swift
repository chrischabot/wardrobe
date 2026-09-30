#if os(iOS)
import SwiftUI
import GarderobeKit

struct TodayView: View {
    @Environment(AppModel.self) private var app
    @State private var footwearPrompt: FootwearPrompt?
    @State private var swapTarget: BoardCard?
    @State private var refusal: String?

    struct FootwearPrompt: Identifiable {
        enum Action { case choose, wore }
        let id = UUID()
        let optionId: String
        let action: Action
        let shoes: [Piece]
    }

    var body: some View {
        @Bindable var today = app.today
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    DayHeader()
                    PendingCommandsView(items: today.pendingForToday)
                    if let record = today.dayRecord { DayRecordCard(record: record) }
                    if let shortfall = today.shortfall {
                        Text(verbatim: shortfall).font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("today.shortfall")
                    }
                    if today.cards.isEmpty {
                        ContentUnavailableView(today.isRefreshing ? "Loading today's board" : "No board yet", systemImage: "sun.horizon", description: Text("The board is prepared the evening before. Pull to check again."))
                    } else {
                        Picker("View", selection: $today.mode) {
                            Text("Outfits").tag(TodayViewModel.Mode.carousel)
                            Text("Compare").tag(TodayViewModel.Mode.list)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("today.mode")
                        switch today.mode {
                        case .carousel: Carousel(perform: perform, swap: { swapTarget = $0 })
                        case .list: ComparisonList(open: { id in today.currentOptionId = id; today.mode = .carousel })
                        }
                    }
                }
                .padding(Spacing.l)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .refreshable { await today.refresh() }
            .navigationTitle("Today")
            .toolbar { AppToolbar(showsLaundry: true) }
            .confirmationDialog("Which shoes?", isPresented: Binding(get: { footwearPrompt != nil }, set: { if !$0 { footwearPrompt = nil } }), titleVisibility: .visible, presenting: footwearPrompt) { prompt in
                ForEach(prompt.shoes) { shoe in
                    Button(shoe.name) {
                        today.selectFootwear(optionId: prompt.optionId, garmentId: shoe.garmentId)
                        Task { await perform(prompt.action, prompt.optionId) }
                    }
                }
            } message: { _ in Text("One pair gets logged.") }
            .sheet(item: $swapTarget) { SwapSheet(card: $0) }
            .alert("Not done", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } })) { Button("OK", role: .cancel) {} } message: { Text(refusal ?? "") }
        }
    }

    func perform(_ action: FootwearPrompt.Action, _ optionId: String) async {
        let result = action == .choose ? await app.today.choose(optionId) : await app.today.iWore(optionId)
        switch result {
        case .needsFootwear(let shoes): footwearPrompt = FootwearPrompt(optionId: optionId, action: action, shoes: shoes)
        case .refused(let why): refusal = why
        case .done, .queued: break
        }
    }
}

/// The day line closing on the shape of the day, then the weather and an honest freshness line.
struct DayHeader: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        let today = app.today
        VStack(alignment: .leading, spacing: Spacing.s) {
            if app.isDemo { DemoBadge() }
            if let trip = today.tripLine {
                // A trip-day board is composed from the suitcase; say so before anything else.
                Label(trip, systemImage: "suitcase")
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("today.trip")
            }
            if let line = today.dayLine {
                Text(verbatim: line).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("today.dayLine")
            }
            if let w = today.weather {
                let rainy = (w.precipitationProbability ?? 0) >= 0.3 || w.rainStartsAt != nil
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    if let line = today.weatherLine { Label(line, systemImage: rainy ? "cloud.rain" : "sun.max").font(.subheadline) }
                    // Figures as supplied; anything the forecast lacks reads "unknown", never a guess.
                    Text(verbatim: DayLine.weatherFigures(w)).font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(DayLine.weatherText(w, timeZone: app.env.timeZone))
                .accessibilityIdentifier("today.weather")
            } else {
                Label("Weather unknown", systemImage: "questionmark.circle").font(.subheadline).foregroundStyle(.secondary)
                    .accessibilityIdentifier("today.weather")
            }
            Text(today.freshnessLabel).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("today.freshness")
            if let note = today.calendarNote { Text(note).font(.caption).foregroundStyle(.secondary) }
        }
    }
}

struct DayRecordCard: View {
    let record: DayRecord
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Label(record.synced ? "Today's record" : "Recorded on this phone", systemImage: record.synced ? "checkmark.seal" : "clock.arrow.circlepath").font(.headline)
            Text(verbatim: record.names.joined(separator: ", ")).font(.body)
            if let state = record.stateLabel { Text(state).font(.caption).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("today.record")
    }
}

/// Swipe between options, with visible previous/next controls for every swipe.
struct Carousel: View {
    @Environment(AppModel.self) private var app
    let perform: (TodayView.FootwearPrompt.Action, String) async -> Void
    let swap: (BoardCard) -> Void

    var body: some View {
        @Bindable var today = app.today
        let cards = today.cards
        let index = cards.firstIndex { $0.optionId == today.currentOptionId } ?? 0
        VStack(spacing: Spacing.m) {
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: Spacing.l) {
                    ForEach(cards) { card in
                        BoardCardView(card: card, perform: perform, swap: swap).containerRelativeFrame(.horizontal)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $today.currentOptionId)
            .scrollIndicators(.hidden)
            HStack {
                Button { step(-1, cards, index) } label: { Label("Previous option", systemImage: "chevron.left").labelStyle(.iconOnly) }
                    .minimumTarget().disabled(index == 0).accessibilityIdentifier("today.previous")
                Spacer()
                Text("Option \(index + 1) of \(cards.count)").font(.footnote).foregroundStyle(.secondary)
                Spacer()
                Button { step(1, cards, index) } label: { Label("Next option", systemImage: "chevron.right").labelStyle(.iconOnly) }
                    .minimumTarget().disabled(index >= cards.count - 1).accessibilityIdentifier("today.next")
            }
            .padding(.horizontal, Spacing.s)
            .controlSurface()
        }
    }

    private func step(_ d: Int, _ cards: [BoardCard], _ index: Int) {
        let i = min(max(0, index + d), cards.count - 1)
        app.today.currentOptionId = cards[i].optionId
    }
}

/// One outfit, as the owner's profile section 11 asks: why it works, then jacket, shirt or jumper,
/// trousers, belt with its optional flourish, socks with shoes. Generous whitespace.
struct BoardCardView: View {
    @Environment(AppModel.self) private var app
    let card: BoardCard
    let perform: (TodayView.FootwearPrompt.Action, String) async -> Void
    let swap: (BoardCard) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            HStack {
                Text("Option \(card.position)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if card.isChosen { Label("Chosen", systemImage: "checkmark").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor) }
                if !card.swappedRoles.isEmpty { Text("Your swap").font(.caption).foregroundStyle(.secondary) }
            }
            Text(verbatim: card.whyItWorks).font(.title3).fixedSize(horizontal: false, vertical: true)
            if let q = card.qualification { Text(verbatim: q).font(.callout).foregroundStyle(.secondary) }
            OutfitComposition(pieces: card.composition)
            VStack(alignment: .leading, spacing: Spacing.l) {
                ForEach(card.lines) { line in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.label).font(.caption).foregroundStyle(.secondary)
                        Text(verbatim: line.text).font(.body)
                        if let f = line.flourish { Text(verbatim: f).font(.subheadline).foregroundStyle(.secondary) }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            if card.footwear.requiresChoice { FootwearChooser(card: card) }
            actions
        }
        .padding(Spacing.l)
        .contentSurface(cornerRadius: 24)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(AccessibilityText.card(card))
        .accessibilityIdentifier("card.\(card.position)")
        .accessibilityAction(named: "Choose") { Task { await perform(.choose, card.optionId) } }
        .accessibilityAction(named: "I wore this") { Task { await perform(.wore, card.optionId) } }
        .accessibilityAction(named: "Swap a piece") { swap(card) }
        .accessibilityAction(named: "Ask about this") { app.askAbout(optionId: card.optionId) }
    }

    private var actions: some View {
        VStack(spacing: Spacing.s) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.s) { chooseButton; woreButton }
                VStack(spacing: Spacing.s) { chooseButton; woreButton }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Spacing.s) { swapButton; askButton }
                VStack(spacing: Spacing.s) { swapButton; askButton }
            }
        }
    }

    private var chooseButton: some View {
        Button { Task { await perform(.choose, card.optionId) } } label: { Text(card.isChosen ? "Chosen" : "Choose").frame(maxWidth: .infinity).minimumTarget() }
            .buttonStyle(.glassProminent).accessibilityIdentifier("card.\(card.position).choose")
    }
    private var woreButton: some View {
        Button { Task { await perform(.wore, card.optionId) } } label: { Text("I wore this").frame(maxWidth: .infinity).minimumTarget() }
            .buttonStyle(.bordered).accessibilityIdentifier("card.\(card.position).wore")
    }
    private var swapButton: some View {
        Button { swap(card) } label: { Label("Swap", systemImage: "arrow.left.arrow.right").frame(maxWidth: .infinity).minimumTarget() }
            .buttonStyle(.borderless).accessibilityIdentifier("card.\(card.position).swap")
    }
    private var askButton: some View {
        Button { app.askAbout(optionId: card.optionId) } label: { Label("Ask about this", systemImage: "bubble.left").frame(maxWidth: .infinity).minimumTarget() }
            .buttonStyle(.borderless).accessibilityIdentifier("card.\(card.position).ask")
    }
}

/// Picking a shoe updates the visible outfit so the wear never logs both.
struct FootwearChooser: View {
    @Environment(AppModel.self) private var app
    let card: BoardCard
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            Text("Shoes — decide at the door").font(.caption).foregroundStyle(.secondary)
            ForEach(card.footwear.alternatives) { shoe in
                let selected = card.footwear.selectedGarmentId == shoe.garmentId
                Button { app.today.selectFootwear(optionId: card.optionId, garmentId: shoe.garmentId) } label: {
                    HStack {
                        Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                        Text(verbatim: shoe.name)
                        Spacer()
                    }
                    .minimumTarget()
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
                .accessibilityIdentifier("card.\(card.position).shoe.\(shoe.name)")
            }
        }
    }
}

/// A compact list for scanning instead of swiping.
struct ComparisonList: View {
    @Environment(AppModel.self) private var app
    let open: (String) -> Void
    var body: some View {
        VStack(spacing: Spacing.m) {
            ForEach(app.today.cards) { card in
                Button { open(card.optionId) } label: {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        HStack {
                            Text("Option \(card.position)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            if card.isChosen { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                        }
                        ForEach(card.lines.filter { $0.kind != .belt }) { line in
                            Text(verbatim: line.text).font(.subheadline).lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentSurface(cornerRadius: 16)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(AccessibilityText.card(card))
                .accessibilityHint("Opens this outfit")
                .accessibilityIdentifier("compare.\(card.position)")
            }
        }
    }
}

/// Swap one piece: a swap, not a rebuild. Candidates come from the backend when online.
struct SwapSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let card: BoardCard
    @State private var role: GarmentRole = .baseTop
    @State private var list: TodayViewModel.SwapList?

    var body: some View {
        NavigationStack {
            List {
                Picker("Piece", selection: $role) {
                    ForEach(swappableRoles, id: \.self) { r in Text(label(r)).tag(r) }
                }
                switch list {
                case .none: ProgressView()
                case .verified(let c): section(c, note: nil)
                case .unverified(let c): section(c, note: "Offline: these were available when last checked; the board has not validated them.")
                }
                if !card.swappedRoles.isEmpty {
                    Button("Undo my swaps", role: .destructive) { app.today.revertSwaps(optionId: card.optionId); dismiss() }
                }
            }
            .navigationTitle("Swap")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task(id: role) {
                list = nil
                list = await app.today.swapCandidates(optionId: card.optionId, role: role, cachedWardrobe: app.wardrobe.allItems)
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var swappableRoles: [GarmentRole] {
        let order: [GarmentRole] = [.baseTop, .midLayer, .outerLayer, .bottom, .socks, .belt, .accessory]
        let present = Set(card.composition.map(\.role))
        return order.filter { present.contains($0) }
    }

    private func label(_ r: GarmentRole) -> String {
        switch r {
        case .baseTop: "Shirt"
        case .midLayer: "Jumper"
        case .outerLayer: "Jacket"
        case .bottom: "Trousers"
        case .socks: "Socks"
        case .belt: "Belt"
        default: "Flourish"
        }
    }

    @ViewBuilder private func section(_ candidates: [SwapCandidates.Candidate], note: String?) -> some View {
        Section {
            if candidates.isEmpty { Text("Nothing else is available for this piece.").foregroundStyle(.secondary) }
            ForEach(candidates) { c in
                Button {
                    if let original = card.composition.first(where: { $0.role == role })?.garmentId {
                        app.today.applySwap(optionId: card.optionId, replacing: original, with: c.garmentId)
                    }
                    dismiss()
                } label: {
                    VStack(alignment: .leading) {
                        Text(verbatim: c.name)
                        Text(verbatim: c.reason).font(.caption).foregroundStyle(.secondary)
                    }
                    .minimumTarget()
                }
            }
        } footer: { if let note { Text(note) } }
    }
}
#endif
