import SwiftUI
import GarderobeKit

/// A saved product comparison: title, verdict, the table the backend sent and when it was
/// checked. An old check is shown as possibly out of date; the comparison is never hidden.
struct ProductComparisonCard: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var typeSize
    let comparison: ProductComparison

    var body: some View {
        let now = app.environment.time.now()
        let columns = comparison.columns
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            Text(comparison.title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            if let verdict = comparison.verdict, !verdict.isEmpty {
                Text(verdict).font(.subheadline)
            }
            if !columns.isEmpty {
                // A grid needs room: with large text or many columns each product becomes a list.
                if typeSize.isAccessibilitySize || columns.count > 3 {
                    stacked(columns)
                } else {
                    grid(columns)
                }
            }
            VStack(alignment: .leading, spacing: Metrics.unit) {
                Text(comparison.checkedLine(now: now, timeZone: app.environment.timeZone))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if comparison.isStale(now: now) {
                    Label("May be out of date", systemImage: "clock")
                        .font(.footnote.weight(.semibold))
                }
            }
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface(padding: Metrics.unit * 3)
        .accessibilityElement(children: .contain)
    }

    private func grid(_ columns: [String]) -> some View {
        Grid(alignment: .topLeading, horizontalSpacing: Metrics.unit * 3, verticalSpacing: Metrics.unit * 2) {
            GridRow {
                ForEach(columns, id: \.self) { column in
                    Text(heading(column)).font(.footnote.weight(.semibold))
                }
            }
            Divider()
            ForEach(Array(comparison.rows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    ForEach(columns, id: \.self) { column in
                        Text(ProductComparison.cell(row[column])).font(.footnote)
                    }
                }
            }
        }
    }

    private func stacked(_ columns: [String]) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            ForEach(Array(comparison.rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Divider() }
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    ForEach(columns, id: \.self) { column in
                        DetailRow(label: heading(column), value: ProductComparison.cell(row[column]))
                            .font(.footnote)
                    }
                }
            }
        }
    }

    /// The backend's column key as a heading: `checked_at` reads "Checked at".
    private func heading(_ key: String) -> String {
        let words = key.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

/// Cited sources, collapsed until asked for.
struct SourcesCard: View {
    @Environment(AppModel.self) private var app
    let sources: [SourceCitation]
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup("Sources (\(sources.count))", isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: Metrics.unit * 3) {
                ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                    sourceView(source)
                }
            }
            .padding(.top, Metrics.unit * 2)
        }
        .font(.subheadline)
        .contentSurface(padding: Metrics.unit * 3)
    }

    private func sourceView(_ source: SourceCitation) -> some View {
        VStack(alignment: .leading, spacing: Metrics.unit) {
            Text(source.title)
                .font(.subheadline)
            Text(detail(source))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let excerpt = source.excerpt, !excerpt.isEmpty {
                Text(excerpt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let url = webURL(source.url) {
                Link(destination: url) {
                    Label("Open source", systemImage: "arrow.up.right.square")
                        .font(.footnote)
                }
                .touchTarget()
                .accessibilityLabel("Open \(source.title)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// `Maker page, checked today at 07:02`, or the kind alone when no check time was given.
    private func detail(_ source: SourceCitation) -> String {
        let kind = source.kind.replacingOccurrences(of: "_", with: " ")
        guard let checkedAt = source.checkedAt else { return "\(kind), check time unknown" }
        let when = Dates.parseInstant(checkedAt).map { Phrases.relativeTime($0, now: app.environment.time.now(), timeZone: app.environment.timeZone) } ?? checkedAt
        return "\(kind), checked \(when)"
    }

    /// Only web addresses become links.
    private func webURL(_ text: String?) -> URL? {
        guard let text, let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }
}
