import Foundation
import Testing

@testable import BoardKit

/// The port draws what the web's sky draws. The tables in `apps/ios/fixtures/sky` hold the model's
/// cases, the camera's, and the browser tests' fake board, each with what the web's own `skyModel`
/// and camera made of it.
@Suite struct SkyTests {
  /// A board as the board's answers give it.
  struct Board: Decodable {
    let members: [Member]
    let projects: [Project]
    let scheduler: SchedulerView
    let tasks: [BoardTask]

    var snapshot: SkySnapshot {
      SkySnapshot(members: members, projects: projects, scheduler: scheduler, tasks: tasks)
    }
  }

  /// The web's model as the tables write it.
  struct WebModel: Decodable {
    struct Anchor: Decodable {
      let id, label, kind: String
      let x, y, radius: Double
    }

    struct Star: Decodable {
      let id, name, cli, state, anchor: String
      let resident: Bool
      let queuedFor: String?
      let x, y: Double
    }

    struct Mark: Decodable {
      let id, title, project, phase, stage: String
      let holder, waitingFor, linked: String?
      let x, y: Double
    }

    let anchors: [Anchor]
    let stars: [Star]
    let tasks: [Mark]
    let radius: Double
  }

  struct Point: Decodable {
    let x, y: Double
  }

  struct Camera: Decodable {
    let x, y, scale: Double

    init(x: Double, y: Double, scale: Double) {
      self.x = x
      self.y = y
      self.scale = scale
    }

    var camera: SkyCamera { SkyCamera(x: x, y: y, scale: scale) }
  }

  struct View: Decodable {
    let width, height, left, right, top, bottom: Double

    var viewport: SkyViewport {
      SkyViewport(width: width, height: height, left: left, right: right, top: top, bottom: bottom)
    }
  }

  struct ModelCase: Decodable {
    struct Asked: Decodable {
      let agent, scope: String
      let star: String?
    }

    let name: String
    let board: Board
    let model: WebModel
    let labels: [String]
    let starOf: [Asked]
  }

  /// A case of the camera's table: one of its functions, what it was given, and what it gave.
  struct CameraCase: Decodable {
    struct Sphere: Decodable {
      let x, y, reach: Double
    }

    let name, op: String
    let view: View?
    let radius: Double?
    let camera: Camera?
    let factor: Double?
    let at: Point?
    let dx, dy: Double?
    let sphere: Sphere?
    let expected: JSONValue
  }

  struct FakeBoardCase: Decodable {
    struct Pose: Decodable {
      struct Frame: Decodable {
        let anchor: String
        let camera: Camera?
      }

      let pose: String
      let view: View
      let home: Camera
      let frames: [Frame]
    }

    let name: String
    let answers: Board
    let model: WebModel
    let labels: [String]
    let cameras: [Pose]
  }

  /// Numbers agree within a millionth: the two compute alike, but their sines and cosines come from
  /// different libraries.
  static func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-6 }

  static func close(_ camera: SkyCamera?, _ web: Camera?) -> Bool {
    guard let camera, let web else { return camera == nil && web == nil }
    return close(camera.x, web.x) && close(camera.y, web.y) && close(camera.scale, web.scale)
  }

  /// What differs between the port's model and the web's, as lines to read.
  static func differences(_ model: SkyModel, _ web: WebModel) -> [String] {
    var found: [String] = []
    func same<T: Equatable>(_ what: String, _ port: T, _ web: T) {
      if port != web {
        found.append("\(what): \(String(describing: port)), the web \(String(describing: web))")
      }
    }
    func number(_ what: String, _ port: Double, _ web: Double) {
      if !close(port, web) { found.append("\(what): \(port), the web \(web)") }
    }
    same("anchors", model.anchors.map(\.id), web.anchors.map(\.id))
    for (anchor, other) in zip(model.anchors, web.anchors) {
      same("\(other.id)'s label", anchor.label, other.label)
      same("\(other.id)'s kind", anchor.kind.rawValue, other.kind)
      number("\(other.id)'s x", anchor.x, other.x)
      number("\(other.id)'s y", anchor.y, other.y)
      number("\(other.id)'s radius", anchor.radius, other.radius)
    }
    same("stars", model.stars.map(\.id), web.stars.map(\.id))
    for (star, other) in zip(model.stars, web.stars) {
      same("\(other.id)'s name", star.name, other.name)
      same("\(other.id)'s CLI", star.cli.rawValue, other.cli)
      same("\(other.id)'s state", star.state.rawValue, other.state)
      same("\(other.id)'s anchor", star.anchor, other.anchor)
      same("\(other.id) resident", star.resident, other.resident)
      same("\(other.id) queued for", star.queuedFor, other.queuedFor)
      number("\(other.id)'s x", star.x, other.x)
      number("\(other.id)'s y", star.y, other.y)
    }
    same("tasks", model.tasks.map(\.id), web.tasks.map(\.id))
    for (mark, other) in zip(model.tasks, web.tasks) {
      same("\(other.id)'s title", mark.title, other.title)
      same("\(other.id)'s project", mark.project, other.project)
      same("\(other.id)'s phase", mark.phase.rawValue, other.phase)
      same("\(other.id)'s stage", mark.stage, other.stage)
      same("\(other.id)'s holder", mark.holder, other.holder)
      same("\(other.id) waiting for", mark.waitingFor, other.waitingFor)
      same("\(other.id)'s link", mark.linked, other.linked)
      number("\(other.id)'s x", mark.x, other.x)
      number("\(other.id)'s y", mark.y, other.y)
    }
    number("radius", model.radius, web.radius)
    return found
  }

  static func labels(_ model: SkyModel) -> [String] {
    model.tasks.map { mark in
      markLabel(mark, place: model.anchors.first { $0.id == mark.project }?.label ?? mark.project)
    }
  }

  @Test func theModelAgreesWithTheWeb() throws {
    let cases = try Fixture.sky("model", as: [ModelCase].self)
    #expect(cases.count >= 15)
    for each in cases {
      let model = skyModel(each.board.snapshot)
      let found = Self.differences(model, each.model)
      #expect(found.isEmpty, "\(each.name): \(found.joined(separator: "; "))")
      #expect(Self.labels(model) == each.labels, "\(each.name)")
      for asked in each.starOf {
        #expect(
          starOf(model, agent: asked.agent, scope: asked.scope) == asked.star,
          "\(each.name): \(asked.agent) at \(asked.scope)")
      }
    }
  }

  @Test func theCameraAgreesWithTheWeb() throws {
    let cases = try Fixture.sky("camera", as: [CameraCase].self)
    #expect(cases.count > 150)
    var found: [String] = []
    for each in cases {
      let view = each.view?.viewport ?? SkyViewport(width: 0, height: 0)
      let from = each.camera?.camera ?? SkyCamera(x: 0, y: 0, scale: 1)
      let web = each.expected
      let agrees: Bool
      switch each.op {
      case "freeWidth":
        agrees = web == .number(freeWidth(view))
      case "viewCenter":
        let center = viewCenter(view)
        agrees = try Self.close(SkyCamera(x: center.x, y: center.y, scale: 1), camera(web, scale: 1))
      case "homeCamera":
        agrees = try Self.close(homeCamera(view, radius: each.radius ?? 0), camera(web))
      case "zoomAt":
        let at = SkyPoint(x: each.at?.x ?? 0, y: each.at?.y ?? 0)
        agrees = try Self.close(zoomAt(from, view, factor: each.factor ?? 1, at: at), camera(web))
      case "panBy":
        agrees = try Self.close(panBy(from, dx: each.dx ?? 0, dy: each.dy ?? 0), camera(web))
      case "frameSphere":
        let sphere = each.sphere.map { (x: $0.x, y: $0.y, reach: $0.reach) } ?? (0, 0, 0)
        agrees = try Self.close(frameSphere(from, view, sphere: sphere), camera(web))
      default:
        agrees = false
      }
      if !agrees {
        found.append("\(each.op) for \(each.name)")
      }
    }
    #expect(found.isEmpty, "\(found.joined(separator: "; "))")
  }

  /// A camera from the table, or nil for its null; a point comes with the scale given.
  func camera(_ value: JSONValue, scale: Double? = nil) throws -> Camera? {
    guard value != .null else { return nil }
    var object = value
    if let scale, case .object(var members) = value {
      members["scale"] = .number(scale)
      object = .object(members)
    }
    return try JSONDecoder().decode(Camera.self, from: JSONEncoder().encode(object))
  }

  @Test func theFakeBoardDrawsAsOnTheWeb() throws {
    let boards = try Fixture.sky("fake-board", as: [FakeBoardCase].self)
    #expect(boards.count >= 5)
    for board in boards {
      let model = skyModel(board.answers.snapshot)
      let found = Self.differences(model, board.model)
      #expect(found.isEmpty, "\(board.name): \(found.joined(separator: "; "))")
      #expect(Self.labels(model) == board.labels, "\(board.name)")
      for pose in board.cameras {
        let view = pose.view.viewport
        let home = homeCamera(view, radius: model.radius)
        #expect(Self.close(home, pose.home), "\(board.name), \(pose.pose)")
        for frame in pose.frames {
          let anchor = try #require(model.anchors.first { $0.id == frame.anchor })
          let framed = frameSphere(
            home, view, sphere: (x: anchor.x, y: anchor.y, reach: anchor.radius + 34))
          #expect(Self.close(framed, frame.camera), "\(board.name), \(pose.pose), \(frame.anchor)")
        }
      }
    }
  }

  /// One of the model table's boards, as JSON to change before it is decoded.
  func board(_ name: String) throws -> [String: Any] {
    let data = try Data(contentsOf: Fixture.folder.appendingPathComponent("sky/model.json"))
    let cases = try #require(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    let found = try #require(cases.first { $0["name"] as? String == name })
    return try #require(found["board"] as? [String: Any])
  }

  func snapshot(_ board: [String: Any]) throws -> SkySnapshot {
    try JSONDecoder().decode(Board.self, from: JSONSerialization.data(withJSONObject: board))
      .snapshot
  }

  @Test func whatANewerServerAddsLeavesTheSkyDrawn() throws {
    var board = try board("orbit")
    var members = try #require(board["members"] as? [[String: Any]])
    members[0]["cli"] = "gemini"
    members[1]["status"] = "resting"
    board["members"] = members
    var tasks = try #require(board["tasks"] as? [[String: Any]])
    tasks[0]["status"] = "paused"
    board["tasks"] = tasks
    let model = skyModel(try snapshot(board))
    // A CLI the client doesn't know still draws a star; a status it doesn't know isn't active.
    #expect(model.stars.map(\.id) == ["ada/lab"])
    #expect(model.stars.first?.cli == OrUnknown<CliKind>.unknown("gemini"))
    // Whether a task of a status the client doesn't know is in play isn't known, so it has no mark.
    let paused = try #require(tasks[0]["id"] as? String)
    #expect(model.tasks.count == 3)
    #expect(!model.tasks.map(\.id).contains(paused))
  }

  @Test func roundsAsJavaScriptDoes() {
    #expect(roundedAsJavaScript(2.5) == 3)
    #expect(roundedAsJavaScript(-2.5) == -2)
    #expect(roundedAsJavaScript(-0.5) == 0)
    #expect(roundedAsJavaScript(-2.6) == -3)
    #expect(roundedAsJavaScript(0.49999999999999994) == 0)
    #expect(roundedAsJavaScript(4_503_599_627_370_497) == 4_503_599_627_370_497)
  }

  @Test func sortsTheBoardsNamesAsTheWebDoes() {
    let names = ["p10", "p9", "eng-10", "eng-9", "zed", "aarhus", "a-b", "ab", "a1", "a-1"]
    #expect(
      names.sorted(by: sortsBefore) == [
        "a-1", "a-b", "a1", "aarhus", "ab", "eng-10", "eng-9", "p10", "p9", "zed",
      ])
    // A numeric order would put p9 first, as Foundation's order for people's eyes does.
    #expect(!sortsBefore("p9", "p10"))
  }

  @Test func readsSessionKeysAsTheBoardSpellsThem() {
    #expect(SessionKey("ada/lab")?.scope == "lab")
    #expect(SessionKey("ada/lab/01M3S1EF764MW5N61H5J41VGR2")?.thread == "01M3S1EF764MW5N61H5J41VGR2")
    #expect(SessionKey("ada/lab/#release")?.channel == "release")
    #expect(SessionKey("ada/lab/#release")?.thread == nil)
    #expect(SessionKey("bo/society/~lab")?.place == "lab")
    #expect(SessionKey("ada") == nil)
    #expect(SessionKey("ada/lab/x/y") == nil)
    #expect(SessionKey("") == nil)
  }

  @Test func insetsLeaveTheBandBetweenThem() {
    let view = SkyViewport(width: 400, height: 900, top: 100, bottom: 400)
    // The free sky runs from 100 to 500, so the home view fits 400 by 400 and centres at 300.
    #expect(viewCenter(view) == SkyPoint(x: 200, y: 300))
    #expect(homeCamera(view, radius: 200).scale == 1)
    // A pinch keeps the world point under the fingers where it was.
    let camera = SkyCamera(x: 30, y: -20, scale: 1)
    let at = SkyPoint(x: 120, y: 180)
    let zoomed = zoomAt(camera, view, factor: 2, at: at)
    let world = (x: camera.x + (at.x - 200) / camera.scale, y: camera.y + (at.y - 300) / camera.scale)
    #expect(Self.close(200 + (world.x - zoomed.x) * zoomed.scale, at.x))
    #expect(Self.close(300 + (world.y - zoomed.y) * zoomed.scale, at.y))
    // A sphere under the bottom inset is out of view, and framing it centres it.
    let framed = frameSphere(camera, view, sphere: (x: 30, y: 230, reach: 40))
    #expect(framed?.x == 30)
    #expect(framed?.y == 230)
    #expect(frameSphere(camera, view, sphere: (x: 30, y: -20, reach: 40)) == nil)
  }

  // MARK: The camera's motion

  static let view = SkyViewport(width: 800, height: 600)
  static let model = SkyModel(
    anchors: [
      SkyAnchor(id: societyScope, label: "society", kind: .society, x: 0, y: 0, radius: 58),
      SkyAnchor(id: "lab", label: "Lab", kind: .project, x: 0, y: -2_000, radius: 58),
    ],
    stars: [], tasks: [], radius: 400)

  @Test func theCameraEasesHomeOnTheCallersClock() {
    var motion = SkyCameraMotion()
    motion.step(at: 10, in: Self.view, model: Self.model)
    let home = homeCamera(Self.view, radius: 400)
    // The first step places the center and starts the clock, and moves nothing yet.
    #expect(motion.target == home)
    #expect(motion.camera.scale == 1)
    #expect(motion.center == viewCenter(Self.view))
    // A twentieth of a second goes 15% of the way.
    motion.step(at: 10.05, in: Self.view, model: Self.model)
    #expect(Self.close(motion.camera.scale, 1 + (home.scale - 1) * 0.15))
    // A clock that jumped moves it no further than a twentieth of a second would.
    let before = motion.camera.scale
    motion.step(at: 99, in: Self.view, model: Self.model)
    #expect(Self.close(motion.camera.scale, before + (home.scale - before) * 0.15))
    // A clock that went back moves nothing.
    let after = motion.camera
    motion.step(at: 50, in: Self.view, model: Self.model)
    #expect(motion.camera == after)
  }

  @Test func reduceMotionLandsAtOnce() {
    var motion = SkyCameraMotion(reducedMotion: true)
    motion.step(at: 0, in: Self.view, model: Self.model)
    #expect(motion.camera == homeCamera(Self.view, radius: 400))
  }

  @Test func aZoomOrADragStaysWhereTheUserLeftIt() {
    var motion = SkyCameraMotion(reducedMotion: true)
    motion.step(at: 0, in: Self.view, model: Self.model)
    motion.zoom(by: 2, in: Self.view)
    #expect(motion.mode == .manual)
    // The sky growing moves a camera the user chose nowhere.
    let grown = SkyModel(anchors: Self.model.anchors, stars: [], tasks: [], radius: 900)
    motion.step(at: 1, in: Self.view, model: grown)
    #expect(motion.camera.scale == homeCamera(Self.view, radius: 400).scale * 2)
    // A drag moves the camera as drawn at once, eased or not.
    var eased = SkyCameraMotion()
    eased.step(at: 0, in: Self.view, model: Self.model)
    eased.pan(dx: 30, dy: -60)
    #expect(eased.camera == SkyCamera(x: -30, y: 60, scale: 1))
    #expect(eased.mode == .manual)
    // Home follows the sky again; the camera eases even to land at once, so it lands within a hair.
    motion.home()
    motion.step(at: 2, in: Self.view, model: grown)
    #expect(Self.close(motion.camera, Camera(x: 0, y: 0, scale: homeCamera(Self.view, radius: 900).scale)))
  }

  @Test func aFocusBringsItsProjectIntoViewAndLetsGoHome() {
    var motion = SkyCameraMotion(reducedMotion: true)
    // A focus waits for a view with a size.
    motion.setFocus("lab")
    motion.step(at: 0, in: SkyViewport(width: 0, height: 0), model: Self.model)
    #expect(motion.mode == .home)
    motion.step(at: 1, in: Self.view, model: Self.model)
    #expect(motion.mode == .focus)
    #expect(motion.camera.x == 0)
    #expect(motion.camera.y == -2_000)
    // Focusing the society, or nothing, sends the camera home, from the step after, as on the web.
    motion.setFocus(societyScope)
    motion.step(at: 2, in: Self.view, model: Self.model)
    #expect(motion.mode == .home)
    motion.step(at: 3, in: Self.view, model: Self.model)
    #expect(motion.camera == homeCamera(Self.view, radius: 400))
    // A focus already in view moves nothing.
    let near = SkyModel(
      anchors: [Self.model.anchors[0], SkyAnchor(id: "lab", label: "Lab", kind: .project, x: 0, y: -100, radius: 58)],
      stars: [], tasks: [], radius: 400)
    motion.setFocus("lab")
    motion.step(at: 4, in: Self.view, model: near)
    #expect(motion.mode == .home)
  }

  @Test func theCenterGlidesAsTheInsetsChange() {
    var motion = SkyCameraMotion()
    motion.step(at: 0, in: Self.view, model: Self.model)
    var folded = Self.view
    folded.bottom = 300
    motion.step(at: 0.05, in: folded, model: Self.model)
    // From 300 toward 150, 15% of the way.
    #expect(Self.close(motion.center?.y ?? 0, 300 - 150 * 0.15))
    #expect(motion.center?.x == 400)
  }
}
