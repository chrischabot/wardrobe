import SwiftUI
import GarderobeKit

/// Consignment, sale, tailoring, storage and similar projects, read-only. They are worked on
/// in Conversation; this list only shows where each one stands. The list is not kept on the
/// phone, so without a connection the screen says so instead of showing something old.
struct ProjectsScreen: View {
    @Environment(AppModel.self) private var app
    @State private var projects: [LifecycleProject] = []
    @State private var hasLoaded = false
    @State private var isLoading = false
    @State private var problem: String?

    var body: some View {
        List {
            Section {
                Text("Projects are worked on in Conversation. This list shows where each one stands.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let problem {
                    Label(problem, systemImage: "exclamationmark.triangle").font(.subheadline)
                } else if isLoading, !hasLoaded {
                    Text("Loading projects...").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            if hasLoaded, projects.isEmpty {
                Section { Text("No projects.").foregroundStyle(.secondary) }
            }
            ForEach(projects, id: \.projectId) { project in
                Section {
                    LabeledContent("Kind", value: Self.name(project.kind))
                    LabeledContent("State", value: Self.name(project.state))
                    if let destination = project.destination { LabeledContent("Where", value: destination) }
                    if let next = project.nextAction { LabeledContent("Next", value: next) }
                } header: {
                    Text(project.title)
                }
            }
        }
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            projects = try await app.environment.api.projects().projects
            hasLoaded = true
            problem = nil
            app.environment.center.noteRead(failure: nil)
        } catch let failure as APIFailure {
            app.environment.center.noteRead(failure: failure)
            if failure.isTransport {
                problem = hasLoaded ? "Offline. This list was loaded earlier and may have changed." : "Offline. Projects are not saved on this phone, so they cannot be shown until you are back online."
            } else {
                problem = failure.ownerMessage
            }
        } catch {
            problem = "The projects could not be loaded."
        }
    }

    private static func name(_ kind: LifecycleKind) -> String {
        switch kind {
        case .consignment: return "Consignment"
        case .sale: return "Sale"
        case .donation: return "Donation"
        case .disposal: return "Disposal"
        case .tailoring: return "Tailoring"
        case .seasonalStorage: return "Seasonal storage"
        case .repair: return "Repair"
        case .other: return "Other"
        case .unknown: return "A kind this version does not recognise"
        }
    }

    private static func name(_ state: LifecycleState) -> String {
        switch state {
        case .open: return "Open"
        case .inProgress: return "In progress"
        case .awaitingOwner: return "Waiting for you"
        case .awaitingExternal: return "Waiting for someone else"
        case .completed: return "Completed"
        case .cancelled: return "Cancelled"
        case .unknown: return "A state this version does not recognise"
        }
    }
}
