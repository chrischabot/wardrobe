import SwiftUI
import GarderobeKit

/// Models and budgets, read-only. Which model handles which task is backend configuration and
/// can change without an app update. Search-service charges are a separate budget and are shown
/// apart from model inference.
struct InferenceScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let settings = app.settings
        // The search budget carries the model's own name for it; the rest are model inference.
        let searchName = SettingsModel.budgetName(.search)
        let budgets = settings.budgetLines
        List {
            Section {
                SettingsFreshnessLabel(freshness: settings.settings.freshness, subject: "settings")
                if settings.inference == nil {
                    Text("The assistant module did not report a profile.")
                }
            }
            if settings.inference != nil {
                Section {
                    if settings.routingLines.isEmpty {
                        Text("No task routing was reported.").foregroundStyle(.secondary)
                    }
                    ForEach(Array(settings.routingLines.enumerated()), id: \.offset) { _, entry in
                        row(title: entry.task, detail: entry.line)
                    }
                } header: {
                    Text("Which model does what")
                } footer: {
                    Text("Each task names its model first, then the fallbacks in order. This is set on the server and can change without an app update.")
                }
                Section {
                    let inference = budgets.filter { $0.name != searchName }
                    if inference.isEmpty {
                        Text("No model budgets were reported.").foregroundStyle(.secondary)
                    }
                    ForEach(Array(inference.enumerated()), id: \.offset) { _, entry in
                        row(title: entry.name, detail: entry.line)
                    }
                } header: {
                    Text("Model inference budgets")
                }
                Section {
                    let search = budgets.filter { $0.name == searchName }
                    if search.isEmpty {
                        Text("No search-service budget was reported.").foregroundStyle(.secondary)
                    }
                    ForEach(Array(search.enumerated()), id: \.offset) { _, entry in
                        row(title: entry.name, detail: entry.line)
                    }
                } header: {
                    Text("Search services")
                } footer: {
                    Text("Search services are charged separately from the models and have their own daily limit.")
                }
            }
        }
        .navigationTitle("Models and budgets")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await settings.refreshSettings() }
    }

    private func row(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            Text(title)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
