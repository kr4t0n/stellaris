import BoardKit
import SwiftUI

/// Draws one frame of the sky, the drawing half of the web's `SkyScene` in
/// `apps/web/src/sky/scene.ts`: `SkyScene.frame` in BoardKit has worked out where everything goes
/// and how bright it is, so this strokes and fills, call for call as the web's canvas does. The
/// names are in the system's font where the web uses its own.
@MainActor struct SkyDrawing {
  let frame: SkyFrame

  private static let white = Color.white
  /// The sphere's haze, the web's `rgba(160, 170, 255, …)`.
  private static let nebula = SkyColor(red: 160, green: 170, blue: 255)
  private static let bubbleWidth = 240.0

  func draw(in context: inout GraphicsContext) {
    let bounds = CGRect(x: 0, y: 0, width: frame.width, height: frame.height)
    context.fill(Path(bounds), with: .color(Color(sky: SkyPalette.surface0)))
    drawSpecks(in: &context, bounds: bounds)
    drawAnchors(in: &context)
    drawTasks(in: &context)
    for star in frame.stars {
      drawStar(star, in: &context)
    }
    drawBubbles(in: &context)
  }

  private func drawSpecks(in context: inout GraphicsContext, bounds: CGRect) {
    for speck in frame.specks {
      context.fill(
        Path(CGRect(x: speck.x, y: speck.y, width: speck.size, height: speck.size)),
        with: .color(SkyDrawing.white.opacity(speck.alpha)))
    }
    // A faint core of light behind the society, so the center reads as the heart of the sky.
    context.fill(
      Path(bounds),
      with: .radialGradient(
        Gradient(colors: [SkyDrawing.white.opacity(0.035), SkyDrawing.white.opacity(0)]),
        center: point(frame.core), startRadius: 0, endRadius: max(1, frame.coreGlow)))
  }

  private func drawAnchors(in context: inout GraphicsContext) {
    var spokes = Path()
    for sphere in frame.spheres where sphere.kind == .project {
      spokes.move(to: point(frame.core))
      spokes.addLine(to: point(sphere.center))
    }
    context.stroke(
      spokes, with: .color(SkyDrawing.white.opacity(0.07)),
      style: StrokeStyle(lineWidth: 1, dash: [2, 7]))

    for sphere in frame.spheres {
      let at = point(sphere.center)
      let ring = sphere.ring
      if sphere.kind == .project {
        let haze = ring * 1.8
        context.fill(
          Path(CGRect(x: at.x - haze, y: at.y - haze, width: haze * 2, height: haze * 2)),
          with: .radialGradient(
            Gradient(colors: [
              Color(sky: SkyDrawing.nebula, opacity: sphere.focused ? 0.1 : 0.05),
              Color(sky: SkyDrawing.nebula, opacity: 0),
            ]), center: at, startRadius: 0, endRadius: max(1, haze)))
      }
      let alpha = sphere.focused ? 0.28 : sphere.kind == .society ? 0.09 : 0.06
      context.stroke(
        circle(at, ring), with: .color(SkyDrawing.white.opacity(alpha)),
        lineWidth: sphere.focused ? 1.5 : 1)
      let below = CGPoint(x: at.x, y: at.y + ring + 10)
      if sphere.kind == .society {
        let label = Text(sphere.label.uppercased())
          .font(.system(size: 10, weight: .semibold))
          .tracking(2)
          .foregroundStyle(Color(sky: SkyPalette.fgMuted, opacity: 0.9))
        context.draw(label, at: below, anchor: .top)
      } else {
        let label = Text(sphere.label)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(
            sphere.focused
              ? Color(sky: SkyColor(hex: "#f5f5f5"))
              : Color(sky: SkyPalette.fgTertiary, opacity: 0.95))
        context.draw(label, at: below, anchor: .top)
      }
    }
  }

  /// Every task in play as a mark on its project's orbit, and a thread of light from each held
  /// task to its holder's star while the holder is in a turn there, with a spark running along it.
  private func drawTasks(in context: inout GraphicsContext) {
    for link in frame.links {
      let color = SkyPalette.phase(link.phase)
      var line = Path()
      line.move(to: point(link.from))
      line.addLine(to: point(link.to))
      context.stroke(
        line,
        with: .linearGradient(
          Gradient(colors: [
            Color(sky: color, opacity: 0.55 * link.alpha), Color(sky: color, opacity: 0.12 * link.alpha),
          ]), startPoint: point(link.from), endPoint: point(link.to)),
        lineWidth: 1)
      if let spark = link.spark {
        context.fill(circle(point(spark), 1.4), with: .color(Color(sky: color, opacity: 0.85 * link.alpha)))
      }
    }
    for mark in frame.marks {
      let color = SkyPalette.phase(mark.phase)
      let at = point(mark.center)
      context.drawLayer { layer in
        layer.opacity = mark.alpha
        glow(color, at: at, size: mark.size * 7, in: &layer)
        layer.translateBy(x: at.x, y: at.y)
        layer.rotate(by: .degrees(45))
        let half = mark.size / 2
        layer.fill(
          Path(CGRect(x: -half, y: -half, width: mark.size, height: mark.size)),
          with: .color(Color(sky: color)))
        if mark.hovered {
          layer.opacity = 1
          layer.stroke(
            Path(CGRect(x: -half - 2, y: -half - 2, width: mark.size + 4, height: mark.size + 4)),
            with: .color(SkyDrawing.white.opacity(0.8 * mark.alpha)), lineWidth: 1)
        }
      }
    }
  }

  private func drawStar(_ star: SkyFrame.Star, in context: inout GraphicsContext) {
    let mark = CliMark.of(star.cli)
    let accent = SkyColor(hex: mark.accent)
    let at = point(star.center)
    let radius = star.radius
    context.drawLayer { layer in
      layer.opacity = star.glowAlpha
      glow(accent, at: at, size: star.glowSize, in: &layer)
    }
    context.drawLayer { layer in
      layer.opacity = star.presence
      if let ripple = star.ripple {
        layer.stroke(
          circle(at, ripple.radius), with: .color(Color(sky: accent, opacity: ripple.alpha)),
          lineWidth: 1.25)
      }
      if let flash = star.flash {
        layer.stroke(
          circle(at, flash.radius), with: .color(SkyDrawing.white.opacity(flash.alpha)),
          lineWidth: 1.25)
      }
      if let resident = star.residentRing {
        layer.stroke(circle(at, resident), with: .color(Color(sky: accent, opacity: 0.3)), lineWidth: 1)
      }
      if let queued = star.queuedRing {
        layer.stroke(
          circle(at, queued), with: .color(Color(sky: SkyPalette.fgSecondary, opacity: 0.55)),
          style: StrokeStyle(lineWidth: 1, dash: [3, 4], dashPhase: star.queuedDash))
      }
      let disc = circle(at, radius)
      layer.fill(disc, with: .color(Color(sky: SkyPalette.surface1)))
      layer.stroke(
        disc, with: .color(Color(sky: accent, opacity: star.hovered ? 0.95 : 0.6)),
        lineWidth: star.hovered ? 1.75 : 1.25)
      let glyph = radius * 1.2 / 24
      layer.fill(
        SkyGlyphs.path(for: mark).applying(
          CGAffineTransform(translationX: -12, y: -12)
            .concatenating(CGAffineTransform(scaleX: glyph, y: glyph))
            .concatenating(CGAffineTransform(translationX: at.x, y: at.y))),
        with: .color(Color(sky: SkyColor(hex: mark.fill))), style: FillStyle(eoFill: true))
      for spark in star.sparks {
        layer.fill(circle(point(spark), 1.6), with: .color(Color(sky: accent, opacity: 0.9)))
      }
      // Names shrink with the sky, down to a floor, so they keep clear of neighbouring stars.
      let name = Text(star.name)
        .font(.system(size: star.nameSize, weight: .medium))
        .foregroundStyle(Color(sky: SkyPalette.fgSecondary, opacity: star.nameAlpha))
      layer.draw(name, at: CGPoint(x: at.x, y: star.nameTop), anchor: .top)
    }
  }

  /// Each post's first line in a small card above its star, rising and fading as it goes.
  private func drawBubbles(in context: inout GraphicsContext) {
    for bubble in frame.bubbles {
      let text = context.resolve(
        Text(SkyDrawing.fitted(bubble.text, in: context))
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Color(sky: SkyPalette.fgSecondary)))
      let size = text.measure(in: CGSize(width: CGFloat.infinity, height: 40))
      let width = size.width + 16
      let height = 22.0
      let radius = max(10, bubble.starRadius)
      let x = bubble.star.x - width / 2
      let y = bubble.star.y - radius - 14 - height - bubble.rise
      context.drawLayer { layer in
        layer.opacity = bubble.alpha
        let card = Path(
          roundedRect: CGRect(x: x, y: y, width: width, height: height), cornerRadius: 7)
        layer.fill(card, with: .color(Color(sky: SkyPalette.surface1, opacity: 0.92)))
        layer.stroke(card, with: .color(SkyDrawing.white.opacity(0.1)), lineWidth: 1)
        layer.draw(text, at: CGPoint(x: x + 8, y: y + height / 2 + 0.5), anchor: .leading)
      }
    }
  }

  /// A line cut with an ellipsis to fit the bubble's width, as the web cuts it.
  private static func fitted(_ line: String, in context: GraphicsContext) -> String {
    func width(_ text: String) -> CGFloat {
      context.resolve(Text(text).font(.system(size: 11, weight: .medium)))
        .measure(in: CGSize(width: CGFloat.infinity, height: 40)).width
    }
    guard width(line) > bubbleWidth else {
      return line
    }
    var cut = line
    while cut.count > 1 && width("\(cut)…") > bubbleWidth {
      cut.removeLast()
    }
    return "\(cut.trimmingCharacters(in: .whitespaces))…"
  }

  /// A soft round glow in one colour, the web's glow sprite, lit additively.
  private func glow(_ color: SkyColor, at center: CGPoint, size: Double, in context: inout GraphicsContext) {
    let radius = size / 2
    guard radius > 0 else { return }
    context.blendMode = .plusLighter
    context.fill(
      circle(center, radius),
      with: .radialGradient(
        Gradient(stops: [
          .init(color: Color(sky: color, opacity: 0.55), location: 0),
          .init(color: Color(sky: color, opacity: 0.2), location: 0.22),
          .init(color: Color(sky: color, opacity: 0.05), location: 0.55),
          .init(color: Color(sky: color, opacity: 0), location: 1),
        ]), center: center, startRadius: 0, endRadius: radius))
    context.blendMode = .normal
  }

  private func point(_ point: SkyPoint) -> CGPoint {
    CGPoint(x: point.x, y: point.y)
  }

  private func circle(_ center: CGPoint, _ radius: Double) -> Path {
    Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
  }
}

/// The CLI marks as paths on their 24-unit grid, read once from their SVG path data.
@MainActor enum SkyGlyphs {
  private static var paths: [String: Path] = [:]

  static func path(for mark: CliMark) -> Path {
    if let path = paths[mark.path] {
      return path
    }
    var path = Path()
    for element in skyPath(mark.path) {
      switch element {
      case .move(let to): path.move(to: CGPoint(x: to.x, y: to.y))
      case .line(let to): path.addLine(to: CGPoint(x: to.x, y: to.y))
      case .curve(let first, let second, let to):
        path.addCurve(
          to: CGPoint(x: to.x, y: to.y), control1: CGPoint(x: first.x, y: first.y),
          control2: CGPoint(x: second.x, y: second.y))
      case .close: path.closeSubpath()
      }
    }
    paths[mark.path] = path
    return path
  }
}
