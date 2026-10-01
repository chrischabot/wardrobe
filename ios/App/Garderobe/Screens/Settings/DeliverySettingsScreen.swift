import SwiftUI
import GarderobeKit

/// Delivery and location: timezone, home location, morning time, number of options, the weekly
/// laundry reset, and how the board appears in Calendar. Every control sends a settings change
/// against the version on screen; the values shown are the backend's.
struct DeliverySettingsScreen: View {
    @Environment(AppModel.self) private var app

    private static let weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    private static let reminderChoices: [Int] = [0, 10, 30, 60]

    var body: some View {
        let settings = app.settings
        let owner = settings.owner
        List {
            Section {
                SettingsFreshnessLabel(freshness: settings.settings.freshness, subject: "settings")
                OutcomeLine(outcome: settings.lastOutcome)
                SettingsMessageLine(message: settings.message)
            }
            Section {
                Picker("Timezone", selection: Binding(get: { owner?.timezone ?? "" },
                                                      set: { identifier in Task { await settings.setTimezone(identifier) } })) {
                    ForEach(timezones(current: owner?.timezone), id: \.self) { identifier in
                        Text(identifier).tag(identifier)
                    }
                }
                .pickerStyle(.navigationLink)
                .disabled(settings.isWorking || owner == nil)
            } footer: {
                Text("The timezone sets where one day ends and the next begins, and when the morning is.")
            }
            DeliveryControls()
            if let service = owner?.laundry.service {
                Section {
                    Toggle("Weekly laundry reset", isOn: Binding(get: { service.weeklyResetEnabled },
                                                                 set: { enabled in Task { await settings.setWeeklyLaundryReset(enabled: enabled) } }))
                        .disabled(settings.isWorking)
                    DetailRow(label: "Collected", value: "\(weekday(service.collectionWeekday)) at \(service.collectionLocalTime)")
                    DetailRow(label: "Returned", value: weekday(service.returnWeekday))
                    DetailRow(label: "Weekly reset (baseline)", value: weekday(service.baselineWeekday))
                } header: {
                    Text("Laundry service")
                } footer: {
                    Text("With the weekly reset on, the regular laundry cycle clears routine doubt about what is clean. A delay or exception you report still takes precedence. The days are shown for reference.")
                }
            }
            CalendarPresentationControls()
            Section {
                Picker("Calendar reminder", selection: Binding(get: { reminderMinutes(owner) },
                                                               set: { minutes in Task { await settings.setCalendarReminder(minutesBefore: minutes) } })) {
                    Text("None").tag(Int?.none)
                    ForEach(reminderOptions(current: reminderMinutes(owner)), id: \.self) { minutes in
                        Text(minutes == 0 ? "At the time of the event" : "\(minutes) minutes before").tag(Int?.some(minutes))
                    }
                }
                .disabled(settings.isWorking || owner == nil)
            } footer: {
                Text("This is the Calendar event's own reminder. It is separate from the app's notifications, so the morning does not alert twice.")
            }
        }
        .navigationTitle("Delivery and location")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// 1 = Monday ... 7 = Sunday.
    private func weekday(_ iso: Int) -> String {
        (1...7).contains(iso) ? DeliverySettingsScreen.weekdayNames[iso - 1] : "Day \(iso)"
    }

    /// The system's timezone names, with the stored one included even if the system list lacks it.
    private func timezones(current: String?) -> [String] {
        let known = TimeZone.knownTimeZoneIdentifiers
        guard let current, !known.contains(current) else { return known }
        return [current] + known
    }

    /// The stored reminder, read from the same settings extension the model writes.
    private func reminderMinutes(_ owner: OwnerSettings?) -> Int? {
        owner?.extensions["daily"]?["calendar"]?["reminderMinutesBefore"]?.intValue
    }

    private func reminderOptions(current: Int?) -> [Int] {
        guard let current, !DeliverySettingsScreen.reminderChoices.contains(current) else { return DeliverySettingsScreen.reminderChoices }
        return (DeliverySettingsScreen.reminderChoices + [current]).sorted()
    }
}
