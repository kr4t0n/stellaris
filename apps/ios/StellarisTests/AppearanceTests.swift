import Testing
import UIKit

/// The app is dark only, as the web is: iOS draws every window it opens dark, whatever the system's
/// setting.
@MainActor @Suite struct AppearanceTests {
  @Test func drawsEveryWindowDark() throws {
    let scene = try #require(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
      "the test host has no window scene")
    #expect(scene.traitCollection.userInterfaceStyle == .dark)
    for window in scene.windows {
      #expect(window.traitCollection.userInterfaceStyle == .dark)
    }
    let window = UIWindow(windowScene: scene)
    window.isHidden = false
    defer { window.isHidden = true }
    #expect(window.traitCollection.userInterfaceStyle == .dark)
  }
}
