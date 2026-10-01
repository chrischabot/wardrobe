import SwiftUI
import GarderobeKit

/// The options as a horizontal, paging carousel. Swiping is never the only way through it:
/// Previous and Next buttons and a position line sit underneath.
struct OptionCarousel: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    let options: [OptionPresentation]
    /// The ID of the option in view. Owned by Today so a link can move the carousel.
    @Binding var position: String?
    var highlightedId: String?

    var body: some View {
        VStack(spacing: Metrics.unit * 3) {
            ScrollView(.horizontal) {
                // Not lazy: every card is measured, so the carousel's height does not change while paging.
                HStack(alignment: .top, spacing: Metrics.unit * 3) {
                    ForEach(options) { option in
                        OptionCard(option: option, isHighlighted: option.id == highlightedId)
                            .containerRelativeFrame(.horizontal)
                    }
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, Metrics.inset, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $position)
            .scrollIndicators(.hidden)
            .accessibilityIdentifier(AXID.todayCarousel)

            controls
                .padding(.horizontal, Metrics.inset)
        }
    }

    private var currentIndex: Int {
        options.firstIndex { $0.id == position } ?? 0
    }

    @ViewBuilder private var controls: some View {
        if typeSize.isAccessibilitySize {
            VStack(spacing: Metrics.unit * 2) { positionText; previousButton; nextButton }
        } else {
            HStack(spacing: Metrics.unit * 3) { previousButton; Spacer(minLength: 0); positionText; Spacer(minLength: 0); nextButton }
        }
    }

    private var positionText: some View {
        Text("\(currentIndex + 1) of \(options.count)")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Option \(currentIndex + 1) of \(options.count)")
    }

    private var previousButton: some View {
        Button { move(by: -1) } label: { Label("Previous", systemImage: "chevron.left") }
            .secondaryAction()
            .controlSize(.large)
            .disabled(currentIndex <= 0)
            .accessibilityLabel("Previous option")
            .accessibilityIdentifier(AXID.todayPrevious)
    }

    private var nextButton: some View {
        Button { move(by: 1) } label: { HStack(spacing: Metrics.unit) { Text("Next"); Image(systemName: "chevron.right") } }
            .secondaryAction()
            .controlSize(.large)
            .disabled(currentIndex >= options.count - 1)
            .accessibilityLabel("Next option")
            .accessibilityIdentifier(AXID.todayNext)
    }

    /// Moves one card. The short settle is removed when Reduce Motion is on.
    private func move(by step: Int) {
        let target = currentIndex + step
        guard options.indices.contains(target) else { return }
        withAnimation(Animation.settle(reduceMotion: reduceMotion)) { position = options[target].id }
    }
}
