// swift-tools-version: 6.2
import PackageDescription

// GarderobeKit: platform-independent models, API client, cache, command queue and view models.
//   Builds and tests on Linux (`swift build`, `swift test`) and on Apple platforms.
// GarderobeUI: the SwiftUI screens. Compiled only where SwiftUI exists (Xcode, iOS 27 SDK);
//   on Linux every file is excluded by `#if canImport(SwiftUI)` so the package still builds.
// The iOS app target (App/) and UI tests (UITests/) are defined in project.yml / Garderobe.xcodeproj.
let package = Package(
    name: "Garderobe",
    platforms: [.iOS("27.0"), .macOS("27.0")],
    products: [
        .library(name: "GarderobeKit", targets: ["GarderobeKit"]),
        .library(name: "GarderobeUI", targets: ["GarderobeUI"]),
    ],
    targets: [
        .target(
            name: "GarderobeKit",
            resources: [.copy("Resources/Fixtures")]
        ),
        .target(name: "GarderobeUI", dependencies: ["GarderobeKit"]),
        .testTarget(name: "GarderobeKitTests", dependencies: ["GarderobeKit"]),
    ]
)
