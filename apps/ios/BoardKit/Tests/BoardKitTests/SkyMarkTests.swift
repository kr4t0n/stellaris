import Foundation
import Testing

@testable import BoardKit

/// The sky draws with the web's marks and colours, read here from the web's own sources, and reads
/// SVG path data as a browser does.
@Suite struct SkyMarkTests {
  /// A file of the web's sources, beside this package.
  static func web(_ path: String) throws -> String {
    let apps = Fixture.folder.deletingLastPathComponent().deletingLastPathComponent()
    return try String(contentsOf: apps.appendingPathComponent("web/src/\(path)"), encoding: .utf8)
  }

  /// The string a `key: "value"` holds in `text`, after `from`.
  static func value(_ key: String, in text: String, after from: String) throws -> String {
    let start = try #require(text.range(of: from)).upperBound
    let field = try #require(text[start...].range(of: "\(key): \""))
    let rest = text[field.upperBound...]
    return String(rest[..<(try #require(rest.firstIndex(of: "\"")))])
  }

  /// The string a `const NAME = "value";` holds in `text`.
  static func constant(_ name: String, in text: String) throws -> String {
    let start = try #require(text.range(of: "const \(name) = \"")).upperBound
    let rest = text[start...]
    return String(rest[..<(try #require(rest.firstIndex(of: "\"")))])
  }

  @Test func theMarksAreTheWebs() throws {
    let marks = try SkyMarkTests.web("lib/marks.ts")
    for (cli, mark) in [("claude", CliMark.claude), ("codex", CliMark.codex)] {
      let block = "  \(cli): {"
      #expect(try SkyMarkTests.value("label", in: marks, after: block) == mark.label)
      #expect(try SkyMarkTests.value("path", in: marks, after: block) == mark.path)
      #expect(try SkyMarkTests.value("fill", in: marks, after: block) == mark.fill)
      #expect(try SkyMarkTests.value("accent", in: marks, after: block) == mark.accent)
    }
  }

  @Test func theColoursAreTheScenes() throws {
    let scene = try SkyMarkTests.web("sky/scene.ts")
    #expect(SkyColor(hex: try SkyMarkTests.constant("SURFACE_0", in: scene)) == SkyPalette.surface0)
    #expect(SkyColor(hex: try SkyMarkTests.constant("SURFACE_1", in: scene)) == SkyPalette.surface1)
    for (name, color) in [
      ("FG_SECONDARY", SkyPalette.fgSecondary), ("FG_TERTIARY", SkyPalette.fgTertiary),
      ("FG_MUTED", SkyPalette.fgMuted),
    ] {
      let channels = try SkyMarkTests.constant(name, in: scene).split(separator: ",")
        .compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
      #expect(channels.count == 3)
      #expect(SkyColor(red: channels[0], green: channels[1], blue: channels[2]) == color, "\(name)")
    }
    let phases: [SkyTaskMark.Phase] = [.waiting, .working, .returned, .landing]
    for phase in phases {
      let hex = try SkyMarkTests.value(phase.rawValue, in: scene, after: "const PHASE_COLOR")
      #expect(SkyColor(hex: hex) == SkyPalette.phase(phase), "\(phase)")
    }
  }

  /// Each mark reads to its end, inside its 24-unit grid, in the subpaths its data draws.
  @Test func theMarksReadWhole() {
    for (mark, subpaths) in [(CliMark.claude, 3), (CliMark.codex, 3)] {
      let elements = skyPath(mark.path)
      #expect(elements.filter { $0 == .close }.count == subpaths, "\(mark.label)")
      let points = elements.flatMap { element -> [SkyPoint] in
        switch element {
        case .move(let point), .line(let point): [point]
        case .curve(let first, let second, let end): [first, second, end]
        case .close: []
        }
      }
      #expect(points.allSatisfy { (-0.5...24.5).contains($0.x) && (-0.5...24.5).contains($0.y) })
      #expect(points.contains { $0.x > 20 } && points.contains { $0.x < 4 })
    }
    #expect(skyPath(CliMark.of(.unknown("gemini")).path).filter { $0 == .close }.count == 2)
  }

  @Test func numbersRunTogetherAsInABrowser() {
    #expect(
      skyPath("M1.5.5L-1-2h.25v1e1z") == [
        .move(SkyPoint(x: 1.5, y: 0.5)), .line(SkyPoint(x: -1, y: -2)),
        .line(SkyPoint(x: -0.75, y: -2)), .line(SkyPoint(x: -0.75, y: 8)), .close,
      ])
    // Pairs after a move are lines, relative after a relative move.
    #expect(
      skyPath("m1 1 2 2M5 5 6 6") == [
        .move(SkyPoint(x: 1, y: 1)), .line(SkyPoint(x: 3, y: 3)), .move(SkyPoint(x: 5, y: 5)),
        .line(SkyPoint(x: 6, y: 6)),
      ])
    // Data it can't read ends the path there.
    #expect(skyPath("M0 0L1 1L2") == [.move(SkyPoint(x: 0, y: 0)), .line(SkyPoint(x: 1, y: 1))])
  }

  /// A half turn of a circle of radius 1 from (0, 0) to (2, 0): two quarter curves through the
  /// point a quarter turn round. With the sweep flag set the arc turns clockwise as drawn, where y
  /// grows downward, so it passes above the line; without it, below.
  @Test func anArcIsQuarterCurves() throws {
    for (sweep, side) in [("1", -1.0), ("0", 1.0)] {
      let elements = skyPath("M0 0a1 1 0 0\(sweep)2 0")
      #expect(elements.count == 3)
      guard case .curve(_, _, let middle) = elements[1], case .curve(_, _, let end) = elements[2]
      else {
        Issue.record("the arc isn't two curves")
        continue
      }
      #expect(abs(middle.x - 1) < 1e-9 && abs(middle.y - side) < 1e-9)
      #expect(end == SkyPoint(x: 2, y: 0))
    }
    // A radius too small for the ends grows to fit them; a zero one draws a line.
    guard case .curve(_, _, let end) = try #require(skyPath("M0 0A0.5 0.5 0 0 1 4 0").last) else {
      Issue.record("the arc isn't curves")
      return
    }
    #expect(end == SkyPoint(x: 4, y: 0))
    #expect(skyPath("M0 0a0 1 0 0 1 2 0") == [.move(SkyPoint(x: 0, y: 0)), .line(SkyPoint(x: 2, y: 0))])
  }

  @Test func aSmoothCurveReflectsTheLastControl() {
    #expect(
      skyPath("M0 0C1 1 2 1 3 0S5 -1 6 0") == [
        .move(SkyPoint(x: 0, y: 0)),
        .curve(SkyPoint(x: 1, y: 1), SkyPoint(x: 2, y: 1), SkyPoint(x: 3, y: 0)),
        .curve(SkyPoint(x: 4, y: -1), SkyPoint(x: 5, y: -1), SkyPoint(x: 6, y: 0)),
      ])
    // A quadratic's control at two thirds of the way from each end.
    #expect(
      skyPath("M0 0Q3 3 6 0") == [
        .move(SkyPoint(x: 0, y: 0)), .curve(SkyPoint(x: 2, y: 2), SkyPoint(x: 4, y: 2), SkyPoint(x: 6, y: 0)),
      ])
  }
}
