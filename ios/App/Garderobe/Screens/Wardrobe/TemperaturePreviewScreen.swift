import SwiftUI
import GarderobeKit

/// What becomes wearable at a chosen temperature, including pieces in seasonal storage.
/// A simulation computed by the backend: it is labelled as one and changes nothing.
struct TemperaturePreviewScreen: View {
    @Environment(AppModel.self) private var app
    @State private var model: TemperaturePreviewModel?
    @State private var temperature: Double = 12

    var body: some View {
        List {
            Section {
                Label(model?.simulationLabel ?? "Simulation. This does not change what is available.", systemImage: "flask")
                    .font(.subheadline.weight(.medium))
                HStack(spacing: Metrics.unit * 3) {
                    Button { temperature = max(-5, temperature - 1) } label: { Image(systemName: "minus.circle") }
                        .touchTarget()
                        .accessibilityLabel("One degree colder")
                    Slider(value: $temperature, in: -5...35, step: 1) { Text("Temperature") }
                        .accessibilityValue("\(Int(temperature)) degrees Celsius")
                    Button { temperature = min(35, temperature + 1) } label: { Image(systemName: "plus.circle") }
                        .touchTarget()
                        .accessibilityLabel("One degree warmer")
                }
                .buttonStyle(.borderless)
                Text("\(Int(temperature)) °C").font(.title3.weight(.semibold))
                if let model, let failure = model.preview.failure {
                    Label(failure.ownerMessage, systemImage: failure.isTransport ? "wifi.slash" : "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(Color.supporting)
                }
            }
            if let preview = model?.preview.value {
                Section("Wearable at this temperature (\(preview.wearable.count))") {
                    ForEach(preview.wearable, id: \.garmentId) { item in
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(item.name)
                            Text("\(Phrases.role(item.role))\(item.inStorage ? " · In storage" : "") · \(item.basis)")
                                .font(.footnote).foregroundStyle(Color.supporting)
                        }
                    }
                }
                Section("Not at this temperature (\(preview.notWearable.count))") {
                    ForEach(preview.notWearable, id: \.garmentId) { item in
                        VStack(alignment: .leading, spacing: Metrics.unit) {
                            Text(item.name)
                            Text(item.why).font(.footnote).foregroundStyle(Color.supporting)
                        }
                    }
                }
            }
        }
        .navigationTitle("Temperature preview")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: temperature) {
            let current = model ?? TemperaturePreviewModel(environment: app.environment, temperatureC: temperature)
            model = current
            // A short pause so dragging the slider does not send a request per degree.
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            current.temperatureC = temperature
            await current.load()
        }
    }
}
