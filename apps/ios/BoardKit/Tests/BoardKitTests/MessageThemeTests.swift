import Foundation
import Testing

@testable import BoardKit

/// The grays and text colours a message is drawn with are the web's, as `@theme` in
/// `apps/web/src/styles.css` sets them.
@Suite struct MessageThemeTests {
  /// The lightness `--color-<name>: hsl(0 0% <n>%)` gives in `css`.
  static func lightness(_ name: String, in css: String) throws -> Double {
    let start = try #require(css.range(of: "--color-\(name): hsl(0 0% ")).upperBound
    let rest = css[start...]
    let end = try #require(rest.firstIndex(of: "%"))
    return try #require(Double(rest[..<end]))
  }

  @Test func theGraysAreTheWebs() throws {
    let css = try SkyMarkTests.web("styles.css")
    for (name, color) in [
      ("surface-0", MessageTheme.surface0), ("surface-1", MessageTheme.surface1),
      ("surface-2", MessageTheme.surface2), ("line", MessageTheme.line),
      ("line-strong", MessageTheme.lineStrong), ("fg-primary", MessageTheme.fgPrimary),
      ("fg-secondary", MessageTheme.fgSecondary), ("fg-tertiary", MessageTheme.fgTertiary),
      ("fg-muted", MessageTheme.fgMuted),
    ] {
      #expect(SkyColor(lightness: try Self.lightness(name, in: css)) == color, "\(name)")
    }
  }

  /// The marked message's tint and bar, and an open thread's mark, are the classes the web gives
  /// them, whose colours `MessageTheme` copies.
  @Test func theMarkedMessageAndAnOpenThreadAreColouredAsOnTheWeb() throws {
    let css = try SkyMarkTests.web("styles.css")
    #expect(css.contains("bg-amber-300/[0.06] shadow-[inset_2px_0_0_rgb(252_211_77_/_0.5)]"))
    #expect(MessageTheme.markBar == SkyColor(red: 252, green: 211, blue: 77))
    let thread = try SkyMarkTests.web("board/ThreadItem.tsx")
    #expect(thread.contains("text-emerald-400"))
  }

  @Test func theIslandIsBlendedAsTheBrowserBlendsIt() {
    #expect(MessageTheme.island == SkyColor(red: 20, green: 20, blue: 20))
  }

  /// The sky's copies of the same tokens, from `scene.ts`, agree with these.
  @Test func theSkyDrawsWithTheSameGrays() {
    #expect(MessageTheme.surface0 == SkyPalette.surface0)
    #expect(MessageTheme.surface1 == SkyPalette.surface1)
    #expect(MessageTheme.fgSecondary == SkyPalette.fgSecondary)
    #expect(MessageTheme.fgTertiary == SkyPalette.fgTertiary)
    #expect(MessageTheme.fgMuted == SkyPalette.fgMuted)
  }
}
