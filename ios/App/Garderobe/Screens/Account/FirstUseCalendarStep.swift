import SwiftUI
import GarderobeKit

/// Step 3: the outfit calendar, the calendars read for the day, and how the board appears in
/// Calendar. Skippable: without Google connected the step says so and nothing else is blocked.
struct FirstUseCalendarStep: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if !app.firstUse.googleConnected {
            Section {
                Label("Google is not connected, so there are no calendars to choose from yet. You can go back and connect it, or skip this step: Today works without Calendar.", systemImage: "calendar.badge.exclamationmark")
            }
        }
        OutfitCalendarControls()
        CalendarPresentationControls()
        Section {
            OutcomeLine(outcome: app.settings.lastOutcome)
            SettingsMessageLine(message: app.settings.message)
            SettingsFreshnessLabel(freshness: app.settings.settings.freshness, subject: "settings")
        }
    }
}
