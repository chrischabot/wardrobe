// swift-tools-version: 6.0
import PackageDescription

// GarderobeKit is the platform-independent core of the native client: the shared contract
// types, the API client, the offline command queue, the local cache and every feature model.
// It builds and tests on Linux (swift.org toolchain) and on Apple platforms. The SwiftUI
// presentation lives in App/ and is built by Garderobe.xcodeproj on a Mac.
//
// There is no recommendation or domain logic here: every decision is made by the backend and
// every change is a domain command that returns a verified receipt.
let package = Package(
    name: "GarderobeKit",
    platforms: [.iOS("26.0"), .macOS("15.0")],
    products: [
        .library(name: "GarderobeKit", targets: ["GarderobeKit"]),
        .executable(name: "garderobe-contract-dump", targets: ["ContractDump"]),
    ],
    targets: [
        .target(
            name: "GarderobeKit",
            path: "Sources/GarderobeKit",
            resources: [.copy("Resources/Fixtures")]
        ),
        .executableTarget(
            name: "ContractDump",
            dependencies: ["GarderobeKit"],
            path: "Sources/ContractDump"
        ),
        .testTarget(
            name: "GarderobeKitTests",
            dependencies: ["GarderobeKit"],
            path: "Tests/GarderobeKitTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
