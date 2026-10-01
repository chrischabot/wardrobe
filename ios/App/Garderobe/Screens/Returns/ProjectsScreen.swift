import SwiftUI
import GarderobeKit

/// Consignment, sale, tailoring, storage and similar projects, read-only. They are worked on
/// in Conversation; this list only shows where each one stands. The list is kept on the
/// phone, so it can be read without a connection, labelled with when it was last checked.
struct ProjectsScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let model = app.projects
        List {
            Section {
                Text("Projects are worked on in Conversation. This list shows where each one stands.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                FreshnessLabel(text: model.freshnessLine, freshness: model.projects.freshness)
                if let unavailable = model.unavailableLine {
                    Label(unavailable, systemImage: "exclamationmark.triangle").font(.subheadline)
                }
            }
            if model.isEmpty {
                Section { Text("No projects.").foregroundStyle(.secondary) }
            }
            ForEach(model.all, id: \.projectId) { project in
                Section {
                    LabeledContent("Kind", value: ProjectsModel.name(project.kind))
                    LabeledContent("State", value: ProjectsModel.name(project.state))
                    if let destination = project.destination { LabeledContent("Where", value: destination) }
                    if let next = project.nextAction { LabeledContent("Next", value: next) }
                    ForEach(project.items, id: \.garmentId) { item in
                        NavigationLink(value: AppRoute.item(garmentId: item.garmentId)) {
                            Text(app.wardrobe.snapshot.value?.items.first { $0.garment.garmentId == item.garmentId }?.garment.name ?? "Open the item")
                        }
                    }
                } header: {
                    Text(project.title)
                }
            }
        }
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.projects.refresh() }
        .task { await model.open() }
    }
}
