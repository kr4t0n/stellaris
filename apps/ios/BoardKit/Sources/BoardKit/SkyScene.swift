// The sky's motion and what each frame of it draws, a port of the web's `SkyScene` in
// `apps/web/src/sky/scene.ts` less the drawing itself, which the app does with SwiftUI's `Canvas`.
// The scene eases every body toward where `skyModel` puts it, and `frame` works out where each
// shape goes on the view and how bright it is, so the app only strokes and fills. Time comes from
// the caller's clock, in seconds, where the web reads `performance.now()`. The numbers are the
// web's, so the two skies move alike.

import Foundation

/// The web's `mulberry32`, a seeded random sequence, so the specks fall where the web's do.
struct Mulberry32 {
  private var state: UInt32

  init(seed: UInt32) {
    state = seed
  }

  mutating func next() -> Double {
    state = state &+ 0x6D2B_79F5
    var t = (state ^ (state >> 15)) &* (1 | state)
    t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
    return Double(t ^ (t >> 14)) / 4_294_967_296
  }
}

/// Where a citizen's drift and breathing start, from its name, so no two stars move in step: the
/// web's FNV-1a hash of the name's UTF-16 code units, as an angle.
func skyPhase(of name: String) -> Double {
  var hash: UInt32 = 2_166_136_261
  for unit in name.utf16 {
    hash = (hash ^ UInt32(unit)) &* 16_777_619
  }
  return Double(hash) / 4_294_967_296 * Double.pi * 2
}

/// A value wrapped into `[0, size)`, for the background's parallax.
private func wrap(_ value: Double, _ size: Double) -> Double {
  size <= 0 ? 0 : (value.truncatingRemainder(dividingBy: size) + size).truncatingRemainder(
    dividingBy: size)
}

/// Values in the order they were first set, as a JavaScript `Map` keeps them: the scene draws its
/// bodies in that order.
struct Ordered<Value: Sendable>: Sendable {
  private(set) var keys: [String] = []
  private var store: [String: Value] = [:]

  subscript(key: String) -> Value? {
    get { store[key] }
    set {
      if let newValue {
        if store.updateValue(newValue, forKey: key) == nil {
          keys.append(key)
        }
      } else if store.removeValue(forKey: key) != nil {
        keys.removeAll { $0 == key }
      }
    }
  }

  var values: [Value] { keys.compactMap { store[$0] } }
  var entries: [(key: String, value: Value)] { keys.compactMap { key in store[key].map { (key, $0) } } }
}

/// The sky's motion: every star, task mark, and sphere eased toward where the model puts it, the
/// lines posts raise, the background's specks, and the camera.
public struct SkyScene: Sendable {
  /// A star as the scene moves it: eased toward its place, fading in and out.
  struct Body: Sendable {
    var star: SkyStar
    /// Where it is heading: its star's place, or for a star leaving, the place of the citizen's
    /// star it merges into.
    var goal: SkyPoint
    var x: Double
    var y: Double
    var vx = 0.0
    var vy = 0.0
    /// Offsets the citizen's drift and breathing so no two stars move in step.
    let phase: Double
    /// 0 to 1: fades in when the citizen appears and out when it leaves the sky.
    var presence: Double
    var leaving = false
    /// 1 when the citizen calls a tool, fading to 0: the star flickers with each call.
    var flash = 0.0
  }

  /// A task's mark as the scene moves it.
  struct MarkBody: Sendable {
    var mark: SkyTaskMark
    var x: Double
    var y: Double
    var presence: Double
    var leaving = false
  }

  /// A sphere as the scene moves it: eased toward its anchor's place and size, like the stars.
  struct Sphere: Sendable {
    var anchor: SkyAnchor
    var x: Double
    var y: Double
    var radius: Double
  }

  /// The first line of a post, rising from its author's star until it fades.
  struct Bubble: Sendable {
    let text: String
    /// Seconds on the scene's clock when it was said.
    let born: Double
  }

  struct Speck: Sendable {
    let x, y, size, alpha, rate, phase: Double
  }

  /// With Reduce Motion nothing drifts, every body lands at once, and the camera does too.
  public var reducedMotion: Bool {
    didSet { camera.reducedMotion = reducedMotion }
  }
  public private(set) var camera: SkyCameraMotion
  /// The model the scene eases toward, once one is set.
  public private(set) var model: SkyModel?
  /// Seconds on the caller's clock at the latest step.
  public private(set) var clock = 0.0
  /// The line each citizen posted last, by name, which outlives its bubble.
  public private(set) var lastSaid: [String: String] = [:]

  private(set) var bodies = Ordered<Body>()
  private(set) var marks = Ordered<MarkBody>()
  private(set) var spheres = Ordered<Sphere>()
  private(set) var bubbles = Ordered<Bubble>()
  let specks: [Speck]
  private var last: Double?

  public init(reducedMotion: Bool = false) {
    self.reducedMotion = reducedMotion
    camera = SkyCameraMotion(reducedMotion: reducedMotion)
    var random = Mulberry32(seed: 7)
    specks = (0..<skySpecks).map { _ in
      let x = random.next()
      let y = random.next()
      let size = 0.5 + random.next() * 1.1
      let alpha = 0.12 + random.next() * 0.45
      let rate = 0.2 + random.next() * 0.8
      return Speck(
        x: x, y: y, size: size, alpha: alpha, rate: rate, phase: random.next() * Double.pi * 2)
    }
  }

  /// Hands the scene the places `skyModel` gives. A citizen's stars are one body of light: a star
  /// that leaves hands its body to the star that replaces it, a second turn splits off from the
  /// first, and a turn that ends while another goes on merges back into it. Only a citizen new to
  /// the sky rises from its anchor.
  public mutating func setModel(_ model: SkyModel) {
    self.model = model
    for anchor in model.anchors {
      if var sphere = spheres[anchor.id] {
        sphere.anchor = anchor
        spheres[anchor.id] = sphere
      } else {
        spheres[anchor.id] = Sphere(anchor: anchor, x: anchor.x, y: anchor.y, radius: anchor.radius)
      }
    }
    let anchorIds = Set(model.anchors.map(\.id))
    for id in spheres.keys where !anchorIds.contains(id) {
      spheres[id] = nil
    }

    let present = Set(model.stars.map(\.id))
    var departing = bodies.entries.filter { !present.contains($0.key) }
    for star in model.stars {
      let goal = SkyPoint(x: star.x, y: star.y)
      if var body = bodies[star.id] {
        body.star = star
        body.goal = goal
        body.leaving = false
        bodies[star.id] = body
        continue
      }
      if let handed = departing.firstIndex(where: { $0.value.star.name == star.name }) {
        var body = departing.remove(at: handed)
        bodies[body.key] = nil
        body.value.star = star
        body.value.goal = goal
        body.value.leaving = false
        bodies[star.id] = body.value
        continue
      }
      let sibling = bodies.values.first { $0.star.name == star.name && present.contains($0.star.id) }
      let anchor = model.anchors.first { $0.id == star.anchor }
      let from =
        sibling.map { SkyPoint(x: $0.x, y: $0.y) } ?? anchor.map { SkyPoint(x: $0.x, y: $0.y) }
        ?? goal
      bodies[star.id] = Body(
        star: star, goal: goal, x: reducedMotion ? star.x : from.x,
        y: reducedMotion ? star.y : from.y, phase: skyPhase(of: star.name),
        presence: reducedMotion ? 1 : 0)
    }
    for (id, var body) in departing {
      body.leaving = true
      if let into = model.stars.first(where: { $0.name == body.star.name }) {
        body.goal = SkyPoint(x: into.x, y: into.y)
      }
      bodies[id] = body
    }

    let marked = Set(model.tasks.map(\.id))
    for mark in model.tasks {
      if var body = marks[mark.id] {
        body.mark = mark
        body.leaving = false
        marks[mark.id] = body
      } else {
        marks[mark.id] = MarkBody(
          mark: mark, x: mark.x, y: mark.y, presence: reducedMotion ? 1 : 0)
      }
    }
    for (id, var body) in marks.entries where !marked.contains(id) {
      body.leaving = true
      marks[id] = body
    }
  }

  /// A star flickers: its citizen just called a tool.
  public mutating func flash(_ id: String) {
    guard var body = bodies[id], !reducedMotion else { return }
    body.flash = 1
    bodies[id] = body
  }

  /// A post's first line rises from its author's star, replacing one still rising there.
  public mutating func say(_ id: String, text: String) {
    guard let body = bodies[id] else { return }
    bubbles[id] = Bubble(text: text, born: clock)
    lastSaid[body.star.name] = text
  }

  /// What a cue from the turn stream sets off.
  public mutating func play(_ cue: SkyCue) {
    flash(cue.star)
    if let line = cue.line {
      say(cue.star, text: line)
    }
  }

  // MARK: The camera

  /// The project the board has open: drawn brighter, and brought into view at the next step.
  public mutating func setFocus(_ anchor: String?) {
    if anchor != camera.focus {
      camera.setFocus(anchor)
    }
  }

  public mutating func zoom(by factor: Double, at point: SkyPoint? = nil, in view: SkyViewport) {
    camera.zoom(by: factor, at: point, in: view)
  }

  public mutating func pan(dx: Double, dy: Double) {
    camera.pan(dx: dx, dy: dy)
  }

  /// Back to the whole sky, which then follows the society as it grows.
  public mutating func home() {
    camera.home()
  }

  /// Where a world point is drawn once the camera has landed where it is heading.
  public func restingPoint(x: Double, y: Double, in view: SkyViewport) -> SkyPoint {
    let center = viewCenter(view)
    let target = camera.target
    return SkyPoint(
      x: center.x + (x - target.x) * target.scale, y: center.y + (y - target.y) * target.scale)
  }

  // MARK: Motion

  /// One frame of motion at `now` on the caller's clock. A clock that jumped, as after the app was
  /// in the background, moves things at most a twentieth of a second's worth.
  public mutating func step(at now: Double, in view: SkyViewport) {
    let dt = last.map { min(0.05, max(0, now - $0)) } ?? 0
    last = now
    clock = now
    if let model {
      camera.step(at: now, in: view, model: model)
    }
    let ease = reducedMotion ? 1 : min(1, dt * 3)
    for id in spheres.keys {
      guard var sphere = spheres[id] else { continue }
      sphere.x += (sphere.anchor.x - sphere.x) * ease
      sphere.y += (sphere.anchor.y - sphere.y) * ease
      sphere.radius += (sphere.anchor.radius - sphere.radius) * ease
      spheres[id] = sphere
    }
    for id in bodies.keys {
      guard var body = bodies[id] else { continue }
      if reducedMotion {
        body.x = body.goal.x
        body.y = body.goal.y
        body.presence = body.leaving ? 0 : 1
      } else {
        // A damped spring: citizens glide to a new place and settle without snapping.
        body.vx += (spring * (body.goal.x - body.x) - damping * body.vx) * dt
        body.vy += (spring * (body.goal.y - body.y) - damping * body.vy) * dt
        body.x += body.vx * dt
        body.y += body.vy * dt
        let toward = body.leaving ? 0.0 : 1.0
        body.presence += (toward - body.presence) * min(1, dt * 2.5)
      }
      body.flash = max(0, body.flash - dt * 2.2)
      bodies[id] = body.leaving && body.presence < 0.02 ? nil : body
    }
    for id in marks.keys {
      guard var body = marks[id] else { continue }
      body.x += (body.mark.x - body.x) * ease
      body.y += (body.mark.y - body.y) * ease
      let toward = body.leaving ? 0.0 : 1.0
      body.presence += (toward - body.presence) * (reducedMotion ? 1 : min(1, dt * 2.5))
      marks[id] = body.leaving && body.presence < 0.02 ? nil : body
    }
    for (id, bubble) in bubbles.entries
    where clock - bubble.born > bubbleLife || bodies[id]?.leaving != false {
      bubbles[id] = nil
    }
  }

  // MARK: The frame

  /// Everything a frame draws, in the view's points, from back to front. `ambient` is false with
  /// Reduce Motion or in Low Power Mode, where nothing drifts, breathes, twinkles, or orbits.
  /// `hovered` is the star or `task:<id>` mark whose card is open, drawn lit and on top; `paused`
  /// dims the sky, as the web does while the society is paused.
  public func frame(in view: SkyViewport, ambient: Bool, hovered: String?, paused: Bool)
    -> SkyFrame
  {
    let t = ambient && !reducedMotion ? clock : 0
    let scale = camera.camera.scale
    func screen(_ x: Double, _ y: Double) -> SkyPoint {
      camera.screenPoint(x: x, y: y)
    }
    let focus = camera.focus

    // The background: specks drifting against a pan, and a faint core of light behind the society.
    let shiftX = -camera.camera.x * scale * parallax
    let shiftY = -camera.camera.y * scale * parallax
    let specks = self.specks.map { speck in
      let twinkle = t == 0 ? 1 : 0.6 + 0.4 * sin(t * speck.rate + speck.phase)
      return SkyFrame.Speck(
        x: wrap(speck.x * view.width + shiftX, view.width),
        y: wrap(speck.y * view.height + shiftY, view.height), size: speck.size,
        alpha: speck.alpha * twinkle * (paused ? 0.6 : 1))
    }
    let core = screen(0, 0)

    let spheres = self.spheres.values.map { sphere in
      SkyFrame.Sphere(
        id: sphere.anchor.id, label: sphere.anchor.label, kind: sphere.anchor.kind,
        center: screen(sphere.x, sphere.y), ring: sphere.radius * scale,
        focused: sphere.anchor.id == focus)
    }

    // Stars, the hovered one last so it draws on top.
    let order = bodies.values.enumerated().sorted { a, b in
      let (left, right) = (a.element.star.id == hovered, b.element.star.id == hovered)
      return left == right ? a.offset < b.offset : right
    }.map(\.element)
    let radius = max(10, coreRadius * scale)
    let stars = order.map { body -> SkyFrame.Star in
      let star = body.star
      let working = star.state == .working
      let isHovered = star.id == hovered
      let amplitude = working ? 2.5 : 5
      let driftX = amplitude * (sin(t * 0.29 + body.phase) + 0.6 * sin(t * 0.17 + body.phase * 2.1))
      let driftY =
        amplitude * (cos(t * 0.23 + body.phase * 1.3) + 0.6 * cos(t * 0.11 + body.phase))
      let at = screen(body.x + driftX, body.y + driftY)
      let rate = working ? 2.4 : star.state == .queued ? 1.4 : 0.7
      let breath = t == 0 ? 0.5 : 0.5 + 0.5 * sin(t * rate + body.phase)
      let base =
        working ? 0.95 + 0.35 * breath : star.state == .queued ? 0.7 + 0.2 * breath : 0.5 + 0.2 * breath
      let intensity =
        (base + (isHovered ? 0.25 : 0) + 0.8 * body.flash) * body.presence * (paused ? 0.7 : 1)
      var ripple: SkyFrame.Ring?
      if working && t != 0 {
        // A ripple leaves the star every 1.8 seconds while its turn runs.
        let progress = (t + body.phase).truncatingRemainder(dividingBy: 1.8) / 1.8
        ripple = SkyFrame.Ring(radius: radius + (6 + 30 * progress) * scale, alpha: 0.4 * (1 - progress))
      }
      let sparks =
        working
        ? (0..<3).map { index -> SkyPoint in
          let angle = t * 1.8 + Double(index) * Double.pi * 2 / 3 + body.phase
          let orbit = radius + 9 * scale
          return SkyPoint(x: at.x + orbit * cos(angle), y: at.y + orbit * sin(angle))
        } : []
      return SkyFrame.Star(
        id: star.id, name: star.name, cli: star.cli, state: star.state, center: at,
        radius: radius, presence: body.presence, leaving: body.leaving, hovered: isHovered,
        glowSize: (working ? 170 : 130) * scale * (0.9 + 0.15 * breath),
        glowAlpha: min(1, intensity),
        ripple: ripple,
        flash: body.flash > 0
          ? SkyFrame.Ring(radius: radius + (3 + 12 * (1 - body.flash)) * scale, alpha: 0.55 * body.flash)
          : nil,
        residentRing: star.resident ? radius + 5 * scale : nil,
        queuedRing: star.state == .queued ? radius + 8 * scale : nil,
        queuedDash: -t * 8,
        sparks: sparks,
        nameSize: max(9, min(11, 11 * scale)),
        nameAlpha: isHovered || working ? 1 : 0.7,
        nameTop: at.y + radius + 8 * scale + 3)
    }
    let starAt = Dictionary(stars.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

    // Task marks, and a thread of light from each held task to its holder's star while the holder
    // is in a turn there, with a spark running along it.
    var links: [SkyFrame.Link] = []
    var marks: [SkyFrame.Mark] = []
    for body in self.marks.values {
      let at = screen(body.x, body.y)
      let phase = body.mark.phase
      if let linked = body.mark.linked, let holder = bodies[linked], !holder.leaving,
        let drawn = starAt[linked]
      {
        let alpha = min(body.presence, holder.presence)
        let along = (t * 0.45 + holder.phase).truncatingRemainder(dividingBy: 1)
        links.append(
          SkyFrame.Link(
            from: at, to: drawn.center, phase: phase, alpha: alpha,
            spark: t == 0
              ? nil
              : SkyPoint(
                x: drawn.center.x + (at.x - drawn.center.x) * along,
                y: drawn.center.y + (at.y - drawn.center.y) * along)))
      }
      let isHovered = hovered == "task:\(body.mark.id)"
      // A task waiting for someone to take it breathes; the others hold steady.
      let breath = phase == .waiting && t != 0 ? 0.65 + 0.35 * sin(t * 1.6 + at.x) : 1
      marks.append(
        SkyFrame.Mark(
          id: body.mark.id, phase: phase, center: at,
          size: max(3, 4 * scale) * (isHovered ? 1.5 : 1),
          alpha: body.presence * breath * (paused ? 0.7 : 1), leaving: body.leaving,
          hovered: isHovered))
    }

    let bubbles = self.bubbles.entries.compactMap { id, bubble -> SkyFrame.Bubble? in
      guard let body = bodies[id], let drawn = starAt[id] else { return nil }
      let age = clock - bubble.born
      let alpha = min(1, age / 0.25, (bubbleLife - age) / 1.2) * body.presence
      guard alpha > 0 else { return nil }
      return SkyFrame.Bubble(
        id: id, text: bubble.text, star: drawn.center, starRadius: radius, alpha: alpha,
        rise: reducedMotion ? 0 : age * 7)
    }

    return SkyFrame(
      width: view.width, height: view.height, scale: scale, specks: specks, core: core,
      coreGlow: 320 * scale, spheres: spheres, links: links, marks: marks, stars: stars,
      bubbles: bubbles)
  }
}

/// How many specks the background holds.
let skySpecks = 280
private let coreRadius = 15.0
private let spring = 5.0
private let damping = 4.2
/// How far the background drifts against a pan, for depth.
private let parallax = 0.06
/// How long a post's line rises, in seconds.
private let bubbleLife = 5.0

/// What one frame of the sky draws, in the view's points, from back to front: the specks, the core
/// of light, the spokes to the spheres and the spheres, the threads from tasks to their holders,
/// the task marks, the stars, and the lines rising from them.
public struct SkyFrame: Sendable {
  public struct Speck: Sendable, Hashable {
    public let x, y, size, alpha: Double
  }

  public struct Sphere: Sendable, Hashable {
    public let id: String
    public let label: String
    public let kind: SkyAnchor.Kind
    public let center: SkyPoint
    /// The sphere's radius on the view.
    public let ring: Double
    /// The project the board has open, drawn brighter.
    public let focused: Bool
  }

  /// A thread of light from a task's mark to its holder's star.
  public struct Link: Sendable, Hashable {
    public let from: SkyPoint
    public let to: SkyPoint
    public let phase: SkyTaskMark.Phase
    public let alpha: Double
    /// The spark running along it, while things move.
    public let spark: SkyPoint?
  }

  public struct Mark: Sendable, Hashable {
    public let id: String
    public let phase: SkyTaskMark.Phase
    public let center: SkyPoint
    /// The side of its diamond.
    public let size: Double
    public let alpha: Double
    public let leaving: Bool
    public let hovered: Bool
  }

  /// A ring around a star, by its radius and its alpha.
  public struct Ring: Sendable, Hashable {
    public let radius: Double
    public let alpha: Double
  }

  public struct Star: Sendable, Hashable {
    public let id: String
    public let name: String
    public let cli: OrUnknown<CliKind>
    public let state: SkyStar.State
    public let center: SkyPoint
    public let radius: Double
    public let presence: Double
    public let leaving: Bool
    public let hovered: Bool
    /// The glow behind it, by its width and its alpha.
    public let glowSize: Double
    public let glowAlpha: Double
    /// A working star's ripple.
    public let ripple: Ring?
    /// The quick ring a tool's call opens.
    public let flash: Ring?
    /// The ring of a citizen whose session is held warm.
    public let residentRing: Double?
    /// The dashed ring of a queued turn, and where its dashes start.
    public let queuedRing: Double?
    public let queuedDash: Double
    /// The three sparks orbiting a working star.
    public let sparks: [SkyPoint]
    /// The name under the star: its size, its alpha, and its top.
    public let nameSize: Double
    public let nameAlpha: Double
    public let nameTop: Double
  }

  /// A post's first line, in a small card above its star.
  public struct Bubble: Sendable, Hashable {
    public let id: String
    public let text: String
    public let star: SkyPoint
    public let starRadius: Double
    public let alpha: Double
    /// How far it has risen.
    public let rise: Double
  }

  public let width: Double
  public let height: Double
  public let scale: Double
  public let specks: [Speck]
  public let core: SkyPoint
  /// The radius of the core's light.
  public let coreGlow: Double
  public let spheres: [Sphere]
  public let links: [Link]
  public let marks: [Mark]
  public let stars: [Star]
  public let bubbles: [Bubble]

  /// How far from its center a touch may land and still take a star: a finger is less exact than
  /// the web's pointer, so never under 22 points, half the 44 Apple asks a target to be.
  public static let starReach = 22.0
  public static let markReach = 22.0

  /// The star under a touch, if any: the nearest within reach.
  public func star(at point: SkyPoint) -> String? {
    var best: String?
    var bestDistance = max(coreRadius * scale + 8, SkyFrame.starReach)
    for star in stars where !star.leaving {
      let distance = hypot(star.center.x - point.x, star.center.y - point.y)
      if distance < bestDistance {
        best = star.id
        bestDistance = distance
      }
    }
    return best
  }

  /// The task whose mark is under a touch, if any.
  public func mark(at point: SkyPoint) -> String? {
    var best: String?
    var bestDistance = SkyFrame.markReach
    for mark in marks where !mark.leaving {
      let distance = hypot(mark.center.x - point.x, mark.center.y - point.y)
      if distance < bestDistance {
        best = mark.id
        bestDistance = distance
      }
    }
    return best
  }

  /// The sphere under a touch when no star or mark is: the one whose center is nearest.
  public func sphere(at point: SkyPoint) -> String? {
    var best: String?
    var bestDistance = Double.infinity
    for sphere in spheres {
      let distance = hypot(sphere.center.x - point.x, sphere.center.y - point.y)
      if distance <= sphere.ring && distance < bestDistance {
        best = sphere.id
        bestDistance = distance
      }
    }
    return best
  }

  /// What a touch takes: a star, else a task's mark, else a sphere.
  public func hit(at point: SkyPoint) -> SkyTarget? {
    if let star = star(at: point) {
      return .star(star)
    }
    if let mark = mark(at: point) {
      return .task(mark)
    }
    return sphere(at: point).map(SkyTarget.sphere)
  }
}

/// Something in the sky a card can be about.
public enum SkyTarget: Sendable, Hashable {
  /// A star, by its id.
  case star(String)
  /// A task's mark, by the task's id.
  case task(String)
  /// A sphere, by its anchor's id.
  case sphere(String)

  /// How the scene names it for drawing it lit: a star's id, or `task:<id>` for a task's mark.
  public var hovered: String? {
    switch self {
    case .star(let id): id
    case .task(let id): "task:\(id)"
    case .sphere: nil
    }
  }
}
