import Foundation
import Testing

@testable import BoardKit

/// The sky's motion moves as the web's scene does, and each frame puts things where the camera
/// draws them.
@Suite struct SkySceneTests {
  static let view = SkyViewport(width: 475, height: 669)

  static func star(
    _ id: String, at anchor: String = societyScope, x: Double = 0, y: Double = 0,
    state: SkyStar.State = .idle
  ) -> SkyStar {
    SkyStar(
      id: id, name: String(id.prefix { $0 != "/" }), cli: .known(.codex), state: state,
      resident: false, anchor: anchor, queuedFor: nil, x: x, y: y)
  }

  static func model(stars: [SkyStar], tasks: [SkyTaskMark] = []) -> SkyModel {
    SkyModel(
      anchors: [
        SkyAnchor(id: societyScope, label: "society", kind: .society, x: 0, y: 0, radius: 58),
        SkyAnchor(id: "demo", label: "Demo", kind: .project, x: 0, y: -300, radius: 112),
      ], stars: stars, tasks: tasks, radius: 504)
  }

  static func mark(_ id: String, linked: String? = nil) -> SkyTaskMark {
    SkyTaskMark(
      id: id, title: "Add the export view", project: "demo", phase: .working, stage: "Build it",
      holder: linked == nil ? nil : "eng-1", waitingFor: nil, linked: linked, x: 0, y: -425)
  }

  /// Steps `scene` from `start` for `seconds`, thirty frames a second.
  static func run(_ scene: inout SkyScene, from start: Double, for seconds: Double) {
    for frame in 0...Int(seconds * 30) {
      scene.step(at: start + Double(frame) / 30, in: view)
    }
  }

  @Test func theSpecksAndPhasesAreTheWebs() {
    // What the web's `mulberry32(7)` and `phaseOf` give, from Node.
    var random = Mulberry32(seed: 7)
    #expect(
      (0..<6).map { _ in random.next() } == [
        0.011704753153026104, 0.06195825757458806, 0.97690763277933, 0.6990287057124078,
        0.5214452685322613, 0.4055216880515218,
      ])
    let scene = SkyScene()
    #expect(scene.specks.count == 280)
    #expect(scene.specks.last?.phase == 0.9935338406357914 * Double.pi * 2)
    #expect(skyPhase(of: "eng-1") == 5.602635976162574)
    #expect(skyPhase(of: "ada") == 1.3799167346594257)
    #expect(skyPhase(of: "émile") == 6.100486970294806)
    #expect(skyPhase(of: "\u{1F680}x") == 3.9413654266274314)
  }

  /// With Reduce Motion everything lands at the first step, nothing drifts from frame to frame,
  /// and a tool's call doesn't flicker.
  @Test func reducedMotionLandsAtOnce() throws {
    var scene = SkyScene(reducedMotion: true)
    let model = SkySceneTests.model(stars: [SkySceneTests.star("eng-1", x: 34, y: 20)])
    scene.setModel(model)
    scene.step(at: 100, in: SkySceneTests.view)
    let first = scene.frame(in: SkySceneTests.view, ambient: true, hovered: nil, paused: false)
    let star = try #require(first.stars.first)
    #expect(star.presence == 1)
    let home = homeCamera(SkySceneTests.view, radius: 504)
    #expect(abs(scene.camera.camera.scale - home.scale) < 1e-12 && scene.camera.camera.x == 0)
    let resting = scene.restingPoint(x: 34, y: 20, in: SkySceneTests.view)
    #expect(hypot(star.center.x - resting.x, star.center.y - resting.y) <= 8 * first.scale + 1e-9)
    scene.flash("eng-1")
    scene.step(at: 107, in: SkySceneTests.view)
    let later = scene.frame(in: SkySceneTests.view, ambient: true, hovered: nil, paused: false)
    #expect(later.stars.first?.center == star.center)
    #expect(later.stars.first?.flash == nil)
    #expect(later.specks == first.specks)
  }

  /// A citizen new to the sky rises from its anchor and springs to its place; a star that leaves
  /// fades out and goes.
  @Test func aNewCitizenRisesFromItsAnchor() throws {
    var scene = SkyScene()
    scene.setModel(SkySceneTests.model(stars: [SkySceneTests.star("eng-1/demo", at: "demo", x: 34, y: -280)]))
    scene.step(at: 0, in: SkySceneTests.view)
    let start = try #require(scene.bodies["eng-1/demo"])
    #expect(start.x == 0 && start.y == -300 && start.presence == 0)
    SkySceneTests.run(&scene, from: 0, for: 4)
    let settled = try #require(scene.bodies["eng-1/demo"])
    #expect(abs(settled.x - 34) < 0.5 && abs(settled.y + 280) < 0.5)
    #expect(settled.presence > 0.99)

    scene.setModel(SkySceneTests.model(stars: []))
    #expect(scene.bodies["eng-1/demo"]?.leaving == true)
    SkySceneTests.run(&scene, from: 5, for: 3)
    #expect(scene.bodies.keys.isEmpty)
  }

  /// A citizen's stars are one body of light: a turn starting moves the star it had, a second
  /// turn splits off from the first, and a turn that ends merges back into the one that goes on.
  @Test func aCitizensStarsAreOneBody() throws {
    var scene = SkyScene()
    scene.setModel(SkySceneTests.model(stars: [SkySceneTests.star("eng-1", x: 34, y: 20)]))
    SkySceneTests.run(&scene, from: 0, for: 4)

    scene.setModel(
      SkySceneTests.model(stars: [
        SkySceneTests.star("eng-1/demo", at: "demo", x: 0, y: -300, state: .working)
      ]))
    #expect(scene.bodies.keys == ["eng-1/demo"])
    let moved = try #require(scene.bodies["eng-1/demo"])
    #expect(abs(moved.x - 34) < 0.5 && moved.presence > 0.99)

    scene.setModel(
      SkySceneTests.model(stars: [
        SkySceneTests.star("eng-1/demo", at: "demo", x: 0, y: -300, state: .working),
        SkySceneTests.star("eng-1/docs", at: "demo", x: 68, y: -300, state: .working),
      ]))
    let split = try #require(scene.bodies["eng-1/docs"])
    #expect(split.x == moved.x && split.y == moved.y && split.presence == 0)

    SkySceneTests.run(&scene, from: 5, for: 4)
    scene.setModel(
      SkySceneTests.model(stars: [
        SkySceneTests.star("eng-1/demo", at: "demo", x: 0, y: -300, state: .working)
      ]))
    let merging = try #require(scene.bodies["eng-1/docs"])
    #expect(merging.leaving && merging.goal == SkyPoint(x: 0, y: -300))
    SkySceneTests.run(&scene, from: 10, for: 3)
    #expect(scene.bodies.keys == ["eng-1/demo"])
  }

  /// A tool's call opens a ring that fades in half a second; a post's first line rises for five
  /// seconds, and the line stays known as the citizen's last.
  @Test func aCallFlickersAndAPostRises() throws {
    var scene = SkyScene()
    scene.setModel(SkySceneTests.model(stars: [SkySceneTests.star("eng-1", x: 34, y: 20)]))
    SkySceneTests.run(&scene, from: 0, for: 4)
    scene.play(SkyCue(star: "eng-1", line: "The export view is in"))
    let lit = scene.frame(in: SkySceneTests.view, ambient: true, hovered: nil, paused: false)
    #expect(lit.stars.first?.flash?.alpha == 0.55)
    SkySceneTests.run(&scene, from: 4.1, for: 0.5)
    let risen = scene.frame(in: SkySceneTests.view, ambient: true, hovered: nil, paused: false)
    #expect(risen.stars.first?.flash == nil)
    let bubble = try #require(risen.bubbles.first)
    #expect(bubble.text == "The export view is in" && bubble.alpha > 0.99 && bubble.rise > 0)
    SkySceneTests.run(&scene, from: 4.7, for: 5)
    #expect(scene.frame(in: SkySceneTests.view, ambient: true, hovered: nil, paused: false).bubbles.isEmpty)
    #expect(scene.lastSaid == ["eng-1": "The export view is in"])
    // A cue for a star the sky no longer has sets nothing off.
    scene.play(SkyCue(star: "ghost", line: "Hello"))
    #expect(scene.lastSaid["ghost"] == nil)
  }

  /// A touch takes the star under it, else a task's mark, else the sphere, within a finger's reach.
  @Test func aTouchTakesWhatIsUnderIt() throws {
    var scene = SkyScene(reducedMotion: true)
    scene.setModel(
      SkySceneTests.model(
        stars: [SkySceneTests.star("eng-1/demo", at: "demo", x: 0, y: -300, state: .working)],
        tasks: [SkySceneTests.mark("T1", linked: "eng-1/demo")]))
    scene.step(at: 1, in: SkySceneTests.view)
    let frame = scene.frame(in: SkySceneTests.view, ambient: false, hovered: nil, paused: false)
    let star = try #require(frame.stars.first).center
    let mark = try #require(frame.marks.first).center
    let sphere = try #require(frame.spheres.first { $0.id == "demo" })
    #expect(frame.hit(at: star) == .star("eng-1/demo"))
    #expect(frame.hit(at: SkyPoint(x: star.x + 21, y: star.y)) == .star("eng-1/demo"))
    #expect(frame.hit(at: mark) == .task("T1"))
    let inside = SkyPoint(x: sphere.center.x + sphere.ring * 0.9, y: sphere.center.y)
    #expect(frame.hit(at: inside) == .sphere("demo"))
    #expect(frame.hit(at: SkyPoint(x: 2, y: 2)) == nil)
    // The thread of light runs from the held task to its holder's star.
    #expect(frame.links.count == 1)
    #expect(frame.links.first?.from == mark && frame.links.first?.to == star)
  }

  /// The card's star or mark draws lit and last, on top of the rest.
  @Test func theOpenCardsStarDrawsOnTop() {
    var scene = SkyScene(reducedMotion: true)
    scene.setModel(
      SkySceneTests.model(stars: [
        SkySceneTests.star("ada", x: 0, y: 0), SkySceneTests.star("bo", x: 68, y: 0),
      ]))
    scene.step(at: 1, in: SkySceneTests.view)
    let frame = scene.frame(
      in: SkySceneTests.view, ambient: false, hovered: SkyTarget.star("ada").hovered, paused: true)
    #expect(frame.stars.map(\.id) == ["bo", "ada"])
    #expect(frame.stars.last?.hovered == true && frame.stars.last?.nameAlpha == 1)
    // Paused, the sky dims.
    #expect(frame.stars.first.map { $0.glowAlpha < 0.5 } == true)
  }

  /// The camera's gestures and focus reach the camera's motion.
  @Test func theCameraFollowsGesturesAndFocus() {
    var scene = SkyScene(reducedMotion: true)
    scene.setModel(SkySceneTests.model(stars: []))
    scene.step(at: 1, in: SkySceneTests.view)
    scene.zoom(by: 2, in: SkySceneTests.view)
    scene.pan(dx: 40, dy: 0)
    #expect(scene.camera.mode == .manual)
    scene.home()
    scene.step(at: 2, in: SkySceneTests.view)
    #expect(scene.camera.mode == .home)
    scene.setFocus("demo")
    scene.zoom(by: 3, in: SkySceneTests.view)
    scene.step(at: 3, in: SkySceneTests.view)
    #expect(scene.camera.mode == .focus && scene.camera.target.x == 0 && scene.camera.target.y == -300)
    let frame = scene.frame(in: SkySceneTests.view, ambient: false, hovered: nil, paused: false)
    #expect(frame.spheres.first { $0.id == "demo" }?.focused == true)
  }
}
