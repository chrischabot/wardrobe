import Foundation
import Observation

/// Consignment, sale, tailoring, storage and similar projects, read-only. They are worked on
/// in Conversation; this list shows where each one stands. It is kept on the phone, so it can
/// be read without a connection, labelled with when it was last checked.
@MainActor
@Observable
public final class ProjectsModel {
    public let environment: AppEnvironment
    public let projects: Resource<ProjectList>

    public init(environment: AppEnvironment) {
        self.environment = environment
        let api = environment.api
        projects = environment.resource("projects") { try await api.projects() }
    }

    /// Shows the saved list at once, then checks it.
    public func open() async {
        projects.loadCached()
        await projects.refresh()
    }

    private static let closed: Set<LifecycleState> = [.completed, .cancelled]

    /// Open projects first, most recently changed first within each group.
    public var all: [LifecycleProject] {
        (projects.value?.projects ?? []).sorted { a, b in
            let ca = ProjectsModel.closed.contains(a.state), cb = ProjectsModel.closed.contains(b.state)
            return ca != cb ? !ca : a.updatedAt > b.updatedAt
        }
    }

    /// Projects that include a garment: shown on its item page.
    public func projects(forGarment garmentId: String) -> [LifecycleProject] {
        all.filter { $0.items.contains { $0.garmentId == garmentId } }
    }

    public var isEmpty: Bool { projects.value != nil && all.isEmpty }

    /// Why nothing can be shown, when nothing was ever saved and the read failed.
    public var unavailableLine: String? {
        guard projects.value == nil, let failure = projects.failure else { return nil }
        return failure.isTransport ? "Offline. Projects have not been saved on this phone yet." : failure.ownerMessage
    }

    public var freshnessLine: String {
        projects.freshness.statement(subject: "projects", now: environment.time.now(), timeZone: environment.timeZone)
    }

    public static func name(_ kind: LifecycleKind) -> String {
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

    public static func name(_ state: LifecycleState) -> String {
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

    /// `Consignment · Waiting for you · 2 items`.
    public func summaryLine(_ project: LifecycleProject) -> String {
        var parts = [ProjectsModel.name(project.kind), ProjectsModel.name(project.state)]
        let units = project.items.reduce(0) { $0 + $1.quantity }
        if units > 0 { parts.append(Phrases.count(units, "item")) }
        return parts.joined(separator: " · ")
    }
}
