import SwiftUI
import GarderobeKit

/// Studio: a composed outfit on a white canvas with a selector per role. Browsing changes
/// nothing; only the three actions at the bottom send anything.
struct StudioScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var studio = app.studio
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.unit * 5) {
                Picker("Mode", selection: Binding(get: { app.studio.mode }, set: { mode in Task { await app.studio.setMode(mode) } })) {
                    Text("For today").tag(StudioMode.forToday)
                    Text("Explore").tag(StudioMode.explore)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier(AXID.studioMode)

                Text(app.studio.mode == .explore
                     ? "Explore includes pieces in storage and marked shopping candidates. Nothing here is planned or logged."
                     : "For today shows what you own and can wear today.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                FreshnessLabel(text: app.studio.freshnessLine, freshness: app.studio.studio.freshness)

                StudioCanvas()
                validation

                ForEach(app.studio.visibleSelectors, id: \.role) { selector in
                    StudioSelectorRow(selector: selector)
                }
                if app.studio.hasAccessorySelectors {
                    Toggle("Show accessories", isOn: $studio.accessoriesExpanded)
                        .frame(minHeight: Metrics.touch)
                }

                StudioActionsBar()
                StudioSavedSection()
            }
            .padding(Metrics.inset)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("Studio")
        .task { await app.studio.open() }
        .refreshable { await app.studio.open() }
    }

    @ViewBuilder private var validation: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            switch app.studio.validation {
            case .none:
                EmptyView()
            case .checking:
                Label("Checking this combination...", systemImage: "hourglass").font(.subheadline)
            case .checked(let verdict):
                Label(verdict.valid ? (verdict.wearableOn == nil ? "This works as an exploration. It is not checked as wearable today." : "This works for today.") : "This does not work as it is.",
                      systemImage: verdict.valid ? "checkmark.circle" : "xmark.octagon")
                    .font(.subheadline.weight(.medium))
                ForEach(Array(verdict.violations.enumerated()), id: \.offset) { _, violation in
                    Label("\(violation.severity == .blocking ? "Problem" : "Note"): \(violation.message)", systemImage: violation.severity == .blocking ? "exclamationmark.triangle" : "info.circle")
                        .font(.footnote)
                }
            case .unchecked(let text):
                Label(text, systemImage: "questionmark.circle").font(.subheadline)
            }
            if !app.studio.slots.isEmpty {
                Button("Check this combination") { Task { await app.studio.validate() } }
                    .secondaryAction()
                    .disabled(app.studio.validation == .checking)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.studioValidation)
    }
}
