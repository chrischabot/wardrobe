import SwiftUI
import GarderobeKit

/// How the day's board appears in Calendar: a timed 15-minute event at the morning time, or an
/// all-day board with a separate reminder. The two are different and the choice is visible.
struct CalendarPresentationControls: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let settings = app.settings
        Section {
            Picker("Calendar presentation", selection: Binding(get: { settings.calendarPresentationIsAllDay },
                                                               set: { allDay in Task { await settings.setCalendarPresentation(allDay: allDay) } })) {
                Text("Timed event").tag(false)
                Text("All-day board").tag(true)
            }
            .pickerStyle(.segmented)
            .disabled(settings.isWorking || settings.owner == nil)
            VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                Text(timedSentence)
                Text("All-day board: the board sits at the top of the day with no start time, so nothing marks the morning itself. Its reminder is separate and is set on its own.")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        } header: {
            Text("How the board appears in Calendar")
        }
    }

    private var timedSentence: String {
        let time = app.settings.owner?.delivery.morningLocalTime
        let at = time.map { "at \($0)" } ?? "at your morning time"
        return "Timed event: a 15-minute event \(at) (for example 7:00 to 7:15), placed in the morning like any appointment."
    }
}
