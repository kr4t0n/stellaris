// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "BoardKit",
  platforms: [.iOS("27.0"), .macOS("15.0")],
  products: [.library(name: "BoardKit", targets: ["BoardKit"])],
  dependencies: [
    .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.9.0")
  ],
  targets: [
    .target(
      name: "BoardKit",
      dependencies: [.product(name: "Markdown", package: "swift-markdown")]),
    .testTarget(name: "BoardKitTests", dependencies: ["BoardKit"]),
  ]
)
