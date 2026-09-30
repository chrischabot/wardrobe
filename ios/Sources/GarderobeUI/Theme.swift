#if os(iOS)
import SwiftUI
import GarderobeKit

/// A 4-point rhythm with 16-point content insets (spec section 3).
enum Spacing {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 40
}

extension View {
    /// 44 × 44 pt minimum interactive area.
    func minimumTarget() -> some View { frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
    /// Liquid Glass on controls only; opaque and outlined when transparency is reduced or contrast increased.
    func controlSurface<S: Shape>(_ shape: S = Capsule()) -> some View { modifier(ControlSurface(shape: shape)) }
    /// Quiet, opaque content surface with a subtle border (no decorative shadow).
    func contentSurface(cornerRadius: CGFloat = 20) -> some View { modifier(ContentSurface(cornerRadius: cornerRadius)) }
    /// Motion only when the owner allows it; frequent actions get none.
    func settle<V: Equatable>(_ value: V) -> some View { modifier(Settle(value: value)) }
}

struct ControlSurface<S: Shape>: ViewModifier {
    let shape: S
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        if reduceTransparency || contrast == .increased {
            content
                .background(Color(uiColor: .systemBackground), in: shape)
                .overlay(shape.stroke(Color.primary.opacity(contrast == .increased ? 0.9 : 0.25), lineWidth: contrast == .increased ? 1.5 : 1))
        } else {
            content.glassEffect(.regular.interactive(), in: shape)
        }
    }
}

struct ContentSurface: ViewModifier {
    let cornerRadius: CGFloat
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        content
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(Color.primary.opacity(contrast == .increased ? 0.6 : 0.08)))
    }
}

struct Settle<V: Equatable>: ViewModifier {
    let value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : .snappy(duration: 0.2), value: value)
    }
}

enum Symbols {
    static func garment(_ c: GarderobeKit.Category) -> String {
        switch c.rawValue {
        case "shirt", "tshirt", "polo", "knitwear", "sweatshirt": "tshirt"
        case "jacket", "coat", "blazer", "overshirt": "hanger"
        case "shoes", "sneakers", "boots": "shoe"
        case "socks": "lines.measurement.horizontal"
        case "trousers", "jeans", "shorts": "rectangle.split.2x1"
        case "belt": "minus.rectangle"
        case "scarf", "tie": "wind"
        default: "circle.dashed"
        }
    }
}

/// Garment photographs sit on a neutral white canvas in light and dark mode so tint never alters
/// perceived colour; a restrained outline keeps a white shirt distinguishable from the canvas.
/// Space is reserved from the known aspect ratio before the image downloads.
struct GarmentTile: View {
    let name: String
    let category: GarderobeKit.Category
    let media: GarmentMedia?
    var compact = false

    var body: some View {
        ZStack {
            Color.white
            if let url = media?.thumbnailUrl ?? media?.catalogueImageUrl {
                AsyncImage(url: url, transaction: Transaction(animation: nil)) { phase in
                    if case .success(let image) = phase { image.resizable().scaledToFit().padding(Spacing.s) } else { placeholder }
                }
            } else {
                placeholder
            }
        }
        .aspectRatio(media?.aspectRatio ?? 0.8, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.black.opacity(0.14)))
        .environment(\.colorScheme, .light)
        .accessibilityHidden(true)
    }

    private var placeholder: some View {
        VStack(spacing: Spacing.xs) {
            Image(systemName: Symbols.garment(category)).font(compact ? .body : .title2).foregroundStyle(.secondary)
            if !compact {
                Text(verbatim: name).font(.caption2).multilineTextAlignment(.center).foregroundStyle(Color.black.opacity(0.72)).lineLimit(3)
            }
        }
        .padding(Spacing.s)
    }
}

/// The composition of the real pieces: a deterministic layout, never an imagined rendering.
struct OutfitComposition: View {
    let pieces: [Piece]
    var body: some View {
        let main = pieces.filter { !$0.isFlourish && $0.role != .socks && $0.role != .belt }
        let small = pieces.filter { $0.isFlourish || $0.role == .socks || $0.role == .belt }
        VStack(spacing: Spacing.s) {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: Spacing.s), GridItem(.flexible(), spacing: Spacing.s)], spacing: Spacing.s) {
                ForEach(main) { GarmentTile(name: $0.name, category: $0.category, media: $0.media) }
            }
            if !small.isEmpty {
                HStack(spacing: Spacing.s) {
                    ForEach(small) { GarmentTile(name: $0.name, category: $0.category, media: $0.media, compact: true).frame(maxWidth: 72) }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(Spacing.s)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// A "Demo data" badge whenever the app runs on bundled fixtures.
struct DemoBadge: View {
    var body: some View {
        Label("Demo data", systemImage: "testtube.2")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, Spacing.m).padding(.vertical, Spacing.xs)
            .controlSurface()
            .accessibilityLabel("Running on demo data, not your live wardrobe")
    }
}
#endif
