import Foundation
import Testing
import UIKit

/// Probe only: prints what the built app holds of its icon.
@Suite struct IconProbeTests {
  @Test func describesTheIcon() {
    let info = Bundle.main.infoDictionary ?? [:]
    for key in ["CFBundleIcons", "CFBundleIcons~ipad", "CFBundleIconName", "CFBundleIconFiles"] {
      print("ICONPROBE \(key) = \(String(describing: info[key]))")
    }
    let files = (try? FileManager.default.contentsOfDirectory(atPath: Bundle.main.bundlePath)) ?? []
    print("ICONPROBE files = \(files.sorted())")
    var names = ["AppIcon", "AppIcon60x60", "AppIcon60x60@2x", "AppIcon76x76"]
    if let icons = info["CFBundleIcons"] as? [String: Any],
      let primary = icons["CFBundlePrimaryIcon"] as? [String: Any],
      let named = primary["CFBundleIconFiles"] as? [String]
    {
      names += named
    }
    for name in names {
      for style in [UIUserInterfaceStyle.light, .dark] {
        let image = UIImage(
          named: name, in: .main, compatibleWith: UITraitCollection(userInterfaceStyle: style))
        let found = image.map { "\($0.size) scale \($0.scale)" } ?? "nil"
        print("ICONPROBE UIImage(named: \(name), style \(style.rawValue)) = \(found)")
      }
    }
    for file in files where file.hasPrefix("AppIcon") {
      let path = (Bundle.main.bundlePath as NSString).appendingPathComponent(file)
      let image = UIImage(contentsOfFile: path)
      print("ICONPROBE contentsOfFile \(file) = \(image.map { "\($0.size) scale \($0.scale)" } ?? "nil")")
    }
  }
}
