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

  /// A task's phase, its plan's segments, a gate, and a proposal's status take the classes the
  /// web's task and proposal views give them, whose colours `MessageTheme` copies.
  @Test func phasesPlansAndStatusesAreColouredAsOnTheWeb() throws {
    let tasks = try SkyMarkTests.web("board/tasks.ts")
    for chip in [
      "returned: \"bg-orange-500/15 text-orange-300\"", "waiting: \"bg-amber-500/15 text-amber-300\"",
      "working: \"bg-emerald-500/15 text-emerald-300\"", "landing: \"bg-sky-500/15 text-sky-300\"",
      "done: \"bg-surface-2 text-fg-secondary\"", "abandoned: \"bg-surface-2 text-fg-muted\"",
      "\"bg-red-500/15 text-red-300\"",
    ] {
      #expect(tasks.contains(chip), "\(chip)")
    }
    let strip = try SkyMarkTests.web("board/PlanStrip.tsx")
    for fill in ["bg-emerald-400/60", "bg-fg-primary/90", "bg-amber-300/80", "ring-sky-300/70"] {
      #expect(strip.contains(fill), "\(fill)")
    }
    let task = try SkyMarkTests.web("board/TaskView.tsx")
    for style in ["bg-sky-400/10 px-1.5 py-px text-[11px] text-sky-300", "bg-emerald-400/20 text-emerald-300"] {
      #expect(task.contains(style), "\(style)")
    }
    let proposals = try SkyMarkTests.web("board/ProposalsView.tsx")
    for status in [
      "proposed: \"bg-amber-500/15 text-amber-300\"",
      "provisioned: \"bg-emerald-500/15 text-emerald-300\"",
      "rejected: \"bg-red-500/15 text-red-300\"", "retired: \"bg-surface-2 text-fg-muted\"",
    ] {
      #expect(proposals.contains(status), "\(status)")
    }
    #expect(MessageTheme.sky300 == MessageTheme.mention)
    #expect(MessageTheme.sky400 == MessageTheme.mentionTint)
    #expect(MessageTheme.amber300 == MessageTheme.markTint)
    #expect(MessageTheme.emerald400 == MessageTheme.threadOpen)
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
