import SwiftUI
import GarderobeKit

/// History search over dated conversations. Results say who said what and when, and the
/// sheet states plainly what the search covered. Opening a result shows it in the transcript.
struct RecallSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var recall = app.recall
        NavigationStack {
            Form {
                Section {
                    TextField("Words to look for", text: $recall.query)
                        .submitLabel(.search)
                        .onSubmit { Task { await recall.search() } }
                    dateRow("From", limit: "Only from a date", date: $recall.from)
                    dateRow("To", limit: "Only up to a date", date: $recall.to)
                    Button {
                        Task { await recall.search() }
                    } label: {
                        Label(recall.isSearching ? "Searching..." : "Search", systemImage: "magnifyingglass")
                    }
                    .disabled(recall.isSearching)
                }
                if let message = recall.message {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                    }
                }
                if recall.result != nil {
                    Section("Results") {
                        if recall.hits.isEmpty {
                            Text("Nothing matching was found.").foregroundStyle(Color.supporting)
                        }
                        ForEach(Array(recall.hits.enumerated()), id: \.offset) { _, hit in
                            Button { open(hit) } label: { hitView(hit) }
                                .buttonStyle(.plain)
                                .accessibilityHint("Opens this message in the conversation")
                        }
                    }
                    if let coverage = recall.coverageLine {
                        Section("What was searched") {
                            Text(coverage).font(.footnote).foregroundStyle(Color.supporting)
                        }
                    }
                }
            }
            .navigationTitle("Search history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    /// An optional civil date: a switch, and a date picker while it is on.
    @ViewBuilder
    private func dateRow(_ title: String, limit: String, date: Binding<LocalDate?>) -> some View {
        let zone = app.environment.timeZone
        Toggle(limit, isOn: Binding(get: { date.wrappedValue != nil },
                                    set: { date.wrappedValue = $0 ? app.environment.today : nil }))
        if let value = date.wrappedValue {
            DatePicker(title,
                       selection: Binding(get: { Dates.noon(of: value, in: zone) ?? app.environment.time.now() },
                                          set: { date.wrappedValue = Dates.localDate(of: $0, in: zone) }),
                       displayedComponents: .date)
                .environment(\.timeZone, zone)
        }
    }

    private func hitView(_ hit: RecallHit) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            Text(app.recall.attribution(hit))
                .font(.footnote.weight(.semibold))
            Text(hit.quote)
                .font(.subheadline)
            ForEach(Array(hit.judgements.enumerated()), id: \.offset) { _, judgement in
                Text("\(kindTitle(judgement.kind.rawValue)): \(judgement.subject)")
                    .font(.caption)
                    .foregroundStyle(Color.supporting)
            }
            ForEach(Array(hit.laterDevelopments.enumerated()), id: \.offset) { _, later in
                Text("Later (\(later.kind.replacingOccurrences(of: "_", with: " "))): \(later.quote)")
                    .font(.caption)
                    .foregroundStyle(Color.supporting)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Metrics.touch, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// `liked` reads "Liked".
    private func kindTitle(_ raw: String) -> String {
        let words = raw.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// Closes the sheet and opens the transcript around the message. The current draft and
    /// reading position are kept by the model for Back to latest.
    private func open(_ hit: RecallHit) {
        let transcript = app.transcript
        let messageId = app.recall.open(hit)
        dismiss()
        Task { await transcript.jump(toMessage: messageId) }
    }
}
