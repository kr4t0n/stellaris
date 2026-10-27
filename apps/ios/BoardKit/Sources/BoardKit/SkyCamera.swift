// The sky's camera, a port of the web's `apps/web/src/sky/camera.ts` with top and bottom insets
// beside its left and right, so a fold, the chat part, or the cameras can cover the sky as the
// web's islands do; and the camera's motion, a port of its half of the web's `SkyScene` in
// `apps/web/src/sky/scene.ts`. A viewport with insets is the web's camera over the band between
// the top and bottom ones, drawn lower by the top one: the functions below work in that band, as
// the web's do in its canvas, so the two agree to the last bit. Both run the tables in
// `apps/ios/fixtures/sky`, which the web's tests write.

/// A point on the sky's view, in points.
public struct SkyPoint: Sendable, Hashable {
  public var x: Double
  public var y: Double

  public init(x: Double, y: Double) {
    self.x = x
    self.y = y
  }
}

/// Where the camera looks: the world point drawn at the middle of the free sky, and the scale.
public struct SkyCamera: Sendable, Hashable {
  public var x: Double
  public var y: Double
  public var scale: Double

  public init(x: Double, y: Double, scale: Double) {
    self.x = x
    self.y = y
    self.scale = scale
  }
}

/// The sky's view and what covers its edges, in points: the free sky is what the insets leave.
public struct SkyViewport: Sendable, Hashable {
  public var width: Double
  public var height: Double
  public var left: Double
  public var right: Double
  public var top: Double
  public var bottom: Double

  public init(
    width: Double, height: Double, left: Double = 0, right: Double = 0, top: Double = 0,
    bottom: Double = 0
  ) {
    self.width = width
    self.height = height
    self.left = left
    self.right = right
    self.top = top
    self.bottom = bottom
  }
}

public let skyMinScale = 0.15
public let skyMaxScale = 3.0
/// The home view never draws the sky smaller or larger than this, however it fits.
private let homeMin = 0.45
private let homeMax = 1.35
/// Room kept clear at the top of the free sky for the web's HUD, which a framed sphere stays out
/// of while the home view and the center take no notice of it.
private let hudRoom = 64.0
/// A framed sphere keeps this much of its own size again around it.
private let frameRoom = 1.15

private func clamp(_ value: Double, _ low: Double, _ high: Double) -> Double {
  min(high, max(low, value))
}

/// The free sky's width: what the left and right insets leave, but never less than 240 points.
public func freeWidth(_ view: SkyViewport) -> Double {
  max(240, view.width - view.left - view.right)
}

/// The free sky's height: what the top and bottom insets leave, the height of the band the camera
/// works in.
public func freeHeight(_ view: SkyViewport) -> Double {
  view.height - view.top - view.bottom
}

/// Where the camera's world point is drawn: the middle of the free sky.
public func viewCenter(_ view: SkyViewport) -> SkyPoint {
  SkyPoint(x: view.left + freeWidth(view) / 2, y: view.top + freeHeight(view) / 2)
}

/// The whole sky, centered on the core and fitted to the free sky.
public func homeCamera(_ view: SkyViewport, radius: Double) -> SkyCamera {
  let fit = min(freeWidth(view), freeHeight(view)) / (2 * radius)
  return SkyCamera(x: 0, y: 0, scale: clamp(fit, homeMin, homeMax))
}

/// Zoomed by `factor` so the world point under `at` stays under it.
public func zoomAt(_ camera: SkyCamera, _ view: SkyViewport, factor: Double, at: SkyPoint)
  -> SkyCamera
{
  let scale = clamp(camera.scale * factor, skyMinScale, skyMaxScale)
  // In the band, as the web works in its canvas.
  let centerX = view.left + freeWidth(view) / 2
  let centerY = freeHeight(view) / 2
  let atY = at.y - view.top
  let worldX = camera.x + (at.x - centerX) / camera.scale
  let worldY = camera.y + (atY - centerY) / camera.scale
  return SkyCamera(
    x: worldX - (at.x - centerX) / scale, y: worldY - (atY - centerY) / scale, scale: scale)
}

/// Moved so the sky follows a drag of `dx`, `dy` points.
public func panBy(_ camera: SkyCamera, dx: Double, dy: Double) -> SkyCamera {
  SkyCamera(x: camera.x - dx / camera.scale, y: camera.y - dy / camera.scale, scale: camera.scale)
}

/// A camera that brings a sphere, with room around it, into the free sky: centered on it, and
/// zoomed out only as far as it needs to fit. Nil when the sphere is in view already, so a focus
/// the user can already see moves nothing.
public func frameSphere(
  _ camera: SkyCamera, _ view: SkyViewport, sphere: (x: Double, y: Double, reach: Double)
) -> SkyCamera? {
  // In the band, as the web works in its canvas.
  let band = freeHeight(view)
  let x = view.left + freeWidth(view) / 2 + (sphere.x - camera.x) * camera.scale
  let y = band / 2 + (sphere.y - camera.y) * camera.scale
  let reach = sphere.reach * camera.scale
  let inside =
    x - reach >= view.left && x + reach <= view.width - view.right && y - reach >= hudRoom
    && y + reach <= band
  if inside {
    return nil
  }
  let fits = min(freeWidth(view), band - hudRoom) / (2 * sphere.reach * frameRoom)
  return SkyCamera(
    x: sphere.x, y: sphere.y, scale: min(camera.scale, clamp(fits, skyMinScale, skyMaxScale)))
}

/// Room around a focused sphere the camera keeps in view: its name and its tasks' orbit. The web's
/// `FOCUS_ROOM`, which the scene's table checks.
let skyFocusRoom = 34.0
/// The longest step the motion takes, in seconds, however long the clock went between two.
private let longestStep = 0.05
/// How much of the way to its target the camera goes in a second, as a rate.
private let easeRate = 3.0

/// The camera as the sky draws it, eased toward the camera it is heading for, and the mode that
/// picks that camera: a port of the camera's half of the web's `SkyScene` (`step`, `zoomBy`,
/// `panBy`, `home`, `setFocus`). Time comes from the caller's clock, in seconds, where the web
/// reads `performance.now()`. It is a value, so the app's model can keep it through a fold.
public struct SkyCameraMotion: Sendable, Hashable {
  /// `home` follows the whole sky as it and the insets change, `focus` holds on the sphere the
  /// board brought into view, and `manual` stays wherever the user zoomed or dragged it.
  public enum Mode: Sendable, Hashable {
    case home, focus, manual
  }

  public private(set) var mode = Mode.home
  /// The camera the motion is heading for.
  public private(set) var target = SkyCamera(x: 0, y: 0, scale: 1)
  /// The camera as drawn.
  public private(set) var camera = SkyCamera(x: 0, y: 0, scale: 1)
  /// Where the camera's world point is drawn: the first step places it, and it glides after that
  /// as the insets change, on both axes, where the web's moves only from side to side.
  public private(set) var center: SkyPoint?
  /// The project the board has open, which the camera brings into view when it isn't.
  public private(set) var focus: String?
  /// A new focus waits for the next step, when the insets for it are known too.
  private var focusPending = false
  /// The clock at the last step.
  private var last: Double?
  /// With Reduce Motion the camera lands at once.
  public var reducedMotion: Bool

  public init(reducedMotion: Bool = false) {
    self.reducedMotion = reducedMotion
  }

  /// The project the board has open: brought into view at the next step.
  public mutating func setFocus(_ anchor: String?) {
    focus = anchor
    focusPending = true
  }

  /// Zooms by `factor` around a point, the middle of the free sky by default.
  public mutating func zoom(by factor: Double, at point: SkyPoint? = nil, in view: SkyViewport) {
    target = zoomAt(target, view, factor: factor, at: point ?? viewCenter(view))
    mode = .manual
  }

  /// Moves the sky with a drag of `dx`, `dy` points, at once rather than eased.
  public mutating func pan(dx: Double, dy: Double) {
    target = panBy(target, dx: dx, dy: dy)
    camera.x -= dx / camera.scale
    camera.y -= dy / camera.scale
    mode = .manual
  }

  /// Back to the whole sky, which then follows the society as it grows.
  public mutating func home() {
    mode = .home
  }

  /// One frame of motion at `now` on the caller's clock: picks the target the mode asks for and
  /// eases the camera toward it. A clock that jumped, as after the app was in the background,
  /// moves it at most a twentieth of a second's worth, and one that went back moves nothing.
  public mutating func step(at now: Double, in view: SkyViewport, model: SkyModel) {
    let dt = last.map { min(longestStep, max(0, now - $0)) } ?? 0
    last = now
    if mode == .home {
      target = homeCamera(view, radius: model.radius)
    }
    if focusPending && view.width > 0 {
      focusPending = false
      frameFocus(view, model: model)
    }
    let ease = reducedMotion ? 1 : min(1, dt * easeRate)
    camera.scale += (target.scale - camera.scale) * ease
    camera.x += (target.x - camera.x) * ease
    camera.y += (target.y - camera.y) * ease
    let goal = viewCenter(view)
    center = center.map {
      SkyPoint(x: $0.x + (goal.x - $0.x) * ease, y: $0.y + (goal.y - $0.y) * ease)
    } ?? goal
  }

  /// Where a world point is drawn now.
  public func screenPoint(x: Double, y: Double) -> SkyPoint {
    let center = center ?? SkyPoint(x: 0, y: 0)
    return SkyPoint(
      x: center.x + (x - camera.x) * camera.scale, y: center.y + (y - camera.y) * camera.scale)
  }

  /// Brings the focused project into view when it is not, and lets a focus the camera moved for go
  /// home when the board lets go of it. A view the user chose stays unless the focus is off it.
  private mutating func frameFocus(_ view: SkyViewport, model: SkyModel) {
    guard let focus, let sphere = model.anchors.first(where: { $0.id == focus }),
      sphere.kind == .project
    else {
      if mode == .focus {
        mode = .home
      }
      return
    }
    if let framed = frameSphere(
      target, view, sphere: (x: sphere.x, y: sphere.y, reach: sphere.radius + skyFocusRoom))
    {
      target = framed
      mode = .focus
    }
  }
}
