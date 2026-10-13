import SwiftUI
import GarderobeKit

/// One role's selector. Tapping (or swiping the row and tapping) changes the piece at once,
/// with no request awaited; Previous and Next are the visible alternative to swiping; a
/// locked role stays exactly where it is.
struct StudioSelectorRow: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    let selector: StudioSelector

    private var role: Role { selector.role }
    private var locked: Bool { app.studio.isLocked(role) }
    private var selectedKey: String? { app.studio.slots.first { $0.role == role }.map { key($0.item) } }
    private func key(_ item: StudioSelectorItem) -> String { item.garmentId ?? "candidate:\(item.shoppingCandidate?.candidateId ?? item.name)" }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.unit * 2) {
            header
            if selector.items.isEmpty {
                Text("Nothing to choose from for this role.").font(.footnote).foregroundStyle(Color.supporting)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: Metrics.unit * 3) {
                        ForEach(Array(selector.items.enumerated()), id: \.offset) { _, item in thumbnail(item) }
                    }
                    .padding(.vertical, Metrics.unit)
                }
                .scrollDisabled(locked)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentSurface(padding: Metrics.unit * 3)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(AXID.studioSelector(role.rawValue))
    }

    private var header: some View {
        let controls = HStack(spacing: Metrics.unit * 2) {
            Button { app.studio.step(role, by: -1) } label: { Image(systemName: "chevron.left") }
                .touchTarget()
                .disabled(locked || selector.items.isEmpty)
                .accessibilityLabel("Previous \(Phrases.role(role).lowercased())")
                .accessibilityIdentifier(AXID.studioPrevious(role.rawValue))
            Button { app.studio.step(role, by: 1) } label: { Image(systemName: "chevron.right") }
                .touchTarget()
                .disabled(locked || selector.items.isEmpty)
                .accessibilityLabel("Next \(Phrases.role(role).lowercased())")
                .accessibilityIdentifier(AXID.studioNext(role.rawValue))
            Button { app.studio.toggleLock(role) } label: {
                Label(locked ? "Locked" : "Lock", systemImage: locked ? "lock.fill" : "lock.open")
            }
            .touchTarget()
            .disabled(selectedKey == nil)
            .accessibilityHint(locked ? "Unlocks this piece so suggestions can change it" : "Keeps this piece while suggestions change the others")
            .accessibilityIdentifier(AXID.studioLock(role.rawValue))
        }
        .buttonStyle(.borderless)
        return Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Metrics.unit) { Text(Phrases.role(role)).font(.headline); controls }
            } else {
                HStack { Text(Phrases.role(role)).font(.headline); Spacer(minLength: Metrics.unit * 2); controls }
            }
        }
    }

    private func thumbnail(_ item: StudioSelectorItem) -> some View {
        let isSelected = selectedKey == key(item)
        let marker = StudioModel.markerLabel(item)
        return Button {
            withAnimation(.settle(reduceMotion: reduceMotion)) { app.studio.select(item, for: role) }
        } label: {
            VStack(alignment: .leading, spacing: Metrics.unit) {
                ZStack(alignment: .topTrailing) {
                    if let garmentId = item.garmentId {
                        GarmentImageView(garmentId: garmentId, name: item.name, image: item.image, decorative: true, missing: .note)
                    } else {
                        Text(item.name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.black)
                            .multilineTextAlignment(.center)
                            .padding(Metrics.unit * 2)
                            .frame(maxWidth: .infinity, minHeight: 104 * 4.0 / 3.0)
                            .catalogueCanvas()
                    }
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Color.accentColor)
                            .padding(Metrics.unit)
                    }
                }
                .overlay {
                    if isSelected { RoundedRectangle(cornerRadius: Metrics.innerRadius(padding: Metrics.unit * 2), style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2) }
                }
                Text(item.name).font(.caption).foregroundStyle(.primary).multilineTextAlignment(.leading)
                if let marker { Text(marker).font(.caption2.weight(.medium)).foregroundStyle(Color.supporting) }
            }
            .frame(width: typeSize.isAccessibilitySize ? 150 : 104, alignment: .leading)
        }
        .buttonStyle(.plain)
        .disabled(locked)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([item.name, marker].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
