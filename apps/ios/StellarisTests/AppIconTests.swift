import Testing
import UIKit

/// The app's icon is Icon Composer's `Icon/AppIcon.icon`, which the asset compiler builds into the
/// app and names in its Info.plist as the primary icon, the one the Home Screen draws.
@Suite struct AppIconTests {
  @Test func namesItsIconAsThePrimaryOne() throws {
    let icons = try #require(
      Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any],
      "the app's Info.plist names no icons")
    let primary = try #require(
      icons["CFBundlePrimaryIcon"] as? [String: Any], "the app's Info.plist names no primary icon")
    #expect(primary["CFBundleIconName"] as? String == "AppIcon")
  }
}
