#if os(iOS)
import SwiftUI
import GarderobeKit

struct StudioView: View {
    @Environment(AppModel.self) private var app
    @State private var planDate = Date()
    @State private var showPlan = false
    @State private var confirmWear = false
    @State private var message: String?

    var body: some View {
        let studio = app.studio
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.l) {
                    Picker("Mode", selection: Binding(get: { studio.state.mode }, set: { studio.setMode($0) })) {
                        ForEach(StudioMode.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("studio.mode")
                    Text(studio.state.mode == .today ? "Owned pieces available today. Garderobe checks the finished combination." : "Includes stored and incoming pieces. Browsing changes no plan or history.")
                        .font(.caption).foregroundStyle(.secondary)

                    VStack(spacing: Spacing.m) {
                        ForEach(studio.visibleRoles) { RoleSelector(role: $0) }
                    }
                    .padding(Spacing.m)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Color.black.opacity(0.1)))

                    Toggle("Accessories", isOn: Binding(get: { studio.state.accessoriesExpanded }, set: { studio.setAccessoriesExpanded($0) }))
                    Toggle("Dress or one-piece layout", isOn: Binding(get: { studio.state.onePieceLayout }, set: { studio.setOnePieceLayout($0) }))

                    ValidationLine(validation: studio.validation, mode: studio.state.mode)
                    if let note = studio.suggestionNote { Text(verbatim: note).font(.callout).foregroundStyle(.secondary) }

                    Button { Task { await studio.findSomethingThatWorks() } } label: {
                        Label("Find something that works with this", systemImage: "sparkles").frame(maxWidth: .infinity).minimumTarget()
                    }
                    .buttonStyle(.bordered)
                    .disabled(studio.isSuggesting)
                    .accessibilityHint("Changes only the unlocked pieces")
                    .accessibilityIdentifier("studio.find")

                    VStack(spacing: Spacing.s) {
                        Button { Task { report(await studio.saveCombination(name: nil), "Saved for later. Nothing was planned or logged.") } } label: { Text("Save combination").frame(maxWidth: .infinity).minimumTarget() }
                            .buttonStyle(.bordered).accessibilityIdentifier("studio.save")
                        Button { showPlan = true } label: { Text("Plan for a day").frame(maxWidth: .infinity).minimumTarget() }
                            .buttonStyle(.bordered).accessibilityIdentifier("studio.plan")
                        Button { confirmWear = true } label: { Text("Wear this").frame(maxWidth: .infinity).minimumTarget() }
                            .buttonStyle(.glassProminent).accessibilityIdentifier("studio.wear")
                    }
                    if let message { Text(message).font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("studio.message") }
                    if studio.lastSavedCombinationId != nil {
                        Button("Remove saved combination", role: .destructive) { Task { report(await studio.removeLastSaved(), "Removed from saved combinations. Its receipt can undo this.") } }
                            .buttonStyle(.borderless).minimumTarget().accessibilityIdentifier("studio.removeSaved")
                    }
                }
                .padding(Spacing.l)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Studio")
            .toolbar { AppToolbar(showsLaundry: false) }
            .confirmationDialog("Record these pieces as worn today?", isPresented: $confirmWear, titleVisibility: .visible) {
                Button("I'm wearing this") { Task { report(await studio.wearThis(), "Recorded as today's wear.") } }
            }
            .sheet(isPresented: $showPlan) {
                NavigationStack {
                    Form { DatePicker("Day", selection: $planDate, in: Date()..., displayedComponents: .date) }
                        .navigationTitle("Plan for a day")
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showPlan = false } }
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Plan") {
                                    showPlan = false
                                    Task { report(await studio.planForDay(LocalDate(date: planDate, timeZone: app.env.timeZone)), "Planned. It is an intention, not a wear.") }
                                }
                            }
                        }
                }
                .presentationDetents([.medium])
            }
            .task { if app.wardrobe.allItems.isEmpty { await app.wardrobe.refresh() } }
        }
    }

    private func report(_ r: ActionResult, _ success: String) {
        switch r {
        case .done: message = success
        case .queued: message = "Saved on this phone; it will send when online."
        case .refused(let why): message = why
        case .needsFootwear: message = "Choose one pair of shoes."
        }
    }
}

/// One horizontal selector: visible previous/next controls, a swipe that follows the finger, and a lock.
struct RoleSelector: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let role: StudioRole
    @State private var drag: CGFloat = 0

    var body: some View {
        let studio = app.studio
        let locked = studio.state.locks.contains(role)
        let item = studio.selected(role)
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack {
                Text(role.label).font(.caption.weight(.semibold)).foregroundStyle(Color.black.opacity(0.6))
                Spacer()
                Button { studio.toggleLock(role) } label: { Image(systemName: locked ? "lock.fill" : "lock.open") }
                    .minimumTarget()
                    .accessibilityLabel(locked ? "Unlock \(role.label)" : "Lock \(role.label)")
                    .accessibilityIdentifier("studio.\(role.rawValue).lock")
                    .disabled(item == nil)
            }
            HStack(spacing: Spacing.s) {
                Button { studio.previous(role) } label: { Image(systemName: "chevron.left") }
                    .minimumTarget().disabled(locked)
                    .accessibilityLabel("Previous \(role.label)")
                    .accessibilityIdentifier("studio.\(role.rawValue).previous")
                ZStack {
                    if let item {
                        HStack(spacing: Spacing.m) {
                            GarmentTile(name: item.garment.name, category: item.garment.category, media: item.garment.media, compact: true).frame(width: 64)
                            VStack(alignment: .leading) {
                                Text(verbatim: item.garment.name).font(.subheadline).foregroundStyle(Color.black)
                                if let badge = studio.badge(for: item) { Text(badge).font(.caption).foregroundStyle(.orange) }
                            }
                            Spacer(minLength: 0)
                        }
                    } else {
                        Text("None").foregroundStyle(Color.black.opacity(0.5)).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .offset(x: locked || reduceMotion ? 0 : drag)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 12)
                        .onChanged { if !locked { drag = $0.translation.width } }
                        .onEnded { value in
                            // Interrupted gestures settle back; a clear swipe steps locally, without the network.
                            if !locked, abs(value.translation.width) > 50 { _ = value.translation.width < 0 ? studio.next(role) : studio.previous(role) }
                            withAnimation(reduceMotion ? nil : .snappy(duration: 0.18)) { drag = 0 }
                        }
                )
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(role.label): \(item?.garment.name ?? "none")\(locked ? ", locked" : "")")
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: studio.next(role)
                    case .decrement: studio.previous(role)
                    @unknown default: break
                    }
                }
                Button { studio.next(role) } label: { Image(systemName: "chevron.right") }
                    .minimumTarget().disabled(locked)
                    .accessibilityLabel("Next \(role.label)")
                    .accessibilityIdentifier("studio.\(role.rawValue).next")
            }
        }
        .environment(\.colorScheme, .light) // on the white canvas
    }
}

struct ValidationLine: View {
    let validation: StudioViewModel.Validation
    let mode: StudioMode
    var body: some View {
        Group {
            switch validation {
            case .idle: EmptyView()
            case .checking: Label("Checking with Garderobe…", systemImage: "hourglass")
            case .valid(_, let validForDate, let warnings):
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    if mode == .explore {
                        Label("Works as a combination", systemImage: "checkmark.circle")
                        if validForDate == false { Label("Would not pass as a plan for today", systemImage: "calendar.badge.exclamationmark").foregroundStyle(.secondary) }
                    } else {
                        Label("Works for today", systemImage: "checkmark.circle")
                    }
                    ForEach(warnings, id: \.self) { w in
                        Label(w.dayBound == true ? "Today: \(w.message)" : w.message, systemImage: "info.circle").foregroundStyle(.secondary)
                    }
                }
            case .issues(let issues):
                VStack(alignment: .leading, spacing: Spacing.xs) {
                    ForEach(issues, id: \.self) { Label($0.message, systemImage: "exclamationmark.circle") }
                }
            case .unavailable(let why): Label(why, systemImage: "wifi.slash")
            }
        }
        .font(.callout)
        .accessibilityIdentifier("studio.validation")
    }
}
#endif
