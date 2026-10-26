// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BoardKit",
  platforms: [.iOS("27.0"), .macOS("15.0")],
  products: [.library(name: "BoardKit", targets: ["BoardKit"])],
  targets: [
    .target(name: "BoardKit"),
    .testTarget(name: "BoardKitTests", dependencies: ["BoardKit"]),
  ]
)
