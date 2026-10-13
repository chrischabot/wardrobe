import SwiftUI
import GarderobeKit

/// What must be read before anything else when a recovery kit has just been issued: what a
/// recovery changed (when there was one), then the kit itself. It fills a screen on its own,
/// so the root or a sheet can show it whenever `app.account.visibleKit` is set.
struct RecoveryOutcomeView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.unit * 4) {
                let summary = app.account.recoverySummary
                if !summary.isEmpty {
                    VStack(alignment: .leading, spacing: Metrics.unit * 2) {
                        SectionHeading(title: "Recovery is complete")
                        ForEach(summary, id: \.self) { line in
                            Label(line, systemImage: "checkmark.circle")
                                .font(.subheadline)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentSurface()
                }
                RecoveryKitView()
                SettingsMessageLine(message: app.account.message)
            }
            .padding(Metrics.inset)
        }
        .background(Color(.systemGroupedBackground))
    }
}
