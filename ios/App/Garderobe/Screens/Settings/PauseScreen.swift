import SwiftUI
import GarderobeKit

/// Pause recommendations. No reason is asked for and the resume date is optional. While paused
/// the screen shows the state and Resume; resuming replays nothing.
struct PauseScreen: View {
    @Environment(AppModel.self) private var app
    @State private var usesResumeDate = false
    @State private var chosenDate: Date?

    var body: some View {
        let settings = app.settings
        List {
            Section {
                Label(settings.pauseLine, systemImage: settings.service?.paused == true ? "pause.circle" : "play.circle")
                SettingsFreshnessLabel(freshness: settings.settings.freshness, subject: "settings")
            }
            if settings.service?.paused == true {
                Section {
                    Button(settings.isWorking ? "Resuming..." : "Resume recommendations") {
                        Task { await settings.resume() }
                    }
                    .disabled(settings.isWorking)
                } footer: {
                    Text("Resuming prepares the next useful board. Nothing is replayed: no backlog of old boards, no missed notifications, and no questions about the days you missed.")
                }
            } else {
                Section {
                    Text("Pausing stops outfit composition, the automatic publication of boards, and wardrobe reminders. Outfit events in Calendar during the pause are removed or silenced so they do not remind you.")
                    Text("Conversation, recording what you wore, and all of your data stay available. Return deadline reminders stay on, because a return window can close during a break.")
                } header: {
                    Text("What pausing does")
                }
                Section {
                    Toggle("Set a resume date", isOn: $usesResumeDate)
                    if usesResumeDate {
                        DatePicker("Resume on", selection: Binding(get: { chosenDate ?? earliestResume }, set: { chosenDate = $0 }),
                                   in: earliestResume..., displayedComponents: .date)
                            .environment(\.timeZone, app.environment.timeZone)
                    }
                } footer: {
                    Text(usesResumeDate ? "Recommendations start again on that date." : "Without a date, recommendations stay paused until you resume them.")
                }
                Section {
                    Button(settings.isWorking ? "Pausing..." : "Pause recommendations") {
                        Task { await settings.pause(resumeOn: resumeOn) }
                    }
                    .disabled(settings.isWorking)
                } footer: {
                    Text("You are not asked why.")
                }
            }
            Section {
                OutcomeLine(outcome: settings.lastOutcome)
                SettingsMessageLine(message: settings.message)
            }
        }
        .navigationTitle("Pause recommendations")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Tomorrow at noon in the owner's timezone: the first date a pause can end on.
    private var earliestResume: Date {
        let tomorrow = Dates.adding(days: 1, to: app.environment.today)
        return Dates.noon(of: tomorrow, in: app.environment.timeZone) ?? app.environment.time.now()
    }

    /// The civil date sent with the pause, in the owner's timezone; nil when no date is set.
    private var resumeOn: LocalDate? {
        guard usesResumeDate else { return nil }
        return Dates.localDate(of: chosenDate ?? earliestResume, in: app.environment.timeZone)
    }
}
