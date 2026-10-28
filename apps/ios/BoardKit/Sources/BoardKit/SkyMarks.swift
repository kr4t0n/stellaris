// What the sky draws with: the two CLI marks from the web's `apps/web/src/lib/marks.ts`, the theme
// tokens and phase colours the web's `apps/web/src/sky/scene.ts` mirrors, and a reader of the SVG
// path data the marks are drawn from. `SkyMarkTests` reads both web files and checks every value
// here against them, so a change there fails BoardKit's tests until it is made here too.

import Foundation

/// A colour as the web writes it, `#rrggbb`, with each channel from 0 to 1.
public struct SkyColor: Sendable, Hashable {
  public let red: Double
  public let green: Double
  public let blue: Double

  /// The colour `#rrggbb` names; black for anything else.
  public init(hex: String) {
    let value = Int(hex.dropFirst(), radix: 16) ?? 0
    red = Double((value >> 16) & 255) / 255
    green = Double((value >> 8) & 255) / 255
    blue = Double(value & 255) / 255
  }

  public init(red: Int, green: Int, blue: Int) {
    self.red = Double(red) / 255
    self.green = Double(green) / 255
    self.blue = Double(blue) / 255
  }
}

/// A CLI's mark: its glyph, as SVG path data on a 24-unit grid filled even-odd, the glyph's own
/// fill, and the colour a citizen on that CLI glows with.
public struct CliMark: Sendable, Hashable {
  public let label: String
  public let path: String
  public let fill: String
  public let accent: String

  /// The mark of a CLI, and for one this client doesn't know, a plain ring in the theme's grey.
  public static func of(_ cli: OrUnknown<CliKind>) -> CliMark {
    switch cli {
    case .known(.claude): claude
    case .known(.codex): codex
    case .unknown(let name): CliMark(label: name, path: unknownPath, fill: "#a3a3a3", accent: "#a3a3a3")
    }
  }

  // Path data from LobeHub's icon set (MIT): ClaudeCode.Color and the mono Codex mark.
  public static let claude = CliMark(
    label: "Claude Code",
    path:
      "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z",
    fill: "#D97757", accent: "#fb923c")

  public static let codex = CliMark(
    label: "Codex",
    path:
      "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
    fill: "#f5f5f5", accent: "#10b981")

  /// A ring for a CLI a newer board names, so its citizens still show.
  private static let unknownPath = "M12 4a8 8 0 100 16 8 8 0 100-16zm0 3a5 5 0 110 10 5 5 0 110-10z"
}

/// The theme's colours the sky is drawn in, mirroring the tokens at the top of the web's scene.
public enum SkyPalette {
  public static let surface0 = SkyColor(hex: "#0a0a0a")
  public static let surface1 = SkyColor(hex: "#171717")
  public static let fgSecondary = SkyColor(red: 212, green: 212, blue: 212)
  public static let fgTertiary = SkyColor(red: 163, green: 163, blue: 163)
  public static let fgMuted = SkyColor(red: 115, green: 115, blue: 115)

  /// A task's phase in the colour the task views use for it.
  public static func phase(_ phase: SkyTaskMark.Phase) -> SkyColor {
    switch phase {
    case .waiting: SkyColor(hex: "#fcd34d")
    case .working: SkyColor(hex: "#6ee7b7")
    case .returned: SkyColor(hex: "#fdba74")
    case .landing: SkyColor(hex: "#7dd3fc")
    }
  }
}

/// One step of a path, in the path's own units: SVG's commands with every arc, quadratic, and
/// shorthand turned into lines and cubic curves.
public enum SkyPathElement: Sendable, Hashable {
  case move(SkyPoint)
  case line(SkyPoint)
  case curve(SkyPoint, SkyPoint, SkyPoint)
  case close
}

/// SVG path data read into absolute moves, lines, and cubic curves, as a browser's `Path2D` reads
/// it: numbers may run together (`1.5.5`, `-1-2`) and an arc's flags may take one digit each
/// (`013.046`). Data it can't read ends the path there, as the SVG standard has a browser do.
public func skyPath(_ data: String) -> [SkyPathElement] {
  var reader = PathReader(Array(data.utf8))
  var elements: [SkyPathElement] = []
  var current = SkyPoint(x: 0, y: 0)
  var start = current
  var command: UInt8 = 0
  // The control point a smooth curve reflects, and the command that left it.
  var lastControl: SkyPoint?
  var lastCommand: UInt8 = 0

  while true {
    reader.skipSeparators()
    if let letter = reader.command() {
      command = letter
    } else if reader.atEnd || command == 0 {
      break
    } else if command == UInt8(ascii: "M") {
      command = UInt8(ascii: "L")
    } else if command == UInt8(ascii: "m") {
      command = UInt8(ascii: "l")
    }
    let relative = command >= UInt8(ascii: "a")
    let upper = relative ? command - 32 : command
    let origin = relative ? current : SkyPoint(x: 0, y: 0)
    func point() -> SkyPoint? {
      guard let x = reader.number(), let y = reader.number() else { return nil }
      return SkyPoint(x: origin.x + x, y: origin.y + y)
    }
    var control: SkyPoint?
    switch upper {
    case UInt8(ascii: "Z"):
      elements.append(.close)
      current = start
      // A closing command takes no numbers: the next one must be a command.
      reader.skipSeparators()
      if reader.peekNumber() {
        return elements
      }
      command = 0
    case UInt8(ascii: "M"):
      guard let to = point() else { return elements }
      elements.append(.move(to))
      current = to
      start = to
    case UInt8(ascii: "L"):
      guard let to = point() else { return elements }
      elements.append(.line(to))
      current = to
    case UInt8(ascii: "H"):
      guard let x = reader.number() else { return elements }
      current = SkyPoint(x: origin.x + x, y: current.y)
      elements.append(.line(current))
    case UInt8(ascii: "V"):
      guard let y = reader.number() else { return elements }
      current = SkyPoint(x: current.x, y: (relative ? current.y : 0) + y)
      elements.append(.line(current))
    case UInt8(ascii: "C"):
      guard let first = point(), let second = point(), let to = point() else { return elements }
      elements.append(.curve(first, second, to))
      control = second
      current = to
    case UInt8(ascii: "S"):
      let first = reflected(lastControl, about: current, after: lastCommand, from: "CS")
      guard let second = point(), let to = point() else { return elements }
      elements.append(.curve(first, second, to))
      control = second
      current = to
    case UInt8(ascii: "Q"):
      guard let middle = point(), let to = point() else { return elements }
      elements.append(quadratic(from: current, middle, to))
      control = middle
      current = to
    case UInt8(ascii: "T"):
      let middle = reflected(lastControl, about: current, after: lastCommand, from: "QT")
      guard let to = point() else { return elements }
      elements.append(quadratic(from: current, middle, to))
      control = middle
      current = to
    case UInt8(ascii: "A"):
      guard let rx = reader.number(), let ry = reader.number(), let rotation = reader.number(),
        let large = reader.flag(), let sweep = reader.flag(), let to = point()
      else {
        return elements
      }
      elements += arc(
        from: current, to: to, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
      current = to
    default:
      return elements
    }
    lastControl = control
    lastCommand = upper
  }
  return elements
}

private func reflected(_ control: SkyPoint?, about point: SkyPoint, after command: UInt8, from: String)
  -> SkyPoint
{
  guard let control, from.utf8.contains(command) else {
    return point
  }
  return SkyPoint(x: 2 * point.x - control.x, y: 2 * point.y - control.y)
}

private func quadratic(from start: SkyPoint, _ middle: SkyPoint, _ end: SkyPoint) -> SkyPathElement {
  .curve(
    SkyPoint(x: start.x + 2 / 3 * (middle.x - start.x), y: start.y + 2 / 3 * (middle.y - start.y)),
    SkyPoint(x: end.x + 2 / 3 * (middle.x - end.x), y: end.y + 2 / 3 * (middle.y - end.y)), end)
}

/// An elliptical arc as cubic curves of at most a quarter turn each, by the SVG standard's
/// conversion from its end points to its center (its implementation notes, appendix B.2.4).
private func arc(
  from start: SkyPoint, to end: SkyPoint, rx: Double, ry: Double, rotation: Double, large: Bool,
  sweep: Bool
) -> [SkyPathElement] {
  if start == end {
    return []
  }
  var rx = abs(rx)
  var ry = abs(ry)
  if rx == 0 || ry == 0 {
    return [.line(end)]
  }
  let phi = rotation * .pi / 180
  let (cosPhi, sinPhi) = (cos(phi), sin(phi))
  let dx = (start.x - end.x) / 2
  let dy = (start.y - end.y) / 2
  let x1 = cosPhi * dx + sinPhi * dy
  let y1 = -sinPhi * dx + cosPhi * dy
  let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if lambda > 1 {
    rx *= lambda.squareRoot()
    ry *= lambda.squareRoot()
  }
  let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
  var factor = (max(0, numerator) / denominator).squareRoot()
  if large == sweep {
    factor = -factor
  }
  let cx1 = factor * rx * y1 / ry
  let cy1 = -factor * ry * x1 / rx
  let cx = cosPhi * cx1 - sinPhi * cy1 + (start.x + end.x) / 2
  let cy = sinPhi * cx1 + cosPhi * cy1 + (start.y + end.y) / 2

  func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
    atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  }
  let theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if !sweep && delta > 0 {
    delta -= 2 * .pi
  } else if sweep && delta < 0 {
    delta += 2 * .pi
  }

  let pieces = max(1, Int((abs(delta) / (.pi / 2)).rounded(.up)))
  let step = delta / Double(pieces)
  let k = 4.0 / 3 * tan(step / 4)
  func onEllipse(_ t: Double) -> (point: SkyPoint, tangent: SkyPoint) {
    let (x, y) = (rx * cos(t), ry * sin(t))
    let (tx, ty) = (-rx * sin(t), ry * cos(t))
    return (
      SkyPoint(x: cx + cosPhi * x - sinPhi * y, y: cy + sinPhi * x + cosPhi * y),
      SkyPoint(x: cosPhi * tx - sinPhi * ty, y: sinPhi * tx + cosPhi * ty)
    )
  }
  var elements: [SkyPathElement] = []
  var from = onEllipse(theta)
  for piece in 1...pieces {
    let to = onEllipse(theta + step * Double(piece))
    let last = piece == pieces
    elements.append(
      .curve(
        SkyPoint(x: from.point.x + k * from.tangent.x, y: from.point.y + k * from.tangent.y),
        SkyPoint(x: to.point.x - k * to.tangent.x, y: to.point.y - k * to.tangent.y),
        last ? end : to.point))
    from = to
  }
  return elements
}

/// Reads SVG path data's commands, numbers, and flags.
private struct PathReader {
  private let bytes: [UInt8]
  private var index = 0

  init(_ bytes: [UInt8]) {
    self.bytes = bytes
  }

  var atEnd: Bool { index >= bytes.count }

  mutating func skipSeparators() {
    while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D, 0x0C, 0x2C].contains(bytes[index]) {
      index += 1
    }
  }

  /// The command letter at the reader, if one is there.
  mutating func command() -> UInt8? {
    guard index < bytes.count, "MmZzLlHhVvCcSsQqTtAa".utf8.contains(bytes[index]) else {
      return nil
    }
    index += 1
    return bytes[index - 1]
  }

  func peekNumber() -> Bool {
    guard index < bytes.count else { return false }
    return "+-.0123456789".utf8.contains(bytes[index])
  }

  /// An arc's flag: one digit, 0 or 1, with or without a separator after it.
  mutating func flag() -> Bool? {
    skipSeparators()
    guard index < bytes.count, bytes[index] == UInt8(ascii: "0") || bytes[index] == UInt8(ascii: "1")
    else {
      return nil
    }
    index += 1
    return bytes[index - 1] == UInt8(ascii: "1")
  }

  /// A number: a sign, digits with one point, and an exponent, ending where another would start.
  mutating func number() -> Double? {
    skipSeparators()
    let begin = index
    if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") {
      index += 1
    }
    var digits = 0
    var point = false
    while index < bytes.count {
      let byte = bytes[index]
      if byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9") {
        digits += 1
      } else if byte == UInt8(ascii: "."), !point {
        point = true
      } else {
        break
      }
      index += 1
    }
    guard digits > 0 else {
      index = begin
      return nil
    }
    if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
      var exponent = index + 1
      if exponent < bytes.count,
        bytes[exponent] == UInt8(ascii: "+") || bytes[exponent] == UInt8(ascii: "-")
      {
        exponent += 1
      }
      if exponent < bytes.count, bytes[exponent] >= UInt8(ascii: "0"),
        bytes[exponent] <= UInt8(ascii: "9")
      {
        index = exponent
        while index < bytes.count, bytes[index] >= UInt8(ascii: "0"), bytes[index] <= UInt8(ascii: "9")
        {
          index += 1
        }
      }
    }
    return Double(String(decoding: bytes[begin..<index], as: UTF8.self))
  }
}
