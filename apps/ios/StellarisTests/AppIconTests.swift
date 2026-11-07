import Testing
import UIKit

/// The app's icon is Icon Composer's `Icon/AppIcon.icon`, which the asset compiler builds into the
/// app and names in its Info.plist as the primary icon, the one the Home Screen draws.
@Suite struct AppIconTests {
  /// The primary icon's entry in the app's Info.plist.
  func primaryIcon() throws -> [String: Any] {
    let icons = try #require(
      Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any],
      "the app's Info.plist names no icons")
    return try #require(
      icons["CFBundlePrimaryIcon"] as? [String: Any], "the app's Info.plist names no primary icon")
  }

  @Test func namesItsIconAsThePrimaryOne() throws {
    let primary = try primaryIcon()
    #expect(primary["CFBundleIconName"] as? String == "AppIcon")
  }

  /// `UIImage(named: "AppIcon")` finds nothing for an Icon Composer icon, so this loads the pictures
  /// the asset compiler writes beside the catalog, which the entry names.
  @Test func loadsThePicturesItNames() throws {
    let primary = try primaryIcon()
    let files = try #require(
      primary["CFBundleIconFiles"] as? [String], "the primary icon names no pictures")
    #expect(!files.isEmpty)
    for file in files {
      let image = try #require(UIImage(named: file), "\(file) doesn't load")
      #expect(image.size.width > 0 && image.size.width == image.size.height, "\(file) isn't square")
    }
  }
}
