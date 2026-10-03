import SwiftUI
import GarderobeKit

/// Layout constants: a 4-point rhythm, 16-point content insets, 44-point minimum touch targets.
enum Metrics {
    static let unit: CGFloat = 4
    static let inset: CGFloat = 16
    static let touch: CGFloat = 44
    static let cardRadius: CGFloat = 20
    /// Inner radius for a shape nested `padding` points inside a card, so corners stay concentric.
    static func innerRadius(padding: CGFloat) -> CGFloat { max(4, cardRadius - padding) }
    /// A short, interruptible settle for user-initiated swaps.
    static let settle: Double = 0.2
}

extension Color {
    /// Supporting text (captions, explanations, freshness). The system's secondary label colour
    /// is about 3.5:1 on a white surface, below the 4.5:1 that small text needs, so the app uses
    /// this instead: about 7:1 in light mode and 9:1 in dark mode, more with Increase Contrast.
    static let supporting = Color(UIColor { traits in
        let high = traits.accessibilityContrast == .high
        if traits.userInterfaceStyle == .dark { return UIColor(white: high ? 0.88 : 0.74, alpha: 1) }
        return UIColor(white: high ? 0.2 : 0.33, alpha: 1)
    })
}

extension Animation {
    /// The settle used after a user-initiated swap. Callers pass `reduceMotion` so positional
    /// motion is removed when the system asks for less.
    static func settle(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .easeOut(duration: Metrics.settle)
    }
}

/// A quiet, opaque content surface: subtle border, no shadow. Glass belongs to navigation and
/// controls, not to content.
struct ContentSurface: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    var padding: CGFloat = Metrics.inset

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous)
                    .strokeBorder(Color(.separator).opacity(contrast == .increased ? 1 : 0.5), lineWidth: contrast == .increased ? 1 : 0.5)
            }
    }
}

/// The neutral white canvas garment photographs sit on, in light and dark mode alike, so the
/// interface tint never alters perceived colour. A restrained outline keeps a white shirt
/// distinguishable from the canvas.
struct CatalogueCanvas: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    var radius: CGFloat = Metrics.innerRadius(padding: Metrics.unit * 2)

    func body(content: Content) -> some View {
        content
            .background(Color.white, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Color.black.opacity(contrast == .increased ? 0.35 : 0.12), lineWidth: 1)
            }
            .environment(\.colorScheme, .light) // text drawn on the canvas stays dark on white
    }
}

extension View {
    func contentSurface(padding: CGFloat = Metrics.inset) -> some View { modifier(ContentSurface(padding: padding)) }
    func catalogueCanvas(radius: CGFloat = Metrics.innerRadius(padding: Metrics.unit * 2)) -> some View { modifier(CatalogueCanvas(radius: radius)) }

    /// At least 44 by 44 points of hit area, whatever the text size.
    func touchTarget() -> some View { frame(minWidth: Metrics.touch, minHeight: Metrics.touch).contentShape(Rectangle()) }
}

/// The prominent action style: Liquid Glass where the system provides it and transparency is
/// allowed, otherwise the standard prominent bordered button.
struct PrimaryActionStyle: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            content.buttonStyle(.glassProminent)
        } else {
            content.buttonStyle(.borderedProminent)
        }
    }
}

/// The secondary action style, with the same fallback rule.
struct SecondaryActionStyle: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            content.buttonStyle(.glass)
        } else {
            content.buttonStyle(.bordered)
        }
    }
}

extension View {
    func primaryAction() -> some View { modifier(PrimaryActionStyle()) }
    func secondaryAction() -> some View { modifier(SecondaryActionStyle()) }
}

/// The freshness sentence under a screen's title. Offline or stale states get an icon as well
/// as words, so the state is not conveyed by colour alone.
struct FreshnessLabel: View {
    let text: String
    let freshness: Freshness
    var identifier: String?

    var body: some View {
        if !text.isEmpty {
            Label {
                Text(text)
            } icon: {
                Image(systemName: freshness.isCurrent ? "checkmark.circle" : (freshness.isOffline ? "wifi.slash" : "clock"))
            }
            .font(.footnote)
            // Primary colour: when something was last checked is information, not decoration.
            .foregroundStyle(.primary)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(identifier ?? "freshness")
        }
    }
}

/// The inline result of the last action on a screen: recorded, saved on the phone, refused,
/// or not saved. Each case is worded so it cannot be mistaken for another.
struct OutcomeLine: View {
    let outcome: SubmissionOutcome?

    var body: some View {
        if let outcome {
            Label {
                Text(message(outcome))
            } icon: {
                Image(systemName: symbol(outcome))
            }
            .font(.footnote)
            .foregroundStyle(Color.supporting)
            .accessibilityElement(children: .combine)
        }
    }

    private func message(_ outcome: SubmissionOutcome) -> String {
        switch outcome {
        case .confirmed(let receipt): return "\(Phrases.receiptOutcome(receipt)): \(receipt.summary)"
        case .queued: return "Saved on this phone. It will be sent when you are back online."
        case .rejected(let error): return "Not recorded: \(error.message)"
        case .notSaved(let message): return message
        }
    }

    private func symbol(_ outcome: SubmissionOutcome) -> String {
        switch outcome {
        case .confirmed: return "checkmark.circle"
        case .queued: return "tray.and.arrow.up"
        case .rejected, .notSaved: return "exclamationmark.triangle"
        }
    }
}

/// A section heading in semantic typography.
struct SectionHeading: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.headline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A label and value row that stacks vertically at accessibility text sizes.
struct DetailRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let label: String
    let value: String

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: Metrics.unit) { labelText; valueText }
            } else {
                HStack(alignment: .firstTextBaseline) { labelText; Spacer(minLength: Metrics.unit * 3); valueText.multilineTextAlignment(.trailing) }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var labelText: some View { Text(label).foregroundStyle(Color.supporting) }
    private var valueText: some View { Text(value) }
}
