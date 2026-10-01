import SwiftUI
import GarderobeKit

/// The dedicated outfit calendar and the calendars read for the day's context, as list
/// sections. The backend only writes to a calendar it created, so an existing calendar is never
/// offered as the target.
struct OutfitCalendarControls: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let settings = app.settings
        let list = settings.calendars
        Section {
            Label(statusLine(list), systemImage: list?.outfitCalendarId == nil ? "calendar.badge.plus" : "checkmark.circle")
                // Reloads when Google becomes connected (or the connection changes).
                .task(id: settings.googleConnection?.connectionId) { await settings.loadCalendars() }
            if list?.outfitCalendarId == nil {
                Button(settings.isWorking ? "Working..." : "Create the outfit calendar") {
                    Task { await settings.createOutfitCalendar() }
                }
                .disabled(settings.isWorking)
            }
            if list == nil {
                Button("Load my calendars") {
                    Task { await settings.loadCalendars() }
                }
                .disabled(settings.isWorking)
            }
        } header: {
            Text("Outfit calendar")
        } footer: {
            Text("Garderobe writes the day's board only to a calendar it created itself. Your other calendars are never written to.")
        }
        if let list, !list.calendars.isEmpty {
            Section {
                ForEach(list.calendars, id: \.calendarId) { calendar in
                    Toggle(isOn: Binding(get: { calendar.readForContext },
                                         set: { read in Task { await settings.setReadCalendars(readIds(list, setting: calendar.calendarId, to: read)) } })) {
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(calendar.name)
                            if let note = note(calendar) {
                                Text(note).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .disabled(settings.isWorking)
                }
            } header: {
                Text("Calendars read for the day")
            } footer: {
                Text("Events in these calendars are read when the day's options are prepared. Reading never changes them.")
            }
        }
    }

    private func statusLine(_ list: ConnectionCalendarList?) -> String {
        guard let list else { return "Your calendars have not been loaded." }
        guard let id = list.outfitCalendarId else { return "There is no outfit calendar yet." }
        let name = list.calendars.first { $0.calendarId == id }?.name
        return name.map { "The outfit calendar is \"\($0)\"." } ?? "The outfit calendar exists."
    }

    private func note(_ calendar: ConnectionCalendar) -> String? {
        if calendar.outfitCalendar { return "The outfit calendar" }
        if calendar.primary { return "Your main calendar" }
        return nil
    }

    /// The complete list `setReadCalendars` expects, with one calendar switched.
    private func readIds(_ list: ConnectionCalendarList, setting calendarId: String, to read: Bool) -> [String] {
        var ids = list.calendars.filter(\.readForContext).map(\.calendarId)
        ids.removeAll { $0 == calendarId }
        if read { ids.append(calendarId) }
        return ids
    }
}
