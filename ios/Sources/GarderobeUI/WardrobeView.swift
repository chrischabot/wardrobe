#if os(iOS)
import SwiftUI
import GarderobeKit

struct WardrobeView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var showPreview = false

    var body: some View {
        @Bindable var app = app
        @Bindable var w = app.wardrobe
        NavigationStack(path: $app.wardrobePath) {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.l) {
                    if app.isDemo { DemoBadge() }
                    CountsHeader(counts: w.counts, complete: w.isComplete)
                    let layout = WardrobeViewModel.layout(isAccessibilitySize: typeSize.isAccessibilitySize)
                    if w.items.isEmpty {
                        ContentUnavailableView.search(text: w.query)
                    }
                    ForEach(w.sections, id: \.category) { section in
                        Text(section.category.displayName).font(.headline).accessibilityAddTraits(.isHeader)
                        switch layout {
                        case .grid:
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: Spacing.m)], spacing: Spacing.m) {
                                ForEach(section.items) { item in NavigationLink(value: item.id) { WardrobeTile(item: item) }.buttonStyle(.plain) }
                            }
                        case .list:
                            VStack(spacing: Spacing.s) {
                                ForEach(section.items) { item in NavigationLink(value: item.id) { WardrobeRow(item: item) }.buttonStyle(.plain) }
                            }
                        }
                    }
                }
                .padding(Spacing.l)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Wardrobe")
            .searchable(text: $w.query, prompt: "Dark jeans, the wide stripe, PCF4340…")
            .refreshable { await w.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { FilterMenu() }
                ToolbarItem(placement: .topBarLeading) {
                    Button { showPreview = true } label: { Label("Temperature preview", systemImage: "thermometer.medium") }.accessibilityIdentifier("wardrobe.preview")
                }
                AppToolbar(showsLaundry: true)
            }
            .navigationDestination(for: String.self) { ItemDetailView(model: app.makeItemViewModel($0)) }
            .sheet(isPresented: $showPreview) { TemperaturePreviewView() }
        }
    }
}

struct CountsHeader: View {
    let counts: WardrobeCounts
    let complete: Bool
    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Spacing.l) { items }
            VStack(alignment: .leading, spacing: Spacing.xs) { items }
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("wardrobe.counts")
    }
    @ViewBuilder private var items: some View {
        count(counts.owned, "owned"); count(counts.available, "available"); count(counts.incoming, "incoming"); count(counts.retired, "retired")
        if !complete { Text("Partial list").foregroundStyle(.orange) }
    }
    private func count(_ n: Int, _ label: String) -> some View {
        HStack(spacing: Spacing.xs) { Text("\(n)").fontWeight(.semibold); Text(label).foregroundStyle(.secondary) }
    }
}

struct WardrobeTile: View {
    let item: WardrobeItem
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            GarmentTile(name: item.garment.name, category: item.garment.category, media: item.garment.media)
            Text(verbatim: item.garment.name).font(.subheadline).lineLimit(2)
            Label {
                Text(verbatim: [item.availability.label, QuantityText.text(for: item)].compactMap { $0 }.joined(separator: " · "))
            } icon: { Image(systemName: item.availability.systemImage) }
                .font(.caption).foregroundStyle(item.availability.available ? Color.secondary : Color.orange)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(AccessibilityText.item(item))
        .accessibilityAddTraits(.isButton)
    }
}

/// The readable list used at accessibility text sizes.
struct WardrobeRow: View {
    let item: WardrobeItem
    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            Text(verbatim: item.garment.name).font(.body)
            Label {
                Text(verbatim: [item.availability.label, QuantityText.text(for: item)].compactMap { $0 }.joined(separator: " · "))
            } icon: { Image(systemName: item.availability.systemImage) }
                .font(.callout).foregroundStyle(item.availability.available ? Color.secondary : Color.orange)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface(cornerRadius: 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(AccessibilityText.item(item))
        .accessibilityAddTraits(.isButton)
    }
}

struct FilterMenu: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        @Bindable var w = app.wardrobe
        let facets = w.facets
        Menu {
            Picker("Availability", selection: $w.filter.availability) {
                ForEach(WardrobeFilter.Availability.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            Picker("Category", selection: $w.filter.category) {
                Text("All categories").tag(GarderobeKit.Category?.none)
                ForEach(facets.categories, id: \.self) { Text($0.displayName).tag(Optional($0)) }
            }
            Picker("Colour", selection: $w.filter.colorFamily) {
                Text("Any colour").tag(String?.none)
                ForEach(facets.colors, id: \.self) { Text($0.capitalized).tag(Optional($0)) }
            }
            Picker("Season", selection: $w.filter.season) {
                Text("Any season").tag(String?.none)
                ForEach(facets.seasons, id: \.self) { Text($0).tag(Optional($0)) }
            }
            Picker("Location", selection: $w.filter.location) {
                Text("Anywhere").tag(LocationKind?.none)
                ForEach(facets.locations, id: \.self) { Text($0.displayName).tag(Optional($0)) }
            }
            Picker("Last recorded wear", selection: $w.filter.lastWorn) {
                ForEach(WardrobeFilter.LastWorn.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            if w.filter.isActive { Button("Clear filters", role: .destructive) { w.filter = WardrobeFilter() } }
        } label: {
            Label("Filters", systemImage: w.filter.isActive ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .accessibilityIdentifier("wardrobe.filters")
    }
}

/// "What becomes wearable at 4°?" — explicitly a simulation; nothing's availability changes.
struct TemperaturePreviewView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        @Bindable var w = app.wardrobe
        NavigationStack {
            List {
                Section {
                    Stepper(value: $w.previewTemperature, in: -10...35, step: 1) { Text("\(Int(w.previewTemperature))°C") }
                        .onChange(of: w.previewTemperature) { Task { await w.loadPreview() } }
                } footer: { Text("Simulation only. Nothing is moved out of storage and no availability changes.") }
                if let p = w.preview {
                    Section("Wearable at \(Int(p.temperatureC))° (simulation)") {
                        if let basis = p.basis { Text(basis == "departure" ? "Judged against the temperature at the door" : "Judged against the day's peak").font(.caption).foregroundStyle(.secondary) }
                        ForEach(p.items) { i in
                            HStack {
                                Text(verbatim: i.name)
                                Spacer()
                                if i.inStorage { Text("In storage").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                } else if let e = w.previewError {
                    Text(e).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Temperature preview")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await w.loadPreview() }
        }
    }
}

struct ItemDetailView: View {
    @Environment(AppModel.self) private var app
    @State var model: ItemDetailViewModel
    @State private var refusal: String?
    @State private var showCorrection = false
    @State private var showFullScreen = false

    var body: some View {
        List {
            if let item = model.item {
                Section {
                    Button { showFullScreen = true } label: { GarmentTile(name: item.garment.name, category: item.garment.category, media: item.garment.media) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Catalogue image of \(item.garment.name). Opens full screen.")
                    Text(verbatim: item.garment.name).font(.title2.weight(.semibold))
                }
                if !model.directCommands.isEmpty {
                    Section("Update") {
                        ForEach(model.directCommands) { cmd in
                            Button { Task { if case .refused(let why) = await model.perform(cmd) { refusal = why } } } label: { Label(cmd.title, systemImage: cmd.systemImage).minimumTarget() }
                                .accessibilityIdentifier("item.\(cmd.rawValue)")
                        }
                    }
                }
                if item.availability.state != .available {
                    Section("Status") {
                        Label(item.availability.label, systemImage: item.availability.systemImage)
                            .accessibilityIdentifier("item.status")
                        if let note = model.availabilityNote { Text(note).font(.callout).foregroundStyle(.secondary) }
                        if model.offersLaundry {
                            Button { app.sheet = .laundry } label: { Label("Open Laundry", systemImage: "washer").minimumTarget() }
                                .accessibilityIdentifier("item.openLaundry")
                        }
                    }
                }
                Section("About") {
                    ForEach(model.facts) { f in
                        LabeledContent(f.label) { Text(verbatim: f.value).multilineTextAlignment(.trailing) }
                    }
                    if item.garment.isAnonymousQuantity {
                        Button("Correct the count") { showCorrection = true }
                    }
                }
                if let restrictions = model.detail?.restrictions, !restrictions.isEmpty {
                    Section("Restrictions") {
                        ForEach(restrictions, id: \.restrictionId) { r in
                            VStack(alignment: .leading) { Text(verbatim: r.reason); Text("Lifted only by your say-so").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                let known = model.knownCombinations
                let combos = app.today.cards.filter { $0.composition.contains { $0.garmentId == model.garmentId } }
                if !known.isEmpty {
                    Section("Known combinations") {
                        ForEach(known) { k in
                            VStack(alignment: .leading, spacing: Spacing.xs) {
                                Text(k.boardDate.date(in: app.env.timeZone), format: .dateTime.weekday(.wide).day().month(.wide)).font(.caption).foregroundStyle(.secondary)
                                Text(verbatim: "With " + k.otherPieces.prefix(4).joined(separator: ", "))
                                if let why = k.why { Text(verbatim: why).font(.caption).foregroundStyle(.secondary) }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                } else if !combos.isEmpty {
                    Section("On today's board") {
                        ForEach(combos) { c in Text(verbatim: "Option \(c.position): " + c.composition.filter { $0.garmentId != model.garmentId && !$0.isFlourish }.prefix(4).map(\.name).joined(separator: ", ")) }
                    }
                }
                Section("Recorded wears") {
                    if let history = model.detail?.wearHistory, !history.isEmpty {
                        ForEach(history, id: \.wearingDate) { Text($0.wearingDate.date(in: TimeZone(identifier: "Europe/London")!), format: .dateTime.weekday(.wide).day().month(.wide)) }
                    } else {
                        Text("None recorded yet. That means unlogged, not unworn.").foregroundStyle(.secondary)
                    }
                }
                Section("Receipts") {
                    if model.receipts.isEmpty { Text("No changes recorded on this item.").foregroundStyle(.secondary) }
                    ForEach(model.receipts) { ReceiptRow(receipt: $0) }
                }
                Section {
                    Button { app.askAbout(garmentId: model.garmentId) } label: { Label("Ask about this", systemImage: "bubble.left") }
                        .accessibilityIdentifier("item.ask")
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(model.item?.garment.name ?? "Item")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .alert("Not done", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } })) { Button("OK", role: .cancel) {} } message: { Text(refusal ?? "") }
        .sheet(isPresented: $showCorrection) { CountCorrectionView(model: model) }
        .fullScreenCover(isPresented: $showFullScreen) {
            ZStack(alignment: .topTrailing) {
                Color.white.ignoresSafeArea()
                if let item = model.item { GarmentTile(name: item.garment.name, category: item.garment.category, media: item.garment.media).padding() }
                Button { showFullScreen = false } label: { Image(systemName: "xmark").padding() }.minimumTarget().controlSurface(Circle()).padding().accessibilityLabel("Close")
            }
        }
    }
}

/// Optional reconciliation: a direct aggregate correction, never a shelf check of pair numbers.
struct CountCorrectionView: View {
    let model: ItemDetailViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var owned = 0
    @State private var clean = 0
    @State private var message: String?
    var body: some View {
        NavigationStack {
            Form {
                Stepper("Pairs owned: \(owned)", value: $owned, in: 0...500)
                Stepper("Clean now: \(clean)", value: $clean, in: 0...max(owned, 0))
                if let message { Text(message).foregroundStyle(.secondary) }
            }
            .navigationTitle("Correct the count")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            let s = model.item?.stock
                            let r = await model.reconcile(clean: clean == s?.clean ? nil : clean, totalOwned: owned == s?.totalOwned ? nil : owned)
                            if case .refused(let why) = r { message = why } else { dismiss() }
                        }
                    }
                }
            }
            .onAppear { owned = model.item?.stock.totalOwned ?? 0; clean = model.item?.stock.clean ?? 0 }
        }
        .presentationDetents([.medium])
    }
}
#endif
