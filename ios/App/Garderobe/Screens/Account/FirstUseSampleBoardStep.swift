import SwiftUI
import GarderobeKit

/// Step 5: the first board as the backend composed it from the imported profile and the
/// reconciled inventory: each option's name, its reason and its garments. Nothing is chosen
/// or recorded here.
struct FirstUseSampleBoardStep: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let today = app.today
        Section {
            Text(today.dateLine)
                .font(.headline)
            FreshnessLabel(text: today.freshnessLine, freshness: today.today.freshness)
            if today.options.isEmpty, let statement = today.emptyStatement {
                Text(statement)
            }
        }
        ForEach(today.options) { presentation in
            Section {
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(presentation.option.name)
                        .font(.headline)
                    Text(presentation.option.reason)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let qualification = presentation.option.qualification {
                        Text(qualification)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                ForEach(presentation.visibleGarments) { line in
                    DetailRow(label: Phrases.role(line.role), value: line.name)
                }
            }
        }
        Section {
            Label("Photos of your garments are being found in the background. A missing photo never blocks a recommendation; the few that research cannot find collect under Photos needed in Settings.", systemImage: "photo.on.rectangle.angled")
                .font(.footnote)
                .foregroundStyle(.secondary)
        } footer: {
            Text("Finish opens Today, where you can choose, swap and record what you wore.")
        }
    }
}
