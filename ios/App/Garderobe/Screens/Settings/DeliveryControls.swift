import SwiftUI
import GarderobeKit

/// Home location, morning delivery time and the number of daily options, as list sections.
/// Used by Settings and by the first-use delivery step. Every control calls the matching
/// `SettingsModel` method; the values shown are the backend's.
struct DeliveryControls: View {
    @Environment(AppModel.self) private var app
    @State private var homeLabel = ""
    @State private var morning = Date()

    var body: some View {
        let settings = app.settings
        let owner = settings.owner
        Section {
            TextField("Town or area", text: $homeLabel)
                .textInputAutocapitalization(.words)
                .accessibilityLabel("Home location")
                .onChange(of: owner?.homeLocation?.label, initial: true) { _, stored in
                    if let stored { homeLabel = stored }
                }
            Button("Save location") {
                Task { await settings.setHomeLocation(label: trimmedHome, latitude: nil, longitude: nil) }
            }
            .disabled(settings.isWorking || owner == nil || trimmedHome.isEmpty || trimmedHome == owner?.homeLocation?.label)
        } header: {
            Text("Home location")
        } footer: {
            Text(owner?.homeLocation.map { "Used for the morning weather. Currently \($0.label)." } ?? "Used for the morning weather. No home location is set.")
        }
        Section {
            DatePicker("Morning time", selection: $morning, displayedComponents: .hourAndMinute)
                .environment(\.timeZone, app.environment.timeZone)
                .onChange(of: owner?.delivery.morningLocalTime, initial: true) { _, stored in
                    if let stored, let date = date(fromLocalTime: stored) { morning = date }
                }
            Button("Save morning time") {
                Task { await settings.setMorningTime(localTime(morning)) }
            }
            .disabled(settings.isWorking || owner == nil || localTime(morning) == owner?.delivery.morningLocalTime)
        } header: {
            Text("Morning delivery")
        } footer: {
            Text(owner.map { "The day's board is delivered at \($0.delivery.morningLocalTime), in \($0.timezone) time." } ?? "Settings have not loaded yet.")
        }
        Section {
            Picker("Daily options", selection: Binding(get: { owner?.delivery.defaultOptionCount ?? 0 },
                                                       set: { count in Task { await settings.setOptionCount(count) } })) {
                ForEach([3, 4, 5], id: \.self) { count in
                    Text("\(count)").tag(count)
                }
            }
            .pickerStyle(.segmented)
            .disabled(settings.isWorking || owner == nil)
        } header: {
            Text("Number of options each day")
        }
    }

    private var trimmedHome: String { homeLabel.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The picker and these conversions use the owner's timezone, so `07:00` stays `07:00`.
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = app.environment.timeZone
        return calendar
    }

    /// `HH:mm`, the form `setMorningTime` sends.
    private func localTime(_ date: Date) -> String {
        Phrases.clock(date, timeZone: app.environment.timeZone)
    }

    private func date(fromLocalTime value: String) -> Date? {
        let parts = value.split(separator: ":").compactMap { Int($0) }
        guard parts.count >= 2 else { return nil }
        return calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: app.environment.time.now())
    }
}
