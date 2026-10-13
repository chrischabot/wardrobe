import SwiftUI
import GarderobeKit

/// The freshness sentence for one cached read behind Settings. `SettingsModel` exposes its reads
/// as resources, so the sentence is the resource's own statement; nothing is worded here.
struct SettingsFreshnessLabel: View {
    @Environment(AppModel.self) private var app
    let freshness: Freshness
    /// What was read, in lower case: "style profile", "connections".
    let subject: String

    var body: some View {
        FreshnessLabel(text: freshness.statement(subject: subject, now: app.environment.time.now(), timeZone: app.environment.timeZone),
                       freshness: freshness)
    }
}

/// A model's `message`: why something could not be done, in the model's words. A symbol
/// accompanies the text so the state is not carried by colour.
struct SettingsMessageLine: View {
    let message: String?

    var body: some View {
        if let message, !message.isEmpty {
            Label {
                Text(message)
            } icon: {
                Image(systemName: "exclamationmark.triangle")
            }
            .font(.footnote)
            .foregroundStyle(Color.supporting)
            .accessibilityElement(children: .combine)
        }
    }
}

/// A contract instant as the owner reads it (`today at 07:02`), or the raw value when it does
/// not parse. Main-actor bound because it reads the app's clock and timezone.
@MainActor
struct SettingsInstant {
    let app: AppModel

    func relative(_ instant: Instant) -> String {
        guard let date = Dates.parseInstant(instant) else { return instant }
        return Phrases.relativeTime(date, now: app.environment.time.now(), timeZone: app.environment.timeZone)
    }
}
