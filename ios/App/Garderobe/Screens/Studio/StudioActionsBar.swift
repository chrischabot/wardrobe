import SwiftUI
import GarderobeKit

/// Find something that works with this, and the three actions with three different effects:
/// Save combination keeps it, Plan for a day records an intention, Wear this records a wear.
struct StudioActionsBar: View {
    @Environment(AppModel.self) private var app
    @State private var isFinding = false
    @State private var naming = false
    @State private var name = ""
    @State private var planning = false
    @State private var planDate = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            Button {
                Task { isFinding = true; await app.studio.findSomethingThatWorks(); isFinding = false }
            } label: {
                Label(isFinding ? "Looking..." : "Find something that works with this", systemImage: "wand.and.sparkles")
                    .frame(maxWidth: .infinity, minHeight: Metrics.touch)
            }
            .secondaryAction()
            .disabled(isFinding || app.studio.slots.isEmpty)
            .accessibilityHint("Changes only the pieces that are not locked")
            .accessibilityIdentifier(AXID.studioFind)

            if let note = app.studio.suggestionNote { Text(note).font(.footnote).foregroundStyle(.secondary) }
            ForEach(Array(app.studio.suggestions.enumerated()), id: \.offset) { _, suggestion in
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(suggestion.reason).font(.subheadline)
                    Text(suggestion.validation.valid ? "Checked: works" : "Checked: has problems").font(.caption).foregroundStyle(.secondary)
                    Button("Show this on the canvas") { app.studio.apply(suggestion) }.touchTarget()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentSurface(padding: Metrics.unit * 3)
            }

            Divider()

            Button { naming = true } label: {
                Label("Save combination", systemImage: "bookmark").frame(maxWidth: .infinity, minHeight: Metrics.touch)
            }
            .secondaryAction()
            .disabled(app.studio.slots.isEmpty || app.studio.isSubmitting)
            .accessibilityHint("Keeps this combination for later. Does not plan or log anything.")
            .accessibilityIdentifier(AXID.studioSave)

            Button { planning = true } label: {
                Label("Plan for a day", systemImage: "calendar.badge.plus").frame(maxWidth: .infinity, minHeight: Metrics.touch)
            }
            .secondaryAction()
            .disabled(app.studio.slots.isEmpty || app.studio.isSubmitting)
            .accessibilityHint("Records an intention for a date. Not a wear.")
            .accessibilityIdentifier(AXID.studioPlan)

            Button { Task { await app.studio.wearThis() } } label: {
                Label("Wear this", systemImage: "checkmark.circle").frame(maxWidth: .infinity, minHeight: Metrics.touch)
            }
            .primaryAction()
            .disabled(!app.studio.canWearThis || app.studio.isSubmitting)
            .accessibilityHint("Records that you are wearing these today")
            .accessibilityIdentifier(AXID.studioWear)

            if !app.studio.slots.isEmpty && !app.studio.canWearThis {
                Text("Wear this is available only when every piece is one you own and have.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            OutcomeLine(outcome: app.studio.lastOutcome)
            Text("Browsing in Studio changes nothing. Only these three actions do, and each does something different.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .alert("Save combination", isPresented: $naming) {
            TextField("Name (optional)", text: $name)
            Button("Save") {
                let chosen = name.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await app.studio.saveCombination(name: chosen.isEmpty ? nil : chosen); name = "" }
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $planning) {
            NavigationStack {
                Form {
                    DatePicker("Day", selection: $planDate, in: Date()..., displayedComponents: .date)
                    Text("Planning records an intention for that day. It does not record a wear.").font(.footnote).foregroundStyle(.secondary)
                }
                .navigationTitle("Plan for a day")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { planning = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Plan") {
                            let date = Dates.localDate(of: planDate, in: app.environment.timeZone)
                            planning = false
                            Task { await app.studio.planForDay(date) }
                        }
                    }
                }
            }
            .presentationDetents([.medium])
        }
    }
}

/// Saved combinations and day plans.
struct StudioSavedSection: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 3) {
            if !app.studio.combinations.isEmpty {
                SectionHeading(title: "Saved combinations")
                ForEach(app.studio.combinations) { combination in
                    VStack(alignment: .leading, spacing: Metrics.unit) {
                        Text(combination.name ?? "Saved combination").font(.subheadline.weight(.medium))
                        Text("\(Phrases.count(combination.slots.count, "piece")) · \(combination.validation.valid ? "worked when checked" : "had problems when checked")")
                            .font(.footnote).foregroundStyle(.secondary)
                        HStack(spacing: Metrics.unit * 4) {
                            Button("Show on canvas") { app.studio.show(combination) }.touchTarget()
                            Button("Remove", role: .destructive) { Task { await app.studio.removeCombination(combination.combinationId) } }.touchTarget()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentSurface(padding: Metrics.unit * 3)
                }
            }
            if !app.studio.dayPlans.isEmpty {
                SectionHeading(title: "Planned days")
                ForEach(app.studio.dayPlans) { plan in
                    VStack(alignment: .leading, spacing: Metrics.unit) {
                        Text(Phrases.weekdayDayMonth(plan.localDate)).font(.subheadline.weight(.medium))
                        Text(Phrases.count(plan.slots.count, "piece")).font(.footnote).foregroundStyle(.secondary)
                        if plan.needsRevalidation {
                            Label(plan.revalidationReason ?? "Something in this plan changed. Check it again.", systemImage: "exclamationmark.triangle").font(.footnote)
                        }
                        Button("Remove plan", role: .destructive) { Task { await app.studio.removeDayPlan(plan.planId) } }.touchTarget()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentSurface(padding: Metrics.unit * 3)
                }
            }
        }
    }
}
