import SwiftUI
import GarderobeKit

/// Today, built for the half-awake glance: the date and the weather lead, then the day's
/// options (or, once a wear is recorded, the day's record). The cached board is on screen at
/// once; the freshness line says when it was checked. Nothing here asks a question.
struct TodayScreen: View {
    @Environment(AppModel.self) private var app
    /// The option in view in the carousel.
    @State private var position: String?
    /// The option a Calendar or web-board link pointed at, while it is marked on screen.
    @State private var highlighted: String?
    @State private var showsWeather = false
    @State private var showsBrief = false
    private static let optionsAnchor = "today.options"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.unit * 8) {
                    header.padding(.horizontal, Metrics.inset)
                    content
                }
                .padding(.vertical, Metrics.inset)
            }
            .background(Color(.systemGroupedBackground))
            .refreshable { await app.today.refresh() }
            .onChange(of: app.highlightedOptionId, initial: true) { _, _ in reveal(using: proxy) }
            .onChange(of: app.today.board?.boardId) { _, _ in reveal(using: proxy) }
            .onChange(of: app.today.today.origin) { _, _ in reveal(using: proxy) }
        }
        .navigationTitle("Today")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { entryPoints }
        .task { await app.today.open() }
        .sheet(isPresented: $showsWeather) { WeatherDetailSheet() }
        .sheet(isPresented: $showsBrief) { DayBriefSheet() }
        .onChange(of: position) { _, new in if new != highlighted { highlighted = nil } }
        .onDisappear { highlighted = nil }
    }

    private var header: some View {
        let today = app.today
        return VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            Text(today.dateLine)
                .font(.largeTitle.weight(.bold))
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(AXID.todayDate)
            if let weather = today.board?.weatherLine {
                Button { showsWeather = true } label: {
                    HStack(alignment: .firstTextBaseline, spacing: Metrics.unit * 2) {
                        Text(weather).font(.title3).multilineTextAlignment(.leading)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.supporting)
                    }
                    .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows the hourly forecast, its source and when it was fetched.")
                .accessibilityIdentifier(AXID.todayWeather)
            }
            if let board = today.board {
                Text(board.dayLine).font(.body)
                if let suitability = board.suitabilityLine {
                    Text(suitability).font(.subheadline).foregroundStyle(Color.supporting)
                }
            }
            FreshnessLabel(text: today.freshnessLine, freshness: today.today.freshness, identifier: AXID.todayFreshness)
            ForEach(today.sourceNotes, id: \.self) { note in
                Label(note, systemImage: "info.circle").font(.footnote)
            }
            if let notice = today.board?.notice {
                Label(notice, systemImage: "exclamationmark.circle").font(.subheadline)
            }
            if let action = today.calendarAction {
                // Calendar needs the owner; Today stays fully usable without it.
                Button { app.sheet = .settings } label: { Label(action, systemImage: "calendar.badge.exclamationmark") }
                    .secondaryAction()
                    .controlSize(.large)
                    .accessibilityHint("Opens settings, where connections are managed.")
            }
            OutcomeLine(outcome: today.lastOutcome)
            ForEach(today.queuedHere) { command in
                Label("Waiting to send: \(command.label)", systemImage: "tray.and.arrow.up").font(.footnote).foregroundStyle(Color.supporting)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var content: some View {
        let today = app.today
        if today.hasDayRecord {
            DayRecordView().padding(.horizontal, Metrics.inset)
        } else if !today.options.isEmpty {
            options
        } else if let statement = today.emptyStatement {
            // The backend's own reason: paused, being prepared, no board, or no complete outfit.
            VStack(alignment: .leading, spacing: Metrics.unit * 3) {
                Text(statement).font(.title3)
                Text("Pull down to check again.").font(.subheadline).foregroundStyle(Color.supporting)
                if today.canAskForOutfits {
                    Button { Task { await today.askForOutfits() } } label: { Label("Ask for outfits now", systemImage: "sparkles") }
                        .secondaryAction()
                        .controlSize(.large)
                        .disabled(today.isSubmitting)
                }
                switch today.composeState {
                case .preparing(let activity):
                    Label(activity ?? "Your outfits are being prepared.", systemImage: "hourglass").font(.subheadline)
                case .failed(let message):
                    Label(message, systemImage: "exclamationmark.triangle").font(.subheadline)
                case .connectionLost:
                    Label("The connection was lost. Your outfits are still being prepared.", systemImage: "wifi.slash").font(.subheadline)
                case .idle, .ready:
                    EmptyView()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentSurface()
            .padding(.horizontal, Metrics.inset)
        }
    }

    private var options: some View {
        @Bindable var today = app.today
        return VStack(alignment: .leading, spacing: Metrics.unit * 4) {
            Toggle(isOn: $today.showsComparison) { Label("Compare all", systemImage: "list.bullet") }
                .toggleStyle(.button)
                .controlSize(.large)
                .padding(.horizontal, Metrics.inset)
                .accessibilityHint("Shows every option in one list instead of one card at a time.")
                .accessibilityIdentifier(AXID.todayComparisonToggle)
            if today.showsComparison {
                ComparisonList(options: today.options, highlightedId: highlighted)
                    .padding(.horizontal, Metrics.inset)
            } else {
                OptionCarousel(options: today.options, position: $position, highlightedId: highlighted)
            }
        }
        .id(Self.optionsAnchor)
    }

    @ToolbarContentBuilder private var entryPoints: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { app.sheet = .laundry } label: { Label("Laundry", systemImage: "washer") }
                .accessibilityIdentifier(AXID.laundryButton)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button { showsBrief = true } label: { Label("Today's brief", systemImage: "text.bubble") }
                Button { app.push(.trips) } label: { Label("Trips", systemImage: "suitcase") }
                Button { app.push(.returns) } label: { Label("Returns and exchanges", systemImage: "shippingbox") }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .accessibilityLabel("More: brief, trips, returns")
        }
    }

    /// Brings the option a link pointed at into view and marks it, then lets the link go.
    /// No animation: opening from a link is not a swap.
    private func reveal(using proxy: ScrollViewProxy) {
        guard let id = app.highlightedOptionId else { return }
        let today = app.today
        let shown = !today.hasDayRecord && today.options.contains { $0.id == id }
        if shown {
            highlighted = id
            position = id
            if today.showsComparison { proxy.scrollTo(id, anchor: .center) } else { proxy.scrollTo(Self.optionsAnchor, anchor: .top) }
        }
        // Keep the link until the board has been read from the backend, so a cold start can still find the option.
        if shown || today.today.origin == .live { app.clearHighlight() }
    }
}
