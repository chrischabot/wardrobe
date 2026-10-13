import SwiftUI
import GarderobeKit

/// What stands behind Today's weather line: the hours, the source and when it was fetched.
struct WeatherDetailSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let today = app.today
        NavigationStack {
            List {
                Section {
                    if let line = today.weather.value?.line ?? today.board?.weatherLine {
                        Text(line).font(.headline)
                    }
                    if let limitation = today.weather.value?.limitation {
                        Label(limitation, systemImage: "exclamationmark.triangle").font(.subheadline)
                    }
                    if let source = today.weatherSourceLine {
                        Text(source).font(.footnote).foregroundStyle(Color.supporting)
                    }
                    FreshnessLabel(text: today.weather.freshness.statement(subject: "forecast", now: app.environment.time.now(), timeZone: app.environment.timeZone),
                                   freshness: today.weather.freshness)
                }
                if let snapshot = today.weather.value {
                    alerts(snapshot.alerts ?? [])
                    conditions(snapshot.conditions)
                    Section("Hour by hour") {
                        if snapshot.hours.isEmpty {
                            Text("The forecast has no hourly figures.").foregroundStyle(Color.supporting)
                        }
                        ForEach(snapshot.hours) { hour in hourRow(hour) }
                    }
                }
            }
            .navigationTitle("Weather")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await today.weather.refresh() }
            .task { await today.loadWeatherDetail() }
        }
    }

    @ViewBuilder private func alerts(_ alerts: [WeatherAlert]) -> some View {
        if !alerts.isEmpty {
            Section("Warnings") {
                ForEach(alerts.indices, id: \.self) { index in
                    let alert = alerts[index]
                    VStack(alignment: .leading, spacing: Metrics.unit) {
                        Label(alert.title, systemImage: "exclamationmark.triangle")
                        Text([alert.severity, period(alert), alert.source].compactMap { $0 }.joined(separator: " · "))
                            .font(.footnote)
                            .foregroundStyle(Color.supporting)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func period(_ alert: WeatherAlert) -> String? {
        let now = app.environment.time.now(), zone = app.environment.timeZone
        var parts: [String] = []
        if let starts = alert.startsAt, let date = Dates.parseInstant(starts) { parts.append("from \(Phrases.relativeTime(date, now: now, timeZone: zone))") }
        if let ends = alert.endsAt, let date = Dates.parseInstant(ends) { parts.append("until \(Phrases.relativeTime(date, now: now, timeZone: zone))") }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// The day's figures the forecast was summarised from. Only figures the backend reported are shown.
    @ViewBuilder private func conditions(_ day: DayConditions) -> some View {
        let rows = conditionRows(day)
        if !rows.isEmpty {
            Section("The day") {
                ForEach(rows, id: \.label) { row in DetailRow(label: row.label, value: row.value) }
            }
        }
    }

    private func conditionRows(_ day: DayConditions) -> [(label: String, value: String)] {
        var rows: [(label: String, value: String)] = []
        if let c = day.departureC { rows.append((label: "When you leave", value: degrees(c) + interval(day.departureInterval))) }
        if let c = day.peakC { rows.append((label: "Warmest", value: degrees(c) + interval(day.peakInterval))) }
        if let c = day.eveningReturnC { rows.append((label: "Evening", value: degrees(c))) }
        if let p = day.maxPrecipitationProbabilityPct { rows.append((label: "Chance of rain, at most", value: percent(p))) }
        if let h = day.rainLikelyFromHour { rows.append((label: "Rain likely from", value: String(format: "%02d:00", h))) }
        if let g = day.maxWindGustKmh { rows.append((label: "Strongest gusts", value: speed(g))) }
        return rows
    }

    private func interval(_ text: String?) -> String {
        if let text { return ", \(text)" }
        return ""
    }

    private func hourRow(_ hour: WeatherHour) -> some View {
        var temperature = "No temperature"
        if let c = hour.temperatureC { temperature = degrees(c) }
        var figures: [String] = []
        if let p = hour.precipitationProbabilityPct { figures.append("\(percent(p)) rain") }
        if let w = hour.windSpeedKmh { figures.append("wind \(speed(w))") }
        let detail = figures.joined(separator: " · ")
        return Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Metrics.unit) {
                    Text(hour.localTime).font(.headline)
                    Text(temperature)
                    if !detail.isEmpty { Text(detail).foregroundStyle(Color.supporting) }
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: Metrics.unit * 3) {
                    Text(hour.localTime).font(.body.monospacedDigit()).foregroundStyle(Color.supporting)
                    Text(temperature).font(.body.monospacedDigit())
                    Spacer(minLength: Metrics.unit * 2)
                    Text(detail).font(.subheadline).foregroundStyle(Color.supporting).multilineTextAlignment(.trailing)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func degrees(_ value: Double) -> String { "\(Int(value.rounded()))°C" }
    private func percent(_ value: Double) -> String { "\(Int(value.rounded()))%" }
    private func speed(_ value: Double) -> String { "\(Int(value.rounded())) km/h" }
}
